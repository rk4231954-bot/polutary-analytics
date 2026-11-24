"""CSV dataset ingestion API: upload, validation report, storage, preview, access, delete."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from conftest import audit_rows, batch_payload

from app.extensions import db
from app.models import DatasetUpload
from app.utils import storage

GOOD_CSV = (
    "date,farm_code,batch_code,temperature_c,humidity_pct,feed_kg,mortality,bird_count\n"
    "2026-10-01,F-001,B-001,31.2,65,120.5,3,1197\n"
    "2026-10-02,F-001,B-001,30.8,,124,2,1195\n"
    "2026-10-03,F-001,B-001,abc,63,126,1,1194\n"
)


def upload(client, content=GOOD_CSV, *, filename="readings.csv", mime="text/csv", **form):
    data = content.encode() if isinstance(content, str) else content
    fields = {"file": (io.BytesIO(data), filename, mime)}
    fields.update({k: v for k, v in form.items() if v is not None})
    return client.post("/api/datasets", data=fields, content_type="multipart/form-data")


@pytest.fixture
def farm_setup(make_farm, as_role):
    farm_id = make_farm()
    manager = as_role("farm_manager", farms=[farm_id])
    manager.post("/api/batches", json=batch_payload(farm_id))
    return farm_id, manager


def data_dir(app) -> Path:
    return Path(app.config["DATA_DIR"])


# --- Successful upload -------------------------------------------------------------
def test_upload_validates_preprocesses_and_stores(app, farm_setup):
    farm_id, manager = farm_setup
    response = upload(manager)
    assert response.status_code == 201
    dataset = response.get_json()["dataset"]
    assert dataset["status"] == "processed"
    assert dataset["farmId"] == farm_id
    assert dataset["stages"] == {
        "uploaded": True,
        "validated": True,
        "preprocessed": True,
        "hdfs": False,  # HDFS is off in unit tests (test_datasets_hdfs.py covers it)
        "hive": False,
    }
    assert (dataset["totalRows"], dataset["rowCount"], dataset["rejectedRows"]) == (3, 2, 1)
    assert dataset["hdfsPath"] is None and dataset["hiveTable"] is None
    assert [h["stage"] for h in dataset["history"]] == [
        "upload",
        "validation",
        "preprocessing",
        "local_storage",
        "hdfs",
    ]
    assert dataset["history"][-1]["status"] == "warning"  # HDFS_ENABLED=false, not hidden
    report = dataset["report"]
    assert report["summary"]["acceptedRows"] == 2
    assert any(e["code"] == "not_a_number:temperature_c" for e in report["errors"])

    # Files are organised by farm and upload, outside the web app.
    did = dataset["id"]
    raw = data_dir(app) / f"raw/farm_id={farm_id}/upload_id={did}"
    processed = data_dir(app) / f"processed/farm_id={farm_id}/upload_id={did}"
    assert (raw / "original.csv").read_text() == GOOD_CSV
    assert (raw / "rejected_rows.csv").read_text().startswith("source_line,errors,raw_record\n4,")
    lines = (processed / "records.csv").read_text().splitlines()
    assert lines[0] == (
        "date,farm_code,batch_code,temperature_c,humidity_pct,feed_kg,water_l,"
        "mortality,avg_weight_g,bird_count,source_line"
    )
    assert lines[2] == "2026-10-02,F-001,B-001,30.8,,124.0,,2,,1195,3"  # missing stays empty
    manifest = json.loads((processed / "manifest.json").read_text())
    assert manifest["rowCount"] == 2 and manifest["hdfs"]["stored"] is False
    assert {"name": "date", "type": "DATE"} in manifest["columns"]

    assert ("dataset.upload", "success", "farm_manager1@example.org") == audit_rows(
        app, "dataset.upload"
    )[0][:3]


def test_preview_pages_through_processed_and_rejected_rows(farm_setup):
    _, manager = farm_setup
    did = upload(manager).get_json()["dataset"]["id"]
    first = manager.get(f"/api/datasets/{did}/preview?limit=1").get_json()["preview"]
    assert first["total"] == 2 and len(first["rows"]) == 1
    assert first["rows"][0][:3] == ["2026-10-01", "F-001", "B-001"]
    second = manager.get(f"/api/datasets/{did}/preview?limit=1&offset=1").get_json()["preview"]
    assert second["rows"][0][4] is None  # missing humidity is returned as null
    rejected = manager.get(f"/api/datasets/{did}/preview?kind=rejected").get_json()["preview"]
    assert rejected["columns"] == ["source_line", "errors", "raw_record"]
    assert rejected["rows"][0][0] == "4"
    assert manager.get(f"/api/datasets/{did}/preview?kind=raw").status_code == 400


def test_list_and_detail(farm_setup):
    _, manager = farm_setup
    did = upload(manager).get_json()["dataset"]["id"]
    listed = manager.get("/api/datasets").get_json()["datasets"]
    assert [d["id"] for d in listed] == [did]
    assert "report" not in listed[0]  # the list stays light
    detail = manager.get(f"/api/datasets/{did}").get_json()["dataset"]
    assert detail["report"]["summary"]["farmCode"] == "F-001"


def test_selected_farm_rejects_rows_for_other_farms(make_farm, as_role):
    farm_a = make_farm("F-001", "Farm A")
    make_farm("F-002", "Farm B")
    manager = as_role("farm_manager", farms=[farm_a])
    text = "date,farm_code,batch_code\n2026-10-01,F-001,B-001\n2026-10-01,F-002,B-001\n"
    dataset = upload(manager, text, farmId=str(farm_a)).get_json()["dataset"]
    assert dataset["status"] == "processed"
    assert dataset["rowCount"] == 1 and dataset["rejectedRows"] == 1
    codes = {e["code"] for e in dataset["report"]["errors"]}
    assert "farm_mismatch:farm_code" in codes


def test_same_file_twice_is_flagged(farm_setup):
    _, manager = farm_setup
    first = upload(manager).get_json()["dataset"]["id"]
    second = upload(manager).get_json()["dataset"]
    warning = next(w for w in second["report"]["warnings"] if w["code"] == "same_file_uploaded")
    assert f"#{first}" in warning["message"]


# --- Validation failures (recorded, with a report) --------------------------------
def test_schema_failure_is_recorded_with_a_report(app, farm_setup):
    _, manager = farm_setup
    response = upload(manager, "date,temperature_c\n2026-10-01,30\n")
    assert response.status_code == 201
    dataset = response.get_json()["dataset"]
    assert dataset["status"] == "failed"
    assert dataset["stages"]["validated"] is False
    assert "schema" in dataset["error"]
    assert {e["code"] for e in dataset["report"]["errors"]} >= {"required_column_missing"}
    # The farm could not be resolved: the original is kept under "unassigned".
    assert (data_dir(app) / f"raw/unassigned/upload_id={dataset['id']}/original.csv").is_file()
    assert not (data_dir(app) / "processed").exists()
    assert audit_rows(app, "dataset.upload")[-1][1] == "failure"


def test_unreadable_file_fails_cleanly(farm_setup):
    _, manager = farm_setup
    dataset = upload(manager, "date,farm\n2026,é\n".encode("latin-1")).get_json()["dataset"]
    assert dataset["status"] == "failed"
    assert "UTF-8" in dataset["error"]


# --- Request checks (refused, nothing stored) --------------------------------------
@pytest.mark.parametrize(
    ("kwargs", "status", "code"),
    [
        ({"filename": "readings.xlsx"}, 415, "INVALID_FILE_TYPE"),
        ({"filename": "readings.csv.exe"}, 415, "INVALID_FILE_TYPE"),
        ({"mime": "application/x-msdownload"}, 415, "INVALID_FILE_TYPE"),
        ({"content": "   \n"}, 400, "EMPTY_FILE"),
        ({"mapping": "{not json"}, 400, "VALIDATION_ERROR"),
        ({"mapping": '{"colour": "x"}'}, 400, "VALIDATION_ERROR"),
        ({"farmId": "abc"}, 400, "VALIDATION_ERROR"),
    ],
)
def test_bad_uploads_are_refused(app, farm_setup, kwargs, status, code):
    _, manager = farm_setup
    response = upload(manager, **kwargs)
    assert response.status_code == status, response.get_json()
    assert response.get_json()["error"]["code"] == code
    with app.app_context():
        assert db.session.query(DatasetUpload).count() == 0


def test_missing_file_is_refused_and_audited(app, farm_setup):
    _, manager = farm_setup
    response = manager.post("/api/datasets", data={}, content_type="multipart/form-data")
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "FILE_REQUIRED"
    assert audit_rows(app, "dataset.upload")[-1][:2] == ("dataset.upload", "failure")


def test_size_limit(app, farm_setup):
    _, manager = farm_setup
    app.config["MAX_UPLOAD_MB"] = 1
    big = GOOD_CSV + "2026-10-04,F-001,B-001,30,60,100,0,1000\n" * 30_000  # > 1 MB
    response = upload(manager, big)
    assert response.status_code == 413
    assert response.get_json()["error"]["code"] == "FILE_TOO_LARGE"


def test_filename_is_sanitised_and_never_used_in_paths(app, farm_setup):
    farm_id, manager = farm_setup
    dataset = upload(manager, filename="../../etc/evil name.csv").get_json()["dataset"]
    assert dataset["filename"] == "etc_evil_name.csv"
    assert (
        data_dir(app) / f"raw/farm_id={farm_id}/upload_id={dataset['id']}/original.csv"
    ).exists()


def test_inaccessible_farm_cannot_be_selected(make_farm, farm_setup):
    _, manager = farm_setup
    other = make_farm("F-009", "Other farm")
    response = upload(manager, farmId=str(other))
    assert response.status_code == 400
    assert "farmId" in response.get_json()["error"]["fields"]


def test_upload_requires_csrf_token(farm_setup):
    _, manager = farm_setup
    manager.csrf = None
    assert upload(manager).status_code == 403


# --- Access control -------------------------------------------------------------
def test_roles_and_farm_scoping(make_farm, as_role, farm_setup):
    farm_id, manager = farm_setup
    did = upload(manager).get_json()["dataset"]["id"]

    analyst = as_role("analyst", farms=[farm_id])
    assert upload(analyst).status_code == 403
    assert [d["id"] for d in analyst.get("/api/datasets").get_json()["datasets"]] == [did]
    assert analyst.get(f"/api/datasets/{did}/preview").status_code == 200
    assert analyst.delete(f"/api/datasets/{did}").status_code == 403

    vet = as_role("veterinarian", farms=[farm_id])
    assert vet.get("/api/datasets").status_code == 403

    outsider = as_role("farm_manager", farms=[make_farm("F-050", "Elsewhere")])
    assert outsider.get("/api/datasets").get_json()["datasets"] == []
    assert outsider.get(f"/api/datasets/{did}").status_code == 404
    assert outsider.delete(f"/api/datasets/{did}").status_code == 404


def test_unassigned_failed_upload_is_visible_only_to_its_uploader(make_farm, as_role, farm_setup):
    farm_id, manager = farm_setup
    did = upload(manager, "date,temperature_c\n2026-10-01,30\n").get_json()["dataset"]["id"]
    colleague = as_role("farm_manager", farms=[farm_id])
    assert colleague.get(f"/api/datasets/{did}").status_code == 404
    assert manager.get(f"/api/datasets/{did}").status_code == 200
    assert as_role("admin").get(f"/api/datasets/{did}").status_code == 200


# --- Delete ---------------------------------------------------------------------
def test_delete_removes_record_and_files(app, farm_setup):
    farm_id, manager = farm_setup
    did = upload(manager).get_json()["dataset"]["id"]
    assert manager.delete(f"/api/datasets/{did}").status_code == 204
    assert manager.get(f"/api/datasets/{did}").status_code == 404
    assert not (data_dir(app) / f"raw/farm_id={farm_id}/upload_id={did}").exists()
    assert not (data_dir(app) / f"processed/farm_id={farm_id}/upload_id={did}").exists()
    assert audit_rows(app, "dataset.delete")[0][1] == "success"


def test_farm_with_datasets_cannot_be_deleted(as_role, farm_setup):
    farm_id, manager = farm_setup
    did = upload(manager).get_json()["dataset"]["id"]
    admin = as_role("admin")
    manager.put(
        f"/api/batches/{manager.get('/api/batches').get_json()['batches'][0]['id']}",
        json=batch_payload(farm_id, status="completed"),
    )
    response = admin.delete(f"/api/farms/{farm_id}")
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "FARM_HAS_DATASETS"
    admin.delete(f"/api/datasets/{did}")
    assert admin.delete(f"/api/farms/{farm_id}").status_code == 204


# --- Storage guard --------------------------------------------------------------
def test_storage_refuses_paths_outside_the_data_dir(app):
    with app.app_context():
        for bad in ("../outside.csv", "/etc/passwd", "raw/../../x", ""):
            with pytest.raises(storage.StorageError):
                storage.resolve(bad)
