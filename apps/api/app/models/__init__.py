"""SQLAlchemy models (application data only; analytics live in Hive from stage 8)."""

from sqlalchemy import Engine, event

from app.models.audit import AUDIT_OUTCOMES, AuditLog, RevokedSession
from app.models.farm import (
    BATCH_STATUSES,
    FARM_STATUSES,
    HEALTH_STATUSES,
    HOUSING_TYPES,
    POULTRY_TYPES,
    BatchInspection,
    Farm,
    PoultryBatch,
)
from app.models.user import USER_STATUSES, FarmAssignment, Role, User


@event.listens_for(Engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection, _record) -> None:
    """SQLite ignores foreign keys unless enabled per connection."""
    if dbapi_connection.__class__.__module__.startswith("sqlite3"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


__all__ = [
    "AUDIT_OUTCOMES",
    "BATCH_STATUSES",
    "FARM_STATUSES",
    "HEALTH_STATUSES",
    "HOUSING_TYPES",
    "POULTRY_TYPES",
    "USER_STATUSES",
    "AuditLog",
    "BatchInspection",
    "Farm",
    "FarmAssignment",
    "PoultryBatch",
    "RevokedSession",
    "Role",
    "User",
]
