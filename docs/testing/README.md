# Testing

## How to run

```bash
bun run lint                                   # Ruff check + format check (all Python apps)
bun run test                                   # pytest in every Python app (unit tests)
cd apps/api && uv run pytest -q                # API unit tests (Hive replaced at run_query)
cd apps/api && uv run pytest -q -m integration # API against the real HDFS + HiveServer2
cd apps/ml  && uv run pytest -q                # ML pipeline mechanics
bun run --cwd apps/web build                   # frontend production build
```

Integration tests need HDFS and HiveServer2 running (see `infrastructure/hadoop-hive/README.md`).
They read the `HIVE_*` settings, including the password, from `apps/api/.env`. They never
assert hard-coded figures. Each endpoint is compared with an independent HiveQL query over the
same table.

## Results (run on 2026-11-24, native Hadoop 3.4.2 + Hive 4.1.0)

| Suite | Result |
|---|---|
| API unit tests | **192 passed**, 0 failed |
| API integration tests (real HDFS + HiveServer2) | **13 passed**, 0 failed |
| ML tests (`apps/ml`) | **3 passed**, 0 failed |
| Lint (`bun run lint`) | passed |
| `bun run test` (Turborepo) | 3/3 tasks successful |
| Web build (Vite) | succeeded |

### What the integration tests prove

- `/api/analytics/status`, `/api/bigdata/status` and `/api/hive/tables` list the real tables.
  HDFS reports a live DataNode.
- The daily, farm-comparison, summary and growth figures equal direct HiveQL aggregates.
- Farm scoping is applied inside the HiveQL.
- The alert trend statistics equal an independent least-squares fit in Python.
- `/api/activity` lists real audit-log entries.
- A CSV uploaded through the API lands in the real HDFS (checked with the `hdfs` CLI) and is
  removed when the dataset is deleted (`test_hdfs_integration.py`, test root `/polutary-test`).
- An unreachable HiveServer2 gives `503 HIVE_UNAVAILABLE`. A wrong password gives
  `503 HIVE_AUTH_FAILED`. An anonymous Hive login is refused.

### End-to-end checks (manual, throwaway database, real cluster)

**Browser:** headless Chromium, signed in as an administrator, opened all 18 pages.

- Dashboard, farms, batches, dataset upload, the 4 Historical Analytics tabs, Big Data / Hive,
  users, audit logs and settings load real API data with HTTP 200 and no browser errors.
- The dashboard KPIs, charts, alerts ("No active alerts", genuine for the current data) and
  activity feed all come from the API.
- **Not built (404, shown as "Not available yet" or as labelled samples):**
  - predictions and model evaluations (stage 10);
  - report history;
  - manual readings;
  - the free-form HiveQL console and its history.

**API with curl:**

- Admin login 200.
- An analyst sees only their farm (FARM001) in analytics and activity.
- `/api/bigdata/status` and `/api/hive/tables`: admin 200, analyst 403, anonymous 401.
- `/api/alerts`, `/api/activity`, `/api/analytics/summary` without a session: 401.

**CSV upload:**

- FARM001 rows exported from Hive were uploaded through `POST /api/datasets`. Result:
  `processed`, 10 accepted, 0 rejected.
- A file without `batch_id` was correctly rejected by validation.
- The processed file is written to HDFS (stage 7). `hdfs dfs -cat` gives the same SHA-256 as the
  local file (minus the header row), and deleting the dataset removes its HDFS folder.
- Stage 8: the folder is added as a partition of `poultry_uploads`; the HiveQL `COUNT(*)`,
  `SUM(mortality)` and `MIN(date)` of the partition match the uploaded file, and deleting the
  dataset drops the partition (`test_hdfs_integration.py`, table `poultry_uploads_test`).

**Final check (2026-11-24, throwaway SQLite database, real Hive):**

- Registration gives 201 with role `analyst`.
- A wrong password gives 401; the correct one gives 200.
- The analyst gets 200 on farms, batches, datasets, analytics, alerts and activity, and 403
  on Big Data, users and audit logs.
- `create-admin` works. The admin gets 200 on every analytics, Big Data, Hive tables, users
  and audit-log endpoint.

**HDFS integrity after restarts:** `hdfs fsck /` HEALTHY. The MD5s of the raw CSV, the cleaned
Parquet file and the test file were unchanged.

### Known gaps

- No ML model is trained. The data can't support one (`docs/research/datasets.md`).
- `/api/alerts` takes about 15 s, because it runs one MapReduce job in local mode.
