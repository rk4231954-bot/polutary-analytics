"""Farm analytics computed by HiveQL on Apache Hive.

SQLite (application data) decides *which* farms a user may see; Hive supplies
every number. Hive identifies farms by the code in its farm_id column, which is
matched (case-insensitively) to Farm.code in the application database:

- Administrators see every farm present in Hive, registered in the app or not.
- Other roles see only Hive data whose farm code matches a farm assigned to them.
- ?farm_id= / ?batch_id= are application (SQLite) ids, checked against those rules
  and translated to the farm/batch codes used in Hive.

Units, as stored in the dataset: average_weight in kg (returned as grams),
feed_consumption in kg per day, temperature in °C, humidity in % RH.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from app.models import User
from app.services import farm_service, hive_client, hive_queries

KG_TO_G = 1000.0


@dataclass
class Scope:
    farm_codes: list[str] | None  # None = all farms in Hive (administrators only)
    farms_by_code: dict[str, tuple[int, str]]  # CODE -> (application farm id, name)

    @property
    def is_empty(self) -> bool:
        return self.farm_codes == []


def resolve_scope(user: User, farm_id: int | None) -> Scope:
    known = {f.code.upper(): (f.id, f.name) for f in farm_service.list_farms(user)}
    if farm_id is not None:
        farm = farm_service.get_farm_for(user, farm_id)  # 404 when not visible to the user
        return Scope([farm.code.upper()], known)
    if user.is_admin:
        return Scope(None, known)
    return Scope(sorted(known), known)


def source_info(database: str) -> dict[str, str]:
    """Tells API clients exactly where the figures came from."""
    return {"engine": "Apache Hive", "table": f"{database}.{hive_queries.ANALYTICS_TABLE}"}


# --- helpers ---------------------------------------------------------------------------


def _num(value: Any, digits: int = 4) -> float | None:
    return None if value is None else round(float(value), digits)


def _int(value: Any) -> int:
    return int(value or 0)


def _grams(kg: Any) -> float | None:
    return None if kg is None else round(float(kg) * KG_TO_G, 2)


def _pct(part: Any, whole: Any) -> float | None:
    return round(float(part) / float(whole) * 100, 4) if whole else None


def _farm_fields(code: str, scope: Scope) -> dict[str, Any]:
    app_id, name = scope.farms_by_code.get(code.upper(), (None, code))
    return {"farmId": code, "farmCode": code, "farmName": name, "appFarmId": app_id}


# --- endpoints -------------------------------------------------------------------------


def daily_records(scope: Scope, days: int) -> list[dict[str, Any]]:
    if scope.is_empty:
        return []
    rows = hive_client.run_query(
        *hive_queries.daily_records(scope.farm_codes, days), name="daily_records"
    )
    return [
        {
            "date": r["record_date"],
            **_farm_fields(r["farm_id"], scope),
            "birdCount": _int(r["bird_count"]),
            "mortality": _int(r["mortality"]),
            "feedKg": _num(r["feed"]),
            "avgWeightG": _grams(r["avg_weight"]),
            "temperatureC": _num(r["temperature"]),
            "humidityPct": _num(r["humidity"]),
            "records": _int(r["records"]),
        }
        for r in rows
    ]


def farm_comparison(scope: Scope, days: int) -> list[dict[str, Any]]:
    if scope.is_empty:
        return []
    rows = hive_client.run_query(
        *hive_queries.farm_comparison(scope.farm_codes, days), name="farm_comparison"
    )
    farms = []
    for r in rows:
        deaths, start_birds = _int(r["deaths"]), _int(r["start_birds"])
        latest_birds = _int(r["latest_birds"])
        feed = _num(r["feed"])
        farms.append(
            {
                **_farm_fields(r["farm_id"], scope),
                "batches": _int(r["batches"]),
                "records": _int(r["records"]),
                "from": r["first_date"],
                "to": r["last_date"],
                "deaths": deaths,
                "startBirds": start_birds,
                "birdCount": latest_birds,
                # Deaths in the period as % of the flock size on each batch's first day.
                "mortalityRatePct": _pct(deaths, start_birds),
                "feedKg": feed,
                "feedPerBirdKg": _num(feed / latest_birds) if feed and latest_birds else None,
                "avgWeightG": _grams(r["latest_avg_weight"]),
                "avgTemperatureC": _num(r["avg_temperature"]),
                "avgHumidityPct": _num(r["avg_humidity"]),
            }
        )
    return farms


def _period_mortality_rate(p: dict[str, Any]) -> float | None:
    """Deaths as a percentage of the average live flock over the period's days."""
    days_with_data = _int(p.get("days_with_data"))
    avg_birds = _int(p.get("bird_days")) / days_with_data if days_with_data else 0
    return _pct(_int(p.get("deaths")), avg_birds)


def _change(current: float | None, previous: float | None) -> float | None:
    if current is None or not previous:
        return None
    return round((current - previous) / previous * 100, 2)


def summary(scope: Scope, days: int) -> dict[str, Any]:
    empty = {
        "totalFarms": 0,
        "activeBatches": 0,
        "totalBirds": 0,
        "feedKg": 0.0,
        "mortalityRatePct": None,
        "avgWeightG": None,
        "trends": {"feedKg": None, "mortalityRatePct": None},
        "from": None,
        "to": None,
    }
    if scope.is_empty:
        return empty
    rows = hive_client.run_query(
        *hive_queries.period_summary(scope.farm_codes, days), name="period_summary"
    )
    by_period = {r["period"]: r for r in rows}
    current, previous = by_period.get("current"), by_period.get("previous")
    if current is None:
        return empty
    latest_birds = _int(current["latest_birds"])
    feed = _num(current["feed"]) or 0.0
    rate = _period_mortality_rate(current)
    return {
        "totalFarms": _int(current["farms"]),
        "activeBatches": _int(current["batches"]),
        "totalBirds": latest_birds,
        "feedKg": feed,
        "mortalityRatePct": rate,
        "avgWeightG": (
            _grams(float(current["latest_weight_x_birds"]) / latest_birds) if latest_birds else None
        ),
        "trends": {
            "feedKg": _change(feed, _num(previous["feed"]) if previous else None),
            "mortalityRatePct": _change(
                rate, _period_mortality_rate(previous) if previous else None
            ),
        },
        "from": current["first_date"],
        "to": current["last_date"],
    }


def growth(user: User, farm_id: int | None, batch_id: int | None) -> list[dict[str, Any]]:
    batch = None
    if batch_id is not None:
        batch = farm_service.get_batch_for(user, batch_id)  # 404 when not visible
        if farm_id is not None and batch.farm_id != farm_id:
            return []
        farm_id = batch.farm_id
    scope = resolve_scope(user, farm_id)
    if scope.is_empty:
        return []
    rows = hive_client.run_query(
        *hive_queries.growth_points(scope.farm_codes, batch.code if batch else None),
        name="growth_points",
    )

    # Registered batches (same farm code + batch code) supply start date and poultry type.
    registered = {
        (b.farm.code.upper(), b.code.upper()): b
        for b in farm_service.list_batches(user, None, None)
    }
    curves: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        key = (r["farm_id"], r["batch_id"])
        if key not in curves:
            app_batch = registered.get((key[0].upper(), key[1].upper()))
            curves[key] = {
                "batchId": key[1],
                "code": key[1],
                "appBatchId": app_batch.id if app_batch else None,
                **_farm_fields(key[0], scope),
                "poultryType": app_batch.poultry_type if app_batch else None,
                "ageBasis": "batch_start_date" if app_batch else "first_record",
                "_start": app_batch.start_date
                if app_batch
                else date.fromisoformat(str(r["record_date"])),
                "points": [],
            }
        curve = curves[key]
        day = date.fromisoformat(str(r["record_date"]))
        curve["points"].append(
            {
                "date": day.isoformat(),
                "ageDays": (day - curve["_start"]).days,
                "avgWeightG": _grams(r["avg_weight"]),
                "birdCount": _int(r["bird_count"]),
            }
        )
    for curve in curves.values():
        del curve["_start"]
    return list(curves.values())
