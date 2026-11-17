# polutary-analytics

**An Apache Hive-based predictive analytics system for poultry farming.** This is an academic CSE engineering project.

Farm managers upload poultry production CSV files. The system validates and preprocesses them, stores them in **Hadoop HDFS**, analyses them with real **HiveQL** queries on **Apache Hive**, and trains **scikit-learn / statsmodels** models on the query results. Results appear in a Bootstrap + Chart.js dashboard, with authentication, role-based access, audit logging and CSV/PDF reports.

> Predictions are statistical estimates from documented datasets. They are **not** verified veterinary or disease diagnoses.

## Status

Stage 1 (monorepo initialization) is done. The app features come in later stages; see the roadmap in [CLAUDE.md](CLAUDE.md).

## Repository layout

```
apps/web                    Vite + Bootstrap 5 + Chart.js frontend
apps/api                    Flask REST API (SQLAlchemy/SQLite, HDFS, PyHive)
apps/ml                     ML training and evaluation (pandas, scikit-learn, statsmodels)
packages/shared-config      Shared lint/format config (Ruff base config)
infrastructure/hadoop-hive  Docker Compose for HDFS + Hive (stage 7)
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
```

## Common commands

```bash
bun run dev     # start dev servers (currently the Vite frontend, at http://localhost:5173)
bun run lint    # ruff on the Python apps
bun run test    # pytest on the Python apps
bun run build   # production build of the frontend
```

Each Python app also works on its own without Bun: `cd apps/api && uv sync && uv run pytest`.
