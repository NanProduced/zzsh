import { Info, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import { PlateDocument } from "@zzsh/ui/plate-document";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EntityPreviewTrigger, OrderPreviewCard, UserProfilePreview } from "../../components/admin-preview";
import { adminRequest } from "../../api";
import { formatDiscountLabel } from "../membership-entitlement-form";
import { financeMoney } from '../admin-finance-api';
import { DiffBlocks } from "../legal-document-diff";
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
import { Fact, FactGrid, NotApplicable, Section, UnknownFact, formatApprovalDate as formatDate } from "./atoms";

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

/** 审批人先看的三到四个关键事实；未知值不补零、不伪装成已确认。 */
function KeyFacts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/60 bg-foreground/[0.02] p-4 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <p className="text-xs text-muted-foreground">{item.label}</p>
          <div className="mt-1 text-base leading-relaxed font-medium break-words text-foreground tabular-nums">
            {item.value === null || item.value === undefined || item.value === "" ? <UnknownFact hint="这项信息暂未提供；不按 0 或已完成显示。" /> : item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function ImpactNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-foreground/[0.04] px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

type OpenPath = ((path: string, title: string) => void) | undefined;

/** 业务对象不显示内部 UUID：用户显示姓名并打开资料预览，订单显示展示号并打开订单详情。 */
function UserEntity({ userId, name, onOpenPath }: { userId: string; name?: string | null; onOpenPath?: OpenPath }) {
  const [resolvedName, setResolvedName] = useState(name?.trim() || "");
  // shortcut: older API builds omit targetUserName; drop this fallback after the projection is fully rolled out.
  useEffect(() => {
    if (resolvedName || !onOpenPath) return;
    let active = true;
    void adminRequest<{ user?: { name?: string } }>(`/users/${encodeURIComponent(userId)}`)
      .then((value) => { if (active) setResolvedName(value.user?.name?.trim() || ""); })
      .catch(() => { /* The hover card already states when the profile is unavailable. */ });
    return () => { active = false; };
  }, [userId, resolvedName, onOpenPath]);
  const label = resolvedName || "查看用户资料";
  const open = onOpenPath ? () => onOpenPath(`/users/${encodeURIComponent(userId)}`, "用户详情") : undefined;
  return (
    <EntityPreviewTrigger
      touchLabel={`预览用户 ${label}`}
      trigger={open
        ? <Button type="button" variant="link" className="h-auto max-w-full p-0 text-left text-sm" onClick={open}>{label}</Button>
        : <span className="text-sm">{label}</span>}
      content={<UserProfilePreview userId={userId} name={label} request={adminRequest} onOpenProfile={open} />}
    />
  );
}

function OrderEntity({ orderId, displayNo, origin, onOpenPath }: { orderId: string; displayNo?: string | null; origin?: string | null; onOpenPath?: OpenPath }) {
  const [resolvedNo, setResolvedNo] = useState(displayNo?.trim() || "");
  // shortcut: older API builds omit displayNo; drop this fallback after the projection is fully rolled out.
  useEffect(() => {
    if (resolvedNo) return;
    let active = true;
    void adminRequest<{ order?: { displayNo?: string } }>(`/orders/${encodeURIComponent(orderId)}`)
      .then((value) => { if (active) setResolvedNo(value.order?.displayNo?.trim() || ""); })
      .catch(() => { /* The hover card states when the order is unavailable. */ });
    return () => { active = false; };
  }, [orderId, resolvedNo]);
  const label = resolvedNo || "查看订单";
  const open = onOpenPath ? () => onOpenPath(`/orders/${encodeURIComponent(orderId)}`, "订单详情") : undefined;
  return (
    <EntityPreviewTrigger
      touchLabel={`预览订单 ${label}`}
      trigger={open
        ? <Button type="button" variant="link" className="h-auto max-w-full p-0 text-left text-sm" onClick={open}>{label}</Button>
        : <span className="text-sm">{label}</span>}
      content={<OrderPreviewCard orderId={orderId} displayNo={resolvedNo || displayNo} sourceOrigin={origin} canOpen={Boolean(open)} onOpen={open} deniedReason="当前账号无权查看订单详情" />}
    />
  );
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

function MembershipSummary({ summary, onOpenPath }: { summary: Record<string, unknown>; onOpenPath?: OpenPath }) {
  const pricing = summary.pricingSummary as Record<string, unknown> | undefined;
  const original = summary.originalRequest as Record<string, unknown> | undefined;
  const originalPricing = original?.pricingSummary as Record<string, unknown> | undefined;
  return (
    <FactGrid>
      <Fact label="游戏" value={text(summary, "gameName")} />
      <Fact label="礼遇类型" value={text(summary, "entitlementKindTitle") ?? text(summary, "entitlementKind")} />
      {pricing ? <Fact label="实际折扣" value={pricing.knowledge === "LEGACY" ? "旧版计价合同" : formatDiscountLabel(text(pricing, "payableRatio") ?? undefined)} /> : null}
      {summary.payloadSource === "APPROVED_FINAL" ? <Fact label="内容来源" value="最终批准内容（原申请保留）" /> : null}
      {originalPricing ? <Fact label="原申请折扣" value={originalPricing.knowledge === "LEGACY" ? "旧版计价合同" : formatDiscountLabel(text(originalPricing, "payableRatio") ?? undefined)} /> : null}
      <Fact label="目标用户" value={text(summary, "targetUserId") ? <UserEntity userId={text(summary, "targetUserId")!} name={text(summary, "targetUserName")} onOpenPath={onOpenPath} /> : null} />
      <Fact label="权益期限（申请快照）" value={text(summary, "startsAt") || text(summary, "endsAt") ? `${formatDate(text(summary, "startsAt"))} → ${formatDate(text(summary, "endsAt"))}` : null} />
      <Fact label="押金权益" value={depositBenefitSummary(summary) ?? bool(summary, "depositWaived")} />
      {original && depositBenefitSummary(original) ? <Fact label="原申请押金权益" value={depositBenefitSummary(original)} /> : null}
    </FactGrid>
  );
}

function MembershipEntitlementContent({ business, summary, operationCode, onOpenPath }: { business: BusinessView; summary: Record<string, unknown>; operationCode: string; onOpenPath?: OpenPath }) {
  const pricing = summary.pricingSummary as Record<string, unknown> | undefined;
  const targetUserId = text(summary, "targetUserId");
  const target = targetUserId ? <UserEntity userId={targetUserId} name={text(summary, "targetUserName")} onOpenPath={onOpenPath} /> : null;
  const kind = text(summary, "entitlementKindTitle") ?? text(summary, "entitlementKind");
  const start = text(summary, "startsAt");
  const end = text(summary, "endsAt");
  const period = start || end ? `${formatDate(start)} → ${formatDate(end)}` : null;
  const revoke = operationCode === "membership.entitlement.revoke";
  const replace = operationCode === "membership.entitlement.replace";
  return (
    <div className="space-y-4">
      <KeyFacts items={[
        { label: "目标用户", value: target },
        { label: "礼遇类型", value: kind },
        { label: "实际折扣", value: pricing ? (pricing.knowledge === "LEGACY" ? "旧版计价合同" : formatDiscountLabel(text(pricing, "payableRatio") ?? undefined)) : null },
        { label: revoke ? "原到期时间" : "权益期限", value: period },
      ]} />
      <Section title="申请时快照">
        <MembershipSummary summary={summary} onOpenPath={onOpenPath} />
      </Section>
      {replace || revoke ? (
        <Section title={replace ? "被替换的原权益" : "被撤销的目标权益"}>
          <FrozenTargets summary={summary} />
        </Section>
      ) : null}
      <ImpactNote>
        {replace ? "批准后按新权益替换原权益，旧权益保留历史记录。" : revoke ? "批准后目标权益撤销，历史订单与已发生权益不追溯改写。" : "批准后生成权益并按申请期限进入生效窗口；权益状态以业务记录为准。"}
      </ImpactNote>
      {business.resultAvailability === "UNRESOLVED" ? <ImpactNote>本次执行结果尚未读到，请按权益记录核对，不要重复办理。</ImpactNote> : null}
    </div>
  );
}

function CompensationSummary({ business, onOpenPath }: { business: BusinessView; onOpenPath?: OpenPath }) {
  const compensation = business.compensation;
  if (!compensation) return <NotApplicable reason="包赔赔偿快照未提供，不能用当前订单状态替代本次申请。" />;
  const order = <OrderEntity orderId={compensation.orderId} displayNo={compensation.displayNo} origin={compensation.origin} onOpenPath={onOpenPath} />;
  const recipient = <UserEntity userId={compensation.ownerUserId} name={compensation.ownerName} onOpenPath={onOpenPath} />;
  const outcome = business.resultAvailability === "KNOWN"
    ? "已核实赔偿入账"
    : business.resultAvailability === "UNRESOLVED"
      ? "入账结果待核对，请勿重复办理"
      : "尚未形成赔偿入账";
  return (
    <div className="space-y-4">
      <KeyFacts items={[
        { label: "赔偿金额", value: financeMoney(compensation.amountCents) },
        { label: "订单", value: order },
        { label: "入账对象", value: recipient },
        { label: "订单来源", value: compensation.origin === "LEGACY" ? "旧平台订单" : "新平台订单" },
      ]} />
      <Section title="事故与核对依据">
        <FactGrid>
          <Fact label="事故或工单编号" value={compensation.caseRef} />
          <Fact label="核对依据" value={compensation.evidenceRef} />
          <Fact label="处理原因" value={compensation.reason} />
        </FactGrid>
      </Section>
      <Section title="当前结果">
        <Fact label="赔偿入账" value={outcome} />
      </Section>
      <ImpactNote>批准后赔偿计入号主可用余额；这不代表渠道退款到账，也不代表订单已经完结。</ImpactNote>
    </div>
  );
}

function MembershipPolicyContent({ business }: { business: BusinessView }) {
  const summary = business.summary ?? {};
  const draft = (summary.policyDraft ?? {}) as Record<string, unknown>;
  return (
    <div className="space-y-4">
      <KeyFacts items={[
        { label: "政策草稿", value: text(draft, "id") ? `v${text(draft, "version") ?? "?"}` : null },
        { label: "草稿状态", value: text(draft, "currentStatus") },
        { label: "拟定生效", value: formatDate(text(draft, "effectiveAtUtc")) },
        { label: "申请理由", value: text(summary, "reason") },
      ]} />
      <details className="rounded-md border border-border/60 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-foreground">政策引用</summary>
        <div className="mt-3"><FactGrid>
          <Fact label="规则版本" value={text(draft, "ruleReleaseId")} mono />
          <Fact label="价格版本" value={text(draft, "priceVersionId")} mono />
          <Fact label="草稿来源" value={text(draft, "sourceRef")} mono />
          <Fact label="草稿摘要" value={text(draft, "hash")} mono />
        </FactGrid></div>
      </details>
      <ImpactNote>
        批准后发布新政策版本；已冻结订单不重算。审批快照不包含逐档权益差异，批准前请在会员成长页核对完整政策。
      </ImpactNote>
    </div>
  );
}

function ReversalSummary({ business, onOpenPath }: { business: BusinessView; onOpenPath?: OpenPath }) {
  const reversal = business.reversal;
  if (!reversal) return <NotApplicable reason="佣金冲回快照未提供，不能用当前佣金状态替代本次申请。" />;
  const original = reversal.original;
  const order = reversal.orderId ? <OrderEntity orderId={reversal.orderId} displayNo={reversal.orderDisplayNo} onOpenPath={onOpenPath} /> : null;
  const authorization = reversal.authorization.knowledge === "KNOWN"
    ? "已授权冲回"
    : reversal.authorization.knowledge === "REJECTED" ? "授权被拒" : "尚未授权";
  return (
    <div className="space-y-4">
      <KeyFacts items={[
        { label: "冲回金额", value: financeMoney(reversal.amountCents) },
        { label: "订单", value: order },
        { label: "冲回范围", value: reversal.full ? "全额冲回" : "部分冲回" },
        { label: "授权状态", value: authorization },
      ]} />
      <Section title="被冲回的原佣金">
        {original ? (
          <FactGrid>
            <Fact label="受益人" value={<UserEntity userId={original.beneficiaryUserId} name={original.beneficiaryName} onOpenPath={onOpenPath} />} />
            <Fact label="受益人角色" value={partyLabel(original.role)} />
            <Fact label="原佣金金额" value={financeMoney(original.amountCents)} />
            <Fact label="原状态" value={original.state} />
            <Fact label="已冲回次数" value={reversal.reversalsAlreadyRecorded === null ? null : String(reversal.reversalsAlreadyRecorded)} />
            <Fact label="政策版本" value={original.policyVersion} />
          </FactGrid>
        ) : <NotApplicable reason="读不到原佣金行；这只说明原事实未知，不代表本次冲回可以跳过核对。" />}
      </Section>
      <Section title="本次申请">
        <FactGrid>
          <Fact label="冲回原因" value={reversal.reason} />
          <Fact label="原事实核对" value={reversal.originalFactsKnowledge === "KNOWN" ? "与申请金额一致" : reversal.originalFactsKnowledge === "MISMATCH" ? "与申请金额不一致" : "原记录未知"} />
        </FactGrid>
      </Section>
      <ImpactNote>批准只授权冲回；实际佣金和钱包变动以执行回执为准，不把授权当成已到账或已冲回。</ImpactNote>
    </div>
  );
}

function TestOperationSummary({ business }: { business: BusinessView }) {
  return (
    <div className="space-y-4">
      <KeyFacts items={[
        { label: "操作类型", value: "本地非资金测试动作" },
        { label: "执行方式", value: business.executionMode === "GENERIC_TRANSACTION" ? "系统办理" : business.executionMode },
        { label: "申请摘要", value: business.changeSummary },
      ]} />
      <ImpactNote>这是本地测试操作，不产生资金或业务事实；生产环境不提供该发起入口。</ImpactNote>
    </div>
  );
}

/** Policy publish has no entitlement target/user fields; only the frozen draft metadata is available today. */
function DistributionSummary({ business }: { business: BusinessView }) {
  const change = business.policyChange;
  if (!change || !["distribution-policy-change.v1", "distribution-policy-initialize.v1", "distribution-policy-initialize.v2"].includes(change.schema ?? "")) return <NotApplicable reason="分销变更快照未提供，不能用当前政策替代本次申请。" />;
  const legacy = change.schema === "distribution-policy-initialize.v2";
  const initial = legacy || change.schema === "distribution-policy-initialize.v1";
  const changes = change.changes && typeof change.changes === "object" && !Array.isArray(change.changes) ? change.changes : {};
  const legacySource = changes.legacySource as {levelNames?:Record<string,string>} | undefined;
  const levels = Array.isArray(changes.levels) ? changes.levels : [];
  const changed = (key: string) => Object.prototype.hasOwnProperty.call(changes, key);
  const percent = (key: string) => changed(key) ? text(changes, key) === null ? null : `${text(changes, key)}%` : "本次未变更";
  const delay = Number.isInteger(changes.settlementDelayDays) && Number(changes.settlementDelayDays) >= 0 ? `${changes.settlementDelayDays} 天` : null;
  const executed = business.result?.knowledge === "KNOWN" && typeof business.result.policyVersionId === "string" && business.result.policyVersionId.trim() !== "";
  const enabled = typeof changes.enabled === "boolean" ? (changes.enabled ? "启用" : "暂停") : null;
  return <div className="space-y-4">
    <KeyFacts items={[
      { label: "申请类型", value: initial ? "首版配置" : "政策变更" },
      { label: "计佣状态", value: enabled },
      { label: "申请理由", value: change.reason },
      { label: "执行结果", value: executed ? "已读到本次执行的版本引用" : null },
    ]} />
    <Section title="分销政策变更快照">
      <FactGrid>
        <Fact label={initial ? "首版计佣状态" : "新增计佣"} value={enabled} />
        {legacy ? null : <Fact label="租客来源佣金比例" value={initial ? (text(changes, "renterPercent") === null ? null : `${text(changes, "renterPercent")}%`) : percent("renterPercent")} />}
        {legacy ? null : <Fact label="号主来源佣金比例" value={initial ? (text(changes, "ownerPercent") === null ? null : `${text(changes, "ownerPercent")}%`) : percent("ownerPercent")} />}
        {initial ? <Fact label="最低计提 / 结算等待" value={`${text(changes, "minimumAccrualCents") ?? "未知"} 分 / ${delay ?? "未知"}`} /> : changed("settlementDelayDays") ? <Fact label="结算后等待入账" value={delay} /> : null}
        <Fact label="申请理由" value={change.reason} />
      </FactGrid>
      {legacy ? <dl className="space-y-2 text-sm">{levels.map(level => <div key={level.code}><dt>{legacySource?.levelNames?.[level.code] ?? level.code}</dt><dd>购买 {level.renterPercent}% · 上架 {level.ownerPercent}%</dd></div>)}</dl> : null}
      <p className="text-xs leading-relaxed text-muted-foreground">{legacy ? "首版比例来自本次申请冻结的旧平台档位。" : initial ? "这是首版完整配置，不沿用任何旧等级或默认比例。" : "仅展示本次申请的改动项；未列项目沿用原政策。"}新开关不清除既有关系或已冻结订单，批准也不代表已执行。</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{executed ? "已读到本次执行的结果引用；当前全局政策是否仍使用该版本需另行核对。" : "尚未读到可核对的执行结果，不按已生效显示。"}</p>
    </Section>
  </div>;
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
        <Fact label="结束原因" value={text(summary, "endReason")} />
        <Fact label="是否提前结束" value={bool(summary, "early")} />
        {amounts.map(([label, key]) => <MoneyRow key={key} label={label} value={summary[key]} />)}
      </FactGrid>
    </>
  );
}

/** 系统计算值 → 拟调整值。拟调整租客应退是应退责任，不是渠道已到账。 */
function SettlementCompare({ summary }: { summary: Record<string, unknown> }) {
  const rows = [
    ["号主扣费前收入", "systemOwnerGross", "proposedOwnerGross"],
    ["全额包赔费", "systemPayoutFee", "proposedPayoutFee"],
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
        <Alert variant="warning" role="status">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>业务结果未读到</AlertTitle>
          <AlertDescription>
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
        </FactGrid>
      ) : null}

      {business.entitlement ? (() => {
        const view = entitlementStateView(business.entitlement.effectiveState || business.entitlement.status);
        return (
          <FactGrid>
            <Fact label="权益当前状态" value={view.label} />
            <Fact label="生效开始" value={formatDate(business.entitlement.startsAt)} />
            <Fact label="生效结束" value={formatDate(business.entitlement.endsAt)} />
            {business.entitlement.replacedById ? <Fact label="后续权益" value="已有新的权益接替，见「涉及对象」" /> : null}
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

function SettlementAdjustmentContent({ business, summary, onOpenPath }: { business: BusinessView; summary: Record<string, unknown>; onOpenPath?: OpenPath }) {
  const orderId = text(summary, "orderId");
  const order = orderId ? <OrderEntity orderId={orderId} displayNo={text(summary, "displayNo")} onOpenPath={onOpenPath} /> : null;
  const result = business.settlementResult;
  const outcome = result ? (result.posted ? "已过账" : "待订单确认/过账") : "结算版本未读到";
  return (
    <div className="space-y-4">
      <KeyFacts items={[
        { label: "订单", value: order },
        { label: "当前结果", value: outcome },
        { label: "号主净入账", value: `${moneyLabel(summary.systemOwnerNet) ?? "待核"} → ${moneyLabel(summary.proposedOwnerNet) ?? "待核"}` },
        { label: "租客应退", value: `${moneyLabel(summary.systemRenterRefund) ?? "待核"} → ${moneyLabel(summary.proposedRenterRefund) ?? "待核"}` },
      ]} />
      <Section title="申请时快照">
        <SettlementSummary summary={summary} />
      </Section>
      <Section title="系统计算与本次拟调整">
        <SettlementCompare summary={summary} />
      </Section>
      <ImpactNote>
        批准只形成结算依据；还需回订单完成双方确认、客服复核和过账。未过账前不算完成，租客应退也不等于渠道已到账。
      </ImpactNote>
    </div>
  );
}

const FIXED_KIND_LABELS: Record<string, string> = {
  PLATFORM_TERMS: "平台服务协议", PLATFORM_PRIVACY: "用户隐私政策", EARLY_SETTLEMENT: "提前结算告知", NOTICE: "场景说明",
};

type FixedDocumentItem = {
  kind: string; key: string; draftVersionId: string; baseVersionId: string | null; digest: string;
  readAvailable?: boolean; title?: string | null; bodyFormat?: "text" | "plate" | null; status?: string;
  digestMatches?: boolean; baseMatches?: boolean;
  preview?: { body: string; document: PlateDocumentEnvelope | null } | null;
  base?: { versionId: string; title: string; body: string; document: PlateDocumentEnvelope | null; effectiveAt: string | null } | null;
  blocks?: { status: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED"; before: string | null; after: string | null }[];
  changes?: { added: number; removed: number; changed: number; unchanged: number };
};

/** 用户端预览：plate 走白名单只读渲染，纯文本按段落显示（与订单快照一致）。 */
function FixedPreview({ item }: { item: FixedDocumentItem }) {
  const preview = item.preview;
  if (!preview) return <p className="text-xs text-muted-foreground">读不到本次草稿正文，不用当前线上版本替代。</p>;
  if (item.bodyFormat === "plate" && preview.document) return <article className="content-notion-readonly" aria-label="用户端预览"><PlateDocument document={preview.document} /></article>;
  return <div className="space-y-2 text-sm leading-relaxed" aria-label="用户端预览">{preview.body.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}

/**
 * 固定文书发布：详情最显眼处并排给出用户端预览与当前生效版本的按块差异。
 * 全部来自申请冻结载荷与服务端只读投影，不在前端重算摘要或改写任何正文。
 */
function FixedDocumentSummary({ business }: { business: BusinessView }) {
  const fixed = (business.summary?.fixedDocument ?? undefined) as { schema?: string; payloadState?: string; items?: FixedDocumentItem[] } | undefined;
  if (!fixed || !Array.isArray(fixed.items)) return <NotApplicable reason="固定文书发布快照未提供，不能用当前线上文书替代本次申请。" />;
  const result = business.result as { knowledge?: string; effectiveAt?: string | null; versionIds?: string[] } | undefined;
  const documents = fixed.items.map(item => FIXED_KIND_LABELS[item.kind] ?? item.title ?? item.kind);
  return <div className="space-y-4">
    <KeyFacts items={[
      { label: "发布文书", value: `${fixed.items.length} 份${documents.length ? ` · ${documents.join("、")}` : ""}` },
      { label: "拟定生效", value: formatDate(result?.effectiveAt ?? null) },
      { label: "生效结果", value: business.resultAvailability === "KNOWN" ? "已读到本次执行结果" : business.resultAvailability === "UNRESOLVED" ? "结果待核对，请勿重复办理" : "尚未生效" },
    ]} />
    <Section title="固定文书发布：用户端预览与线上差异" hint="批准即生效：同一批法律文书共用一个生效时间；已封存正文、摘要与接受记录不会被改写。">
    {fixed.payloadState === "INVALID" ? <Alert variant="warning" role="status"><TriangleAlert aria-hidden="true" /><AlertTitle>申请载荷不符合固定文书合同</AlertTitle><AlertDescription>无法逐项展示预览与差异，请驳回并要求重新提交。</AlertDescription></Alert> : null}
    <div className="space-y-4">
      {fixed.items.map(item => <div key={`${item.kind}:${item.key}:${item.draftVersionId}`} className="rounded-md border border-border/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{FIXED_KIND_LABELS[item.kind] ?? item.kind}</p>
          <span className="text-xs text-muted-foreground">{item.title ?? item.key}</span>
          {item.status ? <Badge variant={item.status === "SEALED" || item.status === "PUBLISHED" ? "success" : item.status === "PENDING" ? "info" : "warning"}>{item.status === "SEALED" ? "已封存" : item.status === "PENDING" ? "待审批" : item.status === "PUBLISHED" ? "已发布" : "草稿"}</Badge> : null}
          {item.readAvailable === false ? <Badge variant="destructive">草稿不可读</Badge> : null}
          {item.digestMatches === false ? <Badge variant="destructive">摘要与申请不一致</Badge> : null}
          {item.baseMatches === false ? <Badge variant="warning">线上版本已变化</Badge> : null}
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div><p className="text-xs font-medium text-muted-foreground">用户端预览（本次草稿）</p><div className="mt-2 max-h-96 overflow-auto rounded-md border border-border/40 p-2"><FixedPreview item={item} /></div></div>
          <div><p className="text-xs font-medium text-muted-foreground">与当前生效版本差异{item.base ? `（线上 ${item.base.versionId}）` : "（线上尚无生效版本）"}</p><div className="mt-2 max-h-96 overflow-auto"><DiffBlocks blocks={item.blocks ?? []} emptyText="没有可比较的正文。" /></div></div>
        </div>
        <details className="mt-3 rounded-md border border-border/40 p-2 text-xs">
          <summary className="cursor-pointer font-medium text-foreground">版本与摘要</summary>
          <div className="mt-2"><FactGrid>
            <Fact label="本次草稿版本" value={item.draftVersionId} mono />
            <Fact label="申请冻结的线上版本" value={item.baseVersionId ?? "无（首次生效）"} mono />
            <Fact label="摘要" value={item.digest} mono />
          </FactGrid></div>
        </details>
        <FactGrid>
          <Fact label="改动块数" value={item.changes ? `新增 ${item.changes.added} · 删除 ${item.changes.removed} · 修改 ${item.changes.changed}` : null} />
        </FactGrid>
      </div>)}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">平台服务协议与隐私政策首次生效必须同一事务；之后可单份更新，用户只需重新同意变更的那份。提前结算告知按订单绑定的文书版本展示，确认时记录版本与结算依据。</p>
  </Section>
  </div>;
}

export function BusinessSummary({ business, operationCode, onOpenPath }: { business: BusinessView | undefined; operationCode: string; onOpenPath?: OpenPath }) {
  if (business === undefined) {
    return (
      <Section title="申请内容">
        <Alert variant="info" role="status">
          <Info aria-hidden="true" />
          <AlertTitle>{BUSINESS_NOT_CONNECTED}</AlertTitle>
          <AlertDescription>
            暂时无法读取这笔申请的业务摘要和处理结果，请联系管理员核对。
          </AlertDescription>
        </Alert>
      </Section>
    );
  }

  const summary = business.summary ?? {};
  const restricted = business.restrictedReasonCodes ?? [];
  const changeSummary = business.changeSummary ?? text(summary, "changeSummary");
  const policyOperation = operationCode === "membership.benefit.policy.publish";
  const distributionOperation = operationCode === "distribution.policy.publish";
  const reversalOperation = operationCode === "distribution.earning.reverse";
  const entitlementOperation = ["membership.entitlement.grant", "membership.entitlement.replace", "membership.entitlement.revoke"].includes(operationCode);
  const settlementOperation = operationCode === "order.settlement.adjust";
  const compensationOperation = operationCode === "order.compensation.grant";
  const fixedOperation = operationCode === "content.fixed_document.publish";
  const pricingOperation = operationCode === "supply.rules.mode_switch";
  const testOperation = operationCode === "approval.test.execute";
  const knownOperation = policyOperation || distributionOperation || reversalOperation || entitlementOperation || settlementOperation || compensationOperation || fixedOperation || pricingOperation || testOperation;

  const restrictedNotice = business.summaryAvailable === false ? (
    <NotApplicable reason={`无权查看本次申请的业务摘要：${restricted.map(reasonLabel).join("；") || "原因未提供"}。这与「你能否审批」是两件事，动作资格以逐项 actions 为准。`} />
  ) : null;

  return (
    <>
      {testOperation ? <TestOperationSummary business={business} /> : null}

      {!testOperation && business.summaryAvailable === false ? (
        <Section title="申请内容">
          {changeSummary ? <p className="text-sm leading-relaxed text-foreground">{changeSummary}</p> : null}
          {restrictedNotice}
        </Section>
      ) : null}

      {!testOperation && business.summaryAvailable !== false && fixedOperation ? <FixedDocumentSummary business={business} /> : null}
      {pricingOperation && business.pricingChange ? <Section title="计价模式变更">
        <FactGrid>
          <Fact label="目标模式" value={business.pricingChange.pricingModel === "FIXED_FEE" ? "固定手续费" : "价差"} />
          <Fact label="生效时间" value={formatDate(business.pricingChange.effectiveAt)} />
          <Fact label="公告" value={business.pricingChange.announcementVersionId} />
          <Fact label="目标价目" value={business.pricingChange.price?.version.id} />
          {business.pricingChange.combination ? <>
            <Fact label="资金政策依据" value={business.pricingChange.combination.funding.id} />
            <Fact label="租期规则" value={business.pricingChange.combination.term.id} />
            <Fact label="出租协议" value={business.pricingChange.combination.agreement.id} />
          </> : null}
          {business.pricingChange.batchId ? <Fact label="排期回执" value={business.pricingChange.batchId} /> : null}
        </FactGrid>
      </Section> : null}
      {!testOperation && business.summaryAvailable !== false && compensationOperation ? <CompensationSummary business={business} onOpenPath={onOpenPath} /> : null}
      {!testOperation && business.summaryAvailable !== false && settlementOperation ? <SettlementAdjustmentContent business={business} summary={summary} onOpenPath={onOpenPath} /> : null}
      {!testOperation && business.summaryAvailable !== false && entitlementOperation ? <MembershipEntitlementContent business={business} summary={summary} operationCode={operationCode} onOpenPath={onOpenPath} /> : null}
      {!testOperation && business.summaryAvailable !== false && policyOperation ? <MembershipPolicyContent business={business} /> : null}
      {!testOperation && business.summaryAvailable !== false && distributionOperation ? <DistributionSummary business={business} /> : null}
      {!testOperation && business.summaryAvailable !== false && reversalOperation ? <ReversalSummary business={business} onOpenPath={onOpenPath} /> : null}

      {!testOperation && !knownOperation && business.summaryAvailable !== false ? (
        <Section title="申请内容">
          {changeSummary ? <p className="text-sm leading-relaxed text-foreground">{changeSummary}</p> : null}
          <NotApplicable reason="该审批类型尚未登记内容适配；请按申请说明、涉及对象和当前办理资格核对，不使用当前业务值替代。 " />
        </Section>
      ) : null}

      {business.pricingRestrictedReasonCode ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          定价与成本口径未显示：{reasonLabel(business.pricingRestrictedReasonCode)}。
        </p>
      ) : null}

      {business.summaryAvailable !== false && business.resultAvailability && business.resultAvailability !== "NOT_APPLICABLE" && !compensationOperation && !reversalOperation && !testOperation
        ? <DomainResult business={business} />
        : null}
    </>
  );
}
