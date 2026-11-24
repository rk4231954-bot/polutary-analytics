"""Unit tests for the Hive analytics endpoints.

Hive is replaced by a recording stand-in here (unit-level isolation only); the same
endpoints are exercised against the real HiveServer2 in test_analytics_integration.py.
"""

from __future__ import annotations

from datetime import date

import pytest
from pyhive import exc as pyhive_exc
from thrift.transport.TTransport import TTransportException

from app.extensions import db
from app.models import PoultryBatch
from app.services import hive_client, hive_queries


@pytest.fixture
def fake_hive(monkeypatch):
    """Records each HiveQL call and returns canned rows keyed by query name."""

    class FakeHive:
        def __init__(self):
            self.calls: list[tuple[str, str, dict]] = []
            self.rows: dict[str, list[dict]] = {}

        def run_query(self, sql, params=None, *, name="query"):
            self.calls.append((name, sql, dict(params or {})))
            return self.rows.get(name, [])

    fake = FakeHive()
    monkeypatch.setattr(hive_client, "run_query", fake.run_query)
    return fake


def daily_row(farm="FARM001", day="2026-01-10", **extra):
    row = {
        "farm_id": farm,
        "record_date": day,
        "bird_count": 985,
        "mortality": 1,
        "feed": 53.0,
        "avg_weight": 0.75,
        "temperature": 28.9,
        "humidity": 65.0,
        "records": 1,
    }
    row.update(extra)
    return row


# --- access control ----------------------------------------------------------------------


def test_requires_sign_in(client, fake_hive):
    response = client.get("/api/analytics/daily")
    assert response.status_code == 401
    assert fake_hive.calls == []


def test_veterinarian_cannot_view_analytics(as_role, fake_hive):
    response = as_role("veterinarian").get("/api/analytics/daily")
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "FORBIDDEN"
    assert fake_hive.calls == []


def test_admin_queries_all_farms(as_role, fake_hive):
    response = as_role("admin").get("/api/analytics/daily?days=7")
    assert response.status_code == 200
    (name, _sql, params) = fake_hive.calls[0]
    assert name == "daily_records"
    assert params["all_farms"] == 1 and params["days"] == 7


def test_analyst_is_limited_to_assigned_farm_codes(as_role, make_farm, fake_hive):
    assigned = make_farm(code="FARM001", name="North Farm")
    make_farm(code="FARM002", name="South Farm")
    response = as_role("analyst", farms=[assigned]).get("/api/analytics/daily")
    assert response.status_code == 200
    params = fake_hive.calls[0][2]
    assert params["all_farms"] == 0
    assert params["farms"] == "FARM001"


def test_analyst_without_farms_gets_empty_results_without_querying_hive(as_role, fake_hive):
    c = as_role("analyst")
    assert c.get("/api/analytics/daily").get_json()["records"] == []
    assert c.get("/api/analytics/farm-comparison").get_json()["farms"] == []
    assert c.get("/api/analytics/summary").get_json()["totalFarms"] == 0
    assert c.get("/api/analytics/growth").get_json()["batches"] == []
    assert fake_hive.calls == []


def test_farm_filter_for_unassigned_farm_is_not_found(as_role, make_farm, fake_hive):
    mine = make_farm(code="FARM001")
    other = make_farm(code="FARM002", name="Other")
    response = as_role("farm_manager", farms=[mine]).get(f"/api/analytics/daily?farm_id={other}")
    assert response.status_code == 404
    assert fake_hive.calls == []


def test_farm_filter_uses_the_farm_code(as_role, make_farm, fake_hive):
    farm = make_farm(code="FARM002", name="South Farm")
    response = as_role("admin").get(f"/api/analytics/farm-comparison?farm_id={farm}")
    assert response.status_code == 200
    params = fake_hive.calls[0][2]
    assert (params["all_farms"], params["farms"]) == (0, "FARM002")


@pytest.mark.parametrize("value", ["abc", "0", "-1", "1;DROP"])
def test_invalid_farm_id_is_rejected(as_role, fake_hive, value):
    response = as_role("admin").get(f"/api/analytics/daily?farm_id={value}")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "BAD_QUERY"
    assert fake_hive.calls == []


# --- HiveQL safety -----------------------------------------------------------------------


def test_hiveql_text_is_static_and_values_are_bound():
    all_sql, all_params = hive_queries.daily_records(None, 30)
    one_sql, one_params = hive_queries.daily_records(["farm001", "FARM-2"], 7)
    assert all_sql == one_sql  # nothing user-supplied is ever part of the statement
    assert "FARM001" not in one_sql
    assert one_params["farms"] == "FARM001,FARM-2"
    assert "poultry_records_cleaned" in one_sql and "staging" not in one_sql


@pytest.mark.parametrize("bad", ["x', 'y", "a,b", "FARM 1", "", "x" * 41])
def test_unsafe_farm_codes_are_refused(bad):
    with pytest.raises(ValueError):
        hive_queries.daily_records([bad], 30)


def test_all_queries_read_the_cleaned_table():
    for sql, _ in (
        hive_queries.daily_records(None, 30),
        hive_queries.farm_comparison(None, 30),
        hive_queries.period_summary(None, 30),
        hive_queries.growth_points(None, None),
        hive_queries.alert_baselines(None, 14),
    ):
        assert "FROM poultry_records_cleaned" in sql
        assert "poultry_records_staging" not in sql


# --- failures map to clear API errors ------------------------------------------------------


def test_hiveserver2_down_returns_503(as_role, monkeypatch):
    def refuse(**_kwargs):
        raise TTransportException(message="Could not connect to any of [('127.0.0.1', 10000)]")

    monkeypatch.setattr(hive_client.hive, "connect", refuse)
    response = as_role("admin").get("/api/analytics/daily")
    assert response.status_code == 503
    error = response.get_json()["error"]
    assert error["code"] == "HIVE_UNAVAILABLE"
    assert "HiveServer2" in error["message"]
    assert "127.0.0.1" not in error["message"]  # internals stay in the server log


def test_refused_hive_login_returns_auth_error(app, as_role, monkeypatch):
    seen = {}

    def refuse(**kwargs):
        seen.update(kwargs)
        raise TTransportException(message="Bad status: 3 (b'Error validating the login')")

    app.config.update(HIVE_AUTH="CUSTOM", HIVE_USERNAME="api", HIVE_PASSWORD="s3cret-value")
    monkeypatch.setattr(hive_client.hive, "connect", refuse)
    response = as_role("admin").get("/api/analytics/summary")
    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "HIVE_AUTH_FAILED"
    assert "s3cret-value" not in response.get_data(as_text=True)
    assert (seen["auth"], seen["username"], seen["password"]) == ("CUSTOM", "api", "s3cret-value")


def test_failed_query_returns_502_without_hive_internals(as_role, monkeypatch):
    class Cursor:
        description = None

        def execute(self, *_args):
            raise pyhive_exc.OperationalError("TExecuteStatementResp(... SemanticException ...)")

    class Conn:
        def cursor(self):
            return Cursor()

        def close(self):
            pass

    monkeypatch.setattr(hive_client.hive, "connect", lambda **_kw: Conn())
    response = as_role("admin").get("/api/analytics/summary")
    assert response.status_code == 502
    error = response.get_json()["error"]
    assert error["code"] == "HIVE_QUERY_FAILED"
    assert "SemanticException" not in error["message"]


# --- response shaping ------------------------------------------------------------------------


def test_daily_records_shape_units_and_farm_names(as_role, make_farm, fake_hive):
    farm = make_farm(code="FARM001", name="North Farm")
    fake_hive.rows["daily_records"] = [daily_row(), daily_row(farm="FARM009")]
    body = as_role("admin").get("/api/analytics/daily").get_json()
    registered, unregistered = body["records"]
    assert registered == {
        "date": "2026-01-10",
        "farmId": "FARM001",
        "farmCode": "FARM001",
        "farmName": "North Farm",
        "appFarmId": farm,
        "birdCount": 985,
        "mortality": 1,
        "feedKg": 53.0,
        "avgWeightG": 750.0,  # stored in kg, returned in grams
        "temperatureC": 28.9,
        "humidityPct": 65.0,
        "records": 1,
    }
    assert unregistered["farmName"] == "FARM009" and unregistered["appFarmId"] is None
    assert body["source"] == {
        "engine": "Apache Hive",
        "table": "poultry_analytics.poultry_records_cleaned",
    }


def test_farm_comparison_rates(as_role, fake_hive):
    fake_hive.rows["farm_comparison"] = [
        {
            "farm_id": "FARM001",
            "batches": 1,
            "records": 10,
            "first_date": "2026-01-01",
            "last_date": "2026-01-10",
            "deaths": 16,
            "feed": 488.0,
            "start_birds": 1000,
            "latest_birds": 985,
            "latest_avg_weight": 0.75,
            "avg_temperature": 28.82,
            "avg_humidity": 65.3,
        }
    ]
    (farm,) = as_role("admin").get("/api/analytics/farm-comparison").get_json()["farms"]
    assert farm["mortalityRatePct"] == 1.6
    assert farm["avgWeightG"] == 750.0
    assert farm["feedPerBirdKg"] == round(488.0 / 985, 4)
    assert farm["avgTemperatureC"] == 28.82


def test_summary_trends_compare_with_previous_period(as_role, fake_hive):
    def period(name, feed, deaths, bird_days):
        return {
            "period": name,
            "farms": 2,
            "batches": 2,
            "feed": feed,
            "deaths": deaths,
            "bird_days": bird_days,
            "days_with_data": 5,
            "first_date": "2026-01-06",
            "last_date": "2026-01-10",
            "latest_birds": 2000,
            "latest_weight_x_birds": 1500.0,
        }

    fake_hive.rows["period_summary"] = [
        period("current", 550.0, 10, 10000),
        period("previous", 500.0, 20, 10000),
    ]
    body = as_role("admin").get("/api/analytics/summary?days=5").get_json()
    assert body["feedKg"] == 550.0
    assert body["mortalityRatePct"] == 0.5  # 10 deaths / (10000 bird-days / 5 days)
    assert body["trends"] == {"feedKg": 10.0, "mortalityRatePct": -50.0}
    assert body["avgWeightG"] == 750.0
    assert (body["from"], body["to"], body["days"]) == ("2026-01-06", "2026-01-10", 5)


def test_summary_without_previous_period_has_no_trend(as_role, fake_hive):
    fake_hive.rows["period_summary"] = [
        {
            "period": "current",
            "farms": 1,
            "batches": 1,
            "feed": 10.0,
            "deaths": 1,
            "bird_days": 100,
            "days_with_data": 1,
            "first_date": "2026-01-01",
            "last_date": "2026-01-01",
            "latest_birds": 100,
            "latest_weight_x_birds": 50.0,
        }
    ]
    body = as_role("admin").get("/api/analytics/summary").get_json()
    assert body["trends"] == {"feedKg": None, "mortalityRatePct": None}


def test_growth_uses_registered_batch_start_date(app, as_role, make_farm, fake_hive):
    farm = make_farm(code="FARM001", name="North Farm")
    with app.app_context():
        batch = PoultryBatch(
            farm_id=farm,
            code="BATCH001",
            poultry_type="Broiler",
            initial_count=1000,
            start_date=date(2025, 12, 25),
            status="active",
        )
        db.session.add(batch)
        db.session.commit()
        batch_id = batch.id
    fake_hive.rows["growth_points"] = [
        {
            "farm_id": "FARM001",
            "batch_id": "BATCH001",
            "record_date": "2026-01-01",
            "avg_weight": 0.45,
            "bird_count": 1000,
        },
        {
            "farm_id": "FARM002",
            "batch_id": "BATCH002",
            "record_date": "2026-01-01",
            "avg_weight": 0.5,
            "bird_count": 1200,
        },
    ]
    body = as_role("admin").get("/api/analytics/growth").get_json()
    registered, unregistered = body["batches"]
    assert registered["poultryType"] == "Broiler" and registered["appBatchId"] == batch_id
    assert registered["ageBasis"] == "batch_start_date"
    assert registered["points"][0]["ageDays"] == 7
    assert registered["points"][0]["avgWeightG"] == 450.0
    assert unregistered["ageBasis"] == "first_record"
    assert unregistered["points"][0]["ageDays"] == 0
    assert unregistered["poultryType"] is None

    as_role("admin").get(f"/api/analytics/growth?batch_id={batch_id}")
    params = fake_hive.calls[-1][2]
    assert (params["farms"], params["batch"]) == ("FARM001", "BATCH001")


def test_status_reports_tables(as_role, fake_hive):
    fake_hive.rows["show_tables"] = [{"tab_name": "poultry_records_cleaned"}]
    body = as_role("analyst").get("/api/analytics/status").get_json()
    assert body["hive"] == {
        "connected": True,
        "database": "poultry_analytics",
        "tables": ["poultry_records_cleaned"],
    }
