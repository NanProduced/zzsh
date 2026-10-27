import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, CircleAlert, Copy, Eye, Flame, LogIn, MoreHorizontal, ShieldCheck, X } from "lucide-react";
import { adminRequest, friendlyError } from "../../api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { ListToolbarEnumSelect } from "@/components/admin-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, InlineStatus } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuGroup, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SupplySelect } from "@/components/supply/supply-select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { accountBusinessStatus, supplyObjectLabel, attributeFacts, historicalReadSummary, historicalResourceText, formatAmount, formatTermDays, publicBasisVersion, quantityText, versionBaseFeeRows, type SupplyQueryKind, type SupplyWorkDetail, type SupplyWorkItem } from "../supply-review/model";
import { ImportedAccountView, ResourceBillingTable } from "../supply-review/detail-pane";
import {
  fullShanghaiTime,
  KIND_LABELS,
  compactTime,
  alignedQuickRow,
  groupConditions,
  kindHint,
  newOrdersReasonText,
  rowAccountTitle,
  rowBaseFeeRows,
  rowCoreAssetsText,
  rowVisibleMaterials,
  rowRentalTerms,
  readableConfigName,
  haffBaseFromM,
  haffMFromBase,
  depositCentsFromYuan,
  depositYuanFromCents,
  rowDisplaySourceText,
  rowTermsLines,
  parseSavedViews,
  primaryReason,
  savedKey,
  serializeSavedViews,
  suggestKind,
  versionText,
  type SavedView,
  rowHaffText,
  rowQuoteText,
  rowDepositText,
  rowGuaranteeEligibilityText,
  rowGuaranteeCondensed,
  rowFullPayout,
} from "./account-list-model";
import { condText } from "./reason-summary";
import { OwnerHoverCard } from "./owner-hover-card";

const KINDS: SupplyQueryKind[] = ["account", "legacy", "order", "owner", "nickname", "link"];
/** 查找类型下拉：用户选择决定查询；识别结果只作建议（单行提示，仅在需要时出现）。 */
export function KindSelect({ kind, onKind }: { kind: SupplyQueryKind; onKind: (k: SupplyQueryKind) => void }) {
  return <SupplySelect label="查找方式" value={kind} onValueChange={v => onKind(v as SupplyQueryKind)} options={KINDS.map(k => ({ value: k, label: KIND_LABELS[k] }))} className="w-24 shrink-0 rounded-r-none border-r-0 sm:w-28"/>;
}
export function KindHint({ q, kind, onKind }: { q: string; kind: SupplyQueryKind; onKind: (k: SupplyQueryKind) => void }) {
  const hint = kindHint(q, kind), s = suggestKind(q);
  if (!hint) return null;
  return <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" role="status">{hint}{s && s !== kind && <Button type="button" variant="link" size="xs" className="ml-1" onClick={() => onKind(s)}>改按{KIND_LABELS[s]}</Button>}</p>;
}
type RangeProps = {
  label: string;
  min: string;
  max: string;
  unit: string;
  parse: (text: string) => { value?: string; error?: string };
  display: (value: string) => string;
  onChange: (min: string, max: string) => void;
};
/** Exact numeric range; empty is unset, zero is a real bound, min>max is its own error. */
function ExactRangeFilter({ label, min, max, unit, parse, display, onChange }: RangeProps) {
  const [open, setOpen] = useState(false);
  const [draftMin, setDraftMin] = useState(min ? display(min) : "");
  const [draftMax, setDraftMax] = useState(max ? display(max) : "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setDraftMin(min ? display(min) : "");
    setDraftMax(max ? display(max) : "");
    setError(null);
  }, [open, min, max]);
  const text = min && max ? `${display(min)}–${display(max)}${unit}` : min ? `≥${display(min)}${unit}` : max ? `≤${display(max)}${unit}` : "全部";
  const apply = () => {
    const low = parse(draftMin), high = parse(draftMax);
    if (low.error || high.error) { setError(low.error ?? high.error!); return; }
    if (low.value && high.value && BigInt(low.value) > BigInt(high.value)) { setError("下限不能大于上限"); return; }
    setError(null);
    onChange(low.value ?? "", high.value ?? "");
    setOpen(false);
  };
  return <Field label={label} composite className="ud-field">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" className="ud-credit-trigger" aria-label={label} />}><span className="truncate">{text}</span><ChevronDown size={14} className="ml-auto shrink-0 opacity-50" aria-hidden /></PopoverTrigger>
      <PopoverContent className="ud-credit-popover" align="start">
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">按精确数值筛选；留空表示不限制。</p>
          <div className="flex items-center gap-2">
            <Input aria-label={label + "下限"} inputMode="decimal" autoComplete="off" placeholder="最低" value={draftMin} onChange={e => { setDraftMin(e.target.value); setError(null); }} className="h-8 text-xs tabular-nums" />
            <span className="text-muted-foreground" aria-hidden>–</span>
            <Input aria-label={label + "上限"} inputMode="decimal" autoComplete="off" placeholder="最高" value={draftMax} onChange={e => { setDraftMax(e.target.value); setError(null); }} className="h-8 text-xs tabular-nums" />
            <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
          </div>
          {error ? <p className="text-[11px] text-destructive" role="alert">{error}</p> : null}
          <div className="flex items-center justify-between border-t border-border pt-2">
            <Button type="button" variant="ghost" size="xs" className="h-7 text-xs" onClick={() => { setDraftMin(""); setDraftMax(""); setError(null); onChange("", ""); setOpen(false); }}>清空</Button>
            <Button type="button" size="xs" className="h-7 text-xs" onClick={apply}>确定</Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  </Field>;
}

export function MoreFilters({ values, loginOptions, onChange }: {
  values: { haffMin: string; haffMax: string; depositMin: string; depositMax: string; loginMethod: string };
  loginOptions: Array<{ code: string; name: string }>;
  onChange: (patch: Partial<typeof values>) => void;
}) {
  return <>
    <ListToolbarEnumSelect label="登录方式" value={values.loginMethod} onChange={loginMethod => onChange({ loginMethod })} options={loginOptions.map(option => [option.code, option.name] as [string, string])} />
    <ExactRangeFilter label="哈夫币" unit="M" min={values.haffMin} max={values.haffMax} parse={haffBaseFromM} display={haffMFromBase} onChange={(haffMin, haffMax) => onChange({ haffMin, haffMax })} />
    <ExactRangeFilter label="基础押金" unit="元" min={values.depositMin} max={values.depositMax} parse={depositCentsFromYuan} display={depositYuanFromCents} onChange={(depositMin, depositMax) => onChange({ depositMin, depositMax })} />
  </>;
}

export function StatusBadge({ facts, reviewState }: { facts: SupplyWorkItem["facts"]; reviewState?: string | null }) {
  const status = accountBusinessStatus(facts, reviewState);
  return <span data-account-status className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"><InlineStatus tone={status.tone}>{status.label}</InlineStatus>{status.detail ? <span className="text-xs text-muted-foreground">{status.detail}</span> : null}</span>;
}
export function ReasonCell({ facts, onMore }: { facts: SupplyWorkItem["facts"]; onMore: () => void }) {
  const { code, others } = primaryReason(facts);
  if (!code) return facts.newOrders === true || facts.businessState === "IN_PROGRESS" || facts.businessState === "COMPLETED" ? null : <span className="text-sm text-muted-foreground">{newOrdersReasonText(facts.newOrders)}</span>;
  if (code === "OCCUPIED" && facts.occupancy === "OCCUPIED" && !facts.staffRestricted && !facts.ownerPaused && others === 0) return null;
  return <div className="text-sm"><div>{condText(code)}</div>{others > 0 && <Button type="button" variant="link" size="xs" className="h-auto px-0 text-xs text-muted-foreground" onClick={e => { e.stopPropagation(); onMore(); }} aria-label={"查看全部 " + (others + 1) + " 项原因"}>另 {others} 项</Button>}</div>;
}
export function TimeText({ iso, label = "更新时间" }: { iso: string; label?: string }) {
  const full = fullShanghaiTime(iso);
  return <Tooltip><TooltipTrigger render={<time dateTime={iso} tabIndex={0} aria-label={label + " " + full + "（上海时间）"} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} className="cursor-default whitespace-nowrap rounded-sm tabular-nums underline decoration-dotted decoration-muted-foreground/40 underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"/>}>{compactTime(iso)}</TooltipTrigger><TooltipContent>{full}（上海时间）</TooltipContent></Tooltip>;
}
/** 号主入口：只用当前行的受权投影；ownerLink 未 READY 时不可点并说明原因。 */
export function IdLine({ row, onOpenOwner }: { row: SupplyWorkItem; onOpenOwner?: (row: SupplyWorkItem) => void }) {
  const canOpen = row.ownerLink?.state === "READY" && Boolean(onOpenOwner);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>编号：{row.displayNo ?? "编号未分配"}</span>
      <span aria-hidden="true">|</span>
      <span>号主：</span>
      <OwnerHoverCard ownerName={row.ownerName} ownerId={row.ownerId} summary={row.ownerSummary ?? null} canOpen={canOpen} onOpenOwner={canOpen ? () => onOpenOwner?.(row) : undefined} />
    </div>
  );
}

/** 账号固定三层：中性标题、新平台编号（无则明确未分配）、号主入口；旧来源只在详情溯源。 */
export function AccountIdentity({ row, onOpenOwner }: { row: SupplyWorkItem; onOpenOwner?: (row: SupplyWorkItem) => void }) {
  const canOpen = row.ownerLink?.state === "READY" && Boolean(onOpenOwner), legacy = row.facts.sources.length > 0 || Boolean(row.facts.historicalRead);
  return (
    <div data-account-identity className="space-y-0.5 text-xs text-muted-foreground">
      <div className="break-words text-sm font-semibold tabular-nums text-foreground">{row.displayNo ?? "编号待分配"}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span>{row.gameName}</span>
        {legacy ? <Badge variant="outline" className="px-1.5 py-0 text-[10px]">旧平台迁入</Badge> : null}
      </div>
      <div>号主：<OwnerHoverCard ownerName={row.ownerName} ownerId={row.ownerId} summary={row.ownerSummary ?? null} canOpen={canOpen} onOpenOwner={canOpen ? () => onOpenOwner?.(row) : undefined} /></div>
    </div>
  );
}

/** Compact display only: zero stock remains available in the full account record. */
export function AccountResources({ row }: { row: SupplyWorkItem }) {
  const historical = !row.summary && row.facts.historicalRead?.display?.state === "KNOWN" ? row.facts.historicalRead.display.facts : null;
  const config = row.summary?.config ?? (historical ? { safeBox: historical.attributeDisplay?.safeBox?.displayName, grading: historical.attributeDisplay?.grading?.displayName } : null);
  const materials = row.summary ? rowVisibleMaterials(row) : (historical?.resources ?? []).filter(item => item.unit !== "HAFF_BASE" && !(typeof item.quantity === "string" && /^0+$/.test(item.quantity))).map(item => ({ itemId: item.code, code: item.code, name: item.name, quantity: item.quantity ?? null, unit: item.unit }));
  const total = row.summary?.materialsVisibleTotal ?? materials.length;
  const unit = (item: typeof materials[number]) => item.unit === "ROUND" ? "发" : item.unit === "DAY" ? "天" : item.unit === "PIECE" ? "件" : "";
  return <div className="space-y-1 text-xs" data-account-resources>
    <p className="font-semibold tabular-nums text-amber-900 dark:text-amber-300">{rowHaffText(row)}</p>
    {config && [config.safeBox, config.grading].some(value => readableConfigName(value)) ? <p className="text-muted-foreground">{[config.safeBox, config.grading].map(value => readableConfigName(value)).filter(Boolean).join(" · ")}</p> : null}
    <p className="max-w-[310px] break-words leading-relaxed text-muted-foreground">{materials.length ? materials.slice(0, 3).map(item => `${item.name ?? "物资"} ${item.quantity ?? "数量未知"}${unit(item)}`).join(" · ") : row.summary?.materialsVisibleTotal === 0 && row.summary.materialsTotal ? "物资数量均为 0" : row.summary?.versionId ? "暂无物资申报" : "资源待完善"}{total > 3 ? ` · 另 ${total - 3} 项` : ""}</p>
  </div>;
}

export function AccountTerms({ row }: { row: SupplyWorkItem }) {
  const terms = rowRentalTerms(row), known = row.summary?.versionId;
  if (!known) return <p className="text-xs text-muted-foreground">出租条件待完善</p>;
  const daily = terms.daily.endsWith(" 哈夫币") ? terms.daily.replace(" 哈夫币", "/天") : terms.daily;
  return <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs" data-account-terms>
    <span className="inline-flex items-center gap-1.5" title="预计租期"><CalendarDays aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/><span className="sr-only">租期：</span>{terms.term}</span>
    <span className="inline-flex items-center gap-1.5" title="每日消耗"><Flame aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/><span className="sr-only">日耗：</span>{daily}</span>
    <span className="inline-flex min-w-0 items-center gap-1.5"><LogIn aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/><span className="sr-only">登录方式：</span>{readableConfigName(terms.login) ?? "待确认"}</span>
    <span className="inline-flex items-center gap-1.5"><ShieldCheck aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/>{terms.payout === "已选" ? "已选包赔" : terms.payout === "未选" ? "未选包赔" : "包赔未提供"}</span>
  </div>;
}

export function AccountFees({ row }: { row: SupplyWorkItem }) {
  const fees = rowBaseFeeRows(row), hasQuote = [fees.total, fees.haff, fees.materials, fees.resources ?? ""].some(value => value.includes("¥"));
  return <div className="min-w-[150px] space-y-1 text-xs tabular-nums" data-account-fees>
    {hasQuote ? <><div className="flex items-baseline justify-between gap-3"><span className="text-muted-foreground">基础总价</span><strong className="text-base font-semibold text-sky-900 dark:text-sky-300">{fees.total}</strong></div><div className="flex justify-between gap-3 text-muted-foreground"><span>哈夫币租金</span><span>{fees.haff}</span></div><div className="flex justify-between gap-3 text-muted-foreground"><span>物资预付</span><span>{fees.materials}</span></div></> : <p className="font-medium text-muted-foreground">报价待完善</p>}
    <div className="flex justify-between gap-3 pt-1.5 text-muted-foreground"><span>租客基础押金</span><span className="font-medium text-foreground">{fees.deposit}</span></div>
    {fees.resources && fees.resources !== "未提供" && (fees.total === "未提供" || !fees.haff.startsWith("¥") || !fees.materials.startsWith("¥")) ? <div className="flex justify-between gap-3 text-muted-foreground"><span>资源费合计</span><span>{fees.resources}</span></div> : null}
    {!row.summary && row.facts.historicalRead ? <span className="text-[11px] text-muted-foreground">迁入时记录</span> : null}
  </div>;
}

/** 行 ⋯ 菜单：保留备用 */
export function RowMenu({ onFull, id, label }: { onFull: () => void; id: string; label: string }) {
  return <div onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={"更多操作 " + label}><MoreHorizontal/></Button>}/><DropdownMenuContent align="end" className="w-40"><DropdownMenuItem onClick={onFull}>打开完整详情</DropdownMenuItem><DropdownMenuItem onClick={() => { void navigator.clipboard?.writeText(id).catch(() => undefined); }}>复制内部 ID</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>;
}

/** 行操作图标组：仅读取与复制入口；上/下架与退款没有正式合同，不在列表提供。 */
export function RowActions({
  row,
  onFull,
}: {
  row: SupplyWorkItem;
  onFull: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = row.displayNo ?? row.accountId;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className="flex items-center gap-0.5"
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              aria-label="查看详情"
              onClick={onFull}
            >
              <Eye className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent>查看详情</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              aria-label="复制编号"
              onClick={handleCopy}
            >
              <Copy className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent>{copied ? "已复制！" : "复制编号"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function useSavedViews(adminId: string) {
  const [state, setState] = useState(() => { try { return parseSavedViews(localStorage.getItem(savedKey(adminId)), adminId); } catch { return { views: [] as SavedView[], notice: "浏览器本地存储不可用，保存的视图暂不可用。" }; } });
  const save = (views: SavedView[]) => { try { localStorage.setItem(savedKey(adminId), serializeSavedViews(views, adminId)); setState({ views }); } catch { setState({ views: state.views, notice: "保存失败：浏览器本地存储不可用。" }); } };
  return { views: state.views, notice: state.notice, save, dismiss: () => setState({ views: state.views }) };
}

export function AccountCards({ items, onView, onOpenOwner }: { items: SupplyWorkItem[]; onView: (row: SupplyWorkItem, trigger?: HTMLElement) => void; onOpenOwner?: (row: SupplyWorkItem) => void }) {
  return <div className="grid gap-2">{items.map(row => { const rule = row.facts.reasons.includes("CONFIRMATION_OR_MEDIA_REQUIRED") || row.facts.reasons.includes("RULE_CHANGED"), terms = rowTermsLines(row), fees = rowBaseFeeRows(row);
    return <Card size="sm" key={row.id} id={"supply-card-" + row.id} role="button" tabIndex={0} aria-label={"快速查看 " + supplyObjectLabel(row)} onClick={e => onView(row, e.currentTarget)} onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onView(row, e.currentTarget); } }} className="cursor-pointer gap-0 p-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><AccountIdentity row={row} onOpenOwner={onOpenOwner}/></div><ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true"/></div>
      <div className="mt-3 grid gap-3"><AccountResources row={row}/><AccountTerms row={row}/><AccountFees row={row}/></div>
      <div className="mt-2 flex items-start gap-2"><StatusBadge facts={row.facts} reviewState={row.reviewState}/><ReasonCell facts={row.facts} onMore={() => onView(row, document.getElementById("supply-card-" + row.id) ?? undefined)}/></div>
      {rule && <p className="mt-2 text-xs text-muted-foreground">规则确认或展示图片仍需核对，详情中逐项查看。</p>}
      <div className="mt-1 text-xs text-muted-foreground">更新 {row.accountUpdatedAt ? <TimeText iso={row.accountUpdatedAt} label="账号更新时间"/> : "未提供"}</div></Card>; })}</div>;
}

type QuickProps = { row: SupplyWorkItem; canRead: boolean; onClose: () => void; onOpenFull: (context: string) => void };
/** 快速核对：身份/状态、基本属性与使用条件、全部申报资源、同版基础费用；历史折叠，完整处置在对象页。 */
export function QuickView({ row, canRead, onClose, onOpenFull }: QuickProps) {
  const [detail, setDetail] = useState<SupplyWorkDetail>(), [error, setError] = useState<string>(), [showDraft, setShowDraft] = useState(false);
  useEffect(() => { if (!canRead) { onClose(); return; } const c = new AbortController(); setDetail(undefined); setError(undefined); setShowDraft(false);
    adminRequest<SupplyWorkDetail>("/supply/listing-reviews/" + encodeURIComponent(row.id) + "?queryVersion=3", undefined, "GET", {}, c.signal).then(d => { if (!c.signal.aborted) setDetail(d); }).catch(e => { if (!c.signal.aborted) setError(friendlyError(e)); });
    return () => c.abort(); }, [row.id, canRead]);
  if (!canRead) return null;
  const facts = detail?.supervision.facts ?? row.facts, g = groupConditions(facts);
  const publicBasis = facts.publicBasis ?? null, publicDefault = !showDraft && publicBasis && detail?.version && publicBasis.id !== detail.version.id ? publicBasis : null;
  const v = publicDefault ? publicBasisVersion(publicDefault) : detail?.version, viewed = publicDefault ? row : alignedQuickRow(row, detail);
  const historical = detail?.supervision.facts.historicalRead ?? row.facts.historicalRead;
  const attrs = v ? attributeFacts(v) : [];
  const verdict = facts.newOrders === null ? "新单资格待核" : facts.newOrders ? "可接新单" : "不可接新单";
  const declaredAttribute = v ? Object.values(v.declaration.attributes).some(value => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)) : false;
  const emptyDraft = Boolean(v && !declaredAttribute && !v.declaration.inventory.length && !v.declaration.entitlements.length && !v.declaration.skins.length && !v.termOption?.displayName);
  const releaseId = v?.releaseId ?? null;
  const ratio = v?.quote?.baseRenterHaffRatioWanPerYuan ?? null;
  const fees = v ? versionBaseFeeRows(v, publicDefault?.baseDeposit?.amountCents) : rowBaseFeeRows(viewed);
  const termSeconds = publicDefault ? publicDefault.quote?.termSeconds ?? null : v?.quote?.termSeconds ?? null;
  const declared = v?.declaration.attributes ?? {};
  const payout = declared.full_payout_declaration as Record<string, unknown> | undefined;
  const payoutLabel = v ? (payout?.selected === true ? "已选" : payout?.selected === false ? "未选" : "未申报") : rowFullPayout(viewed).label;
  const haffLine = v ? v.declaration.inventory.find(item => item.itemId === "haff" || v.presentation.items?.find(entry => entry.id === item.itemId)?.unit === "HAFF_BASE") : null;
  const haffText = haffLine ? quantityText(haffLine.quantity) : rowHaffText(viewed);
  const titleConfig = v ? {
    safeBox: v.attributeDisplay?.safeBox?.displayName ?? (typeof v.declaration.attributes.safe_box_code === "string" ? `未确认（代码 ${v.declaration.attributes.safe_box_code}）` : null),
    grading: v.attributeDisplay?.grading?.displayName ?? (typeof v.declaration.attributes.grading_code === "string" ? `未确认（代码 ${v.declaration.attributes.grading_code}）` : null),
    gradingDivision: Object.hasOwn(v.declaration.attributes, "grading_division") && v.declaration.attributes.grading_division !== null && v.declaration.attributes.grading_division !== "" ? String(v.declaration.attributes.grading_division) : null,
    characterLevel: v.declaration.attributes.character_level === null || v.declaration.attributes.character_level === undefined ? null : String(v.declaration.attributes.character_level),
  } : row.summary?.config ?? null;
  const quickTitle = rowAccountTitle({
    ...row,
    summary: v ? { ...(row.summary ?? {}), haff: haffLine ? { itemId: haffLine.itemId, quantity: haffLine.quantity, unit: "HAFF_BASE" } : null, config: titleConfig } : row.summary,
  } as SupplyWorkItem);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
  <DialogContent showCloseButton={false} aria-labelledby="qv-title" data-quick-view="" className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
    <header className="border-b px-5 pb-3 pt-4">
      <DialogTitle id="qv-title" className="text-lg font-semibold">{quickTitle}</DialogTitle>
      <DialogDescription className="sr-only">账号基本信息、申报资源与同版基础费用速览</DialogDescription>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <IdLine row={row}/>
        <span className="text-xs text-muted-foreground">·</span>
        <StatusBadge facts={facts} reviewState={detail?.supervision.historical ? null : v?.reviewState ?? row.reviewState}/>
        <span className="text-xs text-muted-foreground">{publicDefault ? "对外资料" : showDraft && publicBasis ? "编辑草稿" : "当前资料"}</span>
        {g.blocked.length || g.pending.length ? <span className="text-xs text-muted-foreground">{g.blocked.length ? g.blocked.length + " 项需处理" : ""}{g.blocked.length && g.pending.length ? " · " : ""}{g.pending.length ? "待核 " + g.pending.length + " 项" : ""}</span> : null}
      </div>
    </header>
    <div className="max-h-[calc(100dvh-14rem)] overflow-y-auto px-5 py-4">
      {error && <Alert variant="warning" role="status" className="mb-3"><CircleAlert aria-hidden="true" /><AlertTitle>详情未读到</AlertTitle><AlertDescription><p>{error}</p><p>以下仍为列表已读取的事实。</p></AlertDescription></Alert>}
      {!detail && !error ? <p className="mb-3 text-sm text-muted-foreground" aria-busy="true">正在读取当前资料…</p> : null}

      {!v && detail && historical ? <ImportedAccountView read={historical}/> : <>
      <section className="border-b border-border pb-4" aria-label="基础报价速览">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3"><h3 className="text-sm font-semibold">基础报价</h3><strong className="text-xl font-semibold tabular-nums text-sky-900 dark:text-sky-300"><span className="mr-2 text-xs font-normal text-muted-foreground">基础总价</span>{fees.total}</strong></div>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">哈夫币租金</dt><dd className="mt-1 tabular-nums">{fees.haff}</dd></div>
          <div><dt className="text-xs text-muted-foreground">物资预付</dt><dd className="mt-1 tabular-nums">{fees.materials}</dd></div>
          <div><dt className="text-xs text-muted-foreground">租客基础押金</dt><dd className="mt-1 font-medium tabular-nums">{fees.deposit}</dd></div>
          {fees.resources && fees.resources !== "未提供" && (fees.total === "未提供" || !fees.haff.startsWith("¥") || !fees.materials.startsWith("¥")) ? <div><dt className="text-xs text-muted-foreground">资源费合计</dt><dd className="mt-1 tabular-nums">{fees.resources}</dd></div> : null}
          <div><dt className="text-xs text-muted-foreground">预计租期</dt><dd className="mt-1">{termSeconds ? formatTermDays(termSeconds) : "未提供"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">全额包赔</dt><dd className="mt-1">{payoutLabel}</dd></div>
          <div><dt className="text-xs text-muted-foreground">基础客价比例</dt><dd className="mt-1">{ratio ? ratio + " 万/元" : "未提供"}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">基础总价含哈夫币租金、物资预付和基础押金；租客实际费用按本人报价核定。</p>
        {fees.note ? <p className="mt-1 text-xs text-muted-foreground">{fees.note}</p> : null}
      </section>

      <div className="mt-4 space-y-3">
        <p className="text-sm">哈夫币：<span className="font-semibold tabular-nums text-amber-900 dark:text-amber-300">{haffText}</span></p>
        {v ? <ResourceBillingTable key={v.id} version={v}/> : <p className="text-sm text-muted-foreground">{error ? "详情未读到，完整物资表暂不可核对。" : "正在读取完整物资表…"}</p>}
      </div>

      <section className="border-t pt-3 first:border-t-0 first:pt-0">
        <h3 className="mb-2 text-sm font-semibold">账号资料</h3>
        {v ? (emptyDraft ? <p className="text-sm text-muted-foreground">本版尚未填写申报属性；完整字段可在档案中逐项核对，未申报不按否处理。</p> : <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">{attrs.map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className={fact.unconfirmed ? "text-muted-foreground" : "font-medium"}>{fact.value}</dd></div>)}<div><dt className="text-xs text-muted-foreground">了解渠道（内部）</dt><dd>{v.management?.infoSource?.name ?? (typeof v.declaration.attributes.info_source === "string" ? v.declaration.attributes.info_source : "未提供")}</dd></div></dl>) : <p className="text-sm text-muted-foreground">{error ? "详情未读到，属性暂不可核对。" : "正在读取属性…"}</p>}
      </section>
      </>}

      {v ? <Collapsible className="mt-4 border-t pt-3"><CollapsibleTrigger className="group flex w-full items-center justify-between rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">版本追溯<ChevronDown className="size-3.5"/></CollapsibleTrigger><CollapsibleContent className="pt-2"><dl className="grid gap-2 break-all text-xs text-muted-foreground"><div><dt>资料版本</dt><dd>{v.id}</dd></div><div><dt>内容摘要</dt><dd>{v.contentHash ?? "未提供"}</dd></div><div><dt>规则版本</dt><dd>{releaseId ?? "未提供"}</dd></div></dl></CollapsibleContent></Collapsible> : null}

      {v && historical ? <Collapsible className="mt-4 border-t pt-3">
        <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-sm text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">迁入前记录<ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"/></CollapsibleTrigger>
        <CollapsibleContent keepMounted data-historical-summary="" className="pt-2 data-[closed]:hidden">
          <p className="text-xs text-muted-foreground">{historicalReadSummary(historical)}</p>
          {historical.display?.state === "KNOWN" && historical.display.facts?.sourceUpdatedAt ? <p className="text-xs text-muted-foreground">来源更新：<TimeText iso={historical.display.facts.sourceUpdatedAt} label="历史来源更新时间"/></p> : null}
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">租金</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.haffRentYuan)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">物资费</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.goodsYuan)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">押金</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.depositYuan)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">租期</dt><dd>{historical.historicalQuote.termDays} 天</dd></div>
          </dl>
          {historical.display?.state === "KNOWN" && Array.isArray(historical.display.facts?.resources) ? <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">{historical.display.facts.resources.map(resource => <li key={resource.code}>{resource.name}：{historicalResourceText(resource)}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">历史扩展资料尚待接入，缺失数量不按零显示。</p>}
          <p className="mt-2 text-xs text-muted-foreground">历史记录不代表当前报价、下单应付或可租资格。</p>
        </CollapsibleContent>
      </Collapsible> : null}
    </div>
    <footer className="flex flex-wrap items-center justify-end gap-2 border-t bg-background px-5 py-3">
      {publicDefault ? <Button size="lg" variant="outline" onClick={() => setShowDraft(true)}>查看当前草稿</Button> : showDraft && publicBasis ? <Button size="lg" variant="outline" onClick={() => setShowDraft(false)}>回到对外版</Button> : null}
      <Button size="lg" variant="outline" onClick={onClose}>关闭</Button>
      <Button size="lg" onClick={() => onOpenFull("situation")}>查看完整档案</Button>
    </footer>
  </DialogContent></Dialog>;
}

type SavedApi = ReturnType<typeof useSavedViews>;
/** 个人保存的视图：仅存筛选条件，仅本浏览器、仅本人。 */
export function SavedViewsMenu({ saved, current, onLoad }: { saved: SavedApi; current: Omit<SavedView, "name">; onLoad: (v: SavedView) => void }) {
  const [open, setOpen] = useState(false), [name, setName] = useState("");
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button type="button" variant="outline" size="lg">保存视图{saved.views.length ? " · " + saved.views.length : ""}<ChevronDown data-icon="inline-end"/></Button>}/>
    <PopoverContent align="end" className="w-72"><div className="text-xs text-muted-foreground">只存筛选条件 · 仅本浏览器 · 仅你本人</div>
      <div className="grid">{saved.views.map((v, i) => <div key={i} className="flex items-center gap-1"><Button variant="ghost" className="flex-1 justify-start" onClick={() => { setOpen(false); onLoad(v); }}>{v.name}</Button><Button variant="ghost" size="icon-sm" aria-label={"删除视图 " + v.name} onClick={() => saved.save(saved.views.filter((_, j) => j !== i))}><X/></Button></div>)}{!saved.views.length && <p className="py-1 text-sm text-muted-foreground">还没有保存的视图</p>}</div>
      <div className="flex gap-1.5 border-t pt-2.5"><Input aria-label="视图名称" value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="视图名称" className="h-8"/><Button disabled={!name.trim()} onClick={() => { saved.save([...saved.views, { name: name.trim(), ...current }]); setName(""); }}>保存</Button></div>
    </PopoverContent></Popover>;
}
