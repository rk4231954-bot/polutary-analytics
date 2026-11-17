/**
 * Chooses between the real API and labelled sample data.
 *
 * Preview mode (config.demoMode) only: a preview visitor (not signed in) gets
 * sample data; a signed-in user gets real API data, falling back to labelled
 * samples only for endpoints that are not built yet (ENDPOINT_NOT_FOUND) or
 * when the API is unreachable. Outside preview mode the API is always used.
 *
 * Read-only services return { data, source } where source is "api" or "sample".
 * Pages must render a sample badge whenever source === "sample".
 *
 * Use `apiOnly` for anything that must never be simulated: authentication,
 * writes, uploads, HDFS/Hive status and queries, model evaluation, reports.
 */
import { config } from "../config.js";
import { getUser } from "./session.js";

const SAMPLE_LATENCY_MS = 250; // makes loading states visible during preview

/**
 * @template T
 * @param {() => Promise<T>} apiCall
 * @param {() => T} sampleFactory
 * @returns {Promise<{data: T, source: "api"|"sample"}>}
 */
export async function readWithPreview(apiCall, sampleFactory) {
  if (!config.demoMode) return { data: await apiCall(), source: "api" };
  const sample = async () => {
    await new Promise((r) => setTimeout(r, SAMPLE_LATENCY_MS));
    return { data: structuredClone(sampleFactory()), source: "sample" };
  };
  const user = getUser();
  if (!user || user.isPreview) return sample();
  try {
    return { data: await apiCall(), source: "api" };
  } catch (error) {
    if (error?.code === "ENDPOINT_NOT_FOUND" || error?.isNetworkError) return sample();
    throw error;
  }
}

/** @template T @param {() => Promise<T>} apiCall @returns {Promise<{data: T, source: "api"}>} */
export async function apiOnly(apiCall) {
  return { data: await apiCall(), source: "api" };
}
