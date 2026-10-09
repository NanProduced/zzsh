import { CircleHelp, Coins, Info, Package, ShieldCheck } from "lucide-react";
import type { PersonalRentalQuote } from "@/lib/order-client";
import { moneyText } from "@/lib/order-display";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type ReferenceFees = { total: string; haff: string; items: string };

/** Display sums of the API's rounded buyer lines, never a price calculation. */
export function personalFeeLines(quote: PersonalRentalQuote): { haff: string; items: string } | null {
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

export function RentalPriceSummary({ reference, quote, pendingLabel }: { reference: ReferenceFees; quote: PersonalRentalQuote | null; pendingLabel?: string }) {
  const fees = quote ? personalFeeLines(quote) : reference;
  const deposit = quote ? moneyText(quote.quote.tenantDeposit) : "另行核对";
  const waived = Boolean(quote?.depositWaived && deposit === "¥0.00");
  const baseDeposit = quote ? moneyText(quote.baseTenantDeposit) : "—";
  const tier = quote ? ({ STANDARD: "普通会员", VIP: "VIP会员", SVIP: "SVIP会员", DISCOUNT_USER: "特惠用户" } as Record<string, string>)[quote.customerTier] : null;
  const total = quote ? moneyText(quote.quote.tenantPayableTotal) : pendingLabel ? "—" : reference.total;
  const note = quote ? "已按个人有效报价核定" : pendingLabel ? "个人报价待确认" : "公开参考费用";
  const noteDetail = quote
    ? "本次应付来自当前身份的有效报价，已包含租客押金；物资先预付，最终按适用条款结算。"
    : pendingLabel
      ? "公开金额暂不能替代个人报价；登录并确认后读取会员价格、押金和适用条款。"
      : "公开参考费用来自当前发布资源费用，不含个人押金；最终价格按当前身份与生效规则确认。";
  return <div className="rental-price-summary" data-personal={Boolean(quote)}>
    <div className="account-quote-head"><h2><Coins size={20} aria-hidden="true" />{quote ? "本次应付" : pendingLabel ?? "公开参考费用"}
      <Tooltip><TooltipTrigger asChild><button type="button" className="account-price-help" aria-label="查看报价费用说明"><CircleHelp size={16} aria-hidden="true" /></button></TooltipTrigger><TooltipContent side="bottom">{quote ? "本次应付使用本人的有效报价，已包含租客押金。物资先预付，最终按实际消耗与适用条款结算。" : "公开参考费用只包含普通租客档的资源费用，不含本人押金。会员或礼遇的适用价格由个人核价确认。"}</TooltipContent></Tooltip>
    </h2>
      {tier ? <span className="rental-member-label">当前租客 · {tier}</span> : null}
    </div>
    <p className="account-reference-price" aria-live="polite">{total}</p>
    {waived ? <p className="rental-benefit-summary"><ShieldCheck size={15} aria-hidden="true" />本次免租客押金</p> : null}
    <dl className="account-fee-lines">
      <div><dt><Coins size={16} aria-hidden="true" />{quote ? "哈夫币租金" : "参考哈夫币租金"}</dt><dd>{fees?.haff ?? "待确认"}</dd></div>
      <div><dt><Package size={16} aria-hidden="true" />{quote ? "物资预付" : "参考物资预付"}</dt><dd>{fees?.items ?? "待确认"}</dd></div>
      <div className={waived ? "rental-deposit rental-deposit--waived" : "rental-deposit"}><dt><ShieldCheck size={16} aria-hidden="true" />租客押金</dt><dd>
        {waived && baseDeposit !== "—" && baseDeposit !== "¥0.00" ? <del aria-label={`原租客押金 ${baseDeposit}`}>{baseDeposit}</del> : null}
        <span>{deposit}</span>{waived ? <span className="rental-waiver-label">本次免押</span> : null}
      </dd></div>
    </dl>
    <p className="account-price-note"><Info size={15} aria-hidden="true" /><span>{note}</span><Tooltip><TooltipTrigger asChild><button type="button" className="account-price-help" aria-label="查看金额说明"><CircleHelp size={15} aria-hidden="true" /></button></TooltipTrigger><TooltipContent side="bottom">{noteDetail}</TooltipContent></Tooltip></p>
  </div>;
}
