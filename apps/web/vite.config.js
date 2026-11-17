import { defineConfig } from "vite";

// The Flask API runs separately on port 5000; Vite proxies /api so the
// browser talks to a single origin during development.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
