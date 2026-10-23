import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { formatDate } from "../../api";
import { formatDiscountLabel } from "../membership-entitlement-form";
import {
  BUSINESS_NOT_CONNECTED,
  entitlementStateView,
  executionView,
  moneyLabel,
  pendingConditionLabel,
  policyStatusLabel,
  reasonLabel,
  type BusinessView,
} from "./contract";
import { Fact, FactGrid, NotApplicable, Section } from "./atoms";

/** 摘要来自申请或最终批准快照，当前业务状态另列。 */
function text(summary: Record<string, unknown>, key: string): string | null {
  const value = summary[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function bool(summary: Record<string, unknown>, key: string): string | null {
  const value = summary[key];
  return typeof value === "boolean" ? (value ? "是" : "否") : null;
}

function MoneyRow({ label, value }: { label: string; value: unknown }) {
  return <Fact label={label} value={moneyLabel(value)} />;
}

function depositBenefitSummary(summary: Record<string, unknown>): string | null {
  if (summary.depositWaived === true) return "完全免押";
  const allowance = text(summary, "depositAllowanceCents");
  if (allowance && allowance !== "0" && /^[1-9]\d*$/.test(allowance)) {
    const val = BigInt(allowance);
    const whole = val / 100n;
    const rem = val % 100n;
    const yuan = rem === 0n ? whole.toString() : `${whole}.${rem.toString().padStart(2, "0").replace(/0$/, "")}`;
    return `减免${yuan}元`;
  }
  if (summary.depositWaived === false) return "不减免";
  return null;
}

function pricingScopeLabel(pricing: Record<string, unknown>): string {
  const scope = typeof pricing.scope === "string" ? pricing.scope : null;
  const mode = typeof pricing.mode === "string" ? pricing.mode : null;
  if (scope === "ALL_ENABLED_RENTAL_MODES") return "全部已启用租赁方式统一";
  if (mode) return `旧版 · ${({ ordinary: "普通", custom: "自定义", fast: "极速" } as Record<string, string>)[mode] ?? mode}`;
  return "范围待核";
}

function MembershipSummary({ summary }: { summary: Record<string, unknown> }) {
  const draft = summary.policyDraft as Record<string, unknown> | undefined;
  const inline = summary.inlinePolicy as Record<string, unknown> | undefined;
  const pricing = summary.pricingSummary as Record<string, unknown> | undefined;
  const original = summary.originalRequest as Record<string, unknown> | undefined;
  const originalPricing = original?.pricingSummary as Record<string, unknown> | undefined;
  return (
    <FactGrid>
      <Fact label="游戏" value={text(summary, "gameName")} />
      <Fact label="礼遇类型" value={text(summary, "entitlementKindTitle") ?? text(summary, "entitlementKind")} />
      {pricing ? <Fact label="实际折扣" value={pricing.knowledge === "LEGACY" ? "旧版计价合同" : formatDiscountLabel(text(pricing, "payableRatio") ?? undefined)} /> : null}
      {pricing ? <Fact label="适用范围" value={pricingScopeLabel(pricing)} /> : null}
      {summary.payloadSource === "APPROVED_FINAL" ? <Fact label="内容来源" value="最终批准内容（原申请保留）" /> : null}
      {originalPricing ? <Fact label="原申请折扣" value={originalPricing.knowledge === "LEGACY" ? "旧版计价合同" : formatDiscountLabel(text(originalPricing, "payableRatio") ?? undefined)} /> : null}
      <Fact label="目标用户" value={text(summary, "targetUserId")} mono />
      <Fact label="作用范围标识" value={text(summary, "scopeKey")} mono />
      <Fact label="生效开始（快照）" value={formatDate(text(summary, "startsAt"))} />
      <Fact label="生效结束（快照）" value={formatDate(text(summary, "endsAt"))} />
      <Fact label="押金权益" value={depositBenefitSummary(summary) ?? bool(summary, "depositWaived")} />
      {original && depositBenefitSummary(original) ? <Fact label="原申请押金权益" value={depositBenefitSummary(original)} /> : null}
      <Fact label="关联政策" value={
        text(summary, "policyId")
          ? `${text(summary, "policyId")}${typeof summary.policyVersion === "number" ? ` · v${summary.policyVersion}` : ""}${text(summary, "policyStatus") ? ` · ${policyStatusLabel(text(summary, "policyStatus"))}` : ""}`
          : null
      } mono />
      {draft ? (
        <>
          <Fact label="政策草稿" value={`${String(draft.id)}${typeof draft.version === "number" ? ` · v${draft.version}` : ""}`} mono />
          <Fact label="草稿哈希" value={text(draft, "hash")} mono />
          <Fact label="草稿生效时间" value={formatDate(text(draft, "effectiveAtUtc"))} />
          <Fact label="规则发布 / 价格版本" value={[text(draft, "ruleReleaseId"), text(draft, "priceVersionId")].filter(Boolean).join(" · ") || null} mono />
        </>
      ) : null}
      {inline ? (
        <>
          <Fact label="内联政策版本" value={typeof inline.versionNo === "number" ? `v${inline.versionNo}` : null} />
          <Fact label="内联政策层级" value={Array.isArray(inline.tierCodes) && inline.tierCodes.length > 0 ? inline.tierCodes.join("、") : null} />
        </>
      ) : null}
    </FactGrid>
  );
}

/** 被撤销 / 被替换的目标权益：申请时冻结的作用范围 vs 该对象当前状态。 */
function FrozenTargets({ summary }: { summary: Record<string, unknown> }) {
  const rows = ([
    ["revokedEntitlement", "本次撤销的目标权益"],
    ["replacedEntitlement", "本次替换掉的原权益"],
  ] as const).flatMap(([key, label]) => {
    const target = summary[key];
    return target && typeof target === "object" ? [{ label, target: target as Record<string, unknown> }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div className="space-y-3">
      {rows.map(({ label, target }) => {
        const readAvailable = target.readAvailable === true;
        const current = entitlementStateView(readAvailable ? text(target, "currentStatus") : null);
        return (
          <div key={label} className="rounded-md border border-border/60 bg-foreground/[0.02] p-3">
            <p className="text-xs font-medium text-foreground">{label}</p>
            <div className="mt-3">
              <FactGrid>
                <Fact label="权益对象" value={text(target, "id")} mono />
                <Fact label="冻结的作用范围（申请时）" value={text(target, "frozenTargetScopeKey")} mono />
                <Fact
                  label="该对象当前状态"
                  value={readAvailable
                    ? <span className="inline-flex items-center gap-2">{current.label}{text(target, "currentEndsAt") ? <span className="text-xs text-muted-foreground">至 {formatDate(text(target, "currentEndsAt"))}</span> : null}</span>
                    : null}
                />
              </FactGrid>
              {readAvailable ? null : (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  读不到该权益当前行；这只说明当前状态未知，不代表申请时的冻结内容有误，也不代表撤销或替换失败。
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SettlementSummary({ summary }: { summary: Record<string, unknown> }) {
  const amounts = [
    ["已捕获金额", "capturedAmount"],
    ["押金", "depositAmount"],
  ] as const;
  return (
    <>
      <FactGrid>
        <Fact label="结算口径" value={text(summary, "settlementSchema")} mono />
        <Fact label="结束原因" value={text(summary, "endReason")} />
        <Fact label="是否提前结束" value={bool(summary, "early")} />
        <Fact label="基准结算版本" value={[text(summary, "baseSettlementVersionNo"), text(summary, "baseSettlementVersionId")].filter(Boolean).join(" · ") || null} mono />
        <Fact label="开账版本" value={[text(summary, "openingVersion"), text(summary, "openingId")].filter(Boolean).join(" · ") || null} mono />
        <Fact label="支付确认" value={text(summary, "paymentConfirmationId")} mono />
        {amounts.map(([label, key]) => <MoneyRow key={key} label={label} value={summary[key]} />)}
      </FactGrid>
      <details className="rounded-md border border-border/60 px-3 py-2 text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground">绑定依据摘要（决定 / 报价 / 支付 / 房源）</summary>
        <div className="mt-2">
          <FactGrid>
            <Fact label="决定摘要" value={text(summary, "decisionDigest")} mono />
            <Fact label="报价摘要" value={text(summary, "quoteDigest")} mono />
            <Fact label="支付摘要" value={text(summary, "paymentDigest")} mono />
            <Fact label="房源哈希" value={text(summary, "listingHash")} mono />
          </FactGrid>
        </div>
      </details>
    </>
  );
}

/** 系统计算值 → 拟调整值。拟调整租客应退是应退责任，不是渠道已到账。 */
function SettlementCompare({ summary }: { summary: Record<string, unknown> }) {
  const rows = [
    ["号主净入账", "systemOwnerNet", "proposedOwnerNet"],
    ["租客应退", "systemRenterRefund", "proposedRenterRefund"],
  ] as const;
  const visible = rows.filter(([, system, proposed]) => moneyLabel(summary[system]) !== null || moneyLabel(summary[proposed]) !== null);
  if (visible.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full text-sm">
        <caption className="sr-only">结算调整前后对照</caption>
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">项目</th>
            <th scope="col" className="px-3 py-2 font-medium">系统计算（调整前）</th>
            <th scope="col" className="px-3 py-2 font-medium">本次拟调整</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(([label, system, proposed]) => (
            <tr key={label} className="border-b border-border/40 last:border-b-0">
              <th scope="row" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{label}</th>
              <td className="px-3 py-2 tabular-nums">{moneyLabel(summary[system]) ?? <span className="text-xs text-muted-foreground">未提供</span>}</td>
              <td className="px-3 py-2 tabular-nums">{moneyLabel(summary[proposed]) ?? <span className="text-xs text-muted-foreground">未提供</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        差额不在前端计算。「租客应退」是平台侧应退责任，不等于渠道已到账；实际到账以结算过账与渠道回执为准。
      </p>
    </div>
  );
}

function DomainResult({ business }: { business: BusinessView }) {
  const settlement = business.settlementResult;
  const receipt = business.executionReceipt;
  const pending = business.pendingConditionCodes ?? [];
  return (
    <Section
      title="领域结果（业务对象现在是什么）"
      hint="与审批状态、执行状态分列。审批执行成功不代表业务对象已生效或资金已到账。"
    >
      {business.resultAvailability === "UNRESOLVED" ? (
        <Alert variant="warning">
          <AlertTitle className="text-sm">业务结果未读到</AlertTitle>
          <AlertDescription className="text-xs">
            {reasonLabel(business.resultReasonCode)}。申请可能已执行，但读不到对应业务行；这不等于失败，也不等于成功，请按来源业务核对。
          </AlertDescription>
        </Alert>
      ) : null}
      {business.resultAvailability === "NOT_APPLICABLE" ? (
        <p className="text-xs text-muted-foreground">尚未到执行阶段，没有领域结果可读。</p>
      ) : null}
      {business.resultAvailability === undefined ? (
        <p className="text-xs text-muted-foreground">服务端未提供业务结果字段。</p>
      ) : null}

      {receipt ? (
        <FactGrid>
          <Fact
            label="本次执行回执"
            value={(() => {
              const view = executionView(receipt.status);
              return <span className="inline-flex flex-wrap items-center gap-2">{view.label}<span className="font-mono text-xs text-muted-foreground">{receipt.resultCode}</span></span>;
            })()}
          />
          <Fact label="回执说明" value={receipt.resultDetail} />
        </FactGrid>
      ) : null}

      {business.publishedPolicy ? (
        <FactGrid>
          <Fact label="已发布政策" value={`v${business.publishedPolicy.version} · ${policyStatusLabel(business.publishedPolicy.status)}`} />
          <Fact label="政策生效时间" value={formatDate(business.publishedPolicy.effectiveAt)} />
          <Fact label="政策对象" value={business.publishedPolicy.id} mono />
        </FactGrid>
      ) : null}

      {business.entitlement ? (() => {
        const view = entitlementStateView(business.entitlement.effectiveState || business.entitlement.status);
        return (
          <FactGrid>
            <Fact label="权益当前状态" value={view.label} />
            <Fact label="生效开始" value={formatDate(business.entitlement.startsAt)} />
            <Fact label="生效结束" value={formatDate(business.entitlement.endsAt)} />
            <Fact label="权益对象" value={business.entitlement.id} mono />
            <Fact label="被替换为" value={business.entitlement.replacedById} mono />
          </FactGrid>
        );
      })() : null}

      {settlement ? (
        <>
          <FactGrid>
            <Fact label="结算版本" value={`v${settlement.versionNo}${settlement.currentVersion ? "（当前版本）" : "（已被后续版本替代）"}`} />
            <Fact label="版本类型" value={settlement.kind} />
            <Fact label="批准载荷与版本一致" value={settlement.approvedPayloadMatchesVersion ? "一致" : "不一致，需要重新核对"} />
            <Fact label="已确认方" value={settlement.confirmedParties.length > 0 ? settlement.confirmedParties.map(partyLabel).join("、") : "尚无"} />
            <Fact label="已拒绝方" value={settlement.rejectedParties.length > 0 ? settlement.rejectedParties.map(partyLabel).join("、") : "无"} />
            <Fact label="客服复核" value={settlement.supportReviewed ? "已复核" : "未复核"} />
            <Fact label="过账" value={settlement.posted ? `已过账${settlement.postedAt ? ` · ${formatDate(settlement.postedAt)}` : ""}` : "未过账"} />
            <Fact label="应退时间" value={formatDate(settlement.refundDueAt)} />
          </FactGrid>
          {pending.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">来源业务仍需完成：</span>
              {pending.map((code) => <Badge key={code} variant="warning">{pendingConditionLabel(code)}</Badge>)}
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function partyLabel(party: string): string {
  if (party === "RENTER") return "租客";
  if (party === "OWNER") return "号主";
  return party;
}

export function BusinessSummary({ business, operationCode }: { business: BusinessView | undefined; operationCode: string }) {
  if (business === undefined) {
    return (
      <Section title="此次申请改变什么">
        <Alert variant="default">
          <AlertTitle className="text-sm">{BUSINESS_NOT_CONNECTED}</AlertTitle>
          <AlertDescription className="text-xs">
            这笔申请的受权摘要与领域结果暂未接入，本页不解析载荷猜测含义；请联系管理员确认接入进度。
            操作标识见页面底部「技术追溯」。
          </AlertDescription>
        </Alert>
      </Section>
    );
  }

  const summary = business.summary;
  const restricted = business.restrictedReasonCodes ?? [];
  const changeSummary = business.changeSummary ?? text(summary ?? {}, "changeSummary");
  const pricing = business.pricingReference as Record<string, unknown> | undefined;
  const costBasis = business.costBasis as Record<string, unknown> | undefined;

  return (
    <>
      <Section
        title="此次申请改变什么"
        hint="全部来自申请时冻结的载荷快照，不用当前值替换；当前事实另列在下方与「领域结果」。"
      >
        {changeSummary
          ? <p className="text-sm leading-relaxed text-foreground">{changeSummary}</p>
          : <p className="text-xs text-muted-foreground">服务端未提供变更说明。</p>}
        {business.summaryAvailable === false ? (
          <NotApplicable reason={`无权查看本次申请的业务摘要：${restricted.map(reasonLabel).join("；") || "原因未提供"}。这与「你能否审批」是两件事，动作资格以逐项 actions 为准。`} />
        ) : null}
      </Section>

      {business.summaryAvailable !== false && summary ? (
        <Section title="申请时快照">
          {business.businessType === "settlement" ? <SettlementSummary summary={summary} /> : <MembershipSummary summary={summary} />}
          <FactGrid>
            {business.game ? <Fact label="游戏" value={business.game.name ?? business.game.id} /> : null}
            <Fact label="载荷版本" value={typeof summary.payloadVersion === "number" ? `v${summary.payloadVersion}` : null} />
            <Fact label="载荷哈希" value={text(summary, "payloadHash")} mono />
            <Fact label="申请理由" value={text(summary, "reason")} />
            {pricing ? <Fact label="定价口径引用" value={[pricingScopeLabel(pricing), text(pricing, "priceVersionId"), text(pricing, "costBasisRef"), text(pricing, "schema")].filter(Boolean).join(" · ") || null} mono /> : null}
            {costBasis ? <Fact label="成本依据" value={[text(costBasis, "priceVersionId"), text(costBasis, "ruleReleaseId")].filter(Boolean).join(" · ") || null} mono /> : null}
          </FactGrid>
          {business.businessType === "settlement" ? <SettlementCompare summary={summary} /> : null}
          {business.businessType === "membership" ? <FrozenTargets summary={summary} /> : null}
        </Section>
      ) : null}

      {business.pricingRestrictedReasonCode ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          定价与成本口径未显示：{reasonLabel(business.pricingRestrictedReasonCode)}。
        </p>
      ) : null}

      {business.summaryAvailable === false ? null : <DomainResult business={business} />}
    </>
  );
}
