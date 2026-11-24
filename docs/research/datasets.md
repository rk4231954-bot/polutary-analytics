# Dataset register

Every dataset used by Polutary Analytics is listed here with its real origin, structure and
limitations (CLAUDE.md, rule 7). An entry only records what can be shown. Anything that's
unknown is marked **unknown** and isn't filled in by guesswork.

| ID | Name | Status | Used by |
|----|------|--------|---------|
| DS-01 | `poultry_records.csv` (2 farms × 10 days) | **Development dataset. Origin of the values not documented.** | Hive tables in `poultry_analytics`, `/api/analytics/*`, `/api/alerts` |

---

## DS-01: `poultry_records.csv`

### Origin (what the evidence shows)

| Item | Finding | Evidence |
|---|---|---|
| Author | Written by the project author in a text editor on the development machine. It wasn't downloaded or exported from a farm system. | Shell history: `nano data/raw/poultry_records.csv`, then `ls -lh` and `head -5` on the same file. No `wget`/`curl`/download of a CSV appears in the history. |
| Created | 2026-11-18, about 18:26 UTC (file modification time) | `data/raw/poultry_records.csv` |
| Source of the values | **Unknown.** Nothing records whether the numbers were copied from real farm records, from a publication, or composed by hand to test the pipeline. | Not recorded anywhere in the repository or history |
| Licence | None stated. Project-internal file. | n/a |
| Copies | `data/raw/poultry_records.csv` (local, git-ignored) and `hdfs:///poultry-analytics/raw/poultry_records.csv` (copied with `hdfs dfs -put -f`). Both have MD5 `83b17b653514cd3a861eaa3358868205` and are 1102 bytes. | `md5sum`, `hdfs dfs -cat … \| md5sum` |

**What this means for the project:** under rule 7, DS-01 can't be presented as a real,
documented poultry dataset. It's suitable for checking that the HDFS → Hive → API → dashboard
pipeline works, and it shouldn't be used to report model accuracy or farm findings. It stays
that way until the author confirms where the values came from (and records the source here)
or replaces it with a dataset whose source is documented.

### How it reaches Hive

All commands below come from `~/.beeline/history`. The tables weren't created by the application.

```
data/raw/poultry_records.csv
  └─ hdfs dfs -put → hdfs:///poultry-analytics/raw/poultry_records.csv
       └─ poultry_records_staging  EXTERNAL TEXTFILE, LOCATION /poultry-analytics/raw (comma-separated)
            └─ CREATE TABLE poultry_records_cleaned STORED AS PARQUET AS SELECT … FROM poultry_records_staging
                 WHERE record_id, farm_id, batch_id IS NOT NULL AND bird_count >= 0 AND mortality_count >= 0
                 → hdfs:///user/hive/warehouse/poultry_analytics.db/poultry_records_cleaned/000000_0
```

| Table | Format / location | Rows | Role |
|---|---|---|---|
| `poultry_records_staging` | external text, `/poultry-analytics/raw` | 20 | raw CSV as read by Hive |
| `poultry_records_cleaned` | Parquet, warehouse dir | 20 (no rows removed by the filter) | **the table every analytics query reads** |
| `poultry_records` | Parquet, warehouse dir (empty directory) | 0 | created first and never loaded. See "The empty `poultry_records` table" below. |

### Structure

The CSV has no header row and ten comma-separated columns. The Hive schema (identical in all
three tables) is:

| Column | Hive type | Meaning | Unit |
|---|---|---|---|
| `record_id` | INT | row number, 1–20 | – |
| `farm_id` | STRING | farm code (`FARM001`, `FARM002`) | – |
| `batch_id` | STRING | flock/batch code (`BATCH001`, `BATCH002`) | – |
| `record_date` | DATE | day of the observation | – |
| `bird_count` | INT | live birds that day | birds |
| `mortality_count` | INT | deaths that day | birds |
| `feed_consumption` | DOUBLE | feed used that day | **assumed kg/day** |
| `average_weight` | DOUBLE | average body weight | **assumed kg** (the API converts it to grams) |
| `temperature` | DOUBLE | house temperature | **assumed °C** |
| `humidity` | DOUBLE | relative humidity | **assumed % RH** |

The units aren't written down anywhere. They're inferred from the magnitudes (for example,
weights of 0.45–0.77 can only be kg). The author should confirm them.

Coverage: 20 rows, 2 farms × 1 batch × 10 consecutive days (2026-01-01 to 2026-01-10). No
missing values, no duplicates.

### Observed properties and limitations

- **Very small:** 20 rows, 2 batches, 10 days. That's far too little for training or evaluating
  the ML models in stage 10 (Random Forest, ARIMA, etc.): any "accuracy" would be meaningless.
- **Very regular series**, more regular than measured farm data usually is:
  - FARM002 feed rises by exactly 1.0 kg every day (55 → 64);
  - FARM002 average weight rises by exactly 0.03 kg every day (0.50 → 0.77);
  - FARM002 deaths alternate 2, 1, 2, 1, …;
  - FARM001 follows a similar near-regular pattern.

  This doesn't prove where the values came from, but it matters for analysis: the trend
  baselines behind `/api/alerts` have an almost-zero spread on these series. That's why
  alerts also need a minimum practical difference (see `apps/api/README.md`).
- **Internally consistent flock counts:** each day's `bird_count` equals the previous day's
  count minus the previous day's deaths, for both farms.
- **Flock age unknown:** the first-day weights (0.45 and 0.50 kg) aren't day-old chick
  weights, so 2026-01-01 isn't the hatch or placement date. Without a registered batch start
  date, the growth endpoint counts age from the first record (`ageBasis: "first_record"`).
- **No breed, sex, housing type, feed type or location** information.
- **Farm codes vs the app:** Hive farm codes are matched to `Farm.code` in the application
  database. `FARM002` isn't registered in the app, so only administrators see it (shown by its
  code).

### The empty `poultry_records` table

Finding: **intentionally unused, left over from the first attempt; not a broken pipeline.**

- It was created first (`CREATE TABLE poultry_records (…) STORED AS PARQUET`). The history has
  no `INSERT` or `LOAD DATA` for it.
- The data was then loaded the other way: an external staging table over the raw CSV, followed
  by a CTAS into `poultry_records_cleaned`. So the cleaned table took over the role
  `poultry_records` was meant to have.
- No application code reads `poultry_records`. Every query in
  `apps/api/app/services/hive_queries.py` uses `poultry_records_cleaned` (a unit test checks
  this).

The table and its empty directory have been left as they are (nothing was dropped or
recreated). If it's no longer wanted it can be dropped later with the author's approval, or
it can become the target of the stage 7–8 load (below).

### Related gap: app uploads don't reach Hive yet

The application's CSV upload (stage 6, `POST /api/datasets`) validates and preprocesses files
into `data/processed/` on the local disk only. Writing them to HDFS (stage 7) and adding them
to a Hive table (stage 8) isn't built yet, so anything uploaded through the app doesn't
appear in the analytics. Today the analytics only show DS-01, which was loaded by hand as
described above. Building the upload → HDFS → Hive path would give that pipeline a real target
table. Adding a dataset with a documented source would make the analytics meaningful.

### Can DS-01 train a mortality model? (checked 2026-11-24)

**No.** The check is reproducible with `apps/ml/src/poultry_ml/mortality_feasibility.py`,
run on the 20 rows exported from Hive `poultry_records_cleaned`:

- Split: time-ordered per farm. Days 2–7 are used for training (day 1 has no previous
  day), days 8–10 for testing.
- Features: day, birds, feed, weight, temperature, humidity, previous day's deaths.
- Target: daily deaths.

| Predictor | MAE (deaths/day) on the 6 held-out days |
|---|---|
| Linear regression | 0.315 |
| Mean of the training days | 0.528 |
| Previous day's deaths | 1.000 |
| Rule "3 − previous day's deaths" (no model) | **0.000** |

There are only 12 training rows and 6 test rows, and a one-line rule predicts the test days
perfectly. The deaths simply alternate 2, 1, 2, 1. A model would learn that artificial pattern,
and any accuracy figure would mean nothing. For that reason, no mortality model was trained
for use, saved or served, and the app shows no predictions. (The Predictions page is still a
labelled preview.) A real model needs a dataset with a documented source and many batches.

### To do before stage 10 (ML)

1. The author confirms the origin of DS-01's values and its units, and records them above.
   If the values were composed for testing, mark DS-01 as a test fixture.
2. Add at least one dataset with a documented real source (publisher, URL, licence, collection
   period, column dictionary) as a new entry in this register.
