/** API health. Always calls the real API. */
import { api } from "./apiClient.js";

/** GET /health → { status: "ok", version, time } */
export const getHealth = () => api.get("/health", { timeoutMs: 5000 });
