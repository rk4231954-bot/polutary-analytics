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
