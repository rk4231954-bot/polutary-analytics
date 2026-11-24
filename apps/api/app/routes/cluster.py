"""Read-only Hadoop/Hive cluster metadata for the Big Data page (administrators only).

GET /api/bigdata/status  HDFS (NameNode JMX) and HiveServer2 status, latest data change
GET /api/hive/tables     Hive tables: type, HDFS location, files, size, stored row count

Running arbitrary HiveQL from the browser (POST /api/hive/query) isn't offered: the API
only runs the fixed, parameterised statements in services/hive_queries.py.
"""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify

from app.services import analytics_service, cluster_service
from app.services.auth_service import auth_required

bp = Blueprint("cluster", __name__, url_prefix="/api")


@bp.get("/bigdata/status")
@auth_required("cluster.view")
def bigdata_status():
    return jsonify(**cluster_service.cluster_status())


@bp.get("/hive/tables")
@auth_required("cluster.view")
def hive_tables():
    return jsonify(
        tables=cluster_service.hive_tables(),
        source=analytics_service.source_info(current_app.config["HIVE_DATABASE"]),
    )
