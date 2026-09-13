"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { PortalHeader } from "./portal-header";
import { PortalFooter } from "./portal-footer";
import { SupportRail } from "../support/support-rail";
export function ServiceShell({ children, title, description, initialQuery = "", onSearch, backHref = "/", backLabel = "返回首页" }: { children: ReactNode; title: string; description: string; initialQuery?: string; onSearch?: (query: string) => void; backHref?: string; backLabel?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  return <div className="portal-home portal-subpage">
    <PortalHeader home={false} query={query} onQueryChange={setQuery} onSearch={onSearch ?? ((value: string) => router.push(`/accounts?q=${encodeURIComponent(value)}`))} />
    <main className="portal-width subpage-main">
      <div className="subpage-heading"><Link href={backHref}><ArrowLeft size={16} />{backLabel}</Link><h1>{title}</h1><p>{description}</p></div>
      {children}
    </main>
    <PortalFooter />
    <SupportRail />
  </div>;
}
