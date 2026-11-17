"""Blueprints, one per domain. All routes live under /api."""

from flask import Flask

from app.routes import audit, auth, batches, farms, health, users


def register_blueprints(app: Flask) -> None:
    for module in (health, auth, users, farms, batches, audit):
        app.register_blueprint(module.bp)
