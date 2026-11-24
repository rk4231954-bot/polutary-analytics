"""Upload → validate → preprocess → real HDFS → real Hive partition. HDFS is checked with the
`hdfs` command-line client and Hive with a direct HiveQL query (independent of the API code).

Run with:  uv run pytest -m integration
Needs HDFS + HiveServer2 running and `hdfs` on PATH (or HADOOP_HOME set). Writes only under
/polutary-test and to the Hive table poultry_uploads_test (both removed afterwards); the real
/polutary/processed and poultry_uploads are not touched.
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

from app.services import hive_client

pytestmark = pytest.mark.integration

TEST_ROOT = "/polutary-test"
TEST_TABLE = "poultry_uploads_test"
HIVE_KEYS = (
    "HIVE_HOST",
    "HIVE_PORT",
    "HIVE_USERNAME",
    "HIVE_PASSWORD",
    "HIVE_DATABASE",
    "HIVE_AUTH",
)


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
    for key in ("WEBHDFS_URL", "HDFS_USER", "HDFS_DATANODE_HOST", *HIVE_KEYS):
        if values.get(key):
            app.config[key] = int(values[key]) if key == "HIVE_PORT" else values[key]
    app.config["HIVE_AUTH"] = app.config["HIVE_AUTH"].upper()
    if not values.get("HDFS_USER") and values.get("HIVE_USERNAME"):
        app.config["HDFS_USER"] = values["HIVE_USERNAME"]
    app.config.update(
        HDFS_ENABLED=True,
        HDFS_PROCESSED_DIR=f"{TEST_ROOT}/processed",
        HIVE_UPLOADS_TABLE=TEST_TABLE,
    )
    yield
    with app.app_context():  # external table: DROP removes metadata only
        hive_client.run_statement(f"DROP TABLE IF EXISTS {TEST_TABLE}", name="test_cleanup")
    hdfs("-rm", "-r", "-f", "-skipTrash", TEST_ROOT)


def hive(app, sql):
    with app.app_context():
        return hive_client.run_query(sql, name="test_reference")


def test_upload_lands_in_real_hdfs_and_hive_and_delete_removes_it(
    app, real_hdfs, make_farm, as_role
):
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
    body = local.read_bytes().split(b"\n", 1)[1]  # HDFS copy: same rows, no header row
    assert hashlib.sha256(in_hdfs.stdout).digest() == hashlib.sha256(body).digest()
    assert hdfs("-test", "-e", path.replace("records.csv", "_manifest.json")).returncode == 0

    # Hive reads the partition in place: same rows and totals as the processed file.
    assert dataset["stages"]["hive"] is True, dataset["history"][-1]
    assert dataset["hiveTable"].endswith(f".{TEST_TABLE}")
    sql = (
        "SELECT COUNT(*) AS n, SUM(mortality) AS deaths, MIN(`date`) AS first_day "
        "FROM poultry_uploads_test WHERE farm_id = %(farm)s AND upload_id = %(upload)s"
    )
    with app.app_context():
        (row,) = hive_client.run_query(sql, {"farm": farm_id, "upload": did}, name="test_ref")
    lines = local.read_text().splitlines()[1:]
    header = local.read_text().splitlines()[0].split(",")
    deaths = sum(int(r.split(",")[header.index("mortality")]) for r in lines)
    assert (row["n"], row["deaths"]) == (len(lines), deaths)
    assert str(row["first_day"]) == min(r.split(",")[0] for r in lines)

    assert manager.delete(f"/api/datasets/{did}").status_code == 204
    assert hdfs("-test", "-e", path).returncode != 0
    partitions = hive(app, f"SHOW PARTITIONS {TEST_TABLE}")
    assert not any(f"upload_id={did}" in str(p) for p in partitions)
