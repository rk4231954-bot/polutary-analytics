/** Poultry batches — list, search, filter, create, edit and delete flocks. */
import { createDataTable } from "../components/dataTable.js";
import { BATCH_STATUSES, confirmDeleteBatch, openBatchModal, POULTRY_TYPES } from "../components/farmForms.js";
import { can } from "../services/session.js";
import { icon } from "../components/icons.js";
import { errorState, loadingState, skeletonKpis } from "../components/states.js";
import { kpiCard, pageHeader, selectOptions, sourceBadge, statusBadge } from "../components/ui.js";
import { listBatches } from "../services/batches.js";
import { listFarms } from "../services/farms.js";
import { $, debounce, html, on, setHtml } from "../utils/dom.js";
import { formatDate, formatNumber, formatWeightKg } from "../utils/format.js";
import "../styles/pages/farms.css";
import "../styles/pages/batches.css";

const TYPE_ICON = { Broiler: "bird", Layer: "egg", Breeder: "sprout" };

export default {
  title: "Poultry Batches",
  async render(root, ctx) {
    const state = { batches: [], farms: [], source: null, search: "", farmId: ctx.query.farm || "", status: "", type: "" };
    let table = null;

    setHtml(
      root,
      html`${pageHeader({
          title: "Poultry Batches",
          subtitle: "Track every flock from placement to completion.",
          actions: can("batches.manage")
            ? html`<button type="button" class="btn btn-primary" data-action="add">${icon("plus", { size: 16 })}Add batch</button>`
            : "",
        })}
        <section class="pa-section" aria-label="Batch overview">
          <div class="pa-section-head">
            <h2 class="pa-section-title">Overview</h2>
            <span data-source></span>
          </div>
          <div data-kpis>${skeletonKpis(4)}</div>
        </section>
        <section class="pa-card">
          <div class="pa-toolbar">
            <div class="pa-search-input">
              ${icon("search", { size: 16 })}
              <label class="visually-hidden" for="batch-search">Search batches</label>
              <input type="search" class="form-control form-control-sm" id="batch-search" placeholder="Search batches" data-filter="search" />
            </div>
            <label class="visually-hidden" for="batch-farm">Farm</label>
            <select class="form-select form-select-sm" id="batch-farm" data-filter="farm"><option value="">All farms</option></select>
            <label class="visually-hidden" for="batch-status">Status</label>
            <select class="form-select form-select-sm" id="batch-status" data-filter="status">
              <option value="">All statuses</option>${selectOptions(BATCH_STATUSES, "")}
            </select>
            <label class="visually-hidden" for="batch-type">Poultry type</label>
            <select class="form-select form-select-sm" id="batch-type" data-filter="type">
              <option value="">All types</option>${selectOptions(POULTRY_TYPES, "")}
            </select>
            <span class="pa-toolbar__spacer"></span>
            <span class="pa-text-sm pa-text-2" data-count></span>
          </div>
          <div class="pa-fm-table" data-table>${loadingState("Loading batches…", { compact: true })}</div>
        </section>`,
    );

    function renderKpis() {
      const active = state.batches.filter((b) => b.status === "active");
      const birds = active.reduce((s, b) => s + (b.birdCount || 0), 0);
      const avgAge = active.length ? active.reduce((s, b) => s + (b.ageDays || 0), 0) / active.length : null;
      const planned = state.batches.filter((b) => b.status === "planned").length;
      setHtml($("[data-source]", root), sourceBadge(state.source));
      setHtml(
        $("[data-kpis]", root),
        html`<div class="pa-grid pa-grid--4 pa-fm-kpis">
          ${kpiCard({ label: "Active batches", value: formatNumber(active.length), icon: "layers", footnote: `${formatNumber(state.batches.length)} batches in total` })}
          ${kpiCard({ label: "Birds in active batches", value: formatNumber(birds), icon: "bird", tone: "info", footnote: "Current live count" })}
          ${kpiCard({ label: "Average flock age", value: avgAge === null ? "—" : formatNumber(avgAge), unit: avgAge === null ? "" : "days", icon: "calendar", tone: "warning", footnote: "Across active batches" })}
          ${kpiCard({ label: "Planned placements", value: formatNumber(planned), icon: "clock", footnote: "Batches not yet started" })}
        </div>`,
      );
    }

    function applyFilters() {
      if (!table) return;
      table.setFilter((b) =>
        (!state.farmId || String(b.farmId) === String(state.farmId)) &&
        (!state.status || b.status === state.status) &&
        (!state.type || b.poultryType === state.type),
      );
      table.setSearch(state.search);
      $("[data-count]", root).textContent = state.batches.length
        ? `${formatNumber(table.getVisibleRows().length)} of ${formatNumber(state.batches.length)} batches`
        : "";
    }

    function renderTable() {
      table?.destroy();
      table = createDataTable($("[data-table]", root), {
        caption: "Poultry batches",
        rows: state.batches,
        pageSize: 10,
        sortKey: "startDate",
        sortDir: "desc",
        onRowClick: (b) => ctx.navigate(`/batches/${b.id}`),
        empty: { icon: "bird", title: "No batches yet", message: "Add a batch to start tracking a flock's growth, feed and mortality." },
        columns: [
          {
            key: "code",
            label: "Batch ID",
            sortable: true,
            searchValue: (b) => `${b.code} ${b.breed ?? ""}`,
            render: (b) => html`<a class="pa-cell-primary pa-farm-link" href="#/batches/${b.id}">${b.code}</a>${b.breed ? html`<span class="pa-cell-secondary">${b.breed}</span>` : ""}`,
          },
          { key: "farmName", label: "Farm", sortable: true, render: (b) => html`<a class="pa-farm-link" href="#/farms/${b.farmId}">${b.farmName}</a>` },
          { key: "poultryType", label: "Type", sortable: true, render: (b) => html`<span class="pa-inline-icon">${icon(TYPE_ICON[b.poultryType] || "bird", { size: 14 })}${b.poultryType}</span>` },
          { key: "birdCount", label: "Birds", sortable: true, align: "num", render: (b) => formatNumber(b.birdCount) },
          { key: "ageDays", label: "Age", sortable: true, align: "num", render: (b) => (b.status === "planned" ? "—" : `${formatNumber(b.ageDays)} d`) },
          { key: "startDate", label: "Start date", sortable: true, render: (b) => formatDate(b.startDate) },
          { key: "avgWeightG", label: "Avg weight", sortable: true, align: "num", render: (b) => (b.avgWeightG ? `${formatWeightKg(b.avgWeightG)} kg` : "—") },
          { key: "status", label: "Status", sortable: true, render: (b) => statusBadge(b.status) },
          {
            key: "actions",
            label: html`<span class="visually-hidden">Actions</span>`,
            align: "actions",
            render: (b) => html`<div class="pa-row-actions">
              ${can("batches.manage")
                ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="edit" data-id="${b.id}" title="Edit batch" aria-label="Edit ${b.code}">${icon("pencil", { size: 15 })}</button>
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="delete" data-id="${b.id}" title="Delete batch" aria-label="Delete ${b.code}">${icon("trash", { size: 15 })}</button>`
                : ""}
            </div>`,
          },
        ],
      });
      applyFilters();
    }

    async function loadFarms() {
      try {
        const { data } = await listFarms();
        if (!ctx.isCurrent()) return;
        state.farms = data;
        setHtml($("[data-filter=farm]", root), html`<option value="">All farms</option>${selectOptions(data.map((f) => ({ value: f.id, label: f.name })), state.farmId)}`);
      } catch {
        // Farm filter stays at "All farms"; the table shows any API error.
      }
    }

    async function load() {
      setHtml($("[data-table]", root), loadingState("Loading batches…", { compact: true }));
      setHtml($("[data-kpis]", root), skeletonKpis(4));
      try {
        const { data, source } = await listBatches();
        if (!ctx.isCurrent()) return;
        state.batches = data;
        state.source = source;
        renderKpis();
        renderTable();
      } catch (error) {
        if (!ctx.isCurrent()) return;
        table?.destroy();
        table = null;
        setHtml($("[data-kpis]", root), "");
        setHtml($("[data-table]", root), errorState(error));
        $("[data-count]", root).textContent = "";
      }
    }

    const openAdd = () => openBatchModal({ farms: state.farms, farmId: state.farmId, onSaved: () => ctx.isCurrent() && load() });
    const findBatch = (id) => state.batches.find((b) => String(b.id) === String(id));
    const offs = [
      on(root, "click", '[data-action="add"]', openAdd),
      on(root, "click", '[data-action="edit"]', (_e, btn) => {
        const batch = findBatch(btn.dataset.id);
        if (batch) openBatchModal({ batch, farms: state.farms, onSaved: () => ctx.isCurrent() && load() });
      }),
      on(root, "click", '[data-action="delete"]', async (_e, btn) => {
        const batch = findBatch(btn.dataset.id);
        if (batch && (await confirmDeleteBatch(batch)) && ctx.isCurrent()) load();
      }),
      on(root, "click", '[data-action="retry"]', () => load()),
      on(root, "input", "[data-filter=search]", debounce((e) => {
        state.search = e.target.value;
        applyFilters();
      }, 150)),
      on(root, "change", "[data-filter=farm], [data-filter=status], [data-filter=type]", (e) => {
        const key = { farm: "farmId", status: "status", type: "type" }[e.target.dataset.filter];
        state[key] = e.target.value;
        applyFilters();
      }),
    ];
    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      table?.destroy();
    });

    const wantsNew = ctx.query.action === "new";
    if (wantsNew) window.history.replaceState(null, "", "#/batches");
    await Promise.all([loadFarms(), load()]);
    if (wantsNew && ctx.isCurrent() && can("batches.manage")) openAdd();
  },
};
