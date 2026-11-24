"""HiveQL used by the analytics endpoints. Kept out of the route handlers on purpose.

All queries read the cleaned, analysis-ready table poultry_records_cleaned (never
the raw staging table). The SQL text is fully static: user input only reaches
Hive as bound parameters (%(name)s, escaped by PyHive), and nothing is ever
concatenated into the statement.

Farm scope is passed as two parameters:
  all_farms  1 = no farm restriction (administrators), 0 = restrict to `farms`
  farms      comma-separated upper-case farm codes, matched with
             array_contains(split(%(farms)s, ','), UPPER(farm_id)).
Farm codes are validated application codes ([A-Za-z0-9-]), so they never contain commas.

Period windows: "the last N days" is anchored on the most recent record_date in
the (farm-scoped) data, not on today's date, so historical datasets still produce
a meaningful window. Each response reports the actual from/to dates used.
"""

from __future__ import annotations

import re
from typing import Any

from app.config import HIVE_IDENTIFIER_RE

# Documentation/reporting only; the queries below name the table literally.
ANALYTICS_TABLE = "poultry_records_cleaned"

# Upper bound on rows a single analytics query may return (a safety net, not a sample).
MAX_ROWS = 50000

_FARM_CODE_RE = re.compile(r"^[A-Za-z0-9-]{1,40}$")

Query = tuple[str, dict[str, Any]]


def _scope_params(farm_codes: list[str] | None) -> dict[str, Any]:
    if farm_codes is None:
        return {"all_farms": 1, "farms": ""}
    if not farm_codes:
        raise ValueError("farm_codes must be None (all farms) or a non-empty list")
    for code in farm_codes:
        if not _FARM_CODE_RE.match(code):
            raise ValueError(f"invalid farm code: {code!r}")
    return {"all_farms": 0, "farms": ",".join(code.upper() for code in farm_codes)}


DAILY_RECORDS_SQL = """
SELECT t.farm_id AS farm_id,
       t.record_date AS record_date,
       SUM(t.bird_count) AS bird_count,
       SUM(t.mortality_count) AS mortality,
       SUM(t.feed_consumption) AS feed,
       SUM(t.average_weight * t.bird_count) / SUM(t.bird_count) AS avg_weight,
       AVG(t.temperature) AS temperature,
       AVG(t.humidity) AS humidity,
       COUNT(*) AS records
FROM poultry_records_cleaned t
CROSS JOIN (
  SELECT MAX(record_date) AS max_date FROM poultry_records_cleaned
  WHERE %(all_farms)s = 1 OR array_contains(split(%(farms)s, ','), UPPER(farm_id))
) a
WHERE (%(all_farms)s = 1 OR array_contains(split(%(farms)s, ','), UPPER(t.farm_id)))
  AND t.record_date > DATE_SUB(a.max_date, %(days)s)
GROUP BY t.farm_id, t.record_date
ORDER BY record_date, farm_id
LIMIT %(max_rows)s"""


FARM_COMPARISON_SQL = """
WITH w AS (
  SELECT t.farm_id, t.batch_id, t.record_date, t.bird_count, t.mortality_count,
         t.feed_consumption, t.average_weight, t.temperature, t.humidity,
         ROW_NUMBER() OVER (PARTITION BY t.farm_id, t.batch_id ORDER BY t.record_date ASC)
           AS rn_first,
         ROW_NUMBER() OVER (PARTITION BY t.farm_id, t.batch_id ORDER BY t.record_date DESC)
           AS rn_last
  FROM poultry_records_cleaned t
  CROSS JOIN (
    SELECT MAX(record_date) AS max_date FROM poultry_records_cleaned
    WHERE %(all_farms)s = 1 OR array_contains(split(%(farms)s, ','), UPPER(farm_id))
  ) a
  WHERE (%(all_farms)s = 1 OR array_contains(split(%(farms)s, ','), UPPER(t.farm_id)))
    AND t.record_date > DATE_SUB(a.max_date, %(days)s)
)
SELECT farm_id AS farm_id,
       COUNT(DISTINCT batch_id) AS batches,
       COUNT(*) AS records,
       MIN(record_date) AS first_date,
       MAX(record_date) AS last_date,
       SUM(mortality_count) AS deaths,
       SUM(feed_consumption) AS feed,
       SUM(CASE WHEN rn_first = 1 THEN bird_count ELSE 0 END) AS start_birds,
       SUM(CASE WHEN rn_last = 1 THEN bird_count ELSE 0 END) AS latest_birds,
       SUM(CASE WHEN rn_last = 1 THEN average_weight * bird_count ELSE 0 END)
         / SUM(CASE WHEN rn_last = 1 THEN bird_count ELSE 0 END) AS latest_avg_weight,
       AVG(temperature) AS avg_temperature,
       AVG(humidity) AS avg_humidity
FROM w
GROUP BY farm_id
ORDER BY farm_id"""


PERIOD_SUMMARY_SQL = """
WITH scoped AS (
  SELECT farm_id, batch_id, record_date, bird_count, mortality_count,
         feed_consumption, average_weight
  FROM poultry_records_cleaned
  WHERE %(all_farms)s = 1 OR array_contains(split(%(farms)s, ','), UPPER(farm_id))
),
marked AS (
  SELECT s.farm_id, s.batch_id, s.record_date, s.bird_count, s.mortality_count,
         s.feed_consumption, s.average_weight,
         CASE WHEN s.record_date > DATE_SUB(a.max_date, %(days)s) THEN 'current'
              WHEN s.record_date > DATE_SUB(a.max_date, %(days_x2)s) THEN 'previous'
         END AS period
  FROM scoped s CROSS JOIN (SELECT MAX(record_date) AS max_date FROM scoped) a
),
ranked AS (
  SELECT m.*,
         ROW_NUMBER() OVER (PARTITION BY m.period, m.farm_id, m.batch_id
                            ORDER BY m.record_date DESC) AS rn_last
  FROM marked m WHERE m.period IS NOT NULL
)
SELECT period AS period,
       COUNT(DISTINCT farm_id) AS farms,
       COUNT(DISTINCT CONCAT(farm_id, '|', batch_id)) AS batches,
       SUM(feed_consumption) AS feed,
       SUM(mortality_count) AS deaths,
       SUM(bird_count) AS bird_days,
       COUNT(DISTINCT record_date) AS days_with_data,
       MIN(record_date) AS first_date,
       MAX(record_date) AS last_date,
       SUM(CASE WHEN rn_last = 1 THEN bird_count ELSE 0 END) AS latest_birds,
       SUM(CASE WHEN rn_last = 1 THEN average_weight * bird_count ELSE 0 END)
         AS latest_weight_x_birds
FROM ranked
GROUP BY period"""


GROWTH_POINTS_SQL = """
SELECT farm_id AS farm_id,
       batch_id AS batch_id,
       record_date AS record_date,
       SUM(average_weight * bird_count) / SUM(bird_count) AS avg_weight,
       SUM(bird_count) AS bird_count
FROM poultry_records_cleaned
WHERE (%(all_farms)s = 1 OR array_contains(split(%(farms)s, ','), UPPER(farm_id)))
  AND (%(batch)s = '' OR UPPER(batch_id) = %(batch)s)
GROUP BY farm_id, batch_id, record_date
ORDER BY farm_id, batch_id, record_date
LIMIT %(max_rows)s"""


# Alert baselines: for each farm, a least-squares line is fitted to each metric over the
# `baseline_days` days before the farm's latest record day (x = days relative to that
# day, so the intercept is the value the trend predicts for the latest day). The spread
# is the residual standard deviation, sqrt(SSE / (n - 2)). Fitting a trend matters
# because feed per bird rises as birds grow, and house temperature and humidity are
# often changed with flock age; a flat average would flag normal growth as unusual.
ALERT_BASELINE_SQL = """
WITH daily AS (
  SELECT farm_id, record_date,
         SUM(mortality_count) AS deaths,
         SUM(feed_consumption) / SUM(bird_count) AS feed_per_bird,
         AVG(temperature) AS temperature,
         AVG(humidity) AS humidity
  FROM poultry_records_cleaned
  WHERE %(all_farms)s = 1 OR array_contains(split(%(farms)s, ','), UPPER(farm_id))
  GROUP BY farm_id, record_date
),
latest AS (
  SELECT farm_id, MAX(record_date) AS last_date FROM daily GROUP BY farm_id
),
series AS (
  SELECT d.farm_id, l.last_date, DATEDIFF(d.record_date, l.last_date) AS x,
         d.deaths, d.feed_per_bird, d.temperature, d.humidity
  FROM daily d
  JOIN latest l ON d.farm_id = l.farm_id
  WHERE d.record_date >= DATE_SUB(l.last_date, %(baseline_days)s)
),
fit AS (
  SELECT farm_id,
         COUNT(*) AS base_days,
         REGR_SLOPE(deaths, x) AS b_deaths,
         REGR_INTERCEPT(deaths, x) AS a_deaths,
         REGR_SLOPE(feed_per_bird, x) AS b_feed_per_bird,
         REGR_INTERCEPT(feed_per_bird, x) AS a_feed_per_bird,
         REGR_SLOPE(temperature, x) AS b_temperature,
         REGR_INTERCEPT(temperature, x) AS a_temperature,
         REGR_SLOPE(humidity, x) AS b_humidity,
         REGR_INTERCEPT(humidity, x) AS a_humidity
  FROM series
  WHERE x < 0
  GROUP BY farm_id
)
SELECT s.farm_id AS farm_id,
       MAX(s.last_date) AS last_date,
       MAX(f.base_days) AS base_days,
       MAX(CASE WHEN s.x = 0 THEN s.deaths END) AS last_deaths,
       MAX(f.a_deaths) AS expected_deaths,
       SQRT(SUM(CASE WHEN s.x < 0
                     THEN POW(s.deaths - (f.a_deaths + f.b_deaths * s.x), 2) END)
            / (MAX(f.base_days) - 2)) AS sd_deaths,
       MAX(CASE WHEN s.x = 0 THEN s.feed_per_bird END) AS last_feed_per_bird,
       MAX(f.a_feed_per_bird) AS expected_feed_per_bird,
       SQRT(SUM(CASE WHEN s.x < 0
                     THEN POW(s.feed_per_bird
                              - (f.a_feed_per_bird + f.b_feed_per_bird * s.x), 2) END)
            / (MAX(f.base_days) - 2)) AS sd_feed_per_bird,
       MAX(CASE WHEN s.x = 0 THEN s.temperature END) AS last_temperature,
       MAX(f.a_temperature) AS expected_temperature,
       SQRT(SUM(CASE WHEN s.x < 0
                     THEN POW(s.temperature - (f.a_temperature + f.b_temperature * s.x), 2) END)
            / (MAX(f.base_days) - 2)) AS sd_temperature,
       MAX(CASE WHEN s.x = 0 THEN s.humidity END) AS last_humidity,
       MAX(f.a_humidity) AS expected_humidity,
       SQRT(SUM(CASE WHEN s.x < 0
                     THEN POW(s.humidity - (f.a_humidity + f.b_humidity * s.x), 2) END)
            / (MAX(f.base_days) - 2)) AS sd_humidity
FROM series s
JOIN fit f ON s.farm_id = f.farm_id
GROUP BY s.farm_id
ORDER BY farm_id"""


def daily_records(farm_codes: list[str] | None, days: int) -> Query:
    """One row per farm per day: flock size, deaths, feed, weight, temperature, humidity."""
    return DAILY_RECORDS_SQL, {**_scope_params(farm_codes), "days": days, "max_rows": MAX_ROWS}


def farm_comparison(farm_codes: list[str] | None, days: int) -> Query:
    """One row per farm: mortality, feed, latest weight/flock size, climate averages."""
    return FARM_COMPARISON_SQL, {**_scope_params(farm_codes), "days": days}


def period_summary(farm_codes: list[str] | None, days: int) -> Query:
    """Totals for the current period and the period before it (for trend arrows)."""
    return PERIOD_SUMMARY_SQL, {**_scope_params(farm_codes), "days": days, "days_x2": days * 2}


def growth_points(farm_codes: list[str] | None, batch_code: str | None) -> Query:
    """Average body weight per batch per day (bird-weighted if a day has several rows)."""
    return GROWTH_POINTS_SQL, {
        **_scope_params(farm_codes),
        "batch": (batch_code or "").upper(),
        "max_rows": MAX_ROWS,
    }


def alert_baselines(farm_codes: list[str] | None, baseline_days: int) -> Query:
    """Per farm: the latest day's values, the values the trend of the previous
    `baseline_days` days predicts for that day, and the residual standard deviation
    (deaths, feed per bird, temperature, humidity)."""
    return ALERT_BASELINE_SQL, {**_scope_params(farm_codes), "baseline_days": baseline_days}


# --- Uploaded datasets (stage 8) ---------------------------------------------------------
#
# Processed uploads live in HDFS under HDFS_PROCESSED_DIR/farm_id=<f>/upload_id=<u>/records.csv
# (stage 7). One external, partitioned table reads them in place; dropping a partition never
# deletes HDFS data. The HDFS files have no header row, and Hive ignores files starting with
# "_", so _manifest.json is not read as data. Column names and types come from
# csv_schema.output_schema() (code, not user input).
# The table name comes from HIVE_UPLOADS_TABLE, which the config checks against
# HIVE_IDENTIFIER_RE; it is re-checked here before it is placed into the statement.
UPLOADS_TABLE = "poultry_uploads"


def _table(name: str) -> str:
    if not HIVE_IDENTIFIER_RE.match(name):
        raise ValueError("Unsafe Hive table name.")
    return name


def create_uploads_table(table: str, location: str, columns: list[dict[str, str]]) -> Query:
    cols = ",\n    ".join(f"`{c['name']}` {c['type']}" for c in columns)
    sql = f"""
CREATE EXTERNAL TABLE IF NOT EXISTS {_table(table)} (
    {cols}
)
PARTITIONED BY (farm_id INT, upload_id INT)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION %(location)s
TBLPROPERTIES ('serialization.null.format'='')"""
    return sql, {"location": location}


def add_upload_partition(table: str, farm_id: int, upload_id: int, location: str) -> Query:
    sql = f"""
ALTER TABLE {_table(table)} ADD IF NOT EXISTS
PARTITION (farm_id=%(farm_id)s, upload_id=%(upload_id)s) LOCATION %(location)s"""
    return sql, {"farm_id": int(farm_id), "upload_id": int(upload_id), "location": location}


def drop_upload_partition(table: str, farm_id: int, upload_id: int) -> Query:
    sql = f"""
ALTER TABLE {_table(table)} DROP IF EXISTS
PARTITION (farm_id=%(farm_id)s, upload_id=%(upload_id)s)"""
    return sql, {"farm_id": int(farm_id), "upload_id": int(upload_id)}


def count_upload_rows(table: str, farm_id: int, upload_id: int) -> Query:
    sql = f"""
SELECT COUNT(*) AS row_count
FROM {_table(table)}
WHERE farm_id = %(farm_id)s AND upload_id = %(upload_id)s"""  # noqa: S608 (allow-listed name)
    return sql, {"farm_id": int(farm_id), "upload_id": int(upload_id)}


# --- Flock performance reference data (Kaggle "Broiler Performance Index") -----------------
# Literal "%" is written "%%": PyHive always %-formats the statement.
# One row per broiler flock at harvest. There are no dates, farms or batches, so these
# queries are not farm-scoped and are never mixed with poultry_records_cleaned.

FLOCK_COLUMNS: tuple[tuple[str, str], ...] = (
    ("age_days", "DOUBLE"),
    ("body_weight_kg", "DOUBLE"),
    ("harvest_pct", "DOUBLE"),
    ("depletion_pct", "DOUBLE"),
    ("performance_index", "DOUBLE"),
    ("source_line", "INT"),
)


def create_flock_table(table: str, location: str) -> Query:
    cols = ",\n    ".join(f"`{name}` {kind}" for name, kind in FLOCK_COLUMNS)
    sql = f"""
CREATE EXTERNAL TABLE IF NOT EXISTS {_table(table)} (
    {cols}
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION %(location)s"""
    return sql, {"location": location}


def flock_table_exists(table: str) -> Query:
    return "SHOW TABLES LIKE %(name)s", {"name": _table(table)}


def count_flock_rows(table: str) -> Query:
    return f"SELECT COUNT(*) AS row_count FROM {_table(table)}", {}  # noqa: S608 (allow-listed)


def flock_summary(table: str) -> Query:
    sql = f"""
SELECT
    COUNT(*)                                    AS flocks,
    ROUND(AVG(age_days), 2)                     AS avg_age_days,
    ROUND(MIN(age_days), 2)                     AS min_age_days,
    ROUND(MAX(age_days), 2)                     AS max_age_days,
    ROUND(AVG(body_weight_kg), 3)               AS avg_body_weight_kg,
    ROUND(MIN(body_weight_kg), 3)               AS min_body_weight_kg,
    ROUND(MAX(body_weight_kg), 3)               AS max_body_weight_kg,
    ROUND(AVG(depletion_pct), 2)                AS avg_depletion_pct,
    ROUND(MIN(depletion_pct), 2)                AS min_depletion_pct,
    ROUND(MAX(depletion_pct), 2)                AS max_depletion_pct,
    ROUND(AVG(harvest_pct), 2)                  AS avg_harvest_pct,
    ROUND(AVG(performance_index), 1)            AS avg_performance_index,
    ROUND(MIN(performance_index), 1)            AS min_performance_index,
    ROUND(MAX(performance_index), 1)            AS max_performance_index,
    ROUND(CORR(body_weight_kg, performance_index), 3) AS corr_weight_index,
    ROUND(CORR(depletion_pct, performance_index), 3)  AS corr_depletion_index,
    ROUND(CORR(age_days, performance_index), 3)       AS corr_age_index
FROM {_table(table)}"""  # noqa: S608 (allow-listed name, no user input)
    return sql, {}


def flock_depletion_bands(table: str) -> Query:
    sql = f"""
SELECT band, band_order,
       COUNT(*)                              AS flocks,
       ROUND(AVG(body_weight_kg), 3)         AS avg_body_weight_kg,
       ROUND(AVG(age_days), 2)               AS avg_age_days,
       ROUND(AVG(performance_index), 1)      AS avg_performance_index
FROM (
    SELECT body_weight_kg, age_days, performance_index,
           CASE WHEN depletion_pct < 3 THEN 'Below 3%%'
                WHEN depletion_pct < 5 THEN '3%% to 5%%'
                WHEN depletion_pct < 8 THEN '5%% to 8%%'
                ELSE '8%% and above' END     AS band,
           CASE WHEN depletion_pct < 3 THEN 1
                WHEN depletion_pct < 5 THEN 2
                WHEN depletion_pct < 8 THEN 3
                ELSE 4 END                   AS band_order
    FROM {_table(table)}
) banded
GROUP BY band, band_order
ORDER BY band_order"""  # noqa: S608 (allow-listed name, no user input)
    return sql, {}
