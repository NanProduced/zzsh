"use client";

import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { formatMoneyLabel } from "@/lib/listing-view";
import { type Order, type PersonalRentalQuote, type RentalAgreement, type RentalPricePreview } from "@/lib/order-client";
import { depositReductionCents, membershipBenefitPresentation, moneyText, personalMembershipLabel } from "@/lib/order-display";
import { MembershipBenefitsCard, type ReferenceFees } from "./rental-price-summary";

type AgreementInfo = RentalAgreement;

export type StoredContext = { payable?: string; tier?: string; deposit?: string; expiresAt?: string; disclosure?: string };

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: RentalPricePreview }
  | {
      status: "error";
      code?: string;
      statusHttp?: number;
      message: string;
      requestId?: string;
      canRetry: boolean;
      action?: "refresh" | "back" | "orders";
      retryAfter?: number;
    };

export type Stage =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: PersonalRentalQuote; agreement: AgreementInfo | null; agreementProblem: string | null }
  | { kind: "creating"; quote: PersonalRentalQuote | null }
  | { kind: "create-unknown"; context: StoredContext; message: string; stale: boolean }
  | { kind: "created"; quote: PersonalRentalQuote; order: Order }
  | { kind: "pay-unknown"; orderId: string; message: string }
  | { kind: "paid"; orderId: string }
  | { kind: "review"; orderId: string; reason: string | null }
  | { kind: "notice"; message: string; canRequote: boolean; orderId?: string; action?: "orders" | "refresh" | "back" };

export function countdown(expiresAt: string, now: number): string | null {
  const until = Date.parse(expiresAt);
  if (!Number.isFinite(until)) return null;
  const seconds = Math.max(0, Math.floor((until - now) / 1000));
  if (seconds <= 0) return "已过期";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 内有效`;
}

export function findQuoteChanges(
  baseline: RentalPricePreview | PersonalRentalQuote | null,
  confirmed: PersonalRentalQuote
): string | null {
  if (!baseline) return null;
  const bQuote = baseline.quote;
  const cQuote = confirmed.quote;
  if (!bQuote || !cQuote) return "报价信息尚不完整，请核对最新费用。";
  const amountFacts = (value: { currency?: unknown; unit?: unknown; scale?: unknown; amount?: unknown } | null | undefined) =>
    value ? [value.currency, value.unit, value.scale, value.amount] : null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // 1. Listing hash
  const bHash = "binding" in baseline ? baseline.binding?.listingHash : baseline.listingHash;
  const cHash = confirmed.listingHash;
  if (!bHash || !cHash || bHash !== cHash) {
    return "账号发布信息已有更新，请核对最新报价。";
  }

  // 2. Total payable amount
  if (!same(amountFacts(bQuote.tenantPayableTotal), amountFacts(cQuote.tenantPayableTotal))) {
    return `费用已更新：原预付 ${moneyText(bQuote.tenantPayableTotal)}，最新确认 ${moneyText(cQuote.tenantPayableTotal)}。请核对后下单。`;
  }

  // 3. Resource total & deposit
  if (
    !same(amountFacts(bQuote.resourceTotal), amountFacts(cQuote.resourceTotal)) ||
    !same(amountFacts(bQuote.tenantDeposit), amountFacts(cQuote.tenantDeposit)) ||
    !same(amountFacts(baseline.baseTenantDeposit), amountFacts(confirmed.baseTenantDeposit))
  ) {
    return "费用构成已核定更新（资源费或押金明细已变动）。请核对最新金额后下单。";
  }

  // 4. Line items breakdown
  const bLines = bQuote.lines ?? [];
  const cLines = cQuote.lines ?? [];
  if (bLines.length !== cLines.length) {
    return "计费项目清单已更新。请核对最新明细后下单。";
  }
  const confirmedLines = new Map(cLines.map(line => [line.itemId, line]));
  if (confirmedLines.size !== cLines.length || new Set(bLines.map(line => line.itemId)).size !== bLines.length) {
    return "计费项目清单需要重新核对。";
  }
  for (const bl of bLines) {
    const cl = bl.itemId ? confirmedLines.get(bl.itemId) : undefined;
    if (!cl) {
      return "计费项目清单已更新。请核对最新明细后下单。";
    }
    if (
      bl.itemId !== cl.itemId ||
      bl.quantity !== cl.quantity ||
      bl.unit !== cl.unit ||
      bl.unitQuantity !== cl.unitQuantity ||
      !same(amountFacts(bl.buyerUnitAmount), amountFacts(cl.buyerUnitAmount)) ||
      !same(amountFacts(bl.buyerAmount), amountFacts(cl.buyerAmount))
    ) {
      return "计费明细金额或数量已更新。请核对最新金额后下单。";
    }
  }

  // 5. Membership benefits & customer tier
  const bBen = baseline.membershipBenefits;
  const cBen = confirmed.membershipBenefits;
  if (bBen || cBen) {
    if (
      bBen?.priceSource !== cBen?.priceSource ||
      bBen?.depositSource !== cBen?.depositSource ||
      bBen?.policyVersion !== cBen?.policyVersion ||
      bBen?.policyTier !== cBen?.policyTier ||
      bBen?.effectiveTier !== cBen?.effectiveTier
    ) {
      return "会员优惠或计费条款已按最新依据更新。请核对最新条款后下单。";
    }
  }

  if (baseline.customerTier !== confirmed.customerTier) {
    return "会员计价依据已更新，请核对最新报价。";
  }
  const termsFacts = (disclosure: PersonalRentalQuote["compensationDisclosure"]) => disclosure
    ? [disclosure.selected, disclosure.disclosureVersion, disclosure.terms?.termsVersionId, disclosure.terms?.termsDigest, disclosure.terms?.disclosureVersion]
    : null;
  if (!same(termsFacts(baseline.compensationDisclosure), termsFacts(confirmed.compensationDisclosure))) {
    return "适用条款已有更新，请阅读并重新确认后下单。";
  }

  return null;
}

export function buildRentalPriceState({
  userId,
  stage,
  previewState,
  now,
  sessionStatus,
  autoPreview,
  reference,
}: {
  userId: string | null;
  stage: Stage;
  previewState: PreviewState;
  now: number;
  sessionStatus: string;
  autoPreview: boolean;
  reference?: ReferenceFees;
}): {
  expiredQuote: boolean;
  priceQuote: PersonalRentalQuote | RentalPricePreview | null;
  pendingLabel: string | undefined;
  dockPrice: ReactNode;
} {
  const expiredQuote = stage.kind === "quoted" && ["已过期", null].includes(countdown(stage.quote.expiresAt, now));
  const priceQuote = userId && stage.kind === "quoted" && !expiredQuote
    ? stage.quote
    : userId && previewState.status === "ready" && stage.kind === "idle"
      ? previewState.preview
      : null;
  const pendingLabel = sessionStatus === "loading" ? "正在确认登录状态" :
    stage.kind === "quoted" && countdown(stage.quote.expiresAt, now) === null ? "报价有效期未确认" :
    expiredQuote ? "报价已过期" : stage.kind === "quoting" ? "正在读取本人报价" :
    stage.kind === "create-unknown" || stage.kind === "pay-unknown" ? "原请求结果待确认" :
    stage.kind === "creating" ? "正在确认订单" : stage.kind === "notice" ? "本人报价待确认" :
    autoPreview && previewState.status === "loading" ? "正在读取本人报价" :
    autoPreview && previewState.status === "error" ? "本人报价待确认" :
    stage.kind !== "idle" && stage.kind !== "quoted" ? "请查看订单金额" : undefined;
  const dockPrice = reference ? <span className="rental-dock-price"><span>{priceQuote ? "本次应付（含押金）" : pendingLabel ?? "参考费用 · 押金另核"}</span><strong>{priceQuote ? moneyText(priceQuote.quote.tenantPayableTotal) : pendingLabel ? "—" : reference.total}</strong></span> : null;
  return { expiredQuote, priceQuote, pendingLabel, dockPrice };
}

export function RentalPriceChangeNotice({ notice }: { notice: string | null }) {
  if (!notice) return null;
  return (
    <div className="rental-confirm-notice rental-confirm-notice--price-change" role="alert" style={{ marginBottom: 12, padding: "8px 12px", background: "rgba(216, 165, 72, 0.12)", border: "1px solid rgba(216, 165, 72, 0.4)", borderRadius: 6, fontSize: 13, color: "var(--foreground, #fff)" }}>
      <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <AlertCircle size={15} style={{ flexShrink: 0, color: "#d8a548" }} aria-hidden="true" />
        <span>{notice}</span>
      </p>
    </div>
  );
}

export function RentalPersonalQuoteFacts({ quote }: { quote: PersonalRentalQuote }) {
  const money = quote.quote;
  const payable = formatMoneyLabel(money.tenantPayableTotal ?? null) ?? "以服务端确认为准";
  const depositReduction = depositReductionCents(quote.baseTenantDeposit, money.tenantDeposit ?? null);
  const baseDepositLabel = moneyText(quote.baseTenantDeposit);
  const actualDepositLabel = formatMoneyLabel(money.tenantDeposit ?? null) ?? moneyText(money.tenantDeposit);
  const benefitCard = membershipBenefitPresentation(quote, null, depositReduction, Boolean(quote.depositWaived && actualDepositLabel === "¥0.00"));
  return <>
    <div className="rental-confirm-head"><strong>个人报价确认</strong>
      <span className="rental-confirm-tier">{personalMembershipLabel(quote)}{quote.depositWaived ? " · 已免租客押金" : ""}</span></div>
    <MembershipBenefitsCard presentation={benefitCard} />
    <dl className="rental-confirm-facts">
      <div><dt>资源费用</dt><dd>{formatMoneyLabel(money.resourceTotal ?? null) ?? "—"}</dd></div>
      <div><dt>租客押金</dt><dd>{depositReduction !== null ? <><del aria-label={`原租客押金 ${baseDepositLabel}`}>{baseDepositLabel}</del><span> {quote.depositWaived && actualDepositLabel === "¥0.00" ? "已免押" : actualDepositLabel}</span></> : quote.depositWaived ? "已免押" : formatMoneyLabel(money.tenantDeposit ?? quote.baseTenantDeposit) ?? "—"}</dd></div>
      <div className="rental-confirm-total"><dt>预计合计</dt><dd>{payable}</dd></div>
    </dl>
  </>;
}

export function RentalCreatedAmount({ total }: { total: string | null }) {
  return (
    <div className="rental-created-amount-card">
      <span className="rental-created-amount-label">本次应付</span>
      <strong className="rental-created-amount-val">{total ?? "以服务端确认为准"}</strong>
    </div>
  );
}
