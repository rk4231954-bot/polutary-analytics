/**
 * Poultry batches (flocks).
 * GET    /batches?farm_id&status → { batches: Batch[] }
 * GET    /batches/:id            → { batch: Batch & { daily: DailyBatchRecord[] } }
 * POST   /batches                { code, farmId, poultryType, breed, initialCount, startDate, status } → { batch }
 * PUT    /batches/:id            (same body) → { batch }
 * DELETE /batches/:id            → 204
 * Batch: { id, code, farmId, farmName, poultryType: "Broiler"|"Layer"|"Breeder", breed, initialCount, birdCount,
 *          ageDays, startDate, endDate, avgWeightG, status: "planned"|"active"|"completed" }
 * DailyBatchRecord: { date, ageDays, birdCount, mortality, avgWeightG, feedKg }
 */
import { api } from "./apiClient.js";
import { readWithPreview } from "./dataSource.js";
import { sampleBatches } from "./sample/core.js";

const summary = ({ daily, ...batch }) => batch;

export const listBatches = ({ farmId, status } = {}) =>
  readWithPreview(
    async () => (await api.get("/batches", { query: { farm_id: farmId, status } })).batches,
    () =>
      sampleBatches
        .filter((b) => (!farmId || String(b.farmId) === String(farmId)) && (!status || b.status === status))
        .map(summary),
  );

export const getBatch = (id) =>
  readWithPreview(
    async () => (await api.get(`/batches/${encodeURIComponent(id)}`)).batch,
    () => {
      const batch = sampleBatches.find((b) => String(b.id) === String(id));
      if (!batch) throw Object.assign(new Error("Batch not found."), { isNotFound: true, status: 404 });
      return batch;
    },
  );

export const createBatch = (batch) => api.post("/batches", batch);
export const updateBatch = (id, batch) => api.put(`/batches/${encodeURIComponent(id)}`, batch);
export const deleteBatch = (id) => api.delete(`/batches/${encodeURIComponent(id)}`);
