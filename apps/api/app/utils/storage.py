"""Safe local storage for uploaded and processed datasets under DATA_DIR.

Directory names are built only from integer ids (never from user input) using the
Hive partition convention, so stage 7 can copy them to HDFS unchanged:

    <DATA_DIR>/raw/farm_id=<farm>/upload_id=<upload>/original.csv (+ rejected_rows.csv)
    <DATA_DIR>/raw/unassigned/upload_id=<upload>/...        (farm could not be resolved)
    <DATA_DIR>/processed/farm_id=<farm>/upload_id=<upload>/records.csv (+ manifest.json)

Paths are stored relative to DATA_DIR and re-checked on every use.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from flask import current_app

RAW_FILE = "original.csv"
REJECTED_FILE = "rejected_rows.csv"
PROCESSED_FILE = "records.csv"
MANIFEST_FILE = "manifest.json"


class StorageError(RuntimeError):
    pass


def data_root() -> Path:
    return Path(current_app.config["DATA_DIR"]).resolve()


def raw_dir(upload_id: int, farm_id: int | None) -> str:
    farm = f"farm_id={int(farm_id)}" if farm_id is not None else "unassigned"
    return f"raw/{farm}/upload_id={int(upload_id)}"


def processed_dir(upload_id: int, farm_id: int) -> str:
    return f"processed/farm_id={int(farm_id)}/upload_id={int(upload_id)}"


def resolve(relative: str) -> Path:
    """Absolute path for a stored relative path; refuses anything outside DATA_DIR."""
    root = data_root()
    path = (root / relative).resolve()
    if path == root or not path.is_relative_to(root):
        raise StorageError("Refusing a path outside the data directory.")
    return path


def write_bytes(relative: str, data: bytes) -> None:
    """Writes atomically (temp file in the same folder, then rename)."""
    path = resolve(relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def move_dir(source: str, target: str) -> None:
    src, dst = resolve(source), resolve(target)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        raise StorageError(f"Target folder already exists: {target}")
    os.replace(src, dst)


def remove_dir(relative: str | None) -> None:
    if not relative:
        return
    path = resolve(relative)
    if path.is_dir():
        shutil.rmtree(path)
    # Tidy up an empty farm folder left behind.
    parent = path.parent
    if parent != data_root() and parent.is_dir() and not any(parent.iterdir()):
        parent.rmdir()
