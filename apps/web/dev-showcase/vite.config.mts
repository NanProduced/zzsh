import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  plugins: [react(), tailwind()],
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 4210, strictPort: true },
  build: { outDir: "../../../tmp/docs/planning/repair/showcase-dist", emptyOutDir: false },
});
