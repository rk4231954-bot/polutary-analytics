"""Analytics endpoints. Every figure is computed by HiveQL on Apache Hive (see
services/hive_queries.py); SQLite only decides which farms the caller may see.

GET /api/analytics/status           HiveServer2 connectivity + tables (no MapReduce job)
GET /api/analytics/summary          dashboard KPIs for the period, with trends
GET /api/analytics/daily            per farm per day: birds, deaths, feed, weight, climate
GET /api/analytics/farm-comparison  per farm: mortality, feed, weight, temperature, humidity
GET /api/analytics/growth           weight curves per batch by age
"""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify

from app.services import analytics_service, hive_client
from app.services.auth_service import auth_required, current_user
from app.utils.http import query_id, query_int

bp = Blueprint("analytics", __name__, url_prefix="/api/analytics")

DEFAULT_DAYS = 30
MAX_DAYS = 3650


def _days() -> int:
    return query_int("days", DEFAULT_DAYS, minimum=1, maximum=MAX_DAYS)


def _source() -> dict[str, str]:
    return analytics_service.source_info(current_app.config["HIVE_DATABASE"])


@bp.get("/status")
@auth_required("analytics.view")
def status():
    return jsonify(hive=hive_client.ping(), source=_source())


@bp.get("/summary")
@auth_required("analytics.view")
def summary():
    days = _days()
    scope = analytics_service.resolve_scope(current_user(), query_id("farm_id"))
    body = analytics_service.summary(scope, days)
    return jsonify(**body, days=days, source=_source())


@bp.get("/daily")
@auth_required("analytics.view")
def daily():
    days = _days()
    scope = analytics_service.resolve_scope(current_user(), query_id("farm_id"))
    records = analytics_service.daily_records(scope, days)
    return jsonify(records=records, days=days, source=_source())


@bp.get("/farm-comparison")
@auth_required("analytics.view")
def farm_comparison():
    days = _days()
    scope = analytics_service.resolve_scope(current_user(), query_id("farm_id"))
    farms = analytics_service.farm_comparison(scope, days)
    return jsonify(farms=farms, days=days, source=_source())


@bp.get("/growth")
@auth_required("analytics.view")
def growth():
    batches = analytics_service.growth(current_user(), query_id("farm_id"), query_id("batch_id"))
    return jsonify(batches=batches, source=_source())
