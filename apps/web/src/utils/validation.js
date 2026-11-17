/**
 * Lightweight declarative form validation with Bootstrap feedback styling.
 *
 * rules: { fieldName: [validator, ...] } where a validator is
 *   (value, formValues) => string | null   (string = error message)
 */
export const rules = {
  required: (label = "This field") => (v) => (String(v ?? "").trim() === "" ? `${label} is required.` : null),
  email: () => (v) =>
    v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? "Enter a valid email address." : null,
  minLength: (n, label = "This field") => (v) =>
    v && String(v).length < n ? `${label} must be at least ${n} characters.` : null,
  maxLength: (n, label = "This field") => (v) =>
    v && String(v).length > n ? `${label} must be at most ${n} characters.` : null,
  number: ({ min, max, integer = false, label = "Value" } = {}) => (v) => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return `${label} must be a number.`;
    if (integer && !Number.isInteger(n)) return `${label} must be a whole number.`;
    if (min !== undefined && n < min) return `${label} must be at least ${min}.`;
    if (max !== undefined && n > max) return `${label} must be at most ${max}.`;
    return null;
  },
  date: ({ notFuture = false, label = "Date" } = {}) => (v) => {
    if (!v) return null;
    const d = new Date(`${v}T00:00:00`);
    if (Number.isNaN(d.getTime())) return `${label} is not a valid date.`;
    if (notFuture && d.getTime() > Date.now()) return `${label} cannot be in the future.`;
    return null;
  },
  matches: (otherField, message) => (v, values) => (v !== values[otherField] ? message : null),
  pattern: (regex, message) => (v) => (v && !regex.test(String(v)) ? message : null),
  /** At least 8 chars incl. a letter and a number. Server-side policy is authoritative. */
  password: () => (v) =>
    v && !(String(v).length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v))
      ? "Use at least 8 characters, including a letter and a number."
      : null,
};

export function getFormValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") values[el.name] = el.checked;
    else if (el.type === "radio") {
      if (el.checked) values[el.name] = el.value;
    } else values[el.name] = el.value.trim ? el.value.trim() : el.value;
  }
  return values;
}

function feedbackFor(field) {
  const container = field.closest(".pa-field") || field.parentElement;
  let fb = container.querySelector(":scope > .invalid-feedback");
  if (!fb) {
    fb = document.createElement("div");
    fb.className = "invalid-feedback";
    container.appendChild(fb);
  }
  if (!fb.id) fb.id = `${field.id || field.name}-error`;
  return fb;
}

export function setFieldError(form, name, message) {
  const field = form.elements.namedItem(name);
  if (!field || !(field instanceof HTMLElement)) return;
  const fb = feedbackFor(field);
  if (message) {
    field.classList.add("is-invalid");
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", fb.id);
    fb.textContent = message;
  } else {
    field.classList.remove("is-invalid");
    field.removeAttribute("aria-invalid");
    fb.textContent = "";
  }
}

/** Validates and decorates the form. Returns { valid, values, errors }. */
export function validateForm(form, fieldRules) {
  const values = getFormValues(form);
  const errors = {};
  for (const [name, validators] of Object.entries(fieldRules)) {
    for (const validate of validators) {
      const message = validate(values[name], values);
      if (message) {
        errors[name] = message;
        break;
      }
    }
    setFieldError(form, name, errors[name] || null);
  }
  const firstInvalid = Object.keys(errors)[0];
  if (firstInvalid) form.elements.namedItem(firstInvalid)?.focus?.();
  return { valid: Object.keys(errors).length === 0, values, errors };
}

/** Applies server-side field errors ({ field: message }) returned by the API. */
export function applyServerErrors(form, fieldErrors = {}) {
  for (const [name, message] of Object.entries(fieldErrors)) setFieldError(form, name, message);
}

/** Re-validates a field as the user edits it, once it has been marked invalid. */
export function liveValidate(form, fieldRules) {
  const handler = (e) => {
    const name = e.target.name;
    if (!name || !fieldRules[name] || !e.target.classList.contains("is-invalid")) return;
    const values = getFormValues(form);
    const message = fieldRules[name].map((v) => v(values[name], values)).find(Boolean) || null;
    setFieldError(form, name, message);
  };
  form.addEventListener("input", handler);
  form.addEventListener("change", handler);
}
