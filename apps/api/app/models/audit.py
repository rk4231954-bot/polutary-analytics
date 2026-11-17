"""Append-only audit log and revoked sessions (logout)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, event
from sqlalchemy.orm import Mapped, mapped_column

from app.extensions import db
from app.utils.time import utcnow

AUDIT_OUTCOMES = ("success", "failure", "denied")


class AuditLog(db.Model):
    __tablename__ = "audit_logs"
    __table_args__ = (
        CheckConstraint(f"outcome IN {AUDIT_OUTCOMES}", name="ck_audit_outcome"),
        Index("ix_audit_action_created", "action", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, index=True
    )
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Snapshot so the entry stays readable if the account changes later.
    actor_email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    outcome: Mapped[str] = mapped_column(String(16), nullable=False)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # JSON object with non-sensitive context (never passwords or tokens).
    details: Mapped[str | None] = mapped_column(Text, nullable=True)


@event.listens_for(AuditLog, "before_update")
def _audit_is_append_only(*_args) -> None:
    raise RuntimeError("Audit log entries are append-only and cannot be modified.")


@event.listens_for(AuditLog, "before_delete")
def _audit_cannot_be_deleted(*_args) -> None:
    raise RuntimeError("Audit log entries are append-only and cannot be deleted.")


class RevokedSession(db.Model):
    """A signed-out session. Every token carrying this session id is rejected."""

    __tablename__ = "revoked_sessions"

    session_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    revoked_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    # After this time the session would have expired anyway; rows can then be purged.
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
