"""Configuration, read only from environment variables (.env files are loaded by run.py).

Secrets are never hard-coded. Each setting has a safe default except SECRET_KEY,
which must always be provided (except in the automated test configuration).
"""

from __future__ import annotations

import getpass
import os
import re
from datetime import timedelta
from pathlib import Path

# Repository root (apps/api/app/config.py → parents[3]). Datasets live in <repo>/data by default.
REPO_ROOT = Path(__file__).resolve().parents[3]

WEAK_SECRETS = {"", "change-me", "changeme", "secret", "dev", "development"}

HIVE_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
HDFS_DIR_RE = re.compile(r"^(/[A-Za-z0-9_-]+)+$")
HIVE_AUTH_MODES = {"NONE", "NOSASL", "LDAP", "CUSTOM"}


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    return int(value) if value else default


def _list(name: str, default: str = "") -> list[str]:
    return [
        item.strip().rstrip("/")
        for item in os.environ.get(name, default).split(",")
        if item.strip()
    ]


class ConfigError(RuntimeError):
    """Raised when the environment is missing or has unsafe settings."""


class BaseConfig:
    TESTING = False

    def __init__(self) -> None:
        self.SECRET_KEY = os.environ.get("SECRET_KEY", "")
        # Separate JWT signing key is optional; falls back to SECRET_KEY.
        self.JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY") or self.SECRET_KEY

        # Database: SQLite by default. Any SQLAlchemy URL works (e.g. postgresql+psycopg://...).
        # A relative SQLite path is resolved inside apps/api/instance/ by Flask-SQLAlchemy.
        self.SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL", "sqlite:///polutary.sqlite3")
        self.SQLALCHEMY_TRACK_MODIFICATIONS = False

        # JSON requests. The CSV upload endpoint raises its own limit to MAX_UPLOAD_MB.
        self.MAX_CONTENT_LENGTH = _int("MAX_REQUEST_KB", 64) * 1024
        self.MAX_UPLOAD_MB = _int("MAX_UPLOAD_MB", 50)
        # Uploaded and processed datasets: <DATA_DIR>/raw and <DATA_DIR>/processed.
        # Kept outside every web-served directory; files are never served directly.
        self.DATA_DIR = str(Path(os.environ.get("DATA_DIR") or REPO_ROOT / "data").resolve())
        self.CORS_ALLOWED_ORIGINS = _list("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
        self.TRUST_PROXY_COUNT = _int("TRUST_PROXY_COUNT", 0)

        # --- JWT in HttpOnly cookies, with double-submit CSRF protection ---
        self.JWT_TOKEN_LOCATION = ["cookies"]
        self.JWT_COOKIE_CSRF_PROTECT = True
        self.JWT_CSRF_METHODS = ["POST", "PUT", "PATCH", "DELETE"]
        self.JWT_ACCESS_TOKEN_EXPIRES = timedelta(minutes=_int("JWT_ACCESS_MINUTES", 30))
        self.JWT_REFRESH_WINDOW = timedelta(minutes=_int("JWT_REFRESH_WINDOW_MINUTES", 10))
        self.SESSION_MAX_AGE = timedelta(hours=_int("SESSION_MAX_HOURS", 12))
        self.SESSION_REMEMBER_MAX_AGE = timedelta(days=_int("SESSION_REMEMBER_DAYS", 7))
        self.JWT_COOKIE_SECURE = _bool("JWT_COOKIE_SECURE", False)
        # "Lax" when the frontend is served from the same site (Vite proxy);
        # "None" (+ JWT_COOKIE_SECURE=true) when it is on another domain such as Vercel.
        self.JWT_COOKIE_SAMESITE = os.environ.get("JWT_COOKIE_SAMESITE", "Lax")
        self.JWT_ACCESS_COOKIE_NAME = "pa_access"
        self.JWT_ACCESS_CSRF_COOKIE_NAME = "pa_csrf"
        self.JWT_ACCESS_COOKIE_PATH = "/api/"
        self.JWT_ACCESS_CSRF_COOKIE_PATH = "/"
        self.JWT_ACCESS_CSRF_HEADER_NAME = "X-CSRF-TOKEN"

        # --- Login throttling (per IP and per email, counted on failures) ---
        self.LOGIN_MAX_FAILURES_PER_EMAIL = _int("LOGIN_MAX_FAILURES_PER_EMAIL", 5)
        self.LOGIN_MAX_FAILURES_PER_IP = _int("LOGIN_MAX_FAILURES_PER_IP", 20)
        self.LOGIN_WINDOW_SECONDS = _int("LOGIN_WINDOW_SECONDS", 15 * 60)
        self.REGISTER_MAX_PER_IP = _int("REGISTER_MAX_PER_IP", 10)
        self.REGISTER_WINDOW_SECONDS = _int("REGISTER_WINDOW_SECONDS", 60 * 60)

        self.HSTS_ENABLED = _bool("HSTS_ENABLED", False)

        # --- Apache Hive (HiveServer2 via PyHive). Analytics are HiveQL on Hive, never SQLite. ---
        self.HIVE_HOST = os.environ.get("HIVE_HOST", "localhost").strip()
        self.HIVE_PORT = _int("HIVE_PORT", 10000)
        # User HiveServer2 runs queries as (doAs). Empty = the OS user running the API.
        self.HIVE_USERNAME = os.environ.get("HIVE_USERNAME", "").strip()
        self.HIVE_PASSWORD = os.environ.get("HIVE_PASSWORD", "")
        self.HIVE_DATABASE = os.environ.get("HIVE_DATABASE", "poultry_analytics").strip()
        self.HIVE_AUTH = os.environ.get("HIVE_AUTH", "NONE").strip().upper()
        # External, partitioned Hive table over the processed uploads in HDFS (stage 8).
        self.HIVE_UPLOADS_TABLE = os.environ.get("HIVE_UPLOADS_TABLE", "poultry_uploads").strip()
        # NameNode HTTP address (JMX + WebHDFS), read-only use for the Big Data status page.
        self.WEBHDFS_URL = os.environ.get("WEBHDFS_URL", "http://127.0.0.1:9870").strip()
        # --- HDFS storage of processed uploads (WebHDFS). ---
        self.HDFS_ENABLED = _bool("HDFS_ENABLED", True)
        # HDFS user for writes (simple auth). Defaults to the Hive user, then the OS user.
        self.HDFS_USER = (
            os.environ.get("HDFS_USER", "").strip() or self.HIVE_USERNAME or getpass.getuser()
        )
        # Host to use for DataNode transfers instead of the hostname the NameNode returns
        # (127.0.0.1 for the loopback-only native install). Empty = use it unchanged.
        self.HDFS_DATANODE_HOST = os.environ.get("HDFS_DATANODE_HOST", "").strip()
        self.HDFS_PROCESSED_DIR = os.environ.get(
            "HDFS_PROCESSED_DIR", "/polutary/processed"
        ).strip()

    def validate(self) -> None:
        if self.SECRET_KEY.strip().lower() in WEAK_SECRETS or len(self.SECRET_KEY) < 32:
            raise ConfigError(
                "SECRET_KEY is missing or too weak. Set a random value of at least 32 characters "
                'in apps/api/.env, e.g. python3 -c "import secrets; print(secrets.token_hex(32))"'
            )
        if "*" in self.CORS_ALLOWED_ORIGINS:
            raise ConfigError(
                "CORS_ALLOWED_ORIGINS must list explicit origins; '*' is not allowed."
            )
        if self.JWT_COOKIE_SAMESITE not in {"Lax", "Strict", "None"}:
            raise ConfigError("JWT_COOKIE_SAMESITE must be Lax, Strict or None.")
        if self.JWT_COOKIE_SAMESITE == "None" and not self.JWT_COOKIE_SECURE:
            raise ConfigError("JWT_COOKIE_SAMESITE=None requires JWT_COOKIE_SECURE=true (HTTPS).")
        if not 1 <= self.MAX_UPLOAD_MB <= 500:
            raise ConfigError("MAX_UPLOAD_MB must be between 1 and 500.")
        if not HIVE_IDENTIFIER_RE.match(self.HIVE_DATABASE):
            raise ConfigError("HIVE_DATABASE must be a plain Hive identifier (letters, digits, _).")
        if not HIVE_IDENTIFIER_RE.match(self.HIVE_UPLOADS_TABLE):
            raise ConfigError("HIVE_UPLOADS_TABLE must be a plain Hive identifier.")
        if self.HIVE_AUTH not in HIVE_AUTH_MODES:
            raise ConfigError(f"HIVE_AUTH must be one of: {', '.join(sorted(HIVE_AUTH_MODES))}.")
        if self.HIVE_PASSWORD and self.HIVE_AUTH not in {"LDAP", "CUSTOM"}:
            raise ConfigError("HIVE_PASSWORD is only used with HIVE_AUTH=LDAP or CUSTOM.")
        if not HDFS_DIR_RE.match(self.HDFS_PROCESSED_DIR) or ".." in self.HDFS_PROCESSED_DIR:
            raise ConfigError(
                "HDFS_PROCESSED_DIR must be an absolute HDFS path such as /polutary/processed."
            )
        if self.HDFS_DATANODE_HOST and not re.fullmatch(r"[A-Za-z0-9.-]+", self.HDFS_DATANODE_HOST):
            raise ConfigError("HDFS_DATANODE_HOST must be a host name or IPv4 address.")
        if not HIVE_IDENTIFIER_RE.match(self.HDFS_USER):
            raise ConfigError("HDFS_USER must be a plain user name.")
        if not self.WEBHDFS_URL.startswith(("http://", "https://")):
            raise ConfigError("WEBHDFS_URL must be an http:// or https:// URL.")
        if not 1 <= self.HIVE_PORT <= 65535:
            raise ConfigError("HIVE_PORT must be a valid TCP port.")
        web_dir = (REPO_ROOT / "apps" / "web").resolve()
        if Path(self.DATA_DIR).is_relative_to(web_dir):
            raise ConfigError("DATA_DIR must not be inside apps/web (it would be web-served).")


class DevelopmentConfig(BaseConfig):
    DEBUG = True


class ProductionConfig(BaseConfig):
    DEBUG = False

    def validate(self) -> None:
        super().validate()
        if not self.JWT_COOKIE_SECURE:
            raise ConfigError(
                "Production requires JWT_COOKIE_SECURE=true (cookies over HTTPS only)."
            )


class TestingConfig(BaseConfig):
    TESTING = True

    def __init__(self) -> None:
        super().__init__()
        self.SECRET_KEY = "test-only-secret-key-not-used-anywhere-else-0123456789"  # noqa: S105
        self.JWT_SECRET_KEY = self.SECRET_KEY
        self.SQLALCHEMY_DATABASE_URI = "sqlite://"
        self.CORS_ALLOWED_ORIGINS = ["http://localhost:5173"]
        self.JWT_COOKIE_SECURE = False
        self.JWT_COOKIE_SAMESITE = "Lax"


CONFIGS = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "testing": TestingConfig,
}


def load_config(name: str | None = None) -> BaseConfig:
    name = (
        name or os.environ.get("APP_ENV") or os.environ.get("FLASK_ENV") or "development"
    ).lower()
    if name not in CONFIGS:
        raise ConfigError(f"Unknown APP_ENV '{name}'. Use one of: {', '.join(CONFIGS)}.")
    config = CONFIGS[name]()
    config.validate()
    return config
