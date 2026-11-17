/**
 * Audit logs — immutable trail of security-relevant and data-changing actions,
 * plus a security events view (failed sign-ins, lockouts, role changes,
 * permission denials). Filters, pagination and CSV export of displayed rows.
 */
import { createDataTable } from "../components/dataTable.js";
import { icon } from "../components/icons.js";
import { errorState, loadingState } from "../components/states.js";
import { toast } from "../components/toast.js";
import { pageHeader, selectOptions, sourceBadge, statusBadge } from "../components/ui.js";
import { listAuditEntries, listSecurityEvents } from "../services/audit.js";
import { $, $$, debounce, html, on, setHtml } from "../utils/dom.js";
import { downloadFile, toCsv } from "../utils/csv.js";
import { formatDateTime, formatNumber, formatRelative, titleCase, toDate, toIsoDate } from "../utils/format.js";
import "../styles/pages/audit.css";

const ACTION_CATEGORIES = [
  { value: "auth", label: "Authentication" },
  { value: "user", label: "Users & roles" },
  { value: "farm", label: "Farms" },
  { value: "batch", label: "Batches" },
  { value: "reading", label: "Data collection" },
  { value: "dataset", label: "Datasets" },
  { value: "prediction", label: "Predictions" },
  { value: "report", label: "Reports" },
];
const OUTCOMES = [
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
  { value: "denied", label: "Denied" },
];
const OUTCOME_TONE = { success: "success", failure: "danger", denied: "warning" };
const SEVERITY_LABEL = { danger: "High", warning: "Medium", info: "Info" };
const SEVERITY_ICON = { danger: "shield-alert", warning: "alert-triangle", info: "info" };

function outcomeBadge(outcome) {
  return statusBadge(outcome, { tone: OUTCOME_TONE[outcome] || "neutral", label: titleCase(outcome) });
}

function actionLabel(action) {
  const [category, verb = ""] = String(action).split(".");
  const cat = ACTION_CATEGORIES.find((c) => c.value === category)?.label || titleCase(category);
  return `${cat} · ${titleCase(verb)}`;
}

export default {
  title: "Audit Logs",
  async render(root, ctx) {
    const state = { tab: "trail", entries: [], source: null, search: "", category: "", outcome: "", from: "", to: "" };

    setHtml(
      root,
      html`${pageHeader({
          title: "Audit Logs",
          subtitle: "Who did what, when and from where. Entries are recorded by the server and cannot be edited.",
          actions: html`<button type="button" class="btn btn-secondary" data-action="export" disabled>${icon("download", { size: 16 })}Export CSV</button>
            <button type="button" class="btn btn-secondary" data-action="refresh">${icon("refresh", { size: 16 })}Refresh</button>`,
        })}
        <section class="pa-card">
          <div class="pa-audit-tabs">
            <div class="pa-tabs" role="tablist" aria-label="Audit views">
              <button type="button" class="pa-tab" role="tab" id="tab-trail" aria-controls="audit-panel" aria-selected="true" data-tab="trail">${icon("scroll", { size: 14 })} Audit trail</button>
              <button type="button" class="pa-tab" role="tab" id="tab-security" aria-controls="audit-panel" aria-selected="false" data-tab="security">${icon("shield-alert", { size: 14 })} Security events</button>
            </div>
            <span data-source></span>
          </div>
          <div id="audit-panel" role="tabpanel" aria-labelledby="tab-trail" data-panel></div>
        </section>`,
    );

    const panel = $("[data-panel]", root);
    const exportBtn = $('[data-action="export"]', root);
    let table = null;
    const destroyTable = () => {
      table?.destroy();
      table = null;
    };
    ctx.onCleanup(destroyTable);

    function rowFilter(row) {
      if (state.category && !String(row.action).startsWith(`${state.category}.`)) return false;
      if (state.outcome && row.outcome !== state.outcome) return false;
      const date = toIsoDate(row.timestamp);
      if (state.from && date < state.from) return false;
      if (state.to && date > state.to) return false;
      return true;
    }

    function updateClear() {
      const btn = $('[data-action="clear"]', panel);
      if (btn) btn.hidden = !(state.category || state.outcome || state.from || state.to || state.search);
    }

    function updateExport() {
      updateClear();
      const count = table ? table.getVisibleRows().length : 0;
      exportBtn.disabled = state.tab !== "trail" || count === 0;
      exportBtn.title = exportBtn.disabled ? "No entries to export" : `Export ${count} displayed entries`;
    }

    function renderTrail() {
      setHtml(
        panel,
        html`<div class="pa-toolbar">
            <div class="pa-search-input">
              ${icon("search", { size: 16 })}
              <label class="visually-hidden" for="audit-search">Search audit log</label>
              <input class="form-control form-control-sm" id="audit-search" type="search" placeholder="Search actor, resource, IP…" value="${state.search}" data-search />
            </div>
            <label class="visually-hidden" for="audit-action">Action</label>
            <select class="form-select form-select-sm" id="audit-action" data-filter="category">
              <option value="">All actions</option>${selectOptions(ACTION_CATEGORIES, state.category)}
            </select>
            <label class="visually-hidden" for="audit-outcome">Outcome</label>
            <select class="form-select form-select-sm" id="audit-outcome" data-filter="outcome">
              <option value="">All outcomes</option>${selectOptions(OUTCOMES, state.outcome)}
            </select>
            <div class="pa-audit-dates">
              <label class="pa-text-xs pa-text-2" for="audit-from">From</label>
              <input class="form-control form-control-sm" type="date" id="audit-from" data-filter="from" value="${state.from}" max="${state.to || toIsoDate(new Date())}" />
              <label class="pa-text-xs pa-text-2" for="audit-to">To</label>
              <input class="form-control form-control-sm" type="date" id="audit-to" data-filter="to" value="${state.to}" min="${state.from}" max="${toIsoDate(new Date())}" />
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-action="clear" hidden>${icon("x", { size: 14 })}Clear filters</button>
          </div>
          <div data-table></div>`,
      );
      table = createDataTable($("[data-table]", panel), {
        caption: "Audit trail",
        rows: state.entries,
        pageSize: 12,
        sortKey: "timestamp",
        sortDir: "desc",
        empty: { icon: "scroll", title: "No audit entries", message: "Actions such as sign-ins, uploads and record changes will be recorded here." },
        columns: [
          {
            key: "timestamp",
            label: "Time",
            sortable: true,
            sortValue: (r) => toDate(r.timestamp)?.getTime() ?? 0,
            render: (r) => html`<span class="pa-tabular pa-nowrap" title="${formatRelative(r.timestamp)}">${formatDateTime(r.timestamp)}</span>`,
          },
          { key: "actor", label: "Actor", sortable: true, render: (r) => html`<span class="pa-cell-primary pa-nowrap">${r.actor}</span>` },
          {
            key: "action",
            label: "Action",
            sortable: true,
            searchValue: (r) => `${r.action} ${actionLabel(r.action)}`,
            render: (r) => html`<span class="pa-cell-primary pa-text-sm">${actionLabel(r.action)}</span><span class="pa-cell-secondary pa-mono">${r.action}</span>`,
          },
          { key: "resource", label: "Resource" },
          { key: "ip", label: "IP address", render: (r) => html`<span class="pa-mono">${r.ip}</span>` },
          { key: "outcome", label: "Outcome", sortable: true, render: (r) => outcomeBadge(r.outcome) },
        ],
      });
      table.setFilter(rowFilter);
      if (state.search) table.setSearch(state.search);
      updateExport();
    }

    async function loadTrail() {
      setHtml(panel, loadingState("Loading audit log…"));
      updateExport();
      try {
        const { data, source } = await listAuditEntries({ from: state.from, to: state.to, outcome: state.outcome });
        if (!ctx.isCurrent() || state.tab !== "trail") return;
        state.entries = data;
        state.source = source;
        setHtml($("[data-source]", root), sourceBadge(source));
        renderTrail();
      } catch (error) {
        if (!ctx.isCurrent() || state.tab !== "trail") return;
        setHtml(panel, errorState(error));
      }
    }

    async function loadSecurity() {
      setHtml(panel, loadingState("Loading security events…"));
      updateExport();
      try {
        const { data, source } = await listSecurityEvents();
        if (!ctx.isCurrent() || state.tab !== "security") return;
        setHtml($("[data-source]", root), sourceBadge(source));
        const counts = { danger: 0, warning: 0, info: 0 };
        data.forEach((e) => {
          counts[e.severity] = (counts[e.severity] || 0) + 1;
        });
        setHtml(
          panel,
          html`<div class="pa-audit-summary">
              ${Object.entries(SEVERITY_LABEL).map(
                ([sev, label]) => html`<div class="pa-audit-summary__item">
                  <span class="pa-list-item__icon pa-list-item__icon--${sev}">${icon(SEVERITY_ICON[sev], { size: 16 })}</span>
                  <div class="pa-stat"><span class="pa-stat__label">${label} severity</span><span class="pa-stat__value">${formatNumber(counts[sev] || 0)}</span></div>
                </div>`,
              )}
            </div>
            <div data-table></div>`,
        );
        table = createDataTable($("[data-table]", panel), {
          caption: "Security events",
          rows: data,
          pageSize: 10,
          sortKey: "at",
          sortDir: "desc",
          empty: { icon: "shield-check", title: "No security events", message: "Failed sign-ins, lockouts, role changes and permission denials will appear here." },
          columns: [
            { key: "severity", label: "Severity", sortable: true, render: (r) => statusBadge(r.severity, { label: SEVERITY_LABEL[r.severity] || titleCase(r.severity), tone: r.severity === "info" ? "info" : r.severity }) },
            { key: "type", label: "Event", sortable: true, render: (r) => html`<span class="pa-cell-primary">${titleCase(r.type)}</span>` },
            { key: "message", label: "Details" },
            { key: "ip", label: "IP address", render: (r) => html`<span class="pa-mono">${r.ip}</span>` },
            { key: "at", label: "Time", sortable: true, render: (r) => html`<span class="pa-nowrap" title="${formatDateTime(r.at)}">${formatRelative(r.at)}</span>` },
          ],
        });
      } catch (error) {
        if (!ctx.isCurrent() || state.tab !== "security") return;
        setHtml(panel, errorState(error));
      }
    }

    function showTab(tab) {
      state.tab = tab;
      destroyTable();
      setHtml($("[data-source]", root), "");
      $$("[data-tab]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
      panel.setAttribute("aria-labelledby", `tab-${tab}`);
      return tab === "trail" ? loadTrail() : loadSecurity();
    }

    function exportCsv() {
      const rows = table?.getVisibleRows() || [];
      if (!rows.length) return;
      const csv = toCsv(
        ["timestamp", "actor", "action", "resource", "ip", "outcome"],
        rows.map((r) => [r.timestamp, r.actor, r.action, r.resource, r.ip, r.outcome]),
      );
      const prefix = state.source === "sample" ? "SAMPLE-audit-log" : "audit-log";
      downloadFile(csv, `${prefix}-${toIsoDate(new Date())}.csv`);
      toast.success("Export ready", `${formatNumber(rows.length)} entries exported${state.source === "sample" ? " (sample data)" : ""}.`);
    }

    const applySearch = debounce((value) => {
      state.search = value;
      table?.setSearch(value);
      updateExport();
    }, 150);

    const offs = [
      on(root, "click", "[data-tab]", (_e, btn) => showTab(btn.dataset.tab)),
      on(root, "keydown", "[role=tab]", (e, btn) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        const tabs = $$("[role=tab]", root);
        const next = tabs[(tabs.indexOf(btn) + 1) % tabs.length];
        next.focus();
        showTab(next.dataset.tab);
      }),
      on(root, "input", "[data-search]", (e) => applySearch(e.target.value)),
      on(root, "change", "[data-filter]", (e) => {
        const key = e.target.dataset.filter;
        state[key] = e.target.value;
        // Date and outcome filters are also sent to the API; category/search are client-side.
        if (key === "from" || key === "to" || key === "outcome") loadTrail();
        else {
          table?.setFilter(rowFilter);
          updateExport();
        }
      }),
      on(root, "click", '[data-action="clear"]', () => {
        Object.assign(state, { search: "", category: "", outcome: "", from: "", to: "" });
        loadTrail();
      }),
      on(root, "click", '[data-action="export"]', exportCsv),
      on(root, "click", '[data-action="refresh"], [data-action="retry"]', () => showTab(state.tab)),
      on(root, "click", "[data-page], [data-sort]", () => updateExport()),
    ];
    ctx.onCleanup(() => offs.forEach((off) => off()));

    await loadTrail();
  },
};
