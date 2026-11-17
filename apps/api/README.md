# apps/api: Flask REST API

Handles authentication, roles, farms, CSV uploads and validation, audit logging and reports. Stores app data in SQLite through SQLAlchemy. Writes processed datasets to HDFS and runs HiveQL through PyHive.

This is a standalone Python project, so Bun isn't needed to run it.

```bash
cd apps/api
uv sync              # create .venv and install pinned dependencies
uv run pytest        # tests
uv run ruff check .  # lint
```

Without uv: `python3.12 -m venv .venv && . .venv/bin/activate && pip install -e . pytest==9.2.0 ruff==0.17.5`.

Status: scaffold only. The Flask app factory comes in stage 3.
