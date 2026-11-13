import type { Dispatch, SetStateAction } from "react";

import type { RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { PricingSchedulesPanel } from "./pricing-schedules-panel";
import { PRICING_TABS, type PricingTab, type TermOptionDraft } from "./rules-nav";
import { RentalModeEditor } from "./rental-mode-editor";
import { type useRulesWrite } from "./rules-write";
import { BasePricingEditor, FixedRentalModeEditor, type EnsureDraft } from "./step0-editors";
import { TermOptionsPanel } from "./term-options-panel";

type Command = ReturnType<typeof useRulesWrite>;
type EditorProps = { rules: RulesResponse; command: Command; draftId: string; canEdit: boolean; ensureDraft: EnsureDraft };

export function PricingSection({
  hidden,
  pricingTab,
  setPricingTab,
  showSchedules,
  adminUserId,
  sessionId,
  gameId,
  canSchedule,
  editorKey,
  editorProps,
  fixedEditor,
  priceEditable,
  setBaseDirty,
  setModeDirty,
  setDailyDirty,
  loading,
  guard,
  termId,
  termOptions,
  setTermOptions,
  dirty,
  setDirty,
  applyTerm,
  setSwitchAsk,
  setSealAsk,
  setError,
  setSuccess,
  setLoading,
}: {
  hidden: boolean | undefined;
  pricingTab: PricingTab;
  setPricingTab: Dispatch<SetStateAction<PricingTab>>;
  showSchedules: boolean;
  adminUserId: string;
  sessionId: string | undefined;
  gameId: string;
  canSchedule: boolean;
  editorKey: string;
  editorProps: EditorProps;
  fixedEditor: boolean;
  priceEditable: boolean;
  setBaseDirty: (dirty: boolean) => void;
  setModeDirty: (dirty: boolean) => void;
  setDailyDirty: (dirty: boolean) => void;
  loading: boolean;
  guard: (action: () => Promise<void>) => Promise<void>;
  termId: string;
  termOptions: TermOptionDraft[];
  setTermOptions: Dispatch<SetStateAction<TermOptionDraft[]>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  applyTerm: (recordId: string, options: RulesResponse["termOptions"]) => void;
  setSwitchAsk: Dispatch<SetStateAction<{ kind: "term"; id: string } | null>>;
  setSealAsk: Dispatch<SetStateAction<{ kind: "term"; id: string; revision: string; label: string } | null>>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setSuccess: Dispatch<SetStateAction<string | undefined>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}) {
  const { rules, command, draftId, ensureDraft } = editorProps;
  return (
    <div hidden={hidden} className="space-y-4">
      <div role="tablist" aria-label="租赁定价" className="flex flex-wrap gap-2">{PRICING_TABS.map(([value, label]) => <Button key={value} type="button" role="tab" aria-selected={pricingTab === value} variant={pricingTab === value ? "secondary" : "ghost"} onClick={() => setPricingTab(value)}>{label}</Button>)}</div>
      <div hidden={pricingTab !== "schedule" || undefined}><PricingSchedulesPanel key={`${adminUserId}:${sessionId}:${gameId}`} gameId={gameId} command={command} canSchedule={canSchedule} active={showSchedules} /></div>
      <div hidden={pricingTab !== "base" || undefined}><BasePricingEditor key={`base:${editorKey}`} {...editorProps} part="base" onDirtyChange={setBaseDirty} /></div>
      <div hidden={pricingTab !== "mode" || undefined}>{fixedEditor ? <FixedRentalModeEditor key={`mode:${editorKey}`} {...editorProps} onDirtyChange={setModeDirty} /> : <RentalModeEditor key={`mode:${editorKey}`} rules={rules} command={command} canEdit={priceEditable} draftId={draftId} ensureDraft={ensureDraft} onDirtyChange={setModeDirty} />}</div>
      <div hidden={pricingTab !== "term" || undefined} className="space-y-6">
        <BasePricingEditor key={`daily:${editorKey}`} {...editorProps} part="term" onDirtyChange={setDailyDirty} />
        <TermOptionsPanel rules={rules} command={command} gameId={gameId} loading={loading} guard={guard} termId={termId} termOptions={termOptions} setTermOptions={setTermOptions} dirty={dirty} setDirty={setDirty} applyTerm={applyTerm} setSwitchAsk={setSwitchAsk} setSealAsk={setSealAsk} setError={setError} setSuccess={setSuccess} setLoading={setLoading} />
      </div>
    </div>
  );
}
