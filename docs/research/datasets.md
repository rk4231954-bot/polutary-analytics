# Dataset register

Every dataset used by Polutary Analytics is listed here with its real origin, structure and
limitations (CLAUDE.md, rule 7). An entry only records what can be shown. Anything that's
unknown is marked **unknown** and isn't filled in by guesswork.

| ID | Name | Status | Used by |
|----|------|--------|---------|
| DS-01 | `poultry_records.csv` (2 farms × 10 days) | **Development dataset. Origin of the values not documented.** | Hive tables in `poultry_analytics`, `/api/analytics/*`, `/api/alerts` |
| DS-02 | Kaggle "Broiler Performance Index", `PS Performance.csv` (327 flocks) | **Public Kaggle dataset, Apache 2.0.** The publisher doesn't say where or when the flocks were raised. | Hive table `flock_performance`, `/api/flock-performance/summary`, dashboard card "Broiler flock benchmarks" |
| (checked, not used) | Kaggle "Environmental Effect on Egg Production", `Egg_Production.csv` | Layer (egg) data, no dates/farms/mortality/weight, 407 of 481 rows are exact duplicates | nothing |

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

### App uploads: HDFS and Hive, not yet the dashboard

The application's CSV upload (`POST /api/datasets`) validates and preprocesses files, copies
them to HDFS under `/polutary/processed` (SHA-256 checked) and registers each one as a partition
of the Hive table `poultry_uploads` (row count checked with HiveQL). The dashboard figures still
come from DS-01 in `poultry_records_cleaned`. Adding a dataset with a documented source would
make the analytics meaningful.

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

---

## DS-02: Kaggle "Broiler Performance Index" (`PS Performance.csv`)

### Source (checked 2026-11-24)

| Item | Finding |
|---|---|
| Page | https://www.kaggle.com/datasets/isazulka/broiler-performance-index |
| Publisher | Kaggle user "isa zulka" (`isazulka`). Dataset version 1, last updated 2024-10-23. |
| Licence | Apache 2.0 (as shown in the Kaggle metadata) |
| Description (verbatim) | Subtitle "Performance Score in Broiler Chickens Before 30days". "Performance Score in Broiler Chickens refers to a numerical assessment of production efficiency and overall performance based on key performance indicators. It helps evaluate flock productivity, health, and profitability." |
| Where/when collected | **Not stated** by the publisher (no country, company, years or method). |
| File | `PS Performance.csv`, 9,840 bytes, SHA-256 `b56fff6a6b877bb32bf1e636aaa229634a6d98fcd62ae6288b1bad9bae50caca`. Downloaded anonymously through the Kaggle API on 2026-11-24 to `data/raw/kaggle/isazulka__broiler-performance-index/` (git-ignored). |

### Columns

The headers are Indonesian. The meanings follow common Indonesian broiler terminology; the
publisher gives no column dictionary.

| Column | Meaning | Unit | Observed range |
|---|---|---|---|
| `Umur` | age at harvest | days | 24.0 to 29.4 |
| `BW` | average body weight | kg | 0.85 to 1.51 |
| `%Panen` | share of the flock harvested | % | 5.74 to 79.77 |
| `Deplesi` | depletion: dead plus culled birds | % of the flock | 1.59 to 15.49 |
| `IP` | Indeks Performa, the European production efficiency factor | index | 226 to 501 |

- 327 rows, one per flock. No blank values. 35 rows are exact duplicates of an earlier row.
  They are kept: two flocks can share the same five rounded figures, and nothing shows they
  are copies.
- **No date, farm, batch, bird count, feed or daily mortality.** So DS-02 can't feed the daily
  schema, the daily dashboard charts or the alerts. Inventing those fields would be
  fabrication.

### How it's used

1. An administrator uploads the file in Data Management → CSV Upload (card "Broiler flock
   benchmarks"), which calls `POST /api/flock-performance`.
2. The API checks the exact header, the numbers and impossible values. Rows that fail are
   rejected and listed; no value is filled in or changed.
3. The rows are written headerless to `HDFS_PROCESSED_DIR/flock_performance/records.csv`,
   read back and compared by SHA-256. `_manifest.json` records the source.
4. The external Hive table `flock_performance` points at that folder. A HiveQL `COUNT(*)` must
   equal the accepted row count.
5. `GET /api/flock-performance/summary` runs two HiveQL queries:
   - averages and ranges, plus Pearson `CORR()` with the performance index;
   - a breakdown by depletion band.
6. The dashboard card shows those figures with the source and licence. They are not mixed
   with DS-01.

### Results from the real cluster (2026-11-24)

The HDFS copy matched the original rows exactly. Every HiveQL figure equalled an independent
Python calculation over the downloaded file.

| Figure | Value |
|---|---|
| Flocks | 327 |
| Average body weight | 1.232 kg (0.85 to 1.51) |
| Average depletion | 3.72 % |
| Average performance index | 360.0 (226 to 501) |
| Correlation with the index: body weight | r = 0.648 |
| Correlation with the index: depletion | r = −0.526 |
| Correlation with the index: age | r = −0.178 |

| Depletion band | Flocks | Average performance index |
|---|---|---|
| Below 3 % | 123 | 393.4 |
| 3 % to 5 % | 165 | 346.1 |
| 5 % to 8 % | 31 | 328.8 |
| 8 % and above | 8 | 254.8 |

The correlations describe association in this dataset only.

**Caveat for ML:** the performance index (EPEF) is *calculated from* liveability (100 −
depletion), body weight and age, plus feed conversion, which isn't in the file. A model that
predicts IP from these columns would mostly rediscover that formula. Its accuracy wouldn't
show real predictive power, so no model was trained on DS-02.

### To do before stage 10 (ML)

1. The author confirms the origin of DS-01's values and its units, and records them above.
   If the values were composed for testing, mark DS-01 as a test fixture.
2. Add at least one dataset with a documented real source (publisher, URL, licence, collection
   period, column dictionary) as a new entry in this register.
