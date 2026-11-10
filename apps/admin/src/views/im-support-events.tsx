"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, History, ShieldCheck } from "lucide-react";
import { AdminApiError } from "../api";
import { formatDateTime } from "./im-support-format";
import { CONSULTATION_EVENT_VOCABULARY, formatEventMovement, formatVocabulary } from "./im-support-vocabulary";

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
export type ConsultationEventSummary = { consultationId: string; status: LoadStatus; latest: ConsultationEvent | null };

const EVENT_PAGE_LIMIT = 20;
// 折叠时只露出最近两条；上屏顺序仍是升序，最近两条就是列表尾部。
const COLLAPSED_EVENT_COUNT = 2;


type LoadStatus = "loading" | "ready" | "error" | "forbidden" | "missing" | "expired";

export type RoundItem = {
  id: string;
  roundSeq: string;
  state: string;
  assignedAdmin: { name?: string | null } | null;
  /** Viewer-scoped Team handle for this round; null means no readable round history. */
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  closedAt: string | null;
  transferCount: string;
};

type RoundPage = { contractVersion?: unknown; consultationId?: unknown; rounds?: unknown; nextCursor?: unknown };

const ROUND_STATE_LABEL: Record<string, string> = {
  WAITING: "等待接待",
  ACTIVE: "接待中",
  CLOSED: "已结束",
};

export function asRoundPage(value: unknown): { rounds: RoundItem[]; nextCursor: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ROUNDS");
  const page = value as RoundPage;
  if (page.contractVersion !== "admin-consultation-rounds.v1" || !Array.isArray(page.rounds)) throw new Error("INVALID_ROUNDS");
  const rounds = page.rounds.flatMap((entry): RoundItem[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id) ? row.id : "";
    const roundSeq = typeof row.roundSeq === "string" && /^[1-9][0-9]{0,18}$/.test(row.roundSeq) ? row.roundSeq : "";
    const state = typeof row.state === "string" && ["WAITING", "ACTIVE", "CLOSED"].includes(row.state) ? row.state : "";
    const createdAt = typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : "";
    if (!id || !roundSeq || !state || !createdAt) return [];
    const admin = row.assignedAdmin && typeof row.assignedAdmin === "object" && !Array.isArray(row.assignedAdmin)
      ? { name: typeof (row.assignedAdmin as { name?: unknown }).name === "string" ? (row.assignedAdmin as { name: string }).name : null }
      : null;
    const transferCount = typeof row.transferCount === "string" && /^(0|[1-9][0-9]{0,18})$/.test(row.transferCount) ? row.transferCount : "0";
    return [{
      id, roundSeq, state, assignedAdmin: admin,
      conversationId: typeof row.conversationId === "string" && row.conversationId ? row.conversationId : null,
      createdAt,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : createdAt,
      lastMessageAt: typeof row.lastMessageAt === "string" ? row.lastMessageAt : null,
      closedAt: typeof row.closedAt === "string" && Number.isFinite(Date.parse(row.closedAt)) ? row.closedAt : null,
      transferCount,
    }];
  });
  return { rounds, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null };
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof AdminApiError) return error.status;
  return error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
}

function asEvents(value: unknown): ConsultationEvent[] {
  if (!Array.isArray(value)) return [];
  return value as ConsultationEvent[];
}

export function ConsultationEventsCard({ consultationId, request, onSummary }: { consultationId: string; request: EventsRequest; onSummary?: (summary: ConsultationEventSummary) => void }) {
  const [events, setEvents] = useState<ConsultationEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 每（咨询，重试代次）一代：切换咨询或重读后，迟到的旧响应直接丢弃。
  const generationRef = useRef("");

  // 切换咨询回到默认折叠：上一条会话展开过，不代表这一条也要全量铺开。
  useEffect(() => { setExpanded(false); }, [consultationId]);

  // 投诉摘要只需要最新节点；时间线本身仍是唯一的数据源，不额外发请求。
  useEffect(() => {
    onSummary?.({ consultationId, status, latest: events.length ? events[events.length - 1] ?? null : null });
  }, [consultationId, events, onSummary, status]);

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
          {events.map((event, index) => (
            <li key={event.id} className="im-wb-event" hidden={!expanded && index < events.length - COLLAPSED_EVENT_COUNT} data-type={typeof event.type === "string" ? event.type : "UNKNOWN"}>
              <span className="im-wb-event-tag">{formatVocabulary(CONSULTATION_EVENT_VOCABULARY, event.type, event.type)}</span>
              <time>{formatDateTime(event.occurredAt)}</time>
              <span className="im-wb-event-actor">{event.actor?.displayName ?? "未知"}</span>
              {formatEventMovement(event.from?.displayName, event.to?.displayName) ? (
                <span className="im-wb-event-move">{formatEventMovement(event.from?.displayName, event.to?.displayName)}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {events.length > COLLAPSED_EVENT_COUNT ? <button type="button" className="im-wb-btn" data-action="toggle-events" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起处理记录" : "查看全部处理记录"}</button> : null}
      {status === "ready" && nextCursor ? <button type="button" className="im-wb-btn" data-action="load-earlier-events" onClick={loadEarlier} disabled={loadingEarlier}>{loadingEarlier ? "正在读取更早记录…" : earlierFailed ? "更早记录读取失败，点击重试" : "加载更早的处理记录"}</button> : null}
    </section>
  );
}

type RoundLoadStatus = "idle" | "loading" | "ready" | "error" | "forbidden" | "missing";

/**
 * Public round ledger: every support reader can see all rounds of the selected
 * thread. It shows events only; chat history stays in the normal conversation
 * reader, and user ratings are deliberately absent.
 */
export function ConsultationRoundsTimeline({ consultationId, currentRoundId, request }: {
  consultationId: string;
  currentRoundId: string;
  request: EventsRequest;
}) {
  const [open, setOpen] = useState(false);
  const [rounds, setRounds] = useState<RoundItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<RoundLoadStatus>("idle");
  const [message, setMessage] = useState("");
  const [expandedRound, setExpandedRound] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setOpen(false);
    setRounds([]);
    setNextCursor(null);
    setStatus("idle");
    setMessage("");
    setExpandedRound(null);
    setLoadingMore(false);
  }, [consultationId]);

  const load = async (cursor?: string) => {
    const generation = ++generationRef.current;
    if (cursor) setLoadingMore(true);
    else {
      setRounds([]);
      setNextCursor(null);
      setStatus("loading");
    }
    setMessage("");
    try {
      const query = new URLSearchParams({ limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const value = await request<unknown>(`/im/consultations/${encodeURIComponent(consultationId)}/rounds?${query}`);
      if (generationRef.current !== generation) return;
      const page = asRoundPage(value);
      setRounds((current) => cursor ? [...current, ...page.rounds] : page.rounds);
      setNextCursor(page.nextCursor);
      setStatus("ready");
    } catch (error) {
      if (generationRef.current !== generation) return;
      const code = statusOf(error);
      setStatus(code === 403 || code === 401 ? "forbidden" : code === 404 ? "missing" : "error");
      setMessage(code === 403 || code === 401 ? "当前账号无权查看咨询轮次。" : code === 404 ? "咨询不存在或轮次不可读取。" : "咨询轮次读取失败。");
    } finally {
      if (generationRef.current === generation) setLoadingMore(false);
    }
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
      setExpandedRound(null);
      return;
    }
    setOpen(true);
    if (status === "idle" || status === "error") void load();
  };

  return (
    <section className="im-wb-sec im-wb-rounds" aria-label="历史轮次">
      <span><History size={12} />历史轮次</span>
      <button type="button" className="im-wb-btn" data-action="toggle-rounds" aria-expanded={open} onClick={toggle}>{open ? "收起历史轮次" : "查看历史轮次"}</button>
      {open ? <div className="im-wb-round-scroll" aria-busy={status === "loading" || loadingMore}>
        {status === "loading" ? <small>正在读取咨询轮次…</small> : null}
        {status === "forbidden" || status === "missing" || status === "error" ? <p className="im-wb-events-note" data-tone="warn"><ShieldCheck size={13} />{message}</p> : null}
        {status === "ready" && rounds.length === 0 ? <small>该咨询暂无轮次记录。</small> : null}
        {rounds.length ? <ol className="im-wb-rounds-timeline">
          {rounds.map((round) => {
            const current = round.id === currentRoundId;
            const expanded = expandedRound === round.id;
            return <li key={round.id} className="im-wb-round" data-current={current ? "true" : undefined} data-state={round.state}>
              <span className="im-wb-round-dot" aria-hidden="true" />
              <div className="im-wb-round-body">
                <header className="im-wb-round-head">
                  <strong>第 {round.roundSeq} 轮</strong>
                  <span className="im-wb-round-state">{ROUND_STATE_LABEL[round.state] ?? "状态未记录"}</span>
                  {current ? <span className="im-wb-round-current">本轮</span> : null}
                </header>
                <p className="im-wb-round-meta">接待：{round.assignedAdmin?.name?.trim() || "未分配"}</p>
                <p className="im-wb-round-meta">
                  <time>{formatDateTime(round.createdAt)}</time>
                  {round.state === "CLOSED" ? ` → ${round.closedAt ? formatDateTime(round.closedAt) : "结束时间未记录"}` : " · 进行中"}
                </p>
                {round.transferCount !== "0" ? <p className="im-wb-round-meta">转交 {round.transferCount} 次</p> : null}
                <button type="button" className="im-wb-round-events-toggle" data-action="toggle-round-events" aria-expanded={expanded} onClick={() => setExpandedRound(expanded ? null : round.id)}>{expanded ? "收起处理记录" : "查看处理记录"}</button>
                {expanded ? <ConsultationEventsCard consultationId={round.id} request={request} /> : null}
              </div>
            </li>;
          })}
        </ol> : null}
        {status === "ready" && nextCursor ? <button type="button" className="im-wb-btn" data-action="load-earlier-rounds" onClick={() => void load(nextCursor)} disabled={loadingMore}>{loadingMore ? "正在读取更早轮次…" : "加载更早轮次"}</button> : null}
      </div> : null}
    </section>
  );
}
