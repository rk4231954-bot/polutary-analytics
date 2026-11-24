"""Farm monitoring alerts (GET /api/alerts), computed by HiveQL on Apache Hive.

Alerts are statistical signals (the latest day compared with the farm's own recent
history), not diagnoses. The rule parameters are returned with every response; see
analytics_service.alerts for the rules.
"""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify

from app.services import analytics_service
from app.services.auth_service import auth_required, current_user
from app.utils.http import query_id, query_int

bp = Blueprint("alerts", __name__, url_prefix="/api/alerts")


@bp.get("")
@auth_required("analytics.view")
def list_alerts():
    limit = query_int("limit", 10, maximum=100)
    scope = analytics_service.resolve_scope(current_user(), query_id("farm_id"))
    return jsonify(
        alerts=analytics_service.alerts(scope, limit),
        rules=analytics_service.alert_rules(),
        source=analytics_service.source_info(current_app.config["HIVE_DATABASE"]),
    )
