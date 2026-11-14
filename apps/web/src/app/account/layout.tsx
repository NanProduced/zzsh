import type { Metadata } from "next";
import "@heroui/styles/css";
import "@/components/layout/functional-shell.css";

export const metadata: Metadata = { robots: "noindex" };

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return children;
}
