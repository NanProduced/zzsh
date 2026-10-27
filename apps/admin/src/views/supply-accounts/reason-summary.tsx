import { ChevronDown } from "lucide-react";
import { Badge, InlineStatus, type InlineStatusTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { attributeFacts, blockerLabel, formatAmount, formatFundingCents, formatTermDays, quantityText, quoteLineFacts, type SupplyFacts, type Version } from "../supply-review/model";
import { conditionHeadline, groupConditions } from "./account-list-model";

const PENDING_TEXT: Record<string, string> = { PUBLIC_UNKNOWN: "公开状态待核", NEW_ORDERS_UNKNOWN: "新单资格待核", RESTRICTION_UNKNOWN: "运营限制待核", PAUSE_UNKNOWN: "号主暂停待核" };
export const condText = (code: string) => PENDING_TEXT[code] ?? (code === "OCCUPIED" ? "占用中" : code === "RULE_CHANGED" ? "需按新规则核价" : blockerLabel(code));

/** 抽屉与完整详情共用的接单原因摘要：已确认阻塞 / 待核 / 已满足，每项写明下一步。 */
export function ReasonSummary({ facts, heading = "能不能接新单" }: { facts: SupplyFacts; heading?: string }) {
  const g = groupConditions(facts);
  return <div className="sa-reasons" data-testid="reason-summary">
    <h3 className="mb-1 text-[15px] font-semibold">{heading} <span className="text-xs font-normal text-muted-foreground">{conditionHeadline(g, facts.newOrders)}</span></h3>
    <Group title="已确认阻塞" empty="无已确认阻塞" items={g.blocked.map(c => [condText(c.code), c.who])} tone="error"/>
    <Group title="待核" empty="无待核条件" items={g.pending.map(c => [condText(c.code), c.who])} tone="unknown"/>
    <Group title="已满足" empty="—" items={g.satisfied.map(t => [t, ""])} tone="success"/>
    <p className="mt-2 text-xs text-muted-foreground">各项独立读取，解除其中一项不代表可接新单。</p>
  </div>;
}
function Group({ title, items, empty, tone }: { title: string; items: string[][]; empty: string; tone: InlineStatusTone }) {
  return <div className="mt-2"><div className="text-xs text-muted-foreground">{title} · {items.length}</div>{items.length ? <ul className="text-sm">{items.map(([t, next]) => <li key={t} className="flex justify-between gap-3 border-b border-dashed py-1.5 last:border-0"><InlineStatus tone={tone} className="text-sm font-normal">{t}</InlineStatus>{next && <span className="shrink-0 text-xs text-muted-foreground">下一步：{next}</span>}</li>)}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}</div>;
}

const obj = (v: unknown) => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
/** 详情合同里可读的资料、押金申报与报价；缺失项合并成一条说明。 */
export function AccountFacts({ version }: { version: Version | null | undefined }) {
  if (!version) return <p className="text-sm text-muted-foreground">当前资料版本未提供，不显示属性、押金与报价。</p>;
  const attrs = attributeFacts(version).filter(a => a.value !== "未申报");
  const haff = version.declaration.inventory.find(i => i.itemId === "haff" || version.presentation.items?.find(p => p.id === i.itemId)?.unit === "HAFF_BASE");
  const dep = obj(version.declaration.attributes.owner_deposit_declaration), fp = obj(version.declaration.attributes.full_payout_declaration);
  const q = version.quote;
  return <div className="sa-facts">
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
      {attrs.map(a => <div key={a.label}><dt className="text-xs text-muted-foreground">{a.label}</dt><dd className={a.unconfirmed ? "text-amber-700 dark:text-amber-400" : "font-medium"}>{a.value}</dd></div>)}
      {haff && <div><dt className="text-xs text-muted-foreground">哈夫币库存</dt><dd className="font-medium">{quantityText(haff.quantity)}</dd></div>}
      <div><dt className="text-xs text-muted-foreground">押金（号主申报）</dt><dd className="font-medium tabular-nums">{dep && typeof dep.amountCents === "string" ? formatFundingCents(dep.amountCents) : "未申报"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">全额包赔</dt><dd className="font-medium">{fp && typeof fp.selected === "boolean" ? (fp.selected ? "已选" : "未选") : "未申报"}</dd></div>
      <div><dt className="text-xs text-muted-foreground">资料版本报价（资源金额）</dt><dd className="font-medium tabular-nums">{q ? "¥" + formatAmount(q.resourceTotal.amount) + " · " + formatTermDays(q.termSeconds) : "未提供"}</dd></div>
    </dl>
    {q && <p className="mt-2 text-xs text-muted-foreground">来自资料第{version.sequence}版中保存的报价，非按当前规则重新试算。规则组合：{version.releaseId ?? "未提供"}；租客档位口径未提供，不能作为当前下单报价。</p>}
    <p className="mt-2 text-xs text-muted-foreground">暂未提供：押金是否在当前上限内（只返回资金待核原因）、租客价/号主得分项、每单押金、已确认规则版本。{attrs.length === 0 ? "号主未申报属性。" : ""}</p>
  </div>;
}

export type CheckTarget = { label: string; go: () => void } | null;
/** 完整详情「接单条件核查」：计数 + 条件/下一步/核对 表，每个阻塞一行；已满足、待核折叠。 */
export function ConditionCheck({ facts, target }: { facts: SupplyFacts; target: (code: string) => CheckTarget }) {
  const g = groupConditions(facts);
  const chip = (t: string, n: number, v: "warning" | "unknown" | "success") => <Badge variant={v}>{t} {n}</Badge>;
  const row = (code: string, who: string, pending = false) => { const t = target(code); return <TableRow key={code}><TableCell className="py-2 pr-3 whitespace-normal"><span className={"mr-2 inline-block size-1.5 -translate-y-0.5 rounded-full " + (pending ? "bg-muted-foreground/60" : "bg-amber-500")} aria-hidden="true"/>{condText(code)}</TableCell><TableCell className="py-2 pr-3 whitespace-normal text-muted-foreground">{who}</TableCell><TableCell className="py-2 text-right">{t ? <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={t.go}>{t.label}<span aria-hidden="true" className="text-muted-foreground">›</span></Button> : <span className="text-xs text-muted-foreground">—</span>}</TableCell></TableRow>; };
  return <Card className="px-4" aria-labelledby="cc-title" role="region">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="cc-title" className="text-base font-semibold">接单条件核查</h2><div className="flex flex-wrap gap-1.5">{chip("已确认阻塞", g.blocked.length, "warning")}{chip("待核", g.pending.length, "unknown")}{chip("已满足", g.satisfied.length, "success")}</div></div>
    <Table><TableHeader><TableRow><TableHead className="text-xs font-normal text-muted-foreground">条件</TableHead><TableHead className="text-xs font-normal text-muted-foreground">下一步</TableHead><TableHead className="text-right text-xs font-normal text-muted-foreground">核对</TableHead></TableRow></TableHeader>
      <TableBody>{g.blocked.map(c => row(c.code, c.who))}{!g.blocked.length && <TableRow><TableCell colSpan={3} className="py-2 text-muted-foreground">没有已确认阻塞</TableCell></TableRow>}</TableBody></Table>
    <div className="rounded-lg bg-muted/50 px-3 py-2"><span className="font-medium">已满足 {g.satisfied.length} 项</span><span className="ml-3 text-xs text-muted-foreground">{g.satisfied.join(" / ") || "—"}</span></div>
    <Collapsible className="rounded-lg bg-muted/50 px-3"><CollapsibleTrigger disabled={!g.pending.length} className="group flex w-full items-center justify-between py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"><span><span className="font-medium">待核 {g.pending.length} 项</span>{!g.pending.length && <span className="ml-3 text-xs text-muted-foreground">暂无待核项</span>}</span>{g.pending.length > 0 && <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180"/>}</CollapsibleTrigger><CollapsibleContent className="pb-2">{g.pending.length > 0 && <Table className="mt-1"><TableBody>{g.pending.map(c => row(c.code, c.who, true))}</TableBody></Table>}</CollapsibleContent></Collapsible>
    <p className="text-xs text-muted-foreground">各条件独立读取，解除单项条件不代表账号可以接单。</p>
  </Card>;
}

/** 当前资料键值卡（右栏）。 */
export function FactsCard({ version }: { version: Version | null | undefined }) {
  const kv = (k: string, v: string) => <div key={k} className="flex justify-between gap-3 border-t py-1.5 first:border-0"><dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd></div>;
  const dep = obj(version?.declaration.attributes.owner_deposit_declaration), fp = obj(version?.declaration.attributes.full_payout_declaration), q = version?.quote;
  const term = version?.termOption;
  return <Card className="gap-2 px-4"><div className="flex items-center justify-between"><h2 className="text-base font-semibold">当前资料</h2><span className="text-xs text-muted-foreground">{version ? "第" + version.sequence + "版" : "版本未提供"}</span></div>
    {version ? <dl className="text-sm">{kv("上号时间", version.attributeDisplay?.serviceWindow?.displayName ?? "未确认")}{attributeFacts(version).filter(fact => ["本人脸声明", "封禁记录声明", "小段位"].includes(fact.label)).map(fact => kv(fact.label, fact.value))}{kv("每日消耗", term?.dailyConsumption ? quantityText(term.dailyConsumption.quantity) : "未确认")}{kv("号主申报押金", dep && typeof dep.amountCents === "string" ? formatFundingCents(dep.amountCents) : "未申报")}{kv("全额包赔", fp && typeof fp.selected === "boolean" ? (fp.selected ? "已选" : "未选") : "未申报")}{kv("报价", q ? "¥" + formatAmount(q.resourceTotal.amount) + " · " + formatTermDays(q.termSeconds) : "未提供")}</dl> : <p className="mt-2 text-sm text-muted-foreground">当前资料版本未提供。</p>}
    {version && quoteLineFacts(version).length ? <ul className="text-xs text-muted-foreground">{quoteLineFacts(version).map(line => <li key={line.itemId}>{line.name} · {line.quantity}{line.amount ? ` · ¥${formatAmount(line.amount)}` : ""}</li>)}</ul> : null}
    {q && <p className="text-xs text-muted-foreground">报价依据：资料第{version!.sequence}版保存值 · 规则 {version!.releaseId ?? "版本未提供"}；非当前规则重新试算，租客档位口径未提供。</p>}
    <p className="text-xs text-muted-foreground">暂未提供：押金上限核验、每单押金、已确认规则版本。声明不是平台核验。</p></Card>;
}
