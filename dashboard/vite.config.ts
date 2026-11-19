import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Emit every asset as a file: the CSP forbids data: fonts, and we'd rather not loosen it.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      "/rpc": "http://127.0.0.1:3847",
    },
  },
});
