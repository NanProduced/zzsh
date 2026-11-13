import type { Dispatch, SetStateAction } from "react";

import { friendlyError, type PriceVersionRecord, type RulesResponse } from "../../api";
import { StatusMessage } from "../../components/ui-elements";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { type PricingTab, type RulesSection } from "./rules-nav";
import { draftCommand, type useRulesWrite } from "./rules-write";
import { fixedFeeRateValid, fixedModeNames, fixedModes, type EnsureDraft } from "./step0-editors";

type Command = ReturnType<typeof useRulesWrite>;
type FeeRates = { ordinary: string; custom: string; fast: string };
type ScheduleAsk = { priceVersionId?: string; agreementVersionId?: string } | null;

export function FixedFeeDraftPanel({
  rules,
  section,
  deltaSection,
  showSchedules,
  fixedEditor,
  fixedFee,
  canCreateFixed,
  pricingVersion,
  currentPrice,
  fixedDraft,
  command,
  priceDirty,
  anyDirty,
  canSchedule,
  guard,
  ensureDraft,
  setError,
  setSuccess,
  setEditingFixedDraft,
  setPricingTab,
  setInitialRates,
  setCreateFixedOpen,
  setScheduleAsk,
}: {
  rules: RulesResponse;
  section: RulesSection;
  deltaSection: boolean;
  showSchedules: boolean;
  fixedEditor: boolean;
  fixedFee: boolean;
  canCreateFixed: boolean;
  pricingVersion: PriceVersionRecord | undefined;
  currentPrice: PriceVersionRecord | undefined;
  fixedDraft: PriceVersionRecord | undefined;
  command: Command;
  priceDirty: boolean;
  anyDirty: boolean;
  canSchedule: boolean;
  guard: (action: () => Promise<void>) => Promise<void>;
  ensureDraft: EnsureDraft;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setSuccess: Dispatch<SetStateAction<string | undefined>>;
  setEditingFixedDraft: Dispatch<SetStateAction<boolean>>;
  setPricingTab: Dispatch<SetStateAction<PricingTab>>;
  setInitialRates: Dispatch<SetStateAction<FeeRates>>;
  setCreateFixedOpen: Dispatch<SetStateAction<boolean>>;
  setScheduleAsk: Dispatch<SetStateAction<ScheduleAsk>>;
}) {
  const fixedDraftComplete = Boolean(fixedDraft?.haffRule && fixedDraft.fundingPolicy && rules.items.every(item =>
    rules.priceLines.some(line => line.priceVersionId === fixedDraft.id && line.itemId === item.id && line.customerTier === "STANDARD")));
  const sealedFixed = rules.priceVersions.find(v => v.status === "SEALED" && v.fixedFeeRates
    && v.id !== pricingVersion?.id && v.id !== currentPrice?.id
    && (v.sealedAt ?? "") > (pricingVersion?.sealedAt ?? ""));
  const changeFixedEditor = (enabled: boolean) => {
    if (priceDirty || command.locked) return;
    setEditingFixedDraft(enabled);
    if (enabled) setPricingTab("mode");
  };
  const openFixedDraft = () => {
    if (priceDirty || command.locked) return;
    if (fixedDraft) { changeFixedEditor(true); return; }
    setInitialRates({ ordinary: "", custom: "", fast: "" }); setCreateFixedOpen(true);
  };
  const sealFixed = async () => {
    if (!fixedDraft || !rules || !fixedDraftComplete || anyDirty) return;
    setError(undefined);
    try {
      const result = await command.write(draftCommand(rules.game.id, "price", "seal", { expectedRevision: fixedDraft.revision }, fixedDraft.id));
      if (result) { setEditingFixedDraft(false); setSuccess("固定手续费价目已封存，可安排生效。"); }
    } catch (failure) { setError(friendlyError(failure)); }
  };
  if (!(fixedEditor && deltaSection && !showSchedules || canCreateFixed && section === "pricing" && !showSchedules)) return null;
  return (
    <section className="section-panel space-y-2" aria-label="固定手续费价目草稿">
      <h3 className="font-semibold">固定手续费价目草稿</h3>
      {!fixedFee ? <p className="text-sm text-muted-foreground">当前生效：{pricingVersion?.mode === "SPREAD" ? "价差" : "原比例费率"}。{fixedEditor ? "正在编辑固定手续费草稿。" : "新建草稿后可填写固定手续费价目。"}</p> : null}
      {fixedEditor ? <p className="text-sm text-muted-foreground">封存后由 Boss 在「调价排期」安排价目和默认模式。押金与包赔通过规则组合安排。</p> : null}
      <div className="flex flex-wrap gap-2">
        {fixedEditor && fixedDraft ? <Button type="button" disabled={command.locked || anyDirty || !fixedDraftComplete}
          onClick={() => void guard(sealFixed)}>封存固定手续费价目</Button>
          : <Button type="button" variant="outline" disabled={command.locked || priceDirty} onClick={() => fixedFee
            ? void guard(async () => { await ensureDraft().catch(failure => setError(friendlyError(failure))); })
            : openFixedDraft()}>{!fixedFee && fixedDraft ? "编辑固定手续费草稿" : "新建固定手续费草稿"}</Button>}
        {fixedEditor && !fixedFee ? <Button type="button" variant="outline" disabled={command.locked || priceDirty} onClick={() => changeFixedEditor(false)}>返回当前价目</Button> : null}
        {sealedFixed && canSchedule ? <Button type="button" variant="outline" disabled={command.locked || priceDirty}
          onClick={() => fixedFee ? setScheduleAsk({ priceVersionId: sealedFixed.id }) : setPricingTab("schedule")}>{fixedFee ? "安排资金政策生效" : "前往调价排期"}</Button> : null}
      </div>
      {fixedEditor && fixedDraft && !fixedDraftComplete
        ? <p role="status" className="text-sm text-muted-foreground">先保存出租方式、哈夫币比例、全部物资价目和资金政策，再封存。</p> : null}
    </section>
  );
}

export function CreateFixedDraftDialog({
  open,
  rules,
  command,
  initialRates,
  setInitialRates,
  canCreateFixed,
  fixedDraft,
  priceDirty,
  guard,
  setError,
  setEditingFixedDraft,
  setPricingTab,
  setCreateFixedOpen,
  onRecover,
}: {
  open: boolean;
  rules: RulesResponse | null;
  command: Command;
  initialRates: FeeRates;
  setInitialRates: Dispatch<SetStateAction<FeeRates>>;
  canCreateFixed: boolean;
  fixedDraft: PriceVersionRecord | undefined;
  priceDirty: boolean;
  guard: (action: () => Promise<void>) => Promise<void>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setEditingFixedDraft: Dispatch<SetStateAction<boolean>>;
  setPricingTab: Dispatch<SetStateAction<PricingTab>>;
  setCreateFixedOpen: Dispatch<SetStateAction<boolean>>;
  onRecover: () => Promise<void>;
}) {
  const createFixedDraft = async () => {
    if (!rules || !canCreateFixed || fixedDraft || priceDirty || !Object.values(initialRates).every(fixedFeeRateValid)) return;
    setError(undefined);
    try {
      const result = await command.write(draftCommand(rules.game.id, "price", "create", { gameId: rules.game.id, mode: "PERCENT", fixedFeeRates: initialRates }));
      if (result) { setCreateFixedOpen(false); setEditingFixedDraft(true); setPricingTab("mode"); }
    } catch (failure) { setError(friendlyError(failure)); }
  };
  return (
    <Dialog open={open} onOpenChange={next => { if (!command.locked) setCreateFixedOpen(next); }}>
      <DialogContent closeLabel="取消" showCloseButton={!command.locked}>
        <DialogHeader><DialogTitle>新建固定手续费草稿</DialogTitle><DialogDescription>三档费率均需填写。创建后可配置统一单价及哈夫币比例，生效时间由 Boss 另行安排。</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void guard(createFixedDraft); }}>
          <div className="grid gap-3 sm:grid-cols-3">
            {fixedModes.map(mode => <Field key={mode} label={fixedModeNames[mode] + "手续费率"} required>
              <Input inputMode="decimal" value={initialRates[mode]} disabled={command.locked}
                onChange={event => setInitialRates(previous => ({ ...previous, [mode]: event.target.value.trim() }))} />
            </Field>)}
          </div>
          <p className="text-sm text-muted-foreground">小数费率，例如 0.10 代表 10%，上限 92%。</p>
          {command.state.message ? <StatusMessage error={command.state.message} /> : null}
          <DialogFooter><Button type="button" variant="outline" disabled={command.locked} onClick={() => setCreateFixedOpen(false)}>取消</Button>
            {command.pending ? <Button type="button" disabled={["busy", "recovering"].includes(command.state.kind)} onClick={() => void onRecover()}>核对原写入回执</Button>
              : <Button type="submit" disabled={command.locked || !canCreateFixed || Boolean(fixedDraft) || !Object.values(initialRates).every(fixedFeeRateValid)}>创建草稿</Button>}</DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
