"""Blueprints, one per domain. All routes live under /api."""

from flask import Flask

from app.routes import (
    activity,
    alerts,
    analytics,
    audit,
    auth,
    batches,
    cluster,
    datasets,
    farms,
    flock_performance,
    health,
    users,
)

BLUEPRINT_MODULES = (
    health,
    auth,
    users,
    farms,
    batches,
    datasets,
    analytics,
    flock_performance,
    alerts,
    activity,
    cluster,
    audit,
)


def register_blueprints(app: Flask) -> None:
    for module in BLUEPRINT_MODULES:
        app.register_blueprint(module.bp)
