/**
 * Broiler flock performance reference data: the Kaggle dataset "Broiler Performance Index"
 * (isa zulka, Apache 2.0, file "PS Performance.csv"). API only, never simulated.
 *
 * POST /flock-performance          admin, multipart file → 201 { source, report, hdfs: {path, sha256}, hive: {table, rowCount} }
 *                                  Replaces the stored file in HDFS; Hive's row count must match.
 * GET  /flock-performance/summary  → { loaded: false, dataset, source }
 *                                  | { loaded: true, dataset, source, flocks, ageDays, bodyWeightKg, depletionPct,
 *                                      harvestPct, performanceIndex, correlations, depletionBands[] }  (HiveQL)
 */
import { api, uploadWithProgress } from "./apiClient.js";

export const getFlockSummary = () => api.get("/flock-performance/summary");

export function uploadFlockCsv(file, { onProgress, signal } = {}) {
  const form = new FormData();
  // Same reason as uploadDataset: some systems send .csv as application/octet-stream.
  const typed = file.type ? file : new File([file], file.name, { type: "text/csv" });
  form.append("file", typed, file.name);
  return uploadWithProgress("/flock-performance", form, { onProgress, signal });
}
