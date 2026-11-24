/**
 * Hadoop HDFS / Apache Hive status. API only — never simulated.
 *
 * Implemented (administrators only, read-only metadata):
 * GET  /bigdata/status → { hdfs: { connected, namenodeUrl, state, capacityBytes, usedBytes, remainingBytes,
 *                          liveDataNodes, filesTotal, blocksTotal },
 *                          hive: { connected, host, port, database, version: null }, latestIngestionAt }
 *                      latestIngestionAt = latest change to any Hive table's HDFS directory.
 * GET  /hive/tables    → { tables: [{ name, type, location, partitioned, rowCount (Hive statistics, may be
 *                          null), numFiles, totalSizeBytes, updatedAt }] }
 *
 * Not implemented (the API runs only fixed, parameterised HiveQL); these calls return 404:
 * POST /hive/query     { sql } → { columns, rows, rowCount, durationMs, queryId }
 * GET  /hive/queries?limit → { queries: [...] }
 */
import { api } from "./apiClient.js";
import { apiOnly } from "./dataSource.js";

export const getClusterStatus = () => apiOnly(() => api.get("/bigdata/status", { timeoutMs: 10000 }));
export const listHiveTables = () => apiOnly(async () => (await api.get("/hive/tables")).tables);
export const runHiveQuery = (sql, { signal } = {}) => apiOnly(() => api.post("/hive/query", { sql }, { signal, timeoutMs: 300000 }));
export const getQueryHistory = ({ limit = 10 } = {}) =>
  apiOnly(async () => (await api.get("/hive/queries", { query: { limit } })).queries);
