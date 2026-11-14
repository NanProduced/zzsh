import type { MetadataRoute } from "next";
import { seoOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const origin = seoOrigin();
  if (!origin) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    // 百度按从上往下首条匹配生效，Google 按最长路径优先：不能写 Allow: /，
    // 否则 Disallow: /account 在百度下永远不生效；/accounts 需显式放行以免被 /account 前缀命中。
    rules: { userAgent: "*", allow: "/accounts", disallow: "/account" },
    sitemap: `${origin}/sitemap.xml`,
  };
}
