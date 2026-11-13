import type { RulesResponse } from "../../api";
import { Button } from "../../components/ui/button";
import { SettlementRules } from "./rules-overview";

export function SettlementSection({
  hidden,
  rules,
  fixedFee,
  onOpenPath,
  tradePath,
}: {
  hidden: boolean | undefined;
  rules: RulesResponse;
  fixedFee: boolean;
  onOpenPath?: (path: string) => void;
  tradePath: (trade: "agreement" | "full_payout_terms", version?: string | null) => string;
}) {
  return (
    <div hidden={hidden} className="space-y-6">
      <section className="section-panel" aria-label="结算与退赔"><SettlementRules fixedFee={fixedFee} /></section>
      <section className="section-panel flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-sm font-semibold">全额包赔条款</h3><p className="mt-1 text-xs text-muted-foreground">
          {rules.fullPayoutTermsVersions?.find(version => version.id === rules.currentFullPayoutTermsVersionId)?.title ?? "当前价格版本未引用条款"}
        </p></div>
        {onOpenPath ? <Button type="button" variant="outline" onClick={() => onOpenPath(tradePath("full_payout_terms", rules.currentFullPayoutTermsVersionId))}>在协议条款中查看</Button> : null}
      </section>
    </div>
  );
}
