"""Analytics endpoints against the real HiveServer2 (no stand-ins).

Run with:  uv run pytest -m integration
Needs HDFS + HiveServer2 running and the poultry_analytics database. The HIVE_*
settings (host, port, user, password, auth mode) are taken from apps/api/.env, the
same file the API uses, unless they are already set in the environment.

Expected values are not hard-coded: each endpoint is compared with a plain,
independent HiveQL aggregate over the same table, so the tests stay valid when the
dataset grows.
"""

from __future__ import annotations

import math
import os
import statistics
from datetime import date
from pathlib import Path

import pytest
from dotenv import dotenv_values

from app.services import analytics_service, hive_client, hive_queries

pytestmark = pytest.mark.integration

ALL_DAYS = 3650  # wider than the dataset, so every record is inside the window
HIVE_KEYS = (
    "HIVE_HOST",
    "HIVE_PORT",
    "HIVE_USERNAME",
    "HIVE_PASSWORD",
    "HIVE_DATABASE",
    "HIVE_AUTH",
)


@pytest.fixture(autouse=True)
def real_hive_settings(app):
    """Point the test app at the real HiveServer2 with the API's own credentials."""
    values = {**dotenv_values(Path(__file__).parent.parent / ".env"), **os.environ}
    for key in HIVE_KEYS:
        if values.get(key):
            value = values[key]
            app.config[key] = int(value) if key == "HIVE_PORT" else value
    app.config["HIVE_AUTH"] = app.config["HIVE_AUTH"].upper()


def hive(app, sql):
    with app.app_context():
        return hive_client.run_query(sql, name="test_reference")


@pytest.fixture
def admin(as_role):
    return as_role("admin")


def test_status_lists_the_real_tables(admin):
    response = admin.get("/api/analytics/status")
    assert response.status_code == 200, response.get_json()
    tables = response.get_json()["hive"]["tables"]
    assert "poultry_records_cleaned" in tables


def test_daily_totals_match_direct_hiveql(app, admin):
    body = admin.get(f"/api/analytics/daily?days={ALL_DAYS}").get_json()
    (ref,) = hive(
        app,
        "SELECT COUNT(*) AS n, SUM(mortality_count) AS deaths, SUM(feed_consumption) AS feed, "
        "SUM(bird_count) AS birds FROM poultry_records_cleaned",
    )
    records = body["records"]
    assert records, "Hive returned no daily records"
    assert sum(r["records"] for r in records) == ref["n"]
    assert sum(r["mortality"] for r in records) == ref["deaths"]
    assert sum(r["birdCount"] for r in records) == ref["birds"]
    assert sum(r["feedKg"] for r in records) == pytest.approx(ref["feed"])
    assert body["source"]["engine"] == "Apache Hive"


def test_farm_comparison_matches_direct_group_by(app, admin):
    farms = admin.get(f"/api/analytics/farm-comparison?days={ALL_DAYS}").get_json()["farms"]
    ref = hive(
        app,
        "SELECT farm_id, COUNT(*) AS n, SUM(mortality_count) AS deaths, "
        "SUM(feed_consumption) AS feed, AVG(temperature) AS temp "
        "FROM poultry_records_cleaned GROUP BY farm_id ORDER BY farm_id",
    )
    assert [f["farmCode"] for f in farms] == [r["farm_id"] for r in ref]
    for farm, r in zip(farms, ref, strict=True):
        assert farm["records"] == r["n"]
        assert farm["deaths"] == r["deaths"]
        assert farm["feedKg"] == pytest.approx(r["feed"])
        assert farm["avgTemperatureC"] == pytest.approx(r["temp"], abs=1e-3)


def test_summary_matches_direct_totals(app, admin):
    body = admin.get(f"/api/analytics/summary?days={ALL_DAYS}").get_json()
    (ref,) = hive(
        app,
        "SELECT COUNT(DISTINCT farm_id) AS farms, SUM(feed_consumption) AS feed, "
        "MIN(record_date) AS first_date, MAX(record_date) AS last_date "
        "FROM poultry_records_cleaned",
    )
    assert body["totalFarms"] == ref["farms"]
    assert body["feedKg"] == pytest.approx(ref["feed"])
    assert (body["from"], body["to"]) == (ref["first_date"], ref["last_date"])


def test_growth_points_match_row_count(app, admin):
    batches = admin.get("/api/analytics/growth").get_json()["batches"]
    (ref,) = hive(
        app,
        "SELECT COUNT(*) AS n FROM (SELECT farm_id, batch_id, record_date "
        "FROM poultry_records_cleaned GROUP BY farm_id, batch_id, record_date) g",
    )
    assert sum(len(b["points"]) for b in batches) == ref["n"]
    for b in batches:
        ages = [p["ageDays"] for p in b["points"]]
        assert ages == sorted(ages)


def test_farm_scope_is_applied_in_hive(app, as_role, make_farm):
    (first,) = hive(app, "SELECT MIN(farm_id) AS farm_id FROM poultry_records_cleaned")
    farm = make_farm(code=first["farm_id"], name="Assigned farm")
    analyst = as_role("analyst", farms=[farm])
    records = analyst.get(f"/api/analytics/daily?days={ALL_DAYS}").get_json()["records"]
    assert records
    assert {r["farmCode"] for r in records} == {first["farm_id"]}
    assert {r["farmName"] for r in records} == {"Assigned farm"}


def test_unreachable_hiveserver2_gives_503(app, admin):
    app.config["HIVE_PORT"] = 1  # nothing listens here: a real connection failure
    response = admin.get("/api/analytics/daily")
    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "HIVE_UNAVAILABLE"


def test_alert_trend_statistics_match_an_independent_fit(app, admin):
    """The HiveQL regression (REGR_SLOPE/INTERCEPT + residual SD) is re-done in Python
    from a plain per-day GROUP BY over the same table."""
    days = analytics_service.ALERT_BASELINE_DAYS
    with app.app_context():
        stats = hive_client.run_query(*hive_queries.alert_baselines(None, days), name="test")
    daily = hive(
        app,
        "SELECT farm_id, record_date, SUM(mortality_count) AS deaths, "
        "SUM(feed_consumption) / SUM(bird_count) AS feed_per_bird, "
        "AVG(temperature) AS temperature, AVG(humidity) AS humidity "
        "FROM poultry_records_cleaned GROUP BY farm_id, record_date",
    )
    assert stats, "Hive returned no alert baselines"
    for row in stats:
        last = date.fromisoformat(row["last_date"])
        by_x = {
            (date.fromisoformat(r["record_date"]) - last).days: r
            for r in daily
            if r["farm_id"] == row["farm_id"]
        }
        base = sorted(x for x in by_x if -days <= x < 0)
        assert row["base_days"] == len(base)
        for key in ("deaths", "feed_per_bird", "temperature", "humidity"):
            ys = [float(by_x[x][key]) for x in base]
            slope, intercept = statistics.linear_regression(base, ys)
            sse = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(base, ys, strict=True))
            assert row[f"last_{key}"] == pytest.approx(float(by_x[0][key]))
            assert row[f"expected_{key}"] == pytest.approx(intercept, rel=1e-6, abs=1e-9)
            assert row[f"sd_{key}"] == pytest.approx(math.sqrt(sse / (len(base) - 2)), rel=1e-6)

    body = admin.get("/api/alerts").get_json()
    assert body["source"]["engine"] == "Apache Hive"
    for alert in body["alerts"]:  # whatever fires must satisfy the documented rules
        assert abs(alert["zScore"]) >= body["rules"]["warningZ"]


def test_activity_lists_real_audit_entries(admin):
    admin.post(
        "/api/farms",
        json={
            "code": "INT-1",
            "name": "Integration farm",
            "location": "Test",
            "capacity": 10,
            "housingType": "Closed house",
            "status": "active",
        },
    )
    activity = admin.get("/api/activity").get_json()["activity"]
    assert activity[0]["message"] == "Created farm Integration farm (INT-1)"


def test_wrong_hive_password_gives_auth_error(app, admin):
    if app.config["HIVE_AUTH"] not in {"CUSTOM", "LDAP"}:
        pytest.skip("HiveServer2 is not configured with password authentication")
    app.config["HIVE_PASSWORD"] = "not-the-password"  # a real refused login
    response = admin.get("/api/analytics/status")
    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "HIVE_AUTH_FAILED"
    assert "not-the-password" not in response.get_data(as_text=True)


def test_anonymous_hive_login_is_refused(app, admin):
    if app.config["HIVE_AUTH"] not in {"CUSTOM", "LDAP"}:
        pytest.skip("HiveServer2 is not configured with password authentication")
    app.config.update(HIVE_AUTH="NONE", HIVE_USERNAME="anonymous")
    response = admin.get("/api/analytics/status")
    assert response.get_json()["error"]["code"] == "HIVE_AUTH_FAILED"


def test_cluster_status_and_tables_come_from_the_real_cluster(app, admin):
    status = admin.get("/api/bigdata/status").get_json()
    assert status["hdfs"]["connected"] is True
    assert status["hdfs"]["liveDataNodes"] >= 1
    assert status["hive"]["connected"] is True
    tables = {t["name"]: t for t in admin.get("/api/hive/tables").get_json()["tables"]}
    shown = {row["tab_name"] for row in hive(app, "SHOW TABLES")}
    assert set(tables) == shown
    cleaned = tables[hive_queries.ANALYTICS_TABLE]
    assert cleaned["location"].startswith("hdfs://")
    if cleaned["rowCount"] is not None:  # Hive's stored statistic agrees with a real count
        (row,) = hive(app, "SELECT COUNT(*) AS n FROM poultry_records_cleaned")
        assert cleaned["rowCount"] == row["n"]
    assert status["latestIngestionAt"] == max(t["updatedAt"] for t in tables.values())
