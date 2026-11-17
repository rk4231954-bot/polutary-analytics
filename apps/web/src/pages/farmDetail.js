/** Farm detail — overview, recent environment/feed trend, details and batches for one farm. */
import { barChart, chartCanvas, colors, hasData, lineChart } from "../charts/index.js";
import { createDataTable } from "../components/dataTable.js";
import { confirmDeleteFarm, openBatchModal, openFarmModal } from "../components/farmForms.js";
import { can } from "../services/session.js";
import { icon } from "../components/icons.js";
import { emptyState, errorState, loadingState } from "../components/states.js";
import { card, kpiCard, sourceBadge, statusBadge } from "../components/ui.js";
import { getDailyRecords } from "../services/analytics.js";
import { listBatches } from "../services/batches.js";
import { getFarm, listFarms } from "../services/farms.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatDate, formatNumber, formatPercent, formatWeightKg } from "../utils/format.js";
import "../styles/pages/farms.css";

const TREND_METRICS = {
  temperature: { label: "Temperature", key: "temperatureC", unit: "°C", decimals: 1, color: colors.danger },
  humidity: { label: "Humidity", key: "humidityPct", unit: "%", decimals: 1, color: colors.info },
  feed: { label: "Feed", key: "feedKg", unit: "kg", decimals: 0, color: colors.warning },
};

export default {
  title: "Farm",
  async render(root, ctx) {
    const id = ctx.params.id;
    const state = { farm: null, source: null, records: null, recordsSource: null, metric: "temperature" };
    let batchTable = null;

    const crumbs = (name) => [{ label: "Farm management" }, { label: "Farms", path: "/farms" }, { label: name }];

    function renderShell(farm, source) {
      const util = farm.capacity ? (farm.birdCount / farm.capacity) * 100 : null;
      setHtml(
        root,
        html`<a class="pa-back-link" href="#/farms">${icon("arrow-left", { size: 14 })}All farms</a>
          <header class="pa-page-header">
            <div class="pa-page-header__text">
              <div class="pa-detail-title">
                <h1 class="pa-page-header__title">${farm.name}</h1>
                ${statusBadge(farm.status)} ${sourceBadge(source)}
              </div>
              <div class="pa-meta-row pa-detail-meta">
                <span>${icon("key", { size: 13 })}${farm.code}</span>
                <span>${icon("map-pin", { size: 13 })}${farm.location}</span>
                ${farm.housingType ? html`<span>${icon("warehouse", { size: 13 })}${farm.housingType}</span>` : ""}
              </div>
            </div>
            <div class="pa-page-header__actions">
              ${can("batches.manage") ? html`<button type="button" class="btn btn-secondary" data-action="add-batch">${icon("plus", { size: 16 })}Add batch</button>` : ""}
              ${can("farms.update") ? html`<button type="button" class="btn btn-secondary" data-action="edit">${icon("pencil", { size: 16 })}Edit</button>` : ""}
              ${can("farms.delete") ? html`<button type="button" class="btn btn-outline-danger" data-action="delete">${icon("trash", { size: 16 })}Delete</button>` : ""}
            </div>
          </header>
          <section class="pa-section pa-grid pa-grid--4 pa-fm-kpis" aria-label="Farm overview">
            ${kpiCard({ label: "Bird capacity", value: formatNumber(farm.capacity), unit: "birds", icon: "building", tone: "info", footnote: farm.housingType || "Housing capacity" })}
            ${kpiCard({ label: "Birds housed", value: formatNumber(farm.birdCount), icon: "bird", footnote: "Live birds in active batches" })}
            ${kpiCard({
              label: "Utilisation",
              value: formatPercent(util),
              icon: "gauge",
              tone: util > 95 ? "danger" : util > 85 ? "warning" : "brand",
              footnote: html`<span class="pa-progress pa-capacity-meter" aria-hidden="true"><span class="pa-progress__bar ${util > 95 ? "pa-progress__bar--danger" : util > 85 ? "pa-progress__bar--warning" : ""}" style="width:${Math.min(100, util ?? 0)}%"></span></span>`,
            })}
            ${kpiCard({ label: "Active batches", value: formatNumber(farm.activeBatches), icon: "layers", tone: "warning", footnote: `${formatNumber(farm.totalBatches ?? farm.activeBatches)} batches in total` })}
          </section>
          <section class="pa-section pa-grid pa-grid--main-side">
            ${card({
              title: "Recent conditions",
              subtitle: "Daily averages over the last 30 days",
              icon: "line-chart",
              actions: html`<div class="pa-segmented" role="group" aria-label="Trend metric">
                ${Object.entries(TREND_METRICS).map(([k, m]) => html`<button type="button" data-metric="${k}" aria-pressed="${k === state.metric}">${m.label}</button>`)}
              </div>`,
              body: html`<div data-trend>${loadingState("Loading trend…", { compact: true })}</div>`,
            })}
            ${card({
              title: "Farm details",
              icon: "info",
              body: html`<dl class="pa-dl">
                <dt>Farm code</dt><dd>${farm.code}</dd>
                <dt>Location</dt><dd>${farm.location}</dd>
                <dt>Housing</dt><dd>${farm.housingType || "—"}</dd>
                <dt>Manager</dt><dd>${farm.manager || "—"}</dd>
                <dt>Status</dt><dd>${statusBadge(farm.status)}</dd>
                <dt>Registered</dt><dd>${formatDate(farm.createdAt)}</dd>
              </dl>`,
            })}
          </section>
          ${card({
            title: "Poultry batches",
            subtitle: "All batches placed at this farm",
            icon: "bird",
            actions: html`<span data-batch-source></span><a class="btn btn-secondary btn-sm" href="#/batches">View all batches</a>`,
            body: html`<div class="pa-fm-table" data-batches>${loadingState("Loading batches…", { compact: true })}</div>`,
            flush: true,
          })}`,
      );
    }

    function renderTrend() {
      const holder = $("[data-trend]", root);
      if (!holder || !state.records) return;
      const m = TREND_METRICS[state.metric];
      const rows = [...state.records].sort((a, b) => (a.date < b.date ? -1 : 1));
      const datasets = [{ label: m.label, data: rows.map((r) => r[m.key] ?? null), color: m.color, fill: state.metric !== "feed" }];
      if (!hasData(datasets)) {
        setHtml(holder, emptyState({ icon: "line-chart", title: "No readings in the last 30 days", message: "Record daily readings or upload a dataset for this farm.", compact: true }));
        return;
      }
      setHtml(holder, html`<div class="mb-2">${sourceBadge(state.recordsSource)}</div>${chartCanvas("farm-trend", { label: `${m.label} trend for this farm` })}`);
      const spec = { labels: rows.map((r) => r.date), datasets, unit: m.unit, decimals: m.decimals, yTitle: m.unit, showLegend: false };
      if (state.metric === "feed") barChart($("#farm-trend", root), spec);
      else lineChart($("#farm-trend", root), spec);
    }

    async function loadTrend() {
      try {
        const { data, source } = await getDailyRecords({ farmId: id, days: 30 });
        if (!ctx.isCurrent()) return;
        state.records = data;
        state.recordsSource = source;
        renderTrend();
      } catch (error) {
        if (ctx.isCurrent()) setHtml($("[data-trend]", root), errorState(error, { compact: true }));
      }
    }

    async function loadBatches() {
      const holder = $("[data-batches]", root);
      setHtml(holder, loadingState("Loading batches…", { compact: true }));
      try {
        const { data, source } = await listBatches({ farmId: id });
        if (!ctx.isCurrent()) return;
        setHtml($("[data-batch-source]", root), sourceBadge(source));
        batchTable?.destroy();
        batchTable = createDataTable(holder, {
          caption: "Batches at this farm",
          rows: data,
          pageSize: 8,
          sortKey: "startDate",
          sortDir: "desc",
          onRowClick: (b) => ctx.navigate(`/batches/${b.id}`),
          empty: { icon: "bird", title: "No batches at this farm", message: "Add a batch to start tracking a flock here." },
          columns: [
            { key: "code", label: "Batch ID", sortable: true, render: (b) => html`<a class="pa-cell-primary pa-farm-link" href="#/batches/${b.id}">${b.code}</a><span class="pa-cell-secondary">${b.poultryType}</span>` },
            { key: "birdCount", label: "Birds", sortable: true, align: "num", render: (b) => formatNumber(b.birdCount) },
            { key: "ageDays", label: "Age", sortable: true, align: "num", render: (b) => (b.status === "planned" ? "—" : `${formatNumber(b.ageDays)} d`) },
            { key: "avgWeightG", label: "Avg weight", sortable: true, align: "num", render: (b) => (b.avgWeightG ? `${formatWeightKg(b.avgWeightG)} kg` : "—") },
            { key: "startDate", label: "Start date", sortable: true, render: (b) => formatDate(b.startDate) },
            { key: "status", label: "Status", sortable: true, render: (b) => statusBadge(b.status) },
          ],
        });
      } catch (error) {
        if (ctx.isCurrent()) setHtml(holder, errorState(error, { compact: true }));
      }
    }

    async function load() {
      setHtml(root, loadingState("Loading farm…"));
      try {
        const { data: farm, source } = await getFarm(id);
        if (!ctx.isCurrent()) return;
        state.farm = farm;
        state.source = source;
        ctx.setTitle(farm.name, crumbs(farm.name));
        renderShell(farm, source);
        await Promise.all([loadTrend(), loadBatches()]);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        ctx.setTitle("Farm", crumbs("Farm"));
        if (error.isNotFound) {
          setHtml(
            root,
            html`<div class="pa-card">${emptyState({
              icon: "warehouse",
              title: "Farm not found",
              message: "This farm does not exist or you do not have access to it.",
              action: html`<a class="btn btn-primary btn-sm" href="#/farms">${icon("arrow-left", { size: 14 })}Back to farms</a>`,
            })}</div>`,
          );
        } else setHtml(root, html`<div class="pa-card">${errorState(error)}</div>`);
      }
    }

    const offs = [
      on(root, "click", "[data-metric]", (_e, btn) => {
        state.metric = btn.dataset.metric;
        root.querySelectorAll("[data-metric]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        renderTrend();
      }),
      on(root, "click", '[data-action="edit"]', () => state.farm && openFarmModal({ farm: state.farm, onSaved: load })),
      on(root, "click", '[data-action="delete"]', async () => {
        if (state.farm && (await confirmDeleteFarm(state.farm)) && ctx.isCurrent()) ctx.navigate("/farms");
      }),
      on(root, "click", '[data-action="add-batch"]', async (_e, btn) => {
        btn.disabled = true;
        try {
          const { data: farms } = await listFarms().catch(() => ({ data: state.farm ? [state.farm] : [] }));
          openBatchModal({ farms, farmId: id, onSaved: () => ctx.isCurrent() && loadBatches() });
        } finally {
          btn.disabled = false;
        }
      }),
      on(root, "click", '[data-action="retry"]', (_e, btn) => {
        if (btn.closest("[data-trend]")) loadTrend();
        else if (btn.closest("[data-batches]")) loadBatches();
        else load();
      }),
    ];
    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      batchTable?.destroy();
    });

    await load();
  },
};
