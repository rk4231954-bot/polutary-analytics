/**
 * Server validation report for an uploaded dataset: summary, errors, warnings,
 * transformations, processing history and paged previews of processed/rejected rows.
 * Everything shown here comes from the Flask API (GET /datasets/:id and /preview).
 */
import { icon } from "./icons.js";
import { emptyState } from "./states.js";
import { callout, card, statusBadge } from "./ui.js";
import { html } from "../utils/dom.js";
import { formatDateTime, formatNumber } from "../utils/format.js";

function stat(label, value, tone, iconName, note) {
  return html`<div class="pa-quality-stat pa-quality-stat--${tone}">
    <span class="pa-quality-stat__icon">${icon(iconName, { size: 16 })}</span>
    <div><div class="pa-stat__label">${label}</div><div class="pa-stat__value">${value}</div>${note ? html`<div class="pa-text-xs pa-text-2">${note}</div>` : ""}</div>
  </div>`;
}

function example(e) {
  const parts = [e.line !== undefined ? `line ${e.line}` : "", e.column ? `column “${e.column}”` : ""].filter(Boolean).join(", ");
  return html`<span class="pa-issue-example">${parts}${e.value !== undefined ? html`: <span class="pa-mono">${e.value === "" ? "(empty)" : e.value}</span>` : ""}${e.reason ? ` — ${e.reason}` : ""}</span>`;
}

function issueList(items, tone, emptyTitle) {
  if (!items?.length) return emptyState({ icon: "circle-check", title: emptyTitle, compact: true });
  return html`<ul class="pa-issue-list">
    ${items.map(
      (item) => html`<li>
        <span class="pa-badge pa-badge--${tone}">${formatNumber(item.count)}</span>
        <div>${item.message}${item.scope === "file" ? html` <span class="pa-text-2 pa-text-sm">(whole file)</span>` : ""}
          ${item.examples?.length
            ? html`<div class="pa-text-xs pa-text-2">${item.examples.map(example)}${item.count > item.examples.length ? html`<span class="pa-issue-example">…and ${formatNumber(item.count - item.examples.length)} more</span>` : ""}</div>`
            : ""}
        </div>
      </li>`,
    )}
  </ul>`;
}

function history(events) {
  if (!events?.length) return "";
  const tone = { success: "success", warning: "warning", failure: "danger" };
  const iconFor = { success: "circle-check", warning: "alert-triangle", failure: "circle-alert" };
  return html`<h3 class="pa-h4 mb-2 mt-4">Processing history</h3>
    <ul class="list-unstyled mb-0">
      ${events.map(
        (e) => html`<li class="pa-list-item">
          <span class="pa-list-item__icon pa-list-item__icon--${tone[e.status] || "info"}">${icon(iconFor[e.status] || "info", { size: 14 })}</span>
          <div class="pa-list-item__body">
            <div class="pa-list-item__title">${e.stage.replace(/_/g, " ")}</div>
            <p class="pa-list-item__text">${e.message}</p>
          </div>
          <span class="pa-text-xs pa-text-2">${formatDateTime(e.createdAt)}</span>
        </li>`,
      )}
    </ul>`;
}

/** @param {object} d dataset detail from the API  @param {{canDelete: boolean}} options */
export function datasetReportCard(d, { canDelete }) {
  const report = d.report || { summary: {}, errors: [], warnings: [], transformations: [] };
  const s = report.summary || {};
  const processed = d.status === "processed";
  const rowErrors = (report.errors || []).filter((e) => e.scope !== "file");
  const fileErrors = (report.errors || []).filter((e) => e.scope === "file");
  return card({
    title: `Validation report · ${d.filename}`,
    subtitle: `Dataset #${d.id}${d.farmName ? ` · ${d.farmName}` : ""}${d.uploadedBy ? ` · uploaded by ${d.uploadedBy}` : ""} · ${formatDateTime(d.createdAt)}`,
    icon: "file-check",
    badge: statusBadge(d.status, processed ? { label: "Processed" } : {}),
    actions: canDelete
      ? html`<button type="button" class="btn btn-ghost btn-sm text-danger" data-action="delete-dataset" data-id="${d.id}">${icon("trash", { size: 14 })}Delete</button>`
      : "",
    className: "pa-section",
    body: html`
      ${processed
        ? callout({
            tone: d.rejectedRows ? "warning" : "success",
            title: d.rejectedRows ? "Processed with rejected rows" : "Processed",
            message: `${formatNumber(d.rowCount)} valid rows were saved to ${d.processedFile || "the processed data folder"}. ${d.rejectedRows ? `${formatNumber(d.rejectedRows)} rows with errors were left out (listed below) — they were not changed or guessed.` : ""} Storing in HDFS and Hive comes in the next project stages.`,
          })
        : callout({ tone: "danger", title: "Not processed", message: d.error || "Validation failed." })}
      <div class="pa-quality-grid mt-3">
        ${stat("Data rows", formatNumber(s.totalRows ?? d.totalRows), "neutral", "table", s.columns !== undefined ? `${formatNumber(s.columns)} columns · delimiter ${s.delimiter}` : "")}
        ${stat("Accepted", formatNumber(s.acceptedRows ?? d.rowCount ?? 0), processed ? "success" : "warning", "circle-check", s.dateRange ? `${s.dateRange.from} → ${s.dateRange.to}` : "")}
        ${stat("Rejected", formatNumber(s.rejectedRows ?? 0), (s.rejectedRows ?? 0) > 0 ? "warning" : "success", "x", "Rows with errors")}
        ${stat("Duplicates removed", formatNumber(s.duplicateRowsRemoved ?? 0), (s.duplicateRowsRemoved ?? 0) > 0 ? "warning" : "success", "copy", s.blankRowsSkipped ? `${formatNumber(s.blankRowsSkipped)} blank lines skipped` : "Exact copies only")}
      </div>
      ${s.fieldsNotProvided?.length ? html`<p class="pa-text-sm pa-text-2 mt-3 mb-0">Not in this file (stored as empty): <span class="pa-mono">${s.fieldsNotProvided.join(", ")}</span></p>` : ""}
      <div class="pa-grid pa-grid--2 mt-4">
        <div>
          <h3 class="pa-h4 mb-2">Errors</h3>
          ${fileErrors.length ? html`<div class="mb-2">${issueList(fileErrors, "danger", "")}</div>` : ""}
          ${rowErrors.length || !fileErrors.length ? issueList(rowErrors, "danger", "No errors") : ""}
        </div>
        <div>
          <h3 class="pa-h4 mb-2">Warnings</h3>
          ${issueList(report.warnings, "warning", "No warnings")}
        </div>
      </div>
      ${report.transformations?.length
        ? html`<h3 class="pa-h4 mb-2 mt-4">Preprocessing applied</h3>
            <ul class="pa-upload-reqs">${report.transformations.map((t) => html`<li>${icon("check", { size: 14 })}<span>${t.message}${t.count > 1 ? html` <span class="pa-text-2">(${formatNumber(t.count)})</span>` : ""}</span></li>`)}</ul>`
        : ""}
      ${history(d.history)}
      ${processed ? html`<div class="mt-4" data-preview="processed"></div>` : ""}
      ${d.hasRejectedRows ? html`<div class="mt-4" data-preview="rejected"></div>` : ""}`,
  });
}

/** Paged table for GET /datasets/:id/preview. */
export function previewTable(preview, { title, limit }) {
  const { columns, rows, total, offset, kind } = preview;
  const from = total ? offset + 1 : 0;
  const to = offset + rows.length;
  return html`<div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
      <h3 class="pa-h4 mb-0">${title}</h3>
      <div class="d-flex align-items-center gap-2 pa-text-sm">
        <span class="pa-text-2 pa-tabular">${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}</span>
        <button type="button" class="btn btn-secondary btn-sm" data-action="preview-page" data-kind="${kind}" data-offset="${Math.max(0, offset - limit)}" ${offset === 0 ? "disabled" : ""}>Previous</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="preview-page" data-kind="${kind}" data-offset="${offset + limit}" ${to >= total ? "disabled" : ""}>Next</button>
      </div>
    </div>
    <div class="pa-table-wrap pa-preview-table">
      <table class="pa-table">
        <thead><tr>${columns.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
        <tbody>
          ${rows.map((row) => html`<tr>${row.map((v) => html`<td class="${v === null ? "pa-cell-missing" : ""}">${v === null ? "empty" : v}</td>`)}</tr>`)}
        </tbody>
      </table>
    </div>`;
}
