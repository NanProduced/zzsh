"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { PublicContentResource } from "@zzsh/content";
import { fetchContentResources, fetchFooterResource } from "@/lib/content-public";

type State = { status: "loading" | "ready" | "error"; resources: Readonly<Record<string, PublicContentResource>> };
const PublicContentContext = createContext<State & { retry: () => void }>({ status: "loading", resources: {}, retry() {} });

export function PublicContentProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname(), [nonce, setNonce] = useState(0);
  const [state, setState] = useState<State>({ status: "loading", resources: {} });
  const retry = useCallback(() => setNonce(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => {
      const resources: Record<string, PublicContentResource> = {};
      const footer = previous.resources["placement:FOOTER"];
      if (footer) resources["placement:FOOTER"] = footer;
      return { status: "loading", resources };
    });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    fetchContentResources("placement", { signal })
      .then(items => { if (!controller.signal.aborted) setState(previous => ({ status: "ready", resources: { ...previous.resources, ...Object.fromEntries(items.map(item => [item.key, item])) } })); })
      .catch(() => { if (!controller.signal.aborted) setState(previous => ({ ...previous, status: "error" })); });
    fetchFooterResource({ signal })
      .then(item => { if (!controller.signal.aborted) setState(previous => ({ ...previous, resources: { ...previous.resources, [item.key]: item } })); })
      .catch(() => {});
    return () => controller.abort();
  }, [pathname, nonce]);
  return <PublicContentContext.Provider value={{ ...state, retry }}>{children}</PublicContentContext.Provider>;
}

export function usePublicContent(key: string) {
  const state = useContext(PublicContentContext);
  return { status: state.status, resource: state.resources[key] ?? null, retry: state.retry };
}
