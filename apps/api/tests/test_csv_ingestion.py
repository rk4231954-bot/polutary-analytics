"""Unit tests for CSV validation and preprocessing (pure functions, no Flask app)."""

from __future__ import annotations

from datetime import date

import pytest

from app.services.csv_ingestion import CsvFormatError, FarmContext, decode, ingest, parse_csv
from app.services.csv_schema import OUTPUT_COLUMNS, auto_map

TODAY = date(2026, 11, 18)
HEADER = "date,farm_code,batch_code,temperature_c,humidity_pct,feed_kg,mortality,bird_count"


def farms(selected=None, batches=None):
    return FarmContext({"F-001": 1, "F-002": 2}, selected, batches or {"F-001": {"B-001"}})


def run(text: str, mapping=None, context=None):
    return ingest(text.encode("utf-8"), mapping, context or farms(), TODAY)


def codes(result, bucket="errors"):
    return {item["code"] for item in result.report[bucket]}


def lines_for(result, code):
    item = next(i for i in result.report["errors"] if i["code"] == code)
    return [e["line"] for e in item["examples"]]


# --- Happy path -------------------------------------------------------------------
def test_valid_file_is_processed_into_the_standard_schema():
    result = run(
        f"{HEADER}\n"
        "2026-10-02,F-001,B-001,30.5,62,130,1,1197\n"
        "2026-10-01,F-001,B-001,31.2,65,120.5,3,1198\n"
    )
    assert result.ok, result.report["errors"]
    assert result.farm_code == "F-001"
    assert list(result.processed.columns) == list(OUTPUT_COLUMNS)
    # sorted by date; source_line keeps the link to the original file
    assert result.processed["date"].tolist() == ["2026-10-01", "2026-10-02"]
    assert result.processed["source_line"].tolist() == [3, 2]
    assert result.processed["feed_kg"].tolist() == [120.5, 130.0]
    assert result.processed["mortality"].tolist() == [3, 1]
    summary = result.report["summary"]
    assert (summary["totalRows"], summary["acceptedRows"], summary["rejectedRows"]) == (2, 2, 0)
    assert summary["dateRange"] == {"from": "2026-10-01", "to": "2026-10-02"}
    assert result.report["errors"] == []


def test_missing_readings_stay_missing_and_are_never_filled_in():
    result = run(f"{HEADER}\n2026-10-01,F-001,B-001,NA,,120,null,1198\n")
    assert result.ok
    row = result.processed.iloc[0]
    assert row.isna()[["temperature_c", "humidity_pct", "mortality", "water_l"]].all()
    assert row["feed_kg"] == 120.0
    assert {"missing_temperature_c", "missing_humidity_pct", "missing_mortality"} <= codes(
        result, "warnings"
    )
    assert "missing_tokens" in codes(result, "transformations")


def test_whitespace_case_and_time_are_normalised_and_reported():
    result = run(f"{HEADER}\n 2026-10-01T08:30:00 , f-001 ,b-001,30,60,100,0,1000\n")
    assert result.ok
    row = result.processed.iloc[0]
    assert (row["date"], row["farm_code"], row["batch_code"]) == ("2026-10-01", "F-001", "B-001")
    assert {"whitespace_trimmed", "codes_uppercased", "time_dropped"} <= codes(
        result, "transformations"
    )


def test_semicolon_delimiter_and_quoted_fields():
    text = 'date;farm_code;batch_code;notes\n2026-10-01;F-001;B-001;"multi\nline; note"\n'
    result = run(text)
    assert result.ok
    assert result.report["summary"]["delimiter"] == ";"
    assert result.report["summary"]["ignoredColumns"] == ["notes"]


def test_auto_mapping_uses_header_aliases():
    headers = ["Record Date", "Farm", "Flock", "Temperature (°C)", "Deaths", "Live Birds", "x"]
    assert auto_map(headers) == {
        "date": "Record Date",
        "farm_code": "Farm",
        "batch_code": "Flock",
        "temperature_c": "Temperature (°C)",
        "mortality": "Deaths",
        "bird_count": "Live Birds",
    }


# --- Row-level errors ------------------------------------------------------------
@pytest.mark.parametrize(
    ("row", "code"),
    [
        ("2026-13-01,F-001,B-001,30,60,100,0,1000", "invalid_date:date"),
        ("01/10/2026,F-001,B-001,30,60,100,0,1000", "invalid_date:date"),
        ("2026-12-25,F-001,B-001,30,60,100,0,1000", "future_date:date"),
        ("2026-10-01,F-001,B-001,abc,60,100,0,1000", "not_a_number:temperature_c"),
        ("2026-10-01,F-001,B-001,30°C,60,100,0,1000", "not_a_number:temperature_c"),
        ("2026-10-01,F-001,B-001,1e2,60,100,0,1000", "not_a_number:temperature_c"),
        ("2026-10-01,F-001,B-001,75,60,100,0,1000", "out_of_range:temperature_c"),
        ("2026-10-01,F-001,B-001,30,101,100,0,1000", "out_of_range:humidity_pct"),
        ("2026-10-01,F-001,B-001,30,60,-5,0,1000", "out_of_range:feed_kg"),
        ("2026-10-01,F-001,B-001,30,60,100,1.5,1000", "not_whole_number:mortality"),
        ("2026-10-01,F-001,B 001,30,60,100,0,1000", "invalid_code:batch_code"),
        (",F-001,B-001,30,60,100,0,1000", "missing_required:date"),
        ("2026-10-01,F-001,,30,60,100,0,1000", "missing_required:batch_code"),
        ("2026-10-01,F-999,B-001,30,60,100,0,1000", "unknown_farm:farm_code"),
        ("2026-10-01,F-001,B-001,30,60", "wrong_field_count"),
    ],
)
def test_invalid_rows_are_rejected_with_a_reason(row, code):
    result = run(f"{HEADER}\n2026-10-01,F-001,B-001,30,60,100,0,1000\n{row}\n")
    assert code in codes(result)
    assert result.ok  # the valid row is still processed
    assert result.report["summary"]["acceptedRows"] == 1
    assert [r["line"] for r in result.rejected] == [3]
    assert result.rejected[0]["errors"]
    assert 3 not in result.processed["source_line"].tolist()


def test_line_numbers_account_for_blank_lines_and_multiline_fields():
    text = (
        "date,farm_code,batch_code,notes\n"
        "\n"
        '2026-10-01,F-001,B-001,"two\nlines"\n'
        "2026-10-02,F-001,bad code,x\n"
    )
    result = run(text)
    assert result.report["summary"]["blankRowsSkipped"] == 1
    assert lines_for(result, "invalid_code:batch_code") == [5]


def test_errors_are_grouped_per_field():
    result = run(
        f"{HEADER}\n2026-10-01,F-001,B-001,99,60,100,0,1000\n2026-10-02,F-001,B-001,30,120,100,0,1000\n"
    )
    messages = {i["code"]: i["message"] for i in result.report["errors"]}
    assert "Temperature" in messages["out_of_range:temperature_c"]
    assert "Humidity" in messages["out_of_range:humidity_pct"]


# --- Duplicates ------------------------------------------------------------------
def test_exact_duplicates_are_removed_and_reported():
    row = "2026-10-01,F-001,B-001,30,60,100,0,1000"
    result = run(f"{HEADER}\n{row}\n{row}\n 2026-10-01 ,f-001,B-001,30.0,60,100,0,1000\n")
    assert result.ok
    assert len(result.processed) == 1
    assert result.report["summary"]["duplicateRowsRemoved"] == 2
    dup = next(w for w in result.report["warnings"] if w["code"] == "duplicate_row")
    assert [e["line"] for e in dup["examples"]] == [3, 4]


def test_conflicting_duplicates_are_all_rejected():
    result = run(
        f"{HEADER}\n2026-10-01,F-001,B-001,30,60,100,0,1000\n"
        "2026-10-01,F-001,B-001,31,60,100,0,1000\n2026-10-02,F-001,B-001,30,60,100,0,1000\n"
    )
    assert result.ok
    assert sorted(lines_for(result, "conflicting_duplicate")) == [2, 3]
    assert result.processed["date"].tolist() == ["2026-10-02"]


# --- Farms and batches -----------------------------------------------------------
def test_rows_for_another_farm_are_rejected_when_a_farm_is_selected():
    result = run(
        f"{HEADER}\n2026-10-01,F-001,B-001,30,60,100,0,1000\n2026-10-01,F-002,B-001,30,60,100,0,1000\n",
        context=farms(selected="F-001"),
    )
    assert result.ok and result.farm_code == "F-001"
    assert lines_for(result, "farm_mismatch:farm_code") == [3]


def test_a_file_with_several_farms_fails_without_a_selected_farm():
    result = run(
        f"{HEADER}\n2026-10-01,F-001,B-001,30,60,100,0,1000\n2026-10-01,F-002,B-001,30,60,100,0,1000\n"
    )
    assert not result.ok
    assert "multiple_farms" in codes(result)
    assert "2 farms" in result.error


def test_unregistered_batches_and_implausible_mortality_are_warnings():
    result = run(f"{HEADER}\n2026-10-01,F-001,B-NEW,30,60,100,50,20\n")
    assert result.ok
    assert {"unregistered_batch", "mortality_exceeds_birds"} <= codes(result, "warnings")
    assert result.report["summary"]["batches"] == [
        {"code": "B-NEW", "rows": 1, "registered": False}
    ]


def test_no_valid_rows_fails():
    result = run(f"{HEADER}\nnot-a-date,F-001,B-001,30,60,100,0,1000\n")
    assert not result.ok
    assert "no_valid_rows" in codes(result)
    assert len(result.rejected) == 1


# --- Schema / mapping ------------------------------------------------------------
def test_missing_required_column_fails_the_file():
    result = run("date,farm_code,temperature_c\n2026-10-01,F-001,30\n")
    assert not result.ok
    assert "required_column_missing" in codes(result)
    assert result.processed is None


def test_explicit_mapping_is_checked():
    text = "Day,Farm,Batch,Temp\n2026-10-01,F-001,B-001,30\n"
    ok = run(
        text, {"date": "Day", "farm_code": "Farm", "batch_code": "Batch", "temperature_c": "Temp"}
    )
    assert ok.ok and ok.processed["temperature_c"].tolist() == [30.0]
    missing = run(text, {"date": "Day", "farm_code": "Farm", "batch_code": "Nope"})
    assert "column_not_found" in codes(missing)
    twice = run(text, {"date": "Day", "farm_code": "Farm", "batch_code": "Farm"})
    assert "column_mapped_twice" in codes(twice)


def test_duplicate_header_names_are_ambiguous():
    result = run("date,farm_code,batch_code,batch_code\n2026-10-01,F-001,B-001,B-002\n")
    assert "ambiguous_column" in codes(result)


# --- Unreadable files ------------------------------------------------------------
@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"", "empty"),
        (b"date,farm\x00code\n", "binary"),
        ("date,ferme\n2026-10-01,é\n".encode("latin-1"), "UTF-8"),
    ],
)
def test_decode_rejects_unreadable_files(data, message):
    with pytest.raises(CsvFormatError, match=message):
        decode(data)


def test_parse_rejects_header_only_and_broken_quotes():
    with pytest.raises(CsvFormatError, match="no data rows"):
        parse_csv("date,farm_code,batch_code\n")
    with pytest.raises(CsvFormatError, match="Malformed"):
        parse_csv('date,farm_code\n2026-10-01,"F-001\n')


def test_utf8_bom_is_accepted():
    result = ingest(
        "﻿date,farm_code,batch_code\n2026-10-01,F-001,B-001\n".encode(), None, farms(), TODAY
    )
    assert result.ok
    assert result.report["summary"]["headers"][0] == "date"
