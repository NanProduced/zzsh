import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxy = process.env.ADMIN_API_PROXY ?? "http://127.0.0.1:3102";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "globalThis.__PLATE_TRIAL_ENABLED__": JSON.stringify(process.env.VITE_PLATE_TRIAL_ENABLED === "true"),
  },
  optimizeDeps: {
    include: [
      "@zzsh/content",
      "@zzsh/content/updates",
      "@zzsh/content/markdown",
      "@zzsh/content/markdown/policy",
      "@uiw/react-md-editor/nohighlight",
      "@uiw/react-md-editor/commands-cn",
    ],
  },
  ssr: { external: ["@zzsh/content"] },
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
