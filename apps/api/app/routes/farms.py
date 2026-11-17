"""Farm CRUD. Non-admin users only ever see and change the farms assigned to them."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify

from app.services import farm_service
from app.services.auth_service import auth_required, current_user
from app.services.serializers import batch_to_dict, farm_to_dict
from app.utils.http import json_body

bp = Blueprint("farms", __name__, url_prefix="/api/farms")


@bp.get("")
@auth_required()
def list_farms():
    farms = farm_service.list_farms(current_user())
    stats = farm_service.farm_stats([f.id for f in farms])
    return jsonify(farms=[farm_to_dict(f, stats[f.id]) for f in farms])


@bp.post("")
@auth_required("farms.create")
def create_farm():
    farm = farm_service.create_farm(current_user(), json_body())
    return jsonify(farm=farm_to_dict(farm)), 201


@bp.get("/<int:farm_id>")
@auth_required()
def get_farm(farm_id: int):
    farm = farm_service.get_farm_for(current_user(), farm_id)
    return jsonify(farm=farm_to_dict(farm))


@bp.put("/<int:farm_id>")
@auth_required("farms.update")
def update_farm(farm_id: int):
    user = current_user()
    farm = farm_service.get_farm_for(user, farm_id)
    farm = farm_service.update_farm(user, farm, json_body())
    return jsonify(farm=farm_to_dict(farm))


@bp.delete("/<int:farm_id>")
@auth_required("farms.delete")
def delete_farm(farm_id: int):
    user = current_user()
    farm_service.delete_farm(user, farm_service.get_farm_for(user, farm_id))
    return current_app.response_class(status=204)


@bp.get("/<int:farm_id>/batches")
@auth_required()
def farm_batches(farm_id: int):
    user = current_user()
    farm_service.get_farm_for(user, farm_id)
    return jsonify(
        batches=[batch_to_dict(b) for b in farm_service.list_batches(user, farm_id, None)]
    )
