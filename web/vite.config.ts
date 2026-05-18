import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During dev the host runs on WEB_PORT=7117 by default. Vite proxies the
// API + WS calls there so HMR works against the real backend without
// CORS dances.
const BACKEND = process.env.NANOCLAW_HOST ?? "http://127.0.0.1:7117";

export default defineConfig({
  plugins: [react()],
  build: {
    // Output goes straight into a path the web channel adapter serves
    // statically — no copy step required.
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5181,
    host: "127.0.0.1",
    proxy: {
      "/auth": BACKEND,
      "/healthz": BACKEND,
      "/ws": { target: BACKEND, ws: true },
    },
  },
});
