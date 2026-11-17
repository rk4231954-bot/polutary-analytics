"""Shared fixtures. Every test gets a fresh app with its own temporary SQLite file."""

from __future__ import annotations

import pytest

from app import create_app
from app.extensions import db
from app.models import Farm, FarmAssignment, User
from app.services.passwords import hash_password
from app.services.permissions import get_role

PASSWORD = "Str0ngPassw0rd"


@pytest.fixture
def app(tmp_path):
    app = create_app(
        "testing", {"SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path / 'test.sqlite3'}"}
    )
    yield app
    with app.app_context():
        db.session.remove()
        db.engine.dispose()


class ApiClient:
    """Test client that remembers the CSRF token, like the real frontend."""

    def __init__(self, app):
        self.app = app
        self.http = app.test_client()
        self.csrf = None

    def _headers(self, method, headers):
        headers = dict(headers or {})
        if (
            method in {"POST", "PUT", "PATCH", "DELETE"}
            and self.csrf
            and "X-CSRF-TOKEN" not in headers
        ):
            headers["X-CSRF-TOKEN"] = self.csrf
        return headers

    def request(self, method, path, json=None, headers=None, **kwargs):
        return self.http.open(
            path, method=method, json=json, headers=self._headers(method, headers), **kwargs
        )

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, json=None, **kw):
        return self.request("POST", path, json=json, **kw)

    def put(self, path, json=None, **kw):
        return self.request("PUT", path, json=json, **kw)

    def patch(self, path, json=None, **kw):
        return self.request("PATCH", path, json=json, **kw)

    def delete(self, path, **kw):
        return self.request("DELETE", path, **kw)

    def login(self, email, password=PASSWORD, remember=False):
        response = self.post(
            "/api/auth/login", json={"email": email, "password": password, "remember": remember}
        )
        if response.status_code == 200:
            self.csrf = response.get_json()["csrfToken"]
        return response

    def access_cookie(self):
        cookie = self.http.get_cookie("pa_access", path="/api/")
        return cookie.value if cookie else None


@pytest.fixture
def client(app):
    return ApiClient(app)


@pytest.fixture
def make_client(app):
    return lambda: ApiClient(app)


@pytest.fixture
def make_user(app):
    """Creates a user directly in the database (the API path is tested separately)."""

    def _make(email, role="analyst", *, name=None, farms=(), status="active", must_change=False):
        with app.app_context():
            user = User(
                full_name=name or email.split("@")[0].title(),
                email=email,
                password_hash=hash_password(PASSWORD),
                role=get_role(role),
                status=status,
                must_change_password=must_change,
            )
            db.session.add(user)
            db.session.flush()
            for farm_id in farms:
                db.session.add(FarmAssignment(user_id=user.id, farm_id=farm_id))
            db.session.commit()
            return user.id

    return _make


@pytest.fixture
def make_farm(app):
    def _make(code="F-001", name="Greenfield", **extra):
        with app.app_context():
            farm = Farm(
                code=code,
                name=name,
                location="Kandy",
                capacity=5000,
                housing_type="Closed house",
                status="active",
                **extra,
            )
            db.session.add(farm)
            db.session.commit()
            return farm.id

    return _make


@pytest.fixture
def as_role(make_client, make_user):
    """Signed-in client for a new user with the given role and farm assignments."""
    counter = {"n": 0}

    def _login(role, farms=()):
        counter["n"] += 1
        email = f"{role}{counter['n']}@example.org"
        make_user(email, role, farms=farms)
        c = make_client()
        assert c.login(email).status_code == 200
        return c

    return _login


def farm_payload(**overrides):
    payload = {
        "code": "F-100",
        "name": "Hilltop Poultry",
        "location": "Matale",
        "capacity": 8000,
        "housingType": "Closed house",
        "status": "active",
        "manager": "R. Perera",
    }
    payload.update(overrides)
    return payload


def batch_payload(farm_id, **overrides):
    payload = {
        "code": "B-001",
        "farmId": farm_id,
        "poultryType": "Broiler",
        "breed": "Cobb 500",
        "initialCount": 1200,
        "startDate": "2026-10-01",
        "status": "active",
    }
    payload.update(overrides)
    return payload


def audit_rows(app, action=None):
    from app.models import AuditLog

    with app.app_context():
        query = db.session.query(AuditLog)
        if action:
            query = query.filter(AuditLog.action == action)
        return [
            (e.action, e.outcome, e.actor_email, e.details) for e in query.order_by(AuditLog.id)
        ]
