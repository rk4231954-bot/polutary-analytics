/**
 * Chooses between the real API and labelled sample data.
 *
 * Read-only services return { data, source } where source is "api" or "sample".
 * Pages must render a sample badge whenever source === "sample".
 *
 * Use `apiOnly` for anything that must never be simulated: authentication,
 * writes, uploads, HDFS/Hive status and queries, model evaluation, reports.
 */
import { config } from "../config.js";

const SAMPLE_LATENCY_MS = 250; // makes loading states visible during preview

/**
 * @template T
 * @param {() => Promise<T>} apiCall
 * @param {() => T} sampleFactory
 * @returns {Promise<{data: T, source: "api"|"sample"}>}
 */
export async function readWithPreview(apiCall, sampleFactory) {
  if (config.demoMode) {
    await new Promise((r) => setTimeout(r, SAMPLE_LATENCY_MS));
    return { data: structuredClone(sampleFactory()), source: "sample" };
  }
  return { data: await apiCall(), source: "api" };
}

/** @template T @param {() => Promise<T>} apiCall @returns {Promise<{data: T, source: "api"}>} */
export async function apiOnly(apiCall) {
  return { data: await apiCall(), source: "api" };
}
