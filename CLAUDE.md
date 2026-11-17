# CLAUDE.md: Polutary Analytics

Instructions for Claude (and for human contributors) working in this repository.

## 1. Project objectives

Polutary Analytics is an **Apache Hive-based predictive analytics system for poultry farming**. It's a student-level CSE engineering project. It must provide:

- Poultry farm management (farms, flocks/batches, users)
- CSV dataset upload, validation and preprocessing
- Distributed storage of processed datasets in **Hadoop HDFS**
- An analytical database in **Apache Hive**, queried with **real HiveQL**
- Machine Learning predictions (Random Forest, Decision Tree, Linear Regression, and ARIMA where a time series makes it appropriate)
- An interactive analytics dashboard (Chart.js)
- Authentication and role-based access control
- Audit logging of security-relevant and data-changing actions
- CSV and PDF report export

## 2. Non-negotiable academic integrity rules

These rules override convenience. Never break them, even temporarily, even "for demo purposes".

1. **No fake APIs.** Every endpoint the frontend calls must be implemented and return real data.
2. **Do not simulate Hadoop or Hive.** No mocks, stubs or in-memory fakes standing in for HDFS/Hive in the running app.
3. **Do not replace Hive with SQLite.** SQLite only stores *application* data (users, roles, farms, upload metadata, audit log). All analytics run as HiveQL on Hive.
4. **HDFS must actually store processed datasets.** Python must write them to HDFS (WebHDFS) and Hive tables must read from those HDFS locations.
5. **Python must retrieve real Hive query results** through PyHive / HiveServer2.
6. **Do not fabricate ML results.** Metrics must come from running evaluation code on a held-out split. Never hand-write accuracy, RMSE, etc.
7. **Do not invent datasets.** Every dataset must have a documented real source in `docs/research/datasets.md`. Never generate random data and present it as real.
8. **Predictions are not diagnoses.** UI text, reports and docs must never claim predictions are verified poultry disease diagnoses. Show a disclaimer wherever predictions appear.
9. If a real dependency (Docker, Hive, a dataset) is unavailable, **stop and report it** instead of working around it with a fake.

Test code *may* use mocks for unit-level isolation, but the app itself and the integration tests must use the real services.

## 3. Architecture

```
Browser ── apps/web (Vite, Bootstrap 5, Chart.js, vanilla JS)
   │  JSON over HTTP, proxied via /api in development
   ▼
apps/api (Flask, Flask REST, SQLAlchemy)
   ├── SQLite              application data: users, roles, farms, uploads, audit log
   ├── pandas              CSV validation + preprocessing
   ├── WebHDFS ─► HDFS     /polutary/raw, /polutary/processed
   ├── PyHive  ─► Hive     external tables over HDFS; HiveQL analytics
   └── apps/ml artifacts   trained models loaded for predictions
apps/ml (pandas, NumPy, scikit-learn, statsmodels)
   └── trains on Hive query results, writes models + evaluation reports
infrastructure/hadoop-hive (Docker Compose: NameNode, DataNode, Metastore, HiveServer2)
```

Data flow: **upload CSV → validate → preprocess → write to HDFS → Hive external table/partition → HiveQL analytics → dashboard/reports → ML training on Hive results → predictions.**

## 4. Folder responsibilities

| Path | Responsibility |
|------|----------------|
| `apps/web` | Frontend. Vite dev server and build, Bootstrap 5 UI, Chart.js charts. Plain JavaScript, no framework. |
| `apps/api` | Flask REST API. Python package `poultry_api` in `src/`, tests in `tests/`. SQLite file in `apps/api/instance/` (git-ignored). |
| `apps/ml` | ML pipelines. Python package `poultry_ml` in `src/`. Trained artifacts in `models/` (git-ignored). |
| `packages/shared-config` | Shared configuration (base `ruff.toml`). |
| `infrastructure/hadoop-hive` | Docker Compose and config for the real Hadoop + Hive cluster. |
| `data/raw` | Original uploaded/downloaded CSVs (git-ignored). |
| `data/processed` | Locally preprocessed CSVs before/after HDFS upload (git-ignored). |
| `data/sample` | Small, documented, real sample data that may be committed. |
| `docs/architecture` | Architecture diagrams, ADRs. |
| `docs/research` | Dataset register, literature notes, model evaluation reports. |
| `docs/testing` | Test plans and results. |
| `scripts` | Developer utility scripts (environment checks, setup helpers). |
| `.github/workflows` | CI (lint, test, build). |

## 5. Technology stack (pinned)

- **Monorepo:** Bun 1.4.4 (workspaces), Turborepo 2.11.11
- **Frontend:** HTML5, CSS3, Bootstrap 5.3.9, Chart.js 4.6.1, Vite 8.3.8, vanilla JS (ES modules)
- **Backend:** Python 3.12, Flask 3.1.3, Flask-SQLAlchemy 3.1.1, SQLAlchemy 2.0.58, python-dotenv 1.2.4
- **Big Data:** Apache Hadoop (HDFS), Apache Hive (HiveServer2), PyHive 0.7.0 with thrift 0.25.0, thrift-sasl 0.4.3, pure-sasl 0.6.2
- **ML:** pandas 3.1.1, NumPy 2.5.5, scikit-learn 1.9.1, statsmodels 0.15.0 (ARIMA), joblib 1.6.0
- **Tooling:** uv (Python envs/locks), pytest 9.2.0, Ruff 0.17.5

Pin exact versions. Before adding a dependency, check that it's really needed. Prefer the standard library or something already in the stack.

## 6. How the monorepo works

- Bun workspaces: `apps/*`, `packages/*`.
- Every app has a `package.json` so Turborepo can run its tasks. For the Python apps, that `package.json` only wraps `uv` commands (`setup`, `lint`, `test`). **The Python apps never depend on Bun.** Each is a standalone `pyproject.toml` project with its own `.venv` and `uv.lock`.
- Turbo tasks: `setup` (uncached), `build`, `lint`, `test`, `dev` (persistent, uncached).
- The frontend runs Vite on the Bun runtime (`bunx --bun vite`), so Node.js isn't required.

## 7. Development conventions

- **Python:** PEP 8 via Ruff (base config in `packages/shared-config/ruff.toml`, line length 100). Type hints on public functions. Flask app factory pattern (`create_app()`), blueprints per domain (`auth`, `farms`, `uploads`, `analytics`, `predictions`, `reports`, `audit`). Config only from environment variables (`.env`), never hard-coded.
- **SQL/HiveQL:** keep HiveQL in dedicated query modules, not inline in route handlers. Always use parameterised values or strict allow-lists for identifiers. Never build queries by concatenating user input.
- **JavaScript:** ES modules, one module per page/feature, `fetch` wrapper in a single API client module. No inline scripts in HTML.
- **API:** JSON responses, consistent error shape `{"error": {"code": ..., "message": ...}}`, all routes under `/api`.
- **Git:** small focused commits, imperative mood messages (`Add CSV schema validator`). Don't commit `.env`, datasets in `data/raw|processed`, SQLite files, or model artifacts.
- **Stages:** build only the current stage. Don't scaffold placeholder endpoints for future stages.

## 8. Installation

```bash
./scripts/check-env.sh        # verify bun, uv, python3.12, git, docker
cp .env.example .env          # set SECRET_KEY etc.
bun install
bun run setup                 # uv sync in apps/api and apps/ml
```

Hadoop/Hive (from stage 7): `docker compose -f infrastructure/hadoop-hive/docker-compose.yml up -d`.

## 9. Testing

```bash
bun run lint                  # ruff check + format check
bun run test                  # pytest in every Python app
cd apps/api && uv run pytest  # one app, without Bun
```

- Unit tests sit next to each app in `tests/`.
- Integration tests that need HDFS/Hive are marked `@pytest.mark.integration` and run against the real Docker cluster.
- ML tests check the pipeline mechanics (shapes, no train/test leakage, reproducibility with a fixed seed). They must not assert hard-coded "expected" accuracy numbers that weren't measured.

## 10. Security requirements

- Passwords hashed with a strong algorithm (Werkzeug `generate_password_hash`, scrypt/pbkdf2). Never stored or logged in plain text.
- Session/auth secrets only from `SECRET_KEY` in the environment. `.env` is never committed.
- Role-based access control (e.g. `admin`, `farm_manager`, `analyst`) enforced server-side on every protected endpoint.
- CSV uploads: extension + MIME check, size limit (`MAX_UPLOAD_MB`), schema validation, `secure_filename`, stored outside any web-served directory.
- Parameterised SQL (SQLAlchemy) and HiveQL. Allow-list for any dynamic identifiers.
- Audit log for logins (success and failure), uploads, deletions, role changes and report exports.
- CORS restricted to `CORS_ALLOWED_ORIGINS`. Security headers on responses.
- No secrets, tokens or credentials in code, commits, logs or error messages.

## 11. Development roadmap

1. ✅ Monorepo initialization
2. Frontend scaffold (layout, pages, API client)
3. Flask backend scaffold (app factory, config, health endpoint, error handling)
4. SQLite database (models, migrations/initialisation)
5. Authentication + roles
6. CSV ingestion (upload, validation, preprocessing)
7. Hadoop integration (Docker Compose, HDFS writes via WebHDFS)
8. Hive integration (PyHive connection, external tables over HDFS)
9. HiveQL analytics (mortality, feed conversion, weight gain, production trends)
10. Machine Learning (training, evaluation, model registry, prediction API)
11. Dashboard integration (Chart.js)
12. Security hardening
13. Testing (unit + integration against real services)
14. Documentation (architecture, user guide, academic report material)

Finish and verify each stage, and get the user's approval, before starting the next.
