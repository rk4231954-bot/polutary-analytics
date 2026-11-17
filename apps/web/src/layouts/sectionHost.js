/**
 * Section host: shared header + tab bar (+ optional sub-tab pills) for
 * sections that group several features. Tabs are links (each has its own URL),
 * marked with aria-current, so reload / back / deep links all work.
 *
 * The page module renders into the returned panel element. Inside a panel the
 * page's own pageHeader title is visually suppressed by CSS (the section
 * header is the page's h1); its subtitle and actions remain.
 */
import { icon } from "../components/icons.js";
import { html, setHtml } from "../utils/dom.js";

/**
 * @param {HTMLElement} root
 * @param {{section: object, tabId?: string, subtabId?: string}} location
 * @returns {HTMLElement} panel element for the page
 */
export function renderSectionHost(root, { section, tabId, subtabId }) {
  const activeTab = section.tabs.find((t) => t.id === tabId);
  setHtml(
    root,
    html`<div class="pa-section-host">
      <header class="pa-section-host__head">
        <div class="d-flex align-items-center gap-3 min-w-0">
          <span class="pa-section-host__icon">${icon(section.icon, { size: 20 })}</span>
          <div class="min-w-0">
            <h1 class="pa-section-host__title">${section.label}</h1>
            ${section.subtitle ? html`<p class="pa-section-host__subtitle">${section.subtitle}</p>` : ""}
          </div>
        </div>
      </header>
      <nav class="pa-tabs pa-section-host__tabs" aria-label="${section.label} sections">
        ${section.tabs.map(
          (t) => html`<a class="pa-tab ${t.id === tabId ? "active" : ""}" href="#${t.path}" ${t.id === tabId ? html`aria-current="page"` : ""}>
            ${icon(t.icon, { size: 16 })}<span>${t.label}</span>
          </a>`,
        )}
      </nav>
      ${activeTab?.subtabs
        ? html`<nav class="pa-subtabs" aria-label="${activeTab.label} topics">
            ${activeTab.subtabs.map(
              (st) => html`<a class="pa-subtab ${st.id === subtabId ? "active" : ""}" href="#${st.path}" ${st.id === subtabId ? html`aria-current="page"` : ""}>
                ${icon(st.icon, { size: 14 })}${st.label}
              </a>`,
            )}
          </nav>`
        : ""}
      <div class="pa-panel" data-section-panel></div>
    </div>`,
  );
  return root.querySelector("[data-section-panel]");
}
