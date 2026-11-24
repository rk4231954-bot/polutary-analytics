/**
 * Dataset ingestion (stages 6–7). API only — never simulated, not even in preview mode.
 *
 * POST   /datasets                 multipart: file, mapping (JSON {field: column}), farmId? → 201 { dataset }
 *                                  Validation and preprocessing run during the request; the returned
 *                                  dataset is final: status "processed" (stored locally and, if HDFS was reachable, in HDFS) or "failed".
 * GET    /datasets?limit&farm_id   → { datasets: Dataset[] }
 * GET    /datasets/:id             → { dataset } (with report and history)
 * GET    /datasets/:id/preview?kind=processed|rejected&offset&limit → { preview: {columns, rows, total, offset} }
 * DELETE /datasets/:id             → 204
 * Dataset: { id, filename, status: "uploaded"|"validating"|"processing"|"processed"|"failed",
 *            stages: { uploaded, validated, preprocessed, hdfs, hive } (set by the backend; hdfs is true only
 *            when the HDFS copy was read back and matched; hive stays false until stage 8), hdfsPath, farmId, farmName, rowCount, totalRows, rejectedRows,
 *            duplicateRows, errorCount, warningCount, sizeBytes, uploadedBy, createdAt, processedAt, error,
 *            report?, history? }
 */
import { api, uploadWithProgress } from "./apiClient.js";
import { apiOnly } from "./dataSource.js";

export const listDatasets = ({ limit = 10 } = {}) =>
  apiOnly(async () => (await api.get("/datasets", { query: { limit } })).datasets);

export const getDataset = (id) => apiOnly(async () => (await api.get(`/datasets/${encodeURIComponent(id)}`)).dataset);

export const getDatasetPreview = (id, { kind = "processed", offset = 0, limit = 25 } = {}) =>
  apiOnly(async () => (await api.get(`/datasets/${encodeURIComponent(id)}/preview`, { query: { kind, offset, limit } })).preview);

export const deleteDataset = (id) => api.delete(`/datasets/${encodeURIComponent(id)}`);

/**
 * @param {File} file
 * @param {{mapping: Record<string,string>, farmId?: string, onProgress?: (f:number)=>void, signal?: AbortSignal}} options
 */
export async function uploadDataset(file, { mapping, farmId, onProgress, signal }) {
  const form = new FormData();
  // Some systems have no MIME type registered for .csv; the browser then sends
  // application/octet-stream, which the API refuses. The page has already checked
  // the .csv extension and parsed the file as CSV, so label it as such in that case only.
  const typed = file.type ? file : new File([file], file.name, { type: "text/csv" });
  form.append("file", typed, file.name);
  form.append("mapping", JSON.stringify(mapping));
  if (farmId) form.append("farmId", String(farmId));
  const body = await uploadWithProgress("/datasets", form, { onProgress, signal });
  return body.dataset;
}
