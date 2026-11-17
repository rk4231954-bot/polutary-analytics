"""Writes audit log entries. Sensitive values are stripped before anything is stored."""

from __future__ import annotations

import json
from typing import Any

from flask import has_request_context

from app.extensions import db
from app.models import AuditLog, User
from app.utils.http import client_ip, user_agent

SENSITIVE_MARKERS = ("password", "token", "secret", "hash", "csrf", "cookie", "authorization")


def _clean(details: dict[str, Any] | None) -> str | None:
    if not details:
        return None
    safe = {
        key: value
        for key, value in details.items()
        if not any(marker in key.lower() for marker in SENSITIVE_MARKERS)
    }
    return json.dumps(safe, default=str, sort_keys=True)[:4000] if safe else None


def record(
    action: str,
    outcome: str = "success",
    *,
    actor: User | None = None,
    actor_email: str | None = None,
    resource_type: str | None = None,
    resource_id: Any = None,
    details: dict[str, Any] | None = None,
    commit: bool = True,
) -> AuditLog:
    """Adds an audit entry. Use commit=False to save it in the same transaction as a change."""
    entry = AuditLog(
        action=action,
        outcome=outcome,
        actor_user_id=actor.id if actor else None,
        actor_email=(actor.email if actor else actor_email),
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id is not None else None,
        ip_address=client_ip() if has_request_context() else "cli",
        user_agent=user_agent() if has_request_context() else "flask-cli",
        details=_clean(details),
    )
    db.session.add(entry)
    if commit:
        db.session.commit()
    return entry
