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

export type AdminPricingMode = "ordinary" | "custom" | "fast";
export type AdminGrowthCatalog = {
  safeBoxes: string[];
  materials: Array<{ id: string; name: string; unit: "ROUND" | "PIECE" | "DAY"; unitQuantity?: string }>;
  priceVersions: Array<{ id: string; label: string }>;
  enabledModes?: AdminPricingMode[];
  haffSchema?: "haff-ratio-v1" | "haff-ratio-v2";
  releaseMode?: "SPREAD" | "PERCENT";
  catalogSource?: "SEALED" | "POLICY_PAYLOAD" | null;
};

/** Deposit/threshold metadata only; pricing is server-normalized through unifiedPricing. */
export type AdminGrowthPolicy = {
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAt: string | null;
  catalog: AdminGrowthCatalog;
  tiers: Array<{
    tier: AdminGrowthTier;
    threshold: string;
    tenantDeposit: "ACCOUNT_BASE" | "WAIVED";
    depositAllowanceCents?: string;
  }>;
};

export type AdminPolicyChange = { label: string; before: string; after: string; risk: "LOW" | "REVIEW_REQUIRED" };

export type AdminGrowthPreview = { status: "NOT_RUN" | "LOCAL_FIXTURE" | "KNOWN" | "UNKNOWN"; totalCents?: string; priceBasis?: string; depositBasis?: string; reason?: string };
export type AdminGrowthSubject = { subjectId: string; status: "NOT_LOADED" | "LOADED" | "UNKNOWN" | "FORBIDDEN"; userLabel?: string; tier?: string; rollingPoints?: string; lifetimePoints?: string; evidence?: string[]; reason?: string };
export type AdminApproval = { status: "NOT_REQUESTED" | "REQUESTED" | "APPLIED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "UNKNOWN"; requestId?: string; message?: string };

export type AdminPolicyRequestedValue = { label: string; value: string | null; format: "TEXT" | "DISCOUNT" | "CENTS" };
export type AdminPolicyNotice = { tone: "info" | "warning" | "error"; title: string; description: string; requestId?: string | null; onRecover?: () => void; recovering?: boolean; blocking?: boolean };
export type AdminPolicyChangePerson = { id: string; name: string | null };
export type AdminPolicyChangeStep = {
  key: "SUBMITTED" | "APPROVAL" | "EXECUTION" | "EFFECTIVE";
  label: string;
  state: "COMPLETED" | "CURRENT" | "PENDING" | "FAILED" | "UNKNOWN";
  actor?: AdminPolicyChangePerson | null;
  atUtc?: string | null;
  note?: string | null;
};
export type AdminPolicyChangeDiff = {
  label: string;
  baseline: string | null;
  requested: string | null;
  format?: "TEXT" | "DISCOUNT" | "CENTS";
  risk?: "LOW" | "REVIEW_REQUIRED";
};
export type AdminPolicyChangeRequest = {
  id: string;
  operationCode?: string | null;
  approvalStatus: string;
  executionStatus?: string | null;
  reason?: string | null;
  submittedBy?: AdminPolicyChangePerson | null;
  submittedAtUtc?: string | null;
  plannedEffectiveAtUtc?: string | null;
  steps?: AdminPolicyChangeStep[] | null;
};
export type AdminPolicyChangeProjection = {
  knowledge: "KNOWN" | "UNKNOWN" | "FORBIDDEN";
  draftReference?: { id: string; version: string; payloadHash: string } | null;
  request?: AdminPolicyChangeRequest | null;
  immutableDiff?: AdminPolicyChangeDiff[] | null;
  requestedValues?: AdminPolicyRequestedValue[] | null;
  effectiveState?: { status: string; effectiveAtUtc?: string | null; executed?: boolean | null } | null;
  message?: string | null;
};
export type AdminPolicyChangeRead =
  | { status: "READY"; change: AdminPolicyChangeProjection | null; knownRequestId?: string | null }
  | { status: "UNAVAILABLE"; message?: string | null; knownRequestId?: string | null };

export type MembershipGrowthAdminState =
  | { status: "loading" }
  | { status: "error"; message: string; subject?: AdminGrowthSubject }
  | { status: "permission"; message: string }
  | {
      status: "ready";
      policy: AdminGrowthPolicy;
      unifiedPricing: UnifiedPricingProjection;
      approvedPolicy: AdminGrowthPolicy | null;
      approvedUnifiedPricing: UnifiedPricingProjection | null;
      capability: AdminGrowthCapability;
      preview: AdminGrowthPreview;
      subject: AdminGrowthSubject;
      approval: AdminApproval;
      policyChange: AdminPolicyChangeRead;
      draftReference: { id: string; version: string; payloadHash: string } | null;
    };

const TIER_LABELS: Record<AdminGrowthTier, string> = { STANDARD: "普通", SILVER: "银卡", GOLD: "金卡", PLATINUM: "铂金", DIAMOND: "钻石" };
const TIER_ORDER: AdminGrowthTier[] = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"];
const KIND_LABELS = { FRIEND: "挚友礼遇", PRESTIGE: "尊享礼遇" } as const;

export function exactPercentTenths(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === 0n) return null;
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const scaled = (n * 1000n + d / 2n) / d;
  return negative ? -scaled : scaled;
}

export function formatTenthsPercent(tenths: bigint | null): string {
  if (tenths === null) return "—";
  const negative = tenths < 0n;
  const value = negative ? -tenths : tenths;
  return `${negative ? "-" : ""}${value / 10n}.${value % 10n}%`;
}

function exactPercent(numerator: bigint, denominator: bigint, decimals: number): string {
  if (denominator === 0n) return "—";
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const scale = 10n ** BigInt(decimals);
  const scaled = (n * 100n * scale + d / 2n) / d;
  const whole = scaled / scale;
  const fraction = scaled % scale;
  const text = fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  return `${negative ? "-" : ""}${text}%`;
}

export function formatSpreadRate(rate: { numerator: string; denominator: string } | null | undefined): string {
  if (!rate) return "—";
  try {
    return exactPercent(BigInt(rate.numerator), BigInt(rate.denominator), 1);
  } catch {
    return "—";
  }
}

export function bootstrapGrowthPolicy(catalog: AdminGrowthCatalog, thresholds: Record<string, string>, versionNo: number): AdminGrowthPolicy {
  return {
    version: String(versionNo),
    status: "DRAFT",
    effectiveAt: null,
    catalog,
    tiers: TIER_ORDER.map((tier) => ({
      tier,
      threshold: thresholds[tier] ?? "0",
      tenantDeposit: tier === "STANDARD" || tier === "SILVER" ? "ACCOUNT_BASE" : "WAIVED",
      depositAllowanceCents: "0",
    })),
  };
}

export function unifiedDraftFromProjection(projection: UnifiedPricingProjection): UnifiedDraft {
  return {
    tiers: Object.fromEntries(TIER_ORDER.map((tier) => [tier, projection.tiers[tier]?.knowledge === "KNOWN" ? projection.tiers[tier].payableRatio ?? "" : ""])) as UnifiedDraft["tiers"],
    ranges: Object.fromEntries((["FRIEND", "PRESTIGE"] as const).map((kind) => {
      const range = projection.entitlementRanges[kind];
      return [kind, { min: range?.knowledge === "KNOWN" ? range.minPayableRatio ?? "" : "", max: range?.knowledge === "KNOWN" ? range.maxPayableRatio ?? "" : "" }];
    })) as UnifiedDraft["ranges"],
  };
}

export function unifiedPricingInputFromDraft(draft: UnifiedDraft): UnifiedPricingInput {
  return {
    schema: UNIFIED_PRICING_SCHEMA,
    scope: UNIFIED_PRICING_SCOPE,
    tiers: Object.fromEntries(TIER_ORDER.map((tier) => [tier, { payableRatio: draft.tiers[tier].trim() }])) as UnifiedPricingInput["tiers"],
    entitlementRanges: Object.fromEntries((["FRIEND", "PRESTIGE"] as const).map((kind) => [kind, {
      minPayableRatio: draft.ranges[kind].min.trim(),
      maxPayableRatio: draft.ranges[kind].max.trim(),
    }])) as UnifiedPricingInput["entitlementRanges"],
  };
}

export function formatPayablePercent(value: string): string {
  const ratio = parsePayableRatio(value);
  if (ratio === null) return "";
  const hundredths = (ratio + 5_000n) / 10_000n;
  const whole = hundredths / 100n;
  const fraction = hundredths % 100n;
  const text = fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(2, "0").replace(/0+$/, "")}`;
  return `${text}%`;
}

export function unifiedTierText(tier: UnifiedTierProjection | undefined): { configured: boolean; text: string; detail: string } {
  if (!tier || tier.knowledge !== "KNOWN" || !tier.payableRatio) {
    return { configured: false, text: "待核", detail: unifiedReasonText(tier?.reasonCodes) };
  }
  const label = formatDiscountLabel(tier.payableRatio);
  const percent = label === "原价" ? "" : formatPayablePercent(tier.payableRatio);
  return { configured: true, text: percent ? `${label}（实付 ${percent}）` : label, detail: "" };
}

export function unifiedRangeText(range: UnifiedRangeProjection | undefined): { configured: boolean; text: string; detail: string } {
  if (!range || range.knowledge !== "KNOWN" || !range.minPayableRatio || !range.maxPayableRatio) {
    return { configured: false, text: "待核", detail: unifiedReasonText(range?.reasonCodes) };
  }
  return { configured: true, text: formatDiscountRangeLabel(range.minPayableRatio, range.maxPayableRatio), detail: "" };
}

export function validateAdminPolicyDraft(policy: AdminGrowthPolicy, unified: UnifiedDraft): { errors: string[]; warnings: string[]; publishable: boolean } {
  const errors: string[] = [], warnings: string[] = [];
  if (!policy.effectiveAt) warnings.push("计划生效时间未填写：提交前必须确认");
  let previousRatio: bigint | null = null, previousLabel = "";
  for (const tier of TIER_ORDER) {
    const value = unified.tiers[tier]?.trim() ?? "";
    if (!value) { warnings.push(`${TIER_LABELS[tier]}：统一折扣待填写`); previousRatio = null; previousLabel = TIER_LABELS[tier]; continue; }
    const parsed = parsePayableRatio(value);
    if (parsed === null) { errors.push(`${TIER_LABELS[tier]}：折扣须为 (0,1] 小数，最多 8 位`); previousRatio = null; previousLabel = TIER_LABELS[tier]; continue; }
    if (previousRatio !== null && parsed > previousRatio) errors.push(`${TIER_LABELS[tier]}：高档折扣不得高于${previousLabel}`);
    previousRatio = parsed;
    previousLabel = TIER_LABELS[tier];
  }
  for (const kind of ["FRIEND", "PRESTIGE"] as const) {
    const { min, max } = unified.ranges[kind];
    const minValue = min.trim(), maxValue = max.trim();
    if (!minValue && !maxValue) { warnings.push(`${KIND_LABELS[kind]}：统一范围待填写`); continue; }
    const parsedMin = minValue ? parsePayableRatio(minValue) : null;
    const parsedMax = maxValue ? parsePayableRatio(maxValue) : null;
    if (!minValue || !maxValue) { errors.push(`${KIND_LABELS[kind]}：请填写最小和最大应付比例`); continue; }
    if (parsedMin === null || parsedMax === null) { errors.push(`${KIND_LABELS[kind]}：范围须为 (0,1] 小数，最多 8 位`); continue; }
    if (parsedMin > parsedMax) errors.push(`${KIND_LABELS[kind]}：最小应付比例不能大于最大值`);
  }
  return { errors, warnings, publishable: errors.length === 0 && warnings.length === 0 };
}

function depositText(tier: AdminGrowthPolicy["tiers"][number]): string {
  return formatDepositBenefitText(tier.tenantDeposit === "WAIVED", tier.depositAllowanceCents);
}

export const BLACK_GOLD_CONDITION = "累计有效成长积分 50,000";

function formatPointValue(value: string | undefined): string {
  if (!value) return "—";
  return /^\d+$/.test(value) ? value.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : value;
}

export function blackGoldBenefits(policy: AdminGrowthPolicy | null, unified: UnifiedPricingProjection | null) {
  const diamondTier = policy?.tiers.find((tier) => tier.tier === "DIAMOND") ?? null;
  const display = unifiedTierText(unified?.tiers.DIAMOND);
  return {
    discountText: display.text,
    discountConfigured: display.configured,
    discountDetail: display.detail,
    depositText: diamondTier ? depositText(diamondTier) : "未取得",
    depositKnown: Boolean(diamondTier),
    depositVariant: (diamondTier?.tenantDeposit === "WAIVED" ? "success" : diamondTier?.depositAllowanceCents && diamondTier.depositAllowanceCents !== "0" ? "info" : "outline") as "success" | "info" | "outline",
  };
}

/** Mirrors the backend's integer-cents bound; a valid raw text must be sent unchanged, never replaced by an older value. */
export function parsePolicyAllowanceYuan(value: string): { cents: string | null; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { cents: null, error: "请输入押金减免额度" };
  const cents = parseYuanToCents(trimmed);
  if (cents === null) return { cents: null, error: "额度须为大于 0 的金额，最多两位小数，不支持负数或指数" };
  if (cents === "0") return { cents: null, error: "额度须大于 0" };
  if (cents.length > 24) return { cents: null, error: "额度超出可保存范围" };
  return { cents, error: "" };
}

/** Only decision-relevant changes; price/cost references are server-normalized and never shown as draft inputs. */
export function diffGrowthPolicies(
  baseline: AdminGrowthPolicy,
  baselineUnified: UnifiedPricingProjection,
  draft: AdminGrowthPolicy,
  draftUnified: UnifiedDraft,
): AdminPolicyChange[] {
  const changes: AdminPolicyChange[] = [];
  const beforeEffective = baseline.effectiveAt ? formatDate(baseline.effectiveAt) : "未设定";
  const afterEffective = draft.effectiveAt ? formatDate(draft.effectiveAt) : "未设定";
  if (beforeEffective !== afterEffective) changes.push({ label: "计划生效时间", before: beforeEffective, after: afterEffective, risk: "REVIEW_REQUIRED" });
  for (const tier of TIER_ORDER) {
    const previous = baseline.tiers.find((entry) => entry.tier === tier);
    const current = draft.tiers.find((entry) => entry.tier === tier);
    if (previous && current) {
      const beforeDeposit = depositText(previous), afterDeposit = depositText(current);
      if (beforeDeposit !== afterDeposit) changes.push({ label: `${TIER_LABELS[tier]} · 押金权益`, before: beforeDeposit, after: afterDeposit, risk: "REVIEW_REQUIRED" });
    }
    const before = baselineUnified.tiers[tier];
    const afterRatio = draftUnified.tiers[tier]?.trim() ?? "";
    const beforeText = unifiedTierText(before).text === "待核" ? `待核（${unifiedReasonText(before?.reasonCodes)}）` : unifiedTierText(before).text;
    const afterLabel = afterRatio ? formatDiscountLabel(afterRatio) : "";
    const afterText = afterRatio ? (afterLabel === "原价" ? "原价" : `${afterLabel}（实付 ${formatPayablePercent(afterRatio)}）`) : "待填写";
    if (beforeText !== afterText) {
      const beforeRatio = before?.knowledge === "KNOWN" ? parsePayableRatio(before.payableRatio ?? "") : null;
      const afterParsed = afterRatio ? parsePayableRatio(afterRatio) : null;
      changes.push({
        label: `${TIER_LABELS[tier]} · 统一应付折扣`,
        before: beforeText,
        after: afterText,
        risk: afterParsed === null || beforeRatio === null || afterParsed < beforeRatio ? "REVIEW_REQUIRED" : "LOW",
      });
    }
  }
  for (const kind of ["FRIEND", "PRESTIGE"] as const) {
    const before = baselineUnified.entitlementRanges[kind];
    const beforeText = unifiedRangeText(before).text === "待核" ? `待核（${unifiedReasonText(before?.reasonCodes)}）` : unifiedRangeText(before).text;
    const afterMin = draftUnified.ranges[kind].min.trim(), afterMax = draftUnified.ranges[kind].max.trim();
    const afterText = afterMin && afterMax ? formatDiscountRangeLabel(afterMin, afterMax) : "待填写";
    if (beforeText !== afterText) {
      const beforeMin = before?.knowledge === "KNOWN" ? parsePayableRatio(before.minPayableRatio ?? "") : null;
      const afterMinParsed = afterMin ? parsePayableRatio(afterMin) : null;
      changes.push({
        label: `${KIND_LABELS[kind]} · 统一折扣范围`,
        before: beforeText,
        after: afterText,
        risk: afterMinParsed === null || beforeMin === null || afterMinParsed < beforeMin ? "REVIEW_REQUIRED" : "LOW",
      });
    }
  }
  return changes;
}

export function withBlackGoldChanges(changes: AdminPolicyChange[]): AdminPolicyChange[] {
  if (changes.some((change) => change.label.includes("黑金"))) return changes;
  return changes.flatMap((change) => {
    const derived: AdminPolicyChange[] = [change];
    if (change.label === "钻石 · 统一应付折扣") derived.push({ ...change, label: "黑金（永久） · 统一应付折扣（随钻石）" });
    if (change.label === "钻石 · 押金权益") derived.push({ ...change, label: "黑金（永久） · 押金权益（随钻石）" });
    return derived;
  });
}

export function withBlackGoldDiffs(diffs: AdminPolicyChangeDiff[]): AdminPolicyChangeDiff[] {
  if (diffs.some((diff) => diff.label.includes("黑金"))) return diffs;
  return diffs.flatMap((diff) => {
    const derived: AdminPolicyChangeDiff[] = [diff];
    if (diff.label === "钻石 · 统一应付折扣") derived.push({ ...diff, label: "黑金（永久） · 统一应付折扣（随钻石）" });
    if (diff.label === "钻石 · 押金权益") derived.push({ ...diff, label: "黑金（永久） · 押金权益（随钻石）" });
    return derived;
  });
}

export type PolicyChangeCardKind = "draft" | "pending" | "rejected" | "approved" | "execution-unknown" | "pending-effective" | "effective" | "expired" | "cancelled" | "unknown" | "forbidden" | "unavailable" | "foreign" | "none";

export type PolicyChangeCardModel = {
  kind: PolicyChangeCardKind;
  label: string;
  summary: string;
  diffs: AdminPolicyChangeDiff[];
  detailDiffs: AdminPolicyChangeDiff[];
  diffGap: string | null;
  request: AdminPolicyChangeRequest | null;
  requestId: string | null;
  priorRequest: boolean;
  submittedBy: AdminPolicyChangePerson | null;
  submittedAtUtc: string | null;
  plannedEffectiveAtUtc: string | null;
  nextStep: string;
  effectiveNote: string;
  canSubmit: boolean;
  submitReason: string | null;
  canOpenDetail: boolean;
  approvalActionLabel: string | null;
  sourceNote: string | null;
  steps: AdminPolicyChangeStep[];
};

type PolicyChangeCardInput = {
  read: AdminPolicyChangeRead;
  approval: AdminApproval;
  hasDraft: boolean;
  currentDraft: { id: string; version: string; payloadHash: string } | null;
  draftDiffs: AdminPolicyChangeDiff[];
  submitReady: boolean;
  localPending: boolean;
};

function formatPolicyChangeValue(value: string | null | undefined, format: AdminPolicyChangeDiff["format"]): string {
  if (value === null || value === undefined || value === "") return "未取得";
  if (format === "DISCOUNT") {
    if (parsePayableRatio(value) === null) return "未取得";
    const label = formatDiscountLabel(value);
    return label === "原价" ? "原价" : `${label}（实付 ${formatPayablePercent(value)}）`;
  }
  if (format === "CENTS") return /^-?(0|[1-9]\d*)$/.test(value) ? formatCents(value) : "未取得";
  return value;
}

export function policyChangeDiffText(item: AdminPolicyChangeDiff, side: "baseline" | "requested"): string {
  return formatPolicyChangeValue(side === "baseline" ? item.baseline : item.requested, item.format);
}

export function requestKind(request: AdminPolicyChangeRequest, change: AdminPolicyChangeProjection): Exclude<PolicyChangeCardKind, "draft" | "none" | "foreign" | "forbidden" | "unavailable"> {
  const approval = request.approvalStatus.toUpperCase();
  if (approval === "EXPIRED") return "expired";
  if (approval === "CANCELLED") return "cancelled";
  const execution = (request.executionStatus ?? "").toUpperCase();
  const effective = (change.effectiveState?.status ?? "").toUpperCase();
  const executed = request.executionStatus
    ? ["EXECUTED", "SUCCEEDED", "DONE", "PUBLISHED"].some((value) => execution.includes(value))
    : change.effectiveState?.executed === true;
  const executionFailed = ["FAILED", "ERROR", "UNKNOWN"].some((value) => execution.includes(value));
  if (approval.includes("REJECT") || approval.includes("DENIED")) return "rejected";
  if (approval.includes("APPROVED")) {
    if (executionFailed) return "execution-unknown";
    if (effective === "EFFECTIVE") return "effective";
    if (executed) {
      if (effective === "PENDING_EFFECTIVE" || effective === "SCHEDULED") return "pending-effective";
      // Without a server effective projection, an executed request is not proof of a scheduled/effective result.
      return "unknown";
    }
    return "approved";
  }
  if (approval.includes("PENDING") || approval.includes("REVIEW") || approval.includes("SUBMITTED")) return "pending";
  return "unknown";
}

function policyChangeSteps(request: AdminPolicyChangeRequest, change: AdminPolicyChangeProjection, kind: PolicyChangeCardKind): AdminPolicyChangeStep[] {
  const effective = change.effectiveState;
  const provided = new Map((request.steps ?? []).map((step) => [step.key, step]));
  const base = (key: AdminPolicyChangeStep["key"], label: string, state: AdminPolicyChangeStep["state"]): AdminPolicyChangeStep => ({ key, label, state });
  const steps = [
    base("SUBMITTED", "已提交", request.id ? "COMPLETED" : "UNKNOWN"),
    base("APPROVAL", "审批处理", kind === "pending" ? "CURRENT" : kind === "rejected" ? "FAILED" : kind === "unknown" || kind === "expired" || kind === "cancelled" ? "UNKNOWN" : "COMPLETED"),
    base("EXECUTION", "执行发布", kind === "execution-unknown" ? "UNKNOWN" : kind === "approved" || kind === "pending" ? (kind === "approved" ? "CURRENT" : "PENDING") : kind === "pending-effective" || kind === "effective" ? "COMPLETED" : "PENDING"),
    base("EFFECTIVE", "生效", kind === "effective" ? "COMPLETED" : kind === "pending-effective" ? "CURRENT" : "PENDING"),
  ];
  for (const step of steps) {
    const actual = provided.get(step.key);
    if (!actual) continue;
    step.label = actual.label || step.label;
    step.state = actual.state;
    step.note = actual.note ?? null;
    if (step.state === "COMPLETED" || step.state === "FAILED") {
      step.actor = actual.actor ?? null;
      step.atUtc = actual.atUtc ?? null;
    }
  }
  const submitted = steps[0]!;
  if (submitted.state === "COMPLETED") {
    submitted.actor = submitted.actor ?? request.submittedBy ?? null;
    submitted.atUtc = submitted.atUtc ?? request.submittedAtUtc ?? null;
  }
  const effectiveStep = steps[3]!;
  if (effectiveStep.state === "COMPLETED" && !effectiveStep.atUtc) effectiveStep.atUtc = effective?.effectiveAtUtc ?? request.plannedEffectiveAtUtc ?? null;
  return steps;
}

const POLICY_CHANGE_COPY: Record<PolicyChangeCardKind, { label: string; nextStep: string; effectiveNote: string }> = {
  draft: { label: "草稿待提交", nextStep: "下一步：保存并核对差异后可提交审批；审批通过并执行后才生效。", effectiveNote: "尚未提交；当前生效仍以本页权益表为准。" },
  pending: { label: "待审批", nextStep: "下一步：由具备审批权限的管理员在审批中心处理；当前审批不是多人逐级必签。", effectiveNote: "批准并执行后才生效；计划时间不构成按时生效保证。" },
  rejected: { label: "已退回", nextStep: "下一步：调整草稿并保存后可重新提交；服务端仍会复核重复申请。", effectiveNote: "本次申请未生效；当前权益不变。" },
  approved: { label: "审批已过待发布", nextStep: "下一步：执行/发布；批准不等于生效。", effectiveNote: "执行并到达计划时间后才生效。" },
  "execution-unknown": { label: "执行状态待核对", nextStep: "下一步：核对执行结果；失败或未知不能当作已生效。", effectiveNote: "执行未确认，当前不能称为已生效。" },
  "pending-effective": { label: "已发布待生效", nextStep: "下一步：等待到达计划生效时点；以服务端当前生效投影为准。", effectiveNote: "已发布但尚未到生效时点。" },
  effective: { label: "已生效", nextStep: "当前已生效；以本页生效权益为准。", effectiveNote: "已生效。" },
  expired: { label: "已过期", nextStep: "请调整并保存草稿后重新提交。", effectiveNote: "这份申请已过期。" },
  cancelled: { label: "已撤销", nextStep: "请调整并保存草稿后重新提交。", effectiveNote: "这份申请已撤销。" },
  unknown: { label: "暂未取得变更状态", nextStep: "下一步：刷新状态或查看原申请；关联未清前不能新建政策申请。", effectiveNote: "生效状态未取得。" },
  forbidden: { label: "无权读取变更状态", nextStep: "下一步：联系具备审批读取权限的管理员。", effectiveNote: "当前身份不能读取变更详情。" },
  unavailable: { label: "暂未取得变更状态", nextStep: "下一步：刷新状态或查看原申请；服务端变更投影未就绪前不能新建政策申请。", effectiveNote: "生效状态未取得。" },
  foreign: { label: "原申请属于另一份草稿", nextStep: "下一步：刷新状态或查看原申请；不会把该申请贴到当前草稿。", effectiveNote: "当前草稿关联未知。" },
  none: { label: "暂无待处理变更", nextStep: "当前无需处理。", effectiveNote: "当前生效以本页权益表为准。" },
};

export function policyChangeCardModel(input: PolicyChangeCardInput): PolicyChangeCardModel {
  const { read, approval, hasDraft, currentDraft, draftDiffs, submitReady, localPending } = input;
  const localId = approval.requestId ?? null;
  const localActive = approval.status === "REQUESTED";
  const localRejected = approval.status === "REJECTED";
  const serverId = read.knownRequestId ?? (read.status === "READY" ? read.change?.request?.id ?? null : null);
  const fallbackId = localId ?? serverId;
  const localClosed = ["REJECTED", "EXPIRED", "CANCELLED", "APPLIED"].includes(approval.status);
  const localUnresolvedReal = localActive || Boolean(localId && !localClosed) || localPending;
  const localRequest = (): AdminPolicyChangeRequest | null => localId ? {
    id: localId,
    approvalStatus: localRejected ? "REJECTED" : localActive ? "PENDING" : "UNKNOWN",
    submittedBy: null,
    submittedAtUtc: null,
    plannedEffectiveAtUtc: null,
    steps: null,
  } : null;
  const localKind: PolicyChangeCardKind = localRejected ? "rejected" : localActive ? "pending" : "unknown";
  const localLabel = localRejected ? "已退回" : localActive ? "已提交审批" : "暂未取得变更状态";
  const localCard = (sourceNote: string): PolicyChangeCardModel => ({
    kind: localKind,
    label: localLabel,
    summary: approval.message ?? (localRejected ? "本页保留的原申请已退回；服务端状态待复核" : localActive ? "本页保留原申请号；服务端变更状态待复核" : "关联申请待核对"),
    diffs: [],
    detailDiffs: [],
    diffGap: "差异未取得：需服务端返回原申请冻结值，不能用当前草稿代替。",
    request: localRequest(),
    requestId: fallbackId,
    priorRequest: false,
    submittedBy: null,
    submittedAtUtc: null,
    plannedEffectiveAtUtc: null,
    nextStep: localActive ? "下一步：到审批中心查看/处理；本页不能据此新建申请。" : POLICY_CHANGE_COPY[localKind].nextStep,
    effectiveNote: POLICY_CHANGE_COPY[localKind].effectiveNote,
    canSubmit: false,
    submitReason: sourceNote,
    canOpenDetail: Boolean(fallbackId),
    approvalActionLabel: localActive ? "到审批中心处理" : "查看原申请",
    sourceNote,
    steps: localRequest() ? policyChangeSteps(localRequest()!, { knowledge: "UNKNOWN" }, localKind) : [],
  });
  const idOnlyCard = (kind: "forbidden" | "unknown", label: string, summary: string, sourceNote: string): PolicyChangeCardModel => ({
    kind,
    label,
    summary,
    diffs: [],
    detailDiffs: [],
    diffGap: kind === "forbidden" ? "无权读取差异详情；原申请号已保留。" : "差异未取得：需服务端返回原申请冻结值。",
    request: null,
    requestId: fallbackId,
    priorRequest: false,
    submittedBy: null,
    submittedAtUtc: null,
    plannedEffectiveAtUtc: null,
    nextStep: POLICY_CHANGE_COPY[kind].nextStep,
    effectiveNote: POLICY_CHANGE_COPY[kind].effectiveNote,
    canSubmit: false,
    submitReason: sourceNote,
    canOpenDetail: Boolean(fallbackId),
    approvalActionLabel: fallbackId ? "查看原申请" : null,
    sourceNote,
    steps: [],
  });
  const draftOrNone = (request: AdminPolicyChangeRequest | null, change: AdminPolicyChangeProjection | null, sourceNote: string | null, prior: boolean): PolicyChangeCardModel => {
    const kind: PolicyChangeCardKind = hasDraft ? "draft" : "none";
    const copy = POLICY_CHANGE_COPY[kind];
    const priorLabel = request ? `；上次申请已${requestKind(request, change ?? { knowledge: "UNKNOWN" }) === "effective" ? "生效" : "退回"}（另一份草稿）` : "";
    return {
      kind,
      label: copy.label,
      summary: hasDraft
        ? `草稿待提交 · ${draftDiffs.length ? `与当前生效基线相差${draftDiffs.length}项` : "与当前生效基线一致"}${priorLabel}`
        : "服务端确认当前没有在途政策申请",
      diffs: draftDiffs,
      detailDiffs: prior && request && change ? (change.immutableDiff ?? []) : draftDiffs,
      diffGap: prior && request && change && change.immutableDiff == null ? "差异未取得：需服务端返回原申请冻结值。" : null,
      request,
      requestId: request?.id ?? null,
      priorRequest: prior,
      submittedBy: null,
      submittedAtUtc: null,
      plannedEffectiveAtUtc: null,
      nextStep: copy.nextStep,
      effectiveNote: copy.effectiveNote,
      canSubmit: submitReady && !localUnresolvedReal,
      submitReason: localUnresolvedReal ? "本页仍有原申请责任未核清；服务端确认前不能新建申请。" : null,
      canOpenDetail: Boolean(request) || hasDraft,
      approvalActionLabel: request ? "查看原申请" : null,
      sourceNote,
      steps: [],
    };
  };

  if (read.status === "UNAVAILABLE") {
    if (localUnresolvedReal) return localCard(read.message ?? "服务端尚未提供变更状态；本页原申请号已保留。");
    if (fallbackId) return idOnlyCard("unknown", POLICY_CHANGE_COPY.unknown.label, "服务端变更状态未取得；原申请号保留", read.message ?? "服务端尚未提供变更状态；仅保留原申请号。");
    return {
      kind: "unavailable", label: POLICY_CHANGE_COPY.unavailable.label,
      summary: "服务端尚未提供政策变更读取投影；不能据此判断没有申请",
      diffs: [], detailDiffs: [], diffGap: null, request: null, requestId: null, priorRequest: false,
      submittedBy: null, submittedAtUtc: null, plannedEffectiveAtUtc: null,
      nextStep: POLICY_CHANGE_COPY.unavailable.nextStep, effectiveNote: POLICY_CHANGE_COPY.unavailable.effectiveNote,
      canSubmit: false, submitReason: read.message ?? "变更状态尚未取得；当前不能提交新申请。",
      canOpenDetail: false, approvalActionLabel: null, sourceNote: read.message ?? null, steps: [],
    };
  }
  const change = read.change;
  if (!change) {
    if (localUnresolvedReal) return localCard("服务端未返回变更状态；本页原申请号已保留。");
    if (fallbackId) return idOnlyCard("unknown", POLICY_CHANGE_COPY.unknown.label, "服务端未返回变更状态；原申请号保留", "服务端未返回变更状态；仅保留原申请号。");
    return { ...draftOrNone(null, null, null, false), canSubmit: false, submitReason: "服务端未返回变更状态；当前不能提交新申请。" };
  }
  if (change.knowledge === "FORBIDDEN") {
    if (fallbackId) return idOnlyCard("forbidden", POLICY_CHANGE_COPY.forbidden.label, "变更详情已受限；原申请号保留", "变更详情权限已变化；受限差异、人员和时已清除，仅保留原申请号。");
    return {
      kind: "forbidden", label: POLICY_CHANGE_COPY.forbidden.label, summary: "当前身份不能读取政策变更详情",
      diffs: [], detailDiffs: [], diffGap: null, request: null, requestId: null, priorRequest: false,
      submittedBy: null, submittedAtUtc: null, plannedEffectiveAtUtc: null,
      nextStep: POLICY_CHANGE_COPY.forbidden.nextStep, effectiveNote: POLICY_CHANGE_COPY.forbidden.effectiveNote,
      canSubmit: false, submitReason: "无权读取变更状态；当前不能提交新申请。",
      canOpenDetail: false, approvalActionLabel: null, sourceNote: change.message ?? null, steps: [],
    };
  }
  if (change.knowledge === "UNKNOWN") {
    if (localUnresolvedReal) return localCard(change.message ?? "服务端暂未取得变更状态；本页原申请号已保留。");
    if (fallbackId) return idOnlyCard("unknown", POLICY_CHANGE_COPY.unknown.label, change.message ?? "服务端暂未取得变更状态；原申请号保留", change.message ?? "服务端暂未取得变更状态；仅保留原申请号。");
    return {
      kind: "unknown", label: POLICY_CHANGE_COPY.unknown.label, summary: change.message ?? "服务端暂未取得政策变更状态",
      diffs: [], detailDiffs: [], diffGap: null, request: null, requestId: null, priorRequest: false,
      submittedBy: null, submittedAtUtc: null, plannedEffectiveAtUtc: null,
      nextStep: POLICY_CHANGE_COPY.unknown.nextStep, effectiveNote: POLICY_CHANGE_COPY.unknown.effectiveNote,
      canSubmit: false, submitReason: "变更状态未取得；当前不能提交新申请。",
      canOpenDetail: false, approvalActionLabel: null, sourceNote: change.message ?? null, steps: [],
    };
  }

  const request = change.request ?? null;
  if (!request) {
    if (localUnresolvedReal) return localCard("服务端未返回该申请；本页原申请号已保留。");
    return draftOrNone(null, change, null, false);
  }
  const reference = change.draftReference ?? null;
  const referenceComplete = Boolean(reference && reference.id && reference.version && reference.payloadHash);
  const operationOk = request.operationCode === "membership.benefit.policy.publish";
  if (!operationOk || !referenceComplete || !reference) {
    const operationMissing = !request.operationCode;
    const label = operationMissing || operationOk ? "暂未取得变更状态" : "业务类型不匹配";
    const summary = operationMissing
      ? "申请业务类型未取得；不能核对是否会员政策"
      : operationOk
        ? "申请草稿引用未取得；不能确认对应当前政策"
        : "返回的申请不是会员政策发布；未贴到当前草稿";
    const sourceNote = operationMissing
      ? "申请缺少业务类型；不能视为已核实的会员政策申请。"
      : operationOk
        ? "草稿引用缺少完整 id/version/hash；保持未知。"
        : "业务类型与 policy publish 不一致。";
    return {
      kind: "unknown", label, summary,
      diffs: [], detailDiffs: [], diffGap: "差异未取得：关联未核实，不能按当前草稿展示。",
      request, requestId: request.id, priorRequest: false,
      submittedBy: request.submittedBy ?? null, submittedAtUtc: request.submittedAtUtc ?? null, plannedEffectiveAtUtc: request.plannedEffectiveAtUtc ?? null,
      nextStep: "下一步：刷新状态或查看原申请；未核清前不能新建政策申请。",
      effectiveNote: "当前草稿关联与生效状态未取得。",
      canSubmit: false, submitReason: "申请业务类型或草稿引用未核清；当前不能提交新申请。",
      canOpenDetail: true, approvalActionLabel: "查看原申请", sourceNote, steps: policyChangeSteps(request, change, "unknown"),
    };
  }
  const matchesDraft = Boolean(currentDraft
    && reference.id === currentDraft.id
    && reference.version === currentDraft.version
    && reference.payloadHash === currentDraft.payloadHash);
  const kind = requestKind(request, change);
  const copy = POLICY_CHANGE_COPY[kind];
  const diffs = withBlackGoldDiffs(change.immutableDiff ?? []);
  const diffGap = change.immutableDiff == null ? "差异未取得：需服务端返回原申请冻结值，不能用当前草稿代替。" : null;
  const planned = request.plannedEffectiveAtUtc ?? change.effectiveState?.effectiveAtUtc ?? null;
  const localConflict = localPending || Boolean(localId && localId !== request.id && !localClosed);
  if (kind === "expired" || kind === "cancelled") {
    const sameDraft = Boolean(currentDraft && matchesDraft);
    const canSubmit = !sameDraft && Boolean(currentDraft) && hasDraft && submitReady && !localConflict;
    return {
      kind, label: copy.label, summary: copy.effectiveNote,
      diffs, detailDiffs: diffs, diffGap, request, requestId: request.id, priorRequest: Boolean(currentDraft && !sameDraft),
      submittedBy: request.submittedBy ?? null, submittedAtUtc: request.submittedAtUtc ?? null, plannedEffectiveAtUtc: planned,
      nextStep: canSubmit ? "新草稿已保存，可以重新提交审批。" : copy.nextStep, effectiveNote: copy.effectiveNote,
      canSubmit, submitReason: localConflict ? "上次提交结果仍待核对，请先查询原结果。" : sameDraft ? "请调整并保存草稿后重新提交。" : null,
      canOpenDetail: true, approvalActionLabel: "查看原申请", sourceNote: null, steps: policyChangeSteps(request, change, kind),
    };
  }
  if (!currentDraft) {
    if (kind === "pending-effective" || kind === "effective") {
      return {
        kind, label: copy.label,
        summary: `${copy.label} · ${diffs.length ? `调整${diffs.length}项权益` : diffGap ? "差异未取得" : "未显示权益差异"}`,
        diffs, detailDiffs: diffs, diffGap, request, requestId: request.id, priorRequest: false,
        submittedBy: request.submittedBy ?? null, submittedAtUtc: request.submittedAtUtc ?? null, plannedEffectiveAtUtc: planned,
        nextStep: copy.nextStep, effectiveNote: copy.effectiveNote,
        canSubmit: false, submitReason: "已核发布申请不当作当前草稿；当前不能新建同类申请。",
        canOpenDetail: true, approvalActionLabel: "查看原申请",
        sourceNote: "原申请引用的是已发布政策；当前没有可编辑草稿。",
        steps: policyChangeSteps(request, change, kind),
      };
    }
    if (kind === "rejected") {
      return {
        kind, label: copy.label, summary: "申请已退回；当前没有可编辑草稿",
        diffs, detailDiffs: diffs, diffGap, request, requestId: request.id, priorRequest: false,
        submittedBy: request.submittedBy ?? null, submittedAtUtc: request.submittedAtUtc ?? null, plannedEffectiveAtUtc: planned,
        nextStep: copy.nextStep, effectiveNote: copy.effectiveNote,
        canSubmit: false, submitReason: "当前没有可编辑草稿；不能新建同类申请。",
        canOpenDetail: true, approvalActionLabel: "查看原申请",
        sourceNote: "原申请引用的是已退回政策草稿；当前没有可编辑草稿。",
        steps: policyChangeSteps(request, change, kind),
      };
    }
    return {
      kind: "unknown", label: "暂未取得变更状态", summary: "当前没有可编辑草稿；申请关联与生效依据待核",
      diffs: [], detailDiffs: [], diffGap: "差异未取得：缺少可核对的当前草稿或生效投影。",
      request, requestId: request.id, priorRequest: false,
      submittedBy: request.submittedBy ?? null, submittedAtUtc: request.submittedAtUtc ?? null, plannedEffectiveAtUtc: planned,
      nextStep: POLICY_CHANGE_COPY.unknown.nextStep, effectiveNote: "当前没有可编辑草稿；生效状态未取得。",
      canSubmit: false, submitReason: "申请关联未核实；当前不能新建同类申请。",
      canOpenDetail: true, approvalActionLabel: "查看原申请",
      sourceNote: "当前没有可编辑草稿；不能把该申请当作当前草稿。",
      steps: policyChangeSteps(request, change, "unknown"),
    };
  }
  if (!matchesDraft) {
    if (kind === "rejected" || kind === "effective") {
      const previous = draftOrNone(request, change, `上次申请（另一份草稿）${kind === "effective" ? "已生效" : "已退回"}；未贴到当前草稿。`, true);
      return { ...previous, canSubmit: submitReady && !localConflict, submitReason: localConflict ? "上次提交结果仍待核对，请先查询原结果。" : null };
    }
    return {
      kind: "foreign",
      label: "原申请属于另一份草稿",
      summary: `原申请${copy.label}；当前草稿关联未知`,
      diffs, detailDiffs: diffs, diffGap, request, requestId: request.id, priorRequest: true,
      submittedBy: request.submittedBy ?? null, submittedAtUtc: request.submittedAtUtc ?? null, plannedEffectiveAtUtc: planned,
      nextStep: copy.nextStep, effectiveNote: copy.effectiveNote,
      canSubmit: false, submitReason: "原申请引用另一份草稿；当前草稿关联未清，不能提交新申请。",
      canOpenDetail: true, approvalActionLabel: "查看原申请",
      sourceNote: "原申请引用的草稿 id/version/hash 与当前草稿不一致。",
      steps: policyChangeSteps(request, change, kind),
    };
  }
  const canSubmit = false;
  return {
    kind, label: copy.label,
    summary: `${copy.label} · ${diffs.length ? `调整${diffs.length}项权益` : diffGap ? "差异未取得" : "未显示权益差异"}`,
    diffs, detailDiffs: diffs, diffGap, request, requestId: request.id, priorRequest: false,
    submittedBy: request.submittedBy ?? null, submittedAtUtc: request.submittedAtUtc ?? null, plannedEffectiveAtUtc: planned,
    nextStep: copy.nextStep, effectiveNote: copy.effectiveNote,
    canSubmit, submitReason: canSubmit ? null : "该申请已有在途/关联记录；当前不能新建同类申请。",
    canOpenDetail: true, approvalActionLabel: kind === "pending" || kind === "approved" || kind === "execution-unknown" ? "到审批中心处理" : "查看原申请",
    sourceNote: localConflict ? "本页仍有另一条原申请责任待核；服务端投影与本地记录同时保留。" : null,
    steps: policyChangeSteps(request, change, kind),
  };
}

export function formatCents(cents: string | undefined): string {
  if (!cents || !/^-?(0|[1-9]\d*)$/.test(cents)) return "待确认";
  const negative = cents.startsWith("-");
  const value = (negative ? cents.slice(1) : cents).padStart(3, "0");
  return `${negative ? "-" : ""}¥${value.slice(0, -2)}.${value.slice(-2)}`;
}

function GrowthSelect({ label, value, onChange, options, className = "", disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; className?: string; disabled?: boolean }) {
  return (
    <label className={`membership-admin-control ${className}`}>
      <span>{label}</span>
      <Select value={value || null} disabled={disabled || !options.length} onValueChange={(next) => onChange(next ?? "")}>
        <SelectTrigger aria-label={label} className="membership-admin-select-trigger">
          <SelectValue placeholder="请选择">{options.find((option) => option.value === value)?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  );
}

function buildPolicyApprovalPolicy(policy: AdminGrowthPolicy, approval: AdminApproval): ApprovalPolicy {
  const isApplied = approval.status === "APPLIED" || policy.status === "APPROVED";
  const isRequested = approval.status === "REQUESTED";
  return {
    name: `会员政策 v${policy.version} 审批流`,
    roots: ["draft"],
    steps: [
      {
        id: "draft",
        kind: "approval",
        label: "政策草稿",
        description: "运营填写统一等级折扣与两类礼遇范围",
        status: "complete",
        statusLabel: "已保存草稿",
        facts: [
          { label: "政策版本", value: `v${policy.version}` },
          { label: "适用范围", value: "全部已启用租赁方式" },
        ],
        approvers: [{ name: "运营", title: "草稿起草" }],
        next: ["boss_review"],
      },
      {
        id: "boss_review",
        kind: "approval",
        label: "Boss 审批",
        description: "由 Boss 审批；维持禁止自审与候选/权限守卫",
        status: isRequested ? "pending" : isApplied ? "complete" : "inactive",
        statusLabel: isRequested ? "待 Boss 审批" : isApplied ? "审批已通过" : "待提交审批",
        facts: [
          { label: "审批单号", value: approval.requestId ?? "尚未生成" },
          { label: "审批要求", value: "Boss 审批；提交人不能审批自己的申请" },
        ],
        approvers: [{ name: "Boss", title: "平台负责人" }],
        next: ["execution"],
      },
      {
        id: "execution",
        kind: "terminal",
        label: "批准待执行",
        description: "审批通过后由运营执行发布，到达计划生效时间正式生效",
        status: isApplied ? "complete" : "inactive",
        statusLabel: isApplied
          ? (policy.effectiveAt && new Date(policy.effectiveAt).getTime() > Date.now() ? "已发布 · 待达到生效时间" : "当前有效")
          : "未执行",
        outcome: "approved",
        facts: [
          { label: "计划生效", value: policy.effectiveAt ? formatDate(policy.effectiveAt) : "发布前确认" },
          { label: "执行状态", value: isApplied ? "已执行发布" : "待批准后执行" },
        ],
        next: [],
      },
    ],
  };
}

export type ProfitSimulationContext = {
  schema: "membership-profit-simulation-context.v1";
  gameId: string;
  ruleReleaseId: string;
  priceVersionId: string;
  termVersionId: string;
  enabledModes: AdminPricingMode[];
  safeBoxes: string[];
  resources: { itemId: string; name: string; unit: string; pricingKind: string }[];
  termOptions: { code: string; dailyConsumption: string }[];
};

export type ProfitSimulationPoint = {
  payableRatio: string;
  payableRentalCents: string;
  discountCents: string;
  ownerIncomeCents: string;
  platformSpreadCents: string;
  ownerFloorSatisfied: boolean;
  spreadRate: { numerator: string; denominator: string } | null;
};

export type ProfitSimulationResult = {
  schema: "membership-profit-simulation.v1";
  baseQuotable: boolean;
  estimateOnly: true;
  calculation: "RENTAL_SPREAD_BEFORE_FEES";
  basis: { gameId: string; ruleReleaseId: string; priceVersionId: string; termVersionId: string };
  baseline: {
    rentalCents: string;
    haffRentalCents: string;
    materialFeesCents: string;
    ownerIncomeCents: string;
    platformSpreadCents: string;
    depositCents: string | null;
    termSeconds: string;
  };
  breakEven: { numerator: string; denominator: string } | null;
  points: ProfitSimulationPoint[];
  disclosure?: string;
  reasonCodes?: string[];
  reasons?: string[];
  excluded?: string[];
};

function formatApiError(err: unknown): string {
  const friendly = friendlyError(err);
  let status: number | undefined;
  let requestId: string | undefined;
  if (err && typeof err === "object") {
    if ("status" in err && typeof (err as any).status === "number") status = (err as any).status;
    if ("requestId" in err && typeof (err as any).requestId === "string") requestId = (err as any).requestId;
  }
  let prefix = "";
  if (status === 400) prefix = "场景或比例参数不合法 (400)：";
  else if (status === 403) prefix = "无权访问试算接口 (403)：需要内部报价与政策操作权限；";
  else if (status === 409) prefix = "规则发布冲突 (409)：价格版本与当前规则发布不匹配；";
  else if (status === 503) prefix = "依据缺失或服务不可用 (503)：";
  else if (status === 404) prefix = "试算端点未找到 (404)：";
  const reqText = requestId ? ` [requestId: ${requestId}]` : "";
  return `${prefix}${friendly || "网络请求失败"}${reqText}`;
}

type SimulationResource = ProfitSimulationContext["resources"][number];
type SimulationLine = { resourceId: string; quantity: string };
type SimulationScenario = { id: string; name: string; lines: SimulationLine[] };
type SimulationDiscount = { id: string; label: string; ratio: string };

function simulationResourceName(resource: SimulationResource): string {
  return resource.name?.trim() || (resource.pricingKind === "HAFF_RATIO" ? "哈夫币" : `物资 #${resource.itemId.slice(-6)}`);
}

function simulationUnit(resource: SimulationResource): string {
  if (resource.pricingKind === "HAFF_RATIO") return "M";
  return resource.unit === "ROUND" ? "发" : resource.unit === "DAY" ? "天" : "件";
}

function ratioTextFromUnits(units: bigint): string {
  const whole = units / 100_000_000n;
  const fraction = (units % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Human discount input ("8折", "8.5折", "原价", or a payable ratio like 0.8) to the API's exact payable ratio. */
export function parseHumanDiscount(value: string): string | null {
  const text = value.trim();
  if (text === "原价" || text === "100%") return "1";
  const payable = parsePayableRatio(text);
  if (payable !== null) return ratioTextFromUnits(payable);
  const match = text.match(/^(\d{1,2})(?:\.(\d{1,4}))?折$/);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const digits = BigInt(match[1]! + fraction);
  const denominator = 10n * 10n ** BigInt(fraction.length);
  const scaled = digits * 100_000_000n;
  if (scaled % denominator !== 0n) return null;
  const units = scaled / denominator;
  return units > 0n && units <= 100_000_000n ? ratioTextFromUnits(units) : null;
}

/** Haff input is expressed in M; convert exact decimal text to the server's raw integer units. */
export function parseHaffMillions(value: string): string | null {
  const text = value.trim().replace(/\s*[Mm]$/, "");
  const match = text.match(/^(\d{1,9})(?:\.(\d{1,6}))?$/);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const raw = BigInt(match[1]!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  return raw > 0n ? raw.toString() : null;
}

function parseItemQuantity(value: string): string | null {
  const text = value.trim();
  return /^[1-9]\d{0,8}$/.test(text) ? text : null;
}

function simulationInventory(context: ProfitSimulationContext, quantities: Record<string, string>) {
  return context.resources
    .filter((resource) => quantities[resource.itemId] !== undefined && /^[1-9]\d*$/.test(quantities[resource.itemId]!))
    .map((resource) => ({ itemId: resource.itemId, quantity: quantities[resource.itemId]! }));
}

function scenarioQuantities(context: ProfitSimulationContext, scenario: SimulationScenario): { quantities: Record<string, string>; error?: string } {
  const quantities: Record<string, string> = {};
  for (const line of scenario.lines) {
    const resource = context.resources.find((entry) => entry.itemId === line.resourceId);
    if (!resource) continue;
    const raw = resource.pricingKind === "HAFF_RATIO" ? parseHaffMillions(line.quantity) : parseItemQuantity(line.quantity);
    if (raw === null) return { quantities, error: `${simulationResourceName(resource)}：请填写大于 0 的${resource.pricingKind === "HAFF_RATIO" ? "M 数量（最多 6 位小数）" : "整数数量"}` };
    quantities[resource.itemId] = raw;
  }
  return { quantities, error: Object.keys(quantities).length ? undefined : "请至少添加一项物资并填写数量" };
}

function scenarioSummary(context: ProfitSimulationContext, scenario: SimulationScenario): string {
  const parts = scenario.lines
    .map((line) => {
      const resource = context.resources.find((entry) => entry.itemId === line.resourceId);
      if (!resource) return "";
      const value = line.quantity.trim() || "待填写";
      return `${simulationResourceName(resource)} ${value}${simulationUnit(resource)}`;
    })
    .filter(Boolean);
  return parts.length ? parts.slice(0, 4).join(" · ") + (parts.length > 4 ? ` · +${parts.length - 4} 项` : "") : "尚未添加物资";
}

function simulationQuoteInput(context: ProfitSimulationContext, quantities: Record<string, string>, options: { mode: AdminPricingMode; safeBoxCode: string; termOptionCode: string; priceVersionId: string }) {
  return {
    priceVersionId: options.priceVersionId,
    termVersionId: context.termVersionId,
    conditions: {
      safeBoxCode: options.safeBoxCode || context.safeBoxes[0] || undefined,
      vitLevel: 6,
      bearLevel: 6,
      termOptionCode: options.termOptionCode || context.termOptions[0]?.code,
      rentalPricing: { rentalMode: options.mode },
    },
    inventory: simulationInventory(context, quantities),
  };
}

function ProfitSimulationModal({
  open,
  onOpenChange,
  ruleReleaseId,
  priceVersionId,
  enabledModes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleReleaseId: string;
  priceVersionId: string;
  enabledModes: AdminPricingMode[];
}) {
  const [loadingContext, setLoadingContext] = useState(false);
  const [context, setContext] = useState<ProfitSimulationContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [scenarioResults, setScenarioResults] = useState<Array<{ id: string; name: string; summary: string; result?: ProfitSimulationResult; error?: string }>>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<SimulationScenario[]>([]);
  const [discounts, setDiscounts] = useState<SimulationDiscount[]>([{ id: "discount-8", label: "8折", ratio: "0.8" }]);
  const [discountDraft, setDiscountDraft] = useState("9折");
  const [discountError, setDiscountError] = useState<string | null>(null);
  const enabledModesKey = enabledModes.join(",");
  const sceneSeqRef = useRef(1);
  const discountSeqRef = useRef(1);
  const runSeqRef = useRef(0);
  const runControllerRef = useRef<AbortController | null>(null);
  const runKeyRef = useRef<string | null>(null);

  const invalidateSimulation = () => {
    runSeqRef.current += 1;
    runControllerRef.current?.abort();
    runControllerRef.current = null;
    runKeyRef.current = null;
    setScenarioResults([]);
    setSimulating(false);
  };

  useEffect(() => () => {
    runSeqRef.current += 1;
    runControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!ruleReleaseId) {
      setContextError("当前未绑定有效的规则发布，无法发起试算。");
      return;
    }
    const controller = new AbortController();
    let active = true;
    invalidateSimulation();
    setLoadingContext(true);
    setContextError(null);
    setInputError(null);
    setDiscountError(null);
    adminRequest<ProfitSimulationContext>(
      `/membership-growth/profit-simulation-context?ruleReleaseId=${encodeURIComponent(ruleReleaseId)}&priceVersionId=${encodeURIComponent(priceVersionId)}`,
      undefined,
      "GET",
      {},
      controller.signal,
    )
      .then((data) => {
        if (!active || controller.signal.aborted) return;
        setContext(data);
        setScenarios([{ id: `scene-${sceneSeqRef.current++}`, name: "场景 1", lines: [] }]);
        setDiscounts([{ id: "discount-8", label: "8折", ratio: "0.8" }]);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setContextError(formatApiError(err));
      })
      .finally(() => {
        if (active) setLoadingContext(false);
      });
    return () => {
      active = false;
      controller.abort();
      invalidateSimulation();
    };
  }, [open, ruleReleaseId, priceVersionId, enabledModesKey]);

  const handleConditionChange = (updater: () => void) => {
    invalidateSimulation();
    setInputError(null);
    updater();
  };

  const addScenario = () => {
    if (scenarios.length >= 4) return;
    handleConditionChange(() => setScenarios((previous) => [...previous, { id: `scene-${sceneSeqRef.current++}`, name: `场景 ${previous.length + 1}`, lines: [] }]));
  };

  const duplicateScenario = (scenario: SimulationScenario) => {
    if (scenarios.length >= 4) return;
    handleConditionChange(() => setScenarios((previous) => [...previous, { id: `scene-${sceneSeqRef.current++}`, name: `场景 ${previous.length + 1}`, lines: scenario.lines.map((line) => ({ ...line })) }]));
  };

  const removeScenario = (id: string) => {
    if (scenarios.length <= 1) return;
    handleConditionChange(() => setScenarios((previous) => previous.filter((scenario) => scenario.id !== id)));
  };

  const addLine = (scenarioId: string, resourceId: string) => {
    const resource = context?.resources.find((entry) => entry.itemId === resourceId);
    if (!resource) return;
    handleConditionChange(() => setScenarios((previous) => previous.map((scenario) => scenario.id === scenarioId && !scenario.lines.some((line) => line.resourceId === resourceId)
      ? { ...scenario, lines: [...scenario.lines, { resourceId, quantity: "" }] }
      : scenario)));
  };

  const updateLine = (scenarioId: string, resourceId: string, quantity: string) => {
    handleConditionChange(() => setScenarios((previous) => previous.map((scenario) => scenario.id === scenarioId
      ? { ...scenario, lines: scenario.lines.map((line) => line.resourceId === resourceId ? { ...line, quantity } : line) }
      : scenario)));
  };

  const removeLine = (scenarioId: string, resourceId: string) => {
    handleConditionChange(() => setScenarios((previous) => previous.map((scenario) => scenario.id === scenarioId
      ? { ...scenario, lines: scenario.lines.filter((line) => line.resourceId !== resourceId) }
      : scenario)));
  };

  const addDiscount = () => {
    const ratio = parseHumanDiscount(discountDraft);
    if (ratio === null) { setDiscountError("请输入类似 8折、8.5折 或原价；不支持负数或指数"); return; }
    if (ratio === "1") { setDiscountError("原价已作为基准列显示，无需重复添加"); return; }
    if (discounts.some((discount) => discount.ratio === ratio)) { setDiscountError("该折扣已添加"); return; }
    if (discounts.length >= 5) { setDiscountError("最多添加 5 个折扣列"); return; }
    handleConditionChange(() => setDiscounts((previous) => [...previous, { id: `discount-${discountSeqRef.current++}`, label: /折$/.test(discountDraft.trim()) ? discountDraft.trim() : formatDiscountLabel(ratio), ratio }]));
    setDiscountDraft("");
    setDiscountError(null);
  };

  const handleSimulate = async () => {
    if (!context) return;
    if (!scenarios.some((scenario) => scenario.lines.some((line) => line.quantity.trim()))) {
      setInputError("请至少在一个场景中添加物资并填写数量");
      return;
    }
    invalidateSimulation();
    const runId = runSeqRef.current;
    const controller = new AbortController();
    runControllerRef.current = controller;
    setInputError(null);
    setSimulating(true);
    const contextSnapshot = context;
    const scenarioSnapshot = scenarios.map((scenario) => ({ ...scenario, lines: scenario.lines.map((line) => ({ ...line })) }));
    const discountSnapshot = discounts.map((discount) => ({ ...discount }));
    const defaultCondition = { mode: enabledModes[0] ?? "ordinary", safeBoxCode: contextSnapshot.safeBoxes[0] ?? "", termOptionCode: contextSnapshot.termOptions[0]?.code ?? "", priceVersionId };
    const ratios = [...new Set(["1", ...discountSnapshot.map((discount) => discount.ratio)])];
    const inputKey = JSON.stringify([ruleReleaseId, priceVersionId, enabledModes, contextSnapshot.termVersionId, contextSnapshot.safeBoxes, contextSnapshot.termOptions, scenarioSnapshot, discountSnapshot]);
    runKeyRef.current = inputKey;
    const current = () => runSeqRef.current === runId && runKeyRef.current === inputKey && !controller.signal.aborted;
    const rows: Array<{ id: string; name: string; summary: string; result?: ProfitSimulationResult; error?: string }> = [];
    try {
      for (const scenario of scenarioSnapshot) {
        if (!current()) return;
        const summary = scenarioSummary(contextSnapshot, scenario);
        const { quantities, error } = scenarioQuantities(contextSnapshot, scenario);
        if (error) {
          rows.push({ id: scenario.id, name: scenario.name, summary, error });
          setScenarioResults([...rows]);
          continue;
        }
        try {
          const result = await adminRequest<ProfitSimulationResult>("/membership-growth/profit-simulation", {
            ruleReleaseId,
            quoteInput: simulationQuoteInput(contextSnapshot, quantities, defaultCondition),
            payableRatios: ratios,
          }, undefined, {}, controller.signal);
          if (!current()) return;
          rows.push({ id: scenario.id, name: scenario.name, summary, result });
        } catch (err: unknown) {
          if (!current()) return;
          rows.push({ id: scenario.id, name: scenario.name, summary, error: formatApiError(err) });
        }
        if (!current()) return;
        setScenarioResults([...rows]);
      }
    } finally {
      if (runSeqRef.current === runId) {
        setSimulating(false);
        runControllerRef.current = null;
      }
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) invalidateSimulation();
    onOpenChange(nextOpen);
  };

  const centsOf = (value: string | undefined | null): bigint | null => {
    if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) return null;
    return BigInt(value);
  };
  const pointFor = (result: ProfitSimulationResult, ratio: string): ProfitSimulationPoint | null => {
    const target = parsePayableRatio(ratio);
    if (target === null || result.baseQuotable === false) return null;
    return result.points?.find((point) => parsePayableRatio(point.payableRatio) === target) ?? null;
  };
  const displayRows = scenarioResults.flatMap((row) => {
    if (row.error || !row.result || row.result.baseQuotable === false) {
      return [{ key: `${row.id}:error`, scene: row.name, summary: row.summary, ratio: "—", renter: null, owner: null, platform: null, originalPlatform: null, reduction: null, reductionTenths: null, floor: null, closed: null, missing: row.error ?? row.result?.reasonCodes?.join("；") ?? "无法报价" }];
    }
    const originalPoint = pointFor(row.result, "1");
    const originalPlatform = originalPoint ? centsOf(originalPoint.platformSpreadCents) : null;
    return [{ id: "original", label: "原价", ratio: "1" }, ...discounts.map((discount) => ({ id: discount.id, label: discount.label, ratio: discount.ratio }))].map((discount) => {
      const point = pointFor(row.result!, discount.ratio);
      const renter = point ? centsOf(point.payableRentalCents) : null;
      const owner = point ? centsOf(point.ownerIncomeCents) : null;
      const platform = point ? centsOf(point.platformSpreadCents) : null;
      const reduction = originalPlatform !== null && platform !== null ? originalPlatform - platform : null;
      const reductionTenths = reduction !== null && originalPlatform !== null && originalPlatform !== 0n ? exactPercentTenths(reduction, originalPlatform) : null;
      const closed = renter !== null && owner !== null && platform !== null ? renter === owner + platform : null;
      return {
        key: `${row.id}:${discount.ratio}`,
        scene: row.name,
        summary: row.summary,
        ratio: formatDiscountLabel(discount.ratio),
        renter,
        owner,
        platform,
        originalPlatform,
        reduction,
        reductionTenths,
        floor: point?.ownerFloorSatisfied ?? null,
        closed,
        missing: point ? "" : "响应缺少该折扣点",
      };
    });
  });
  const amountRows = displayRows.filter((row) => row.renter !== null && row.owner !== null && row.platform !== null);
  const riskyRows = amountRows.filter((row) => row.platform !== null && (row.platform < 0n || row.floor === false));
  const openRows = displayRows.filter((row) => row.missing);
  const discountsWithOriginal = [{ id: "original", label: "原价", ratio: "1" }, ...discounts];
  const basisShort = (value: string) => value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="max-h-[90vh] min-w-0 max-w-[calc(100vw-2rem)] overflow-y-auto p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between border-b pb-4">
          <div className="space-y-1">
            <DialogTitle className="text-lg font-bold flex flex-wrap items-center gap-2">
              <LineChart className="size-5 text-primary" />
              <span>三方试算</span>
              <Badge variant="outline" className="text-xs">纯只读</Badge>
              <Badge variant="secondary" className="text-xs">不建单 / 不预留</Badge>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              自定义少量场景与折扣，对照租客租赁费用、号主应得和平台租赁毛利。押金不计入；平台毛利未扣渠道费、分佣和运营成本。
            </DialogDescription>
          </div>
        </div>

        <div className="min-w-0 space-y-4 text-xs">
          {loadingContext ? (
            <div className="space-y-3 p-4 rounded-xl border border-border">
              <div className="text-xs text-muted-foreground">正在读取试算价目与可用物资…</div>
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          ) : contextError ? (
            <Alert variant="warning" role="status">
              <TriangleAlert aria-hidden />
              <AlertTitle>试算依据暂不可用</AlertTitle>
              <AlertDescription><p>{contextError}</p><p>未读取到价目时不生成结果，不以全 0 或旧结果代替。</p></AlertDescription>
            </Alert>
          ) : context ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
                  <div className="space-y-1">
                    <p className="font-semibold text-foreground">本次试算依据</p>
                    <p className="text-[11px] text-muted-foreground">按打开试算时绑定的封存价目计算；不是实时订单，也不代表当前发布价目。</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-[10px]">只读假设</Badge>
                </div>
                <details className="rounded-lg border border-border/70 bg-background/60 p-2.5">
                  <summary className="cursor-pointer text-[11px] text-muted-foreground">价目与固定报价条件</summary>
                  <dl className="mt-2 grid gap-1.5 text-[11px] text-muted-foreground sm:grid-cols-2">
                    <div><dt className="inline text-foreground">规则发布：</dt><dd className="inline font-mono">{basisShort(context.ruleReleaseId)}</dd></div>
                    <div><dt className="inline text-foreground">价格版本：</dt><dd className="inline font-mono">{basisShort(context.priceVersionId)}</dd></div>
                    <div><dt className="inline text-foreground">租期版本：</dt><dd className="inline font-mono">{basisShort(context.termVersionId)}</dd></div>
                    <div><dt className="inline text-foreground">固定条件：</dt><dd className="inline">{enabledModes[0] ?? "ordinary"} · {context.safeBoxes[0] ?? "未提供"} · {context.termOptions[0]?.code ?? "未提供"}</dd></div>
                  </dl>
                  <p className="mt-2 text-[10px] text-muted-foreground">接口未提供可选租期/保险箱；本页不把它们伪装成可调变量。当前发布价目是否与本次封存价目一致，需服务端后续提供投影。</p>
                </details>
              </div>

              <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                  <span className="font-semibold text-foreground">对照折扣</span>
                  <span className="text-[11px] text-muted-foreground">原价始终保留；可输入 8折、8.5折</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="font-mono">原价</Badge>
                  {discounts.map((discount) => (
                    <span key={discount.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px]">
                      {discount.label}
                      <button type="button" aria-label={`移除折扣 ${discount.label}`} className="rounded-full text-muted-foreground hover:text-foreground" onClick={() => handleConditionChange(() => setDiscounts((previous) => previous.filter((entry) => entry.id !== discount.id)))}>
                        <X className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <label htmlFor="simulation-discount" className="text-[11px] font-medium text-muted-foreground">添加折扣</label>
                    <div className="flex items-center gap-2">
                      <Input id="simulation-discount" aria-label="添加折扣" value={discountDraft} onChange={(event) => { setDiscountDraft(event.target.value); setDiscountError(null); }} placeholder="如 8折" className="h-9 max-w-40 bg-background text-xs" />
                      <Button type="button" size="sm" variant="outline" className="h-9" onClick={addDiscount}><Plus className="size-3.5 mr-1" aria-hidden />添加</Button>
                    </div>
                  </div>
                  <p className="basis-full text-[11px] text-muted-foreground">输入人类折扣标尺，提交前转换为服务端精确应付比例。</p>
                </div>
                {discountError ? <p className="text-xs text-destructive" role="alert">{discountError}</p> : null}
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">试算场景</span>
                  <Button type="button" size="sm" variant="outline" disabled={scenarios.length >= 4} onClick={addScenario}><Plus className="size-3.5 mr-1" aria-hidden />新增场景</Button>
                </div>
                {scenarios.map((scenario, index) => {
                  const available = context.resources.filter((resource) => !scenario.lines.some((line) => line.resourceId === resource.itemId));
                  return (
                    <div key={scenario.id} className="rounded-xl border border-border bg-card/60 p-3.5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge variant="outline" className="shrink-0 text-[10px]">场景 {index + 1}</Badge>
                          <Input aria-label={`场景 ${index + 1} 名称`} value={scenario.name} onChange={(event) => handleConditionChange(() => setScenarios((previous) => previous.map((entry) => entry.id === scenario.id ? { ...entry, name: event.target.value } : entry)))} className="h-8 min-w-0 max-w-48 bg-background text-xs" />
                        </div>
                        <div className="flex items-center gap-1">
                          <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-[11px]" disabled={scenarios.length >= 4} onClick={() => duplicateScenario(scenario)}><Copy className="size-3 mr-1" aria-hidden />复制</Button>
                          <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-[11px] text-destructive" disabled={scenarios.length <= 1} onClick={() => removeScenario(scenario.id)}><Trash2 className="size-3 mr-1" aria-hidden />删除</Button>
                        </div>
                      </div>
                      {scenario.lines.length ? (
                        <div className="space-y-2">
                          {scenario.lines.map((line) => {
                            const resource = context.resources.find((entry) => entry.itemId === line.resourceId);
                            if (!resource) return null;
                            const unit = simulationUnit(resource);
                            const label = simulationResourceName(resource);
                            return (
                              <div key={line.resourceId} className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg border border-border/70 bg-background p-2.5">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs font-medium text-foreground" title={label}>{label}</div>
                                  <div className="text-[10px] text-muted-foreground">{resource.pricingKind === "HAFF_RATIO" ? "按 M 填写，自动换算原始哈夫币数量" : `按${unit}填写整数数量`}</div>
                                </div>
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <Input aria-label={`${scenario.name} ${label} 数量（${unit}）`} inputMode={resource.pricingKind === "HAFF_RATIO" ? "decimal" : "numeric"} value={line.quantity} onChange={(event) => updateLine(scenario.id, line.resourceId, event.target.value)} placeholder={resource.pricingKind === "HAFF_RATIO" ? "如 60" : "如 1"} className="h-8 w-28 bg-card text-right font-mono text-xs" />
                                  <span className="w-6 text-[11px] text-muted-foreground">{unit}</span>
                                </div>
                                <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-[11px]" aria-label={`移除 ${scenario.name} 的 ${label}`} onClick={() => removeLine(scenario.id, line.resourceId)}><X className="size-3" aria-hidden /></Button>
                              </div>
                            );
                          })}
                        </div>
                      ) : <p className="rounded-lg border border-dashed border-border/70 p-3 text-[11px] text-muted-foreground">尚未添加物资；未选择物资不参与本场景。</p>}
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value="" onValueChange={(value) => value && addLine(scenario.id, value)}>
                          <SelectTrigger aria-label={`${scenario.name} 添加物资`} className="h-8 w-full max-w-60 bg-background text-xs"><SelectValue placeholder="添加物资" /></SelectTrigger>
                          <SelectContent>
                            {available.map((resource) => <SelectItem key={resource.itemId} value={resource.itemId}>{simulationResourceName(resource)}（{simulationUnit(resource)}）</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {available.length === 0 ? <span className="text-[11px] text-muted-foreground">可用物资已全部加入</span> : null}
                      </div>
                    </div>
                  );
                })}
                {inputError ? <p className="text-xs text-destructive" role="alert">{inputError}</p> : null}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <p className="text-[11px] text-muted-foreground">每个场景只发一次报价；折扣一次提交，原价作为基准。少量场景串行执行。</p>
                  <Button type="button" className="h-9 px-4" onClick={() => void handleSimulate()} disabled={simulating || !context.resources.length}>{simulating ? "正在试算…" : "开始试算"}</Button>
                </div>
              </div>

              {displayRows.length ? (
                <div className="space-y-3">
                  <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-foreground">{scenarios.length} 个场景 × {discountsWithOriginal.length} 个折扣</p>
                      <Badge variant={riskyRows.length || openRows.length ? "warning" : "success"}>{riskyRows.length ? `${riskyRows.length} 行需注意` : openRows.length ? `${openRows.length} 行待核` : "保底均满足"}</Badge>
                    </div>
                    <p className="text-muted-foreground">三列金额均来自同一次判价响应；租客租赁费用 = 号主应得 + 平台租赁毛利（逐行核对）。{openRows.length ? ` ${openRows.length} 行缺少所需折扣点，未补 0。` : ""}</p>
                  </div>
                  <div className="min-w-0 w-full overflow-x-auto rounded-lg border">
                    <Table className="min-w-[900px] text-xs">
                      <TableHeader>
                        <TableRow>
                          <TableHead>场景 / 物资</TableHead>
                          <TableHead>折扣</TableHead>
                          <TableHead className="text-right">租客租赁费用</TableHead>
                          <TableHead className="text-right">号主应得</TableHead>
                          <TableHead className="text-right">平台租赁毛利</TableHead>
                          <TableHead className="text-right">毛利较原价</TableHead>
                          <TableHead>号主保底</TableHead>
                          <TableHead>金额核对</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {displayRows.map((row) => {
                          const risky = row.platform !== null && (row.platform < 0n || row.floor === false);
                          return (
                            <TableRow key={row.key} className={risky ? "bg-destructive/5" : undefined}>
                              <TableCell>
                                <div className="font-medium text-foreground">{row.scene}</div>
                                <div className="mt-0.5 max-w-72 text-[10px] text-muted-foreground">{row.summary}</div>
                              </TableCell>
                              <TableCell className="font-mono">{row.ratio}</TableCell>
                              <TableCell className="text-right font-mono tabular-nums">{row.renter !== null ? formatCents(row.renter.toString()) : "待核"}</TableCell>
                              <TableCell className="text-right font-mono tabular-nums">{row.owner !== null ? formatCents(row.owner.toString()) : "待核"}</TableCell>
                              <TableCell className={`text-right font-mono tabular-nums ${risky ? "font-semibold text-destructive" : ""}`}>{row.platform !== null ? formatCents(row.platform.toString()) : "待核"}</TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {row.ratio === "原价" ? "—" : row.reduction !== null ? `${row.reduction >= 0n ? "-" : "+"}${formatCents((row.reduction < 0n ? -row.reduction : row.reduction).toString())}${row.reductionTenths !== null ? `（${row.reductionTenths >= 0n ? "-" : "+"}${formatTenthsPercent(row.reductionTenths < 0n ? -row.reductionTenths : row.reductionTenths)}）` : ""}` : "待核"}
                              </TableCell>
                              <TableCell>
                                {row.floor === null ? <span className="text-[11px] text-muted-foreground">待核</span> : row.floor ? <Badge variant="outline" className="border-emerald-300 text-emerald-600">满足</Badge> : <Badge variant="destructive">低于底线</Badge>}
                              </TableCell>
                              <TableCell className="text-[11px]">
                                {row.missing ? <span className="text-destructive">{row.missing}</span> : row.closed === null ? <span className="text-muted-foreground">待核</span> : row.closed ? <span className="text-emerald-600 dark:text-emerald-400">闭合</span> : <span className="text-destructive">差额 {formatCents((row.renter! - row.owner! - row.platform!).toString())}</span>}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-[11px] text-muted-foreground">租客租赁费用、号主应得、平台租赁毛利是本次封存价目的 what-if 合计，不是实际订单、结算利润或号主净利润；押金不计入。负毛利只表示试算结果，不能用于实际核价。</p>
                </div>
              ) : simulating ? (
                <p className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground" role="status">正在按场景逐一试算，结果会随完成情况更新…</p>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  添加场景与物资、填写数量和折扣后点击「开始试算」。原价会作为基准与每个折扣同表对照。
                </div>
              )}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "已复制" : "复制单号"}
    </Button>
  );
}

function stateMessage(state: Exclude<MembershipGrowthAdminState, { status: "ready" }>, refresh?: () => void, requestId?: string | null, open?: (path: string, title?: string) => void) {
  const loading = state.status === "loading", denied = state.status === "permission";
  const title = loading ? "正在读取会员政策" : denied ? "没有会员政策查看权限" : "会员政策暂不可用";
  return <section className="membership-admin-view" data-state={state.status}>
    <Alert variant={loading ? "default" : denied ? "warning" : "destructive"} role={loading || denied ? "status" : "alert"}>
      {loading ? <RefreshCw aria-hidden className="animate-spin" /> : <TriangleAlert aria-hidden />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{loading ? "请稍候。" : denied ? "请联系有权限的管理员。" : state.message}</AlertDescription>
      <AlertAction>
        {!loading && refresh ? <Button size="sm" variant="outline" onClick={refresh}>刷新状态</Button> : null}
        {requestId && open ? <Button size="sm" variant="ghost" onClick={() => open(`/approvals/${encodeURIComponent(requestId)}?from=membership-growth&fromTab=policy`, "审批详情")}>查看原申请</Button> : null}
      </AlertAction>
    </Alert>
    {loading ? <div className="space-y-3" aria-hidden><Skeleton className="h-8 w-full" /><Skeleton className="h-36 w-full" /></div> : null}
  </section>;
}

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
    pending: "申请已提交，等待审批。", approved: "审批已通过，执行发布后才会生效。",
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
                租金价差试算
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
                <summary className="cursor-pointer text-[11px]">接口说明</summary>
                <p className="mt-2 text-[11px] leading-relaxed">审批历史、经手人与时间线字段待接口接入（API_DEPENDENCY_PENDING）。本页不补造审批人或结果；当前只展示本页本次提交的申请号与审批中心入口。</p>
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
        <ProfitSimulationModal key={`${binding?.ruleReleaseId ?? ""}:${binding?.priceVersionId ?? ""}`} open={isSimulateOpen} onOpenChange={setIsSimulateOpen} ruleReleaseId={binding?.ruleReleaseId ?? ""} priceVersionId={binding?.priceVersionId ?? ""} enabledModes={policy.catalog.enabledModes ?? []} />
      ) : null}
    </div>
  );
}
