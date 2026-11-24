"""Broiler flock performance reference data: upload → validate → HDFS → Hive → HiveQL.

Source: Kaggle dataset "Broiler Performance Index" by isa zulka (Apache 2.0),
https://www.kaggle.com/datasets/isazulka/broiler-performance-index, file `PS Performance.csv`.
Each row summarises one broiler flock at harvest. The file has no date, farm or batch, so
it is kept apart from the daily farm records (poultry_records_cleaned / poultry_uploads):
nothing is invented to make it fit that schema.

Columns (Indonesian headers, as published):
    Umur     age at harvest, days
    BW       average body weight, kg
    %Panen   share of the flock harvested, %
    Deplesi  depletion (dead + culled birds), % of the flock
    IP       Indeks Performa (European production efficiency factor)

Validation only rejects rows; it never fills, corrects or estimates a value. Exact duplicate
rows are kept (two flocks can share the same five rounded figures) and are counted in the
report.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
from pathlib import PurePosixPath
from typing import Any

from flask import current_app
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from app.models import User
from app.services import audit_service, hdfs_client, hive_client, hive_queries
from app.services.dataset_service import ALLOWED_MIME_TYPES, max_upload_bytes
from app.utils.errors import ApiError
from app.utils.time import iso, utcnow

SOURCE = {
    "name": "Broiler Performance Index",
    "publisher": "Kaggle (uploaded by isa zulka)",
    "url": "https://www.kaggle.com/datasets/isazulka/broiler-performance-index",
    "license": "Apache 2.0",
    "file": "PS Performance.csv",
    "note": (
        "Flock-level harvest summaries. The publisher does not state where or when the "
        "flocks were raised, and the file has no dates, farms or batches."
    ),
}

# (CSV header, Hive column, label, minimum, maximum). The bounds only reject impossible
# values (e.g. a negative weight or a percentage above 100); they don't trim outliers.
COLUMNS: tuple[tuple[str, str, str, float, float], ...] = (
    ("Umur", "age_days", "Age (days)", 1, 120),
    ("BW", "body_weight_kg", "Body weight (kg)", 0.01, 10),
    ("%Panen", "harvest_pct", "Harvested (%)", 0, 100),
    ("Deplesi", "depletion_pct", "Depletion (%)", 0, 100),
    ("IP", "performance_index", "Performance index", 0, 2000),
)
HEADER = [c[0] for c in COLUMNS]
MAX_REPORTED_ERRORS = 25
_HIVE_ERRORS = (
    hive_client.HiveUnavailableError,
    hive_client.HiveAuthError,
    hive_client.HiveQueryError,
)


def _folder() -> str:
    return f"{hdfs_client.processed_root()}/flock_performance"


def _table() -> str:
    return current_app.config["HIVE_FLOCK_TABLE"]


def _audit(user: User, outcome: str, **details: Any) -> None:
    audit_service.record(
        "flock_performance.upload",
        outcome,
        actor=user,
        resource_type="reference_dataset",
        resource_id="flock_performance",
        details=details,
    )


def _fail(user: User, status: int, code: str, message: str, **details: Any) -> ApiError:
    _audit(user, "failure", reason=code, **details)
    return ApiError(status, code, message)


def parse(data: bytes) -> dict[str, Any]:
    """Validates the CSV. Returns accepted rows as CSV text (no header) plus a report."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ApiError(400, "VALIDATION_ERROR", "The file is not UTF-8 text.") from None
    reader = csv.reader(io.StringIO(text))
    header = [h.strip() for h in next(reader, [])]
    if header != HEADER:
        raise ApiError(
            400,
            "VALIDATION_ERROR",
            f"Expected the columns {', '.join(HEADER)} (the Kaggle file 'PS Performance.csv'); "
            f"found {', '.join(header) or 'none'}.",
        )
    accepted: list[str] = []
    errors: list[dict[str, Any]] = []
    rejected = total = 0
    seen: set[tuple[str, ...]] = set()
    duplicates = 0
    for line_no, raw in enumerate(reader, start=2):
        if not any(cell.strip() for cell in raw):
            continue  # blank line
        total += 1
        cells = [c.strip() for c in raw]
        problem = None
        if len(cells) != len(COLUMNS):
            problem = f"expected {len(COLUMNS)} values, found {len(cells)}"
        else:
            for cell, (name, _col, label, low, high) in zip(cells, COLUMNS, strict=True):
                try:
                    value = float(cell)
                except ValueError:
                    problem = f"{name} '{cell[:20]}' is not a number"
                    break
                if not math.isfinite(value) or not low <= value <= high:
                    problem = f"{label} {cell} is outside {low:g}–{high:g}"
                    break
        if problem:
            rejected += 1
            if len(errors) < MAX_REPORTED_ERRORS:
                errors.append({"line": line_no, "message": problem})
            continue
        key = tuple(cells)
        duplicates += key in seen
        seen.add(key)
        accepted.append(",".join([*cells, str(line_no)]))
    if not accepted:
        raise ApiError(400, "VALIDATION_ERROR", "The file has no valid rows.")
    return {
        "body": ("\n".join(accepted) + "\n").encode(),
        "report": {
            "totalRows": total,
            "acceptedRows": len(accepted),
            "rejectedRows": rejected,
            "exactDuplicateRows": duplicates,
            "errors": errors,
        },
    }


def upload(user: User, file: FileStorage | None) -> dict[str, Any]:
    if file is None or not file.filename:
        raise _fail(user, 400, "FILE_REQUIRED", "Choose a CSV file to upload.")
    filename = secure_filename(file.filename)[:255] or "upload.csv"
    if PurePosixPath(filename).suffix.lower() != ".csv":
        raise _fail(user, 415, "INVALID_FILE_TYPE", "Only .csv files are accepted.")
    if (file.mimetype or "").lower() not in ALLOWED_MIME_TYPES:
        raise _fail(user, 415, "INVALID_FILE_TYPE", "Upload a CSV file.")
    limit = max_upload_bytes()
    data = file.stream.read(limit + 1)
    if len(data) > limit:
        raise _fail(user, 413, "FILE_TOO_LARGE", "The file is larger than the upload limit.")
    if not data:
        raise _fail(user, 400, "EMPTY_FILE", "The file is empty.")
    try:
        parsed = parse(data)
    except ApiError as exc:
        _audit(user, "failure", reason=exc.code, filename=filename)
        raise
    report = parsed["report"]
    original_sha = hashlib.sha256(data).hexdigest()

    if not current_app.config["HDFS_ENABLED"]:
        raise _fail(user, 503, "HDFS_DISABLED", "HDFS storage is turned off (HDFS_ENABLED=false).")
    folder = _folder()
    path = f"{folder}/records.csv"
    try:
        hdfs_client.mkdirs(folder)
        sha = hdfs_client.store_verified(path, parsed["body"])
        manifest = {
            "source": SOURCE,
            "originalFilename": filename,
            "originalSha256": original_sha,
            "columns": [{"csv": c[0], "hive": c[1]} for c in COLUMNS] + [{"hive": "source_line"}],
            "report": {k: v for k, v in report.items() if k != "errors"},
            "hdfs": {"path": path, "sha256": sha, "header": False},
            "uploadedAt": iso(utcnow()),
            "uploadedBy": user.email,
        }
        hdfs_client.store_verified(f"{folder}/_manifest.json", json.dumps(manifest).encode())
    except hdfs_client.HdfsError as exc:
        raise _fail(user, 503, "HDFS_UNAVAILABLE", f"Not stored in HDFS: {exc}") from None

    table = _table()
    try:
        hive_client.run_statement(
            *hive_queries.create_flock_table(table, folder), name="create_flock_table"
        )
        rows = hive_client.run_query(*hive_queries.count_flock_rows(table), name="count_flock_rows")
    except _HIVE_ERRORS as exc:
        _audit(user, "failure", reason=exc.code, hdfsPath=path)
        raise
    counted = int(rows[0]["row_count"]) if rows else 0
    if counted != report["acceptedRows"]:
        raise _fail(
            user,
            502,
            "HIVE_COUNT_MISMATCH",
            f"Hive read {counted} rows but {report['acceptedRows']} were stored in HDFS.",
            hdfsPath=path,
        )
    hive = {"table": f"{current_app.config['HIVE_DATABASE']}.{table}", "rowCount": counted}
    _audit(
        user,
        "success",
        filename=filename,
        sha256=original_sha,
        acceptedRows=report["acceptedRows"],
        rejectedRows=report["rejectedRows"],
        hdfsPath=path,
        hiveTable=hive["table"],
    )
    return {"source": SOURCE, "report": report, "hdfs": {"path": path, "sha256": sha}, "hive": hive}


def _float(value: Any) -> float | None:
    return None if value is None else float(value)


def summary() -> dict[str, Any]:
    """HiveQL aggregates over the flock table; {"loaded": False} until a file is uploaded."""
    table = _table()
    source = {"engine": "Apache Hive", "table": f"{current_app.config['HIVE_DATABASE']}.{table}"}
    if not hive_client.run_query(
        *hive_queries.flock_table_exists(table), name="flock_table_exists"
    ):
        return {"loaded": False, "dataset": SOURCE, "source": source}
    totals = hive_client.run_query(*hive_queries.flock_summary(table), name="flock_summary")
    bands = hive_client.run_query(*hive_queries.flock_depletion_bands(table), name="flock_bands")
    row = totals[0] if totals else {}
    if not row.get("flocks"):
        return {"loaded": False, "dataset": SOURCE, "source": source}
    return {
        "loaded": True,
        "dataset": SOURCE,
        "source": source,
        "flocks": int(row["flocks"]),
        "ageDays": {k: _float(row[f"{k}_age_days"]) for k in ("avg", "min", "max")},
        "bodyWeightKg": {k: _float(row[f"{k}_body_weight_kg"]) for k in ("avg", "min", "max")},
        "depletionPct": {k: _float(row[f"{k}_depletion_pct"]) for k in ("avg", "min", "max")},
        "harvestPct": {"avg": _float(row["avg_harvest_pct"])},
        "performanceIndex": {
            k: _float(row[f"{k}_performance_index"]) for k in ("avg", "min", "max")
        },
        # Pearson correlation computed by Hive's CORR(); association only, not causation.
        "correlations": {
            "bodyWeightVsIndex": _float(row["corr_weight_index"]),
            "depletionVsIndex": _float(row["corr_depletion_index"]),
            "ageVsIndex": _float(row["corr_age_index"]),
        },
        "depletionBands": [
            {
                "band": b["band"],
                "flocks": int(b["flocks"]),
                "avgBodyWeightKg": _float(b["avg_body_weight_kg"]),
                "avgAgeDays": _float(b["avg_age_days"]),
                "avgPerformanceIndex": _float(b["avg_performance_index"]),
            }
            for b in bands
        ],
    }
