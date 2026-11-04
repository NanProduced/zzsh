import { formatOrderMoney, formatOrderTime } from "./order-client.ts";
import type { Order, OrderImProjection, OrderImStage, OrderLine, OrderParty, PersonalRentalQuote, SettlementOpening, SettlementPosting, SettlementPreview, SettlementVersion } from "./order-client";

export function paymentObservation(payment: { disposition: string } | null): string {
  if (!payment) return "暂未查到付款记录";
  const status = payment.disposition === "APPLIED" ? "已记入订单" : payment.disposition === "REVIEW_REQUIRED" ? "需要人工核对" : "状态待确认";
  return `已有付款记录（${status}）`;
}

export function settlementPreviewProblem(reasons: string[] | undefined): string {
  const labels: Record<string, string> = {
    FULL_PAYOUT_UNKNOWN: "包赔资料暂时无法确认，请联系客服。",
    QUOTE_BASIS_INVALID: "订单计价资料暂时无法确认，请联系客服。",
    OPENING_QUANTITY_MISMATCH: "物资数量与开租记录不一致，请核对后重试。",
    SETTLEMENT_QUANTITY_MISMATCH: "物资数量与开租记录不一致，请核对后重试。",
    EARLY_REASON_REQUIRED: "请填写提前结束原因。",
  };
  return reasons?.length ? [...new Set(reasons.map(reason => labels[reason] ?? "结算方案暂时无法确认，请联系客服。"))].join(" ") : "结算方案暂时无法生成，请稍后重试。";
}

/** The frozen order snapshot's rental mode; older v1 orders carry no mode and stay unlabeled. */
export function orderRentalModeLabel(order: Pick<Order, "quote">): string | null {
  const mode = order.quote?.rentalMode;
  return mode === "ordinary" ? "普通出租" : mode === "custom" ? "自定义出租" : mode === "fast" ? "极速出租" : null;
}

/** Current catalog facts remain useful, but must not look like the frozen order contract. */
export function orderListingSourceLabel(order: Pick<Order, "source" | "listingFacts" | "listingFactsUnknownReason">): string | null {
  if (order.listingFacts?.source === "LEGACY_ACCOUNT_SNAPSHOT") return "当前账号资料（迁入时记录）";
  if (order.source?.origin === "LEGACY") return "历史订单";
  if (order.listingFacts?.source === "ACCOUNT_CURRENT") return "当前账号资料";
  if (order.listingFacts?.source === "ORDER_VERSION") return "下单时账号资料";
  return order.listingFactsUnknownReason ? "账号资料待核实" : null;
}

/** Opening and settlement stages come from the server; absence never becomes a renting label. */
export function orderSettlementStageLabel(order: Pick<Order, "stage">): string | null {
  return order.stage && !["NONE", "UNKNOWN"].includes(order.stage.code) ? order.stage.label : null;
}

/** The six fulfillment steps, in the order the server projects them. */
export const ORDER_FULFILLMENT_STEPS = [
  { key: "PAID", label: "已付款" },
  { key: "TEAM", label: "客服与群" },
  { key: "OPENING", label: "账号与开租" },
  { key: "RENTING", label: "租用中" },
  { key: "ENDING", label: "结束确认" },
  { key: "SETTLED", label: "结算完成" },
] as const;

export type OrderFulfillmentStepState = "done" | "current" | "pending" | "cancelled" | "unknown";

/** WAITING_STAFF and TEAM_PENDING stay in the second step; PENDING_PAYMENT/CANCELLED own no step. */
export function orderFulfillmentStepIndex(stage: OrderImStage | null | undefined): number {
  switch (stage) {
    case "WAITING_STAFF":
    case "TEAM_PENDING": return 1;
    case "OPENING_CONFIRM": return 2;
    case "RENTING": return 3;
    case "ENDING": return 4;
    case "SETTLED": return 5;
    default: return -1;
  }
}

/** A missing projection leaves every step unknown; it never marks progress from the order status. */
export function orderFulfillmentStepStates(stage: OrderImStage | null | undefined): OrderFulfillmentStepState[] {
  if (stage === "CANCELLED") return ORDER_FULFILLMENT_STEPS.map(() => "cancelled");
  const current = orderFulfillmentStepIndex(stage);
  if (current < 0) return ORDER_FULFILLMENT_STEPS.map(() => "unknown");
  return ORDER_FULFILLMENT_STEPS.map((_, index) => {
    if (stage === "SETTLED") return "done";
    return index < current ? "done" : index === current ? "current" : "pending";
  });
}

/** The viewer's own settlement decision refines the ending copy; it never changes the stage itself. */
export type OrderFulfillmentEnding = "PENDING" | "WAITING" | "SERVICE" | "REJECTED" | null;

function fulfillmentWindowText(sendUntil: string | null, canSend: boolean, now: number): string {
  if (!sendUntil) return "仅可查看";
  const until = new Date(sendUntil).getTime();
  if (!Number.isFinite(until)) return "仅可查看";
  if (now >= until) return "已超过 72 小时 · 仅可查看";
  return canSend ? `可沟通至 ${formatOrderTime(sendUntil, { timeZoneName: false })}` : "仅可查看";
}

/**
 * One compact line: current stage plus the next thing that matters. Due and read-only states come
 * only from the server projection; a missing projection stays "阶段待核对".
 */
export function orderFulfillmentSummary(
  projection: OrderImProjection | null | undefined,
  options: { now?: number; ending?: OrderFulfillmentEnding } = {},
): string {
  if (!projection) return "阶段待核对";
  const now = options.now ?? Date.now();
  switch (projection.stage) {
    case "PENDING_PAYMENT": return "待付款";
    case "WAITING_STAFF": return "已付款 · 待客服接入";
    case "TEAM_PENDING": return "已付款 · 订单群准备中";
    case "OPENING_CONFIRM": {
      if (projection.openingState === "NONE") return "账号与开租确认 · 待客服录入开租清单";
      const acks = projection.openingAcks;
      if (!acks) return "账号与开租确认";
      return `账号与开租确认 · 租客${acks.renter ? "已确认" : "待确认"} · 号主${acks.owner ? "已确认" : "待确认"}`;
    }
    case "RENTING": {
      if (!projection.dueAt) return "租用中";
      const due = new Date(projection.dueAt).getTime();
      if (!Number.isFinite(due)) return "租用中";
      const when = formatOrderTime(projection.dueAt, { timeZoneName: false });
      return due < now ? `租用中 · 已到期 ${when}` : `租用中 · 到期 ${when}`;
    }
    case "ENDING":
      if (options.ending === "REJECTED") return "结束确认 · 本版已拒绝，等待重新核对";
      if (options.ending === "PENDING") return "结束确认 · 待你确认";
      if (options.ending === "WAITING") return "结束确认 · 待对方确认";
      if (options.ending === "SERVICE") return "结束确认 · 待客服核实";
      return "结束确认 · 等待确认";
    case "CANCELLED": {
      if (projection.cancelReason === "MANUAL_CLOSE") return `客服手动结束 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
      if (projection.cancelReason !== "PRESTART_TERMINATED") return `已取消 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
      if (projection.refundPending) return "未开租终止 · 退款处理中 · 可沟通";
      return `未开租终止 · 退款已核销 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
    }
    case "SETTLED":
      return `结算完成 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
    default:
      return "阶段待核对";
  }
}

export type OrderListFulfillmentTag = { code: "WAITING_STAFF" | "TEAM_PENDING"; label: string };

/**
 * A list row only knows the fulfillment assignment; the opening/ending stage needs the order IM
 * projection. Show only the early stages the row can prove — a ready group is not a stage and
 * gets no chip. `Order.stage` is a settlement stage and is never reused here.
 */
export function orderListFulfillmentTag(order: Pick<Order, "status" | "readOnly" | "fulfillmentAssignment">): OrderListFulfillmentTag | null {
  if (order.readOnly || order.status !== "PAID") return null;
  const assignment = order.fulfillmentAssignment;
  if (assignment?.state === "WAITING") return { code: "WAITING_STAFF", label: "待客服接入" };
  if (assignment?.state === "ASSIGNED" && assignment.teamReady === false) return { code: "TEAM_PENDING", label: "订单群准备中" };
  return null;
}

/** Renter and owner see their own frozen unit amount, paired with the snapshot's real unit quantity. */
export function orderUnitPriceText(
  amount: { amount?: unknown } | null | undefined,
  unitQuantity: string | null | undefined,
  unit: string | null | undefined,
): string | null {
  if (!amount || typeof amount.amount !== "string" || !/^-?\d+(?:\.\d{1,8})?$/.test(amount.amount)) return null;
  const price = `¥${amount.amount}`;
  const quantity = unitQuantity?.trim();
  return quantity ? `${price} / ${quantityText(unit, quantity)}` : price;
}

/** The fee table total is the resource total, which excludes the tenant deposit. */
export function orderLinesTotalLabel(party: OrderParty): string {
  return party === "owner" ? "号主报价合计" : "资源合计（不含押金）";
}

export function personalMembershipLabel(quote: {
  membershipBenefits?: { schema?: string; effectiveTier?: string } | null;
  customerTier?: string | null;
}): string {
  const b = quote.membershipBenefits;
  if (b?.schema === "membership-benefits-v1" && b.effectiveTier)
    return (
      {
        STANDARD: "普通会员",
        SILVER: "银卡会员",
        GOLD: "金卡会员",
        PLATINUM: "铂金会员",
        DIAMOND: "钻石会员",
        BLACK_GOLD: "黑金会员·终身",
      } as Record<string, string>
    )[b.effectiveTier] ?? "会员权益待核";
  return quote.customerTier ? "既有确认方案" : "会员权益待核";
}
export function personalBenefitSources(quote: {
  membershipBenefits?: { priceSource?: string; depositSource?: string } | null;
}): string | null {
  const b = quote.membershipBenefits;
  if (!b) return null;
  const names = { GROWTH: "成长权益", FRIEND: "挚友礼遇", PRESTIGE: "尊享礼遇" } as Record<string, string>;
  return `价格：${names[b.priceSource ?? ""] ?? "待核"}；押金：${names[b.depositSource ?? ""] ?? "待核"}`;
}

/**
 * Server-observed entry eligibility for the two payment actions. The projection is authoritative when
 * present; the local status facts are only the equivalent fallback, never a wider client-side guess.
 */
export function paymentEntryOpen(order: Order): boolean {
  return order.paymentOpen ?? (order.status === "PENDING_PAYMENT" && !order.expiredAwaitingCancel);
}

const LEGACY_RESOURCE_NAMES: Record<string, string> = {
  df_billable_haff: "哈夫币",
  df_billable_awm_bullet: "AWM子弹",
  df_billable_level6_bullet: "6级子弹",
  df_billable_level6_helmet: "6级头盔",
  df_billable_level6_armor: "6级护甲",
  df_billable_top_insure_card: "顶级保险卡",
  df_billable_barrett_bullet: "巴雷特子弹",
  df_billable_coffee: "咖啡豆",
};

export function orderResourceLines(order: Pick<Order, "orderFacts">) {
  return (order.orderFacts?.resources ?? []).flatMap((resource) => {
    const name = LEGACY_RESOURCE_NAMES[resource.code];
    if (!name) return [];
    const unit = resource.unit === "DAY" ? " 天" : "";
    return [{ ...resource, name, value: `${resource.quantity}${unit}` }];
  });
}

/** A natural order summary from frozen order facts; no current account title or legacy alias is consulted. */
export function orderResourceSummary(order: Pick<Order, "orderFacts">, limit = 3): string | null {
  const labels = orderResourceLines(order).filter(resource => !/^0+(?:\.0+)?$/.test(resource.quantity)).map(resource => `${resource.name} ${resource.value}`);
  if (!labels.length) return null;
  const visible = labels.slice(0, Math.max(1, limit));
  return [...visible, ...(labels.length > visible.length ? [`+${labels.length - visible.length}项`] : [])].join(" · ");
}

/** A frozen order has no user-authored title; its identity is rebuilt from server facts. */
function haffTitleFromBase(raw: string | null | undefined): string | null {
  const valueText = raw?.trim();
  if (!valueText || !/^\d+$/.test(valueText)) return null;
  const value = BigInt(valueText);
  if (value === 0n) return null;
  if (value < 1_000_000n) return `${groupedInteger(valueText)} 哈夫币`;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} M 哈夫币`;
}

function orderFactsTitle(order: Pick<Order, "listingFacts">): string | null {
  const facts = order.listingFacts;
  if (!facts) return null;
  const haff = facts.resourceLines.find((line) => line.unit === "HAFF_BASE");
  const parts = [
    haffTitleFromBase(haff?.quantity),
    facts.attributeDisplay.safeBox,
    facts.attributeDisplay.grading,
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length ? parts.join(" · ") : null;
}

function orderHaffTitle(order: Pick<Order, "quote">): string | null {
  const line = order.quote?.lines?.find((candidate) => candidate.unit === "HAFF_BASE");
  return haffTitleFromBase(line?.quantity);
}

export function orderUsesResourceSummary(order: Pick<Order, "source" | "orderFacts">): boolean {
  return order.source?.origin === "LEGACY" && orderResourceSummary(order) !== null;
}

/** Historical participation is not permission to view the account's current private facts. */
export function orderAccountTitle(order: Pick<Order, "source" | "orderFacts" | "quote" | "listingFacts">): string {
  const facts = orderFactsTitle(order);
  if (facts) return facts;
  if (order.source?.origin === "LEGACY") return orderResourceSummary(order) ?? "租赁账号";
  const haff = orderHaffTitle(order);
  if (haff) return haff;
  const named = (order.quote?.lines ?? []).find((line) => line.name?.trim() && line.quantity && !/^0+(?:\.0+)?$/.test(line.quantity));
  return named?.name?.trim() || "租赁账号";
}

export type OrderAmountFacts = { main: string; caption: string; secondary: string[] };

/** The main amount is the renter's actual order record; an owner view never relabels it as owner income. */
export function orderAmountFacts(order: Order, party: OrderParty): OrderAmountFacts {
  if (order.readOnly && order.source?.origin === "LEGACY") {
    if (party === "owner") return order.ownerIncomeSource?.source === "LEGACY_ORDER_SNAPSHOT" && order.amounts?.ownerRecordedIncome
      ? { main: formatOrderMoney(order.amounts.ownerRecordedIncome), caption: "已结算", secondary: [] }
      : { main: "未记录", caption: "待结算", secondary: [] };
    const paid = order.payment?.state === "RECORDED_PAID";
    return {
      main: formatOrderMoney(paid ? order.legacyAmounts?.paid : order.legacyAmounts?.required),
      caption: paid ? "已付金额记录" : "订单应付",
      secondary: [
        ...(order.legacyAmounts?.deposit ? [`押金 ${formatOrderMoney(order.legacyAmounts.deposit)}`] : []),
        ...(order.legacyAmounts?.refund ? [`原退款金额记录 ${formatOrderMoney(order.legacyAmounts.refund)}`] : []),
      ],
    };
  }
  const amounts = order.amounts;
  const settled = order.status === "COMPLETED";
  if (party === "owner") {
    const quote = order.amounts?.ownerExpectedIncome ?? order.quote?.ownerTotal;
    return quote
      ? { main: formatOrderMoney(quote), caption: "下单时号主报价", secondary: [] }
      : { main: "未记录", caption: "号主报价", secondary: [] };
  }
  const caption = order.status === "PENDING_PAYMENT" ? "待支付"
    : order.status === "PAID" ? "已支付"
    : settled ? "实付 · 下单快照"
    : "下单金额";
  return {
    main: formatOrderMoney(amounts?.totalDue),
    caption,
    secondary: [`租赁 ${formatOrderMoney(amounts?.rental)}`, `押金 ${formatOrderMoney(amounts?.deposit)}`],
  };
}

export function cancelEntryOpen(order: Order): boolean {
  return order.cancelOpen ?? order.status === "PENDING_PAYMENT";
}

const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", PIECE: "件", ROUND: "发", DAY: "天" };

export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return UNIT_LABELS[unit] ?? unit;
}

/** Unit hint for a table cell; omitted when the resource name already carries it. */
export function unitHint(name: string, unit: string | null | undefined): string {
  const label = unitLabel(unit);
  return label && !name.includes(label) ? label : "";
}

export function groupedInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** HAFF quantities are base units; show the exact integer plus the exact M helper. */
export function quantityText(unit: string | null | undefined, quantity: string): string {
  const label = unitLabel(unit);
  if (!/^\d+$/.test(quantity)) return quantity;
  if (unit === "HAFF_BASE") {
    const value = BigInt(quantity);
    const whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    const millions = fraction ? `${whole}.${fraction}` : whole.toString();
    return `${groupedInteger(quantity)} 哈夫币（${millions} M）`;
  }
  return `${groupedInteger(quantity)}${label ? ` ${label}` : ""}`;
}

/** The original bill uses the exact M quantity; full base units remain in settlement records. */
export function orderLineQuantityText(line: OrderLine): string {
  const quantity = line.quantity ?? line.unitQuantity;
  if (quantity === null || quantity === undefined || quantity === "") return "数量待确认";
  if (line.unit === "HAFF_BASE" && /^\d+$/.test(quantity)) {
    const value = BigInt(quantity);
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${groupedInteger((value / 1_000_000n).toString())}${fraction ? `.${fraction}` : ""} M`;
  }
  return quantityText(unitHint(line.name ?? "", line.unit) ? line.unit : undefined, quantity);
}

export function resourceName(order: Order, itemId: string): string {
  const line = order.quote?.lines?.find((candidate) => candidate.itemId === itemId);
  return line?.name && line.name.trim() ? line.name : itemId;
}

/** Settlement projections may deliver exact yuan strings or {currency,amount} objects. */
export function moneyText(value: unknown): string {
  if (typeof value === "string") return /^\d+\.\d{2}$/.test(value) ? `¥${value}` : "—";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  const amount = value as { currency?: unknown; amount?: unknown };
  if (amount.currency !== "CNY" || typeof amount.amount !== "string" || !/^\d+\.\d{2}$/.test(amount.amount)) return "—";
  return `¥${amount.amount}`;
}

/**
 * Cents-suffixed posting fields are exact integer strings. A missing value stays unknown ("—"):
 * it is never widened to zero, and the sign is kept because a negative net is a real server fact.
 */
export function moneyCents(value: string | null | undefined): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return "—";
  const cents = BigInt(value);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}¥${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")} 元`;
}

function amountAt(amounts: Record<string, unknown>, key: string): string {
  return moneyText(amounts[key]);
}

export type SettlementAmountRow = { label: string; value: string; note?: string };

/**
 * Party-facing breakdown of the frozen settlement amounts; internal profit fields are not included.
 *
 * `mode` only renames what the same server numbers mean: a preview is still an estimate, while a
 * posting is the effective result. It never recalculates money in the browser.
 */
export function settlementAmountRows(
  party: OrderParty,
  amounts: Record<string, unknown> | null | undefined,
  mode: "estimate" | "effective" = "estimate",
): SettlementAmountRow[] {
  if (!amounts) return [];
  const effective = mode === "effective";
  const rows: SettlementAmountRow[] = [];
  const feePayer = typeof amounts.feePayer === "string" ? amounts.feePayer : "NONE";
  const rate = typeof amounts.feeRate === "string" ? amounts.feeRate : null;
  if (party === "renter") {
    rows.push({ label: "哈夫币消耗（租客侧）", value: amountAt(amounts, "haffConsumedBuyer") });
    rows.push({ label: "物品消耗（租客侧）", value: amountAt(amounts, "itemConsumedBuyer") });
    rows.push({ label: "未耗物品退回", value: amountAt(amounts, "unusedItemRefund") });
    rows.push({ label: "未耗哈夫退回", value: amountAt(amounts, "unusedHaffRefund") });
    rows.push({ label: effective ? "本次结算扣费" : "本次消耗合计", value: amountAt(amounts, "renterCharge") });
    const makeup = amountAt(amounts, "earlyMakeup");
    if (makeup !== "—" && makeup !== "¥0.00") rows.push({ label: "提前结束补足", value: makeup });
    if (feePayer === "RENTER") rows.push({ label: `包赔费用（租客承担${rate ? ` · 费率 ${rate}` : ""}）`, value: amountAt(amounts, "feeAmount") });
    rows.push({ label: effective ? "最终应退" : "预计应退", value: amountAt(amounts, "renterRefund"), note: effective ? "已生效金额；不等于渠道退款到账" : "含押金应退，不等于渠道到账" });
    rows.push({ label: "其中押金应退", value: amountAt(amounts, "depositRefund") });
  } else {
    rows.push({ label: "哈夫币消耗（号主侧）", value: amountAt(amounts, "haffConsumedOwner") });
    rows.push({ label: "物品消耗（号主侧）", value: amountAt(amounts, "itemConsumedOwner") });
    rows.push({ label: "号主毛收入", value: amountAt(amounts, "ownerGross") });
    if (feePayer === "OWNER") rows.push({ label: `包赔费用（号主承担${rate ? ` · 费率 ${rate}` : ""}）`, value: amountAt(amounts, "feeAmount") });
    else if (feePayer === "RENTER") rows.push({ label: "包赔费用", value: "由租客承担", note: "不在号主净额中扣除" });
    rows.push({ label: effective ? "本单净入账" : "号主净入账", value: amountAt(amounts, "ownerNet"), note: effective ? "本单净入账，不是钱包全部余额或提现结果" : "结算生效后进入可用余额" });
  }
  return rows;
}

export function previewAmounts(preview: SettlementPreview | null): Record<string, unknown> | null {
  return preview?.amounts ?? null;
}

export function versionAmounts(version: SettlementVersion | null | undefined): Record<string, unknown> | null {
  return version?.computation?.amounts ?? null;
}

/** Whether this version is a human adjustment, i.e. its net/refund are not the system computation. */
export function isAdjustedVersion(version: SettlementVersion | null | undefined): boolean {
  if (!version) return false;
  return version.kind === "MANUAL_ADJUSTMENT" || version.proposedOwnerNet != null || version.proposedRenterRefund != null;
}

function netLabel(party: OrderParty, mode: "estimate" | "effective"): string {
  if (party === "owner") return mode === "effective" ? "本单净入账" : "号主净入账";
  return mode === "effective" ? "最终应退" : "预计应退";
}

/** The charge row is the system computation, and says so once an adjustment moved the final figures. */
export function chargeRowLabel(adjusted: boolean): string {
  return adjusted ? "系统计算扣费（调整前）" : "本次结算扣费";
}

/**
 * The cents value this party would settle by confirming now. A missing or malformed value is not
 * readable evidence, so it stays null instead of falling back to the system computation.
 */
export function proposedConfirmationCents(party: OrderParty, version: SettlementVersion | null | undefined): string | null {
  if (!version) return null;
  const raw = party === "owner" ? version.proposedOwnerNet : version.proposedRenterRefund;
  return typeof raw === "string" && /^\d+$/.test(raw) ? raw : null;
}

/**
 * Rows for the version the user is about to decide on. A manual version must disclose the amount that
 * confirmation would actually settle: the system computation and the proposed adjustment are two
 * different figures, and a missing proposed value stays unknown instead of falling back to the system one.
 */
export function decisionAmountRows(party: OrderParty, version: SettlementVersion | null | undefined): SettlementAmountRow[] {
  const rows = settlementAmountRows(party, versionAmounts(version));
  if (!isAdjustedVersion(version)) return rows;
  const target = netLabel(party, "estimate");
  const system = party === "owner" ? version?.systemOwnerNet : version?.systemRenterRefund;
  const proposed = proposedConfirmationCents(party, version);
  const subject = party === "owner" ? "净额" : "应退";
  return rows
    .filter((row) => row.label !== target)
    .concat([
      { label: `系统计算${subject}`, value: moneyCents(system), note: "按已确认期初与本次期末计算的系统值" },
      { label: `本次将确认的${subject}`, value: moneyCents(proposed), note: proposed === null ? "没有可读的拟调整金额，不能按系统值确认，也暂不能确认这一版" : "确认后按此金额生效" },
    ]);
}

/**
 * The effective breakdown of one posting. The final net/refund are the posting's own columns; the
 * snapshot rows keep their system values and say so, because a manual adjustment only moves the
 * net and the payable refund.
 */
export function postingAmountRows(party: OrderParty, posting: SettlementPosting): SettlementAmountRow[] {
  const rows = settlementAmountRows(party, posting.amounts ?? null, "effective");
  const adjusted = Boolean(posting.manualAdjustment);
  const target = netLabel(party, "effective");
  const chargeLabel = chargeRowLabel(adjusted);
  const finalValue = party === "owner" ? moneyCents(posting.owner?.availableCents) : moneyCents(posting.refund?.payableCents);
  return rows.map((row) => {
    if (row.label === target) return { ...row, value: finalValue };
    if (adjusted && row.label === "本次结算扣费") return { ...row, label: chargeLabel, note: "按系统计算；人工调整只改变最终净额与应退" };
    return adjusted ? { ...row, note: row.note ?? "系统计算快照" } : row;
  });
}

export type ConsumptionRow = {
  itemId: string;
  name: string;
  unit: string | null | undefined;
  /** Opening quantity of the version this settlement was computed against. */
  opening: string | null;
  /** Remaining quantity the initiator submitted; null when this version carries no such line. */
  remaining: string | null;
  /** Server consumption when the projection carries it; otherwise the exact difference. */
  consumed: string | null;
};

/**
 * Opening/remaining/consumed per resource for one settlement version. Everything is taken from the
 * server projection (opening lines, the version's input snapshot, the computed consumption); the
 * difference is only a display fallback for a line the server did not compute.
 */
export function consumptionRows(order: Order, opening: SettlementOpening | null, version: SettlementVersion | null | undefined): ConsumptionRow[] {
  const openingLines = opening?.lines ?? [];
  if (openingLines.length === 0) return [];
  const submitted = new Map((version?.inputSnapshot?.lines ?? []).map((line) => [line.itemId, line.remainingQuantity]));
  const consumed = version?.computation?.consumed;
  return openingLines.map((line) => {
    const open = line.quantity ?? null;
    const rest = submitted.get(line.itemId) ?? null;
    const serverLine = consumed?.items?.find((item) => item.itemId === line.itemId);
    const derived = open !== null && rest !== null && /^\d+$/.test(open) && /^\d+$/.test(rest) && BigInt(rest) <= BigInt(open)
      ? (BigInt(open) - BigInt(rest)).toString()
      : null;
    const used = line.pricingKind === "HAFF_RATIO" && consumed?.haff !== undefined && consumed.haff !== null
      ? String(consumed.haff)
      : serverLine?.consumed ?? derived;
    return { itemId: line.itemId, name: resourceName(order, line.itemId), unit: line.unit, opening: open, remaining: rest, consumed: used ?? null };
  });
}
