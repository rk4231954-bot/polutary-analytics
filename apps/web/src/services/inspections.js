/**
 * Health inspection observations for a batch (recorded by veterinary users or administrators).
 * GET  /batches/:id/inspections → { inspections: [{ id, observedOn, healthStatus, observation, inspector, createdAt }] }
 * POST /batches/:id/inspections { observedOn, healthStatus: "normal"|"attention"|"critical", observation } → { inspection }
 * Real records only: there is no sample data for inspections.
 */
import { api } from "./apiClient.js";

export const listInspections = async (batchId) =>
  (await api.get(`/batches/${encodeURIComponent(batchId)}/inspections`)).inspections;
export const recordInspection = (batchId, inspection) =>
  api.post(`/batches/${encodeURIComponent(batchId)}/inspections`, inspection);
