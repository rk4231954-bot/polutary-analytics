"""CSV dataset ingestion: upload, validation report, processed preview, history, delete."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from app.services import dataset_service
from app.services.auth_service import auth_required, current_user
from app.services.serializers import dataset_to_dict
from app.utils.errors import ApiError
from app.utils.http import query_int

bp = Blueprint("datasets", __name__, url_prefix="/api/datasets")

FORM_OVERHEAD_BYTES = 256 * 1024  # multipart boundaries + the mapping/farm fields


@bp.post("")
@auth_required("datasets.upload")
def upload_dataset():
    user = current_user()
    # The app-wide limit is sized for JSON; raise it for this endpoint only.
    request.max_content_length = dataset_service.max_upload_bytes() + FORM_OVERHEAD_BYTES
    try:
        file = request.files.get("file")
        form = request.form
    except RequestEntityTooLarge:
        raise dataset_service.reject_too_large(user) from None
    dataset = dataset_service.upload_dataset(user, file, form.get("mapping"), form.get("farmId"))
    return jsonify(dataset=dataset_to_dict(dataset, detail=True)), 201


@bp.get("")
@auth_required("datasets.view")
def list_datasets():
    farm_id = request.args.get("farm_id", type=int)
    if request.args.get("farm_id") and farm_id is None:
        raise ApiError(400, "BAD_QUERY", "farm_id must be a number.")
    limit = query_int("limit", 20, maximum=100)
    datasets = dataset_service.list_datasets(current_user(), farm_id, limit)
    return jsonify(datasets=[dataset_to_dict(d) for d in datasets])


@bp.get("/<int:dataset_id>")
@auth_required("datasets.view")
def get_dataset(dataset_id: int):
    dataset = dataset_service.get_dataset_for(current_user(), dataset_id)
    return jsonify(dataset=dataset_to_dict(dataset, detail=True))


@bp.get("/<int:dataset_id>/preview")
@auth_required("datasets.view")
def preview_dataset(dataset_id: int):
    dataset = dataset_service.get_dataset_for(current_user(), dataset_id)
    kind = request.args.get("kind", "processed")
    offset = query_int("offset", 0, minimum=0, maximum=10_000_000)
    limit = query_int("limit", 50, maximum=200)
    return jsonify(preview=dataset_service.preview(dataset, kind, offset, limit))


@bp.delete("/<int:dataset_id>")
@auth_required("datasets.delete")
def delete_dataset(dataset_id: int):
    user = current_user()
    dataset_service.delete_dataset(user, dataset_service.get_dataset_for(user, dataset_id))
    return current_app.response_class(status=204)
