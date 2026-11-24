"""HiveServer2 access through PyHive.

Every analytics figure the API returns comes from a real HiveQL query run here.
One connection per call keeps request threads independent. HiveQL text lives in
hive_queries.py; values are always bound as parameters (PyHive "pyformat").

Failures become structured API errors:
  503 HIVE_UNAVAILABLE   HiveServer2 cannot be reached (not started, wrong host/port, dropped).
  503 HIVE_AUTH_FAILED   HiveServer2 refused the API's login (HIVE_USERNAME / HIVE_PASSWORD).
  502 HIVE_QUERY_FAILED  HiveServer2 answered but the session or query failed.
Hive's own error text can contain server internals, so it is logged, not returned.
"""

from __future__ import annotations

import logging
import time
from contextlib import suppress
from datetime import date, datetime
from typing import Any

from flask import current_app
from pyhive import exc as pyhive_exc
from pyhive import hive
from thrift.Thrift import TException

from app.utils.errors import ApiError

log = logging.getLogger(__name__)
# PyHive logs every statement's full text at INFO; run_query logs a one-line summary instead.
logging.getLogger("pyhive").setLevel(logging.WARNING)


class HiveUnavailableError(ApiError):
    def __init__(self) -> None:
        super().__init__(
            503,
            "HIVE_UNAVAILABLE",
            "The Hive analytics service (HiveServer2) is not reachable. "
            "Start HiveServer2 and try again.",
        )


class HiveAuthError(ApiError):
    def __init__(self) -> None:
        super().__init__(
            503,
            "HIVE_AUTH_FAILED",
            "The API could not sign in to the Hive analytics service. "
            "An administrator must check the HiveServer2 credentials.",
        )


# HiveServer2's SASL answer when the user name or password is refused.
_LOGIN_REFUSED = "Error validating the login"


class HiveQueryError(ApiError):
    def __init__(self) -> None:
        super().__init__(
            502,
            "HIVE_QUERY_FAILED",
            "The Hive analytics query failed. Check the HiveServer2 logs for details.",
        )


def _connect():
    cfg = current_app.config
    kwargs: dict[str, Any] = {
        "host": cfg["HIVE_HOST"],
        "port": cfg["HIVE_PORT"],
        "username": cfg["HIVE_USERNAME"] or None,
        "database": cfg["HIVE_DATABASE"],
        "auth": cfg["HIVE_AUTH"],
    }
    if cfg["HIVE_AUTH"] in {"LDAP", "CUSTOM"}:
        kwargs["password"] = cfg["HIVE_PASSWORD"]
    try:
        return hive.connect(**kwargs)
    except (TException, OSError) as exc:
        if _LOGIN_REFUSED in str(exc):
            log.error(
                "HiveServer2 at %s:%s refused the login of user %r (check HIVE_USERNAME, "
                "HIVE_PASSWORD and HIVE_AUTH)",
                cfg["HIVE_HOST"],
                cfg["HIVE_PORT"],
                cfg["HIVE_USERNAME"],
            )
            raise HiveAuthError() from exc
        log.warning(
            "HiveServer2 unreachable at %s:%s (%s)", cfg["HIVE_HOST"], cfg["HIVE_PORT"], exc
        )
        raise HiveUnavailableError() from exc
    except pyhive_exc.Error as exc:  # e.g. the configured database does not exist
        log.error("Could not open a Hive session on database %s: %s", cfg["HIVE_DATABASE"], exc)
        raise HiveQueryError() from exc


def _plain(value: Any) -> Any:
    """Hive DATE/TIMESTAMP values may arrive as strings or date objects; normalise to ISO."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def run_query(
    sql: str, params: dict[str, Any] | None = None, *, name: str = "query"
) -> list[dict[str, Any]]:
    """Runs one HiveQL statement and returns its rows as dicts keyed by column alias."""
    conn = _connect()
    started = time.monotonic()
    try:
        cursor = conn.cursor()
        cursor.execute(sql, params or {})
        # Hive may prefix result columns with a table alias ("t.farm_id"); keep the bare name.
        columns = [d[0].rsplit(".", 1)[-1] for d in cursor.description or []]
        rows = cursor.fetchall()
    except (TException, OSError) as exc:
        log.warning("Lost the HiveServer2 connection during a query: %s", exc)
        raise HiveUnavailableError() from exc
    except pyhive_exc.Error as exc:
        log.error("HiveQL %s failed: %s", name, exc)
        raise HiveQueryError() from exc
    finally:
        with suppress(Exception):
            conn.close()
    log.info("HiveQL %s returned %d rows in %.2fs", name, len(rows), time.monotonic() - started)
    return [{c: _plain(v) for c, v in zip(columns, row, strict=True)} for row in rows]


def run_statement(sql: str, params: dict[str, Any] | None = None, *, name: str = "ddl") -> None:
    """Runs one HiveQL statement that returns no rows (DDL such as ALTER TABLE ... PARTITION)."""
    conn = _connect()
    started = time.monotonic()
    try:
        conn.cursor().execute(sql, params or {})
    except (TException, OSError) as exc:
        log.warning("Lost the HiveServer2 connection during %s: %s", name, exc)
        raise HiveUnavailableError() from exc
    except pyhive_exc.Error as exc:
        log.error("HiveQL %s failed: %s", name, exc)
        raise HiveQueryError() from exc
    finally:
        with suppress(Exception):
            conn.close()
    log.info("HiveQL %s finished in %.2fs", name, time.monotonic() - started)


def ping() -> dict[str, Any]:
    """Cheap connectivity check (metadata only, no MapReduce job)."""
    tables = [row["tab_name"] for row in run_query("SHOW TABLES", name="show_tables")]
    cfg = current_app.config
    return {"connected": True, "database": cfg["HIVE_DATABASE"], "tables": tables}
