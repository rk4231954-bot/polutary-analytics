"""CORS, security headers, configuration safety, error shape and the admin bootstrap command."""

from __future__ import annotations

import pytest

from app.config import ConfigError, load_config
from app.extensions import db
from app.models import AuditLog, User


def test_health_is_public(client):
    body = client.get("/api/health").get_json()
    assert body["status"] == "ok" and body["database"] == "ok"


def test_cors_allows_configured_origin_with_credentials(client):
    response = client.http.options(
        "/api/auth/login",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type, X-CSRF-TOKEN",
        },
    )
    assert response.headers["Access-Control-Allow-Origin"] == "http://localhost:5173"
    assert response.headers["Access-Control-Allow-Credentials"] == "true"
    assert "x-csrf-token" in response.headers["Access-Control-Allow-Headers"].lower()


def test_cors_ignores_other_origins(client):
    response = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in response.headers


def test_security_headers(client):
    headers = client.get("/api/health").headers
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert headers["Cache-Control"] == "no-store"
    assert "default-src 'none'" in headers["Content-Security-Policy"]


def test_unknown_endpoint_uses_json_error_shape(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.get_json() == {
        "error": {"code": "ENDPOINT_NOT_FOUND", "message": "This API endpoint does not exist."}
    }


def test_method_not_allowed_shape(client):
    response = client.http.put("/api/health")
    assert response.status_code == 405
    assert response.get_json()["error"]["code"] == "METHOD_NOT_ALLOWED"


@pytest.mark.parametrize("secret", ["", "change-me", "short-secret"])
def test_weak_secret_key_is_refused(monkeypatch, secret):
    monkeypatch.setenv("SECRET_KEY", secret)
    with pytest.raises(ConfigError):
        load_config("development")


def test_wildcard_cors_is_refused(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "x" * 40)
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "*")
    with pytest.raises(ConfigError):
        load_config("development")


def test_cross_site_cookies_require_https(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "x" * 40)
    monkeypatch.setenv("JWT_COOKIE_SAMESITE", "None")
    monkeypatch.setenv("JWT_COOKIE_SECURE", "false")
    with pytest.raises(ConfigError):
        load_config("development")


def test_production_requires_secure_cookies(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "x" * 40)
    monkeypatch.delenv("JWT_COOKIE_SECURE", raising=False)
    with pytest.raises(ConfigError):
        load_config("production")


def test_create_admin_command(app):
    runner = app.test_cli_runner()
    result = runner.invoke(
        args=[
            "create-admin",
            "--email",
            "Root@Example.org",
            "--name",
            "Root Admin",
            "--password-stdin",
        ],
        input="AdminPass123\n",
    )
    assert result.exit_code == 0, result.output
    assert "AdminPass123" not in result.output
    with app.app_context():
        user = db.session.query(User).filter_by(email="root@example.org").one()
        assert user.role_name == "admin"
        assert user.password_hash.startswith("$argon2id$")
        assert db.session.query(AuditLog).filter_by(action="user.admin_bootstrap").count() == 1

    again = runner.invoke(
        args=["create-admin", "--email", "two@example.org", "--name", "Two", "--password-stdin"],
        input="AdminPass123\n",
    )
    assert again.exit_code != 0
    assert "already exists" in again.output


def test_create_admin_rejects_weak_password(app):
    result = app.test_cli_runner().invoke(
        args=["create-admin", "--email", "root@example.org", "--name", "Root", "--password-stdin"],
        input="weak\n",
    )
    assert result.exit_code != 0
