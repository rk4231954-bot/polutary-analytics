import { describe, expect, test } from "bun:test";
import { parseCsv } from "../src/utils/csv.js";
import {
  autoMapColumns, checkValue, EXPECTED_FIELDS, isMissing, isUploadReady, mappingIssues, normaliseHeader,
  parseIsoDate, parseNumber, profileDataset,
} from "../src/utils/datasetProfile.js";

const field = (key) => EXPECTED_FIELDS.find((f) => f.key === key);

describe("helpers", () => {
  test("normaliseHeader", () => {
    expect(normaliseHeader("Temperature (°C)")).toBe("temperature_c");
    expect(normaliseHeader("  Farm ID ")).toBe("farm_id");
  });

  test("isMissing", () => {
    for (const v of ["", " ", "NA", "n/a", "NULL", "NaN", "-", undefined, null]) expect(isMissing(v)).toBe(true);
    for (const v of ["0", "x", "12.5"]) expect(isMissing(v)).toBe(false);
  });

  test("parseNumber is strict", () => {
    expect(parseNumber("12")).toBe(12);
    expect(parseNumber(" -3.5 ")).toBe(-3.5);
    expect(parseNumber(".5")).toBe(0.5);
    for (const v of ["12kg", "1,234", "", "1e3", "abc"]) expect(parseNumber(v)).toBeNull();
  });

  test("parseIsoDate rejects impossible and non-ISO dates", () => {
    expect(parseIsoDate("2024-02-29")).not.toBeNull();
    expect(parseIsoDate("2024-03-05T08:30:00")).not.toBeNull();
    expect(parseIsoDate("2023-02-29")).toBeNull();
    expect(parseIsoDate("05/03/2024")).toBeNull();
  });

  test("checkValue applies type and range rules", () => {
    expect(checkValue(field("humidity_pct"), "55")).toBeNull();
    expect(checkValue(field("humidity_pct"), "120")).toMatch(/Above maximum/);
    expect(checkValue(field("mortality"), "2.5")).toMatch(/whole number/);
    expect(checkValue(field("feed_kg"), "-1")).toMatch(/Below minimum/);
    expect(checkValue(field("temperature_c"), "warm")).toBe("Not a number");
    expect(checkValue(field("date"), "2024-13-01")).toMatch(/date/);
  });

  test("checkValue mirrors the server rules for codes and future dates", () => {
    expect(checkValue(field("farm_code"), "F-001")).toBeNull();
    expect(checkValue(field("batch_code"), "B 001")).toMatch(/letters, numbers or hyphens/);
    expect(checkValue(field("batch_code"), "X")).toMatch(/letters, numbers or hyphens/);
    expect(checkValue(field("date"), "2999-01-01")).toBe("Date is in the future");
    expect(checkValue(field("date"), "2026-01-01")).toBeNull();
  });
});

describe("autoMapColumns", () => {
  test("matches keys and aliases, using each column once", () => {
    const mapping = autoMapColumns(["Date", "Farm", "Batch ID", "Temp", "RH", "Deaths", "Weight", "Notes"]);
    expect(mapping).toMatchObject({
      date: "Date", farm_code: "Farm", batch_code: "Batch ID", temperature_c: "Temp",
      humidity_pct: "RH", mortality: "Deaths", avg_weight_g: "Weight", feed_kg: "", water_l: "",
    });
  });

  test("mappingIssues reports missing required fields and double mapping", () => {
    const issues = mappingIssues({ date: "d", farm_code: "", batch_code: "d" }, ["d"]);
    expect(issues.some((i) => i.field === "farm_code")).toBe(true);
    expect(issues.some((i) => /mapped to 2 fields/.test(i.message))).toBe(true);
  });
});

describe("profileDataset", () => {
  const csv = [
    "date,farm_code,batch_code,temperature_c,humidity_pct,mortality",
    "2024-03-01,F1,B1,28.5,60,2",
    "2024-03-02,F1,B1,,61,1", // missing temperature
    "2024-03-02,F1,B1,,61,1", // exact duplicate of the previous row
    "2024-03-03,F1,B1,hot,150,1.5", // invalid number, out of range, non-integer
    "2024-02-30,F1,B2,27,58,0", // invalid date
    "2024-03-04,F1,B2,27", // ragged row
  ].join("\n");
  const parsed = parseCsv(csv);
  const mapping = autoMapColumns(parsed.headers);
  const profile = profileDataset(parsed, mapping);

  test("counts rows and missing values per column", () => {
    expect(profile.rowCount).toBe(6);
    const temp = profile.missing.find((m) => m.column === "temperature_c");
    expect(temp.count).toBe(2);
    // the ragged row has no humidity/mortality cells
    expect(profile.missing.find((m) => m.column === "mortality").count).toBe(1);
  });

  test("finds exact duplicates and duplicate record keys", () => {
    expect(profile.duplicates.count).toBe(1);
    expect(profile.duplicates.examples[0]).toEqual({ line: 4, firstLine: 3 });
    expect(profile.keyDuplicates.checked).toBe(true);
    expect(profile.keyDuplicates.count).toBe(1);
  });

  test("reports invalid readings with line numbers", () => {
    const byField = Object.fromEntries(profile.invalid.map((e) => [e.field, e]));
    expect(byField.temperature_c.count).toBe(1);
    expect(byField.temperature_c.examples[0]).toMatchObject({ line: 5, value: "hot", reason: "Not a number" });
    expect(byField.humidity_pct.count).toBe(1);
    expect(byField.mortality.count).toBe(1);
    expect(byField.date.count).toBe(1);
    expect(profile.totalInvalid).toBe(4);
  });

  test("detects ragged rows and upload readiness", () => {
    expect(profile.ragged.count).toBe(1);
    expect(profile.ragged.examples[0]).toEqual({ line: 7, fields: 4 });
    expect(isUploadReady(profile)).toBe(true);
    expect(isUploadReady(profileDataset(parsed, { ...mapping, date: "" }))).toBe(false);
  });
});
