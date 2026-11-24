/**
 * Admin card on the Dataset Upload page: uploads the Kaggle "Broiler Performance Index" file
 * (PS Performance.csv) to HDFS and Hive. Kept separate from the daily-records pipeline because
 * the file has no date, farm or batch columns.
 */
import { icon } from "./icons.js";
import { errorState, loadingState } from "./states.js";
import { callout, card } from "./ui.js";
import { uploadFlockCsv } from "../services/flockPerformance.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatNumber } from "../utils/format.js";

const KAGGLE_URL = "https://www.kaggle.com/datasets/isazulka/broiler-performance-index";

export function flockUploadCard() {
  return card({
    title: "Broiler flock benchmarks (Kaggle reference data)",
    subtitle: "Administrators only · replaces the stored copy",
    icon: "upload-cloud",
    className: "pa-section",
    body: html`<p class="pa-text-sm">Upload <span class="pa-mono">PS Performance.csv</span> from the Kaggle dataset
        <a href="${KAGGLE_URL}" target="_blank" rel="noopener noreferrer">Broiler Performance Index</a> (Apache 2.0).
        Expected columns: <span class="pa-mono">Umur, BW, %Panen, Deplesi, IP</span> (age in days, body weight in kg,
        % harvested, depletion %, performance index). Each row is one flock at harvest; the file has no dates,
        farms or batches, so it is analysed separately from your daily farm records. Invalid rows are left out and
        listed; no value is filled in or changed.</p>
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <label class="visually-hidden" for="flock-file">Flock CSV file</label>
        <input class="form-control form-control-sm w-auto" type="file" id="flock-file" accept=".csv,text/csv" data-flock-file />
        <button type="button" class="btn btn-primary btn-sm" data-action="flock-upload" disabled>${icon("upload-cloud", { size: 14 })}Upload to HDFS and Hive</button>
      </div>
      <div class="mt-3" data-flock-result></div>`,
  });
}

/** Wires the card's events inside `root`; returns a cleanup function. */
export function bindFlockUpload(root) {
  const fileInput = $("[data-flock-file]", root);
  const button = $("[data-action=flock-upload]", root);
  const result = $("[data-flock-result]", root);
  const offs = [
    on(root, "change", "[data-flock-file]", () => {
      button.disabled = !fileInput.files?.length;
    }),
    on(root, "click", "[data-action=flock-upload]", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      button.disabled = true;
      setHtml(result, loadingState("Validating, writing to HDFS and checking the row count in Hive…", { compact: true }));
      try {
        const body = await uploadFlockCsv(file);
        const r = body.report;
        const problems = r.errors.length
          ? html`<ul class="pa-text-sm mb-0">${r.errors.map((e) => html`<li>Line ${e.line}: ${e.message}</li>`)}</ul>`
          : "";
        setHtml(
          result,
          html`${callout({
            tone: "success",
            title: "Stored in HDFS and available in Hive",
            message: `${formatNumber(r.acceptedRows)} of ${formatNumber(r.totalRows)} rows accepted, ${formatNumber(r.rejectedRows)} rejected, ${formatNumber(r.exactDuplicateRows)} exact duplicate rows kept as published. HDFS: ${body.hdfs.path} · Hive: ${body.hive.table} (${formatNumber(body.hive.rowCount)} rows counted by HiveQL). The dashboard shows the results.`,
          })}${problems}`,
        );
      } catch (error) {
        console.error(error);
        setHtml(result, errorState(error, { compact: true, retry: false }));
      } finally {
        button.disabled = !fileInput.files?.length;
      }
    }),
  ];
  return () => offs.forEach((off) => off());
}
