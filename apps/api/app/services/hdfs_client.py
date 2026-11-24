"""Minimal WebHDFS client (standard library only) for storing processed datasets in HDFS.

Writes use the two-step WebHDFS protocol: the NameNode answers CREATE/OPEN with the
DataNode address (`noredirect=true` returns it as JSON), and the data goes to that DataNode.
Every write is read back and compared by SHA-256, so a dataset is only marked as stored in
HDFS when HDFS really holds an identical copy.

Paths are built by the caller from integer ids only; `_check_path` refuses anything outside
HDFS_PROCESSED_DIR or with unexpected characters.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen

from flask import current_app

log = logging.getLogger(__name__)

TIMEOUT_SECONDS = 30
_SAFE_PATH_RE = re.compile(r"^/[A-Za-z0-9_./=-]+$")


class HdfsError(RuntimeError):
    """HDFS could not be reached or refused the operation (message is safe to show)."""


def processed_root() -> str:
    return current_app.config["HDFS_PROCESSED_DIR"].rstrip("/")


def _check_path(path: str) -> str:
    root = processed_root()
    if not _SAFE_PATH_RE.match(path) or ".." in path or not path.startswith(root + "/"):
        raise HdfsError("Refusing an HDFS path outside the processed-data directory.")
    return path


def _url(path: str, op: str, **params: Any) -> str:
    base = current_app.config["WEBHDFS_URL"].rstrip("/")
    query = {"op": op, "user.name": current_app.config["HDFS_USER"], **params}
    return f"{base}/webhdfs/v1{quote(path)}?{urlencode(query)}"


def _call(method: str, url: str, data: bytes | None = None) -> bytes:
    headers = {"Content-Type": "application/octet-stream"} if data is not None else {}
    request = Request(url, data=data, method=method, headers=headers)  # noqa: S310
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:  # noqa: S310
            return response.read()
    except HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        log.error("WebHDFS %s %s failed: %s %s", method, urlsplit(url).path, exc.code, detail)
        raise HdfsError(f"HDFS refused the request (HTTP {exc.code}).") from exc
    except (URLError, OSError) as exc:
        log.warning("WebHDFS unreachable at %s: %s", current_app.config["WEBHDFS_URL"], exc)
        raise HdfsError("HDFS (WebHDFS) is not reachable.") from exc


def _datanode_location(method: str, url: str) -> str:
    body = json.loads(_call(method, url) or b"{}")
    location = urlsplit(body.get("Location", ""))
    if location.scheme not in {"http", "https"} or not location.port:
        raise HdfsError("WebHDFS did not return a DataNode address.")
    # The NameNode names the DataNode by its registered hostname. On a single-node install
    # bound to 127.0.0.1 that hostname may resolve to another interface, so it can be
    # replaced with HDFS_DATANODE_HOST (the port is kept).
    host = current_app.config["HDFS_DATANODE_HOST"]
    if host:
        location = location._replace(netloc=f"{host}:{location.port}")
    return location.geturl()


def mkdirs(path: str) -> None:
    _call("PUT", _url(_check_path(path), "MKDIRS", permission="755"))


def write_file(path: str, data: bytes) -> None:
    location = _datanode_location(
        "PUT",
        _url(_check_path(path), "CREATE", overwrite="true", permission="644", noredirect="true"),
    )
    _call("PUT", location, data)


def read_file(path: str) -> bytes:
    location = _datanode_location("GET", _url(_check_path(path), "OPEN", noredirect="true"))
    return _call("GET", location)


def delete_dir(path: str) -> None:
    _call("DELETE", _url(_check_path(path), "DELETE", recursive="true"))


def store_verified(path: str, data: bytes) -> str:
    """Writes `data` to `path` and reads it back; returns the SHA-256 HDFS holds."""
    write_file(path, data)
    expected = hashlib.sha256(data).hexdigest()
    actual = hashlib.sha256(read_file(path)).hexdigest()
    if actual != expected:
        raise HdfsError("The copy in HDFS does not match the processed file.")
    return actual
