/**
 * User and role management. Passwords, hashes and tokens are never returned
 * by these endpoints and never displayed by the UI.
 *
 * GET   /users                 → { users: User[] }
 * POST  /users                 { fullName, email, role, farmIds } → { user, temporaryPassword }
 * PATCH /users/:id             { role?, status?, farmIds? } → { user }
 * POST  /users/:id/reset-password → { user, temporaryPassword }
 *   (temporary passwords are shown once to the admin; the user must change it at first sign-in)
 * GET   /users/login-activity  → { logins: [{ id, userName, email, ip, userAgent, at }] }
 * GET   /users/failed-logins   → { attempts: [{ id, email, ip, reason, attempts, at }] }
 * User: { id, fullName, email, role: "admin"|"farm_manager"|"analyst"|"veterinarian", status: "active"|"suspended",
 *         permissions: string[], farms: string[], farmIds: number[], mustChangePassword, lastLoginAt, createdAt }
 */
import { api } from "./apiClient.js";
import { readWithPreview } from "./dataSource.js";
import { sampleFailedLogins, sampleLoginActivity, sampleUsers } from "./sample/security.js";

export const listUsers = () => readWithPreview(async () => (await api.get("/users")).users, () => sampleUsers);
export const listLoginActivity = () =>
  readWithPreview(async () => (await api.get("/users/login-activity")).logins, () => sampleLoginActivity);
export const listFailedLogins = () =>
  readWithPreview(async () => (await api.get("/users/failed-logins")).attempts, () => sampleFailedLogins);

export const createUser = (user) => api.post("/users", user);
export const updateUser = (id, changes) => api.patch(`/users/${encodeURIComponent(id)}`, changes);
export const resetUserPassword = (id) => api.post(`/users/${encodeURIComponent(id)}/reset-password`);
