"use client";
import { useState } from "react";
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import type { OrderTeamAccess, OrderTeamTerms } from "./order-team-panel";
import type { OrderReference } from "@zzsh/im-client/nim-web-client";
import "./order-card.css";

/** Order-stage cards travel as ordinary chat messages; every fact is read from the
    role-projected order access, never from the card payload itself. */
export type OrderCardKind = NonNullable<NimMessageLike["card"]>["kind"];
type Party = OrderTeamTerms["viewerParty"];
type Basis = OrderTeamTerms["basis"];
type OpeningAckSource = "PARTY" | "ON_BEHALF" | "AUTO";
type ConfirmTarget = { mode: "PARTY" } | { mode: "ON_BEHALF"; party: "RENTER" | "OWNER" };
const PENDING = "金额依据待核对";
const HEADINGS: Record<OrderCardKind, string> = {
  ORDER_OPENING: "开租确认",
  ORDER_ENDING: "结束确认",
  ORDER_SETTLED: "结算完成",
  ORDER_PRICE_CHANGE: "价格调整待确认",
};
/** Cents only. Anything else stays unreadable instead of being shown as 0. */
function amountText(value: string | null | undefined, basis: Basis): string {
  if (basis !== "QUOTE" || typeof value !== "string" || !/^(0|[1-9]\d{0,17})$/.test(value)) return PENDING;
  const digits = value.padStart(3, "0");
  return `¥${groupDigits(digits.slice(0, -2))}.${digits.slice(-2)}`;
}
function groupDigits(value: string): string {
  const bare = value.replace(/^0+(?=\d)/, "");
  return bare.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** Quantities arrive as strings. Unreadable ones stay unknown, never 0. */
function quantityNumber(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function quantityText(value: string | null | undefined): string {
  const numeric = quantityNumber(value);
  return numeric === null ? "数量待核对" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(numeric);
}
/** Zero-quantity rows are absent; an unreadable quantity is kept so it can be checked. */
function keepsItem(line: OrderTeamTerms["lines"][number]): boolean {
  const numeric = quantityNumber(line.quantity);
  return numeric === null || numeric > 0;
}
function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date) : "时间暂不可用";
}
function dueLabel(value: string | null | undefined): string {
  if (!value) return "未提供";
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return "时间暂不可用";
  return `${at <= Date.now() ? "已到期 · " : ""}${timeLabel(value)}`;
}
function partyOf(info: OrderTeamAccess): Party {
  const declared = info.terms?.viewerParty;
  if (declared === "RENTER" || declared === "OWNER" || declared === "STAFF") return declared;
  // Older payloads without terms: the member table still knows who is looking.
  const member = info.members.find(item => item.accountId === info.viewerAccountId);
  return member?.party === "OWNER" ? "OWNER" : member?.party === "STAFF" ? "STAFF" : "RENTER";
}
function basisOf(terms: OrderTeamTerms | undefined): Basis {
  return terms?.basis === "QUOTE" ? "QUOTE" : "UNKNOWN";
}
/** Sums cents without ever turning an unreadable amount into a fake 0. */
function sumAmounts(values: Array<string | null | undefined>): string | null {
  if (!values.length) return null;
  let total = BigInt(0);
  for (const value of values) {
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,17})$/.test(value)) return null;
    total += BigInt(value);
  }
  return total.toString();
}
function endStateText(state: OrderTeamAccess["endState"]): string {
  return state === "REQUESTED" ? "已发起 · 待双方确认" : state === "POSTED" ? "已提交 · 待结算" : state === "NONE" ? "尚未发起结束" : "待确认";
}
function windowText(sendUntil: string | null | undefined): string {
  const until = typeof sendUntil === "string" ? new Date(sendUntil).getTime() : Number.NaN;
  if (!Number.isFinite(until)) return "仅可查看";
  return Date.now() < until ? `可沟通至 ${timeLabel(sendUntil!)}` : "仅可查看 · 已超过 72 小时";
}
function ackSourceText(confirmed: boolean, source: OpeningAckSource | null | undefined): string {
  if (!confirmed) return "待确认";
  if (source === "AUTO") return "已确认 · 自动";
  if (source === "ON_BEHALF") return "已确认 · 代确认";
  return "已确认";
}
function partyText(party: "RENTER" | "OWNER"): string {
  return party === "RENTER" ? "租客" : "号主";
}
/** Server rejection codes become stable copy; raw messages/ids never reach the card. */
function confirmErrorText(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 403) return "当前账号无权确认本单，请联系平台客服。";
  if (status === 401 || status === 423) return "登录状态已变化，请重新确认身份后再操作。";
  if (status === 409) return "期初版本已更新或已确认，请刷新后再操作。";
  return "确认未完成，请稍后重试。";
}
function DocIcon() {
  return <svg className="order-card-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 12.5h6M9 16.5h4" />
  </svg>;
}
function CheckIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
}
function ChevronIcon({ className }: { className: string }) {
  return <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
}
function ArrowIcon({ className }: { className: string }) {
  return <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
}
function CopyIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>;
}
function InfoIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>;
}

/** Display-only shared reference; the destination authorizes access to order facts. */
export function OrderReferenceMessage({ order, onOpenOrder }: { order: OrderReference; onOpenOrder?: (id: string) => void }) {
  const action = <><span>查看订单</span><ArrowIcon className="order-card-action-chevron" /></>;
  return <article className="order-card order-reference-card" aria-label="关联订单卡片">
    <header className="order-card-head"><DocIcon /><strong>关联订单</strong><span className="order-reference-party">{order.party === "owner" ? "出租订单" : "租入订单"}</span></header>
    <div className="order-card-account"><strong>{order.title}</strong></div>
    <footer className="order-card-foot"><span className="order-card-no">订单号 <b>{order.displayNo}</b></span>
      {onOpenOrder ? <button type="button" className="order-card-action" onClick={() => onOpenOrder(order.id)}>{action}</button> : <a className="order-card-action" href={`/orders/${encodeURIComponent(order.id)}`}>{action}</a>}
    </footer>
  </article>;
}

/**
 * One order-stage message. It stays a chat message: a stage header, the two-party
 * confirmation, one account line, a compact amount list and a footer with the
 * order number. The order detail page owns the full inventory and the actions.
 */
export function OrderCardMessage({ message, info, onOpenOrder, onConfirmOpening, onConfirmOpeningOnBehalf }: {
  message: NimMessageLike; info: OrderTeamAccess; onOpenOrder?: () => void;
  /** Party confirmation runs through the user order endpoint; resolution is never faked locally. */
  onConfirmOpening?: (info: OrderTeamAccess) => Promise<void>;
  /** Staff confirmation on behalf of one missing party; the server re-checks the responsible admin. */
  onConfirmOpeningOnBehalf?: (info: OrderTeamAccess, party: "RENTER" | "OWNER") => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [confirmSubmittedFor, setConfirmSubmittedFor] = useState<string | null>(null);
  const card = message.card;
  if (!card) return null;
  const heading = HEADINGS[card.kind] ?? HEADINGS.ORDER_PRICE_CHANGE;
  const terms = info.terms;
  const basis = basisOf(terms);
  const party = partyOf(info);
  const staff = party === "STAFF" ? terms?.staff : undefined;
  const lines = terms?.lines ?? [];
  const money = (value: string | null | undefined) => amountText(value, basis);
  const both = (buyer: string | null | undefined, owner: string | null | undefined) => `租客 ${money(buyer)} · 号主 ${money(owner)}`;
  const readAmounts = basis === "QUOTE";
  const frozenHaff = info.frozenInventory?.find(line => line.unit === "HAFF_BASE");
  // Only a matched HAFF line may carry the 哈夫币 row; an unnamed first line is not assumed to be it.
  const haffLine = terms?.lines.find(line => line.itemId === frozenHaff?.itemId) ?? terms?.lines.find(line => /哈夫币/.test(line.name ?? ""));
  const haffQuantity = haffLine?.quantity ?? frozenHaff?.quantity ?? null;
  const isHaff = (line: OrderTeamTerms["lines"][number]) => line === haffLine;
  // Quantity 0 is absent, not a free item. Unreadable quantities stay visible to be checked.
  const itemLines = lines.filter(line => !isHaff(line) && keepsItem(line));
  const itemBuyerTotal = sumAmounts(itemLines.map(line => party === "STAFF" ? line.buyerAmount : line.amount));
  const itemOwnerTotal = sumAmounts(itemLines.map(line => line.ownerAmount));
  const itemCount = itemLines.length;
  const itemAmount = !itemCount ? null : !readAmounts ? PENDING : party === "STAFF" ? both(itemBuyerTotal, itemOwnerTotal) : money(itemBuyerTotal);
  const itemEmptyText = lines.length ? "无额外物品" : "清单待核对";
  type Figure = { label: string; value: string };
  const figures: Figure[] = [];
  const meta: Figure[] = [];
  let haffAmount: string | null = null;
  let depositLabel: string | null = null;
  let platform: string | null = null;
  let note: string | null = null;
  let showAcks = false;

  if (card.kind === "ORDER_OPENING") {
    haffAmount = party === "STAFF" ? both(haffLine?.buyerAmount, haffLine?.ownerAmount) : money(haffLine?.amount);
    if (party === "RENTER") { depositLabel = "押金"; figures.push({ label: "实付", value: money(terms?.paidTotal) }); }
    else if (party === "OWNER") { depositLabel = "保证金"; figures.push({ label: "应收", value: money(terms?.rentalAmount) }); }
    else figures.push({ label: "租客合计", value: money(staff?.buyerTotal) }, { label: "号主合计", value: money(staff?.ownerTotal) });
    if (party === "STAFF") platform = money(staff?.platformContribution);
    showAcks = true;
    note = readAmounts ? "金额按订单冻结价展示，双方确认前不变。" : null;
  } else if (card.kind === "ORDER_ENDING") {
    meta.push({ label: "结束状态", value: endStateText(info.endState) }, { label: "到期时间", value: dueLabel(info.dueAt) });
    if (party === "RENTER") figures.push({ label: "实付", value: money(terms?.paidTotal) }, { label: "押金", value: money(terms?.depositAmount) });
    else if (party === "OWNER") figures.push({ label: "应收", value: money(terms?.rentalAmount) }, { label: "保证金", value: money(terms?.depositAmount) });
    else figures.push({ label: "租客合计", value: money(staff?.buyerTotal) }, { label: "号主合计", value: money(staff?.ownerTotal) });
    if (party === "STAFF") platform = money(staff?.platformContribution);
    note = "应退/应收金额以双方确认的结算单为准。";
  } else if (card.kind === "ORDER_SETTLED") {
    meta.push({ label: "结算状态", value: "已结算" }, { label: "沟通窗口", value: windowText(info.sendUntil) });
    if (party === "RENTER") figures.push({ label: "我的实付", value: money(terms?.paidTotal) });
    else if (party === "OWNER") figures.push({ label: "我的应收", value: money(terms?.rentalAmount) });
    else figures.push({ label: "租客合计", value: money(staff?.buyerTotal) }, { label: "号主合计", value: money(staff?.ownerTotal) });
    if (party === "STAFF") platform = money(staff?.platformContribution);
    note = "到账时间以支付渠道为准。";
  } else {
    note = "价格调整内容以订单详情为准，确认前金额不变。";
  }

  const acks = info.openingAcks;
  const viewerAck = party === "RENTER" ? acks?.renter : party === "OWNER" ? acks?.owner : null;
  const openingConfirmed = card.kind === "ORDER_OPENING"
    ? info.openingState ? info.openingState === "CONFIRMED" : Boolean(acks?.renter && acks?.owner)
    : false;
  const openingId = typeof info.openingId === "string" && info.openingId ? info.openingId : null;
  const openingVersion = Number.isInteger(info.openingVersion) ? Number(info.openingVersion) : null;
  const openingPending = card.kind === "ORDER_OPENING" && !openingConfirmed && info.orderStatus === "PAID";
  const missingParties = (["RENTER", "OWNER"] as const).filter(item => !acks?.[item === "RENTER" ? "renter" : "owner"]);
  const canPartyConfirm = openingPending && party !== "STAFF" && viewerAck === false
    && openingId !== null && openingVersion !== null && Boolean(onConfirmOpening);
  const canConfirmOnBehalf = openingPending && party === "STAFF" && missingParties.length > 0
    && openingId !== null && openingVersion !== null && Boolean(onConfirmOpeningOnBehalf);
  const openingKey = `${openingId ?? ""}:${openingVersion ?? ""}`;
  const confirmSubmitted = confirmSubmittedFor === openingKey;
  const openingDue = canPartyConfirm && info.openingConfirmDueAt ? info.openingConfirmDueAt : null;
  const actionLabel = card.kind === "ORDER_OPENING"
    ? party === "STAFF" ? "查看本单" : canPartyConfirm ? "查看订单详情" : viewerAck === false ? "查看并确认开租" : "查看订单详情"
    : card.kind === "ORDER_ENDING" ? party === "STAFF" ? "去处理结束" : "查看并处理" : "查看订单详情";
  // The user site needs the party view to open the right order tab; staff always pass a callback.
  const detailHref = party === "STAFF"
    ? `/account?orderId=${encodeURIComponent(info.orderId)}`
    : `/account?view=${party === "OWNER" ? "leased" : "rentals"}&orderId=${encodeURIComponent(info.orderId)}`;
  const lineAmount = (line: OrderTeamTerms["lines"][number]) => party === "STAFF"
    ? `租客 ${money(line.buyerAmount)} · 号主 ${money(line.ownerAmount)}`
    : money(line.amount);
  const accountTitle = info.account.title?.trim() || "账号";
  const totals = <>
    {figures.length ? <dl className="order-card-figures" data-count={figures.length}>{figures.map(figure =>
      <div className="order-card-figure" key={figure.label}><dt>{figure.label}</dt><dd data-pending={figure.value === PENDING ? "true" : undefined}>{figure.value}</dd></div>)}</dl> : null}
    {platform ? <p className="order-card-platform"><span>平台贡献</span><strong>{platform}</strong></p> : null}
  </>;
  const copyDisplayNo = async () => {
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) return;
      await clipboard.writeText(info.displayNo);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const openConfirm = (target: ConfirmTarget) => {
    if (confirming) return;
    setConfirmError("");
    setConfirmTarget(target);
  };
  const closeConfirm = () => {
    if (confirming) return;
    setConfirmTarget(null);
    setConfirmError("");
  };
  const submitConfirm = async () => {
    const target = confirmTarget;
    if (!target || confirming) return;
    setConfirming(true);
    setConfirmError("");
    try {
      if (target.mode === "PARTY") await onConfirmOpening?.(info);
      else await onConfirmOpeningOnBehalf?.(info, target.party);
      setConfirmTarget(null);
      setConfirmSubmittedFor(openingKey);
    } catch (error) {
      setConfirmError(confirmErrorText(error));
    } finally {
      setConfirming(false);
    }
  };

  return <article className="order-card" data-kind={card.kind} data-party={party} data-basis={basis} data-order-id={card.orderId}
    aria-label={`订单阶段卡：${heading}`}>
    <header className="order-card-head">
      <DocIcon />
      <strong className="order-card-title">{heading}</strong>
    </header>
    {showAcks ? <div className="order-card-acks" aria-label="开租确认状态">
      <div className="order-card-ack" data-state={acks?.renter ? "confirmed" : "pending"} data-self={party === "RENTER" ? "true" : undefined} data-source={acks?.renter ? info.openingAckSources?.renter ?? "PARTY" : undefined}>
        <span className="order-card-ack-mark" aria-hidden="true">{acks?.renter ? <CheckIcon /> : null}</span>
        <span className="order-card-ack-text">
          <span className="order-card-ack-name">租客</span>
          <span className="order-card-ack-state">{ackSourceText(Boolean(acks?.renter), info.openingAckSources?.renter)}</span>
        </span>
      </div>
      <span className="order-card-ack-link" aria-hidden="true" />
      <div className="order-card-ack" data-state={acks?.owner ? "confirmed" : "pending"} data-self={party === "OWNER" ? "true" : undefined} data-source={acks?.owner ? info.openingAckSources?.owner ?? "PARTY" : undefined}>
        <span className="order-card-ack-mark" aria-hidden="true">{acks?.owner ? <CheckIcon /> : null}</span>
        <span className="order-card-ack-text">
          <span className="order-card-ack-name">号主</span>
          <span className="order-card-ack-state">{ackSourceText(Boolean(acks?.owner), info.openingAckSources?.owner)}</span>
        </span>
      </div>
    </div> : null}
    {showAcks && openingConfirmed && info.openingConfirmSource === "AUTO" ? <p className="order-card-ack-note">双方未确认，已按 40 分钟规则由系统自动确认；租期自确认时起算。</p> : null}
    {showAcks && openingConfirmed && info.openingConfirmSource === "ON_BEHALF" ? <p className="order-card-ack-note">客服已代未确认方完成确认；租期自确认时起算。</p> : null}
    <div className="order-card-subject">
      <strong className="order-card-account">{accountTitle}</strong>
      <span className="order-card-game">{info.gameName}</span>
    </div>
    {!readAmounts ? <p className="order-card-verify" role="status"><i className="order-card-warn-dot" aria-hidden="true" />金额依据待核对，最终以订单详情为准。</p> : null}
    {meta.length ? <dl className="order-card-meta">{meta.map(item =>
      <div className="order-card-meta-row" key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl> : null}
    {card.kind === "ORDER_OPENING" ? <div className="order-card-money">
      <div className="order-card-rows">
        <div className="order-card-row">
          <span className="order-card-row-label">哈夫币<small className="order-card-row-hint">{quantityText(haffQuantity)}</small></span>
          <span className="order-card-row-value">{haffAmount}</span>
        </div>
        {depositLabel ? <div className="order-card-row">
          <span className="order-card-row-label">{depositLabel}</span>
          <span className="order-card-row-value">{money(terms?.depositAmount)}</span>
        </div> : null}
        {itemCount ? <button type="button" className="order-card-row order-card-items-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          <span className="order-card-row-label">物品清单（{itemCount} 项）<ChevronIcon className="order-card-chevron" /></span>
          <span className="order-card-row-value">{itemAmount}</span>
        </button> : <div className="order-card-row">
          <span className="order-card-row-label">物品清单{lines.length ? "（0 项）" : ""}</span>
          <span className="order-card-row-value order-card-row-muted">{itemEmptyText}</span>
        </div>}
      </div>
      {expanded && itemCount > 0 ? <ul className="order-card-lines" aria-label="物品清单">
        {itemLines.map(line => <li className="order-card-line" key={line.itemId}>
          <span className="order-card-line-name">{line.name?.trim() || "未命名资源"}</span>
          <span className="order-card-line-qty">× {quantityText(line.quantity)}</span>
          {readAmounts ? <span className="order-card-line-amount">{lineAmount(line)}</span> : null}
        </li>)}
      </ul> : null}
      {totals}
    </div> : null}
    {card.kind !== "ORDER_OPENING" && (figures.length || platform) ? <div className="order-card-money">{totals}</div> : null}
    {canPartyConfirm && !confirmSubmitted ? <div className="order-card-confirm" role="group" aria-label="开租确认操作">
      <p className="order-card-confirm-copy">{openingDue ? `双方未确认时，将于 ${timeLabel(openingDue)} 自动确认并开始租期。` : "双方确认后开始租期；超时未确认将由系统自动确认。"}</p>
      <button type="button" className="order-card-confirm-button" onClick={() => openConfirm({ mode: "PARTY" })}>确认开租</button>
    </div> : null}
    {confirmSubmitted && !viewerAck ? <p className="order-card-confirm-state" role="status">已提交确认，正在刷新订单状态…</p> : null}
    {canConfirmOnBehalf ? <div className="order-card-confirm" data-staff="true" role="group" aria-label="客服代确认操作">
      <p className="order-card-confirm-copy">代确认只补齐未确认方，并记录操作人与审计；租期自确认时起算。</p>
      <div className="order-card-confirm-actions">{missingParties.map(item =>
        <button type="button" className="order-card-confirm-button" key={item} onClick={() => openConfirm({ mode: "ON_BEHALF", party: item })}>代{partyText(item)}确认</button>)}</div>
    </div> : null}
    <footer className="order-card-foot">
      <span className="order-card-no">
        <span>订单 <b>{info.displayNo}</b></span>
        <button type="button" className="order-card-copy" aria-label={`复制订单号 ${info.displayNo}`} title="复制订单号" onClick={copyDisplayNo}><CopyIcon /></button>
        <span className="order-card-copy-state" role="status" aria-live="polite">{copied ? "已复制" : ""}</span>
      </span>
      {onOpenOrder
        ? <button type="button" className="order-card-action" onClick={onOpenOrder} title="打开订单详情完成确认与操作">{actionLabel}<ArrowIcon className="order-card-action-chevron" /></button>
        : <a className="order-card-action" href={detailHref} title="打开订单详情完成确认与操作">{actionLabel}<ArrowIcon className="order-card-action-chevron" /></a>}
    </footer>
    {note ? <p className="order-card-note"><InfoIcon /><span>{note}</span></p> : null}
    {confirmTarget ? <div className="order-card-dialog-layer" onClick={event => { if (event.target === event.currentTarget) closeConfirm(); }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeConfirm(); } }}>
      <div className="order-card-dialog" role="dialog" aria-modal="true" aria-label={confirmTarget.mode === "PARTY" ? "确认开租" : `代${partyText(confirmTarget.party)}确认开租`} data-mode={confirmTarget.mode} aria-busy={confirming}>
        <strong className="order-card-dialog-title">{confirmTarget.mode === "PARTY" ? "确认开租" : `代${partyText(confirmTarget.party)}确认开租`}</strong>
        <p className="order-card-dialog-order">订单 {info.displayNo} · {accountTitle}</p>
        <p className="order-card-dialog-copy">{confirmTarget.mode === "PARTY"
          ? "请核对账号、押金与物品清单。提交确认后等待另一方确认；双方确认或 40 分钟到期后开始租期，起租时间以平台确认信息为准。"
          : `将以客服身份代${partyText(confirmTarget.party)}确认；该操作会记录审计，且只补齐未确认方，不会覆盖已确认记录。`}</p>
        {confirmError ? <p className="order-card-dialog-error" role="alert">{confirmError}</p> : null}
        <div className="order-card-dialog-actions">
          <button type="button" className="order-card-dialog-cancel" onClick={closeConfirm} disabled={confirming} autoFocus>取消</button>
          <button type="button" className="order-card-dialog-confirm" onClick={() => void submitConfirm()} disabled={confirming} aria-busy={confirming}>
            {confirming ? "确认中…" : confirmTarget.mode === "PARTY" ? "确认开租" : `代${partyText(confirmTarget.party)}确认`}
          </button>
        </div>
      </div>
    </div> : null}
  </article>;
}
