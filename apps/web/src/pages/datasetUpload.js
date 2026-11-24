/**
 * Dataset Upload — CSV ingestion (stages 6–7).
 *
 * Client side (real, from the selected file): parsing, preview, column
 * mapping, missing/duplicate/invalid summaries. These are pre-upload checks.
 * Server side (Flask API, never simulated): upload, validation, preprocessing
 * local storage of the processed file, and its copy in HDFS (read back and
 * checked by the API). The Hive step (stage 8) stays pending until the API reports it.
 */
import { config } from "../config.js";
import { icon } from "../components/icons.js";
import { datasetReportCard, previewTable } from "../components/datasetReport.js";
import { emptyState, errorState, loadingState } from "../components/states.js";
import { createDataTable } from "../components/dataTable.js";
import { bindFlockUpload, flockUploadCard } from "../components/flockUpload.js";
import { confirmDialog } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { callout, card, pageHeader, statusBadge } from "../components/ui.js";
import { deleteDataset, getDataset, getDatasetPreview, listDatasets, uploadDataset } from "../services/datasets.js";
import { listFarms } from "../services/farms.js";
import { can } from "../services/session.js";
import { parseCsv } from "../utils/csv.js";
import { autoMapColumns, EXPECTED_FIELDS, isUploadReady, profileDataset } from "../utils/datasetProfile.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatBytes, formatDateTime, formatNumber, formatPercent, formatRelative } from "../utils/format.js";
import "../styles/pages/upload.css";

const PREVIEW_ROWS = 20;
const SERVER_PREVIEW_ROWS = 25;
const POLL_MS = 3000;
const STAGES = [
  { key: "uploaded", label: "Uploaded", hint: "File received by the API" },
  { key: "validated", label: "Validated", hint: "Schema and values checked" },
  { key: "preprocessed", label: "Preprocessed", hint: "Cleaned and normalised" },
  { key: "hdfs", label: "Stored in HDFS", hint: "Written to Hadoop" },
  { key: "hive", label: "Available in Hive", hint: "Queryable with HiveQL" },
];
// "processed" is final: the file is stored locally and, when HDFS was reachable, in HDFS.
const TERMINAL = new Set(["processed", "available", "failed"]);

function typeLabel(field) {
  const t = { date: "Date (YYYY-MM-DD)", code: "Code (e.g. F-001)", number: "Number", integer: "Whole number" }[field.type];
  return field.unit ? `${t} · ${field.unit}` : t;
}

function stepper(dataset) {
  const stages = dataset?.stages || {};
  const failed = dataset?.status === "failed";
  const finished = TERMINAL.has(dataset?.status) && !failed;
  // A finished dataset has no step "in progress": later steps are simply not built yet.
  const firstPending = finished ? -1 : STAGES.findIndex((s) => !stages[s.key]);
  // The API records an HDFS write that failed or was turned off as an "hdfs" history entry.
  const hdfsNote = (dataset?.history || []).filter((e) => e.stage === "hdfs").at(-1);
  return html`<ol class="pa-steps" aria-label="Ingestion pipeline">
    ${STAGES.map((s, i) => {
      const done = Boolean(stages[s.key]);
      const isCurrent = dataset && i === firstPending;
      const cls = done ? "is-done" : isCurrent ? (failed ? "is-error" : "is-active") : "";
      const marker = done ? icon("check", { size: 14, strokeWidth: 2.5 }) : isCurrent && failed ? icon("x", { size: 14, strokeWidth: 2.5 }) : String(i + 1);
      const state = done
        ? "complete"
        : isCurrent
          ? failed ? "failed" : "in progress"
          : s.key === "hdfs" && hdfsNote && hdfsNote.status !== "success"
            ? "not stored"
            : finished ? "not built yet" : "pending";
      return html`<li class="pa-step ${cls}" aria-label="${s.label}: ${state}">
        <span class="pa-step__marker">${marker}</span>
        <span class="pa-step__label">${s.label}</span>
        <span class="pa-step__hint">${isCurrent && failed ? "Failed" : finished && !done ? "Next project stage" : s.hint}</span>
      </li>`;
    })}
  </ol>`;
}

export default {
  title: "Dataset Upload",
  async render(root, ctx) {
    const state = {
      file: null,
      parsed: null,
      mapping: {},
      profile: null,
      farms: null,
      dataset: null,
      uploading: false,
      abort: null,
      pollTimer: null,
      uploadError: null,
    };

    setHtml(
      root,
      html`${pageHeader({
          title: "Dataset Upload",
          subtitle: "Upload poultry farm CSV datasets for validation, preprocessing and storage in Hadoop HDFS and Apache Hive.",
        })}
        ${card({
          title: "Ingestion pipeline",
          subtitle: "Steps are marked complete only when the backend confirms them.",
          icon: "workflow",
          actions: html`<span data-pipeline-status>${statusBadge("idle", { label: "No upload yet", tone: "neutral" })}</span>`,
          body: html`<div data-stepper>${stepper(null)}</div><div data-pipeline-detail></div>`,
          className: "pa-section",
        })}
        <div class="pa-grid pa-grid--main-side pa-section">
          ${card({
            title: "Select a CSV file",
            icon: "file-spreadsheet",
            body: html`<div data-file-area></div>`,
          })}
          ${card({
            title: "File requirements",
            icon: "info",
            body: html`<ul class="pa-upload-reqs">
                <li>${icon("check", { size: 14 })}<span>CSV format (.csv), UTF-8, with a header row</span></li>
                <li>${icon("check", { size: 14 })}<span>Maximum size ${config.maxUploadMb} MB</span></li>
                <li>${icon("check", { size: 14 })}<span>Dates as ISO <span class="pa-mono">YYYY-MM-DD</span></span></li>
                <li>${icon("check", { size: 14 })}<span>Required columns: <span class="pa-mono">date</span>, <span class="pa-mono">farm_code</span>, <span class="pa-mono">batch_code</span> (one row per batch per day)</span></li>
                <li>${icon("check", { size: 14 })}<span>Farm and batch codes: 2–20 letters, numbers or hyphens</span></li>
                <li>${icon("check", { size: 14 })}<span>Comma, semicolon, tab or pipe delimiters are detected</span></li>
              </ul>
              ${callout({
                tone: "info",
                title: "Checked twice",
                message: "This page checks the file in your browser first. The server then validates every row again; rows with errors are left out and listed, and missing readings stay empty — nothing is guessed or filled in.",
              })}`,
          })}
        </div>
        <div data-report></div>
        <div data-analysis></div>
        ${card({
          title: "Recent uploads",
          subtitle: "Datasets submitted to the ingestion API · select a row to see its report",
          icon: "history",
          actions: html`<button type="button" class="btn btn-ghost btn-sm" data-action="reload-recent">${icon("refresh", { size: 14 })}Refresh</button>`,
          body: html`<div data-recent>${loadingState("Loading uploads…", { compact: true })}</div>`,
          flush: true,
        })}
        ${can("reference_data.upload") ? html`<div data-flock-upload>${flockUploadCard()}</div>` : ""}`,
    );
    const flockHost = $("[data-flock-upload]", root);
    if (flockHost) ctx.onCleanup(bindFlockUpload(flockHost));

    const fileArea = $("[data-file-area]", root);
    const analysis = $("[data-analysis]", root);
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,text/csv";
    fileInput.hidden = true;
    fileInput.setAttribute("data-file-input", "");
    root.appendChild(fileInput);

    // ---------------------------------------------------------------- file area
    function renderDropzone(error) {
      setHtml(
        fileArea,
        html`<div class="pa-dropzone" role="button" tabindex="0" data-dropzone aria-describedby="dz-help">
            <span class="pa-state__icon">${icon("upload-cloud", { size: 22 })}</span>
            <div class="fw-semibold">Drag and drop a CSV file here</div>
            <div class="pa-text-sm pa-text-2" id="dz-help">or <span class="pa-link">browse your computer</span> · up to ${config.maxUploadMb} MB</div>
          </div>
          ${error ? html`<div class="mt-3">${callout({ tone: "danger", title: "File rejected", message: error })}</div>` : ""}`,
      );
    }

    function renderFileSummary() {
      const { file, parsed } = state;
      setHtml(
        fileArea,
        html`<div class="pa-file-summary">
          <span class="pa-file-summary__icon">${icon("file-spreadsheet", { size: 20 })}</span>
          <div class="min-w-0 flex-grow-1">
            <div class="fw-semibold text-truncate" title="${file.name}">${file.name}</div>
            <div class="pa-meta-row">
              <span>${formatBytes(file.size)}</span>
              <span>${formatNumber(parsed.rows.length)} rows</span>
              <span>${formatNumber(parsed.headers.length)} columns</span>
              <span>Delimiter: <span class="pa-mono">${parsed.delimiter === "\t" ? "tab" : parsed.delimiter}</span></span>
            </div>
          </div>
          <div class="d-flex gap-2 flex-shrink-0">
            <button type="button" class="btn btn-secondary btn-sm" data-action="browse" ${state.uploading ? html`disabled title="Upload in progress"` : ""}>Replace</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="remove-file" aria-label="Remove file" ${state.uploading ? html`disabled title="Upload in progress"` : ""}>${icon("x", { size: 16 })}</button>
          </div>
        </div>
        <div class="pa-local-check mt-3">${icon("circle-check", { size: 14 })}Checked locally in your browser — not yet uploaded</div>`,
      );
    }

    async function acceptFile(file) {
      if (!file) return;
      const maxBytes = config.maxUploadMb * 1024 * 1024;
      let error = null;
      if (!/\.csv$/i.test(file.name)) error = `“${file.name}” is not a .csv file.`;
      else if (file.size === 0) error = "The file is empty.";
      else if (file.size > maxBytes) error = `The file is ${formatBytes(file.size)}; the limit is ${config.maxUploadMb} MB.`;
      if (error) return rejectFile(error);

      setHtml(fileArea, loadingState(`Reading ${file.name}…`, { compact: true }));
      let parsed;
      try {
        parsed = parseCsv(await file.text());
      } catch (e) {
        return rejectFile(`The file could not be parsed as CSV: ${e.message}`);
      }
      if (!ctx.isCurrent()) return;
      if (parsed.headers.length === 0 || parsed.headers.every((h) => h === "")) return rejectFile("The file has no header row.");
      if (parsed.rows.length === 0) return rejectFile("The file has a header row but no data rows.");

      Object.assign(state, { file, parsed, mapping: autoMapColumns(parsed.headers), dataset: null, uploadError: null });
      stopPolling();
      renderPipeline();
      renderFileSummary();
      recompute();
    }

    function rejectFile(message) {
      Object.assign(state, { file: null, parsed: null, profile: null });
      renderDropzone(message);
      setHtml(analysis, "");
      toast.error("File rejected", message);
    }

    function clearFile() {
      Object.assign(state, { file: null, parsed: null, profile: null, mapping: {} });
      fileInput.value = "";
      renderDropzone();
      setHtml(analysis, "");
    }

    // ------------------------------------------------------------- analysis
    function recompute() {
      state.profile = profileDataset(state.parsed, state.mapping);
      renderAnalysis();
    }

    function mappingCard() {
      const { headers } = state.parsed;
      const issues = state.profile.mappingIssues;
      return card({
        title: "Column mapping",
        subtitle: "Match the file's columns to the expected fields. Suggestions are based on header names.",
        icon: "columns",
        body: html`${issues.length
            ? html`<div class="mb-3">${callout({ tone: "danger", title: "Fix the mapping before uploading", message: issues.map((i) => i.message).join(" ") })}</div>`
            : ""}
          <div class="pa-table-wrap pa-mapping">
            <table class="pa-table">
              <thead><tr><th scope="col">Expected field</th><th scope="col">Type</th><th scope="col">File column</th></tr></thead>
              <tbody>
                ${EXPECTED_FIELDS.map((f) => {
                  const issue = issues.find((i) => i.field === f.key);
                  return html`<tr>
                    <td><span class="pa-cell-primary ${f.required ? "pa-required" : ""}">${f.label}</span><span class="pa-cell-secondary pa-mono">${f.key}</span></td>
                    <td class="pa-text-2 pa-text-sm">${typeLabel(f)}</td>
                    <td>
                      <label class="visually-hidden" for="map-${f.key}">File column for ${f.label}</label>
                      <select class="form-select form-select-sm ${issue ? "is-invalid" : ""}" id="map-${f.key}" data-map="${f.key}" ${state.uploading ? "disabled" : ""}>
                        <option value="">${f.required ? "— Select a column —" : "— Not in file —"}</option>
                        ${headers.map((h) => html`<option value="${h}" ${state.mapping[f.key] === h ? "selected" : ""}>${h || "(blank header)"}</option>`)}
                      </select>
                    </td>
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>`,
      });
    }

    function stat(label, value, tone, iconName, note) {
      return html`<div class="pa-quality-stat pa-quality-stat--${tone}">
        <span class="pa-quality-stat__icon">${icon(iconName, { size: 16 })}</span>
        <div><div class="pa-stat__label">${label}</div><div class="pa-stat__value">${value}</div>${note ? html`<div class="pa-text-xs pa-text-2">${note}</div>` : ""}</div>
      </div>`;
    }

    function qualityCard() {
      const p = state.profile;
      const missingCols = p.missing.filter((m) => m.count > 0);
      const invalidFields = p.invalid.filter((e) => e.count > 0 || e.missingRequired > 0);
      const toneFor = (n) => (n > 0 ? "warning" : "success");
      return card({
        title: "Data quality summary",
        subtitle: "Computed from the selected file before upload",
        icon: "file-check",
        body: html`<div class="pa-quality-grid">
            ${stat("Data rows", formatNumber(p.rowCount), "neutral", "table", `${formatNumber(p.columnCount)} columns`)}
            ${stat("Missing values", formatNumber(p.totalMissingCells), toneFor(p.totalMissingCells), "circle-alert", `${missingCols.length} of ${p.columnCount} columns affected`)}
            ${stat("Duplicate rows", formatNumber(p.duplicates.count), toneFor(p.duplicates.count + p.keyDuplicates.count), "copy",
              p.keyDuplicates.checked ? `${formatNumber(p.keyDuplicates.count)} repeated date/farm/batch keys` : "Map date, farm and batch to check keys")}
            ${stat("Invalid readings", formatNumber(p.totalInvalid), toneFor(p.totalInvalid + p.ragged.count), "alert-triangle",
              p.ragged.count ? `${formatNumber(p.ragged.count)} rows with wrong field count` : "In mapped columns")}
          </div>
          <div class="pa-grid pa-grid--2 mt-4">
            <div>
              <h3 class="pa-h4 mb-2">Missing values by column</h3>
              ${missingCols.length
                ? html`<ul class="pa-missing-list">
                    ${p.missing.filter((m) => m.count > 0).sort((a, b) => b.count - a.count).map(
                      (m) => html`<li>
                        <div class="d-flex justify-content-between gap-2 pa-text-sm"><span class="text-truncate" title="${m.column}">${m.column || "(blank header)"}</span><span class="pa-tabular pa-text-2">${formatNumber(m.count)} · ${formatPercent(m.pct)}</span></div>
                        <div class="pa-progress mt-1"><div class="pa-progress__bar ${m.pct > 20 ? "pa-progress__bar--danger" : "pa-progress__bar--warning"}" style="width:${Math.max(2, Math.min(100, m.pct)).toFixed(1)}%"></div></div>
                      </li>`,
                    )}
                  </ul>`
                : emptyState({ icon: "circle-check", title: "No missing values", compact: true })}
            </div>
            <div>
              <h3 class="pa-h4 mb-2">Duplicates and invalid readings</h3>
              ${p.duplicates.count + p.keyDuplicates.count + invalidFields.length + p.ragged.count === 0
                ? emptyState({ icon: "circle-check", title: "No duplicates or invalid readings found", message: "Only mapped columns are checked for invalid values.", compact: true })
                : html`<ul class="pa-issue-list">
                    ${p.duplicates.count
                      ? html`<li><span class="pa-badge pa-badge--warning">${formatNumber(p.duplicates.count)}</span><div>Exact duplicate rows<div class="pa-text-xs pa-text-2">${p.duplicates.examples.map((e) => `line ${e.line} repeats line ${e.firstLine}`).join("; ")}</div></div></li>`
                      : ""}
                    ${p.keyDuplicates.count
                      ? html`<li><span class="pa-badge pa-badge--warning">${formatNumber(p.keyDuplicates.count)}</span><div>Repeated date + farm + batch<div class="pa-text-xs pa-text-2">${p.keyDuplicates.examples.map((e) => `line ${e.line} (${e.key})`).join("; ")}</div></div></li>`
                      : ""}
                    ${p.ragged.count
                      ? html`<li><span class="pa-badge pa-badge--danger">${formatNumber(p.ragged.count)}</span><div>Rows with ${p.columnCount === 1 ? "a" : "the"} wrong number of fields<div class="pa-text-xs pa-text-2">${p.ragged.examples.map((e) => `line ${e.line}: ${e.fields} fields`).join("; ")}</div></div></li>`
                      : ""}
                    ${invalidFields.map(
                      (e) => html`<li>
                        <span class="pa-badge pa-badge--${e.count ? "danger" : "warning"}">${formatNumber(e.count + e.missingRequired)}</span>
                        <div>${e.label} <span class="pa-text-2 pa-text-sm">(${e.column})</span>
                          <div class="pa-text-xs pa-text-2">
                            ${e.missingRequired ? `${formatNumber(e.missingRequired)} missing in a required field. ` : ""}
                            ${e.examples.map((x) => html`<span class="pa-issue-example">line ${x.line}: <span class="pa-mono">${x.value}</span> — ${x.reason}</span>`)}
                          </div>
                        </div>
                      </li>`,
                    )}
                  </ul>`}
            </div>
          </div>`,
      });
    }

    function previewCard() {
      const { headers, rows } = state.parsed;
      const shown = rows.slice(0, PREVIEW_ROWS);
      return card({
        title: "Dataset preview",
        subtitle: rows.length > PREVIEW_ROWS ? `First ${PREVIEW_ROWS} of ${formatNumber(rows.length)} rows` : `${formatNumber(rows.length)} rows`,
        icon: "table",
        flush: true,
        body: html`<div class="pa-table-wrap pa-preview-table">
          <table class="pa-table">
            <thead><tr><th scope="col" class="is-num">Line</th>${headers.map((h) => html`<th scope="col">${h || "(blank)"}</th>`)}</tr></thead>
            <tbody>
              ${shown.map(
                (row, i) => html`<tr>
                  <td class="is-num pa-text-2">${i + 2}</td>
                  ${headers.map((_, c) => {
                    const v = row[c];
                    const blank = v === undefined || String(v).trim() === "";
                    return html`<td class="${blank ? "pa-cell-missing" : ""}">${blank ? "empty" : v}</td>`;
                  })}
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
      });
    }

    function uploadCard() {
      if (!can("datasets.upload")) {
        return card({
          title: "Upload for ingestion",
          icon: "upload",
          body: callout({ tone: "info", title: "View only", message: "Your role can view uploaded datasets but not upload new ones. Ask a farm manager or administrator." }),
        });
      }
      const ready = isUploadReady(state.profile);
      const farmOptions = state.farms?.source === "api" ? state.farms.data : null;
      const warnings = state.profile.totalInvalid + state.profile.totalMissingCells + state.profile.duplicates.count;
      const reason = !ready ? "Resolve the column mapping issues first" : "";
      return card({
        title: "Upload for ingestion",
        icon: "upload",
        body: html`<div class="pa-upload-actions">
            <div class="pa-upload-farm">
              <label class="form-label" for="upload-farm">Farm (optional)</label>
              ${farmOptions
                ? html`<select class="form-select" id="upload-farm" data-upload-farm ${state.uploading ? "disabled" : ""}>
                    <option value="">Use farm codes from the file</option>
                    ${farmOptions.map((f) => html`<option value="${f.id}">${f.name}</option>`)}
                  </select>`
                : html`<select class="form-select" id="upload-farm" disabled title="Farm list requires the API"><option>Use farm codes from the file</option></select>
                    <div class="form-text">The farm list loads from the API when it is connected.</div>`}
            </div>
            <div class="pa-upload-submit">
              ${warnings > 0 && ready
                ? html`<div class="pa-text-sm pa-text-2 mb-2">${icon("info", { size: 14 })} Rows with invalid values will be rejected by the server and listed in the report; missing readings stay empty.</div>`
                : ""}
              <div class="d-flex gap-2 flex-wrap">
                <button type="button" class="btn btn-primary" data-action="upload" ${!ready || state.uploading ? "disabled" : ""} ${reason ? html`title="${reason}"` : ""}>
                  ${icon("upload-cloud", { size: 16 })}Upload dataset
                </button>
                ${state.uploading ? html`<button type="button" class="btn btn-secondary" data-action="cancel-upload">Cancel</button>` : ""}
              </div>
            </div>
          </div>
          <div data-upload-progress class="${state.uploading ? "" : "d-none"} mt-3">
            <div class="d-flex justify-content-between pa-text-sm mb-1"><span>Uploading ${state.file.name}…</span><span data-progress-label class="pa-tabular">0%</span></div>
            <div class="pa-progress" role="progressbar" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="pa-progress__bar" data-progress-bar style="width:0%"></div></div>
          </div>`,
      });
    }

    function renderAnalysis() {
      if (!state.parsed) return setHtml(analysis, "");
      setHtml(
        analysis,
        html`<div class="pa-section">${mappingCard()}</div>
          <div class="pa-section">${qualityCard()}</div>
          <div class="pa-section">${previewCard()}</div>
          <div class="pa-section">${uploadCard()}</div>`,
      );
    }

    // ------------------------------------------------------------- pipeline
    function renderPipeline() {
      const d = state.dataset;
      const error = state.uploadError;
      setHtml($("[data-stepper]", root), stepper(d));
      const statusEl = $("[data-pipeline-status]", root);
      if (!d) setHtml(statusEl, statusBadge("idle", { label: state.uploading ? "Uploading…" : "No upload yet", tone: state.uploading ? "info" : "neutral" }));
      else setHtml(statusEl, statusBadge(d.status));
      const detail = $("[data-pipeline-detail]", root);
      if (error) {
        setHtml(detail, html`<div class="mt-3">${callout({ tone: "danger", title: error.isNetworkError ? "Upload failed — backend not connected" : "Upload failed", message: error.message })}</div>`);
      } else if (d) {
        setHtml(
          detail,
          html`<dl class="pa-dl mt-4">
            <dt>Dataset</dt><dd>${d.filename ?? "—"} ${d.id !== undefined ? html`<span class="pa-text-2 pa-mono">#${d.id}</span>` : ""}</dd>
            ${d.rowCount !== undefined && d.rowCount !== null ? html`<dt>Rows accepted</dt><dd>${formatNumber(d.rowCount)}${d.totalRows ? ` of ${formatNumber(d.totalRows)}` : ""}</dd>` : ""}
            ${d.processedFile ? html`<dt>Processed file</dt><dd class="pa-mono">${d.processedFile}</dd>` : ""}
            ${d.hdfsPath ? html`<dt>HDFS path</dt><dd class="pa-mono">${d.hdfsPath}</dd>` : ""}
            ${d.hiveTable ? html`<dt>Hive table</dt><dd class="pa-mono">${d.hiveTable}</dd>` : ""}
            ${d.error ? html`<dt>Error</dt><dd class="text-danger">${d.error}</dd>` : ""}
          </dl>`,
        );
      } else setHtml(detail, "");
      renderReport();
    }

    // -------------------------------------------------------- server report
    function renderReport() {
      const holder = $("[data-report]", root);
      const d = state.dataset;
      if (!d || !d.report) return setHtml(holder, "");
      setHtml(holder, datasetReportCard(d, { canDelete: can("datasets.delete") }));
      if (d.status === "processed") loadPreview("processed", 0);
      if (d.hasRejectedRows) loadPreview("rejected", 0);
    }

    async function loadPreview(kind, offset) {
      const holder = $(`[data-preview="${kind}"]`, root);
      const d = state.dataset;
      if (!holder || !d) return;
      setHtml(holder, loadingState("Loading rows…", { compact: true }));
      try {
        const { data } = await getDatasetPreview(d.id, { kind, offset, limit: SERVER_PREVIEW_ROWS });
        if (!ctx.isCurrent() || state.dataset?.id !== d.id) return;
        const title = kind === "processed" ? "Processed dataset preview" : "Rejected rows (left out of the processed file)";
        setHtml(holder, previewTable(data, { title, limit: SERVER_PREVIEW_ROWS }));
      } catch (error) {
        if (ctx.isCurrent()) setHtml(holder, errorState(error, { compact: true, retry: false }));
      }
    }

    async function openDataset(id) {
      stopPolling();
      try {
        const { data } = await getDataset(id);
        if (!ctx.isCurrent()) return;
        state.dataset = data;
        state.uploadError = null;
        renderPipeline();
        $("[data-report]", root)?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (error) {
        if (ctx.isCurrent()) toast.apiError(error, "Could not load the dataset");
      }
    }

    async function removeDataset(id) {
      const d = state.dataset;
      const ok = await confirmDialog({
        title: "Delete dataset?",
        message: `This permanently deletes “${d?.filename ?? `dataset #${id}`}”, its validation report and its stored files.`,
        confirmLabel: "Delete dataset",
        danger: true,
      });
      if (!ok || !ctx.isCurrent()) return;
      try {
        await deleteDataset(id);
        toast.success("Dataset deleted");
        state.dataset = null;
        renderPipeline();
        loadRecent();
      } catch (error) {
        toast.apiError(error, "Could not delete the dataset");
      }
    }

    function stopPolling() {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }

    function poll() {
      stopPolling();
      if (!state.dataset || TERMINAL.has(state.dataset.status) || state.dataset.id === undefined) return;
      state.pollTimer = setTimeout(async () => {
        try {
          const { data } = await getDataset(state.dataset.id);
          if (!ctx.isCurrent()) return;
          state.dataset = data;
          renderPipeline();
          if (data.status === "available") {
            toast.success("Dataset available in Hive", `${data.filename} can now be queried.`);
            loadRecent();
          } else if (data.status === "failed") {
            toast.error("Ingestion failed", data.error || "The backend reported a failure.");
            loadRecent();
          }
          poll();
        } catch (error) {
          if (!ctx.isCurrent()) return;
          toast.apiError(error, "Could not refresh ingestion status");
          state.pollTimer = setTimeout(poll, POLL_MS * 3);
        }
      }, POLL_MS);
    }

    async function startUpload() {
      if (!state.file || !isUploadReady(state.profile)) return;
      const farmId = $("[data-upload-farm]", root)?.value || "";
      const mapping = Object.fromEntries(Object.entries(state.mapping).filter(([, v]) => v));
      state.uploading = true;
      state.abort = new AbortController();
      state.dataset = null;
      state.uploadError = null;
      renderAnalysis();
      renderFileSummary();
      renderPipeline();
      const bar = $("[data-progress-bar]", root);
      const label = $("[data-progress-label]", root);
      const progress = bar?.parentElement;
      try {
        const dataset = await uploadDataset(state.file, {
          mapping,
          farmId,
          signal: state.abort.signal,
          onProgress: (f) => {
            const pct = Math.round(f * 100);
            if (bar) bar.style.width = `${pct}%`;
            if (label) label.textContent = `${pct}%`;
            progress?.setAttribute("aria-valuenow", String(pct));
          },
        });
        if (!ctx.isCurrent()) return;
        state.dataset = dataset;
        if (dataset.status === "processed") {
          const rejected = dataset.rejectedRows ? `; ${formatNumber(dataset.rejectedRows)} rejected` : "";
          toast.success("Dataset processed", `${formatNumber(dataset.rowCount)} valid rows saved${rejected}. See the validation report.`);
        } else if (dataset.status === "failed") {
          toast.error("Dataset not processed", dataset.error || "See the validation report for details.");
        }
        renderPipeline();
        loadRecent();
        poll();
      } catch (error) {
        if (!ctx.isCurrent()) return;
        if (error?.name === "AbortError") {
          toast.info("Upload cancelled");
        } else {
          state.uploadError = error;
          toast.apiError(error, "Upload failed");
        }
      } finally {
        state.uploading = false;
        state.abort = null;
        if (ctx.isCurrent() && state.file) {
          renderFileSummary();
          renderAnalysis();
          renderPipeline();
        }
      }
    }

    // ---------------------------------------------------------- recent list
    let recentTable = null;
    async function loadRecent() {
      const holder = $("[data-recent]", root);
      setHtml(holder, loadingState("Loading uploads…", { compact: true }));
      recentTable?.destroy();
      recentTable = null;
      try {
        const { data } = await listDatasets({ limit: 20 });
        if (!ctx.isCurrent()) return;
        recentTable = createDataTable(holder, {
          rows: data,
          pageSize: 8,
          caption: "Recent dataset uploads",
          onRowClick: (d) => openDataset(d.id),
          columns: [
            { key: "filename", label: "File", sortable: true, render: (d) => html`<span class="pa-cell-primary">${d.filename}</span><span class="pa-cell-secondary">${d.uploadedBy ?? ""}</span>` },
            { key: "status", label: "Status", sortable: true, render: (d) => statusBadge(d.status) },
            { key: "rowCount", label: "Rows", sortable: true, align: "num", render: (d) => formatNumber(d.rowCount) },
            { key: "sizeBytes", label: "Size", sortable: true, align: "num", render: (d) => formatBytes(d.sizeBytes) },
            { key: "farmName", label: "Farm", sortable: true, render: (d) => d.farmName ?? "—" },
            { key: "rejectedRows", label: "Rejected", sortable: true, align: "num", render: (d) => (d.rejectedRows === null || d.rejectedRows === undefined ? "—" : formatNumber(d.rejectedRows)) },
            { key: "createdAt", label: "Uploaded", sortable: true, render: (d) => html`<span title="${formatDateTime(d.createdAt)}">${formatRelative(d.createdAt)}</span>` },
          ],
          empty: { icon: "upload-cloud", title: "No uploads yet", message: "Datasets you upload will appear here with their ingestion status." },
        });
      } catch (error) {
        if (ctx.isCurrent()) setHtml(holder, errorState(error, { compact: true }));
      }
    }

    // ------------------------------------------------------------- events
    const offs = [
      on(root, "click", "[data-dropzone], [data-action=browse]", () => fileInput.click()),
      on(root, "keydown", "[data-dropzone]", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fileInput.click();
        }
      }),
      on(root, "dragover", "[data-dropzone]", (e, el) => {
        e.preventDefault();
        el.classList.add("is-dragover");
      }),
      on(root, "dragleave", "[data-dropzone]", (_e, el) => el.classList.remove("is-dragover")),
      on(root, "drop", "[data-dropzone]", (e, el) => {
        e.preventDefault();
        el.classList.remove("is-dragover");
        const files = e.dataTransfer?.files;
        if (files?.length > 1) toast.warning("One file at a time", "Only the first file was used.");
        acceptFile(files?.[0]);
      }),
      on(root, "click", "[data-action=remove-file]", clearFile),
      on(root, "change", "[data-map]", (e, el) => {
        state.mapping[el.dataset.map] = el.value;
        recompute();
        $(`#map-${el.dataset.map}`, root)?.focus();
      }),
      on(root, "click", "[data-action=upload]", startUpload),
      on(root, "click", "[data-action=cancel-upload]", () => state.abort?.abort()),
      on(root, "click", "[data-action=reload-recent], [data-recent] [data-action=retry]", loadRecent),
      on(root, "click", "[data-action=preview-page]", (_e, el) => loadPreview(el.dataset.kind, Number(el.dataset.offset) || 0)),
      on(root, "click", "[data-action=delete-dataset]", (_e, el) => removeDataset(Number(el.dataset.id))),
    ];
    fileInput.addEventListener("change", () => acceptFile(fileInput.files?.[0]));
    // Prevent the browser from opening files dropped outside the dropzone.
    const preventDrop = (e) => {
      if (!e.target.closest?.("[data-dropzone]")) e.preventDefault();
    };
    window.addEventListener("dragover", preventDrop);
    window.addEventListener("drop", preventDrop);

    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      window.removeEventListener("dragover", preventDrop);
      window.removeEventListener("drop", preventDrop);
      stopPolling();
      state.abort?.abort();
      recentTable?.destroy();
      fileInput.remove();
    });

    renderDropzone();
    loadRecent();
    listFarms()
      .then((farms) => {
        state.farms = farms;
        if (ctx.isCurrent() && state.parsed && !state.uploading) renderAnalysis();
      })
      .catch(() => {
        state.farms = null;
      });
  },
};
