"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, CircleSlash, Clock3, RefreshCw, WalletCards } from "lucide-react";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import {
  orderApi,
  orderIntentKey,
  OrderRequestError,
  type Order,
  type OrderParty,
  type OrderSettlement,
  type SettlementOpening,
  type SettlementPreview,
  type SettlementVersion,
} from "@/lib/order-client";
import { clearIntent, isIntentStale, loadIntent, saveIntent, type IntentKind } from "@/lib/order-intents";
import { cancelEntryOpen, chargeRowLabel, consumptionRows, decisionAmountRows, isAdjustedVersion, moneyCents, moneyText, paymentEntryOpen, postingAmountRows, previewAmounts, proposedConfirmationCents, quantityText, resourceName, settlementAmountRows, unitHint, type SettlementAmountRow } from "@/lib/order-display";
import "./order.css";

type PanelError = { message: string; retryable: boolean };
export type WriteOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "unknown"; message: string }
  | { status: "unauthorized"; error: OrderRequestError }
  | { status: "blocked"; message: string }
  | { status: "recovery-unresolved"; error: OrderRequestError }
  | { status: "definitive"; error: OrderRequestError };

/** Facts the detail banner may state, and only what the settlement read actually returned. */
export type OrderStageFacts = {
  rentalStarted: boolean;
  phase: "RENTING" | "INTAKE_PENDING" | "DECISION_PENDING" | "DECISION_REJECTED" | "DECISION_WAITING" | "POSTED";
  early: boolean;
  postedAt: string | null;
  openingVersionNo: string | null;
  settlementVersionNo: string | null;
  openingConfirmedAt: string | null;
  myAck: boolean;
  otherAck: boolean;
  /** This party's final settlement figure, straight from the posting's final column. `null` until posted. */
  settled: { label: string; text: string } | null;
};

function writeError(error: unknown): string {
  if (error instanceof OrderRequestError) {
    if (error.status === 0 || error.status === 502) return "网络或网关中断，原请求结果未知；可查询原请求，不会重复执行。";
    return error.message || "操作未完成，请稍后重试。";
  }
  return "操作未完成，请稍后重试。";
}

/**
 * Freeze key/body/context before a write and never overwrite an existing intent: a retry or a
 * recovery consumes the original frozen body, not whatever the caller passes now. Age only
 * disables automatic replay (callers must read authority first); it never releases the intent.
 * A 4xx on a fresh key is a definitive non-commit; a 4xx while recovering an existing intent is
 * returned as `recovery-unresolved` and only an authoritative read may release it.
 */
export async function performGuardedWrite<T>(
  userId: string | null,
  kind: IntentKind,
  resourceId: string,
  body: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  request: (key: string, body: Record<string, unknown>, context: Record<string, unknown> | undefined) => Promise<T>,
): Promise<WriteOutcome<T>> {
  if (!userId) return { status: "definitive", error: new OrderRequestError(401, null) };
  const existing = loadIntent(userId, kind, resourceId);
  let key: string, frozenBody: Record<string, unknown>, frozenContext: Record<string, unknown> | undefined;
  if (existing) {
    key = existing.key;
    frozenBody = existing.body;
    frozenContext = existing.context;
  } else {
    const saved = saveIntent({ userId, kind, resourceId, key: orderIntentKey(), body, context });
    if (!saved.persisted) return { status: "blocked", message: "浏览器会话存储不可用，无法保存原请求恢复信息；为避免产生不可恢复的写入，本次提交已阻止。" };
    key = saved.intent.key;
    frozenBody = saved.intent.body;
    frozenContext = saved.intent.context;
  }
  try {
    const value = await request(key, frozenBody, frozenContext);
    clearIntent(userId, kind, resourceId);
    return { status: "ok", value };
  } catch (error) {
    const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
    if (typed.status === 401 || typed.code === "UNAUTHENTICATED") return { status: "unauthorized", error: typed };
    if (typed.status === 0 || typed.status >= 500) return { status: "unknown", message: writeError(error) };
    if (existing) return { status: "recovery-unresolved", error: typed };
    clearIntent(userId, kind, resourceId);
    return { status: "definitive", error: typed };
  }
}

function panelError(error: unknown): PanelError {
  if (error instanceof OrderRequestError) {
    if (error.status === 0) return { message: "网络中断，结果未知。原请求可安全重试，不会重复扣款或重复记账。", retryable: true };
    if (error.status === 401 || error.code === "UNAUTHENTICATED") return { message: "登录状态已变化；原请求与幂等键已保留，确认身份后可恢复。", retryable: false };
    if (error.status === 403) return { message: "当前身份没有这项操作权限。", retryable: false };
    if (error.status === 404) return { message: "当前对象不存在或当前环境未开启这项交易操作。", retryable: false };
    if (error.status === 409) return { message: "服务端状态与本次请求不一致；已按权威状态刷新，请按最新结果操作。", retryable: false };
    if (error.status === 503) return { message: error.message || "依赖的服务端依据暂不可用。", retryable: true };
    return { message: error.message || "操作未完成，请稍后重试。", retryable: true };
  }
  return { message: "操作未完成，请稍后重试。", retryable: true };
}

const AUTH_MESSAGE = "登录状态已变化；原请求与幂等键已保留。正在确认身份，确认后可在本页恢复。";
const BLOCKED_MESSAGE = "浏览器会话存储不可用，无法保存原请求恢复信息；已阻止提交。请启用会话存储后重试。";
const STALE_MESSAGE = "该原请求已超出自动查询窗口；请先刷新权威状态核对，确认未生效后再重新操作。";

function partyLabel(party: string): string {
  if (party === "RENTER") return "租客";
  if (party === "OWNER") return "号主";
  if (party === "SUPPORT") return "客服";
  return party;
}

function UnknownNotice({ label, message, onQuery, onOpenOrder }: { label: string; message: string; onQuery: () => void; onOpenOrder?: () => void }) {
  return <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>{label}</strong><span>{message}</span></div>
    <div className="order-trade-actions">
      <button type="button" className="button secondary button--sm" onClick={onQuery}><RefreshCw size={14} aria-hidden="true" />查询原请求结果</button>
      {onOpenOrder ? <button type="button" className="button quiet button--sm" onClick={onOpenOrder}>刷新订单</button> : null}
    </div>
  </div>;
}

function AmountTable({ rows, caption }: { rows: SettlementAmountRow[]; caption: string }) {
  if (rows.length === 0) return null;
  return <table className="order-trade-amounts" aria-label={caption}>
    <caption>{caption}</caption>
    <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.value}{row.note ? <small>{row.note}</small> : null}</td></tr>)}</tbody>
  </table>;
}

function RecordList({ title, records }: { title: string; records: Array<{ label: string; time?: string | null }> }) {
  if (records.length === 0) return null;
  return <div className="order-records">
    <h3>{title}</h3>
    <ul>{records.map((record, index) => <li key={`${record.label}-${index}`}><span className="order-record-mark" aria-hidden="true"><CheckCircle2 size={13} /></span><span>{record.label}</span>{record.time ? <time dateTime={record.time}>{new Date(record.time).toLocaleString("zh-CN")}</time> : <span className="order-muted">待确认</span>}</li>)}</ul>
  </div>;
}

function PaymentAction({ order, party, onChanged }: { order: Order; party: OrderParty; onChanged: () => void }) {
  const session = useUserSession();
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [error, setError] = useState<PanelError | null>(null);
  const [receipt, setReceipt] = useState<{ disposition: string; reasonCode?: string | null; replay: boolean } | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [cancelUnknown, setCancelUnknown] = useState<string | null>(null);
  const reset = useCallback(() => { setBusy(false); setUnknown(null); setError(null); setReceipt(null); setCancelArmed(false); setCancelUnknown(null); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const payment = loadIntent(userId, "order.payment", order.id);
    if (payment) setUnknown(isIntentStale(payment) ? STALE_MESSAGE : "检测到本订单有一笔结果未知的支付请求；原幂等键已冻结。");
    const cancel = loadIntent(userId, "order.cancel", order.id);
    if (cancel) setCancelUnknown(isIntentStale(cancel) ? STALE_MESSAGE : "检测到本订单有一笔结果未知的取消请求；原幂等键已冻结。");
  }, [userId, order.id]);
  const applyOutcome = (acting: string, outcome: WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, kind: "pay" | "cancel") => {
    const fail = (typed: OrderRequestError) => {
      setError(panelError(typed));
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void session.confirm();
    };
    if (outcome.status === "ok") {
      if (kind === "pay") {
        setReceipt(outcome.value.payment);
        if (outcome.value.payment.disposition === "APPLIED") onChanged();
      } else onChanged();
      return;
    }
    if (outcome.status === "unknown") { kind === "pay" ? setUnknown(outcome.message) : setCancelUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError({ message: BLOCKED_MESSAGE, retryable: false }); return; }
    if (outcome.status === "unauthorized") { fail(outcome.error); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting, outcome.error, kind); return; }
    fail(outcome.error);
    onChanged();
  };
  /** A read can only describe the observed state; only the original-key receipt may release the lock. */
  const resolveRecovery = async (acting: string, typed: OrderRequestError, kind: "pay" | "cancel") => {
    const label = kind === "pay" ? "支付" : "取消";
    try {
      const authority = await orderApi.paymentStatus(order.id);
      if (!isCurrent(acting)) return;
      const observed = authority.payment
        ? `服务端已有付款记录（${authority.payment.disposition}）`
        : `当前订单状态 ${authority.order.status}，暂未观察到付款记录`;
      const message = `原${label}请求仍未取得确定回执（原幂等键保留）。${observed}；读取结果不构成“已生效/未生效”证明，请稍后再次查询或联系客服核对。`;
      if (kind === "pay") setUnknown(message); else setCancelUnknown(message);
    } catch {
      if (isCurrent(acting)) {
        const message = `原${label}请求仍未取得确定回执；权威状态暂时无法读取（${typed.message || "读取失败"}）。原请求保留，请稍后再次查询。`;
        if (kind === "pay") setUnknown(message); else setCancelUnknown(message);
      }
    }
  };
  const pay = async () => {
    if (!userId) return;
    const acting = userId;
    setBusy(true); setError(null); setUnknown(null);
    const outcome = await performGuardedWrite(acting, "order.payment", order.id, {}, undefined,
      (key) => orderApi.pay(order.id, key));
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "pay");
  };
  const queryPayment = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.payment", order.id)) { setUnknown(null); onChanged(); return; }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "order.payment", order.id, {}, undefined, (key) => orderApi.pay(order.id, key));
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "pay");
  };
  const cancel = async () => {
    if (!userId) return;
    const acting = userId;
    setBusy(true); setError(null); setCancelUnknown(null);
    const outcome = await performGuardedWrite(acting, "order.cancel", order.id, {}, undefined, (key, body) => orderApi.cancel(order.id, key, typeof body.reason === "string" ? body.reason : undefined));
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "cancel");
  };
  const queryCancel = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.cancel", order.id)) { setCancelUnknown(null); onChanged(); return; }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "order.cancel", order.id, {}, undefined, (key, body) => orderApi.cancel(order.id, key, typeof body.reason === "string" ? body.reason : undefined));
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "cancel");
  };
  const payLocked = busy || receipt !== null || unknown !== null || cancelUnknown !== null;
  const cancelLocked = busy || receipt !== null || unknown !== null || cancelUnknown !== null;
  const paymentOpen = paymentEntryOpen(order);
  const cancelOpen = cancelEntryOpen(order);
  const expired = order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel === true;
  return <section className="order-detail-section order-trade-panel" aria-label="支付与取消">
    <div className="order-trade-heading"><h2 className="order-section-title">支付与取消</h2></div>
    {receipt?.disposition === "APPLIED" ? <div className="order-notice is-success" role="status"><CheckCircle2 size={17} aria-hidden="true" /><div><strong>支付已接纳{receipt.replay ? "（原回执重放）" : ""}</strong><span>订单状态以服务端记录为准；支付不等于交付、建群或开租。</span></div></div> : null}
    {expired ? <div className="order-notice is-warning" role="status"><Clock3 size={17} aria-hidden="true" /><div><strong>已到期，取消处理中</strong><span>占用时间以订单记录为准；系统正在按序释放该账号，不再接受新的支付。</span></div></div> : null}
    {party === "renter" ? <p className="order-muted">订单的支付与取消都会冻结原请求：结果未知时只能查询原请求，不会重复提交；两个动作互斥，未决期间同时锁定。</p> : null}
    {receipt?.disposition === "REVIEW_REQUIRED" ? <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>支付结果需要人工核对</strong><span>原因：{receipt.reasonCode ?? "待确认"}。未重复扣款；不再新发起支付，等待平台核对。</span></div></div> : null}
    {unknown ? <UnknownNotice label="支付结果未知" message={unknown} onQuery={() => void queryPayment()} onOpenOrder={onChanged} /> : null}
    {cancelUnknown ? <UnknownNotice label="取消结果未知" message={cancelUnknown} onQuery={() => void queryCancel()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
    {party === "renter" ? <div className="order-trade-actions">
      {paymentOpen ? <button type="button" className="button" onClick={() => void pay()} disabled={payLocked}>
        <WalletCards size={15} aria-hidden="true" />{busy ? "提交支付请求…" : "提交支付"}
      </button> : <p className="order-muted">当前订单不可继续支付；请刷新查看最新订单记录。</p>}
      {cancelOpen ? (!cancelArmed ? <button type="button" className="button quiet" onClick={() => setCancelArmed(true)} disabled={cancelLocked}>取消订单</button> :
        <span className="order-trade-confirm">确认取消该订单？账号占用将释放。<button type="button" className="button secondary button--sm" onClick={() => void cancel()} disabled={cancelLocked}>{busy ? "取消中…" : "确认取消"}</button><button type="button" className="button quiet button--sm" onClick={() => setCancelArmed(false)} disabled={busy}>保留订单</button></span>) : null}
    </div> : <p className="order-muted">等待租客完成支付；订单不提供代付或代为接单操作。</p>}
    <p className="order-trade-note">当前为本地受控收款环境：服务端生成明确的本地收款依据，不发生真实渠道扣款。</p>
  </section>;
}

function OpeningLines({ order, opening, heading }: { order: Order; opening: SettlementOpening; heading: string }) {
  return <table className="order-trade-lines"><thead><tr><th scope="col">资源</th><th scope="col">{heading}</th></tr></thead>
    <tbody>{opening.lines.map((line) => <tr key={line.itemId}>
      <td>{resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(resourceName(order, line.itemId), line.unit)}</span></td>
      <td>{quantityText(line.unit, line.quantity ?? "0")}</td>
    </tr>)}</tbody></table>;
}

function OpeningPanel({ opening, order, party, onChanged }: { opening: SettlementOpening; order: Order; party: OrderParty; onChanged: () => void }) {
  const session = useUserSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const reset = useCallback(() => { setBusy(false); setError(null); setUnknown(null); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "opening.confirm", order.id);
    if (intent) setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的期初确认；原幂等键已冻结。");
  }, [userId, order.id]);
  const myParty = party.toUpperCase();
  const acks = opening.acks ?? [];
  const acked = acks.some((ack) => ack.party === myParty);
  const otherAcked = acks.some((ack) => ack.party !== myParty);
  const confirmed = opening.status === "CONFIRMED";
  const tag = confirmed ? "双方已确认" : acked && otherAcked ? "双方已确认" : acked ? "你已确认 · 对方待确认" : otherAcked ? `${partyLabel(acks.find((ack) => ack.party !== myParty)?.party ?? "")}已确认 · 你待确认` : "待双方确认";
  const apply = (acting: string, outcome: WriteOutcome<OrderSettlement>) => {
    if (outcome.status === "ok") { onChanged(); return; }
    if (outcome.status === "unknown") { setUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError({ message: BLOCKED_MESSAGE, retryable: false }); return; }
    if (outcome.status === "unauthorized") { setError(panelError(outcome.error)); void session.confirm(); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting); return; }
    setError(panelError(outcome.error));
    onChanged();
  };
  /** Only a receipt on the original opening/version may release the lock; a projection only observes. */
  const resolveRecovery = async (acting: string) => {
    const intent = loadIntent(acting, "opening.confirm", order.id);
    const targetId = typeof intent?.context?.openingId === "string" ? intent.context.openingId : "";
    const targetVersion = Number(intent?.body?.versionNo ?? 0);
    if (!targetId || !Number.isInteger(targetVersion) || targetVersion < 1) {
      setUnknown("原请求缺少目标期初标识或版本，不能按当前页面对象恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    try {
      const authority = await orderApi.settlement(order.id);
      if (!isCurrent(acting)) return;
      const target = authority.openings.find((candidate) => candidate.id === targetId);
      const myAck = target?.acks?.some((ack) => ack.party === myParty) ?? false;
      if (target && myAck) {
        clearIntent(acting, "opening.confirm", order.id);
        setUnknown(null);
        setError({ message: target.status === "CONFIRMED" ? "服务端已记录双方确认，期初已生效。" : "服务端已记录你的期初确认，等待对方确认。", retryable: false });
        onChanged();
        return;
      }
      const observed = target ? `原目标期初当前状态 ${target.status}` : "未在原结算记录中找到该期初版本";
      setUnknown(`原期初确认仍未取得确定回执（原幂等键保留）。${observed}；读取结果不构成“已生效/未生效”证明，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原期初确认仍未取得确定回执；权威结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const confirm = async () => {
    if (!userId) return;
    const acting = userId;
    setBusy(true); setError(null); setUnknown(null);
    const outcome = await performGuardedWrite(acting, "opening.confirm", order.id, { versionNo: Number(opening.versionNo) },
      { openingId: opening.id, orderId: order.id },
      (key, body) => orderApi.confirmOpening(order.id, opening.id, Number(body.versionNo), key));
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const query = async () => {
    if (!userId) return;
    const acting = userId;
    const intent = loadIntent(acting, "opening.confirm", order.id);
    if (!intent) { setUnknown(null); onChanged(); return; }
    const targetId = typeof intent.context?.openingId === "string" ? intent.context.openingId : "";
    if (!targetId) {
      setUnknown("原请求缺少目标期初标识，不能按当前页面对象恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "opening.confirm", order.id, { versionNo: Number(opening.versionNo) },
      { openingId: opening.id, orderId: order.id },
      (key, body, frozenContext) => orderApi.confirmOpening(order.id, String(frozenContext?.openingId ?? ""), Number(body.versionNo), key));
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  return <div className="order-trade-block">
    <h3>{confirmed ? "已确认期初库存" : "期初库存确认"} <span className="order-trade-tag">第{opening.versionNo}版</span> <span className="order-trade-tag is-accent">{tag}</span></h3>
    <p className="order-muted">{confirmed ? "以下为双方确认的开租库存，开租后按结算记录核对消耗。" : "期初数量由客服按交付时的实际库存代录；与预付款一致并双方确认同一版本后才开始计租。付款、建群与沟通都不等于已开租。"}</p>
    <OpeningLines order={order} opening={opening} heading={confirmed ? "开租时数量" : "期初数量"} />
    {unknown ? <UnknownNotice label="期初确认结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
    {!confirmed && !acked && !unknown ? <button type="button" className="button" onClick={() => void confirm()} disabled={busy}>{busy ? "确认中…" : "确认期初并开租"}</button> : null}
    {!confirmed && acked ? <p className="order-muted"><Clock3 size={14} aria-hidden="true" /> 已提交确认；等待对方确认后正式开租。</p> : null}
    <RecordList title="确认记录" records={acks.map((ack) => ({ label: `${partyLabel(ack.party)}确认期初`, time: ack.createdAt ?? null }))} />
    {opening.confirmedAt ? <p className="order-muted">开租时间：{new Date(opening.confirmedAt).toLocaleString("zh-CN")}</p> : null}
  </div>;
}

function ConsumedTable({ order, opening, remaining, consumed }: { order: Order; opening: SettlementOpening; remaining: Record<string, string>; consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> } | null }) {
  return <table className="order-trade-lines"><thead><tr><th scope="col">资源</th><th scope="col">期初</th><th scope="col">期末剩余</th><th scope="col">本次实耗</th></tr></thead>
    <tbody>{opening.lines.map((line) => {
      const open = line.quantity ?? "0";
      const rest = remaining[line.itemId] ?? "";
      const valid = /^\d+$/.test(rest) && BigInt(rest) <= BigInt(open);
      const derived = valid ? (BigInt(open) - BigInt(rest)).toString() : null;
      const serverLine = consumed?.items?.find((item) => item.itemId === line.itemId);
      const used = line.pricingKind === "HAFF_RATIO" && consumed?.haff !== undefined && consumed.haff !== null
        ? String(consumed.haff)
        : serverLine?.consumed ?? derived;
      return <tr key={line.itemId}>
        <td>{resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(resourceName(order, line.itemId), line.unit)}</span></td>
        <td>{quantityText(line.unit, open)}</td>
        <td>{rest === "" ? "待确认" : quantityText(line.unit, rest)}</td>
        <td>{used === null || used === undefined ? "待确认" : quantityText(line.unit, used)}</td>
      </tr>;
    })}</tbody></table>;
}

function ConsumptionTable({ order, opening, version }: { order: Order; opening: SettlementOpening | null; version: SettlementVersion | null | undefined }) {
  const rows = consumptionRows(order, opening, version);
  if (rows.length === 0) return null;
  return <table className="order-trade-lines"><thead><tr><th scope="col">资源</th><th scope="col">期初</th><th scope="col">期末剩余</th><th scope="col">实际消耗</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.itemId}>
      <td>{row.name}<span className="order-trade-unit">{unitHint(row.name, row.unit)}</span></td>
      <td>{row.opening === null ? "待确认" : quantityText(row.unit, row.opening)}</td>
      <td>{row.remaining === null ? "待确认" : quantityText(row.unit, row.remaining)}</td>
      <td>{row.consumed === null ? "待确认" : quantityText(row.unit, row.consumed)}</td>
    </tr>)}</tbody></table>;
}

function EndingForm({ opening, order, party, onChanged }: { opening: SettlementOpening; order: Order; party: OrderParty; onChanged: () => void }) {
  const session = useUserSession();
  // The ending quantities are the user's own input: they start empty so that "unknown" is never
  // silently submitted as the opening quantity (i.e. as zero consumption).
  const [raw, setRaw] = useState<Record<string, string>>(() => Object.fromEntries(opening.lines.map((line) => [line.itemId, ""])));
  const [expanded, setExpanded] = useState(false);
  const [checked, setChecked] = useState<{ lines: Array<{ itemId: string; remainingQuantity: string }>; versionHash: string; snapshot: string; preview: SettlementPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const revision = useRef(0);
  const reset = useCallback(() => { setChecked(null); setError(null); setBusy(false); setUnknown(null); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    revision.current += 1;
    setChecked(null);
    setError(null);
    setRaw(Object.fromEntries(opening.lines.map((line) => [line.itemId, ""])));
  }, [opening.id, opening.versionNo, order.id, order.status]);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "settlement.submit", order.id);
    if (intent) {
      setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的结束提交；原幂等键与内容已冻结。");
      setExpanded(true);
    }
  }, [userId, order.id]);
  const locked = unknown !== null;
  const open = expanded || locked || checked !== null;
  const update = (itemId: string, value: string) => {
    if (locked) return;
    revision.current += 1;
    setChecked(null);
    setError(null);
    setBusy(false);
    setRaw((current) => ({ ...current, [itemId]: value }));
  };
  const validate = (): { lines?: Array<{ itemId: string; remainingQuantity: string }>; error?: string } => {
    const lines: Array<{ itemId: string; remainingQuantity: string }> = [];
    for (const line of opening.lines) {
      const value = (raw[line.itemId] ?? "").trim();
      const name = resourceName(order, line.itemId);
      if (value === "") return { error: `请填写「${name}」的期末剩余数量；留空表示未知，不能按 0 处理。` };
      if (!/^(0|[1-9]\d{0,18})$/.test(value)) return { error: `「${name}」的期末数量必须是 0 或正整数（不接受负数、小数、空格或科学计数法）。` };
      if (BigInt(value) > BigInt(line.quantity ?? "0")) return { error: `「${name}」的期末数量不能大于期初数量（${line.quantity}）；异常数量请联系客服核实，不会自动裁剪。` };
      lines.push({ itemId: line.itemId, remainingQuantity: value });
    }
    return { lines };
  };
  const runPreview = async () => {
    if (locked) return;
    const result = validate();
    if (result.error || !result.lines) { setChecked(null); setError(result.error ?? "数量无效"); return; }
    const sequence = ++revision.current;
    setBusy(true);
    setError(null);
    try {
      const preview = await orderApi.settlementPreview(order.id, { lines: result.lines });
      if (sequence !== revision.current) return;
      if (!preview.versionHash || (preview.reasons ?? []).some((reason) => reason !== "EARLY_REASON_REQUIRED")) {
        setError(preview.reasons?.join("、") || "服务端暂不能生成可提交的结算版本。");
        return;
      }
      setChecked({ lines: result.lines, versionHash: preview.versionHash, snapshot: JSON.stringify(result.lines), preview });
    } catch (caught) {
      if (sequence === revision.current) setError(panelError(caught).message);
    } finally {
      if (sequence === revision.current) setBusy(false);
    }
  };
  const apply = (acting: string, outcome: WriteOutcome<OrderSettlement>) => {
    if (outcome.status === "ok") { setChecked(null); onChanged(); return; }
    if (outcome.status === "unknown") { setUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError(BLOCKED_MESSAGE); return; }
    if (outcome.status === "unauthorized") { setError(panelError(outcome.error).message); void session.confirm(); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting); return; }
    setChecked(null);
    setError(panelError(outcome.error).message);
    onChanged();
  };
  /**
   * No projection entry can be bound to the original submission (the receipt hash is not part of
   * the projection), so equal content is never treated as the same request: only the original-key
   * replay may release the lock; everything read here is observation only.
   */
  const resolveRecovery = async (acting: string) => {
    try {
      const authority = await orderApi.settlement(order.id);
      if (!isCurrent(acting)) return;
      const observed = authority.currentRequest
        ? `当前申请状态 ${authority.currentRequest.kind}/${authority.currentRequest.status ?? "待确认"}`
        : authority.settlement
          ? `当前结算版本 ${authority.settlement.versionNo}`
          : "当前没有可读的申请或结算版本";
      setUnknown(`原结束提交仍未取得确定回执（原幂等键保留）。${observed}；读取结果不构成“已生效/未生效”证明，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原结束提交仍未取得确定回执；权威结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const submit = async () => {
    if (!userId || locked) return;
    const acting = userId;
    const result = validate();
    if (result.error || !result.lines) { setChecked(null); setError(result.error ?? "数量无效"); return; }
    if (!checked || JSON.stringify(result.lines) !== checked.snapshot) { setChecked(null); setError("数量已修改或尚未预览，请重新预览后再提交。"); return; }
    setBusy(true);
    setError(null);
    const outcome = await performGuardedWrite(acting, "settlement.submit", order.id,
      { lines: checked.lines, acceptedHash: checked.versionHash },
      { openingId: opening.id, openingVersion: opening.versionNo },
      (key, body) => orderApi.submitSettlement(order.id, body as { lines: Array<{ itemId: string; remainingQuantity: string }>; acceptedHash: string }, key));
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const querySubmit = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "settlement.submit", order.id)) { setUnknown(null); onChanged(); return; }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "settlement.submit", order.id, {}, undefined,
      (key, body) => orderApi.submitSettlement(order.id, body as { lines: Array<{ itemId: string; remainingQuantity: string }>; acceptedHash: string }, key));
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const amounts = settlementAmountRows(party, previewAmounts(checked?.preview ?? null));
  if (!open) return <div className="order-trade-block">
    <h3>发起结束租用</h3>
    <p className="order-muted">填写归还时的剩余数量，先预览结算金额，再确认提交。留空或负数不会被当作 0。</p>
    <div className="order-trade-actions"><button type="button" className="button" onClick={() => setExpanded(true)}>发起结束租用</button></div>
  </div>;
  return <div className="order-trade-block">
    <div className="order-trade-heading"><h3>发起结束租用</h3>{!locked && checked === null ? <button type="button" className="button quiet button--sm" onClick={() => setExpanded(false)} disabled={busy}>收起</button> : null}</div>
    <p className="order-muted">填写归还时账号内的剩余库存。哈夫币按净差计算消耗；物品按件/张差额计算，未耗部分按预付时价格退回。留空或负数不会被当作 0；提交结果未知期间输入与提交全部锁定，只允许查询原请求。</p>
    <table className="order-trade-lines order-trade-input"><thead><tr><th scope="col">资源</th><th scope="col">期初数量</th><th scope="col">期末剩余</th></tr></thead>
      <tbody>{opening.lines.map((line) => <tr key={line.itemId}>
        <td>{resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(resourceName(order, line.itemId), line.unit)}</span></td>
        <td>{quantityText(line.unit, line.quantity ?? "0")}</td>
        <td><input type="text" inputMode="numeric" autoComplete="off" value={raw[line.itemId] ?? ""} placeholder={`填写整数，单位：${resourceName(order, line.itemId)}`} disabled={locked || busy} aria-label={`${resourceName(order, line.itemId)} 期末剩余数量`} aria-invalid={error ? true : undefined} onChange={(event) => update(line.itemId, event.target.value)} /></td>
      </tr>)}</tbody></table>
    {error ? <p className="order-inline-notice" role="alert">{error}</p> : null}
    {unknown ? <UnknownNotice label="结束提交结果未知" message={unknown} onQuery={() => void querySubmit()} onOpenOrder={onChanged} /> : null}
    {checked && !locked ? <div className="order-trade-preview">
      <p className="order-muted">{checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") ? "本次消耗低于 70%，属于提前结束：提交后由受权客服核实原因并复核，双方确认后生效，退款在复核生效后 7 天发起。" : "消耗比例满足正常结算条件：对方确认后自动生效，无需客服审核。"}</p>
      <ConsumedTable order={order} opening={opening} remaining={Object.fromEntries(checked.lines.map((line) => [line.itemId, line.remainingQuantity]))} consumed={checked.preview.consumed} />
      <AmountTable rows={amounts} caption={`本版结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}，服务端计算）`} />
      <div className="order-trade-actions">
        <button type="button" className="button" onClick={() => void submit()} disabled={busy}>{busy ? "提交中…" : checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") ? "提交结束申请" : "提交结算"}</button>
        <button type="button" className="button quiet" onClick={() => setChecked(null)} disabled={busy}>修改数量</button>
      </div>
    </div> : (!locked ? <div className="order-trade-actions">
      <button type="button" className="button secondary" onClick={() => void runPreview()} disabled={busy}>{busy ? "计算中…" : "预览结算金额"}</button>
    </div> : null)}
  </div>;
}

function DecisionPanel({ version, party, order, onChanged }: { version: SettlementVersion; party: OrderParty; order: Order; onChanged: () => void }) {
  const session = useUserSession();
  const [busy, setBusy] = useState<"CONFIRM" | "REJECT" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reset = useCallback(() => { setBusy(null); setError(null); setUnknown(null); setRejectOpen(false); setReason(""); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "settlement.decision", order.id);
    if (intent) setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的结算决定；原幂等键与内容已冻结。");
  }, [userId, order.id]);
  const myParty = party.toUpperCase();
  const decided = (version.decisions ?? []).find((decision) => decision.party === myParty);
  const locked = unknown !== null;
  const apply = (acting: string, outcome: WriteOutcome<OrderSettlement>) => {
    if (outcome.status === "ok") { setRejectOpen(false); onChanged(); return; }
    if (outcome.status === "unknown") { setUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError(BLOCKED_MESSAGE); return; }
    if (outcome.status === "unauthorized") { setError(panelError(outcome.error).message); void session.confirm(); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting); return; }
    setRejectOpen(false);
    setError(panelError(outcome.error).message);
    onChanged();
  };
  /** Only the original version + action + party may release the lock; a projection only observes. */
  const resolveRecovery = async (acting: string) => {
    const intent = loadIntent(acting, "settlement.decision", order.id);
    const targetVersionId = typeof intent?.context?.versionId === "string" ? intent.context.versionId : "";
    const targetAction = intent?.body?.action === "CONFIRM" || intent?.body?.action === "REJECT" ? intent.body.action : "";
    if (!targetVersionId || !targetAction) {
      setUnknown("原决定缺少目标版本或动作，不能按当前页面对象恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    try {
      const authority = await orderApi.settlement(order.id);
      if (!isCurrent(acting)) return;
      const target = authority.versions.find((candidate) => candidate.id === targetVersionId);
      const recorded = (target?.decisions ?? []).some((decision) => decision.party === myParty && decision.action === targetAction);
      if (recorded) {
        clearIntent(acting, "settlement.decision", order.id);
        setUnknown(null);
        setError("服务端已记录你的决定。");
        onChanged();
        return;
      }
      const observed = target ? `原目标版本当前状态（版本 ${target.versionNo}，你的决定未记录）` : "未在原结算记录中找到该版本";
      setUnknown(`原结算决定仍未取得确定回执（原幂等键保留）。${observed}；读取结果不构成“已生效/未生效”证明，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原结算决定仍未取得确定回执；权威结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const decide = async (action: "CONFIRM" | "REJECT") => {
    if (!userId || locked) return;
    // A new confirmation is refused while the amount it would settle cannot be read. Rejecting,
    // refreshing and recovering an existing frozen request stay available.
    if (action === "CONFIRM" && !confirmable) {
      setError("服务端未返回可读的拟调整金额，无法确认这一版；请刷新或联系客服核对后重试。");
      return;
    }
    const acting = userId;
    setBusy(action);
    setError(null);
    const body = { action, versionHash: version.versionHash, ...(action === "REJECT" && reason.trim() ? { reason: reason.trim() } : {}) };
    const outcome = await performGuardedWrite(acting, "settlement.decision", order.id, body, { versionId: version.id, orderId: order.id },
      (key, frozen) => orderApi.decideSettlement(order.id, version.id, frozen as { action: "CONFIRM" | "REJECT"; versionHash: string }, key));
    if (!isCurrent(acting)) return;
    setBusy(null);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const query = async () => {
    if (!userId) return;
    const acting = userId;
    const intent = loadIntent(acting, "settlement.decision", order.id);
    if (!intent) { setUnknown(null); onChanged(); return; }
    const targetVersionId = typeof intent.context?.versionId === "string" ? intent.context.versionId : "";
    if (!targetVersionId) {
      setUnknown("原决定缺少目标版本，不能按当前页面版本恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    setBusy("CONFIRM");
    const outcome = await performGuardedWrite(acting, "settlement.decision", order.id,
      { action: "CONFIRM", versionHash: version.versionHash }, { versionId: version.id, orderId: order.id },
      (key, frozen, frozenContext) => orderApi.decideSettlement(order.id, String(frozenContext?.versionId ?? ""), frozen as { action: "CONFIRM" | "REJECT"; versionHash: string }, key));
    if (!isCurrent(acting)) return;
    setBusy(null);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const amounts = decisionAmountRows(party, version);
  const adjusted = isAdjustedVersion(version);
  const confirmable = !adjusted || proposedConfirmationCents(party, version) !== null;
  const subject = party === "owner" ? "净额" : "应退";
  return <div className="order-trade-block">
    <div className="order-trade-heading"><h3>结算确认</h3><span className="order-trade-tag">第{version.versionNo}版</span><span className="order-trade-tag is-accent">{version.early ? "提前结算" : version.kind === "MANUAL_ADJUSTMENT" ? "人工调整" : "正常结算"}</span></div>
    <p className="order-muted">金额取自已确认的期初与本次期末数据，按冻结单价计算；双方同一版本确认后生效。拒绝与确认是不同的结果，拒绝不会生效这一版。</p>
    {adjusted ? <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>这一版含人工调整</strong><span>确认后会按「本次将确认的{subject}」生效，而不是系统计算值；请先核对两组金额与调整说明。</span></div></div> : null}
    <AmountTable rows={amounts} caption={adjusted ? `系统计算与拟调整金额（${party === "renter" ? "租客口径" : "号主口径"}）` : `本版结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}，服务端计算）`} />
    {adjusted ? <p className="order-muted">调整说明：{version.inputSnapshot?.reason ?? version.inputSnapshot?.endReason ?? "服务端未返回说明"}</p> : null}
    {unknown ? <UnknownNotice label="结算决定结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error}</p> : null}
    {decided ? <p className="order-muted">{decided.action === "CONFIRM" ? "你已确认这一版结算" : "你已拒绝这一版结算"} · {decided.createdAt ? new Date(decided.createdAt).toLocaleString("zh-CN") : ""}</p> :
      locked ? null :
      <div className="order-trade-actions">
        {!confirmable ? <p className="order-inline-notice" role="status">这一版的拟调整金额暂时不可读，确认已暂时停用；可以刷新、拒绝，或先查询原请求。拒绝与查询不受影响。</p> : null}
        <button type="button" className="button" onClick={() => void decide("CONFIRM")} disabled={busy !== null || !confirmable}>{busy === "CONFIRM" ? "确认中…" : version.early ? "确认提前结算（待客服复核）" : "确认结算"}</button>
        {!rejectOpen ? <button type="button" className="button quiet" onClick={() => setRejectOpen(true)} disabled={busy !== null}>拒绝并说明</button> :
          <span className="order-trade-reject"><input type="text" value={reason} maxLength={500} placeholder="请填写拒绝原因（可留空）" onChange={(event) => setReason(event.target.value)} aria-label="拒绝原因" /><button type="button" className="button secondary button--sm" onClick={() => void decide("REJECT")} disabled={busy !== null}>{busy === "REJECT" ? "提交中…" : "提交拒绝"}</button><button type="button" className="button quiet button--sm" onClick={() => setRejectOpen(false)} disabled={busy !== null}>返回</button></span>}
      </div>}
  </div>;
}

/** The confirmed opening the page settles against: the confirmed version if one exists, otherwise the latest recorded one. */
function activeOpening(openings: SettlementOpening[]): SettlementOpening | null {
  if (openings.length === 0) return null;
  return openings.find((opening) => opening.status === "CONFIRMED") ?? openings[openings.length - 1]!;
}

function stageFacts(data: OrderSettlement, opening: SettlementOpening | null, party: OrderParty): OrderStageFacts {
  const myParty = party.toUpperCase();
  const posting = data.posting ?? null;
  const current = data.settlement ?? null;
  const request = data.currentRequest ?? null;
  const myDecision = current ? (current.decisions ?? []).find((decision) => decision.party === myParty) : undefined;
  const phase: OrderStageFacts["phase"] = posting
    ? "POSTED"
    : request?.kind === "INTAKE" && request.status === "OPEN"
      ? "INTAKE_PENDING"
      : current && !myDecision
        ? "DECISION_PENDING"
        : current && myDecision?.action === "REJECT"
          ? "DECISION_REJECTED"
          : current
            ? "DECISION_WAITING"
            : "RENTING";
  return {
    rentalStarted: data.rentalStarted === true,
    phase,
    early: posting?.early === true,
    postedAt: posting?.postedAt ?? null,
    openingVersionNo: opening?.versionNo ?? null,
    settlementVersionNo: current?.versionNo ?? null,
    openingConfirmedAt: opening?.confirmedAt ?? null,
    myAck: (opening?.acks ?? []).some((ack) => ack.party === myParty),
    otherAck: (opening?.acks ?? []).some((ack) => ack.party !== myParty),
    // Reuses the M3 final-column rule: an unreadable figure stays "—" rather than becoming zero.
    settled: posting
      ? {
          label: party === "owner" ? "本单净入账" : "本单应退",
          text: party === "owner" ? moneyCents(posting.owner?.availableCents) : moneyCents(posting.refund?.payableCents),
        }
      : null,
  };
}

function PostingResult({ data, order, party, posting }: { data: OrderSettlement; order: Order; party: OrderParty; posting: NonNullable<OrderSettlement["posting"]> }) {
  const version = data.versions.find((candidate) => candidate.id === posting.settlementVersionId) ?? data.settlement ?? null;
  const opening = activeOpening(data.openings);
  const fee = typeof posting.compensationFeeCents === "string" && /^\d+$/.test(posting.compensationFeeCents) ? moneyCents(posting.compensationFeeCents) : null;
  const adjustment = posting.manualAdjustment;
  // The posted snapshot carries the fee decision; the response-level amounts only exist on a preview.
  const effectiveAmounts = posting.amounts ?? data.amounts ?? null;
  const feePayer = effectiveAmounts && typeof effectiveAmounts.feePayer === "string" ? effectiveAmounts.feePayer : null;
  const amountRows = postingAmountRows(party, posting);
  const captured = typeof posting.capturedCents === "string" && /^\d+$/.test(posting.capturedCents) ? moneyCents(posting.capturedCents) : "待确认";
  const charge = amountRows.find((row) => row.label === chargeRowLabel(Boolean(posting.manualAdjustment))) ?? null;
  const records = (version?.decisions ?? []).map((decision) => ({ label: `${partyLabel(decision.party)}${decision.action === "CONFIRM" ? "已确认" : "已拒绝"}`, time: decision.createdAt ?? null }));
  if (posting.postedAt) records.push({ label: "结算生效", time: posting.postedAt });
  return <>
    <div className="order-trade-block">
      <div className="order-trade-heading"><h3>结算已生效</h3><span className="order-trade-tag is-accent">{posting.early ? "提前结算" : "正常结算"}{version ? ` · 第${version.versionNo}版` : ""} · 已生效</span></div>
      <dl className="order-facts order-trade-facts">
        {party === "renter" ? <>
          <div><dt>{charge?.label ?? "本次结算扣费"}</dt><dd>{charge?.value ?? moneyText(posting.amounts?.renterCharge)}</dd></div>
          <div><dt>最终应退</dt><dd>{moneyCents(posting.refund?.payableCents)}</dd></div>
        </> : <>
          <div><dt>本单净入账</dt><dd>{moneyCents(posting.owner?.availableCents)}</dd></div>
          <div><dt>本次毛收入</dt><dd>{moneyText(posting.owner?.gross)}</dd></div>
          <div><dt>包赔费{feePayer ? `（${feePayer === "OWNER" ? "号主" : feePayer === "RENTER" ? "租客" : "平台"}承担）` : ""}</dt><dd>{fee ?? "待确认"}</dd></div>
        </>}
        <div><dt>原订单已付</dt><dd>{captured}</dd></div>
        <div><dt>退款应付款时间</dt><dd>{posting.refundDueAt ? new Date(posting.refundDueAt).toLocaleString("zh-CN") : "待确认"}</dd></div>
      </dl>
      <p className="order-muted">{party === "owner" ? "本单净入账只表示这一笔订单的净额，不代表钱包全部余额或提现结果。" : "最终应退为已生效的应付金额；退款到账结果待确认，需以收款渠道的实际记录为准，可在我的钱包查看。"}</p>
      {amountRows.length ? <AmountTable rows={amountRows} caption={`生效结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}）`} /> : null}
      {adjustment ? <div className="order-trade-sub">
        <h5>人工调整</h5>
        <dl className="order-facts order-trade-facts">
          <div><dt>{party === "owner" ? "系统净额 → 最终净额" : "系统应退 → 最终应退"}</dt><dd>{party === "owner" ? `${moneyCents(adjustment.systemOwnerNetCents)} → ${moneyCents(adjustment.postedOwnerNetCents)}` : `${moneyCents(adjustment.systemRenterRefundCents)} → ${moneyCents(adjustment.postedRenterRefundCents)}`}</dd></div>
        </dl>
        <p className="order-muted">调整说明：{adjustment.reason ?? "服务端未返回说明"}</p>
      </div> : null}
      <ConsumptionTable order={order} opening={opening} version={version} />
      <RecordList title="结算记录" records={records} />
    </div>
    <div className="order-trade-block">
      <h3>版本记录</h3>
      <VersionHistory versions={data.versions} current={version} />
    </div>
  </>;
}

function VersionHistory({ versions, current }: { versions: SettlementVersion[]; current: SettlementVersion | null }) {
  if (versions.length === 0) return <p className="order-muted">服务端未返回历史结算版本。</p>;
  return <ul className="order-version-list">{versions.map((version) => {
    const reason = version.inputSnapshot?.reason ?? version.inputSnapshot?.endReason ?? version.endReason ?? null;
    const decisions = version.decisions ?? [];
    return <li key={version.id} data-state={version.supersededAt ? "superseded" : version.id === current?.id ? "current" : undefined}>
      <span className="order-version-no">第{version.versionNo}版</span>
      <span className="order-version-kind">{version.early ? "提前结算" : version.kind === "MANUAL_ADJUSTMENT" ? "人工调整" : "正常结算"}</span>
      {version.supersededAt ? <span className="order-version-state">已被替换 · {new Date(version.supersededAt).toLocaleString("zh-CN")}</span> : <span className="order-version-state">当前版本</span>}
      {decisions.length ? <span className="order-version-decisions">{decisions.map((decision) => `${partyLabel(decision.party)}${decision.action === "CONFIRM" ? "已确认" : "已拒绝"}${decision.createdAt ? ` ${new Date(decision.createdAt).toLocaleString("zh-CN")}` : ""}`).join(" · ")}</span> : null}
      {reason ? <span className="order-version-reason">说明：{reason}</span> : null}
      {version.supersededAt ? <span className="order-version-readonly">历史版本只读，不能再对其确认。</span> : null}
    </li>;
  })}</ul>;
}

function SettlementAction({ order, party, onChanged, onStageFacts }: { order: Order; party: OrderParty; onChanged: () => void; onStageFacts?: (facts: OrderStageFacts | null, failed: boolean) => void }) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: OrderSettlement } | { status: "unavailable" } | { status: "error" }>({ status: "loading" });
  const report = useRef(onStageFacts);
  useEffect(() => { report.current = onStageFacts; }, [onStageFacts]);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    report.current?.(null, false);
    orderApi.settlement(order.id, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setState({ status: "ready", data });
      report.current?.(stageFacts(data, activeOpening(data.openings), party), false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      report.current?.(null, true);
      if (error instanceof OrderRequestError && error.status === 404) setState({ status: "unavailable" });
      else setState({ status: "error" });
    });
    return () => { controller.abort(); report.current?.(null, false); };
  }, [order.id, party, reload]);
  const refresh = useCallback(() => { setReload((value) => value + 1); onChanged(); }, [onChanged]);
  if (state.status === "loading") return <section className="order-detail-section order-trade-panel" aria-busy="true" aria-label="开租与结算"><h2 className="order-section-title">开租与结算</h2><p className="order-muted">正在读取结算记录…</p></section>;
  if ((state.status === "unavailable" || state.status === "error") && onStageFacts) return null;
  if (state.status === "unavailable") return <section className="order-detail-section order-trade-panel" aria-label="开租与结算">
    <h2 className="order-section-title">开租与结算</h2>
    <p className="order-muted">结算明细暂时无法读取，消耗、费用与退款金额尚无法展示。</p>
  </section>;
  if (state.status === "error") return <section className="order-detail-section order-trade-panel" role="alert"><h2 className="order-section-title">开租与结算</h2><p className="order-inline-notice">结算记录没有读取成功。</p></section>;
  const data = state.data;
  const opening = activeOpening(data.openings);
  const current = data.settlement ?? null;
  const myParty = party.toUpperCase();
  const myDecision = current ? (current.decisions ?? []).find((decision) => decision.party === myParty) : undefined;
  const posting = data.posting ?? null;
  const openIntake = data.currentRequest?.kind === "INTAKE" && data.currentRequest.status === "OPEN";
  return <section className="order-detail-section order-trade-panel" aria-label="开租与结算">
    <div className="order-trade-heading"><h2 className="order-section-title">开租与结算</h2><button type="button" className="button quiet button--sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />刷新</button></div>
    {!opening ? <div className="order-trade-block"><h3>期初库存</h3><p className="order-muted">等待受权客服按实际交付录入期初库存后，双方在同一条目上确认并开始计租。付款与建群都不会自动开租。</p></div>
      : <OpeningPanel opening={opening} order={order} party={party} onChanged={refresh} />}
    {opening && data.rentalStarted ? <>
      {posting ? <PostingResult data={data} order={order} party={party} posting={posting} /> :
        openIntake ? <div className="order-trade-block"><h3>结束申请待客服处理</h3><p className="order-muted">已提交期末数据，等待受权客服核实原因并复核；复核与双方确认完成后结算生效。期间不会重复受理同一份结束申请。</p></div> :
          current && !myDecision ? <DecisionPanel version={current} party={party} order={order} onChanged={refresh} /> :
            current && myDecision?.action === "REJECT" ? <div className="order-trade-block">
              <h3>你已拒绝第{current.versionNo}版</h3>
              <p className="order-muted">拒绝不会使这一版生效；服务端会按新的期末数据或人工调整生成新版本，请按最新版本重新核对后再决定。</p>
              <AmountTable rows={decisionAmountRows(party, current)} caption={`被拒绝版本金额明细（${party === "renter" ? "租客口径" : "号主口径"}${isAdjustedVersion(current) ? "，含人工调整" : ""}）`} />
            </div> :
              current && myDecision ? <div className="order-trade-block"><h3>等待对方确认 <span className="order-trade-tag">第{current.versionNo}版</span></h3><p className="order-muted">你已在这一版结算上完成操作；金额变化会生成新版本并要求重新确认。</p>
                <AmountTable rows={decisionAmountRows(party, current)} caption={`当前版本金额明细（${party === "renter" ? "租客口径" : "号主口径"}${isAdjustedVersion(current) ? "，含人工调整" : ""}）`} />
                <RecordList title="结算记录" records={(current.decisions ?? []).map((decision) => ({ label: `${partyLabel(decision.party)}${decision.action === "CONFIRM" ? "已确认" : "已拒绝"}`, time: decision.createdAt ?? null }))} />
              </div> :
                <EndingForm opening={opening} order={order} party={party} onChanged={refresh} />}
    </> : null}
    {opening && !posting && data.versions.length > 1 ? <div className="order-trade-block"><h3>历史结算版本</h3><VersionHistory versions={data.versions} current={current} /></div> : null}
  </section>;
}

export function OrderTradeActions({ order, party, onChanged, onStageFacts }: { order: Order; party: OrderParty; onChanged: () => void; onStageFacts?: (facts: OrderStageFacts | null, failed: boolean) => void }) {
  if (order.status === "PENDING_PAYMENT") return <PaymentAction order={order} party={party} onChanged={onChanged} />;
  if (order.status === "PAID" || order.status === "COMPLETED") return <SettlementAction order={order} party={party} onChanged={onChanged} onStageFacts={onStageFacts} />;
  if (order.status === "CANCELLED") return <section className="order-detail-section order-trade-panel" aria-label="交易动作">
    <h2 className="order-section-title">交易动作</h2>
    <p className="order-muted"><CircleSlash size={14} aria-hidden="true" /> 本单已取消。{party === "renter" ? "可重新选择账号下单。" : "可前往出租账号管理查看接单状态。"}</p>
    <div className="order-trade-actions">
      <Link className="button secondary" href={party === "renter" ? "/accounts" : "/account?view=accounts"} scroll={false}>{party === "renter" ? "浏览可租账号" : "管理出租账号"}</Link>
    </div>
  </section>;
  return null;
}
