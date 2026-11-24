"""Recent operational activity for the dashboard, read from the audit log (SQLite).

Only data-changing actions are listed (uploads, farm/batch changes, inspections and,
for administrators, account administration). Sign-ins and security events stay on the
admin-only audit pages. Visibility follows the same rules as the rest of the API:

- Administrators see every listed action.
- Other users see their own actions, plus actions on farms assigned to them when their
  role may see that kind of record (datasets.view for uploads, health.view for
  inspections). Account administration (user.*) is visible to administrators only.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select

from app.extensions import db
from app.models import AuditLog, PoultryBatch, User
from app.services.permissions import accessible_farm_ids, has_permission
from app.utils.time import iso

# action -> activity type used by the dashboard icons
ACTIVITY_TYPES: dict[str, str] = {
    "dataset.upload": "upload",
    "dataset.delete": "upload",
    "farm.create": "farm",
    "farm.update": "farm",
    "farm.delete": "farm",
    "batch.create": "farm",
    "batch.update": "farm",
    "batch.delete": "farm",
    "inspection.create": "farm",
    "user.create": "user",
    "user.role_change": "user",
    "user.status_change": "user",
    "user.farm_access_change": "user",
    "user.password_reset": "user",
}

# Permission a non-admin needs (besides farm access) to see an action on a farm.
_REQUIRES = {"dataset": "datasets.view", "inspection": "health.view"}

# How many recent candidate entries are examined per request (they are filtered by
# visibility in Python, so this bounds the work for users who can see little).
SCAN_LIMIT = 1000


def _details(entry: AuditLog) -> dict[str, Any]:
    try:
        return json.loads(entry.details) if entry.details else {}
    except ValueError:
        return {}


def _farm_id(entry: AuditLog, details: dict[str, Any], batches: dict[int, int]) -> int | None:
    """The application farm an entry belongs to, if any."""
    if entry.resource_type == "farm" and entry.resource_id and entry.resource_id.isdigit():
        return int(entry.resource_id)
    if isinstance(details.get("farmId"), int):
        return details["farmId"]
    if entry.resource_type == "batch" and entry.resource_id and entry.resource_id.isdigit():
        return batches.get(int(entry.resource_id))
    return None


def _changed(details: dict[str, Any]) -> str:
    fields = details.get("changed") or []
    return f" ({', '.join(fields)})" if fields else ""


def _message(entry: AuditLog, d: dict[str, Any], names: dict[str, str]) -> str:
    action, ok = entry.action, entry.outcome == "success"
    farm = names.get(f"farm:{entry.resource_id}") or f"farm #{entry.resource_id}"
    batch = d.get("code") or names.get(f"batch:{entry.resource_id}") or f"#{entry.resource_id}"
    if action == "dataset.upload":
        name = d.get("filename") or "a file"
        if ok:
            return (
                f"Uploaded dataset {name}: {d.get('acceptedRows', 0)} rows accepted, "
                f"{d.get('rejectedRows', 0)} rejected"
            )
        if entry.resource_id:
            return f"Dataset {name} failed processing"
        return f"Upload refused ({d.get('reason', 'invalid file')})"
    messages = {
        "dataset.delete": f"Deleted dataset {d.get('filename') or entry.resource_id}",
        "farm.create": f"Created farm {d.get('name')} ({d.get('code')})",
        "farm.update": f"Updated {farm}{_changed(d)}",
        "farm.delete": f"Deleted farm {d.get('name')} ({d.get('code')})",
        "batch.create": f"Created batch {batch}",
        "batch.update": f"Updated batch {batch}{_changed(d)}",
        "batch.delete": f"Deleted batch {batch}",
        "inspection.create": f"Recorded inspection for batch {batch} ({d.get('healthStatus')})",
        "user.create": f"Created account {d.get('email')} ({d.get('role')})",
        "user.role_change": f"Changed role of {d.get('email')}: {d.get('from')} → {d.get('to')}",
        "user.status_change": (
            f"Changed status of {d.get('email')}: {d.get('from')} → {d.get('to')}"
        ),
        "user.farm_access_change": f"Changed farm access for {d.get('email')}",
        "user.password_reset": f"Reset the password of {d.get('email')}",
    }
    return messages[action]


def recent_activity(user: User, limit: int) -> list[dict[str, Any]]:
    entries = list(
        db.session.scalars(
            select(AuditLog)
            .where(AuditLog.action.in_(ACTIVITY_TYPES))
            # Refused uploads are kept: they show a user that an upload did not go through.
            .where(AuditLog.outcome.in_(("success", "failure")))
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(SCAN_LIMIT)
        )
    )
    batch_ids = {
        int(e.resource_id)
        for e in entries
        if e.resource_type == "batch" and e.resource_id and e.resource_id.isdigit()
    }
    batches = {
        b.id: b
        for b in db.session.scalars(select(PoultryBatch).where(PoultryBatch.id.in_(batch_ids)))
    }
    batch_farms = {bid: b.farm_id for bid, b in batches.items()}
    names = {f"batch:{bid}": b.code for bid, b in batches.items()}
    names |= {f"farm:{b.farm_id}": b.farm.name for b in batches.values()}

    allowed = accessible_farm_ids(user)  # None = all farms (admin)
    actor_ids = {e.actor_user_id for e in entries if e.actor_user_id}
    actors = {
        u.id: u.full_name for u in db.session.scalars(select(User).where(User.id.in_(actor_ids)))
    }
    items = []
    for entry in entries:
        details = _details(entry)
        if allowed is not None and entry.actor_user_id != user.id:
            kind = entry.action.split(".", 1)[0]
            if kind == "user":
                continue
            if kind in _REQUIRES and not has_permission(user, _REQUIRES[kind]):
                continue
            if _farm_id(entry, details, batch_farms) not in allowed:
                continue
        # Failed outcomes other than uploads are not data changes.
        if entry.outcome != "success" and entry.action != "dataset.upload":
            continue
        items.append(
            {
                "id": entry.id,
                "type": ACTIVITY_TYPES[entry.action],
                "action": entry.action,
                "outcome": entry.outcome,
                "message": _message(entry, details, names),
                "actor": actors.get(entry.actor_user_id) or entry.actor_email or "System",
                "createdAt": iso(entry.created_at),
            }
        )
        if len(items) >= limit:
            break
    return items
