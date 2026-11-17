/**
 * Authentication against the Flask API (session cookie). Never simulated —
 * there is no client-side login, token storage or password handling here.
 *
 * POST /auth/login     { email, password, remember } → { user }
 * POST /auth/register  { fullName, email, password } → { user }
 * POST /auth/logout    → 204
 * GET  /auth/me        → { user }  (401 when not signed in)
 * user: { id, fullName, email, role: "admin"|"farm_manager"|"analyst", farms: [...] }
 */
import { api } from "./apiClient.js";

export const login = ({ email, password, remember = false }) => api.post("/auth/login", { email, password, remember });
export const register = ({ fullName, email, password }) => api.post("/auth/register", { fullName, email, password });
export const logout = () => api.post("/auth/logout");
export const fetchCurrentUser = () => api.get("/auth/me", { timeoutMs: 8000 });

/** PATCH /auth/me { fullName, email } → { user } */
export const updateProfile = ({ fullName, email }) => api.patch("/auth/me", { fullName, email });
/** POST /auth/change-password { currentPassword, newPassword } → 204 */
export const changePassword = ({ currentPassword, newPassword }) =>
  api.post("/auth/change-password", { currentPassword, newPassword });
