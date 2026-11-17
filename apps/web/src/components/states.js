/** Empty, error and loading states shared by every page. */
import { html } from "../utils/dom.js";
import { icon } from "./icons.js";

/**
 * @param {{icon?: string, title: string, message?: string, action?: any, compact?: boolean}} options
 *   action: markup for a button/link (e.g. html`<button ...>`)
 */
export function emptyState({ icon: iconName = "inbox", title, message, action, compact = false }) {
  return html`<div class="pa-state ${compact ? "pa-state--compact" : ""}">
    <div class="pa-state__icon">${icon(iconName, { size: 20 })}</div>
    <div class="pa-state__title">${title}</div>
    ${message ? html`<p class="pa-state__message">${message}</p>` : ""}
    ${action ? html`<div class="pa-state__actions">${action}</div>` : ""}
  </div>`;
}

/**
 * Error state for a failed API call. Network errors get a friendly
 * "backend not connected" message; other errors show the API message.
 * Include a button with data-action="retry" to let the page re-run its loader.
 */
export function errorState(error, { compact = false, retry = true, title } = {}) {
  const offline = error?.isNetworkError;
  const notFound = error?.isNotFound;
  const heading =
    title || (offline ? "Backend not connected" : notFound ? "Not available yet" : error?.isForbidden ? "Access denied" : "Something went wrong");
  const message = offline
    ? "This view loads real data from the Flask API, which is not reachable right now."
    : error?.message || "An unexpected error occurred.";
  return html`<div class="pa-state pa-state--error ${compact ? "pa-state--compact" : ""}" role="alert">
    <div class="pa-state__icon">${icon(offline ? "cloud-off" : "circle-alert", { size: 20 })}</div>
    <div class="pa-state__title">${heading}</div>
    <p class="pa-state__message">${message}</p>
    ${offline && error?.path ? html`<div class="pa-state__detail">GET ${error.path}</div>` : ""}
    ${retry
      ? html`<div class="pa-state__actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="retry">${icon("refresh", { size: 14 })}Try again</button>
        </div>`
      : ""}
  </div>`;
}

export function loadingState(label = "Loading…", { compact = false } = {}) {
  return html`<div class="pa-state ${compact ? "pa-state--compact" : ""}" aria-busy="true">
    <div class="pa-text-2">${icon("loader", { size: 20, className: "pa-spin" })}</div>
    <p class="pa-state__message">${label}</p>
  </div>`;
}

export function skeletonLines(count = 3) {
  return html`<div class="d-flex flex-column gap-2" aria-hidden="true">
    ${Array.from({ length: count }, (_, i) => html`<span class="pa-skeleton" style="height:12px;width:${90 - i * 15}%"></span>`)}
  </div>`;
}

/** @param {number} count @param {string} [gridClass] e.g. "pa-grid--4" to match the final layout */
export function skeletonKpis(count = 6, gridClass = "pa-grid--kpi") {
  return html`<div class="pa-grid ${gridClass}" aria-busy="true" aria-label="Loading metrics">
    ${Array.from({ length: count }, () => html`<div class="pa-card pa-kpi">
      <span class="pa-skeleton" style="height:14px;width:55%"></span>
      <span class="pa-skeleton" style="height:28px;width:45%"></span>
      <span class="pa-skeleton" style="height:12px;width:70%"></span>
    </div>`)}
  </div>`;
}
