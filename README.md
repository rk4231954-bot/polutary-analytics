# polutary-analytics

**An Apache Hive-based predictive analytics system for poultry farming.** This is an academic CSE engineering project.

Farm managers upload poultry production CSV files. The system validates and preprocesses them, stores them in **Hadoop HDFS**, analyses them with real **HiveQL** queries on **Apache Hive**, and trains **scikit-learn / statsmodels** models on the query results. Results appear in a Bootstrap + Chart.js dashboard, with authentication, role-based access, audit logging and CSV/PDF reports.

> Predictions are statistical estimates from documented datasets. They are **not** verified veterinary or disease diagnoses.

## Status

Stages 1–6 are done: frontend, Flask API, SQLite app data, authentication and roles, and CSV
ingestion. The dashboard analytics and alerts are computed by HiveQL on a native Hadoop +
Hive install. Uploaded CSVs are written to HDFS (stage 7) but not yet registered in Hive
(stage 8). No ML model is served: the current data can't support one (stage 10).
The roadmap is in [CLAUDE.md](CLAUDE.md). The dataset currently in Hive is a small
development dataset whose origin is still being documented; see
[`docs/research/datasets.md`](docs/research/datasets.md).

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
| Docker  | Compose v2 | Hadoop + Hive cluster (from stage 7)    |

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
