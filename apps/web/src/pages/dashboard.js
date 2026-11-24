/**
 * Dashboard — overview of farm operations.
 * Reference implementation for page structure: header + filters, sections that
 * load independently (each with loading / empty / error states), charts created
 * through charts/index.js, and sample badges driven by the service `source`.
 */
import { barChart, chartCanvas, colors, hasData, lineChart, palette } from "../charts/index.js";
import { icon } from "../components/icons.js";
import { emptyState, errorState, loadingState, skeletonKpis } from "../components/states.js";
import { card, kpiCard, pageHeader, selectOptions, sourceBadge, trend } from "../components/ui.js";
import { getActivity, getAlerts, getDailyRecords, getFarmComparison, getGrowthCurves, getSummary } from "../services/analytics.js";
import { listFarms } from "../services/farms.js";
import { getFlockSummary } from "../services/flockPerformance.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatDate, formatNumber, formatPercent, formatRelative, formatWeightKg } from "../utils/format.js";
import "../styles/pages/dashboard.css";

const RANGES = [
  { days: 7, label: "7D" },
  { days: 30, label: "30D" },
  { days: 90, label: "90D" },
];

const COMPARISON_METRICS = {
  mortalityRatePct: { label: "Mortality rate", unit: "%", decimals: 2, color: colors.danger },
  avgWeightG: { label: "Average weight", unit: "g", decimals: 0, color: colors.emerald },
  feedPerBirdKg: { label: "Feed per bird", unit: "kg", decimals: 2, color: colors.warning },
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Pivots per-farm daily rows into chart labels + one dataset per farm. */
function seriesByFarm(records, key) {
  const labels = [...new Set(records.map((r) => r.date))].sort();
  const farms = [...new Map(records.map((r) => [r.farmId, r.farmName])).entries()];
  const datasets = farms.map(([farmId, farmName], i) => {
    const byDate = new Map(records.filter((r) => r.farmId === farmId).map((r) => [r.date, r[key]]));
    return { label: farmName, data: labels.map((d) => byDate.get(d) ?? null), color: palette[i % palette.length] };
  });
  return { labels, datasets };
}

function totalsByDate(records, key) {
  const totals = new Map();
  for (const r of records) totals.set(r.date, (totals.get(r.date) || 0) + (r[key] || 0));
  const labels = [...totals.keys()].sort();
  return { labels, values: labels.map((d) => Math.round(totals.get(d) * 10) / 10) };
}

function movingAverage(values, window = 7) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.length < Math.min(window, 3) ? null : slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

const CHARTS = [
  { id: "temperature", title: "Temperature", subtitle: "Daily average house temperature", icon: "thermometer" },
  { id: "humidity", title: "Relative humidity", subtitle: "Daily average relative humidity", icon: "droplets" },
  { id: "feed", title: "Daily feed consumption", subtitle: "Total feed delivered across farms", icon: "wheat" },
  { id: "growth", title: "Growth curves", subtitle: "Average body weight by flock age", icon: "trending-up" },
  { id: "mortality", title: "Mortality", subtitle: "Daily deaths with 7-day average", icon: "heart-pulse" },
  { id: "comparison", title: "Farm performance comparison", subtitle: "Selected period, per farm", icon: "bar-chart" },
];

export default {
  title: "Dashboard",
  async render(root, ctx) {
    const state = { farmId: ctx.query.farm || "", days: Number(ctx.query.days) || Number(localStorage.getItem("pa-pref-dashboard-days")) || 30, metric: "mortalityRatePct", comparison: null };
    const firstName = ctx.user?.isPreview ? "" : (ctx.user?.fullName || "").split(" ")[0];

    setHtml(
      root,
      html`${pageHeader({
          title: `${greeting()}${firstName ? `, ${firstName}` : ""}`,
          subtitle: "Monitor your poultry operations and farm performance.",
          actions: html`<label class="visually-hidden" for="dash-farm">Farm</label>
            <select class="form-select form-select-sm pa-dash-farm" id="dash-farm" data-filter="farm">
              <option value="">All farms</option>
            </select>
            <div class="pa-segmented" role="group" aria-label="Date range">
              ${RANGES.map((r) => html`<button type="button" data-range="${r.days}" aria-pressed="${r.days === state.days}" title="Last ${r.days} days">${r.label}</button>`)}
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-action="refresh">${icon("refresh", { size: 14 })}Refresh</button>`,
        })}
        <section class="pa-section" aria-labelledby="kpi-heading">
          <div class="pa-section-head">
            <h2 class="pa-section-title" id="kpi-heading">Key metrics <span class="pa-text-2 fw-normal pa-text-sm" data-range-label></span></h2>
            <span data-kpi-source></span>
          </div>
          <div data-kpis>${skeletonKpis()}</div>
        </section>
        <section class="pa-section" aria-label="Analytics charts">
          <div class="pa-grid pa-grid--2">
            ${CHARTS.map((c) =>
              card({
                id: `chart-${c.id}`,
                title: c.title,
                subtitle: c.subtitle,
                icon: c.icon,
                actions:
                  c.id === "comparison"
                    ? html`<label class="visually-hidden" for="cmp-metric">Comparison metric</label>
                      <select class="form-select form-select-sm" id="cmp-metric" data-filter="metric">
                        ${Object.entries(COMPARISON_METRICS).map(([k, m]) => html`<option value="${k}">${m.label}</option>`)}
                      </select>`
                    : html`<span data-chart-badge="${c.id}"></span>`,
                body: html`<div data-chart="${c.id}">${loadingState("Loading chart…", { compact: true })}</div>`,
              }),
            )}
          </div>
        </section>
        <section class="pa-grid pa-grid--main-side">
          ${card({
            title: "Farm monitoring alerts",
            subtitle: "Statistical signals from the latest Hive records. Not a diagnosis; check the flock.",
            icon: "alert-triangle",
            actions: html`<span data-alerts-badge></span>`,
            body: html`<div data-alerts>${loadingState("Loading alerts…", { compact: true })}</div>`,
            flush: true,
          })}
          ${card({
            title: "Recent activity",
            icon: "history",
            actions: html`<span data-activity-badge></span>`,
            body: html`<div data-activity>${loadingState("Loading activity…", { compact: true })}</div>`,
            flush: true,
          })}
        </section>
        <section class="pa-section" aria-labelledby="flock-heading">
          <div class="pa-section-head">
            <h2 class="pa-section-title" id="flock-heading">Broiler flock benchmarks <span class="pa-text-2 fw-normal pa-text-sm">· Kaggle dataset, HiveQL results</span></h2>
            <span class="pa-text-2 pa-text-sm" data-flock-table></span>
          </div>
          <div data-flock>${loadingState("Loading flock benchmarks…", { compact: true })}</div>
        </section>`,
    );

    const farmSelect = $("[data-filter=farm]", root);

    async function loadFarms() {
      try {
        const { data: farms } = await listFarms();
        if (!ctx.isCurrent()) return;
        setHtml(farmSelect, html`<option value="">All farms</option>${selectOptions(farms.map((f) => ({ value: f.id, label: f.name })), state.farmId)}`);
      } catch {
        // Farm list unavailable: keep "All farms" only; the sections below show the API error.
      }
    }

    function renderKpis(summary, source) {
      setHtml($("[data-kpi-source]", root), sourceBadge(source));
      setHtml(
        $("[data-kpis]", root),
        html`<div class="pa-grid pa-grid--kpi">
          ${kpiCard({ label: "Total farms", value: formatNumber(summary.totalFarms), icon: "warehouse", footnote: state.farmId ? "Selected farm" : "Registered farms" })}
          ${kpiCard({ label: "Active poultry batches", value: formatNumber(summary.activeBatches), icon: "layers", tone: "info", footnote: "Currently in production" })}
          ${kpiCard({ label: "Total birds", value: summary.totalBirds >= 100000 ? formatNumber(summary.totalBirds, { compact: true, decimals: 1 }) : formatNumber(summary.totalBirds), icon: "bird", footnote: "Live birds in active batches" })}
          ${kpiCard({
            label: "Feed consumption",
            value: formatNumber(summary.feedKg / 1000, { decimals: 1 }),
            unit: "t",
            icon: "wheat",
            tone: "warning",
            trend: trend(summary.trends?.feedKg, { goodWhen: "neutral" }),
            footnote: `vs previous ${state.days} days`,
          })}
          ${kpiCard({
            label: "Mortality rate",
            value: formatPercent(summary.mortalityRatePct, 2),
            icon: "heart-pulse",
            tone: "danger",
            trend: trend(summary.trends?.mortalityRatePct, { goodWhen: "down" }),
            footnote: `vs previous ${state.days} days`,
          })}
          ${kpiCard({ label: "Average bird weight", value: formatWeightKg(summary.avgWeightG), unit: "kg", icon: "scale", footnote: "Weighted across active batches" })}
        </div>`,
      );
    }

    function chartBody(id, { size, label }) {
      setHtml($(`[data-chart="${id}"]`, root), chartCanvas(`canvas-${id}`, { size, label }));
      return $(`#canvas-${id}`, root);
    }

    function chartEmpty(id, message) {
      setHtml($(`[data-chart="${id}"]`, root), emptyState({ icon: "line-chart", title: "No data for this period", message, compact: true }));
    }

    function renderDailyCharts(records, source) {
      ["temperature", "humidity", "feed", "mortality"].forEach((id) => setHtml($(`[data-chart-badge="${id}"]`, root), sourceBadge(source)));
      const noData = "Upload a dataset or record daily readings to populate this chart.";

      const temp = seriesByFarm(records, "temperatureC");
      if (hasData(temp.datasets)) lineChart(chartBody("temperature", { label: "Temperature trend by farm" }), { ...temp, unit: "°C", decimals: 1, yTitle: "°C" });
      else chartEmpty("temperature", noData);

      const hum = seriesByFarm(records, "humidityPct");
      if (hasData(hum.datasets)) lineChart(chartBody("humidity", { label: "Humidity trend by farm" }), { ...hum, unit: "%", decimals: 1, yTitle: "% RH" });
      else chartEmpty("humidity", noData);

      const feed = totalsByDate(records, "feedKg");
      if (feed.values.some((v) => v > 0))
        barChart(chartBody("feed", { label: "Daily feed consumption" }), {
          labels: feed.labels,
          datasets: [{ label: "Feed", data: feed.values, color: colors.warning }],
          unit: "kg",
          decimals: 0,
          yTitle: "kg",
          showLegend: false,
        });
      else chartEmpty("feed", noData);

      const deaths = totalsByDate(records, "mortality");
      if (deaths.values.length)
        barChart(chartBody("mortality", { label: "Daily mortality with 7-day average" }), {
          labels: deaths.labels,
          datasets: [
            { label: "Deaths", data: deaths.values, color: colors.danger, muted: true },
            { label: "7-day average", data: movingAverage(deaths.values), color: colors.danger, type: "line" },
          ],
          unit: "birds",
          decimals: 1,
          yTitle: "Birds",
        });
      else chartEmpty("mortality", noData);
    }

    function renderGrowth(batches, source) {
      setHtml($('[data-chart-badge="growth"]', root), sourceBadge(source));
      const maxAge = Math.max(0, ...batches.flatMap((b) => b.points.map((p) => p.ageDays)));
      const labels = Array.from({ length: maxAge + 1 }, (_, i) => String(i));
      const datasets = batches.map((b, i) => {
        const byAge = new Map(b.points.map((p) => [p.ageDays, p.avgWeightG]));
        return { label: `${b.code} (${b.poultryType})`, data: labels.map((a) => byAge.get(Number(a)) ?? null), color: palette[i % palette.length] };
      });
      if (!hasData(datasets)) return chartEmpty("growth", "Weight records for batches will appear here.");
      lineChart(chartBody("growth", { label: "Growth curves by batch" }), { labels, datasets, unit: "g", decimals: 0, yTitle: "Weight (g)", xTitle: "Age (days)" });
    }

    function renderComparison() {
      const { data, source } = state.comparison;
      const metric = COMPARISON_METRICS[state.metric];
      const rows = data.filter((f) => f[state.metric] !== null && f[state.metric] !== undefined);
      const holder = $('[data-chart="comparison"]', root);
      if (!rows.length) return chartEmpty("comparison", "Comparison needs data from at least one farm.");
      setHtml(holder, html`<div class="mb-2">${sourceBadge(source)}</div>${chartCanvas("canvas-comparison", { label: `${metric.label} by farm` })}`);
      barChart($("#canvas-comparison", root), {
        labels: rows.map((r) => r.farmName.replace("Sample Farm — ", "Sample · ")),
        datasets: [{ label: metric.label, data: rows.map((r) => r[state.metric]), color: metric.color }],
        unit: metric.unit,
        decimals: metric.decimals,
        horizontal: true,
        showLegend: false,
      });
    }

    const ALERT_ICONS = { temperature: "thermometer", humidity: "droplets", mortality: "heart-pulse", feed: "wheat" };
    function renderAlerts(alerts, source) {
      setHtml($("[data-alerts-badge]", root), sourceBadge(source));
      if (!alerts.length) {
        setHtml($("[data-alerts]", root), emptyState({ icon: "shield-check", title: "No active alerts", message: "Each farm's latest readings are within the range expected from its recent trend.", compact: true }));
        return;
      }
      setHtml(
        $("[data-alerts]", root),
        html`<ul class="pa-list">
          ${alerts.map(
            (a) => html`<li class="pa-list-item">
              <span class="pa-list-item__icon pa-list-item__icon--${a.severity}">${icon(ALERT_ICONS[a.type] || "alert-triangle", { size: 16 })}</span>
              <div class="pa-list-item__body">
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <span class="pa-list-item__title">${a.title}</span>
                  <span class="pa-badge pa-badge--${a.severity}">${a.severity === "danger" ? "High" : "Medium"}</span>
                </div>
                <p class="pa-list-item__text">${a.message}</p>
                <div class="pa-meta-row mt-1"><span>${icon("map-pin", { size: 12 })}${a.farmName}</span><span>${icon("clock", { size: 12 })}${a.date ? `Records of ${formatDate(a.date)}` : formatRelative(a.createdAt)}</span></div>
              </div>
            </li>`,
          )}
        </ul>`,
      );
    }

    const ACTIVITY_ICONS = { upload: ["upload", "info"], farm: ["warehouse", "success"], prediction: ["brain", "warning"], user: ["user", ""] };
    function renderActivity(items, source) {
      setHtml($("[data-activity-badge]", root), sourceBadge(source));
      if (!items.length) {
        setHtml($("[data-activity]", root), emptyState({ icon: "history", title: "No recent activity", message: "Uploads and farm, batch and account changes will be listed here.", compact: true }));
        return;
      }
      setHtml(
        $("[data-activity]", root),
        html`<ul class="pa-list pa-activity">
          ${items.map((a) => {
            const [ic, tone] = ACTIVITY_ICONS[a.type] || ["activity", ""];
            return html`<li class="pa-list-item">
              <span class="pa-list-item__icon ${tone ? `pa-list-item__icon--${tone}` : ""}">${icon(ic, { size: 15 })}</span>
              <div class="pa-list-item__body">
                <div class="pa-list-item__title pa-text-sm">${a.message}</div>
                <p class="pa-list-item__text pa-text-xs">${a.actor} · ${formatRelative(a.createdAt)}</p>
              </div>
            </li>`;
          })}
        </ul>`,
      );
    }

    function renderFlock(summary) {
      const target = $("[data-flock]", root);
      const ds = summary.dataset;
      setHtml($("[data-flock-table]", root), `Hive table ${summary.source.table}`);
      const sourceNote = html`<p class="pa-text-2 pa-text-sm mt-3 mb-0">Source: <a href="${ds.url}" target="_blank" rel="noopener noreferrer">${ds.name}</a>
        (${ds.publisher}, ${ds.license}, file “${ds.file}”). ${ds.note} These are public benchmark flocks, not your farms' records, so the farm and date filters above don't apply.</p>`;
      if (!summary.loaded) {
        setHtml(
          target,
          card({
            body: html`${emptyState({
              icon: "upload-cloud",
              title: "Flock dataset not loaded",
              message: "An administrator can upload PS Performance.csv in Data Management → CSV Upload. It is stored in HDFS and queried in Hive.",
              compact: true,
            })}${sourceNote}`,
          }),
        );
        return;
      }
      const n = (v, decimals) => formatNumber(v, { decimals });
      const r = (v) => (v === null || v === undefined ? "n/a" : n(v, 3));
      const bands = summary.depletionBands;
      setHtml(
        target,
        html`<div class="pa-grid pa-grid--kpi">
            ${kpiCard({ label: "Flocks analysed", value: n(summary.flocks, 0), icon: "bird", footnote: "One row per flock at harvest" })}
            ${kpiCard({ label: "Average harvest age", value: n(summary.ageDays.avg, 1), unit: "days", icon: "calendar", tone: "info", footnote: `Range ${n(summary.ageDays.min, 1)}–${n(summary.ageDays.max, 1)} days` })}
            ${kpiCard({ label: "Average body weight", value: n(summary.bodyWeightKg.avg, 2), unit: "kg", icon: "scale", footnote: `Range ${n(summary.bodyWeightKg.min, 2)}–${n(summary.bodyWeightKg.max, 2)} kg` })}
            ${kpiCard({ label: "Average depletion", value: formatPercent(summary.depletionPct.avg, 2), icon: "heart-pulse", tone: "danger", footnote: `Dead + culled · range ${formatPercent(summary.depletionPct.min, 2)}–${formatPercent(summary.depletionPct.max, 2)}` })}
            ${kpiCard({ label: "Average harvested", value: formatPercent(summary.harvestPct.avg, 1), icon: "layers", tone: "warning", footnote: "Share of flock harvested" })}
            ${kpiCard({ label: "Average performance index", value: n(summary.performanceIndex.avg, 1), icon: "trending-up", tone: "info", footnote: `EPEF · range ${n(summary.performanceIndex.min, 0)}–${n(summary.performanceIndex.max, 0)}` })}
          </div>
          <div class="pa-grid pa-grid--2 mt-3">
            ${card({
              title: "Performance index by depletion band",
              subtitle: "Average EPEF per band; flock count in brackets",
              icon: "bar-chart",
              body: html`<div data-flock-chart="index"></div>`,
            })}
            ${card({
              title: "Body weight by depletion band",
              subtitle: "Average body weight at harvest per band (kg)",
              icon: "scale",
              body: html`<div data-flock-chart="weight"></div>`,
            })}
          </div>
          <div class="pa-grid pa-grid--main-side mt-3">
            ${card({
              title: "Depletion bands",
              subtitle: "GROUP BY over every flock in Hive",
              icon: "table",
              flush: true,
              body: html`<div class="pa-table-wrap"><table class="pa-table" aria-label="Flock results by depletion band">
                <thead><tr><th scope="col">Depletion band</th><th scope="col" class="text-end">Flocks</th><th scope="col" class="text-end">Avg age (days)</th><th scope="col" class="text-end">Avg body weight (kg)</th><th scope="col" class="text-end">Avg performance index</th></tr></thead>
                <tbody>${bands.map(
                  (b) => html`<tr><th scope="row">${b.band}</th><td class="text-end">${n(b.flocks, 0)}</td><td class="text-end">${n(b.avgAgeDays, 2)}</td><td class="text-end">${n(b.avgBodyWeightKg, 3)}</td><td class="text-end">${n(b.avgPerformanceIndex, 1)}</td></tr>`,
                )}</tbody>
              </table></div>`,
            })}
            ${card({
              title: "Correlation with performance index",
              subtitle: "Pearson r from Hive CORR(); association, not cause",
              icon: "line-chart",
              flush: true,
              body: html`<div class="pa-table-wrap"><table class="pa-table" aria-label="Correlation with performance index">
                <thead><tr><th scope="col">Measure</th><th scope="col" class="text-end">r</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Body weight</th><td class="text-end">${r(summary.correlations.bodyWeightVsIndex)}</td></tr>
                  <tr><th scope="row">Depletion</th><td class="text-end">${r(summary.correlations.depletionVsIndex)}</td></tr>
                  <tr><th scope="row">Harvest age</th><td class="text-end">${r(summary.correlations.ageVsIndex)}</td></tr>
                </tbody>
              </table></div>`,
            })}
          </div>
          ${sourceNote}`,
      );
      const labels = bands.map((b) => `${b.band} (${b.flocks})`);
      setHtml($('[data-flock-chart="index"]', target), chartCanvas("canvas-flock-index", { label: "Average performance index by depletion band" }));
      barChart($("#canvas-flock-index", target), {
        labels,
        datasets: [{ label: "Average performance index", data: bands.map((b) => b.avgPerformanceIndex) }],
        decimals: 1,
        yTitle: "Performance index",
        showLegend: false,
      });
      setHtml($('[data-flock-chart="weight"]', target), chartCanvas("canvas-flock-weight", { label: "Average body weight by depletion band" }));
      barChart($("#canvas-flock-weight", target), {
        labels,
        datasets: [{ label: "Average body weight", data: bands.map((b) => b.avgBodyWeightKg), color: palette[1] }],
        unit: "kg",
        decimals: 3,
        yTitle: "kg",
        showLegend: false,
      });
    }

    async function loadFlock() {
      setHtml($("[data-flock]", root), loadingState("Loading flock benchmarks…", { compact: true }));
      try {
        const summary = await getFlockSummary();
        if (ctx.isCurrent()) renderFlock(summary);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        console.error(error);
        setHtml($("[data-flock]", root), errorState(error, { compact: true }));
      }
    }

    /** Runs a loader and renders its result, or an error state into `selector`. */
    async function section(selector, loader, onData) {
      try {
        const result = await loader();
        if (ctx.isCurrent()) onData(result.data, result.source);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        setHtml($(selector, root), errorState(error, { compact: true }));
      }
    }

    async function load() {
      const params = { farmId: state.farmId, days: state.days };
      $("[data-range-label]", root).textContent = `· last ${state.days} days`;
      setHtml($("[data-kpis]", root), skeletonKpis());
      CHARTS.forEach((c) => setHtml($(`[data-chart="${c.id}"]`, root), loadingState("Loading chart…", { compact: true })));

      await Promise.all([
        section("[data-kpis]", () => getSummary(params), renderKpis),
        getDailyRecords(params)
          .then((r) => ctx.isCurrent() && renderDailyCharts(r.data, r.source))
          .catch((error) => {
            if (!ctx.isCurrent()) return;
            ["temperature", "humidity", "feed", "mortality"].forEach((id) => setHtml($(`[data-chart="${id}"]`, root), errorState(error, { compact: true })));
          }),
        section('[data-chart="growth"]', () => getGrowthCurves({ farmId: state.farmId }), renderGrowth),
        section('[data-chart="comparison"]', () => getFarmComparison({ days: state.days }), (data, source) => {
          state.comparison = { data, source };
          renderComparison();
        }),
        section("[data-alerts]", () => getAlerts({ farmId: state.farmId, limit: 6 }), renderAlerts),
        section("[data-activity]", () => getActivity({ limit: 6 }), renderActivity),
        loadFlock(),
      ]);
    }

    const offs = [
      on(root, "click", "[data-range]", (_e, btn) => {
        state.days = Number(btn.dataset.range);
        root.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        load();
      }),
      on(root, "change", "[data-filter=farm]", (e) => {
        state.farmId = e.target.value;
        load();
      }),
      on(root, "change", "[data-filter=metric]", (e) => {
        state.metric = e.target.value;
        if (state.comparison) renderComparison();
      }),
      on(root, "click", '[data-action="refresh"], [data-action="retry"]', () => load()),
    ];
    ctx.onCleanup(() => offs.forEach((off) => off()));

    loadFarms();
    await load();
  },
};
