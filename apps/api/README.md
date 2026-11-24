# apps/api: Flask REST API

Authentication, role-based access control, farms, poultry batches, health inspections,
audit logging (stage 3) and CSV dataset ingestion (stage 6: upload, validation, preprocessing,
local storage), with application data in SQLite through SQLAlchemy.
Hadoop/HDFS, Hive and ML arrive in later stages and are **not** part of this code yet: processed
datasets are stored locally and marked *ready for HDFS*; nothing claims they are in HDFS or Hive.

This is a standalone Python project (uv-managed). Bun is not needed to run it.

## Folder structure

```
apps/api/
├── run.py                  entry point (loads .env, creates the app, runs the dev server)
├── app/
│   ├── __init__.py         create_app() factory, CORS, security headers
│   ├── config.py           settings from environment variables + safety checks
│   ├── extensions.py       SQLAlchemy, JWTManager, CORS instances
│   ├── cli.py              flask commands: init-db, create-admin, purge-sessions
│   ├── models/             SQLAlchemy models
│   │   ├── user.py           Role, User, FarmAssignment
│   │   ├── farm.py           Farm, PoultryBatch, BatchInspection
│   │   ├── audit.py          AuditLog (append-only), RevokedSession
│   │   └── dataset.py        DatasetUpload, DatasetEvent (processing history)
│   ├── routes/             one blueprint per domain (all under /api)
│   │   ├── auth.py  users.py  farms.py  batches.py  datasets.py  audit.py  health.py
│   ├── services/           business logic
│   │   ├── auth_service.py   JWT cookie sessions, CSRF, sliding expiry, @auth_required
│   │   ├── permissions.py    roles → permissions, farm-level access rules
│   │   ├── farm_service.py   farm / batch / inspection rules
│   │   ├── audit_service.py  audit entries (sensitive keys stripped)
│   │   ├── csv_schema.py     daily-record CSV schema (fields, types, ranges, aliases)
│   │   ├── csv_ingestion.py  CSV parsing, validation, preprocessing (pure, no Flask)
│   │   ├── dataset_service.py upload checks, storage, SQLite metadata, history, audit
│   │   ├── passwords.py      Argon2id hashing
│   │   ├── rate_limit.py     login / registration throttling
│   │   └── serializers.py    model → JSON (camelCase, no secrets)
│   └── utils/              errors, validation, HTTP, time and safe file-storage helpers
├── tests/                  pytest suite (temporary SQLite file per test)
├── instance/               SQLite database (git-ignored, created automatically)
├── pyproject.toml / uv.lock     pinned dependencies (source of truth)
├── requirements.txt        runtime deps exported from uv.lock (for pip users)
├── requirements-dev.txt    pytest + ruff
├── .env.example            every setting, documented
└── package.json            Turborepo wrapper: setup / dev / lint / test
```

## Install and run

```bash
cd apps/api
uv sync                                   # .venv with pinned dependencies (Python 3.11 or 3.12)
cp .env.example .env                      # then set SECRET_KEY:
python3 -c "import secrets; print(secrets.token_hex(32))"
uv run flask --app run create-admin --email you@example.org --name "Your Name"   # prompts for password
uv run python run.py                      # http://127.0.0.1:5000/api/health
```

Without uv: `python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt -r requirements-dev.txt`,
then use `python run.py` and `flask --app run ...`.

From the repository root, `bun run dev` starts both the Vite frontend (5173) and this API (5000).
The Vite dev server proxies `/api` to the API, so cookies are same-site in development.

| Command | Purpose |
|---|---|
| `uv run pytest` | run the test suite |
| `uv run ruff check . && uv run ruff format --check .` | lint |
| `uv run flask --app run init-db` | create tables + roles (also done automatically at start-up) |
| `uv run flask --app run create-admin --email … --name …` | bootstrap the first administrator (`--password-stdin` for scripts) |
| `uv run flask --app run purge-sessions` | delete expired logout records |

### First administrator

Public registration **always** creates an *Analyst* account and rejects any `role` field.
The only way to get the first administrator is the `create-admin` command, which runs on the
server, reads the password from a hidden prompt (never a command-line argument), refuses to run
when an administrator already exists (unless `--allow-additional`), and writes an audit entry.
After that, administrators manage roles from **Administration & Security → Users & Roles**.

## Security design

| Concern | Implementation |
|---|---|
| Passwords | Argon2id (argon2-cffi, RFC 9106 low-memory profile), salted; rehashed on login if parameters change. Policy: 8–128 chars with a letter and a digit. Never logged or returned. |
| Sessions | JWT (Flask-JWT-Extended) in an **HttpOnly** cookie `pa_access`, path `/api/`, 30 min, sliding re-issue while active, absolute limit 12 h (7 days with "keep me signed in"). |
| CSRF | Double-submit token: POST/PUT/PATCH/DELETE must send `X-CSRF-TOKEN`. The token is returned by login and `/auth/me` (a Vercel frontend cannot read API cookies). Login/register require `application/json`, which cross-site forms cannot send without a CORS preflight. |
| Logout / revocation | Session id stored in `revoked_sessions`; password change, admin password reset and suspension bump `token_version`, invalidating every token of that user. |
| Brute force | 5 failures per email and 20 per IP in 15 min → `429` with `Retry-After`; 10 registrations per IP per hour. Unknown emails still run a hash verification, so timing does not reveal registered accounts. |
| RBAC | Permissions checked server-side in `@auth_required("permission")`; farm-level checks in every farm/batch query. Unassigned farms return `404` (existence is not revealed) and are audited as `access.denied`. |
| CORS | Only origins listed in `CORS_ALLOWED_ORIGINS`, credentials allowed; `*` is refused at start-up. |
| Headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP `default-src 'none'`, `Cache-Control: no-store`, optional HSTS. |
| Config | Start-up fails if `SECRET_KEY` is missing/weak, if `SameSite=None` is used without `Secure`, or if production lacks secure cookies. |
| Audit | Append-only (ORM refuses updates/deletes); keys containing password/token/secret/hash/csrf are dropped. |

## Roles and permissions

| Permission | Admin | Farm Manager | Analyst | Veterinary User |
|---|:-:|:-:|:-:|:-:|
| `users.manage` (users, roles, farm access) | ✔ | | | |
| `audit.view` | ✔ | | | |
| `farms.create` | ✔ | ✔ (auto-assigned) | | |
| `farms.update` | ✔ all | ✔ assigned | | |
| `farms.delete` (no active batches) | ✔ | | | |
| `batches.manage` | ✔ all | ✔ assigned | | |
| `health.view` (inspections) | ✔ | ✔ assigned | | ✔ assigned |
| `inspections.record` | ✔ | | | ✔ assigned |
| `analytics.view` (stage 9+) | ✔ | ✔ | ✔ | |
| `reports.generate` (stage 9+) | ✔ | | ✔ | |
| `datasets.upload` (CSV ingestion) | ✔ all | ✔ assigned | | |
| `datasets.view` (reports, previews, history) | ✔ all | ✔ assigned | ✔ assigned | |
| `datasets.delete` | ✔ all | ✔ assigned | | |
| `cluster.view` (HDFS/Hive status, Hive tables) | ✔ | | | |
| Read farms & batches | all | assigned | assigned | assigned |

## Database schema (SQLite)

```
roles              id PK · name UNIQUE · label · description
users              id PK · full_name · email UNIQUE (lower-case, indexed) · password_hash (Argon2id)
                   role_id FK→roles (RESTRICT, indexed) · status CHECK(active|suspended)
                   must_change_password · token_version CHECK(>=0) · created_at · updated_at
                   last_login_at · password_changed_at
farm_assignments   (user_id FK→users CASCADE, farm_id FK→farms CASCADE) composite PK
                   assigned_at · assigned_by_id FK→users SET NULL · INDEX(farm_id)
farms              id PK · code UNIQUE · name · location · capacity CHECK(>0)
                   housing_type CHECK(Closed house|Open-sided house|Free range|Other)
                   status CHECK(active|maintenance|inactive) INDEX · manager_name
                   created_by_id FK→users SET NULL · created_at · updated_at
poultry_batches    id PK · farm_id FK→farms CASCADE · code · UNIQUE(farm_id, code)
                   poultry_type CHECK(Broiler|Layer|Breeder) · breed · initial_count CHECK(>0)
                   start_date · end_date CHECK(end_date >= start_date)
                   status CHECK(planned|active|completed) · INDEX(farm_id, status)
                   created_by_id FK→users SET NULL · created_at · updated_at
batch_inspections  id PK · batch_id FK→poultry_batches CASCADE · inspector_id FK→users SET NULL
                   observed_on · health_status CHECK(normal|attention|critical) · observation
                   created_at · INDEX(batch_id, observed_on)
audit_logs         id PK · created_at INDEX · actor_user_id FK→users SET NULL INDEX · actor_email
                   action · resource_type · resource_id · outcome CHECK(success|failure|denied)
                   ip_address · user_agent · details (JSON text) · INDEX(action, created_at)
revoked_sessions   session_id PK · user_id FK→users CASCADE · revoked_at · expires_at INDEX
dataset_uploads    id PK · farm_id FK→farms RESTRICT (null until resolved) · uploaded_by_id FK→users SET NULL
                   original_filename (secure_filename, display only) · content_type · size_bytes · sha256 INDEX
                   status CHECK(uploaded|validating|processing|processed|failed)
                   total_rows · accepted_rows · rejected_rows · duplicate_rows · error_count · warning_count
                   raw_path · processed_path · rejected_path (relative to DATA_DIR) · report (JSON) · error
                   created_at · updated_at · processed_at · INDEX(farm_id, created_at)
dataset_events     id PK · dataset_id FK→dataset_uploads CASCADE INDEX · stage · status
                   CHECK(success|warning|failure) · message · created_at
```

SQLite foreign keys are enabled on every connection. Set `DATABASE_URL` to any SQLAlchemy URL
(e.g. `postgresql+psycopg://…` plus the driver) to move to PostgreSQL; no SQLite-specific SQL is used.

## API endpoints

All responses are JSON. Errors: `{"error": {"code", "message", "fields"?}}`.
🔒 = signed-in session required · ✎ = also requires the `X-CSRF-TOKEN` header.

| Method | Path | Access | Body → Response |
|---|---|---|---|
| GET | `/api/health` | public | → `{status, version, time, database}` |
| POST | `/api/auth/register` | public | `{fullName, email, password}` → `201 {user}` · 409 `EMAIL_TAKEN` · 400 `ROLE_NOT_ALLOWED` |
| POST | `/api/auth/login` | public | `{email, password, remember}` → `{user, csrfToken}` + cookie · 401 `INVALID_CREDENTIALS` · 403 `ACCOUNT_SUSPENDED` · 429 |
| POST | `/api/auth/logout` | ✎ if signed in | → `204`, session revoked, cookies cleared |
| GET | `/api/auth/me` | 🔒 | → `{user, csrfToken}` |
| PATCH | `/api/auth/me` | 🔒✎ | `{fullName?, email?}` → `{user}` |
| POST | `/api/auth/change-password` | 🔒✎ | `{currentPassword, newPassword}` → `{user, csrfToken}` · 400 `INVALID_CURRENT_PASSWORD` |
| GET | `/api/farms` | 🔒 | → `{farms}` (only accessible farms, with batch stats) |
| POST | `/api/farms` | 🔒✎ `farms.create` | `{code, name, location, capacity, housingType, status, manager?}` → `201 {farm}` |
| GET | `/api/farms/:id` | 🔒 farm access | → `{farm}` |
| PUT | `/api/farms/:id` | 🔒✎ `farms.update` + access | full farm body → `{farm}` |
| DELETE | `/api/farms/:id` | 🔒✎ `farms.delete` | → `204` · 409 `FARM_HAS_ACTIVE_BATCHES` · 409 `FARM_HAS_DATASETS` |
| GET | `/api/farms/:id/batches` | 🔒 farm access | → `{batches}` |
| GET | `/api/batches?farm_id=&status=` | 🔒 | → `{batches}` (accessible farms only) |
| POST | `/api/batches` | 🔒✎ `batches.manage` | `{code, farmId, poultryType, breed?, initialCount, startDate, status, endDate?}` → `201 {batch}` |
| GET | `/api/batches/:id` | 🔒 farm access | → `{batch}` (`daily: []` until stage 6) |
| PUT | `/api/batches/:id` | 🔒✎ `batches.manage` + access | full batch body → `{batch}` |
| DELETE | `/api/batches/:id` | 🔒✎ `batches.manage` + access | → `204` · 409 `BATCH_ACTIVE` |
| GET | `/api/batches/:id/inspections` | 🔒 `health.view` + access | → `{inspections}` |
| POST | `/api/batches/:id/inspections` | 🔒✎ `inspections.record` + access | `{observedOn, healthStatus, observation}` → `201 {inspection}` |
| POST | `/api/datasets` | 🔒✎ `datasets.upload` | multipart `file` (.csv), `mapping`? (JSON `{field: column}`; omitted = match by header), `farmId`? → `201 {dataset}` with `status` `processed` or `failed` + report · 400 `FILE_REQUIRED`/`EMPTY_FILE`/`VALIDATION_ERROR` · 413 `FILE_TOO_LARGE` · 415 `INVALID_FILE_TYPE` |
| GET | `/api/datasets?limit=&farm_id=` | 🔒 `datasets.view` | → `{datasets}` (newest first, accessible farms only) |
| GET | `/api/datasets/:id` | 🔒 `datasets.view` + access | → `{dataset}` with `report` (summary, errors, warnings, transformations) and `history` |
| GET | `/api/datasets/:id/preview?kind=processed\|rejected&offset=&limit=` | 🔒 `datasets.view` + access | → `{preview: {columns, rows, total, offset}}` (limit ≤ 200; empty cells are `null`) |
| DELETE | `/api/datasets/:id` | 🔒✎ `datasets.delete` + access | → `204` (record, history and stored files removed) |
| GET | `/api/users` | 🔒 `users.manage` | → `{users}` |
| POST | `/api/users` | 🔒✎ `users.manage` | `{fullName, email, role, farmIds}` → `201 {user, temporaryPassword}` |
| PATCH | `/api/users/:id` | 🔒✎ `users.manage` | `{role?, status?, farmIds?}` → `{user}` · 400 `CANNOT_MODIFY_SELF` · 409 `LAST_ADMIN` |
| POST | `/api/users/:id/reset-password` | 🔒✎ `users.manage` | → `{user, temporaryPassword}` |
| GET | `/api/users/login-activity` | 🔒 `users.manage` | → `{logins}` |
| GET | `/api/users/failed-logins` | 🔒 `users.manage` | → `{attempts}` (grouped) |
| GET | `/api/audit-logs?from&to&action&outcome&limit` | 🔒 `audit.view` | → `{entries}` |
| GET | `/api/audit-logs/security-events` | 🔒 `audit.view` | → `{events}` |

Temporary passwords are shown once to the administrator; the account must change it before any
other endpoint works (`403 PASSWORD_CHANGE_REQUIRED`).

Audit actions: `auth.register|login|logout|password_change`, `user.create|role_change|status_change|
farm_access_change|password_reset|profile_update|admin_bootstrap`, `farm.create|update|delete`,
`batch.create|update|delete`, `inspection.create`, `dataset.upload` (success, or failure with the
reason, including refused files), `dataset.delete`, `access.denied`.

## CSV dataset ingestion (stage 6)

One row = one day of readings for one poultry batch. Headers are matched to fields by name
(case, spaces and units are ignored, common aliases such as `Deaths` or `Temperature (°C)` are
recognised) or by the `mapping` sent with the upload. Extra columns are ignored and reported.

| Field | Required | Type | Rule | Meaning |
|---|:-:|---|---|---|
| `date` | ✔ | date | `YYYY-MM-DD` (a time part is dropped), real date, not in the future | Day of the readings |
| `farm_code` | ✔ | code | 2–20 letters/digits/hyphens; a registered farm assigned to the uploader | Farm, e.g. `F-001` |
| `batch_code` | ✔ | code | 2–20 letters/digits/hyphens (warning if not registered for the farm) | Flock/batch, e.g. `B-2026-07` |
| `temperature_c` | | number | −10 to 60 | House temperature, °C |
| `humidity_pct` | | number | 0 to 100 | Relative humidity, % |
| `feed_kg` | | number | ≥ 0 | Feed consumed that day, kg |
| `water_l` | | number | ≥ 0 | Water consumed that day, litres |
| `mortality` | | integer | ≥ 0 | Birds that died that day |
| `avg_weight_g` | | number | 0 to 10 000 | Average live weight per bird, g |
| `bird_count` | | integer | ≥ 0 | Live birds at the end of the day |

**File checks (refused, nothing stored):** `.csv` extension; MIME type in an allow-list
(`text/csv`, `application/vnd.ms-excel`, `text/plain`, …); size ≤ `MAX_UPLOAD_MB`; not empty.
With curl, send the type explicitly: `-F "file=@readings.csv;type=text/csv"`.

**Whole-file errors (dataset `failed`, report kept):** not UTF-8, binary content, malformed
quoting, no header or no data rows, a required column missing, a mapped column absent or used
twice, duplicate header names, no valid rows left, or rows for several farms when no farm was
selected.

**Row errors (row left out, listed with line number and reason):** wrong number of fields,
missing required value, invalid date/code/number, value out of range, decimal in a whole-number
field, future date, farm code not the selected farm (or not one of the uploader's farms), and
rows with the same date + farm + batch but different readings (all such rows are rejected,
because neither can be chosen automatically).

**Warnings (rows kept):** missing optional readings, blank lines, exact duplicate rows (first
kept), batch codes not registered in the app, mortality higher than the bird count, and the same
file already processed for the farm.

**Preprocessing (every change is listed in the report):** trim spaces, treat `NA`, `null`,
`n/a`, `nan`, `none`, `-`, `?` and empty cells as missing, upper-case codes, drop the time part
of dates, write numbers in a standard form, rename columns to the field names, drop unmapped
columns, remove exact duplicates, sort by date and batch. **Missing values stay empty; nothing
is imputed, estimated or corrected.**

**Storage** (`DATA_DIR`, default `<repo>/data`, git-ignored, never web-served; folder names use
only numeric ids, in Hive partition style so stage 7 can copy them to HDFS unchanged):

```
data/raw/farm_id=<farm>/upload_id=<id>/original.csv        the file exactly as uploaded
data/raw/farm_id=<farm>/upload_id=<id>/rejected_rows.csv   source_line, errors, raw_record
data/raw/unassigned/upload_id=<id>/...                     farm could not be resolved
data/processed/farm_id=<farm>/upload_id=<id>/records.csv   cleaned rows, fixed 11-column schema
data/processed/farm_id=<farm>/upload_id=<id>/manifest.json columns + Hive types, row count, sha256
```

`records.csv`: UTF-8, comma-separated, header row, empty field = missing, columns `date,
farm_code, batch_code, temperature_c, humidity_pct, feed_kg, water_l, mortality, avg_weight_g,
bird_count, source_line` (`source_line` = line in the original upload).

## Analytics on Apache Hive (stage 9)

Analytics endpoints run **HiveQL on HiveServer2** through PyHive and return the query
results. They never read SQLite or the upload staging files. SQLite still holds users,
farms, batches, uploads and the audit log.

| Module | Role |
|---|---|
| `app/services/hive_client.py` | one connection per request, error mapping, row normalisation |
| `app/services/hive_queries.py` | all HiveQL, static text with bound values only (`%(name)s`) |
| `app/services/analytics_service.py` | farm scoping (RBAC) and response shaping |
| `app/routes/analytics.py` | `/api/analytics/*` blueprint |

All queries read `<HIVE_DATABASE>.poultry_records_cleaned`. A `days` window ends at the
**latest record date in the data**, not today, so historic datasets still show values.

| Method | Path | Access | Response |
|---|---|---|---|
| GET | `/api/analytics/status` | 🔒 `analytics.view` | `{hive: {connected, database, tables}, source}` |
| GET | `/api/analytics/summary?farm_id=&days=` | 🔒 `analytics.view` | `{totalFarms, activeBatches, totalBirds, feedKg, mortalityRatePct, avgWeightG, trends, from, to, source}` |
| GET | `/api/analytics/daily?farm_id=&days=` | 🔒 `analytics.view` | `{records: [{date, farmId, farmCode, farmName, birdCount, mortality, feedKg, avgWeightG, temperatureC, humidityPct, records}], source, days}` |
| GET | `/api/analytics/farm-comparison?days=` | 🔒 `analytics.view` | `{farms: [{farmCode, farmName, deaths, mortalityRatePct, feedKg, feedPerBirdKg, avgWeightG, avgTemperatureC, avgHumidityPct, ...}], source, days}` |
| GET | `/api/analytics/growth?farm_id=&batch_id=` | 🔒 `analytics.view` | `{batches: [{code, farmName, poultryType, ageBasis, points: [{date, ageDays, avgWeightG, birdCount}]}], source}` |
| GET | `/api/alerts?farm_id=&limit=` | 🔒 `analytics.view` | `{alerts: [{id, type, severity, title, message, farmCode, farmName, date, value, expected, residualStdDev, zScore, baselineDays}], rules, source}` |
| GET | `/api/bigdata/status` | 🔒 `cluster.view` | `{hdfs: {connected, namenodeUrl, state, capacityBytes, usedBytes, remainingBytes, liveDataNodes, filesTotal, blocksTotal}, hive: {connected, host, port, database, version}, latestIngestionAt}` |
| GET | `/api/hive/tables` | 🔒 `cluster.view` | `{tables: [{name, type, location, partitioned, rowCount, numFiles, totalSizeBytes, updatedAt}], source}` |
| GET | `/api/activity?limit=` | 🔒 any signed-in user | `{activity: [{id, type, action, outcome, message, actor, createdAt}]}` (from the audit log; see below) |

Mortality, feed, average weight and temperature are all served by `daily` (per farm per day)
and `farm-comparison` (per farm over the period). `days` is 1–3650 (default 30). `farm_id` and
`batch_id` are **application (SQLite) ids**. They're mapped to Hive codes through `Farm.code` and
`Batch.code`. `avgWeightG` is grams (the dataset stores kg).

**Farm scoping.** Admins see every farm in Hive. Other roles see only Hive rows whose
`farm_id` equals the `code` of a farm assigned to them. A user with no farms gets empty
results and Hive isn't queried. Veterinarians don't have `analytics.view`.

**Alerts** (`/api/alerts`) are statistical signals, **not diagnoses** and not veterinary
thresholds. How they work:

- For each farm, one HiveQL query (`hive_queries.ALERT_BASELINE_SQL`) takes the farm's latest
  record day and the 14 days before it.
- For mortality, feed per bird, temperature and humidity, it fits a least-squares trend with
  `REGR_SLOPE`/`REGR_INTERCEPT`, predicts the latest day from that trend, and works out the
  residual standard deviation.
- An alert needs all of the following:
  - `|z| ≥ 2` for a warning, or `|z| ≥ 3` for danger;
  - a difference of at least 5% of the predicted value (and at least one bird for mortality),
    so a negligible difference on a very regular series isn't flagged;
  - at least 5 days of history;
  - for mortality, an increase only.
- A trend is used rather than a flat average because feed per bird rises as birds grow, and
  a flat average would flag normal growth.
- The 2σ and 3σ cut-offs are common statistical conventions, and the 5% guard is an
  application choice. Neither comes from a poultry standard. The rule parameters come back in
  `rules` with every response.
- `date`/`createdAt` is the **record date** in the data, not the time of the request.

**Activity** (`/api/activity`) lists real data-changing actions from the audit log: dataset
uploads and deletions, farm/batch create/update/delete, inspections, and account
administration. Sign-ins and security events stay on the admin-only audit pages. Who sees what:

- Admins see everything.
- Other users see their own actions, plus actions on their assigned farms when their role
  allows that record type (`datasets.view` for uploads, `health.view` for inspections).
- Account administration is visible to admins only.

**Cluster status** (`/api/bigdata/status`, `/api/hive/tables`, admins only) is read-only metadata
for the Big Data page:

- HDFS figures come from the NameNode JMX bean `FSNamesystemState` at `WEBHDFS_URL`.
- Tables come from `SHOW TABLES` plus `DESCRIBE FORMATTED`. Table names are checked against the
  identifier allow-list before they're quoted.
- `rowCount` is Hive's stored `numRows` statistic. It's `null` when Hive has no statistic (the
  external staging table), rather than a guess or a MapReduce count.
- `updatedAt` / `latestIngestionAt` is the HDFS modification time of the table directories
  (WebHDFS `GETFILESTATUS`).
- `hive.version` is `null` (not queried).

Free-form HiveQL from the browser (`POST /api/hive/query`, `/api/hive/queries`) is **not
offered**. The API runs only the fixed statements in `hive_queries.py`, so the page's query
console reports that the endpoint is unavailable.

**Errors.**

| Status | Code | When |
|---|---|---|
| 503 | `HIVE_UNAVAILABLE` | HiveServer2 can't be reached (connection refused, timeout) |
| 503 | `HIVE_AUTH_FAILED` | HiveServer2 refused the API's login (check `HIVE_USERNAME`/`HIVE_PASSWORD`/`HIVE_AUTH`) |
| 502 | `HIVE_QUERY_FAILED` | HiveServer2 rejected or failed the query (details go to the server log only) |
| 400 | `BAD_QUERY` | invalid `days`, `farm_id` or `batch_id` |
| 404 | `NOT_FOUND` | farm/batch doesn't exist or isn't accessible |

**Configuration** (`.env`, keep it mode 0600):

- `HIVE_HOST` (localhost) and `HIVE_PORT` (10000).
- `HIVE_USERNAME`: HiveServer2 runs queries as this user (doAs), so it needs HDFS access.
- `HIVE_DATABASE` (poultry_analytics).
- `HIVE_AUTH` (`NONE`|`NOSASL`|`LDAP`|`CUSTOM`). The project's HiveServer2 requires
  `CUSTOM`, a password login (see `infrastructure/hadoop-hive/README.md`).
- `HIVE_PASSWORD`: used with LDAP/CUSTOM only, and never logged or returned in errors.
- `WEBHDFS_URL` (http://127.0.0.1:9870): the NameNode HTTP address, used read-only for cluster status.

**Tests.** `uv run pytest` runs unit tests with Hive replaced at the `run_query` boundary.
`uv run pytest -m integration` runs against the real HiveServer2, using the `HIVE_*` settings
from `apps/api/.env`. It compares each endpoint with an independent HiveQL aggregate and re-fits
the alert trends in Python. It also checks the 503 paths, including a refused login. Start order for HDFS, HiveServer2,
Beeline and Flask: see `infrastructure/hadoop-hive/README.md`.

## Connecting a deployed frontend (Vercel)

1. Host this API on HTTPS (a VM/container; Vercel cannot run it or, later, Hadoop/Hive).
2. API `.env`: `APP_ENV=production`, `CORS_ALLOWED_ORIGINS=https://<your-site>.vercel.app`,
   `JWT_COOKIE_SAMESITE=None`, `JWT_COOKIE_SECURE=true`, `HSTS_ENABLED=true`,
   `TRUST_PROXY_COUNT=1` if behind a reverse proxy. Run with a WSGI server, e.g. gunicorn.
3. Vercel env: `VITE_API_BASE_URL=https://<api-domain>/api`, `VITE_DEMO_MODE=false`; redeploy.

Browsers that block third-party cookies may refuse cross-site cookies; serving the API from a
sub-domain of the frontend's site (or proxying `/api` through the frontend host) avoids that.
