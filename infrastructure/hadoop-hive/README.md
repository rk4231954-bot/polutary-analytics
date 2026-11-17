# infrastructure/hadoop-hive

Docker Compose setup for a real, single-node Hadoop (HDFS NameNode + DataNode) and Apache Hive (Metastore + HiveServer2) cluster for local development.

**Status: not yet implemented (stage 7).** This directory has no `docker-compose.yml` on purpose. The compose file is written and tested against a running Docker engine in stage 7.

Planned services and ports:

| Service       | Purpose                              | Port  |
|---------------|--------------------------------------|-------|
| namenode      | HDFS NameNode + WebHDFS              | 9870  |
| datanode      | HDFS DataNode                        | 9864  |
| metastore     | Hive Metastore (persistent backend)  | 9083  |
| hiveserver2   | HiveServer2 (Thrift, used by PyHive) | 10000 |

Prerequisite: Docker Engine with Compose v2. On WSL2, turn on Docker Desktop's WSL integration for this distro, or install Docker Engine inside WSL.
