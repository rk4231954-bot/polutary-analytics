"""Entry point.

    uv run python run.py                 # development server on API_HOST:API_PORT
    uv run flask --app run <command>     # CLI commands (init-db, create-admin, ...)

Environment variables are read from apps/api/.env, then the repository-root .env
(values already set in the real environment always win).
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
load_dotenv(HERE.parent.parent / ".env")

from app import create_app  # noqa: E402  (env must be loaded first)

app = create_app()

if __name__ == "__main__":
    app.run(
        host=os.environ.get("API_HOST", "127.0.0.1"),
        port=int(os.environ.get("API_PORT", "5000")),
        debug=app.config.get("DEBUG", False),
    )
