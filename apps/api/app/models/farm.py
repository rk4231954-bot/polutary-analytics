"""Farms, poultry batches (flocks) and inspection observations."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.extensions import db
from app.models.user import FarmAssignment, User
from app.utils.time import utcnow

FARM_STATUSES = ("active", "maintenance", "inactive")
HOUSING_TYPES = ("Closed house", "Open-sided house", "Free range", "Other")
POULTRY_TYPES = ("Broiler", "Layer", "Breeder")
BATCH_STATUSES = ("planned", "active", "completed")
HEALTH_STATUSES = ("normal", "attention", "critical")


class Farm(db.Model):
    __tablename__ = "farms"
    __table_args__ = (
        CheckConstraint("capacity > 0", name="ck_farms_capacity"),
        CheckConstraint(f"status IN {FARM_STATUSES}", name="ck_farms_status"),
        CheckConstraint(f"housing_type IN {HOUSING_TYPES}", name="ck_farms_housing_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    location: Mapped[str] = mapped_column(String(160), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    housing_type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active", index=True)
    # Free-text name of the person responsible on site (account access is via FarmAssignment).
    manager_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )

    batches: Mapped[list[PoultryBatch]] = relationship(
        back_populates="farm", cascade="all, delete-orphan", passive_deletes=True
    )
    assignments: Mapped[list[FarmAssignment]] = relationship(
        back_populates="farm", cascade="all, delete-orphan", passive_deletes=True
    )


class PoultryBatch(db.Model):
    __tablename__ = "poultry_batches"
    __table_args__ = (
        UniqueConstraint("farm_id", "code", name="uq_batches_farm_code"),
        CheckConstraint("initial_count > 0", name="ck_batches_initial_count"),
        CheckConstraint(f"status IN {BATCH_STATUSES}", name="ck_batches_status"),
        CheckConstraint(f"poultry_type IN {POULTRY_TYPES}", name="ck_batches_poultry_type"),
        CheckConstraint("end_date IS NULL OR end_date >= start_date", name="ck_batches_dates"),
        Index("ix_batches_farm_status", "farm_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    farm_id: Mapped[int] = mapped_column(ForeignKey("farms.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(20), nullable=False)
    poultry_type: Mapped[str] = mapped_column(String(16), nullable=False)
    breed: Mapped[str | None] = mapped_column(String(80), nullable=True)
    initial_count: Mapped[int] = mapped_column(Integer, nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )

    farm: Mapped[Farm] = relationship(back_populates="batches")
    inspections: Mapped[list[BatchInspection]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="desc(BatchInspection.observed_on), desc(BatchInspection.id)",
    )


class BatchInspection(db.Model):
    """An observation recorded during a health inspection (e.g. by a veterinary user)."""

    __tablename__ = "batch_inspections"
    __table_args__ = (
        CheckConstraint(f"health_status IN {HEALTH_STATUSES}", name="ck_inspections_status"),
        Index("ix_inspections_batch_date", "batch_id", "observed_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("poultry_batches.id", ondelete="CASCADE"), nullable=False
    )
    inspector_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    observed_on: Mapped[date] = mapped_column(Date, nullable=False)
    health_status: Mapped[str] = mapped_column(String(16), nullable=False)
    observation: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    batch: Mapped[PoultryBatch] = relationship(back_populates="inspections")
    inspector: Mapped[User | None] = relationship()
