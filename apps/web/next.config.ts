import type { NextConfig } from "next";
const config: NextConfig = {
  // Local review builds can be sealed before switching the running preview.
  distDir: process.env.ZZSH_WEB_DIST_DIR ?? ".next",
  poweredByHeader: false,
  experimental: { proxyClientMaxBodySize: "15mb" },
};
export default config;
