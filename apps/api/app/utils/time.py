"""Time helpers. All timestamps are stored as naive UTC and serialised as ISO 8601 with 'Z'."""

from __future__ import annotations

from datetime import UTC, date, datetime


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def today() -> date:
    return utcnow().date()


def iso(value: datetime | date | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat() + "Z"
    return value.isoformat()
