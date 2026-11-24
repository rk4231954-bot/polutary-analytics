"""Checks whether the Hive dataset can support a meaningful mortality model.

This is a data-sufficiency check, not a trained model for use: nothing is saved and no
prediction is served. Input is a CSV exported from Hive (poultry_records_cleaned), e.g.

    beeline -u jdbc:hive2://localhost:10000/poultry_analytics -n kiran --outputformat=csv2 \\
      -e "SELECT farm_id, record_date, bird_count, mortality_count, feed_consumption,
          average_weight, temperature, humidity FROM poultry_records_cleaned" -p > rows.csv
    uv run python -m poultry_ml.mortality_feasibility rows.csv

Split: time-ordered per farm (first 7 days train, later days test), so no future data is
used for training. A linear regression is compared with simple baselines; if a trivial
rule matches or beats it, the data does not support a meaningful model.
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error

FEATURES = [
    "day",
    "bird_count",
    "feed_consumption",
    "average_weight",
    "temperature",
    "humidity",
    "prev_deaths",
]
TRAIN_LAST_DAY = 6  # day index 0..6 (7 days) for training


def evaluate(df: pd.DataFrame) -> dict[str, float | int]:
    df = df.sort_values(["farm_id", "record_date"]).copy()
    df["day"] = df.groupby("farm_id").cumcount()
    df["prev_deaths"] = df.groupby("farm_id")["mortality_count"].shift(1)
    rows = df.dropna()
    train, test = rows[rows.day <= TRAIN_LAST_DAY], rows[rows.day > TRAIN_LAST_DAY]
    model = LinearRegression().fit(train[FEATURES], train.mortality_count)
    y = test.mortality_count
    return {
        "rows": len(df),
        "train_rows": len(train),
        "test_rows": len(test),
        "mae_linear_regression": mean_absolute_error(y, model.predict(test[FEATURES])),
        "mae_baseline_train_mean": mean_absolute_error(
            y, np.full(len(y), train.mortality_count.mean())
        ),
        "mae_baseline_previous_day": mean_absolute_error(y, test.prev_deaths),
        "mae_rule_3_minus_previous_day": mean_absolute_error(y, 3 - test.prev_deaths),
    }


def main(path: str) -> int:
    for key, value in evaluate(pd.read_csv(path)).items():
        print(f"{key}: {value:.3f}" if isinstance(value, float) else f"{key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
