/**
 * Big Data / Hive — HDFS and Hive status, Hive tables, HiveQL query console.
 *
 * Everything on this page comes from the Flask API (never sample data, never
 * simulated). When the API, HDFS or Hive is unreachable, the page says so.
 */
import { Dropdown } from "bootstrap";
import { icon } from "../components/icons.js";
import { createDataTable } from "../components/dataTable.js";
import { setButtonLoading } from "../components/modal.js";
import { emptyState, errorState, loadingState, skeletonLines } from "../components/states.js";
import { toast } from "../components/toast.js";
import { callout, card, pageHeader, statusBadge } from "../components/ui.js";
import { getClusterStatus, getQueryHistory, listHiveTables, runHiveQuery } from "../services/bigdata.js";
import { downloadFile, toCsv } from "../utils/csv.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatPercent, formatRelative } from "../utils/format.js";
import "../styles/pages/bigData.css";

const MAX_DISPLAY_ROWS = 1000;

/** Example statements. Inserted into the editor only; never run automatically. */
const TEMPLATES = [
  { label: "List tables", sql: "SHOW TABLES;" },
  { label: "Describe a table", sql: "DESCRIBE <table_name>;" },
  { label: "Preview rows", sql: "SELECT *\nFROM <table_name>\nLIMIT 20;" },
  {
    label: "Daily averages by farm",
    sql: "SELECT farm_code,\n       `date`,\n       AVG(temperature_c) AS avg_temperature_c,\n       AVG(humidity_pct)  AS avg_humidity_pct,\n       SUM(feed_kg)       AS total_feed_kg,\n       SUM(mortality)     AS total_mortality\nFROM <table_name>\nGROUP BY farm_code, `date`\nORDER BY `date` DESC\nLIMIT 100;",
  },
  {
    label: "Mortality by batch",
    sql: "SELECT batch_code,\n       SUM(mortality) AS deaths,\n       MAX(bird_count) AS peak_birds\nFROM <table_name>\nGROUP BY batch_code\nORDER BY deaths DESC;",
  },
];

function statusRow(label, value) {
  return html`<div class="pa-bd-row"><span class="pa-text-2">${label}</span><span class="pa-bd-row__value">${value ?? "—"}</span></div>`;
}

function unknownBody(error, what, { badge = false } = {}) {
  return html`<div class="pa-bd-unknown">
    ${badge ? statusBadge("unknown", { label: "Unknown", tone: "neutral" }) : ""}
    <p class="pa-text-sm pa-text-2 mb-0 ${badge ? "mt-2" : ""}">${error.isNetworkError ? `${what} status is unavailable because the Flask API is not connected.` : error.message}</p>
  </div>`;
}

export default {
  title: "Big Data / Hive",
  async render(root, ctx) {
    const state = { result: null, running: false, abort: null, tables: null };

    setHtml(
      root,
      html`${pageHeader({
          title: "Big Data / Hive",
          subtitle: "Hadoop HDFS storage, Apache Hive tables and HiveQL analytics.",
          actions: html`<button type="button" class="btn btn-secondary btn-sm" data-action="refresh-all">${icon("refresh", { size: 14 })}Refresh status</button>`,
        })}
        <section class="pa-grid pa-grid--3 pa-section" aria-label="Cluster status">
          ${card({ title: "Hadoop HDFS", icon: "hard-drive", actions: html`<span data-badge="hdfs"></span>`, body: html`<div data-status="hdfs">${skeletonLines(4)}</div>` })}
          ${card({ title: "Apache Hive", icon: "database", actions: html`<span data-badge="hive"></span>`, body: html`<div data-status="hive">${skeletonLines(4)}</div>` })}
          ${card({ title: "Ingestion", icon: "workflow", body: html`<div data-status="ingestion">${skeletonLines(3)}</div>` })}
        </section>
        <div class="pa-grid pa-grid--main-side pa-section">
          ${card({
            title: "HiveQL query",
            subtitle: "Runs on HiveServer2 through the Flask API",
            icon: "table",
            actions: html`<div class="dropdown">
                <button type="button" class="btn btn-secondary btn-sm" data-bs-toggle="dropdown" aria-expanded="false">${icon("file-text", { size: 14 })}Templates${icon("chevron-down", { size: 14 })}</button>
                <div class="dropdown-menu dropdown-menu-end">
                  <h6 class="dropdown-header">Insert into editor (not run)</h6>
                  ${TEMPLATES.map((t, i) => html`<button type="button" class="dropdown-item" data-template="${i}">${t.label}</button>`)}
                </div>
              </div>`,
            body: html`<div class="pa-code-editor">
                <div class="pa-code-editor__gutter" aria-hidden="true" data-gutter>1</div>
                <label class="visually-hidden" for="hql-editor">HiveQL statement</label>
                <textarea id="hql-editor" data-editor spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="SELECT * FROM <table_name> LIMIT 20;"></textarea>
              </div>
              <div class="pa-query-bar">
                <div class="pa-query-status" data-query-status aria-live="polite">${statusBadge("idle", { label: "Idle", tone: "neutral" })}</div>
                <div class="d-flex gap-2 flex-wrap">
                  <button type="button" class="btn btn-ghost btn-sm" data-action="clear" title="Clear the editor">Clear</button>
                  <button type="button" class="btn btn-secondary btn-sm d-none" data-action="cancel">Cancel</button>
                  <button type="button" class="btn btn-primary btn-sm" data-action="run" disabled title="Enter a query first">${icon("play", { size: 14 })}Execute<kbd class="pa-kbd">Ctrl ↵</kbd></button>
                </div>
              </div>
              <div class="mt-3">${callout({
                tone: "warning",
                title: "Free-form queries are not enabled",
                message: "The API runs only its fixed, parameterised HiveQL (see the Historical Analytics tabs and the dashboard); it does not execute statements typed here, so Execute and the history below report that the endpoint is unavailable. Run ad-hoc HiveQL with Beeline instead.",
              })}</div>`,
          })}
          ${card({
            title: "Hive tables",
            icon: "layers",
            actions: html`<span class="pa-text-xs pa-text-2" data-db-name></span>`,
            body: html`<div data-tables>${loadingState("Loading tables…", { compact: true })}</div>`,
            flush: true,
          })}
        </div>
        <div class="pa-section">
          ${card({
            title: "Query results",
            icon: "table",
            actions: html`<button type="button" class="btn btn-secondary btn-sm" data-action="export" disabled title="Run a query to export its results">${icon("download", { size: 14 })}Export CSV</button>`,
            body: html`<div data-results>${emptyState({ icon: "play", title: "No results yet", message: "Execute a HiveQL query to see its results here.", compact: true })}</div>`,
            flush: true,
          })}
        </div>
        ${card({
          title: "Query execution history",
          icon: "history",
          actions: html`<button type="button" class="btn btn-ghost btn-sm" data-action="reload-history">${icon("refresh", { size: 14 })}Refresh</button>`,
          body: html`<div data-history>${loadingState("Loading history…", { compact: true })}</div>`,
          flush: true,
        })}`,
    );

    const editor = $("[data-editor]", root);
    const gutter = $("[data-gutter]", root);
    const runBtn = $("[data-action=run]", root);
    Dropdown.getOrCreateInstance($('[data-bs-toggle="dropdown"]', root));

    // ------------------------------------------------------------ editor
    function syncEditor() {
      const lines = editor.value.split("\n").length;
      gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
      gutter.scrollTop = editor.scrollTop;
      const empty = editor.value.trim() === "";
      runBtn.disabled = empty || state.running;
      runBtn.title = empty ? "Enter a query first" : state.running ? "A query is running" : "Execute (Ctrl+Enter)";
    }
    editor.addEventListener("input", syncEditor);
    editor.addEventListener("scroll", () => {
      gutter.scrollTop = editor.scrollTop;
    });
    editor.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        execute();
      } else if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
        syncEditor();
      }
    });

    function insertSql(sql) {
      editor.value = sql;
      syncEditor();
      editor.focus();
      const placeholder = sql.indexOf("<table_name>");
      if (placeholder !== -1) editor.setSelectionRange(placeholder, placeholder + "<table_name>".length);
    }

    // ------------------------------------------------------------ status
    async function loadStatus() {
      ["hdfs", "hive"].forEach((k) => {
        setHtml($(`[data-status=${k}]`, root), skeletonLines(4));
        setHtml($(`[data-badge=${k}]`, root), "");
      });
      setHtml($("[data-status=ingestion]", root), skeletonLines(3));
      try {
        const { data } = await getClusterStatus();
        if (!ctx.isCurrent()) return;
        const { hdfs = {}, hive = {} } = data;
        const used = hdfs.usedBytes;
        const cap = hdfs.capacityBytes;
        const pct = cap ? (used / cap) * 100 : null;
        setHtml($("[data-badge=hdfs]", root), statusBadge(hdfs.connected ? "connected" : "disconnected"));
        setHtml(
          $("[data-status=hdfs]", root),
          html`${statusRow("NameNode", hdfs.namenodeUrl ? html`<span class="pa-mono">${hdfs.namenodeUrl}</span>` : "—")}
            ${statusRow("Live DataNodes", formatNumber(hdfs.liveDataNodes))}
            ${statusRow("Remaining", formatBytes(hdfs.remainingBytes))}
            <div class="mt-3">
              <div class="d-flex justify-content-between pa-text-sm mb-1"><span>Storage used</span><span class="pa-tabular">${formatBytes(used)} of ${formatBytes(cap)}${pct !== null ? ` · ${formatPercent(pct)}` : ""}</span></div>
              <div class="pa-progress"><div class="pa-progress__bar ${pct > 85 ? "pa-progress__bar--danger" : pct > 70 ? "pa-progress__bar--warning" : ""}" style="width:${pct === null ? 0 : Math.min(100, pct).toFixed(1)}%"></div></div>
            </div>`,
        );
        setHtml($("[data-badge=hive]", root), statusBadge(hive.connected ? "connected" : "disconnected"));
        setHtml(
          $("[data-status=hive]", root),
          html`${statusRow("HiveServer2", hive.host ? html`<span class="pa-mono">${hive.host}${hive.port ? `:${hive.port}` : ""}</span>` : "—")}
            ${statusRow("Database", hive.database ? html`<span class="pa-mono">${hive.database}</span>` : "—")}
            ${statusRow("Version", hive.version)}`,
        );
        setHtml($("[data-db-name]", root), hive.database ? `Database: ${hive.database}` : "");
        renderIngestion(data.latestIngestionAt);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        ["hdfs", "hive"].forEach((k) => setHtml($(`[data-badge=${k}]`, root), statusBadge("unknown", { label: "Unknown", tone: "neutral" })));
        setHtml($("[data-status=hdfs]", root), unknownBody(error, "HDFS"));
        setHtml($("[data-status=hive]", root), unknownBody(error, "Hive"));
        setHtml(
          $("[data-status=ingestion]", root),
          html`${unknownBody(error, "Ingestion", { badge: true })}<div class="mt-3"><button type="button" class="btn btn-secondary btn-sm" data-action="refresh-all">${icon("refresh", { size: 14 })}Try again</button></div>`,
        );
      }
    }

    function renderIngestion(latest) {
      const tables = state.tables;
      const totalRows = tables?.reduce((s, t) => s + (t.rowCount || 0), 0);
      setHtml(
        $("[data-status=ingestion]", root),
        html`${statusRow("Latest table data change", latest ? html`<span title="${formatDateTime(latest)}">${formatRelative(latest)}</span>` : "No ingestion yet")}
          ${statusRow("Hive tables", tables ? formatNumber(tables.length) : "—")}
          ${statusRow("Total records (Hive statistics)", tables ? formatNumber(totalRows) : "—")}
          <a class="btn btn-secondary btn-sm mt-3" href="#/datasets/upload">${icon("upload-cloud", { size: 14 })}Upload a dataset</a>`,
      );
    }

    // ------------------------------------------------------------ tables
    async function loadTables() {
      const holder = $("[data-tables]", root);
      setHtml(holder, loadingState("Loading tables…", { compact: true }));
      try {
        const { data } = await listHiveTables();
        if (!ctx.isCurrent()) return;
        state.tables = data;
        if (!data.length) {
          setHtml(holder, emptyState({ icon: "layers", title: "No Hive tables yet", message: "Tables are created when an uploaded dataset is stored in HDFS and registered in Hive.", compact: true }));
          return;
        }
        setHtml(
          holder,
          html`<ul class="pa-list pa-table-list">
            ${data.map(
              (t) => html`<li class="pa-list-item">
                <span class="pa-list-item__icon">${icon("table", { size: 15 })}</span>
                <div class="pa-list-item__body">
                  <div class="d-flex align-items-center gap-2 flex-wrap"><span class="pa-list-item__title pa-mono">${t.name}</span>${t.partitioned ? html`<span class="pa-badge pa-badge--info">Partitioned</span>` : ""}</div>
                  <p class="pa-list-item__text">${t.rowCount === null || t.rowCount === undefined ? "Row count not in Hive statistics" : `${formatNumber(t.rowCount)} rows`}${t.totalSizeBytes != null ? ` · ${formatBytes(t.totalSizeBytes)}` : ""}${t.updatedAt ? ` · updated ${formatRelative(t.updatedAt)}` : ""}</p>
                  ${t.location ? html`<p class="pa-list-item__text pa-mono pa-text-xs text-truncate" title="${t.location}">${t.location}</p>` : ""}
                </div>
                <button type="button" class="btn btn-ghost btn-sm" data-preview-table="${t.name}" title="Insert a preview query for ${t.name}">Query</button>
              </li>`,
            )}
          </ul>`,
        );
      } catch (error) {
        if (!ctx.isCurrent()) return;
        state.tables = null;
        setHtml(holder, errorState(error, { compact: true }));
      }
    }

    // ------------------------------------------------------------ query
    function setQueryStatus(kind, detail) {
      const labels = { idle: ["Idle", "neutral"], running: ["Running…", "info"], success: ["Succeeded", "success"], error: ["Failed", "danger"] };
      const [label, tone] = labels[kind];
      setHtml(
        $("[data-query-status]", root),
        html`${statusBadge(kind, { label, tone })}${detail ? html`<span class="pa-text-sm pa-text-2">${detail}</span>` : ""}`,
      );
    }

    let resultTable = null;
    function renderResults() {
      const holder = $("[data-results]", root);
      resultTable?.destroy();
      resultTable = null;
      const exportBtn = $("[data-action=export]", root);
      const r = state.result;
      if (!r) return;
      exportBtn.disabled = !r.columns?.length;
      exportBtn.title = r.columns?.length ? "Download the returned rows as CSV" : "This query returned no columns";
      if (!r.columns?.length) {
        setHtml(holder, emptyState({ icon: "circle-check", title: "Statement executed", message: "The query returned no result set.", compact: true }));
        return;
      }
      const rows = (r.rows || []).slice(0, MAX_DISPLAY_ROWS).map((row, i) => {
        const obj = { __i: i };
        r.columns.forEach((_, c) => {
          obj[`c${c}`] = row[c];
        });
        return obj;
      });
      const truncated = (r.rows?.length || 0) > MAX_DISPLAY_ROWS;
      setHtml(
        holder,
        html`<div class="pa-results-meta">
          <span>${formatNumber(r.rowCount ?? r.rows?.length ?? 0)} rows</span>
          <span>${formatNumber(r.columns.length)} columns</span>
          ${r.durationMs !== undefined ? html`<span>${formatDuration(r.durationMs)}</span>` : ""}
          ${r.queryId ? html`<span class="pa-mono">${r.queryId}</span>` : ""}
          ${truncated ? html`<span class="pa-badge pa-badge--warning">Showing first ${formatNumber(MAX_DISPLAY_ROWS)} rows — export includes all ${formatNumber(r.rows.length)} returned rows</span>` : ""}
        </div><div data-result-table></div>`,
      );
      resultTable = createDataTable($("[data-result-table]", holder), {
        rows,
        rowKey: "__i",
        pageSize: 25,
        caption: "HiveQL query results",
        columns: r.columns.map((name, c) => ({
          key: `c${c}`,
          label: name,
          sortable: true,
          render: (row) => {
            const v = row[`c${c}`];
            return v === null || v === undefined ? html`<span class="pa-text-muted pa-mono">NULL</span>` : typeof v === "object" ? JSON.stringify(v) : String(v);
          },
        })),
        empty: { icon: "inbox", title: "Query returned 0 rows", message: "The statement ran successfully but matched no rows." },
      });
    }

    async function execute() {
      const sql = editor.value.trim();
      if (!sql || state.running) return;
      state.running = true;
      state.abort = new AbortController();
      syncEditor();
      setButtonLoading(runBtn, true, "Running…");
      $("[data-action=cancel]", root).classList.remove("d-none");
      setQueryStatus("running");
      setHtml($("[data-results]", root), loadingState("Executing on Hive…", { compact: true }));
      const started = performance.now();
      try {
        const { data } = await runHiveQuery(sql, { signal: state.abort.signal });
        if (!ctx.isCurrent()) return;
        state.result = data;
        setQueryStatus("success", `${formatDuration(data.durationMs ?? performance.now() - started)} · ${formatNumber(data.rowCount ?? data.rows?.length ?? 0)} rows`);
        renderResults();
        loadHistory();
      } catch (error) {
        if (!ctx.isCurrent()) return;
        state.result = null;
        const exportBtn = $("[data-action=export]", root);
        exportBtn.disabled = true;
        exportBtn.title = "Run a query to export its results";
        if (error?.name === "AbortError" || state.abort?.signal.aborted) {
          setQueryStatus("idle", "Cancelled in the browser");
          setHtml($("[data-results]", root), emptyState({ icon: "x-circle", title: "Query cancelled", message: "The request was cancelled. The server may still finish the statement.", compact: true }));
        } else {
          setQueryStatus("error", error.isNetworkError ? "Backend not connected" : error.code || "");
          setHtml($("[data-results]", root), errorState(error, { compact: true, retry: false, title: error.isNetworkError ? "Backend not connected" : "Query failed" }));
        }
      } finally {
        state.running = false;
        state.abort = null;
        if (ctx.isCurrent()) {
          setButtonLoading(runBtn, false);
          $("[data-action=cancel]", root).classList.add("d-none");
          syncEditor();
        }
      }
    }

    function exportCsv() {
      const r = state.result;
      if (!r?.columns?.length) return;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      downloadFile(toCsv(r.columns, r.rows || []), `hive-query-${stamp}.csv`);
      toast.success("Export ready", `${formatNumber(r.rows?.length || 0)} rows exported to CSV.`);
    }

    // ------------------------------------------------------------ history
    let historyTable = null;
    async function loadHistory() {
      const holder = $("[data-history]", root);
      historyTable?.destroy();
      historyTable = null;
      setHtml(holder, loadingState("Loading history…", { compact: true }));
      try {
        const { data } = await getQueryHistory({ limit: 25 });
        if (!ctx.isCurrent()) return;
        historyTable = createDataTable(holder, {
          rows: data,
          pageSize: 8,
          caption: "HiveQL query execution history",
          columns: [
            { key: "sql", label: "Statement", render: (q) => html`<code class="pa-history-sql" title="${q.sql}">${q.sql}</code>${q.error ? html`<span class="pa-cell-secondary text-danger">${q.error}</span>` : ""}` },
            { key: "status", label: "Status", sortable: true, render: (q) => statusBadge(q.status) },
            { key: "durationMs", label: "Duration", sortable: true, align: "num", render: (q) => formatDuration(q.durationMs) },
            { key: "rowCount", label: "Rows", sortable: true, align: "num", render: (q) => formatNumber(q.rowCount) },
            { key: "executedBy", label: "User", sortable: true },
            { key: "executedAt", label: "Executed", sortable: true, render: (q) => html`<span title="${formatDateTime(q.executedAt)}">${formatRelative(q.executedAt)}</span>` },
            { key: "actions", label: "", align: "actions", render: (q) => html`<button type="button" class="btn btn-ghost btn-sm" data-reuse="${q.id}" title="Copy this statement into the editor">Reuse</button>` },
          ],
          empty: { icon: "history", title: "No queries executed yet", message: "Executed HiveQL statements are logged here." },
        });
        historyTable.rowsById = new Map(data.map((q) => [String(q.id), q]));
      } catch (error) {
        if (ctx.isCurrent()) setHtml(holder, errorState(error, { compact: true }));
      }
    }

    // ------------------------------------------------------------ events
    const offs = [
      on(root, "click", "[data-template]", (_e, el) => insertSql(TEMPLATES[Number(el.dataset.template)].sql)),
      on(root, "click", "[data-preview-table]", (_e, el) => {
        insertSql(`SELECT *\nFROM ${el.dataset.previewTable}\nLIMIT 20;`);
        editor.scrollIntoView({ block: "center", behavior: "smooth" });
      }),
      on(root, "click", "[data-reuse]", (_e, el) => {
        const q = historyTable?.rowsById?.get(el.dataset.reuse);
        if (q) {
          insertSql(q.sql);
          editor.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }),
      on(root, "click", "[data-action=run]", execute),
      on(root, "click", "[data-action=cancel]", () => state.abort?.abort()),
      on(root, "click", "[data-action=clear]", () => insertSql("")),
      on(root, "click", "[data-action=export]", exportCsv),
      on(root, "click", "[data-action=refresh-all]", async () => {
        await loadTables();
        await loadStatus();
      }),
      on(root, "click", "[data-action=reload-history], [data-history] [data-action=retry]", loadHistory),
      on(root, "click", "[data-tables] [data-action=retry]", loadTables),
    ];
    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      state.abort?.abort();
      resultTable?.destroy();
      historyTable?.destroy();
    });

    syncEditor();
    loadHistory();
    await loadTables();
    await loadStatus();
  },
};
