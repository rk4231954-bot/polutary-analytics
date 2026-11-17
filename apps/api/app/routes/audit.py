"""Read-only audit log access (admin only). There are no endpoints to edit or delete entries."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, request
from sqlalchemy import or_, select

from app.extensions import db
from app.models import AUDIT_OUTCOMES, AuditLog
from app.services.auth_service import auth_required
from app.services.serializers import audit_to_dict
from app.utils.errors import ApiError
from app.utils.http import query_int
from app.utils.time import iso

bp = Blueprint("audit", __name__, url_prefix="/api/audit-logs")


def _date_arg(name: str) -> date | None:
    raw = request.args.get(name)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ApiError(400, "BAD_QUERY", f"'{name}' must be a date in YYYY-MM-DD format.") from exc


@bp.get("")
@auth_required("audit.view")
def list_entries():
    stmt = select(AuditLog)
    if start := _date_arg("from"):
        stmt = stmt.where(AuditLog.created_at >= datetime.combine(start, datetime.min.time()))
    if end := _date_arg("to"):
        stmt = stmt.where(
            AuditLog.created_at < datetime.combine(end + timedelta(days=1), datetime.min.time())
        )
    if outcome := request.args.get("outcome"):
        if outcome not in AUDIT_OUTCOMES:
            raise ApiError(
                400, "BAD_QUERY", f"outcome must be one of: {', '.join(AUDIT_OUTCOMES)}."
            )
        stmt = stmt.where(AuditLog.outcome == outcome)
    if action := request.args.get("action"):
        # Exact action ("farm.create") or a category prefix ("farm").
        # Bound parameter: never concatenated into SQL.
        stmt = stmt.where(
            or_(
                AuditLog.action == action, AuditLog.action.startswith(f"{action}.", autoescape=True)
            )
        )
    limit = query_int("limit", 500, maximum=2000)
    entries = db.session.scalars(
        stmt.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(limit)
    )
    return jsonify(entries=[audit_to_dict(e) for e in entries])


EVENT_TYPES = {
    ("auth.login", "failure"): ("Failed sign-in", "warning"),
    ("auth.login", "denied"): ("Blocked sign-in", "danger"),
    ("auth.register", "denied"): ("Blocked registration", "danger"),
    ("auth.password_change", "failure"): ("Failed password change", "warning"),
    ("access.denied", "denied"): ("Access denied", "warning"),
    ("user.role_change", "success"): ("Role changed", "info"),
    ("user.status_change", "success"): ("Account status changed", "info"),
    ("user.farm_access_change", "success"): ("Farm access changed", "info"),
    ("user.password_reset", "success"): ("Password reset by admin", "info"),
    ("user.admin_bootstrap", "success"): ("Administrator created", "info"),
}


@bp.get("/security-events")
@auth_required("audit.view")
def security_events():
    actions = {action for action, _ in EVENT_TYPES}
    entries = db.session.scalars(
        select(AuditLog)
        .where(AuditLog.action.in_(actions))
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(query_int("limit", 200, maximum=1000))
    )
    events = []
    for e in entries:
        kind = EVENT_TYPES.get((e.action, e.outcome))
        if not kind:
            continue
        data = audit_to_dict(e)
        detail = data["details"].get("reason") or ", ".join(
            f"{k}: {v}" for k, v in data["details"].items()
        )
        events.append(
            {
                "id": e.id,
                "type": kind[0],
                "severity": kind[1],
                "message": (e.actor_email or "Unknown account")
                + (f" — {detail}" if detail else ""),
                "ip": e.ip_address,
                "at": iso(e.created_at),
            }
        )
    return jsonify(events=events)
