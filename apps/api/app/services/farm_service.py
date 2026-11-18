"""Farm, batch and inspection business rules (validation, access, persistence, audit)."""

from __future__ import annotations

from sqlalchemy import case, func, select

from app.extensions import db
from app.models import (
    BATCH_STATUSES,
    FARM_STATUSES,
    HEALTH_STATUSES,
    HOUSING_TYPES,
    POULTRY_TYPES,
    BatchInspection,
    DatasetUpload,
    Farm,
    FarmAssignment,
    PoultryBatch,
    User,
)
from app.services import audit_service
from app.services.permissions import batch_scope, can_access_farm, farm_scope, has_permission
from app.utils.errors import ApiError, ValidationError
from app.utils.time import today
from app.utils.validation import CODE_RE, Validator

CODE_MSG = "Use 2-20 letters, numbers or hyphens."


# --- Farms --------------------------------------------------------------------
def farm_stats(farm_ids: list[int]) -> dict[int, dict]:
    """Batch counts and placed birds per farm in one query."""
    if not farm_ids:
        return {}
    is_active = PoultryBatch.status == "active"
    rows = db.session.execute(
        select(
            PoultryBatch.farm_id,
            func.count(PoultryBatch.id),
            func.sum(case((is_active, 1), else_=0)),
            func.sum(case((is_active, PoultryBatch.initial_count), else_=0)),
        )
        .where(PoultryBatch.farm_id.in_(farm_ids))
        .group_by(PoultryBatch.farm_id)
    )
    stats = {fid: {"total": 0, "active": 0, "birds": 0} for fid in farm_ids}
    for farm_id, total, active, birds in rows:
        stats[farm_id] = {"total": total, "active": int(active or 0), "birds": int(birds or 0)}
    return stats


def list_farms(user: User) -> list[Farm]:
    return list(db.session.scalars(farm_scope(select(Farm), user).order_by(Farm.name)))


def get_farm_for(user: User, farm_id: int) -> Farm:
    """Returns the farm if the user may access it. Unassigned farms look like missing ones (404)."""
    farm = db.session.get(Farm, farm_id)
    if farm is None or not can_access_farm(user, farm.id):
        if farm is not None:
            audit_service.record(
                "access.denied",
                "denied",
                actor=user,
                resource_type="farm",
                resource_id=farm_id,
                details={"reason": "farm not assigned"},
            )
        raise ApiError(404, "NOT_FOUND", "Farm not found.")
    return farm


def _farm_values(data: dict) -> dict:
    v = Validator(data)
    values = {
        "code": v.string(
            "code", "Farm code", required=True, max_len=20, pattern=CODE_RE, pattern_msg=CODE_MSG
        ),
        "name": v.string("name", "Farm name", required=True, min_len=2, max_len=120),
        "location": v.string("location", "Location", required=True, max_len=160),
        "capacity": v.integer(
            "capacity", "Capacity", required=True, min_value=1, max_value=1_000_000
        ),
        "housing_type": v.choice("housingType", HOUSING_TYPES, "Housing type", required=True),
        "status": v.choice("status", FARM_STATUSES, "Status", required=True),
        "manager_name": v.string("manager", "Manager name", max_len=120) or None,
    }
    v.done()
    values["code"] = values["code"].upper()
    return values


def _ensure_unique_farm_code(code: str, exclude_id: int | None = None) -> None:
    stmt = select(Farm.id).where(Farm.code == code)
    if exclude_id is not None:
        stmt = stmt.where(Farm.id != exclude_id)
    if db.session.scalar(stmt) is not None:
        raise ValidationError(
            {"code": "A farm with this code already exists."}, "Farm code already in use."
        )


def create_farm(user: User, data: dict) -> Farm:
    values = _farm_values(data)
    _ensure_unique_farm_code(values["code"])
    farm = Farm(**values, created_by_id=user.id)
    db.session.add(farm)
    db.session.flush()
    if not user.is_admin:
        # A farm manager who creates a farm is assigned to it automatically.
        db.session.add(FarmAssignment(user_id=user.id, farm_id=farm.id, assigned_by_id=user.id))
    audit_service.record(
        "farm.create",
        actor=user,
        resource_type="farm",
        resource_id=farm.id,
        details={"code": farm.code, "name": farm.name},
        commit=False,
    )
    db.session.commit()
    return farm


def update_farm(user: User, farm: Farm, data: dict) -> Farm:
    values = _farm_values(data)  # PUT: the full farm is sent and validated
    _ensure_unique_farm_code(values["code"], exclude_id=farm.id)
    changed = {k: v for k, v in values.items() if getattr(farm, k) != v}
    for key, value in changed.items():
        setattr(farm, key, value)
    audit_service.record(
        "farm.update",
        actor=user,
        resource_type="farm",
        resource_id=farm.id,
        details={"changed": sorted(changed)},
        commit=False,
    )
    db.session.commit()
    return farm


def delete_farm(user: User, farm: Farm) -> None:
    active = db.session.scalar(
        select(func.count(PoultryBatch.id)).where(
            PoultryBatch.farm_id == farm.id, PoultryBatch.status == "active"
        )
    )
    if active:
        raise ApiError(
            409,
            "FARM_HAS_ACTIVE_BATCHES",
            f"This farm has {active} active batch(es). "
            "Complete or remove them before deleting the farm.",
        )
    datasets = db.session.scalar(
        select(func.count(DatasetUpload.id)).where(DatasetUpload.farm_id == farm.id)
    )
    if datasets:
        raise ApiError(
            409,
            "FARM_HAS_DATASETS",
            f"This farm has {datasets} uploaded dataset(s). "
            "Delete them under Data Management before deleting the farm.",
        )
    audit_service.record(
        "farm.delete",
        actor=user,
        resource_type="farm",
        resource_id=farm.id,
        details={"code": farm.code, "name": farm.name, "batches": len(farm.batches)},
        commit=False,
    )
    db.session.delete(farm)
    db.session.commit()


# --- Batches ------------------------------------------------------------------
def list_batches(user: User, farm_id: int | None, status: str | None) -> list[PoultryBatch]:
    stmt = batch_scope(select(PoultryBatch), user).join(PoultryBatch.farm)
    if farm_id is not None:
        stmt = stmt.where(PoultryBatch.farm_id == farm_id)
    if status:
        if status not in BATCH_STATUSES:
            raise ApiError(400, "BAD_QUERY", f"status must be one of: {', '.join(BATCH_STATUSES)}.")
        stmt = stmt.where(PoultryBatch.status == status)
    return list(
        db.session.scalars(stmt.order_by(PoultryBatch.start_date.desc(), PoultryBatch.id.desc()))
    )


def get_batch_for(user: User, batch_id: int) -> PoultryBatch:
    batch = db.session.get(PoultryBatch, batch_id)
    if batch is None or not can_access_farm(user, batch.farm_id):
        if batch is not None:
            audit_service.record(
                "access.denied",
                "denied",
                actor=user,
                resource_type="batch",
                resource_id=batch_id,
                details={"reason": "farm not assigned"},
            )
        raise ApiError(404, "NOT_FOUND", "Batch not found.")
    return batch


def _batch_values(user: User, data: dict) -> dict:
    v = Validator(data)
    values = {
        "code": v.string(
            "code", "Batch ID", required=True, max_len=20, pattern=CODE_RE, pattern_msg=CODE_MSG
        ),
        "farm_id": v.integer("farmId", "Farm", required=True, min_value=1),
        "poultry_type": v.choice("poultryType", POULTRY_TYPES, "Poultry type", required=True),
        "breed": v.string("breed", "Breed", max_len=80),
        "initial_count": v.integer(
            "initialCount", "Initial bird count", required=True, min_value=1, max_value=200_000
        ),
        "start_date": v.date("startDate", "Start date", required=True),
        "end_date": v.date("endDate", "End date"),
        "status": v.choice("status", BATCH_STATUSES, "Status", required=True),
    }
    if (
        values["start_date"]
        and values["status"] in ("active", "completed")
        and values["start_date"] > today()
    ):
        v.errors["startDate"] = "Only planned batches can start in the future."
    v.done()
    values["code"] = values["code"].upper()
    if values["status"] == "completed" and values["end_date"] is None:
        values["end_date"] = max(today(), values["start_date"])
    if values["status"] != "completed":
        values["end_date"] = None
    if values["end_date"] and values["end_date"] < values["start_date"]:
        raise ValidationError({"endDate": "End date cannot be before the start date."})
    if (
        not can_access_farm(user, values["farm_id"])
        or db.session.get(Farm, values["farm_id"]) is None
    ):
        raise ValidationError({"farmId": "Choose one of your farms."})
    return values


def _ensure_unique_batch_code(farm_id: int, code: str, exclude_id: int | None = None) -> None:
    stmt = select(PoultryBatch.id).where(PoultryBatch.farm_id == farm_id, PoultryBatch.code == code)
    if exclude_id is not None:
        stmt = stmt.where(PoultryBatch.id != exclude_id)
    if db.session.scalar(stmt) is not None:
        raise ValidationError(
            {"code": "This farm already has a batch with this ID."}, "Batch ID already in use."
        )


def create_batch(user: User, data: dict) -> PoultryBatch:
    values = _batch_values(user, data)
    _ensure_unique_batch_code(values["farm_id"], values["code"])
    batch = PoultryBatch(**values, created_by_id=user.id)
    db.session.add(batch)
    db.session.flush()
    audit_service.record(
        "batch.create",
        actor=user,
        resource_type="batch",
        resource_id=batch.id,
        details={"code": batch.code, "farmId": batch.farm_id},
        commit=False,
    )
    db.session.commit()
    return batch


def update_batch(user: User, batch: PoultryBatch, data: dict) -> PoultryBatch:
    values = _batch_values(user, data)
    _ensure_unique_batch_code(values["farm_id"], values["code"], exclude_id=batch.id)
    changed = {k: v for k, v in values.items() if getattr(batch, k) != v}
    for key, value in changed.items():
        setattr(batch, key, value)
    audit_service.record(
        "batch.update",
        actor=user,
        resource_type="batch",
        resource_id=batch.id,
        details={"changed": sorted(changed)},
        commit=False,
    )
    db.session.commit()
    return batch


def delete_batch(user: User, batch: PoultryBatch) -> None:
    if batch.status == "active":
        raise ApiError(
            409, "BATCH_ACTIVE", "Active batches cannot be deleted. Mark the batch completed first."
        )
    audit_service.record(
        "batch.delete",
        actor=user,
        resource_type="batch",
        resource_id=batch.id,
        details={"code": batch.code, "farmId": batch.farm_id},
        commit=False,
    )
    db.session.delete(batch)
    db.session.commit()


# --- Inspections --------------------------------------------------------------
def can_view_health(user: User) -> bool:
    return has_permission(user, "health.view")


def record_inspection(user: User, batch: PoultryBatch, data: dict) -> BatchInspection:
    v = Validator(data)
    observed_on = v.date("observedOn", "Inspection date", required=True)
    status = v.choice("healthStatus", HEALTH_STATUSES, "Health status", required=True)
    observation = v.string("observation", "Observation", required=True, min_len=3, max_len=2000)
    if observed_on and observed_on > today():
        v.errors["observedOn"] = "The inspection date cannot be in the future."
    if observed_on and observed_on < batch.start_date:
        v.errors["observedOn"] = "The inspection date cannot be before the batch started."
    v.done()
    item = BatchInspection(
        batch_id=batch.id,
        inspector_id=user.id,
        observed_on=observed_on,
        health_status=status,
        observation=observation,
    )
    db.session.add(item)
    db.session.flush()
    audit_service.record(
        "inspection.create",
        actor=user,
        resource_type="batch",
        resource_id=batch.id,
        details={"inspectionId": item.id, "healthStatus": status},
        commit=False,
    )
    db.session.commit()
    return item
