import type { Metadata } from "next";
import { StatusPage } from "@/components/status/status-page";

export const metadata: Metadata = {
  title: "访问提示 · 洲洲商行",
  robots: { index: false, follow: false },
};

export default function AccessDeniedPage() {
  return <StatusPage kind="forbidden" />;
}
