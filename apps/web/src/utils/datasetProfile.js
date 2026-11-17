/**
 * Client-side profiling of an uploaded CSV, computed from the real file:
 * column mapping, missing values, duplicates and invalid readings.
 *
 * This is a pre-upload quality check only. The Flask API re-validates and
 * preprocesses every dataset (stage 6); its result is authoritative.
 *
 * The expected schema below is PROVISIONAL until stage 6 (CSV ingestion).
 */

/** @typedef {{key: string, label: string, type: "date"|"string"|"number"|"integer", required: boolean, min?: number, max?: number, unit?: string, aliases: string[]}} FieldSpec */

/** @type {FieldSpec[]} */
export const EXPECTED_FIELDS = [
  { key: "date", label: "Date", type: "date", required: true, aliases: ["record_date", "reading_date", "day", "timestamp"] },
  { key: "farm_code", label: "Farm code", type: "string", required: true, aliases: ["farm", "farm_id", "farm_name"] },
  { key: "batch_code", label: "Batch code", type: "string", required: true, aliases: ["batch", "batch_id", "flock", "flock_id", "flock_code"] },
  { key: "temperature_c", label: "Temperature", type: "number", required: false, min: -10, max: 60, unit: "°C", aliases: ["temperature", "temp", "temp_c", "temperature_celsius"] },
  { key: "humidity_pct", label: "Humidity", type: "number", required: false, min: 0, max: 100, unit: "%", aliases: ["humidity", "rh", "relative_humidity", "humidity_percent"] },
  { key: "feed_kg", label: "Feed", type: "number", required: false, min: 0, unit: "kg", aliases: ["feed", "feed_consumption", "feed_consumption_kg", "feed_intake_kg"] },
  { key: "water_l", label: "Water", type: "number", required: false, min: 0, unit: "L", aliases: ["water", "water_consumption", "water_consumption_l", "water_litres", "water_liters"] },
  { key: "mortality", label: "Mortality", type: "integer", required: false, min: 0, unit: "birds", aliases: ["deaths", "dead", "mortality_count", "dead_birds"] },
  { key: "avg_weight_g", label: "Average weight", type: "number", required: false, min: 0, max: 10000, unit: "g", aliases: ["weight", "avg_weight", "average_weight", "average_weight_g", "body_weight_g"] },
  { key: "bird_count", label: "Bird count", type: "integer", required: false, min: 0, unit: "birds", aliases: ["birds", "population", "flock_size", "live_birds"] },
];

const MISSING_TOKENS = new Set(["", "na", "n/a", "null", "nan", "none", "-", "?"]);
const MAX_EXAMPLES = 5;

/** "Temperature (°C)" → "temperature_c" */
export function normaliseHeader(header) {
  return String(header ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isMissing(value) {
  return value === undefined || value === null || MISSING_TOKENS.has(String(value).trim().toLowerCase());
}

/** Strict decimal parser: "12", "-3.5", ".5". Rejects "12kg", "1,234", "" and exponent notation. */
export function parseNumber(value) {
  const s = String(value ?? "").trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return Number(s);
}

/** Accepts ISO dates (YYYY-MM-DD, optionally followed by a time). Returns a Date or null. */
export function parseIsoDate(value) {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/**
 * Suggests a column for each expected field from the file headers.
 * Each file column is used at most once.
 * @param {string[]} headers
 * @returns {Record<string, string>} field key → header ("" when unmatched)
 */
export function autoMapColumns(headers) {
  const normalised = headers.map(normaliseHeader);
  const used = new Set();
  const mapping = {};
  for (const field of EXPECTED_FIELDS) {
    const candidates = [field.key, ...field.aliases];
    let index = -1;
    for (const candidate of candidates) {
      index = normalised.findIndex((h, i) => h === candidate && !used.has(i));
      if (index !== -1) break;
    }
    if (index !== -1) used.add(index);
    mapping[field.key] = index === -1 ? "" : headers[index];
  }
  return mapping;
}

/** Problems with the mapping itself (missing required fields, a column mapped twice). */
export function mappingIssues(mapping, headers) {
  const issues = [];
  for (const field of EXPECTED_FIELDS) {
    const column = mapping[field.key];
    if (field.required && !column) issues.push({ field: field.key, message: `${field.label} is required but not mapped.` });
    if (column && !headers.includes(column)) issues.push({ field: field.key, message: `Column “${column}” is not in the file.` });
  }
  const counts = {};
  for (const column of Object.values(mapping)) if (column) counts[column] = (counts[column] || 0) + 1;
  for (const [column, count] of Object.entries(counts)) {
    if (count > 1) issues.push({ field: null, message: `Column “${column}” is mapped to ${count} fields.` });
  }
  return issues;
}

/** Validates one non-missing value against a field spec. Returns a reason string or null. */
export function checkValue(field, raw) {
  const value = String(raw).trim();
  if (field.type === "date") return parseIsoDate(value) ? null : "Not a valid YYYY-MM-DD date";
  if (field.type === "string") return value.length > 100 ? "Longer than 100 characters" : null;
  const n = parseNumber(value);
  if (n === null) return "Not a number";
  if (field.type === "integer" && !Number.isInteger(n)) return "Not a whole number";
  if (field.min !== undefined && n < field.min) return `Below minimum (${field.min}${field.unit ? ` ${field.unit}` : ""})`;
  if (field.max !== undefined && n > field.max) return `Above maximum (${field.max}${field.unit ? ` ${field.unit}` : ""})`;
  return null;
}

/** Line number in the original file for data row `index` (header is line 1). */
const lineOf = (index) => index + 2;

/**
 * @param {{headers: string[], rows: string[][]}} parsed  output of parseCsv
 * @param {Record<string,string>} mapping  field key → header
 */
export function profileDataset({ headers, rows }, mapping = {}) {
  const width = headers.length;

  // Missing values per column.
  const missing = headers.map((column, c) => {
    let count = 0;
    for (const row of rows) if (isMissing(row[c])) count += 1;
    return { column, count, pct: rows.length ? (count / rows.length) * 100 : 0 };
  });
  const totalMissingCells = missing.reduce((s, m) => s + m.count, 0);

  // Rows with the wrong number of fields.
  const ragged = { count: 0, examples: [] };
  rows.forEach((row, i) => {
    if (row.length !== width) {
      ragged.count += 1;
      if (ragged.examples.length < MAX_EXAMPLES) ragged.examples.push({ line: lineOf(i), fields: row.length });
    }
  });

  // Exact duplicate rows (after trimming cells). The first occurrence is not counted.
  const seen = new Map();
  const duplicates = { count: 0, examples: [] };
  rows.forEach((row, i) => {
    const key = JSON.stringify(row.map((v) => String(v ?? "").trim()));
    if (seen.has(key)) {
      duplicates.count += 1;
      if (duplicates.examples.length < MAX_EXAMPLES) duplicates.examples.push({ line: lineOf(i), firstLine: seen.get(key) });
    } else seen.set(key, lineOf(i));
  });

  // Duplicate record keys (same date + farm + batch) when those fields are mapped.
  const keyFields = ["date", "farm_code", "batch_code"];
  const keyIdx = keyFields.map((k) => headers.indexOf(mapping[k]));
  const keyDuplicates = { checked: keyIdx.every((i) => i !== -1), count: 0, examples: [] };
  if (keyDuplicates.checked) {
    const keys = new Map();
    rows.forEach((row, i) => {
      if (keyIdx.some((c) => isMissing(row[c]))) return;
      const key = keyIdx.map((c) => String(row[c]).trim().toLowerCase()).join("\u0000");
      if (keys.has(key)) {
        keyDuplicates.count += 1;
        if (keyDuplicates.examples.length < MAX_EXAMPLES)
          keyDuplicates.examples.push({ line: lineOf(i), firstLine: keys.get(key), key: keyIdx.map((c) => String(row[c]).trim()).join(" · ") });
      } else keys.set(key, lineOf(i));
    });
  }

  // Invalid readings in mapped columns, plus missing values in required fields.
  const invalid = [];
  for (const field of EXPECTED_FIELDS) {
    const c = headers.indexOf(mapping[field.key]);
    if (c === -1) continue;
    const entry = { field: field.key, label: field.label, column: headers[c], count: 0, missingRequired: 0, examples: [] };
    rows.forEach((row, i) => {
      const value = row[c];
      if (isMissing(value)) {
        if (field.required) entry.missingRequired += 1;
        return;
      }
      const reason = checkValue(field, value);
      if (reason) {
        entry.count += 1;
        if (entry.examples.length < MAX_EXAMPLES) entry.examples.push({ line: lineOf(i), value: String(value), reason });
      }
    });
    invalid.push(entry);
  }
  const totalInvalid = invalid.reduce((s, e) => s + e.count, 0);
  const totalMissingRequired = invalid.reduce((s, e) => s + e.missingRequired, 0);

  return {
    rowCount: rows.length,
    columnCount: width,
    missing,
    totalMissingCells,
    ragged,
    duplicates,
    keyDuplicates,
    invalid,
    totalInvalid,
    totalMissingRequired,
    mappingIssues: mappingIssues(mapping, headers),
  };
}

/** True when the profile has no blocking problems for upload (warnings are allowed). */
export function isUploadReady(profile) {
  return profile.rowCount > 0 && profile.mappingIssues.length === 0;
}
