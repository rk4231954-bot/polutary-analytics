import { describe, expect, test } from "bun:test";
import { detectDelimiter, parseCsv, toCsv } from "../src/utils/csv.js";

describe("parseCsv", () => {
  test("parses headers and rows", () => {
    const { headers, rows, delimiter } = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(delimiter).toBe(",");
    expect(headers).toEqual(["a", "b", "c"]);
    expect(rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  });

  test("handles quotes, escaped quotes, embedded delimiters and newlines", () => {
    const { rows } = parseCsv('name,note\n"Smith, J","said ""hi""\nthen left"\n');
    expect(rows).toEqual([["Smith, J", 'said "hi"\nthen left']]);
  });

  test("handles CRLF, BOM and trims header whitespace", () => {
    const { headers, rows } = parseCsv("﻿ a , b \r\n1,2\r\n");
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([["1", "2"]]);
  });

  test("keeps empty fields and skips blank lines", () => {
    const { rows } = parseCsv("a,b\n1,\n\n,2\n");
    expect(rows).toEqual([["1", ""], ["", "2"]]);
  });

  test("detects semicolon and tab delimiters", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([["1", "2"]]);
  });

  test("returns empty result for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], delimiter: "," });
  });

  test("throws on an unclosed quoted field", () => {
    expect(() => parseCsv('a,b\n"open,2\n')).toThrow(/not closed/);
  });
});

describe("toCsv", () => {
  test("quotes fields that need it and round-trips", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'q"uote'], [1, null]]);
    expect(csv).toBe('a,b\r\n"x,y","q""uote"\r\n1,\r\n');
    expect(parseCsv(csv).rows).toEqual([["x,y", 'q"uote'], ["1", ""]]);
  });

  test("neutralises spreadsheet formulas but keeps negative numbers", () => {
    expect(toCsv(["v"], [["=SUM(A1)"], ["-12.5"], ["@cmd"]])).toBe("v\r\n'=SUM(A1)\r\n-12.5\r\n'@cmd\r\n");
  });
});
