"""Broiler flock performance reference data (Kaggle "Broiler Performance Index").

POST /api/flock-performance          admin: upload PS Performance.csv → HDFS → Hive (replaces it)
GET  /api/flock-performance/summary  HiveQL aggregates over the flock table
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from app.services import flock_performance
from app.services.auth_service import auth_required, current_user
from app.services.dataset_service import max_upload_bytes
from app.utils.errors import ApiError

bp = Blueprint("flock_performance", __name__, url_prefix="/api/flock-performance")


@bp.post("")
@auth_required("reference_data.upload")
def upload():
    request.max_content_length = max_upload_bytes() + 64 * 1024
    try:
        file = request.files.get("file")
    except RequestEntityTooLarge:
        raise ApiError(413, "FILE_TOO_LARGE", "The file is larger than the upload limit.") from None
    return jsonify(flock_performance.upload(current_user(), file)), 201


@bp.get("/summary")
@auth_required("analytics.view")
def summary():
    return jsonify(flock_performance.summary())
