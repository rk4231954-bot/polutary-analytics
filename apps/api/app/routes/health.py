"""Public health check used by the frontend's connection test."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify
from sqlalchemy import text

from app import __version__
from app.extensions import db
from app.utils.time import iso, utcnow

bp = Blueprint("health", __name__, url_prefix="/api")


@bp.get("/health")
def health():
    try:
        db.session.execute(text("SELECT 1"))
        database = "ok"
    except Exception:  # noqa: BLE001 - report, don't crash the health check
        current_app.logger.exception("Database health check failed")
        database = "unavailable"
    status = "ok" if database == "ok" else "degraded"
    body = {"status": status, "version": __version__, "time": iso(utcnow()), "database": database}
    return jsonify(body), 200 if status == "ok" else 503
