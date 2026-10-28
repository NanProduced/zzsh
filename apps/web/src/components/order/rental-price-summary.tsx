import { useEffect, useRef } from "react";
import Image from "next/image";
import { CircleHelp, Coins, Gift, Info, Package, ShieldCheck } from "lucide-react";
import type { PersonalRentalQuote, RentalPricePreview, OrderLine } from "@/lib/order-client";
import type { ResourceLine } from "@/lib/listing-view";
import { moneyText, personalMembershipLabel, personalBenefitSources } from "@/lib/order-display";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type PriceQuote = PersonalRentalQuote | RentalPricePreview;

export type ReferenceFees = {
  total: string;
  haff: string;
  items: string;
  lines?: readonly ResourceLine[];
  unitAmountsInformational?: boolean;
  baseRenterHaffRatioWanPerYuan?: string | null;
};

/** Strictly narrowed metadata allowed to be borrowed from reference. No quantities, no costs! */
export type RefLineMeta = Pick<ResourceLine, "itemId" | "code" | "name" | "unitLabel">;

/** Display sums of the API's rounded buyer lines, never a price calculation. */
export function personalFeeLines(quote: PriceQuote): { haff: string; items: string } | null {
  const lines = quote.quote.lines;
  if (!lines?.length) return null;
  let haff = 0n, items = 0n;
  for (const line of lines) {
    if (!["HAFF_BASE", "PIECE", "ROUND", "DAY"].includes(line.unit ?? "") || moneyText(line.buyerAmount) === "—") return null;
    const cents = BigInt(line.buyerAmount!.amount.replace(".", ""));
    if (line.unit === "HAFF_BASE") haff += cents; else items += cents;
  }
  if (moneyText(quote.quote.resourceTotal) === "—" || haff + items !== BigInt(quote.quote.resourceTotal!.amount.replace(".", ""))) return null;
  const label = (cents: bigint) => `¥${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  return { haff: label(haff), items: label(items) };
}

function canonicalCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const aliases: Record<string, string> = {
    level6_armor: "df_billable_level6_armor",
    level6_helmet: "df_billable_level6_helmet",
    level6_round: "df_billable_level6_bullet",
    awm_round: "df_billable_awm_bullet",
    coffee: "df_billable_coffee",
    legacy_barrett_round: "df_billable_barrett_bullet",
    barrett_round: "df_billable_barrett_bullet",
    top_insure_card_piece: "df_billable_top_insure_card",
    df_billable_top_insure_card_piece: "df_billable_top_insure_card",
    legacy_insurance_day: "df_billable_top_insure_card",
  };
  return aliases[code] ?? code;
}

function cleanDecimal(amount: string): string {
  return amount.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

export function formatAuthoritativeRatio(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const clean = cleanDecimal(trimmed);
  return `${clean}万/元`;
}

function unitPriceText(line: { code?: string | null; unitPriceLabel?: string | null }): string {
  if (!line.unitPriceLabel) return "未确认";
  const match = line.unitPriceLabel.match(/^(¥\d+(?:\.\d+)?)\s*\/\s*(\d+)\s+(.+)$/);
  if (!match) return line.unitPriceLabel;
  const amount = cleanDecimal(match[1]!);
  const grouped = canonicalCode(line.code) === "df_billable_level6_bullet" && match[2] === "60" && match[3] === "发";
  return `${amount} / ${grouped ? "组" : `${match[2] === "1" ? "" : match[2]}${match[3]}`}`;
}

function formatPersonalUnitPrice(
  unitAmount: { amount?: string } | null | undefined,
  unitQuantity?: string | null,
  unitLabel?: string | null,
  code?: string | null,
): string | null {
  if (!unitAmount?.amount) return null;
  const cleanAmount = cleanDecimal(`¥${unitAmount.amount}`);
  if (!unitQuantity && !unitLabel) return cleanAmount;
  if (!unitQuantity) {
    // Missing personal unitQuantity must not default to 1 round base
    return cleanAmount;
  }
  const isGrouped = canonicalCode(code) === "df_billable_level6_bullet" && unitQuantity === "60" && unitLabel === "发";
  if (isGrouped) return `${cleanAmount} / 组`;
  if (unitQuantity === "1") {
    return unitLabel ? `${cleanAmount} / ${unitLabel}` : cleanAmount;
  }
  return unitLabel ? `${cleanAmount} / ${unitQuantity}${unitLabel}` : `${cleanAmount} / ${unitQuantity}`;
}

function isHaffLine(line: { code?: string | null; itemId?: string | null; unit?: string | null }): boolean {
  return (
    line.unit === "HAFF_BASE" ||
    line.itemId === "haff_rent" ||
    canonicalCode(line.code) === "df_billable_haff"
  );
}

type FormattedBillRow = {
  key: string;
  name: string;
  isHaff: boolean;
  spec: string;
  amount: string;
  isZero: boolean;
  isUnknown: boolean;
  ratioTag?: string | null;
};

function formatPublicRow(line: ResourceLine, authoritativeRatio?: string | null): FormattedBillRow {
  const isHaff = isHaffLine(line);
  const isZeroQuantity = line.quantity === "0";
  const isUnknownQuantity = line.quantity == null || line.quantity === "";

  const hasCost = (line.costLabel != null && line.costLabel !== "") || (line.costAmount != null && line.costAmount !== "");
  const isZeroCost = line.costAmount === "0.00" || line.costAmount === "0" || line.costLabel === "¥0.00" || line.costLabel === "¥0";

  // Bug 2 fix: Zero quantity missing cost must NOT invent ¥0.00
  const amount = line.costLabel ?? (isZeroCost ? "¥0.00" : (hasCost ? "—" : "未提供"));
  const isUnknownAmount = !hasCost;

  if (isHaff) {
    const qtyText = line.quantityLabel?.replace(/\s+/g, "") || (line.quantity ? `${Math.round(parseInt(line.quantity, 10) / 1_000_000)}M` : "未提供");
    const ratio = formatAuthoritativeRatio(authoritativeRatio);
    const spec = qtyText;
    return {
      key: line.itemId || "haff_rent",
      name: "哈夫币",
      isHaff: true,
      spec,
      amount,
      isZero: isZeroQuantity,
      isUnknown: isUnknownQuantity || isUnknownAmount,
      ratioTag: ratio,
    };
  }

  // Bug 3 fix: Bullet inventory representation depends strictly on quantity, NEVER on cost!
  let qtyText = "未提供";
  if (!isUnknownQuantity) {
    if (canonicalCode(line.code) === "df_billable_level6_bullet") {
      const rounds = parseInt(line.quantity, 10);
      if (line.quantity === "0" || rounds === 0) {
        qtyText = "0组（0发）";
      } else if (!Number.isNaN(rounds)) {
        const stacks = Math.floor(rounds / 60);
        const rem = rounds % 60;
        qtyText = rem === 0 ? `${stacks}组（${rounds}发）` : `${stacks}组零${rem}发（共${rounds}发）`;
      } else {
        qtyText = line.quantityLabel || `${line.quantity}${line.unitLabel || "发"}`;
      }
    } else {
      qtyText = line.quantityLabel && line.quantityLabel !== line.quantity
        ? line.quantityLabel
        : `${line.quantity}${line.unitLabel || ""}`;
    }
  }

  const pText = unitPriceText(line);
  let spec = "未提供";
  if (isUnknownQuantity) {
    spec = "数量未提供";
  } else if (pText === "未确认") {
    spec = `${qtyText} · 单价未确认`;
  } else {
    spec = `${qtyText} · ${pText}`;
  }

  return {
    key: line.itemId || line.code || "unknown_item",
    name: line.name,
    isHaff: false,
    spec,
    amount,
    isZero: isZeroQuantity,
    isUnknown: isUnknownQuantity || isUnknownAmount,
  };
}

function formatPersonalRow(line: OrderLine, refLine?: RefLineMeta, authoritativeRatio?: string | null): FormattedBillRow {
  const code = refLine?.code ?? null;
  const name = line.name || refLine?.name || "资源项目";
  const isHaff = isHaffLine({ code, itemId: line.itemId, unit: line.unit });
  const unitLabel =
    line.unit === "ROUND"
      ? "发"
      : line.unit === "DAY"
        ? "天"
        : line.unit === "HAFF_BASE"
          ? "哈夫币"
          : line.unit === "PIECE"
            ? (refLine?.unitLabel || "件")
            : (refLine?.unitLabel ?? null);

  const isUnknownAmount = !line.buyerAmount?.amount;
  const isZeroQuantity = line.quantity === "0";
  const amount = line.buyerAmount ? moneyText(line.buyerAmount) : "未提供";

  const pStr = formatPersonalUnitPrice(line.buyerUnitAmount, line.unitQuantity, unitLabel, code);

  let spec = "未提供";
  let ratioTag: string | null = null;

  if (isHaff) {
    const qtyStr = line.quantity
      ? (line.quantity.endsWith("000000") ? `${parseInt(line.quantity, 10) / 1_000_000}M` : `${line.quantity}哈夫币`)
      : "未提供";
    // Authoritative base ratio is shown only if personal haff amount is present and ratio is provided.
    // If personal haff amount is missing, never display a ratio.
    ratioTag = line.buyerAmount?.amount ? formatAuthoritativeRatio(authoritativeRatio) : null;
    spec = qtyStr;
  } else {
    let qtyStr = "未提供";
    if (line.quantity != null && line.quantity !== "") {
      if (canonicalCode(code) === "df_billable_level6_bullet") {
        const rounds = parseInt(line.quantity, 10);
        if (line.quantity === "0" || rounds === 0) {
          qtyStr = "0组（0发）";
        } else if (!Number.isNaN(rounds)) {
          const stacks = Math.floor(rounds / 60);
          const rem = rounds % 60;
          qtyStr = rem === 0 ? `${stacks}组（${rounds}发）` : `${stacks}组零${rem}发（共${rounds}发）`;
        } else {
          qtyStr = unitLabel ? `${line.quantity}${unitLabel}` : line.quantity;
        }
      } else {
        qtyStr = unitLabel ? `${line.quantity}${unitLabel}` : line.quantity;
      }
    }

    if (qtyStr === "未提供") {
      spec = "数量未提供";
    } else if (!pStr) {
      spec = `${qtyStr} · 单价未提供`;
    } else {
      spec = `${qtyStr} · ${pStr}`;
    }
  }

  return {
    key: line.itemId || name || "unknown_personal_item",
    name,
    isHaff,
    spec,
    amount,
    isZero: isZeroQuantity,
    isUnknown: isUnknownAmount,
    ratioTag,
  };
}

function computeSuppliesSubtotal(supplyRows: FormattedBillRow[]): string | null {
  if (supplyRows.length === 0) return null;
  let totalCents = 0n;
  for (const row of supplyRows) {
    if (row.isUnknown || !row.amount.startsWith("¥")) return null;
    const match = row.amount.slice(1).match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return null;
    const whole = BigInt(match[1]!);
    const frac = (match[2] ?? "").padEnd(2, "0").slice(0, 2);
    totalCents += whole * 100n + BigInt(frac);
  }
  return `¥${totalCents / 100n}.${String(totalCents % 100n).padStart(2, "0")}`;
}

export function RentalPriceSummary({
  reference,
  quote,
  pendingLabel,
}: {
  reference: ReferenceFees;
  quote?: PriceQuote | null;
  pendingLabel?: string;
}) {
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const column = summaryRef.current?.closest<HTMLElement>(".account-quote-column");
    if (!column || typeof ResizeObserver === "undefined") return;
    // A tall bill follows the page until its footer fits, without an inner scroll area.
    const measure = () => column.style.setProperty("--account-quote-height", `${column.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    measure();
    return () => {
      observer.disconnect();
      column.style.removeProperty("--account-quote-height");
    };
  }, []);
  const fees = quote ? personalFeeLines(quote) : reference;
  const deposit = quote ? moneyText(quote.quote.tenantDeposit) : "另行核对";
  const waived = Boolean((quote as PersonalRentalQuote)?.depositWaived && deposit === "¥0.00");
  const baseDeposit = quote ? moneyText(quote.baseTenantDeposit) : "—";
  const tier = quote ? personalMembershipLabel(quote) : null;
  const total = quote ? moneyText(quote.quote.tenantPayableTotal) : pendingLabel ? "—" : reference.total;
  const note = quote
    ? "含租客押金，物资按实际消耗结算。"
    : pendingLabel
      ? "个人报价待确认"
      : "个人价格与押金，以个人报价为准。";
  const noteDetail = quote
    ? "本次应付来自当前有效报价，已含租客押金。物资按实际消耗和适用条款结算；押金于退租核验后按约退还。"
    : pendingLabel
      ? "公开金额暂不能替代个人报价；确认后读取会员价格、押金和适用条款。"
      : "公开参考费用来自当前发布资源费用，不含个人押金。实际价格与免押资格按当前生效规则与个人核价确认。";

  const hasItemizedLines = Boolean(reference.lines && reference.lines.length > 0);

  let billRows: FormattedBillRow[] = [];
  let billTag = "参考计价";
  let suppliesSubtotal: string = "未提供";

  // Bug 1 fix: Personal quote without lines must NOT borrow public rows
  if (quote) {
    billTag = "个人报价";
    const personalFees = personalFeeLines(quote);
    const authoritativeRatio =
      ("baseRenterHaffRatioWanPerYuan" in quote.quote
        ? (quote.quote as { baseRenterHaffRatioWanPerYuan?: string | null }).baseRenterHaffRatioWanPerYuan
        : null) ??
      reference.baseRenterHaffRatioWanPerYuan ??
      null;
    if (quote.quote.lines && quote.quote.lines.length > 0) {
      const refLineMap = new Map<string, RefLineMeta>();
      if (reference.lines) {
        for (const l of reference.lines) {
          if (l.itemId) {
            refLineMap.set(l.itemId, {
              itemId: l.itemId,
              code: l.code,
              name: l.name,
              unitLabel: l.unitLabel,
            });
          }
        }
      }
      billRows = quote.quote.lines.map((l) =>
        formatPersonalRow(l, l.itemId ? refLineMap.get(l.itemId) : undefined, authoritativeRatio)
      );
    } else {
      billRows = [];
    }

    const supplyRows = billRows.filter((r) => !r.isHaff);
    if (personalFees?.items) {
      suppliesSubtotal = personalFees.items;
    } else {
      const calculated = computeSuppliesSubtotal(supplyRows);
      suppliesSubtotal = calculated ?? "未提供";
    }
  } else if (reference.lines) {
    billTag = "参考计价";
    suppliesSubtotal = reference.items;
    billRows = reference.lines.map((l) => formatPublicRow(l, reference.baseRenterHaffRatioWanPerYuan));
  }

  const haffRow = billRows.find((r) => r.isHaff);
  const supplyRows = billRows.filter((r) => !r.isHaff);
  const visibleSupplies = supplyRows.filter((row) => !row.isZero);
  // Keep incomplete or inconsistent charges visible as a notice when zero stock is omitted.
  const hiddenSupplyIssue = supplyRows.some((row) => row.isZero && (row.isUnknown || !/^¥0(?:\.0+)?$/.test(row.amount)));
  const benefitSources = quote ? personalBenefitSources(quote) : null;
  const depositCents = (value: PriceQuote["baseTenantDeposit"]): bigint | null =>
    value?.unit === "yuan" && value.scale === 2 && moneyText(value) !== "—"
      ? BigInt(value.amount.replace(".", "")) : null;
  const baseCents = quote ? depositCents(quote.baseTenantDeposit) : null;
  const actualCents = quote ? depositCents(quote.quote.tenantDeposit ?? null) : null;
  const hasDepositReduction = baseCents !== null && actualCents !== null && baseCents > actualCents;
  // A tier or selected policy identifies the price source, not a monetary saving.
  const hasAppliedBenefitSource = Boolean(
    (quote?.membershipBenefits?.effectiveTier && quote.membershipBenefits.effectiveTier !== "STANDARD") ||
    (quote && "customerTier" in quote && quote.customerTier && quote.customerTier !== "STANDARD") ||
    (quote?.membershipBenefits?.priceSource && quote.membershipBenefits.priceSource !== "GROWTH") ||
    (quote?.membershipBenefits?.depositSource && quote.membershipBenefits.depositSource !== "GROWTH")
  );

  return (
    <div ref={summaryRef} className="rental-price-summary" data-personal={Boolean(quote)}>
      <div className="account-quote-head">
        <span className="account-quote-mark" aria-hidden="true"><Coins size={19} /></span>
        <div className="account-quote-heading">
          <div className="account-quote-title-row">
            <h2>租用报价</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="account-price-help" aria-label="查看报价费用说明">
                  <CircleHelp size={15} aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{noteDetail}</TooltipContent>
            </Tooltip>
          </div>
          <p className="account-quote-status">{quote ? `个人报价${tier ? ` · ${tier}` : ""}` : pendingLabel ?? "公开参考 · 押金另核"}</p>
        </div>
        <Image className="account-quote-header-art" src="/art/quote/rental-quote-v1.png" width={132} height={88} sizes="132px" alt="" aria-hidden="true" />
      </div>

      {hasItemizedLines ? (
        <div className="account-quote-bill">
          <span className="sr-only account-quote-bill-tag">{billTag}</span>

          {/* 第一组：哈夫币租金 (Haff Coin Rent) */}
          {haffRow ? (
            <div className="account-bill-section account-bill-section--haff">
              <div className="account-bill-section-head">
                <h3 className="account-bill-section-title">哈夫币租金</h3>
                {haffRow.ratioTag ? (
                  <span
                    className="account-haff-ratio-badge"
                    title="发布版基础客价（已含平台价差，未计会员优惠）"
                  >
                    {haffRow.ratioTag}
                  </span>
                ) : null}
              </div>
              <ul className="account-quote-bill-list" role="list" aria-label="哈夫币租金">
                <li
                  key={haffRow.key}
                  className={`account-quote-bill-row account-quote-bill-row--haff${haffRow.isZero ? " account-quote-bill-row--zero" : ""}${haffRow.isUnknown ? " account-quote-bill-row--unknown" : ""}`}
                  data-zero={haffRow.isZero ? "true" : undefined}
                  data-unknown={haffRow.isUnknown ? "true" : undefined}
                >
                  <div className="account-quote-bill-item">
                    <span className="account-quote-bill-name">{haffRow.name}</span>
                  </div>
                  <span className="account-quote-bill-spec">{haffRow.spec}</span>
                  <span className="account-quote-bill-amount">{haffRow.amount}</span>
                </li>
              </ul>
            </div>
          ) : null}

          {/* 第二组：物资预付 (Supplies Prepayment) */}
          {supplyRows.length > 0 ? (
            <div className="account-bill-section account-bill-section--supplies">
              <div className="account-bill-section-head">
                <h3 className="account-bill-section-title">物资预付</h3>
                <span className="account-bill-section-note">按实际消耗结算</span>
              </div>
              <ul className="account-quote-bill-list" role="list" aria-label="物资预付列表">
                {visibleSupplies.map((row) => (
                  <li
                    key={row.key}
                    className={`account-quote-bill-row${row.isZero ? " account-quote-bill-row--zero" : ""}${row.isUnknown ? " account-quote-bill-row--unknown" : ""}`}
                    data-zero={row.isZero ? "true" : undefined}
                    data-unknown={row.isUnknown ? "true" : undefined}
                  >
                    <div className="account-quote-bill-item">
                      <span className="account-quote-bill-name">{row.name}</span>
                    </div>
                    <span className="account-quote-bill-spec">{row.spec}</span>
                    <span className="account-quote-bill-amount">{row.amount}</span>
                  </li>
                ))}
              </ul>
              {!visibleSupplies.length && !hiddenSupplyIssue ? <p className="account-quote-bill-empty">暂无附带物资</p> : null}
              {hiddenSupplyIssue ? <p className="account-bill-notice" role="status">部分物资费用信息不完整或与库存不一致，请核对后再租用。</p> : null}
              <div className="account-quote-bill-subtotal">
                <span>物资预付小计</span>
                <strong>{suppliesSubtotal}</strong>
              </div>
            </div>
          ) : null}

          {benefitSources && (hasAppliedBenefitSource || hasDepositReduction) ? (
            <div className="account-quote-benefits" data-savings={hasDepositReduction}>
              {hasDepositReduction ? <Gift size={18} aria-hidden="true" /> : null}
              <div><strong>{hasDepositReduction ? "本次押金减免" : "本次计价来源"}</strong><p>{benefitSources}</p></div>
            </div>
          ) : null}

          {billRows.length === 0 ? (
            <p className="account-quote-bill-empty">个人报价明细未提供，以核定总额为准</p>
          ) : null}

          {/* 第三组：租客押金 (Tenant Deposit) */}
          <div className="account-bill-section account-bill-section--deposit">
            <div className="account-bill-section-head">
              <h3 className="account-bill-section-title"><ShieldCheck size={17} aria-hidden="true" />押金说明</h3>
              {waived ? <span className="rental-waiver-label">本次免押</span> : null}
            </div>
            <dl className="account-fee-lines">
              <div className={waived ? "rental-deposit rental-deposit--waived" : "rental-deposit"}>
                <dt>
                  <span>租客押金</span>
                </dt>
                <dd>
                  {waived && baseDeposit !== "—" && baseDeposit !== "¥0.00" ? (
                    <del aria-label={`原租客押金 ${baseDeposit}`}>{baseDeposit}</del>
                  ) : null}
                  <span>{deposit}</span>
                </dd>
              </div>
            </dl>
            <p className="account-deposit-hint">退租结算后，按约退还。</p>
          </div>
        </div>
      ) : null}

      {!hasItemizedLines ? (
        <dl className="account-fee-lines">
          <div>
            <dt>
              <Coins size={16} aria-hidden="true" />
              {quote ? "哈夫币租金" : "参考哈夫币租金"}
            </dt>
            <dd>{fees?.haff ?? "待确认"}</dd>
          </div>
          <div>
            <dt>
              <Package size={16} aria-hidden="true" />
              {quote ? "物资预付" : "参考物资预付"}
            </dt>
            <dd>{fees?.items ?? "待确认"}</dd>
          </div>
          <div className={waived ? "rental-deposit rental-deposit--waived" : "rental-deposit"}>
            <dt>
              <ShieldCheck size={16} aria-hidden="true" />租客押金
            </dt>
            <dd>
              {waived && baseDeposit !== "—" && baseDeposit !== "¥0.00" ? (
                <del aria-label={`原租客押金 ${baseDeposit}`}>{baseDeposit}</del>
              ) : null}
              <span>{deposit}</span>
              {waived ? <span className="rental-waiver-label">本次免押</span> : null}
            </dd>
          </div>
        </dl>
      ) : null}

      {/* 第四部分：三段之后总额强调，紧邻主动作 */}
      <div className="account-quote-total-section">
        <div className="account-quote-total-head">
          <span className="account-quote-total-label">{quote ? "本次预付" : "参考资源费"}</span>
          {!quote ? <span className="account-quote-total-note">不含个人押金</span> : null}
          {waived ? <span className="rental-waiver-label">本次免押</span> : null}
        </div>
        <p className="account-reference-price" aria-live="polite">
          {total}
        </p>
      </div>

      {quote || pendingLabel ? <p className="account-price-note">
        <Info size={15} aria-hidden="true" />
        <span>{note}</span>
      </p> : null}
    </div>
  );
}
