import type { MetadataRoute } from "next";
import { seoOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const origin = seoOrigin();
  if (!origin) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    // /account 前缀会命中 /accounts，最长匹配下必须显式放行租号大厅。
    rules: { userAgent: "*", allow: ["/", "/accounts"], disallow: "/account" },
    sitemap: `${origin}/sitemap.xml`,
  };
}