"""Mechanics of the feasibility check (time-ordered split, row counts). The rows below are
a hand-made test fixture, not poultry data, and no accuracy value is asserted."""

import pandas as pd

from poultry_ml.mortality_feasibility import TRAIN_LAST_DAY, evaluate


def fixture(days: int = 10) -> pd.DataFrame:
    rows = []
    for farm in ("A", "B"):
        for d in range(days):
            rows.append(
                {
                    "farm_id": farm,
                    "record_date": f"2026-01-{d + 1:02d}",
                    "bird_count": 100 - d,
                    "mortality_count": d % 3,
                    "feed_consumption": 10.0 + d,
                    "average_weight": 0.5 + d / 100,
                    "temperature": 28.0 + (d % 2),
                    "humidity": 60.0 + d,
                }
            )
    return pd.DataFrame(rows)


def test_split_is_time_ordered_and_counts_rows():
    result = evaluate(fixture())
    # day 0 has no previous day and is dropped; days 1..6 train, 7..9 test, per farm
    assert result["rows"] == 20
    assert result["train_rows"] == 2 * TRAIN_LAST_DAY
    assert result["test_rows"] == 2 * 3


def test_is_deterministic():
    assert evaluate(fixture()) == evaluate(fixture())
