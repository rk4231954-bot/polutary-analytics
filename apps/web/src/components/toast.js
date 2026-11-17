/** Toast notifications. toast.success("Saved", "Farm created.") etc. */
import { html, setHtml } from "../utils/dom.js";
import { icon } from "./icons.js";

const ICON_BY_TYPE = { success: "circle-check", error: "x-circle", warning: "alert-triangle", info: "info" };

function region() {
  let el = document.getElementById("pa-toast-region");
  if (!el) {
    el = document.createElement("div");
    el.id = "pa-toast-region";
    el.className = "pa-toast-region";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "false");
    document.body.appendChild(el);
  }
  return el;
}

function dismiss(el) {
  if (!el.isConnected || el.classList.contains("is-leaving")) return;
  el.classList.add("is-leaving");
  el.addEventListener("animationend", () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 400);
}

/**
 * @param {{type?: "success"|"error"|"warning"|"info", title: string, message?: string, duration?: number}} options
 */
export function showToast({ type = "info", title, message = "", duration = 5000 }) {
  const el = document.createElement("div");
  el.className = `pa-toast pa-toast--${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  setHtml(
    el,
    html`<span class="pa-toast__icon">${icon(ICON_BY_TYPE[type], { size: 18 })}</span>
      <div class="pa-toast__body">
        <div class="pa-toast__title">${title}</div>
        ${message ? html`<p class="pa-toast__message">${message}</p>` : ""}
      </div>
      <button type="button" class="btn btn-ghost btn-icon btn-sm pa-toast__close" aria-label="Dismiss notification">
        ${icon("x", { size: 14 })}
      </button>`,
  );
  el.querySelector("button").addEventListener("click", () => dismiss(el));
  region().appendChild(el);
  if (duration > 0) setTimeout(() => dismiss(el), duration);
  return () => dismiss(el);
}

export const toast = {
  success: (title, message) => showToast({ type: "success", title, message }),
  error: (title, message) => showToast({ type: "error", title, message, duration: 8000 }),
  warning: (title, message) => showToast({ type: "warning", title, message, duration: 7000 }),
  info: (title, message) => showToast({ type: "info", title, message }),
  /** Standard toast for a failed API call. */
  apiError: (error, title = "Request failed") => showToast({ type: "error", title, message: error?.message || String(error), duration: 8000 }),
};
