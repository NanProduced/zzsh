import type { ReactNode } from "react";

import { ChevronDown } from "lucide-react";
import { BEIJING_TIME_ZONE } from "../../workspace/beijing-time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  attributeFacts,
  feeSummaryRows,
  formatAmount,
  formatFundingCents,
  formatTermDays,
  inventoryRows,
  historicalAttributeFacts,
  historicalReadSummary,
  historicalResourceText,
  isHistorical,
  mediaCanQuarantine,
  mediaCanRestore,
  mediaContentUrl,
  mediaEligibleLabel,
  mediaPurposeLabel,
  mediaReadableLabel,
  mediaReviewLabel,
  publicationSourceLabel,
  quantityText,
  quoteLineFacts,
  publicBasisVersion,
  reviewStateLabel,
  skinFacts,
  entitlementTermText,
  type Detail,
  type LegacyHistoricalRead,
  type MediaBinding,
  type PublicBasis,
  type QueueItem,
  type ZoomTarget,
} from "./model";

const displayTime = (value: string | null | undefined) => !value || !Number.isFinite(Date.parse(value)) ? "时间未提供" : new Intl.DateTimeFormat("zh-CN", { timeZone: BEIJING_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

function CatalogSkinImage({ mediaId }: { mediaId: string | null }) {
  if (!mediaId) return null;
  return <span className="mt-1 block"><img src={`/api/v1/supply/media/${mediaId}/content`} alt="" className="h-16 w-16 rounded border border-border object-contain" loading="lazy" /><span className="block text-xs text-muted-foreground">目录参考图，不是持有证明</span></span>;
}

function SkinList({ version }: { version: Detail["version"] }) {
  const skins = skinFacts(version);
  if (!skins.rows.length) return <p className="text-sm text-muted-foreground">{skins.source === "CURRENT_DRAFT_SELECTION" ? "当前草稿没有已选皮肤。" : version.declaration.skins.length ? "皮肤名称或归属尚未核齐" : "未申报皮肤"}{skins.withheld ? `另有 ${skins.withheld} 项未准入，不显示名称。` : ""}</p>;
  return <ul className="space-y-1 text-sm">{skins.source === "CURRENT_DRAFT_SELECTION" ? <li className="text-xs text-muted-foreground">未发布修改中的当前选择{skins.withheld ? `；另有 ${skins.withheld} 项未准入，不显示名称` : ""}</li> : null}{skins.rows.map(skin => <li key={skin.id}>{skin.text}<CatalogSkinImage mediaId={skin.mediaId} /></li>)}</ul>;
}

/** Same detail helpers as the archive. Draft fields are not consulted. */
export function PublicBasisView({ basis }: { basis: PublicBasis }) {
  const version = publicBasisVersion(basis);
  const skins = skinFacts(version);
  const payout = basis.fullPayoutSelected;
  const ratio = basis.quote?.baseRenterHaffRatioWanPerYuan;
  let fees = feeSummaryRows(basis.feeSummary);
  if (!basis.feeSummary?.resourceTotal && basis.quote?.resourceTotal?.amount) fees = { ...fees, total: `¥${formatAmount(basis.quote.resourceTotal.amount)}` };
  const declared = basis.attributes?.owner_deposit_declaration as Record<string, unknown> | undefined;
  const depositText = basis.baseDeposit ? formatFundingCents(basis.baseDeposit.amountCents)
    : declared?.schema === "owner-deposit-declaration-v1" && typeof declared.amountCents === "string" ? formatFundingCents(declared.amountCents) : "未提供";
  const termSeconds = basis.quote?.termSeconds;
  return <section className="mb-4 space-y-3 rounded-lg border border-border p-4" aria-label="租客当前看到的版本"><h2 className="text-base font-semibold">租客当前看到的版本</h2><p className="text-sm text-muted-foreground">版本 {basis.id} · 摘要 {basis.contentHash ?? "未提供"} · 规则 {basis.releaseId ?? "未提供"}。这一版不混入当前草稿。</p><p className="text-sm">{version.declaration.title || "标题未提供"}</p><p className="whitespace-pre-wrap text-sm">{version.declaration.description || "说明未提供"}</p><dl className="grid grid-cols-2 gap-3 text-sm">{attributeFacts(version).map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd>{fact.value}</dd></div>)}<div><dt className="text-xs text-muted-foreground">发布时间</dt><dd>{basis.publishedAt ? displayTime(basis.publishedAt) : "发布时间未提供"}</dd></div><div><dt className="text-xs text-muted-foreground">哈夫币租金</dt><dd className="tabular-nums">{fees.haff}</dd></div><div><dt className="text-xs text-muted-foreground">物资费</dt><dd className="tabular-nums">{fees.materials}</dd></div><div><dt className="text-xs text-muted-foreground">资源费合计</dt><dd className="tabular-nums">{fees.total}</dd></div><div><dt className="text-xs text-muted-foreground">租客基础押金（号主申报）</dt><dd className="tabular-nums">{depositText}</dd></div><div><dt className="text-xs text-muted-foreground">租期规则</dt><dd>{basis.termOption?.displayName ?? "未提供"}</dd></div><div><dt className="text-xs text-muted-foreground">每日消耗</dt><dd className="tabular-nums">{basis.termOption?.dailyConsumption?.quantity ? quantityText(basis.termOption.dailyConsumption.quantity) : "未提供"}</dd></div><div><dt className="text-xs text-muted-foreground">资料租期（冻结原值）</dt><dd>{termSeconds ? formatTermDays(termSeconds) : "未提供"}</dd></div><div><dt className="text-xs text-muted-foreground">全额包赔</dt><dd>{payout === true ? "已选" : payout === false ? "未选" : "未申报"}</dd></div><div><dt className="text-xs text-muted-foreground">对外报价</dt><dd>{version.quote ? `¥${version.quote.resourceTotal.amount}` : "报价未提供"}</dd></div><div><dt className="text-xs text-muted-foreground">基础客价比例</dt><dd>{ratio ? `${ratio} 万哈夫币/元` : "未提供"}</dd></div><div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">费用口径</dt><dd className="text-xs">{fees.note}</dd></div></dl><ul className="text-sm">{inventoryRows(version, null).map(row => <li key={row.itemId}>{row.name} · {row.current} {row.unit}</li>)}</ul>{quoteLineFacts(version).length ? <ul className="space-y-1 text-xs text-muted-foreground">{quoteLineFacts(version).map(line => <li key={line.itemId}>{line.name} · 计价基数 {line.unitQuantity ?? "未提供"} · 参考单价 {line.buyerUnitAmount ? `¥${formatAmount(line.buyerUnitAmount)}` : "未提供"}{line.amount ? ` · 原行金额 ¥${formatAmount(line.amount)}` : ""}</li>)}</ul> : null}{version.declaration.entitlements.map(item => <p key={item.entitlementId} className="text-sm">{version.presentation.entitlements?.find(entry => entry.id === item.entitlementId)?.name ?? "权益名称未提供"} · {entitlementTermText(item)}</p>)}{basis.media.length ? <ul className="grid gap-2 sm:grid-cols-3">{basis.media.map((item, index) => <li key={item.assetId ?? index}>{item.url ? <img src={item.url} alt={item.category === "PENALTY" ? "处罚公示" : "账号展示图"} className="aspect-[4/3] w-full rounded border border-border object-contain" loading="lazy" /> : <span>图片地址未提供</span>}<span className="block text-xs text-muted-foreground">{item.category === "PENALTY" ? "处罚公示" : "账号展示图"}</span></li>)}</ul> : <p className="text-sm">这次公开读取没有展示图。</p>}<ul className="space-y-1 text-sm">{skins.rows.length ? skins.rows.map(skin => <li key={skin.id}>{skin.text}<CatalogSkinImage mediaId={skin.mediaId} /></li>) : <li>这次公开读取没有皮肤。</li>}</ul></section>;
}

function StateBadge({ state }: { state: string }) {
  const variant = state === "SUBMITTED" || state === "IMPORTED_UNVERIFIED" ? "warning" : state === "REJECTED" ? "destructive" : "secondary";
  return <Badge variant={variant}>{reviewStateLabel(state)}</Badge>;
}

/** 完整账号资料：图片、属性、资产、费用、权益、历史与记录在一页分区呈现，不再嵌套第二层档案 tab。 */
export function AccountCompleteView({
  detail, version, historicalRead, canReviewMedia, busy, reasonReady, onZoom, onQuarantine, onRestore,
  onSelectVersion, versionId, actions, entryNote, onRefresh, refreshing,
}: {
  detail: Omit<Detail, "version">;
  version: Detail["version"];
  historicalRead?: LegacyHistoricalRead | null;
  canReviewMedia: boolean;
  busy: boolean;
  reasonReady: boolean;
  onZoom: (target: ZoomTarget, trigger?: HTMLElement) => void;
  onQuarantine: (assetId: string) => void;
  onRestore: (assetId: string) => void;
  onSelectVersion: (versionId: string | null) => void;
  versionId: string | null;
  actions?: ReactNode;
  entryNote?: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const historical = isHistorical(detail);
  const media = version.declaration.mediaBindings;
  const publication = version.publication;
  const quote = version.quote;
  const lines = quoteLineFacts(version);
  let fees = feeSummaryRows(version.feeSummary);
  if (!version.feeSummary?.resourceTotal && quote?.resourceTotal?.amount) fees = { ...fees, total: `¥${formatAmount(quote.resourceTotal.amount)}` };
  const deposit = version.declaration.attributes.owner_deposit_declaration as Record<string, unknown> | undefined;
  const depositText = deposit?.schema === "owner-deposit-declaration-v1" && typeof deposit.amountCents === "string" && /^(0|[1-9]\d*)$/.test(deposit.amountCents) ? formatFundingCents(deposit.amountCents) : "未申报";
  const payout = version.declaration.attributes.full_payout_declaration as Record<string, unknown> | undefined;
  const payoutText = payout?.selected === true ? "已选" : payout?.selected === false ? "未选" : "未申报";
  return <div className="supervision-detail-body min-w-0 space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="break-words text-lg font-semibold">完整账号资料</h2>
        {entryNote ? <p className="mt-1 text-sm text-muted-foreground">{entryNote}</p> : null}
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{version.sequence ? `第 ${version.sequence} 版` : "资料版本未提供"}</span>
          <StateBadge state={version.reviewState} />
        </p>
      </div>
      <div className="flex flex-wrap gap-2">{actions}<Button variant="outline" size="sm" onClick={onRefresh} aria-busy={refreshing || undefined} disabled={refreshing}>{refreshing ? "读取中…" : "刷新详情"}</Button></div>
    </header>
    {historical ? <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-soft-warning px-3 py-2 text-xs text-warning"><span>正在查看历史版本（只读），处置只对当前版本开放。</span><Button size="sm" variant="outline" onClick={() => onSelectVersion(null)}>回到当前资料</Button></div> : null}


    <Section title="申报属性" aside={<span className="text-xs text-muted-foreground">基本资料与使用条件 · 未申报不按否处理</span>}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">{attributeFacts(version).map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className={fact.unconfirmed ? "text-warning" : ""}>{fact.value}</dd></div>)}</dl>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{version.declaration.description || "未填写补充说明"}</p>
    </Section>

    <Section title="账号资产" aside={<span className="text-xs text-muted-foreground">本版全部申报物资、皮肤与权益</span>}>
      <div className="overflow-x-auto"><Table className="w-full text-left text-sm"><TableHeader className="bg-surface-raised"><TableRow><TableHead className="px-4 py-2.5 font-medium">物品</TableHead><TableHead className="px-4 py-2.5 font-medium">计价单位</TableHead><TableHead className="px-4 py-2.5 text-right font-medium">申报数量</TableHead></TableRow></TableHeader><TableBody>{inventoryRows(version, null).map(row => <TableRow key={row.itemId} className="border-t border-border"><TableCell className="px-4 py-2.5 whitespace-normal">{row.name}</TableCell><TableCell className="px-4 py-2.5 text-muted-foreground">{row.unit}</TableCell><TableCell className="px-4 py-2.5 text-right tabular-nums">{row.current}</TableCell></TableRow>)}{!version.declaration.inventory.length ? <TableRow><TableCell colSpan={3} className="px-4 py-3 text-muted-foreground">本版未申报物资；不代表账号没有资源。</TableCell></TableRow> : null}</TableBody></Table></div>
      <SkinList version={version}/>
      {version.declaration.entitlements.length ? <ul className="space-y-1.5 text-sm">{version.declaration.entitlements.map(item => <li key={item.entitlementId}>{version.presentation.entitlements?.find(entry => entry.id === item.entitlementId)?.name ?? "权益名称未提供"} · {item.value === true ? "已声明持有" : item.value === false ? "未持有" : String(item.value ?? "未知")} · {entitlementTermText(item)}</li>)}</ul> : null}
    </Section>

    <Section title="费用与租期" aside={<span className="text-xs text-muted-foreground">本版保存值，非当前规则重算或下单应付</span>}>
      <dl className="grid gap-x-8 gap-y-3 rounded-lg border border-border bg-card px-4 py-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">哈夫币租金</dt><dd className="mt-0.5 tabular-nums">{fees.haff}</dd></div>
        <div><dt className="text-xs text-muted-foreground">物资费</dt><dd className="mt-0.5 tabular-nums">{fees.materials}</dd></div>
        <div><dt className="text-xs text-muted-foreground">资源费合计（资料版冻结参考）</dt><dd className="mt-0.5 text-base font-semibold tabular-nums">{fees.total}</dd></div>
        <div><dt className="text-xs text-muted-foreground">租期规则</dt><dd className="mt-0.5">{version.termOption?.displayName ?? "未提供"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">每日消耗</dt><dd className="mt-0.5 tabular-nums">{version.termOption?.dailyConsumption?.quantity ? quantityText(version.termOption.dailyConsumption.quantity) : "未提供"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">资料租期（冻结原值）</dt><dd className="mt-0.5">{quote ? formatTermDays(quote.termSeconds) : "未提供"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">基础客价比例</dt><dd className="mt-0.5">{quote?.baseRenterHaffRatioWanPerYuan ? `${quote.baseRenterHaffRatioWanPerYuan} 万哈夫币/元` : "未提供"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">租客基础押金（号主申报）</dt><dd className="mt-0.5 tabular-nums">{depositText}</dd></div>
        <div><dt className="text-xs text-muted-foreground">全额包赔</dt><dd className="mt-0.5">{payoutText}</dd></div>
        <div><dt className="text-xs text-muted-foreground">发布事实</dt><dd className="mt-0.5">{publication ? `${publicationSourceLabel(publication.source)} · ${displayTime(publication.publishedAt)}` : "无发布记录"}</dd></div>
      </dl>
      {lines.length ? <div className="overflow-x-auto"><Table className="w-full text-left text-sm"><TableHeader className="bg-surface-raised"><TableRow><TableHead className="px-4 py-2.5 font-medium">报价行</TableHead><TableHead className="px-4 py-2.5 font-medium">数量</TableHead><TableHead className="px-4 py-2.5 font-medium">计价基数</TableHead><TableHead className="px-4 py-2.5 font-medium">参考单价</TableHead><TableHead className="px-4 py-2.5 text-right font-medium">原行金额</TableHead></TableRow></TableHeader><TableBody>{lines.map(line => <TableRow key={line.itemId} className="border-t border-border"><TableCell className="px-4 py-2.5 whitespace-normal">{line.name}</TableCell><TableCell className="px-4 py-2.5 tabular-nums">{line.quantity}</TableCell><TableCell className="px-4 py-2.5 tabular-nums">{line.unitQuantity ?? "未提供"}</TableCell><TableCell className="px-4 py-2.5 tabular-nums">{line.buyerUnitAmount ? `¥${formatAmount(line.buyerUnitAmount)}` : "未提供"}</TableCell><TableCell className="px-4 py-2.5 text-right tabular-nums">{line.amount ? `¥${formatAmount(line.amount)}` : "未提供"}</TableCell></TableRow>)}</TableBody></Table></div> : <p className="text-sm text-muted-foreground">本版没有可读报价行；不从当前价目补算。</p>}
      <p className="text-xs text-muted-foreground">{fees.note}。金额为资料版本冻结参考；租客档位与会员个性化减免不在本页推断，真实应付以原订单冻结价为准。</p>
    </Section>

    <Section title="账号图片" aside={<span className="text-xs text-muted-foreground">展示图与私有凭证分区；目录图不是持有证明</span>}>
      {media.length ? <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{media.map((binding, index) => <MediaCard key={binding.assetId} binding={binding} index={index} total={media.length} canReviewMedia={canReviewMedia} readOnly={historical} busy={busy} reasonReady={reasonReady} onZoom={onZoom} onQuarantine={onQuarantine} onRestore={onRestore}/>)}</div> : <p className="text-sm text-muted-foreground">本版本未绑定图片；不能据此认定账号没有图片。</p>}
    </Section>

    <Collapsible className="border-t pt-4"><CollapsibleTrigger className="group flex w-full items-center justify-between text-sm font-semibold">版本依据<ChevronDown className="size-3.5"/></CollapsibleTrigger><CollapsibleContent className="pt-2 text-xs text-muted-foreground"><dl className="grid gap-2 break-all"><div><dt>资料版本</dt><dd>{version.id}</dd></div><div><dt>资料摘要</dt><dd>{version.contentHash ?? "未提供"}</dd></div><div><dt>规则版本</dt><dd>{version.releaseId ?? "未提供"}</dd></div></dl></CollapsibleContent></Collapsible>

    {historicalRead ? <Collapsible className="border-t pt-4"><CollapsibleTrigger className="group flex w-full items-center justify-between rounded-sm text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">历史来源资料（仅参考，不覆盖当前资料）<span aria-hidden="true" className="text-muted-foreground transition-transform group-data-[panel-open]:rotate-90">›</span></CollapsibleTrigger><CollapsibleContent className="pt-2"><p className="text-sm text-muted-foreground">{historicalReadSummary(historicalRead)}</p>{historicalRead.display?.state === "KNOWN" && historicalRead.display.facts?.attributes && Array.isArray(historicalRead.display.facts.resources) ? <><dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{historicalAttributeFacts(historicalRead).map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl><ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">{historicalRead.display.facts.resources.map(resource => <li key={resource.code}>{resource.name}：{historicalResourceText(resource)}</li>)}</ul></> : <p className="mt-2 text-sm text-muted-foreground">历史扩展资料尚待接入，未提供的数量不能按零处理。</p>}<p className="mt-2 text-sm">历史租金 {historicalRead.historicalQuote.haffRentYuan} 元 · 历史物资金额 {historicalRead.historicalQuote.goodsYuan} 元 · 历史押金 {historicalRead.historicalQuote.depositYuan} 元</p><p className="mt-1 text-xs text-muted-foreground">来源记录，不是当前报价、余额、保证金到账或退款结果。</p></CollapsibleContent></Collapsible> : null}

    <Collapsible className="border-t pt-4"><CollapsibleTrigger className="group flex w-full items-center justify-between rounded-sm text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">历史版本与审核记录<ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"/></CollapsibleTrigger><CollapsibleContent className="pt-2">
      {detail.history?.length ? <div className="flex flex-wrap gap-1.5">{detail.history.map(entry => <Button key={entry.id} variant="ghost" type="button" aria-pressed={versionId === entry.id} onClick={() => onSelectVersion(entry.id)} className={`rounded-full border px-2.5 py-1 text-xs ${versionId === entry.id ? "border-foreground bg-foreground font-medium text-background" : "border-border bg-surface-raised text-muted-foreground hover:text-foreground"}`}>第 {entry.sequence} 版 · {reviewStateLabel(entry.review_state)}</Button>)}</div> : <p className="text-sm text-muted-foreground">没有更早的资料版本记录。</p>}
      {detail.decisions.length ? <ol className="mt-3 space-y-3">{detail.decisions.map(decision => <li key={decision.id} className="text-sm"><p className="font-medium">{decision.decision === "APPROVE" ? "通过（历史人工审核）" : "退回"} · {decision.reviewer_name}</p><p className="text-xs text-muted-foreground">{displayTime(decision.decided_at)}</p><p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{decision.reason}</p></li>)}</ol> : <p className="mt-2 text-sm text-muted-foreground">{version.reviewState === "PUBLISHED" ? "直发账号无人工预审记录。" : "尚无审核决定。"}</p>}
    </CollapsibleContent></Collapsible>
  </div>;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function MediaCard({
  binding,
  index,
  total,
  canReviewMedia,
  readOnly,
  busy,
  reasonReady,
  onZoom,
  onQuarantine,
  onRestore,
}: {
  binding: MediaBinding;
  index: number;
  total: number;
  canReviewMedia: boolean;
  readOnly: boolean;
  busy: boolean;
  reasonReady: boolean;
  onZoom: (target: ZoomTarget, trigger?: HTMLElement) => void;
  onQuarantine: (assetId: string) => void;
  onRestore: (assetId: string) => void;
}) {
  const evidence = binding.purpose !== "ACCOUNT_DISPLAY";
  const label = mediaPurposeLabel(binding) + (binding.category === "PENALTY" ? " · 处罚公示" : binding.category === "SHOWCASE" ? " · 展示" : "");
  const caption = evidence ? `${label} · 仅审核可见,始终不公开` : label;
  const quarantined = binding.reviewState === "QUARANTINED";
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-card">
      <Button variant="ghost"
        type="button"
        aria-label={`放大核对 ${caption} ${index + 1}`}
        className="block h-auto w-full rounded-none p-0 focus-visible:ring-inset"
        onClick={event =>
          onZoom({
            src: mediaContentUrl(binding.assetId),
            alt: `${caption} ${index + 1}`,
            caption: `${caption} · ${index + 1} / ${total}`,
          }, event.currentTarget)
        }
      >
        <img
          src={mediaContentUrl(binding.assetId)}
          alt={`${caption} ${index + 1}`}
          loading="lazy"
          className="aspect-[4/3] w-full bg-surface-raised object-contain"
        />
      </Button>
      <figcaption className="space-y-1.5 px-2.5 py-1.5 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={evidence ? "text-warning" : ""}>{caption} · {index + 1}</span>
          <span className="text-foreground">放大核对</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={quarantined ? "destructive" : "secondary"}>
            {mediaReviewLabel(binding)}
          </Badge>
          <Badge variant="outline">{mediaEligibleLabel(binding)}</Badge>
          <Badge variant="outline">{mediaReadableLabel(binding)}</Badge>
        </div>
        {!evidence && canReviewMedia && !readOnly && (mediaCanQuarantine(binding) || mediaCanRestore(binding)) ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {mediaCanQuarantine(binding) ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                title="填写原因并确认后才会隔离"
                onClick={() => onQuarantine(binding.assetId)}
              >
                隔离展示图…
              </Button>
            ) : null}
            {mediaCanRestore(binding) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                title="填写原因并确认恢复，技术资格由服务端核验"
                onClick={() => onRestore(binding.assetId)}
              >
                恢复展示…
              </Button>
            ) : null}
          </div>
        ) : null}
        {!evidence && canReviewMedia && !readOnly && quarantined ? (
          <p className="text-xs">恢复前提为技术就绪;不满足时服务端会返回明确错误,需重新上传校验。</p>
        ) : null}
      </figcaption>
    </figure>
  );
}
