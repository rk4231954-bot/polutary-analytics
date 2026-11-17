/** Small presentational building blocks: page header, cards, badges, KPI cards. */
import { html } from "../utils/dom.js";
import { titleCase } from "../utils/format.js";
import { icon } from "./icons.js";

export function pageHeader({ title, subtitle, actions }) {
  return html`<header class="pa-page-header">
    <div class="pa-page-header__text">
      <h1 class="pa-page-header__title">${title}</h1>
      ${subtitle ? html`<p class="pa-page-header__subtitle">${subtitle}</p>` : ""}
    </div>
    ${actions ? html`<div class="pa-page-header__actions">${actions}</div>` : ""}
  </header>`;
}

/**
 * Card shell. `body` and `actions` are markup.
 * @param {{title?: string, subtitle?: string, icon?: string, actions?: any, body: any, footer?: any,
 *          flush?: boolean, bordered?: boolean, className?: string, id?: string, badge?: any}} options
 */
export function card({ title, subtitle, icon: iconName, actions, body, footer, flush = false, bordered = false, className = "", id, badge }) {
  return html`<section class="pa-card ${className}" ${id ? html`id="${id}"` : ""}>
    ${title
      ? html`<div class="pa-card__header ${bordered ? "pa-card__header--bordered" : ""}">
          <div class="min-w-0">
            <h2 class="pa-card__title">${iconName ? icon(iconName, { size: 16 }) : ""}${title}${badge ? html` ${badge}` : ""}</h2>
            ${subtitle ? html`<p class="pa-card__subtitle">${subtitle}</p>` : ""}
          </div>
          ${actions ? html`<div class="pa-card__actions">${actions}</div>` : ""}
        </div>`
      : ""}
    <div class="pa-card__body ${flush ? "pa-card__body--flush" : ""}">${body}</div>
    ${footer ? html`<div class="pa-card__footer">${footer}</div>` : ""}
  </section>`;
}

/** Marks content as illustrative sample data (preview mode only). */
export function sampleBadge(label = "Sample data") {
  return html`<span class="pa-badge pa-badge--sample" title="Illustrative preview data — not real farm measurements">${label}</span>`;
}

/** Marks a value as a model prediction, distinct from measured data. */
export function predictionBadge(label = "Predicted") {
  return html`<span class="pa-badge pa-badge--prediction" title="Model estimate — not a measured value">${label}</span>`;
}

/** Shows sampleBadge only when the data source is sample. */
export function sourceBadge(source) {
  return source === "sample" ? sampleBadge() : "";
}

const STATUS_TONES = {
  active: "success", healthy: "success", success: "success", completed: "neutral", connected: "success", ok: "success",
  online: "success", stored: "success", available: "success", verified: "success", enabled: "success",
  warning: "warning", maintenance: "warning", pending: "warning", planned: "info", processing: "info", running: "info",
  queued: "info", validating: "info", info: "info", invited: "info",
  inactive: "neutral", archived: "neutral", disabled: "neutral", unknown: "neutral", "not configured": "neutral",
  error: "danger", failed: "danger", danger: "danger", critical: "danger", offline: "danger", disconnected: "danger",
  locked: "danger", suspended: "danger", high: "danger", medium: "warning", low: "success",
};

export function statusBadge(status, { label, tone, dot = true } = {}) {
  const key = String(status ?? "unknown").toLowerCase();
  const t = tone || STATUS_TONES[key] || "neutral";
  return html`<span class="pa-badge pa-badge--${t}">${dot ? html`<span class="pa-badge__dot"></span>` : ""}${label || titleCase(key)}</span>`;
}

/**
 * Trend chip. `delta` is a percentage change; `goodWhen` says whether an increase is good.
 */
export function trend(delta, { goodWhen = "up", suffix = "%" } = {}) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "";
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return html`<span class="pa-trend pa-trend--neutral">${icon("minus", { size: 12 })}0${suffix}</span>`;
  const up = rounded > 0;
  const good = goodWhen === "neutral" ? null : (up && goodWhen === "up") || (!up && goodWhen === "down");
  const cls = good === null ? "neutral" : good ? "good" : "bad";
  return html`<span class="pa-trend pa-trend--${cls}">${icon(up ? "arrow-up" : "arrow-down", { size: 12 })}${Math.abs(rounded)}${suffix}</span>`;
}

/**
 * @param {{label: string, value: string, unit?: string, icon: string, tone?: "brand"|"info"|"warning"|"danger",
 *          trend?: any, footnote?: string}} options
 */
export function kpiCard({ label, value, unit, icon: iconName, tone = "brand", trend: trendMarkup, footnote }) {
  return html`<article class="pa-card pa-kpi">
    <div class="pa-kpi__top">
      <span class="pa-kpi__label">${label}</span>
      <span class="pa-kpi__icon ${tone !== "brand" ? `pa-kpi__icon--${tone}` : ""}">${icon(iconName, { size: 16 })}</span>
    </div>
    <div class="pa-kpi__value">${value}${unit ? html`<span class="pa-kpi__unit">${unit}</span>` : ""}</div>
    <div class="pa-kpi__foot">${trendMarkup || ""}${footnote ? html`<span>${footnote}</span>` : ""}</div>
  </article>`;
}

export function callout({ tone = "info", icon: iconName, title, message }) {
  const defaults = { info: "info", warning: "alert-triangle", danger: "circle-alert", success: "circle-check" };
  return html`<div class="pa-callout pa-callout--${tone}" role="${tone === "danger" ? "alert" : "note"}">
    ${icon(iconName || defaults[tone] || "info", { size: 16 })}
    <div>
      ${title ? html`<div class="pa-callout__title">${title}</div>` : ""}
      ${message ? html`<p>${message}</p>` : ""}
    </div>
  </div>`;
}

/** Standard notice shown wherever ML predictions appear. */
export function predictionDisclaimer() {
  return callout({
    tone: "warning",
    icon: "shield-alert",
    title: "Decision support only — not a diagnosis",
    message:
      "Risk indicators and forecasts are statistical estimates from historical data. They are not confirmed poultry disease diagnoses. Consult a qualified veterinarian before acting on health concerns.",
  });
}

export function selectOptions(options, selected) {
  return options.map(
    (o) => html`<option value="${o.value}" ${String(o.value) === String(selected ?? "") ? "selected" : ""}>${o.label}</option>`,
  );
}
