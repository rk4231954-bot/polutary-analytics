# apps/ml: machine learning

Trains and evaluates models (Random Forest, Decision Tree, Linear Regression, and ARIMA for time series) on documented datasets. Training data comes from real Hive query results. Saved models go in `models/`, which git ignores.

```bash
cd apps/ml
uv sync
uv run pytest
uv run ruff check .
```

Rules:
- Every model must cite the dataset it was trained on (see `docs/research/`).
- Report evaluation metrics measured on a held-out split. Never hand-write them.
- Predictions are statistical estimates. They are **not** verified poultry disease diagnoses.

Status: scaffold only. Pipelines come in stage 10.
