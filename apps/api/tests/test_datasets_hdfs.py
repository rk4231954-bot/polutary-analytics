"""Processed uploads are copied to HDFS (stage 7). WebHDFS is replaced here by an in-memory
stand-in; test_hdfs_integration.py writes to the real HDFS."""

from __future__ import annotations

import hashlib
import json

import pytest
from conftest import batch_payload
from test_datasets import data_dir, upload

from app.services import hdfs_client


@pytest.fixture
def farm_setup(make_farm, as_role):
    farm_id = make_farm()
    manager = as_role("farm_manager", farms=[farm_id])
    manager.post("/api/batches", json=batch_payload(farm_id))
    return farm_id, manager


@pytest.fixture
def fake_hdfs(app, monkeypatch):
    app.config["HDFS_ENABLED"] = True
    files: dict[str, bytes] = {}
    state = {"down": False, "corrupt": False, "deleted": []}

    def check(path):
        hdfs_client._check_path(path)  # the real path guard still applies
        if state["down"]:
            raise hdfs_client.HdfsError("HDFS (WebHDFS) is not reachable.")

    def mkdirs(path):
        check(path)

    def write_file(path, data):
        check(path)
        files[path] = b"corrupted" if state["corrupt"] else data

    def read_file(path):
        check(path)
        return files[path]

    def delete_dir(path):
        check(path)
        state["deleted"].append(path)
        for key in [k for k in files if k.startswith(path + "/")]:
            del files[key]

    for name, fn in {
        "mkdirs": mkdirs,
        "write_file": write_file,
        "read_file": read_file,
        "delete_dir": delete_dir,
    }.items():
        monkeypatch.setattr(hdfs_client, name, fn)
    return files, state


def test_processed_upload_is_stored_in_hdfs_and_verified(app, farm_setup, fake_hdfs):
    farm_id, manager = farm_setup
    files, _ = fake_hdfs
    dataset = upload(manager).get_json()["dataset"]
    did = dataset["id"]
    folder = f"/polutary/processed/farm_id={farm_id}/upload_id={did}"
    assert dataset["status"] == "processed"
    assert dataset["stages"]["hdfs"] is True and dataset["stages"]["hive"] is False
    assert dataset["hdfsPath"] == f"{folder}/records.csv"
    assert dataset["readyForHdfs"] is False
    assert dataset["history"][-1]["stage"] == "hdfs"
    assert dataset["history"][-1]["status"] == "success"
    assert "SHA-256 verified" in dataset["history"][-1]["message"]

    local = data_dir(app) / f"processed/farm_id={farm_id}/upload_id={did}"
    assert files[f"{folder}/records.csv"] == (local / "records.csv").read_bytes()
    manifest = json.loads(files[f"{folder}/manifest.json"])
    assert manifest["hdfs"] == {
        "stored": True,
        "path": f"{folder}/records.csv",
        "sha256": hashlib.sha256((local / "records.csv").read_bytes()).hexdigest(),
    }
    assert json.loads((local / "manifest.json").read_text())["hdfs"]["stored"] is True


def test_hdfs_down_keeps_the_local_file_and_says_so(app, farm_setup, fake_hdfs):
    farm_id, manager = farm_setup
    _, state = fake_hdfs
    state["down"] = True
    dataset = upload(manager).get_json()["dataset"]
    assert dataset["status"] == "processed"  # the local processing result stands
    assert dataset["stages"]["hdfs"] is False and dataset["hdfsPath"] is None
    assert dataset["readyForHdfs"] is True
    last = dataset["history"][-1]
    assert (last["stage"], last["status"]) == ("hdfs", "failure")
    assert "not reachable" in last["message"]
    local = data_dir(app) / f"processed/farm_id={farm_id}/upload_id={dataset['id']}"
    assert (local / "records.csv").is_file()


def test_mismatched_hdfs_copy_is_not_marked_stored(farm_setup, fake_hdfs):
    _, manager = farm_setup
    _, state = fake_hdfs
    state["corrupt"] = True
    dataset = upload(manager).get_json()["dataset"]
    assert dataset["stages"]["hdfs"] is False
    assert "does not match" in dataset["history"][-1]["message"]


def test_failed_validation_is_not_sent_to_hdfs(farm_setup, fake_hdfs):
    _, manager = farm_setup
    files, _ = fake_hdfs
    dataset = upload(manager, "nothing,useful\n1,2\n").get_json()["dataset"]
    assert dataset["status"] == "failed"
    assert files == {}


def test_delete_removes_only_this_uploads_hdfs_folder(farm_setup, fake_hdfs):
    farm_id, manager = farm_setup
    files, state = fake_hdfs
    did = upload(manager).get_json()["dataset"]["id"]
    assert manager.delete(f"/api/datasets/{did}").status_code == 204
    assert state["deleted"] == [f"/polutary/processed/farm_id={farm_id}/upload_id={did}"]
    assert files == {}


@pytest.mark.parametrize(
    "path",
    [
        "/user/hive/warehouse/poultry_analytics.db/x",
        "/polutary/processed/../raw/x",
        "/polutary/processed",
        "/polutary/processed/a b",
    ],
)
def test_paths_outside_the_processed_dir_are_refused(app, path):
    with app.app_context(), pytest.raises(hdfs_client.HdfsError):
        hdfs_client._check_path(path)
