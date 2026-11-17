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
   * so the UI can be reviewed before the backend exists. Defaults to on for the
   * Vite dev server and off for production builds. Set VITE_DEMO_MODE=false
   * once the Flask API is connected.
   *
   * Preview mode never applies to: authentication, saving data, CSV upload,
   * HDFS/Hive status, HiveQL execution or ML model evaluation.
   */
  demoMode: readBool(env.VITE_DEMO_MODE, Boolean(env.DEV)),
  requestTimeoutMs: Number(env.VITE_API_TIMEOUT_MS) || 20000,
  maxUploadMb: Number(env.VITE_MAX_UPLOAD_MB) || 50,
});
