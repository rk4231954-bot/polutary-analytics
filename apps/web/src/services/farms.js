/**
 * Farms.
 * GET    /farms            → { farms: Farm[] }
 * GET    /farms/:id        → { farm: Farm }
 * POST   /farms            { code, name, location, capacity, status, housingType, manager } → { farm }
 * PUT    /farms/:id        (same body) → { farm }
 * DELETE /farms/:id        → 204
 * Farm: { id, code, name, location, capacity, status: "active"|"inactive"|"maintenance", housingType,
 *         manager, activeBatches, totalBatches, birdCount, createdAt }
 */
import { api } from "./apiClient.js";
import { readWithPreview } from "./dataSource.js";
import { sampleFarmsWithStats } from "./sample/core.js";

export const listFarms = () => readWithPreview(async () => (await api.get("/farms")).farms, sampleFarmsWithStats);

export const getFarm = (id) =>
  readWithPreview(
    async () => (await api.get(`/farms/${encodeURIComponent(id)}`)).farm,
    () => {
      const farm = sampleFarmsWithStats().find((f) => String(f.id) === String(id));
      if (!farm) throw Object.assign(new Error("Farm not found."), { isNotFound: true, status: 404 });
      return farm;
    },
  );

// Writes always go to the real API.
export const createFarm = (farm) => api.post("/farms", farm);
export const updateFarm = (id, farm) => api.put(`/farms/${encodeURIComponent(id)}`, farm);
export const deleteFarm = (id) => api.delete(`/farms/${encodeURIComponent(id)}`);
