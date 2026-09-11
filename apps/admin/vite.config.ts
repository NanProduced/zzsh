import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxy = process.env.ADMIN_API_PROXY ?? "http://127.0.0.1:3102";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@brand": path.resolve(import.meta.dirname, "../../assets/brand"),
    },
  },
  server: {
    // Development transport only; the authenticated boundary is the API BFF.
    proxy: {
      "/api": { target: apiProxy, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      "/api": { target: apiProxy, changeOrigin: false },
    },
  },
});
