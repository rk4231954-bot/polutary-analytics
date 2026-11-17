/**
 * ============================================================================
 *  SAMPLE PREDICTION PREVIEW — ILLUSTRATIVE ONLY, NOT MODEL OUTPUT
 * ============================================================================
 * These values are NOT produced by any trained machine-learning model. They
 * are derived by simple arithmetic extrapolation (linear trend / recent mean)
 * of the illustrative sample series in ./core.js, purely so the Predictions
 * page layout can be reviewed before Stage 10 (model training) exists.
 *
 * Used only when config.demoMode is true. The UI labels every section with a
 * "Sample preview" badge and "Illustrative values — not produced by a trained
 * model", and modelName is always SAMPLE_MODEL_NAME below.
 * ============================================================================
 */
import { toIsoDate } from "../../utils/format.js";
import { sampleBatches, sampleFarmDaily } from "./core.js";

export const SAMPLE_MODEL_NAME = "Not trained yet (sample preview)";
const DAY = 86400000;
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

function findBatch(batchId) {
  const batch = sampleBatches.find((b) => String(b.id) === String(batchId));
  if (!batch) throw Object.assign(new Error("Batch not found."), { isNotFound: true, status: 404 });
  return batch;
}

/** Least-squares slope/intercept of y over index (simple extrapolation, not a model). */
function linearTrend(values) {
  const n = values.length;
  const xs = values.map((_, i) => i);
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = values.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (values[i] - my);
    den += (x - mx) ** 2;
  });
  const slope = den ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return toIsoDate(new Date(new Date(y, m - 1, d).getTime() + n * DAY));
}

const generatedAt = () => new Date().toISOString();

/**
 * Illustrative "risk" = how much the last 7 days' deaths exceed the previous 7 days,
 * mapped into 0–1. Feature weights are fixed illustrative numbers, not model importances.
 */
export function sampleMortalityRisk(batchId) {
  const b = findBatch(batchId);
  const last = b.daily.slice(-7).reduce((s, d) => s + d.mortality, 0);
  const prev = b.daily.slice(-14, -7).reduce((s, d) => s + d.mortality, 0);
  const ratio = prev > 0 ? last / prev : 1;
  const probability = Math.max(0.04, Math.min(0.95, 0.18 + (ratio - 1) * 0.35));
  return {
    probability: round(probability, 2),
    category: probability >= 0.6 ? "high" : probability >= 0.3 ? "medium" : "low",
    features: [
      { name: "7-day mortality trend", importance: 0.34 },
      { name: "Average house temperature", importance: 0.22 },
      { name: "Relative humidity", importance: 0.16 },
      { name: "Feed intake deviation", importance: 0.15 },
      { name: "Flock age", importance: 0.13 },
    ],
    generatedAt: generatedAt(),
    modelName: SAMPLE_MODEL_NAME,
    modelVersion: null,
  };
}

/** Extends the weight curve using the mean daily gain of the last 7 records. */
export function sampleGrowthForecast(batchId, horizonDays = 7) {
  const b = findBatch(batchId);
  const history = b.daily.map((d) => ({ ageDays: d.ageDays, avgWeightG: d.avgWeightG }));
  const tail = history.slice(-8);
  const gain = tail.length > 1 ? (tail.at(-1).avgWeightG - tail[0].avgWeightG) / (tail.length - 1) : 0;
  const last = history.at(-1);
  const forecast = last
    ? Array.from({ length: horizonDays }, (_, i) => ({ ageDays: last.ageDays + i + 1, avgWeightG: Math.round(last.avgWeightG + gain * (i + 1)) }))
    : [];
  return { history, forecast, modelName: SAMPLE_MODEL_NAME, generatedAt: generatedAt() };
}

/** Linear trend of the last 14 days of feed, extended forward. */
export function sampleFeedForecast(batchId, horizonDays = 7) {
  const b = findBatch(batchId);
  const history = b.daily.slice(-21).map((d) => ({ date: d.date, feedKg: d.feedKg }));
  const recent = history.slice(-14).map((h) => h.feedKg);
  const { slope, intercept } = recent.length ? linearTrend(recent) : { slope: 0, intercept: 0 };
  const lastDate = history.at(-1)?.date;
  const forecast = lastDate
    ? Array.from({ length: horizonDays }, (_, i) => ({ date: addDays(lastDate, i + 1), feedKg: round(Math.max(0, intercept + slope * (recent.length + i)), 1) }))
    : [];
  return {
    history,
    forecast,
    totalForecastKg: round(forecast.reduce((s, f) => s + f.feedKg, 0), 1),
    modelName: SAMPLE_MODEL_NAME,
    generatedAt: generatedAt(),
  };
}

/** Persistence baseline: each future day = mean of the last 7 days. */
export function sampleEnvironmentForecast(farmId, horizonDays = 7) {
  const rows = sampleFarmDaily.filter((r) => String(r.farmId) === String(farmId)).slice(-21);
  const history = rows.map((r) => ({ date: r.date, temperatureC: r.temperatureC, humidityPct: r.humidityPct }));
  const last7 = history.slice(-7);
  const avg = (k) => (last7.length ? last7.reduce((s, r) => s + r[k], 0) / last7.length : null);
  const lastDate = history.at(-1)?.date;
  const forecast = lastDate
    ? Array.from({ length: horizonDays }, (_, i) => ({ date: addDays(lastDate, i + 1), temperatureC: round(avg("temperatureC"), 1), humidityPct: round(avg("humidityPct"), 1) }))
    : [];
  return { history, forecast, modelName: SAMPLE_MODEL_NAME, generatedAt: generatedAt() };
}
