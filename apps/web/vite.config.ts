import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev only: forward /api to the local API server (pnpm dev:api).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:3001" } },
});
