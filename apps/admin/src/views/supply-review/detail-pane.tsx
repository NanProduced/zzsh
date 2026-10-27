import { useState, type ReactNode } from "react";

import { ChevronDown } from "lucide-react";
import { useIsMobile } from "../../hooks/use-mobile";
import { BEIJING_TIME_ZONE } from "../../workspace/beijing-time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  attributeFacts,
  formatAmount,
  formatTermDays,
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
  resourceBillingRows,
  versionBaseFeeRows,
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
  return <span className="block shrink-0"><img src={`/api/v1/supply/media/${mediaId}/content`} alt="" className="size-10 rounded-md border border-border object-contain" loading="lazy" /></span>;
}

function SkinList({ version }: { version: Detail["version"] }) {
  const skins = skinFacts(version);
  if (!skins.rows.length) return <p className="text-sm text-muted-foreground">{skins.source === "CURRENT_DRAFT_SELECTION" ? "当前草稿没有已选皮肤。" : version.declaration.skins.length ? "皮肤名称或归属尚未核齐" : "未申报皮肤"}{skins.withheld ? `另有 ${skins.withheld} 项未准入，不显示名称。` : ""}</p>;
  return <div className="space-y-3"><ul data-skin-list className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-x-5 gap-y-2 text-sm">{skins.rows.map(skin => <li key={skin.id} className="flex min-w-0 items-center gap-2.5"><CatalogSkinImage mediaId={skin.mediaId}/><div className="min-w-0"><p className="break-words font-medium">{skin.name}</p><Badge variant={skin.rarity === "品质未知" ? "unknown" : "outline"} className="mt-1 h-auto whitespace-normal text-[11px]">{skin.rarity}</Badge></div></li>)}</ul><p className="text-xs text-muted-foreground">{skins.source === "CURRENT_DRAFT_SELECTION" ? "当前编辑资料中的选择；" : ""}目录图片用于辨认外观，不代替持有证明。{skins.withheld ? `另有 ${skins.withheld} 项资料待核。` : ""}</p></div>;
}

export function ResourceBillingTable({ version }: { version: Detail["version"] }) {
  const [showZero, setShowZero] = useState(false);
  const rows = resourceBillingRows(version), zeroCount = rows.filter(row => row.zero).length;
  const visible = showZero ? rows : rows.filter(row => !row.zero);
  const money = (value: string | null) => value === null ? "未提供" : `¥${formatAmount(value)}`;
  return <Section title="物资数量与计费" aside={zeroCount ? <Button size="sm" variant="ghost" aria-label={showZero ? "隐藏零数量项" : "显示零数量项"} aria-pressed={showZero} onClick={() => setShowZero(value => !value)}>{showZero ? "隐藏零数量项" : "显示零数量项"}（{zeroCount}）</Button> : undefined}>
    {visible.length ? <div className="overflow-x-auto" data-resource-billing><Table className="text-xs [&_tr]:border-border"><TableHeader><TableRow><TableHead>物资</TableHead><TableHead className="text-right">数量</TableHead><TableHead>单位</TableHead><TableHead className="text-right">计价基数</TableHead><TableHead className="text-right">单价</TableHead><TableHead className="text-right">行额</TableHead></TableRow></TableHeader><TableBody>{visible.map(row => <TableRow key={row.itemId}><TableCell className="min-w-24 whitespace-normal font-medium">{row.name}{row.quantityNote ? <span className="mt-1 block text-[11px] font-normal text-amber-900 dark:text-amber-300">{row.quantityNote}</span> : null}</TableCell><TableCell className="text-right tabular-nums">{row.quantity}</TableCell><TableCell className="text-muted-foreground">{row.unit}</TableCell><TableCell className="text-right tabular-nums">{row.unitQuantity}</TableCell><TableCell className="text-right tabular-nums">{money(row.unitAmount)}</TableCell><TableCell className="text-right font-medium tabular-nums">{money(row.amount)}</TableCell></TableRow>)}</TableBody></Table></div> : <p className="text-sm text-muted-foreground">{zeroCount ? "已申报数量均为 0，可展开核对。" : "本版未提供物资数量与计费明细。"}</p>}
    <p className="text-xs leading-relaxed text-muted-foreground">计价基数按本行单位；未提供不按免费或零处理。{version.quote?.unitAmountsInformational ? "单价用于说明，行额以本版报价为准。" : ""}</p>
  </Section>;
}

/** Imported-only accounts retain their readable data without pretending to have a native quote or version. */
export function ImportedAccountView({ read }: { read: LegacyHistoricalRead }) {
  const [showZero, setShowZero] = useState(false);
  const source = read.display?.state === "KNOWN" ? read.display.facts : null;
  const resources = source?.resources ?? [], zero = resources.filter(item => item.quantity === "0").length;
  const visible = showZero ? resources : resources.filter(item => item.quantity !== "0");
  return <div className="space-y-6" data-imported-account>
    <div className="space-y-1 text-xs text-muted-foreground"><p>{historicalReadSummary(read)}</p>{source?.sourceUpdatedAt ? <p>来源更新：{displayTime(source.sourceUpdatedAt)}</p> : null}<p>原平台历史记录；不代表当前报价、下单应付或可租资格。</p></div>
    <Section title="账号资料" aside={<span className="text-xs text-muted-foreground">迁入时记录</span>}>
      {source ? <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">{historicalAttributeFacts(read).map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className="mt-1 font-medium">{fact.value}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">暂未提供详细资料。</p>}
    </Section>
    <Section title="资源数量" aside={zero ? <Button variant="ghost" size="sm" aria-label={showZero ? "隐藏零数量项" : "显示零数量项"} aria-pressed={showZero} onClick={() => setShowZero(value => !value)}>{showZero ? "隐藏零数量项" : "显示零数量项"}（{zero}）</Button> : undefined}>
      <ul className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">{visible.map(item => <li className="flex justify-between gap-4" key={item.code}><span className="text-muted-foreground">{item.name}</span><span className="font-medium tabular-nums">{historicalResourceText(item)}</span></li>)}</ul>
    </Section>
    <Section title="迁入时金额"><dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4"><div><dt className="text-xs text-muted-foreground">租金</dt><dd className="mt-1 tabular-nums">¥{formatAmount(read.historicalQuote.haffRentYuan)}</dd></div><div><dt className="text-xs text-muted-foreground">物资费</dt><dd className="mt-1 tabular-nums">¥{formatAmount(read.historicalQuote.goodsYuan)}</dd></div><div><dt className="text-xs text-muted-foreground">押金</dt><dd className="mt-1 tabular-nums">¥{formatAmount(read.historicalQuote.depositYuan)}</dd></div><div><dt className="text-xs text-muted-foreground">租期</dt><dd className="mt-1">{read.historicalQuote.termDays} 天</dd></div></dl><p className="text-xs text-muted-foreground">以上保留迁入时的记录；当前可租情况以上方业务状态为准。</p></Section>
  </div>;
}

/** Same detail helpers as the archive. Draft fields are not consulted. */
function AccountProfile({ version, depositCents, payoutText, media, assets, showManagement = true }: {
  version: Detail["version"]; depositCents?: string | null; payoutText: string; media: ReactNode; assets: ReactNode; showManagement?: boolean;
}) {
  const mobile = useIsMobile();
  const facts = attributeFacts(version);
  const named = [...(version.presentation.items ?? []), ...(version.catalogItems ?? [])];
  const haff = version.declaration.inventory.find(item => named.some(entry => entry.id === item.itemId && entry.unit === "HAFF_BASE") || version.quote?.lines?.some(line => line.itemId === item.itemId && line.unit === "HAFF_BASE"));
  const fees = versionBaseFeeRows(version, depositCents);
  const group = (labels: string[]) => {
    const selected = facts.filter(fact => labels.includes(fact.label));
    if (selected.every(fact => ["未提供", "未申报", "未确认", "未知", "来源未提供"].includes(fact.value))) return <p className="text-sm leading-relaxed text-muted-foreground">{selected.map(fact => fact.label).join("、")}：尚未提供。</p>;
    return <dl className="grid grid-cols-2 gap-x-5 gap-y-4 text-sm sm:grid-cols-3">{facts.filter(fact => labels.includes(fact.label)).map(fact => <div key={fact.label} className="min-w-0"><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className={"mt-1 break-words font-medium " + (["未提供", "未申报", "未确认", "未知"].includes(fact.value) ? "text-muted-foreground" : "text-foreground")}>{fact.value}</dd></div>)}</dl>;
  };
  const infoSource = version.management?.infoSource?.name ?? (typeof version.declaration.attributes.info_source === "string" ? version.declaration.attributes.info_source : null);
  const rentalAndDeclarations = <>
        <Section title="出租条件">
          {group(["登录方式", "上号时间", "每日消耗"])}
        </Section>
        <Section title="账号申报">
          {group(["下赛季通行证", "德穆兰", "本人脸声明", "封禁记录声明"])}
          {version.declaration.description ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{version.declaration.description}</p> : null}
        </Section>
  </>;
  return <>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]" data-account-profile>
      <div className="min-w-0 space-y-6">
        <Section title="游戏配置" aside={<span className="text-sm font-semibold tabular-nums text-amber-900 dark:text-amber-300">{haff ? quantityText(haff.quantity) : "哈夫币未提供"}</span>}>
          {group(["安全箱配置", "角色等级", "段位", "小段位", "体力等级", "负重等级", "潜水等级", "绝密 KD", "地区"])}
        </Section>
        {!mobile ? rentalAndDeclarations : null}
      </div>
      <aside className="space-y-4 rounded-xl border border-border bg-card p-5" aria-label="基础报价">
        <h3 className="text-sm font-semibold">基础报价</h3>
        <div><p className="text-xs text-muted-foreground">基础总价</p><p className="mt-1 text-2xl font-semibold tabular-nums text-sky-900 dark:text-sky-300">{fees.total}</p></div>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-muted-foreground">哈夫币租金</dt><dd className="tabular-nums">{fees.haff}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted-foreground">物资预付</dt><dd className="tabular-nums">{fees.materials}</dd></div>
          {fees.total === "未提供" || !fees.haff.startsWith("¥") || !fees.materials.startsWith("¥") ? <div className="flex justify-between gap-4"><dt className="text-muted-foreground">资源费合计</dt><dd className="tabular-nums">{fees.resources}</dd></div> : null}
          <div className="flex justify-between gap-4 border-t border-border pt-3"><dt className="text-muted-foreground">租客基础押金</dt><dd className="font-medium tabular-nums">{fees.deposit}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted-foreground">预计租期</dt><dd>{version.quote ? formatTermDays(version.quote.termSeconds) : "未提供"}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted-foreground">全额包赔</dt><dd>{payoutText}</dd></div>
          {version.quote?.baseRenterHaffRatioWanPerYuan ? <div className="flex justify-between gap-4"><dt className="text-muted-foreground">基础客价比例</dt><dd>{version.quote.baseRenterHaffRatioWanPerYuan} 万/元</dd></div> : null}
        </dl>
        <p className="text-xs leading-relaxed text-muted-foreground">基础总价含哈夫币租金、物资预付和基础押金；会员优惠及押金减免以租客本人报价为准。</p>
        {fees.note ? <p className="text-xs text-muted-foreground">{fees.note}</p> : null}
      </aside>
      {mobile ? <div className="min-w-0 space-y-6">{rentalAndDeclarations}</div> : null}
    </div>
    <ResourceBillingTable version={version}/>
    <Section title="皮肤与权益">{assets}</Section>
    <Section title="账号图片">{media}</Section>
    {showManagement && (version.management !== undefined || infoSource) ? <Section title="管理信息"><dl className="text-sm"><dt className="text-xs text-muted-foreground">了解渠道（内部）</dt><dd className="mt-1">{infoSource ?? "未提供"}</dd></dl></Section> : null}
  </>;
}

export function PublicBasisView({ basis, showManagement = true }: { basis: PublicBasis; showManagement?: boolean }) {
  const version = publicBasisVersion(basis);
  const payout = basis.fullPayoutSelected === true ? "已选" : basis.fullPayoutSelected === false ? "未选" : "未提供";
  return <section className="space-y-6" aria-label="租客当前看到的版本">
    <AccountProfile version={version} depositCents={basis.baseDeposit?.amountCents} payoutText={payout} showManagement={showManagement}
      assets={<><SkinList version={version}/>{version.declaration.entitlements.map(item => <p key={item.entitlementId} className="text-sm">{version.presentation.entitlements?.find(entry => entry.id === item.entitlementId)?.name ?? "权益名称未提供"} · {entitlementTermText(item)}</p>)}</>}
      media={basis.media.length ? <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{basis.media.map((item, index) => <li key={item.assetId ?? index}>{item.url ? <img src={item.url} alt={item.category === "PENALTY" ? "处罚公示" : "账号展示图"} className="aspect-[4/3] w-full rounded-lg border border-border object-contain" loading="lazy"/> : <span className="text-sm text-muted-foreground">图片暂不可读</span>}<p className="mt-1 text-xs text-muted-foreground">{item.category === "PENALTY" ? "处罚公示" : "账号展示图"}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">暂未提供可读图片。</p>}/>
    {showManagement ? <Collapsible className="border-t border-border pt-4"><CollapsibleTrigger className="group flex w-full items-center justify-between text-sm text-muted-foreground">资料版本与发布时间<ChevronDown className="size-3.5"/></CollapsibleTrigger><CollapsibleContent keepMounted className="pt-3 text-xs text-muted-foreground data-[closed]:hidden"><dl className="grid gap-2 break-all"><div><dt>原标题</dt><dd>{basis.title || "未填写"}</dd></div><div><dt>发布时间</dt><dd>{displayTime(basis.publishedAt)}</dd></div><div><dt>版本</dt><dd>{basis.id}</dd></div><div><dt>内容摘要</dt><dd>{basis.contentHash ?? "未提供"}</dd></div><div><dt>规则</dt><dd>{basis.releaseId ?? "未提供"}</dd></div></dl></CollapsibleContent></Collapsible> : null}
  </section>;
}

function StateBadge({ state }: { state: string }) {
  const variant = state === "SUBMITTED" || state === "IMPORTED_UNVERIFIED" ? "warning" : state === "REJECTED" ? "destructive" : "secondary";
  return <Badge variant={variant}>{reviewStateLabel(state)}</Badge>;
}

/** 完整账号资料：图片、属性、资产、费用、权益、历史与记录在一页分区呈现，不再嵌套第二层档案 tab。 */
export function AccountCompleteView({
  detail, version, canReviewMedia, busy, reasonReady, onZoom, onQuarantine, onRestore,
  onSelectVersion, versionId, actions, entryNote, showManagement = true,
}: {
  detail: Omit<Detail, "version">; version: Detail["version"]; historicalRead?: LegacyHistoricalRead | null;
  canReviewMedia: boolean; busy: boolean; reasonReady: boolean;
  onZoom: (target: ZoomTarget, trigger?: HTMLElement) => void;
  onQuarantine: (assetId: string) => void; onRestore: (assetId: string) => void;
  onSelectVersion: (versionId: string | null) => void; versionId: string | null;
  actions?: ReactNode; entryNote?: string; showManagement?: boolean;
}) {
  const historical = isHistorical(detail), media = version.declaration.mediaBindings.filter(binding => showManagement || binding.purpose === "ACCOUNT_DISPLAY" && binding.publiclyReadable === true && Boolean(binding.publicUrl));
  const payout = version.declaration.attributes.full_payout_declaration as Record<string, unknown> | undefined;
  const payoutText = payout?.selected === true ? "已选" : payout?.selected === false ? "未选" : "未提供";
  return <div className="supervision-detail-body min-w-0 space-y-6">
    <h2 className="sr-only">完整账号资料</h2>
    {actions || entryNote ? <header className="flex flex-wrap items-center justify-between gap-3">{entryNote ? <p className="text-sm text-muted-foreground">{entryNote}</p> : null}<div className="flex flex-wrap gap-2">{actions}</div></header> : null}
    {historical ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"><span>正在查看资料存档，只能阅读。</span><Button size="sm" variant="outline" onClick={() => onSelectVersion(null)}>回到当前资料</Button></div> : null}
    <AccountProfile version={version} payoutText={payoutText} showManagement={showManagement}
      assets={<><SkinList version={version}/>{version.declaration.entitlements.length ? <ul className="mt-3 space-y-1.5 text-sm">{version.declaration.entitlements.map(item => <li key={item.entitlementId}>{version.presentation.entitlements?.find(entry => entry.id === item.entitlementId)?.name ?? "权益名称未提供"} · {item.value === true ? "持有" : item.value === false ? "未持有" : String(item.value ?? "未提供")} · {entitlementTermText(item)}</li>)}</ul> : null}</>}
      media={media.length ? <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{media.map((binding, index) => <MediaCard key={binding.assetId} binding={binding} index={index} total={media.length} showManagement={showManagement} canReviewMedia={showManagement && canReviewMedia} readOnly={historical} busy={busy} reasonReady={reasonReady} onZoom={onZoom} onQuarantine={onQuarantine} onRestore={onRestore}/>)}</div> : <p className="text-sm text-muted-foreground">{showManagement ? "暂未提供图片。" : "本次读取未提供可公开读取的展示图。"}</p>}/>
    {showManagement ? <Collapsible className="border-t border-border pt-4"><CollapsibleTrigger className="group flex w-full items-center justify-between text-sm font-medium text-muted-foreground">版本与审核记录<ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"/></CollapsibleTrigger><CollapsibleContent className="space-y-4 pt-3">
      <dl className="grid gap-3 break-all text-xs text-muted-foreground sm:grid-cols-2"><div><dt>原标题</dt><dd>{version.declaration.title || "未填写"}</dd></div><div><dt>资料版本</dt><dd>{version.id}</dd></div><div><dt>状态</dt><dd><StateBadge state={version.reviewState}/></dd></div><div><dt>内容摘要</dt><dd>{version.contentHash ?? "未提供"}</dd></div><div><dt>规则版本</dt><dd>{version.releaseId ?? "未提供"}</dd></div><div><dt>租期规则</dt><dd>{version.termOption?.displayName ?? "未提供"}</dd></div><div><dt>发布时间</dt><dd>{displayTime(version.publication?.publishedAt)}</dd></div></dl>
      {detail.history?.length ? <div className="flex flex-wrap gap-2">{detail.history.map(entry => <Button key={entry.id} variant="outline" size="sm" type="button" aria-pressed={versionId === entry.id} onClick={() => onSelectVersion(entry.id)}>第 {entry.sequence} 版 · {reviewStateLabel(entry.review_state)}</Button>)}</div> : <p className="text-sm text-muted-foreground">没有更早的资料记录。</p>}
      {detail.decisions.length ? <ol className="space-y-3">{detail.decisions.map(decision => <li key={decision.id} className="text-sm"><p className="font-medium">{decision.decision === "APPROVE" ? "审核通过" : "退回"} · {decision.reviewer_name}</p><p className="text-xs text-muted-foreground">{displayTime(decision.decided_at)}</p><p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{decision.reason}</p></li>)}</ol> : <p className="text-sm text-muted-foreground">{version.reviewState === "PUBLISHED" ? "号主直接发布，无人工审核记录。" : "尚无审核记录。"}</p>}
    </CollapsibleContent></Collapsible> : null}
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
  showManagement,
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
  showManagement: boolean;
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
  const src = showManagement ? mediaContentUrl(binding.assetId) : binding.publicUrl!;
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-card">
      <Button variant="ghost"
        type="button"
        aria-label={`放大核对 ${caption} ${index + 1}`}
        className="block h-auto w-full rounded-none p-0 focus-visible:ring-inset"
        onClick={event =>
          onZoom({
            src,
            alt: `${caption} ${index + 1}`,
            caption: `${caption} · ${index + 1} / ${total}`,
          }, event.currentTarget)
        }
      >
        <img
          src={src}
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
        {showManagement ? <Collapsible><CollapsibleTrigger className="group flex w-full items-center justify-between text-xs text-muted-foreground">图片状态<ChevronDown className="size-3"/></CollapsibleTrigger><CollapsibleContent keepMounted className="mt-2 data-[closed]:hidden"><div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={quarantined ? "destructive" : "secondary"}>
            {mediaReviewLabel(binding)}
          </Badge>
          <Badge variant="outline">{mediaEligibleLabel(binding)}</Badge>
          <Badge variant="outline">{mediaReadableLabel(binding)}</Badge>
        </div></CollapsibleContent></Collapsible> : null}
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
