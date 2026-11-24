# Architecture

Polutary Analytics is an Apache Hive-based analytics system for poultry farming. **Hive does
the big-data analytics. SQLite holds the application records.** Each kind of data stays in its
own store.

## Components (as built)

```
Browser: apps/web (Vite, Bootstrap 5, Chart.js, vanilla JS)
   │  JSON over HTTP, /api (Vite proxies to Flask in development)
   ▼
Flask API: apps/api (app factory, one blueprint per domain)
   ├── SQLite (SQLAlchemy)     users, roles, farm assignments, farms, batches, inspections,
   │                           dataset uploads, audit log  ← app records and auth only
   ├── pandas                  CSV validation + preprocessing (uploads → data/processed)
   └── PyHive ─► HiveServer2   (127.0.0.1:10000, password login, doAs)
                    └── Hive 4.1.0 (MapReduce, local mode), Derby metastore
                          └── database poultry_analytics → tables over HDFS
                                └── HDFS 3.4.2 (127.0.0.1:9000) /poultry-analytics/raw,
                                    /user/hive/warehouse/poultry_analytics.db
apps/ml (pandas, scikit-learn, statsmodels)
   └── reads Hive query results; currently only a data-sufficiency check (no deployed model)
```

| Layer | Technology | Where |
|---|---|---|
| Frontend | HTML5, CSS3, Bootstrap 5.3, Chart.js 4.6, Vite 8, vanilla ES modules | `apps/web` |
| API | Python 3.12, Flask 3.1, SQLAlchemy 2.0, Flask-JWT-Extended, Argon2id | `apps/api` |
| App database | SQLite | `apps/api/instance/` (git-ignored) |
| Distributed storage | Apache Hadoop 3.4.2 HDFS (single node) | native WSL install |
| Analytics engine | Apache Hive 4.1.0, HiveServer2, HiveQL; PyHive 0.7 client | native WSL install |
| ML tooling | pandas, NumPy, scikit-learn, statsmodels | `apps/ml` |
| Monorepo/tooling | Bun workspaces, Turborepo, uv, pytest, Ruff | repo root |

## Data flow

```
1. CSV file ─► hdfs dfs -put ─► HDFS /poultry-analytics/raw/poultry_records.csv
2. Hive: poultry_records_staging (EXTERNAL TEXTFILE over /poultry-analytics/raw)
3. Hive: CTAS ─► poultry_records_cleaned (Parquet, null/negative rows filtered)
4. Flask ─► PyHive ─► HiveQL (GROUP BY, window functions, JOIN, REGR_SLOPE) ─► JSON
5. Dashboard / analytics pages render the JSON with Chart.js
```

In-app CSV upload (`POST /api/datasets`) is a separate path. It validates, preprocesses and
records the file (SQLite metadata plus `data/processed/`). Writing those files to HDFS and Hive
(roadmap stage 7) **isn't built yet**, so uploaded files don't change the Hive analytics.
Steps 1–3 were done by hand (see `docs/research/datasets.md`).

## Request flow for one analytics call

1. The browser calls `GET /api/analytics/summary?days=30` with the session cookie (HttpOnly JWT).
2. `auth_required("analytics.view")` checks the session and role. Veterinarians are refused.
3. `analytics_service.resolve_scope` reads the user's farm assignments from **SQLite**.
   Admins get all farms; other roles get only the Hive farm codes that match their farms.
4. `hive_queries.period_summary` returns static HiveQL plus bound parameters (no string
   building from user input).
5. `hive_client.run_query` opens a PyHive connection, signs in, runs the HiveQL and closes the
   connection.
6. The result rows become JSON with `source: {engine: "Apache Hive", table: …}`.
7. Failures come back as structured errors:
   - `503 HIVE_UNAVAILABLE`: HiveServer2 can't be reached;
   - `503 HIVE_AUTH_FAILED`: the API's Hive login was refused;
   - `502 HIVE_QUERY_FAILED`: the query failed.

## Endpoints backed by Hive

`/api/analytics/status`, `/summary`, `/daily`, `/farm-comparison`, `/growth`, and `/api/alerts`
(trend-based statistical signals, not diagnoses). `/api/bigdata/status` and `/api/hive/tables`
(admins only) report read-only HDFS (NameNode JMX/WebHDFS) and Hive table metadata.
`/api/activity` reads the SQLite audit log.
Details: `apps/api/README.md`.

## Security (summary)

**Application**
- Argon2id password hashes.
- JWT in an HttpOnly cookie with double-submit CSRF.
- Role-based access control plus farm-level scoping, enforced on the server.
- Audit log.
- Parameterised SQL and HiveQL.

**Cluster**
- HiveServer2 requires a user name and password (custom PBKDF2 provider).
- HiveServer2 and HDFS listen on 127.0.0.1 only.
- The unauthenticated `anonymous` proxy user was removed; impersonation is limited to `kiran`.
- World-writable HDFS directories were tightened.

Details: `infrastructure/hadoop-hive/README.md`.
