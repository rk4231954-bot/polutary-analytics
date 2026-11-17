/** Data Collection — manual daily readings per batch, plus recent readings. */
import { setButtonLoading } from "../components/modal.js";
import { createDataTable } from "../components/dataTable.js";
import { icon } from "../components/icons.js";
import { errorState, loadingState } from "../components/states.js";
import { toast } from "../components/toast.js";
import { callout, card, pageHeader, selectOptions, sourceBadge } from "../components/ui.js";
import { config } from "../config.js";
import { listBatches } from "../services/batches.js";
import { listFarms } from "../services/farms.js";
import { createReading, listReadings } from "../services/readings.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatDate, formatNumber, toIsoDate } from "../utils/format.js";
import { applyServerErrors, liveValidate, rules, validateForm } from "../utils/validation.js";
import "../styles/pages/farms.css";
import "../styles/pages/dataCollection.css";

const readingRules = {
  batchId: [rules.required("Batch")],
  date: [rules.required("Date"), rules.date({ notFuture: true, label: "Date" })],
  temperatureC: [rules.required("Temperature"), rules.number({ min: -10, max: 50, label: "Temperature" })],
  humidityPct: [rules.required("Humidity"), rules.number({ min: 0, max: 100, label: "Humidity" })],
  feedKg: [rules.required("Feed"), rules.number({ min: 0, max: 100000, label: "Feed" })],
  waterL: [rules.number({ min: 0, max: 500000, label: "Water" })],
  mortality: [rules.required("Mortality"), rules.number({ min: 0, max: 200000, integer: true, label: "Mortality" })],
  avgWeightG: [rules.number({ min: 1, max: 10000, label: "Average weight" })],
  notes: [rules.maxLength(500, "Notes")],
};

const PIPELINE = [
  { icon: "save", title: "Saved by the API", text: "Validated and stored as an application record." },
  { icon: "hard-drive", title: "Exported to HDFS", text: "Included in the processed dataset written to Hadoop HDFS." },
  { icon: "database", title: "Queried in Hive", text: "Available to HiveQL analytics on Apache Hive." },
  { icon: "brain", title: "Used by models", text: "Feeds dashboards, reports and model training." },
];

function numberField(name, label, { unit, required = false, step = "any", min, max, hint, col = "col-sm-6" }) {
  return html`<div class="${col} pa-field">
    <label class="form-label ${required ? "pa-required" : ""}" for="r-${name}">${label}</label>
    <div class="input-group has-validation">
      <input class="form-control" type="number" id="r-${name}" name="${name}" step="${step}" ${min !== undefined ? html`min="${min}"` : ""} ${max !== undefined ? html`max="${max}"` : ""} inputmode="decimal" autocomplete="off" />
      <span class="input-group-text">${unit}</span>
    </div>
    <div class="invalid-feedback" id="r-${name}-error"></div>
    ${hint ? html`<div class="form-text">${hint}</div>` : ""}
  </div>`;
}

export default {
  title: "Data Collection",
  async render(root, ctx) {
    const state = { farmId: "", batchId: ctx.query.batch || "", batches: [] };
    let table = null;
    const today = toIsoDate(new Date());

    setHtml(
      root,
      html`${pageHeader({
          title: "Data Collection",
          subtitle: "Record daily environmental and production readings for each batch.",
          actions: html`<a class="btn btn-secondary" href="#/datasets/upload">${icon("upload-cloud", { size: 16 })}Upload a CSV instead</a>`,
        })}
        <div class="pa-section pa-grid pa-grid--main-side">
          ${card({
            title: "Record daily readings",
            subtitle: "One entry per batch per day. Fields marked * are required.",
            icon: "clipboard",
            bordered: true,
            body: html`<form class="pa-reading-form" novalidate data-form>
              <div class="row g-3">
                <div class="col-sm-8 pa-field">
                  <label class="form-label pa-required" for="r-batchId">Batch</label>
                  <select class="form-select" id="r-batchId" name="batchId" data-batch-select disabled><option value="">Loading batches…</option></select>
                  <div class="invalid-feedback" id="r-batchId-error"></div>
                  <div class="form-text" data-batch-hint></div>
                </div>
                <div class="col-sm-4 pa-field">
                  <label class="form-label pa-required" for="r-date">Date</label>
                  <input class="form-control" type="date" id="r-date" name="date" value="${today}" max="${today}" />
                  <div class="invalid-feedback" id="r-date-error"></div>
                </div>
              </div>
              <fieldset class="pa-reading-group">
                <legend class="pa-overline">Environment</legend>
                <div class="row g-3">
                  ${numberField("temperatureC", "Average temperature", { unit: "°C", required: true, step: "0.1", min: -10, max: 50 })}
                  ${numberField("humidityPct", "Relative humidity", { unit: "%", required: true, step: "0.1", min: 0, max: 100 })}
                </div>
              </fieldset>
              <fieldset class="pa-reading-group">
                <legend class="pa-overline">Production</legend>
                <div class="row g-3">
                  ${numberField("feedKg", "Feed consumed", { unit: "kg", required: true, step: "0.1", min: 0 })}
                  ${numberField("waterL", "Water consumed", { unit: "L", step: "0.1", min: 0, hint: "Optional" })}
                  ${numberField("mortality", "Mortality", { unit: "birds", required: true, step: "1", min: 0 })}
                  ${numberField("avgWeightG", "Average body weight", { unit: "g", step: "1", min: 1, hint: "Optional — from a sample weighing" })}
                </div>
              </fieldset>
              <div class="pa-field mt-3">
                <label class="form-label" for="r-notes">Notes</label>
                <textarea class="form-control" id="r-notes" name="notes" rows="2" maxlength="500" placeholder="Observations, e.g. ventilation change or vaccination"></textarea>
                <div class="invalid-feedback" id="r-notes-error"></div>
              </div>
              <div class="pa-reading-actions">
                ${config.demoMode ? html`<span class="pa-text-xs pa-text-2 me-auto">${icon("info", { size: 13 })} Saving requires the Flask API.</span>` : html`<span class="me-auto"></span>`}
                <button type="reset" class="btn btn-secondary">Clear</button>
                <button type="submit" class="btn btn-primary">${icon("save", { size: 16 })}Save reading</button>
              </div>
            </form>`,
          })}
          <div class="d-flex flex-column gap-3">
            ${card({
              title: "Where readings go",
              icon: "workflow",
              body: html`<ol class="pa-pipeline">
                ${PIPELINE.map(
                  (p, i) => html`<li>
                    <span class="pa-pipeline__icon">${icon(p.icon, { size: 15 })}</span>
                    <div><div class="pa-pipeline__title">${i + 1}. ${p.title}</div><div class="pa-text-sm pa-text-2">${p.text}</div></div>
                  </li>`,
                )}
              </ol>`,
              footer: "HDFS export and Hive analytics are implemented in later project stages (7–9).",
            })}
            ${callout({
              tone: "info",
              title: "Accepted ranges",
              message: "Temperature −10 to 50 °C, humidity 0–100 %, non-negative feed and water, whole-number mortality. Out-of-range values are rejected here and again by the API.",
            })}
          </div>
        </div>
        ${card({
          title: "Recent readings",
          subtitle: "Latest entries across batches",
          icon: "history",
          actions: html`<span data-source></span>`,
          flush: true,
          body: html`<div class="pa-toolbar">
              <label class="visually-hidden" for="rr-farm">Farm</label>
              <select class="form-select form-select-sm" id="rr-farm" data-filter="farm"><option value="">All farms</option></select>
              <label class="visually-hidden" for="rr-batch">Batch</label>
              <select class="form-select form-select-sm" id="rr-batch" data-filter="batch"><option value="">All batches</option></select>
            </div>
            <div class="pa-fm-table" data-table>${loadingState("Loading readings…", { compact: true })}</div>`,
        })}`,
    );

    const form = $("[data-form]", root);
    liveValidate(form, readingRules);

    function batchOptions(filterFarm) {
      return state.batches
        .filter((b) => !filterFarm || String(b.farmId) === String(filterFarm))
        .map((b) => ({ value: b.id, label: `${b.code} · ${b.farmName}` }));
    }

    async function loadOptions() {
      const select = $("[data-batch-select]", root);
      try {
        const [{ data: batches }, farms] = await Promise.all([
          listBatches({ status: "active" }),
          listFarms().then((r) => r.data).catch(() => []),
        ]);
        if (!ctx.isCurrent()) return;
        state.batches = batches;
        const options = batchOptions();
        select.disabled = options.length === 0;
        setHtml(select, html`<option value="">${options.length ? "Select an active batch" : "No active batches"}</option>${selectOptions(options, state.batchId)}`);
        $("[data-batch-hint]", root).textContent = options.length ? "" : "Add or activate a batch under Poultry Batches first.";
        setHtml($("[data-filter=farm]", root), html`<option value="">All farms</option>${selectOptions(farms.map((f) => ({ value: f.id, label: f.name })), "")}`);
        setHtml($("[data-filter=batch]", root), html`<option value="">All batches</option>${selectOptions(options, state.batchId)}`);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        setHtml(select, html`<option value="">Batches unavailable</option>`);
        $("[data-batch-hint]", root).textContent = error.isNetworkError ? "Cannot load batches: the Flask API is not reachable." : error.message;
      }
    }

    async function loadReadings() {
      const holder = $("[data-table]", root);
      setHtml(holder, loadingState("Loading readings…", { compact: true }));
      try {
        const { data, source } = await listReadings({ farmId: state.farmId, batchId: $("[data-filter=batch]", root).value, limit: 100 });
        if (!ctx.isCurrent()) return;
        setHtml($("[data-source]", root), sourceBadge(source));
        table?.destroy();
        table = createDataTable(holder, {
          caption: "Recent daily readings",
          rows: data,
          pageSize: 10,
          sortKey: "date",
          sortDir: "desc",
          empty: { icon: "clipboard", title: "No readings yet", message: "Saved readings will appear here." },
          columns: [
            { key: "date", label: "Date", sortable: true, render: (r) => formatDate(r.date) },
            { key: "batchCode", label: "Batch", sortable: true, render: (r) => html`<a class="pa-cell-primary" href="#/batches/${r.batchId}">${r.batchCode}</a><span class="pa-cell-secondary">${r.farmName}</span>` },
            { key: "temperatureC", label: "Temp (°C)", sortable: true, align: "num", render: (r) => formatNumber(r.temperatureC, { decimals: 1 }) },
            { key: "humidityPct", label: "RH (%)", sortable: true, align: "num", render: (r) => formatNumber(r.humidityPct, { decimals: 1 }) },
            { key: "feedKg", label: "Feed (kg)", sortable: true, align: "num", render: (r) => formatNumber(r.feedKg, { decimals: 1 }) },
            { key: "waterL", label: "Water (L)", sortable: true, align: "num", render: (r) => formatNumber(r.waterL, { decimals: 1 }) },
            { key: "mortality", label: "Deaths", sortable: true, align: "num", render: (r) => formatNumber(r.mortality) },
            { key: "avgWeightG", label: "Weight (g)", sortable: true, align: "num", render: (r) => formatNumber(r.avgWeightG) },
            { key: "recordedBy", label: "Recorded by", sortable: true, render: (r) => html`<span class="pa-text-2">${r.recordedBy || "—"}</span>` },
          ],
        });
      } catch (error) {
        if (!ctx.isCurrent()) return;
        table?.destroy();
        table = null;
        setHtml(holder, errorState(error, { compact: true }));
      }
    }

    async function submit(e) {
      e.preventDefault();
      const { valid, values } = validateForm(form, readingRules);
      if (!valid) return;
      const toNum = (v) => (v === "" || v === undefined ? null : Number(v));
      const payload = {
        batchId: Number(values.batchId),
        date: values.date,
        temperatureC: toNum(values.temperatureC),
        humidityPct: toNum(values.humidityPct),
        feedKg: toNum(values.feedKg),
        waterL: toNum(values.waterL),
        mortality: toNum(values.mortality),
        avgWeightG: toNum(values.avgWeightG),
        notes: values.notes || null,
      };
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true, "Saving…");
      try {
        await createReading(payload);
        if (!ctx.isCurrent()) return;
        toast.success("Reading saved", `Daily reading for ${formatDate(payload.date)} was recorded.`);
        form.reset();
        $("#r-date", root).value = today;
        $("[data-batch-select]", root).value = String(payload.batchId);
        loadReadings();
      } catch (error) {
        applyServerErrors(form, error.fields);
        toast.apiError(error, "Reading not saved");
      } finally {
        if (button.isConnected) setButtonLoading(button, false);
      }
    }

    const offs = [
      on(root, "submit", "[data-form]", submit),
      on(root, "reset", "[data-form]", () => {
        form.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));
        setTimeout(() => {
          $("#r-date", root).value = today;
        });
      }),
      on(root, "change", "[data-filter=farm]", (e) => {
        state.farmId = e.target.value;
        setHtml($("[data-filter=batch]", root), html`<option value="">All batches</option>${selectOptions(batchOptions(state.farmId), "")}`);
        loadReadings();
      }),
      on(root, "change", "[data-filter=batch]", () => loadReadings()),
      on(root, "click", '[data-action="retry"]', () => loadReadings()),
    ];
    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      table?.destroy();
    });

    await loadOptions();
    await loadReadings();
  },
};
