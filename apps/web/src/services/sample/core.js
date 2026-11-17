/**
 * ============================================================================
 *  SAMPLE DATA — FOR FRONTEND PREVIEW ONLY
 * ============================================================================
 * Everything in this file is ILLUSTRATIVE. It is generated deterministically
 * from a fixed seed so the interface can be reviewed before the Flask API
 * exists. It is NOT real farm data, NOT a documented dataset, and must never
 * be used for analysis, model training or reports.
 *
 * It is only used when config.demoMode is true, and every view that renders
 * it shows a "Sample data" badge. Farm names and locations are deliberately
 * labelled "Sample" so they cannot be mistaken for real farms.
 * ============================================================================
 */
import { toIsoDate } from "../../utils/format.js";

/** Small seeded PRNG (mulberry32) so sample data is stable between reloads. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const DAY = 86400000;
export const SAMPLE_HISTORY_DAYS = 120;

function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - n * DAY);
}

export const sampleFarms = [
  { id: 1, code: "SMP-F01", name: "Sample Farm — Greenfield", location: "District A (sample)", capacity: 24000, status: "active", manager: "Sample Manager 1", housingType: "Closed house", createdAt: toIsoDate(daysAgo(400)) },
  { id: 2, code: "SMP-F02", name: "Sample Farm — Riverside", location: "District B (sample)", capacity: 18000, status: "active", manager: "Sample Manager 2", housingType: "Open-sided house", createdAt: toIsoDate(daysAgo(320)) },
  { id: 3, code: "SMP-F03", name: "Sample Farm — Hilltop", location: "District C (sample)", capacity: 12000, status: "maintenance", manager: "Sample Manager 3", housingType: "Closed house", createdAt: toIsoDate(daysAgo(210)) },
];

/** Gompertz-shaped illustrative growth curve (grams by age in days). Not a breed standard. */
function illustrativeWeight(ageDays, variance = 1) {
  const wMax = 5000;
  const b = Math.log(wMax / 42);
  const k = 0.041;
  return wMax * Math.exp(-b * Math.exp(-k * ageDays)) * variance;
}

const batchDefs = [
  { id: 101, code: "SMP-B101", farmId: 1, poultryType: "Broiler", initialCount: 9000, startOffset: 30, status: "active" },
  { id: 102, code: "SMP-B102", farmId: 1, poultryType: "Broiler", initialCount: 8500, startOffset: 12, status: "active" },
  { id: 103, code: "SMP-B103", farmId: 2, poultryType: "Broiler", initialCount: 7800, startOffset: 24, status: "active" },
  { id: 104, code: "SMP-B104", farmId: 2, poultryType: "Layer", initialCount: 6000, startOffset: 110, status: "active" },
  { id: 105, code: "SMP-B105", farmId: 1, poultryType: "Broiler", initialCount: 8800, startOffset: 85, endOffset: 43, status: "completed" },
  { id: 106, code: "SMP-B106", farmId: 3, poultryType: "Broiler", initialCount: 5000, startOffset: -5, status: "planned" },
];

function buildBatches() {
  return batchDefs.map((def) => {
    const rand = seededRandom(def.id * 7919);
    const farm = sampleFarms.find((f) => f.id === def.farmId);
    const endOffset = def.endOffset ?? 0;
    const ageDays = def.status === "planned" ? 0 : def.startOffset - endOffset;
    const daily = [];
    let alive = def.initialCount;
    if (def.status !== "planned") {
      for (let age = 0; age <= ageDays; age += 1) {
        const baseRate = def.poultryType === "Layer" ? 0.00025 : age < 7 ? 0.0011 : 0.00045;
        const spike = def.id === 103 && age > ageDays - 6 ? 2.6 : 1; // visible upward trend for the alert preview
        const deaths = Math.round(alive * baseRate * spike * (0.5 + rand()));
        alive -= deaths;
        const weight =
          def.poultryType === "Layer"
            ? Math.min(1900, illustrativeWeight(age * 0.55, 0.98 + rand() * 0.03))
            : illustrativeWeight(age, 0.97 + rand() * 0.05);
        const feedPerBirdG = def.poultryType === "Layer" ? 95 + rand() * 15 : Math.max(12, weight * 0.075 + 10 + rand() * 8);
        daily.push({
          date: toIsoDate(daysAgo(def.startOffset - age)),
          ageDays: age,
          birdCount: alive,
          mortality: deaths,
          avgWeightG: Math.round(weight),
          feedKg: round((alive * feedPerBirdG) / 1000, 1),
        });
      }
    }
    const last = daily[daily.length - 1];
    return {
      id: def.id,
      code: def.code,
      farmId: def.farmId,
      farmName: farm.name,
      poultryType: def.poultryType,
      breed: def.poultryType === "Layer" ? "Sample layer strain" : "Sample broiler strain",
      initialCount: def.initialCount,
      birdCount: last ? last.birdCount : def.initialCount,
      ageDays,
      startDate: toIsoDate(daysAgo(def.startOffset)),
      endDate: def.endOffset !== undefined ? toIsoDate(daysAgo(def.endOffset)) : null,
      avgWeightG: last ? last.avgWeightG : null,
      status: def.status,
      daily,
    };
  });
}

export const sampleBatches = buildBatches();

/** Per-farm daily environment + production records for the last SAMPLE_HISTORY_DAYS days. */
function buildFarmDaily() {
  const records = [];
  for (const farm of sampleFarms) {
    const rand = seededRandom(farm.id * 104729);
    const tempBase = farm.housingType === "Open-sided house" ? 29.5 : 27;
    for (let offset = SAMPLE_HISTORY_DAYS - 1; offset >= 0; offset -= 1) {
      const date = toIsoDate(daysAgo(offset));
      const seasonal = Math.sin((offset / 45) * Math.PI) * 1.4;
      const heatwave = farm.id === 2 && offset < 4 ? 3.2 : 0; // drives the sample high-temperature alert
      const temperatureC = round(tempBase + seasonal + heatwave + (rand() - 0.5) * 1.6, 1);
      const humidityPct = round(64 - seasonal * 2 + (farm.id === 1 && offset < 3 ? 14 : 0) + (rand() - 0.5) * 8, 1);
      let birdCount = 0;
      let feedKg = 0;
      let mortality = 0;
      let weightSum = 0;
      for (const b of sampleBatches.filter((x) => x.farmId === farm.id)) {
        const rec = b.daily.find((d) => d.date === date);
        if (!rec) continue;
        birdCount += rec.birdCount;
        feedKg += rec.feedKg * (farm.id === 1 && offset < 2 ? 1.22 : 1); // sample feed anomaly
        mortality += rec.mortality;
        weightSum += rec.avgWeightG * rec.birdCount;
      }
      records.push({
        date,
        farmId: farm.id,
        farmName: farm.name,
        temperatureC,
        humidityPct,
        birdCount,
        feedKg: round(feedKg, 1),
        mortality,
        avgWeightG: birdCount ? Math.round(weightSum / birdCount) : null,
      });
    }
  }
  return records;
}

export const sampleFarmDaily = buildFarmDaily();

export function sampleFarmsWithStats() {
  return sampleFarms.map((farm) => {
    const batches = sampleBatches.filter((b) => b.farmId === farm.id);
    const active = batches.filter((b) => b.status === "active");
    return {
      ...farm,
      activeBatches: active.length,
      totalBatches: batches.length,
      birdCount: active.reduce((s, b) => s + b.birdCount, 0),
    };
  });
}

const now = Date.now();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();

export const sampleAlerts = [
  { id: 1, type: "temperature", severity: "danger", title: "High house temperature", message: "Average temperature above 32 °C for 3 consecutive days.", farmId: 2, farmName: "Sample Farm — Riverside", createdAt: minutesAgo(35) },
  { id: 2, type: "humidity", severity: "warning", title: "Unusual humidity", message: "Relative humidity 14 points above the 30-day average.", farmId: 1, farmName: "Sample Farm — Greenfield", createdAt: minutesAgo(140) },
  { id: 3, type: "mortality", severity: "danger", title: "Mortality increasing", message: "Batch SMP-B103 daily mortality is above its 7-day baseline.", farmId: 2, farmName: "Sample Farm — Riverside", createdAt: minutesAgo(260) },
  { id: 4, type: "feed", severity: "warning", title: "Feed consumption anomaly", message: "Feed intake 22% above the expected range for the flock age.", farmId: 1, farmName: "Sample Farm — Greenfield", createdAt: minutesAgo(410) },
];

export const sampleActivity = [
  { id: 1, type: "upload", message: "Uploaded dataset sample_daily_readings.csv", actor: "Sample Analyst", createdAt: minutesAgo(18) },
  { id: 2, type: "farm", message: "Updated capacity for Sample Farm — Hilltop", actor: "Sample Admin", createdAt: minutesAgo(95) },
  { id: 3, type: "prediction", message: "Generated growth forecast for batch SMP-B102", actor: "Sample Analyst", createdAt: minutesAgo(210) },
  { id: 4, type: "user", message: "Invited a new farm manager account", actor: "Sample Admin", createdAt: minutesAgo(1300) },
  { id: 5, type: "farm", message: "Started batch SMP-B102 at Sample Farm — Greenfield", actor: "Sample Manager 1", createdAt: minutesAgo(12 * 1440) },
];
