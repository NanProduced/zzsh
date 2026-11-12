import { formatOrderMoney, formatOrderTime } from "./order-client.ts";
import { formatReferenceYuan } from "@zzsh/ui/display-money";
export { formatReferenceYuan } from "@zzsh/ui/display-money";
import type { Order, OrderImProjection, OrderImStage, OrderLine, OrderParty, PersonalRentalQuote, SettlementLine, SettlementOpening, SettlementPosting, SettlementPreview, SettlementVersion } from "./order-client";

export function paymentObservation(payment: { disposition: string } | null): string {
  if (!payment) return "暂未查到付款记录";
  const status = payment.disposition === "APPLIED" ? "已记入订单" : payment.disposition === "REVIEW_REQUIRED" ? "需要人工核对" : "状态未记录";
  return `已有付款记录（${status}）`;
}

export function settlementPreviewProblem(reasons: string[] | undefined): string {
  const labels: Record<string, string> = {
    FULL_PAYOUT_UNKNOWN: "包赔资料暂时无法确认，请联系客服。",
    QUOTE_BASIS_INVALID: "订单计价资料暂时无法确认，请联系客服。",
    OPENING_QUANTITY_MISMATCH: "物资数量与开租记录不一致，请核对后重试。",
    SETTLEMENT_QUANTITY_MISMATCH: "物资数量与开租记录不一致，请核对后重试。",
    INSUFFICIENT_PREPAYMENT: "本单已付金额不足以覆盖实际费用，请联系客服处理。",
    SETTLEMENT_PRICING_INVALID: "本单结算价格资料暂不可用，请联系客服核实。",
    DISCOUNT_OWNER_FUNDING_INSUFFICIENT: "本次结算金额需要客服核实，请联系客服处理。",
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
  return order.listingFactsUnknownReason ? "账号资料未确认" : null;
}

/** Opening and settlement stages come from the server; absence never becomes a renting label. */
export function orderSettlementStageLabel(order: Pick<Order, "stage">): string | null {
  return order.stage && !["NONE", "UNKNOWN"].includes(order.stage.code) ? order.stage.label : null;
}

/** The normal fulfillment path. A cancelled order renders only the steps it actually reached. */
export const ORDER_FULFILLMENT_STEPS = [
  { key: "PAID", label: "已付款" },
  { key: "OPENING", label: "开租确认" },
  { key: "RENTING", label: "租用中" },
  { key: "ENDING", label: "结束确认" },
  { key: "SETTLED", label: "结算完成" },
] as const;

export const ORDER_CANCELLED_PRESTART_STEPS = [
  { key: "PAID", label: "已付款" },
  { key: "OPENING", label: "开租确认" },
  { key: "CANCELLED", label: "已取消" },
] as const;

export const ORDER_CANCELLED_STARTED_STEPS = [
  { key: "PAID", label: "已付款" },
  { key: "OPENING", label: "开租确认" },
  { key: "RENTING", label: "租用中" },
  { key: "CANCELLED", label: "已取消" },
] as const;

export type OrderFulfillmentStepState = "done" | "current" | "pending" | "cancelled" | "skipped" | "unknown";

/** WAITING_STAFF and TEAM_PENDING are both inside the paid step. */
export function orderFulfillmentStepIndex(stage: OrderImStage | null | undefined): number {
  switch (stage) {
    case "WAITING_STAFF":
    case "TEAM_PENDING": return 0;
    case "OPENING_CONFIRM": return 1;
    case "RENTING": return 2;
    case "ENDING": return 3;
    case "SETTLED": return 4;
    default: return -1;
  }
}

/** Cancelled orders keep the path they reached, then end on a red terminal step. */
export function orderFulfillmentSteps(stage: OrderImStage | null | undefined, cancelledAfterOpening = false) {
  if (stage !== "CANCELLED") return ORDER_FULFILLMENT_STEPS;
  return cancelledAfterOpening ? ORDER_CANCELLED_STARTED_STEPS : ORDER_CANCELLED_PRESTART_STEPS;
}

/** A missing projection leaves every step unknown; it never marks progress from the order status. */
export function orderFulfillmentStepStates(stage: OrderImStage | null | undefined, cancelledAfterOpening = false): OrderFulfillmentStepState[] {
  const steps = orderFulfillmentSteps(stage, cancelledAfterOpening);
  if (stage === "CANCELLED") {
    return steps.map((step) => step.key === "CANCELLED" ? "cancelled" : step.key === "OPENING" && !cancelledAfterOpening ? "skipped" : "done");
  }
  const current = orderFulfillmentStepIndex(stage);
  if (current < 0) return steps.map(() => "unknown");
  return steps.map((_, index) => {
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
 * only from the server projection; a missing projection stays "阶段未确认".
 */
export function orderFulfillmentSummary(
  projection: OrderImProjection | null | undefined,
  options: { now?: number; ending?: OrderFulfillmentEnding; showRefund?: boolean } = {},
): string {
  if (!projection) return "阶段未确认";
  const now = options.now ?? Date.now();
  switch (projection.stage) {
    case "PENDING_PAYMENT": return "待付款";
    case "WAITING_STAFF": return "已付款 · 待客服接入";
    case "TEAM_PENDING": return "已付款 · 订单群准备中";
    case "OPENING_CONFIRM": {
      if (projection.openingState === "NONE") return "开租确认 · 待生成或核对开租清单";
      const acks = projection.openingAcks;
      if (!acks) return "开租确认";
      return `开租确认 · 租客${acks.renter ? "确认已记录" : "未记录"} · 号主${acks.owner ? "确认已记录" : "未记录"}`;
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
      return "结束确认 · 等双方确认";
    case "CANCELLED": {
      if (projection.cancelReason === "MANUAL_CLOSE") return `客服手动结束 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
      if (projection.cancelReason !== "PRESTART_TERMINATED") return `已取消 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
      if (options.showRefund === false) return `未开租终止 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
      if (projection.refundPending) return "未开租终止 · 退款处理中 · 可沟通";
      if (projection.refundCompletedAt) return `未开租终止 · 退款已完成 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
      return `未开租终止 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
    }
    case "SETTLED":
      return `结算完成 · ${fulfillmentWindowText(projection.sendUntil, projection.canSend, now)}`;
    default:
      return "阶段未确认";
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
  const price = formatReferenceYuan(amount?.amount);
  if (!price) return null;
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
    )[b.effectiveTier] ?? "会员权益未记录";
  return quote.customerTier ? "既有确认方案" : "会员权益未记录";
}
export function personalBenefitSources(quote: {
  membershipBenefits?: { priceSource?: string; depositSource?: string } | null;
}): string | null {
  const b = quote.membershipBenefits;
  if (!b) return null;
  const names = { GROWTH: "成长权益", FRIEND: "挚友礼遇", PRESTIGE: "尊享礼遇" } as Record<string, string>;
  return `价格：${names[b.priceSource ?? ""] ?? "未记录"}；押金：${names[b.depositSource ?? ""] ?? "未记录"}`;
}

const BENEFIT_SOURCE_NAMES: Record<string, string> = {
  GROWTH: "成长权益",
  FRIEND: "挚友礼遇",
  PRESTIGE: "尊享礼遇",
};

/** Mapped membership source name used next to a proven monetary benefit. */
export function personalBenefitSourceLabel(source?: string | null): string | null {
  return source ? (BENEFIT_SOURCE_NAMES[source] ?? null) : null;
}

/** Exact yuan cents from a server money object; unknown or non-CNY values stay null. */
export function yuanCentsFromMoney(value: unknown): bigint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const money = value as { unit?: unknown; scale?: unknown; amount?: unknown };
  if (money.unit !== "yuan" || money.scale !== 2 || typeof money.amount !== "string" || moneyText(value) === "—") {
    return null;
  }
  return BigInt(money.amount.replace(".", ""));
}

export function formatYuanFromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}¥${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

/** Positive difference between the recorded base tenant deposit and the payable deposit. */
export function depositReductionCents(base: unknown, actual: unknown): bigint | null {
  const baseCents = yuanCentsFromMoney(base);
  const actualCents = yuanCentsFromMoney(actual);
  if (baseCents === null || actualCents === null || baseCents <= actualCents) return null;
  return baseCents - actualCents;
}

const PLACEHOLDER_MEMBERSHIP_LABELS = new Set(["会员权益未记录", "既有确认方案", "普通会员"]);

/** Visible actor for a reduction chain: tier and/or mapped 礼遇, omitting placeholder labels. */
export function personalBenefitActorLabel(
  quote: {
    membershipBenefits?: { schema?: string; effectiveTier?: string; priceSource?: string; depositSource?: string } | null;
    customerTier?: string | null;
  },
  kind: "price" | "deposit",
): string | null {
  const tier = personalMembershipLabel(quote);
  const source = personalBenefitSourceLabel(
    kind === "price" ? quote.membershipBenefits?.priceSource : quote.membershipBenefits?.depositSource,
  );
  const parts = [tier && !PLACEHOLDER_MEMBERSHIP_LABELS.has(tier) ? tier : null, source].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length ? parts.join(" · ") : null;
}

export function yuanCentsFromLabel(value: string | null | undefined): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^¥(\d+)\.(\d{2})$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

function referenceLineCents(line: { costLabel?: string | null; costAmount?: string | null }): bigint | null {
  const fromLabel = yuanCentsFromLabel(line.costLabel ?? null);
  if (fromLabel !== null) return fromLabel;
  if (typeof line.costAmount === "string" && /^\d+\.\d{2}$/.test(line.costAmount)) {
    return yuanCentsFromLabel(`¥${line.costAmount}`);
  }
  return null;
}

/**
 * Rent/resource savings only when every personal line has a same-quantity public counterpart.
 * Divergent bills are not treated as a membership discount.
 */
export function matchingResourceDiscount(
  personalLines: readonly { itemId?: string | null; quantity?: unknown; buyerAmount?: unknown }[] | null | undefined,
  personalResourceTotal: unknown,
  referenceLines: readonly { itemId?: string | null; quantity?: unknown; costLabel?: string | null; costAmount?: string | null }[] | null | undefined,
): { reduction: bigint; original: string; final: string } | null {
  if (!personalLines?.length || !referenceLines?.length) return null;
  const refById = new Map<string, { itemId?: string | null; quantity?: unknown; costLabel?: string | null; costAmount?: string | null }>();
  for (const line of referenceLines) {
    if (!line.itemId || refById.has(line.itemId)) return null;
    refById.set(line.itemId, line);
  }
  const matched = new Set<string>();
  let referenceCents = 0n;
  let personalCents = 0n;
  for (const line of personalLines) {
    if (!line.itemId || matched.has(line.itemId)) return null;
    matched.add(line.itemId);
    const referenceLine = refById.get(line.itemId);
    if (!referenceLine || String(referenceLine.quantity ?? "") !== String(line.quantity ?? "")) return null;
    const lineReferenceCents = referenceLineCents(referenceLine);
    const linePersonalCents = yuanCentsFromMoney(line.buyerAmount);
    if (lineReferenceCents === null || linePersonalCents === null) return null;
    referenceCents += lineReferenceCents;
    personalCents += linePersonalCents;
  }
  for (const [itemId, line] of refById) {
    if (!matched.has(itemId) && referenceLineCents(line) !== 0n) return null;
  }
  const totalCents = yuanCentsFromMoney(personalResourceTotal);
  if (totalCents === null || totalCents !== personalCents) return null;
  if (referenceCents <= personalCents) return null;
  return {
    reduction: referenceCents - personalCents,
    original: formatYuanFromCents(referenceCents),
    final: formatYuanFromCents(personalCents),
  };
}

/** Whole-order payable ratio as a compact 折 label when the cents map cleanly, else null. */
export function formatNiceZhe(originalCents: bigint, finalCents: bigint): string | null {
  if (originalCents <= 0n || finalCents < 0n || finalCents >= originalCents) return null;
  let best: { zhe: number; error: bigint } | null = null;
  for (let zhe = 1; zhe <= 99; zhe += 1) {
    if ((originalCents * BigInt(zhe) + 50n) / 100n !== finalCents) continue;
    const produced = originalCents * BigInt(zhe);
    const target = finalCents * 100n;
    const error = produced >= target ? produced - target : target - produced;
    if (!best || error < best.error) best = { zhe, error };
  }
  if (!best) return null;
  return `${best.zhe / 10}折`;
}

export function rentBenefitChip(originalCents: bigint, finalCents: bigint): string | null {
  if (originalCents <= 0n || finalCents >= originalCents) return null;
  return formatNiceZhe(originalCents, finalCents) ?? `已减 ${formatYuanFromCents(originalCents - finalCents)}`;
}

export function depositBenefitChip(reductionCents: bigint, fullyWaived = false): string {
  if (fullyWaived) return "免押";
  return `减免押金 ${formatYuanFromCents(reductionCents)}`;
}

function courtesySourceLabel(source?: string | null): string | null {
  const label = personalBenefitSourceLabel(source);
  return label && label !== "成长权益" ? label : null;
}

/** Card heading: visible tier once, plus 挚友/尊享 courtesy names when those sources actually apply. */
export function membershipBenefitTitle(
  quote: {
    membershipBenefits?: { schema?: string; effectiveTier?: string; priceSource?: string; depositSource?: string } | null;
    customerTier?: string | null;
  },
  applied: { rent?: boolean; deposit?: boolean },
): string | null {
  const tier = personalMembershipLabel(quote);
  const visibleTier = tier && !PLACEHOLDER_MEMBERSHIP_LABELS.has(tier) ? tier : null;
  const courtesies: string[] = [];
  const push = (source?: string | null) => {
    const label = courtesySourceLabel(source);
    if (label && !courtesies.includes(label)) courtesies.push(label);
  };
  if (applied.rent) push(quote.membershipBenefits?.priceSource);
  if (applied.deposit) push(quote.membershipBenefits?.depositSource);
  const parts = [visibleTier, ...courtesies].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

export function membershipBenefitPresentation(
  quote: {
    membershipBenefits?: { schema?: string; effectiveTier?: string; priceSource?: string; depositSource?: string } | null;
    customerTier?: string | null;
  },
  resourceDiscount: { original: string; final: string; reduction: bigint } | null,
  depositReduction: bigint | null,
  depositFullyWaived = false,
): { title: string | null; chips: string[] } | null {
  const chips: string[] = [];
  if (resourceDiscount) {
    const originalCents = yuanCentsFromLabel(resourceDiscount.original);
    const finalCents = yuanCentsFromLabel(resourceDiscount.final);
    const chip =
      originalCents !== null && finalCents !== null
        ? rentBenefitChip(originalCents, finalCents)
        : `已减 ${formatYuanFromCents(resourceDiscount.reduction)}`;
    if (chip) chips.push(chip);
  }
  if (depositReduction !== null) {
    chips.push(depositBenefitChip(depositReduction, depositFullyWaived));
  }
  if (!chips.length) return null;
  return {
    title: membershipBenefitTitle(quote, { rent: Boolean(resourceDiscount), deposit: depositReduction !== null }),
    chips,
  };
}

/**
 * Server-observed entry eligibility for the two payment actions. The projection is authoritative when
 * present; the local status facts are only the equivalent fallback, never a wider client-side guess.
 */
export function paymentEntryOpen(order: Order): boolean {
  return order.paymentOpen ?? (order.status === "PENDING_PAYMENT" && !order.expiredAwaitingCancel);
}

const LEGACY_RESOURCE_NAMES: Record<string, string> = {
  df_billable_haff: "哈夫币消耗",
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
    if (party === "owner") {
      if (order.ownerIncomeSource?.source === "LEGACY_ORDER_SNAPSHOT" && order.amounts?.ownerRecordedIncome) {
        return { main: formatOrderMoney(order.amounts.ownerRecordedIncome), caption: "已结算", secondary: [] };
      }
      const paid = order.payment?.state === "RECORDED_PAID";
      const unpaid = order.payment?.state === "RECORDED_UNPAID";
      // Cancelled / unpaid rows have no owner settlement duty — never label them 待结算.
      if (order.status === "CANCELLED" && unpaid) return { main: "未记录", caption: "已取消 · 未付款", secondary: [] };
      if (order.status === "CANCELLED") return { main: "未记录", caption: paid ? "收益未记录" : "无号主收益记录", secondary: [] };
      if (order.status === "COMPLETED") return { main: "未记录", caption: "收益未记录", secondary: [] };
      if (order.status === "PENDING_PAYMENT" || unpaid || !paid) return { main: "未记录", caption: "无号主收益记录", secondary: [] };
      return { main: "未记录", caption: "结算未入账", secondary: [] };
    }
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

/**
 * One decision per order state, derived only from server-owned facts. The primary action always
 * points at a capability the page already owns (or at the support host); it never submits a write
 * itself, so no second idempotency path is created. A failed or in-flight read only states facts
 * that were actually read and never infers success, delivery, settling or bank arrival.
 */
export type OrderProgressOwner = "你" | "对方" | "客服" | "系统" | "平台" | "暂无";
export type OrderProgressTarget = "trade" | "legacy" | "refund" | "support" | "groups" | "refresh" | "browse" | "manage" | "list";
export type OrderProgressAction = { label: string; target: OrderProgressTarget; href?: string };
export type OrderProgressView = {
  tone: "active" | "waiting" | "warning" | "done" | "unknown";
  title: string;
  owner: OrderProgressOwner;
  note: string;
  primary: OrderProgressAction | null;
  secondary: OrderProgressAction[];
  known: string[];
  terminal: boolean;
  noNewTransaction: boolean;
  pendingRead: boolean;
};

/** Structural subset of the settlement read's stage facts; no component import, no client pricing. */
export type OrderProgressFacts = {
  rentalStarted: boolean;
  phase: "RENTING" | "INTAKE_PENDING" | "DECISION_PENDING" | "DECISION_REJECTED" | "DECISION_WAITING" | "POSTED";
  openingVersionNo: string | null;
  openingConfirmedAt: string | null;
  myAck: boolean;
  otherAck: boolean;
  /** Additive server stage / frozen opening deadline; absent on older projections and fixtures. */
  stageCode?: string | null;
  viewerActionRequired?: boolean;
  autoConfirmDueAt?: string | null;
  openingGenerationState?: "CREATED" | "REVIEW_REQUIRED" | null;
  openingGenerationRecoveryRequired?: boolean;
  feeReconfirmationRequired?: boolean;
};

/** Only the facts the channel payment read returned. `readFailed` means no conclusion is available. */
export type OrderPaymentFacts = {
  state: string | null;
  displayState: string | null;
  blockedReason: string | null;
  readFailed: boolean;
  /** An original local request is still awaiting recovery; this does not establish a channel result. */
  originalRequestPending?: boolean;
};

type ProgressOrder = Pick<Order,
  "status" | "readOnly" | "source" | "paymentOpen" | "expiredAwaitingCancel" | "cancelReason" | "fundsResolution" | "viewerParty">;

/** A support consultation, not the order-group panel: the two are different capabilities. */
const progressSupport: OrderProgressAction = { label: "联系客服", target: "support" };
const progressOrderGroups: OrderProgressAction = { label: "打开订单群", target: "groups" };
const progressRefresh: OrderProgressAction = { label: "刷新进度", target: "refresh" };
const progressRefund: OrderProgressAction = { label: "查看退款进度", target: "refund" };
const progressBrowse: OrderProgressAction = { label: "浏览可租账号", target: "browse", href: "/accounts" };
const progressManage: OrderProgressAction = { label: "管理上架账号", target: "manage", href: "/account?view=accounts" };
const progressRetry: OrderProgressAction = { label: "重试读取", target: "refresh" };

function orderStatusFact(status: string): string {
  if (status === "PENDING_PAYMENT") return "订单主状态：待支付";
  if (status === "PAID") return "订单主状态：已付款";
  if (status === "COMPLETED") return "订单主状态：已完成";
  if (status === "CANCELLED") return "订单主状态：已取消";
  return "订单主状态：未记录";
}

export function orderProgressView({ order, party, facts, readFailed, payment = null }: {
  order: ProgressOrder;
  party: OrderParty;
  facts: OrderProgressFacts | null;
  readFailed: boolean;
  payment?: OrderPaymentFacts | null;
}): OrderProgressView {
  const status = order.status;
  const legacy = order.readOnly === true || order.source?.origin === "LEGACY";
  const terminal = status === "COMPLETED" || status === "CANCELLED";
  const known = [
    orderStatusFact(status),
    "订单号、下单时间与金额以页面上方已读到的记录为准",
    "消耗、费用与退款以服务端结算和退款读取为准，页面不自行计算或补零",
  ];
  // readSettlement() supplies the authoritative stage. Expose it as a known fact instead of
  // rebuilding a second, possibly different, stage story in the browser.
  if (facts?.stageCode) known.push(`服务端结算阶段：${facts.stageCode}${facts.viewerActionRequired ? "（需要你操作）" : "（当前不需要你操作）"}`);
  const base = { known, terminal, noNewTransaction: terminal, pendingRead: false };

  // A historical manual close never settled or refunded by itself.
  if (order.fundsResolution?.code === "HISTORICAL_MANUAL_CLOSE") {
    return { ...base, tone: "warning", title: "联系客服核对资金处理", owner: "客服",
      note: "原人工关闭没有自动完成结算或退款。请联系平台核对原付款与资金处理记录；订单关闭不代表资金已处理或退款已到账。",
      primary: progressSupport, secondary: [progressRefund, progressRefresh], terminal: true, noNewTransaction: true };
  }

  // Migrated orders keep their own continuation contract; current membership prices never re-price them.
  if (legacy) {
    const inflight = status === "PAID" || status === "PENDING_PAYMENT";
    return { ...base, tone: "done", title: inflight ? "查看订单续办" : "查看历史订单事实", owner: inflight ? "你" : "暂无",
      note: inflight
        ? "这是迁入的历史订单。页面下方的「订单续办」保留本单原有的预览、提交、确认与拒绝能力；金额以本单可核实的旧价与旧付款事实为准，不套用当前会员价格，账号资料也不是下单时的冻结快照。资料缺失请联系客服。"
        : "这是迁入的历史订单。页面只展示可核实的历史事实、原退款记录与客服入口；历史记录金额不代表渠道到账。",
      primary: inflight ? { label: "查看订单续办", target: "legacy" } : progressSupport,
      secondary: inflight ? [progressSupport, progressRefresh] : [{ label: "返回订单列表", target: "list" }],
      terminal: !inflight, noNewTransaction: !inflight };
  }

  if (status === "PENDING_PAYMENT") {
    if (order.expiredAwaitingCancel) {
      return { ...base, tone: "warning", title: "等待平台释放账号占用", owner: "平台",
        note: "原支付保留时间已到期，系统正按序释放账号占用，不再接受新的支付。请以服务端订单状态为准，不要重复付款。",
        primary: progressRefresh, secondary: [progressSupport, party === "renter" ? progressBrowse : progressManage] };
    }
    // A channel request with an unknown/review result is not an invitation to pay again. The
    // channel read owns this fact; the order main status alone cannot clear it.
    const pay = payment ?? null;
    if (party === "renter" && pay === null && (order.paymentOpen ?? true)) {
      return { ...base, tone: "waiting", title: "正在核对支付状态", owner: "平台",
        note: "正在读取本单支付记录；读取完成后再显示可用操作。",
        primary: null, secondary: [progressSupport], pendingRead: true };
    }
    const unknownPayment = pay?.originalRequestPending === true || pay?.readFailed === true
      || ["UNKNOWN", "SUBMITTING", "PROCESSING_UNCONFIRMED", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "REVIEW_REQUIRED"].includes(pay?.state ?? "")
      || ["CONFIRMING", "CONFIRMING_PAYMENT", "UNDER_REVIEW", "SUBMITTING", "PROCESSING", "STATUS_PENDING_CONFIRMATION"].includes(pay?.displayState ?? "")
      || ["CHANNEL_RESULT_UNKNOWN", "CHANNEL_RESULT_PENDING", "PAYMENT_REVIEW", "UNKNOWN_SOURCE", "UNKNOWN_STATE", "REQUEST_SUBMITTING"].includes(pay?.blockedReason ?? "");
    if (unknownPayment) {
      return { ...base, tone: "unknown", title: "支付结果正在确认", owner: "平台",
        note: pay?.originalRequestPending
          ? "本地保留了一笔待核对的原支付申请。请先查询原请求，不要重复付款；是否扣款以渠道和平台记录为准。"
          : pay?.readFailed
            ? "本页暂时读不到这笔订单的渠道支付状态。已读到的订单事实保持有效；支付结果正在确认，不要重复付款，可重试读取、按原请求查询回执或联系客服核对。模拟付款记录不代表渠道扣款。"
            : "本单已有一笔支付请求的结果尚未确认，或需要平台人工核对。支付结果正在确认，页面不会把它写成支付成功，也不引导重复付款；请在支付区按原请求查询回执，或联系客服核对。",
        primary: pay?.originalRequestPending ? { label: "查询原支付请求", target: "trade" }
          : { label: pay?.readFailed ? "重试读取" : "查询原支付请求", target: pay?.readFailed ? "refresh" : "trade" },
        secondary: [progressSupport, progressRefresh], pendingRead: true,
        known: [...known, "本次支付读取没有给出可确认的付款结论，未确认的事项保持未知"] };
    }
    if (party === "renter" && (order.paymentOpen ?? true)) {
      return { ...base, tone: "active", title: "完成支付", owner: "你",
        note: "请在本页支付区选择服务端当前开放的方式完成付款；结果未确认时查询原请求，不要重复提交。付款接纳不等于交付、建群或开租，模拟付款记录也不代表渠道扣款。",
        primary: { label: "去支付", target: "trade" }, secondary: [progressSupport] };
    }
    return { ...base, tone: "waiting", title: "等待租客支付", owner: "对方",
      note: "本单尚未付款，号主不能代付或代为接单。租客完成支付后，双方再按冻结报价核对开租清单。",
      primary: progressRefresh, secondary: [progressSupport] };
  }

  if (status === "CANCELLED") {
    if (order.cancelReason === "OWNER_DELISTED") return { ...base, tone: "warning", title: "号主已下架账号，订单已取消", owner: "暂无",
      note: party === "renter" ? "请勿继续使用之前的付款码；如果已经扣款，请联系客服核对。" : "待付款订单已关闭；如租客仍通过旧付款码支付，请联系客服核对。",
      primary: progressSupport, secondary: [progressRefresh] };
    const prestart = order.cancelReason === "PRESTART_TERMINATED";
    // The existing attention band already owns the one role-specific "browse/manage" next step;
    // repeating it here would give a cancelled order two competing primary exits.
    return { ...base, tone: "done", title: "查看退款进度", owner: "暂无",
      note: prestart
        ? "本单未开租终止，账号占用已解除。退款处理进度看下方退款记录；本地受理与核销都不等于渠道退款到账，售后与客服入口仍可使用。"
        : "订单已结束，本页不再提供开租或结算操作。可按实际可用性查看退款进度、提交售后记录或联系客服；取消或过账都不代表渠道退款已到账，本单账号不会因完单而再次上架。",
      primary: progressRefund, secondary: [progressSupport, progressRefresh] };
  }

  if (status === "PAID" || status === "COMPLETED") {
    // A terminal order never offers another opening/settlement write, even when a
    // stale settlement read still reports an in-flight phase. Keep the mismatch
    // unknown instead of guessing which record won.
    if (terminal && facts && facts.phase !== "POSTED") {
      return { ...base, tone: "unknown", title: "查看退款与售后", owner: "平台",
        note: "订单主状态已完成，但本次结算读取尚未给出已过账结论。已读到的订单事实保持有效；本页不再提供开租或结算操作，可按实际权限查看退款进度、提交售后记录或联系客服。",
        primary: progressRefund, secondary: [progressSupport, progressRefresh], pendingRead: true,
        known: [...known, "结算阶段与订单主状态不一致，未确认的事项保持未知"] };
    }
    if (readFailed && !facts) {
      return { ...base, tone: "unknown", title: "核对当前进度", owner: "平台",
        note: "本页暂时读不到开租与结算记录。已展示的订单金额与时间仍然有效；消耗、费用及退款没有读到就保持未知，不显示为成功或到账。可重试读取或联系客服。",
        primary: progressRetry, secondary: [progressSupport], pendingRead: true,
        known: [...known, "本次开租与结算读取未成功，未确认的事项保持未知"] };
    }
    if (!facts) {
      return { ...base, tone: "unknown", title: "正在核对当前进度", owner: "平台",
        note: "页面正在按服务端记录核对开租与结算进度，暂时不展示阶段结论；已读到的订单事实保持有效。",
        primary: progressRefresh, secondary: [progressSupport], pendingRead: true };
    }
    // The server can explicitly mark the stage unverifiable. Never turn that into a confident
    // "confirm the checklist" or "end the rental" next step.
    if (facts.feeReconfirmationRequired) {
      return { ...base, tone: "warning", title: "等待重新核对结算方案", owner: "客服",
        note: "原方案的包赔费计算口径需要更正，请联系客服重新生成。新方案需要双方重新确认。",
        primary: progressSupport, secondary: [progressRefresh, progressRefund] };
    }
    if (facts.stageCode === "UNKNOWN") {
      return { ...base, tone: "unknown", title: "状态待核实", owner: "平台",
        note: "服务端本次把结算阶段标记为待核实。已读到的订单事实保持有效；页面不推断开租、结算或退款结论，可刷新读取或联系客服核对。",
        primary: progressRefresh, secondary: [progressSupport, progressRefund], pendingRead: true,
        known: [...known, "服务端结算阶段为 UNKNOWN，未确认的事项保持未知"] };
    }
    if (facts.phase === "POSTED") {
      return { ...base, tone: "done", title: "查看退款与售后", owner: "暂无",
        note: "结算已过账。应退金额、平台退款处理状态与渠道到账是三件独立的事，页面不会把过账写成已到账。可按实际权限查看退款进度、提交售后记录或联系客服；本单账号不会再次上架。",
        primary: progressRefund, secondary: [progressSupport], terminal: true, noNewTransaction: true };
    }
    if (facts.phase === "DECISION_REJECTED") {
      return { ...base, tone: "warning", title: "等待新的结算方案", owner: "客服",
        note: "这一版结算未达成一致，拒绝不会使它生效。请等待客服按新的期末数据或人工调整生成新版本后再核对；期间不需要重复确认。",
        primary: progressSupport, secondary: [progressRefresh, progressRefund] };
    }
    if (facts.phase === "INTAKE_PENDING") {
      return { ...base, tone: "waiting", title: "等待客服复核结束申请", owner: "客服",
        note: "期末数据已提交，等待受权客服核实原因并复核；复核与双方确认完成后结算才生效。当前没有需要你提交的写操作。",
        primary: progressRefresh, secondary: [progressSupport] };
    }
    if (facts.phase === "DECISION_PENDING") {
      return { ...base, tone: "active", title: "核对并确认本版结算", owner: "你",
        note: "请在本页结算区核对本次消耗、费用承担与责任归属；金额由服务端预览与版本给出。拒绝与确认是不同结果，拒绝不会使这一版生效。",
        primary: { label: "确认结算", target: "trade" }, secondary: [progressSupport] };
    }
    if (facts.phase === "DECISION_WAITING") {
      return { ...base, tone: "waiting", title: "等待对方确认结算", owner: "对方",
        note: "你已在这一版完成操作；金额或版本变化会生成新版本并要求重新确认。无需重复提交。",
        primary: progressRefresh, secondary: [progressSupport] };
    }
    // No current settlement version yet: the opening checklist is the live decision.
    if (!facts.rentalStarted || !facts.openingConfirmedAt) {
      if (facts.openingVersionNo === null) {
        const generationPending = facts.openingGenerationState === "REVIEW_REQUIRED" || facts.openingGenerationRecoveryRequired;
        return { ...base, tone: "warning", title: "联系客服核对开租清单", owner: "客服",
          note: "付款已接纳，但本单尚未读到自动生成的开租清单。资料不足或生成待核对时由客服办理；订单群准备好不等于已经开租，页面不会自动生成清单或交付。请刷新或联系客服。",
          primary: progressSupport, secondary: [progressOrderGroups, progressRefresh],
          known: [...known, generationPending ? "服务端记录：开租清单生成待客服核对" : "本次结算读取没有返回开租清单"] };
      }
      const due = typeof facts.autoConfirmDueAt === "string" && Number.isFinite(Date.parse(facts.autoConfirmDueAt)) ? facts.autoConfirmDueAt : null;
      if (!facts.myAck) {
        return { ...base, tone: "active", title: "确认期初清单并开租", owner: "你",
          note: `期初数量取自本单冻结报价，双方各自确认同一版本；确认来源会区分本人、客服代操作与系统自动确认，截止时间取本单冻结值。${due ? "" : "本单未记录自动确认截止时间，页面不会承诺系统自动确认。"}付款、建群与沟通都不等于已开租。`,
          primary: { label: "确认期初并开租", target: "trade" }, secondary: [progressSupport],
          known: due ? [...known, `本单冻结的自动确认截止时间：${formatOrderTime(due)}`] : [...known, "本单未记录自动确认截止时间"] };
      }
      return { ...base, tone: "waiting", title: "等待对方确认期初清单", owner: "对方",
        note: due
          ? "你已完成期初确认，等待对方确认后正式开租；未确认时按本单冻结的截止时间由系统自动确认。无需代替对方操作。"
          : "你已完成期初确认，等待对方确认后正式开租。本单没有记录自动确认截止时间，页面不会承诺系统会自动确认；如对方迟迟未确认，请联系客服核对，不要代替对方操作。",
        primary: progressRefresh, secondary: [progressSupport],
        known: due ? [...known, `本单冻结的自动确认截止时间：${formatOrderTime(due)}`] : [...known, "本单未记录自动确认截止时间"] };
    }
    return { ...base, tone: "active", title: "发起结束租用并核对消耗", owner: "你",
      note: "按实际消耗或期末剩余填写后，先由服务端预览金额，再提交结算；最终金额不在浏览器计算。消耗偏低属于提前结束时，需客服复核并按新方案确认。",
      primary: { label: "发起结束租用", target: "trade" }, secondary: [progressSupport] };
  }

  return { ...base, tone: "unknown", title: "核对当前进度", owner: "平台",
    note: "当前订单状态没有可展示的下一步结论；已读到的订单事实保持有效，可刷新或联系客服。",
    primary: progressRefresh, secondary: [progressSupport], pendingRead: true };
}

/** Report assembled from the legacy continuation read, never from the order status alone. */
export type LegacyProgressReport = {
  status: string;
  party: OrderParty;
  availability: "KNOWN" | "NOT_IMPORTED" | "ISOLATED" | null;
  capabilities: string[];
  stage: string | null;
  isSettle: string | null;
  reasons: string[];
  refundProgress: string[];
  /** A saved original-key intent whose result is not confirmed yet. */
  pending: "NONE" | "VALID" | "UNREADABLE" | "UNKNOWN";
  readFailed: boolean;
};
export type LegacyProgressView = {
  tone: OrderProgressView["tone"];
  title: string;
  owner: OrderProgressOwner;
  note: string;
  primary: OrderProgressAction;
  secondary: OrderProgressAction[];
  known: string[];
  terminal: boolean;
};

const LEGACY_CAPABILITY_LABELS: Record<string, string> = {
  preview: "预览金额", propose: "提交结算方案", confirm: "确认结算方案", reject: "拒绝结算方案",
  hold: "暂扣押金", release: "解除暂扣", confiscate: "没收押金",
};
const LEGACY_REFUND_LABELS: Record<string, string> = {
  UNKNOWN: "退款状态待核对", NO_REFUND_DUE: "无需退款", NO_NEW_REFUND: "旧退款已抵扣本次应退",
  CHANNEL_SUCCEEDED: "渠道已确认退款", FAILED: "退款未完成，请联系客服", PROCESSING: "退款处理中",
  REVIEW_REQUIRED: "退款状态待核对", SIMULATED: "模拟退款已记录，不代表真实退款或到账",
};

/**
 * Migrated orders have their own continuation contract. The page must only promise capabilities
 * the continuation read actually returned, keep terminal orders free of new writes, and surface a
 * saved original-key intent before inviting the user to look at the panel again.
 */
export function legacyProgressView(input: LegacyProgressReport): LegacyProgressView {
  const terminal = input.status === "COMPLETED" || input.status === "CANCELLED";
  const known = [
    `历史订单主状态：${orderStatusFact(input.status).replace("订单主状态：", "")}`,
    "旧单金额以本单可核实的旧价与旧付款事实为准，不套用当前会员价格；账号资料不是下单时的冻结快照",
    "历史记录金额与原退款记录都不代表渠道到账",
  ];
  if (input.availability) known.push(`续办资料可用性：${input.availability}`);
  if (input.stage) known.push(`旧单阶段：${input.stage}`);
  if (input.capabilities.length) known.push(`服务端开放的续办能力：${input.capabilities.map(c => LEGACY_CAPABILITY_LABELS[c] ?? c).join("、")}`);
  for (const progress of input.refundProgress) known.push(`原退款记录：${LEGACY_REFUND_LABELS[progress] ?? "状态待核对"}`);
  for (const reason of input.reasons) known.push(`服务端续办理由：${reason}`);
  const openRefund = input.refundProgress.some(p => ["UNKNOWN", "PROCESSING", "REVIEW_REQUIRED", "FAILED"].includes(p));

  if (input.readFailed || input.availability === null) {
    return { tone: "unknown", title: "续办状态待核对", owner: "平台",
      note: "本页暂时读不到旧单续办资料。已读到的订单金额、时间与退款记录仍然有效；页面不推断还有哪些可办理的操作，可重试读取或联系客服核对。",
      primary: progressRetry, secondary: [progressSupport], terminal,
      known: [...known, "本次旧单续办读取未成功，未确认的事项保持未知"] };
  }
  if (input.availability !== "KNOWN") {
    return { tone: "warning", title: "资料待客服核对", owner: "客服",
      note: "这笔迁入订单的续办资料尚未核实（未导入或已隔离）。页面不承诺有任何可用的预览、提交、确认或拒绝功能；已读到的金额与时间仍是历史记录，证据缺失或金额存疑请联系客服核对。",
      primary: progressSupport, secondary: [progressRefresh], terminal, known };
  }
  if (terminal) {
    return { tone: "done", title: "查看历史订单事实", owner: "暂无",
      note: `这笔迁入订单已完成或取消。页面只展示可核实的历史事实、原退款记录与客服入口，不再提供开租、结算或新的续办写操作，也不提供新订单续租或订单评价。${openRefund ? "本单仍有待处理的退款记录，可在下方查看并联系客服核对；" : ""}历史记录金额不代表渠道到账。`,
      primary: progressSupport, secondary: [{ label: "返回订单列表", target: "list" }], terminal: true, known };
  }
  if (input.pending !== "NONE") {
    return { tone: "warning", title: "先核对未确认的续办申请", owner: "你",
      note: "检测到一笔按原请求键保存、结果未知的旧单续办申请。请先按原键查询回执，不要重复提交；页面不会清除待恢复记录。金额仍以旧价与旧付款事实为准。",
      primary: { label: "查询原请求", target: "legacy" }, secondary: [progressSupport, progressRefresh], terminal: false, known };
  }
  if (input.reasons.includes("EARLY_REVIEW_PENDING")) {
    return { tone: "waiting", title: "提前结算待客服复核", owner: "客服",
      note: "结算方案已确认，客服复核后才会过账；退款进度以实际处理为准。",
      primary: progressSupport, secondary: [progressRefresh], terminal: false, known };
  }
  if (input.capabilities.length === 0) {
    return { tone: "waiting", title: "等待客服核对续办能力", owner: "客服",
      note: "服务端当前没有为这笔旧单开放新的续办写操作。页面不显示预览、提交、确认或拒绝入口；已读到的金额与时间仍是历史记录，需要办理请联系客服。",
      primary: progressSupport, secondary: [progressRefresh], terminal: false, known };
  }
  const stageOwner: OrderProgressOwner = input.stage === "8" ? input.party === "owner" ? "你" : "对方"
    : input.stage === "9" ? input.party === "renter" ? "你" : "对方"
      : input.stage === "4" ? "客服" : "你";
  const caps = input.capabilities.map(c => LEGACY_CAPABILITY_LABELS[c] ?? c).join("、");
  return { tone: "active", title: "查看并办理订单续办", owner: stageOwner,
    note: `这是迁入的历史订单，不是新订单续租。下方「订单续办」当前开放：${caps}；只按本单可核实的旧价与旧付款事实办理，不套用当前会员价格，账号资料也不是下单时的冻结快照。证据缺失或金额存疑请联系客服核对。${openRefund ? "本单另有待处理的退款记录，可在下方查看并联系客服核对。" : ""}`,
    primary: { label: "查看订单续办", target: "legacy" }, secondary: [progressSupport, progressRefresh], terminal: false, known };
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
  if (quantity === null || quantity === undefined || quantity === "") return "数量未记录";
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
    rows.push({ label: "未消耗物资预付款（按下单时分配）", value: amountAt(amounts, "unusedItemRefund"), note: "按下单时的预付款分配计算；实际应退会重新计算会员折扣和费用。" });
    rows.push({ label: "未消耗哈夫币预付款（按下单时分配）", value: amountAt(amounts, "unusedHaffRefund"), note: "按下单时的预付款分配计算；实际应退会重新计算会员折扣和费用。" });
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
  let rows = settlementAmountRows(party, versionAmounts(version));
  if (!isAdjustedVersion(version)) return rows;
  if(party==="owner" && version?.inputSnapshot?.proposedOwnerGross != null) {
    rows=rows.map(row=>row.label==="号主毛收入" || row.label.startsWith("包赔费用") ? {...row,label:`系统计算${row.label}`,note:"调整前的系统计算"} : row);
    rows.push({label:"调整后号主扣费前收入",value:moneyText(version.inputSnapshot.proposedOwnerGross)});
    rows.push({label:"调整后包赔费",value:moneyText(version.inputSnapshot.proposedFullPayoutFee)});
  }
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
  const projected=rows.map((row) => {
    if (row.label === target) return { ...row, value: finalValue };
    if (adjusted && row.label === "本次结算扣费") return { ...row, label: chargeLabel, note: "调整前的系统计算；最终应退以人工调整结果为准" };
    if (adjusted && party==="owner" && posting.manualAdjustment?.proposedOwnerGross != null && (row.label==="号主毛收入" || row.label.startsWith("包赔费用")))
      return {...row,label:`系统计算${row.label}`,note:"调整前的系统计算"};
    return adjusted ? { ...row, note: row.note ?? "系统计算快照" } : row;
  });
  if(adjusted && party==="owner" && posting.manualAdjustment?.proposedOwnerGross != null) {
    projected.push({label:"调整后号主扣费前收入",value:moneyText(posting.manualAdjustment.proposedOwnerGross)});
    projected.push({label:"调整后包赔费",value:moneyText(posting.manualAdjustment.proposedFullPayoutFee)});
  }
  return projected;
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
export function consumptionRows(order: Order, opening: SettlementOpening | null, version: SettlementVersion | null | undefined, extraResources: SettlementLine[] = []): ConsumptionRow[] {
  const openingLines = opening?.lines ?? [];
  if (openingLines.length === 0) return [];
  const submittedIds=new Set((version?.inputSnapshot?.lines??[]).filter(line=>typeof line.consumedQuantity==="string"&&/^\d+$/.test(line.consumedQuantity)&&BigInt(line.consumedQuantity)>0n).map(line=>line.itemId));
  const lines=[...openingLines,...extraResources.filter(line=>submittedIds.has(line.itemId)&&!openingLines.some(item=>item.itemId===line.itemId)).map(line=>({...line,quantity:"0"}))];
  const submitted = new Map((version?.inputSnapshot?.lines ?? []).map((line) => [line.itemId, line.remainingQuantity]));
  const consumed = version?.computation?.consumed;
  return lines.map((line) => {
    const open = line.quantity ?? null;
    const rest = submitted.get(line.itemId) ?? null;
    const serverLine = consumed?.items?.find((item) => item.itemId === line.itemId);
    const derived = open !== null && rest !== null && /^\d+$/.test(open) && /^\d+$/.test(rest) && BigInt(rest) <= BigInt(open)
      ? (BigInt(open) - BigInt(rest)).toString()
      : null;
    const used = line.pricingKind === "HAFF_RATIO" && consumed?.haff !== undefined && consumed.haff !== null
      ? String(consumed.haff)
      : serverLine?.consumed ?? derived;
    return { itemId: line.itemId, name: line.name??resourceName(order, line.itemId), unit: line.unit, opening: open, remaining: rest, consumed: used ?? null };
  });
}
