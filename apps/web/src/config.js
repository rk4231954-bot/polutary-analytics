/**
 * Centralised frontend configuration.
 *
 * Only VITE_-prefixed variables reach the browser bundle. Never put secrets
 * here: everything in this file is public.
 */
const env = import.meta.env;

function readBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

export const config = Object.freeze({
  appName: "Poultry Analytics",
  appTagline: "Intelligent Farm Management",
  /** Base URL of the Flask REST API. Relative by default so the Vite dev proxy is used. */
  apiBaseUrl: (env.VITE_API_BASE_URL || "/api").replace(/\/+$/, ""),
  /**
   * Preview mode. When true, read-only views show clearly labelled SAMPLE data
   * so the UI can be reviewed before the backend exists. Off unless
   * VITE_DEMO_MODE=true: the Flask API is connected, so pages show real API
   * results or the real error, never sample figures.
   *
   * Preview mode never applies to: authentication, saving data, CSV upload,
   * HDFS/Hive status, HiveQL execution or ML model evaluation.
   */
  demoMode: readBool(env.VITE_DEMO_MODE, false),
  requestTimeoutMs: Number(env.VITE_API_TIMEOUT_MS) || 20000,
  maxUploadMb: Number(env.VITE_MAX_UPLOAD_MB) || 50,
});
