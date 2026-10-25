import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert, Copy, Eye, MoreHorizontal, X } from "lucide-react";
import { adminRequest, friendlyError } from "../../api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InlineStatus } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuGroup, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SupplySelect } from "@/components/supply/supply-select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { newOrdersStatus, supplyObjectLabel, attributeFacts, historicalReadSummary, historicalResourceText, inventoryRows, formatAmount, formatFundingCents, quantityText, quoteLineFacts, type SupplyQueryKind, type SupplyWorkDetail, type SupplyWorkItem } from "../supply-review/model";
import {
  fullShanghaiTime,
  KIND_LABELS,
  compactTime,
  alignedQuickRow,
  groupConditions,
  kindHint,
  newOrdersReasonText,
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
export function MoreFilters() {
  return null;
}

export function StatusBadge({ facts }: { facts: SupplyWorkItem["facts"] }) {
  const status = newOrdersStatus(facts);
  return <InlineStatus tone={status.tone}>{status.label}</InlineStatus>;
}
export function ReasonCell({ facts, onMore }: { facts: SupplyWorkItem["facts"]; onMore: () => void }) {
  const { code, others } = primaryReason(facts);
  if (!code) return <span className="text-sm text-muted-foreground">{newOrdersReasonText(facts.newOrders)}</span>;
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

type QuickProps = { row: SupplyWorkItem; canRead: boolean; onClose: () => void; onOpenFull: (context: string) => void };
/** 快速核对：身份/状态、基本属性与使用条件、全部申报资源、同版基础费用；历史折叠，完整处置在对象页。 */
export function QuickView({ row, canRead, onClose, onOpenFull }: QuickProps) {
  const [detail, setDetail] = useState<SupplyWorkDetail>(), [error, setError] = useState<string>();
  useEffect(() => { if (!canRead) { onClose(); return; } const c = new AbortController(); setDetail(undefined); setError(undefined);
    adminRequest<SupplyWorkDetail>("/supply/listing-reviews/" + encodeURIComponent(row.id) + "?queryVersion=3", undefined, "GET", {}, c.signal).then(d => { if (!c.signal.aborted) setDetail(d); }).catch(e => { if (!c.signal.aborted) setError(friendlyError(e)); });
    return () => c.abort(); }, [row.id, canRead]);
  if (!canRead) return null;
  const facts = detail?.supervision.facts ?? row.facts, g = groupConditions(facts), v = detail?.version, viewed = alignedQuickRow(row, detail);
  const historical = detail?.supervision.facts.historicalRead ?? row.facts.historicalRead;
  const attrs = v ? attributeFacts(v) : [], inventory = v ? inventoryRows(v, null) : [], lines = v ? quoteLineFacts(v) : [];
  const verdict = facts.newOrders === null ? "新单资格待核" : facts.newOrders ? "可接新单" : "不可接新单";
  const guarantee = rowGuaranteeCondensed(row);
  const releaseId = v?.releaseId ?? null;
  const ratio = v?.quote?.baseRenterHaffRatioWanPerYuan ?? null;
  const declared = v?.declaration.attributes ?? {};
  const deposit = declared.owner_deposit_declaration as Record<string, unknown> | undefined;
  const depositText = v && deposit?.schema === "owner-deposit-declaration-v1" && typeof deposit.amountCents === "string" && /^(0|[1-9]\d*)$/.test(deposit.amountCents)
    ? formatFundingCents(deposit.amountCents) : rowDepositText(viewed);
  const payout = declared.full_payout_declaration as Record<string, unknown> | undefined;
  const payoutLabel = v ? (payout?.selected === true ? "已选" : payout?.selected === false ? "未选" : "未申报") : rowFullPayout(viewed).label;
  const haffLine = v ? v.declaration.inventory.find(item => item.itemId === "haff" || v.presentation.items?.find(entry => entry.id === item.itemId)?.unit === "HAFF_BASE") : null;
  const haffText = haffLine ? quantityText(haffLine.quantity) : rowHaffText(viewed);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
  <DialogContent showCloseButton={false} aria-labelledby="qv-title" data-quick-view="" className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
    <header className="border-b px-5 pb-3 pt-4">
      <DialogTitle id="qv-title" className="text-lg font-semibold">{row.title ?? "资料未提供"}</DialogTitle>
      <DialogDescription className="sr-only">账号基本信息、申报资源与同版基础费用速览</DialogDescription>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <IdLine row={row}/>
        <span className="text-xs text-muted-foreground">·</span>
        <StatusBadge facts={facts}/>
        <span className="text-xs text-muted-foreground">· {verdict}{g.blocked.length ? ` · ${g.blocked.length} 项已确认阻塞` : ""}{g.pending.length ? `、${g.pending.length} 项待核` : ""}</span>
      </div>
    </header>
    <div className="max-h-[calc(100dvh-14rem)] overflow-y-auto px-5 py-4">
      {error && <Alert variant="warning" role="status" className="mb-3"><CircleAlert aria-hidden="true" /><AlertTitle>详情未读到</AlertTitle><AlertDescription><p>{error}</p><p>以下仍为列表已读取的事实。</p></AlertDescription></Alert>}
      {!detail && !error ? <p className="mb-3 text-sm text-muted-foreground" aria-busy="true">正在读取当前资料…</p> : null}

      <section className="border-t pt-3 first:border-t-0 first:pt-0">
        <h3 className="mb-2 text-sm font-semibold">基本属性与使用条件</h3>
        {v ? <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">{attrs.map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className={fact.unconfirmed ? "text-amber-700 dark:text-amber-400" : ""}>{fact.value}</dd></div>)}<div><dt className="text-xs text-muted-foreground">全额包赔</dt><dd>{payoutLabel}</dd></div></dl> : <p className="text-sm text-muted-foreground">{error ? "详情未读到，属性暂不可核对。" : "正在读取属性…"}</p>}
      </section>

      <section className="mt-4 border-t pt-3">
        <h3 className="mb-2 text-sm font-semibold">哈夫币与已申报物资 <span className="ml-1 text-xs font-normal text-muted-foreground">{v ? `第 ${v.sequence} 版全部申报` : "列表摘要"}</span></h3>
        <p className="mb-2 text-sm">哈夫币：<span className="font-mono font-semibold tabular-nums text-amber-900 dark:text-amber-300">{haffText}</span></p>
        {v ? (inventory.length ? <Table className="text-sm"><TableHeader><TableRow><TableHead>物品</TableHead><TableHead className="text-right">申报数量</TableHead></TableRow></TableHeader><TableBody>{inventory.map(item => <TableRow key={item.itemId}><TableCell className="whitespace-normal">{item.name}</TableCell><TableCell className="text-right tabular-nums">{item.current} {item.unit}</TableCell></TableRow>)}</TableBody></Table> : <p className="text-sm text-muted-foreground">本版未申报物资；不代表没有该物品。</p>) : <p className="text-sm text-muted-foreground">{error ? "详情未读到，完整物资表暂不可核对。" : "正在读取完整物资表…"}</p>}
      </section>

      <section className="mt-4 border-t pt-3">
        <h3 className="mb-2 text-sm font-semibold">同版基础费用</h3>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">资源费（资料版冻结参考）</dt><dd className="tabular-nums">{v?.quote ? `¥${formatAmount(v.quote.resourceTotal.amount)}` : rowQuoteText(viewed).total}</dd></div>
          <div><dt className="text-xs text-muted-foreground">租客基础押金（号主申报）</dt><dd className="tabular-nums">{depositText}</dd></div>
          <div><dt className="text-xs text-muted-foreground">全额包赔</dt><dd>{payoutLabel}</dd></div>
          {guarantee ? <div><dt className="text-xs text-muted-foreground">号主保证金</dt><dd>{guarantee}</dd></div> : null}
          <div><dt className="text-xs text-muted-foreground">规则版本</dt><dd className="break-all">{releaseId ?? "未提供"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">基础客价比例</dt><dd>{ratio ? `${ratio} 万哈夫币/元` : "未提供"}</dd></div>
        </dl>
        {lines.length ? <div className="mt-2 overflow-x-auto"><Table className="text-xs"><TableHeader><TableRow><TableHead>参考行</TableHead><TableHead>计价基数</TableHead><TableHead>参考单价</TableHead><TableHead className="text-right">原行金额</TableHead></TableRow></TableHeader><TableBody>{lines.map(line => <TableRow key={line.itemId}><TableCell className="whitespace-normal">{line.name} · {line.quantity}</TableCell><TableCell className="tabular-nums">{line.unitQuantity ?? "未提供"}</TableCell><TableCell className="tabular-nums">{line.buyerUnitAmount ? `¥${formatAmount(line.buyerUnitAmount)}` : "未提供"}</TableCell><TableCell className="text-right tabular-nums">{line.amount ? `¥${formatAmount(line.amount)}` : "未提供"}</TableCell></TableRow>)}</TableBody></Table></div> : null}
        <p className="mt-2 text-xs text-muted-foreground">资料版本保存值，非按当前规则重新试算，也不是下单应付；租客档位口径未提供，会员个性化金额不在列表推断。</p>
      </section>

      {historical ? <Collapsible className="mt-4 border-t pt-3">
        <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-sm text-left text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">历史来源记录（仅参考）<ChevronDown className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"/></CollapsibleTrigger>
        <CollapsibleContent keepMounted data-historical-summary="" className="pt-2 data-[closed]:hidden">
          <p className="text-xs text-muted-foreground">{historicalReadSummary(historical)}</p>
          {historical.display?.state === "KNOWN" && historical.display.facts?.sourceUpdatedAt ? <p className="text-xs text-muted-foreground">来源更新：<TimeText iso={historical.display.facts.sourceUpdatedAt} label="历史来源更新时间"/></p> : null}
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">历史租金</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.haffRentYuan)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">历史物资费</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.goodsYuan)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">历史押金</dt><dd className="tabular-nums">¥{formatAmount(historical.historicalQuote.depositYuan)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">历史租期</dt><dd>{historical.historicalQuote.termDays} 天</dd></div>
          </dl>
          {historical.display?.state === "KNOWN" && Array.isArray(historical.display.facts?.resources) ? <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">{historical.display.facts.resources.map(resource => <li key={resource.code}>{resource.name}：{historicalResourceText(resource)}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">历史扩展资料尚待接入，缺失数量不按零显示。</p>}
          <p className="mt-2 text-xs text-muted-foreground">历史记录不代表当前报价、下单应付或可租资格。</p>
        </CollapsibleContent>
      </Collapsible> : null}
    </div>
    <footer className="flex items-center justify-end gap-2 border-t bg-background px-5 py-3">
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
