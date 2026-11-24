"""Unit tests for GET /api/bigdata/status and GET /api/hive/tables. Hive and the NameNode
HTTP endpoints are replaced by recording stand-ins here; test_analytics_integration.py
calls both endpoints against the real cluster."""

from __future__ import annotations

from urllib.error import URLError

import pytest

from app.services import cluster_service, hive_client

DESCRIBE_CLEANED = [
    {"col_name": "record_id", "data_type": "int", "comment": None},
    {"col_name": "# Detailed Table Information", "data_type": None, "comment": None},
    {
        "col_name": "Location:           ",
        "data_type": "hdfs://localhost:9000/user/hive/warehouse/db/poultry_records_cleaned",
        "comment": None,
    },
    {"col_name": "Table Type:         ", "data_type": "EXTERNAL_TABLE      ", "comment": None},
    {"col_name": "", "data_type": "numFiles            ", "comment": "1                   "},
    {"col_name": "", "data_type": "numRows             ", "comment": "20                  "},
    {"col_name": "", "data_type": "totalSize           ", "comment": "3304                "},
]
DESCRIBE_STAGING = [  # an external text table: Hive has no numRows statistic for it
    {"col_name": "Location:", "data_type": "hdfs://localhost:9000/poultry-analytics/raw"},
    {"col_name": "Table Type:", "data_type": "EXTERNAL_TABLE"},
    {"col_name": "# Partition Information", "data_type": None},
    {"col_name": "", "data_type": "totalSize", "comment": "1102"},
]
JMX = {
    "beans": [
        {
            "FSState": "Operational",
            "CapacityTotal": 1000,
            "CapacityUsed": 10,
            "CapacityRemaining": 900,
            "NumLiveDataNodes": 1,
            "FilesTotal": 22,
            "BlocksTotal": 3,
        }
    ]
}


@pytest.fixture
def fake_cluster(monkeypatch):
    statements: list[str] = []
    http_paths: list[str] = []
    state = {"tables": ["poultry_records_cleaned", "poultry_records_staging"], "http_down": False}

    def run_query(sql, params=None, *, name="query"):
        statements.append(sql)
        if sql == "SHOW TABLES":
            return [{"tab_name": t} for t in state["tables"]]
        return DESCRIBE_CLEANED if "cleaned" in sql else DESCRIBE_STAGING

    def http_json(path):
        http_paths.append(path)
        if state["http_down"]:
            raise URLError("connection refused")
        if path.startswith("/jmx"):
            return JMX
        modified = 1795027986953 if "cleaned" in path else 1795026549194
        return {"FileStatus": {"modificationTime": modified}}

    monkeypatch.setattr(hive_client, "run_query", run_query)
    monkeypatch.setattr(cluster_service, "_http_json", http_json)
    return statements, http_paths, state


def test_cluster_endpoints_are_admin_only(client, as_role, fake_cluster):
    for path in ("/api/bigdata/status", "/api/hive/tables"):
        assert client.get(path).status_code == 401
        for role in ("farm_manager", "analyst", "veterinarian"):
            assert as_role(role).get(path).status_code == 403


def test_tables_come_from_describe_formatted(as_role, fake_cluster):
    statements, http_paths, _ = fake_cluster
    tables = as_role("admin").get("/api/hive/tables").get_json()["tables"]
    cleaned, staging = tables
    assert cleaned == {
        "name": "poultry_records_cleaned",
        "type": "EXTERNAL_TABLE",
        "location": "hdfs://localhost:9000/user/hive/warehouse/db/poultry_records_cleaned",
        "partitioned": False,
        "rowCount": 20,
        "numFiles": 1,
        "totalSizeBytes": 3304,
        "updatedAt": "2026-11-18T18:53:06.953000+00:00",
    }
    assert staging["rowCount"] is None  # no statistic: not guessed, not counted
    assert staging["partitioned"] is True
    assert statements == [
        "SHOW TABLES",
        "DESCRIBE FORMATTED `poultry_records_cleaned`",
        "DESCRIBE FORMATTED `poultry_records_staging`",
    ]
    assert "/webhdfs/v1/poultry-analytics/raw?op=GETFILESTATUS" in http_paths


def test_unexpected_table_names_are_not_put_into_hiveql(as_role, fake_cluster):
    statements, _, state = fake_cluster
    state["tables"] = ["poultry_records_cleaned", "x`; DROP TABLE y; --"]
    tables = as_role("admin").get("/api/hive/tables").get_json()["tables"]
    assert [t["name"] for t in tables] == ["poultry_records_cleaned"]
    assert not any("DROP" in s for s in statements)


def test_status_reports_hdfs_and_hive(as_role, fake_cluster):
    body = as_role("admin").get("/api/bigdata/status").get_json()
    assert body["hdfs"] == {
        "connected": True,
        "namenodeUrl": "http://127.0.0.1:9870",
        "state": "Operational",
        "capacityBytes": 1000,
        "usedBytes": 10,
        "remainingBytes": 900,
        "liveDataNodes": 1,
        "filesTotal": 22,
        "blocksTotal": 3,
    }
    assert body["hive"]["connected"] is True
    assert body["hive"]["database"] == "poultry_analytics"
    assert body["latestIngestionAt"] == "2026-11-18T18:53:06.953000+00:00"


def test_status_when_namenode_and_hive_are_down(as_role, fake_cluster, monkeypatch):
    _, _, state = fake_cluster
    state["http_down"] = True

    def refuse(*_args, **_kwargs):
        raise hive_client.HiveUnavailableError()

    monkeypatch.setattr(hive_client, "run_query", refuse)
    body = as_role("admin").get("/api/bigdata/status").get_json()
    assert body["hdfs"] == {"connected": False, "namenodeUrl": "http://127.0.0.1:9870"}
    assert body["hive"]["connected"] is False
    assert body["hive"]["error"] == "HIVE_UNAVAILABLE"
    assert body["latestIngestionAt"] is None


def test_free_form_hiveql_is_not_offered(as_role):
    assert as_role("admin").post("/api/hive/query", json={"sql": "SHOW TABLES"}).status_code in {
        404,
        405,
    }
