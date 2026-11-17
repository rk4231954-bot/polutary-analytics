/**
 * Modal dialogs built on Bootstrap's Modal.
 *
 * openFormModal: a modal wrapping a <form>. onSubmit(form, modal) may be async;
 * the submit button shows a spinner while it runs. Return `false` to keep the
 * modal open (e.g. validation failed); anything else closes it.
 */
import { Modal } from "bootstrap";
import { html, setHtml, uid } from "../utils/dom.js";
import { icon } from "./icons.js";

function mount(markup) {
  const wrapper = document.createElement("div");
  setHtml(wrapper, markup);
  const el = wrapper.firstElementChild;
  document.body.appendChild(el);
  return el;
}

export function setButtonLoading(button, loading, loadingLabel) {
  if (!button) return;
  if (loading) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setHtml(button, html`${icon("loader", { size: 14, className: "pa-spin" })}<span>${loadingLabel || "Working…"}</span>`);
  } else {
    if (button.dataset.label !== undefined) button.innerHTML = button.dataset.label;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

/**
 * @param {{
 *   title: string, subtitle?: string, body: any, size?: "sm"|"lg"|"xl",
 *   submitLabel?: string, cancelLabel?: string, danger?: boolean,
 *   onSubmit?: (form: HTMLFormElement, ctx: {close: () => void}) => any,
 *   onOpen?: (el: HTMLElement) => void, hideFooter?: boolean, footerNote?: any
 * }} options
 */
export function openFormModal(options) {
  const {
    title, subtitle, body, size, submitLabel = "Save", cancelLabel = "Cancel", danger = false,
    onSubmit, onOpen, hideFooter = false, footerNote,
  } = options;
  const id = uid("modal");
  const el = mount(html`
    <div class="modal fade" id="${id}" tabindex="-1" aria-labelledby="${id}-title" aria-modal="true" role="dialog">
      <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ${size ? `modal-${size}` : ""}">
        <form class="modal-content" novalidate>
          <div class="modal-header">
            <div>
              <h2 class="modal-title" id="${id}-title">${title}</h2>
              ${subtitle ? html`<div class="pa-modal-subtitle">${subtitle}</div>` : ""}
            </div>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">${body}</div>
          ${hideFooter
            ? ""
            : html`<div class="modal-footer">
                ${footerNote ? html`<div class="me-auto pa-text-xs pa-text-2">${footerNote}</div>` : ""}
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">${cancelLabel}</button>
                ${onSubmit
                  ? html`<button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${submitLabel}</button>`
                  : ""}
              </div>`}
        </form>
      </div>
    </div>`);

  const modal = new Modal(el);
  const form = el.querySelector("form");
  const close = () => modal.hide();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const button = form.querySelector('button[type="submit"]');
    setButtonLoading(button, true, "Saving…");
    try {
      const result = await onSubmit(form, { close });
      if (result !== false) close();
    } finally {
      if (el.isConnected) setButtonLoading(button, false);
    }
  });
  el.addEventListener("shown.bs.modal", () => {
    form.querySelector("input:not([type=hidden]):not([disabled]), select, textarea")?.focus();
  });
  el.addEventListener("hidden.bs.modal", () => {
    modal.dispose();
    el.remove();
  });
  onOpen?.(el);
  modal.show();
  return { el, form, close };
}

/**
 * Confirmation dialog. Resolves true when confirmed.
 * @param {{title: string, message: any, confirmLabel?: string, danger?: boolean}} options
 */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const { el } = openFormModal({
      title,
      size: "sm",
      body: html`<div class="d-flex gap-3">
        <span class="pa-list-item__icon ${danger ? "pa-list-item__icon--danger" : "pa-list-item__icon--warning"}">
          ${icon("alert-triangle", { size: 16 })}
        </span>
        <p class="mb-0 pa-text-2">${message}</p>
      </div>`,
      submitLabel: confirmLabel,
      danger,
      onSubmit: () => {
        confirmed = true;
      },
    });
    el.addEventListener("hidden.bs.modal", () => resolve(confirmed), { once: true });
  });
}
