import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
export const metadata: Metadata = { title: "洲洲商行 · 开发环境", description: "洲洲商行新平台开发入口", robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }
