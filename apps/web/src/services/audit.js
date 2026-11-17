/**
 * Audit log (append-only on the server).
 *
 * GET /audit-logs?from&to&action&outcome      → { entries: [{ id, timestamp, actor, action, resource, ip, outcome: "success"|"failure"|"denied" }] }
 * GET /audit-logs/security-events             → { events: [{ id, type, severity: "info"|"warning"|"danger", message, ip, at }] }
 */
import { api } from "./apiClient.js";
import { readWithPreview } from "./dataSource.js";
import { sampleAuditEntries, sampleSecurityEvents } from "./sample/security.js";

export const listAuditEntries = ({ from, to, action, outcome } = {}) =>
  readWithPreview(
    async () => (await api.get("/audit-logs", { query: { from, to, action, outcome } })).entries,
    () => sampleAuditEntries,
  );

export const listSecurityEvents = () =>
  readWithPreview(async () => (await api.get("/audit-logs/security-events")).events, () => sampleSecurityEvents);
