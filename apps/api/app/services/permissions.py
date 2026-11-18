"""Role-based access control (RBAC) and farm-level access rules.

Roles grant permissions (what kind of action). Farm assignments decide *which*
farms a non-admin user can see or change. Both are checked on the server for
every request; the frontend only hides buttons for convenience.
"""

from __future__ import annotations

from sqlalchemy import select

from app.extensions import db
from app.models import Farm, FarmAssignment, PoultryBatch, Role, User

ROLE_DEFINITIONS: dict[str, tuple[str, str]] = {
    "admin": (
        "Administrator",
        "Manages users, roles and farms; views all analytics and audit logs.",
    ),
    "farm_manager": (
        "Farm Manager",
        "Manages assigned farms and poultry batches; views farm analytics.",
    ),
    "analyst": (
        "Analyst",
        "Reads permitted analytical data for assigned farms and generates reports.",
    ),
    "veterinarian": (
        "Veterinary User",
        "Views assigned farm health indicators and records inspections.",
    ),
}

# Role assigned by public self-registration: the least-privileged role.
DEFAULT_ROLE = "analyst"

PERMISSIONS: dict[str, frozenset[str]] = {
    "admin": frozenset(
        {
            "users.manage",
            "audit.view",
            "farms.create",
            "farms.update",
            "farms.delete",
            "batches.manage",
            "health.view",
            "inspections.record",
            "analytics.view",
            "reports.generate",
            "datasets.upload",
            "datasets.view",
            "datasets.delete",
        }
    ),
    "farm_manager": frozenset(
        {
            "farms.create",
            "farms.update",
            "batches.manage",
            "health.view",
            "analytics.view",
            "datasets.upload",
            "datasets.view",
            "datasets.delete",
        }
    ),
    "analyst": frozenset({"analytics.view", "reports.generate", "datasets.view"}),
    "veterinarian": frozenset({"health.view", "inspections.record"}),
}


def seed_roles() -> None:
    """Creates/updates the four roles (idempotent)."""
    existing = {role.name: role for role in db.session.scalars(select(Role))}
    for name, (label, description) in ROLE_DEFINITIONS.items():
        role = existing.get(name)
        if role is None:
            db.session.add(Role(name=name, label=label, description=description))
        else:
            role.label, role.description = label, description
    db.session.commit()


def get_role(name: str) -> Role:
    role = db.session.scalar(select(Role).where(Role.name == name))
    if role is None:  # pragma: no cover - roles are seeded at start-up
        raise RuntimeError(f"Role '{name}' is missing; run 'flask --app run init-db'.")
    return role


def permissions_for(user: User) -> frozenset[str]:
    return PERMISSIONS.get(user.role_name, frozenset())


def has_permission(user: User, permission: str) -> bool:
    return permission in permissions_for(user)


def accessible_farm_ids(user: User) -> set[int] | None:
    """None means "all farms" (administrators)."""
    if user.is_admin:
        return None
    return set(
        db.session.scalars(select(FarmAssignment.farm_id).where(FarmAssignment.user_id == user.id))
    )


def can_access_farm(user: User, farm_id: int) -> bool:
    ids = accessible_farm_ids(user)
    return ids is None or farm_id in ids


def farm_scope(statement, user: User, farm_column=Farm.id):
    """Restricts a SELECT to the farms the user may see."""
    ids = accessible_farm_ids(user)
    return statement if ids is None else statement.where(farm_column.in_(ids or {-1}))


def batch_scope(statement, user: User):
    return farm_scope(statement, user, PoultryBatch.farm_id)
