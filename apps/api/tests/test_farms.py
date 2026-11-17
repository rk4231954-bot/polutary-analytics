"""Farm CRUD and farm-level access restrictions."""

from __future__ import annotations

from conftest import batch_payload, farm_payload


def test_admin_farm_crud(as_role):
    admin = as_role("admin")
    created = admin.post("/api/farms", json=farm_payload(code="f-100"))
    assert created.status_code == 201
    farm = created.get_json()["farm"]
    assert farm["code"] == "F-100"
    assert farm["housingType"] == "Closed house"
    assert farm["activeBatches"] == 0 and farm["birdCount"] == 0

    assert [f["id"] for f in admin.get("/api/farms").get_json()["farms"]] == [farm["id"]]
    assert admin.get(f"/api/farms/{farm['id']}").get_json()["farm"]["name"] == "Hilltop Poultry"

    updated = admin.put(
        f"/api/farms/{farm['id']}", json=farm_payload(name="Hilltop Unit 2", capacity=9000)
    )
    assert updated.status_code == 200
    assert updated.get_json()["farm"]["name"] == "Hilltop Unit 2"
    assert updated.get_json()["farm"]["capacity"] == 9000

    assert admin.delete(f"/api/farms/{farm['id']}").status_code == 204
    assert admin.get(f"/api/farms/{farm['id']}").status_code == 404


def test_farm_validation_and_unique_code(as_role):
    admin = as_role("admin")
    bad = admin.post(
        "/api/farms", json=farm_payload(code="!", capacity=0, housingType="Tent", status="x")
    )
    assert bad.status_code == 400
    assert set(bad.get_json()["error"]["fields"]) == {"code", "capacity", "housingType", "status"}
    assert admin.post("/api/farms", json=farm_payload()).status_code == 201
    dup = admin.post("/api/farms", json=farm_payload(code="f-100"))
    assert dup.status_code == 400
    assert "code" in dup.get_json()["error"]["fields"]


def test_farm_stats_count_batches(as_role):
    admin = as_role("admin")
    farm_id = admin.post("/api/farms", json=farm_payload()).get_json()["farm"]["id"]
    admin.post("/api/batches", json=batch_payload(farm_id, code="B-1", initialCount=1000))
    admin.post(
        "/api/batches",
        json=batch_payload(farm_id, code="B-2", initialCount=500, status="completed"),
    )
    farm = admin.get("/api/farms").get_json()["farms"][0]
    assert (farm["totalBatches"], farm["activeBatches"], farm["birdCount"]) == (2, 1, 1000)


def test_farm_manager_creates_farm_and_is_assigned(as_role):
    manager = as_role("farm_manager")
    farm = manager.post("/api/farms", json=farm_payload()).get_json()["farm"]
    assert [f["id"] for f in manager.get("/api/farms").get_json()["farms"]] == [farm["id"]]
    me = manager.get("/api/auth/me").get_json()["user"]
    assert me["farmIds"] == [farm["id"]]


def test_users_only_see_assigned_farms(as_role, make_farm):
    farm_a = make_farm("F-A", "Farm A")
    farm_b = make_farm("F-B", "Farm B")
    manager = as_role("farm_manager", farms=[farm_a])
    analyst = as_role("analyst", farms=[farm_b])
    vet = as_role("veterinarian", farms=[farm_a, farm_b])

    assert [f["code"] for f in manager.get("/api/farms").get_json()["farms"]] == ["F-A"]
    assert [f["code"] for f in analyst.get("/api/farms").get_json()["farms"]] == ["F-B"]
    assert {f["code"] for f in vet.get("/api/farms").get_json()["farms"]} == {"F-A", "F-B"}
    assert as_role("analyst").get("/api/farms").get_json()["farms"] == []


def test_unassigned_farm_is_hidden_and_cannot_be_changed(as_role, make_farm):
    farm_a = make_farm("F-A", "Farm A")
    farm_b = make_farm("F-B", "Farm B")
    manager = as_role("farm_manager", farms=[farm_a])
    assert manager.get(f"/api/farms/{farm_b}").status_code == 404
    assert manager.put(f"/api/farms/{farm_b}", json=farm_payload(code="F-B")).status_code == 404
    assert manager.get(f"/api/farms/{farm_b}/batches").status_code == 404
    assert manager.put(f"/api/farms/{farm_a}", json=farm_payload(code="F-A")).status_code == 200


def test_read_only_roles_cannot_modify_farms(as_role, make_farm):
    farm_a = make_farm()
    for role in ("analyst", "veterinarian"):
        c = as_role(role, farms=[farm_a])
        assert c.get(f"/api/farms/{farm_a}").status_code == 200
        assert c.post("/api/farms", json=farm_payload()).status_code == 403
        assert c.put(f"/api/farms/{farm_a}", json=farm_payload(code="F-001")).status_code == 403
        assert c.delete(f"/api/farms/{farm_a}").status_code == 403


def test_only_admin_deletes_farms_and_not_with_active_batches(as_role, make_farm):
    farm_id = make_farm()
    manager = as_role("farm_manager", farms=[farm_id])
    admin = as_role("admin")
    manager.post("/api/batches", json=batch_payload(farm_id))
    assert manager.delete(f"/api/farms/{farm_id}").status_code == 403
    blocked = admin.delete(f"/api/farms/{farm_id}")
    assert blocked.status_code == 409
    assert blocked.get_json()["error"]["code"] == "FARM_HAS_ACTIVE_BATCHES"
    batch_id = admin.get("/api/batches").get_json()["batches"][0]["id"]
    admin.put(f"/api/batches/{batch_id}", json=batch_payload(farm_id, status="completed"))
    assert admin.delete(f"/api/farms/{farm_id}").status_code == 204
    assert admin.get(f"/api/batches/{batch_id}").status_code == 404  # batches removed with the farm
