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
  type Figure = { label: string; value: string };
  const figures: Figure[] = [];
  const meta: Figure[] = [];
  let resource: { quantity: string; amount: string | null } | null = null;
  let itemSummary: string | null = null;
  let platform: string | null = null;
  let note: string | null = null;
  let showAcks = false;

  if (card.kind === "ORDER_OPENING") {
    resource = {
      quantity: haffQuantity ? groupDigits(haffQuantity) : "数量待核对",
      amount: readAmounts
        ? party === "STAFF" ? both(haffLine?.buyerAmount, haffLine?.ownerAmount) : money(haffLine?.amount)
        : null,
    };
    itemSummary = itemLines.length
      ? `${itemLines.length} 项${readAmounts ? ` · ${party === "STAFF" ? both(itemBuyerTotal, itemOwnerTotal) : `合计 ${money(itemBuyerTotal)}`}` : ""}`
      : lines.length ? "无额外物品" : "清单待核对";
    if (party === "RENTER") figures.push({ label: "押金", value: money(terms?.depositAmount) }, { label: "实付", value: money(terms?.paidTotal) });
    else if (party === "OWNER") figures.push({ label: "保证金", value: money(terms?.depositAmount) }, { label: "应收", value: money(terms?.rentalAmount) });
    else figures.push({ label: "买家合计", value: money(staff?.buyerTotal) }, { label: "号主合计", value: money(staff?.ownerTotal) });
    if (party === "STAFF") platform = money(staff?.platformContribution);
    showAcks = true;
    note = readAmounts ? "金额按订单冻结价展示，双方确认前不变。" : null;
  } else if (card.kind === "ORDER_ENDING") {
    meta.push({ label: "结束状态", value: endStateText(info.endState) }, { label: "到期时间", value: dueLabel(info.dueAt) });
    if (party === "RENTER") figures.push({ label: "实付", value: money(terms?.paidTotal) }, { label: "押金", value: money(terms?.depositAmount) });
    else if (party === "OWNER") figures.push({ label: "应收", value: money(terms?.rentalAmount) }, { label: "保证金", value: money(terms?.depositAmount) });
    else figures.push({ label: "买家合计", value: money(staff?.buyerTotal) }, { label: "号主合计", value: money(staff?.ownerTotal) });
    if (party === "STAFF") platform = money(staff?.platformContribution);
    note = "应退/应收金额以双方确认的结算单为准。";
  } else if (card.kind === "ORDER_SETTLED") {
    meta.push({ label: "结算状态", value: "已结算" });
    if (party === "RENTER") figures.push({ label: "我的实付", value: money(terms?.paidTotal) });
    else if (party === "OWNER") figures.push({ label: "我的应收", value: money(terms?.rentalAmount) });
    else figures.push({ label: "买家合计", value: money(staff?.buyerTotal) }, { label: "号主合计", value: money(staff?.ownerTotal) });
    if (party === "STAFF") platform = money(staff?.platformContribution);
    meta.push({ label: "沟通窗口", value: windowText(info.sendUntil) });
    note = "到账时间以支付渠道为准。";
  } else {
    note = "价格调整内容以订单详情为准，确认前金额不变。";
  }

  const acks = info.openingAcks;
  const viewerAck = party === "RENTER" ? acks?.renter : party === "OWNER" ? acks?.owner : null;
  const actionLabel = card.kind === "ORDER_OPENING"
    ? party !== "STAFF" && viewerAck === false ? "查看并确认开租" : party === "STAFF" ? "查看本单" : "查看订单详情"
    : card.kind === "ORDER_ENDING" ? party === "STAFF" ? "去处理结束" : "查看并处理" : "查看订单详情";
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
      <div className="order-card-kicker">
        <span className="order-card-tag"><i className="order-card-tone-dot" aria-hidden="true" />{heading.tag}</span>
        <small className="order-card-no">订单 {info.displayNo}</small>
      </div>
      <strong className="order-card-title">{heading.title}</strong>
    </header>
    <p className="order-card-account">{info.gameName} · {info.account.title}<small>稳定 ID {info.account.id}</small></p>
    {!readAmounts ? <p className="order-card-verify" role="status"><i className="order-card-warn-dot" aria-hidden="true" />金额依据待核对，最终以订单详情为准。</p> : null}
    {resource ? <div className="order-card-resource">
      <span className="order-card-resource-label">哈夫币</span>
      <strong className="order-card-resource-value">{resource.quantity}</strong>
      {resource.amount ? <span className="order-card-resource-amount">{resource.amount}</span> : null}
    </div> : null}
    {figures.length ? <dl className="order-card-figures" data-count={figures.length}>{figures.map(figure =>
      <div className="order-card-figure" key={figure.label}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl> : null}
    {platform ? <p className="order-card-platform"><span>平台贡献</span><strong>{platform}</strong></p> : null}
    {meta.length ? <dl className="order-card-meta">{meta.map(item =>
      <div className="order-card-meta-row" key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl> : null}
    {showAcks ? <div className="order-card-acks" aria-label="开租确认状态">
      <span className="order-card-acks-label">开租确认</span>
      <span className="order-card-ack" data-state={acks?.renter ? "confirmed" : "pending"} data-self={party === "RENTER" ? "true" : undefined}><i className="order-card-ack-dot" aria-hidden="true" />买家 {acks?.renter ? "已确认" : "待确认"}</span>
      <span className="order-card-ack" data-state={acks?.owner ? "confirmed" : "pending"} data-self={party === "OWNER" ? "true" : undefined}><i className="order-card-ack-dot" aria-hidden="true" />号主 {acks?.owner ? "已确认" : "待确认"}</span>
    </div> : null}
    {itemSummary ? <div className="order-card-inventory">
      <div className="order-card-inventory-head"><span>物品</span><span>{itemSummary}</span></div>
      {itemLines.length ? <ul className="order-card-lines" aria-label="物品清单">
        {visibleLines.map(line => <li className="order-card-line" key={line.itemId}>
          <span className="order-card-line-name">{line.name?.trim() || "未命名资源"}</span>
          <span className="order-card-line-qty">× {groupDigits(line.quantity)}</span>
          {readAmounts ? <span className="order-card-line-amount">{lineAmount(line)}</span> : null}
        </li>)}
        {itemLines.length > 3 ? <li><button type="button" className="order-card-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起清单" : `查看完整清单（${itemLines.length} 项）`}</button></li> : null}
      </ul> : null}
    </div> : null}
    {note ? <p className="order-card-note">{note}</p> : null}
    <div className="order-card-foot">
      {onOpenOrder
        ? <button type="button" className="order-card-action" onClick={onOpenOrder} title="打开订单详情完成确认与操作">{actionLabel}</button>
        : <a className="order-card-action" href={detailHref} title="打开订单详情完成确认与操作">{actionLabel}</a>}
    </div>
  </article>;
}
