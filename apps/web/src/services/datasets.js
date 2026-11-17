/**
 * Dataset ingestion. API only — never simulated, not even in preview mode.
 *
 * POST /datasets            multipart: file, mapping (JSON {field: column}), farmId? → { dataset }
 * GET  /datasets?limit      → { datasets: Dataset[] }
 * GET  /datasets/:id        → { dataset }
 * Dataset: { id, filename, status: "uploaded"|"validating"|"processing"|"stored"|"available"|"failed",
 *            stages: { uploaded, validated, preprocessed, hdfs, hive } (booleans, set by the backend),
 *            hdfsPath, hiveTable, rowCount, sizeBytes, uploadedBy, createdAt, error }
 */
import { api, uploadWithProgress } from "./apiClient.js";
import { apiOnly } from "./dataSource.js";

export const listDatasets = ({ limit = 10 } = {}) =>
  apiOnly(async () => (await api.get("/datasets", { query: { limit } })).datasets);

export const getDataset = (id) => apiOnly(async () => (await api.get(`/datasets/${encodeURIComponent(id)}`)).dataset);

/**
 * @param {File} file
 * @param {{mapping: Record<string,string>, farmId?: string, onProgress?: (f:number)=>void, signal?: AbortSignal}} options
 */
export async function uploadDataset(file, { mapping, farmId, onProgress, signal }) {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("mapping", JSON.stringify(mapping));
  if (farmId) form.append("farmId", String(farmId));
  const body = await uploadWithProgress("/datasets", form, { onProgress, signal });
  return body.dataset;
}
