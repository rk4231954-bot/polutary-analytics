/**
 * Analytics read endpoints. In the real system these are answered by HiveQL
 * queries executed on Apache Hive by the Flask API (stage 9).
 *
 * GET /analytics/summary?farm_id&days        → Summary
 * GET /analytics/daily?farm_id&days           → { records: FarmDailyRecord[] }
 * GET /analytics/growth?farm_id&batch_id      → { batches: [{ batchId, code, farmName, poultryType, points: [{ ageDays, avgWeightG }] }] }
 * GET /analytics/farm-comparison?days         → { farms: [{ farmId, farmName, mortalityRatePct, avgWeightG, feedPerBirdKg, birdCount }] }
 * GET /alerts?limit                           → { alerts: Alert[] }
 * GET /activity?limit                         → { activity: Activity[] }
 *
 * Summary: { totalFarms, activeBatches, totalBirds, feedKg, mortalityRatePct, avgWeightG,
 *            trends: { feedKg, mortalityRatePct } (percent change vs previous period), from, to }
 * FarmDailyRecord: { date, farmId, farmName, temperatureC, humidityPct, birdCount, feedKg, mortality, avgWeightG }
 * Alert: { id, type: "temperature"|"humidity"|"mortality"|"feed", severity: "warning"|"danger", title, message, farmId, farmName, createdAt }
 * Activity: { id, type: "upload"|"farm"|"prediction"|"user", message, actor, createdAt }
 */
import { api } from "./apiClient.js";
import { readWithPreview } from "./dataSource.js";
import { sampleActivity, sampleAlerts, sampleBatches, sampleFarmDaily, sampleFarms } from "./sample/core.js";

const matchesFarm = (farmId) => (row) => !farmId || String(row.farmId) === String(farmId);

function lastDays(records, days, offset = 0) {
  const dates = [...new Set(records.map((r) => r.date))].sort();
  const end = dates.length - offset;
  const window = new Set(dates.slice(Math.max(0, end - days), end));
  return records.filter((r) => window.has(r.date));
}

const pctChange = (current, previous) => (previous ? ((current - previous) / previous) * 100 : null);

function sampleSummary({ farmId, days = 30 }) {
  const daily = sampleFarmDaily.filter(matchesFarm(farmId));
  const current = lastDays(daily, days);
  const previous = lastDays(daily, days, days);
  const active = sampleBatches.filter((b) => b.status === "active" && matchesFarm(farmId)(b));
  const totalBirds = active.reduce((s, b) => s + b.birdCount, 0);
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  /** Deaths as a percentage of the average live population over the period. */
  const mortalityRate = (rows) => {
    const deaths = sum(rows, "mortality");
    const dates = new Set(rows.map((r) => r.date));
    const avgBirds = dates.size ? sum(rows, "birdCount") / dates.size : 0;
    return avgBirds ? (deaths / avgBirds) * 100 : null;
  };
  const weighted = active.reduce((s, b) => s + (b.avgWeightG || 0) * b.birdCount, 0);
  const feedKg = sum(current, "feedKg");
  const mortalityRatePct = mortalityRate(current);
  return {
    totalFarms: sampleFarms.filter(matchesFarm(farmId)).length,
    activeBatches: active.length,
    totalBirds,
    feedKg,
    mortalityRatePct,
    avgWeightG: totalBirds ? weighted / totalBirds : null,
    trends: {
      feedKg: pctChange(feedKg, sum(previous, "feedKg")),
      mortalityRatePct: pctChange(mortalityRatePct, mortalityRate(previous)),
    },
    from: current[0]?.date ?? null,
    to: current[current.length - 1]?.date ?? null,
  };
}

function sampleGrowth({ farmId, batchId }) {
  return sampleBatches
    .filter((b) => b.status !== "planned" && matchesFarm(farmId)(b) && (!batchId || String(b.id) === String(batchId)))
    .map((b) => ({
      batchId: b.id,
      code: b.code,
      farmName: b.farmName,
      poultryType: b.poultryType,
      points: b.daily.map((d) => ({ ageDays: d.ageDays, avgWeightG: d.avgWeightG })),
    }));
}

function sampleComparison({ days = 30 }) {
  return sampleFarms.map((farm) => {
    const rows = lastDays(sampleFarmDaily.filter(matchesFarm(farm.id)), days);
    const deaths = rows.reduce((s, r) => s + r.mortality, 0);
    const startBirds = rows[0]?.birdCount || 0;
    const feed = rows.reduce((s, r) => s + r.feedKg, 0);
    const last = rows[rows.length - 1];
    return {
      farmId: farm.id,
      farmName: farm.name,
      mortalityRatePct: startBirds ? (deaths / startBirds) * 100 : null,
      avgWeightG: last?.avgWeightG ?? null,
      feedPerBirdKg: last?.birdCount ? feed / last.birdCount : null,
      birdCount: last?.birdCount ?? 0,
    };
  });
}

export const getSummary = ({ farmId, days = 30 } = {}) =>
  readWithPreview(() => api.get("/analytics/summary", { query: { farm_id: farmId, days } }), () => sampleSummary({ farmId, days }));

export const getDailyRecords = ({ farmId, days = 30 } = {}) =>
  readWithPreview(
    async () => (await api.get("/analytics/daily", { query: { farm_id: farmId, days } })).records,
    () => lastDays(sampleFarmDaily.filter(matchesFarm(farmId)), days),
  );

export const getGrowthCurves = ({ farmId, batchId } = {}) =>
  readWithPreview(
    async () => (await api.get("/analytics/growth", { query: { farm_id: farmId, batch_id: batchId } })).batches,
    () => sampleGrowth({ farmId, batchId }),
  );

export const getFarmComparison = ({ days = 30 } = {}) =>
  readWithPreview(
    async () => (await api.get("/analytics/farm-comparison", { query: { days } })).farms,
    () => sampleComparison({ days }),
  );

export const getAlerts = ({ farmId, limit = 10 } = {}) =>
  readWithPreview(
    async () => (await api.get("/alerts", { query: { farm_id: farmId, limit } })).alerts,
    () => sampleAlerts.filter(matchesFarm(farmId)).slice(0, limit),
  );

export const getActivity = ({ limit = 10 } = {}) =>
  readWithPreview(async () => (await api.get("/activity", { query: { limit } })).activity, () => sampleActivity.slice(0, limit));
