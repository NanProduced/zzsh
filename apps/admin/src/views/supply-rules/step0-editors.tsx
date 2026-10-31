import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileEdit, Info, Lock } from "lucide-react";
import type { FundingPolicy, PriceVersionRecord, RulesResponse } from "../../api";
import { friendlyError } from "../../api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Field } from "../../components/ui/field";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { draftCommand, type useRulesWrite } from "./rules-write";
import { asHaffV2, centsYuan, safeBoxLabel, unitLabel, unitYuan, yuanInput, type HaffV2 } from "./rules-model";
import { draftHasLines, priceSaveBody, type SealCheck } from "./price-draft";

type Command = ReturnType<typeof useRulesWrite>;
export type EnsureDraft = () => Promise<{ rules: RulesResponse; draft: PriceVersionRecord } | null>;
type EditorProps = { rules: RulesResponse; command: Command; draftId: string; canEdit: boolean; onDirtyChange: (dirty: boolean) => void; ensureDraft: EnsureDraft };

const currentPrice = (rules: RulesResponse) => rules.priceVersions.find(v => v.id === rules.release?.priceVersionId);
/** 比例与加减值：可为负，最多两位小数。 */
const DECIMAL = /^-?\d+(\.\d{1,2})?$/;
/** 金额：非负，最多两位小数。 */
const MONEY = /^\d+(\.\d{1,2})?$/;
/** 服务端要求这三项的计费数量为 1。见 delta-rental DELTA_RESOURCE_UNITS。 */
const LOCKED_UNIT_QUANTITY = new Set(["df_billable_top_insure_card", "df_billable_barrett_bullet", "df_billable_turtle_backpack_45"]);
/** 四舍五入到分。 */
const r2 = (n: number) => Math.round(n * 100 + 1e-9) / 100;

/** 编辑提示：一行，说明现在改的是什么。 */
export function DraftLine({ selected, locked }: { selected: PriceVersionRecord | undefined; locked?: boolean }) {
  if (selected?.status === "SEALED") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-950 dark:text-amber-200" role="status">
        <Lock className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>已提交，等 Boss 确认生效。本版本已锁定为只读；生效后可新建草稿继续修改。</span>
      </div>
    );
  }
  if (locked) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/60 px-3.5 py-2 text-xs text-muted-foreground" role="status">
        <Info className="size-3.5 shrink-0" />
        <span>有一个写入操作正在核对中，暂时不能修改。</span>
      </div>
    );
  }
  if (selected) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3.5 py-2 text-xs text-blue-950 dark:text-blue-200" role="status">
        <FileEdit className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
        <span>正在编辑草稿。保存后仅暂存在草稿中，提交并由 Boss 确认后才替换线上。</span>
      </div>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      显示的是线上生效值；修改后保存将自动创建为新草稿，不影响当前线上运行。
    </p>
  );
}

function useDirty<T>(initial: T, locked: boolean, onDirtyChange: (dirty: boolean) => void) {
  const [value, setValue] = useState<T>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const dirty = JSON.stringify(value) !== baseline;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  // 未改动时跟随服务端最新值；有未保存输入时保留输入（含 409 后重新读取）。
  useEffect(() => { if (dirty || locked) return; setValue(initial); setBaseline(JSON.stringify(initial)); }, [JSON.stringify(initial), dirty, locked]); // eslint-disable-line react-hooks/exhaustive-deps
  return { value, setValue, dirty, markSaved: () => setBaseline(JSON.stringify(value)), reset: () => { setValue(initial); setBaseline(JSON.stringify(initial)); } };
}

/** 金额输入最多两位小数：多打的位数直接不接收。 */
export const MONEY2 = /^\d*(?:\.\d{0,2})?$/;

function Panel({ title, note, more, children }: { title: string; note?: ReactNode; more?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="section-panel space-y-4" aria-label={title}>
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {note ? <div className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{note}</div> : null}
        {more ? (
          <Collapsible open={open} onOpenChange={setOpen} className="mt-1.5">
            <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1" />}>
              <Info className="size-3 shrink-0" />
              <span>{open ? "收起说明" : "计价说明与示例"}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 max-w-3xl rounded-md bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                {more}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function useSave(command: Command) {
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const run = async (body: () => Promise<Parameters<Command["write"]>[0] | null>, ok: string, after: () => void) => {
    setError(undefined); setNotice(undefined);
    try { const cmd = await body(); if (!cmd) return; const result = await command.write(cmd); if (!result) return; after(); setNotice(ok); } catch (failure) { setError(friendlyError(failure)); }
  };
  const messages = <>{error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}{notice ? <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs">{notice}</p> : null}</>;
  return { run, messages };
}

/* ---------------- 基础计价 / 租期与每日消耗（haff-ratio-v2 结构化字段） ---------------- */

type MapKey = "baseBySafeBox" | "vitalityDeltaByLevel" | "bearDeltaByLevel" | "dailyDeltaByTermOption";
const MAP_LABEL: Record<MapKey, { title: string; key: string }> = {
  baseBySafeBox: { title: "保险箱基础比例（号主比例起点）", key: "保险箱" },
  vitalityDeltaByLevel: { title: "体力等级加减", key: "体力等级" },
  bearDeltaByLevel: { title: "负重等级加减", key: "负重等级" },
  dailyDeltaByTermOption: { title: "按每日消耗档加减比例", key: "每日消耗档" },
};
type HaffForm = { maps: Partial<Record<MapKey, Record<string, string>>>; spreadDelta?: string };

export function BasePricingEditor({ rules, command, draftId, canEdit, onDirtyChange, ensureDraft, part }: EditorProps & { part: "base" | "term" }) {
  const selected = rules.priceVersions.find(v => v.id === draftId);
  const current = currentPrice(rules);
  const currentHaff = asHaffV2(current?.haffRule);
  // 未选草稿时用当前生效值只读展示（先看后改）。
  const sourceHaff = selected ? asHaffV2(selected.haffRule) ?? (selected.haffRule === null ? currentHaff : null) : currentHaff;
  const keys: MapKey[] = part === "base" ? ["baseBySafeBox", "vitalityDeltaByLevel", "bearDeltaByLevel"] : ["dailyDeltaByTermOption"];
  const initial = useMemo<HaffForm>(() => sourceHaff ? { maps: Object.fromEntries(keys.map(k => [k, { ...sourceHaff[k] }])), ...(part === "base" ? { spreadDelta: sourceHaff.compatibility.ordinary.spreadDelta } : {}) } : { maps: {} }, [JSON.stringify(sourceHaff), part]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = !canEdit || command.locked || (selected ? selected.status !== "DRAFT" : false) || !sourceHaff; const sealedView = !!selected && selected.status !== "DRAFT";
  const form = useDirty(initial, command.locked, onDirtyChange);
  const save = useSave(command);
  const invalid = Object.values(form.value.maps).some(map => Object.values(map ?? {}).some(v => !DECIMAL.test(v.trim()))) || (form.value.spreadDelta !== undefined && !DECIMAL.test(form.value.spreadDelta.trim()));
  const submit = () => {
    if (!sourceHaff || locked || invalid) return;
    void save.run(async () => {
      const t = await ensureDraft(); if (!t) return null;
      // 以服务端最新草稿规则为底，只覆盖本页签字段；会员档位折扣等隐藏字段原样保留。
      const next: HaffV2 = JSON.parse(JSON.stringify(sourceHaff));
      for (const k of keys) next[k] = Object.fromEntries(Object.entries(form.value.maps[k] ?? {}).map(([key, v]) => [key, v.trim()]));
      if (form.value.spreadDelta !== undefined) next.compatibility.ordinary.spreadDelta = form.value.spreadDelta.trim();
      return draftCommand(t.rules.game.id, "price", "update", priceSaveBody(t.rules, t.draft, { haffRule: next }), t.draft.id);
    }, part === "base" ? "基础计价已保存到草稿。" : "租期每日消耗已保存到草稿。", form.markSaved);
  };
  const setCell = (k: MapKey, key: string, v: string) => form.setValue(prev => ({ ...prev, maps: { ...prev.maps, [k]: { ...prev.maps[k], [key]: v } } }));
  const title = part === "base" ? "基础计价" : "租期每日消耗";
  const keyLabel = (k: MapKey, key: string) => k === "baseBySafeBox" ? `${safeBoxLabel(key)} 保险箱` : k === "dailyDeltaByTermOption" ? rules.termOptions.find(o => o.code === key && o.versionId === rules.release?.termVersionId)?.name ?? key : `${key} 级`;
  const example = useMemo(() => haffExample(rules, currentHaff), [rules, currentHaff]);
  return <Panel title={title} note={part === "base" ? "号主比例＝保险箱基础＋体力＋负重＋每日消耗档；租客比例＝号主比例－利润点。" : "号主比例按每日消耗档加减；可租天数＝哈夫币总量÷每日消耗（向上取整）。"} more={part === "base" ? "比例＝1 元换多少万哈夫币，比例越大哈夫币越便宜。左列是线上值，右列可改，改过的格子会高亮。会员优惠按总价折扣另算。" : undefined}>
    <DraftLine selected={selected} locked={command.locked} />
    {selected && !sourceHaff ? <div className="space-y-2"><p role="status" className="text-xs text-muted-foreground">这份草稿的哈夫币规则是旧写法，这里只能查看。</p><pre className="max-h-64 overflow-auto rounded-md border border-border p-2 text-xs">{JSON.stringify(selected.haffRule, null, 2)}</pre></div> : null}
    {sourceHaff ? <div className="grid gap-4 lg:grid-cols-2">
      {keys.map(k => <div key={k} className="min-w-0 space-y-2"><h3 className="text-sm font-semibold">{MAP_LABEL[k].title}</h3>
        <div className="rules-items-table overflow-x-auto rounded-md border border-border max-sm:overflow-visible max-sm:border-0 max-sm:[&_thead]:hidden max-sm:[&_table]:block max-sm:[&_tbody]:grid max-sm:[&_tbody]:gap-3 max-sm:[&_tr]:grid max-sm:[&_tr]:grid-cols-2 max-sm:[&_tr]:gap-x-3 max-sm:[&_tr]:gap-y-2 max-sm:[&_tr]:rounded-md max-sm:[&_tr]:border max-sm:[&_tr]:border-border max-sm:[&_tr]:p-3 max-sm:[&_td]:block max-sm:[&_td]:p-0 max-sm:[&_td]:text-left"><Table><TableHeader><TableRow><TableHead>{MAP_LABEL[k].key}</TableHead><TableHead className="text-right">当前生效</TableHead><TableHead className="text-right">{sealedView ? "待生效" : "草稿"}</TableHead></TableRow></TableHeader><TableBody>
          {Object.keys(form.value.maps[k] ?? {}).map(key => { const before = currentHaff?.[k]?.[key]; const after = form.value.maps[k]?.[key] ?? ""; return <TableRow key={key}><TableCell className="max-sm:col-span-2">{keyLabel(k, key)}</TableCell><TableCell data-label="当前生效" className={`text-right tabular-nums ${ML}`}>{before ?? "—"}</TableCell><TableCell data-label="草稿" className={`w-36 ${ML}`}><Input aria-label={`${MAP_LABEL[k].title} ${key}`} inputMode="decimal" value={after} disabled={locked} aria-invalid={!DECIMAL.test(after.trim())} className={`text-right tabular-nums ${before !== undefined && before !== after.trim() ? "border-primary" : ""}`} onChange={e => setCell(k, key, e.target.value)} /></TableCell></TableRow>; })}
        </TableBody></Table></div></div>)}
      {form.value.spreadDelta !== undefined ? <div className="min-w-0 space-y-2"><h3 className="text-sm font-semibold">普通模式利润点（比例差）</h3><div className="grid grid-cols-2 items-center gap-2 text-sm"><span className="text-muted-foreground">当前生效：{currentHaff?.compatibility.ordinary.spreadDelta ?? "—"}</span><Input aria-label="普通模式利润点" inputMode="decimal" value={form.value.spreadDelta} disabled={locked} aria-invalid={!DECIMAL.test(form.value.spreadDelta.trim())} className="text-right tabular-nums" onChange={e => form.setValue(prev => ({ ...prev, spreadDelta: e.target.value }))} /></div></div> : null}
    </div> : null}
    {invalid ? <p role="status" className="text-xs text-destructive">请填写数字（可为负数），最多两位小数。</p> : null}
    {example ? <HaffExample example={example} part={part} /> : null}
    {save.messages}
    {canEdit && sourceHaff && !sealedView ? <div className="flex flex-wrap gap-2"><Button type="button" disabled={locked || !form.dirty || invalid} onClick={submit}>保存{title}</Button>{form.dirty ? <Button type="button" variant="ghost" onClick={form.reset}>放弃本次输入</Button> : null}</div> : null}
  </Panel>;
}

/* ---------------- 物资价目（仅普通档位） ---------------- */

type ItemRow = { itemId: string; pricingKind: "FIXED_UNIT" | "HAFF_RATIO"; unitQuantity: string; buyerUnitAmount: string; ownerUnitAmount: string };

/** 窄屏下表格行改为卡片，单元格用 data-label 显示列名。 */
const ML = "max-sm:before:mb-1 max-sm:before:block max-sm:before:text-[11px] max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]";

export function PriceItemsEditor({ rules, command, draftId, canEdit, onDirtyChange, ensureDraft }: EditorProps) {
  const selected = rules.priceVersions.find(v => v.id === draftId);
  const current = currentPrice(rules);
  const std = (versionId: string | undefined) => rules.priceLines.filter(l => l.priceVersionId === versionId && (l.customerTier ?? "STANDARD") === "STANDARD");
  const hasDraftLines = Boolean(selected && draftHasLines(rules, selected.id));
  const basis = hasDraftLines ? std(selected?.id) : std(current?.id);
  const initial = useMemo<ItemRow[]>(() => rules.items.map(item => { const l = basis.find(x => x.itemId === item.id); return { itemId: item.id, pricingKind: l?.pricingKind ?? (item.unit === "HAFF_BASE" ? "HAFF_RATIO" : "FIXED_UNIT"), unitQuantity: LOCKED_UNIT_QUANTITY.has(item.code) ? "1" : (l?.unitQuantity ?? "1"), buyerUnitAmount: l?.buyerUnitAmount ? yuanInput(l.buyerUnitAmount) : "", ownerUnitAmount: l?.ownerUnitAmount ? yuanInput(l.ownerUnitAmount) : "" }; }), [JSON.stringify(basis), rules.items]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = !canEdit || command.locked || (selected ? selected.status !== "DRAFT" : false); const sealedView = !!selected && selected.status !== "DRAFT";
  const form = useDirty(initial, command.locked, onDirtyChange);
  const save = useSave(command);
  const mode = selected?.mode ?? current?.mode ?? "SPREAD";
  const memberTiers = selected ? rules.priceLines.some(l => l.priceVersionId === selected.id && (l.customerTier ?? "STANDARD") !== "STANDARD") : false;
  const submit = () => {
    if (locked) return;
    const lines = form.value.filter(r => r.pricingKind === "HAFF_RATIO" || r.buyerUnitAmount.trim() !== "").map(r => r.pricingKind === "HAFF_RATIO" ? { itemId: r.itemId, customerTier: "STANDARD", pricingKind: "HAFF_RATIO" } : { itemId: r.itemId, customerTier: "STANDARD", pricingKind: "FIXED_UNIT", unitQuantity: r.unitQuantity.trim(), buyerUnitAmount: r.buyerUnitAmount.trim(), ...(mode === "SPREAD" && r.ownerUnitAmount.trim() !== "" ? { ownerUnitAmount: r.ownerUnitAmount.trim() } : {}) });
    if (!lines.length) return;
    void save.run(async () => { const t = await ensureDraft(); return t ? draftCommand(t.rules.game.id, "price", "update", priceSaveBody(t.rules, t.draft, { lines }), t.draft.id) : null; }, "物资价目已保存到草稿。", form.markSaved);
  };
  const set = (i: number, key: keyof ItemRow, v: string) => form.setValue(prev => prev.map((r, j) => j === i ? { ...r, [key]: v } : r));
  const rowIssue = (r: ItemRow) => r.pricingKind === "HAFF_RATIO" ? "" : !/^[1-9]\d*$/.test(r.unitQuantity.trim()) ? "计费数量须为正整数" : (r.buyerUnitAmount.trim() !== "" && !MONEY.test(r.buyerUnitAmount.trim())) || (r.ownerUnitAmount.trim() !== "" && !MONEY.test(r.ownerUnitAmount.trim())) ? "金额须为非负数，最多两位小数" : r.buyerUnitAmount.trim() !== "" && r.ownerUnitAmount.trim() !== "" && Number(r.ownerUnitAmount) > Number(r.buyerUnitAmount) ? "号主价高于租客价，平台会倒贴" : "";
  const itemsInvalid = form.value.some(r => { const m = rowIssue(r); return m !== "" && !m.startsWith("号主价高于"); });
  return <Panel title="物资价目" note={<>按「每 N 个多少钱」计价：租客付 <b>数量÷N×租客价</b>，号主得 <b>数量÷N×号主价</b>，差额归平台。</>} more="例：六级子弹每 60 发租客 ¥10.00、号主 ¥4.00，租 120 发 → 租客付 ¥20.00、号主得 ¥8.00。金额四舍五入到分；会员优惠按总价折扣另算。">
    <DraftLine selected={selected} locked={command.locked} />
    {memberTiers ? <p role="note" className="text-xs text-muted-foreground">此草稿还带有旧的会员档位价目；保存后草稿只保留普通档位（已封存版本不受影响）。</p> : null}
    <div className="rules-items-table overflow-x-auto rounded-md border border-border max-sm:overflow-visible max-sm:border-0 max-sm:[&_thead]:hidden max-sm:[&_table]:block max-sm:[&_tbody]:grid max-sm:[&_tbody]:gap-3 max-sm:[&_tr]:grid max-sm:[&_tr]:grid-cols-2 max-sm:[&_tr]:gap-x-3 max-sm:[&_tr]:gap-y-2 max-sm:[&_tr]:rounded-md max-sm:[&_tr]:border max-sm:[&_tr]:border-border max-sm:[&_tr]:p-3 max-sm:[&_td]:block max-sm:[&_td]:p-0 max-sm:[&_td]:text-left"><Table className="min-w-[720px]"><TableHeader><TableRow><TableHead>物品</TableHead><TableHead>计价方式</TableHead><TableHead className="text-right">当前租客单价</TableHead><TableHead className="text-right">计费数量 N</TableHead><TableHead className="text-right">{sealedView ? "待生效租客价（元）" : "草稿租客价（元）"}</TableHead>{mode === "SPREAD" ? <><TableHead className="text-right">当前号主单价</TableHead><TableHead className="text-right">{sealedView ? "待生效号主价（元）" : "草稿号主价（元）"}</TableHead><TableHead className="text-right">平台差价</TableHead></> : null}</TableRow></TableHeader><TableBody>
      {form.value.map((r, i) => { const item = rules.items.find(x => x.id === r.itemId); const cur = std(current?.id).find(l => l.itemId === r.itemId); const haff = r.pricingKind === "HAFF_RATIO"; const lockedQty = LOCKED_UNIT_QUANTITY.has(item?.code ?? ""); return <TableRow key={r.itemId}>
        <TableCell className="max-sm:col-span-2"><span className="font-medium">{item?.name ?? r.itemId}</span>{rowIssue(r) ? <p className="text-[11px] text-destructive">{rowIssue(r)}</p> : null}</TableCell><TableCell data-label="计价方式" className={`whitespace-nowrap ${ML}`}>{haff ? "按哈夫币比例（见基础计价）" : `每 ${cur?.unitQuantity ?? r.unitQuantity} ${unitLabel(item?.unit ?? "", item?.code)}`}</TableCell>
        <TableCell data-label="当前租客单价" className={`text-right tabular-nums ${ML}`}>{haff ? "—" : cur?.buyerUnitAmount ? unitYuan(cur.buyerUnitAmount) : "未配置"}</TableCell>
        <TableCell data-label="计费数量 N" className={`min-w-24 ${ML} ${haff ? "max-sm:hidden" : ""}`}>{haff ? "—" : lockedQty ? <div className="text-right max-sm:text-left"><span className="text-sm font-medium tabular-nums">{r.unitQuantity}</span><span className="block text-[11px] text-muted-foreground whitespace-nowrap max-sm:inline max-sm:ml-1.5" title="按 1 个基础单位计价，不能改">（固定 1 单位）</span></div> : <Input aria-label={`${item?.name} 单位数量`} inputMode="numeric" className={`text-right tabular-nums ${cur && cur.unitQuantity !== r.unitQuantity.trim() ? "border-primary" : ""}`} value={r.unitQuantity} disabled={locked} onChange={e => set(i, "unitQuantity", e.target.value)} />}</TableCell>
        <TableCell data-label={sealedView ? "待生效租客价（元）" : "草稿租客价（元）"} className={`min-w-24 ${ML} ${haff ? "max-sm:hidden" : ""}`}>{haff ? "—" : <Input aria-label={`${item?.name} 租客单价`} inputMode="decimal" value={r.buyerUnitAmount} disabled={locked} className={`text-right tabular-nums ${cur && yuanInput(cur.buyerUnitAmount) !== r.buyerUnitAmount.trim() ? "border-primary" : ""}`} onChange={e => { if (MONEY2.test(e.target.value)) set(i, "buyerUnitAmount", e.target.value); }} />}</TableCell>
        {mode === "SPREAD" ? <><TableCell data-label="当前号主单价" className={`text-right tabular-nums ${ML} ${haff ? "max-sm:hidden" : ""}`}>{haff ? "—" : cur?.ownerUnitAmount ? unitYuan(cur.ownerUnitAmount) : "未配置"}</TableCell><TableCell data-label={sealedView ? "待生效号主价（元）" : "草稿号主价（元）"} className={`min-w-24 ${ML} ${haff ? "max-sm:hidden" : ""}`}>{haff ? "—" : <Input aria-label={`${item?.name} 号主单价`} inputMode="decimal" value={r.ownerUnitAmount} disabled={locked} className={`text-right tabular-nums ${cur && yuanInput(cur.ownerUnitAmount) !== r.ownerUnitAmount.trim() ? "border-primary" : ""}`} onChange={e => { if (MONEY2.test(e.target.value)) set(i, "ownerUnitAmount", e.target.value); }} />}</TableCell><TableCell data-label="平台差价" className={`text-right tabular-nums ${ML} ${haff ? "max-sm:hidden" : ""}`}>{haff || !MONEY.test(r.buyerUnitAmount.trim()) || !MONEY.test(r.ownerUnitAmount.trim()) ? "—" : unitYuan(r2(Number(r.buyerUnitAmount) - Number(r.ownerUnitAmount)))}</TableCell></> : null}
      </TableRow>; })}
    </TableBody></Table></div>
    {save.messages}
    {canEdit && !sealedView ? <div className="flex flex-wrap gap-2"><Button type="button" disabled={locked || itemsInvalid || !(form.dirty || (selected && !hasDraftLines))} onClick={submit}>保存物资价目</Button>{form.dirty ? <Button type="button" variant="ghost" onClick={form.reset}>放弃本次输入</Button> : null}</div> : null}
  </Panel>;
}

/* ---------------- 押金规则：只改上限 ---------------- */

const YUAN = /^\d+(\.\d{1,2})?$/;
const toCents = (y: string) => { const [i = "0", f = ""] = y.trim().split("."); return String(BigInt(i) * 100n + BigInt((f + "00").slice(0, 2))); };

export function DepositCapEditor({ rules, command, draftId, canEdit, onDirtyChange, ensureDraft }: EditorProps) {
  const selected = rules.priceVersions.find(v => v.id === draftId);
  const current = currentPrice(rules);
  const policy: FundingPolicy | null | undefined = selected?.fundingPolicy ?? current?.fundingPolicy ?? rules.priceVersions.find(v => v.status === "SEALED" && v.fundingPolicy)?.fundingPolicy;
  const initial = policy ? centsYuan(policy.ownerDepositRules.capCents).replace(/[^\d.]/g, "") : "";
  const roundingText = depositRoundingText(policy);
  const locked = !canEdit || command.locked || (selected ? selected.status !== "DRAFT" : false) || !policy; const sealedView = !!selected && selected.status !== "DRAFT";
  const form = useDirty(initial, command.locked, onDirtyChange);
  const save = useSave(command);
  const valid = YUAN.test(form.value.trim());
  const submit = () => {
    if (!policy || locked || !valid) return;
    const cap = toCents(form.value);
    // 一个上限同时写入号主押金封顶与推荐押金上限，其余政策字段原样保留。
    const next: FundingPolicy = { ...policy, ownerDepositRules: { ...policy.ownerDepositRules, capCents: cap }, recommendation: { ...policy.recommendation, parameters: { ...policy.recommendation.parameters, upperLimitCents: cap } } as FundingPolicy["recommendation"] };
    void save.run(async () => { const t = await ensureDraft(); return t ? draftCommand(t.rules.game.id, "price", "update", priceSaveBody(t.rules, t.draft, { fundingPolicy: next }), t.draft.id) : null; }, "押金上限已保存到草稿。", form.markSaved);
  };
  const r = policy?.recommendation.parameters.rounding ?? {};
  return <Panel title="押金规则" note="这里只改押金上限：号主能填的最高押金，也是推荐押金的封顶。" more="押金由号主上架时填写，系统给推荐值；租客下单时按号主填的金额冻结。最低押金和取整方式是固定规则，只读。">
    <DraftLine selected={selected} locked={command.locked} />
    {!policy ? <p role="status" className="text-sm text-muted-foreground">尚无资金政策，无法配置押金上限。</p> : <>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">当前生效上限</dt><dd className="tabular-nums">{current?.fundingPolicy ? centsYuan(current.fundingPolicy.ownerDepositRules.capCents) : "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">普通最低押金（只读）</dt><dd className="tabular-nums">{centsYuan(policy.ownerDepositRules.normal.minCents)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">选择全额赔付时最低押金（只读）</dt><dd className="tabular-nums">{centsYuan(policy.ownerDepositRules.fullPayoutSelected.minCents)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">推荐押金取整（只读）</dt><dd>{roundingText}</dd></div>
      </dl>
      <label className="block max-w-xs space-y-1 text-xs"><span className="text-muted-foreground">草稿押金上限（元）{current?.fundingPolicy && valid && toCents(form.value) !== current.fundingPolicy.ownerDepositRules.capCents ? <b className="ml-1 text-primary">已修改</b> : null}</span><Input aria-label="草稿押金上限（元）" inputMode="decimal" value={form.value} disabled={locked} aria-invalid={!valid} className="text-right tabular-nums" onChange={e => { if (MONEY2.test(e.target.value)) form.setValue(e.target.value); }} /></label>
      {!valid ? <p role="status" className="text-xs text-destructive">请填写金额，最多两位小数。</p> : valid && policy && BigInt(toCents(form.value)) < BigInt(policy.ownerDepositRules.fullPayoutSelected.minCents) ? <p role="status" className="text-xs text-destructive">上限低于全额包赔最低押金 {centsYuan(policy.ownerDepositRules.fullPayoutSelected.minCents)}，号主将无法选择全额包赔。</p> : null}
      {policy ? <DepositExample policy={policy} /> : null}
    </>}
    {save.messages}
    {canEdit && policy && !sealedView ? <div className="flex flex-wrap gap-2"><Button type="button" disabled={locked || !form.dirty || !valid} onClick={submit}>保存押金上限</Button>{form.dirty ? <Button type="button" variant="ghost" onClick={form.reset}>放弃本次输入</Button> : null}</div> : null}
  </Panel>;
}

/* ---------------- 草稿栏 ---------------- */

export function sealChecks(rules: RulesResponse, version: PriceVersionRecord | undefined): SealCheck[] {
  if (!version) return [];
  const rec = version.fundingPolicy?.recommendation;
  return [
    { label: "已有普通档位物资价目", section: "items", ok: rules.priceLines.some(l => l.priceVersionId === version.id && (l.customerTier ?? "STANDARD") === "STANDARD") },
    { label: "哈夫币规则为新版结构", section: "pricing", ok: asHaffV2(version.haffRule) !== null },
    { label: "皮肤推荐押金为新版且已填全", failLabel: "皮肤推荐押金还是旧规则，需要先配好新版才能提交", section: "skin", ok: rec?.schema === "deposit-recommendation-v2" && rec.parameters.skinRules.every(row => row.firstCents !== null && row.subsequentCents !== null) && rec.parameters.skinOverrides.every(row => row.amountCents !== null) },
  ];
}

type HaffExampleData = { box: string; vit: string; bear: string; term: string; base: number; vd: number; bd: number; td: number; owner: number; spread: number; tenant: number; haffM: number; days: number | null; tenantYuan: number; ownerYuan: number };
/** 用当前生效值拼一个“3×3 保险箱 / 7 级体力 / 4 级负重 / 第 2 个每日消耗档 / 1 亿哈夫币”的示例；与服务端 quote-preview 同口径（金额四舍五入到分，天数向上取整）。 */
export function haffExample(rules: RulesResponse, haff: HaffV2 | null | undefined): HaffExampleData | null {
  if (!haff) return null;
  const pick = (m: Record<string, string>, pref: string[]) => pref.find(k => k in m) ?? Object.keys(m).at(-1);
  const box = pick(haff.baseBySafeBox, ["safe_box_3x3"]), vit = pick(haff.vitalityDeltaByLevel, ["7"]), bear = pick(haff.bearDeltaByLevel, ["4"]);
  const opts = rules.termOptions.filter(o => o.versionId === rules.release?.termVersionId && o.code in haff.dailyDeltaByTermOption);
  const opt = opts[1] ?? opts[0];
  if (!box || !vit || !bear || !opt) return null;
  const n = (s: string | undefined) => Number(s ?? "0");
  const base = n(haff.baseBySafeBox[box]), vd = n(haff.vitalityDeltaByLevel[vit]), bd = n(haff.bearDeltaByLevel[bear]), td = n(haff.dailyDeltaByTermOption[opt.code]);
  const owner = r2(base + vd + bd + td), spread = n(haff.compatibility.ordinary.spreadDelta), tenant = r2(owner - spread);
  if (!(owner > 0) || !(tenant > 0)) return null;
  const haffM = 100, daily = Number(opt.dailyConsumption) / 1_000_000;
  return { box, vit, bear, term: opt.name, base, vd, bd, td, owner, spread, tenant, haffM, days: daily > 0 ? Math.ceil(haffM / daily) : null, tenantYuan: r2(haffM * 100 / tenant), ownerYuan: r2(haffM * 100 / owner) };
}
const sgn = (v: number) => (v < 0 ? `− ${-v}` : `+ ${v}`);
function HaffExample({ example: e, part }: { example: HaffExampleData; part: "base" | "term" }) {
  return <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs leading-6">
    <p className="font-medium">举个例子（按当前生效值，与服务端试算一致）</p>
    <p>号主上架 {safeBoxLabel(e.box)} 保险箱、{e.vit} 级体力、{e.bear} 级负重，选“{e.term}”，出租 {e.haffM}M（1 亿）哈夫币：</p>
    <p>号主比例 = {e.base} {sgn(e.vd)} {sgn(e.bd)} {sgn(e.td)} = <b>{e.owner}</b>；租客比例 = {e.owner} − 利润点 {e.spread} = <b>{e.tenant}</b></p>
    <p>租客付 {e.haffM * 100} 万 ÷ {e.tenant} = <b>{unitYuan(e.tenantYuan)}</b>，号主得 {e.haffM * 100} 万 ÷ {e.owner} = <b>{unitYuan(e.ownerYuan)}</b>，平台得 {unitYuan(r2(e.tenantYuan - e.ownerYuan))}{part === "term" && e.days ? `；可租 ${e.days} 天` : ""}。</p>
  </div>;
}
export function depositRoundingText(policy: FundingPolicy | null | undefined): string {
  const r = policy?.recommendation.parameters.rounding as Record<string, string> | undefined;
  if (!r) return "—";
  const unit = r.unitCents ? centsYuan(r.unitCents) : "";
  const mode = r.mode === "CEIL" ? "向上取整" : r.mode === "FLOOR" ? "向下取整" : r.mode === "HALF_UP" ? "四舍五入" : r.mode ?? "";
  return `${mode}${unit ? `到 ${unit} 的整数倍` : ""}${r.zeroFallbackCents ? `；算出为 0 时按 ${centsYuan(r.zeroFallbackCents)}` : ""}`;
}
function DepositExample({ policy }: { policy: FundingPolicy }) {
  const p = policy.recommendation.parameters as { safeBoxWeightsByCode?: Record<string, string>; vitalityAtLeast7Cents?: string };
  const box = p.safeBoxWeightsByCode?.safe_box_3x3, vit = p.vitalityAtLeast7Cents;
  if (box === undefined || vit === undefined) return null;
  const sum = String(BigInt(box) + BigInt(vit));
  return <p className="rounded-md border border-dashed bg-muted/30 p-3 text-xs leading-6">推荐押金例子：3×3 保险箱 {centsYuan(box)} ＋ 体力 7 级及以上 {centsYuan(vit)} ＝ <b>{centsYuan(sum)}</b>，再按上面的取整规则处理，最终不超过押金上限 {centsYuan(policy.ownerDepositRules.capCents)}。号主可以改填，但不能低于最低押金、不能高于上限。</p>;
}
