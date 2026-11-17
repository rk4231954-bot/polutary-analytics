"""Audit logging: what is recorded, what is never recorded, and that entries are append-only."""

from __future__ import annotations

import pytest
from conftest import PASSWORD, audit_rows, farm_payload

from app.extensions import db
from app.models import AuditLog


def test_security_and_data_events_are_recorded(client, make_client, as_role, app):
    client.post(
        "/api/auth/register",
        json={"fullName": "Ann Lee", "email": "ann@example.org", "password": "GoodPass123"},
    )
    client.login("ann@example.org", "WrongPass999")
    client.login("ann@example.org", "GoodPass123")
    client.post("/api/auth/logout")

    admin = as_role("admin")
    farm_id = admin.post("/api/farms", json=farm_payload()).get_json()["farm"]["id"]
    admin.put(f"/api/farms/{farm_id}", json=farm_payload(name="Renamed"))

    rows = audit_rows(app)
    pairs = [(action, outcome) for action, outcome, *_ in rows]
    for expected in [
        ("auth.register", "success"),
        ("auth.login", "failure"),
        ("auth.login", "success"),
        ("auth.logout", "success"),
        ("farm.create", "success"),
        ("farm.update", "success"),
    ]:
        assert expected in pairs
    update = next(r for r in rows if r[0] == "farm.update")
    assert '"changed": ["name"]' in update[3]


def test_no_passwords_or_tokens_are_ever_logged(client, make_user, app):
    make_user("ann@example.org")
    client.login("ann@example.org", "SuperSecret999")
    client.login("ann@example.org")
    client.post(
        "/api/auth/change-password",
        json={"currentPassword": PASSWORD, "newPassword": "Another123x"},
    )
    token = client.access_cookie()
    with app.app_context():
        dump = " ".join(str(vars(e)) for e in db.session.query(AuditLog))
    for secret in ("SuperSecret999", PASSWORD, "Another123x", token, client.csrf):
        assert secret not in dump


def test_audit_details_drop_sensitive_keys(app):
    from app.services import audit_service

    with app.test_request_context():
        entry = audit_service.record(
            "test.event", details={"password": "x", "apiToken": "y", "farm": "F-1"}
        )
        assert entry.details == '{"farm": "F-1"}'


def test_audit_entries_are_append_only(app, make_user):
    make_user("ann@example.org")
    with app.test_request_context():
        from app.services import audit_service

        entry = audit_service.record("test.event")
        entry.outcome = "failure"
        with pytest.raises(RuntimeError):
            db.session.commit()
        db.session.rollback()
        db.session.delete(db.session.get(AuditLog, entry.id))
        with pytest.raises(RuntimeError):
            db.session.commit()
        db.session.rollback()


def test_admin_can_filter_audit_log(as_role, make_client, make_user):
    make_user("ann@example.org")
    make_client().login("ann@example.org", "WrongPass999")
    admin = as_role("admin")
    failures = admin.get("/api/audit-logs?outcome=failure").get_json()["entries"]
    assert failures and all(e["outcome"] == "failure" for e in failures)
    auth = admin.get("/api/audit-logs?action=auth").get_json()["entries"]
    assert auth and all(e["action"].startswith("auth.") for e in auth)
    assert admin.get("/api/audit-logs?outcome=bogus").status_code == 400
    assert admin.get("/api/audit-logs?from=not-a-date").status_code == 400
    events = admin.get("/api/audit-logs/security-events").get_json()["events"]
    assert any(e["type"] == "Failed sign-in" for e in events)
