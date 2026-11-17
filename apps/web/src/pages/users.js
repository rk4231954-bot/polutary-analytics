/**
 * Users & Roles — account management, role overview, login activity and
 * failed sign-in attempts. Never displays passwords, hashes or tokens.
 * All changes are sent to the real API, which enforces role-based access.
 */
import { createDataTable } from "../components/dataTable.js";
import { icon } from "../components/icons.js";
import { confirmDialog, openFormModal } from "../components/modal.js";
import { errorState, loadingState } from "../components/states.js";
import { toast } from "../components/toast.js";
import { callout, pageHeader, selectOptions, sourceBadge, statusBadge } from "../components/ui.js";
import { listFarms } from "../services/farms.js";
import { ROLES } from "../services/session.js";
import { createUser, listFailedLogins, listLoginActivity, listUsers, updateUser } from "../services/users.js";
import { $, $$, debounce, html, on, setHtml } from "../utils/dom.js";
import { formatDateTime, formatNumber, formatRelative, initials } from "../utils/format.js";
import { applyServerErrors, liveValidate, rules, validateForm } from "../utils/validation.js";
import "../styles/pages/users.css";

const PERMISSIONS = {
  admin: ["Manage users, roles and farm assignments", "Access all farms and datasets", "Configure system settings", "Review audit logs and security events"],
  farm_manager: ["Manage assigned farms and batches", "Record daily readings and upload datasets", "View analytics and predictions for assigned farms"],
  analyst: ["View analytics and predictions", "Run HiveQL queries on the analytical store", "Export CSV and PDF reports"],
};
const ROLE_ICONS = { admin: "shield-check", farm_manager: "warehouse", analyst: "bar-chart" };
const ROLE_OPTIONS = Object.entries(ROLES).map(([value, r]) => ({ value, label: r.label }));
const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
];

function roleBadge(role) {
  return html`<span class="pa-badge ${role === "admin" ? "pa-badge--brand" : "pa-badge--neutral"}">${ROLES[role]?.label || role || "—"}</span>`;
}

function farmsCell(user) {
  if (user.role === "admin") return html`<span class="pa-text-2">All farms</span>`;
  if (!user.farms?.length) return html`<span class="pa-text-2">None assigned</span>`;
  const [first, ...rest] = user.farms;
  return html`<span class="pa-users-farms" title="${user.farms.join(", ")}">${first}${rest.length ? html` <span class="pa-badge pa-badge--neutral">+${rest.length}</span>` : ""}</span>`;
}

function farmChecklist(farms, selectedNames = []) {
  if (farms === null) return html`<p class="pa-text-sm pa-text-2 mb-0">${icon("cloud-off", { size: 14 })} Farm list unavailable — farms can be assigned later.</p>`;
  if (!farms.length) return html`<p class="pa-text-sm pa-text-2 mb-0">No farms registered yet.</p>`;
  return html`<div class="pa-check-list" role="group" aria-label="Assigned farms">
    ${farms.map(
      (f) => html`<label class="form-check pa-check-list__item">
        <input class="form-check-input" type="checkbox" name="farmIds" value="${f.id}" ${selectedNames.includes(f.name) ? "checked" : ""} />
        <span class="form-check-label">${f.name}</span>
      </label>`,
    )}
  </div>`;
}

const selectedFarmIds = (form) => $$('input[name="farmIds"]:checked', form).map((i) => Number(i.value) || i.value);

export default {
  title: "Users & Roles",
  async render(root, ctx) {
    const canManage = !ctx.user?.role || ctx.user.role === "admin"; // preview visitor: server decides
    const state = { tab: "users", users: [], usersSource: null, search: "", role: "", status: "", farms: undefined };

    setHtml(
      root,
      html`${pageHeader({
          title: "Users & Roles",
          subtitle: "Manage accounts, role-based access and farm assignments.",
          actions: html`<button type="button" class="btn btn-primary" data-action="invite" ${canManage ? "" : html`disabled title="Only administrators can add users"`}>
            ${icon("user-plus", { size: 16 })}Add user
          </button>`,
        })}
        ${canManage ? "" : html`<div class="mb-4">${callout({ tone: "info", title: "Read-only", message: "Only administrators can add users or change roles." })}</div>`}
        <section class="pa-section" aria-labelledby="roles-heading">
          <div class="pa-section-head"><h2 class="pa-section-title" id="roles-heading">Roles</h2></div>
          <div class="pa-grid pa-grid--3" data-roles></div>
        </section>
        <section class="pa-card" aria-label="Accounts and sign-in activity">
          <div class="pa-users-tabs">
            <div class="pa-tabs" role="tablist" aria-label="User management views">
              <button type="button" class="pa-tab" role="tab" id="tab-users" aria-controls="panel" aria-selected="true" data-tab="users">${icon("users", { size: 14 })} Users</button>
              <button type="button" class="pa-tab" role="tab" id="tab-logins" aria-controls="panel" aria-selected="false" data-tab="logins">${icon("key", { size: 14 })} Login activity</button>
              <button type="button" class="pa-tab" role="tab" id="tab-failed" aria-controls="panel" aria-selected="false" data-tab="failed">${icon("shield-alert", { size: 14 })} Failed attempts</button>
            </div>
            <span data-tab-source></span>
          </div>
          <div id="panel" role="tabpanel" aria-labelledby="tab-users" data-panel></div>
        </section>`,
    );

    const panel = $("[data-panel]", root);
    let table = null;
    const destroyTable = () => {
      table?.destroy();
      table = null;
    };
    ctx.onCleanup(destroyTable);

    function renderRoles() {
      const counts = Object.fromEntries(Object.keys(ROLES).map((r) => [r, state.users.filter((u) => u.role === r).length]));
      setHtml(
        $("[data-roles]", root),
        Object.entries(ROLES).map(
          ([key, role]) => html`<article class="pa-card pa-role-card">
            <div class="pa-role-card__head">
              <span class="pa-kpi__icon ${key === "admin" ? "" : key === "analyst" ? "pa-kpi__icon--info" : "pa-kpi__icon--warning"}">${icon(ROLE_ICONS[key], { size: 16 })}</span>
              <div class="min-w-0">
                <h3 class="pa-h4">${role.label}</h3>
                <p class="pa-text-sm pa-text-2 mb-0">${role.description}</p>
              </div>
              <span class="pa-role-card__count" title="Accounts with this role">${state.usersSource ? formatNumber(counts[key]) : "—"}<small>users</small></span>
            </div>
            <ul class="pa-role-card__perms">
              ${PERMISSIONS[key].map((p) => html`<li>${icon("check", { size: 14 })}<span>${p}</span></li>`)}
            </ul>
          </article>`,
        ),
      );
    }

    function filteredUsers() {
      return (row) => (!state.role || row.role === state.role) && (!state.status || row.status === state.status);
    }

    function renderUsersTab() {
      setHtml(
        panel,
        html`<div class="pa-toolbar">
            <div class="pa-search-input">
              ${icon("search", { size: 16 })}
              <label class="visually-hidden" for="user-search">Search users</label>
              <input class="form-control form-control-sm" id="user-search" type="search" placeholder="Search name or email…" value="${state.search}" data-search />
            </div>
            <label class="visually-hidden" for="user-role">Role</label>
            <select class="form-select form-select-sm" id="user-role" data-filter="role">
              <option value="">All roles</option>${selectOptions(ROLE_OPTIONS, state.role)}
            </select>
            <label class="visually-hidden" for="user-status">Status</label>
            <select class="form-select form-select-sm" id="user-status" data-filter="status">
              <option value="">All statuses</option>
              ${selectOptions([...STATUS_OPTIONS, { value: "invited", label: "Invited" }], state.status)}
            </select>
          </div>
          <div data-table></div>`,
      );
      table = createDataTable($("[data-table]", panel), {
        caption: "User accounts",
        rows: state.users,
        pageSize: 10,
        sortKey: "fullName",
        empty: { icon: "users", title: "No users yet", message: "Add the first account to give someone access." },
        columns: [
          {
            key: "fullName",
            label: "User",
            sortable: true,
            searchValue: (u) => `${u.fullName} ${u.email}`,
            render: (u) => html`<div class="d-flex align-items-center gap-2 min-w-0">
              <span class="pa-avatar">${initials(u.fullName)}</span>
              <div class="min-w-0"><span class="pa-cell-primary">${u.fullName}</span><span class="pa-cell-secondary">${u.email}</span></div>
            </div>`,
          },
          { key: "role", label: "Role", sortable: true, render: (u) => roleBadge(u.role), searchValue: (u) => ROLES[u.role]?.label },
          { key: "farms", label: "Farms", render: farmsCell, searchValue: (u) => (u.farms || []).join(" ") },
          { key: "status", label: "Status", sortable: true, render: (u) => statusBadge(u.status) },
          {
            key: "lastLoginAt",
            label: "Last sign-in",
            sortable: true,
            render: (u) => (u.lastLoginAt ? html`<span title="${formatDateTime(u.lastLoginAt)}">${formatRelative(u.lastLoginAt)}</span>` : html`<span class="pa-text-2">Never</span>`),
          },
          {
            key: "actions",
            label: html`<span class="visually-hidden">Actions</span>`,
            align: "actions",
            render: (u) => html`<div class="d-inline-flex gap-1">
              <button type="button" class="btn btn-ghost btn-icon btn-sm" data-edit="${u.id}" aria-label="Edit ${u.fullName}" title="Edit role and access" ${canManage ? "" : "disabled"}>${icon("pencil", { size: 14 })}</button>
              ${u.status === "suspended"
                ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-reactivate="${u.id}" aria-label="Reactivate ${u.fullName}" title="Reactivate" ${canManage ? "" : "disabled"}>${icon("refresh", { size: 14 })}</button>`
                : html`<button type="button" class="btn btn-ghost btn-icon btn-sm pa-users-danger" data-deactivate="${u.id}" aria-label="Deactivate ${u.fullName}" title="Deactivate" ${canManage ? "" : "disabled"}>${icon("x-circle", { size: 14 })}</button>`}
            </div>`,
          },
        ],
      });
      table.setFilter(filteredUsers());
      if (state.search) table.setSearch(state.search);
    }

    async function loadUsers() {
      setHtml(panel, loadingState("Loading users…"));
      try {
        const { data, source } = await listUsers();
        if (!ctx.isCurrent()) return;
        state.users = data;
        state.usersSource = source;
        renderRoles();
        if (state.tab === "users") {
          setHtml($("[data-tab-source]", root), sourceBadge(source));
          renderUsersTab();
        }
      } catch (error) {
        if (!ctx.isCurrent() || state.tab !== "users") return;
        setHtml(panel, errorState(error));
      }
    }

    async function loadSimpleTab(tab, loader, columns, empty, caption) {
      setHtml(panel, loadingState("Loading…"));
      try {
        const { data, source } = await loader();
        if (!ctx.isCurrent() || state.tab !== tab) return;
        setHtml($("[data-tab-source]", root), sourceBadge(source));
        setHtml(panel, html`<div data-table></div>`);
        table = createDataTable($("[data-table]", panel), { rows: data, columns, pageSize: 10, sortKey: "at", sortDir: "desc", empty, caption });
      } catch (error) {
        if (!ctx.isCurrent() || state.tab !== tab) return;
        setHtml(panel, errorState(error));
      }
    }

    const whenColumn = {
      key: "at",
      label: "Time",
      sortable: true,
      render: (r) => html`<span title="${formatDateTime(r.at)}">${formatRelative(r.at)}</span>`,
    };

    function showTab(tab) {
      state.tab = tab;
      destroyTable();
      setHtml($("[data-tab-source]", root), "");
      $$("[data-tab]", root).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
      panel.setAttribute("aria-labelledby", `tab-${tab}`);
      if (tab === "users") return loadUsers();
      if (tab === "logins")
        return loadSimpleTab(
          "logins",
          listLoginActivity,
          [
            { key: "userName", label: "User", sortable: true, render: (r) => html`<span class="pa-cell-primary">${r.userName}</span><span class="pa-cell-secondary">${r.email}</span>`, searchValue: (r) => `${r.userName} ${r.email}` },
            { key: "ip", label: "IP address", render: (r) => html`<span class="pa-mono">${r.ip}</span>` },
            { key: "userAgent", label: "Device" },
            whenColumn,
          ],
          { icon: "key", title: "No sign-ins recorded", message: "Successful sign-ins will be listed here." },
          "Successful sign-ins",
        );
      return loadSimpleTab(
        "failed",
        listFailedLogins,
        [
          { key: "email", label: "Account", sortable: true, render: (r) => html`<span class="pa-cell-primary">${r.email}</span>` },
          { key: "ip", label: "IP address", render: (r) => html`<span class="pa-mono">${r.ip}</span>` },
          { key: "reason", label: "Reason", render: (r) => statusBadge("warning", { label: r.reason }) },
          { key: "attempts", label: "Attempts", align: "num", sortable: true, render: (r) => html`<span class="${r.attempts >= 5 ? "pa-users-danger fw-semibold" : ""}">${formatNumber(r.attempts)}</span>` },
          whenColumn,
        ],
        { icon: "shield-check", title: "No failed attempts", message: "Failed sign-in attempts will be listed here." },
        "Failed sign-in attempts",
      );
    }

    async function getFarms() {
      if (state.farms !== undefined) return state.farms;
      try {
        state.farms = (await listFarms()).data;
      } catch {
        state.farms = null;
      }
      return state.farms;
    }

    const USER_RULES = {
      fullName: [rules.required("Full name"), rules.maxLength(120, "Full name")],
      email: [rules.required("Email"), rules.email()],
      role: [rules.required("Role")],
    };

    async function openInvite() {
      const farms = await getFarms();
      if (!ctx.isCurrent()) return;
      openFormModal({
        title: "Add user",
        subtitle: "The user receives access according to the selected role.",
        submitLabel: "Add user",
        body: html`<div class="pa-field mb-3">
            <label class="form-label pa-required" for="inv-name">Full name</label>
            <input class="form-control" id="inv-name" name="fullName" autocomplete="off" maxlength="120" />
          </div>
          <div class="pa-field mb-3">
            <label class="form-label pa-required" for="inv-email">Email</label>
            <input class="form-control" id="inv-email" name="email" type="email" autocomplete="off" />
          </div>
          <div class="pa-field mb-3">
            <label class="form-label pa-required" for="inv-role">Role</label>
            <select class="form-select" id="inv-role" name="role"><option value="">Select a role…</option>${selectOptions(ROLE_OPTIONS)}</select>
            <div class="form-text" data-role-help>Choose the minimum role needed.</div>
          </div>
          <fieldset>
            <legend class="form-label">Assigned farms</legend>
            ${farmChecklist(farms)}
          </fieldset>`,
        footerNote: "No password is set here. The account holder sets their own password.",
        onOpen: (el) => {
          const form = $("form", el);
          liveValidate(form, USER_RULES);
          form.elements.namedItem("role").addEventListener("change", (e) => {
            $("[data-role-help]", el).textContent = ROLES[e.target.value]?.description || "Choose the minimum role needed.";
          });
        },
        onSubmit: async (form) => {
          const { valid, values } = validateForm(form, USER_RULES);
          if (!valid) return false;
          try {
            await createUser({ fullName: values.fullName, email: values.email, role: values.role, farmIds: selectedFarmIds(form) });
            toast.success("User added", `${values.fullName} now has ${ROLES[values.role].label} access.`);
            loadUsers();
            return true;
          } catch (error) {
            applyServerErrors(form, error.fields);
            toast.apiError(error, "Could not add user");
            return false;
          }
        },
      });
    }

    async function openEdit(user) {
      const farms = await getFarms();
      if (!ctx.isCurrent()) return;
      openFormModal({
        title: "Edit access",
        subtitle: `${user.fullName} · ${user.email}`,
        submitLabel: "Save changes",
        body: html`<div class="row g-3 mb-3">
            <div class="col-sm-6 pa-field">
              <label class="form-label" for="edit-role">Role</label>
              <select class="form-select" id="edit-role" name="role">${selectOptions(ROLE_OPTIONS, user.role)}</select>
            </div>
            <div class="col-sm-6 pa-field">
              <label class="form-label" for="edit-status">Status</label>
              <select class="form-select" id="edit-status" name="status" ${user.status === "invited" ? "disabled" : ""}>
                ${selectOptions(user.status === "invited" ? [{ value: "invited", label: "Invited" }] : STATUS_OPTIONS, user.status)}
              </select>
            </div>
          </div>
          <fieldset>
            <legend class="form-label">Assigned farms</legend>
            ${farmChecklist(farms, user.farms || [])}
          </fieldset>`,
        footerNote: "Role changes are recorded in the audit log.",
        onSubmit: async (form) => {
          const changes = { role: form.elements.namedItem("role").value, farmIds: selectedFarmIds(form) };
          if (user.status !== "invited") changes.status = form.elements.namedItem("status").value;
          try {
            await updateUser(user.id, changes);
            toast.success("Access updated", `Changes for ${user.fullName} were saved.`);
            loadUsers();
            return true;
          } catch (error) {
            toast.apiError(error, "Could not update user");
            return false;
          }
        },
      });
    }

    async function setStatus(user, status) {
      const deactivate = status === "suspended";
      const ok = await confirmDialog({
        title: deactivate ? "Deactivate user?" : "Reactivate user?",
        message: deactivate
          ? `${user.fullName} will no longer be able to sign in. Their records and audit history are kept.`
          : `${user.fullName} will be able to sign in again with their existing role.`,
        confirmLabel: deactivate ? "Deactivate" : "Reactivate",
        danger: deactivate,
      });
      if (!ok) return;
      try {
        await updateUser(user.id, { status });
        toast.success(deactivate ? "User deactivated" : "User reactivated", user.fullName);
        loadUsers();
      } catch (error) {
        toast.apiError(error, deactivate ? "Could not deactivate user" : "Could not reactivate user");
      }
    }

    const findUser = (id) => state.users.find((u) => String(u.id) === String(id));
    const applySearch = debounce((value) => {
      state.search = value;
      table?.setSearch(value);
    }, 150);

    const offs = [
      on(root, "click", "[data-tab]", (_e, btn) => showTab(btn.dataset.tab)),
      on(root, "keydown", "[role=tab]", (e, btn) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        const tabs = $$("[role=tab]", root);
        const next = tabs[(tabs.indexOf(btn) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        showTab(next.dataset.tab);
      }),
      on(root, "input", "[data-search]", (e) => applySearch(e.target.value)),
      on(root, "change", "[data-filter]", (e) => {
        state[e.target.dataset.filter] = e.target.value;
        table?.setFilter(filteredUsers());
      }),
      on(root, "click", '[data-action="invite"]', () => openInvite()),
      on(root, "click", "[data-edit]", (_e, b) => findUser(b.dataset.edit) && openEdit(findUser(b.dataset.edit))),
      on(root, "click", "[data-deactivate]", (_e, b) => findUser(b.dataset.deactivate) && setStatus(findUser(b.dataset.deactivate), "suspended")),
      on(root, "click", "[data-reactivate]", (_e, b) => findUser(b.dataset.reactivate) && setStatus(findUser(b.dataset.reactivate), "active")),
      on(root, "click", '[data-action="retry"]', () => showTab(state.tab)),
    ];
    ctx.onCleanup(() => offs.forEach((off) => off()));

    renderRoles();
    if (ctx.query.action === "new" && canManage) openInvite();
    await loadUsers();
  },
};
