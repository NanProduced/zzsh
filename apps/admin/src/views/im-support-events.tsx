"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, History, ShieldCheck } from "lucide-react";
import { AdminApiError } from "../api";
import { formatDateTime } from "./im-support-format";

/**
 * 处理记录时间线：im_consultation_event 的只读投影（GET …/consultations/:id/events）。
 * 只渲染服务端明确输出的 id/type/occurredAt/actor/from/to——事件原始 details 与云信账号
 * 不在投影里，前端也不从别处拼接。与 ConsultationUserCard 同一模式：调用方注入 request，
 * 组件自身按（咨询，重试代次）隔离迟到响应。
 */

type ConsultationEvent = {
  id: string;
  type: string;
  occurredAt: string;
  actor: { kind: string; displayName: string };
  from: { displayName: string } | null;
  to: { displayName: string } | null;
};

type EventPage = { events?: unknown; nextCursor?: unknown };

export type EventsRequest = <T>(path: string) => Promise<T>;

const EVENT_PAGE_LIMIT = 20;

// 与 im/consultation.ts 的 EVENT_TYPES 对齐。服务端会把未知类型归一为 UNKNOWN；
// 前端仍对表外类型按原码兜底显示，任何一端新增类型都不会崩或丢事件。
const EVENT_TYPE_LABELS: Record<string, string> = {
  CREATED: "发起咨询",
  ASSIGNED: "系统分配",
  CLAIMED: "客服接入",
  TRANSFERRED: "转交",
  CLOSED: "结束咨询",
  REOPENED: "重新开启",
  UNKNOWN: "未知类型",
};

type LoadStatus = "loading" | "ready" | "error" | "forbidden" | "missing" | "expired";

function statusOf(error: unknown): number | undefined {
  if (error instanceof AdminApiError) return error.status;
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
}

function asEvents(value: unknown): ConsultationEvent[] {
  if (!Array.isArray(value)) return [];
  return value as ConsultationEvent[];
}

export function ConsultationEventsCard({ consultationId, request }: { consultationId: string; request: EventsRequest }) {
  const [events, setEvents] = useState<ConsultationEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 每（咨询，重试代次）一代：切换咨询或重读后，迟到的旧响应直接丢弃。
  const generationRef = useRef("");

  useEffect(() => {
    const generation = `${consultationId}|${attempt}`;
    generationRef.current = generation;
    let active = true;
    setEvents([]);
    setNextCursor(null);
    setEarlierFailed(false);
    setStatus("loading");
    void request<EventPage>(`/im/consultations/${encodeURIComponent(consultationId)}/events?limit=${EVENT_PAGE_LIMIT}`)
      .then((page) => {
        if (!active || generationRef.current !== generation) return;
        setEvents(asEvents(page?.events));
        setNextCursor(typeof page?.nextCursor === "string" ? page.nextCursor : null);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (!active || generationRef.current !== generation) return;
        const code = statusOf(error);
        // 合同语义：403=缺 im.support.read；404=咨询已结束/不存在/跨端/他人/投诉排除名单
        // （服务端统一 404，不确认对象存在）。401=身份失效（全局重确认已由 adminRequest 触发）。
        // 三种拒绝都要明说，不能留白。
        setStatus(code === 403 ? "forbidden" : code === 404 ? "missing" : code === 401 ? "expired" : "error");
      });
    return () => { active = false; };
  }, [consultationId, attempt, request]);

  const clearProjection = (next: LoadStatus) => {
    setEvents([]);
    setNextCursor(null);
    setStatus(next);
  };

  const loadEarlier = () => {
    if (!nextCursor || loadingEarlier) return;
    const generation = generationRef.current;
    const cursor = nextCursor;
    setLoadingEarlier(true);
    setEarlierFailed(false);
    void request<EventPage>(`/im/consultations/${encodeURIComponent(consultationId)}/events?limit=${EVENT_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`)
      .then((page) => {
        if (generationRef.current !== generation) return;
        // 服务端每页页内升序、游标指向更早一页：旧页拼在当前列表之前，时间线保持升序。
        setEvents((current) => [...asEvents(page?.events), ...current]);
        setNextCursor(typeof page?.nextCursor === "string" ? page.nextCursor : null);
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        const code = statusOf(error);
        if (code === 401) {
          // 身份失效：全局身份重确认已由 adminRequest 触发；本地按撤敏规则清掉投影，
          // 不再保留旧咨询的处理记录。
          clearProjection("expired");
          return;
        }
        if (code === 403 || code === 404) {
          // 对象级拒绝（撤权/转交/结束/排除名单）：这不是网络抖动，旧投影与游标即刻清理，
          // 显示与首屏一致的拒绝态。
          clearProjection(code === 403 ? "forbidden" : "missing");
          return;
        }
        // 网络/5xx：不清掉已加载的记录，只把「加载更早」变成可重试的错误态。
        setEarlierFailed(true);
      })
      .finally(() => { if (generationRef.current === generation) setLoadingEarlier(false); });
  };

  return (
    <section className="im-wb-sec" aria-label="处理记录">
      <span><History size={12} />处理记录</span>
      {status === "loading" ? <small>正在读取处理记录…</small> : null}
      {status === "forbidden" ? <p className="im-wb-events-note" data-tone="warn"><ShieldCheck size={13} />当前账号无权查看该咨询的处理记录。</p> : null}
      {status === "missing" ? <p className="im-wb-events-note" data-tone="warn"><ShieldCheck size={13} />处理记录不可读：该咨询已结束、不存在，或当前账号不在可查看范围。</p> : null}
      {status === "expired" ? <p className="im-wb-events-note" data-tone="warn"><ShieldCheck size={13} />会话已失效，本地处理记录已清除；请重新登录后继续。</p> : null}
      {status === "error" ? <div className="im-wb-events-note" data-tone="error"><CircleAlert size={13} /><span>处理记录读取失败。</span><button type="button" className="im-wb-btn" data-action="retry-events" onClick={() => setAttempt((value) => value + 1)}>重新读取</button></div> : null}
      {status === "ready" && events.length === 0 ? <small>该咨询暂无处理记录。</small> : null}
      {events.length > 0 ? (
        <ol className="im-wb-events">
          {events.map((event) => (
            <li key={event.id} className="im-wb-event" data-type={typeof event.type === "string" ? event.type : "UNKNOWN"}>
              <span className="im-wb-event-tag">{EVENT_TYPE_LABELS[event.type] ?? event.type}</span>
              <time>{formatDateTime(event.occurredAt)}</time>
              <span className="im-wb-event-actor">{event.actor?.displayName ?? "未知"}</span>
              {event.from?.displayName || event.to?.displayName ? <span className="im-wb-event-move">{event.from?.displayName ?? ""} → {event.to?.displayName ?? ""}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {status === "ready" && nextCursor ? <button type="button" className="im-wb-btn" data-action="load-earlier-events" onClick={loadEarlier} disabled={loadingEarlier}>{loadingEarlier ? "正在读取更早记录…" : earlierFailed ? "更早记录读取失败，点击重试" : "加载更早的处理记录"}</button> : null}
    </section>
  );
}
