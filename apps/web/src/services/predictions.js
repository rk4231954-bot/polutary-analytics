/**
 * Machine-learning predictions (decision support only — never a diagnosis).
 *
 * GET  /predictions/mortality-risk?batch_id
 *      → { probability: 0..1, category: "low"|"medium"|"high", features: [{ name, importance }],
 *          generatedAt, modelName, modelVersion }
 * GET  /predictions/growth?batch_id&horizon_days
 *      → { history: [{ ageDays, avgWeightG }], forecast: [{ ageDays, avgWeightG, lower?, upper? }], modelName, generatedAt }
 * GET  /predictions/feed?batch_id&horizon_days
 *      → { history: [{ date, feedKg }], forecast: [{ date, feedKg }], totalForecastKg, modelName, generatedAt }
 * GET  /predictions/environment?farm_id&horizon_days
 *      → { history: [{ date, temperatureC, humidityPct }], forecast: [{ date, temperatureC, humidityPct }], modelName, generatedAt }
 * POST /predictions { batchId, type: "all"|"mortality-risk"|"growth"|"feed"|"environment" } → { jobId?, status }
 *
 * Preview mode returns illustrative extrapolations from sample/predictions.js
 * (labelled in the UI) — never presented as model output.
 */
import { api } from "./apiClient.js";
import { readWithPreview } from "./dataSource.js";
import {
  sampleEnvironmentForecast, sampleFeedForecast, sampleGrowthForecast, sampleMortalityRisk,
} from "./sample/predictions.js";

export const getMortalityRisk = ({ batchId }) =>
  readWithPreview(() => api.get("/predictions/mortality-risk", { query: { batch_id: batchId } }), () => sampleMortalityRisk(batchId));

export const getGrowthForecast = ({ batchId, horizonDays = 7 }) =>
  readWithPreview(
    () => api.get("/predictions/growth", { query: { batch_id: batchId, horizon_days: horizonDays } }),
    () => sampleGrowthForecast(batchId, horizonDays),
  );

export const getFeedForecast = ({ batchId, horizonDays = 7 }) =>
  readWithPreview(
    () => api.get("/predictions/feed", { query: { batch_id: batchId, horizon_days: horizonDays } }),
    () => sampleFeedForecast(batchId, horizonDays),
  );

export const getEnvironmentForecast = ({ farmId, horizonDays = 7 }) =>
  readWithPreview(
    () => api.get("/predictions/environment", { query: { farm_id: farmId, horizon_days: horizonDays } }),
    () => sampleEnvironmentForecast(farmId, horizonDays),
  );

/** Requests new predictions from the real API (always — no preview fallback). */
export const generatePrediction = ({ batchId, type = "all" }) => api.post("/predictions", { batchId, type });
