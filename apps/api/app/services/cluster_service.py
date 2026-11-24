"""Read-only Hadoop HDFS / Apache Hive metadata for the Big Data page.

HDFS figures come from the NameNode's JMX endpoint and WebHDFS (GETFILESTATUS); Hive table
details come from `SHOW TABLES` and `DESCRIBE FORMATTED` on HiveServer2. Nothing here runs a
MapReduce job or writes anything, and nothing is estimated: a value Hive or HDFS doesn't
report is returned as null.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlsplit
from urllib.request import urlopen

from flask import current_app

from app.config import HIVE_IDENTIFIER_RE
from app.services import hive_client

log = logging.getLogger(__name__)

HTTP_TIMEOUT_SECONDS = 5
_FS_STATE_BEAN = "Hadoop:service=NameNode,name=FSNamesystemState"


def _http_json(path: str) -> dict[str, Any]:
    base = current_app.config["WEBHDFS_URL"].rstrip("/")
    with urlopen(f"{base}{path}", timeout=HTTP_TIMEOUT_SECONDS) as response:  # noqa: S310
        return json.loads(response.read().decode("utf-8"))


def _iso_from_ms(ms: Any) -> str | None:
    if not isinstance(ms, int | float) or ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat()


def hdfs_status() -> dict[str, Any]:
    url = current_app.config["WEBHDFS_URL"]
    try:
        beans = _http_json(f"/jmx?qry={_FS_STATE_BEAN}").get("beans") or []
    except (URLError, OSError, ValueError) as exc:
        log.warning("NameNode at %s unreachable: %s", url, exc)
        return {"connected": False, "namenodeUrl": url}
    bean = beans[0] if beans else {}
    return {
        "connected": bool(bean) and bean.get("FSState") == "Operational",
        "namenodeUrl": url,
        "state": bean.get("FSState"),
        "capacityBytes": bean.get("CapacityTotal"),
        "usedBytes": bean.get("CapacityUsed"),
        "remainingBytes": bean.get("CapacityRemaining"),
        "liveDataNodes": bean.get("NumLiveDataNodes"),
        "filesTotal": bean.get("FilesTotal"),
        "blocksTotal": bean.get("BlocksTotal"),
    }


def _hdfs_modified(location: str | None) -> str | None:
    """Last modification time of a table's HDFS directory (WebHDFS GETFILESTATUS)."""
    if not location:
        return None
    path = urlsplit(location).path
    if not path.startswith("/"):
        return None
    try:
        body = _http_json(f"/webhdfs/v1{quote(path)}?op=GETFILESTATUS")
    except (URLError, OSError, ValueError) as exc:
        log.warning("WebHDFS GETFILESTATUS %s failed: %s", path, exc)
        return None
    return _iso_from_ms((body.get("FileStatus") or {}).get("modificationTime"))


def _int_or_none(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _describe(table: str) -> dict[str, Any]:
    # The name comes from SHOW TABLES and is checked against the identifier allow-list
    # before it is quoted into the statement (identifiers can't be bound as parameters).
    rows = hive_client.run_query(f"DESCRIBE FORMATTED `{table}`", name="describe_table")
    info: dict[str, Any] = {"partitioned": False}
    params: dict[str, str] = {}
    for row in rows:
        key = (row.get("col_name") or "").strip()
        value = (row.get("data_type") or "").strip()
        if key == "# Partition Information":
            info["partitioned"] = True
        elif key in {"Location:", "Table Type:"}:
            info[key.rstrip(":")] = value
        elif not key and value:  # table parameters: ('', name, value)
            params[value] = (row.get("comment") or "").strip()
    location = info.get("Location")
    return {
        "name": table,
        "type": info.get("Table Type"),
        "location": location,
        "partitioned": info["partitioned"],
        # numRows is Hive's stored statistic. Tables without statistics report null rather
        # than a guess (counting them would start a MapReduce job).
        "rowCount": _int_or_none(params.get("numRows")),
        "numFiles": _int_or_none(params.get("numFiles")),
        "totalSizeBytes": _int_or_none(params.get("totalSize")),
        "updatedAt": _hdfs_modified(location),
    }


def hive_tables() -> list[dict[str, Any]]:
    names = [row["tab_name"] for row in hive_client.run_query("SHOW TABLES", name="show_tables")]
    tables = []
    for name in names:
        if not HIVE_IDENTIFIER_RE.match(name):
            log.warning("Skipping Hive table with an unexpected name: %r", name)
            continue
        tables.append(_describe(name))
    return tables


def cluster_status() -> dict[str, Any]:
    cfg = current_app.config
    hive: dict[str, Any] = {
        "connected": False,
        "host": cfg["HIVE_HOST"],
        "port": cfg["HIVE_PORT"],
        "database": cfg["HIVE_DATABASE"],
        "version": None,
    }
    tables: list[dict[str, Any]] = []
    try:
        tables = hive_tables()
        hive["connected"] = True
    except (hive_client.HiveUnavailableError, hive_client.HiveAuthError) as exc:
        hive["error"] = exc.code
    stamps = [t["updatedAt"] for t in tables if t["updatedAt"]]
    return {
        "hdfs": hdfs_status(),
        "hive": hive,
        # Latest change to any Hive table's HDFS data directory.
        "latestIngestionAt": max(stamps) if stamps else None,
    }
