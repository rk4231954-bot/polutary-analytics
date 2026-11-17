/**
 * Farm and batch create/edit modals and delete confirmations, shared by the
 * farm management pages. Every save goes to the real API; failures are shown
 * honestly (toast + field errors) and never reported as success.
 */
import { config } from "../config.js";
import { createBatch, deleteBatch, updateBatch } from "../services/batches.js";
import { createFarm, deleteFarm, updateFarm } from "../services/farms.js";
import { html } from "../utils/dom.js";
import { toIsoDate } from "../utils/format.js";
import { applyServerErrors, liveValidate, rules, validateForm } from "../utils/validation.js";
import { confirmDialog, openFormModal } from "./modal.js";
import { toast } from "./toast.js";
import { selectOptions } from "./ui.js";

export const FARM_STATUSES = [
  { value: "active", label: "Active" },
  { value: "maintenance", label: "Maintenance" },
  { value: "inactive", label: "Inactive" },
];
export const HOUSING_TYPES = ["Closed house", "Open-sided house", "Free range", "Other"].map((v) => ({ value: v, label: v }));
export const POULTRY_TYPES = ["Broiler", "Layer", "Breeder"].map((v) => ({ value: v, label: v }));
export const BATCH_STATUSES = [
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
];

const footerNote = () => (config.demoMode ? "Saving requires the Flask API." : "");

function field({ name, label, required = false, input, hint, col = "col-12" }) {
  return html`<div class="${col} pa-field">
    <label class="form-label ${required ? "pa-required" : ""}" for="f-${name}">${label}</label>
    ${input}
    ${hint ? html`<div class="form-text">${hint}</div>` : ""}
    <div class="invalid-feedback" id="f-${name}-error"></div>
  </div>`;
}

const textInput = (name, value, attrs = {}) =>
  html`<input class="form-control" id="f-${name}" name="${name}" type="${attrs.type || "text"}" value="${value ?? ""}"
    ${attrs.placeholder ? html`placeholder="${attrs.placeholder}"` : ""} ${attrs.min !== undefined ? html`min="${attrs.min}"` : ""}
    ${attrs.max !== undefined ? html`max="${attrs.max}"` : ""} ${attrs.step ? html`step="${attrs.step}"` : ""}
    ${attrs.inputmode ? html`inputmode="${attrs.inputmode}"` : ""} autocomplete="off" />`;

const selectInput = (name, options, selected, placeholder) =>
  html`<select class="form-select" id="f-${name}" name="${name}">
    ${placeholder ? html`<option value="">${placeholder}</option>` : ""}${selectOptions(options, selected)}
  </select>`;

/** Runs an API save and maps errors onto the form. Returns false to keep the modal open. */
async function save(form, action, { successTitle, successMessage, errorTitle, onSaved }) {
  try {
    const result = await action();
    toast.success(successTitle, successMessage);
    onSaved?.(result);
    return true;
  } catch (error) {
    applyServerErrors(form, error.fields);
    toast.apiError(error, errorTitle);
    return false;
  }
}

// --- Farms -------------------------------------------------------------------
const farmRules = {
  code: [rules.required("Farm code"), rules.pattern(/^[A-Za-z0-9-]{2,20}$/, "Use 2–20 letters, numbers or hyphens.")],
  name: [rules.required("Farm name"), rules.maxLength(120, "Farm name")],
  location: [rules.required("Location"), rules.maxLength(160, "Location")],
  capacity: [rules.required("Capacity"), rules.number({ min: 1, max: 1000000, integer: true, label: "Capacity" })],
  housingType: [rules.required("Housing type")],
  manager: [rules.maxLength(120, "Manager name")],
  status: [rules.required("Status")],
};

/** @param {{farm?: object, onSaved?: (result) => void}} options */
export function openFarmModal({ farm, onSaved } = {}) {
  const editing = Boolean(farm);
  openFormModal({
    title: editing ? "Edit farm" : "Add farm",
    subtitle: editing ? `${farm.name} · ${farm.code}` : "Register a farm to start tracking batches and readings.",
    size: "lg",
    submitLabel: editing ? "Save changes" : "Add farm",
    footerNote: footerNote(),
    body: html`<div class="row g-3">
      ${field({ name: "name", label: "Farm name", required: true, col: "col-md-8", input: textInput("name", farm?.name, { placeholder: "e.g. Greenfield Poultry Unit" }) })}
      ${field({ name: "code", label: "Farm code", required: true, col: "col-md-4", input: textInput("code", farm?.code, { placeholder: "e.g. F-001" }) })}
      ${field({ name: "location", label: "Location", required: true, col: "col-md-8", input: textInput("location", farm?.location, { placeholder: "District, region" }) })}
      ${field({ name: "capacity", label: "Bird capacity", required: true, col: "col-md-4", input: textInput("capacity", farm?.capacity, { type: "number", min: 1, step: 1, inputmode: "numeric" }) })}
      ${field({ name: "housingType", label: "Housing type", required: true, col: "col-md-6", input: selectInput("housingType", HOUSING_TYPES, farm?.housingType, "Select housing type") })}
      ${field({ name: "status", label: "Status", required: true, col: "col-md-6", input: selectInput("status", FARM_STATUSES, farm?.status || "active") })}
      ${field({ name: "manager", label: "Farm manager", col: "col-12", input: textInput("manager", farm?.manager, { placeholder: "Name of the responsible manager" }), hint: "Optional. Account access is managed under Users & Roles." })}
    </div>`,
    onOpen: (el) => liveValidate(el.querySelector("form"), farmRules),
    onSubmit: (form) => {
      const { valid, values } = validateForm(form, farmRules);
      if (!valid) return false;
      const payload = { ...values, capacity: Number(values.capacity), manager: values.manager || null };
      return save(form, () => (editing ? updateFarm(farm.id, payload) : createFarm(payload)), {
        successTitle: editing ? "Farm updated" : "Farm added",
        successMessage: `${payload.name} was saved.`,
        errorTitle: "Could not save farm",
        onSaved,
      });
    },
  });
}

export async function confirmDeleteFarm(farm) {
  const ok = await confirmDialog({
    title: "Delete farm?",
    message: `“${farm.name}” and its batch records will be removed. This cannot be undone.`,
    confirmLabel: "Delete farm",
    danger: true,
  });
  if (!ok) return false;
  try {
    await deleteFarm(farm.id);
    toast.success("Farm deleted", `${farm.name} was removed.`);
    return true;
  } catch (error) {
    toast.apiError(error, "Could not delete farm");
    return false;
  }
}

// --- Batches -----------------------------------------------------------------
const batchRules = {
  code: [rules.required("Batch ID"), rules.pattern(/^[A-Za-z0-9-]{2,20}$/, "Use 2–20 letters, numbers or hyphens.")],
  farmId: [rules.required("Farm")],
  poultryType: [rules.required("Poultry type")],
  breed: [rules.maxLength(80, "Breed / strain")],
  initialCount: [rules.required("Initial bird count"), rules.number({ min: 1, max: 200000, integer: true, label: "Initial bird count" })],
  startDate: [
    rules.required("Start date"),
    rules.date({ label: "Start date" }),
    (v, values) =>
      v && values.status !== "planned" && v > toIsoDate(new Date()) ? "Only planned batches can start in the future." : null,
  ],
  status: [rules.required("Status")],
};

/** @param {{batch?: object, farms: Array, farmId?: string|number, onSaved?: (result) => void}} options */
export function openBatchModal({ batch, farms = [], farmId, onSaved } = {}) {
  const editing = Boolean(batch);
  const farmOptions = farms.map((f) => ({ value: f.id, label: f.name }));
  openFormModal({
    title: editing ? "Edit batch" : "Add poultry batch",
    subtitle: editing ? `${batch.code} · ${batch.farmName}` : "Start tracking a new flock.",
    size: "lg",
    submitLabel: editing ? "Save changes" : "Add batch",
    footerNote: footerNote(),
    body: html`<div class="row g-3">
      ${field({ name: "code", label: "Batch ID", required: true, col: "col-md-4", input: textInput("code", batch?.code, { placeholder: "e.g. B-2026-07" }) })}
      ${field({
        name: "farmId",
        label: "Farm",
        required: true,
        col: "col-md-8",
        input: selectInput("farmId", farmOptions, batch?.farmId ?? farmId, farmOptions.length ? "Select a farm" : "No farms available"),
        hint: farmOptions.length ? "" : "Add a farm first, or check the API connection.",
      })}
      ${field({ name: "poultryType", label: "Poultry type", required: true, col: "col-md-4", input: selectInput("poultryType", POULTRY_TYPES, batch?.poultryType || "Broiler") })}
      ${field({ name: "breed", label: "Breed / strain", col: "col-md-8", input: textInput("breed", batch?.breed, { placeholder: "Optional" }) })}
      ${field({ name: "initialCount", label: "Initial bird count", required: true, col: "col-md-4", input: textInput("initialCount", batch?.initialCount, { type: "number", min: 1, step: 1, inputmode: "numeric" }) })}
      ${field({ name: "startDate", label: "Start (placement) date", required: true, col: "col-md-4", input: textInput("startDate", batch?.startDate || toIsoDate(new Date()), { type: "date" }) })}
      ${field({ name: "status", label: "Status", required: true, col: "col-md-4", input: selectInput("status", BATCH_STATUSES, batch?.status || "active") })}
    </div>`,
    onOpen: (el) => liveValidate(el.querySelector("form"), batchRules),
    onSubmit: (form) => {
      const { valid, values } = validateForm(form, batchRules);
      if (!valid) return false;
      const payload = { ...values, farmId: Number(values.farmId), initialCount: Number(values.initialCount), breed: values.breed || null };
      return save(form, () => (editing ? updateBatch(batch.id, payload) : createBatch(payload)), {
        successTitle: editing ? "Batch updated" : "Batch added",
        successMessage: `${payload.code} was saved.`,
        errorTitle: "Could not save batch",
        onSaved,
      });
    },
  });
}

export async function confirmDeleteBatch(batch) {
  const ok = await confirmDialog({
    title: "Delete batch?",
    message: `Batch “${batch.code}” and its daily records will be removed. This cannot be undone.`,
    confirmLabel: "Delete batch",
    danger: true,
  });
  if (!ok) return false;
  try {
    await deleteBatch(batch.id);
    toast.success("Batch deleted", `${batch.code} was removed.`);
    return true;
  } catch (error) {
    toast.apiError(error, "Could not delete batch");
    return false;
  }
}
