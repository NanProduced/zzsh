"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { ChevronDown, ChevronUp, FileText, RefreshCw } from "lucide-react";
import { RecoveryAlert, SkeletonBlock, StatusBadge } from "@/components/ui/information";
import { walletMoney } from "@/lib/personal-wallet-client";
import { historicalWithdrawalStatus } from "@/lib/controlled-withdrawal-client";
import { WithdrawalRequestError } from "@/lib/withdrawal-client-core";
import {
  readWithdrawalHistory,
  readWithdrawalHistoryItem,
  type WithdrawalHistoryDetail,
  type WithdrawalHistoryRead,
  type WithdrawalHistorySource,
} from "@/lib/withdrawal-history-client";
import {
  advanceWithdrawalTimeline,
  emptyWithdrawalTimeline,
  hasMoreWithdrawalTimeline,
  removeWithdrawalTimelineSource,
  WithdrawalTimelineSourceError,
  type TimelineItem,
  type TimelineState,
} from "@/lib/withdrawal-timeline";
import {
  type IdentityFailure,
  type ReadState,
  asError,
  timeLabel,
  errorCopy,
  ErrorDetails,
  channelStateLabel,
  useWithdrawalIdentity,
} from "./bank-binding-types";

export type HistorySource = Exclude<WithdrawalHistorySource, "ALL">;
export type HistoryRow = TimelineItem & { amount: string; label: string; note: string; mask?: string | null };
export type HistoryView = { availability: string; rows: HistoryRow[]; cursor: string | null; snapshot: string | null; asOf: string | null; coverageKnown: boolean };

export function historyView(source: HistorySource, reply: WithdrawalHistoryRead): HistoryView {
  if (source === "HISTORICAL") {
    const part = reply.sections.historical, data = part.data;
    return { availability: part.availability, rows: data?.items.map(item => ({ source, id: item.id, amount: item.amountCents, at: item.occurredAt, label: historicalWithdrawalStatus(item.sourceStatus), note: "到账情况未记录" })) ?? [], cursor: data?.nextCursor ?? null, snapshot: data?.snapshotVersion ?? null, asOf: data?.asOf ?? null, coverageKnown: data?.coverage.knowledge === "KNOWN" };
  }
  if (source === "LOCAL_CONTROLLED") {
    const part = reply.sections.controlled, data = part.data;
    return { availability: part.availability, rows: data?.items.map(item => ({ source, id: `controlled:${item.id}`, amount: item.amountCents, at: item.acceptedAt, label: item.state === "SUCCEEDED" ? "处理完成" : channelStateLabel[item.state] ?? "状态未确认", note: "测试记录，未实际打款" })) ?? [], cursor: data?.pagination?.nextCursor ?? null, snapshot: data?.pagination?.snapshotVersion ?? null, asOf: data?.pagination?.asOf ?? null, coverageKnown: Boolean(data?.pagination) };
  }
  const part = reply.sections.joinpay, data = part.data;
  return { availability: part.availability, rows: data?.items.map(item => ({ source, id: item.id, amount: item.amountCents, at: item.occurredAt, label: item.requiresReview ? "需要人工核对" : channelStateLabel[item.state] ?? "状态未确认", note: "到账情况未记录", mask: item.originalDestination?.cardMask ?? null })) ?? [], cursor: data?.nextCursor ?? null, snapshot: data?.snapshotVersion ?? null, asOf: data?.asOf ?? null, coverageKnown: Boolean(data) };
}

export function HistoryDetail({ value }: { value: WithdrawalHistoryDetail }) {
  const item = value.source === "LOCAL_CONTROLLED" ? value.item.intent : value.source === "JOINPAY" ? value.data.item : value.item;
  const joinpay = value.source === "JOINPAY" ? value.data.item : null;
  const historical = value.source === "HISTORICAL_WITHDRAWAL" ? value.item : null;
  return <><dl className="bank-facts"><div><dt>申请金额</dt><dd>{walletMoney(item.amountCents)}</dd></div><div><dt>提现净额</dt><dd>{walletMoney(item.netCents)}</dd></div><div><dt>手续费</dt><dd>{walletMoney(item.feeCents)}</dd></div>{historical ? <div><dt>原提现单号</dt><dd>{historical.originalNumber ?? "未记录"}</dd></div> : null}{joinpay ? <><div><dt>原收款银行卡</dt><dd>{joinpay.originalDestination?.cardMask ?? "原收款目标未提供"}</dd></div><div><dt>申请单号</dt><dd>{joinpay.merchantOrderNo}</dd></div><div><dt>交易流水号</dt><dd>{joinpay.platformSerialNo ?? "尚未提供"}</dd></div></> : null}<div><dt>到账情况</dt><dd>未记录</dd></div></dl><p className="bank-help">{value.source === "LOCAL_CONTROLLED" ? "这是测试记录，未向银行卡打款。" : <>{historical ? "金额按原记录展示；" : "金额按申请记录展示；"}到账情况请以收款记录为准。</>}</p></>;
}

export function WithdrawalHistorySection({ scope, refreshKey, onIdentityFailure }: { scope: string; refreshKey: number; onIdentityFailure?: IdentityFailure }) {
  const identity = useWithdrawalIdentity(scope, onIdentityFailure);
  const [state, setState] = useState<ReadState<TimelineState<HistoryRow>>>({ scope, value: null, busy: true, error: null });
  const [detail, setDetail] = useState<{ scope: string; source: HistorySource; id: string; value: WithdrawalHistoryDetail | null; busy: boolean; error: WithdrawalRequestError | null } | null>(null);
  const [visibleCount, setVisibleCount] = useState(5);
  const stateRef = useRef(state); stateRef.current = state;
  const abort = useRef<AbortController | null>(null), ticket = useRef(0), detailAbort = useRef<AbortController | null>(null), detailTicket = useRef(0);
  const visible = state.scope === scope && identity.ready ? state : { scope, value: null, busy: true, error: null };
  const load = async (reset = false) => {
    if (!identity.current() || !identity.userId || !reset && stateRef.current.busy) return;
    abort.current?.abort(); const controller = new AbortController(), run = ++ticket.current; abort.current = controller;
    if (reset) { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); setVisibleCount(5); }
    const prior = !reset && stateRef.current.scope === scope ? stateRef.current.value : null;
    setState({ scope, value: prior, busy: true, error: null });
    try {
      const next = await advanceWithdrawalTimeline(prior ?? emptyWithdrawalTimeline<HistoryRow>(), async (source, cursor) => {
        try {
          const part = historyView(source, await readWithdrawalHistory(identity.userId!, { source, cursor, limit: 20 }, controller.signal));
          return { items: part.rows, cursor: part.cursor, snapshot: part.snapshot, asOf: part.asOf, available: part.availability === "AVAILABLE", coverageKnown: part.coverageKnown };
        } catch (error) {
          const e = asError(error);
          if (cursor && e.status === 403) throw new WithdrawalTimelineSourceError(source, "WITHDRAWAL_SOURCE_FORBIDDEN");
          if (!cursor && (e.status === 403 || e.status === 404 || e.status === 502 || e.status === 503 || e.status === 0 || e.code === "EVIDENCE_UNAVAILABLE")) return { items: [], cursor: null, snapshot: null, asOf: null, available: false, coverageKnown: false };
          throw error;
        }
      });
      if (identity.current() && !controller.signal.aborted && run === ticket.current) setState({ scope, value: next, busy: false, error: null });
    } catch (error) {
      if (!identity.current() || controller.signal.aborted || run !== ticket.current) return;
      if (error instanceof WithdrawalTimelineSourceError) {
        detailTicket.current++; detailAbort.current?.abort(); setDetail(null);
        setState({ scope, value: prior ? removeWithdrawalTimelineSource(prior, error.source) : null, busy: false, error: new WithdrawalRequestError(403, "WITHDRAWAL_SOURCE_CHANGED") });
        return;
      }
      const e = error instanceof WithdrawalRequestError ? error : new WithdrawalRequestError(409, "WITHDRAWAL_SNAPSHOT_CHANGED");
      if (e.status === 401 || e.status === 409) { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); }
      setState({ scope, value: e.status === 401 || e.status === 409 ? null : prior, busy: false, error: e }); identity.identityFailure(e);
    }
  };
  useEffect(() => {
    setState({ scope, value: null, busy: true, error: null }); setDetail(null); setVisibleCount(5);
    if (identity.ready) void load(true);
    return () => { ticket.current++; detailTicket.current++; abort.current?.abort(); detailAbort.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, identity.ready, identity.userId, refreshKey]);
  const openDetail = async (recordId: string, source: HistorySource) => {
    if (!identity.current() || !identity.userId) return;
    detailAbort.current?.abort(); const controller = new AbortController(), run = ++detailTicket.current; detailAbort.current = controller;
    setDetail({ scope, source, id: recordId, value: null, busy: true, error: null });
    try { const value = await readWithdrawalHistoryItem(identity.userId, recordId, controller.signal); if (identity.current() && !controller.signal.aborted && run === detailTicket.current) setDetail({ scope, source, id: recordId, value, busy: false, error: null }); }
    catch (error) { if (identity.current() && !controller.signal.aborted && run === detailTicket.current) { const e = asError(error); if (e.status === 401 || e.status === 403) { ticket.current++; abort.current?.abort(); abort.current = null; if (e.status === 401) setState({ scope, value: null, busy: false, error: e }); else setState(current => ({ ...current, value: current.value ? removeWithdrawalTimelineSource(current.value, source) : null, busy: false, error: e })); } setDetail({ scope, source, id: recordId, value: null, busy: false, error: e }); identity.identityFailure(e); } }
  };
  const closeDetail = () => { detailTicket.current++; detailAbort.current?.abort(); setDetail(null); };
  const rows = visible.value?.items ?? [];
  const displayedRows = rows.slice(0, visibleCount);
  const hasMoreLocalRows = rows.length > visibleCount;

  return <section className="account-module-card bank-history-section" aria-label="提现记录">
    <div className="bank-section-heading"><h3><FileText size={18} aria-hidden="true" />提现记录</h3><Button variant="tertiary" className="bank-action" isDisabled={visible.busy} onPress={() => void load(true)} aria-label="刷新提现记录"><RefreshCw size={15} aria-hidden="true" />刷新</Button></div>
    <p className="bank-help">按申请时间查看记录，处理记录不代表银行已到账。</p>
    {visible.busy && !visible.value ? <SkeletonBlock label="正在读取提现记录" lines={2} /> : null}
    {visible.value?.partial ? <RecoveryAlert tone="unknown" title="部分记录暂时无法确认" problem="当前列表可能不完整，请稍后刷新；已显示的记录仍可查看。" /> : null}
    {visible.value?.temporalTies ? <p className="bank-help">同一时间的记录顺序可能有差异。</p> : null}
    {displayedRows.length ? <div className="bank-history-rows">{displayedRows.map(row => {
      const isRowDetailOpen = detail?.id === row.id && detail?.scope === scope && identity.ready;
      return <article key={row.id} className={`bank-history-row${isRowDetailOpen ? " is-expanded" : ""}`}>
        <div className="bank-history-row-header">
          <div><StatusBadge tone="neutral">{row.label}</StatusBadge><p>{timeLabel(row.at)}</p><small>{row.mask !== undefined ? `原收款卡：${row.mask ?? "未提供"} · ` : ""}{row.note}</small></div>
          <strong>{walletMoney(row.amount)}</strong>
          <Button variant="tertiary" className="bank-action" onPress={() => (isRowDetailOpen ? closeDetail() : void openDetail(row.id, row.source))} aria-label={isRowDetailOpen ? "收起提现详情" : "查看提现详情"}>
            {isRowDetailOpen ? "收起" : "详情"}
            {isRowDetailOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
          </Button>
        </div>
        {isRowDetailOpen ? <div className="bank-history-detail" aria-label="提现详情"><div className="bank-section-heading"><h4>申请详情</h4><Button variant="tertiary" className="bank-action" onPress={closeDetail}>收起详情</Button></div>{detail.busy ? <SkeletonBlock label="正在读取申请详情" lines={2} /> : detail.error ? <RecoveryAlert tone="error" title="详情暂时无法读取" problem={errorCopy(detail.error)} action={<Button variant="secondary" className="bank-action" onPress={() => void openDetail(detail.id, detail.source)}>重试详情</Button>} /> : detail.value ? <HistoryDetail value={detail.value} /> : null}</div> : null}
      </article>;
    })}</div> : visible.value && !visible.value.partial && !hasMoreWithdrawalTimeline(visible.value) ? <p className="bank-empty-text">当前没有可显示的提现记录。</p> : null}
    {visible.error ? <RecoveryAlert tone="error" live title="提现记录读取未完成" problem={errorCopy(visible.error)} action={<Button variant="secondary" className="bank-action" isDisabled={visible.busy} onPress={() => void load(!visible.value || visible.error?.status === 403)}>重新读取</Button>} details={{ summary: "查看查询信息", body: <ErrorDetails error={visible.error} /> }} /> : null}
    {hasMoreLocalRows ? (
      <Button variant="secondary" className="bank-action bank-history-more" onPress={() => setVisibleCount(c => c + 5)}>
        查看更多记录（已显示 {displayedRows.length} / 共 {rows.length} 条）
      </Button>
    ) : visible.value && hasMoreWithdrawalTimeline(visible.value) && !visible.error ? (
      <Button variant="secondary" className="bank-action bank-history-more" isDisabled={visible.busy} onPress={() => void load()}>
        {visible.busy ? "正在读取…" : "加载更多记录"}
      </Button>
    ) : null}
  </section>;
}
