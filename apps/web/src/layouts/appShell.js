/**
 * Application shell: sidebar navigation, top bar (breadcrumb, title, search,
 * notifications, user menu), preview-mode banner and the page content area.
 */
import { Dropdown, Modal } from "bootstrap";
import { config } from "../config.js";
import { icon } from "../components/icons.js";
import { emptyState, errorState, loadingState } from "../components/states.js";
import { sampleBadge } from "../components/ui.js";
import { toast } from "../components/toast.js";
import { NAV_GROUPS, SEARCH_ENTRIES } from "../navigation.js";
import { getAlerts } from "../services/analytics.js";
import { onUnauthorized } from "../services/apiClient.js";
import { ROLES, getUser, onUserChange, signOut } from "../services/session.js";
import { $, $$, html, on, setHtml } from "../utils/dom.js";
import { formatRelative, initials } from "../utils/format.js";

const SIDEBAR_KEY = "pa-sidebar";
let els = null;
let globalListenersBound = false;
let handlingUnauthorized = false;
let navigateFn = (path) => {
  window.location.hash = path;
};

function brandMark(size = 18) {
  return html`<span class="pa-brand-mark">${icon("sprout", { size, strokeWidth: 2 })}</span>`;
}

function sidebarMarkup() {
  return html`<aside class="pa-sidebar" id="pa-sidebar" aria-label="Main navigation">
    <div class="pa-sidebar__brand">
      ${brandMark()}
      <div class="pa-brand-text">
        <span class="pa-brand-name">${config.appName}</span>
        <span class="pa-brand-sub">${config.appTagline}</span>
      </div>
      <button type="button" class="pa-icon-btn pa-collapse-btn" data-action="toggle-sidebar" aria-label="Collapse sidebar" aria-controls="pa-sidebar" aria-expanded="true">
        ${icon("panel-close", { size: 18 })}
      </button>
    </div>
    <nav class="pa-sidebar__nav">
      ${NAV_GROUPS.map(
        (group) => html`<div class="pa-nav-group">
          <div class="pa-nav-group__label">${group.label}</div>
          ${group.items.map(
            (item) => html`<a class="pa-nav-link" href="#${item.path}" data-nav="${item.id}" title="${item.label}">
              ${icon(item.icon, { size: 18 })}<span class="pa-nav-link__label">${item.label}</span>
            </a>`,
          )}
        </div>`,
      )}
    </nav>
    <div class="pa-sidebar__footer">
      <div class="pa-env-chip" title="${config.demoMode ? "Preview mode: read-only views show sample data" : `Connected to ${config.apiBaseUrl}`}">
        <span class="pa-env-chip__dot ${config.demoMode ? "is-sample" : "is-api"}"></span>
        <span class="pa-env-chip__text">${config.demoMode ? "Preview mode · sample data" : `Live API · ${config.apiBaseUrl}`}</span>
      </div>
    </div>
  </aside>`;
}

function userMenuMarkup(user) {
  const isPreview = !user || user.isPreview;
  const roleLabel = isPreview ? "Not signed in" : ROLES[user.role]?.label || user.role || "User";
  return html`<button type="button" class="pa-user-btn" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Account menu">
      <span class="pa-avatar">${isPreview ? icon("user", { size: 14 }) : initials(user.fullName)}</span>
      <span class="pa-user-btn__name">${user?.fullName ?? "Guest"}</span>
      <span class="pa-user-btn__chevron pa-text-2">${icon("chevron-down", { size: 14 })}</span>
    </button>
    <div class="dropdown-menu dropdown-menu-end" style="min-width: 240px">
      <div class="d-flex align-items-center gap-2 px-3 py-2">
        <span class="pa-avatar pa-avatar--lg">${isPreview ? icon("user", { size: 16 }) : initials(user.fullName)}</span>
        <div class="min-w-0">
          <div class="fw-semibold text-truncate">${user?.fullName ?? "Guest"}</div>
          <div class="pa-text-xs pa-text-2 text-truncate">${isPreview ? roleLabel : user.email}</div>
          ${isPreview ? "" : html`<span class="pa-badge pa-badge--brand mt-1">${roleLabel}</span>`}
        </div>
      </div>
      <div class="dropdown-divider"></div>
      <a class="dropdown-item" href="#/settings">${icon("user", { size: 16 })}Profile &amp; preferences</a>
      <a class="dropdown-item" href="#/settings?tab=security">${icon("shield", { size: 16 })}Security</a>
      <div class="dropdown-divider"></div>
      ${isPreview
        ? html`<a class="dropdown-item" href="#/login">${icon("lock", { size: 16 })}Sign in</a>`
        : html`<button type="button" class="dropdown-item" data-action="logout">${icon("log-out", { size: 16 })}Sign out</button>`}
    </div>`;
}

function topbarMarkup() {
  return html`<header class="pa-topbar">
    <button type="button" class="pa-icon-btn pa-mobile-only" data-action="open-mobile-nav" aria-label="Open navigation" aria-controls="pa-sidebar">
      ${icon("menu", { size: 20 })}
    </button>
    <div class="pa-topbar__title">
      <ol class="pa-breadcrumb" data-breadcrumb aria-label="Breadcrumb"></ol>
      <div class="pa-page-title" data-page-title></div>
    </div>
    <div class="pa-topbar__actions">
      <button type="button" class="pa-search-trigger" data-action="open-search" aria-label="Search pages and actions (Ctrl+K)">
        ${icon("search", { size: 16 })}<span class="pa-search-trigger__text">Search…</span><kbd>Ctrl K</kbd>
      </button>
      <div class="dropdown">
        <button type="button" class="pa-icon-btn" data-action="notifications" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false" aria-label="Notifications">
          ${icon("bell", { size: 18 })}<span class="pa-notif-dot d-none" data-notif-dot></span>
        </button>
        <div class="dropdown-menu dropdown-menu-end pa-notif-menu">
          <div class="pa-notif-menu__head">
            <span class="fw-semibold">Farm alerts</span>
            <a href="#/dashboard" class="pa-text-sm">View dashboard</a>
          </div>
          <div class="pa-notif-menu__body" data-notif-body>${loadingState("Loading alerts…", { compact: true })}</div>
        </div>
      </div>
      <div class="dropdown" data-user-menu></div>
    </div>
  </header>`;
}

function previewBanner() {
  if (!config.demoMode) return "";
  const user = getUser();
  const signedIn = user && !user.isPreview;
  return html`<div class="pa-preview-banner" role="note">
    ${icon("info", { size: 16 })}
    <span><strong>Preview mode.</strong> Views marked ${sampleBadge("Sample data")} show illustrative values, not real farm measurements.
    <span class="pa-hide-sm">${signedIn
      ? "Farms, batches, users and audit logs use the real API; features not built yet fall back to labelled samples."
      : "Saving, uploads, Hive queries and model results require the Flask API."}</span></span>
  </div>`;
}

function renderUserMenu() {
  const container = $("[data-user-menu]", els.root);
  setHtml(container, userMenuMarkup(getUser()));
  Dropdown.getOrCreateInstance($('[data-bs-toggle="dropdown"]', container));
}

const SEVERITY_ICON = { danger: "alert-triangle", warning: "circle-alert", info: "info" };

async function loadNotifications() {
  const body = $("[data-notif-body]", els.root);
  setHtml(body, loadingState("Loading alerts…", { compact: true }));
  try {
    const { data: alerts, source } = await getAlerts({ limit: 6 });
    $("[data-notif-dot]", els.root).classList.toggle("d-none", alerts.length === 0);
    if (!alerts.length) {
      setHtml(body, emptyState({ icon: "bell", title: "No active alerts", message: "Alerts generated from farm data will appear here.", compact: true }));
      return;
    }
    setHtml(
      body,
      html`${source === "sample" ? html`<div class="px-3 pt-2">${sampleBadge("Sample alerts")}</div>` : ""}
        <ul class="pa-list">
          ${alerts.map(
            (a) => html`<li class="pa-list-item">
              <span class="pa-list-item__icon pa-list-item__icon--${a.severity}">${icon(SEVERITY_ICON[a.severity] || "info", { size: 16 })}</span>
              <div class="pa-list-item__body">
                <div class="pa-list-item__title">${a.title}</div>
                <p class="pa-list-item__text">${a.farmName} · ${formatRelative(a.createdAt)}</p>
              </div>
            </li>`,
          )}
        </ul>`,
    );
  } catch (error) {
    setHtml(body, errorState(error, { compact: true }));
  }
}

// --- Command palette (global search over pages and actions) ----------------
const ACTIONS = [
  { label: "Add a farm", icon: "plus", path: "/farms?action=new", group: "Actions" },
  { label: "Add a poultry batch", icon: "plus", path: "/batches?action=new", group: "Actions" },
  { label: "Record daily readings", icon: "clipboard", path: "/data-collection", group: "Actions" },
  { label: "Upload a CSV dataset", icon: "upload-cloud", path: "/datasets/upload", group: "Actions" },
  { label: "Run a HiveQL query", icon: "database", path: "/big-data", group: "Actions" },
  { label: "Export a report", icon: "file-down", path: "/reports", group: "Actions" },
];

function openPalette() {
  const byGroup = (g) => SEARCH_ENTRIES.filter((e) => e.group === g);
  const entries = [...byGroup("Sections"), ...byGroup("Pages"), ...ACTIONS];
  const wrapper = document.createElement("div");
  setHtml(
    wrapper,
    html`<div class="modal pa-palette" tabindex="-1" aria-label="Search">
      <div class="modal-dialog"><div class="modal-content">
        <div class="pa-palette__input">
          ${icon("search", { size: 18 })}
          <input type="text" placeholder="Search pages and actions…" aria-label="Search pages and actions" role="combobox" aria-expanded="true" aria-controls="pa-palette-results" autocomplete="off" />
        </div>
        <ul class="pa-palette__results" id="pa-palette-results" role="listbox"></ul>
        <div class="pa-palette__foot"><span>↑↓ to navigate</span><span>↵ to open</span><span>Esc to close</span></div>
      </div></div>
    </div>`,
  );
  const el = wrapper.firstElementChild;
  document.body.appendChild(el);
  const modal = new Modal(el);
  const input = $("input", el);
  const list = $("ul", el);
  let results = entries;
  let active = 0;

  const draw = () => {
    if (!results.length) {
      setHtml(list, html`<li class="px-3 py-4 text-center pa-text-2">No pages or actions match “${input.value}”.</li>`);
      return;
    }
    let lastGroup = null;
    setHtml(
      list,
      results.map((r, i) => {
        const header = r.group !== lastGroup ? html`<li class="pa-palette__group" role="presentation">${r.group}</li>` : "";
        lastGroup = r.group;
        return html`${header}<li role="option" aria-selected="${i === active}">
          <button type="button" class="pa-palette__item ${i === active ? "is-active" : ""}" data-index="${i}">${icon(r.icon, { size: 16 })}${r.label}</button>
        </li>`;
      }),
    );
    $(".is-active", list)?.scrollIntoView({ block: "nearest" });
  };
  const go = (entry) => {
    modal.hide();
    navigateFn(entry.path);
  };
  input.addEventListener("input", () => {
    const term = input.value.trim().toLowerCase();
    results = term ? entries.filter((e) => e.label.toLowerCase().includes(term) || e.group.toLowerCase().includes(term)) : entries;
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") active = Math.min(results.length - 1, active + 1);
    else if (e.key === "ArrowUp") active = Math.max(0, active - 1);
    else if (e.key === "Enter" && results[active]) return go(results[active]);
    else return;
    e.preventDefault();
    draw();
  });
  on(list, "click", "[data-index]", (_e, btn) => go(results[Number(btn.dataset.index)]));
  el.addEventListener("shown.bs.modal", () => input.focus());
  el.addEventListener("hidden.bs.modal", () => {
    modal.dispose();
    el.remove();
  });
  draw();
  modal.show();
}

// --- Sidebar state -----------------------------------------------------------
function applySidebarState(collapsed) {
  els.root.dataset.sidebar = collapsed ? "collapsed" : "expanded";
  const btn = $('[data-action="toggle-sidebar"]', els.root);
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  setHtml(btn, icon(collapsed ? "panel-open" : "panel-close", { size: 18 }));
}

function setMobileNav(open) {
  els.root.dataset.mobileNav = open ? "open" : "closed";
  document.body.style.overflow = open ? "hidden" : "";
  if (open) $(".pa-nav-link.active, .pa-nav-link", els.root)?.focus();
}

export function mountAppShell(container, { navigate }) {
  navigateFn = navigate;
  setHtml(
    container,
    html`<div class="pa-app" data-sidebar="expanded" data-mobile-nav="closed">
      <a class="visually-hidden-focusable" href="#pa-content" data-action="skip">Skip to content</a>
      ${sidebarMarkup()}
      <div class="pa-sidebar-backdrop" data-action="close-mobile-nav"></div>
      <div class="pa-main">
        ${topbarMarkup()}
        ${previewBanner()}
        <main class="pa-content" id="pa-content" tabindex="-1"></main>
      </div>
    </div>`,
  );
  els = { root: $(".pa-app", container), content: $("#pa-content", container) };
  applySidebarState(localStorage.getItem(SIDEBAR_KEY) === "collapsed");
  renderUserMenu();

  on(els.root, "click", "[data-action]", async (e, el) => {
    switch (el.dataset.action) {
      case "toggle-sidebar": {
        const collapsed = els.root.dataset.sidebar !== "collapsed";
        localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
        applySidebarState(collapsed);
        break;
      }
      case "open-mobile-nav":
        setMobileNav(true);
        break;
      case "close-mobile-nav":
        setMobileNav(false);
        break;
      case "open-search":
        openPalette();
        break;
      case "skip":
        e.preventDefault();
        els.content.focus();
        break;
      case "logout":
        try {
          await signOut();
          toast.success("Signed out", "You have been signed out.");
        } catch (error) {
          toast.apiError(error, "Sign-out failed");
        }
        navigateFn("/login");
        break;
      default:
        break;
    }
  });
  $('[data-action="notifications"]', els.root).addEventListener("show.bs.dropdown", loadNotifications);
  bindGlobalListeners();
}

/** Document-level listeners are bound once, even if the shell is re-mounted after login. */
function bindGlobalListeners() {
  if (globalListenersBound) return;
  globalListenersBound = true;
  onUserChange(() => els?.root.isConnected && renderUserMenu());
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && els?.root.isConnected) {
      e.preventDefault();
      if (!document.querySelector(".pa-palette.show")) openPalette();
    }
    if (e.key === "Escape" && els?.root.dataset.mobileNav === "open") setMobileNav(false);
  });
  onUnauthorized(() => {
    const user = getUser();
    if (handlingUnauthorized || !user || user.isPreview || !els?.root.isConnected) return;
    handlingUnauthorized = true;
    toast.warning("Session expired", "Please sign in again.");
    signOut()
      .catch(() => {})
      .finally(() => {
        handlingUnauthorized = false;
        navigateFn("/login");
      });
  });
}

export const appShell = {
  content: () => els?.content,
  setActive(navId) {
    if (!els) return;
    $$(".pa-nav-link", els.root).forEach((a) => {
      const active = a.dataset.nav === navId;
      a.classList.toggle("active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  },
  setPageMeta(title, breadcrumb = []) {
    if (!els) return;
    $("[data-page-title]", els.root).textContent = title;
    setHtml(
      $("[data-breadcrumb]", els.root),
      breadcrumb.map((c, i) =>
        c.path && i < breadcrumb.length - 1 ? html`<li><a href="#${c.path}">${c.label}</a></li>` : html`<li>${c.label}</li>`,
      ),
    );
  },
  closeMobileNav() {
    if (els) setMobileNav(false);
  },
};
