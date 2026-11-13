import type { Dispatch, SetStateAction } from "react";

import { friendlyError, type PriceVersionRecord, type RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { SupplySelect } from "../../components/supply/supply-select";
import { DepositCapEditor, type EnsureDraft } from "./step0-editors";
import { draftCommand, type useRulesWrite } from "./rules-write";

type Command = ReturnType<typeof useRulesWrite>;
type EditorProps = { rules: RulesResponse; command: Command; draftId: string; canEdit: boolean; ensureDraft: EnsureDraft };

export function DepositSection({
  hidden,
  editorProps,
  editorKey,
  setCapDirty,
  fixedEditor,
  fixedDraft,
  currentPrice,
  fundingVersion,
  setFundingVersion,
  payoutTermsId,
  setPayoutTermsId,
  gameId,
  guard,
  setError,
}: {
  hidden: boolean | undefined;
  editorProps: EditorProps;
  editorKey: string;
  setCapDirty: (dirty: boolean) => void;
  fixedEditor: boolean;
  fixedDraft: PriceVersionRecord | undefined;
  currentPrice: PriceVersionRecord | undefined;
  fundingVersion: string;
  setFundingVersion: Dispatch<SetStateAction<string>>;
  payoutTermsId: string;
  setPayoutTermsId: Dispatch<SetStateAction<string>>;
  gameId: string;
  guard: (action: () => Promise<void>) => Promise<void>;
  setError: Dispatch<SetStateAction<string | undefined>>;
}) {
  const { rules, command, ensureDraft } = editorProps;
  const saveFunding = async () => {
    if (!rules || !fixedEditor || !fundingVersion.trim()) return;
    const target = await ensureDraft();
    const policy = target?.draft.fundingPolicy ?? currentPrice?.fundingPolicy;
    const terms = (rules.fullPayoutTermsVersions ?? []).find(version => version.id === payoutTermsId && version.status === "SEALED");
    if (!target || !policy || fundingVersion.trim() === policy.policyVersion || (payoutTermsId && !terms)) return;
    const result = await command.write(draftCommand(rules.game.id, "price", "update", {
      expectedRevision: target.draft.revision,
      fundingPolicy: { ...policy, policyVersion: fundingVersion.trim(), ...(terms ? {
        fullPayoutPolicyRef: terms.policyRef, fullPayoutPolicyVersion: terms.policyVersion, disclosureVersion: terms.disclosureVersion,
      } : {}) },
    }, target.draft.id));
    if (result) { setFundingVersion(""); setPayoutTermsId(""); }
  };
  return (
    <div hidden={hidden} className="space-y-4">
      <DepositCapEditor key={`cap:${editorKey}`} {...editorProps} onDirtyChange={setCapDirty} />
      {fixedEditor && (fixedDraft?.fundingPolicy ?? currentPrice?.fundingPolicy) ? <section className="section-panel space-y-3" aria-label="固定手续费资金版本">
        <h3 className="font-semibold">资金政策与包赔条款</h3>
        <p className="text-sm text-muted-foreground">{fixedDraft?.fundingPolicy ? "草稿资金政策" : "生效资金政策参考"} {(fixedDraft?.fundingPolicy ?? currentPrice?.fundingPolicy)?.policyVersion}。修改押金或包赔后填写新的资金政策版本。</p>
        {fixedDraft && !fixedDraft.fundingPolicy && currentPrice?.fundingPolicy ? <Button type="button" variant="outline" disabled={command.locked} onClick={() => void guard(async () => {
          await command.write(draftCommand(gameId, "price", "update", { expectedRevision: fixedDraft.revision, fundingPolicy: currentPrice.fundingPolicy }, fixedDraft.id));
        })}>沿用生效资金政策</Button> : null}
        <Field label="新资金政策版本"><Input value={fundingVersion} disabled={command.locked} maxLength={160} onChange={event => setFundingVersion(event.target.value)} /></Field>
        <SupplySelect label="已封存包赔条款" value={payoutTermsId} onValueChange={setPayoutTermsId} disabled={command.locked}
          options={[{value:"",label:"沿用草稿条款"}, ...(rules.fullPayoutTermsVersions ?? []).filter(v => v.status === "SEALED").map(v => ({value:v.id,label:`${v.title} · ${v.policyVersion}`}))]} />
        <Button type="button" disabled={command.locked || !fundingVersion.trim() || fundingVersion.trim() === (fixedDraft?.fundingPolicy ?? currentPrice?.fundingPolicy)?.policyVersion}
          onClick={() => void saveFunding().catch(failure => setError(friendlyError(failure)))}>保存资金政策版本</Button>
      </section> : null}
    </div>
  );
}
