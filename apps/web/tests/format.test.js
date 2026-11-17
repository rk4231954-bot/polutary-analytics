import { describe, expect, test } from "bun:test";
import { formatBytes, formatDuration, formatPercent, formatWeightKg, initials, toDate, toIsoDate, titleCase } from "../src/utils/format.js";

describe("format helpers", () => {
  test("missing values render as an em dash", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatWeightKg(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
  test("bare ISO dates are parsed as local calendar dates", () => {
    const d = toDate("2026-03-05");
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 5]);
    expect(toIsoDate(d)).toBe("2026-03-05");
  });
  test("invalid dates return null", () => {
    expect(toDate("not a date")).toBeNull();
  });
  test("bytes and durations", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toMatch(/^1[.,]5 KB$/);
    expect(formatDuration(250)).toBe("250 ms");
  });
  test("initials and title case", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("")).toBe("?");
    expect(titleCase("farm_manager")).toBe("Farm Manager");
  });
});
