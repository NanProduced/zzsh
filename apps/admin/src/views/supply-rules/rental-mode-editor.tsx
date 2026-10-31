import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Info } from "lucide-react";
import type { RulesResponse } from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Checkbox } from "../../components/ui/checkbox";
import { SupplySelect } from "../../components/supply/supply-select";
import { draftCommand, type useRulesWrite } from "./rules-write";
import { DraftFastTrial } from "./rental-mode-trial-panel";
import { DraftLine, HelpTip, type EnsureDraft } from "./step0-editors";
import { boundText, buildRentalModeRule, legacyNonZero, rentalModeBase, rentalModeDraft, rentalModeIssues, rentalModeSaveBody, withFastDefaults, type BoundDraft, type RentalModeDraft } from "./rental-modes";


/**
 * 租赁模式配置：自定义 / 极速的启停、利润点与号主比例范围。
 * 只写价格草稿（新建→保存→封存），沿用 rules-write 的幂等键与原请求恢复；生效仍由 Boss 在“选择版本并确认生效”中完成。
 */
export function RentalModeEditor({ rules, command, canEdit, onDirtyChange, draftId, ensureDraft }: { rules: RulesResponse; command: ReturnType<typeof useRulesWrite>; canEdit: boolean; onDirtyChange: (dirty: boolean) => void; draftId: string; ensureDraft: EnsureDraft }) {
  const id = draftId;
  const [pendingDefaults, setPendingDefaults] = useState(false);
  const selected = rules.priceVersions.find((v) => v.id === id);
  const base = useMemo(() => rentalModeBase(rules, id), [rules, id]);
  const initial = useMemo(() => (base ? rentalModeDraft(base.haff) : null), [base]);
  const [draft, setDraft] = useState<RentalModeDraft | null>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const dirty = JSON.stringify(draft) !== baseline;
  const issues = draft ? rentalModeIssues(draft) : {};
  const hasIssues = Object.keys(issues).length > 0;
  const locked = !canEdit || command.locked || (selected ? selected.status !== "DRAFT" : false);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (dirty || command.locked) return;
    const next = initial && pendingDefaults ? withFastDefaults(initial) : initial;
    setDraft(next); setBaseline(JSON.stringify(initial));
  }, [initial, dirty, command.locked, pendingDefaults]);

  const fillFastDefaults = () => {
    if (!draft || locked) return;
    // 默认值只填入表单，仍需点“保存”才写入草稿。
    setDraft(withFastDefaults(draft));
    setNotice("表单已填入极速默认值（利润点 12、下限 C+6、不设上限）。隐藏的旧档位增量保持原值不变。核对后点“保存模式草稿”。");
  };
  const save = async () => {
    if (!base || !draft || locked || hasIssues) return;
    setError(undefined); setNotice(undefined);
    try {
      const rule = buildRentalModeRule(base.haff, draft);
      const t = await ensureDraft(); if (!t) return;
      const result = await command.write(draftCommand(t.rules.game.id, "price", "update", rentalModeSaveBody(t.rules, t.draft, base.source, rule), t.draft.id));
      if (!result) return;
      setPendingDefaults(false); setBaseline(JSON.stringify(draft));
      setNotice("已保存草稿。去「待发布修改」提交。");
    } catch (failure) { setError((failure as Error).message); }
  };

  const set = (fn: (d: RentalModeDraft) => RentalModeDraft) => setDraft((prev) => (prev ? fn(prev) : prev));
  const err = (key: string) => issues[key] ? <p id={`rm-${key}`} className="text-[11px] text-destructive">{issues[key]}</p> : null;
  const boundInput = (name: "custom" | "fast", key: "min" | "max", value: BoundDraft, label: string) => (
    <div className="min-w-0 space-y-1.5 text-xs">
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">{label}</span>
        <HelpTip label={`${label}基准说明`}>
          支持「基础比例 C ±」浮动偏移（以账号基础核算比例 C 为基准加减）或「固定比例」绝对数值。
        </HelpTip>
      </div>
      <div className="flex gap-2">
        <SupplySelect label={`${label}基准`} className="w-36 shrink-0" value={value.base} disabled={locked} options={[{ value: "C", label: "基础比例 C ±" }, { value: "ABSOLUTE", label: "固定比例" }]} onValueChange={(v) => set((d) => ({ ...d, [name]: { ...d[name], [key]: { ...d[name][key], base: v as BoundDraft["base"] } } }))} />
        <Input aria-label={label} inputMode="decimal" value={value.value} disabled={locked} placeholder={key === "max" ? "不设上限" : "必填"} aria-invalid={Boolean(issues[`${name}.${key}`])} className="min-w-28 tabular-nums"
          onChange={(e) => set((d) => ({ ...d, [name]: { ...d[name], [key]: { ...d[name][key], value: e.target.value } } }))} />
      </div>{err(`${name}.${key}`)}
    </div>
  );

  const current = rules.priceVersions.find((v) => v.id === rules.release?.priceVersionId);
  return <section className="section-panel space-y-4" aria-label="租赁模式配置">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">租赁模式</h2>
          <HelpTip label="租赁模式与比例概念">
            租客比例 ＝ 号主比例 − 平台利润点（比例差）。比例数值为 1 元兑换万哈夫币数量，数值越小单价越高。
          </HelpTip>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground leading-relaxed">
          配置自定义模式与极速模式的启停状态、号主比例限制区间及平台留存利润点。
        </p>
      </div>
      {canEdit ? <Button type="button" variant="outline" size="sm" disabled={locked || !draft} onClick={fillFastDefaults}>填入极速默认值</Button> : null}
    </div>
    {!base || !draft ? <p role="status" className="text-sm text-muted-foreground">当前生效版本不是可编辑的兼容比例规则，暂不能配置模式；请核对原始配置。</p> : <>
      <div className="grid gap-3 sm:grid-cols-2">
        <DraftLine selected={selected} locked={command.locked} />
        <div className="rounded-lg border border-border/80 bg-muted/20 p-2.5 text-xs text-muted-foreground space-y-1">
          <p>参数基准：<span className="font-medium text-foreground">{base.source.id === current?.id ? "当前生效版本" : `历史版本 #${base.source.id.slice(-6)}`}</span></p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1">
              自定义模式：
              {current && rentalModeBase(rules, "")?.haff.compatibility.modes.custom.enabled ? (
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] py-0 px-1.5 font-normal">已启用</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-normal">未启用</Badge>
              )}
            </span>
            <span className="flex items-center gap-1">
              极速模式：
              {rentalModeBase(rules, "")?.haff.compatibility.modes.fast.enabled ? (
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] py-0 px-1.5 font-normal">
                  已启用（下限 {boundText(rentalModeBase(rules, "")?.haff.compatibility.modes.fast.min)}，上限 {boundText(rentalModeBase(rules, "")?.haff.compatibility.modes.fast.max)}）
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-normal">未启用</Badge>
              )}
            </span>
          </div>
        </div>
      </div>
      {!selected ? <p role="status" className="text-xs text-muted-foreground">请在顶部草稿栏选择或新建价格草稿后编辑；未选择草稿时仅显示当前生效值，不能保存。</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <fieldset className="space-y-3.5 rounded-lg border border-border/80 bg-card/60 p-4 shadow-2xs">
          <legend className="px-1 text-sm font-semibold text-foreground">自定义模式</legend>
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox aria-label="启用自定义模式" checked={draft.custom.enabled} disabled={locked} onCheckedChange={(v) => set((d) => ({ ...d, custom: { ...d.custom, enabled: v === true } }))} />
            <span>启用自定义模式</span>
          </label>
          {draft.custom.enabled ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {boundInput("custom", "min", draft.custom.min, "号主比例下限")}
              {boundInput("custom", "max", draft.custom.max, "号主比例上限（可选）")}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">已停用；保留原有区间参数，暂不对号主开放该模式。</p>
          )}
        </fieldset>
        <fieldset className="space-y-3.5 rounded-lg border border-border/80 bg-card/60 p-4 shadow-2xs">
          <legend className="px-1 text-sm font-semibold text-foreground">极速模式</legend>
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox aria-label="启用极速模式" checked={draft.fast.enabled} disabled={locked} onCheckedChange={(v) => set((d) => ({ ...d, fast: { ...d.fast, enabled: v === true } }))} />
            <span>启用极速模式</span>
          </label>
          {draft.fast.enabled ? <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="min-w-0 space-y-1.5 text-xs">
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">利润点（比例差）</span>
                  <HelpTip label="极速模式利润点说明">
                    平台在极速模式下留存的固定比例差。租客支付比例 ＝ 号主比例 − 利润点。
                  </HelpTip>
                </div>
                <Input aria-label="极速利润点" inputMode="decimal" value={draft.fast.spreadDelta} disabled={locked} placeholder="待配置" aria-invalid={Boolean(issues["fast.spreadDelta"])} onChange={(e) => set((d) => ({ ...d, fast: { ...d.fast, spreadDelta: e.target.value } }))} />
                {err("fast.spreadDelta")}
              </label>
              {boundInput("fast", "min", draft.fast.min, "号主比例下限")}
              {boundInput("fast", "max", draft.fast.max, "号主比例上限（可选）")}
            </div>
            {legacyNonZero(draft).length ? (
              <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                <Info className="size-3.5 shrink-0 text-muted-foreground" />
                <span>历史会员档位增量已继承锁定：{legacyNonZero(draft).join("，")}</span>
              </div>
            ) : null}
          </> : (
            <p className="text-xs text-muted-foreground">已停用；号主不能选择极速上架。</p>
          )}
        </fieldset>
      </div>
      {selected ? <DraftFastTrial key={`${selected.id}:${selected.revision}`} rules={rules} version={selected} dirty={dirty} /> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs">{notice}</p> : null}
      {canEdit ? <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={locked || !dirty || hasIssues} onClick={() => void save()}>保存模式草稿</Button>
      </div> : <p className="text-xs text-muted-foreground">当前账号只有查看权限。</p>}
    </>}
  </section>;
}
