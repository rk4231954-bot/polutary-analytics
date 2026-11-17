/** Batch detail — flock KPIs, growth and mortality charts, daily records and health inspections for one batch. */
import { barChart, chartCanvas, colors, hasData, lineChart } from "../charts/index.js";
import { createDataTable } from "../components/dataTable.js";
import { confirmDeleteBatch, openBatchModal } from "../components/farmForms.js";
import { icon } from "../components/icons.js";
import { openFormModal } from "../components/modal.js";
import { emptyState, errorState, loadingState } from "../components/states.js";
import { toast } from "../components/toast.js";
import { callout, card, kpiCard, selectOptions, sourceBadge, statusBadge } from "../components/ui.js";
import { getBatch } from "../services/batches.js";
import { listFarms } from "../services/farms.js";
import { listInspections, recordInspection } from "../services/inspections.js";
import { can, getUser } from "../services/session.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatDate, formatDateTime, formatNumber, formatPercent, formatWeightKg, toIsoDate } from "../utils/format.js";
import { applyServerErrors, liveValidate, rules, validateForm } from "../utils/validation.js";

const HEALTH_STATUSES = [
  { value: "normal", label: "Normal", tone: "success" },
  { value: "attention", label: "Needs attention", tone: "warning" },
  { value: "critical", label: "Critical", tone: "danger" },
];
const INSPECTION_RULES = {
  observedOn: [rules.required("Inspection date"), rules.date({ label: "Inspection date" })],
  healthStatus: [rules.required("Health status")],
  observation: [rules.required("Observation"), rules.minLength(3, "Observation"), rules.maxLength(2000, "Observation")],
};
import "../styles/pages/farms.css";
import "../styles/pages/batches.css";

export default {
  title: "Batch",
  async render(root, ctx) {
    const id = ctx.params.id;
    let batch = null;
    let table = null;
    const crumbs = (code) => [{ label: "Farm management" }, { label: "Poultry Batches", path: "/batches" }, { label: code }];

    function render(b, source) {
      const daily = [...(b.daily || [])].sort((x, y) => x.ageDays - y.ageDays);
      // Mortality is only known once daily readings exist; never show 0% for "no data".
      const deaths = daily.length && b.initialCount && b.birdCount !== null ? b.initialCount - b.birdCount : null;
      const mortalityPct = deaths !== null && b.initialCount ? (deaths / b.initialCount) * 100 : null;
      const feedKg = daily.reduce((s, d) => s + (d.feedKg || 0), 0);

      setHtml(
        root,
        html`<a class="pa-back-link" href="#/batches">${icon("arrow-left", { size: 14 })}All batches</a>
          <header class="pa-page-header">
            <div class="pa-page-header__text">
              <div class="pa-detail-title">
                <h1 class="pa-page-header__title">Batch ${b.code}</h1>
                ${statusBadge(b.status)} ${sourceBadge(source)}
              </div>
              <div class="pa-meta-row pa-detail-meta">
                <span>${icon("warehouse", { size: 13 })}<a class="pa-farm-link" href="#/farms/${b.farmId}">${b.farmName}</a></span>
                <span>${icon("bird", { size: 13 })}${b.poultryType}${b.breed ? ` · ${b.breed}` : ""}</span>
                <span>${icon("calendar", { size: 13 })}Placed ${formatDate(b.startDate)}${b.endDate ? ` · ended ${formatDate(b.endDate)}` : ""}</span>
              </div>
            </div>
            <div class="pa-page-header__actions">
              ${can("batches.manage")
                ? html`<a class="btn btn-secondary" href="#/data-collection?batch=${b.id}">${icon("clipboard", { size: 16 })}Record readings</a>
                    <button type="button" class="btn btn-secondary" data-action="edit">${icon("pencil", { size: 16 })}Edit</button>
                    <button type="button" class="btn btn-outline-danger" data-action="delete">${icon("trash", { size: 16 })}Delete</button>`
                : ""}
            </div>
          </header>
          <section class="pa-section pa-grid pa-grid--kpi pa-batch-kpis" aria-label="Batch metrics">
            ${kpiCard({ label: "Birds alive", value: formatNumber(b.birdCount), icon: "bird", footnote: `of ${formatNumber(b.initialCount)} placed` })}
            ${kpiCard({ label: "Mortality to date", value: formatPercent(mortalityPct, 2), icon: "heart-pulse", tone: "danger", footnote: deaths !== null ? `${formatNumber(deaths)} birds` : "No mortality records" })}
            ${kpiCard({ label: "Flock age", value: b.status === "planned" ? "—" : formatNumber(b.ageDays), unit: b.status === "planned" ? "" : "days", icon: "calendar", tone: "info", footnote: b.status === "planned" ? "Not yet placed" : "Since placement" })}
            ${kpiCard({ label: "Average weight", value: b.avgWeightG ? formatWeightKg(b.avgWeightG) : "—", unit: b.avgWeightG ? "kg" : "", icon: "scale", footnote: "Latest recorded" })}
            ${kpiCard({ label: "Cumulative feed", value: daily.length ? formatNumber(feedKg / 1000, { decimals: 1 }) : "—", unit: daily.length ? "t" : "", icon: "wheat", tone: "warning", footnote: daily.length ? `${formatNumber(feedKg)} kg recorded` : "No feed records" })}
          </section>
          <section class="pa-section pa-grid pa-grid--2">
            ${card({ title: "Growth curve", subtitle: "Average body weight by age", icon: "trending-up", actions: sourceBadge(source), body: html`<div data-chart="growth"></div>` })}
            ${card({ title: "Daily mortality", subtitle: "Deaths recorded per day", icon: "heart-pulse", actions: sourceBadge(source), body: html`<div data-chart="mortality"></div>` })}
          </section>
          ${card({
            title: "Daily records",
            subtitle: "Most recent first",
            icon: "table",
            actions: sourceBadge(source),
            body: html`<div class="pa-fm-table" data-records></div>`,
            flush: true,
          })}
          ${can("health.view")
            ? html`<section class="pa-section mt-4">
                ${card({
                  title: "Health inspections",
                  subtitle: "Observations recorded during on-farm inspections",
                  icon: "stethoscope",
                  actions: can("inspections.record")
                    ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="add-inspection">${icon("plus", { size: 14 })}Record inspection</button>`
                    : "",
                  body: html`<div data-inspections></div>`,
                })}
              </section>`
            : ""}`,
      );
      if (can("health.view")) loadInspections();

      const growth = [{ label: "Average weight", data: daily.map((d) => d.avgWeightG ?? null), color: colors.emerald, fill: true }];
      if (hasData(growth)) {
        setHtml($('[data-chart="growth"]', root), chartCanvas("batch-growth", { label: "Batch growth curve" }));
        lineChart($("#batch-growth", root), { labels: daily.map((d) => String(d.ageDays)), datasets: growth, unit: "g", decimals: 0, yTitle: "Weight (g)", xTitle: "Age (days)", showLegend: false });
      } else {
        setHtml($('[data-chart="growth"]', root), emptyState({ icon: "line-chart", title: "No weight records yet", message: "Weights recorded through Data Collection or dataset uploads appear here.", compact: true }));
      }

      const mortality = [{ label: "Deaths", data: daily.map((d) => d.mortality ?? null), color: colors.danger }];
      if (hasData(mortality)) {
        setHtml($('[data-chart="mortality"]', root), chartCanvas("batch-mortality", { label: "Daily mortality for this batch" }));
        barChart($("#batch-mortality", root), { labels: daily.map((d) => d.date), datasets: mortality, unit: "birds", decimals: 0, yTitle: "Birds", showLegend: false });
      } else {
        setHtml($('[data-chart="mortality"]', root), emptyState({ icon: "heart-pulse", title: "No mortality records yet", compact: true }));
      }

      table?.destroy();
      table = createDataTable($("[data-records]", root), {
        caption: "Daily records for this batch",
        rows: daily.map((d) => ({ ...d, id: d.date })),
        pageSize: 10,
        sortKey: "date",
        sortDir: "desc",
        empty: { icon: "clipboard", title: "No daily records", message: "Record daily readings to build this batch's history." },
        columns: [
          { key: "date", label: "Date", sortable: true, render: (d) => formatDate(d.date) },
          { key: "ageDays", label: "Age", sortable: true, align: "num", render: (d) => `${d.ageDays} d` },
          { key: "birdCount", label: "Birds", sortable: true, align: "num", render: (d) => formatNumber(d.birdCount) },
          { key: "mortality", label: "Deaths", sortable: true, align: "num", render: (d) => formatNumber(d.mortality) },
          { key: "avgWeightG", label: "Avg weight (g)", sortable: true, align: "num", render: (d) => formatNumber(d.avgWeightG) },
          { key: "feedKg", label: "Feed (kg)", sortable: true, align: "num", render: (d) => formatNumber(d.feedKg, { decimals: 1 }) },
        ],
      });
    }

    async function loadInspections() {
      const box = $("[data-inspections]", root);
      if (!box) return;
      if (getUser()?.isPreview) {
        setHtml(box, callout({ tone: "info", title: "Sign in required", message: "Inspection records are only available to signed-in users. There is no sample data for them." }));
        return;
      }
      setHtml(box, loadingState("Loading inspections…"));
      try {
        const items = await listInspections(id);
        if (!ctx.isCurrent() || !box.isConnected) return;
        setHtml(
          box,
          items.length
            ? html`<ul class="pa-inspections">
                ${items.map((item) => {
                  const status = HEALTH_STATUSES.find((s) => s.value === item.healthStatus);
                  return html`<li class="pa-inspections__item">
                    <div class="pa-inspections__head">
                      ${statusBadge(item.healthStatus, { tone: status?.tone, label: status?.label || item.healthStatus })}
                      <span class="pa-text-sm fw-semibold">${formatDate(item.observedOn)}</span>
                      <span class="pa-text-xs pa-text-2" title="${formatDateTime(item.createdAt)}">${item.inspector || "Unknown inspector"}</span>
                    </div>
                    <p class="pa-inspections__text">${item.observation}</p>
                  </li>`;
                })}
              </ul>`
            : emptyState({ icon: "stethoscope", title: "No inspections recorded", message: "Observations from health inspections will be listed here.", compact: true }),
        );
      } catch (error) {
        if (ctx.isCurrent() && box.isConnected) setHtml(box, errorState(error, { retry: false }));
      }
    }

    function openInspection() {
      openFormModal({
        title: "Record inspection",
        subtitle: `Batch ${batch.code} · ${batch.farmName}`,
        submitLabel: "Save inspection",
        footerNote: "Observations are recorded in the audit log.",
        body: html`<div class="row g-3">
          <div class="col-sm-6 pa-field">
            <label class="form-label pa-required" for="insp-date">Inspection date</label>
            <input class="form-control" type="date" id="insp-date" name="observedOn" value="${toIsoDate(new Date())}" max="${toIsoDate(new Date())}" />
            <div class="invalid-feedback"></div>
          </div>
          <div class="col-sm-6 pa-field">
            <label class="form-label pa-required" for="insp-status">Health status</label>
            <select class="form-select" id="insp-status" name="healthStatus">${selectOptions(HEALTH_STATUSES, "normal")}</select>
            <div class="invalid-feedback"></div>
          </div>
          <div class="col-12 pa-field">
            <label class="form-label pa-required" for="insp-text">Observation</label>
            <textarea class="form-control" id="insp-text" name="observation" rows="4" maxlength="2000" placeholder="What was observed, where, and any follow-up."></textarea>
            <div class="invalid-feedback"></div>
          </div>
        </div>`,
        onOpen: (el) => liveValidate(el.querySelector("form"), INSPECTION_RULES),
        onSubmit: async (form) => {
          const { valid, values } = validateForm(form, INSPECTION_RULES);
          if (!valid) return false;
          try {
            await recordInspection(id, values);
            toast.success("Inspection recorded", `Saved for batch ${batch.code}.`);
            if (ctx.isCurrent()) loadInspections();
            return true;
          } catch (error) {
            applyServerErrors(form, error.fields);
            toast.apiError(error, "Could not save inspection");
            return false;
          }
        },
      });
    }

    async function load() {
      setHtml(root, loadingState("Loading batch…"));
      try {
        const { data, source } = await getBatch(id);
        if (!ctx.isCurrent()) return;
        batch = data;
        ctx.setTitle(`Batch ${data.code}`, crumbs(data.code));
        render(data, source);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        ctx.setTitle("Batch", crumbs("Batch"));
        setHtml(
          root,
          html`<div class="pa-card">${error.isNotFound
            ? emptyState({
                icon: "bird",
                title: "Batch not found",
                message: "This batch does not exist or you do not have access to it.",
                action: html`<a class="btn btn-primary btn-sm" href="#/batches">${icon("arrow-left", { size: 14 })}Back to batches</a>`,
              })
            : errorState(error)}</div>`,
        );
      }
    }

    const offs = [
      on(root, "click", '[data-action="edit"]', async (_e, btn) => {
        if (!batch) return;
        btn.disabled = true;
        try {
          const { data: farms } = await listFarms().catch(() => ({ data: [{ id: batch.farmId, name: batch.farmName }] }));
          openBatchModal({ batch, farms, onSaved: () => ctx.isCurrent() && load() });
        } finally {
          btn.disabled = false;
        }
      }),
      on(root, "click", '[data-action="delete"]', async () => {
        if (batch && (await confirmDeleteBatch(batch)) && ctx.isCurrent()) ctx.navigate("/batches");
      }),
      on(root, "click", '[data-action="add-inspection"]', () => batch && openInspection()),
      on(root, "click", '[data-action="retry"]', () => load()),
    ];
    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      table?.destroy();
    });

    await load();
  },
};
