"""Registration, login, logout, sessions, CSRF, password change and throttling."""

from __future__ import annotations

from datetime import timedelta

from conftest import PASSWORD, audit_rows

from app.extensions import db
from app.models import User

NEW_USER = {"fullName": "Nimal Silva", "email": "Nimal@Example.org", "password": "GoodPass123"}


# --- Registration ---------------------------------------------------------------
def test_register_creates_least_privileged_account(client):
    response = client.post("/api/auth/register", json=NEW_USER)
    assert response.status_code == 201
    user = response.get_json()["user"]
    assert user["email"] == "nimal@example.org"  # normalised
    assert user["role"] == "analyst"
    assert user["farms"] == []
    text = response.get_data(as_text=True)
    assert NEW_USER["password"] not in text and "argon2" not in text and "passwordHash" not in text


def test_register_rejects_duplicate_email_case_insensitively(client):
    assert client.post("/api/auth/register", json=NEW_USER).status_code == 201
    response = client.post("/api/auth/register", json={**NEW_USER, "email": "NIMAL@example.org"})
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "EMAIL_TAKEN"


def test_register_cannot_choose_admin_role(client, app):
    response = client.post("/api/auth/register", json={**NEW_USER, "role": "admin"})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "ROLE_NOT_ALLOWED"
    with app.app_context():
        assert db.session.query(User).count() == 0
    assert audit_rows(app, "auth.register")[-1][1] == "denied"


def test_register_validates_input(client):
    response = client.post(
        "/api/auth/register", json={"fullName": "A", "email": "bad", "password": "short"}
    )
    assert response.status_code == 400
    fields = response.get_json()["error"]["fields"]
    assert set(fields) == {"fullName", "email", "password"}


def test_register_requires_letters_and_digits(client):
    response = client.post("/api/auth/register", json={**NEW_USER, "password": "onlyletters"})
    assert response.status_code == 400
    assert "password" in response.get_json()["error"]["fields"]


def test_register_requires_json_body(client):
    response = client.http.post(
        "/api/auth/register", data="fullName=x", content_type="application/x-www-form-urlencoded"
    )
    assert response.status_code == 415


# --- Password hashing -----------------------------------------------------------
def test_password_is_stored_as_argon2id_hash(client, app):
    client.post("/api/auth/register", json=NEW_USER)
    with app.app_context():
        user = db.session.query(User).one()
        assert user.password_hash.startswith("$argon2id$")
        assert NEW_USER["password"] not in user.password_hash
        assert "GoodPass123" not in repr(user)


def test_hashes_are_salted(make_user, app):
    make_user("a@example.org")
    make_user("b@example.org")
    with app.app_context():
        hashes = [u.password_hash for u in db.session.query(User)]
    assert hashes[0] != hashes[1]  # same password, different salts


# --- Login ----------------------------------------------------------------------
def test_login_sets_httponly_cookie_and_returns_csrf(client, make_user):
    make_user("ann@example.org")
    response = client.login("ANN@example.org")
    assert response.status_code == 200
    body = response.get_json()
    assert body["user"]["email"] == "ann@example.org"
    assert body["csrfToken"]
    cookies = response.headers.getlist("Set-Cookie")
    access = next(c for c in cookies if c.startswith("pa_access="))
    assert "HttpOnly" in access and "SameSite=Lax" in access
    assert "Max-Age" not in access  # browser-session cookie unless "keep me signed in"


def test_login_remember_sets_persistent_cookie(client, make_user):
    make_user("ann@example.org")
    response = client.login("ann@example.org", remember=True)
    access = next(c for c in response.headers.getlist("Set-Cookie") if c.startswith("pa_access="))
    assert "Max-Age=" in access


def test_login_rejects_wrong_password(client, make_user, app):
    make_user("ann@example.org")
    response = client.login("ann@example.org", "WrongPass999")
    assert response.status_code == 401
    assert response.get_json()["error"] == {
        "code": "INVALID_CREDENTIALS",
        "message": "Incorrect email or password.",
    }
    assert client.access_cookie() is None


def test_login_unknown_email_gives_same_error(client):
    response = client.login("nobody@example.org")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "INVALID_CREDENTIALS"


def test_suspended_user_cannot_login(client, make_user):
    make_user("sus@example.org", status="suspended")
    response = client.login("sus@example.org")
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "ACCOUNT_SUSPENDED"


def test_login_is_rate_limited_per_email(client, make_user, app):
    make_user("ann@example.org")
    for _ in range(app.config["LOGIN_MAX_FAILURES_PER_EMAIL"]):
        assert client.login("ann@example.org", "WrongPass999").status_code == 401
    blocked = client.login("ann@example.org")  # even the right password is refused while blocked
    assert blocked.status_code == 429
    assert blocked.get_json()["error"]["code"] == "TOO_MANY_ATTEMPTS"
    assert int(blocked.headers["Retry-After"]) > 0
    assert audit_rows(app, "auth.login")[-1][1] == "denied"


def test_successful_login_resets_email_counter(client, make_user, app):
    make_user("ann@example.org")
    for _ in range(app.config["LOGIN_MAX_FAILURES_PER_EMAIL"] - 1):
        client.login("ann@example.org", "WrongPass999")
    assert client.login("ann@example.org").status_code == 200
    assert client.login("ann@example.org", "WrongPass999").status_code == 401  # counter restarted


# --- Session, CSRF, logout ------------------------------------------------------
def test_me_requires_authentication(client):
    response = client.get("/api/auth/me")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "AUTH_REQUIRED"


def test_me_returns_current_user(client, make_user):
    make_user("ann@example.org", "farm_manager")
    client.login("ann@example.org")
    body = client.get("/api/auth/me").get_json()
    assert body["user"]["role"] == "farm_manager"
    assert body["csrfToken"] == client.csrf


def test_state_changing_request_requires_csrf_header(client, make_user):
    make_user("ann@example.org")
    client.login("ann@example.org")
    response = client.patch(
        "/api/auth/me", json={"fullName": "Ann B"}, headers={"X-CSRF-TOKEN": ""}
    )
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "CSRF_FAILED"
    wrong = client.patch(
        "/api/auth/me", json={"fullName": "Ann B"}, headers={"X-CSRF-TOKEN": "forged"}
    )
    assert wrong.status_code == 403
    assert client.patch("/api/auth/me", json={"fullName": "Ann B"}).status_code == 200


def test_logout_revokes_the_session_server_side(client, make_user, app):
    make_user("ann@example.org")
    client.login("ann@example.org")
    stolen = client.access_cookie()
    assert client.post("/api/auth/logout").status_code == 204
    assert client.access_cookie() is None
    # Replaying the old token (e.g. a copied cookie) no longer works.
    client.http.set_cookie("pa_access", stolen, path="/api/")
    response = client.get("/api/auth/me")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "SESSION_REVOKED"
    assert audit_rows(app, "auth.logout")[-1][1] == "success"


def test_logout_without_session_just_clears_cookies(client):
    assert client.post("/api/auth/logout").status_code == 204


def test_session_slides_forward_when_close_to_expiry(client, make_user, app):
    make_user("ann@example.org")
    app.config["JWT_REFRESH_WINDOW"] = timedelta(hours=1)  # every token is "close to expiry"
    client.login("ann@example.org")
    first = client.access_cookie()
    response = client.get("/api/auth/me")
    assert any(c.startswith("pa_access=") for c in response.headers.getlist("Set-Cookie"))
    assert client.access_cookie() != first
    assert client.get("/api/auth/me").get_json()["csrfToken"] == client.csrf  # CSRF unchanged


def test_tampered_token_is_rejected(client, make_user):
    make_user("ann@example.org")
    client.login("ann@example.org")
    token = client.access_cookie()
    client.http.set_cookie("pa_access", token[:-4] + "AAAA", path="/api/")
    response = client.get("/api/auth/me")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "INVALID_TOKEN"


# --- Profile & password ---------------------------------------------------------
def test_update_profile_cannot_change_role(client, make_user):
    make_user("ann@example.org")
    client.login("ann@example.org")
    response = client.patch("/api/auth/me", json={"fullName": "Ann", "role": "admin"})
    assert response.status_code == 400
    assert client.get("/api/auth/me").get_json()["user"]["role"] == "analyst"


def test_change_password_flow(client, make_client, make_user, app):
    make_user("ann@example.org")
    client.login("ann@example.org")
    other_device = make_client()
    other_device.login("ann@example.org")

    wrong = client.post(
        "/api/auth/change-password",
        json={"currentPassword": "nope12345", "newPassword": "NewPass456"},
    )
    assert wrong.status_code == 400  # not 401: a typo must not look like an expired session
    assert wrong.get_json()["error"]["code"] == "INVALID_CURRENT_PASSWORD"

    weak = client.post(
        "/api/auth/change-password", json={"currentPassword": PASSWORD, "newPassword": "short"}
    )
    assert weak.status_code == 400

    ok = client.post(
        "/api/auth/change-password", json={"currentPassword": PASSWORD, "newPassword": "NewPass456"}
    )
    assert ok.status_code == 200
    assert client.get("/api/auth/me").status_code == 200  # this browser stays signed in
    assert other_device.get("/api/auth/me").status_code == 401  # other sessions are signed out
    assert make_client().login("ann@example.org", PASSWORD).status_code == 401
    assert make_client().login("ann@example.org", "NewPass456").status_code == 200
    actions = [(a, o) for a, o, *_ in audit_rows(app, "auth.password_change")]
    assert actions == [("auth.password_change", "failure"), ("auth.password_change", "success")]
