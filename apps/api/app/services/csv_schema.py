"""The daily farm-record CSV schema (authoritative; the frontend mirrors it for pre-checks).

One row = one day of readings for one poultry batch on one farm. Only date,
farm_code and batch_code are required; every reading column is optional, and a
missing reading stays missing (it is never filled in or estimated).

Keep in sync with apps/web/src/utils/datasetProfile.js (EXPECTED_FIELDS).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

FieldType = Literal["date", "code", "number", "integer"]


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    type: FieldType
    required: bool
    description: str
    min: float | None = None
    max: float | None = None
    unit: str | None = None
    aliases: tuple[str, ...] = field(default_factory=tuple)


FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec(
        "date",
        "Date",
        "date",
        True,
        "Day the readings were taken (YYYY-MM-DD).",
        aliases=("record_date", "reading_date", "day", "timestamp"),
    ),
    FieldSpec(
        "farm_code",
        "Farm code",
        "code",
        True,
        "Code of a farm registered in the app (e.g. F-001).",
        aliases=("farm", "farm_id", "farm_name"),
    ),
    FieldSpec(
        "batch_code",
        "Batch code",
        "code",
        True,
        "Code of the poultry batch/flock on that farm (e.g. B-2026-07).",
        aliases=("batch", "batch_id", "flock", "flock_id", "flock_code"),
    ),
    FieldSpec(
        "temperature_c",
        "Temperature",
        "number",
        False,
        "House temperature in degrees Celsius.",
        min=-10,
        max=60,
        unit="°C",
        aliases=("temperature", "temp", "temp_c", "temperature_celsius"),
    ),
    FieldSpec(
        "humidity_pct",
        "Humidity",
        "number",
        False,
        "Relative humidity in percent.",
        min=0,
        max=100,
        unit="%",
        aliases=("humidity", "rh", "relative_humidity", "humidity_percent"),
    ),
    FieldSpec(
        "feed_kg",
        "Feed",
        "number",
        False,
        "Feed consumed that day, in kilograms.",
        min=0,
        unit="kg",
        aliases=("feed", "feed_consumption", "feed_consumption_kg", "feed_intake_kg"),
    ),
    FieldSpec(
        "water_l",
        "Water",
        "number",
        False,
        "Water consumed that day, in litres.",
        min=0,
        unit="L",
        aliases=(
            "water",
            "water_consumption",
            "water_consumption_l",
            "water_litres",
            "water_liters",
        ),
    ),
    FieldSpec(
        "mortality",
        "Mortality",
        "integer",
        False,
        "Birds that died that day.",
        min=0,
        unit="birds",
        aliases=("deaths", "dead", "mortality_count", "dead_birds"),
    ),
    FieldSpec(
        "avg_weight_g",
        "Average weight",
        "number",
        False,
        "Average live body weight per bird, in grams.",
        min=0,
        max=10000,
        unit="g",
        aliases=("weight", "avg_weight", "average_weight", "average_weight_g", "body_weight_g"),
    ),
    FieldSpec(
        "bird_count",
        "Bird count",
        "integer",
        False,
        "Live birds in the batch at the end of the day.",
        min=0,
        unit="birds",
        aliases=("birds", "population", "flock_size", "live_birds"),
    ),
)

FIELDS_BY_KEY = {f.key: f for f in FIELDS}
KEY_FIELDS = ("date", "farm_code", "batch_code")

# Cell values treated as "no value" (compared case-insensitively after trimming).
MISSING_TOKENS = frozenset({"", "na", "n/a", "null", "nan", "none", "-", "?"})

# Same rule as farm and batch codes in the app (app.utils.validation.CODE_RE).
CODE_RE = re.compile(r"^[A-Za-z0-9-]{2,20}$")
# Strict decimal: "12", "-3.5", ".5". No thousands separators, units or exponents.
NUMBER_RE = r"^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$"
# ISO date, optionally followed by a time (the time part is dropped; records are daily).
DATE_RE = r"^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$"

# Column order of every processed file (one stable schema for the future Hive table).
# source_line points back to the line in the original upload.
OUTPUT_COLUMNS: tuple[str, ...] = (*(f.key for f in FIELDS), "source_line")
HIVE_TYPES = {"date": "DATE", "code": "STRING", "number": "DOUBLE", "integer": "INT"}


def output_schema() -> list[dict[str, str]]:
    """Column names and Hive types of the processed CSV (written to manifest.json)."""
    columns = [{"name": f.key, "type": HIVE_TYPES[f.type]} for f in FIELDS]
    columns.append({"name": "source_line", "type": "INT"})
    return columns


def normalise_header(header: str) -> str:
    """'Temperature (°C)' → 'temperature_c' (same rule as the frontend)."""
    ascii_only = header.lower().encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", ascii_only).strip("_")


def auto_map(headers: list[str]) -> dict[str, str]:
    """Suggests a column for each field from header names; each column is used at most once."""
    normalised = [normalise_header(h) for h in headers]
    used: set[int] = set()
    mapping: dict[str, str] = {}
    for spec in FIELDS:
        for candidate in (spec.key, *spec.aliases):
            index = next(
                (i for i, h in enumerate(normalised) if h == candidate and i not in used), None
            )
            if index is not None:
                used.add(index)
                mapping[spec.key] = headers[index]
                break
    return mapping
