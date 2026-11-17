/**
 * Data table with client-side search, column sorting and pagination.
 *
 * const table = createDataTable(container, {
 *   columns: [{ key: "name", label: "Name", sortable: true, render: (row) => html`...`, align: "num"|"actions",
 *               sortValue: (row) => ..., searchValue: (row) => ... }],
 *   rows: [...],
 *   pageSize: 10,
 *   rowKey: "id",
 *   onRowClick: (row) => {},          // optional, makes rows clickable (keyboard accessible)
 *   empty: { icon, title, message },  // shown when there are no rows at all
 *   caption: "Accessible table description",
 * });
 * table.setRows(rows); table.setSearch("term"); table.setFilter((row) => bool);
 */
import { html, on, setHtml } from "../utils/dom.js";
import { formatNumber } from "../utils/format.js";
import { icon } from "./icons.js";
import { emptyState } from "./states.js";

function defaultValue(row, key) {
  return row?.[key];
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function createDataTable(container, options) {
  const {
    columns, pageSize = 10, rowKey = "id", onRowClick, caption,
    empty = { icon: "inbox", title: "No records", message: "There is nothing to show yet." },
  } = options;
  const state = {
    rows: options.rows || [],
    search: "",
    filter: null,
    sortKey: options.sortKey || null,
    sortDir: options.sortDir || "asc",
    page: 1,
  };

  function visibleRows() {
    let rows = state.rows;
    if (state.filter) rows = rows.filter(state.filter);
    if (state.search) {
      const term = state.search.toLowerCase();
      rows = rows.filter((row) =>
        columns.some((c) => {
          const v = c.searchValue ? c.searchValue(row) : defaultValue(row, c.key);
          return v !== null && v !== undefined && String(v).toLowerCase().includes(term);
        }),
      );
    }
    if (state.sortKey) {
      const col = columns.find((c) => c.key === state.sortKey);
      const get = col?.sortValue || ((row) => defaultValue(row, state.sortKey));
      rows = [...rows].sort((a, b) => compare(get(a), get(b)) * (state.sortDir === "asc" ? 1 : -1));
    }
    return rows;
  }

  function headerCell(col) {
    const cls = col.align === "num" ? "is-num" : col.align === "actions" ? "is-actions" : "";
    if (!col.sortable) return html`<th scope="col" class="${cls}">${col.label ?? ""}</th>`;
    const active = state.sortKey === col.key;
    const ariaSort = active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none";
    const iconName = active ? (state.sortDir === "asc" ? "arrow-up" : "arrow-down") : "arrow-up-down";
    return html`<th scope="col" class="${cls}" aria-sort="${ariaSort}">
      <button type="button" class="pa-sort-btn" data-sort="${col.key}" ${active ? "data-active" : ""}>
        ${col.label}${icon(iconName, { size: 12 })}
      </button>
    </th>`;
  }

  function render() {
    const rows = visibleRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    state.page = Math.min(state.page, totalPages);
    const start = (state.page - 1) * pageSize;
    const pageRows = rows.slice(start, start + pageSize);

    if (state.rows.length === 0) {
      setHtml(container, emptyState({ ...empty, compact: true }));
      return;
    }

    setHtml(
      container,
      html`<div class="pa-table-wrap">
          <table class="pa-table">
            ${caption ? html`<caption class="visually-hidden">${caption}</caption>` : ""}
            <thead><tr>${columns.map(headerCell)}</tr></thead>
            <tbody>
              ${pageRows.length === 0
                ? html`<tr><td colspan="${columns.length}">${emptyState({
                    icon: "search",
                    title: "No matching records",
                    message: "Try a different search term or clear the filters.",
                    compact: true,
                  })}</td></tr>`
                : pageRows.map(
                    (row) => html`<tr data-key="${row[rowKey]}" ${onRowClick ? html`class="is-clickable" tabindex="0"` : ""}>
                      ${columns.map((c) => {
                        const cls = c.align === "num" ? "is-num" : c.align === "actions" ? "is-actions" : "";
                        const content = c.render ? c.render(row) : defaultValue(row, c.key);
                        return html`<td class="${cls}">${content ?? "—"}</td>`;
                      })}
                    </tr>`,
                  )}
            </tbody>
          </table>
        </div>
        ${rows.length > pageSize || state.page > 1
          ? html`<nav class="pa-pagination" aria-label="Table pagination">
              <span>Showing ${formatNumber(start + 1)}–${formatNumber(Math.min(start + pageSize, rows.length))} of ${formatNumber(rows.length)}</span>
              <div class="pa-pagination__controls">
                <button type="button" class="btn btn-secondary btn-sm" data-page="prev" ${state.page === 1 ? "disabled" : ""} aria-label="Previous page">
                  ${icon("chevron-left", { size: 14 })}
                </button>
                <span class="px-2">Page ${state.page} of ${totalPages}</span>
                <button type="button" class="btn btn-secondary btn-sm" data-page="next" ${state.page === totalPages ? "disabled" : ""} aria-label="Next page">
                  ${icon("chevron-right", { size: 14 })}
                </button>
              </div>
            </nav>`
          : rows.length > 0
            ? html`<div class="pa-pagination"><span>${formatNumber(rows.length)} ${rows.length === 1 ? "record" : "records"}</span></div>`
            : ""}`,
    );
  }

  const offs = [
    on(container, "click", "[data-sort]", (_e, btn) => {
      const key = btn.dataset.sort;
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      render();
    }),
    on(container, "click", "[data-page]", (_e, btn) => {
      state.page += btn.dataset.page === "next" ? 1 : -1;
      render();
      container.querySelector(".pa-table-wrap")?.scrollIntoView({ block: "nearest" });
    }),
  ];

  if (onRowClick) {
    const findRow = (tr) => state.rows.find((r) => String(r[rowKey]) === tr.dataset.key);
    offs.push(
      on(container, "click", "tr.is-clickable", (e, tr) => {
        if (e.target.closest("button, a, input, select, label")) return;
        const row = findRow(tr);
        if (row) onRowClick(row);
      }),
      on(container, "keydown", "tr.is-clickable", (e, tr) => {
        if (e.key !== "Enter" || e.target !== tr) return;
        const row = findRow(tr);
        if (row) onRowClick(row);
      }),
    );
  }

  render();

  return {
    setRows(rows) {
      state.rows = rows || [];
      render();
    },
    setSearch(term) {
      state.search = String(term || "").trim();
      state.page = 1;
      render();
    },
    setFilter(fn) {
      state.filter = fn;
      state.page = 1;
      render();
    },
    getVisibleRows: visibleRows,
    destroy() {
      offs.forEach((off) => off());
    },
  };
}
