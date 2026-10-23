import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert, Copy, Eye, MoreHorizontal, X } from "lucide-react";
import { adminRequest, friendlyError } from "../../api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InlineStatus } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuGroup, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SupplySelect } from "@/components/supply/supply-select";
import { newOrdersStatus, reviewStateLabel, supplyObjectLabel, attributeFacts, historicalAttributeFacts, historicalReadSummary, historicalResourceText, formatAmount, type SupplyQueryKind, type SupplyWorkDetail, type SupplyWorkItem } from "../supply-review/model";
import {
  fullShanghaiTime,
  KIND_LABELS,
  compactTime,
  groupConditions,
  kindHint,
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
  rowGuaranteeRequirementText,
  rowGuaranteeEligibilityText,
  rowGuaranteeProofText,
  rowFullPayout,
} from "./account-list-model";
import { AccountFacts, condText } from "./reason-summary";
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
const MORE = ["新单资格", "占用状态", "公开状态", "待规则确认", "保险箱", "体力/负重等级", "哈夫币库存", "押金范围", "最近变更时间"];
export function MoreFilters() {
  return <DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" size="lg">更多筛选<ChevronDown data-icon="inline-end"/></Button>}/><DropdownMenuContent align="end" className="w-56"><DropdownMenuGroup><DropdownMenuLabel>以下条件需后端支持，暂不可用</DropdownMenuLabel></DropdownMenuGroup><DropdownMenuSeparator/><DropdownMenuGroup>{MORE.map(m => <DropdownMenuItem key={m} disabled className="justify-between">{m}<span className="text-xs text-muted-foreground">待接入</span></DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>;
}

export function StatusBadge({ facts }: { facts: SupplyWorkItem["facts"] }) {
  const status = newOrdersStatus(facts);
  return <InlineStatus tone={status.tone}>{status.label}</InlineStatus>;
}
export function ReasonCell({ facts, onMore }: { facts: SupplyWorkItem["facts"]; onMore: () => void }) {
  const { code, others } = primaryReason(facts);
  if (!code) return <span className="text-sm text-muted-foreground">服务端未返回阻塞</span>;
  return <div className="text-sm"><div>{condText(code)}</div>{others > 0 && <Button type="button" variant="link" size="xs" className="h-auto px-0 text-xs text-muted-foreground" onClick={e => { e.stopPropagation(); onMore(); }} aria-label={"查看全部 " + (others + 1) + " 项原因"}>另 {others} 项</Button>}</div>;
}
export function TimeText({ iso, label = "更新时间" }: { iso: string; label?: string }) {
  const full = fullShanghaiTime(iso);
  return <Tooltip><TooltipTrigger render={<time dateTime={iso} tabIndex={0} aria-label={label + " " + full + "（上海时间）"} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} className="cursor-default whitespace-nowrap rounded-sm tabular-nums underline decoration-dotted decoration-muted-foreground/40 underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"/>}>{compactTime(iso)}</TooltipTrigger><TooltipContent>{full}（上海时间）</TooltipContent></Tooltip>;
}
/** 号主入口：只用当前行的受权投影；ownerLink 未 READY 时不可点并说明原因。 */
export function IdLine({ row, onOpenOwner }: { row: SupplyWorkItem; onOpenOwner?: (row: SupplyWorkItem) => void }) {
  const label = supplyObjectLabel(row);
  const canOpen = row.ownerLink?.state === "READY" && Boolean(onOpenOwner);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>编号：{row.displayNo ?? (label.startsWith("旧来源号") ? "未登记（" + label + "）" : "编号待核")}</span>
      <span aria-hidden="true">|</span>
      <span>号主：</span>
      <OwnerHoverCard ownerName={row.ownerName} ownerId={row.ownerId} summary={row.ownerSummary ?? null} canOpen={canOpen} onOpenOwner={canOpen ? () => onOpenOwner?.(row) : undefined} />
    </div>
  );
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

export function AccountCards({ items, onView }: { items: SupplyWorkItem[]; onView: (row: SupplyWorkItem, trigger?: HTMLElement) => void }) {
  return <div className="grid gap-2">{items.map(row => { const rule = row.facts.reasons.includes("CONFIRMATION_OR_MEDIA_REQUIRED") || row.facts.reasons.includes("RULE_CHANGED");
    const quote = rowQuoteText(row);
    return <Card size="sm" key={row.id} id={"supply-card-" + row.id} role="button" tabIndex={0} aria-label={"快速查看 " + supplyObjectLabel(row)} onClick={e => onView(row, e.currentTarget)} onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onView(row, e.currentTarget); } }} className="cursor-pointer gap-0 p-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="break-words font-semibold">{row.title ?? "资料未提供"}</div><IdLine row={row}/></div><ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true"/></div>
      {row.facts.historicalRead ? <p className="mt-1 text-xs text-muted-foreground">{historicalReadSummary(row.facts.historicalRead)}</p> : null}
      {row.facts.historicalRead ? <div className="mt-2 space-y-0.5 text-xs tabular-nums"><p>{rowHaffText(row)} · 押金 {rowDepositText(row)}</p><p>{quote.total}</p><p className="text-muted-foreground">{quote.note}</p></div> : null}
      <div className="mt-2 flex items-start gap-2"><StatusBadge facts={row.facts}/><ReasonCell facts={row.facts} onMore={() => onView(row, document.getElementById("supply-card-" + row.id) ?? undefined)}/></div>
      {rule && <p className="mt-2 text-xs text-muted-foreground">规则确认或展示图片仍需核对，详情中逐项查看。</p>}
      <div className="mt-1 text-xs text-muted-foreground">{versionText(row.sequence)} · 资料排序 <TimeText iso={row.sortAt} label="资料排序时间"/></div></Card>; })}</div>;
}

export function summaryText(row: SupplyWorkItem, detail?: SupplyWorkDetail) {
  const f = detail?.supervision.facts ?? row.facts, g = groupConditions(f);
  return [(row.title ?? "资料未提供") + " · " + (row.displayNo ?? "未登记编号") + " · " + row.accountId, "号主：" + row.ownerName, (f.newOrders === null ? "新单资格待核" : f.newOrders ? "可接新单" : "不可接新单") + "；已确认阻塞 " + g.blocked.length + " 项、待核 " + g.pending.length + " 项", ...g.blocked.map(c => "· " + condText(c.code) + " → " + c.who), ...g.pending.map(c => "· [待核] " + condText(c.code) + " → " + c.who), "各条件独立，解除一项不代表账号可以接单。"].join("\n");
}

export function QuickViewAssetSummary({
  row,
  detail,
}: {
  row: SupplyWorkItem;
  detail?: SupplyWorkDetail;
}) {
  const resourceTotal = row.summary?.quote?.resourceTotal ?? detail?.version?.quote?.resourceTotal ?? null;
  const facts = detail?.version ? attributeFacts(detail.version).filter(f => ["安全箱配置", "体力等级", "负重等级", "潜水等级", "角色等级", "段位", "绝密 KD"].includes(f.label)) : [];
  const fullPayout = rowFullPayout(row);
  const inventory = (detail?.version?.declaration?.inventory ?? []).filter(item => item.itemId !== row.summary?.haff?.itemId);
  const historical = detail?.supervision.facts.historicalRead ?? row.facts.historicalRead;
  const display = historical?.display?.state === "KNOWN" ? historical.display.facts : null;

  return (
    <div className="my-3 space-y-3.5">
      {historical ? <section data-historical-summary="" className="space-y-2 rounded-lg border bg-muted/20 p-3">
        <h3 className="text-sm font-semibold">历史来源记录</h3>
        <p className="text-xs text-muted-foreground">{historicalReadSummary(historical)}</p>
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">历史租金</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.haffRentYuan)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">历史物资费</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.goodsYuan)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">历史押金</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.depositYuan)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">历史租期</dt><dd>{historical.historicalQuote.termDays} 天</dd></div>
        </dl>
        {display?.attributes && Array.isArray(display.resources) ? <>
          <p className="text-xs text-muted-foreground">来源更新：<TimeText iso={display.sourceUpdatedAt} label="历史来源更新时间"/></p>
          <Collapsible className="border-t">
            <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-sm py-2 text-left text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              历史属性与物资<ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"/>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="grid grid-cols-2 gap-2 pb-2 text-sm sm:grid-cols-3">{historicalAttributeFacts(historical).filter(fact => fact.label !== "租期规则").map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 pb-2 text-xs">{display.resources.map(resource => <li key={resource.code}>{resource.name}：{historicalResourceText(resource)}</li>)}</ul>
            </CollapsibleContent>
          </Collapsible>
        </> : <p className="text-xs text-muted-foreground">历史扩展资料尚待接入，缺失数量不按零显示。</p>}
        <p className="text-xs text-muted-foreground">历史记录仅供核对，不代表当前报价、下单应付或可租资格。</p>
      </section> : null}
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-muted-foreground">
          <span>核心游戏资产</span>
          {!historical ? <span className="text-[10px] text-muted-foreground">来源：当前资料版本申报值</span> : null}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border bg-card p-2.5 shadow-xs">
            <span className="block text-[11px] text-muted-foreground">哈夫币数量</span>
            <span className="mt-0.5 block font-mono text-sm font-bold tabular-nums text-amber-900 dark:text-amber-300">{rowHaffText(row)}</span>
          </div>
          {facts.map(fact => (
            <div className="rounded-lg border bg-card p-2.5 shadow-xs" key={fact.label}>
              <span className="block text-[11px] text-muted-foreground">{fact.label}</span>
              <span className={"mt-0.5 block text-sm font-semibold " + (fact.unconfirmed ? "text-amber-700 dark:text-amber-400" : "")}>{fact.value}</span>
            </div>
          ))}
          <div className="rounded-lg border bg-card p-2.5 shadow-xs">
            <span className="block text-[11px] text-muted-foreground">全额包赔</span>
            <span className="mt-0.5 block text-sm font-semibold">{fullPayout.label}</span>
          </div>
        </div>
        {!detail ? <p className="mt-1 text-[11px] text-muted-foreground">属性需读取当前资料版本；未读到版本时不显示为“未申报”以外的结论。</p> : null}
      </div>

      <div>
        <div className="mb-1.5 text-xs font-semibold text-muted-foreground">资金与报价构成</div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border bg-muted/30 p-2.5">
            <span className="block text-[11px] text-muted-foreground">资源金额（冻结报价）</span>
            <span className="mt-0.5 block text-sm font-bold tabular-nums text-primary">{resourceTotal ? `¥${formatAmount(resourceTotal.amount)}` : "未提供"}</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">资料版本保存值，非下单应付</span>
          </div>
          <div className="rounded-lg border bg-muted/30 p-2.5">
            <span className="block text-[11px] text-muted-foreground">{historical ? "押金" : "押金（号主申报）"}</span>
            <span className="mt-0.5 block text-sm font-semibold tabular-nums">{rowDepositText(row)}</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">{!row.summary?.baseDeposit && historical ? "历史来源值，不替代当前申报或应付" : "基础申报押金，不含会员个性化减免"}</span>
          </div>
          <div className="rounded-lg border bg-muted/30 p-2.5">
            <span className="block text-[11px] text-muted-foreground">号主保证金</span>
            <span className="mt-0.5 block text-sm font-semibold">{rowGuaranteeRequirementText(row)}</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">{rowGuaranteeEligibilityText(row)}</span>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">{rowGuaranteeProofText(row)}</p>
      </div>

      {inventory.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-muted-foreground">
            <span>物品与装备资源 ({inventory.length} 种)</span>
          </div>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto rounded-lg border bg-muted/20 p-2">
            {inventory.map(item => (
              <span key={item.itemId} className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1 text-xs font-medium text-foreground shadow-2xs">
                <span>{item.itemId}</span>
                {item.quantity && <span className="font-mono text-muted-foreground">x{item.quantity}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type QuickProps = { row: SupplyWorkItem; canRead: boolean; canRestrict: boolean; canOrders: boolean; onClose: () => void; onOpenFull: (context: string) => void };
/** 快速判断：结论 + 需要处理 + 折叠的已满足/待核 + 资料摘要；完整核对与风险操作在对象页。 */
export function QuickView({ row, canRead, canRestrict, canOrders, onClose, onOpenFull }: QuickProps) {
  const [detail, setDetail] = useState<SupplyWorkDetail>(), [error, setError] = useState<string>(), [note, setNote] = useState(""), title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!canRead) { onClose(); return; } const c = new AbortController(); setDetail(undefined); setError(undefined);
    adminRequest<SupplyWorkDetail>("/supply/listing-reviews/" + encodeURIComponent(row.id) + "?queryVersion=3", undefined, "GET", {}, c.signal).then(d => { if (!c.signal.aborted) setDetail(d); }).catch(e => { if (!c.signal.aborted) setError(friendlyError(e)); });
    return () => c.abort(); }, [row.id, canRead]);
  useEffect(() => { title.current?.focus(); }, [row.id]);
  if (!canRead) return null;
  const facts = detail?.supervision.facts ?? row.facts, g = groupConditions(facts), v = detail?.version, hist = detail?.supervision.restrictionHistory, orders = detail?.supervision.orders;
  const copy = (text: string, done: string) => { void navigator.clipboard?.writeText(text).then(() => setNote(done), () => setNote("剪贴板不可用")); };
  const verdict = facts.newOrders === null ? "新单资格待核" : facts.newOrders ? "可接新单" : "不可接新单";
  const soft = facts.newOrders ? "bg-emerald-500/10" : "bg-amber-500/10";
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
  <SheetContent side="right" showCloseButton={false} initialFocus={title} finalFocus={false} aria-labelledby="qv-title" data-quick-view="" className="w-full gap-0 bg-background data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
    <div className="border-b px-5 pt-4 pb-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">账号快速查看 · 资产速查</span>
        <div className="flex items-center gap-1">
          {canRestrict && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="风险操作"><MoreHorizontal/></Button>}/>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>风险操作</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => onOpenFull("review")}>
                    {facts.staffRestricted ? "复核已有限制" : "新增运营限制"}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="关闭快速查看" onClick={onClose}><X/></Button>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <h2 id="qv-title" ref={title} tabIndex={-1} className="text-lg font-semibold outline-none">{row.title ?? "资料未提供"}</h2>
        <Button variant="ghost" size="icon-xs" aria-label="复制内部 ID" title={row.accountId} onClick={() => copy(row.accountId, "已复制内部 ID")} className="text-muted-foreground"><Copy className="size-3.5"/></Button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <IdLine row={row}/>
        <span className="text-xs text-muted-foreground">·</span>
        <StatusBadge facts={facts}/>
      </div>
    </div>
    <div className="flex-1 overflow-y-auto px-5 pb-4">
      <div className={"mt-3 rounded-lg px-4 py-3 " + soft}>
        <div className="font-semibold">{verdict}<span className="mx-2 opacity-40">·</span><span className="font-medium">{g.blocked.length} 项已确认阻塞{g.pending.length ? "、" + g.pending.length + " 项待核" : ""}</span></div>
        <div className="text-xs text-muted-foreground">各条件独立，解除一项不代表账号可以接单。</div>
      </div>
      {error && <Alert variant="warning" className="mt-3"><CircleAlert aria-hidden="true" /><AlertTitle>详情未读到</AlertTitle><AlertDescription><p>{error}</p><p>以下仍为列表已读取的事实。</p></AlertDescription></Alert>}

      <QuickViewAssetSummary row={row} detail={detail} />

      <h3 className="mt-4 mb-1 text-sm font-semibold">需要处理 · {g.blocked.length} 项</h3>
      {g.blocked.length ? (
        <ul className="divide-y rounded-lg border px-3">
          {g.blocked.map(c => (
            <li key={c.code} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span><span className="mr-2 inline-block size-1.5 -translate-y-0.5 rounded-full bg-amber-500" aria-hidden="true"/>{condText(c.code)}</span>
              <span className="text-xs text-muted-foreground">{c.who}</span>
            </li>
          ))}
        </ul>
      ) : <p className="py-2 text-sm text-muted-foreground">没有已确认阻塞</p>}

      <div className="mt-2 flex items-center justify-between border-t py-2.5">
        <span className="text-sm font-medium">已满足 · {g.satisfied.length} 项</span>
        <span className="text-xs text-muted-foreground">{g.satisfied.join("、") || "—"}</span>
      </div>

      <Collapsible className="border-t">
        <CollapsibleTrigger disabled={!g.pending.length} className="group flex w-full items-center justify-between rounded-sm py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="text-sm font-medium">待核 · {g.pending.length} 项</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {g.pending.length ? "展开" : "暂无待核项"}
            {g.pending.length > 0 && <ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"/>}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {g.pending.map(c => (
            <div key={c.code} className="flex justify-between gap-3 py-1.5 pl-4 text-sm">
              <span>{condText(c.code)}</span>
              <span className="text-xs text-muted-foreground">{c.who}</span>
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>

      <div className="mt-4 border-t pt-3">
        <h3 className="mb-2 text-sm font-semibold">当前资料 <span className="ml-1 text-xs font-normal text-muted-foreground">{v ? versionText(v.sequence) + " · " + reviewStateLabel(v.reviewState) : detail ? "版本未提供" : error ? "详情未读到" : "读取中…"}</span></h3>
        {detail ? <AccountFacts version={v}/> : <p className="text-sm text-muted-foreground">{error ? "详情未读到，属性、押金与报价暂不可核对。" : "正在读取属性、押金与报价…"}</p>}
      </div>

      <div className="mt-3 border-t">
        <EntryRow label="关联订单" value={!detail ? error ? "详情未读到" : "读取中…" : !canOrders || orders?.state === "DENIED" ? "无订单读取权限" : orders?.items?.length ? "当前范围 " + (orders.total ?? orders.items.length) + " 条" : "当前授权范围内未匹配订单"} onClick={() => onOpenFull("orders")}/>
        <EntryRow label="操作记录" value={!hist ? error ? "详情未读到" : "读取中…" : hist.state === "NOT_RECORDED" ? "限制历史未提供" : hist.items.length ? "最近 " + hist.items.length + " 条" : "最近 " + hist.limit + " 条内无限制事件"} onClick={() => onOpenFull("records")}/>
      </div>
      {note && <p role="status" className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </div>
    <div className="sticky bottom-0 grid grid-cols-2 gap-2 border-t bg-background px-5 py-3">
      <Button size="lg" variant="outline" onClick={() => copy(summaryText(row, detail), "核对摘要已复制，未自动发送")}>复制核对摘要</Button>
      <Button size="lg" onClick={() => onOpenFull("situation")}>打开完整详情</Button>
    </div>
  </SheetContent></Sheet>;
}

function EntryRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return <Button type="button" variant="ghost" onClick={onClick} className="h-auto w-full justify-between gap-3 rounded-none border-b px-0 py-3 text-left whitespace-normal"><span className="font-medium">{label}</span><span className="flex items-center gap-1 text-xs text-muted-foreground">{value}<ChevronRight size={14}/></span></Button>;
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
