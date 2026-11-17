"""Poultry batch CRUD and inspection observations, limited to the user's farms."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request

from app.services import farm_service
from app.services.auth_service import auth_required, current_user
from app.services.serializers import batch_to_dict, inspection_to_dict
from app.utils.errors import ApiError
from app.utils.http import json_body

bp = Blueprint("batches", __name__, url_prefix="/api/batches")


@bp.get("")
@auth_required()
def list_batches():
    farm_id = request.args.get("farm_id", type=int)
    if request.args.get("farm_id") and farm_id is None:
        raise ApiError(400, "BAD_QUERY", "farm_id must be a number.")
    batches = farm_service.list_batches(current_user(), farm_id, request.args.get("status") or None)
    return jsonify(batches=[batch_to_dict(b) for b in batches])


@bp.post("")
@auth_required("batches.manage")
def create_batch():
    batch = farm_service.create_batch(current_user(), json_body())
    return jsonify(batch=batch_to_dict(batch)), 201


@bp.get("/<int:batch_id>")
@auth_required()
def get_batch(batch_id: int):
    batch = farm_service.get_batch_for(current_user(), batch_id)
    # Daily records (weights, mortality, feed) are added by data collection in stage 6.
    return jsonify(batch={**batch_to_dict(batch), "daily": []})


@bp.put("/<int:batch_id>")
@auth_required("batches.manage")
def update_batch(batch_id: int):
    user = current_user()
    batch = farm_service.update_batch(user, farm_service.get_batch_for(user, batch_id), json_body())
    return jsonify(batch=batch_to_dict(batch))


@bp.delete("/<int:batch_id>")
@auth_required("batches.manage")
def delete_batch(batch_id: int):
    user = current_user()
    farm_service.delete_batch(user, farm_service.get_batch_for(user, batch_id))
    return current_app.response_class(status=204)


@bp.get("/<int:batch_id>/inspections")
@auth_required("health.view")
def list_inspections(batch_id: int):
    batch = farm_service.get_batch_for(current_user(), batch_id)
    return jsonify(inspections=[inspection_to_dict(i) for i in batch.inspections])


@bp.post("/<int:batch_id>/inspections")
@auth_required("inspections.record")
def create_inspection(batch_id: int):
    user = current_user()
    batch = farm_service.get_batch_for(user, batch_id)
    item = farm_service.record_inspection(user, batch, json_body())
    return jsonify(inspection=inspection_to_dict(item)), 201
