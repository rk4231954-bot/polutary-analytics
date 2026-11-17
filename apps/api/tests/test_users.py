"""Admin user management and role-based access control."""

from __future__ import annotations

import pytest
from conftest import PASSWORD, audit_rows


@pytest.mark.parametrize("role", ["farm_manager", "analyst", "veterinarian"])
def test_admin_only_endpoints_are_forbidden_for_other_roles(as_role, role, app):
    c = as_role(role)
    for path in (
        "/api/users",
        "/api/users/login-activity",
        "/api/users/failed-logins",
        "/api/audit-logs",
        "/api/audit-logs/security-events",
    ):
        response = c.get(path)
        assert response.status_code == 403, path
        assert response.get_json()["error"]["code"] == "FORBIDDEN"
    assert (
        c.post(
            "/api/users", json={"fullName": "X Y", "email": "x@y.org", "role": "admin"}
        ).status_code
        == 403
    )
    assert audit_rows(app, "access.denied")[-1][1] == "denied"


def test_role_permissions_are_exposed_to_the_frontend(as_role):
    perms = {
        r: set(as_role(r).get("/api/auth/me").get_json()["user"]["permissions"])
        for r in ("admin", "farm_manager", "analyst", "veterinarian")
    }
    assert {"users.manage", "audit.view", "farms.delete"} <= perms["admin"]
    assert "batches.manage" in perms["farm_manager"] and "users.manage" not in perms["farm_manager"]
    assert perms["analyst"] == {"analytics.view", "reports.generate"}
    assert perms["veterinarian"] == {"health.view", "inspections.record"}


def test_admin_creates_user_with_temporary_password(as_role, make_client, make_farm):
    farm_id = make_farm()
    admin = as_role("admin")
    response = admin.post(
        "/api/users",
        json={
            "fullName": "Kamal Dias",
            "email": "kamal@example.org",
            "role": "veterinarian",
            "farmIds": [farm_id],
        },
    )
    assert response.status_code == 201
    body = response.get_json()
    assert body["user"]["mustChangePassword"] is True
    assert body["user"]["farmIds"] == [farm_id]
    temporary = body["temporaryPassword"]

    kamal = make_client()
    assert kamal.login("kamal@example.org", temporary).status_code == 200
    blocked = kamal.get("/api/farms")
    assert blocked.status_code == 403
    assert blocked.get_json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"
    assert kamal.get("/api/auth/me").status_code == 200
    changed = kamal.post(
        "/api/auth/change-password",
        json={"currentPassword": temporary, "newPassword": "MyOwnPass77"},
    )
    assert changed.status_code == 200
    assert kamal.get("/api/farms").status_code == 200


def test_role_status_and_farm_changes_are_enforced_and_audited(
    as_role, make_user, make_client, make_farm, app
):
    farm_id = make_farm()
    admin = as_role("admin")
    user_id = make_user("ravi@example.org", "analyst")
    ravi = make_client()
    ravi.login("ravi@example.org")
    assert ravi.post("/api/farms", json={}).status_code == 403

    response = admin.patch(
        f"/api/users/{user_id}", json={"role": "farm_manager", "farmIds": [farm_id]}
    )
    assert response.status_code == 200
    assert response.get_json()["user"]["role"] == "farm_manager"
    # The new role applies to the existing session immediately (role is read on every request).
    assert [f["id"] for f in ravi.get("/api/farms").get_json()["farms"]] == [farm_id]

    assert admin.patch(f"/api/users/{user_id}", json={"status": "suspended"}).status_code == 200
    assert ravi.get("/api/auth/me").status_code == 401  # suspension ends sessions
    assert make_client().login("ravi@example.org", PASSWORD).status_code == 403

    actions = [a for a, *_ in audit_rows(app) if a.startswith("user.")]
    assert {"user.role_change", "user.farm_access_change", "user.status_change"} <= set(actions)


def test_admin_cannot_demote_or_suspend_self(as_role, app):
    admin = as_role("admin")
    me = admin.get("/api/auth/me").get_json()["user"]
    response = admin.patch(f"/api/users/{me['id']}", json={"role": "analyst"})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "CANNOT_MODIFY_SELF"


def test_admin_can_promote_and_suspend_other_admins(as_role, make_user, make_client):
    admin = as_role("admin")
    other = make_user("other@example.org", "analyst")
    assert admin.patch(f"/api/users/{other}", json={"role": "admin"}).status_code == 200
    promoted = make_client()
    promoted.login("other@example.org")
    assert promoted.get("/api/users").status_code == 200
    assert admin.patch(f"/api/users/{other}", json={"status": "suspended"}).status_code == 200
    assert promoted.get("/api/users").status_code == 401


def test_admin_password_reset(as_role, make_user, make_client):
    admin = as_role("admin")
    user_id = make_user("lost@example.org")
    old_session = make_client()
    old_session.login("lost@example.org")
    response = admin.post(f"/api/users/{user_id}/reset-password")
    assert response.status_code == 200
    temporary = response.get_json()["temporaryPassword"]
    assert old_session.get("/api/auth/me").status_code == 401
    assert make_client().login("lost@example.org", temporary).status_code == 200


def test_unknown_farm_ids_are_rejected(as_role, make_user):
    admin = as_role("admin")
    user_id = make_user("x@example.org")
    response = admin.patch(f"/api/users/{user_id}", json={"farmIds": [999]})
    assert response.status_code == 400


def test_login_activity_and_failed_logins(as_role, make_client, make_user):
    make_user("ann@example.org")
    c = make_client()
    c.login("ann@example.org", "WrongPass999")
    c.login("ann@example.org", "WrongPass999")
    c.login("ann@example.org")
    admin = as_role("admin")
    logins = admin.get("/api/users/login-activity").get_json()["logins"]
    assert {entry["email"] for entry in logins} >= {"ann@example.org"}
    failed = admin.get("/api/users/failed-logins").get_json()["attempts"]
    assert failed[0]["email"] == "ann@example.org" and failed[0]["attempts"] == 2
