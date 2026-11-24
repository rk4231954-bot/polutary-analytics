"""Upload → validate → preprocess → real HDFS, checked with the `hdfs` command-line client
(independent of the API's WebHDFS code).

Run with:  uv run pytest -m integration
Needs HDFS running and `hdfs` on PATH (or HADOOP_HOME set). Writes only under
/polutary-test (removed afterwards); the real /polutary/processed is not touched.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from conftest import batch_payload
from dotenv import dotenv_values
from test_datasets import GOOD_CSV, data_dir, upload

pytestmark = pytest.mark.integration

TEST_ROOT = "/polutary-test"


def hdfs_cli() -> str:
    found = shutil.which("hdfs")
    home = os.environ.get("HADOOP_HOME") or str(Path.home() / "hadoop")
    if not found and Path(home, "bin/hdfs").is_file():
        found = str(Path(home, "bin/hdfs"))
    if not found:
        pytest.skip("the hdfs command-line client is not available")
    return found


def hdfs(*args: str) -> subprocess.CompletedProcess:
    # Fixed program and arguments from this test only (no user input).
    return subprocess.run(  # noqa: S603
        [hdfs_cli(), "dfs", *args], capture_output=True, timeout=120
    )


@pytest.fixture
def real_hdfs(app):
    values = {**dotenv_values(Path(__file__).parent.parent / ".env"), **os.environ}
    for key in ("WEBHDFS_URL", "HDFS_USER", "HDFS_DATANODE_HOST", "HIVE_USERNAME"):
        if values.get(key):
            app.config[key] = values[key]
    if not values.get("HDFS_USER") and values.get("HIVE_USERNAME"):
        app.config["HDFS_USER"] = values["HIVE_USERNAME"]
    app.config.update(HDFS_ENABLED=True, HDFS_PROCESSED_DIR=f"{TEST_ROOT}/processed")
    yield
    hdfs("-rm", "-r", "-f", "-skipTrash", TEST_ROOT)


def test_upload_lands_in_real_hdfs_and_delete_removes_it(app, real_hdfs, make_farm, as_role):
    farm_id = make_farm()
    manager = as_role("farm_manager", farms=[farm_id])
    manager.post("/api/batches", json=batch_payload(farm_id))

    dataset = upload(manager, GOOD_CSV).get_json()["dataset"]
    assert dataset["stages"]["hdfs"] is True, dataset["history"][-1]
    did = dataset["id"]
    path = f"{TEST_ROOT}/processed/farm_id={farm_id}/upload_id={did}/records.csv"
    assert dataset["hdfsPath"] == path

    local = data_dir(app) / f"processed/farm_id={farm_id}/upload_id={did}/records.csv"
    in_hdfs = hdfs("-cat", path)
    assert in_hdfs.returncode == 0, in_hdfs.stderr
    assert hashlib.sha256(in_hdfs.stdout).digest() == hashlib.sha256(local.read_bytes()).digest()
    assert hdfs("-test", "-e", path.replace("records.csv", "manifest.json")).returncode == 0

    assert manager.delete(f"/api/datasets/{did}").status_code == 204
    assert hdfs("-test", "-e", path).returncode != 0
