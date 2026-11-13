import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../components/ui/collapsible";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, CircleHelp, FileEdit, Info, Lock } from "lucide-react";
import type { FundingPolicy, PriceVersionRecord, RulesResponse } from "../../api";
import { friendlyError } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Field } from "../../components/ui/field";
import { SupplySelect } from "../../components/supply/supply-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "@/lib/utils";
import { draftCommand, type useRulesWrite } from "./rules-write";
import { asHaffV2, centsYuan, referenceUnitYuan, safeBoxLabel, spread, unitLabel, unitPriceInput, unitYuan, yuanInput, type HaffV2 } from "./rules-model";
import { draftHasLines, priceSaveBody, type SealCheck } from "./price-draft";

type Command = ReturnType<typeof useRulesWrite>;
export type EnsureDraft = () => Promise<{ rules: RulesResponse; draft: PriceVersionRecord } | null>;
type EditorProps = { rules: RulesResponse; command: Command; draftId: string; canEdit: boolean; onDirtyChange: (dirty: boolean) => void; ensureDraft: EnsureDraft };

/** 轻量说明气泡：问号/感叹号图标 + Tooltip，便于与主要数据区分、不抢视觉重心。 */
export function HelpTip({
  children,
  icon: Icon = CircleHelp,
  className,
  side = "top",
  label = "查看说明",
}: {
  children: ReactNode;
  icon?: typeof CircleHelp | typeof CircleAlert | typeof Info;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  label?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className={cn(
              "size-4 shrink-0 rounded p-0 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              className,
            )}
          >
            <Icon className="size-3.5" />
          </Button>
        }
      />
      <TooltipContent side={side} className="max-w-xs text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

const currentPrice = (rules: RulesResponse) => rules.priceVersions.find(v => v.id === rules.release?.priceVersionId);
/** 比例与加减值：可为负，最多两位小数。 */
const DECIMAL = /^-?\d+(\.\d{1,2})?$/;
const EXACT_RATIO = /^-?\d+(\.\d{1,8})?$/;
/** 物资新单价：非负，最多两位小数。 */
const MONEY = /^\d{1,16}(\.\d{1,2})?$/;
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

function useDirty<T>(initial: T, locked: boolean, onDirtyChange: (dirty: boolean) => void, extraDirty = false) {
  const [value, setValue] = useState<T>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const dirty = JSON.stringify(value) !== baseline || extraDirty;
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
type FixedHaff = Pick<HaffV2, MapKey> & { schema: "haff-ratio-v3"; fixedModes: Record<"ordinary" | "custom" | "fast", { enabled: boolean; min?: { base: "C" | "ABSOLUTE"; value: string }; max?: { base: "C" | "ABSOLUTE"; value: string } }> };
const fixedHaff = (price: PriceVersionRecord | undefined) => price?.haffRule?.schema === "haff-ratio-v3" ? price.haffRule as FixedHaff : null;
const effectivePrice = (rules: RulesResponse) => rules.newListingPrice === undefined ? currentPrice(rules) : rules.priceVersions.find(v => v.id === rules.newListingPrice?.priceVersionId);
export const fixedModeNames = { ordinary: "普通", custom: "自定义", fast: "极速" } as const;
export const fixedModes = Object.keys(fixedModeNames) as (keyof typeof fixedModeNames)[];
const haffMapKeys: MapKey[] = ["baseBySafeBox", "vitalityDeltaByLevel", "bearDeltaByLevel", "dailyDeltaByTermOption"];
export const fixedFeeRateValid = (rate: string) => /^0(?:\.\d{1,8})?$/.test(rate) && Number(rate) <= 0.92;
type HaffForm = { maps: Partial<Record<MapKey, Record<string, string>>>; spreadDelta?: string };

export function BasePricingEditor({ rules, command, draftId, canEdit, onDirtyChange, ensureDraft, part }: EditorProps & { part: "base" | "term" }) {
  const selected = rules.priceVersions.find(v => v.id === draftId);
  const current = effectivePrice(rules);
  const fixed = Boolean(selected?.fixedFeeRates ?? current?.fixedFeeRates);
  const currentHaff = fixedHaff(current) ?? asHaffV2(current?.haffRule);
  // 未选草稿时用当前生效值只读展示（先看后改）。
  const sourceHaff = selected ? (fixed ? fixedHaff(selected) : asHaffV2(selected.haffRule)) ?? (!fixed && selected.haffRule === null ? currentHaff : null) : currentHaff;
  const keys: MapKey[] = part === "base" ? ["baseBySafeBox", "vitalityDeltaByLevel", "bearDeltaByLevel"] : ["dailyDeltaByTermOption"];
  const initial = useMemo<HaffForm>(() => sourceHaff ? { maps: Object.fromEntries(keys.map(k => [k, { ...sourceHaff[k] }])), ...(part === "base" && "compatibility" in sourceHaff ? { spreadDelta: sourceHaff.compatibility.ordinary.spreadDelta } : {}) } : { maps: {} }, [JSON.stringify(sourceHaff), part]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = !canEdit || command.locked || (selected ? selected.status !== "DRAFT" : false) || !sourceHaff; const sealedView = !!selected && selected.status !== "DRAFT";
  const form = useDirty(initial, command.locked, onDirtyChange);
  const save = useSave(command);
  const ratioPattern = fixed ? EXACT_RATIO : DECIMAL;
  const invalid = Object.values(form.value.maps).some(map => Object.values(map ?? {}).some(v => !(fixed && !v.trim()) && !ratioPattern.test(v.trim()))) || (form.value.spreadDelta !== undefined && !DECIMAL.test(form.value.spreadDelta.trim()));
  const submit = () => {
    if (!sourceHaff || locked || invalid) return;
    void save.run(async () => {
      const t = await ensureDraft(); if (!t) return null;
      // 以服务端最新草稿规则为底，只覆盖本页签字段；会员档位折扣等隐藏字段原样保留。
      const next = structuredClone((fixed ? fixedHaff(t.draft) : asHaffV2(t.draft.haffRule)) ?? sourceHaff);
      for (const k of keys) next[k] = Object.fromEntries(Object.entries(form.value.maps[k] ?? {}).filter(([, value]) => !fixed || value.trim() !== "").map(([key, v]) => [key, v.trim()]));
      if (form.value.spreadDelta !== undefined && "compatibility" in next) next.compatibility.ordinary.spreadDelta = form.value.spreadDelta.trim();
      return draftCommand(t.rules.game.id, "price", "update", priceSaveBody(t.rules, t.draft, { haffRule: next }), t.draft.id);
    }, part === "base" ? "基础计价已保存到草稿。" : "租期每日消耗已保存到草稿。", form.markSaved);
  };
  const setCell = (k: MapKey, key: string, v: string) => form.setValue(prev => ({ ...prev, maps: { ...prev.maps, [k]: { ...prev.maps[k], [key]: v } } }));
  const title = part === "base" ? "基础计价" : "租期每日消耗";
  const configuredKeys: Partial<Record<MapKey, string[]>> = fixed ? {
    baseBySafeBox: ["safe_box_1x2", "safe_box_2x2", "safe_box_2x3", "safe_box_3x3"],
    dailyDeltaByTermOption: rules.termOptions.map(term => term.code),
  } : {};
  const keyLabel = (k: MapKey, key: string) => k === "baseBySafeBox" ? `${safeBoxLabel(key)} 保险箱` : k === "dailyDeltaByTermOption" ? rules.termOptions.find(o => o.code === key && o.versionId === rules.release?.termVersionId)?.name ?? key : `${key} 级`;
  const example = useMemo(() => haffExample(rules, !fixed && currentHaff && "compatibility" in currentHaff ? currentHaff : null), [rules, currentHaff, fixed]);
  return <Panel
    title={title}
    note={
      fixed ? "租客与号主使用同一哈夫币比例，比例单位为万哈夫币/元。" : part === "base" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>号主比例＝保险箱基础＋体力＋负重＋每日消耗档；租客比例＝号主比例－利润点。</span>
          <HelpTip label="基础比例规则说明">
            比例代表 1 元换多少万哈夫币，比例越大单价越便宜。租客实际支付比例为号主核算比例减去平台利润点。改动格子会有边框高亮。
          </HelpTip>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>号主比例按每日消耗档加减；可租天数＝哈夫币总量÷每日消耗（向上取整）。</span>
          <HelpTip label="每日消耗规则说明">
            不同租期档位对应每日哈夫币消耗标准，系统以此测算可租借天数并浮动号主比例。
          </HelpTip>
        </div>
      )
    }
    more={!fixed && part === "base" ? "比例＝1 元换多少万哈夫币，比例越大哈夫币越便宜。左列是线上值，右列可改，改过的格子会高亮。会员优惠按总价折扣另算。" : undefined}
  >
    <DraftLine selected={selected} locked={command.locked} />
    {selected?.fixedFeeRates && !sourceHaff ? <p role="status" className="text-sm text-muted-foreground">请在「出租模式」保存首版哈夫币比例。</p> : null}
    {selected && !fixed && !sourceHaff ? <div className="space-y-2"><p role="status" className="text-xs text-muted-foreground">这份草稿的哈夫币规则是旧写法，这里只能查看。</p><pre className="max-h-64 overflow-auto rounded-md border border-border p-2 text-xs">{JSON.stringify(selected.haffRule, null, 2)}</pre></div> : null}
    {sourceHaff ? <div className="grid gap-4 lg:grid-cols-2">
      {keys.map(k => <div key={k} className="min-w-0 space-y-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold">{fixed && k === "baseBySafeBox" ? "保险箱基础比例" : MAP_LABEL[k].title}</h3>
          <HelpTip label={`${MAP_LABEL[k].title}说明`}>
            {fixed ? "数值增减会影响本单双方采用的哈夫币比例。" : "以数值增减直接影响号主基准比例，数值变化将同步作用于最终租客支付测算。"}
          </HelpTip>
        </div>
        <div className="rules-items-table overflow-x-auto rounded-md border border-border max-sm:overflow-visible max-sm:border-0 max-sm:[&_thead]:hidden max-sm:[&_table]:block max-sm:[&_tbody]:grid max-sm:[&_tbody]:gap-3 max-sm:[&_tr]:grid max-sm:[&_tr]:grid-cols-2 max-sm:[&_tr]:gap-x-3 max-sm:[&_tr]:gap-y-2 max-sm:[&_tr]:rounded-md max-sm:[&_tr]:border max-sm:[&_tr]:border-border max-sm:[&_tr]:p-3 max-sm:[&_td]:block max-sm:[&_td]:p-0 max-sm:[&_td]:text-left"><Table><TableHeader><TableRow><TableHead className="font-medium text-foreground">{MAP_LABEL[k].key}</TableHead><TableHead className="text-right">{fixed && current?.mode === "SPREAD" ? "生效价差参考" : "当前生效"}</TableHead><TableHead className="text-right font-medium text-foreground">{sealedView ? "待生效" : "草稿"}</TableHead></TableRow></TableHeader><TableBody>
          {[...new Set([...Object.keys(form.value.maps[k] ?? {}), ...(configuredKeys[k] ?? [])])].map(key => {
            const before = currentHaff?.[k]?.[key];
            const after = form.value.maps[k]?.[key] ?? "";
            const changed = before !== undefined && before !== after.trim();
            return <TableRow key={key}>
              <TableCell className="max-sm:col-span-2 font-medium">{keyLabel(k, key)}</TableCell>
              <TableCell data-label={fixed && current?.mode === "SPREAD" ? "生效价差参考" : "当前生效"} className={`text-right tabular-nums text-muted-foreground ${ML}`}>{before ?? "—"}</TableCell>
              <TableCell data-label="草稿" className={`w-36 ${ML}`}>
                <div className="flex flex-col items-end gap-1">
                  <Input
                    aria-label={`${MAP_LABEL[k].title} ${key}`}
                    inputMode="decimal"
                    value={after}
                    disabled={locked}
                    aria-invalid={!(fixed && !after.trim()) && !ratioPattern.test(after.trim())}
                    className={`text-right tabular-nums transition-colors ${changed ? "border-primary bg-primary/[0.04] font-medium ring-1 ring-primary/30" : ""}`}
                    onChange={e => setCell(k, key, e.target.value)}
                  />
                  {changed ? <span className="text-[10px] text-primary font-medium">已修改</span> : null}
                </div>
              </TableCell>
            </TableRow>;
          })}
        </TableBody></Table></div></div>)}
      {form.value.spreadDelta !== undefined ? (
        <div className="min-w-0 space-y-2 rounded-lg border border-border/80 bg-muted/20 p-3.5">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold">普通模式利润点（比例差）</h3>
            <HelpTip label="普通模式利润点说明">
              租客支付比例 ＝ 号主比例 − 平台利润点。调大该数值租客支付增加、平台留存收益扩大。
            </HelpTip>
          </div>
          <div className="grid grid-cols-2 items-center gap-3 text-sm">
            <span className="text-xs text-muted-foreground">当前生效：<b className="font-semibold tabular-nums text-foreground">{currentHaff && "compatibility" in currentHaff ? currentHaff.compatibility.ordinary.spreadDelta : "—"}</b></span>
            <div className="flex items-center justify-end gap-2">
              <span className="text-xs text-muted-foreground">{sealedView ? "待生效" : "草稿"}</span>
              <Input
                aria-label="普通模式利润点"
                inputMode="decimal"
                value={form.value.spreadDelta}
                disabled={locked}
                aria-invalid={!DECIMAL.test(form.value.spreadDelta.trim())}
                className={`w-28 text-right tabular-nums ${currentHaff && "compatibility" in currentHaff && currentHaff.compatibility.ordinary.spreadDelta !== form.value.spreadDelta.trim() ? "border-primary bg-primary/[0.04] font-medium" : ""}`}
                onChange={e => form.setValue(prev => ({ ...prev, spreadDelta: e.target.value }))}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div> : null}
    {invalid ? <p role="status" className="flex items-center gap-1 text-xs text-destructive"><CircleAlert className="size-3.5 shrink-0" />请填写有效数字（可为负数），最多{fixed ? "八" : "两"}位小数。</p> : null}
    {example ? <HaffExample example={example} part={part} /> : null}
    {save.messages}
    {canEdit && sourceHaff && !sealedView ? <div className="flex flex-wrap gap-2"><Button type="button" disabled={locked || !form.dirty || invalid} onClick={submit}>保存{title}</Button>{form.dirty ? <Button type="button" variant="ghost" onClick={form.reset}>放弃本次输入</Button> : null}</div> : null}
  </Panel>;
}

export function FixedRentalModeEditor({ rules, command, draftId, canEdit, ensureDraft, onDirtyChange }: EditorProps) {
  const selected = rules.priceVersions.find(v => v.id === draftId);
  const basis = selected ?? effectivePrice(rules);
  const rule = fixedHaff(basis);
  const setup = Boolean(selected?.fixedFeeRates && !rule);
  const releaseTermId = rules.release?.termVersionId;
  const currentHaff = asHaffV2(effectivePrice(rules)?.haffRule);
  const initial = useMemo(() => {
    const blanks = (keys: string[]) => Object.fromEntries([...new Set(keys)].map(key => [key, ""]));
    return {
      rates: basis?.fixedFeeRates ?? { ordinary: "", custom: "", fast: "" },
      modes: rule?.fixedModes ?? (setup ? { ordinary: { enabled: false }, custom: { enabled: false }, fast: { enabled: false } } as FixedHaff["fixedModes"] : undefined),
      maps: setup ? {
        baseBySafeBox: blanks(["safe_box_1x2", "safe_box_2x2", "safe_box_2x3", "safe_box_3x3"]),
        vitalityDeltaByLevel: blanks(["4", "5", "6", "7"]),
        bearDeltaByLevel: blanks(["4", "5", "6", "7"]),
        dailyDeltaByTermOption: blanks(rules.termOptions.filter(term => term.versionId === releaseTermId).map(term => term.code)),
      } : undefined,
    };
  }, [basis, rule, setup, rules.termOptions, releaseTermId]);
  const form = useDirty(initial, command.locked, onDirtyChange);
  const save = useSave(command);
  const locked = !canEdit || command.locked || selected?.status === "SEALED";
  const modes = form.value.modes;
  if (!modes) return <p role="status">固定手续费出租规则暂无法核实。</p>;
  const maps = form.value.maps;
  const mapsReady = !setup || Boolean(maps && haffMapKeys.every(key => Object.keys(maps[key]).length > 0
    && Object.values(maps[key]).every(value => EXACT_RATIO.test(value.trim()) && (key !== "baseBySafeBox" || Number(value) > 0))));
  const valid = mapsReady && Object.values(form.value.rates).every(fixedFeeRateValid) && Object.values(modes).some(mode => mode.enabled)
    && (["custom", "fast"] as const).every(key => !modes[key].enabled || (modes[key].min && EXACT_RATIO.test(modes[key].min.value)
      && (!modes[key].max || EXACT_RATIO.test(modes[key].max.value))));
  const submit = () => void save.run(async () => {
    const target = await ensureDraft();
    if (!target) return null;
    const draftRule = fixedHaff(target.draft);
    if (!draftRule && (!setup || !maps)) return null;
    const savedMaps = maps ? Object.fromEntries(haffMapKeys.map(key => [key,
      Object.fromEntries(Object.entries(maps[key]).map(([name, value]) => [name, value.trim()]))])) : {};
    const haffRule = { ...draftRule, ...savedMaps, schema: "haff-ratio-v3", fixedModes: modes };
    return draftCommand(target.rules.game.id, "price", "update", priceSaveBody(target.rules, target.draft, {
      fixedFeeRates: form.value.rates, haffRule,
    }), target.draft.id);
  }, "手续费和出租方式已保存到草稿。", form.markSaved);
  return <Panel title="固定手续费率与出租方式" note="输入小数费率，例如 0.10 代表 10%。三档手续费率均不得超过 92%。">
    <DraftLine selected={selected} locked={command.locked} />
    {setup ? <p className="text-sm text-muted-foreground">填写哈夫币比例和各档加减项，再启用需要的出租方式。</p> : null}
    {setup && maps ? <div className="grid gap-4 sm:grid-cols-2">
      {haffMapKeys.map(key => <fieldset key={key} disabled={locked} className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">{MAP_LABEL[key].title}</legend>
        {Object.entries(maps[key]).map(([name, value]) => {
          const label = key === "baseBySafeBox" ? safeBoxLabel(name)
            : key === "dailyDeltaByTermOption" ? rules.termOptions.find(term => term.versionId === releaseTermId && term.code === name)?.name ?? name
            : name + " 级";
          const current = currentHaff?.[key][name];
          return <Field key={name} label={label} hint={current === undefined ? undefined : "生效价差参考 " + current}>
            <Input inputMode="decimal" value={value} onChange={event => form.setValue(previous => ({
              ...previous, maps: { ...maps, [key]: { ...maps[key], [name]: event.target.value } },
            }))} />
          </Field>;
        })}
      </fieldset>)}
    </div> : null}
    <div className="grid gap-3 lg:grid-cols-3">{fixedModes.map(key => {
      const name = fixedModeNames[key], mode = modes[key];
      const setMode = (value: typeof mode) => form.setValue({ ...form.value, modes: { ...modes, [key]: value } });
      return <fieldset key={key} className="space-y-3 rounded-md border border-border px-3 pb-3" disabled={locked}>
        <legend className="px-1 font-medium">{name}</legend>
        <Field label={name + "手续费率"} error={!fixedFeeRateValid(form.value.rates[key]) ? "请输入 0 到 0.92，最多八位小数。" : undefined}><Input inputMode="decimal" value={form.value.rates[key]}
          onChange={e => form.setValue({ ...form.value, rates: { ...form.value.rates, [key]: e.target.value } })} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mode.enabled}
          onChange={e => setMode({ ...mode, enabled: e.target.checked })} />启用{name}出租</label>
        {key !== "ordinary" && mode.enabled ? (["min", "max"] as const).map(bound => {
          const label = name + (bound === "min" ? "比例下限" : "比例上限"), value = mode[bound];
          return <div key={bound} className="space-y-1">
            <SupplySelect label={label + "基准"} value={value?.base ?? ""} onValueChange={base => {
              if (base === "") { const next = { ...mode }; delete next[bound]; setMode(next); }
              else if (base === "C" || base === "ABSOLUTE") setMode({ ...mode, [bound]: { base, value: value?.value ?? "" } });
            }} options={[{ value: "", label: "未设置" }, { value: "C", label: "相对基准比例" }, { value: "ABSOLUTE", label: "固定比例" }]} disabled={locked} />
            {value ? <Field label={label}><Input inputMode="decimal" value={value.value}
              onChange={e => setMode({ ...mode, [bound]: { ...value, value: e.target.value } })} /></Field> : null}
          </div>;
        }) : null}
      </fieldset>;
    })}</div>
    {form.dirty && !valid ? <p role="status" className="text-sm text-muted-foreground">请核对费率，填齐比例，并为已启用的自定义或极速出租填写下限。</p> : null}
    {save.messages}
    {canEdit && <Button type="button" disabled={locked || !valid || !form.dirty} onClick={submit}>{setup ? "保存费率、出租方式与比例" : "保存手续费与出租方式"}</Button>}
  </Panel>;
}

/* ---------------- 物资价目（仅普通档位） ---------------- */

type ItemRow = { itemId: string; pricingKind: "FIXED_UNIT" | "HAFF_RATIO"; unitQuantity: string; buyerUnitAmount: string; ownerUnitAmount: string };
const hasSubCent = (value: string | null | undefined) => typeof value === "string" && /[1-9]/.test((value.split(".")[1] ?? "").slice(2));
function exactUnit(value: string): bigint | null {
  if (value.length>25 || !/^\d+(?:\.\d{1,8})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}

/** 窄屏下表格行改为卡片，单元格用 data-label 显示列名。 */
const ML = "max-sm:before:mb-1 max-sm:before:block max-sm:before:text-[11px] max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]";

export function PriceItemsEditor({ rules, command, draftId, canEdit, onDirtyChange, ensureDraft }: EditorProps) {
  const selected = rules.priceVersions.find(v => v.id === draftId);
  const current = effectivePrice(rules);
  const fixed = Boolean(selected?.fixedFeeRates ?? current?.fixedFeeRates);
  const std = (versionId: string | undefined) => rules.priceLines.filter(l => l.priceVersionId === versionId && (l.customerTier ?? "STANDARD") === "STANDARD");
  const hasDraftLines = Boolean(selected && draftHasLines(rules, selected.id));
  const basis = hasDraftLines ? std(selected?.id) : fixed && selected ? [] : std(current?.id);
  const initial = useMemo<ItemRow[]>(() => rules.items.map(item => { const l = basis.find(x => x.itemId === item.id); return { itemId: item.id, pricingKind: l?.pricingKind ?? (item.unit === "HAFF_BASE" ? "HAFF_RATIO" : "FIXED_UNIT"), unitQuantity: LOCKED_UNIT_QUANTITY.has(item.code) ? "1" : (l?.unitQuantity ?? (fixed && selected && item.unit !== "HAFF_BASE" ? "" : "1")), buyerUnitAmount: unitPriceInput(l?.buyerUnitAmount), ownerUnitAmount: unitPriceInput(l?.ownerUnitAmount) }; }), [JSON.stringify(basis), rules.items, fixed, selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const locked = !canEdit || command.locked || (selected ? selected.status !== "DRAFT" : false); const sealedView = !!selected && selected.status !== "DRAFT";
  const [changedPrices, setChangedPrices] = useState<Set<string>>(() => new Set());
  const form = useDirty(initial, command.locked, onDirtyChange, changedPrices.size > 0);
  const save = useSave(command);
  const mode = selected?.mode ?? current?.mode ?? "SPREAD";
  const memberTiers = selected ? rules.priceLines.some(l => l.priceVersionId === selected.id && (l.customerTier ?? "STANDARD") !== "STANDARD") : false;
  const price = (r: ItemRow, field: "buyerUnitAmount" | "ownerUnitAmount") => {
    const old = basis.find(line => line.itemId === r.itemId)?.[field];
    const initialValue = initial.find(line => line.itemId === r.itemId)?.[field];
    return hasSubCent(old) && !changedPrices.has(`${r.itemId}:${field}`) && r[field] === initialValue ? old! : r[field].trim();
  };
  const submit = () => {
    if (locked) return;
    const lines = form.value.filter(r => r.pricingKind === "HAFF_RATIO" || r.buyerUnitAmount.trim() !== "").map(r => r.pricingKind === "HAFF_RATIO" ? { itemId: r.itemId, customerTier: "STANDARD", pricingKind: "HAFF_RATIO" } : { itemId: r.itemId, customerTier: "STANDARD", pricingKind: "FIXED_UNIT", unitQuantity: r.unitQuantity.trim(), buyerUnitAmount: price(r,"buyerUnitAmount"), ...(mode === "SPREAD" && r.ownerUnitAmount.trim() !== "" ? { ownerUnitAmount: price(r,"ownerUnitAmount") } : {}) });
    if (!lines.length) return;
    void save.run(async () => { const t = await ensureDraft(); return t ? draftCommand(t.rules.game.id, "price", "update", priceSaveBody(t.rules, t.draft, { lines }), t.draft.id) : null; }, "物资价目已保存到草稿。", () => { form.markSaved(); setChangedPrices(new Set()); });
  };
  const set = (i: number, key: keyof ItemRow, v: string) => form.setValue(prev => prev.map((r, j) => j === i ? { ...r, [key]: v } : r));
  const rowIssue = (r: ItemRow) => {
    if (r.pricingKind === "HAFF_RATIO") return "";
    if (!/^[1-9]\d*$/.test(r.unitQuantity.trim())) return "计费数量须为正整数";
    if ((r.buyerUnitAmount.trim() !== "" && !MONEY.test(r.buyerUnitAmount.trim())) || (r.ownerUnitAmount.trim() !== "" && !MONEY.test(r.ownerUnitAmount.trim()))) return "金额须为非负数，整数最多16位、小数最多两位";
    const old = basis.find(line => line.itemId === r.itemId);
    if (old && old.unitQuantity !== r.unitQuantity.trim() && (["buyerUnitAmount","ownerUnitAmount"] as const).some(field => hasSubCent(old[field]) && !changedPrices.has(`${r.itemId}:${field}`))) return "计费数量已变，请先将原单价明确调整为两位小数";
    const buyer=exactUnit(price(r,"buyerUnitAmount")),owner=exactUnit(price(r,"ownerUnitAmount"));
    return buyer!==null&&owner!==null&&owner>buyer ? "号主价高于租客价，平台会倒贴" : "";
  };
  const itemsInvalid = form.value.some(r => { const m = rowIssue(r); return m !== "" && !m.startsWith("号主价高于"); });
  return <Panel
    title="物资价目"
    note={fixed ? "租客与号主使用统一单价，手续费在结算时另计。" :
      <div className="flex flex-wrap items-center gap-1.5">
        <span>按「每 N 个多少钱」计价：租客付 <b>数量÷N×租客价</b>，号主得 <b>数量÷N×号主价</b>，差额归平台收益。</span>
        <HelpTip label="物资计费规则说明">
          按订单实际消耗量结算。例：六级子弹每 60 发租客 ¥10.00、号主 ¥4.00，实际租 120 发时，租客付 ¥20.00、号主得 ¥8.00、平台留存 ¥12.00。金额均四舍五入到分。
        </HelpTip>
      </div>
    }
    more={fixed ? undefined : "例：六级子弹每 60 发租客 ¥10.00、号主 ¥4.00，租 120 发 → 租客付 ¥20.00、号主得 ¥8.00。金额四舍五入到分；会员优惠按总价折扣另算。"}
  >
    <DraftLine selected={selected} locked={command.locked} />
    {basis.some(line => hasSubCent(line.buyerUnitAmount) || hasSubCent(line.ownerUnitAmount)) ? <p role="note" className="text-xs text-muted-foreground">原价有不足一分的精度，未修改时沿用原值；调整后的单价最多两位小数。</p> : null}
    {memberTiers ? <p role="note" className="text-xs text-muted-foreground">此草稿还带有旧的会员档位价目；保存后草稿只保留普通档位（已封存版本不受影响）。</p> : null}
    <div className="rules-items-table overflow-x-auto rounded-md border border-border max-sm:overflow-visible max-sm:border-0 max-sm:[&_thead]:hidden max-sm:[&_table]:block max-sm:[&_tbody]:grid max-sm:[&_tbody]:gap-3 max-sm:[&_tr]:grid max-sm:[&_tr]:grid-cols-2 max-sm:[&_tr]:gap-x-3 max-sm:[&_tr]:gap-y-2 max-sm:[&_tr]:rounded-md max-sm:[&_tr]:border max-sm:[&_tr]:border-border max-sm:[&_tr]:p-3 max-sm:[&_td]:block max-sm:[&_td]:p-0 max-sm:[&_td]:text-left">
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-36 font-semibold text-foreground">物品</TableHead>
            <TableHead className="w-44">
              <span className="inline-flex items-center gap-1">计价基数 N <HelpTip label="计费基数说明">物资按每 N 个单位单次计价与结算</HelpTip></span>
            </TableHead>
            <TableHead className="text-right">{fixed ? current?.mode === "SPREAD" ? "生效价差租客价（参考）" : "当前统一单价" : "当前租客单价"}</TableHead>
            <TableHead className="text-right font-semibold text-foreground">{fixed ? "统一单价（元）" : sealedView ? "待生效租客价（元）" : "草稿租客价（元）"}</TableHead>
            {mode === "SPREAD" ? (
              <>
                <TableHead className="text-right">当前号主单价</TableHead>
                <TableHead className="text-right font-semibold text-foreground">{sealedView ? "待生效号主价（元）" : "草稿号主价（元）"}</TableHead>
                <TableHead className="text-right">
                  <span className="inline-flex items-center gap-1 justify-end">平台差价 <HelpTip label="平台差价说明">租客单价与号主单价差额，按每 N 个物资单位结算平台收益</HelpTip></span>
                </TableHead>
              </>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {form.value.map((r, i) => {
            const item = rules.items.find(x => x.id === r.itemId);
            const cur = std(current?.id).find(l => l.itemId === r.itemId);
            const haff = r.pricingKind === "HAFF_RATIO";
            const lockedQty = LOCKED_UNIT_QUANTITY.has(item?.code ?? "");
            const buyer=exactUnit(price(r,"buyerUnitAmount")),owner=exactUnit(price(r,"ownerUnitAmount"));
            const spreadVal = haff || buyer===null || owner===null ? null : buyer-owner;
            const buyerChanged = cur && yuanInput(cur.buyerUnitAmount) !== yuanInput(price(r,"buyerUnitAmount"));
            const ownerChanged = cur && yuanInput(cur.ownerUnitAmount) !== yuanInput(price(r,"ownerUnitAmount"));
            const qtyChanged = cur && cur.unitQuantity !== r.unitQuantity.trim();
            return (
              <TableRow key={r.itemId}>
                <TableCell className="max-sm:col-span-2">
                  <span className="font-medium text-foreground">{item?.name ?? r.itemId}</span>
                  {rowIssue(r) ? (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-destructive">
                      <CircleAlert className="size-3 shrink-0" />
                      {rowIssue(r)}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell data-label="计价基数" className={`whitespace-nowrap ${ML}`}>
                  {haff ? (
                    <Badge variant="secondary" className="font-normal text-[11px] text-muted-foreground">
                      按哈夫币比例（见基础计价）
                    </Badge>
                  ) : lockedQty ? (
                    <div className="flex items-center gap-1">
                      <span>每 <b className="font-semibold tabular-nums text-foreground">{r.unitQuantity}</b> {unitLabel(item?.unit ?? "", item?.code)}</span>
                      <HelpTip icon={CircleAlert} label="单位锁定说明" className="text-amber-600/80 hover:text-amber-600">
                        根据资源履约契约固定按 1 个基础单位计价，不可更改。
                      </HelpTip>
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">每</span>
                      <Input
                        aria-label={`${item?.name} 单位数量`}
                        inputMode="numeric"
                        className={`h-8 w-16 text-center tabular-nums transition-colors ${qtyChanged ? "border-primary bg-primary/[0.04] font-medium ring-1 ring-primary/30" : ""}`}
                        value={r.unitQuantity}
                        disabled={locked}
                        onChange={e => set(i, "unitQuantity", e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">{unitLabel(item?.unit ?? "", item?.code)}</span>
                    </div>
                  )}
                </TableCell>
                <TableCell data-label={fixed && current?.mode === "SPREAD" ? "生效价差租客价（参考）" : fixed ? "当前统一单价" : "当前租客单价"} className={`text-right tabular-nums text-muted-foreground ${ML}`}>
                  {haff ? "—" : cur?.buyerUnitAmount ? referenceUnitYuan(cur.buyerUnitAmount) : <span className="text-muted-foreground/50">未配置</span>}
                </TableCell>
                <TableCell data-label={fixed ? "统一单价（元）" : sealedView ? "待生效租客价（元）" : "草稿租客价（元）"} className={`min-w-28 ${ML} ${haff ? "max-sm:hidden" : ""}`}>
                  {haff ? "—" : (
                    <div className="flex flex-col items-end gap-1">
                      <Input
                        aria-label={`${item?.name} ${fixed ? "统一单价" : "租客单价"}`}
                        inputMode="decimal"
                        maxLength={19}
                        value={r.buyerUnitAmount}
                        disabled={locked}
                        className={`text-right tabular-nums transition-colors ${buyerChanged ? "border-primary bg-primary/[0.04] font-medium ring-1 ring-primary/30" : ""}`}
                        onChange={e => { if (MONEY2.test(e.target.value)) { set(i, "buyerUnitAmount", e.target.value); if (hasSubCent(basis.find(line=>line.itemId===r.itemId)?.buyerUnitAmount)) setChangedPrices(previous=>new Set(previous).add(`${r.itemId}:buyerUnitAmount`)); } }}
                      />
                      {buyerChanged ? <span className="text-[10px] text-primary font-medium">已改动</span> : null}
                    </div>
                  )}
                  {!haff && hasSubCent(basis.find(line=>line.itemId===r.itemId)?.buyerUnitAmount) && !changedPrices.has(`${r.itemId}:buyerUnitAmount`) && !locked ? <Button type="button" variant="ghost" size="sm" aria-label={`${item?.name} 租客单价改用两位价格`} onClick={() => setChangedPrices(previous=>new Set(previous).add(`${r.itemId}:buyerUnitAmount`))}>改用两位价格</Button> : null}
                </TableCell>
                {mode === "SPREAD" ? (
                  <>
                    <TableCell data-label="当前号主单价" className={`text-right tabular-nums text-muted-foreground ${ML} ${haff ? "max-sm:hidden" : ""}`}>
                      {haff ? "—" : cur?.ownerUnitAmount ? referenceUnitYuan(cur.ownerUnitAmount) : <span className="text-muted-foreground/50">未配置</span>}
                    </TableCell>
                    <TableCell data-label={sealedView ? "待生效号主价（元）" : "草稿号主价（元）"} className={`min-w-28 ${ML} ${haff ? "max-sm:hidden" : ""}`}>
                      {haff ? "—" : (
                        <div className="flex flex-col items-end gap-1">
                          <Input
                            aria-label={`${item?.name} 号主单价`}
                            inputMode="decimal"
                            maxLength={19}
                            value={r.ownerUnitAmount}
                            disabled={locked}
                            className={`text-right tabular-nums transition-colors ${ownerChanged ? "border-primary bg-primary/[0.04] font-medium ring-1 ring-primary/30" : ""}`}
                            onChange={e => { if (MONEY2.test(e.target.value)) { set(i, "ownerUnitAmount", e.target.value); if (hasSubCent(basis.find(line=>line.itemId===r.itemId)?.ownerUnitAmount)) setChangedPrices(previous=>new Set(previous).add(`${r.itemId}:ownerUnitAmount`)); } }}
                          />
                          {ownerChanged ? <span className="text-[10px] text-primary font-medium">已改动</span> : null}
                        </div>
                      )}
                      {!haff && hasSubCent(basis.find(line=>line.itemId===r.itemId)?.ownerUnitAmount) && !changedPrices.has(`${r.itemId}:ownerUnitAmount`) && !locked ? <Button type="button" variant="ghost" size="sm" aria-label={`${item?.name} 号主单价改用两位价格`} onClick={() => setChangedPrices(previous=>new Set(previous).add(`${r.itemId}:ownerUnitAmount`))}>改用两位价格</Button> : null}
                    </TableCell>
                    <TableCell data-label="平台差价" className={`text-right tabular-nums ${ML} ${haff ? "max-sm:hidden" : ""}`}>
                      {spreadVal === null ? (
                        <span className="text-muted-foreground/40">—</span>
                      ) : spreadVal > 0n ? (
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400">+{spread(price(r,"buyerUnitAmount"),price(r,"ownerUnitAmount"))}</span>
                      ) : spreadVal === 0n ? (
                        <span className="text-muted-foreground tabular-nums">{spread(price(r,"buyerUnitAmount"),price(r,"ownerUnitAmount"))}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-bold text-destructive">
                          <CircleAlert className="size-3 shrink-0" />
                          {spread(price(r,"buyerUnitAmount"),price(r,"ownerUnitAmount"))}
                        </span>
                      )}
                    </TableCell>
                  </>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
    {save.messages}
    {canEdit && !sealedView ? <div className="flex flex-wrap gap-2"><Button type="button" disabled={locked || itemsInvalid || !(form.dirty || (selected && !hasDraftLines))} onClick={submit}>保存物资价目</Button>{form.dirty ? <Button type="button" variant="ghost" onClick={() => { form.reset(); setChangedPrices(new Set()); }}>放弃本次输入</Button> : null}</div> : null}
  </Panel>;
}

/* ---------------- 押金规则：只改上限 ---------------- */

const YUAN = /^\d+(\.\d{1,2})?$/;
const toCents = (y: string) => { const [i = "0", f = ""] = y.trim().split("."); return String(BigInt(i) * 100n + BigInt((f + "00").slice(0, 2))); };

export function DepositCapEditor({ rules, command, draftId, canEdit, onDirtyChange, ensureDraft }: EditorProps) {
  const selected = rules.priceVersions.find(v => v.id === draftId);
  const current = currentPrice(rules);
  const policy: FundingPolicy | null | undefined = rules.release
    ? (canEdit ? selected?.fundingPolicy ?? current?.fundingPolicy : current?.fundingPolicy)
    : selected?.fundingPolicy ?? rules.priceVersions.find(v => v.status === "SEALED" && !v.fixedFeeRates && v.fundingPolicy)?.fundingPolicy;
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
  return <Panel
    title="押金规则"
    note={
      <div className="flex flex-wrap items-center gap-1.5">
        <span>配置押金上限：号主上架时能填写的最高押金，同时作为系统推荐押金的封顶阈值。</span>
        <HelpTip label="押金规则与上限说明">
          押金由号主在账号上架时填写，系统提供推荐参考值；租客下单时按号主填写的金额进行预授权冻结。最低押金门槛与计算取整为固定策略。
        </HelpTip>
      </div>
    }
    more="押金由号主上架时填写，系统给推荐值；租客下单时按号主填的金额冻结。最低押金和取整方式是固定规则，只读。"
  >
    <DraftLine selected={selected} locked={command.locked} />
    {!policy ? <p role="status" className="text-sm text-muted-foreground">尚无资金政策，无法配置押金上限。</p> : <>
      <dl className="grid gap-3 rounded-lg border border-border/80 bg-muted/20 p-3.5 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            当前生效上限
            <HelpTip label="生效上限说明">全平台线上当前运行的押金绝对封顶值</HelpTip>
          </dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">{current?.fundingPolicy ? centsYuan(current.fundingPolicy.ownerDepositRules.capCents) : "—"}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            普通最低押金
            <HelpTip label="普通最低押金说明">号主普通出租模式下必须满足的最低押金门槛</HelpTip>
          </dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">{centsYuan(policy.ownerDepositRules.normal.minCents)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            全额包赔最低押金
            <HelpTip label="全额包赔最低押金说明">租客选用全额包赔时号主端要求的最低押金门槛</HelpTip>
          </dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-foreground">{centsYuan(policy.ownerDepositRules.fullPayoutSelected.minCents)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            推荐押金取整
            <HelpTip label="取整规则说明">系统根据属性核算出基准推荐押金后的向上/向下取整规范</HelpTip>
          </dt>
          <dd className="mt-0.5 text-xs font-medium text-foreground leading-5">{roundingText}</dd>
        </div>
      </dl>
      <label className="block max-w-xs space-y-1.5 text-xs">
        <span className="text-muted-foreground">
          {canEdit ? "草稿押金上限（元）" : "当前押金上限（元）"}
          {current?.fundingPolicy && valid && toCents(form.value) !== current.fundingPolicy.ownerDepositRules.capCents ? (
            <Badge variant="outline" className="ml-1.5 border-primary/40 bg-primary/10 text-primary text-[10px] font-normal py-0 px-1">已修改</Badge>
          ) : null}
        </span>
        <Input
          aria-label={canEdit ? "草稿押金上限（元）" : "当前押金上限（元）"}
          inputMode="decimal"
          value={form.value}
          disabled={locked}
          aria-invalid={!valid}
          className={`text-right tabular-nums transition-colors ${current?.fundingPolicy && valid && toCents(form.value) !== current.fundingPolicy.ownerDepositRules.capCents ? "border-primary bg-primary/[0.04] font-medium" : ""}`}
          onChange={e => { if (MONEY2.test(e.target.value)) form.setValue(e.target.value); }}
        />
      </label>
      {!valid ? (
        <p role="status" className="flex items-center gap-1 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />请填写有效金额，最多两位小数。
        </p>
      ) : valid && policy && BigInt(toCents(form.value)) < BigInt(policy.ownerDepositRules.fullPayoutSelected.minCents) ? (
        <p role="status" className="flex items-center gap-1 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          上限低于全额包赔最低押金 {centsYuan(policy.ownerDepositRules.fullPayoutSelected.minCents)}，号主将无法选择全额包赔。
        </p>
      ) : null}
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
  return (
    <div className="rounded-lg border border-border/80 bg-muted/20 p-3.5 text-xs leading-relaxed space-y-1.5">
      <div className="flex items-center gap-1.5 font-semibold text-foreground">
        <span>测算参考示例（与线上试算同口径）</span>
        <HelpTip label="示例说明">以当前生效规则测算标准上架场景的收益换算，金额四舍五入到分，天数向上取整。</HelpTip>
      </div>
      <p className="text-muted-foreground">
        参考场景：号主上架 <span className="font-medium text-foreground">{safeBoxLabel(e.box)} 保险箱</span>、<span className="font-medium text-foreground">{e.vit} 级体力</span>、<span className="font-medium text-foreground">{e.bear} 级负重</span>，选用「<span className="font-medium text-foreground">{e.term}</span>」，出租 <span className="font-semibold text-foreground tabular-nums">{e.haffM}M</span>（1 亿）哈夫币：
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-0.5 font-mono text-[11px] text-muted-foreground">
        <span>号主比例 ＝ {e.base} {sgn(e.vd)} {sgn(e.bd)} {sgn(e.td)} ＝ <b className="text-foreground">{e.owner}</b></span>
        <span>租客比例 ＝ {e.owner} − 利润点 {e.spread} ＝ <b className="text-foreground">{e.tenant}</b></span>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 pt-1 text-xs">
        <span>租客实付：<b className="tabular-nums font-semibold text-foreground">{unitYuan(e.tenantYuan)}</b></span>
        <span>号主结算：<b className="tabular-nums font-semibold text-foreground">{unitYuan(e.ownerYuan)}</b></span>
        <span>平台收益：<b className="tabular-nums font-bold text-emerald-600 dark:text-emerald-400">+{unitYuan(r2(e.tenantYuan - e.ownerYuan))}</b></span>
        {part === "term" && e.days ? <span>可租借天数：<b className="tabular-nums font-medium text-foreground">{e.days} 天</b></span> : null}
      </div>
    </div>
  );
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
  return (
    <div className="rounded-lg border border-border/80 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground space-y-1">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <span>推荐押金换算示例</span>
        <HelpTip label="推荐押金换算说明">
          3×3 保险箱（{centsYuan(box)}）＋ 体力 7 级及以上（{centsYuan(vit)}）＝ {centsYuan(sum)}，经取整后不超过上限。号主可改填，但须满足最低要求且不超过上限。
        </HelpTip>
      </div>
      <p>
        3×3 保险箱 <span className="font-medium text-foreground">{centsYuan(box)}</span> ＋ 体力 7 级及以上 <span className="font-medium text-foreground">{centsYuan(vit)}</span> ＝ <b className="font-semibold text-foreground tabular-nums">{centsYuan(sum)}</b>，按规则取整且不超过押金上限 <span className="font-semibold text-foreground tabular-nums">{centsYuan(policy.ownerDepositRules.capCents)}</span>。
      </p>
    </div>
  );
}
