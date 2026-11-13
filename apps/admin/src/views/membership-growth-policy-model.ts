import { formatDate } from "../api";
import { formatDepositBenefitText, formatDiscountLabel, formatDiscountRangeLabel, parsePayableRatio, parseYuanToCents } from "./membership-entitlement-form";
import type { AdminEntitlementKind, AdminGrowthCapability, UnifiedDraft, UnifiedPricingInput, UnifiedPricingProjection, UnifiedRangeProjection, UnifiedTierProjection } from "./membership-unified-contract";
import { UNIFIED_PRICING_SCHEMA, UNIFIED_PRICING_SCOPE, unifiedReasonText } from "./membership-unified-contract";
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

export const TIER_LABELS: Record<AdminGrowthTier, string> = { STANDARD: "普通", SILVER: "银卡", GOLD: "金卡", PLATINUM: "铂金", DIAMOND: "钻石" };
export const TIER_ORDER: AdminGrowthTier[] = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"];
export const KIND_LABELS = { FRIEND: "挚友礼遇", PRESTIGE: "尊享礼遇" } as const;

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

export function formatPointValue(value: string | undefined): string {
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

export function formatPolicyChangeValue(value: string | null | undefined, format: AdminPolicyChangeDiff["format"]): string {
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
  pending: { label: "待 Boss 审批", nextStep: "下一步：由 Boss 在审批中心处理；当前审批不是多人逐级必签。", effectiveNote: "批准并执行后才生效；计划时间不构成按时生效保证。" },
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
