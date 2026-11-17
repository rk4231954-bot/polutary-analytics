/**
 * Settings — profile, password, device preferences and API connection status.
 * Profile and password changes go to the real API; preferences are stored
 * only in this browser (localStorage, keys prefixed "pa-").
 */
import { config } from "../config.js";
import { icon } from "../components/icons.js";
import { setButtonLoading } from "../components/modal.js";
import { bindPasswordChecklist, bindPasswordToggles, passwordChecklist, passwordField } from "../components/passwordField.js";
import { toast } from "../components/toast.js";
import { callout, card, pageHeader, statusBadge } from "../components/ui.js";
import { changePassword, updateProfile } from "../services/auth.js";
import { ROLES, getUser, setUser } from "../services/session.js";
import { getHealth } from "../services/system.js";
import { $, $$, html, on, setHtml } from "../utils/dom.js";
import { formatDateTime, formatDuration } from "../utils/format.js";
import { applyServerErrors, liveValidate, rules, validateForm } from "../utils/validation.js";
import "../styles/pages/settings.css";

const TABS = [
  { id: "profile", label: "Profile", icon: "user" },
  { id: "security", label: "Security", icon: "shield" },
  { id: "preferences", label: "Preferences", icon: "sliders" },
  { id: "system", label: "System & connection", icon: "plug" },
];

/** Device-local preference keys. "pa-sidebar" is read by the app shell on load. */
export const PREF_KEYS = { dashboardDays: "pa-pref-dashboard-days", sidebar: "pa-sidebar" };

const PROFILE_RULES = {
  fullName: [rules.required("Full name"), rules.maxLength(120, "Full name")],
  email: [rules.required("Email"), rules.email()],
};
const PASSWORD_RULES = {
  currentPassword: [rules.required("Current password")],
  newPassword: [
    rules.required("New password"),
    rules.password(),
    (v, values) => (v && v === values.currentPassword ? "Choose a password different from the current one." : null),
  ],
  confirmPassword: [rules.required("Password confirmation"), rules.matches("newPassword", "Passwords do not match.")],
};

function signInRequired(what) {
  return callout({
    tone: "info",
    icon: "lock",
    title: "Sign in required",
    message: `You are browsing in preview mode without an account. Sign in to ${what}.`,
  });
}

function apiFailure(error, fallback) {
  if (error?.isNetworkError) return "The Flask API is not reachable, so nothing was saved.";
  if (error?.status === 404) return "This feature is not available yet: the API endpoint has not been implemented.";
  return error?.message || fallback;
}

export default {
  title: "Settings",
  render(root, ctx) {
    let tab = TABS.some((t) => t.id === ctx.query.tab) ? ctx.query.tab : "profile";
    const isPreview = () => !getUser() || getUser().isPreview;
    let panelOffs = [];
    const clearPanel = () => {
      panelOffs.forEach((off) => off());
      panelOffs = [];
    };
    ctx.onCleanup(clearPanel);

    setHtml(
      root,
      html`${pageHeader({ title: "Settings", subtitle: "Manage your account, preferences and connection to the analytics backend." })}
        <div class="pa-settings">
          <nav class="pa-settings__nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
            ${TABS.map(
              (t) => html`<button type="button" role="tab" class="pa-settings__tab" id="set-tab-${t.id}" aria-controls="set-panel" aria-selected="${t.id === tab}" data-tab="${t.id}">
                ${icon(t.icon, { size: 16 })}<span>${t.label}</span>
              </button>`,
            )}
          </nav>
          <div class="pa-settings__panel" id="set-panel" role="tabpanel" data-panel></div>
        </div>`,
    );
    const panel = $("[data-panel]", root);

    function renderProfile() {
      const user = getUser();
      const preview = isPreview();
      setHtml(
        panel,
        card({
          title: "Profile",
          subtitle: "Your name and email address as shown to other users.",
          body: html`${preview ? html`<div class="mb-3">${signInRequired("edit your profile")}</div>` : ""}
            <form novalidate data-form="profile">
              <fieldset ${preview ? "disabled" : ""}>
                <div class="d-flex align-items-center gap-3 mb-4">
                  <span class="pa-avatar pa-avatar--lg">${icon("user", { size: 18 })}</span>
                  <div>
                    <div class="fw-semibold">${user?.fullName ?? "Guest"}</div>
                    <div class="pa-text-sm pa-text-2">${preview ? "Not signed in" : ROLES[user.role]?.label || user.role}</div>
                  </div>
                </div>
                <div class="row g-3">
                  <div class="col-md-6 pa-field">
                    <label class="form-label" for="pf-name">Full name</label>
                    <input class="form-control" id="pf-name" name="fullName" autocomplete="name" maxlength="120" value="${preview ? "" : user.fullName}" />
                  </div>
                  <div class="col-md-6 pa-field">
                    <label class="form-label" for="pf-email">Email</label>
                    <input class="form-control" id="pf-email" name="email" type="email" autocomplete="email" value="${preview ? "" : user.email}" />
                  </div>
                </div>
                <div class="pa-settings__actions">
                  <button type="submit" class="btn btn-primary">${icon("save", { size: 16 })}Save profile</button>
                </div>
              </fieldset>
            </form>`,
        }),
      );
      const form = $("[data-form=profile]", panel);
      liveValidate(form, PROFILE_RULES);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const { valid, values } = validateForm(form, PROFILE_RULES);
        if (!valid) return;
        const button = $('button[type="submit"]', form);
        setButtonLoading(button, true, "Saving…");
        try {
          const response = await updateProfile(values);
          if (response?.user) setUser(response.user);
          toast.success("Profile updated", "Your changes have been saved.");
        } catch (error) {
          applyServerErrors(form, error.fields);
          toast.error("Profile not saved", apiFailure(error, "Could not save your profile."));
        } finally {
          if (button.isConnected) setButtonLoading(button, false);
        }
      });
    }

    function renderSecurity() {
      const preview = isPreview();
      setHtml(
        panel,
        html`${card({
            title: "Change password",
            subtitle: "Use a password you do not use anywhere else.",
            body: html`${preview ? html`<div class="mb-3">${signInRequired("change your password")}</div>` : ""}
              <form novalidate data-form="password" class="pa-settings__narrow">
                <fieldset ${preview ? "disabled" : ""}>
                  ${passwordField({ name: "currentPassword", label: "Current password", autocomplete: "current-password", id: "pw-current" })}
                  ${passwordField({ name: "newPassword", label: "New password", autocomplete: "new-password", id: "pw-new" })}
                  ${passwordChecklist("pw-reqs")}
                  ${passwordField({ name: "confirmPassword", label: "Confirm new password", autocomplete: "new-password", id: "pw-confirm" })}
                  <div class="pa-settings__actions">
                    <button type="submit" class="btn btn-primary">${icon("key", { size: 16 })}Update password</button>
                  </div>
                </fieldset>
              </form>`,
          })}
          <div class="mt-4">
            ${card({
              title: "Session security",
              subtitle: "How this application protects your account.",
              body: html`<ul class="pa-settings__list">
                <li>${icon("lock", { size: 16 })}<span>Passwords are hashed on the server and are never shown in the interface.</span></li>
                <li>${icon("shield-check", { size: 16 })}<span>Sessions use a server-issued cookie; this browser stores no access tokens.</span></li>
                <li>${icon("scroll", { size: 16 })}<span>Sign-ins, failed attempts and role changes are recorded in the audit log.</span></li>
              </ul>`,
            })}
          </div>`,
      );
      const form = $("[data-form=password]", panel);
      liveValidate(form, PASSWORD_RULES);
      panelOffs.push(bindPasswordToggles(panel), bindPasswordChecklist(form.elements.namedItem("newPassword"), $("#pw-reqs", panel)));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const { valid, values } = validateForm(form, PASSWORD_RULES);
        if (!valid) return;
        const button = $('button[type="submit"]', form);
        setButtonLoading(button, true, "Updating…");
        try {
          await changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
          form.reset();
          form.elements.namedItem("newPassword").dispatchEvent(new Event("input"));
          toast.success("Password updated", "Use your new password next time you sign in.");
        } catch (error) {
          applyServerErrors(form, error.fields);
          if (error?.status === 400 || error?.status === 401) toast.error("Password not changed", "The current password is incorrect.");
          else toast.error("Password not changed", apiFailure(error, "Could not change your password."));
        } finally {
          if (button.isConnected) setButtonLoading(button, false);
        }
      });
    }

    function renderPreferences() {
      const days = localStorage.getItem(PREF_KEYS.dashboardDays) || "30";
      const collapsed = localStorage.getItem(PREF_KEYS.sidebar) === "collapsed";
      setHtml(
        panel,
        card({
          title: "Preferences",
          subtitle: "Stored only on this device and browser — not synced to your account.",
          body: html`<form data-form="prefs" class="pa-settings__narrow">
            <div class="pa-field mb-4">
              <label class="form-label" for="pref-days">Default dashboard date range</label>
              <select class="form-select" id="pref-days" name="dashboardDays">
                ${[7, 30, 90].map((d) => html`<option value="${d}" ${String(d) === days ? "selected" : ""}>Last ${d} days</option>`)}
              </select>
              <div class="form-text">Used when the dashboard opens without a range in the address.</div>
            </div>
            <div class="form-check form-switch mb-1">
              <input class="form-check-input" type="checkbox" role="switch" id="pref-sidebar" name="sidebarCollapsed" ${collapsed ? "checked" : ""} />
              <label class="form-check-label" for="pref-sidebar">Start with the sidebar collapsed</label>
            </div>
            <div class="form-text mb-4">Applies the next time the application loads. You can also collapse the sidebar with the button next to the logo.</div>
            <div class="pa-settings__actions">
              <button type="submit" class="btn btn-primary">${icon("save", { size: 16 })}Save preferences</button>
              <button type="button" class="btn btn-secondary" data-action="reset-prefs">Reset to defaults</button>
            </div>
          </form>`,
        }),
      );
      const form = $("[data-form=prefs]", panel);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        localStorage.setItem(PREF_KEYS.dashboardDays, form.elements.namedItem("dashboardDays").value);
        localStorage.setItem(PREF_KEYS.sidebar, form.elements.namedItem("sidebarCollapsed").checked ? "collapsed" : "expanded");
        toast.success("Preferences saved", "Saved on this device.");
      });
      panelOffs.push(
        on(panel, "click", '[data-action="reset-prefs"]', () => {
          Object.values(PREF_KEYS).forEach((k) => localStorage.removeItem(k));
          toast.info("Preferences reset", "Defaults restored on this device.");
          renderPreferences();
        }),
      );
    }

    function renderSystem() {
      setHtml(
        panel,
        html`${card({
            title: "API connection",
            subtitle: "The frontend talks to the Flask REST API at the address below.",
            actions: html`<button type="button" class="btn btn-secondary btn-sm" data-action="test">${icon("plug", { size: 14 })}Test connection</button>`,
            body: html`<dl class="pa-dl">
                <dt>API base URL</dt><dd><span class="pa-mono">${config.apiBaseUrl}</span></dd>
                <dt>Build mode</dt><dd>${import.meta.env.MODE}</dd>
                <dt>Preview mode</dt>
                <dd>${config.demoMode ? statusBadge("warning", { label: "On — sample data in read-only views" }) : statusBadge("active", { label: "Off — live API data only" })}</dd>
                <dt>Request timeout</dt><dd>${formatDuration(config.requestTimeoutMs)}</dd>
              </dl>
              <div class="mt-4" data-health aria-live="polite"></div>`,
          })}
          <div class="mt-4">
            ${card({
              title: "Preview mode",
              subtitle: "Controls whether illustrative sample data is shown before the backend exists.",
              body: html`<p class="pa-text-2 mb-3">
                  Preview mode is ${config.demoMode ? "enabled" : "disabled"}. It is enabled by default on the Vite development server and
                  disabled in production builds. It never applies to authentication, saving data, uploads, HDFS/Hive status, HiveQL
                  queries, model evaluation or reports.
                </p>
                <p class="pa-text-2 mb-2">To disable it once the Flask API is running, set this in the repository-root <span class="pa-mono">.env</span> and restart the dev server:</p>
                <pre class="pa-settings__code"><code>VITE_DEMO_MODE=false\nVITE_API_BASE_URL=/api</code></pre>`,
            })}
          </div>`,
      );
      const result = $("[data-health]", panel);
      panelOffs.push(
        on(panel, "click", '[data-action="test"]', async (_e, button) => {
          setButtonLoading(button, true, "Testing…");
          const started = performance.now();
          try {
            const health = await getHealth();
            const ms = performance.now() - started;
            if (!ctx.isCurrent()) return;
            setHtml(
              result,
              callout({
                tone: "success",
                icon: "wifi",
                title: "Connected",
                message: `API responded in ${formatDuration(ms)}. Status: ${health?.status ?? "unknown"}${health?.version ? ` · version ${health.version}` : ""}${health?.time ? ` · server time ${formatDateTime(health.time)}` : ""}.`,
              }),
            );
          } catch (error) {
            if (!ctx.isCurrent()) return;
            setHtml(
              result,
              callout({
                tone: "danger",
                icon: "wifi-off",
                title: error.isNetworkError ? "API not reachable" : "Health check failed",
                message: `${error.message} (checked ${config.apiBaseUrl}/health after ${formatDuration(performance.now() - started)}).`,
              }),
            );
          } finally {
            if (button.isConnected) setButtonLoading(button, false);
          }
        }),
      );
    }

    const RENDERERS = { profile: renderProfile, security: renderSecurity, preferences: renderPreferences, system: renderSystem };

    function showTab(id, { updateUrl = true } = {}) {
      tab = id;
      clearPanel();
      $$("[data-tab]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
      panel.setAttribute("aria-labelledby", `set-tab-${id}`);
      if (updateUrl) window.history.replaceState(null, "", `#/settings?tab=${id}`);
      RENDERERS[id]();
    }

    const offs = [
      on(root, "click", "[data-tab]", (_e, btn) => showTab(btn.dataset.tab)),
      on(root, "keydown", "[role=tab]", (e, btn) => {
        const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
        if (!(e.key in keys)) return;
        e.preventDefault();
        const tabs = $$("[role=tab]", root);
        const next = tabs[(tabs.indexOf(btn) + keys[e.key] + tabs.length) % tabs.length];
        next.focus();
        showTab(next.dataset.tab);
      }),
    ];
    ctx.onCleanup(() => offs.forEach((off) => off()));
    showTab(tab, { updateUrl: false });
  },
};
