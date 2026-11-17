/** Farms — list, search, filter, create, edit and delete farms. */
import { confirmDeleteFarm, FARM_STATUSES, openFarmModal } from "../components/farmForms.js";
import { can } from "../services/session.js";
import { createDataTable } from "../components/dataTable.js";
import { icon } from "../components/icons.js";
import { errorState, loadingState, skeletonKpis } from "../components/states.js";
import { kpiCard, pageHeader, selectOptions, sourceBadge, statusBadge } from "../components/ui.js";
import { listFarms } from "../services/farms.js";
import { $, debounce, html, on, setHtml } from "../utils/dom.js";
import { formatNumber, formatPercent } from "../utils/format.js";
import "../styles/pages/farms.css";

function utilisation(farm) {
  return farm.capacity ? (farm.birdCount / farm.capacity) * 100 : null;
}

export default {
  title: "Farms",
  async render(root, ctx) {
    const state = { farms: [], source: null, search: "", status: "" };
    let table = null;

    setHtml(
      root,
      html`${pageHeader({
          title: "Farms",
          subtitle: "Register farms, track capacity and monitor bird population across sites.",
          actions: can("farms.create")
            ? html`<button type="button" class="btn btn-primary" data-action="add">${icon("plus", { size: 16 })}Add farm</button>`
            : "",
        })}
        <section class="pa-section" aria-label="Farm overview">
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
              <label class="visually-hidden" for="farm-search">Search farms</label>
              <input type="search" class="form-control form-control-sm" id="farm-search" placeholder="Search farms" data-filter="search" />
            </div>
            <label class="visually-hidden" for="farm-status">Status</label>
            <select class="form-select form-select-sm" id="farm-status" data-filter="status">
              <option value="">All statuses</option>
              ${selectOptions(FARM_STATUSES, "")}
            </select>
            <span class="pa-toolbar__spacer"></span>
            <span class="pa-text-sm pa-text-2" data-count></span>
          </div>
          <div class="pa-fm-table" data-table>${loadingState("Loading farms…", { compact: true })}</div>
        </section>`,
    );

    function renderKpis() {
      const farms = state.farms;
      const capacity = farms.reduce((s, f) => s + (f.capacity || 0), 0);
      const birds = farms.reduce((s, f) => s + (f.birdCount || 0), 0);
      const activeBatches = farms.reduce((s, f) => s + (f.activeBatches || 0), 0);
      const activeFarms = farms.filter((f) => f.status === "active").length;
      setHtml($("[data-source]", root), sourceBadge(state.source));
      setHtml(
        $("[data-kpis]", root),
        html`<div class="pa-grid pa-grid--4 pa-fm-kpis">
          ${kpiCard({ label: "Registered farms", value: formatNumber(farms.length), icon: "warehouse", footnote: `${formatNumber(activeFarms)} active` })}
          ${kpiCard({ label: "Total capacity", value: formatNumber(capacity), unit: "birds", icon: "building", tone: "info", footnote: "Combined housing capacity" })}
          ${kpiCard({ label: "Birds housed", value: formatNumber(birds), icon: "bird", footnote: capacity ? `${formatPercent((birds / capacity) * 100)} of capacity` : "No capacity registered" })}
          ${kpiCard({ label: "Active batches", value: formatNumber(activeBatches), icon: "layers", tone: "warning", footnote: "Across all farms" })}
        </div>`,
      );
    }

    function applyFilters() {
      table?.setFilter(state.status ? (f) => f.status === state.status : null);
      table?.setSearch(state.search);
      const visible = table ? table.getVisibleRows().length : 0;
      $("[data-count]", root).textContent = state.farms.length ? `${formatNumber(visible)} of ${formatNumber(state.farms.length)} farms` : "";
    }

    function renderTable() {
      table?.destroy();
      table = createDataTable($("[data-table]", root), {
        caption: "Registered farms",
        rows: state.farms,
        pageSize: 10,
        sortKey: "name",
        onRowClick: (farm) => ctx.navigate(`/farms/${farm.id}`),
        empty: {
          icon: "warehouse",
          title: "No farms yet",
          message: "Add your first farm to start tracking batches, readings and analytics.",
        },
        columns: [
          {
            key: "name",
            label: "Farm",
            sortable: true,
            searchValue: (f) => `${f.name} ${f.code} ${f.manager ?? ""}`,
            render: (f) => html`<a class="pa-cell-primary pa-farm-link" href="#/farms/${f.id}">${f.name}</a><span class="pa-cell-secondary">${f.code}${f.manager ? ` · ${f.manager}` : ""}</span>`,
          },
          { key: "location", label: "Location", sortable: true, render: (f) => html`<span class="pa-inline-icon pa-text-2">${icon("map-pin", { size: 13 })}${f.location}</span>` },
          { key: "capacity", label: "Capacity", sortable: true, align: "num", render: (f) => formatNumber(f.capacity) },
          {
            key: "birdCount",
            label: "Birds",
            sortable: true,
            align: "num",
            render: (f) => {
              const u = utilisation(f);
              return html`<div class="pa-util">
                <span>${formatNumber(f.birdCount)}</span>
                <div class="pa-progress" title="${formatPercent(u)} of capacity" aria-hidden="true">
                  <div class="pa-progress__bar ${u > 95 ? "pa-progress__bar--danger" : u > 85 ? "pa-progress__bar--warning" : ""}" style="width:${Math.min(100, u ?? 0)}%"></div>
                </div>
              </div>`;
            },
          },
          { key: "activeBatches", label: "Active batches", sortable: true, align: "num", render: (f) => formatNumber(f.activeBatches) },
          { key: "status", label: "Status", sortable: true, render: (f) => statusBadge(f.status) },
          {
            key: "actions",
            label: html`<span class="visually-hidden">Actions</span>`,
            align: "actions",
            render: (f) => html`<div class="pa-row-actions">
              <a class="btn btn-ghost btn-icon btn-sm" href="#/farms/${f.id}" title="View farm" aria-label="View ${f.name}">${icon("eye", { size: 15 })}</a>
              ${can("farms.update") ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="edit" data-id="${f.id}" title="Edit farm" aria-label="Edit ${f.name}">${icon("pencil", { size: 15 })}</button>` : ""}
              ${can("farms.delete") ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="delete" data-id="${f.id}" title="Delete farm" aria-label="Delete ${f.name}">${icon("trash", { size: 15 })}</button>` : ""}
            </div>`,
          },
        ],
      });
      applyFilters();
    }

    async function load() {
      setHtml($("[data-table]", root), loadingState("Loading farms…", { compact: true }));
      setHtml($("[data-kpis]", root), skeletonKpis(4));
      try {
        const { data, source } = await listFarms();
        if (!ctx.isCurrent()) return;
        state.farms = data;
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

    const findFarm = (id) => state.farms.find((f) => String(f.id) === String(id));
    const offs = [
      on(root, "click", '[data-action="add"]', () => openFarmModal({ onSaved: load })),
      on(root, "click", '[data-action="edit"]', (_e, btn) => {
        const farm = findFarm(btn.dataset.id);
        if (farm) openFarmModal({ farm, onSaved: load });
      }),
      on(root, "click", '[data-action="delete"]', async (_e, btn) => {
        const farm = findFarm(btn.dataset.id);
        if (farm && (await confirmDeleteFarm(farm)) && ctx.isCurrent()) load();
      }),
      on(root, "click", '[data-action="retry"]', () => load()),
      on(root, "input", "[data-filter=search]", debounce((e) => {
        state.search = e.target.value;
        applyFilters();
      }, 150)),
      on(root, "change", "[data-filter=status]", (e) => {
        state.status = e.target.value;
        applyFilters();
      }),
    ];
    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      table?.destroy();
    });

    if (ctx.query.action === "new") {
      window.history.replaceState(null, "", "#/farms");
      if (can("farms.create")) openFarmModal({ onSaved: load });
    }
    await load();
  },
};
