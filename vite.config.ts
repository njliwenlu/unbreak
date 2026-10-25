import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Rapier ships its WASM inlined in the JS bundle (~4 MB); that is expected.
  build: { chunkSizeWarningLimit: 6000 },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
