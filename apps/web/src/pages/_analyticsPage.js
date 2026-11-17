/**
 * Shared builder for the four analytics pages (environmental, feed, growth,
 * mortality). Each page supplies a config; this module renders the filter bar,
 * summary stats, two chart cards and a sortable daily-records table with CSV
 * export, and handles loading / empty / error states.
 *
 * config: {
 *   title, subtitle,
 *   filters: { batch?: boolean, range?: boolean },        // farm filter is always shown
 *   load(params) → Promise<{ data, source }>,             // params: { farmId, batchId, days }
 *   stats(data) → Array<kpiCard options>,
 *   charts: [{ id, title, subtitle, icon, draw(canvas, data) → void, isEmpty(data) → boolean, emptyMessage, wide? }],
 *   table: { title, rows(data) → object[], columns: dataTable columns, rowKey, csv: { headers: string[], row(r) → any[] }, fileBase },
 * }
 */
import { chartCanvas } from "../charts/index.js";
import { createDataTable } from "../components/dataTable.js";
import { icon } from "../components/icons.js";
import { emptyState, errorState, loadingState, skeletonKpis } from "../components/states.js";
import { toast } from "../components/toast.js";
import { card, kpiCard, pageHeader, selectOptions, sourceBadge } from "../components/ui.js";
import { listBatches } from "../services/batches.js";
import { listFarms } from "../services/farms.js";
import { downloadFile, toCsv } from "../utils/csv.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { toIsoDate } from "../utils/format.js";
import "../styles/pages/analytics.css";

const RANGES = [7, 30, 90];

export function createAnalyticsPage(config) {
  const { filters = {}, charts, table } = config;
  const showRange = filters.range !== false;

  return {
    title: config.title,
    async render(root, ctx) {
      const state = {
        farmId: ctx.query.farm || "",
        batchId: ctx.query.batch || "",
        days: RANGES.includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30,
        result: null,
        table: null,
      };

      setHtml(
        root,
        html`${pageHeader({
            title: config.title,
            subtitle: config.subtitle,
            actions: html`<button type="button" class="btn btn-secondary btn-sm" data-action="export" disabled>
                ${icon("download", { size: 14 })}Export CSV
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="refresh">${icon("refresh", { size: 14 })}Refresh</button>`,
          })}
          <div class="pa-card pa-analytics-filters">
            <div class="pa-toolbar">
              <div class="pa-analytics-filter">
                <label class="form-label" for="af-farm">Farm</label>
                <select class="form-select form-select-sm" id="af-farm" data-filter="farm"><option value="">All farms</option></select>
              </div>
              ${filters.batch
                ? html`<div class="pa-analytics-filter">
                    <label class="form-label" for="af-batch">Batch</label>
                    <select class="form-select form-select-sm" id="af-batch" data-filter="batch"><option value="">All batches</option></select>
                  </div>`
                : ""}
              ${showRange
                ? html`<div class="pa-analytics-filter">
                    <span class="form-label d-block" id="af-range-label">Period</span>
                    <div class="pa-segmented" role="group" aria-labelledby="af-range-label">
                      ${RANGES.map((d) => html`<button type="button" data-range="${d}" aria-pressed="${d === state.days}" title="Last ${d} days">${d}D</button>`)}
                    </div>
                  </div>`
                : ""}
              <div class="pa-toolbar__spacer"></div>
              <span data-source></span>
            </div>
            <div class="pa-analytics-provenance">
              ${icon("database", { size: 13 })}
              <span>In the full system these figures are produced by HiveQL queries executed on Apache Hive over data stored in HDFS.</span>
            </div>
          </div>
          <section class="pa-section" aria-label="Summary">
            <div data-stats>${skeletonKpis(config.statCount || 4)}</div>
          </section>
          <section class="pa-section">
            <div class="pa-grid pa-grid--2">
              ${charts.map((c) =>
                card({
                  className: c.wide ? "pa-span-2" : "",
                  title: c.title,
                  subtitle: c.subtitle,
                  icon: c.icon,
                  actions: html`<span data-chart-badge="${c.id}"></span>`,
                  body: html`<div data-chart="${c.id}">${loadingState("Loading chart…", { compact: true })}</div>`,
                }),
              )}
            </div>
          </section>
          ${card({
            title: table.title,
            icon: "table",
            actions: html`<span data-table-badge></span>`,
            body: html`<div class="pa-toolbar">
                <div class="pa-search-input">
                  ${icon("search", { size: 14 })}
                  <input type="search" class="form-control form-control-sm" placeholder="Search records…" aria-label="Search records" data-table-search />
                </div>
              </div>
              <div data-table>${loadingState("Loading records…", { compact: true })}</div>`,
            flush: true,
          })}`,
      );

      const farmSelect = $("[data-filter=farm]", root);
      const batchSelect = $("[data-filter=batch]", root);
      const exportBtn = $('[data-action="export"]', root);

      async function loadFarmOptions() {
        try {
          const { data } = await listFarms();
          if (!ctx.isCurrent()) return;
          setHtml(farmSelect, html`<option value="">All farms</option>${selectOptions(data.map((f) => ({ value: f.id, label: f.name })), state.farmId)}`);
        } catch {
          /* filter stays at "All farms"; sections show the API error */
        }
      }

      async function loadBatchOptions() {
        if (!batchSelect) return;
        try {
          const { data } = await listBatches({ farmId: state.farmId || undefined });
          if (!ctx.isCurrent()) return;
          const options = data.filter((b) => b.status !== "planned").map((b) => ({ value: b.id, label: `${b.code} · ${b.poultryType}` }));
          if (state.batchId && !options.some((o) => String(o.value) === String(state.batchId))) state.batchId = "";
          setHtml(batchSelect, html`<option value="">All batches</option>${selectOptions(options, state.batchId)}`);
        } catch {
          setHtml(batchSelect, html`<option value="">All batches</option>`);
        }
      }

      function chartHolder(id) {
        return $(`[data-chart="${id}"]`, root);
      }

      function renderAll() {
        const { data, source } = state.result;
        setHtml($("[data-source]", root), sourceBadge(source));
        setHtml($("[data-table-badge]", root), sourceBadge(source));

        const stats = config.stats(data);
        setHtml($("[data-stats]", root), html`<div class="pa-grid ${stats.length === 4 ? "pa-grid--4" : "pa-grid--kpi"} pa-analytics-stats">${stats.map((s) => kpiCard(s))}</div>`);

        for (const c of charts) {
          setHtml($(`[data-chart-badge="${c.id}"]`, root), sourceBadge(source));
          if (c.isEmpty(data)) {
            setHtml(chartHolder(c.id), emptyState({ icon: "line-chart", title: "No data for this selection", message: c.emptyMessage || "Try another farm or a longer period.", compact: true }));
            continue;
          }
          setHtml(chartHolder(c.id), chartCanvas(`canvas-${c.id}`, { size: c.size || "", label: c.title }));
          c.draw($(`#canvas-${c.id}`, root), data);
        }

        const rows = table.rows(data);
        const tableEl = $("[data-table]", root);
        state.table?.destroy();
        state.table = createDataTable(tableEl, {
          columns: table.columns,
          rows,
          rowKey: table.rowKey || "key",
          pageSize: 10,
          sortKey: table.sortKey,
          sortDir: table.sortDir || "desc",
          caption: table.title,
          empty: { icon: "table", title: "No records", message: "No daily records match the selected filters." },
        });
        const search = $("[data-table-search]", root);
        if (search.value) state.table.setSearch(search.value);
        exportBtn.disabled = rows.length === 0;
      }

      function renderError(error) {
        exportBtn.disabled = true;
        setHtml($("[data-source]", root), "");
        setHtml($("[data-stats]", root), html`<div class="pa-card">${errorState(error, { compact: true })}</div>`);
        for (const c of charts) {
          setHtml($(`[data-chart-badge="${c.id}"]`, root), "");
          setHtml(chartHolder(c.id), errorState(error, { compact: true, retry: false }));
        }
        state.table?.destroy();
        state.table = null;
        setHtml($("[data-table]", root), errorState(error, { compact: true, retry: false }));
      }

      async function load() {
        exportBtn.disabled = true;
        setHtml($("[data-stats]", root), skeletonKpis(config.statCount || 4));
        charts.forEach((c) => setHtml(chartHolder(c.id), loadingState("Loading chart…", { compact: true })));
        setHtml($("[data-table]", root), loadingState("Loading records…", { compact: true }));
        try {
          const result = await config.load({ farmId: state.farmId || undefined, batchId: state.batchId || undefined, days: state.days });
          if (!ctx.isCurrent()) return;
          state.result = result;
          renderAll();
        } catch (error) {
          if (!ctx.isCurrent()) return;
          console.error(error);
          renderError(error);
        }
      }

      function exportCsv() {
        if (!state.table || !state.result) return;
        const rows = state.table.getVisibleRows();
        if (!rows.length) return toast.warning("Nothing to export", "No records match the current filters.");
        const csv = toCsv(table.csv.headers, rows.map(table.csv.row));
        const prefix = state.result.source === "sample" ? "sample-" : "";
        downloadFile(csv, `${prefix}${table.fileBase}-${toIsoDate(new Date())}.csv`);
        toast.success("Export ready", `${rows.length} ${rows.length === 1 ? "record" : "records"} exported${state.result.source === "sample" ? " (sample data)" : ""}.`);
      }

      const offs = [
        on(root, "click", "[data-range]", (_e, btn) => {
          state.days = Number(btn.dataset.range);
          root.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
          load();
        }),
        on(root, "change", "[data-filter=farm]", async (e) => {
          state.farmId = e.target.value;
          if (batchSelect) {
            state.batchId = "";
            await loadBatchOptions();
          }
          load();
        }),
        on(root, "change", "[data-filter=batch]", (e) => {
          state.batchId = e.target.value;
          load();
        }),
        on(root, "click", '[data-action="refresh"], [data-action="retry"]', () => load()),
        on(root, "click", '[data-action="export"]', exportCsv),
        on(root, "input", "[data-table-search]", (e) => state.table?.setSearch(e.target.value)),
      ];
      ctx.onCleanup(() => {
        offs.forEach((off) => off());
        state.table?.destroy();
      });

      loadFarmOptions();
      await loadBatchOptions();
      await load();
    },
  };
}

// --- Shared computations ------------------------------------------------------

export const mean = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

export function sortedDates(records) {
  return [...new Set(records.map((r) => r.date))].sort();
}

/** One dataset per farm, aligned to the sorted date labels. */
export function seriesByFarm(records, valueOf, palette) {
  const labels = sortedDates(records);
  const farms = [...new Map(records.map((r) => [r.farmId, r.farmName])).entries()];
  const datasets = farms.map(([farmId, farmName], i) => {
    const byDate = new Map(records.filter((r) => r.farmId === farmId).map((r) => [r.date, valueOf(r)]));
    return { label: farmName, data: labels.map((d) => byDate.get(d) ?? null), color: palette[i % palette.length] };
  });
  return { labels, datasets };
}

export function totalsByDate(records, key) {
  const totals = new Map();
  for (const r of records) totals.set(r.date, (totals.get(r.date) || 0) + (r[key] || 0));
  const labels = [...totals.keys()].sort();
  return { labels, values: labels.map((d) => totals.get(d)) };
}

export function movingAverage(values, window = 7) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v) => v !== null && Number.isFinite(v));
    return slice.length < Math.min(window, 3) ? null : slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

export const rowKey = (r) => `${r.farmId}-${r.date}`;
