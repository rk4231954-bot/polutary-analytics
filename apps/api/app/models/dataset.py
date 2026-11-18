"""Uploaded CSV datasets and their processing history.

Only metadata lives here. The files themselves are stored under DATA_DIR
(raw upload + processed CSV); paths are saved relative to DATA_DIR.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.extensions import db
from app.models.farm import Farm
from app.models.user import User
from app.utils.time import utcnow

# uploaded → validating → processing → processed (ready for HDFS, stage 7) | failed
DATASET_STATUSES = ("uploaded", "validating", "processing", "processed", "failed")
EVENT_STATUSES = ("success", "warning", "failure")


class DatasetUpload(db.Model):
    __tablename__ = "dataset_uploads"
    __table_args__ = (
        CheckConstraint(f"status IN {DATASET_STATUSES}", name="ck_datasets_status"),
        CheckConstraint("size_bytes >= 0", name="ck_datasets_size"),
        Index("ix_datasets_farm_created", "farm_id", "created_at"),
        Index("ix_datasets_sha256", "sha256"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Null until the farm is known (a file rejected before its farm could be resolved).
    # RESTRICT: a farm with datasets cannot be deleted until the datasets are removed.
    farm_id: Mapped[int | None] = mapped_column(
        ForeignKey("farms.id", ondelete="RESTRICT"), nullable=True
    )
    uploaded_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Sanitised (secure_filename) display name; never used to build a path.
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="uploaded")

    total_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    accepted_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rejected_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duplicate_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    warning_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Paths relative to DATA_DIR.
    raw_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    processed_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rejected_path: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # JSON validation report (errors, warnings, transformations, summary).
    report: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Short user-facing reason when status == "failed".
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )
    processed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    farm: Mapped[Farm | None] = relationship()
    uploaded_by: Mapped[User | None] = relationship()
    events: Mapped[list[DatasetEvent]] = relationship(
        back_populates="dataset",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="DatasetEvent.id",
    )


class DatasetEvent(db.Model):
    """One step of a dataset's processing history (received, validated, preprocessed, ...)."""

    __tablename__ = "dataset_events"
    __table_args__ = (
        CheckConstraint(f"status IN {EVENT_STATUSES}", name="ck_dataset_events_status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dataset_id: Mapped[int] = mapped_column(
        ForeignKey("dataset_uploads.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stage: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    dataset: Mapped[DatasetUpload] = relationship(back_populates="events")
