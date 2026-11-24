"""Flock performance reference data (Kaggle "Broiler Performance Index"). WebHDFS and
HiveServer2 are replaced by in-memory stand-ins here;
test_flock_performance_integration.py uses the real cluster."""

from __future__ import annotations

import io

import pytest

from app.services import flock_performance, hdfs_client, hive_client

GOOD = "Umur,BW,%Panen,Deplesi,IP\n28.57,1.05,19.19,3.47,282.00\n27.15,1.06,21.56,4.11,318.00\n"


def send(client, content, *, filename="PS Performance.csv", mime="text/csv"):
    data = content.encode() if isinstance(content, str) else content
    return client.post(
        "/api/flock-performance",
        data={"file": (io.BytesIO(data), filename, mime)},
        content_type="multipart/form-data",
    )


@pytest.fixture
def cluster(app, monkeypatch):
    app.config["HDFS_ENABLED"] = True
    files: dict[str, bytes] = {}
    hive = {"statements": [], "table": False, "count": None}

    def write_file(path, data):
        hdfs_client._check_path(path)  # the real path guard still applies
        files[path] = data

    def run_statement(sql, params=None, *, name="ddl"):
        hive["statements"].append(name)
        hive["table"] = True

    def run_query(sql, params=None, *, name="query"):
        hive["statements"].append(name)
        if name == "flock_table_exists":
            return [{"tab_name": "flock_performance"}] if hive["table"] else []
        rows = [
            line for p, d in files.items() if p.endswith("records.csv") for line in d.splitlines()
        ]
        if name == "count_flock_rows":
            return [{"row_count": len(rows) if hive["count"] is None else hive["count"]}]
        raise AssertionError(name)

    monkeypatch.setattr(hdfs_client, "mkdirs", hdfs_client._check_path)
    monkeypatch.setattr(hdfs_client, "write_file", write_file)
    monkeypatch.setattr(hdfs_client, "read_file", lambda path: files[path])
    monkeypatch.setattr(hive_client, "run_statement", run_statement)
    monkeypatch.setattr(hive_client, "run_query", run_query)
    return files, hive


def test_parse_keeps_values_as_given_and_reports_problems():
    text = GOOD + "x,1,1,1,1\n27,-1,30,3,300\n27,1.2,30\n\n28.57,1.05,19.19,3.47,282.00\n"
    parsed = flock_performance.parse(text.encode())
    assert parsed["body"].decode().splitlines() == [
        "28.57,1.05,19.19,3.47,282.00,2",
        "27.15,1.06,21.56,4.11,318.00,3",
        "28.57,1.05,19.19,3.47,282.00,8",  # exact duplicate: kept and counted
    ]
    report = parsed["report"]
    assert (report["totalRows"], report["acceptedRows"], report["rejectedRows"]) == (6, 3, 3)
    assert report["exactDuplicateRows"] == 1
    assert [e["line"] for e in report["errors"]] == [4, 5, 6]


def test_parse_requires_the_published_columns():
    with pytest.raises(Exception, match="Expected the columns"):
        flock_performance.parse(b"date,farm,mortality\n2026-01-01,F1,2\n")


def test_admin_upload_is_stored_in_hdfs_and_checked_in_hive(app, as_role, cluster):
    files, hive = cluster
    response = send(as_role("admin"), GOOD)
    assert response.status_code == 201, response.get_json()
    body = response.get_json()
    path = f"{app.config['HDFS_PROCESSED_DIR']}/flock_performance/records.csv"
    assert body["hdfs"]["path"] == path
    assert files[path].decode().splitlines()[0] == "28.57,1.05,19.19,3.47,282.00,2"  # no header
    assert path.replace("records.csv", "_manifest.json") in files
    assert body["hive"]["rowCount"] == 2
    assert hive["statements"] == ["create_flock_table", "count_flock_rows"]
    assert body["source"]["url"].startswith("https://www.kaggle.com/datasets/isazulka/")


def test_hive_count_mismatch_is_an_error(as_role, cluster):
    _, hive = cluster
    hive["count"] = 1
    response = send(as_role("admin"), GOOD)
    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "HIVE_COUNT_MISMATCH"


def test_only_admins_can_upload(client, as_role, cluster):
    assert send(client, GOOD).status_code == 401
    for role in ("farm_manager", "analyst", "veterinarian"):
        assert send(as_role(role), GOOD).status_code == 403


def test_rejects_non_csv_and_wrong_columns(as_role, cluster):
    admin = as_role("admin")
    assert send(admin, GOOD, filename="data.xlsx").status_code == 415
    bad = send(admin, "a,b\n1,2\n")
    assert bad.status_code == 400
    assert bad.get_json()["error"]["code"] == "VALIDATION_ERROR"


def test_summary_before_upload_says_not_loaded(as_role, cluster):
    body = as_role("analyst").get("/api/flock-performance/summary").get_json()
    assert body["loaded"] is False
    assert body["dataset"]["license"] == "Apache 2.0"


def test_summary_requires_analytics_permission(client, as_role, cluster):
    assert client.get("/api/flock-performance/summary").status_code == 401
    assert as_role("veterinarian").get("/api/flock-performance/summary").status_code == 403
