import { useEffect, useState } from "react";
import type React from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import type { PriceVersionRecord, RulesResponse } from "../../api";
import { friendlyError } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { draftCommand, RULES_RELEASE_OPERATION, type useRulesWrite } from "./rules-write";
import { centsYuan, safeBoxLabel, skinSummary, unitYuan } from "./rules-model";
import { sourcePriceVersion } from "./price-draft";
import { sealChecks } from "./step0-editors";

type Command = ReturnType<typeof useRulesWrite>;
export type PublishStage = "unsaved" | "draft" | "sealed" | "live";
type Section = "pricing" | "items" | "skin" | "deposit";

/** 服务端只回 createdAt + revision：本机看到 revision 变化时记下时间作为"保存于"；没见过就老实写创建时间。 */
const SAVED_KEY = "supply-rules.draft-saved-at";
export function savedLabel(d: PriceVersionRecord): string {
  let map: Record<string, { revision: string; at: string }> = {};
  try { map = JSON.parse(sessionStorage.getItem(SAVED_KEY) ?? "{}"); } catch { /* ignore */ }
  const seen = map[d.id];
  if (!seen) { map[d.id] = { revision: d.revision, at: "" }; try { sessionStorage.setItem(SAVED_KEY, JSON.stringify(map)); } catch { /* ignore */ } }
  else if (seen.revision !== d.revision) { map[d.id] = { revision: d.revision, at: new Date().toISOString() }; try { sessionStorage.setItem(SAVED_KEY, JSON.stringify(map)); } catch { /* ignore */ } }
  const at = map[d.id]!.at;
  return at ? `保存于 ${fmtTime(at)}` : `创建于 ${fmtTime(d.createdAt)}`;
}
export const fmtTime = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

/** 四种状态统一用彩色小标签：未保存 / 已保存草稿 / 待 Boss 生效 / 已生效。 */
export function StageBadge({ stage, at }: { stage: PublishStage; at?: string | null }) {
  const map = { unsaved: ["warning", "未保存"], draft: ["info", "已保存草稿"], sealed: ["secondary", "待 Boss 生效"], live: ["success", `已生效${at ? ` · ${fmtTime(at)}` : ""}`] } as const;
  const [variant, label] = map[stage];
  return <Badge variant={variant} data-stage={stage}>{label}</Badge>;
}

/** 唯一进行中的价格草稿：取最新一份。 */
export function activePriceDraft(rules: RulesResponse): PriceVersionRecord | undefined {
  // 已提交待生效的版本之前留下的旧草稿不算"进行中"，否则封版后会误把旧空草稿当成编辑目标。
  const s = pendingSealedPrice(rules);
  return rules.priceVersions.filter(v => v.status === "DRAFT" && (!s || v.createdAt > (s.sealedAt ?? ""))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
/** 已提交（封存）但还没生效、且比线上新的价格版本。 */
export function pendingSealedPrice(rules: RulesResponse): PriceVersionRecord | undefined {
  const r = rules.release;
  return rules.priceVersions.filter(v => v.status === "SEALED" && v.id !== r?.priceVersionId && (!r || (v.sealedAt ?? "") > r.activatedAt)).sort((a, b) => (b.sealedAt ?? "").localeCompare(a.sealedAt ?? ""))[0];
}
export function priceStage(rules: RulesResponse, dirty: boolean): PublishStage {
  // 草稿和线上一样时不算「待发布」，避免显示「已保存草稿 · 0 项」。
  const draft = activePriceDraft(rules);
  return dirty ? "unsaved" : draft && priceDiff(rules, draft).length ? "draft" : pendingSealedPrice(rules) ? "sealed" : "live";
}

export type DiffRow = { label: string; before: string; after: string; section: Section; detail?: string };
const MAP: Record<string, [string, (k: string) => string]> = {
  baseBySafeBox: ["保险箱基础比例", k => safeBoxLabel(k)],
  vitalityDeltaByLevel: ["体力加减", k => `${k} 级`],
  bearDeltaByLevel: ["负重加减", k => `${k} 级`],
  dailyDeltaByTermOption: ["每日消耗档加减", k => k],
};
function flat(v: unknown, path: string[] = [], out = new Map<string, string>()) {
  if (v && typeof v === "object") {
    if (Array.isArray(v)) v.forEach((x, i) => { const o = x as Record<string, unknown>; const key = o && typeof o === "object" ? String(o.skinId ?? (o.ownerKind ? `${o.ownerKind}/${o.rarityCode ?? "*"}` : i)) : String(i); flat(x, [...path, key], out); });
    else for (const [k, x] of Object.entries(v)) flat(x, [...path, k], out);
  } else out.set(path.join("."), v === null || v === undefined ? "" : String(v));
  return out;
}
function haffLabel(path: string): [string, Section] {
  const [head = "", key = ""] = path.split(".");
  if (MAP[head]) return [`${MAP[head][0]} · ${MAP[head][1](key ?? "")}`, "pricing"];
  if (path.endsWith("ordinary.spreadDelta")) return ["普通模式利润点", "pricing"];
  if (/fast/i.test(path)) return ["极速模式设置", "pricing"];
  if (/custom/i.test(path)) return ["自定义模式设置", "pricing"];
  return ["租赁定价其它设置", "pricing"];
}
function fundLabel(path: string): [string, Section] {
  if (path.endsWith("capCents") || path.endsWith("upperLimitCents")) return ["押金上限", "deposit"];
  if (/skinRules|skinOverrides/.test(path)) return ["皮肤推荐押金", "skin"];
  if (path === "policyVersion") return ["押金政策", "skin"];
  return ["押金推荐参数", "skin"];
}
const money = (path: string, v: string) => /Cents$/.test(path) && v !== "" ? centsYuan(v) : v === "" ? "未填" : v;

/** 草稿相对线上的逐项改动（人话标签，相同标签合并计数）。 */
export function priceDiff(rules: RulesResponse, target: PriceVersionRecord | undefined): DiffRow[] {
  if (!target) return [];
  const live = rules.priceVersions.find(v => v.id === rules.release?.priceVersionId) ?? sourcePriceVersion(rules);
  const rows: DiffRow[] = [];
  const std = (id?: string) => rules.priceLines.filter(l => l.priceVersionId === id && (l.customerTier ?? "STANDARD") === "STANDARD");
  const targetLines = std(target.id);
  if (targetLines.length) for (const l of targetLines) {
    const c = std(live?.id).find(x => x.itemId === l.itemId);
    const name = rules.items.find(i => i.id === l.itemId)?.name ?? "物资";
    if ((c?.buyerUnitAmount ?? "") !== (l.buyerUnitAmount ?? "") && l.pricingKind === "FIXED_UNIT") rows.push({ label: `${name} · 租客价`, before: c?.buyerUnitAmount ? unitYuan(c.buyerUnitAmount) : "未配置", after: l.buyerUnitAmount ? unitYuan(l.buyerUnitAmount) : "未配置", section: "items" });
    if ((c?.ownerUnitAmount ?? "") !== (l.ownerUnitAmount ?? "") && l.pricingKind === "FIXED_UNIT") rows.push({ label: `${name} · 号主价`, before: c?.ownerUnitAmount ? unitYuan(c.ownerUnitAmount) : "未配置", after: l.ownerUnitAmount ? unitYuan(l.ownerUnitAmount) : "未配置", section: "items" });
    if ((c?.unitQuantity ?? "") !== (l.unitQuantity ?? "") && l.pricingKind === "FIXED_UNIT") rows.push({ label: `${name} · 计费数量`, before: c?.unitQuantity ?? "—", after: l.unitQuantity ?? "—", section: "items" });
  }
  // Owner 决定只保留普通档：线上的会员/折扣档位行在新版本里会被移除，必须明示。
  if (targetLines.length) {
    const removed = rules.priceLines.filter(l => l.priceVersionId === live?.id && (l.customerTier ?? "STANDARD") !== "STANDARD" && !rules.priceLines.some(t => t.priceVersionId === target.id && t.itemId === l.itemId && t.customerTier === l.customerTier)).length;
    if (removed) rows.push({ label: "会员价行", before: `${removed} 行`, after: "将移除", section: "items" });
  }
  const cmp = (a: unknown, b: unknown, label: (p: string) => [string, Section]) => {
    if (b === null || b === undefined) return;
    const fa = flat(a), fb = flat(b);
    for (const [p, v] of fb) { const before = fa.get(p) ?? ""; if (before !== v && !/schema|algorithm|version$|inputSpec/.test(p)) { const [l, s] = label(p); rows.push({ label: l, before: money(p, before), after: money(p, v), section: s }); } }
  };
  cmp(live?.haffRule, target.haffRule, haffLabel);
  cmp(live?.fundingPolicy, target.fundingPolicy, fundLabel);
  // 同一标签只显示一行：押金上限写两处只算一次；其它多处改动合并成「N 处改动」，不露内部字段。
  const out: DiffRow[] = [];
  for (const r of rows) {
    const same = rows.filter(x => x.label === r.label);
    if (out.some(x => x.label === r.label)) continue;
    const plain = /^-?[\d.,¥]+$|^未填$|^\d+ 行$|^将移除$/;
    if (r.label === "皮肤推荐押金") { out.push({ ...r, before: skinSummary(live?.fundingPolicy?.recommendation), after: skinSummary(target.fundingPolicy?.recommendation) }); continue; }
    if (r.label === "押金政策") { out.push({ ...r, before: "", after: "更新为新版", detail: `版本 ${r.before || "无"} → ${r.after}` }); continue; }
    out.push(same.length > 1 && r.label !== "押金上限" ? { ...r, before: "", after: `${same.length} 处改动` } : plain.test(r.after) && plain.test(r.before) ? r : { ...r, before: "", after: "已修改" });
  }
  return out;
}

export type ActivationReceipt = { at: string; changes: DiffRow[] };

const SECTION_NAME: Record<Section, string> = { pricing: "租赁定价", items: "物资价目", skin: "皮肤推荐押金", deposit: "押金规则" };

/** 页顶一行：状态标签 + 待发布修改 (N)。点开右侧抽屉看改动、检查、提交和生效。 */
export function PublishBar({ rules, command, dirty, isBoss, canEdit, onOpenSection }: { rules: RulesResponse; command: Command; dirty: boolean; isBoss: boolean; canEdit: boolean; onOpenSection: (s: Section) => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"seal" | "activate" | null>(null);
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [receipt, setReceipt] = useState<ActivationReceipt | null>(null);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(undefined), 4000); return () => clearTimeout(t); }, [toast]);
  const draft = activePriceDraft(rules);
  const sealed = pendingSealedPrice(rules);
  const draftRows = priceDiff(rules, draft);
  const sealedRows = priceDiff(rules, sealed);
  const checks = sealChecks(rules, draft);
  const checksOk = checks.every(c => c.ok);
  const count = draft ? draftRows.length : sealed ? sealedRows.length : 0;
  const stage = priceStage(rules, dirty);
  const release = rules.release;
  const go = (s: Section) => { setOpen(false); onOpenSection(s); };

  const seal = async () => {
    if (!draft) return;
    setError(undefined);
    try {
      const r = await command.write(draftCommand(rules.game.id, "price", "seal", { expectedRevision: draft.revision }, draft.id));
      if (!r) return;
      setToast(isBoss ? "已提交。请核对后点“确认生效”。" : "已提交，等待 Boss 生效。");
    } catch (failure) { setError(friendlyError(failure)); }
  };
  const activate = async () => {
    if (!sealed || !release) return;
    setError(undefined);
    const changes = sealedRows;
    try {
      const r = await command.write({ operation: RULES_RELEASE_OPERATION, resourceId: rules.game.id, gameId: rules.game.id, path: "/supply/releases", method: "POST", body: { gameId: rules.game.id, priceVersionId: sealed.id, termVersionId: release.termVersionId, agreementVersionId: release.agreementVersionId, expectedGeneration: release.generation } });
      if (!r) return;
      setReceipt({ at: r.fresh.release?.activatedAt ?? new Date().toISOString(), changes });
      setToast("已生效，新订单按新价格计算。");
    } catch (failure) { setError(friendlyError(failure)); }
  };

  const list = (rows: DiffRow[]) => rows.length ? <ul className="divide-y divide-border rounded-md border border-border">{rows.map((r, i) => <li key={i} className={`flex gap-x-3 gap-y-1 px-3 py-2 text-sm ${r.before.length + r.after.length > 24 ? "flex-wrap items-start" : "items-center"}`}><span className={`min-w-24 flex-1 ${r.before.length + r.after.length > 24 ? "basis-full" : ""}`}>{r.label}{r.detail ? <MutedDetails className="mt-1"><p className="text-xs text-muted-foreground">{r.detail}</p></MutedDetails> : null}</span>{r.before ? <><span className="tabular-nums text-muted-foreground line-through">{r.before}</span><span aria-hidden>→</span></> : null}<b className="tabular-nums">{r.after}</b>{canEdit && draft ? <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => go(r.section)}>去改</Button> : null}</li>)}</ul> : <p className="text-sm text-muted-foreground">和线上一样，没有改动。</p>;

  return <>
    <div className="section-panel flex flex-wrap items-center gap-3 py-3" aria-label="发布状态">
      <StageBadge stage={stage} at={stage === "live" ? release?.activatedAt : null} />
      <span className="text-sm text-muted-foreground">{stage === "unsaved" ? "有输入还没保存" : stage === "draft" ? "改动已存草稿，线上还没变" : stage === "sealed" ? (isBoss ? "已提交，等你确认生效" : "已提交，等待 Boss 生效") : "线上规则，直接修改即可，保存时自动存为草稿"}</span>
      <Button type="button" variant={count ? "default" : "outline"} size="sm" className="ml-auto" onClick={() => setOpen(true)}>待发布修改（{count}）</Button>
    </div>
    {toast ? <div role="status" className="fixed bottom-6 right-6 z-50 rounded-md bg-foreground px-4 py-2 text-sm text-background shadow-lg">{toast}</div> : null}
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" closeLabel="关闭" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader><SheetTitle>待发布修改</SheetTitle><SheetDescription>保存的改动先进草稿；提交后锁定，Boss 确认生效后才替换线上。</SheetDescription></SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {receipt ? <section className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3" aria-label="生效回执"><div className="flex items-center gap-2"><StageBadge stage="live" at={receipt.at} /><span className="text-sm font-medium">已生效</span></div><p className="text-xs text-muted-foreground">生效时间 {fmtTime(receipt.at)}。之后的新订单按新价格；已有订单不变。</p>{list(receipt.changes)}</section> : null}
          {draft ? <section className="space-y-3" aria-label="草稿改动">
            <div className="flex items-center gap-2"><StageBadge stage={dirty ? "unsaved" : "draft"} /><h3 className="text-sm font-semibold">草稿改动 {draftRows.length} 项</h3><span className="ml-auto text-xs text-muted-foreground" title={`草稿编号 ${draft.id}`}>{savedLabel(draft)}</span></div>
            {list(draftRows)}
            <div className="space-y-1"><p className="text-xs font-medium">提交前检查</p><ul className="space-y-1 text-sm">{checks.map(c => <li key={c.label} className="flex items-center gap-2"><span className={c.ok ? "text-emerald-600" : "text-destructive"}>{c.ok ? "✓" : "✗"}</span><span className={c.ok ? "text-muted-foreground" : ""}>{c.ok ? c.label : (c.failLabel ?? c.label)}</span>{!c.ok && c.section ? <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => go(c.section!)}>去配置</Button> : null}</li>)}</ul></div>
            {dirty ? <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs">还有输入没保存，先在页面里保存再提交。</p> : null}
            {canEdit ? confirm === "seal" ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"><span className="text-sm">提交后这份草稿锁定，不能再改。</span><Button type="button" size="sm" onClick={() => { setConfirm(null); void seal(); }}>确认提交</Button><Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>取消</Button></div> : <Button type="button" disabled={!checksOk || !draftRows.length || command.locked} onClick={() => setConfirm("seal")}>提交发布</Button> : null}
          </section> : null}
          {sealed ? <section className="space-y-3" aria-label="待生效">
            <div className="flex items-center gap-2"><StageBadge stage="sealed" /><h3 className="text-sm font-semibold">已提交 {sealedRows.length} 项</h3><span className="ml-auto text-xs text-muted-foreground">提交于 {fmtTime(sealed.sealedAt)}</span></div>
            {list(sealedRows)}
            {draft ? <p className="text-xs text-muted-foreground">另有一份新草稿在编辑中，它不会随这次生效。</p> : null}
            {isBoss ? confirm === "activate" ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary p-3"><span className="text-sm">确认后立即替换线上价格，新订单按新价格计算。</span><Button type="button" size="sm" onClick={() => { setConfirm(null); void activate(); }}>确认生效</Button><Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>取消</Button></div> : <Button type="button" disabled={command.locked || !release} onClick={() => setConfirm("activate")}>确认生效</Button> : <p className="text-sm text-muted-foreground">已提交，等待 Boss 生效。</p>}
          </section> : null}
          {!draft && !sealed && !receipt ? <p className="text-sm text-muted-foreground">没有待发布的修改。在{Object.values(SECTION_NAME).join("、")}里直接改，保存后会出现在这里。</p> : null}
          {command.state.kind === "conflict" ? <p role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">刚被别人改过，你的输入已保留。请刷新核对后再操作。</p> : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  </>;
}

/** 协议、包赔条款这类单份文档的阶段：和价格同样四种标签。 */
export function docStage(v: { id: string; status: "DRAFT" | "SEALED"; sealedAt: string | null } | undefined, opts: { dirty: boolean; live: boolean; after?: string | null }): PublishStage | "history" {
  if (!v) return "live";
  if (opts.dirty && v.status === "DRAFT") return "unsaved";
  if (v.status === "DRAFT") return "draft";
  if (opts.live) return "live";
  return !opts.after || (v.sealedAt ?? "") > opts.after ? "sealed" : "history";
}

/** 文档发布行：状态标签 + 一句话 + 操作；生效后显示回执。 */
export function DocStatusRow({ stage, at, note, children, receipt }: { stage: PublishStage | "history"; at?: string | null; note: string; children?: React.ReactNode; receipt?: { at: string; text: string } | null }) {
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2" aria-label="发布状态">{stage === "history" ? <Badge variant="outline">历史版本</Badge> : <StageBadge stage={stage} at={at} />}<span className="text-xs text-muted-foreground">{note}</span><span className="ml-auto flex flex-wrap gap-2">{children}</span></div>
    {receipt ? <div role="status" aria-label="生效回执" className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs"><StageBadge stage="live" at={receipt.at} /><span>{receipt.text}</span></div> : null}
  </div>;
}

/** 灰色小字“详情”折叠：放编号、摘要等备查信息。 */
export function MutedDetails({ label = "详情", children, className = "" }: { label?: string; children: React.ReactNode; className?: string }) {
  return <Collapsible className={`text-xs text-muted-foreground ${className}`}><CollapsibleTrigger render={<Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground" />}>{label}</CollapsibleTrigger><CollapsibleContent className="mt-1">{children}</CollapsibleContent></Collapsible>;
}

/** 版本列表里的时间：提交时间，没有就用创建时间。 */
export const versionTime = (v: { createdAt?: string | null; sealedAt?: string | null }) => { const at = v.sealedAt ?? v.createdAt; return at ? new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""; };
