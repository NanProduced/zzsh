"use client";
import { useState } from "react";
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import type { OrderTeamAccess, OrderTeamTerms } from "./order-team-panel";
import "./order-card.css";

/** Order-stage cards travel as ordinary chat messages; every fact is read from the
    role-projected order access, never from the card payload itself. */
export type OrderCardKind = NonNullable<NimMessageLike["card"]>["kind"];
type Party = OrderTeamTerms["viewerParty"];
type Basis = OrderTeamTerms["basis"];
const PENDING = "金额依据待核对";
const HEADINGS: Record<OrderCardKind, { tag: string; title: string }> = {
  ORDER_OPENING: { tag: "本单确认", title: "账号信息与开租确认" },
  ORDER_ENDING: { tag: "订单动态", title: "结束确认" },
  ORDER_SETTLED: { tag: "订单动态", title: "结算完成" },
  ORDER_PRICE_CHANGE: { tag: "订单动态", title: "价格调整待确认" },
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

/**
 * One order-stage message. Layout stays a message, not a dashboard: a compact
 * summary first, at most three item rows, and no nested cards or native controls.
 */
export function OrderCardMessage({ message, info, onOpenOrder }: { message: NimMessageLike; info: OrderTeamAccess; onOpenOrder?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const card = message.card;
  if (!card) return null;
  const heading = HEADINGS[card.kind] ?? HEADINGS.ORDER_PRICE_CHANGE;
  const terms = info.terms;
  const basis = basisOf(terms);
  const party = partyOf(info);
  const staff = party === "STAFF" ? terms?.staff : undefined;
  const lines = terms?.lines ?? [];
  const money = (value: string | null | undefined) => amountText(value, basis);
  const both = (buyer: string | null | undefined, owner: string | null | undefined) => `买家 ${money(buyer)} · 号主 ${money(owner)}`;
  const readAmounts = basis === "QUOTE";
  const frozenHaff = info.frozenInventory?.find(line => line.unit === "HAFF_BASE");
  // Only a matched HAFF line may carry the 哈夫币 row; an unnamed first line is not assumed to be it.
  const haffLine = terms?.lines.find(line => line.itemId === frozenHaff?.itemId) ?? terms?.lines.find(line => /哈夫币/.test(line.name ?? ""));
  const haffQuantity = haffLine?.quantity ?? frozenHaff?.quantity ?? null;
  const isHaff = (line: OrderTeamTerms["lines"][number]) => line === haffLine;
  const itemLines = lines.filter(line => !isHaff(line));
  const itemBuyerTotal = sumAmounts(itemLines.map(line => party === "STAFF" ? line.buyerAmount : line.amount));
  const itemOwnerTotal = sumAmounts(itemLines.map(line => line.ownerAmount));
  const visibleLines = expanded ? itemLines : itemLines.slice(0, 3);
  const rows: Array<{ label: string; value: string }> = [];
  let note: string | null = null;
  let showAcks = false;

  if (card.kind === "ORDER_OPENING") {
    rows.push({
      label: "哈夫币",
      value: `${haffQuantity ? groupDigits(haffQuantity) : "数量待核对"}${readAmounts ? ` · ${party === "STAFF" ? both(haffLine?.buyerAmount, haffLine?.ownerAmount) : money(haffLine?.amount)}` : ""}`,
    });
    rows.push({
      label: "物品",
      value: `${itemLines.length ? `${itemLines.length} 项${readAmounts ? ` · ${party === "STAFF" ? both(itemBuyerTotal, itemOwnerTotal) : `合计 ${money(itemBuyerTotal)}`}` : ""}` : lines.length ? "无额外物品" : "清单待核对"}`,
    });
    rows.push({
      label: party === "OWNER" ? "保证金 / 应收" : party === "STAFF" ? "双边金额" : "押金 / 实付",
      value: party === "OWNER"
        ? `保证金 ${money(terms?.depositAmount)} · 应收 ${money(terms?.rentalAmount)}`
        : party === "STAFF"
          ? `买家合计 ${money(staff?.buyerTotal)} · 号主合计 ${money(staff?.ownerTotal)}`
          : `押金 ${money(terms?.depositAmount)} · 实付 ${money(terms?.paidTotal)}`,
    });
    if (party === "STAFF") rows.push({ label: "平台贡献", value: money(staff?.platformContribution) });
    showAcks = true;
    note = readAmounts ? "金额按订单冻结价展示，双方确认前不变。" : null;
  } else if (card.kind === "ORDER_ENDING") {
    rows.push({ label: "结束状态", value: endStateText(info.endState) });
    rows.push({ label: "到期时间", value: dueLabel(info.dueAt) });
    rows.push({
      label: party === "OWNER" ? "应收 / 保证金" : party === "STAFF" ? "双边金额" : "应退 / 实付",
      value: party === "OWNER"
        ? `应收 ${money(terms?.rentalAmount)} · 保证金 ${money(terms?.depositAmount)}`
        : party === "STAFF"
          ? `买家合计 ${money(staff?.buyerTotal)} · 号主合计 ${money(staff?.ownerTotal)}`
          : `实付 ${money(terms?.paidTotal)} · 押金 ${money(terms?.depositAmount)}`,
    });
    if (party === "STAFF") rows.push({ label: "平台贡献", value: money(staff?.platformContribution) });
    note = "应退/应收金额以双方确认的结算单为准。";
  } else if (card.kind === "ORDER_SETTLED") {
    rows.push({ label: "结算状态", value: "已结算" });
    rows.push({
      label: party === "OWNER" ? "我的应收" : party === "STAFF" ? "双边金额" : "我的实付",
      value: party === "OWNER"
        ? money(terms?.rentalAmount)
        : party === "STAFF"
          ? `买家合计 ${money(staff?.buyerTotal)} · 号主合计 ${money(staff?.ownerTotal)}`
          : money(terms?.paidTotal),
    });
    if (party === "STAFF") rows.push({ label: "平台贡献", value: money(staff?.platformContribution) });
    rows.push({ label: "沟通窗口", value: windowText(info.sendUntil) });
    note = "到账时间以支付渠道为准。";
  } else {
    note = "价格调整内容以订单详情为准，确认前金额不变。";
  }

  const acks = info.openingAcks;
  // The user site needs the party view to open the right order tab; staff always pass a callback.
  const detailHref = party === "STAFF"
    ? `/account?orderId=${encodeURIComponent(info.orderId)}`
    : `/account?view=${party === "OWNER" ? "leased" : "rentals"}&orderId=${encodeURIComponent(info.orderId)}`;
  const lineAmount = (line: OrderTeamTerms["lines"][number]) => party === "STAFF"
    ? `买家 ${money(line.buyerAmount)} · 号主 ${money(line.ownerAmount)}`
    : money(line.amount);

  return <article className="order-card" data-kind={card.kind} data-party={party} data-basis={basis} data-order-id={card.orderId}
    aria-label={`订单阶段卡：${heading.title}`}>
    <header className="order-card-head">
      <span className="order-card-tag">{heading.tag}</span>
      <strong className="order-card-title">{heading.title}</strong>
      <small className="order-card-no">订单 {info.displayNo}</small>
    </header>
    <p className="order-card-account">{info.gameName} · {info.account.title}<small>稳定 ID {info.account.id}</small></p>
    {!readAmounts ? <p className="order-card-verify" role="status">金额依据待核对，最终以订单详情为准。</p> : null}
    <dl className="order-card-rows">{rows.map(row => <div className="order-card-row" key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    {showAcks ? <div className="order-card-acks" aria-label="开租确认状态">
      <span className="order-card-ack" data-state={acks?.renter ? "confirmed" : "pending"} data-self={party === "RENTER" ? "true" : undefined}>买家 {acks?.renter ? "已确认" : "待确认"}</span>
      <span className="order-card-ack" data-state={acks?.owner ? "confirmed" : "pending"} data-self={party === "OWNER" ? "true" : undefined}>号主 {acks?.owner ? "已确认" : "待确认"}</span>
    </div> : null}
    {itemLines.length ? <ul className="order-card-lines" aria-label="物品清单">
      {visibleLines.map(line => <li className="order-card-line" key={line.itemId}>
        <span className="order-card-line-name">{line.name?.trim() || "未命名资源"}</span>
        <span className="order-card-line-qty">× {groupDigits(line.quantity)}</span>
        {readAmounts ? <span className="order-card-line-amount">{lineAmount(line)}</span> : null}
      </li>)}
      {itemLines.length > 3 ? <li><button type="button" className="order-card-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起清单" : `查看完整清单（${itemLines.length} 项）`}</button></li> : null}
    </ul> : null}
    {note ? <p className="order-card-note">{note}</p> : null}
    <div className="order-card-foot">
      {onOpenOrder
        ? <button type="button" className="order-card-action" onClick={onOpenOrder}>查看订单详情</button>
        : <a className="order-card-action" href={detailHref}>查看订单详情</a>}
    </div>
  </article>;
}
