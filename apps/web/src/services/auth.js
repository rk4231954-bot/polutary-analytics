/**
 * Authentication against the Flask API. Never simulated: there is no
 * client-side login or password handling here. The session itself is an
 * HttpOnly cookie set by the API; only the CSRF token is kept by the page.
 *
 * POST  /auth/register         { fullName, email, password } → 201 { user }
 * POST  /auth/login            { email, password, remember } → { user, csrfToken }
 * POST  /auth/logout           → 204
 * GET   /auth/me               → { user, csrfToken }  (401 when not signed in)
 * PATCH /auth/me               { fullName?, email? } → { user }
 * POST  /auth/change-password  { currentPassword, newPassword } → { user, csrfToken }
 *
 * user: { id, fullName, email, role: "admin"|"farm_manager"|"analyst"|"veterinarian", roleLabel,
 *         status, permissions: string[], farms: string[], farmIds: number[], mustChangePassword }
 */
import { api, setCsrfToken } from "./apiClient.js";

function keepCsrf(response) {
  if (response?.csrfToken) setCsrfToken(response.csrfToken);
  return response;
}

export const login = async ({ email, password, remember = false }) =>
  keepCsrf(await api.post("/auth/login", { email, password, remember }));
export const register = ({ fullName, email, password }) => api.post("/auth/register", { fullName, email, password });
export const logout = async () => {
  try {
    await api.post("/auth/logout");
  } finally {
    setCsrfToken(null);
  }
};
export const fetchCurrentUser = async () => keepCsrf(await api.get("/auth/me", { timeoutMs: 8000 }));

export const updateProfile = ({ fullName, email }) => api.patch("/auth/me", { fullName, email });
export const changePassword = async ({ currentPassword, newPassword }) =>
  keepCsrf(await api.post("/auth/change-password", { currentPassword, newPassword }));
