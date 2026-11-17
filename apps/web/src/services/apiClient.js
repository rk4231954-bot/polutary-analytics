/**
 * Shared HTTP client for the Flask REST API.
 *
 * - Every request goes to `${config.apiBaseUrl}${path}`.
 * - Cookies are sent (`credentials: "include"`): the session is an HttpOnly JWT
 *   cookie the page can never read.
 * - CSRF: state-changing requests carry the X-CSRF-TOKEN header (double-submit).
 *   The token comes from the login and /auth/me responses (a frontend on another
 *   domain such as Vercel cannot read the API's cookies) and is kept in
 *   sessionStorage. It is not a credential on its own.
 * - Errors are normalised into ApiError so pages can render consistent states.
 * - Expected error body from the API: {"error": {"code": "...", "message": "...", "fields": {...}}}
 */
import { config } from "../config.js";

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, fields?: Record<string,string>, path?: string}} [info]
   */
  constructor(message, { status = 0, code = "UNKNOWN", fields = {}, path = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.path = path;
  }

  /** True when the API could not be reached at all (backend not running / not built yet). */
  get isNetworkError() {
    return ["NETWORK", "TIMEOUT", "BACKEND_UNAVAILABLE"].includes(this.code);
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }

  get isNotFound() {
    return this.status === 404;
  }
}

const CSRF_KEY = "pa-csrf";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Stores (or clears, with null) the CSRF token issued by the API. */
export function setCsrfToken(token) {
  try {
    if (token) sessionStorage.setItem(CSRF_KEY, token);
    else sessionStorage.removeItem(CSRF_KEY);
  } catch {
    /* storage disabled: requests will fail CSRF and ask the user to sign in again */
  }
}

function csrfHeader(method) {
  if (!UNSAFE_METHODS.has(method)) return {};
  let token = null;
  try {
    token = sessionStorage.getItem(CSRF_KEY);
  } catch {
    /* ignore */
  }
  return token ? { "X-CSRF-TOKEN": token } : {};
}

const unauthorizedListeners = new Set();
/** Lets the app shell react to expired sessions (redirect to login). */
export function onUnauthorized(listener) {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export function buildUrl(path, query) {
  const url = `${config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(response, path) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON error body */
  }
  const err = body?.error || {};
  const message =
    err.message ||
    (response.status === 404
      ? "This API endpoint is not available yet."
      : `Request failed with status ${response.status}.`);
  return new ApiError(message, {
    status: response.status,
    code: err.code || `HTTP_${response.status}`,
    fields: err.fields || {},
    path,
  });
}

/**
 * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
 * @param {string} path  e.g. "/farms"
 * @param {{query?: object, body?: unknown, signal?: AbortSignal, raw?: boolean, timeoutMs?: number}} [options]
 *   raw: return the Response (for file downloads) instead of parsed JSON.
 */
export async function request(method, path, options = {}) {
  const { query, body, signal, raw = false, timeoutMs = config.requestTimeoutMs } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });

  const isForm = body instanceof FormData;
  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
        "X-Requested-With": "XMLHttpRequest",
        ...csrfHeader(method),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = controller.signal.reason === "timeout";
    throw new ApiError(
      timedOut
        ? "The API did not respond in time."
        : `Cannot reach the API at ${config.apiBaseUrl}. Make sure the Flask backend is running.`,
      { code: timedOut ? "TIMEOUT" : "NETWORK", path },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const error = await parseError(response, path);
    if (error.isUnauthorized) unauthorizedListeners.forEach((fn) => fn(error));
    throw error;
  }
  if (raw) return response;
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    // The Vite dev server answers unknown paths with index.html when no proxy target is up.
    throw new ApiError("The API returned an unexpected response (not JSON).", {
      status: response.status,
      code: "BAD_RESPONSE",
      path,
    });
  }
  return response.json();
}

export const api = {
  get: (path, options) => request("GET", path, options),
  post: (path, body, options) => request("POST", path, { ...options, body }),
  put: (path, body, options) => request("PUT", path, { ...options, body }),
  patch: (path, body, options) => request("PATCH", path, { ...options, body }),
  delete: (path, options) => request("DELETE", path, options),
};

/**
 * Multipart upload with progress (fetch has no upload progress events).
 * @param {string} path
 * @param {FormData} formData
 * @param {{onProgress?: (fraction:number)=>void, signal?: AbortSignal}} [options]
 */
export function uploadWithProgress(path, formData, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", buildUrl(path));
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
    for (const [name, value] of Object.entries(csrfHeader("POST"))) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () =>
      reject(
        new ApiError(`Cannot reach the API at ${config.apiBaseUrl}. Make sure the Flask backend is running.`, {
          code: "NETWORK",
          path,
        }),
      );
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body !== null) return resolve(body);
      const err = body?.error || {};
      const error = new ApiError(
        err.message ||
          (xhr.status === 404 ? "The upload endpoint is not available yet." : `Upload failed (status ${xhr.status}).`),
        { status: xhr.status, code: err.code || `HTTP_${xhr.status}`, fields: err.fields || {}, path },
      );
      if (error.isUnauthorized) unauthorizedListeners.forEach((fn) => fn(error));
      reject(error);
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(formData);
  });
}

/** Downloads a file produced by the API (CSV/PDF reports). */
export async function downloadFromApi(path, query, fallbackName) {
  const response = await request("GET", path, { query, raw: true, timeoutMs: 120000 });
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const filename = match ? decodeURIComponent(match[1]) : fallbackName;
  const blob = await response.blob();
  return { blob, filename };
}
