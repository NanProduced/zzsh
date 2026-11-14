import type { Metadata } from "next";
import type { ReactNode } from "react";
import { seoPageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = seoPageMetadata({
  title: "登录或注册",
  description: "登录或注册洲洲商行账号，即可在线租用或出租三角洲行动账号。",
  path: "/login",
});

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
