/**
 * Hadoop HDFS / Apache Hive status and HiveQL execution. API only — never
 * simulated. The Flask API runs the queries on HiveServer2 through PyHive.
 *
 * GET  /bigdata/status → { hdfs: { connected, namenodeUrl, capacityBytes, usedBytes, remainingBytes, liveDataNodes },
 *                          hive: { connected, host, port, database, version }, latestIngestionAt }
 * GET  /hive/tables    → { tables: [{ name, rowCount, location, partitioned, updatedAt }] }
 * POST /hive/query     { sql } → { columns: string[], rows: any[][], rowCount, durationMs, queryId }
 *                      Only read-only SELECT statements are accepted (validated server-side).
 * GET  /hive/queries?limit → { queries: [{ id, sql, status, durationMs, rowCount, executedBy, executedAt, error }] }
 */
import { api } from "./apiClient.js";
import { apiOnly } from "./dataSource.js";

export const getClusterStatus = () => apiOnly(() => api.get("/bigdata/status", { timeoutMs: 10000 }));
export const listHiveTables = () => apiOnly(async () => (await api.get("/hive/tables")).tables);
export const runHiveQuery = (sql, { signal } = {}) => apiOnly(() => api.post("/hive/query", { sql }, { signal, timeoutMs: 300000 }));
export const getQueryHistory = ({ limit = 10 } = {}) =>
  apiOnly(async () => (await api.get("/hive/queries", { query: { limit } })).queries);
