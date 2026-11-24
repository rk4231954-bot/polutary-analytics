"""Flock performance upload against the real HDFS and HiveServer2. Every figure the API
returns is compared with an independent calculation in Python over the same CSV.

Run with:  uv run pytest -m integration
Writes only under /polutary-test and to the Hive table flock_performance_test (both removed
afterwards). The real /polutary/processed and flock_performance are not touched.
"""

from __future__ import annotations

import csv
import io
import os
import statistics
from pathlib import Path

import pytest
from dotenv import dotenv_values
from test_flock_performance import send
from test_hdfs_integration import HIVE_KEYS, hdfs

from app.services import hive_client

pytestmark = pytest.mark.integration

TEST_ROOT = "/polutary-test"
TEST_TABLE = "flock_performance_test"
CSV_TEXT = (
    "Umur,BW,%Panen,Deplesi,IP\n"
    "28.57,1.05,19.19,3.47,282.00\n"
    "27.15,1.06,21.56,4.11,318.00\n"
    "28.39,1.34,25.36,5.94,427.00\n"
    "27.05,1.28,26.78,4.40,407.00\n"
    "26.03,0.95,28.42,9.92,271.00\n"
    "27.65,1.40,29.90,2.10,363.00\n"
)


@pytest.fixture
def real_cluster(app):
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
        HIVE_FLOCK_TABLE=TEST_TABLE,
    )
    yield
    with app.app_context():  # external table: DROP removes metadata only
        hive_client.run_statement(f"DROP TABLE IF EXISTS {TEST_TABLE}", name="test_cleanup")
    hdfs("-rm", "-r", "-f", "-skipTrash", TEST_ROOT)


def test_upload_to_hdfs_and_hive_then_hiveql_summary(app, real_cluster, as_role):
    admin = as_role("admin")
    response = send(admin, CSV_TEXT)
    assert response.status_code == 201, response.get_json()
    body = response.get_json()
    path = f"{TEST_ROOT}/processed/flock_performance/records.csv"
    assert body["hdfs"]["path"] == path
    stored = hdfs("-cat", path)
    assert stored.returncode == 0, stored.stderr
    assert stored.stdout.decode().splitlines()[0] == "28.57,1.05,19.19,3.47,282.00,2"
    assert body["hive"]["rowCount"] == 6

    rows = list(csv.DictReader(io.StringIO(CSV_TEXT)))
    bw = [float(r["BW"]) for r in rows]
    dep = [float(r["Deplesi"]) for r in rows]
    ip = [float(r["IP"]) for r in rows]

    summary = admin.get("/api/flock-performance/summary").get_json()
    assert summary["loaded"] is True
    assert summary["flocks"] == 6
    assert summary["bodyWeightKg"]["avg"] == pytest.approx(statistics.mean(bw), abs=5e-4)
    assert summary["depletionPct"]["max"] == pytest.approx(max(dep))
    assert summary["performanceIndex"]["avg"] == pytest.approx(statistics.mean(ip), abs=0.05)
    assert summary["correlations"]["bodyWeightVsIndex"] == pytest.approx(
        statistics.correlation(bw, ip), abs=5e-4
    )
    bands = {b["band"]: b["flocks"] for b in summary["depletionBands"]}
    assert bands == {"Below 3%": 1, "3% to 5%": 3, "5% to 8%": 1, "8% and above": 1}

    # Uploading again replaces the file; Hive reads only the new rows.
    assert send(admin, CSV_TEXT.rsplit("\n", 2)[0] + "\n").get_json()["hive"]["rowCount"] == 5
