/** Password input with an accessible show/hide toggle (used by login, register, settings). */
import { html, on, setHtml } from "../utils/dom.js";
import { icon } from "./icons.js";
import "../styles/pages/password.css";

export function passwordField({ name, label, autocomplete, id, hint, help }) {
  return html`<div class="pa-field mb-3">
    <div class="d-flex justify-content-between align-items-baseline gap-2">
      <label class="form-label" for="${id}">${label}</label>
      ${hint || ""}
    </div>
    <div class="pa-password">
      <input class="form-control" type="password" id="${id}" name="${name}" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="off" />
      <button type="button" class="pa-password__toggle" data-toggle-password="${id}" aria-label="Show password" aria-pressed="false" aria-controls="${id}">
        ${icon("eye", { size: 16 })}
      </button>
    </div>
    ${help ? html`<div class="form-text">${help}</div>` : ""}
  </div>`;
}

/** Wires every [data-toggle-password] button inside root. Returns an unsubscribe function. */
export function bindPasswordToggles(root) {
  return on(root, "click", "[data-toggle-password]", (_e, btn) => {
    const input = root.querySelector(`#${btn.dataset.togglePassword}`);
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", String(show));
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    setHtml(btn, icon(show ? "eye-off" : "eye", { size: 16 }));
  });
}

/** Live checklist of password requirements (mirrors rules.password; the server policy is authoritative). */
export const PASSWORD_REQUIREMENTS = [
  { id: "length", label: "At least 8 characters", test: (v) => v.length >= 8 },
  { id: "letter", label: "Contains a letter", test: (v) => /[A-Za-z]/.test(v) },
  { id: "number", label: "Contains a number", test: (v) => /\d/.test(v) },
];

export function passwordChecklist(id) {
  return html`<ul class="pa-pw-checklist" id="${id}" aria-live="polite">
    ${PASSWORD_REQUIREMENTS.map((r) => html`<li data-req="${r.id}">${icon("check", { size: 12 })}<span>${r.label}</span></li>`)}
  </ul>`;
}

export function bindPasswordChecklist(input, list) {
  const update = () => {
    for (const r of PASSWORD_REQUIREMENTS) {
      const li = list.querySelector(`[data-req="${r.id}"]`);
      const met = r.test(input.value);
      li.classList.toggle("is-met", met);
      li.setAttribute("aria-label", `${r.label}: ${met ? "met" : "not met"}`);
    }
  };
  input.addEventListener("input", update);
  update();
  return () => input.removeEventListener("input", update);
}
