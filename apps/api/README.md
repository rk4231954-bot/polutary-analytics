# apps/api: Flask REST API

Stage 3 backend: authentication, role-based access control, farms, poultry batches,
health inspections and audit logging, stored in SQLite through SQLAlchemy.
Hadoop/HDFS, Hive and ML arrive in later stages and are **not** part of this code yet.

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
│   │   └── audit.py          AuditLog (append-only), RevokedSession
│   ├── routes/             one blueprint per domain (all under /api)
│   │   ├── auth.py  users.py  farms.py  batches.py  audit.py  health.py
│   ├── services/           business logic
│   │   ├── auth_service.py   JWT cookie sessions, CSRF, sliding expiry, @auth_required
│   │   ├── permissions.py    roles → permissions, farm-level access rules
│   │   ├── farm_service.py   farm / batch / inspection rules
│   │   ├── audit_service.py  audit entries (sensitive keys stripped)
│   │   ├── passwords.py      Argon2id hashing
│   │   ├── rate_limit.py     login / registration throttling
│   │   └── serializers.py    model → JSON (camelCase, no secrets)
│   └── utils/              errors, validation, HTTP and time helpers
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
| DELETE | `/api/farms/:id` | 🔒✎ `farms.delete` | → `204` · 409 `FARM_HAS_ACTIVE_BATCHES` |
| GET | `/api/farms/:id/batches` | 🔒 farm access | → `{batches}` |
| GET | `/api/batches?farm_id=&status=` | 🔒 | → `{batches}` (accessible farms only) |
| POST | `/api/batches` | 🔒✎ `batches.manage` | `{code, farmId, poultryType, breed?, initialCount, startDate, status, endDate?}` → `201 {batch}` |
| GET | `/api/batches/:id` | 🔒 farm access | → `{batch}` (`daily: []` until stage 6) |
| PUT | `/api/batches/:id` | 🔒✎ `batches.manage` + access | full batch body → `{batch}` |
| DELETE | `/api/batches/:id` | 🔒✎ `batches.manage` + access | → `204` · 409 `BATCH_ACTIVE` |
| GET | `/api/batches/:id/inspections` | 🔒 `health.view` + access | → `{inspections}` |
| POST | `/api/batches/:id/inspections` | 🔒✎ `inspections.record` + access | `{observedOn, healthStatus, observation}` → `201 {inspection}` |
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
`batch.create|update|delete`, `inspection.create`, `access.denied`.

## Connecting a deployed frontend (Vercel)

1. Host this API on HTTPS (a VM/container; Vercel cannot run it or, later, Hadoop/Hive).
2. API `.env`: `APP_ENV=production`, `CORS_ALLOWED_ORIGINS=https://<your-site>.vercel.app`,
   `JWT_COOKIE_SAMESITE=None`, `JWT_COOKIE_SECURE=true`, `HSTS_ENABLED=true`,
   `TRUST_PROXY_COUNT=1` if behind a reverse proxy. Run with a WSGI server, e.g. gunicorn.
3. Vercel env: `VITE_API_BASE_URL=https://<api-domain>/api`, `VITE_DEMO_MODE=false`; redeploy.

Browsers that block third-party cookies may refuse cross-site cookies; serving the API from a
sub-domain of the frontend's site (or proxying `/api` through the frontend host) avoids that.
