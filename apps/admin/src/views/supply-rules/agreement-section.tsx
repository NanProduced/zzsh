import type { Dispatch, SetStateAction } from "react";

import type { RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { docStage, DocStatusRow } from "./publish-flow";
import { type useRulesWrite } from "./rules-write";
import { BusyButton, RulesSelect } from "./rules-widgets";

type Command = ReturnType<typeof useRulesWrite>;

export function AgreementSection({
  hidden,
  rules,
  agreementId,
  setAgreementId,
  command,
  loading,
  canSchedule,
  onOpenPath,
  tradePath,
  setScheduleAsk,
}: {
  hidden: boolean | undefined;
  rules: RulesResponse;
  agreementId: string;
  setAgreementId: Dispatch<SetStateAction<string>>;
  command: Command;
  loading: boolean;
  canSchedule: boolean;
  onOpenPath?: (path: string) => void;
  tradePath: (trade: "agreement" | "full_payout_terms", version?: string | null) => string;
  setScheduleAsk: Dispatch<SetStateAction<{ priceVersionId?: string; agreementVersionId?: string } | null>>;
}) {
  const selectedAgreement = rules.agreementVersions.find((version) => version.id === agreementId);
  return (
    <div hidden={hidden} className="space-y-6">
      <section className="section-panel space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">协议版本</h3>
          {onOpenPath ? <Button type="button" variant="outline" onClick={() => onOpenPath(tradePath("agreement", selectedAgreement?.id))}>在协议条款中查看与编辑</Button> : null}
        </div>
        {rules.agreementVersions.length ? <div className="w-full sm:w-96"><RulesSelect label="协议版本" value={agreementId}
          disabled={command.locked} onChange={setAgreementId} options={rules.agreementVersions.map(version => ({
            value: version.id,
            label: version.title + (version.id === rules.release?.agreementVersionId ? " · 当前生效" : version.status === "DRAFT" ? " · 草稿" : " · 已封存"),
          }))} /></div> : <p className="text-sm text-muted-foreground">暂无协议版本。可在「协议条款」起草。</p>}
        {selectedAgreement ? (() => {
          const live = selectedAgreement.id === rules.release?.agreementVersionId;
          const stage = docStage(selectedAgreement, { dirty: false, live, after: rules.release?.activatedAt });
          return <DocStatusRow stage={stage} at={live ? rules.release?.activatedAt : null}
            note={live ? "租客下单时看到的就是这份" : selectedAgreement.status === "DRAFT" ? "草稿待提交" : "可在协议条款查看正文和版本差异"}>
            {selectedAgreement.status === "SEALED" && !live && canSchedule && rules.release
              ? <BusyButton type="button" size="sm" busy={loading} disabled={command.locked} onClick={() => setScheduleAsk({ agreementVersionId: selectedAgreement.id })}>安排生效</BusyButton> : null}
          </DocStatusRow>;
        })() : null}
      </section>
    </div>
  );
}
