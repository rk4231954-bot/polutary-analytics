"""Unit tests for GET /api/alerts (Hive, replaced by a recording stand-in here) and
GET /api/activity (audit log in SQLite). test_analytics_integration.py runs the alert
query against the real HiveServer2."""

from __future__ import annotations

import pytest
from conftest import batch_payload, farm_payload

from app.services import audit_service, hive_client


@pytest.fixture
def fake_hive(monkeypatch):
    calls: list[tuple[str, dict]] = []
    rows: dict[str, list[dict]] = {}

    def run_query(sql, params=None, *, name="query"):
        calls.append((name, dict(params or {})))
        return rows.get(name, [])

    monkeypatch.setattr(hive_client, "run_query", run_query)
    return calls, rows


def baseline(farm="FARM001", **overrides):
    """A farm whose latest day matches its trend exactly (no alert)."""
    row = {"farm_id": farm, "last_date": "2026-01-10", "base_days": 9}
    for key, value, sd in (
        ("deaths", 2.0, 1.0),
        ("feed_per_bird", 0.05, 0.002),
        ("temperature", 28.0, 0.5),
        ("humidity", 64.0, 2.0),
    ):
        row |= {f"last_{key}": value, f"expected_{key}": value, f"sd_{key}": sd}
    row.update(overrides)
    return row


# --- alerts ---------------------------------------------------------------------------------


def test_alerts_require_analytics_permission(client, as_role, fake_hive):
    assert client.get("/api/alerts").status_code == 401
    assert as_role("veterinarian").get("/api/alerts").status_code == 403


def test_no_alert_when_values_follow_the_trend(as_role, fake_hive):
    _, rows = fake_hive
    rows["alert_baselines"] = [baseline()]
    body = as_role("admin").get("/api/alerts").get_json()
    assert body["alerts"] == []
    assert body["rules"]["warningZ"] == 2.0
    assert body["source"]["engine"] == "Apache Hive"


def test_temperature_alert_severity_and_message(as_role, fake_hive):
    calls, rows = fake_hive
    # 28.0 expected: 29.5 with sd 0.6 is z = 2.5 (warning), 26.4 with sd 0.5 is z = -3.2
    # (danger). Both differ by more than 5% of 28.0 (1.4 °C).
    rows["alert_baselines"] = [
        baseline("FARM001", last_temperature=29.5, sd_temperature=0.6),
        baseline("FARM002", last_temperature=26.4),
    ]
    alerts = as_role("admin").get("/api/alerts").get_json()["alerts"]
    assert [(a["farmCode"], a["severity"], a["zScore"]) for a in alerts] == [
        ("FARM002", "danger", -3.2),  # most severe first
        ("FARM001", "warning", 2.5),
    ]
    first = alerts[0]
    assert first["type"] == "temperature"
    assert first["title"] == "House temperature below recent range"
    assert "26.4 °C" in first["message"] and "28.0 °C expected" in first["message"]
    assert first["date"] == "2026-01-10"
    assert calls[0][1]["baseline_days"] == 14


def test_mortality_alerts_only_on_increase_and_by_at_least_one_bird(as_role, fake_hive):
    _, rows = fake_hive
    rows["alert_baselines"] = [
        baseline("FARM001", last_deaths=5.0),  # +3 birds, z = 3: alert
        baseline("FARM002", last_deaths=0.0, sd_deaths=0.5),  # fewer deaths: never an alert
        baseline("FARM003", last_deaths=2.6, sd_deaths=0.2),  # z = 3 but only 0.6 bird
    ]
    alerts = as_role("admin").get("/api/alerts").get_json()["alerts"]
    assert [(a["farmCode"], a["type"]) for a in alerts] == [("FARM001", "mortality")]


def test_negligible_difference_is_not_an_alert(as_role, fake_hive):
    _, rows = fake_hive
    # Very regular series: z is huge, but the difference is 0.1% of the expected value.
    rows["alert_baselines"] = [baseline(last_feed_per_bird=0.05005, sd_feed_per_bird=0.00001)]
    assert as_role("admin").get("/api/alerts").get_json()["alerts"] == []


@pytest.mark.parametrize("override", [{"base_days": 4}, {"sd_humidity": 0}, {"sd_humidity": None}])
def test_no_alert_without_enough_history_or_spread(as_role, fake_hive, override):
    _, rows = fake_hive
    rows["alert_baselines"] = [baseline(last_humidity=90.0, **override)]
    if "base_days" in override:
        rows["alert_baselines"][0]["last_temperature"] = 40.0
    assert as_role("admin").get("/api/alerts").get_json()["alerts"] == []


def test_alerts_are_scoped_to_assigned_farms(as_role, make_farm, fake_hive):
    calls, _ = fake_hive
    farm = make_farm(code="FARM001", name="North")
    as_role("farm_manager", farms=[farm]).get("/api/alerts")
    assert calls[-1][1]["all_farms"] == 0 and calls[-1][1]["farms"] == "FARM001"
    calls.clear()
    assert as_role("analyst").get("/api/alerts").get_json()["alerts"] == []
    assert calls == []  # no farms: Hive is not queried at all


def test_alerts_limit(as_role, fake_hive):
    _, rows = fake_hive
    rows["alert_baselines"] = [
        baseline(f"F{i}", last_temperature=30.0, last_humidity=75.0) for i in range(5)
    ]
    assert len(as_role("admin").get("/api/alerts?limit=3").get_json()["alerts"]) == 3


# --- activity --------------------------------------------------------------------------------


def messages(response):
    assert response.status_code == 200, response.get_json()
    return [a["message"] for a in response.get_json()["activity"]]


def test_activity_requires_sign_in(client):
    assert client.get("/api/activity").status_code == 401


def test_admin_sees_real_changes_with_actor_names(as_role):
    admin = as_role("admin")
    farm_id = admin.post("/api/farms", json=farm_payload()).get_json()["farm"]["id"]
    admin.post("/api/batches", json=batch_payload(farm_id))
    activity = admin.get("/api/activity").get_json()["activity"]
    assert [a["message"] for a in activity] == [
        "Created batch B-001",
        "Created farm Hilltop Poultry (F-100)",
    ]
    assert {a["type"] for a in activity} == {"farm"}
    assert activity[0]["actor"] == "Admin1"  # the account's full name
    # Sign-ins are security events, not activity.
    assert all(a["action"] != "auth.login" for a in activity)


def test_activity_is_scoped_to_assigned_farms(app, as_role, make_farm):
    admin = as_role("admin")
    mine = admin.post("/api/farms", json=farm_payload(code="F-1", name="Mine")).get_json()
    other = admin.post("/api/farms", json=farm_payload(code="F-2", name="Other")).get_json()
    admin.post("/api/batches", json=batch_payload(other["farm"]["id"], code="B-OTHER"))
    analyst = as_role("analyst", farms=[mine["farm"]["id"]])
    seen = messages(analyst.get("/api/activity"))
    assert seen == ["Created farm Mine (F-1)"]


def test_account_administration_is_admin_only(as_role):
    admin = as_role("admin")
    admin.post(
        "/api/users",
        json={"fullName": "New Analyst", "email": "new@example.org", "role": "analyst"},
    )
    assert any("Created account new@example.org" in m for m in messages(admin.get("/api/activity")))
    assert messages(as_role("farm_manager").get("/api/activity")) == []


def test_dataset_activity_needs_dataset_permission(app, as_role, make_farm):
    farm = make_farm(code="F-9", name="Ninth")
    with app.app_context():
        audit_service.record(
            "dataset.upload",
            resource_type="dataset",
            resource_id=1,
            details={"filename": "day.csv", "farmId": farm, "acceptedRows": 10, "rejectedRows": 2},
        )
    expected = ["Uploaded dataset day.csv: 10 rows accepted, 2 rejected"]
    assert messages(as_role("analyst", farms=[farm]).get("/api/activity")) == expected
    assert messages(as_role("veterinarian", farms=[farm]).get("/api/activity")) == []


def test_own_actions_are_always_visible(as_role):
    manager = as_role("farm_manager")
    manager.post("/api/farms", json=farm_payload(code="F-7", name="Seventh"))
    assert messages(manager.get("/api/activity")) == ["Created farm Seventh (F-7)"]


def test_activity_limit(as_role):
    admin = as_role("admin")
    for i in range(4):
        admin.post("/api/farms", json=farm_payload(code=f"F-{i}", name=f"Farm {i}"))
    assert len(messages(admin.get("/api/activity?limit=2"))) == 2
