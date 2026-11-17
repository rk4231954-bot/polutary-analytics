/**
 * Current-user session state for the UI.
 *
 * - Normal mode: the user comes from GET /auth/me (server session). Not signed
 *   in → the router sends the visitor to /login.
 * - Preview mode (config.demoMode): if the API is unreachable, the UI can be
 *   browsed as an unauthenticated "Preview visitor" so the design can be
 *   reviewed. This grants NO server access — every write still goes to the
 *   real API, which enforces authentication and roles.
 */
import { config } from "../config.js";
import { fetchCurrentUser, logout as apiLogout } from "./auth.js";

/** Mirrors the server's roles (apps/api/app/services/permissions.py). The server enforces them. */
export const ROLES = {
  admin: { label: "Administrator", description: "Manages users, roles and farms; views all analytics and audit logs." },
  farm_manager: { label: "Farm Manager", description: "Manages assigned farms and poultry batches; views farm analytics." },
  analyst: { label: "Analyst", description: "Reads permitted analytical data for assigned farms and generates reports." },
  veterinarian: { label: "Veterinary User", description: "Views assigned farm health indicators and records inspections." },
};

const PREVIEW_USER = Object.freeze({
  id: null,
  fullName: "Preview Visitor",
  email: "not signed in",
  role: null,
  farms: [],
  isPreview: true,
});

const PREVIEW_OPT_OUT_KEY = "pa-preview-signed-out";

let currentUser = null;
const listeners = new Set();

export function getUser() {
  return currentUser;
}

export function setUser(user) {
  currentUser = user;
  listeners.forEach((fn) => fn(user));
}

export function onUserChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolves the session. Returns the user, or null when sign-in is required. */
export async function resolveSession() {
  if (currentUser && !currentUser.isPreview) return currentUser;
  try {
    const { user } = await fetchCurrentUser();
    setUser(user);
    return user;
  } catch (error) {
    const backendMissing = error.isNetworkError || error.isNotFound || error.code === "BAD_RESPONSE";
    if (config.demoMode && backendMissing && !sessionStorage.getItem(PREVIEW_OPT_OUT_KEY)) {
      setUser(PREVIEW_USER);
      return PREVIEW_USER;
    }
    setUser(null);
    return null;
  }
}

export async function signOut() {
  try {
    if (currentUser && !currentUser.isPreview) await apiLogout();
  } finally {
    if (config.demoMode) sessionStorage.setItem(PREVIEW_OPT_OUT_KEY, "1");
    setUser(null);
  }
}

/** Preview mode only: lets the login page offer "Continue in preview mode". */
export function enterPreview() {
  sessionStorage.removeItem(PREVIEW_OPT_OUT_KEY);
}

/** Call after a successful real login. */
export function clearPreviewOptOut() {
  sessionStorage.removeItem(PREVIEW_OPT_OUT_KEY);
}

export function hasRole(...roles) {
  return Boolean(currentUser?.role && roles.includes(currentUser.role));
}

/**
 * Whether to offer an action in the UI. Signed-in users: the permission list sent
 * by the API. Preview visitors: true (forms are shown, but saving still needs the API).
 * This only hides buttons; the API checks every request itself.
 */
export function can(permission) {
  if (!currentUser || currentUser.isPreview) return true;
  return Boolean(currentUser.permissions?.includes(permission));
}
