# Architecture

```
Browser (Vite + Bootstrap 5 + Chart.js)
        │  REST/JSON (/api)
        ▼
Flask API (apps/api) ──► SQLite (users, roles, farms, uploads, audit log)
        │
        ├─► CSV validation and preprocessing (pandas)
        ├─► HDFS (WebHDFS): processed datasets
        ├─► Hive (HiveServer2 via PyHive): external tables over HDFS, HiveQL analytics
        └─► ML models (apps/ml): trained on Hive query results, loaded for predictions
```

Diagrams and design decisions (ADRs) go in this folder.
