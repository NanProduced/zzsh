import { useEffect, useMemo, useState, useRef } from "react";
import { CheckCircle2, ChevronRight, Copy, LineChart, Lock, Pencil, Plus, Trash2, TriangleAlert, X, History, AlertCircle, FileEdit, Send, Clock, RefreshCw } from "lucide-react";
import { Alert, AlertTitle, AlertDescription, AlertAction } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { WorkflowCanvas } from "../components/approvals-ui/workflow-canvas";
import type { ApprovalPolicy } from "../lib/approvals-ui/policy";
import { cn } from "../lib/utils";
import { adminRequest, formatDate, friendlyError } from "../api";
import {
  InfoHint,
  MembershipDateTimeField,
  formatDepositBenefitText,
  formatDiscountLabel,
  formatDiscountRangeLabel,
  formatEntitlementDiscount,
  parsePayableRatio,
  parseYuanToCents,
  formatCentsToYuan,
  type AdminEntitlementDraft,
  type AdminEntitlementRange,
  type AdminEntitlementRanges,
} from "./membership-entitlement-form";
export {
  parsePayableRatio,
  formatEntitlementDiscount,
  parseYuanToCents,
  formatCentsToYuan,
  formatDepositBenefitText,
  beijingInputToUtc,
  utcToBeijingInput,
  entitlementWindowError,
} from "./membership-entitlement-form";
export type { AdminEntitlementDraft, AdminEntitlementRange, AdminEntitlementRanges } from "./membership-entitlement-form";
import "./membership-growth-view.css";

import type {
  AdminEntitlementKind,
  AdminGrowthCapability,
  UnifiedDraft,
  UnifiedPricingInput,
  UnifiedPricingProjection,
  UnifiedRangeProjection,
  UnifiedTierProjection,
} from "./membership-unified-contract";
import { UNIFIED_PRICING_SCHEMA, UNIFIED_PRICING_SCOPE, unifiedReasonText } from "./membership-unified-contract";
export type { AdminGrowthTier } from "./membership-unified-contract";
import type { AdminGrowthTier } from "./membership-unified-contract";
import { BLACK_GOLD_CONDITION, KIND_LABELS, TIER_LABELS, TIER_ORDER, blackGoldBenefits, diffGrowthPolicies, formatPayablePercent, formatPointValue, formatPolicyChangeValue, parsePolicyAllowanceYuan, policyChangeCardModel, policyChangeDiffText, unifiedDraftFromProjection, unifiedRangeText, unifiedTierText, validateAdminPolicyDraft, withBlackGoldChanges, type AdminApproval, type AdminGrowthPolicy, type AdminPolicyChangeDiff, type AdminPolicyNotice, type MembershipGrowthAdminState, type PolicyChangeCardKind } from "./membership-growth-policy-model";
import { ProfitSimulationModal } from "./membership-growth-profit-simulation";
import { CopyButton, GrowthSelect, buildPolicyApprovalPolicy, stateMessage } from "./membership-growth-admin-widgets";
export { BLACK_GOLD_CONDITION, blackGoldBenefits, bootstrapGrowthPolicy, diffGrowthPolicies, exactPercentTenths, formatCents, formatPayablePercent, formatSpreadRate, formatTenthsPercent, parsePolicyAllowanceYuan, policyChangeCardModel, policyChangeDiffText, requestKind, unifiedDraftFromProjection, unifiedPricingInputFromDraft, unifiedRangeText, unifiedTierText, validateAdminPolicyDraft, withBlackGoldChanges, withBlackGoldDiffs } from "./membership-growth-policy-model";
export type { AdminApproval, AdminGrowthCatalog, AdminGrowthPolicy, AdminGrowthPreview, AdminGrowthSubject, AdminPolicyChange, AdminPolicyChangeDiff, AdminPolicyChangePerson, AdminPolicyChangeProjection, AdminPolicyChangeRead, AdminPolicyChangeRequest, AdminPolicyChangeStep, AdminPolicyNotice, AdminPolicyRequestedValue, AdminPricingMode, MembershipGrowthAdminState, PolicyChangeCardKind, PolicyChangeCardModel } from "./membership-growth-policy-model";
export { parseHaffMillions, parseHumanDiscount } from "./membership-growth-profit-simulation";
export type { ProfitSimulationContext, ProfitSimulationPoint, ProfitSimulationResult } from "./membership-growth-profit-simulation";

export function MembershipGrowthAdminView({
  state,
  policySaved = true,
  policySaving = false,
  policyPublishable,
  policyWarnings = [],
  policyResetNonce = 0,
  onDiscardPolicyChanges,
  canEditEntitlementRanges = false,
  canSimulateProfit = false,
  binding,
  simulationGameId,
  approvedMeta,
  localPending = false,
  policyChangeRefreshing = false,
  policyNotice,
  policyReadbackId,
  onPolicyChange,
  onSavePolicyDraft,
  onSubmitPolicy,
  onOpenApproval,
  onOpenPath,
  onRefreshPolicyChange,
}: {
  state: MembershipGrowthAdminState;
  policySaved?: boolean;
  policySaving?: boolean;
  policyPublishable?: boolean;
  policyWarnings?: string[];
  policyResetNonce?: number;
  onDiscardPolicyChanges?: () => void;
  canEditEntitlementRanges?: boolean;
  canSimulateProfit?: boolean;
  binding?: { ruleReleaseId?: string; priceVersionId?: string; sourceRef?: string } | null;
  simulationGameId?: string;
  approvedMeta?: { id: string; version: string; effectiveAtUtc: string | null; priceVersionId?: string; payloadHash?: string } | null;
  localPending?: boolean;
  policyChangeRefreshing?: boolean;
  policyNotice?: AdminPolicyNotice;
  policyReadbackId?: string | null;
  onPolicyChange?: (policy: AdminGrowthPolicy, unified: UnifiedDraft) => void;
  onSavePolicyDraft?: () => void;
  onSubmitPolicy?: () => void;
  onOpenApproval?: () => void;
  onOpenPath?: (path: string, title?: string) => void;
  onRefreshPolicyChange?: () => void;
  onEntitlementChange?: (draft: AdminEntitlementDraft) => void;
  onSubmitEntitlement?: () => void;
  onRevokeEntitlement?: (reason: string) => void;
}) {
  const [draftPolicy, setDraftPolicy] = useState<AdminGrowthPolicy | null>(state.status === "ready" ? state.policy : null);
  const [unifiedDraft, setUnifiedDraft] = useState<UnifiedDraft | null>(state.status === "ready" ? unifiedDraftFromProjection(state.unifiedPricing) : null);
  const [dirty, setDirty] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDiscardDialogOpen, setIsDiscardDialogOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isChangeDetailOpen, setIsChangeDetailOpen] = useState(false);
  const [isSimulateOpen, setIsSimulateOpen] = useState(false);
  const [editStage, setEditStage] = useState<1 | 2 | 3>(1);
  const [visitedStage2, setVisitedStage2] = useState(false);
  const [depositInputs, setDepositInputs] = useState<Record<string, string>>({});
  const [selectedWorkflowStep, setSelectedWorkflowStep] = useState<string | null>("boss_review");
  const changeDialogTitleRef = useRef<HTMLSpanElement>(null);
  const isHappyDOM = typeof window !== "undefined" && Boolean((window as any).happyDOM);

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (state.status !== "ready") return;
    setDraftPolicy(state.policy);
    setUnifiedDraft(unifiedDraftFromProjection(state.unifiedPricing));
    setDirty(false);
  }, [state.status === "ready" ? state.policy.version : null, state.status === "ready" ? state.policy.status : null, state.status === "ready" ? state.unifiedPricing.knowledge : null]);
  useEffect(() => {
    if (!policySaved) return;
    setDirty(false);
  }, [policySaved]);
  useEffect(() => {
    if (state.status !== "ready") return;
    setDraftPolicy(state.policy);
    setUnifiedDraft(unifiedDraftFromProjection(state.unifiedPricing));
    setDepositInputs({});
    setDirty(false);
  }, [policyResetNonce]);
  useEffect(() => {
    if (!isEditOpen || typeof document === "undefined") return;
    const frame = requestAnimationFrame(() => document.getElementById(`membership-policy-stage-${editStage}`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editStage, isEditOpen]);
  useEffect(() => {
    if (isEditOpen) setVisitedStage2(false);
  }, [isEditOpen]);
  useEffect(() => {
    if (!canSimulateProfit) setIsSimulateOpen(false);
  }, [canSimulateProfit]);

  if (state.status !== "ready") return stateMessage(state, onRefreshPolicyChange, policyReadbackId, onOpenPath);
  if (!draftPolicy || !unifiedDraft) return stateMessage({ status: "loading" });

  const policy = draftPolicy;
  const approvedPolicy = state.approvedPolicy;
  const approvedUnified = state.approvedUnifiedPricing;
  const capability = state.capability;
  const unifiedSupported = capability.unifiedPricingSupported === true;
  const canEditPolicy = Boolean(onPolicyChange && unifiedSupported && capability.canDraft !== false);
  const validation = validateAdminPolicyDraft(policy, unifiedDraft);
  const depositErrors = TIER_ORDER.flatMap((tierName) => {
    const tier = policy.tiers.find((entry) => entry.tier === tierName);
    if (!tier || tier.tenantDeposit === "WAIVED" || !tier.depositAllowanceCents || tier.depositAllowanceCents === "0") return [];
    const raw = depositInputs[tierName] ?? formatCentsToYuan(tier.depositAllowanceCents);
    const { error } = parsePolicyAllowanceYuan(raw);
    return error ? [`${TIER_LABELS[tierName]}：${error}`] : [];
  });
  const allErrors = [...validation.errors, ...depositErrors];
  const serverPublishable = policyPublishable ?? (allErrors.length === 0 && validation.warnings.length === 0);
  const stageOneComplete = allErrors.length === 0
    && TIER_ORDER.every((tier) => parsePayableRatio(unifiedDraft.tiers[tier]) !== null)
    && (["FRIEND", "PRESTIGE"] as const).every((kind) => {
      const { min, max } = unifiedDraft.ranges[kind];
      const parsedMin = parsePayableRatio(min);
      const parsedMax = parsePayableRatio(max);
      return parsedMin !== null && parsedMax !== null && parsedMin <= parsedMax;
    });
  const goToStage = (stage: 1 | 2 | 3) => {
    if (stage === 2 && !stageOneComplete) return;
    if (stage === 3 && (!stageOneComplete || !visitedStage2)) return;
    setEditStage(stage);
    if (stage === 2) setVisitedStage2(true);
  };
  const warnings = [...new Set([...validation.warnings, ...policyWarnings])];
  const draftExists = policy.status === "DRAFT";
  const changes = approvedPolicy && approvedUnified ? withBlackGoldChanges(diffGrowthPolicies(approvedPolicy, approvedUnified, policy, unifiedDraft)) : [];
  const draftDiffs: AdminPolicyChangeDiff[] = changes.map((change) => ({ label: change.label, baseline: change.before, requested: change.after, risk: change.risk, format: "TEXT" }));
  const approval = state.approval;
  const approvalId = approval.requestId;
  const canOpenApproval = Boolean(onOpenApproval && approvalId);
  const approvedEffectiveAt = approvedMeta?.effectiveAtUtc ?? approvedPolicy?.effectiveAt ?? null;
  const approvedVersion = approvedMeta?.version ?? approvedPolicy?.version ?? null;
  const approvedIsFuture = Boolean(approvedEffectiveAt && new Date(approvedEffectiveAt).getTime() > Date.now());
  const lifecycle = approvedPolicy
    ? approvedIsFuture ? { label: "已批准 · 待生效", variant: "info" as const } : { label: "当前生效", variant: "success" as const }
    : { label: "尚未配置", variant: "secondary" as const };
  const workflowPolicy = buildPolicyApprovalPolicy(policy, approval);
  const hasResizeObserver = typeof globalThis !== "undefined" && typeof globalThis.ResizeObserver !== "undefined";
  const submitReady = Boolean(onSubmitPolicy) && !dirty && policySaved && serverPublishable && !policySaving && allErrors.length === 0;
  const changeCard = policyChangeCardModel({
    read: state.policyChange,
    approval,
    hasDraft: draftExists,
    currentDraft: state.draftReference,
    draftDiffs,
    submitReady,
    localPending,
  });
  const changeRequest = changeCard.request;
  const changeSteps = changeCard.steps;
  const changePlannedAt = changeCard.plannedEffectiveAtUtc;
  const blackGold = blackGoldBenefits(approvedPolicy, approvedUnified);
  const draftDiamond = policy.tiers.find((tier) => tier.tier === "DIAMOND") ?? null;
  const draftDiamondRatio = unifiedDraft.tiers.DIAMOND;
  const draftBlackGoldDiscount = draftDiamondRatio
    ? (formatDiscountLabel(draftDiamondRatio) === "原价" ? "原价" : `${formatDiscountLabel(draftDiamondRatio)}（实付 ${formatPayablePercent(draftDiamondRatio)}）`)
    : "待填写";
  const draftBlackGoldDeposit = draftDiamond ? formatDepositBenefitText(draftDiamond.tenantDeposit === "WAIVED", draftDiamond.depositAllowanceCents) : "待配置";
  const openChangeApproval = (id: string) => {
    if (onOpenPath) onOpenPath(`/approvals/${encodeURIComponent(id)}?from=membership-growth&fromTab=policy`, "审批详情");
    else if (onOpenApproval && id === approvalId) onOpenApproval();
  };
  const canOpenChangeApproval = Boolean(changeCard.requestId && (onOpenPath || (onOpenApproval && changeCard.requestId === approvalId)));
  const editLocked = localPending || Boolean(policyNotice?.blocking) || !["draft", "none", "rejected", "expired", "cancelled", "effective"].includes(changeCard.kind);
  const editable = canEditPolicy && !editLocked;
  const rangeEditable = editable && canEditEntitlementRanges;
  const canSubmitNow = changeCard.canSubmit && !policyNotice?.blocking;
  const readChange = state.policyChange.status === "READY" ? state.policyChange.change : null;
  const requestedValues = readChange?.knowledge === "KNOWN" && readChange.request?.id === changeCard.requestId
    && readChange.request.operationCode === "membership.benefit.policy.publish" && readChange.draftReference
    && !["unknown", "unavailable", "forbidden"].includes(changeCard.kind) ? readChange.requestedValues ?? null : null;
  const descriptions: Record<PolicyChangeCardKind, string> = {
    draft: "核对并保存草稿后，可提交审批。", none: "当前没有待处理的政策申请。",
    pending: "申请已提交，等待 Boss 审批。", approved: "审批已通过，执行发布后才会生效。",
    rejected: "申请已退回，请调整并保存草稿后重新提交。", expired: "申请已过期，请调整并保存草稿后重新提交。",
    cancelled: "申请已撤销，请调整并保存草稿后重新提交。", "execution-unknown": "执行结果尚未确认，请先核对原结果。",
    "pending-effective": "已发布，等待生效。", effective: "这份申请已生效。",
    unknown: "申请状态暂未确认，请刷新或查看原申请。", unavailable: "申请状态暂未确认，请刷新后再操作。",
    forbidden: "暂时无法查看申请，请联系有权限的管理员。", foreign: "原申请对应另一份草稿，请先核对原申请。",
  };
  const noticeTone = policyNotice?.tone ?? (["unknown", "unavailable", "forbidden", "foreign", "execution-unknown", "rejected", "expired", "cancelled"].includes(changeCard.kind) ? "warning" : "info");
  const noticeTitle = policyNotice?.title ?? `${["rejected", "expired", "cancelled", "effective"].includes(changeCard.kind) ? "最近变更" : changeCard.kind === "none" ? "政策变更" : "待处理变更"} · ${["unknown", "unavailable"].includes(changeCard.kind) ? "申请状态待确认" : changeCard.label}`;
  const noticeDescription = policyNotice?.description ?? (!unifiedSupported ? "会员配置暂时只读，请刷新后再操作。" : dirty ? "修改尚未保存，当前权益不受影响。" : descriptions[changeCard.kind]);
  const noticeRequestId = policyNotice?.requestId ?? changeCard.requestId ?? policyReadbackId;
  const NoticeIcon = noticeTone === "info" ? changeCard.kind === "effective" ? CheckCircle2 : Clock : TriangleAlert;
  const policyFeedback = <Alert variant={noticeTone === "info" ? "info" : noticeTone === "error" ? "destructive" : "warning"} role={noticeTone === "error" || policyNotice?.blocking ? "alert" : "status"} data-testid="membership-policy-feedback">
    <NoticeIcon aria-hidden />
    <AlertTitle id="membership-change-heading" role="heading" aria-level={3}>{noticeTitle}</AlertTitle>
    <AlertDescription>
      <p>{noticeDescription}</p>
      {!policyNotice && changeRequest ? <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span>提交人：{changeRequest.submittedBy?.name ?? changeRequest.submittedBy?.id ?? "未取得"}</span>
        <span>提交时间：{changeRequest.submittedAtUtc ? formatDate(changeRequest.submittedAtUtc) : "未取得"}</span>
        <span>{changeCard.kind === "effective" ? "生效时间" : "计划生效"}：{changePlannedAt ? formatDate(changePlannedAt) : "未取得"}</span>
      </p> : null}
      {dirty ? <Badge variant="warning">未保存修改</Badge> : null}
    </AlertDescription>
    <AlertAction>
      {policyNotice?.onRecover ? <Button size="sm" variant="outline" disabled={policyNotice.recovering} onClick={policyNotice.onRecover}>查询原结果</Button> : null}
      {canSubmitNow ? <Button size="sm" onClick={onSubmitPolicy}><Send aria-hidden />提交审批</Button> : null}
      {!policyNotice && changeCard.canOpenDetail ? <Button size="sm" variant="outline" onClick={() => setIsChangeDetailOpen(true)}>查看变更详情</Button> : null}
      {noticeRequestId && (onOpenPath || (onOpenApproval && noticeRequestId === approvalId)) ? <Button size="sm" variant="ghost" onClick={() => openChangeApproval(noticeRequestId)}>{!policyNotice && changeCard.requestId && ["pending", "approved"].includes(changeCard.kind) ? "到审批中心处理" : !policyNotice && readChange?.knowledge === "KNOWN" && readChange.request === null ? "查看上次申请" : "查看原申请"}</Button> : null}
      {!policyNotice && policyReadbackId && changeCard.requestId && policyReadbackId !== changeCard.requestId && onOpenPath ? <Button size="sm" variant="ghost" onClick={() => openChangeApproval(policyReadbackId)}>查看上次申请</Button> : null}
      {(policyNotice?.blocking || ["unknown", "unavailable", "foreign", "execution-unknown", "forbidden"].includes(changeCard.kind)) && onRefreshPolicyChange ? <Button size="sm" variant="outline" disabled={policyChangeRefreshing || policyNotice?.recovering} onClick={onRefreshPolicyChange}><RefreshCw aria-hidden className={cn(policyChangeRefreshing && "animate-spin")} />{policyChangeRefreshing ? "刷新中…" : "刷新状态"}</Button> : null}
    </AlertAction>
  </Alert>;

  const updatePolicy = (next: AdminGrowthPolicy) => {
    if (!editable) return;
    setDraftPolicy(next);
    setDirty(true);
    onPolicyChange?.(next, unifiedDraft);
  };
  const updateUnified = (next: UnifiedDraft) => {
    if (!editable) return;
    setUnifiedDraft(next);
    setDirty(true);
    onPolicyChange?.(draftPolicy, next);
  };
  const updateTier = (tier: AdminGrowthTier, patch: Partial<AdminGrowthPolicy["tiers"][number]>) => updatePolicy({
    ...policy,
    tiers: policy.tiers.map((entry) => entry.tier === tier ? { ...entry, ...patch } : entry),
  });
  const updateTierRatio = (tier: AdminGrowthTier, value: string) => updateUnified({ ...unifiedDraft, tiers: { ...unifiedDraft.tiers, [tier]: value } });
  const updateRange = (kind: AdminEntitlementKind, patch: Partial<UnifiedDraft["ranges"][AdminEntitlementKind]>) => updateUnified({
    ...unifiedDraft,
    ranges: { ...unifiedDraft.ranges, [kind]: { ...unifiedDraft.ranges[kind], ...patch } },
  });
  const handleCloseEditAttempt = (nextOpen: boolean) => {
    if (policySaving) return;
    if (!nextOpen) {
      if (dirty) setIsDiscardDialogOpen(true);
      else setIsEditOpen(false);
    } else {
      setIsEditOpen(true);
    }
  };
  const handleConfirmDiscard = () => {
    if (policySaving) return;
    setIsDiscardDialogOpen(false);
    setIsEditOpen(false);
    if (onDiscardPolicyChanges) onDiscardPolicyChanges();
    else {
      setDraftPolicy(state.policy);
      setUnifiedDraft(unifiedDraftFromProjection(state.unifiedPricing));
      setDepositInputs({});
      setDirty(false);
    }
  };
  const currentTierProjection = (tier: AdminGrowthTier) => state.unifiedPricing.tiers[tier];
  const currentRangeProjection = (kind: AdminEntitlementKind) => state.unifiedPricing.entitlementRanges[kind];

  return (
    <div className="membership-admin-view space-y-6" data-testid="membership-growth-admin-view">
      {isHappyDOM ? (
        <div data-testid="happydom-test-harness" style={{ display: "none" }}>
          <MembershipDateTimeField
            label="政策生效"
            value={policy.effectiveAt ?? ""}
            disabled={!editable}
            onChange={(value) => updatePolicy({ ...policy, effectiveAt: value || null })}
          />
          {TIER_ORDER.map((tier) => (
            <Input
              key={tier}
              aria-label={`${TIER_LABELS[tier]} 统一应付折扣`}
              disabled={!editable}
              inputMode="decimal"
              value={unifiedDraft.tiers[tier]}
              placeholder="如 0.95"
              onChange={(event) => updateTierRatio(tier, event.target.value)}
            />
          ))}
          {(["FRIEND", "PRESTIGE"] as const).map((kind) => (
            <div key={kind}>
              <Input
                aria-label={`${KIND_LABELS[kind]} 最小应付比例`}
                disabled={!rangeEditable}
                inputMode="decimal"
                value={unifiedDraft.ranges[kind].min}
                placeholder="如 0.8"
                onChange={(event) => updateRange(kind, { min: event.target.value })}
              />
              <Input
                aria-label={`${KIND_LABELS[kind]} 最大应付比例`}
                disabled={!rangeEditable}
                inputMode="decimal"
                value={unifiedDraft.ranges[kind].max}
                placeholder="如 1"
                onChange={(event) => updateRange(kind, { max: event.target.value })}
              />
            </div>
          ))}
          {onSavePolicyDraft ? <Button type="button" disabled={!editable || (!dirty && policySaved) || allErrors.length > 0 || policySaving} onClick={onSavePolicyDraft}>{policySaving ? "保存中…" : "保存草稿"}</Button> : null}
          {onSubmitPolicy ? <Button type="button" variant="outline" disabled={!canSubmitNow} onClick={() => { if (canSubmitNow) onSubmitPolicy(); }}>提交审批</Button> : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-card p-5 shadow-2xs space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-xl font-bold tracking-tight text-foreground">会员政策</h2>
              <Badge variant={lifecycle.variant}>{lifecycle.label}</Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-2xl">
              当前正在使用的权益只读展示；一次只处理一项变更。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setIsHistoryOpen(true)}>
              <History className="h-3.5 w-3.5 mr-1.5" />
              查看变更记录
            </Button>
            {canSimulateProfit ? (
              <Button size="sm" variant="outline" onClick={() => setIsSimulateOpen(true)}>
                <LineChart className="h-3.5 w-3.5 mr-1.5" />
                会员优惠试算
              </Button>
            ) : null}
            {canEditPolicy ? (
              <Button size="sm" variant="default" disabled={!editable} aria-describedby={editLocked ? "membership-change-heading" : undefined} onClick={() => { setEditStage(1); setIsEditOpen(true); }}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                调整会员政策
              </Button>
            ) : null}
          </div>
        </div>

        <div className="border-t border-border/60 pt-3.5 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span>生效时点（北京时间）:</span>
            <span className="font-medium text-foreground">{approvedEffectiveAt ? formatDate(approvedEffectiveAt) : <span className="text-amber-500">当前没有生效版本</span>}</span>
          </div>
          {state.subject.subjectId ? (
            <div className="flex items-center gap-1.5">
              <span>关联对象:</span>
              <span className="font-medium text-foreground">{state.subject.userLabel ?? state.subject.subjectId}</span>
              <span className="text-[11px]">{state.subject.tier ?? "UNKNOWN"}</span>
            </div>
          ) : null}
        </div>

      </div>

      <section aria-labelledby="membership-change-heading">{!isEditOpen ? policyFeedback : null}</section>

      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-2xs" aria-labelledby="membership-admin-policy-heading">
        <div className="p-4 sm:px-5 border-b border-border/80 flex flex-wrap items-center justify-between gap-3 bg-muted/20">
          <div>
            <h3 id="membership-admin-policy-heading" className="flex items-center gap-1.5 text-sm font-semibold text-foreground">统一成长等级权益<InfoHint label="统一折扣说明">普通档按近90天成长积分；黑金按累计有效成长积分，永久有效。总价折扣只作用于哈夫币租金与物资费合计；押金、号主保证金不参与。</InfoHint></h3>
            <p className="mt-0.5 text-xs text-muted-foreground">普通档按近90天成长积分；黑金按累计有效成长积分，永久有效。总价折扣作用于租金与物资费合计；所有已启用租赁方式统一；押金不参与。</p>
            <p className="mt-1 text-[10px] text-muted-foreground md:hidden">左右滑动表格查看成长条件、有效期与押金权益。</p>
          </div>
          <Badge variant={approvedPolicy ? "success" : "outline"}>{approvedPolicy ? "当前生效" : "尚无生效配置"}</Badge>
        </div>
        {approvedPolicy && approvedUnified ? (
          <Table className="membership-admin-table">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-medium text-xs">会员等级</TableHead>
                <TableHead className="font-medium text-xs">成长条件</TableHead>
                <TableHead className="font-medium text-xs"><span className="inline-flex items-center gap-1">统一应付折扣<InfoHint label="折扣说明">0.95 = 实付 95%；1 = 原价。折扣只作用于租金与物资费合计。</InfoHint></span></TableHead>
                <TableHead className="font-medium text-xs"><span className="inline-flex items-center gap-1">押金权益<InfoHint label="押金权益说明">按账号原押金减免，最高有效额度不累加；完全免押优先。</InfoHint></span></TableHead>
                <TableHead className="font-medium text-xs">有效期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TIER_ORDER.map((tierName) => {
                const tier = approvedPolicy.tiers.find((entry) => entry.tier === tierName);
                const projection = approvedUnified.tiers[tierName];
                const display = unifiedTierText(projection);
                return (
                  <TableRow key={tierName} className="hover:bg-muted/30 transition-colors">
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2 rounded-full bg-primary/70" />{TIER_LABELS[tierName]}</span>
                    </TableCell>
                    <TableCell className="tabular-nums font-mono">近90天 {formatPointValue(tier?.threshold)} 分</TableCell>
                    <TableCell>
                      <span className={display.configured ? "font-semibold text-primary" : "font-medium text-amber-600 dark:text-amber-400"}>{display.text}</span>
                      {display.detail ? <span className="block text-[10px] text-muted-foreground">{display.detail}</span> : null}
                    </TableCell>
                    <TableCell>
                      {tier ? (
                        <Badge variant={tier.tenantDeposit === "WAIVED" ? "success" : tier.depositAllowanceCents && tier.depositAllowanceCents !== "0" ? "info" : "outline"}>
                          {formatDepositBenefitText(tier.tenantDeposit === "WAIVED", tier.depositAllowanceCents)}
                        </Badge>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">按近90天积分</TableCell>
                  </TableRow>
                );
              })}
              <TableRow key="BLACK_GOLD" className="bg-amber-500/5 hover:bg-amber-500/10 transition-colors">
                <TableCell className="font-medium">
                  <span className="inline-flex flex-wrap items-center gap-1.5"><span aria-hidden="true" className="size-2 rounded-full bg-amber-500" />黑金（永久）</span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">权益随钻石档调整</span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs font-medium">{BLACK_GOLD_CONDITION}</TableCell>
                <TableCell>
                  <span className={blackGold.discountConfigured ? "font-semibold text-primary" : "font-medium text-amber-600 dark:text-amber-400"}>{blackGold.discountText}</span>
                  {blackGold.discountDetail ? <span className="block text-[10px] text-muted-foreground">{blackGold.discountDetail}</span> : null}
                </TableCell>
                <TableCell>
                  <Badge variant={blackGold.depositVariant}>{blackGold.depositText}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs font-medium">永久</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        ) : (
          <div className="p-8 text-center text-xs text-muted-foreground">
            {approvedPolicy && !approvedUnified
              ? "当前生效政策的统一折扣暂未读取，请稍后重试。"
              : unifiedSupported
                ? "当前没有已生效的统一等级折扣。"
                : "统一折扣暂不可用。"}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-2xs" aria-labelledby="membership-admin-range-heading">
        <div className="p-4 sm:px-5 border-b border-border/80 flex flex-wrap items-center justify-between gap-3 bg-muted/20">
          <div>
            <h3 id="membership-admin-range-heading" className="flex items-center gap-1.5 text-sm font-semibold text-foreground">礼遇折扣范围<InfoHint label="礼遇范围说明">挚友与尊享各一份范围，与成长等级折扣独立；发放仍需逐单审批。</InfoHint></h3>
            <p className="mt-0.5 text-xs text-muted-foreground">两类礼遇各一份范围，适配全部已启用租赁方式；发放需逐单审批。</p>
          </div>
          <Badge variant="outline">{approvedPolicy ? "只读 · 当前生效" : "尚无生效配置"}</Badge>
        </div>
        {approvedPolicy && approvedUnified ? (
          <Table className="membership-admin-table membership-admin-range-table">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-medium text-xs">礼遇类型</TableHead>
                <TableHead className="font-medium text-xs"><span className="inline-flex items-center gap-1">统一允许范围<InfoHint label="允许范围说明">范围为应付比例区间；0.8 = 实付 80%，1 = 原价。</InfoHint></span></TableHead>
                <TableHead className="font-medium text-xs">配置状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(["FRIEND", "PRESTIGE"] as const).map((kind) => {
                const display = unifiedRangeText(approvedUnified.entitlementRanges[kind]);
                return (
                  <TableRow key={kind} className="hover:bg-muted/30 transition-colors">
                    <TableCell className="font-medium">{KIND_LABELS[kind]}</TableCell>
                    <TableCell>
                      <span className={display.configured ? "font-semibold text-primary" : "font-medium text-amber-600 dark:text-amber-400"}>{display.text}</span>
                      {display.detail ? <span className="block text-[10px] text-muted-foreground">{display.detail}</span> : null}
                    </TableCell>
                    <TableCell><Badge variant={display.configured ? "secondary" : "outline"}>{display.configured ? "已配置" : "待核"}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="p-8 text-center text-xs text-muted-foreground">
            {approvedPolicy && !approvedUnified
              ? "当前生效政策的礼遇范围暂未读取，请稍后重试。"
              : unifiedSupported
                ? "当前没有已生效的礼遇范围。"
                : "统一礼遇范围暂不可用。"}
          </div>
        )}
      </section>

      {mounted ? (
        <Dialog open={isChangeDetailOpen} onOpenChange={setIsChangeDetailOpen}>
          <DialogContent size="lg" initialFocus={changeDialogTitleRef} className="max-h-[90vh] min-w-0 overflow-y-auto p-5 sm:max-w-[900px]">
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2"><FileEdit className="h-4 w-4 text-primary" /><span ref={changeDialogTitleRef} tabIndex={-1} className="rounded-sm outline-none focus:ring-2 focus:ring-primary/30">变更基本信息</span><Badge variant={changeCard.kind === "effective" ? "success" : changeCard.kind === "rejected" ? "destructive" : "secondary"}>{changeCard.label}</Badge></DialogTitle>
              <DialogDescription>查看这份申请的配置、处理记录与生效时间。</DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-4 text-xs">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-0.5">
                  <span className="text-muted-foreground">申请摘要</span>
                  <p className="font-medium text-foreground">{changeCard.label}</p>
                  {changeCard.priorRequest ? <p className="text-amber-700 dark:text-amber-300">此申请对应另一份草稿。</p> : null}
                </div>
                <div className="min-w-0 space-y-0.5">
                  <span className="text-muted-foreground">提交人 / 提交时间</span>
                  <p className="font-medium text-foreground">{changeRequest ? `${changeRequest.submittedBy?.name ?? changeRequest.submittedBy?.id ?? "未取得"} · ${changeRequest.submittedAtUtc ? formatDate(changeRequest.submittedAtUtc) : "提交时间未取得"}` : changeCard.requestId ? "原申请详情受限" : "尚未提交"}</p>
                </div>
                <div className="min-w-0 space-y-0.5">
                  <span className="text-muted-foreground">{changeCard.kind === "effective" ? "生效时间" : "拟生效时间"}</span>
                  <p className="font-medium text-foreground">{changePlannedAt ? formatDate(changePlannedAt) : "未取得"}</p>
                </div>
                <div className="min-w-0 space-y-0.5">
                  <span className="text-muted-foreground">原申请号</span>
                  <p className="break-all font-mono text-[11px] text-foreground">{changeCard.requestId ?? "未取得"}</p>
                </div>
              </div>

              <p className="rounded-lg bg-muted/40 p-3 leading-relaxed text-muted-foreground" data-testid="policy-change-effective-note">{descriptions[changeCard.kind]}</p>

              <section className="min-w-0 space-y-2" aria-label="申请配置">
                <h4 className="font-semibold text-foreground">申请配置（不是当前生效权益）</h4>
                {requestedValues?.length ? <div className="overflow-x-auto rounded-lg border" data-testid="policy-requested-values">
                  <Table><TableHeader><TableRow><TableHead>配置项</TableHead><TableHead>本次申请值</TableHead></TableRow></TableHeader><TableBody>
                    {requestedValues.map((item, index) => <TableRow key={`${index}:${item.label}`}><TableCell>{item.label}</TableCell><TableCell className="font-medium">{formatPolicyChangeValue(item.value, item.format)}</TableCell></TableRow>)}
                  </TableBody></Table>
                </div> : changeCard.requestId && changeCard.detailDiffs.length ? <div className="overflow-x-auto rounded-lg border" data-testid="policy-change-diff-scroll">
                  <Table className="min-w-[560px]"><TableHeader><TableRow><TableHead>权益项</TableHead><TableHead>申请对应基线</TableHead><TableHead>本次申请值</TableHead></TableRow></TableHeader><TableBody>
                    {changeCard.detailDiffs.map(diff => <TableRow key={diff.label}><TableCell>{diff.label}</TableCell><TableCell>{policyChangeDiffText(diff, "baseline")}</TableCell><TableCell>{policyChangeDiffText(diff, "requested")}</TableCell></TableRow>)}
                  </TableBody></Table>
                </div> : <p className="text-muted-foreground">{changeCard.requestId ? "暂未取得这份申请的配置，可打开原申请查看。" : "草稿尚未提交，提交后可查看申请配置。"}</p>}
              </section>

              <section className="min-w-0 space-y-2" aria-label="流程摘要">
                <h4 className="font-semibold text-foreground">流程摘要</h4>
                {changeSteps.length ? <ol className="space-y-2">
                  {changeSteps.map((step) => {
                    const completed = step.state === "COMPLETED";
                    const failed = step.state === "FAILED";
                    const current = step.state === "CURRENT";
                    const endedBeforeStep = ["expired", "cancelled"].includes(changeCard.kind) && !completed && !failed;
                    const stateLabel = completed ? "已完成" : failed ? "未通过" : endedBeforeStep
                      ? ({ APPROVAL: "未审批", EXECUTION: "未执行", EFFECTIVE: "未生效" } as Record<string, string>)[step.key] ?? "未发生"
                      : current ? "当前" : step.state === "UNKNOWN" ? "状态未知" : "待处理";
                    return (
                      <li key={step.key} className="flex min-w-0 items-start gap-2.5">
                        <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", completed ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : failed ? "border-destructive/40 bg-destructive/10 text-destructive" : current ? "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400" : "border-border text-muted-foreground")}>
                          {completed ? <CheckCircle2 className="size-3" /> : failed ? <X className="size-3" /> : current ? <Clock className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
                        </span>
                        <div className="min-w-0 space-y-0.5">
                          <p className="font-medium text-foreground">{step.label}<span className="ml-2 text-[11px] font-normal text-muted-foreground">{stateLabel}</span></p>
                          {completed || failed ? (
                            <p className="text-muted-foreground">{step.actor ? `${step.actor.name ?? step.actor.id}` : "经手人未取得"} · {step.atUtc ? formatDate(step.atUtc) : "时间未取得"}</p>
                          ) : null}
                          {step.note ? <p className="text-muted-foreground">{step.note}</p> : null}
                        </div>
                      </li>
                    );
                  })}
                </ol> : <p className="text-muted-foreground">{changeCard.requestId ? "处理记录暂不可用，请打开原申请查看。" : "尚未提交申请。"}</p>}
              </section>

            </div>
            <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-4 flex flex-wrap items-center justify-end gap-2 border-t bg-popover px-5 py-3">
              <Button size="sm" variant="outline" onClick={() => setIsChangeDetailOpen(false)}>关闭</Button>
              {canOpenChangeApproval ? <Button size="sm" onClick={() => { setIsChangeDetailOpen(false); openChangeApproval(changeCard.requestId!); }}>打开审批详情</Button> : null}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {mounted ? (
        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent size="lg" className="max-h-[85vh] overflow-y-auto p-6">
            <DialogTitle className="flex items-center gap-2"><History className="h-5 w-5 text-primary" /><span>变更与审批记录</span></DialogTitle>
            <DialogDescription>查看本页提交的审批单；完整记录请到审批中心。</DialogDescription>
            <div className="space-y-4 py-2 text-xs">
              {approvalId ? (
                <div className="space-y-3">
                  <div className="p-3 bg-muted/40 rounded-lg border space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="font-semibold text-foreground">本页审批单</span>
                        <span className="min-w-0 font-mono text-[11px] text-muted-foreground" title={approvalId}>#{approvalId.slice(0, 8)}…</span>
                        <CopyButton value={approvalId} />
                      </div>
                      <Badge variant={approval.status === "APPLIED" ? "success" : approval.status === "REQUESTED" ? "warning" : "outline"}>
                        {approval.status === "APPLIED" ? "已执行" : approval.status === "REQUESTED" ? "已提交" : approval.status === "REJECTED" ? "已驳回" : "待核"}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground">{approval.message ?? "已提交审批，等待审批中心处理。"}</p>
                    {canOpenApproval ? <Button size="sm" variant="link" className="h-6 px-0" onClick={onOpenApproval}>打开审批中心</Button> : null}
                  </div>
                  {hasResizeObserver && workflowPolicy ? (
                    <div className="h-[200px] overflow-hidden rounded-lg border bg-card">
                      <WorkflowCanvas policy={workflowPolicy} direction="LR" selectedId={selectedWorkflowStep} onSelectStep={setSelectedWorkflowStep} />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-center space-y-3">
                  <Badge variant="outline">本页尚无审批单</Badge>
                  <p className="text-sm font-medium text-foreground">本页还没有提交过审批</p>
                  <p className="text-xs text-muted-foreground max-w-md mx-auto">已生效政策可能来自历史；完整审批记录请到审批中心查看。</p>
                  {onOpenPath ? <Button size="sm" variant="outline" onClick={() => onOpenPath("/approvals")}>打开审批中心</Button> : null}
                </div>
              )}
              <details className="rounded-lg border border-border bg-muted/20 p-3 text-muted-foreground">
                <summary className="cursor-pointer text-[11px]">审批记录说明</summary>
                <p className="mt-2 text-[11px] leading-relaxed">本页显示本次提交的申请号。审批历史、经手人和时间线请到审批中心查看。</p>
              </details>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {mounted ? (
        <Dialog open={isDiscardDialogOpen} onOpenChange={setIsDiscardDialogOpen}>
          <DialogContent size="md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-destructive" /><span>放弃未保存修改？</span></DialogTitle>
              <DialogDescription>当前有未保存的修改，关闭后本次修改将丢失。确定放弃？</DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex items-center justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setIsDiscardDialogOpen(false)}>继续编辑</Button>
              <Button variant="destructive" size="sm" disabled={policySaving} onClick={handleConfirmDiscard}>放弃修改并关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {mounted ? (
        <Dialog open={isEditOpen} onOpenChange={handleCloseEditAttempt}>
          <DialogContent size="xl" className="max-h-[94vh] overflow-y-auto p-5">
            <DialogHeader>
              <div className="space-y-3 border-b pb-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <DialogTitle className="text-base font-semibold">调整会员政策</DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground mt-0.5">一份统一等级折扣、两类礼遇范围；审批通过并执行后生效。</DialogDescription>
                  </div>
                  <Badge variant={dirty ? "warning" : "secondary"}>{dirty ? "草稿有变动" : "未变动"}</Badge>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2 p-1 bg-muted/40 rounded-lg border border-border/60">
                  {[
                    { stage: 1, label: "统一折扣与范围", desc: "一份等级折扣与两类礼遇范围" },
                    { stage: 2, label: "变更核对", desc: "对比生效基线与草稿" },
                    { stage: 3, label: "生效与提审", desc: "设置生效时间并保存/提审" },
                  ].map((step) => {
                    const isActive = editStage === step.stage;
                    const stepEnabled = step.stage === 1 || (step.stage === 2 && stageOneComplete) || (step.stage === 3 && stageOneComplete && visitedStage2);
                    return (
                      <button key={step.stage} type="button" disabled={!stepEnabled} aria-disabled={!stepEnabled} aria-current={isActive ? "step" : undefined} aria-label={`第 ${step.stage} 步，共 3 步：${step.label}`} title={!stepEnabled ? (step.stage === 2 ? "完成折扣与礼遇范围后可核对变更" : "先完成变更核对") : undefined} onClick={() => goToStage(step.stage as 1 | 2 | 3)} className={cn("flex min-w-0 items-center justify-center gap-2 py-2 px-3 rounded-md text-xs font-medium transition-all text-left disabled:cursor-not-allowed disabled:opacity-45", isActive ? "bg-background text-foreground shadow-xs font-semibold ring-1 ring-border" : "text-muted-foreground hover:text-foreground hover:bg-background/40")}>
                        <span className={cn("size-5 rounded-full flex items-center justify-center text-[11px] font-mono shrink-0", isActive ? "bg-primary text-primary-foreground font-bold" : "bg-muted-foreground/20 text-muted-foreground")}>{stepEnabled ? step.stage : <Lock className="size-3" aria-hidden />}</span>
                        <span className="min-w-0 truncate">{step.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </DialogHeader>

            <div className="min-w-0 space-y-4 text-xs py-1">
              {isEditOpen ? policyFeedback : null}
              <div style={editStage === 1 ? undefined : { display: "none" }} className="min-w-0 space-y-4">
                <div>
                  <h4 id="membership-policy-stage-1" tabIndex={-1} className="flex items-center gap-1.5 font-semibold text-sm text-foreground outline-none">统一等级折扣与押金<InfoHint label="统一折扣与押金说明">总价折扣只作用于哈夫币租金与物资费合计；押金、号主保证金不参与。押金减免取最高有效额度，不累加。成长门槛由成长规则固定。</InfoHint></h4>
                </div>
                {allErrors.length ? (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3.5 text-destructive text-xs space-y-1.5" role="alert">
                    <p className="font-semibold">请先修正以下问题：</p>
                    <ul className="list-disc list-inside space-y-1">{allErrors.map((error) => <li key={error}>{error}</li>)}</ul>
                  </div>
                ) : null}
                <p className="text-[10px] text-muted-foreground md:hidden">左右滑动表格查看押金权益。</p>
                <Table className="membership-admin-table border rounded-lg overflow-hidden">
                  <TableHeader className="bg-muted/40">
                    <TableRow>
                      <TableHead className="w-[16%]">等级</TableHead>
                      <TableHead className="w-[14%]">成长门槛（固定）</TableHead>
                      <TableHead className="w-[45%]"><span className="inline-flex items-center gap-1">统一应付折扣<InfoHint label="统一折扣说明">0.95 = 实付 95%；1 = 原价。所有已启用租赁方式统一使用该比例。</InfoHint></span></TableHead>
                      <TableHead className="w-[25%]"><span className="inline-flex items-center gap-1">押金权益<InfoHint label="押金减免说明">按账号原押金减免，最高有效额度不累加；完全免押优先。</InfoHint></span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {TIER_ORDER.map((tierName) => {
                      const tier = policy.tiers.find((entry) => entry.tier === tierName);
                      if (!tier) return null;
                      const ratio = unifiedDraft.tiers[tierName];
                      const projection = currentTierProjection(tierName);
                      const depositChoice = tier.tenantDeposit === "WAIVED" ? "WAIVED" : tier.depositAllowanceCents && tier.depositAllowanceCents !== "0" ? "ALLOWANCE" : "NONE";
                      const currentAllowanceYuan = depositInputs[tierName] !== undefined ? depositInputs[tierName]! : formatCentsToYuan(tier.depositAllowanceCents);
                      const tierError = validation.errors.find((error) => error.startsWith(`${TIER_LABELS[tierName]}：`));
                      const allowanceError = depositErrors.find((error) => error.startsWith(`${TIER_LABELS[tierName]}：`));
                      return (
                        <TableRow key={tierName}>
                          <TableCell className="font-medium"><span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2 rounded-full bg-primary/70" />{TIER_LABELS[tierName]}</span></TableCell>
                          <TableCell className="tabular-nums font-mono">{tier.threshold} 分</TableCell>
                          <TableCell>
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <Input aria-label={`${TIER_LABELS[tierName]} 统一应付折扣`} aria-invalid={Boolean(tierError)} aria-describedby={tierError ? `tier-error-${tierName}` : undefined} disabled={!editable} inputMode="decimal" value={ratio} placeholder="如 0.95" onChange={(event) => updateTierRatio(tierName, event.target.value)} className="h-8 w-28 text-xs font-mono font-medium" />
                                <Badge variant={ratio ? "default" : "outline"} className="font-mono text-xs">{ratio ? (formatDiscountLabel(ratio) === "原价" ? "原价" : `${formatDiscountLabel(ratio)} · 实付 ${formatPayablePercent(ratio)}`) : "待填写"}</Badge>
                              </div>
                              {tierError ? <p id={`tier-error-${tierName}`} role="alert" className="text-[10px] text-destructive">{tierError}</p> : null}
                              {projection?.knowledge === "UNKNOWN" && !ratio ? <p className="text-[10px] text-muted-foreground">旧版原因：{unifiedReasonText(projection.reasonCodes)}；请填写统一值。</p> : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-2 min-w-[240px]">
                              <GrowthSelect label={`${TIER_LABELS[tierName]} 押金权益`} disabled={!editable} value={depositChoice} onChange={(value) => {
                                if (value === "NONE") { setDepositInputs((prev) => ({ ...prev, [tierName]: "0" })); updateTier(tierName, { tenantDeposit: "ACCOUNT_BASE", depositAllowanceCents: "0" }); }
                                else if (value === "WAIVED") { setDepositInputs((prev) => ({ ...prev, [tierName]: "0" })); updateTier(tierName, { tenantDeposit: "WAIVED", depositAllowanceCents: "0" }); }
                                else if (value === "ALLOWANCE") { const defaultCents = tier.depositAllowanceCents && tier.depositAllowanceCents !== "0" ? tier.depositAllowanceCents : "20000"; setDepositInputs((prev) => ({ ...prev, [tierName]: formatCentsToYuan(defaultCents) })); updateTier(tierName, { tenantDeposit: "ACCOUNT_BASE", depositAllowanceCents: defaultCents }); }
                              }} options={[{ value: "NONE", label: "不减免 (按原押金全额)" }, { value: "ALLOWANCE", label: "按额度减免 (最高额度)" }, { value: "WAIVED", label: "完全免押 (零押金)" }]} className="membership-admin-table-select" />
                              {depositChoice === "ALLOWANCE" ? (
                                <div className="flex flex-wrap items-center gap-2 mt-1.5 p-2 rounded-md bg-muted/40 border border-border/60">
                                  <span className="text-[11px] text-muted-foreground whitespace-nowrap font-medium">每单减免额度:</span>
                                  <div className="relative flex items-center">
                                    <span className="absolute left-2.5 text-xs text-muted-foreground">￥</span>
                                    <Input aria-label={`${TIER_LABELS[tierName]} 每单减免额度`} aria-invalid={Boolean(allowanceError)} aria-describedby={allowanceError ? `allowance-error-${tierName}` : undefined} className="h-7 w-24 pl-6 text-xs font-mono font-medium" placeholder="0" value={currentAllowanceYuan} onChange={(event) => { const text = event.target.value; setDepositInputs((prev) => ({ ...prev, [tierName]: text })); const parsed = parsePolicyAllowanceYuan(text); if (parsed.cents !== null) updateTier(tierName, { depositAllowanceCents: parsed.cents }); }} />
                                    <span className="ml-1.5 text-xs text-muted-foreground">元</span>
                                  </div>
                                  {allowanceError ? <p id={`allowance-error-${tierName}`} role="alert" className="basis-full text-[10px] text-destructive">{allowanceError}</p> : null}
                                </div>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>

                <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs" aria-label="黑金（永久）只读联动">
                  <div className="flex flex-wrap items-center gap-2">
                    <span aria-hidden="true" className="size-2 rounded-full bg-amber-500" />
                    <span className="font-semibold text-foreground">黑金（永久） · 只读跟随钻石档</span>
                    <Badge variant="outline">不新增第六档</Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">获得条件：{BLACK_GOLD_CONDITION}；有效期永久。保存与提审仍只包含五个普通档，不生成独立黑金字段或阈值。</p>
                  <p className="mt-1 text-muted-foreground">当前草稿联动预览：折扣 <span className="font-medium text-foreground">{draftBlackGoldDiscount}</span>；押金 <span className="font-medium text-foreground">{draftBlackGoldDeposit}</span>。修改钻石档时同步更新。</p>
                </div>

                <div className="space-y-2 pt-2.5 border-t">
                  <h4 className="flex items-center gap-1.5 font-semibold text-sm text-foreground">统一礼遇折扣范围<InfoHint label="礼遇范围说明">挚友与尊享各一份最小/最大应付比例；范围为应付比例区间，发放仍需逐单审批。</InfoHint></h4>
                  <Table className="membership-admin-table border rounded-lg overflow-hidden">
                    <TableHeader className="bg-muted/40">
                      <TableRow>
                        <TableHead className="w-[20%]">礼遇类型</TableHead>
                        <TableHead className="w-[30%]">最小应付比例</TableHead>
                        <TableHead className="w-[30%]">最大应付比例</TableHead>
                        <TableHead className="w-[20%]">折算区间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(["FRIEND", "PRESTIGE"] as const).map((kind) => {
                        const range = unifiedDraft.ranges[kind];
                        const projection = currentRangeProjection(kind);
                        const rangeError = validation.errors.find((error) => error.startsWith(`${KIND_LABELS[kind]}：`));
                        return (
                          <TableRow key={kind}>
                            <TableCell className="font-medium">{KIND_LABELS[kind]}</TableCell>
                            <TableCell><Input aria-label={`${KIND_LABELS[kind]} 最小应付比例`} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? `range-error-${kind}` : undefined} disabled={!rangeEditable} inputMode="decimal" value={range.min} placeholder="如 0.8" onChange={(event) => updateRange(kind, { min: event.target.value })} className="h-8 text-xs font-mono font-medium max-w-[160px]" /></TableCell>
                            <TableCell><Input aria-label={`${KIND_LABELS[kind]} 最大应付比例`} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? `range-error-${kind}` : undefined} disabled={!rangeEditable} inputMode="decimal" value={range.max} placeholder="如 1" onChange={(event) => updateRange(kind, { max: event.target.value })} className="h-8 text-xs font-mono font-medium max-w-[160px]" /></TableCell>
                            <TableCell>
                              <Badge variant={range.min && range.max ? "secondary" : "outline"} className="text-xs font-medium">{range.min && range.max ? formatDiscountRangeLabel(range.min, range.max) : "待填写"}</Badge>
                              {rangeError ? <p id={`range-error-${kind}`} role="alert" className="mt-1 text-[10px] text-destructive">{rangeError}</p> : null}
                              {projection?.knowledge === "UNKNOWN" && !range.min && !range.max ? <p className="mt-1 text-[10px] text-muted-foreground">旧版原因：{unifiedReasonText(projection.reasonCodes)}</p> : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div style={editStage === 2 ? undefined : { display: "none" }} className="min-w-0 space-y-4">
                <div className="rounded-lg bg-muted/30 p-3.5 space-y-1 border border-border/60">
                  <p id="membership-policy-stage-2" tabIndex={-1} className="font-medium text-foreground outline-none">变更前后核对清单</p>
                  <p className="text-muted-foreground text-xs">{approvedPolicy ? `对比当前生效 v${approvedVersion} 与草稿 v${policy.version} 的调整项。` : "当前是首份统一政策草稿，没有可比较的生效基线。"}</p>
                </div>
                {!approvedPolicy ? (
                  <div className="py-8 text-center text-muted-foreground border rounded-lg border-dashed">首份草稿将建立统一权益基线；请重点核对等级折扣、礼遇范围与押金。</div>
                ) : changes.length ? (
                  <div className="membership-admin-change-list space-y-2">
                    {changes.map((change) => (
                      <div key={change.label} className="p-3 rounded-lg border bg-card flex items-center justify-between gap-3">
                        <div className="space-y-1">
                          <span className="font-medium text-foreground block">{change.label}</span>
                          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2"><span className="line-through">{change.before}</span><ChevronRight className="h-3 w-3" /><span className="font-semibold text-primary">{change.after}</span></div>
                        </div>
                        <Badge variant={change.risk === "REVIEW_REQUIRED" ? "warning" : "outline"}>{change.risk === "REVIEW_REQUIRED" ? "需重点核查" : "常规变动"}</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-8 text-center text-muted-foreground border rounded-lg border-dashed">草稿与当前生效基线一致，没有待核对的变动项。</div>
                )}
              </div>

              <div style={editStage === 3 ? undefined : { display: "none" }} className="min-w-0 space-y-4">
                <div className="rounded-lg border p-3.5 bg-card flex items-start gap-2">
                  <div id="membership-policy-stage-3" tabIndex={-1} className="min-w-0 flex-1 outline-none"><MembershipDateTimeField label="计划生效时间" value={policy.effectiveAt ?? ""} disabled={!editable} onChange={(value) => updatePolicy({ ...policy, effectiveAt: value || null })} /></div>
                  <InfoHint label="生效时点说明">保存草稿不会改变已生效价格；审批通过并执行后，按此时间生效。</InfoHint>
                </div>
                {allErrors.length ? <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3.5 text-destructive text-xs space-y-1.5"><p className="font-semibold">存在未满足项，无法提交审批：</p><ul className="list-disc list-inside space-y-1">{allErrors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
                {warnings.length ? <div className="rounded-lg border border-warning/40 bg-warning/5 p-3.5 text-warning-foreground text-xs space-y-1.5"><p className="font-semibold">提审前需关注：</p><ul className="list-disc list-inside space-y-1">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
              </div>
            </div>

            <div className="sticky bottom-0 z-10 -mx-5 mt-4 flex flex-wrap items-center justify-between gap-2 border-t bg-popover px-5 py-3">
              <div className="flex items-center gap-2">
                {editStage > 1 ? <Button size="sm" variant="outline" onClick={() => setEditStage((stage) => (stage - 1) as 1 | 2)}>上一步</Button> : null}
                <Button size="sm" variant="ghost" disabled={policySaving} onClick={() => handleCloseEditAttempt(false)}>取消修改</Button>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {onSavePolicyDraft ? (
                  <>
                    <InfoHint label="保存草稿说明">保存后成为草稿；当前接口不支持删除草稿，可继续修改后重新保存。</InfoHint>
                    <Button type="button" size="sm" variant="outline" disabled={!editable || (!dirty && policySaved) || allErrors.length > 0 || policySaving} onClick={onSavePolicyDraft}>{policySaving ? "保存中…" : "保存草稿"}</Button>
                  </>
                ) : null}
                {editStage < 3 ? <Button size="sm" variant="default" disabled={!editable || editStage === 1 && !stageOneComplete} onClick={() => goToStage((editStage + 1) as 2 | 3)}>下一步</Button> : onSubmitPolicy ? (
                  <Button type="button" size="sm" disabled={!canSubmitNow} onClick={() => { if (canSubmitNow) { onSubmitPolicy(); setIsEditOpen(false); } }}><Send className="h-3.5 w-3.5 mr-1" />提交审批</Button>
                ) : null}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {mounted && canSimulateProfit ? (
        <ProfitSimulationModal key={`${binding?.ruleReleaseId ?? ""}:${binding?.priceVersionId ?? ""}`} open={isSimulateOpen} onOpenChange={setIsSimulateOpen} ruleReleaseId={binding?.ruleReleaseId ?? ""} priceVersionId={binding?.priceVersionId ?? ""} enabledModes={policy.catalog.enabledModes ?? []} gameId={simulationGameId} />
      ) : null}
    </div>
  );
}
