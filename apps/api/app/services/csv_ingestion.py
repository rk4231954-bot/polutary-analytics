"""CSV validation and preprocessing for daily farm records (pure functions, no Flask).

Pipeline: decode → parse (stdlib csv, exact line numbers) → check the column
mapping → validate every mapped value (pandas, vectorised) → check farm and
batch codes → remove exact duplicates / reject conflicting duplicates →
build the processed table in the fixed output schema.

Rules that keep the data honest:
- Nothing is invented: missing readings stay missing (empty), invalid values
  are never "corrected" or replaced. A row with any error is excluded from the
  processed output and listed, with its reasons, in the rejected rows.
- Every change that *is* made (trimming, upper-casing codes, dropping a time
  part, removing an exact duplicate) is counted in report["transformations"].
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date

import pandas as pd

from app.services.csv_schema import (
    CODE_RE,
    DATE_RE,
    FIELDS,
    FIELDS_BY_KEY,
    KEY_FIELDS,
    MISSING_TOKENS,
    NUMBER_RE,
    OUTPUT_COLUMNS,
    FieldSpec,
    auto_map,
)

MAX_EXAMPLES = 10
INT_MAX = 2_147_483_647  # Hive INT
DELIMITERS = (",", ";", "\t", "|")


class CsvFormatError(ValueError):
    """The file cannot be read as CSV at all."""


@dataclass
class ParsedCsv:
    headers: list[str]
    rows: list[tuple[int, list[str]]]  # (line number in the file, cells)
    delimiter: str
    blank_rows: int


@dataclass
class FarmContext:
    """What the uploading user may write to, resolved by the service layer from SQLite."""

    accessible: dict[str, int]  # farm code (upper-case) → farm id
    selected_code: str | None = None  # farm chosen in the upload form, if any
    batches: dict[str, set[str]] = field(default_factory=dict)  # farm code → batch codes


@dataclass
class IngestionResult:
    ok: bool
    report: dict
    error: str | None = None  # short reason when not ok
    farm_code: str | None = None
    processed: pd.DataFrame | None = None
    rejected: list[dict] = field(default_factory=list)  # {line, errors, raw}


class _Report:
    """Collects issues as {code, message, count, examples[]} grouped by code."""

    def __init__(self) -> None:
        self.buckets: dict[str, dict[str, dict]] = {
            "errors": {},
            "warnings": {},
            "transformations": {},
        }

    def add(self, bucket: str, code: str, message: str, count: int = 1, *, scope="row", **ex):
        if count <= 0:
            return
        items = self.buckets[bucket]
        item = items.setdefault(
            code, {"code": code, "message": message, "count": 0, "examples": []}
        )
        if bucket == "errors":
            item["scope"] = scope
        item["count"] += count
        if ex and len(item["examples"]) < MAX_EXAMPLES:
            item["examples"].append({k: v for k, v in ex.items() if v is not None})

    def has_file_errors(self) -> bool:
        return any(i.get("scope") == "file" for i in self.buckets["errors"].values())

    def as_dict(self) -> dict:
        return {name: list(items.values()) for name, items in self.buckets.items()}


# --- Parsing --------------------------------------------------------------------
def decode(data: bytes) -> str:
    if not data.strip():
        raise CsvFormatError("The file is empty.")
    if b"\x00" in data:
        raise CsvFormatError("The file contains binary data; it is not a CSV text file.")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CsvFormatError(
            f"The file is not valid UTF-8 text (byte {exc.start}). "
            "Save it as 'CSV UTF-8' and upload it again."
        ) from exc


def detect_delimiter(text: str) -> str:
    """Most frequent candidate in the header line (same rule as the frontend)."""
    first_line = text.splitlines()[0] if text else ""
    counts = {d: first_line.count(d) for d in DELIMITERS}
    best = max(DELIMITERS, key=lambda d: counts[d])
    return best if counts[best] > 0 else ","


def parse_csv(text: str) -> ParsedCsv:
    delimiter = detect_delimiter(text)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
    headers: list[str] | None = None
    rows: list[tuple[int, list[str]]] = []
    blank = 0
    previous_end = 0
    while True:
        try:
            cells = next(reader)
        except StopIteration:
            break
        except csv.Error as exc:
            raise CsvFormatError(f"Malformed CSV near line {reader.line_num}: {exc}.") from exc
        start, previous_end = previous_end + 1, reader.line_num
        if not cells or all(c.strip() == "" for c in cells):
            blank += 1
            continue
        if headers is None:
            headers = [c.strip() for c in cells]
        else:
            rows.append((start, cells))
    if headers is None:
        raise CsvFormatError("The file has no header row.")
    if not rows:
        raise CsvFormatError("The file has a header row but no data rows.")
    return ParsedCsv(headers, rows, delimiter, blank)


def _raw_record(cells: list[str], delimiter: str) -> str:
    buffer = io.StringIO()
    csv.writer(buffer, delimiter=delimiter, lineterminator="").writerow(cells)
    return buffer.getvalue()


# --- Mapping --------------------------------------------------------------------
def check_mapping(mapping: dict[str, str], headers: list[str], report: _Report) -> None:
    used: dict[str, str] = {}
    for key, column in mapping.items():
        spec = FIELDS_BY_KEY[key]
        if column not in headers:
            report.add(
                "errors",
                "column_not_found",
                f"Column '{column}' (mapped to {spec.label}) is not in the file.",
                scope="file",
            )
        elif headers.count(column) > 1:
            report.add(
                "errors",
                "ambiguous_column",
                f"The file has more than one column named '{column}'; rename the duplicates.",
                scope="file",
            )
        if column in used:
            report.add(
                "errors",
                "column_mapped_twice",
                f"Column '{column}' is mapped to both {FIELDS_BY_KEY[used[column]].label} "
                f"and {spec.label}.",
                scope="file",
            )
        used[column] = key
    for spec in FIELDS:
        if spec.required and spec.key not in mapping:
            report.add(
                "errors",
                "required_column_missing",
                f"Required column '{spec.key}' ({spec.label}) is missing. {spec.description}",
                scope="file",
            )


# --- Value checks ---------------------------------------------------------------
def _range_text(spec: FieldSpec) -> str:
    unit = f" {spec.unit}" if spec.unit else ""
    if spec.min is not None and spec.max is not None:
        return f"between {spec.min:g} and {spec.max:g}{unit}"
    if spec.min is not None:
        return f"at least {spec.min:g}{unit}"
    return f"at most {spec.max:g}{unit}"


def _clean_field(spec: FieldSpec, raw: pd.Series, today: date, flag, report: _Report):
    """Returns the cleaned column (NA where missing/invalid). Problems are reported via flag()."""
    stripped = raw.str.strip()
    report.add(
        "transformations",
        "whitespace_trimmed",
        "Leading/trailing spaces were removed from values.",
        int((stripped != raw).sum()),
    )
    lowered = stripped.str.lower()
    missing = lowered.isin(MISSING_TOKENS)
    report.add(
        "transformations",
        "missing_tokens",
        f"Placeholders such as NA, null or '-' were treated as missing values "
        f"(recognised: {', '.join(sorted(t for t in MISSING_TOKENS if t))}).",
        int((missing & (stripped != "")).sum()),
    )
    present = ~missing
    if spec.required:
        flag(missing, "missing_required", f"{spec.label} is missing (required).", spec, stripped)

    if spec.type == "code":
        valid = present & stripped.str.fullmatch(CODE_RE.pattern).astype(bool)
        flag(
            present & ~valid,
            "invalid_code",
            f"{spec.label} must be 2-20 letters, numbers or hyphens.",
            spec,
            stripped,
        )
        upper = stripped.str.upper()
        report.add(
            "transformations",
            "codes_uppercased",
            "Farm and batch codes were converted to upper case.",
            int((valid & (upper != stripped)).sum()),
        )
        return upper.where(valid)

    if spec.type == "date":
        date_part = stripped.str.extract(DATE_RE, expand=False)
        parsed = pd.to_datetime(date_part, format="%Y-%m-%d", errors="coerce")
        valid = present & parsed.notna()
        flag(
            present & ~valid,
            "invalid_date",
            f"{spec.label} must be a real calendar date in YYYY-MM-DD format.",
            spec,
            stripped,
        )
        future = valid & (parsed > pd.Timestamp(today))
        flag(future, "future_date", f"{spec.label} is in the future.", spec, stripped)
        valid &= ~future
        report.add(
            "transformations",
            "time_dropped",
            "A time of day was removed from dates (records are daily).",
            int((valid & (date_part.str.len() != stripped.str.len())).sum()),
        )
        return parsed.dt.strftime("%Y-%m-%d").where(valid)

    is_number = present & stripped.str.fullmatch(NUMBER_RE).astype(bool)
    flag(
        present & ~is_number,
        "not_a_number",
        f"{spec.label} must be a plain number (no units, commas or exponents).",
        spec,
        stripped,
    )
    numbers = pd.to_numeric(stripped.where(is_number), errors="coerce")
    valid = is_number & numbers.notna() & (numbers.abs() != float("inf"))
    if spec.type == "integer":
        not_whole = valid & (numbers % 1 != 0)
        flag(not_whole, "not_whole_number", f"{spec.label} must be a whole number.", spec, stripped)
        too_big = valid & (numbers.abs() > INT_MAX)
        flag(too_big, "too_large", f"{spec.label} is too large.", spec, stripped)
        valid &= ~not_whole & ~too_big
    if spec.min is not None:
        below = valid & (numbers < spec.min)
        flag(below, "out_of_range", f"{spec.label} must be {_range_text(spec)}.", spec, stripped)
        valid &= ~below
    if spec.max is not None:
        above = valid & (numbers > spec.max)
        flag(above, "out_of_range", f"{spec.label} must be {_range_text(spec)}.", spec, stripped)
        valid &= ~above
    report.add(
        "transformations",
        "numbers_standardised",
        "Numbers were written in a standard form (e.g. 65 -> 65.0 for decimal fields, "
        "12.0 -> 12 for whole-number fields); their values are unchanged.",
        int(valid.sum()) and 1,
    )
    cleaned = numbers.where(valid)
    return cleaned.astype("Int64") if spec.type == "integer" else cleaned.astype("float64")


# --- Main entry point -----------------------------------------------------------
def ingest(
    data: bytes, mapping: dict[str, str] | None, farms: FarmContext, today: date
) -> IngestionResult:
    report = _Report()
    summary: dict = {
        "totalRows": 0,
        "acceptedRows": 0,
        "rejectedRows": 0,
        "duplicateRowsRemoved": 0,
        "blankRowsSkipped": 0,
    }

    def fail(message: str, code: str = "unreadable_file", rejected=()) -> IngestionResult:
        if not report.has_file_errors():
            report.add("errors", code, message, scope="file")
        return IngestionResult(
            False, {"summary": summary, **report.as_dict()}, error=message, rejected=list(rejected)
        )

    try:
        parsed = parse_csv(decode(data))
    except CsvFormatError as exc:
        return fail(str(exc))

    headers = parsed.headers
    width = len(headers)
    summary.update(
        totalRows=len(parsed.rows),
        blankRowsSkipped=parsed.blank_rows,
        columns=width,
        delimiter={"\t": "tab"}.get(parsed.delimiter, parsed.delimiter),
        headers=headers,
    )
    report.add("warnings", "blank_rows", "Empty lines were skipped.", parsed.blank_rows)

    if not mapping:
        mapping = auto_map(headers)
        report.add(
            "transformations",
            "auto_mapped",
            "Columns were matched to fields automatically by header name.",
        )
    check_mapping(mapping, headers, report)
    summary["mapping"] = mapping
    if report.has_file_errors():
        return fail("The file's columns do not match the required schema.", "schema")
    ignored = [h for h in headers if h not in mapping.values()]
    summary["ignoredColumns"] = ignored
    report.add(
        "transformations",
        "ignored_columns",
        f"Columns not mapped to a field were left out: {', '.join(ignored) or '-'}.",
        1 if ignored else 0,
    )
    renamed = {k: c for k, c in mapping.items() if c != k}
    report.add(
        "transformations",
        "columns_renamed",
        "Columns were renamed to the standard field names: "
        + ", ".join(f"'{c}' -> {k}" for k, c in renamed.items())
        + ".",
        1 if renamed else 0,
    )
    not_provided = [f.key for f in FIELDS if f.key not in mapping]
    summary["fieldsNotProvided"] = not_provided

    # Rows with the wrong number of fields cannot be aligned to columns: reject them.
    errors_by_row: dict[int, list[str]] = {}
    raw_by_line = {line: cells for line, cells in parsed.rows}
    good: list[tuple[int, list[str]]] = []
    for line, cells in parsed.rows:
        if len(cells) == width:
            good.append((line, cells))
            continue
        reason = f"Row has {len(cells)} fields; the header has {width}."
        errors_by_row[line] = [reason]
        report.add(
            "errors",
            "wrong_field_count",
            "Rows with a different number of fields than the header.",
            line=line,
            reason=reason,
        )

    lines = pd.Series([line for line, _ in good], dtype="int64")
    table = pd.DataFrame([cells for _, cells in good], dtype="str")
    clean = pd.DataFrame(index=table.index)

    def flag(mask: pd.Series, code: str, message: str, spec: FieldSpec, values: pd.Series):
        for idx in mask[mask].index:
            line = int(lines[idx])
            errors_by_row.setdefault(line, []).append(message)
            report.add(
                "errors",
                f"{code}:{spec.key}",
                message,
                line=line,
                column=mapping[spec.key],
                value=str(values[idx])[:100],
            )

    for spec in FIELDS:
        column = mapping.get(spec.key)
        if column is None or table.empty:
            clean[spec.key] = pd.Series(pd.NA, index=table.index, dtype="object")
            continue
        clean[spec.key] = _clean_field(spec, table[headers.index(column)], today, flag, report)
    clean["source_line"] = lines

    # Farm: rows must belong to the selected farm, or to a farm the user may upload to.
    farm_codes = clean["farm_code"]
    if farms.selected_code:
        wrong = farm_codes.notna() & (farm_codes != farms.selected_code)
        message = f"Farm code does not match the selected farm ({farms.selected_code})."
        code = "farm_mismatch"
    else:
        wrong = farm_codes.notna() & ~farm_codes.isin(list(farms.accessible))
        message = "Farm code is not a registered farm assigned to you."
        code = "unknown_farm"
    flag(wrong, code, message, FIELDS_BY_KEY["farm_code"], farm_codes)

    is_valid = ~clean["source_line"].isin(list(errors_by_row))
    accepted = clean[is_valid]

    # Exact duplicates (identical after cleaning): keep the first, report the rest.
    value_columns = [c for c in OUTPUT_COLUMNS if c != "source_line"]
    exact = accepted.duplicated(subset=value_columns, keep="first")
    if exact.any():
        first_line = accepted.groupby(value_columns, dropna=False, sort=False)[
            "source_line"
        ].transform("first")
        for idx in exact[exact].index:
            report.add(
                "warnings",
                "duplicate_row",
                "Exact duplicate rows were removed (the first occurrence was kept).",
                line=int(accepted.at[idx, "source_line"]),
                reason=f"Same as line {int(first_line[idx])}",
            )
        summary["duplicateRowsRemoved"] = int(exact.sum())
        report.add(
            "transformations",
            "duplicates_removed",
            "Exact duplicate rows were removed.",
            int(exact.sum()),
        )
    accepted = accepted[~exact]

    # Same date + farm + batch with different readings: we cannot know which one is right.
    conflict = accepted.duplicated(subset=list(KEY_FIELDS), keep=False)
    if conflict.any():
        groups = accepted[conflict].groupby(list(KEY_FIELDS))["source_line"].apply(list)
        for key, group_lines in groups.items():
            for line in group_lines:
                others = ", ".join(str(n) for n in group_lines if n != line)
                reason = (
                    f"Conflicting readings for {key[0]} / {key[1]} / {key[2]} "
                    f"(also on line {others})."
                )
                errors_by_row.setdefault(int(line), []).append(reason)
                report.add(
                    "errors",
                    "conflicting_duplicate",
                    "Rows with the same date, farm and batch but different readings "
                    "were rejected (neither can be chosen automatically).",
                    line=int(line),
                    reason=reason,
                )
        accepted = accepted[~conflict]

    rejected = [
        {
            "line": line,
            "errors": errors_by_row[line],
            "raw": _raw_record(raw_by_line[line], parsed.delimiter),
        }
        for line in sorted(errors_by_row)
    ]
    summary["rejectedRows"] = len(rejected)
    summary["acceptedRows"] = len(accepted)

    resolved = sorted(accepted["farm_code"].dropna().unique())
    if not resolved:
        return fail(
            "No valid rows remain after validation; see the errors below.",
            "no_valid_rows",
            rejected,
        )
    if len(resolved) > 1:
        return fail(
            f"The file contains records for {len(resolved)} farms ({', '.join(resolved)}). "
            "Select one farm or split the file into one file per farm.",
            "multiple_farms",
            rejected,
        )
    farm_code = resolved[0]

    # Warnings on accepted rows (kept as they are).
    for spec in FIELDS:
        if spec.required or spec.key not in mapping:
            continue
        report.add(
            "warnings",
            f"missing_{spec.key}",
            f"{spec.label}: missing values were kept empty (not filled in).",
            int(accepted[spec.key].isna().sum()),
            scope="column",
        )
    registered = farms.batches.get(farm_code, set())
    unknown = sorted(set(accepted["batch_code"]) - registered)
    if unknown:
        shown = ", ".join(unknown[:10]) + (" ..." if len(unknown) > 10 else "")
        report.add(
            "warnings",
            "unregistered_batch",
            f"Batch codes not registered for farm {farm_code} in the app: {shown}. "
            "The rows were kept; register the batches under Farm Management.",
            int(accepted["batch_code"].isin(unknown).sum()),
            scope="column",
        )
    both = accepted["mortality"].notna() & accepted["bird_count"].notna()
    implausible = accepted[both & (accepted["mortality"] > accepted["bird_count"])]
    for _, row in implausible.iterrows():
        report.add(
            "warnings",
            "mortality_exceeds_birds",
            "Daily mortality is higher than the live bird count; please check.",
            line=int(row["source_line"]),
        )

    processed = accepted.sort_values(["date", "batch_code", "source_line"]).reset_index(drop=True)
    processed = processed[list(OUTPUT_COLUMNS)]
    report.add("transformations", "sorted", "Rows were sorted by date and batch code.")
    batches = processed.groupby("batch_code").size()
    summary.update(
        farmCode=farm_code,
        dateRange={"from": processed["date"].min(), "to": processed["date"].max()},
        batches=[
            {"code": c, "rows": int(n), "registered": c in registered} for c, n in batches.items()
        ][:100],
    )
    return IngestionResult(
        True,
        {"summary": summary, **report.as_dict()},
        farm_code=farm_code,
        processed=processed,
        rejected=rejected,
    )
