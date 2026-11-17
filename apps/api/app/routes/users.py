"""User administration (admin only).

Create accounts, change roles / status / farm access, reset passwords.
"""

from __future__ import annotations

import json

from flask import Blueprint, jsonify
from sqlalchemy import func, select

from app.extensions import db
from app.models import AuditLog, Farm, FarmAssignment, Role, User
from app.services import audit_service
from app.services.auth_service import auth_required, current_user
from app.services.passwords import generate_temporary_password, hash_password
from app.services.permissions import ROLE_DEFINITIONS, get_role
from app.services.serializers import user_to_dict
from app.utils.errors import ApiError, ValidationError
from app.utils.http import json_body, query_int
from app.utils.time import iso, utcnow
from app.utils.validation import Validator

bp = Blueprint("users", __name__, url_prefix="/api/users")

ROLE_NAMES = tuple(ROLE_DEFINITIONS)
STATUS_VALUES = ("active", "suspended")


def _get_user(user_id: int) -> User:
    user = db.session.get(User, user_id)
    if user is None:
        raise ApiError(404, "NOT_FOUND", "User not found.")
    return user


def _active_admin_count() -> int:
    return db.session.scalar(
        select(func.count(User.id))
        .join(User.role)
        .where(Role.name == "admin", User.status == "active")
    )


def _check_farm_ids(farm_ids: list[int]) -> None:
    if not farm_ids:
        return
    found = set(db.session.scalars(select(Farm.id).where(Farm.id.in_(farm_ids))))
    missing = sorted(set(farm_ids) - found)
    if missing:
        raise ValidationError({"farmIds": f"Unknown farm id(s): {', '.join(map(str, missing))}."})


def _set_farms(user: User, farm_ids: list[int], admin: User) -> tuple[list[int], list[int]]:
    current = {a.farm_id for a in user.assignments}
    wanted = set(farm_ids)
    for assignment in list(user.assignments):
        if assignment.farm_id not in wanted:
            user.assignments.remove(assignment)
    for farm_id in sorted(wanted - current):
        user.assignments.append(FarmAssignment(farm_id=farm_id, assigned_by_id=admin.id))
    return sorted(wanted - current), sorted(current - wanted)


@bp.get("")
@auth_required("users.manage")
def list_users():
    users = db.session.scalars(select(User).order_by(User.full_name))
    return jsonify(users=[user_to_dict(u) for u in users])


@bp.post("")
@auth_required("users.manage")
def create_user():
    """Creates an account with a one-time temporary password, shown once to the admin."""
    admin = current_user()
    v = Validator(json_body())
    full_name = v.string("fullName", "Full name", required=True, min_len=2, max_len=120)
    email = v.email()
    role = v.choice("role", ROLE_NAMES, "Role", required=True)
    farm_ids = v.int_list("farmIds", "Farms") or []
    v.done()
    _check_farm_ids(farm_ids)
    if db.session.scalar(select(User.id).where(User.email == email)) is not None:
        raise ApiError(
            409,
            "EMAIL_TAKEN",
            "An account with this email already exists.",
            {"email": "An account with this email already exists."},
        )

    temporary = generate_temporary_password()
    user = User(
        full_name=full_name,
        email=email,
        password_hash=hash_password(temporary),
        role=get_role(role),
        must_change_password=True,
    )
    db.session.add(user)
    db.session.flush()
    if role != "admin":
        _set_farms(user, farm_ids, admin)
    audit_service.record(
        "user.create",
        actor=admin,
        resource_type="user",
        resource_id=user.id,
        details={"email": email, "role": role, "farmIds": farm_ids},
        commit=False,
    )
    db.session.commit()
    return jsonify(user=user_to_dict(user), temporaryPassword=temporary), 201


@bp.patch("/<int:user_id>")
@auth_required("users.manage")
def update_user(user_id: int):
    admin = current_user()
    user = _get_user(user_id)
    v = Validator(json_body(), partial=True)
    role = v.choice("role", ROLE_NAMES, "Role")
    status = v.choice("status", STATUS_VALUES, "Status")
    farm_ids = v.int_list("farmIds", "Farms")
    v.done()
    if farm_ids is not None:
        _check_farm_ids(farm_ids)

    role_changes = role is not None and role != user.role_name
    status_changes = status is not None and status != user.status
    if user.id == admin.id and (role_changes or status_changes):
        raise ApiError(
            400,
            "CANNOT_MODIFY_SELF",
            "You cannot change your own role or status. Ask another administrator.",
        )
    removes_admin = (
        user.is_admin
        and user.is_active
        and ((role_changes and role != "admin") or (status_changes and status != "active"))
    )
    if removes_admin and _active_admin_count() <= 1:
        raise ApiError(409, "LAST_ADMIN", "At least one active administrator must remain.")

    if role_changes:
        old = user.role_name
        user.role = get_role(role)
        audit_service.record(
            "user.role_change",
            actor=admin,
            resource_type="user",
            resource_id=user.id,
            details={"from": old, "to": role, "email": user.email},
            commit=False,
        )
    if status_changes:
        old = user.status
        user.status = status
        if status == "suspended":
            user.token_version += 1  # ends the user's active sessions immediately
        audit_service.record(
            "user.status_change",
            actor=admin,
            resource_type="user",
            resource_id=user.id,
            details={"from": old, "to": status, "email": user.email},
            commit=False,
        )
    if user.role_name == "admin":
        farm_ids = []  # administrators see every farm; explicit assignments are not used
    if farm_ids is not None:
        added, removed = _set_farms(user, farm_ids, admin)
        if added or removed:
            audit_service.record(
                "user.farm_access_change",
                actor=admin,
                resource_type="user",
                resource_id=user.id,
                details={"added": added, "removed": removed, "email": user.email},
                commit=False,
            )
    db.session.commit()
    return jsonify(user=user_to_dict(user))


@bp.post("/<int:user_id>/reset-password")
@auth_required("users.manage")
def reset_password(user_id: int):
    admin = current_user()
    user = _get_user(user_id)
    if user.id == admin.id:
        raise ApiError(
            400, "CANNOT_MODIFY_SELF", "Use Settings → Security to change your own password."
        )
    temporary = generate_temporary_password()
    user.password_hash = hash_password(temporary)
    user.password_changed_at = utcnow()
    user.must_change_password = True
    user.token_version += 1
    audit_service.record(
        "user.password_reset",
        actor=admin,
        resource_type="user",
        resource_id=user.id,
        details={"email": user.email},
        commit=False,
    )
    db.session.commit()
    return jsonify(user=user_to_dict(user), temporaryPassword=temporary)


@bp.get("/login-activity")
@auth_required("users.manage")
def login_activity():
    limit = query_int("limit", 200, maximum=1000)
    rows = db.session.execute(
        select(AuditLog, User.full_name)
        .outerjoin(User, User.id == AuditLog.actor_user_id)
        .where(AuditLog.action == "auth.login", AuditLog.outcome == "success")
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(limit)
    )
    return jsonify(
        logins=[
            {
                "id": e.id,
                "userName": name or e.actor_email,
                "email": e.actor_email,
                "ip": e.ip_address,
                "userAgent": e.user_agent or "Unknown",
                "at": iso(e.created_at),
            }
            for e, name in rows
        ]
    )


@bp.get("/failed-logins")
@auth_required("users.manage")
def failed_logins():
    """Failed or blocked sign-ins grouped by account, address and reason."""
    entries = db.session.scalars(
        select(AuditLog)
        .where(AuditLog.action == "auth.login", AuditLog.outcome.in_(("failure", "denied")))
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(2000)
    )
    groups: dict[tuple, dict] = {}
    for e in entries:
        reason = json.loads(e.details).get("reason", "failed") if e.details else "failed"
        key = (e.actor_email, e.ip_address, reason)
        if key not in groups:
            groups[key] = {
                "id": e.id,
                "email": e.actor_email or "—",
                "ip": e.ip_address,
                "reason": reason,
                "attempts": 0,
                "at": iso(e.created_at),
            }
        groups[key]["attempts"] += 1
    return jsonify(attempts=list(groups.values())[: query_int("limit", 200, maximum=1000)])
