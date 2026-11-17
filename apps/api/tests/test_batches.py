"""Poultry batch CRUD, batch access rules and inspection observations."""

from __future__ import annotations

from datetime import date, timedelta

from conftest import audit_rows, batch_payload

from app.utils.time import today


def test_manager_batch_crud(as_role, make_farm):
    farm_id = make_farm()
    manager = as_role("farm_manager", farms=[farm_id])
    created = manager.post("/api/batches", json=batch_payload(farm_id, code="b-2026-07"))
    assert created.status_code == 201
    batch = created.get_json()["batch"]
    assert batch["code"] == "B-2026-07"
    assert batch["farmName"] == "Greenfield"
    assert batch["ageDays"] == (today() - date(2026, 10, 1)).days
    assert batch["avgWeightG"] is None  # no readings yet: nothing is invented

    detail = manager.get(f"/api/batches/{batch['id']}").get_json()["batch"]
    assert detail["daily"] == []

    listed = manager.get(f"/api/batches?farm_id={farm_id}&status=active").get_json()["batches"]
    assert [b["id"] for b in listed] == [batch["id"]]
    assert manager.get("/api/batches?status=planned").get_json()["batches"] == []

    done = manager.put(
        f"/api/batches/{batch['id']}", json=batch_payload(farm_id, status="completed")
    )
    assert done.status_code == 200
    assert done.get_json()["batch"]["endDate"] is not None
    assert manager.delete(f"/api/batches/{batch['id']}").status_code == 204


def test_active_batch_cannot_be_deleted(as_role, make_farm):
    farm_id = make_farm()
    manager = as_role("farm_manager", farms=[farm_id])
    batch_id = manager.post("/api/batches", json=batch_payload(farm_id)).get_json()["batch"]["id"]
    response = manager.delete(f"/api/batches/{batch_id}")
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "BATCH_ACTIVE"


def test_batch_validation(as_role, make_farm):
    farm_id = make_farm()
    manager = as_role("farm_manager", farms=[farm_id])
    future = (today() + timedelta(days=5)).isoformat()
    bad = manager.post(
        "/api/batches",
        json=batch_payload(farm_id, initialCount=0, poultryType="Duck", startDate=future),
    )
    assert bad.status_code == 400
    assert {"initialCount", "poultryType"} <= set(bad.get_json()["error"]["fields"])
    planned = manager.post(
        "/api/batches", json=batch_payload(farm_id, startDate=future, status="planned")
    )
    assert planned.status_code == 201
    dup = manager.post(
        "/api/batches", json=batch_payload(farm_id, code=planned.get_json()["batch"]["code"])
    )
    assert dup.status_code == 400


def test_batches_limited_to_assigned_farms(as_role, make_farm):
    farm_a, farm_b = make_farm("F-A", "Farm A"), make_farm("F-B", "Farm B")
    admin = as_role("admin")
    batch_b = admin.post("/api/batches", json=batch_payload(farm_b)).get_json()["batch"]["id"]
    manager = as_role("farm_manager", farms=[farm_a])

    assert manager.get("/api/batches").get_json()["batches"] == []
    assert manager.get(f"/api/batches/{batch_b}").status_code == 404
    assert manager.put(f"/api/batches/{batch_b}", json=batch_payload(farm_b)).status_code == 404
    # cannot create a batch on someone else's farm
    response = manager.post("/api/batches", json=batch_payload(farm_b, code="B-X"))
    assert response.status_code == 400
    assert "farmId" in response.get_json()["error"]["fields"]


def test_read_only_roles_cannot_manage_batches(as_role, make_farm):
    farm_id = make_farm()
    for role in ("analyst", "veterinarian"):
        c = as_role(role, farms=[farm_id])
        assert c.get("/api/batches").status_code == 200
        assert c.post("/api/batches", json=batch_payload(farm_id)).status_code == 403


def test_veterinarian_records_inspections(as_role, make_farm, app):
    farm_id = make_farm()
    admin = as_role("admin")
    batch_id = admin.post("/api/batches", json=batch_payload(farm_id)).get_json()["batch"]["id"]
    vet = as_role("veterinarian", farms=[farm_id])
    observation = {
        "observedOn": today().isoformat(),
        "healthStatus": "attention",
        "observation": "Mild respiratory sounds in pen 3; recheck in 48 h.",
    }
    created = vet.post(f"/api/batches/{batch_id}/inspections", json=observation)
    assert created.status_code == 201
    assert created.get_json()["inspection"]["inspector"] == "Veterinarian2"
    listed = vet.get(f"/api/batches/{batch_id}/inspections").get_json()["inspections"]
    assert [i["healthStatus"] for i in listed] == ["attention"]
    assert audit_rows(app, "inspection.create")[-1][1] == "success"

    bad = vet.post(
        f"/api/batches/{batch_id}/inspections", json={**observation, "observedOn": "2020-01-01"}
    )
    assert bad.status_code == 400  # before the batch started


def test_inspection_permissions(as_role, make_farm):
    farm_id = make_farm()
    other_farm = make_farm("F-2", "Other")
    admin = as_role("admin")
    batch_id = admin.post("/api/batches", json=batch_payload(farm_id)).get_json()["batch"]["id"]
    observation = {
        "observedOn": today().isoformat(),
        "healthStatus": "normal",
        "observation": "Flock normal.",
    }

    analyst = as_role("analyst", farms=[farm_id])
    assert analyst.get(f"/api/batches/{batch_id}/inspections").status_code == 403
    assert analyst.post(f"/api/batches/{batch_id}/inspections", json=observation).status_code == 403

    manager = as_role("farm_manager", farms=[farm_id])
    assert manager.get(f"/api/batches/{batch_id}/inspections").status_code == 200
    assert manager.post(f"/api/batches/{batch_id}/inspections", json=observation).status_code == 403

    outsider_vet = as_role("veterinarian", farms=[other_farm])
    assert (
        outsider_vet.post(f"/api/batches/{batch_id}/inspections", json=observation).status_code
        == 404
    )
