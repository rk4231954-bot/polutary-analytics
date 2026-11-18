"""CSV dataset ingestion: upload checks, local storage, SQLite metadata, history and audit.

Stage 6 ends with a processed CSV on local disk, marked ready for HDFS. Writing it
to HDFS (stage 7) and exposing it in Hive (stage 8) are NOT done here; the
dataset's hdfs/hive stages stay false until those stages really happen.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
from pathlib import PurePosixPath

from flask import current_app
from sqlalchemy import or_, select
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from app.extensions import db
from app.models import DatasetEvent, DatasetUpload, Farm, PoultryBatch, User
from app.services import audit_service
from app.services.csv_ingestion import FarmContext, IngestionResult, ingest
from app.services.csv_schema import FIELDS_BY_KEY, output_schema
from app.services.permissions import accessible_farm_ids, can_access_farm
from app.utils import storage
from app.utils.errors import ApiError, ValidationError
from app.utils.time import iso, today, utcnow

log = logging.getLogger(__name__)

# Browsers send different types for .csv (Windows/Excel: application/vnd.ms-excel).
# The content itself is always checked afterwards (UTF-8 text, no binary data, valid CSV).
ALLOWED_MIME_TYPES = frozenset(
    {
        "text/csv",
        "application/csv",
        "text/x-csv",
        "text/comma-separated-values",
        "application/vnd.ms-excel",
        "text/plain",
    }
)
PREVIEW_KINDS = ("processed", "rejected")


def max_upload_bytes() -> int:
    return current_app.config["MAX_UPLOAD_MB"] * 1024 * 1024


def _event(dataset: DatasetUpload, stage: str, status: str, message: str) -> None:
    dataset.events.append(DatasetEvent(stage=stage, status=status, message=message[:500]))


def _reject(user: User, status: int, code: str, message: str, **details) -> ApiError:
    """Audits a refused upload (no dataset record is created) and returns the error."""
    audit_service.record(
        "dataset.upload",
        "failure",
        actor=user,
        resource_type="dataset",
        details={"reason": code, **details},
    )
    return ApiError(status, code, message)


def reject_too_large(user: User) -> ApiError:
    return _reject(
        user,
        413,
        "FILE_TOO_LARGE",
        f"The file is larger than the {current_app.config['MAX_UPLOAD_MB']} MB upload limit.",
    )


def _parse_mapping(raw: str | None) -> dict[str, str] | None:
    if raw is None or raw.strip() in ("", "{}"):
        return None  # matched automatically from the header names
    try:
        mapping = json.loads(raw)
    except ValueError as exc:
        raise ValidationError({"mapping": "Column mapping must be valid JSON."}) from exc
    if not isinstance(mapping, dict):
        raise ValidationError({"mapping": "Column mapping must be a JSON object."})
    clean: dict[str, str] = {}
    for key, column in mapping.items():
        if key not in FIELDS_BY_KEY:
            raise ValidationError({"mapping": f"Unknown field '{key}' in the column mapping."})
        if column in (None, ""):
            continue
        if not isinstance(column, str) or len(column) > 200:
            raise ValidationError({"mapping": f"Invalid column name for '{key}'."})
        clean[key] = column.strip()
    return clean or None


def _selected_farm(user: User, raw: str | None) -> Farm | None:
    if raw is None or raw.strip() == "":
        return None
    try:
        farm_id = int(raw)
    except ValueError as exc:
        raise ValidationError({"farmId": "Choose one of your farms."}) from exc
    farm = db.session.get(Farm, farm_id)
    if farm is None or not can_access_farm(user, farm.id):
        raise ValidationError({"farmId": "Choose one of your farms."})
    return farm


def _farm_context(user: User, selected: Farm | None) -> FarmContext:
    ids = accessible_farm_ids(user)
    stmt = select(Farm.code, Farm.id)
    if ids is not None:
        stmt = stmt.where(Farm.id.in_(ids or {-1}))
    accessible = {code.upper(): fid for code, fid in db.session.execute(stmt)}
    batches: dict[str, set[str]] = {}
    rows = db.session.execute(
        select(Farm.code, PoultryBatch.code)
        .join(PoultryBatch.farm)
        .where(Farm.id.in_(list(accessible.values()) or [-1]))
    )
    for farm_code, batch_code in rows:
        batches.setdefault(farm_code.upper(), set()).add(batch_code.upper())
    return FarmContext(accessible, selected.code.upper() if selected else None, batches)


def _rejected_csv(rejected: list[dict]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["source_line", "errors", "raw_record"])
    for item in rejected:
        writer.writerow([item["line"], " | ".join(item["errors"]), item["raw"]])
    return buffer.getvalue().encode("utf-8")


def _count(report: dict, bucket: str) -> int:
    return sum(item["count"] for item in report.get(bucket, []))


def upload_dataset(
    user: User, file: FileStorage | None, mapping_raw: str | None, farm_raw: str | None
) -> DatasetUpload:
    # --- Request checks (refused uploads are audited but not stored) -------------
    if file is None or not file.filename:
        raise _reject(user, 400, "FILE_REQUIRED", "Choose a CSV file to upload.")
    filename = secure_filename(file.filename)[:255] or "upload.csv"
    if PurePosixPath(filename).suffix.lower() != ".csv":
        raise _reject(
            user, 415, "INVALID_FILE_TYPE", "Only .csv files are accepted.", filename=filename
        )
    mime = (file.mimetype or "").lower()
    if mime not in ALLOWED_MIME_TYPES:
        raise _reject(
            user,
            415,
            "INVALID_FILE_TYPE",
            f"The file type '{mime or 'unknown'}' is not accepted; upload a CSV file.",
            filename=filename,
        )
    mapping = _parse_mapping(mapping_raw)
    selected = _selected_farm(user, farm_raw)

    limit = max_upload_bytes()
    data = file.stream.read(limit + 1)
    if len(data) > limit:
        raise reject_too_large(user)
    if not data.strip():
        raise _reject(user, 400, "EMPTY_FILE", "The file is empty.", filename=filename)

    # --- Store the original file and create the record ---------------------------
    dataset = DatasetUpload(
        farm_id=selected.id if selected else None,
        uploaded_by_id=user.id,
        original_filename=filename,
        content_type=mime,
        size_bytes=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        status="uploaded",
    )
    db.session.add(dataset)
    db.session.flush()
    raw_dir = storage.raw_dir(dataset.id, dataset.farm_id)
    try:
        storage.write_bytes(f"{raw_dir}/{storage.RAW_FILE}", data)
    except OSError:
        db.session.rollback()
        log.exception("Could not store upload")
        raise ApiError(500, "STORAGE_FAILED", "The file could not be stored. Try again.") from None
    dataset.raw_path = f"{raw_dir}/{storage.RAW_FILE}"
    _event(dataset, "upload", "success", f"File received ({len(data):,} bytes).")
    db.session.commit()

    # --- Validate and preprocess ----------------------------------------------------
    written: list[str] = []
    try:
        dataset.status = "validating"
        result = ingest(data, mapping, _farm_context(user, selected), today())
        _finish(dataset, result, raw_dir, written)
    except Exception:
        db.session.rollback()
        log.exception("Dataset %s processing failed", dataset.id)
        for folder in written:  # remove a half-written processed folder
            try:
                storage.remove_dir(folder)
            except (OSError, storage.StorageError):
                log.exception("Could not remove %s", folder)
        dataset = db.session.get(DatasetUpload, dataset.id)
        dataset.status = "failed"
        dataset.error = "An internal error stopped processing. The original file was kept."
        _event(dataset, "processing", "failure", dataset.error)

    audit_service.record(
        "dataset.upload",
        "success" if dataset.status == "processed" else "failure",
        actor=user,
        resource_type="dataset",
        resource_id=dataset.id,
        details={
            "filename": filename,
            "status": dataset.status,
            "farmId": dataset.farm_id,
            "acceptedRows": dataset.accepted_rows,
            "rejectedRows": dataset.rejected_rows,
        },
        commit=False,
    )
    db.session.commit()
    return dataset


def _finish(
    dataset: DatasetUpload, result: IngestionResult, raw_dir: str, written: list[str]
) -> None:
    report = result.report
    summary = report["summary"]
    farm_id = None
    if result.farm_code:
        farm_id = db.session.scalar(select(Farm.id).where(Farm.code == result.farm_code))

    # Same file content already processed for this farm: warn (it is not rejected).
    if result.ok and dataset.sha256:
        earlier = db.session.scalar(
            select(DatasetUpload.id).where(
                DatasetUpload.sha256 == dataset.sha256,
                DatasetUpload.farm_id == farm_id,
                DatasetUpload.status == "processed",
                DatasetUpload.id != dataset.id,
            )
        )
        if earlier:
            report["warnings"].append(
                {
                    "code": "same_file_uploaded",
                    "message": f"This exact file was already processed as dataset #{earlier}.",
                    "count": 1,
                    "examples": [],
                }
            )

    dataset.total_rows = summary.get("totalRows")
    dataset.accepted_rows = summary.get("acceptedRows")
    dataset.rejected_rows = summary.get("rejectedRows")
    dataset.duplicate_rows = summary.get("duplicateRowsRemoved")
    dataset.error_count = _count(report, "errors")
    dataset.warning_count = _count(report, "warnings")

    if result.rejected:
        rejected_path = f"{raw_dir}/{storage.REJECTED_FILE}"
        storage.write_bytes(rejected_path, _rejected_csv(result.rejected))
        dataset.rejected_path = rejected_path

    if not result.ok:
        dataset.status = "failed"
        dataset.error = (result.error or "Validation failed.")[:500]
        dataset.report = json.dumps(report)
        _event(dataset, "validation", "failure", dataset.error)
        return

    _event(
        dataset,
        "validation",
        "warning" if dataset.rejected_rows or dataset.warning_count else "success",
        f"{dataset.accepted_rows:,} of {dataset.total_rows:,} rows valid; "
        f"{dataset.rejected_rows:,} rejected, {dataset.duplicate_rows:,} duplicates removed, "
        f"{dataset.warning_count:,} warnings.",
    )
    dataset.status = "processing"
    out_dir = storage.processed_dir(dataset.id, farm_id)
    written.append(out_dir)
    records = result.processed.to_csv(index=False, na_rep="", lineterminator="\n").encode()
    manifest = {
        "datasetId": dataset.id,
        "farmId": farm_id,
        "farmCode": result.farm_code,
        "file": storage.PROCESSED_FILE,
        "rowCount": int(len(result.processed)),
        "sha256": hashlib.sha256(records).hexdigest(),
        "format": {"delimiter": ",", "header": True, "encoding": "utf-8", "nullValue": ""},
        "columns": output_schema(),
        "dateRange": summary.get("dateRange"),
        "source": {"filename": dataset.original_filename, "sha256": dataset.sha256},
        "createdAt": iso(utcnow()),
        "hdfs": {"stored": False, "note": "Written to HDFS in stage 7."},
    }
    storage.write_bytes(f"{out_dir}/{storage.PROCESSED_FILE}", records)
    storage.write_bytes(
        f"{out_dir}/{storage.MANIFEST_FILE}", json.dumps(manifest, indent=2).encode()
    )
    dataset.processed_path = f"{out_dir}/{storage.PROCESSED_FILE}"
    dataset.report = json.dumps(report)
    _event(
        dataset,
        "preprocessing",
        "success",
        f"Cleaned {dataset.accepted_rows:,} rows into the standard schema "
        f"({len(output_schema())} columns).",
    )
    _event(
        dataset,
        "local_storage",
        "success",
        f"Processed file saved to data/{dataset.processed_path}; ready for HDFS (stage 7).",
    )
    # File the raw upload (and rejected rows) under its farm now that the farm is known.
    if dataset.farm_id is None:
        target = storage.raw_dir(dataset.id, farm_id)
        storage.move_dir(raw_dir, target)
        dataset.raw_path = f"{target}/{storage.RAW_FILE}"
        if dataset.rejected_path:
            dataset.rejected_path = f"{target}/{storage.REJECTED_FILE}"
    dataset.farm_id = farm_id
    dataset.status = "processed"
    dataset.processed_at = utcnow()


# --- Reading ------------------------------------------------------------------------
def _visible(statement, user: User):
    if user.is_admin:
        return statement
    ids = accessible_farm_ids(user) or {-1}
    return statement.where(
        or_(
            DatasetUpload.farm_id.in_(ids),
            (DatasetUpload.farm_id.is_(None)) & (DatasetUpload.uploaded_by_id == user.id),
        )
    )


def list_datasets(user: User, farm_id: int | None, limit: int) -> list[DatasetUpload]:
    stmt = _visible(select(DatasetUpload), user)
    if farm_id is not None:
        stmt = stmt.where(DatasetUpload.farm_id == farm_id)
    stmt = stmt.order_by(DatasetUpload.created_at.desc(), DatasetUpload.id.desc()).limit(limit)
    return list(db.session.scalars(stmt))


def get_dataset_for(user: User, dataset_id: int) -> DatasetUpload:
    dataset = db.session.scalar(
        _visible(select(DatasetUpload).where(DatasetUpload.id == dataset_id), user)
    )
    if dataset is None:
        if db.session.get(DatasetUpload, dataset_id) is not None:
            audit_service.record(
                "access.denied",
                "denied",
                actor=user,
                resource_type="dataset",
                resource_id=dataset_id,
                details={"reason": "farm not assigned"},
            )
        raise ApiError(404, "NOT_FOUND", "Dataset not found.")
    return dataset


def preview(dataset: DatasetUpload, kind: str, offset: int, limit: int) -> dict:
    if kind not in PREVIEW_KINDS:
        raise ApiError(400, "BAD_QUERY", f"kind must be one of: {', '.join(PREVIEW_KINDS)}.")
    relative = dataset.processed_path if kind == "processed" else dataset.rejected_path
    total = (dataset.accepted_rows if kind == "processed" else dataset.rejected_rows) or 0
    if not relative:
        return {"kind": kind, "columns": [], "rows": [], "total": 0, "offset": offset}
    path = storage.resolve(relative)
    if not path.is_file():
        raise ApiError(410, "FILE_MISSING", "The stored file for this dataset is missing.")
    columns: list[str] = []
    rows: list[list[str | None]] = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        columns = next(reader, [])
        for index, row in enumerate(reader):
            if index < offset:
                continue
            if len(rows) >= limit:
                break
            rows.append([value if value != "" else None for value in row])
    return {"kind": kind, "columns": columns, "rows": rows, "total": total, "offset": offset}


def delete_dataset(user: User, dataset: DatasetUpload) -> None:
    raw_dir = str(PurePosixPath(dataset.raw_path).parent) if dataset.raw_path else None
    processed = (
        str(PurePosixPath(dataset.processed_path).parent) if dataset.processed_path else None
    )
    audit_service.record(
        "dataset.delete",
        actor=user,
        resource_type="dataset",
        resource_id=dataset.id,
        details={
            "filename": dataset.original_filename,
            "farmId": dataset.farm_id,
            "status": dataset.status,
        },
        commit=False,
    )
    db.session.delete(dataset)
    db.session.commit()
    for folder in (processed, raw_dir):
        try:
            storage.remove_dir(folder)
        except (OSError, storage.StorageError):
            log.exception("Could not remove dataset folder %s", folder)
