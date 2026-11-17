"""Users, roles and farm assignments."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.extensions import db
from app.utils.time import utcnow

USER_STATUSES = ("active", "suspended")


class Role(db.Model):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    users: Mapped[list[User]] = relationship(back_populates="role")


class FarmAssignment(db.Model):
    """Which non-admin users may access which farm (farm-level access control)."""

    __tablename__ = "farm_assignments"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    farm_id: Mapped[int] = mapped_column(
        ForeignKey("farms.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    assigned_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    assigned_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    user: Mapped[User] = relationship(foreign_keys=[user_id], back_populates="assignments")
    farm: Mapped[Farm] = relationship(back_populates="assignments")  # noqa: F821


class User(db.Model):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(f"status IN {USER_STATUSES}", name="ck_users_status"),
        CheckConstraint("token_version >= 0", name="ck_users_token_version"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    full_name: Mapped[str] = mapped_column(String(120), nullable=False)
    # Always stored lower-case so uniqueness is case-insensitive.
    email: Mapped[str] = mapped_column(String(254), unique=True, nullable=False, index=True)
    # Argon2id hash. The plaintext password is never stored or logged.
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role_id: Mapped[int] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Incremented on password change / suspension: invalidates every issued token.
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    role: Mapped[Role] = relationship(back_populates="users", lazy="joined")
    assignments: Mapped[list[FarmAssignment]] = relationship(
        foreign_keys=[FarmAssignment.user_id],
        back_populates="user",
        cascade="all, delete-orphan",
    )

    @property
    def role_name(self) -> str:
        return self.role.name

    @property
    def is_admin(self) -> bool:
        return self.role.name == "admin"

    @property
    def is_active(self) -> bool:
        return self.status == "active"

    def __repr__(self) -> str:  # never include the password hash
        return f"<User {self.id} {self.email} {self.role_name}>"
