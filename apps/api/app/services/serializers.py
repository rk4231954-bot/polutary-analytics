"""Model → JSON dictionaries in the camelCase shape the frontend expects.

Password hashes, token versions and other secrets are never serialised.
"""

from __future__ import annotations

import json

from app.models import AuditLog, BatchInspection, DatasetUpload, Farm, PoultryBatch, User
from app.services.permissions import permissions_for
from app.utils.time import iso, today


def user_to_dict(user: User) -> dict:
    farms = sorted((a.farm for a in user.assignments), key=lambda f: f.name.lower())
    return {
        "id": user.id,
        "fullName": user.full_name,
        "email": user.email,
        "role": user.role_name,
        "roleLabel": user.role.label,
        "status": user.status,
        "permissions": sorted(permissions_for(user)),
        "farms": [f.name for f in farms],
        "farmIds": [f.id for f in farms],
        "mustChangePassword": user.must_change_password,
        "lastLoginAt": iso(user.last_login_at),
        "createdAt": iso(user.created_at),
    }


def batch_age_days(batch: PoultryBatch) -> int | None:
    if batch.status == "planned":
        return None
    end = batch.end_date if batch.status == "completed" and batch.end_date else today()
    return max(0, (end - batch.start_date).days)


def batch_to_dict(batch: PoultryBatch) -> dict:
    return {
        "id": batch.id,
        "code": batch.code,
        "farmId": batch.farm_id,
        "farmName": batch.farm.name,
        "poultryType": batch.poultry_type,
        "breed": batch.breed,
        "initialCount": batch.initial_count,
        # Placed birds. Mortality is subtracted once daily readings exist (stage 6).
        "birdCount": batch.initial_count,
        "ageDays": batch_age_days(batch),
        "startDate": iso(batch.start_date),
        "endDate": iso(batch.end_date),
        # Weights come from daily readings (stage 6); not recorded yet.
        "avgWeightG": None,
        "status": batch.status,
        "createdAt": iso(batch.created_at),
        "updatedAt": iso(batch.updated_at),
    }


def farm_to_dict(farm: Farm, stats: dict | None = None) -> dict:
    if stats is None:
        active = [b for b in farm.batches if b.status == "active"]
        stats = {
            "total": len(farm.batches),
            "active": len(active),
            "birds": sum(b.initial_count for b in active),
        }
    return {
        "id": farm.id,
        "code": farm.code,
        "name": farm.name,
        "location": farm.location,
        "capacity": farm.capacity,
        "status": farm.status,
        "housingType": farm.housing_type,
        "manager": farm.manager_name,
        "activeBatches": stats["active"],
        "totalBatches": stats["total"],
        "birdCount": stats["birds"],
        "createdAt": iso(farm.created_at),
        "updatedAt": iso(farm.updated_at),
    }


def inspection_to_dict(item: BatchInspection) -> dict:
    return {
        "id": item.id,
        "batchId": item.batch_id,
        "observedOn": iso(item.observed_on),
        "healthStatus": item.health_status,
        "observation": item.observation,
        "inspector": item.inspector.full_name if item.inspector else None,
        "createdAt": iso(item.created_at),
    }


def audit_to_dict(entry: AuditLog) -> dict:
    return {
        "id": entry.id,
        "timestamp": iso(entry.created_at),
        "actor": entry.actor_email or "anonymous",
        "action": entry.action,
        "resource": f"{entry.resource_type}:{entry.resource_id}"
        if entry.resource_type and entry.resource_id
        else (entry.resource_type or "—"),
        "ip": entry.ip_address,
        "outcome": entry.outcome,
        "details": json.loads(entry.details) if entry.details else {},
    }


def dataset_to_dict(dataset: DatasetUpload, *, detail: bool = False) -> dict:
    processed = dataset.status == "processed"
    report = json.loads(dataset.report) if dataset.report else {}
    hdfs_path = (report.get("hdfs") or {}).get("path") if processed else None
    hive_table = (report.get("hive") or {}).get("table") if hdfs_path else None
    data = {
        "id": dataset.id,
        "filename": dataset.original_filename,
        "status": dataset.status,
        "farmId": dataset.farm_id,
        "farmName": dataset.farm.name if dataset.farm else None,
        "farmCode": dataset.farm.code if dataset.farm else None,
        # Each flag is true only when that step really happened (HDFS copy verified by
        # SHA-256; Hive partition counted with HiveQL).
        "stages": {
            "uploaded": dataset.raw_path is not None,
            "validated": processed,
            "preprocessed": processed and dataset.processed_path is not None,
            "hdfs": hdfs_path is not None,
            "hive": hive_table is not None,
        },
        "readyForHdfs": processed and hdfs_path is None,
        "rowCount": dataset.accepted_rows,
        "totalRows": dataset.total_rows,
        "rejectedRows": dataset.rejected_rows,
        "duplicateRows": dataset.duplicate_rows,
        "errorCount": dataset.error_count,
        "warningCount": dataset.warning_count,
        "sizeBytes": dataset.size_bytes,
        "uploadedBy": dataset.uploaded_by.full_name if dataset.uploaded_by else None,
        "createdAt": iso(dataset.created_at),
        "processedAt": iso(dataset.processed_at),
        "hdfsPath": hdfs_path,
        "hiveTable": hive_table,
        "error": dataset.error,
    }
    if detail:
        data.update(
            sha256=dataset.sha256,
            processedFile=f"data/{dataset.processed_path}" if dataset.processed_path else None,
            hasRejectedRows=dataset.rejected_path is not None,
            report=json.loads(dataset.report) if dataset.report else None,
            history=[
                {
                    "stage": e.stage,
                    "status": e.status,
                    "message": e.message,
                    "createdAt": iso(e.created_at),
                }
                for e in dataset.events
            ],
        )
    return data
