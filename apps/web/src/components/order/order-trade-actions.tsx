"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, RefreshCw, WalletCards, XCircle } from "lucide-react";
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
import { quantityText, resourceName, settlementAmountRows, unitHint, versionAmounts, previewAmounts } from "@/lib/order-display";
import "./order.css";

type PanelError = { message: string; retryable: boolean };
export type WriteOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "unknown"; message: string }
  | { status: "unauthorized"; error: OrderRequestError }
  | { status: "blocked"; message: string }
  | { status: "recovery-unresolved"; error: OrderRequestError }
  | { status: "definitive"; error: OrderRequestError };

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

function yuanCents(cents: string | null | undefined): string {
  if (!cents || !/^\d+$/.test(cents)) return "—";
  const value = BigInt(cents);
  return `¥${value / 100n}.${(value % 100n).toString().padStart(2, "0")} 元`;
}

function UnknownNotice({ label, message, onQuery, onOpenOrder }: { label: string; message: string; onQuery: () => void; onOpenOrder?: () => void }) {
  return <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>{label}</strong><span>{message}</span></div>
    <div className="order-trade-actions">
      <button type="button" className="button secondary button--sm" onClick={onQuery}><RefreshCw size={14} aria-hidden="true" />查询原请求结果</button>
      {onOpenOrder ? <button type="button" className="button quiet button--sm" onClick={onOpenOrder}>刷新订单</button> : null}
    </div>
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
  if (receipt?.disposition === "APPLIED") {
    return <section className="order-detail-section order-trade-panel" aria-label="本地受控支付">
      <h3>本地受控支付</h3>
      <div className="order-notice is-success" role="status"><CheckCircle2 size={17} aria-hidden="true" /><div><strong>支付已接纳{receipt.replay ? "（原回执重放）" : ""}</strong><span>这是本地受控收款依据，不代表真实渠道到账；订单状态以服务端记录为准。</span></div></div>
    </section>;
  }
  return <section className="order-detail-section order-trade-panel" aria-label="本地受控支付">
    <h3>本地受控支付</h3>
    <p className="order-muted">当前为本地受控支付环境：服务端生成明确的本地收款依据；不发生真实渠道扣款。结果未知时只查询原请求；支付与取消互为互斥动作，未决期间两者都锁定。</p>
    {receipt?.disposition === "REVIEW_REQUIRED" ? <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>支付结果需要人工核对</strong><span>原因：{receipt.reasonCode ?? "待确认"}。未重复扣款；不再新发起支付，等待平台核对。</span></div></div> : null}
    {unknown ? <UnknownNotice label="支付结果未知" message={unknown} onQuery={() => void queryPayment()} onOpenOrder={onChanged} /> : null}
    {cancelUnknown ? <UnknownNotice label="取消结果未知" message={cancelUnknown} onQuery={() => void queryCancel()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
    {party === "renter" ? <div className="order-trade-actions">
      <button type="button" className="button" onClick={() => void pay()} disabled={payLocked}>
        <WalletCards size={15} aria-hidden="true" />{busy ? "提交支付请求…" : "提交本地受控支付"}
      </button>
      {!cancelArmed ? <button type="button" className="button quiet" onClick={() => setCancelArmed(true)} disabled={cancelLocked}>取消订单</button> :
        <span className="order-trade-confirm">确认取消该订单？账号占用将释放。<button type="button" className="button secondary button--sm" onClick={() => void cancel()} disabled={cancelLocked}>{busy ? "取消中…" : "确认取消"}</button><button type="button" className="button quiet button--sm" onClick={() => setCancelArmed(false)} disabled={busy}>保留订单</button></span>}
    </div> : <p className="order-muted">等待租客完成支付；订单金额以服务端记录为准。</p>}
  </section>;
}

function OpeningLines({ order, opening }: { order: Order; opening: SettlementOpening }) {
  return <table className="order-trade-lines"><thead><tr><th scope="col">资源</th><th scope="col">期初数量</th></tr></thead>
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
  const acked = (opening.acks ?? []).some((ack) => ack.party === party.toUpperCase());
  const confirmed = opening.status === "CONFIRMED";
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
      const myAck = target?.acks?.some((ack) => ack.party === party.toUpperCase()) ?? false;
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
    <h4>期初库存确认 <span className="order-trade-tag">{confirmed ? "双方已确认" : acked ? "已确认 · 等待对方" : "待确认"}</span></h4>
    <p className="order-muted">期初数量由客服按交付时的实际库存代录；与预付款一致才可开始计租。付款、建群与沟通都不等于已开租。</p>
    <OpeningLines order={order} opening={opening} />
    {unknown ? <UnknownNotice label="期初确认结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
    {!confirmed && !acked && !unknown ? <button type="button" className="button" onClick={() => void confirm()} disabled={busy}>{busy ? "确认中…" : "确认期初并开租"}</button> : null}
    {!confirmed && acked ? <p className="order-muted"><Clock3 size={14} aria-hidden="true" /> 已提交确认；等待对方确认后正式开租。</p> : null}
  </div>;
}

function AmountTable({ rows, caption }: { rows: Array<{ label: string; value: string; note?: string }>; caption: string }) {
  if (rows.length === 0) return null;
  return <table className="order-trade-amounts" aria-label={caption}>
    <caption>{caption}</caption>
    <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.value}{row.note ? <small>{row.note}</small> : null}</td></tr>)}</tbody>
  </table>;
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
        <td>{rest === "" ? "未填写" : quantityText(line.unit, rest)}</td>
        <td>{used === null || used === undefined ? "待计算" : quantityText(line.unit, used)}</td>
      </tr>;
    })}</tbody></table>;
}

function EndingForm({ opening, order, party, onChanged }: { opening: SettlementOpening; order: Order; party: OrderParty; onChanged: () => void }) {
  const session = useUserSession();
  const [raw, setRaw] = useState<Record<string, string>>(() => Object.fromEntries(opening.lines.map((line) => [line.itemId, line.quantity ?? ""])));
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
  }, [opening.id, opening.versionNo, order.id, order.status]);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "settlement.submit", order.id);
    if (intent) setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的结束提交；原幂等键与内容已冻结。");
  }, [userId, order.id]);
  const locked = unknown !== null;
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
        ? `当前申请状态 ${authority.currentRequest.kind}/${authority.currentRequest.status}`
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
  return <div className="order-trade-block">
    <h4>发起结束 · 填写期末剩余</h4>
    <p className="order-muted">填写归还时账号内的剩余库存。哈夫币按净差计算消耗；物品按件/张差额计算，未耗部分按预付时价格退回。留空或负数不会被当作 0；提交结果未知期间输入与提交全部锁定，只允许查询原请求。</p>
    <table className="order-trade-lines order-trade-input"><thead><tr><th scope="col">资源</th><th scope="col">期初</th><th scope="col">期末剩余</th></tr></thead>
      <tbody>{opening.lines.map((line) => <tr key={line.itemId}>
        <td>{resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(resourceName(order, line.itemId), line.unit)}</span></td>
        <td>{quantityText(line.unit, line.quantity ?? "0")}</td>
        <td><input type="text" inputMode="numeric" autoComplete="off" value={raw[line.itemId] ?? ""} disabled={locked || busy} aria-label={`${resourceName(order, line.itemId)} 期末剩余数量`} aria-invalid={error ? true : undefined} onChange={(event) => update(line.itemId, event.target.value)} /></td>
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
  const amounts = settlementAmountRows(party, versionAmounts(version));
  return <div className="order-trade-block">
    <h4>结算确认 <span className="order-trade-tag">{version.early ? "提前结算" : "正常结算"}</span></h4>
    <p className="order-muted">金额取自已确认的期初与本次期末数据，按冻结单价计算；双方同一版本确认后生效，正常结算不再需要客服审核。提前结算还需受权客服复核。</p>
    <AmountTable rows={amounts} caption={`本版结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}，服务端计算）`} />
    {unknown ? <UnknownNotice label="结算决定结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error}</p> : null}
    {decided ? <p className="order-muted">{decided.action === "CONFIRM" ? "你已确认这一版结算" : "你已拒绝这一版结算"} · {decided.createdAt ? new Date(decided.createdAt).toLocaleString("zh-CN") : ""}</p> :
      locked ? null :
      <div className="order-trade-actions">
        <button type="button" className="button" onClick={() => void decide("CONFIRM")} disabled={busy !== null}>{busy === "CONFIRM" ? "确认中…" : version.early ? "确认提前结算（待客服复核）" : "确认结算"}</button>
        {!rejectOpen ? <button type="button" className="button quiet" onClick={() => setRejectOpen(true)} disabled={busy !== null}>拒绝并说明</button> :
          <span className="order-trade-reject"><input type="text" value={reason} maxLength={500} placeholder="请填写拒绝原因（可留空）" onChange={(event) => setReason(event.target.value)} aria-label="拒绝原因" /><button type="button" className="button secondary button--sm" onClick={() => void decide("REJECT")} disabled={busy !== null}>{busy === "REJECT" ? "提交中…" : "提交拒绝"}</button><button type="button" className="button quiet button--sm" onClick={() => setRejectOpen(false)} disabled={busy !== null}>返回</button></span>}
      </div>}
  </div>;
}

function SettlementAction({ order, party, onChanged }: { order: Order; party: OrderParty; onChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: OrderSettlement } | { status: "unavailable" } | { status: "error" }>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    orderApi.settlement(order.id, controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ status: "ready", data });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof OrderRequestError && error.status === 404) setState({ status: "unavailable" });
      else setState({ status: "error" });
    });
    return () => controller.abort();
  }, [order.id, reload]);
  const refresh = useCallback(() => { setReload((value) => value + 1); onChanged(); }, [onChanged]);
  if (state.status === "loading") return <section className="order-detail-section order-trade-panel" aria-busy="true" aria-label="正在读取开租与结算"><h3>开租与结算</h3><p className="order-muted">正在读取服务端结算记录…</p></section>;
  if (state.status === "unavailable") return null;
  if (state.status === "error") return <section className="order-detail-section order-trade-panel" role="alert"><h3>开租与结算</h3><p className="order-inline-notice">结算信息暂时没有读取成功。<button type="button" className="button secondary button--sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />重试</button></p></section>;
  const data = state.data;
  const opening = data.openings.length > 0 ? data.openings[data.openings.length - 1]! : null;
  const current = data.settlement ?? null;
  const myParty = party.toUpperCase();
  const decided = current ? (current.decisions ?? []).some((decision) => decision.party === myParty) : false;
  const posting = data.posting ?? null;
  const openIntake = data.currentRequest?.kind === "INTAKE" && data.currentRequest.status === "OPEN";
  const postingAmounts = posting?.amounts ?? null;
  return <section className="order-detail-section order-trade-panel" aria-label="开租与结算">
    <div className="order-trade-heading"><h3>开租与结算</h3><button type="button" className="button quiet button--sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />刷新</button></div>
    {!opening ? <p className="order-muted">等待受权客服按实际交付录入期初库存后，双方在同一条目上确认并开始计租。</p> : <OpeningPanel opening={opening} order={order} party={party} onChanged={refresh} />}
    {opening && data.rentalStarted ? <>
      {posting ? <div className="order-trade-block">
        <h4>结算已生效 <span className="order-trade-tag">订单已结束</span></h4>
        <p className="order-muted">{posting.refundDueAt ? `退款应付款已生成，按服务端到期时间处理：${new Date(posting.refundDueAt).toLocaleString("zh-CN")}。发起/应退不等于渠道到账。` : "退款应付款已生成；渠道退款与到账分别记录。"}</p>
        <dl className="order-facts order-trade-facts">
          <div><dt>号主净入账（含调整后）</dt><dd>{yuanCents(posting.owner?.availableCents)}</dd></div>
          <div><dt>租客应退</dt><dd>{yuanCents(posting.refund?.payableCents)}</dd></div>
          {posting.compensationFeeCents ? <div><dt>包赔费（已生效）</dt><dd>{yuanCents(posting.compensationFeeCents)}</dd></div> : null}
        </dl>
        <AmountTable rows={settlementAmountRows(party, postingAmounts)} caption={`生效结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}）`} />
      </div> :
        openIntake ? <div className="order-trade-block"><h4>结束申请待客服处理</h4><p className="order-muted">已提交期末数据，等待受权客服核实原因并复核；复核与双方确认完成后结算生效。</p></div> :
          current && !decided ? <DecisionPanel version={current} party={party} order={order} onChanged={refresh} /> :
            current && decided && !data.ready ? <div className="order-trade-block"><h4>等待对方确认</h4><p className="order-muted">你已在这一版结算上完成操作；金额变化会生成新版本并要求重新确认。</p>
              <AmountTable rows={settlementAmountRows(party, versionAmounts(current))} caption={`当前版本金额明细（${party === "renter" ? "租客口径" : "号主口径"}）`} /></div> :
              !current ? <EndingForm opening={opening} order={order} party={party} onChanged={refresh} /> :
                <div className="order-trade-block"><h4>结算待处理</h4><p className="order-muted">服务端状态：{data.reasons?.join("、") || "待确认"}。</p></div>
      }
    </> : null}
  </section>;
}

export function OrderTradeActions({ order, party, onChanged }: { order: Order; party: OrderParty; onChanged: () => void }) {
  if (order.status === "PENDING_PAYMENT") return <PaymentAction order={order} party={party} onChanged={onChanged} />;
  if (order.status === "PAID" || order.status === "COMPLETED") return <SettlementAction order={order} party={party} onChanged={onChanged} />;
  if (order.status === "CANCELLED") return <section className="order-detail-section order-trade-panel"><h3>交易动作</h3><p className="order-muted"><XCircle size={14} aria-hidden="true" /> 订单已取消；如需继续租用请重新选择账号下单。</p></section>;
  return null;
}
