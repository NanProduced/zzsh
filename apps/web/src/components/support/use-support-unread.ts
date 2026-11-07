"use client";
import { useEffect, useSyncExternalStore } from "react";
import { readSupportOrders } from "@/lib/support-directory";
import {
  computeSupportUnread,
  getSupportUnreadSnapshot,
  publishSupportUnread,
  readDirectoryPreferences,
  resetSupportUnread,
  subscribeSupportUnread,
  type SupportUnreadConsultation,
  type SupportUnreadOrder,
  type SupportUnreadSummary,
} from "./support-unread";

/** 入口轮询比窗口内的 5 秒目录慢一档：它是“有没有新消息”的提示，不是会话读条。 */
const ENTRY_POLL_MS = 20_000;
/** 首轮覆盖新旧订单及双方；没读完只发布已读取的部分。 */
const ORDER_PAGE_BUDGET = 4;

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

async function readJson(response: Response, fallback: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const error = new Error(fallback) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("客服响应格式无效");
  return value as Record<string, unknown>;
}

async function readConsultationUnread(signal: AbortSignal): Promise<SupportUnreadConsultation[]> {
  const response = await fetch("/api/im/consultations?limit=50", { credentials: "same-origin", cache: "no-store", signal });
  const value = await readJson(response, "暂时无法读取咨询未读。");
  if (!Array.isArray(value.consultations)) throw new Error("咨询记录格式无效");
  return value.consultations
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.id === "string" && Boolean(item.id))
    .map((item) => ({
      id: item.id as string,
      threadId: typeof item.threadId === "string" && item.threadId ? item.threadId : null,
      hasUnread: item.hasUnread === true,
      userUnreadCount: typeof item.userUnreadCount === "number" ? item.userUnreadCount : 0,
    }));
}

async function readOrderUnread(signal: AbortSignal,userId:string): Promise<SupportUnreadOrder[]> {
  const scan = readSupportOrders(async <T,>(path: string): Promise<T> => {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal, headers:{"x-zzsh-expected-user-id":userId} });
    return await readJson(response, "暂时无法读取订单群未读。") as T;
  }, signal);
  let page: { items: SupportUnreadOrder[]; complete: boolean } | undefined;
  for (let count = 0; count < ORDER_PAGE_BUDGET; count += 1) {
    const next = await scan.next();
    page = next.value;
    if (!page || page.complete) break;
  }
  return (page?.items ?? []).map((item) => ({
    id: item.id,
    status: item.status ?? null,
    origin: item.origin,
    unreadCount: typeof item.unreadCount === "number" ? item.unreadCount : 0,
  }));
}

/**
 * 客服入口未读。窗口关着时才轮询：窗口开着时它自己的目录轮询会发布同一份快照，这里停手，
 * 一个页面只跑一条未读链路。隐藏标签页不发请求；重新可见立刻补一次。
 */
export function useSupportUnread(identity: string | null, enabled: boolean,userId:string|null): SupportUnreadSummary | null {
  const summary = useSyncExternalStore(subscribeSupportUnread, getSupportUnreadSnapshot, () => null);
  useEffect(() => {
    if (!enabled || !identity || !userId) return;
    let cancelled = false;
    let pending = false;
    let controller = new AbortController();
    const read = async (): Promise<void> => {
      if (cancelled || pending) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      pending = true;
      const signal = controller.signal;
      try {
        const [consultations, orders] = await Promise.all([readConsultationUnread(signal), readOrderUnread(signal,userId)]);
        if (cancelled || signal.aborted) return;
        publishSupportUnread(computeSupportUnread(consultations, orders, readDirectoryPreferences(identity)));
      } catch (cause) {
        if (cancelled || signal.aborted) return;
        // 失败保留上一次事实：读不到不等于没有未读。只有真的失权才清空这个身份的角标。
        const status = httpStatus(cause);
        if (status === 401 || status === 403) resetSupportUnread();
      } finally {
        pending = false;
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        controller.abort();
        controller = new AbortController();
        return;
      }
      controller = new AbortController();
      void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => void read(), ENTRY_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [enabled, identity,userId]);
  return summary;
}
