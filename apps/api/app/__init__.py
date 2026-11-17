"""Polutary Analytics REST API (Flask application factory)."""

from __future__ import annotations

import logging
import os

from flask import Flask, request
from werkzeug.middleware.proxy_fix import ProxyFix

__version__ = "0.3.0"


def create_app(config_name: str | None = None, overrides: dict | None = None) -> Flask:
    from app import cli, models  # noqa: F401  (models registers tables + SQLite FK pragma)
    from app.config import load_config
    from app.extensions import cors, db, jwt
    from app.routes import register_blueprints
    from app.services import auth_service  # noqa: F401  (registers JWT callbacks)
    from app.services.permissions import seed_roles
    from app.services.rate_limit import SlidingWindowLimiter
    from app.utils.errors import register_error_handlers

    app = Flask(
        __name__, instance_path=os.path.join(os.path.dirname(os.path.dirname(__file__)), "instance")
    )
    app.config.from_object(load_config(config_name))
    if overrides:
        app.config.update(overrides)
    os.makedirs(app.instance_path, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    if app.config["TRUST_PROXY_COUNT"] > 0:
        n = app.config["TRUST_PROXY_COUNT"]
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=n, x_proto=n, x_host=n)

    db.init_app(app)
    jwt.init_app(app)
    cors.init_app(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ALLOWED_ORIGINS"]}},
        supports_credentials=True,
        allow_headers=["Content-Type", "X-CSRF-TOKEN", "X-Requested-With"],
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        max_age=600,
    )
    app.extensions["login_limiter"] = SlidingWindowLimiter()

    register_error_handlers(app)  # after jwt.init_app so our CSRF handler wins
    register_blueprints(app)
    cli.register(app)

    @app.after_request
    def _after(response):
        response = auth_service.refresh_if_needed(response)
        return _security_headers(app, response)

    with app.app_context():
        db.create_all()
        seed_roles()

    return app


def _security_headers(app: Flask, response):
    headers = response.headers
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Referrer-Policy", "no-referrer")
    headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
    headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    headers.setdefault("Cross-Origin-Resource-Policy", "same-site")
    if request.path.startswith("/api/"):
        headers["Cache-Control"] = "no-store"
    if app.config.get("HSTS_ENABLED"):
        headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response
