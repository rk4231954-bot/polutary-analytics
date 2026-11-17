import { defineConfig, loadEnv } from "vite";

// Read the repository-root .env. Only VITE_* variables are exposed to the browser.
const ENV_DIR = "../..";

// The Flask API runs separately; Vite proxies /api so the browser talks to a
// single origin during development. When Flask is not running, the proxy
// answers with a JSON 502 so the UI can show a clear "backend not connected" state.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, "VITE_");
  const apiTarget = env.VITE_DEV_API_TARGET || "http://127.0.0.1:5000";

  return {
    envDir: ENV_DIR,
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("error", (_err, _req, res) => {
              if (!res || res.headersSent || typeof res.writeHead !== "function") return;
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: {
                    code: "BACKEND_UNAVAILABLE",
                    message: `The Flask API is not running (the dev proxy could not reach ${apiTarget}).`,
                  },
                }),
              );
            });
          },
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      chunkSizeWarningLimit: 700,
    },
  };
});
