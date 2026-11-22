import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The browser always uses http://127.0.0.1:4317. Vite owns that port in
 * `bun run dev`; `/api` is proxied to the API on 4318. Production
 * `bun run start` binds 4317 itself and serves `web/dist`.
 *
 * `strictPort` is required — without it Vite silently moves to 5318/5319
 * when 4317 is taken, which is how this app kept growing extra URLs.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    fs: {
      // shared/ sits one level above the Vite root (web/).
      allow: [path.resolve(import.meta.dirname, "..")],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4318",
        // Keep the browser-facing Host header. OAuth callbacks are registered
        // against 4317; rewriting it to the API's private 4318 port makes Slack
        // reject redirect_uri before the user can authorize.
        changeOrigin: false,
      },
    },
  },
  build: {
    // Served by src/api/serve.ts, which looks here by default.
    outDir: "dist",
    emptyOutDir: true,
  },
});
