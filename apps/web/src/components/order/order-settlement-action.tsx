"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Clock3, RefreshCw } from "lucide-react";
import TradeTermsDocument from "@/components/content/trade-terms-document";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import {
  formatOrderTime,
  orderApi,
  OrderRequestError,
  captureOrderSubject,
  isOrderSubjectCurrent,
  type EarlySettlementDisclosure,
  type Order,
  type OrderParty,
  type OrderSettlement,
  type OrderSettlementStage,
  type SettlementLine,
  type SettlementOpening,
  type SettlementPreview,
  type SettlementQuantityInput,
  type SettlementVersion,
} from "@/lib/order-client";
import { inspectIntent, isIntentStale, loadIntent, clearIntent } from "@/lib/order-intents";
import {
  chargeRowLabel,
  consumptionRows,
  decisionAmountRows,
  isAdjustedVersion,
  moneyCents,
  moneyText,
  postingAmountRows,
  previewAmounts,
  proposedConfirmationCents,
  quantityText,
  resourceName,
  settlementAmountRows,
  settlementPreviewProblem,
  unitHint,
} from "@/lib/order-display";
import type { PanelError, WriteOutcome, OrderStageFacts, SettlementFocus } from "./order-trade-types";
import {
  BLOCKED_MESSAGE,
  STALE_MESSAGE,
  panelError,
  performGuardedWrite,
  partyLabel,
  UnknownNotice,
  AmountTable,
  RecordList,
} from "./order-trade-shared";

function OpeningLines({ order, opening, heading }: { order: Order; opening: SettlementOpening; heading: string }) {
  return (
    <table className="order-trade-lines">
      <thead>
        <tr>
          <th scope="col">资源</th>
          <th scope="col">{heading}</th>
        </tr>
      </thead>
      <tbody>
        {opening.lines.map((line) => (
          <tr key={line.itemId}>
            <td>{resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(resourceName(order, line.itemId), line.unit)}</span></td>
            <td>{quantityText(line.unit, line.quantity ?? "0")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OpeningPanel({ opening, order, party, onChanged, readOnly = false }: { opening: SettlementOpening; order: Order; party: OrderParty; onChanged: () => void; readOnly?: boolean }) {
  const session = useUserSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const reset = useCallback(() => { setBusy(false); setError(null); setUnknown(null); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "opening.confirm", order.id);
    if (intent) setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的期初确认；原申请已保留，请勿重复提交。");
  }, [userId, order.id]);
  const myParty = party.toUpperCase();
  const acks = opening.acks ?? [];
  const myAck = acks.find((ack) => ack.party === myParty), otherAck = acks.find((ack) => ack.party !== myParty);
  const acked = Boolean(myAck), otherAcked = Boolean(otherAck);
  const confirmed = opening.status === "CONFIRMED";
  const ackText = (ack: typeof myAck, own: boolean) => !ack ? "" : ack.source === "PARTY" ? `${own ? "你" : partyLabel(ack.party)}已确认`
    : ack.source === "ON_BEHALF" ? `客服已协助${own ? "你" : partyLabel(ack.party)}确认`
    : ack.source === "AUTO" ? `${own ? "你的" : partyLabel(ack.party) + "的"}期初已自动确认` : `${own ? "你的" : partyLabel(ack.party) + "的"}确认已记录`;
  const bothPartyConfirmed = acked && otherAcked && acks.every(ack => ack.source === "PARTY");
  const tag = confirmed || (acked && otherAcked) ? bothPartyConfirmed ? "双方已确认" : "期初已确认" : acked ? `${ackText(myAck, true)} · 对方未记录` : otherAcked ? `${ackText(otherAck, false)} · 你未记录` : "待双方确认";
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
      const authority = await orderApi.settlement(acting, order.id);
      if (!isCurrent(acting)) return;
      const target = authority.openings.find((candidate) => candidate.id === targetId);
      const originalPartyAck = target?.acks?.some((ack) => ack.party === myParty && ack.source === "PARTY") ?? false;
      if (target && originalPartyAck) {
        clearIntent(acting, "opening.confirm", order.id);
        setUnknown(null);
        setError({ message: target.status === "CONFIRMED" ? "服务端已记录你的期初确认，期初已生效。" : "服务端已记录你的期初确认，等待对方确认。", retryable: false });
        onChanged();
        return;
      }
      const observed = target ? `原目标期初${target.status === "CONFIRMED" ? "已确认" : target.status === "DRAFT" ? "未记录" : "状态未确认"}` : "未在原结算记录中找到该期初版本";
      setUnknown(`原开租确认申请仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原开租确认申请仍未取得确定回执；最新结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const confirm = async () => {
    if (!userId) return;
    const acting = userId;
    const pending = inspectIntent(acting, "opening.confirm", order.id);
    if (pending.state === "UNREADABLE") { setError({ message: "原开租确认记录无法读取，请联系客服核对。", retryable: false }); return; }
    if (pending.intent) { setUnknown(isIntentStale(pending.intent) ? STALE_MESSAGE : "检测到未完成的开租确认，请先查询原请求。"); return; }
    setBusy(true); setError(null); setUnknown(null);
    const outcome = await performGuardedWrite(acting, "opening.confirm", order.id, { versionNo: Number(opening.versionNo) },
      { openingId: opening.id, orderId: order.id },
      (key, body, frozenContext, subject) => orderApi.confirmOpening(subject, order.id, String(frozenContext?.openingId ?? ""), Number(body.versionNo), key), isCurrent);
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
      (key, body, frozenContext, subject) => orderApi.confirmOpening(subject, order.id, String(frozenContext?.openingId ?? ""), Number(body.versionNo), key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  return (
    <div className="order-trade-block">
      <h3>{confirmed ? "已确认期初库存" : "期初库存确认"} <span className="order-trade-tag">第{opening.versionNo}版</span> <span className="order-trade-tag is-accent">{tag}</span></h3>
      <p className="order-muted">{confirmed ? "以下为已生效的开租库存，确认方式见下方记录；开租后按结算记录核对消耗。" : "期初数量取自本单冻结报价；请双方核对同一版本，资料异常时联系客服处理。付款、建群与沟通都不等于已开租。"}</p>
      <OpeningLines order={order} opening={opening} heading={confirmed ? "开租时数量" : "期初数量"} />
      {unknown ? <UnknownNotice label="期初确认结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
      {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
      {!readOnly && !confirmed && !acked && !unknown ? <button type="button" className="button primary" onClick={() => void confirm()} disabled={busy}>{busy ? "确认中…" : "确认期初并开租"}</button> : null}
      {readOnly && !confirmed && !acked && !unknown ? <p className="order-muted">订单主状态已完成，本页不再提供新的期初确认；如有一笔结果未知的申请，请用下方「查询原请求」按原键核对。</p> : null}
      {!confirmed && acked ? <p className="order-muted"><Clock3 size={14} aria-hidden="true" /> {ackText(myAck, true)}；等待对方确认后正式开租。</p> : null}
      {!confirmed && opening.status === "DRAFT" && opening.autoConfirmDueAt && Number.isFinite(Date.parse(opening.autoConfirmDueAt)) ? <p className="order-muted">双方未确认时，将于 {formatOrderTime(opening.autoConfirmDueAt)} 自动确认并开始租期。</p> : null}
      <RecordList title="确认记录" records={acks.map((ack) => ({ label: ack.source === "PARTY" ? `${partyLabel(ack.party)}确认期初` : ack.source === "ON_BEHALF" ? `客服协助${partyLabel(ack.party)}确认期初` : ack.source === "AUTO" ? `${partyLabel(ack.party)}期初自动确认` : `${partyLabel(ack.party)}期初确认已记录`, time: ack.createdAt ?? null }))} />
      {opening.confirmedAt ? <p className="order-muted">开租时间：{formatOrderTime(opening.confirmedAt)}</p> : null}
    </div>
  );
}

function settlementDecisionLabel(action: string): string {
  return action === "CONFIRM" ? "已确认" : action === "REJECT" ? "已拒绝" : action === "REVIEW" ? "已复核" : action === "FINALIZE" ? "已确认结算" : "状态待核";
}

function ConsumedTable({ order, lines, values, actual, consumed }: { order: Order; lines: SettlementLine[]; values: Record<string, string>; actual: boolean; consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> } | null }) {
  return (
    <table className="order-trade-lines">
      <thead>
        <tr>
          <th scope="col">资源</th>
          <th scope="col">期初</th>
          <th scope="col">期末剩余</th>
          <th scope="col">本次实耗</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => {
          const open = line.quantity ?? "0";
          const value = values[line.itemId] ?? "";
          const valid = /^\d+$/.test(value);
          const rest = valid && actual ? (BigInt(value) < BigInt(open) ? (BigInt(open) - BigInt(value)).toString() : "0") : value;
          const derived = valid && actual ? value : valid && BigInt(rest) <= BigInt(open) ? (BigInt(open) - BigInt(rest)).toString() : null;
          const serverLine = consumed?.items?.find((item) => item.itemId === line.itemId);
          const used = line.pricingKind === "HAFF_RATIO" && consumed?.haff !== undefined && consumed.haff !== null
            ? String(consumed.haff)
            : serverLine?.consumed ?? derived;
          const name = line.name ?? resourceName(order, line.itemId);
          return (
            <tr key={line.itemId}>
              <td>{name}<span className="order-trade-unit">{unitHint(name, line.unit)}</span></td>
              <td>{quantityText(line.unit, open)}</td>
              <td>{rest === "" ? "未记录" : quantityText(line.unit, rest)}</td>
              <td>{used === null || used === undefined ? "未记录" : quantityText(line.unit, used)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ConsumptionTable({ order, opening, version, extraResources }: { order: Order; opening: SettlementOpening | null; version: SettlementVersion | null | undefined; extraResources?: SettlementLine[] }) {
  const rows = consumptionRows(order, opening, version, extraResources);
  if (rows.length === 0) return null;
  return (
    <table className="order-trade-lines">
      <thead>
        <tr>
          <th scope="col">资源</th>
          <th scope="col">期初</th>
          <th scope="col">期末剩余</th>
          <th scope="col">实际消耗</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.itemId}>
            <td>{row.name}<span className="order-trade-unit">{unitHint(row.name, row.unit)}</span></td>
            <td>{row.opening === null ? "未记录" : quantityText(row.unit, row.opening)}</td>
            <td>{row.remaining === null ? "未记录" : quantityText(row.unit, row.remaining)}</td>
            <td>{row.consumed === null ? "未记录" : quantityText(row.unit, row.consumed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EarlyTermsConsent({ disclosure, accepted, onChange, disabled, label }: {
  disclosure?: EarlySettlementDisclosure; accepted: boolean; onChange: (accepted: boolean) => void; disabled: boolean; label: string;
}) {
  const [readDigest, setReadDigest] = useState<string | null>(null);
  if (!disclosure) return <p className="order-inline-notice" role="alert">本单提前结算告知暂时无法核验。请刷新后重试。</p>;
  const readable = !disclosure.bodyDocument || readDigest === disclosure.digest;
  return (
    <>
      <TradeTermsDocument body={disclosure.body} document={disclosure.bodyDocument} target={disclosure.digest} onReady={setReadDigest} />
      <label className="order-trade-consent">
        <input type="checkbox" checked={accepted && readable} disabled={disabled || !readable} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}</span>
      </label>
    </>
  );
}

function boundEarlyDisclosure(order: Order, disclosure?: EarlySettlementDisclosure): EarlySettlementDisclosure | undefined {
  const ref = order.earlySettlementDisclosure;
  if (!ref) return undefined;
  if (disclosure?.versionId === ref.versionId && disclosure.digest === ref.digest) return disclosure;
  if (!disclosure && ref.body !== undefined) return { ...ref, body: ref.body };
  return undefined;
}

function EndingForm({ opening, order, party, onChanged, consumptionMode, extraResources = [], readOnly = false }: { opening: SettlementOpening; order: Order; party: OrderParty; onChanged: () => void; consumptionMode?: OrderSettlement["consumptionMode"]; extraResources?: SettlementLine[]; readOnly?: boolean }) {
  const session = useUserSession();
  const actual = consumptionMode === "ACTUAL";
  const extra = actual ? extraResources.filter((line) => !opening.lines.some((item) => item.itemId === line.itemId)).map((line) => ({ ...line, quantity: "0" })) : [];
  const lines = [...opening.lines, ...extra];
  const extraKey = extra.map((line) => line.itemId).join("|");
  const initialValues = () => Object.fromEntries(lines.map((line) => [line.itemId, extra.some((item) => item.itemId === line.itemId) ? "0" : ""]));
  const [raw, setRaw] = useState<Record<string, string>>(initialValues);
  const [expanded, setExpanded] = useState(false);
  const [checked, setChecked] = useState<{ lines: SettlementQuantityInput[]; versionHash: string; snapshot: string; preview: SettlementPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const revision = useRef(0);
  const reset = useCallback(() => { setChecked(null); setError(null); setBusy(false); setUnknown(null); setTermsAccepted(false); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    revision.current += 1;
    setChecked(null);
    setError(null);
    setTermsAccepted(false);
    setRaw(initialValues());
  }, [opening.id, opening.versionNo, order.id, order.status, actual, extraKey]);
  useEffect(() => { setTermsAccepted(false); }, [checked?.versionHash]);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "settlement.submit", order.id);
    if (intent) {
      setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的结束提交；原申请内容已保留，请勿重复提交。");
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
  const validate = (): { lines?: SettlementQuantityInput[]; error?: string } => {
    const selected: SettlementQuantityInput[] = [];
    for (const line of lines) {
      const value = (raw[line.itemId] ?? "").trim();
      const name = line.name ?? resourceName(order, line.itemId);
      const label = actual ? "实际消耗数量" : "期末剩余数量";
      if (value === "") return { error: `请填写「${name}」的${label}；留空表示未知，不能按 0 处理。` };
      if (!/^(0|[1-9]\d{0,18})$/.test(value)) return { error: `「${name}」的${label}必须是 0 或正整数。` };
      if (!actual && BigInt(value) > BigInt(line.quantity ?? "0")) return { error: `「${name}」的期末数量不能大于期初数量（${line.quantity}）；异常数量请联系客服核实。` };
      selected.push(actual ? { itemId: line.itemId, consumedQuantity: value } : { itemId: line.itemId, remainingQuantity: value });
    }
    return { lines: selected };
  };
  const runPreview = async () => {
    if (locked || !userId) return;
    const result = validate();
    if (result.error || !result.lines) { setChecked(null); setError(result.error ?? "数量无效"); return; }
    const sequence = ++revision.current;
    setBusy(true);
    setError(null);
    try {
      const preview = await orderApi.settlementPreview(userId, order.id, { lines: result.lines });
      if (sequence !== revision.current) return;
      if (!preview.versionHash || (preview.reasons ?? []).some((reason) => reason !== "EARLY_REASON_REQUIRED")) {
        setError(settlementPreviewProblem(preview.reasons));
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
  const resolveRecovery = async (acting: string) => {
    try {
      const authority = await orderApi.settlement(acting, order.id);
      if (!isCurrent(acting)) return;
      const observed = authority.currentRequest
        ? authority.currentRequest.kind === "INTAKE" ? "当前有结束申请，状态未确认" : authority.currentRequest.kind === "SETTLEMENT_VERSION" ? "当前有结算方案" : "当前申请状态未记录"
        : authority.settlement
          ? `当前结算版本 ${authority.settlement.versionNo}`
          : "当前没有可读的申请或结算版本";
      setUnknown(`原结束提交仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原结束提交仍未取得确定回执；最新结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const submit = async () => {
    if (!userId || locked) return;
    const acting = userId;
    const result = validate();
    if (result.error || !result.lines) { setChecked(null); setError(result.error ?? "数量无效"); return; }
    if (!checked || JSON.stringify(result.lines) !== checked.snapshot) { setChecked(null); setError("数量已修改或尚未预览，请重新预览后再提交。"); return; }
    const early = checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") === true;
    if (early && (order.earlySettlementDisclosure || order.earlySettlementDisclosureUnavailable) && (!earlyDisclosure || !termsAccepted)) { setError("请阅读并同意本单提前结束规则后再提交。"); return; }
    setBusy(true);
    setError(null);
    const outcome = await performGuardedWrite(acting, "settlement.submit", order.id,
      { lines: checked.lines, acceptedHash: checked.versionHash, ...(early && order.earlySettlementDisclosure ? { termsAccepted: true } : {}) },
      { openingId: opening.id, openingVersion: opening.versionNo },
      (key, body, _context, subject) => orderApi.submitSettlement(subject, order.id, body as { lines: SettlementQuantityInput[]; acceptedHash: string; termsAccepted?: boolean }, key), isCurrent);
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
      (key, body, _context, subject) => orderApi.submitSettlement(subject, order.id, body as { lines: SettlementQuantityInput[]; acceptedHash: string }, key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const earlyDisclosure = boundEarlyDisclosure(order, checked?.preview.earlySettlementDisclosure);
  const amounts = settlementAmountRows(party, previewAmounts(checked?.preview ?? null));
  if (consumptionMode === "UNAVAILABLE") return <div className="order-trade-block"><h3>发起结束租用</h3><p className="order-inline-notice" role="alert">本单结算价格资料暂不可用，请联系客服核实。</p></div>;
  if (!open) return (
    <div className="order-trade-block">
      <h3>发起结束租用</h3>
      <p className="order-muted">{actual ? "填写实际消耗数量，先预览结算金额，再确认提交。" : "填写归还时的剩余数量，先预览结算金额，再确认提交。留空或负数不会被当作 0。"}</p>
      {readOnly ? <p className="order-muted">订单主状态已完成，本页不再提供新的结束租用或结算申请；如有一笔结果未知的申请，请用下方「查询原请求」按原键核对。</p>
        : <div className="order-trade-actions"><button type="button" className="button primary" onClick={() => setExpanded(true)}>发起结束租用</button></div>}
    </div>
  );
  return (
    <div className="order-trade-block">
      <div className="order-trade-heading"><h3>发起结束租用</h3>{!locked && checked === null ? <button type="button" className="button quiet button--sm" onClick={() => setExpanded(false)} disabled={busy}>收起</button> : null}</div>
      <p className="order-muted">{actual ? "按实际使用量填写；超出期初的部分按本单价格与会员规则计算。未在期初申报的物资默认 0，请核对后修改。" : "填写归还时账号内的剩余库存。留空不会被当作 0。"}</p>
      <table className="order-trade-lines order-trade-input">
        <thead>
          <tr>
            <th scope="col">资源</th>
            <th scope="col">期初数量</th>
            <th scope="col">{actual ? "实际消耗" : "期末剩余"}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.itemId}>
              <td>{line.name ?? resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(line.name ?? resourceName(order, line.itemId), line.unit)}</span></td>
              <td>{quantityText(line.unit, line.quantity ?? "0")}</td>
              <td><input type="text" inputMode="numeric" autoComplete="off" value={raw[line.itemId] ?? ""} placeholder="填写整数" disabled={locked || busy || readOnly} aria-label={`${line.name ?? resourceName(order, line.itemId)} ${actual ? "实际消耗" : "期末剩余"}数量`} aria-invalid={error ? true : undefined} onChange={(event) => update(line.itemId, event.target.value)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="order-inline-notice" role="alert">{error}</p> : null}
      {unknown ? <UnknownNotice label="结束提交结果未知" message={unknown} onQuery={() => void querySubmit()} onOpenOrder={onChanged} /> : null}
      {checked && !locked ? (
        <div className="order-trade-preview">
          <p className="order-muted">{checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") ? "本次消耗低于 70%，属于提前结束。提交后客服会核实原因并生成结算方案，请按方案核对费用和退款安排。" : "消耗比例满足正常结算条件：对方确认后自动生效，无需客服审核。"}</p>
          {checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") && (order.earlySettlementDisclosure || order.earlySettlementDisclosureUnavailable) ? <EarlyTermsConsent key={checked.versionHash} disclosure={earlyDisclosure} accepted={termsAccepted} onChange={setTermsAccepted} disabled={busy} label="我已阅读并同意上述提前结束规则，具体金额以结算方案为准" /> : null}
          <ConsumedTable order={order} lines={lines} values={Object.fromEntries(checked.lines.map((line) => [line.itemId, "consumedQuantity" in line ? line.consumedQuantity : line.remainingQuantity]))} actual={actual} consumed={checked.preview.consumed} />
          <AmountTable rows={amounts} caption={`本版结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}，服务端计算）`} />
          {readOnly ? <p className="order-muted">订单主状态已完成，本页不再提交新的结算申请；下方金额仅为已读到的预览记录。</p> : (
            <div className="order-trade-actions">
              <button type="button" className="button primary" onClick={() => void submit()} disabled={busy || (checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") && Boolean(order.earlySettlementDisclosure || order.earlySettlementDisclosureUnavailable) && (!earlyDisclosure || !termsAccepted))}>{busy ? "提交中…" : checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") ? "提交结束申请" : "提交结算"}</button>
              <button type="button" className="button quiet" onClick={() => setChecked(null)} disabled={busy}>修改数量</button>
            </div>
          )}
        </div>
      ) : (!locked && !readOnly ? (
        <div className="order-trade-actions">
          <button type="button" className="button primary" onClick={() => void runPreview()} disabled={busy}>{busy ? "计算中…" : "预览结算金额"}</button>
        </div>
      ) : null)}
    </div>
  );
}

function DecisionPanel({ version, party, order, disclosure, onChanged, onApplied, readOnly = false, feeReconfirmationRequired = false }: { version: SettlementVersion; party: OrderParty; order: Order; disclosure?: EarlySettlementDisclosure; onChanged: () => void; onApplied?: (data: OrderSettlement) => void; readOnly?: boolean; feeReconfirmationRequired?: boolean }) {
  const session = useUserSession();
  const [busy, setBusy] = useState<"CONFIRM" | "REJECT" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const reset = useCallback(() => { setBusy(null); setError(null); setUnknown(null); setRejectOpen(false); setReason(""); setTermsAccepted(false); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "settlement.decision", order.id);
    if (intent) setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的结算决定；原申请内容已保留，请勿重复提交。");
  }, [userId, order.id]);
  useEffect(() => { setTermsAccepted(false); }, [version.id, version.versionHash, disclosure?.digest]);
  const earlyDisclosure = boundEarlyDisclosure(order, disclosure);
  const myParty = party.toUpperCase();
  const decided = (version.decisions ?? []).find((decision) => decision.party === myParty);
  const locked = unknown !== null;
  const apply = (acting: string, outcome: WriteOutcome<OrderSettlement>) => {
    // POST .../decisions 的回执本身就是权威的 OrderSettlement（含 posting / stage）。
    // 最后一方确认时先用它收敛界面，避免弹窗短时仍显示「等待对方确认」。
    if (outcome.status === "ok") {
      setRejectOpen(false);
      if (onApplied) onApplied(outcome.value);
      else onChanged();
      return;
    }
    if (outcome.status === "unknown") { setUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError(BLOCKED_MESSAGE); return; }
    if (outcome.status === "unauthorized") { setError(panelError(outcome.error).message); void session.confirm(); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting); return; }
    setRejectOpen(false);
    setError(panelError(outcome.error).message);
    onChanged();
  };
  const resolveRecovery = async (acting: string) => {
    const intent = loadIntent(acting, "settlement.decision", order.id);
    const targetVersionId = typeof intent?.context?.versionId === "string" ? intent.context.versionId : "";
    const targetAction = intent?.body?.action === "CONFIRM" || intent?.body?.action === "REJECT" ? intent.body.action : "";
    if (!targetVersionId || !targetAction) {
      setUnknown("原决定缺少目标版本或动作，不能按当前页面对象恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    try {
      const authority = await orderApi.settlement(acting, order.id);
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
      setUnknown(`原结算决定仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原结算决定仍未取得确定回执；最新结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const decide = async (action: "CONFIRM" | "REJECT") => {
    if (!userId || locked) return;
    const pending = inspectIntent(userId, "settlement.decision", order.id);
    if (pending.state === "UNREADABLE") { setError("原结算决定记录无法读取，请联系客服核对。"); return; }
    if (pending.intent) { setUnknown(isIntentStale(pending.intent) ? STALE_MESSAGE : "检测到未完成的结算决定，请先查询原请求。"); return; }
    if (action === "CONFIRM" && !confirmable) {
      setError("服务端未返回可读的拟调整金额，无法确认这一版；请刷新或联系客服核对后重试。");
      return;
    }
    if (action === "CONFIRM" && version.early && (order.earlySettlementDisclosure || order.earlySettlementDisclosureUnavailable) && (!earlyDisclosure || !termsAccepted)) {
      setError("请阅读并同意提前结束规则后再确认。");
      return;
    }
    const acting = userId;
    setBusy(action);
    setError(null);
    const body = { action, versionHash: version.versionHash, ...(action === "REJECT" && reason.trim() ? { reason: reason.trim() } : {}), ...(action === "CONFIRM" && version.early && order.earlySettlementDisclosure ? { termsAccepted: true } : {}) };
    const outcome = await performGuardedWrite(acting, "settlement.decision", order.id, body, { versionId: version.id, orderId: order.id },
      (key, frozen, frozenContext, subject) => orderApi.decideSettlement(subject, order.id, String(frozenContext?.versionId ?? ""), frozen as { action: "CONFIRM" | "REJECT"; versionHash: string }, key), isCurrent);
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
      (key, frozen, frozenContext, subject) => orderApi.decideSettlement(subject, order.id, String(frozenContext?.versionId ?? ""), frozen as { action: "CONFIRM" | "REJECT"; versionHash: string }, key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(null);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const amounts = decisionAmountRows(party, version);
  const adjusted = isAdjustedVersion(version);
  const confirmable = !adjusted || proposedConfirmationCents(party, version) !== null;
  const subject = party === "owner" ? "净额" : "应退";
  return (
    <div className="order-trade-block">
      <div className="order-trade-heading"><h3>结算确认</h3><span className="order-trade-tag">第{version.versionNo}版</span><span className="order-trade-tag is-accent">{version.early ? "提前结算" : version.kind === "MANUAL_ADJUSTMENT" ? "人工调整" : "正常结算"}</span></div>
      {feeReconfirmationRequired ? <p className="order-inline-notice" role="status">原方案的包赔费计算口径需要更正，暂不能生效。请联系客服重新生成方案；双方需确认新方案。</p> : <p className="order-muted">金额取自已确认的期初与本次期末数据，按冻结单价计算；双方同一版本确认后生效。拒绝与确认是不同的结果，拒绝不会生效这一版。</p>}
      {adjusted ? <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>这一版含人工调整</strong><span>确认后会按「本次将确认的{subject}」生效，而不是系统计算值；请先核对两组金额与调整说明。</span></div></div> : null}
      <AmountTable rows={amounts} caption={adjusted ? `系统计算与拟调整金额（${party === "renter" ? "租客口径" : "号主口径"}）` : `本版结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}，服务端计算）`} />
      {adjusted ? <p className="order-muted">调整说明：{version.inputSnapshot?.reason ?? version.inputSnapshot?.endReason ?? "服务端未返回说明"}</p> : null}
      {unknown ? <UnknownNotice label="结算决定结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
      {error ? <p className="order-inline-notice" role="alert">{error}</p> : null}
      {version.early && (order.earlySettlementDisclosure || order.earlySettlementDisclosureUnavailable) && !decided && !locked && !feeReconfirmationRequired ? <EarlyTermsConsent key={version.versionHash} disclosure={earlyDisclosure} accepted={termsAccepted} onChange={setTermsAccepted} disabled={busy !== null} label="我已核对并接受本次提前结束的费用与退款安排" /> : null}
      {feeReconfirmationRequired ? <p className="order-muted">原版本仅供核对；如有结果未知的申请，请用上方「查询原请求」核对。</p> : decided ? <p className="order-muted">{decided.action === "CONFIRM" ? "你已确认这一版结算" : "你已拒绝这一版结算"} · {formatOrderTime(decided.createdAt)}</p> :
        readOnly ? <p className="order-muted">订单主状态已完成，本页不再提供新的确认或拒绝操作；如有一笔结果未知的申请，请用上方「查询原请求」按原键核对。</p> :
        locked ? null : (
          <div className="order-trade-actions">
            {!confirmable ? <p className="order-inline-notice" role="status">这一版的拟调整金额暂时不可读，确认已暂时停用；可以刷新、拒绝，或先查询原请求。拒绝与查询不受影响。</p> : null}
            <button type="button" className="button primary" onClick={() => void decide("CONFIRM")} disabled={busy !== null || !confirmable || (version.early && Boolean(order.earlySettlementDisclosure || order.earlySettlementDisclosureUnavailable) && (!earlyDisclosure || !termsAccepted))}>{busy === "CONFIRM" ? "确认中…" : version.early ? "确认提前结算（待客服复核）" : "确认结算"}</button>
            {!rejectOpen ? <button type="button" className="button quiet" onClick={() => setRejectOpen(true)} disabled={busy !== null}>拒绝并说明</button> : (
              <span className="order-trade-reject"><input type="text" value={reason} maxLength={500} placeholder="请填写拒绝原因（可留空）" onChange={(event) => setReason(event.target.value)} aria-label="拒绝原因" /><button type="button" className="button secondary button--sm" onClick={() => void decide("REJECT")} disabled={busy !== null}>{busy === "REJECT" ? "提交中…" : "提交拒绝"}</button><button type="button" className="button quiet button--sm" onClick={() => setRejectOpen(false)} disabled={busy !== null}>返回</button></span>
            )}
          </div>
        )}
    </div>
  );
}

/** The confirmed opening the page settles against: the confirmed version if one exists, otherwise the latest recorded one. */
export function activeOpening(openings: SettlementOpening[]): SettlementOpening | null {
  if (openings.length === 0) return null;
  return openings.find((opening) => opening.status === "CONFIRMED") ?? openings[openings.length - 1]!;
}

/**
 * The server's `stage` is authoritative when readSettlement() returns the additive field. Codes
 * that describe an opening/no-stage/unknown state keep the local reconstruction, because the
 * progress card still needs the opening acks and deadline from the same read; a client-side
 * rebuild is only a fallback for older projections that omit `stage`.
 */
function serverPhase(code: OrderSettlementStage["code"]): OrderStageFacts["phase"] | null {
  if (code === "POSTED") return "POSTED";
  if (code === "INTAKE_PENDING") return "INTAKE_PENDING";
  if (code === "DECISION_REJECTED") return "DECISION_REJECTED";
  if (code === "DECISION_PENDING") return "DECISION_PENDING";
  if (code === "DECISION_WAITING") return "DECISION_WAITING";
  if (code === "RENTING") return "RENTING";
  return null;
}

/**
 * stageFacts 仍然以服务端 stage 为准（服务端返回的 stage.code 具有绝对权威）。
 */
export function stageFacts(data: OrderSettlement, opening: SettlementOpening | null, party: OrderParty): OrderStageFacts {
  const myParty = party.toUpperCase();
  const posting = data.posting ?? null;
  const current = data.settlement ?? null;
  const request = data.currentRequest ?? null;
  const myDecision = current ? (current.decisions ?? []).find((decision) => decision.party === myParty) : undefined;
  const rejection = current?.decisions?.find((decision) => decision.action === "REJECT");
  const reconstructed: OrderStageFacts["phase"] = posting
    ? "POSTED"
    : request?.kind === "INTAKE" && request.status === "OPEN"
      ? "INTAKE_PENDING"
      : rejection
        ? "DECISION_REJECTED"
        : current && !myDecision
          ? "DECISION_PENDING"
          : current
            ? "DECISION_WAITING"
            : "RENTING";
  const stage = data.stage ?? null;
  const phase = (stage ? serverPhase(stage.code) : null) ?? reconstructed;
  return {
    rentalStarted: data.rentalStarted === true,
    phase,
    stageCode: stage?.code ?? null,
    viewerActionRequired: stage?.viewerActionRequired ?? false,
    autoConfirmDueAt: opening?.autoConfirmDueAt ?? null,
    openingGenerationState: data.openingGeneration?.state ?? null,
    openingGenerationRecoveryRequired: data.openingGenerationRecoveryRequired === true,
    feeReconfirmationRequired: data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED") === true,
    early: posting?.early === true,
    postedAt: posting?.postedAt ?? null,
    openingVersionNo: opening?.versionNo ?? null,
    settlementVersionNo: current?.versionNo ?? null,
    rejectedBy: rejection?.party ?? null,
    openingConfirmedAt: opening?.confirmedAt ?? null,
    myAck: (opening?.acks ?? []).some((ack) => ack.party === myParty),
    otherAck: (opening?.acks ?? []).some((ack) => ack.party !== myParty),
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
  const effectiveAmounts = posting.amounts ?? null;
  const feePayer = effectiveAmounts && typeof effectiveAmounts.feePayer === "string" ? effectiveAmounts.feePayer : null;
  const amountRows = postingAmountRows(party, posting);
  const captured = typeof posting.capturedCents === "string" && /^\d+$/.test(posting.capturedCents) ? moneyCents(posting.capturedCents) : "未记录";
  const charge = amountRows.find((row) => row.label === chargeRowLabel(Boolean(posting.manualAdjustment))) ?? null;
  const records = (version?.decisions ?? []).map((decision) => ({ label: `${partyLabel(decision.party)}${settlementDecisionLabel(decision.action)}`, time: decision.createdAt ?? null }));
  if (posting.postedAt) records.push({ label: "结算生效", time: posting.postedAt });
  return (
    <>
      <div className="order-trade-block">
        <div className="order-trade-heading"><h3>结算已生效</h3><span className="order-trade-tag is-accent">{posting.early ? "提前结算" : "正常结算"}{version ? ` · 第${version.versionNo}版` : ""} · 已生效</span></div>
        <dl className="order-facts order-trade-facts">
          {party === "renter" ? (
            <>
              <div><dt>{charge?.label ?? "本次结算扣费"}</dt><dd>{charge?.value ?? moneyText(posting.amounts?.renterCharge)}</dd></div>
              <div><dt>最终应退</dt><dd>{moneyCents(posting.refund?.payableCents)}</dd></div>
            </>
          ) : (
            <>
              <div><dt>本单净入账</dt><dd>{moneyCents(posting.owner?.availableCents)}</dd></div>
              <div><dt>本次毛收入</dt><dd>{moneyText(posting.owner?.gross)}</dd></div>
              {feePayer === "OWNER" ? <div><dt>包赔费（号主承担）</dt><dd>{fee ?? "未记录"}</dd></div> : null}
            </>
          )}
          {party === "renter" ? (
            <>
              <div><dt>原订单已付</dt><dd>{captured}</dd></div>
              <div><dt>退款应付款时间</dt><dd>{formatOrderTime(posting.refundDueAt)}</dd></div>
            </>
          ) : null}
        </dl>
        <p className="order-muted">{party === "owner" ? "本单净入账只表示这一笔订单的净额，不代表钱包全部余额或提现结果。" : "最终应退为已生效的应付金额；退款到账结果未记录，需以收款渠道的实际记录为准，可在我的钱包查看。"}</p>
        {amountRows.length ? <AmountTable rows={amountRows} caption={`生效结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}）`} /> : null}
        {adjustment ? (
          <div className="order-trade-sub">
            <h5>人工调整</h5>
            <dl className="order-facts order-trade-facts">
              <div><dt>{party === "owner" ? "系统净额 → 最终净额" : "系统应退 → 最终应退"}</dt><dd>{party === "owner" ? `${moneyCents(adjustment.systemOwnerNetCents)} → ${moneyCents(adjustment.postedOwnerNetCents)}` : `${moneyCents(adjustment.systemRenterRefundCents)} → ${moneyCents(adjustment.postedRenterRefundCents)}`}</dd></div>
            </dl>
            <p className="order-muted">调整说明：{adjustment.reason ?? "服务端未返回说明"}</p>
          </div>
        ) : null}
        <ConsumptionTable order={order} opening={opening} version={version} extraResources={data.extraResources} />
        <RecordList title="结算记录" records={records} />
      </div>
      <div className="order-trade-block">
        <h3>版本记录</h3>
        <VersionHistory versions={data.versions} current={version} />
      </div>
    </>
  );
}

function VersionHistory({ versions, current }: { versions: SettlementVersion[]; current: SettlementVersion | null }) {
  if (versions.length === 0) return <p className="order-muted">服务端未返回历史结算版本。</p>;
  return (
    <ul className="order-version-list">
      {versions.map((version) => {
        const reason = version.inputSnapshot?.reason ?? version.inputSnapshot?.endReason ?? version.endReason ?? null;
        const decisions = version.decisions ?? [];
        return (
          <li key={version.id} data-state={version.supersededAt ? "superseded" : version.id === current?.id ? "current" : undefined}>
            <span className="order-version-no">第{version.versionNo}版</span>
            <span className="order-version-kind">{version.early ? "提前结算" : version.kind === "MANUAL_ADJUSTMENT" ? "人工调整" : "正常结算"}</span>
            {version.supersededAt ? <span className="order-version-state">已被替换 · {formatOrderTime(version.supersededAt)}</span> : <span className="order-version-state">当前版本</span>}
            {decisions.length ? <span className="order-version-decisions">{decisions.map((decision) => `${partyLabel(decision.party)}${settlementDecisionLabel(decision.action)}${decision.createdAt ? ` ${formatOrderTime(decision.createdAt)}` : ""}`).join(" · ")}</span> : null}
            {reason ? <span className="order-version-reason">说明：{reason}</span> : null}
            {version.supersededAt ? <span className="order-version-readonly">历史版本只读，不能再对其确认。</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function SettlementAction({
  order,
  party,
  onChanged,
  onStageFacts,
  modal = false,
  focus = "settlement",
}: {
  order: Order;
  party: OrderParty;
  onChanged: () => void;
  onStageFacts?: (facts: OrderStageFacts | null, failed: boolean) => void;
  modal?: boolean;
  focus?: SettlementFocus;
}) {
  const session = useUserSession();
  const subject = useMemo(() => captureOrderSubject(session.userId, session.identityVersion), [session.userId, session.identityVersion]);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: OrderSettlement } | { status: "unavailable" } | { status: "error" }>({ status: "loading" });
  const report = useRef(onStageFacts);
  useEffect(() => {
    report.current = onStageFacts;
  }, [onStageFacts]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    report.current?.(null, false);
    if (!subject) {
      report.current?.(null, true);
      setState({ status: "error" });
      return () => controller.abort();
    }
    orderApi.settlement(subject, order.id, controller.signal).then((data) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      setState({ status: "ready", data });
      report.current?.(stageFacts(data, activeOpening(data.openings), party), false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      report.current?.(null, true);
      if (error instanceof OrderRequestError && error.status === 404) setState({ status: "unavailable" });
      else setState({ status: "error" });
    });
    return () => {
      controller.abort();
      report.current?.(null, false);
    };
  }, [order.id, party, reload, subject, session]);

  const refresh = useCallback(() => {
    setReload((value) => value + 1);
    onChanged();
  }, [onChanged]);

  /** 写回执已是权威结算单：立即呈现生效结果并上报阶段事实，外层订单详情仍按原路径刷新。 */
  const applySettlement = useCallback((data: OrderSettlement) => {
    setState({ status: "ready", data });
    report.current?.(stageFacts(data, activeOpening(data.openings), party), false);
    onChanged();
  }, [party, onChanged]);

  if (state.status === "loading") {
    if (modal) return <div className="order-action-form"><p className="order-muted" role="status">正在读取履约记录…</p></div>;
    return (
      <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-busy="true" aria-label="开租与结算">
        <h2 className="order-section-title">开租与结算</h2>
        <p className="order-muted">正在读取结算记录…</p>
      </section>
    );
  }
  if ((state.status === "unavailable" || state.status === "error") && onStageFacts) return null;
  if (state.status === "unavailable") {
    if (modal) return <div className="order-action-form"><p className="order-inline-notice" role="status">履约明细暂时无法读取，请稍后重试或联系客服。</p></div>;
    return (
      <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-label="开租与结算">
        <h2 className="order-section-title">开租与结算</h2>
        <p className="order-muted">结算明细暂时无法读取，消耗、费用与退款金额尚无法展示。</p>
      </section>
    );
  }
  if (state.status === "error") {
    if (modal) return <div className="order-action-form"><p className="order-inline-notice" role="alert">履约记录没有读取成功，请稍后重试或联系客服。</p></div>;
    return (
      <section className="order-detail-section order-trade-panel" id="order-trade-actions" role="alert">
        <h2 className="order-section-title">开租与结算</h2>
        <p className="order-inline-notice">结算记录没有读取成功。</p>
      </section>
    );
  }
  const data = state.data;
  const terminal = order.status === "COMPLETED";
  const opening = activeOpening(data.openings);
  const current = data.settlement ?? null;
  const myParty = party.toUpperCase();
  const myDecision = current ? (current.decisions ?? []).find((decision) => decision.party === myParty) : undefined;
  const posting = data.posting ?? null;
  const openIntake = data.currentRequest?.kind === "INTAKE" && data.currentRequest.status === "OPEN";
  const rejected = current?.decisions?.some((decision) => decision.action === "REJECT") === true;

  if (modal) {
    const form = (() => {
      if (focus === "opening") {
        return opening ? (
          <OpeningPanel opening={opening} order={order} party={party} onChanged={refresh} readOnly={terminal} />
        ) : (
          <p className="order-muted">开租清单还没有准备好，请稍后刷新或联系客服。</p>
        );
      }
      // 已过账生效优先于「等待对方确认」：最后一方确认的回执里 posting 已存在，
      // 此时再展示等待对方确认会与服务端事实矛盾。
      if (posting) return <PostingResult data={data} order={order} party={party} posting={posting} />;
      if (focus === "decision") {
        if (!current) return <p className="order-muted">当前没有需要你确认的结算版本，请刷新后查看。</p>;
        if (myDecision) {
          return (
            <div className="order-trade-block">
              <h3>等待对方确认 <span className="order-trade-tag">第{current.versionNo}版</span></h3>
              <p className="order-muted">你已确认这一版结算，无需重复提交。</p>
              <AmountTable rows={decisionAmountRows(party, current)} caption={`本版金额明细（${party === "renter" ? "租客口径" : "号主口径"}）`} />
            </div>
          );
        }
        return <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} onApplied={applySettlement} readOnly={terminal} feeReconfirmationRequired={data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED")} />;
      }
      if (current && data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED")) {
        return <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} onApplied={applySettlement} readOnly={terminal} feeReconfirmationRequired />;
      }
      if (openIntake) return <p className="order-muted">结束申请已提交，客服核对后会生成结算方案。</p>;
      if (current && rejected) return <p className="order-muted">上一版结算未达成一致，请联系客服生成新的方案。</p>;
      if (current && !myDecision) return <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} onApplied={applySettlement} readOnly={terminal} />;
      if (current && myDecision) return <p className="order-muted">你已确认本版结算，等待对方确认。</p>;
      if (opening && data.rentalStarted) return <EndingForm opening={opening} order={order} party={party} onChanged={refresh} consumptionMode={data.consumptionMode} extraResources={data.extraResources} readOnly={terminal} />;
      return <p className="order-muted">当前没有可执行的结算操作，请稍后刷新或联系客服。</p>;
    })();
    return <div className="order-action-form">{form}</div>;
  }

  return (
    <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-label="开租与结算">
      <div className="order-trade-heading">
        <h2 className="order-section-title">{terminal ? "开租与结算记录" : "开租与结算"}</h2>
        <button type="button" className="button quiet button--sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />刷新</button>
      </div>
      {!opening ? (
        <div className="order-trade-block">
          <h3>期初库存</h3>
          <p className="order-muted">
            {data.openingGeneration?.state === "REVIEW_REQUIRED" || data.openingGenerationRecoveryRequired
              ? data.openingGeneration?.reason === "LEGACY_V1_QUOTE_REVIEW"
                ? "本单使用旧版建单，缺少个性化资金/包赔依据，系统不会自动生成开租清单；请联系客服按未开租取消退款或使用新版重新下单。"
                : "付款已接纳，但本单冻结资料不足或自动生成记录暂不可用，开租清单正在等待客服核对。可点本区右上角「刷新」重新读取，或用页面上方「下一步」联系客服办理；用户侧不会自行生成清单或交付。订单页与聊天不受影响。"
              : "付款接纳后系统会按本单冻结报价生成开租清单；当前尚未读取到清单。可点本区右上角「刷新」重新读取，或用页面上方「下一步」联系客服核对；用户侧不会自行生成清单或交付，订单群准备好不等于已经开租。"}
          </p>
        </div>
      ) : (
        <OpeningPanel opening={opening} order={order} party={party} onChanged={refresh} readOnly={terminal} />
      )}
      {opening && data.rentalStarted ? (
        <>
          {posting ? (
            <PostingResult data={data} order={order} party={party} posting={posting} />
          ) : current && data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED") ? (
            <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} onApplied={applySettlement} readOnly feeReconfirmationRequired />
          ) : openIntake ? (
            <div className="order-trade-block">
              <h3>结束申请待客服处理</h3>
              <p className="order-muted">已提交期末数据，等待受权客服核实原因并复核；复核与双方确认完成后结算生效。期间不会重复受理同一份结束申请。</p>
            </div>
          ) : current && rejected ? (
            <div className="order-trade-block">
              <h3>{myDecision?.action === "REJECT" ? "你已拒绝" : "未达成一致的结算"}第{current.versionNo}版</h3>
              <p className="order-muted">拒绝不会使这一版生效；服务端会按新的期末数据或人工调整生成新版本，请按最新版本重新核对后再决定。</p>
              <AmountTable rows={decisionAmountRows(party, current)} caption={`被拒绝版本金额明细（${party === "renter" ? "租客口径" : "号主口径"}${isAdjustedVersion(current) ? "，含人工调整" : ""}）`} />
            </div>
          ) : current && !myDecision ? (
            <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} onApplied={applySettlement} readOnly={terminal} />
          ) : current && myDecision ? (
            <div className="order-trade-block">
              <h3>等待对方确认 <span className="order-trade-tag">第{current.versionNo}版</span></h3>
              <p className="order-muted">你已在这一版结算上完成操作；金额变化会生成新版本并要求重新确认。</p>
              <AmountTable rows={decisionAmountRows(party, current)} caption={`当前版本金额明细（${party === "renter" ? "租客口径" : "号主口径"}${isAdjustedVersion(current) ? "，含人工调整" : ""}）`} />
              <RecordList title="结算记录" records={(current.decisions ?? []).map((decision) => ({ label: `${partyLabel(decision.party)}${settlementDecisionLabel(decision.action)}`, time: decision.createdAt ?? null }))} />
            </div>
          ) : (
            <EndingForm opening={opening} order={order} party={party} onChanged={refresh} consumptionMode={data.consumptionMode} extraResources={data.extraResources} readOnly={terminal} />
          )}
        </>
      ) : null}
      {opening && !posting && data.versions.length > 1 ? (
        <div className="order-trade-block">
          <h3>历史结算版本</h3>
          <VersionHistory versions={data.versions} current={current} />
        </div>
      ) : null}
    </section>
  );
}
