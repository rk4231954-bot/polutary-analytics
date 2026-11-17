/**
 * RFC 4180 CSV parsing and serialisation (no dependencies).
 * Handles quoted fields, escaped quotes, embedded delimiters/newlines,
 * CRLF line endings and a UTF-8 BOM.
 */

export function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * @param {string} text
 * @param {{delimiter?: string}} [options]
 * @returns {{headers: string[], rows: string[][], delimiter: string}}
 */
export function parseCsv(text, options = {}) {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter || detectDelimiter(input);
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i += 1;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (inQuotes) throw new Error("Malformed CSV: a quoted field is not closed.");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Drop fully empty lines (e.g. trailing newline).
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [], delimiter };
  const [headerRow, ...rows] = nonEmpty;
  return { headers: headerRow.map((h) => h.trim()), rows, delimiter };
}

function escapeField(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Neutralise spreadsheet formula injection for values exported to CSV.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {string[]} headers @param {Array<Array<unknown>>} rows */
export function toCsv(headers, rows) {
  const lines = [headers.map(escapeField).join(",")];
  for (const row of rows) lines.push(row.map(escapeField).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Triggers a browser download for in-memory content. */
export function downloadFile(content, filename, mimeType = "text/csv;charset=utf-8") {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
