"""Recent activity feed (GET /api/activity), read from the audit log.

Any signed-in user may call it; services/activity_service.py limits each user to the
entries their role and farm assignments allow.
"""

from __future__ import annotations

from flask import Blueprint, jsonify

from app.services import activity_service
from app.services.auth_service import auth_required, current_user
from app.utils.http import query_int

bp = Blueprint("activity", __name__, url_prefix="/api/activity")


@bp.get("")
@auth_required()
def recent():
    limit = query_int("limit", 10, maximum=100)
    return jsonify(activity=activity_service.recent_activity(current_user(), limit))
