/**
 * Predictions — mortality risk, growth, feed and environmental forecasts for a batch.
 * Predictions are always visually distinct from measurements (purple dashed
 * series + "Predicted" badges) and accompanied by the not-a-diagnosis notice.
 */
import { chartCanvas, colors, lineChart } from "../charts/index.js";
import { icon } from "../components/icons.js";
import { setButtonLoading } from "../components/modal.js";
import { emptyState, errorState, loadingState } from "../components/states.js";
import { toast } from "../components/toast.js";
import { callout, card, pageHeader, predictionBadge, predictionDisclaimer, sampleBadge, selectOptions } from "../components/ui.js";
import { listBatches } from "../services/batches.js";
import {
  generatePrediction, getEnvironmentForecast, getFeedForecast, getGrowthForecast, getMortalityRisk,
} from "../services/predictions.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatDateTime, formatNumber, formatPercent, formatShortDate } from "../utils/format.js";
import "../styles/pages/predictions.css";

const HORIZONS = [7, 14];
const RISK = {
  low: { label: "Low risk", tone: "success", bar: "" },
  medium: { label: "Medium risk", tone: "warning", bar: "pa-progress__bar--warning" },
  high: { label: "High risk", tone: "danger", bar: "pa-progress__bar--danger" },
};

const SECTIONS = [
  { id: "risk", title: "Mortality risk", subtitle: "Probability of elevated mortality in the coming days", icon: "heart-pulse" },
  { id: "growth", title: "Growth prediction", subtitle: "Average body weight — measured vs predicted", icon: "trending-up" },
  { id: "feed", title: "Feed consumption forecast", subtitle: "Daily feed — measured vs predicted", icon: "wheat" },
  { id: "env", title: "Environmental forecast", subtitle: "Temperature and humidity — measured vs predicted", icon: "thermometer" },
];

function sectionBadges(source) {
  return html`${predictionBadge()}${source === "sample" ? html` ${sampleBadge("Sample preview")}` : ""}`;
}

function sampleNote(source) {
  if (source !== "sample") return "";
  return html`<div class="pa-pred-sample-note">${icon("info", { size: 14 })}Illustrative values — not produced by a trained model.</div>`;
}

function modelMeta(data) {
  return html`<div class="pa-meta-row pa-pred-meta">
    <span>${icon("cpu", { size: 12 })}Model: ${data.modelName || "—"}${data.modelVersion ? ` v${data.modelVersion}` : ""}</span>
    <span>${icon("clock", { size: 12 })}Generated ${formatDateTime(data.generatedAt)}</span>
  </div>`;
}

/** Joins measured history and forecast on one axis; the predicted series starts at the last measured point. */
function joinSeries(history, forecast, xKey, yKey) {
  const labels = [...history.map((h) => String(h[xKey])), ...forecast.map((f) => String(f[xKey]))];
  const actual = [...history.map((h) => h[yKey]), ...forecast.map(() => null)];
  const predicted = [...history.map((_, i) => (i === history.length - 1 ? history[i][yKey] : null)), ...forecast.map((f) => f[yKey])];
  return { labels, actual, predicted };
}

function statBlock(label, value, unit, badge) {
  return html`<div class="pa-stat">
    <span class="pa-stat__label">${label} ${badge || ""}</span>
    <span class="pa-stat__value">${value}${unit ? html`<span class="pa-kpi__unit">${unit}</span>` : ""}</span>
  </div>`;
}

export default {
  title: "Predictions",
  async render(root, ctx) {
    const state = { batchId: ctx.query.batch || "", horizon: 7, batches: [] };

    setHtml(
      root,
      html`${pageHeader({
          title: "Predictions",
          subtitle: "Model-based estimates to support flock management decisions.",
          actions: html`<label class="visually-hidden" for="pred-batch">Batch</label>
            <select class="form-select form-select-sm pa-pred-batch" id="pred-batch" data-filter="batch" disabled><option>Loading batches…</option></select>
            <div class="pa-segmented" role="group" aria-label="Forecast horizon">
              ${HORIZONS.map((h) => html`<button type="button" data-horizon="${h}" aria-pressed="${h === state.horizon}" title="Forecast ${h} days ahead">${h} days</button>`)}
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-action="generate" disabled>${icon("brain", { size: 14 })}Generate prediction</button>`,
        })}
        <div class="pa-section">${callout({
          tone: "warning",
          title: "Preview: no prediction model is trained yet",
          message:
            "The current development dataset (20 daily records: 2 farms × 10 days) is too small to train or fairly evaluate a mortality model; a one-line rule already matches its held-out days. The prediction API is not built, so panels show labelled sample previews or 'not available'. Details: docs/research/datasets.md.",
        })}</div>
        <div class="pa-section">${predictionDisclaimer()}</div>
        <div data-body>${loadingState("Loading batches…")}</div>`,
    );

    const body = $("[data-body]", root);
    const batchSelect = $("[data-filter=batch]", root);
    const generateBtn = $('[data-action="generate"]', root);

    function renderShell() {
      setHtml(
        body,
        html`<div class="pa-grid pa-grid--2 pa-pred-grid">
          ${SECTIONS.map((s) =>
            card({
              title: s.title,
              subtitle: s.subtitle,
              icon: s.icon,
              actions: html`<span class="d-flex gap-1 flex-wrap justify-content-end" data-badges="${s.id}"></span>`,
              body: html`<div data-section="${s.id}">${loadingState("Loading prediction…", { compact: true })}</div>`,
            }),
          )}
        </div>`,
      );
    }

    const holder = (id) => $(`[data-section="${id}"]`, body);
    const setBadges = (id, source) => setHtml($(`[data-badges="${id}"]`, body), sectionBadges(source));

    function renderRisk(data, source) {
      setBadges("risk", source);
      const risk = RISK[data.category] || RISK.low;
      const maxImportance = Math.max(...(data.features || []).map((f) => f.importance), 0) || 1;
      setHtml(
        holder("risk"),
        html`${sampleNote(source)}
          <div class="pa-risk">
            <div class="pa-risk__value pa-tabular">${formatPercent(data.probability * 100, 0)}</div>
            <div>
              <span class="pa-badge pa-badge--${risk.tone}"><span class="pa-badge__dot"></span>${risk.label}</span>
              <div class="pa-text-xs pa-text-2 mt-1">Estimated probability of elevated mortality</div>
            </div>
          </div>
          <div class="pa-risk__meter" aria-hidden="true">
            <div class="pa-progress"><div class="pa-progress__bar ${risk.bar}" style="width:${Math.round(data.probability * 100)}%"></div></div>
            <div class="pa-risk__scale"><span>Low</span><span>Medium</span><span>High</span></div>
          </div>
          <h3 class="pa-h4 mt-4 mb-2">Contributing factors</h3>
          ${data.features?.length
            ? html`<ul class="pa-features">
                ${data.features.map(
                  (f) => html`<li>
                    <span class="pa-features__name">${f.name}</span>
                    <span class="pa-features__bar"><span style="width:${Math.round((f.importance / maxImportance) * 100)}%"></span></span>
                    <span class="pa-features__value pa-tabular">${formatNumber(f.importance * 100, { decimals: 0 })}%</span>
                  </li>`,
                )}
              </ul>`
            : html`<p class="pa-text-sm pa-text-2 mb-0">No factor breakdown available for this model.</p>`}
          ${modelMeta(data)}`,
      );
    }

    function renderGrowth(data, source) {
      setBadges("growth", source);
      const history = (data.history || []).slice(-21);
      const forecast = data.forecast || [];
      if (!history.length) return setHtml(holder("growth"), emptyState({ icon: "scale", title: "No weight records", message: "Growth predictions need weight records for this batch.", compact: true }));
      const s = joinSeries(history, forecast, "ageDays", "avgWeightG");
      const lastF = forecast.at(-1);
      setHtml(
        holder("growth"),
        html`${sampleNote(source)}
          <div class="pa-pred-stats">
            ${statBlock("Current average", formatNumber(history.at(-1).avgWeightG), "g")}
            ${statBlock(`Predicted at day ${lastF?.ageDays ?? "—"}`, formatNumber(lastF?.avgWeightG), "g", predictionBadge())}
            ${statBlock("Forecast period", formatNumber(forecast.length), "days")}
          </div>
          ${chartCanvas("pred-growth-canvas", { label: "Measured and predicted average weight" })}
          ${modelMeta(data)}`,
      );
      lineChart($("#pred-growth-canvas", body), {
        labels: s.labels,
        datasets: [
          { label: "Measured", data: s.actual, color: colors.emerald },
          { label: "Predicted", data: s.predicted, color: colors.prediction, dashed: true },
        ],
        unit: "g",
        decimals: 0,
        yTitle: "Weight (g)",
        xTitle: "Age (days)",
      });
    }

    function renderFeed(data, source) {
      setBadges("feed", source);
      const history = data.history || [];
      const forecast = data.forecast || [];
      if (!history.length) return setHtml(holder("feed"), emptyState({ icon: "wheat", title: "No feed records", message: "Feed forecasts need feed records for this batch.", compact: true }));
      const s = joinSeries(history, forecast, "date", "feedKg");
      const last7 = history.slice(-7).reduce((sum, h) => sum + h.feedKg, 0);
      setHtml(
        holder("feed"),
        html`${sampleNote(source)}
          <div class="pa-pred-stats">
            ${statBlock("Last 7 days (measured)", formatNumber(last7, { decimals: 0 }), "kg")}
            ${statBlock(`Next ${forecast.length} days`, formatNumber(data.totalForecastKg, { decimals: 0 }), "kg", predictionBadge())}
            ${statBlock("Forecast daily average", formatNumber(forecast.length ? data.totalForecastKg / forecast.length : null, { decimals: 0 }), "kg")}
          </div>
          ${chartCanvas("pred-feed-canvas", { label: "Measured and predicted feed consumption" })}
          ${modelMeta(data)}`,
      );
      lineChart($("#pred-feed-canvas", body), {
        labels: s.labels,
        datasets: [
          { label: "Measured", data: s.actual, color: colors.warning },
          { label: "Predicted", data: s.predicted, color: colors.prediction, dashed: true },
        ],
        unit: "kg",
        decimals: 0,
        yTitle: "kg / day",
      });
    }

    function renderEnv(data, source) {
      setBadges("env", source);
      const history = data.history || [];
      const forecast = data.forecast || [];
      if (!history.length) return setHtml(holder("env"), emptyState({ icon: "thermometer", title: "No environmental records", message: "Forecasts need temperature and humidity readings for this farm.", compact: true }));
      const t = joinSeries(history, forecast, "date", "temperatureC");
      const h = joinSeries(history, forecast, "date", "humidityPct");
      const first = forecast[0];
      setHtml(
        holder("env"),
        html`${sampleNote(source)}
          <div class="pa-pred-stats">
            ${statBlock("Forecast temperature", formatNumber(first?.temperatureC, { decimals: 1 }), "°C", predictionBadge())}
            ${statBlock("Forecast humidity", formatNumber(first?.humidityPct, { decimals: 1 }), "% RH", predictionBadge())}
            ${statBlock("Period", forecast.length ? `${formatShortDate(forecast[0].date)} – ${formatShortDate(forecast.at(-1).date)}` : "—")}
          </div>
          <div class="pa-pred-env">
            <div><div class="pa-overline mb-1">Temperature</div>${chartCanvas("pred-temp-canvas", { size: "sm", label: "Measured and predicted temperature" })}</div>
            <div><div class="pa-overline mb-1">Relative humidity</div>${chartCanvas("pred-hum-canvas", { size: "sm", label: "Measured and predicted humidity" })}</div>
          </div>
          ${modelMeta(data)}`,
      );
      lineChart($("#pred-temp-canvas", body), {
        labels: t.labels,
        datasets: [
          { label: "Measured", data: t.actual, color: colors.danger },
          { label: "Predicted", data: t.predicted, color: colors.prediction, dashed: true },
        ],
        unit: "°C",
        decimals: 1,
      });
      lineChart($("#pred-hum-canvas", body), {
        labels: h.labels,
        datasets: [
          { label: "Measured", data: h.actual, color: colors.info },
          { label: "Predicted", data: h.predicted, color: colors.prediction, dashed: true },
        ],
        unit: "%",
        decimals: 1,
      });
    }

    async function section(id, loader, render) {
      try {
        const result = await loader();
        if (ctx.isCurrent()) render(result.data, result.source);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        setHtml($(`[data-badges="${id}"]`, body), "");
        setHtml(holder(id), errorState(error, { compact: true }));
      }
    }

    async function loadPredictions() {
      const batch = state.batches.find((b) => String(b.id) === String(state.batchId));
      if (!batch) return;
      renderShell();
      const params = { batchId: batch.id, horizonDays: state.horizon };
      await Promise.all([
        section("risk", () => getMortalityRisk(params), renderRisk),
        section("growth", () => getGrowthForecast(params), renderGrowth),
        section("feed", () => getFeedForecast(params), renderFeed),
        section("env", () => getEnvironmentForecast({ farmId: batch.farmId, horizonDays: state.horizon }), renderEnv),
      ]);
    }

    async function loadBatches() {
      setHtml(body, loadingState("Loading batches…"));
      try {
        const { data } = await listBatches({ status: "active" });
        if (!ctx.isCurrent()) return;
        state.batches = data;
        if (!data.length) {
          batchSelect.disabled = true;
          generateBtn.disabled = true;
          setHtml(batchSelect, html`<option>No active batches</option>`);
          setHtml(
            body,
            html`<div class="pa-card">${emptyState({
              icon: "bird",
              title: "No active batches",
              message: "Predictions are generated per active poultry batch. Add a batch to get started.",
              action: html`<a class="btn btn-primary btn-sm" href="#/batches">${icon("plus", { size: 14 })}Go to batches</a>`,
            })}</div>`,
          );
          return;
        }
        if (!data.some((b) => String(b.id) === String(state.batchId))) state.batchId = String(data[0].id);
        setHtml(batchSelect, selectOptions(data.map((b) => ({ value: b.id, label: `${b.code} · ${b.farmName}` })), state.batchId));
        batchSelect.disabled = false;
        generateBtn.disabled = false;
        await loadPredictions();
      } catch (error) {
        if (!ctx.isCurrent()) return;
        setHtml(batchSelect, html`<option>Batches unavailable</option>`);
        setHtml(body, html`<div class="pa-card" data-batches-error>${errorState(error)}</div>`);
      }
    }

    async function generate() {
      setButtonLoading(generateBtn, true, "Requesting…");
      try {
        await generatePrediction({ batchId: state.batchId, type: "all" });
        if (!ctx.isCurrent()) return;
        toast.success("Prediction requested", "New predictions were generated for the selected batch.");
        await loadPredictions();
      } catch (error) {
        toast.apiError(error, "Prediction not generated");
      } finally {
        if (generateBtn.isConnected) setButtonLoading(generateBtn, false);
      }
    }

    const offs = [
      on(root, "change", "[data-filter=batch]", (e) => {
        state.batchId = e.target.value;
        loadPredictions();
      }),
      on(root, "click", "[data-horizon]", (_e, btn) => {
        state.horizon = Number(btn.dataset.horizon);
        root.querySelectorAll("[data-horizon]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        loadPredictions();
      }),
      on(root, "click", '[data-action="generate"]', generate),
      on(root, "click", '[data-action="retry"]', () => (state.batches.length ? loadPredictions() : loadBatches())),
    ];
    ctx.onCleanup(() => offs.forEach((off) => off()));

    await loadBatches();
  },
};
