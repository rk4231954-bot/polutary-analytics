# polutary-analytics

**An Apache Hive-based predictive analytics system for poultry farming.** This is an academic CSE engineering project.

Farm managers upload poultry production CSV files. The system validates and preprocesses them, stores them in **Hadoop HDFS**, analyses them with real **HiveQL** queries on **Apache Hive**, and trains **scikit-learn / statsmodels** models on the query results. Results appear in a Bootstrap + Chart.js dashboard, with authentication, role-based access, audit logging and CSV/PDF reports.

> Predictions are statistical estimates from documented datasets. They are **not** verified veterinary or disease diagnoses.

## Status

| Stage | State |
|---|---|
| 1–6: monorepo, frontend, Flask API, SQLite, auth + roles, CSV ingestion | done |
| 7: processed uploads written to HDFS (WebHDFS, SHA-256 read-back check) | done |
| 8: each upload registered as a partition of the Hive external table `poultry_uploads` (HiveQL row count checked) | done |
| 9: HiveQL analytics: mortality, feed, weight, bird count, environment, farm comparison, trend alerts | done |
| 10: ML | **not deployed.** A feasibility check showed the data can't support a model (see below). Prediction pages are labelled *Preview*. |
| 11: dashboard (Chart.js on real Hive results) | done |

The dashboard figures come from `poultry_analytics.poultry_records_cleaned` (dataset DS-01).
Uploaded CSVs are stored in HDFS and queryable in Hive, but they aren't merged into the
dashboard figures yet. The roadmap is in [CLAUDE.md](CLAUDE.md).

## Dataset

**DS-01, `poultry_records.csv`:** 20 daily records (2 farms × 10 days, 2026-01-01 to
2026-01-10). Columns: farm, batch, date, bird count, mortality, feed, water, average weight,
temperature and humidity. It's a **development dataset typed by the project author. The
origin of its values is not documented.** It is not a Kaggle, public or real-farm dataset, and
the UI labels it that way. It proves that the pipeline works, not that the farm findings are
real. Full evidence and limitations: [`docs/research/datasets.md`](docs/research/datasets.md).
No image data is used.

## Technologies

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Bootstrap 5.3, Chart.js 4.6, Vite 8, vanilla JS (ES modules) |
| Backend | Python 3.12, Flask 3.1, SQLAlchemy 2.0 + SQLite (app data only), Flask-JWT-Extended, Argon2id |
| Big data | Apache Hadoop 3.4.2 HDFS (WebHDFS), Apache Hive 4.1.0 / HiveServer2, PyHive |
| Data / ML | pandas, NumPy, scikit-learn, statsmodels |
| Tooling | Bun workspaces, Turborepo, uv, pytest, Ruff |

## Algorithms actually implemented

- **CSV validation and preprocessing** (pandas): schema and type checks, rejected-row
  report, date and number normalisation, exact-duplicate removal. Nothing is imputed.
- **HiveQL analytics:** `GROUP BY` aggregates, window functions and joins for mortality rate,
  feed per bird, average weight, bird count, temperature and humidity per farm and day.
- **Trend alerts:** a least-squares trend per farm (`REGR_SLOPE` / `REGR_INTERCEPT` in HiveQL).
  The latest value's residual is turned into a z-score, and the alert fires when that z-score
  passes a threshold. These are statistical signals, not diagnoses.
- **ML feasibility check** (`apps/ml`, scikit-learn): linear regression for next-day mortality,
  compared with simple baselines on a time-ordered hold-out split.

## Evaluation metrics (measured, not invented)

The mortality feasibility check used a time-ordered split of DS-01: 12 training rows and
6 held-out days. Results:

| Predictor | MAE (deaths/day) |
|---|---|
| Linear regression | 0.315 |
| Training mean | 0.528 |
| Previous day's value | 1.000 |
| Rule "3 − previous day" | 0.000 |

A fixed rule fits the hold-out data exactly, so the data follows a simple pattern and is too
small to train a meaningful model. **No model is trained or served.** The Predictions and
Model Evaluation pages say so and show no scores.

## Comparison with common approaches (qualitative)

No published results are claimed or compared here, because DS-01 has no documented source.
Compared with keeping farm records in spreadsheets, this system adds:

- server-side validation;
- an audit trail;
- role- and farm-level access control;
- storage that can scale out (HDFS);
- analytics in SQL-on-Hadoop (HiveQL).

On the ML side, the honest comparison is with naive baselines (table above). A model is only
worth deploying when it beats them on real held-out data.

## Future scope

- Replace DS-01 with a poultry dataset whose source is documented (farm records or a
  published dataset with a licence). Then train and evaluate the Random Forest, Decision Tree,
  Linear Regression and ARIMA models on Hive results.
- Merge the uploaded partitions (`poultry_uploads`) into the dashboard analytics.
- Add the prediction API, model registry and report history (CSV/PDF export).
- Run on a multi-node Hadoop cluster with YARN or Tez instead of MapReduce in local mode.
- Add HTTPS deployment and Kerberos for the cluster.

## Repository layout

```
apps/web                    Vite + Bootstrap 5 + Chart.js frontend
apps/api                    Flask REST API (SQLAlchemy/SQLite, HDFS, PyHive)
apps/ml                     ML training and evaluation (pandas, scikit-learn, statsmodels)
packages/shared-config      Shared lint/format config (Ruff base config)
infrastructure/hadoop-hive  HDFS + Hive: run/security docs, HiveServer2 auth provider
data/{raw,processed,sample} Dataset storage (raw/processed are git-ignored)
docs/{architecture,research,testing}
scripts                     Developer utility scripts
.github/workflows           CI
```

## Prerequisites

| Tool    | Version | Purpose                                    |
|---------|---------|--------------------------------------------|
| Bun     | ≥ 1.4   | JS package manager, workspaces, runs Turbo |
| uv      | ≥ 0.11  | Python environments and locked installs    |
| Python  | 3.12    | Flask API and ML                           |
| Hadoop / Hive | 3.4.2 / 4.1.0 | native single-node install (see infrastructure/hadoop-hive) |

Run `./scripts/check-env.sh` to see what's installed.

## Installation

```bash
git clone https://github.com/rk4231954-bot/polutary-analytics.git
cd polutary-analytics
cp .env.example .env          # then set SECRET_KEY and the other values
bun install                   # JS deps + turbo (creates bun.lock)
bun run setup                 # uv sync for apps/api and apps/ml
# create the first administrator (prompts for a password; public sign-up never grants admin)
cd apps/api && uv run flask --app run create-admin --email you@example.org --name "Your Name" && cd ../..
```

## Starting and stopping

Start in this order: **HDFS → HiveServer2 → (Beeline check) → Flask API + frontend**. Stop
in the reverse order. Full commands, checks and troubleshooting:
[`infrastructure/hadoop-hive/README.md`](infrastructure/hadoop-hive/README.md).

```bash
# start
start-dfs.sh                                                   # HDFS
until hdfs dfsadmin -safemode get | grep -q OFF; do sleep 2; done
pgrep -f '[D]proc_hiveserver2' || (cd "$HIVE_HOME" && nohup hive --service hiveserver2 > ~/hiveserver2.out 2>&1 &)
until ss -ltn | grep -q '127.0.0.1\]*:10000 '; do sleep 5; done  # HiveServer2 ready (30–90 s)
bun run dev                                                    # API :5000 + frontend :5173

# stop
#   Ctrl+C in the `bun run dev` terminal
kill -TERM "$(pgrep -f '[D]proc_hiveserver2')"                  # HiveServer2 (graceful)
while pgrep -f '[D]proc_hiveserver2' >/dev/null; do sleep 1; done
stop-dfs.sh                                                    # HDFS
```

The API signs in to HiveServer2 with `HIVE_USERNAME` / `HIVE_PASSWORD` (`HIVE_AUTH=CUSTOM`) from
`apps/api/.env`. If HiveServer2 is down, analytics endpoints return `503 HIVE_UNAVAILABLE`.
If the credentials are wrong, they return `503 HIVE_AUTH_FAILED`. The rest of the app keeps
working.

Open **http://localhost:5173** and sign in. The first API call that runs Hive takes a few
seconds (MapReduce in local mode). `/api/alerts` takes about 15 s.

## 5-minute demo

1. **Login / registration (30 s):** register a new account. It gets the *Analyst* role,
   never admin. Sign out, then sign in as the administrator. A wrong password gives an error
   and is written to the audit log.
2. **Dashboard (1 min):** KPIs, charts, alerts and activity, all from HiveQL. Point out the
   dataset note and the "not a diagnosis" disclaimers.
3. **Big Data Analytics → Hadoop & Hive (45 s):** live HDFS state (NameNode JMX), Hive tables,
   locations and sizes.
4. **Historical Analytics (45 s):** the Mortality, Feed, Growth and Environment tabs, with
   farm-wise HiveQL results.
5. **Data Management → CSV Upload (1 min):** upload a CSV. Show the validation report and
   rejected rows, then the stepper: *processed → HDFS (SHA-256 verified) → Hive partition
   (row count verified)*.
6. **Predictive Analytics (30 s):** the *Preview* labels. No model is trained, and why
   (the MAE table above).
7. **Administration (30 s):**
   - users and roles;
   - farm assignments: an analyst sees only their own farms;
   - audit logs of logins and uploads.

## Common commands

```bash
bun run dev     # Vite frontend (http://localhost:5173) + Flask API (http://127.0.0.1:5000, proxied at /api)
bun run lint    # ruff on the Python apps
bun run test    # pytest (unit) on the Python apps + bun test for the frontend
(cd apps/api && uv run pytest -m integration)   # API tests against the real HiveServer2
bun run build   # production build of the frontend
```

Each Python app also works on its own without Bun: `cd apps/api && uv sync && uv run pytest`.
API endpoints, database schema and security design: [`apps/api/README.md`](apps/api/README.md).
