import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  experimental: { proxyClientMaxBodySize: "64kb" },
};
export default config;
