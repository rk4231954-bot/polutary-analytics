/**
 * Manual data collection (daily readings entered by farm staff).
 * GET  /readings?farm_id&batch_id&limit → { readings: Reading[] }
 * POST /readings { batchId, date, temperatureC, humidityPct, feedKg, waterL, mortality, avgWeightG, notes } → { reading }
 * Reading: { id, batchId, batchCode, farmId, farmName, date, temperatureC, humidityPct, feedKg, waterL,
 *            mortality, avgWeightG, notes, recordedBy, createdAt }
 */
import { api } from "./apiClient.js";
import { readWithPreview } from "./dataSource.js";
import { sampleBatches, sampleFarmDaily } from "./sample/core.js";

function sampleReadings({ farmId, batchId } = {}) {
  const rows = [];
  for (const b of sampleBatches) {
    if (b.status !== "active") continue;
    if (farmId && String(b.farmId) !== String(farmId)) continue;
    if (batchId && String(b.id) !== String(batchId)) continue;
    for (const d of b.daily.slice(-14)) {
      const env = sampleFarmDaily.find((r) => r.farmId === b.farmId && r.date === d.date);
      rows.push({
        id: `${b.id}-${d.date}`,
        batchId: b.id,
        batchCode: b.code,
        farmId: b.farmId,
        farmName: b.farmName,
        date: d.date,
        temperatureC: env?.temperatureC ?? null,
        humidityPct: env?.humidityPct ?? null,
        feedKg: d.feedKg,
        waterL: null,
        mortality: d.mortality,
        avgWeightG: d.avgWeightG,
        notes: "",
        recordedBy: "Sample Manager",
      });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export const listReadings = (params = {}) =>
  readWithPreview(
    async () => (await api.get("/readings", { query: { farm_id: params.farmId, batch_id: params.batchId, limit: params.limit } })).readings,
    () => sampleReadings(params),
  );

export const createReading = (reading) => api.post("/readings", reading);
