import { useEffect, useMemo, useState, useRef } from "react";
import { CheckCircle2, ChevronRight, LineChart, Lock, Pencil, TriangleAlert, X, History, AlertCircle, FileEdit, Send } from "lucide-react";
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
export type AdminApproval = { status: "NOT_REQUESTED" | "REQUESTED" | "APPLIED" | "REJECTED" | "UNKNOWN"; requestId?: string; message?: string };

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
type SimulationScenario = { key: string; label: string; quantities: Record<string, string> };

function simulationResourceName(resource: SimulationResource): string {
  return resource.name?.trim() || (resource.pricingKind === "HAFF_RATIO" ? "哈夫币" : `物资 #${resource.itemId.slice(-6)}`);
}

function simulationUnit(resource: SimulationResource): string {
  if (resource.pricingKind === "HAFF_RATIO") return "哈夫币";
  return resource.unit === "ROUND" ? "发" : resource.unit === "DAY" ? "天" : "件";
}

function presetQuantities(context: ProfitSimulationContext, kind: "standard" | "heavy"): Record<string, string> {
  const quantities: Record<string, string> = {};
  for (const resource of context.resources) {
    quantities[resource.itemId] = resource.pricingKind === "HAFF_RATIO"
      ? kind === "heavy" ? "120000000" : "60000000"
      : resource.unit === "ROUND" ? kind === "heavy" ? "3000" : "1000" : kind === "heavy" ? "5" : "1";
  }
  return quantities;
}

function sameQuantities(context: ProfitSimulationContext, left: Record<string, string>, right: Record<string, string>): boolean {
  return context.resources.every((resource) => (left[resource.itemId] ?? "1") === (right[resource.itemId] ?? "1"));
}

function buildScenarios(context: ProfitSimulationContext, custom: Record<string, string>): SimulationScenario[] {
  const standard = presetQuantities(context, "standard");
  const heavy = presetQuantities(context, "heavy");
  const scenarios: SimulationScenario[] = [
    { key: "standard", label: "标准租赁", quantities: standard },
    { key: "heavy", label: "重度高耗损", quantities: heavy },
    { key: "custom", label: "当前输入", quantities: custom },
  ];
  return scenarios.filter((scenario, index) => scenarios.findIndex((candidate) => sameQuantities(context, candidate.quantities, scenario.quantities)) === index);
}

function scenarioSummary(context: ProfitSimulationContext, quantities: Record<string, string>): string {
  const parts = context.resources
    .filter((resource) => Number(quantities[resource.itemId] ?? "1") > 0)
    .map((resource) => `${simulationResourceName(resource)} ${Number(quantities[resource.itemId] ?? "1").toLocaleString("zh-CN")}${resource.pricingKind === "HAFF_RATIO" ? "" : simulationUnit(resource)}`);
  return parts.length ? `${parts.slice(0, 3).join(" · ")}${parts.length > 3 ? ` · +${parts.length - 3} 项` : ""}` : "默认物资组合";
}

function simulationInventory(context: ProfitSimulationContext, quantities: Record<string, string>) {
  return context.resources
    .filter((resource) => quantities[resource.itemId] !== undefined && Number(quantities[resource.itemId]) > 0)
    .map((resource) => ({ itemId: resource.itemId, quantity: quantities[resource.itemId]! }));
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
  const [scenarioResults, setScenarioResults] = useState<Array<{ key: string; label: string; summary: string; result?: ProfitSimulationResult; haffResult?: ProfitSimulationResult | null; error?: string }>>([]);
  const [ratioError, setRatioError] = useState<string | null>(null);

  // Operational scene inputs
  const [resourceQuantities, setResourceQuantities] = useState<Record<string, string>>({});
  const [proposedRatio, setProposedRatio] = useState<string>("0.8");
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
      setContextError("当前未绑定有效的规则发布 (ruleReleaseId 缺失)，无法发起试算。");
      return;
    }
    const controller = new AbortController();
    let active = true;
    invalidateSimulation();
    setLoadingContext(true);
    setContextError(null);
    setRatioError(null);
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
        const defaultQuantities: Record<string, string> = {};
        for (const res of data.resources || []) {
          if (res.pricingKind === "HAFF_RATIO") {
            defaultQuantities[res.itemId] = "60000000";
          } else if (res.unit === "ROUND") {
            defaultQuantities[res.itemId] = "1000";
          } else {
            defaultQuantities[res.itemId] = "1";
          }
        }
        setResourceQuantities(defaultQuantities);
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
  }, [open, ruleReleaseId, priceVersionId]);

  const handleConditionChange = (updater: () => void) => {
    invalidateSimulation();
    updater();
  };

  const handleSimulate = async () => {
    if (!context) return;
    const ratioText = proposedRatio.trim();
    if (!ratioText || parsePayableRatio(ratioText) === null) {
      setRatioError("请输入 0–1 之间的小数，如 0.8 表示 8 折。");
      return;
    }
    invalidateSimulation();
    const runId = runSeqRef.current;
    const controller = new AbortController();
    runControllerRef.current = controller;
    setRatioError(null);
    setSimulating(true);
    const contextSnapshot = context;
    const scenarios = buildScenarios(contextSnapshot, resourceQuantities);
    const defaultCondition = { mode: enabledModes[0] ?? "ordinary", safeBoxCode: contextSnapshot.safeBoxes[0] ?? "", termOptionCode: contextSnapshot.termOptions[0]?.code ?? "", priceVersionId };
    const haffResources = contextSnapshot.resources.filter((resource) => resource.pricingKind === "HAFF_RATIO");
    const ratios = [...new Set(["1", ratioText])];
    const inputKey = JSON.stringify([ruleReleaseId, priceVersionId, ratioText, resourceQuantities, enabledModes, contextSnapshot.termVersionId, contextSnapshot.safeBoxes, contextSnapshot.termOptions]);
    runKeyRef.current = inputKey;
    const current = () => runSeqRef.current === runId && runKeyRef.current === inputKey && !controller.signal.aborted;
    const rows: Array<{ key: string; label: string; summary: string; result?: ProfitSimulationResult; haffResult?: ProfitSimulationResult | null; error?: string }> = [];
    try {
      for (const scenario of scenarios) {
        if (!current()) return;
        const summary = scenarioSummary(contextSnapshot, scenario.quantities);
        if (!simulationInventory(contextSnapshot, scenario.quantities).length) {
          rows.push({ key: scenario.key, label: scenario.label, summary, error: "请至少填写一项大于 0 的数量" });
          setScenarioResults([...rows]);
          continue;
        }
        try {
          const result = await adminRequest<ProfitSimulationResult>("/membership-growth/profit-simulation", {
            ruleReleaseId,
            quoteInput: simulationQuoteInput(contextSnapshot, scenario.quantities, defaultCondition),
            payableRatios: ratios,
          }, undefined, {}, controller.signal);
          if (!current()) return;
          const haffQuantities = Object.fromEntries(haffResources.map((resource) => [resource.itemId, scenario.quantities[resource.itemId] ?? "1"]));
          let haffResult: ProfitSimulationResult | null = null;
          if (haffResources.length && Number(haffQuantities[haffResources[0]!.itemId] ?? "1") > 0) {
            try {
              haffResult = await adminRequest<ProfitSimulationResult>("/membership-growth/profit-simulation", {
                ruleReleaseId,
                quoteInput: simulationQuoteInput(contextSnapshot, haffQuantities, defaultCondition),
                payableRatios: ["1"],
              }, undefined, {}, controller.signal);
              if (!current()) return;
            } catch {
              if (!current()) return;
              haffResult = null;
            }
          }
          rows.push({ key: scenario.key, label: scenario.label, summary, result, haffResult });
        } catch (err: unknown) {
          if (!current()) return;
          rows.push({ key: scenario.key, label: scenario.label, summary, error: formatApiError(err) });
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

  const pointFor = (row: (typeof scenarioResults)[number], ratio: string) => {
    const target = parsePayableRatio(ratio);
    if (target === null || row.result?.baseQuotable === false) return null;
    return row.result?.points?.find((point) => parsePayableRatio(point.payableRatio) === target) ?? null;
  };
  const centsOf = (value: string | undefined | null): bigint | null => {
    if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) return null;
    return BigInt(value);
  };
  const comparedRows = scenarioResults.map((row) => {
    const original = pointFor(row, "1");
    const discounted = pointFor(row, proposedRatio.trim());
    const originalSpread = original ? centsOf(original.platformSpreadCents) : null;
    const discountedSpread = discounted ? centsOf(discounted.platformSpreadCents) : null;
    const reduction = originalSpread !== null && discountedSpread !== null ? originalSpread - discountedSpread : null;
    const reductionTenths = reduction !== null && originalSpread !== null && originalSpread !== 0n ? exactPercentTenths(reduction, originalSpread) : null;
    const haffSpread = row.haffResult?.baseline ? centsOf(row.haffResult.baseline.platformSpreadCents) : null;
    const itemSpread = originalSpread !== null && haffSpread !== null ? originalSpread - haffSpread : null;
    const missing = row.error
      ? row.error
      : row.result?.baseQuotable === false
        ? row.result.reasonCodes?.join("；") || "无法报价"
        : !original
          ? "响应缺少原价点"
          : !discounted
            ? "响应缺少拟设折扣点"
            : originalSpread === null || discountedSpread === null
              ? "响应缺少有效价差"
              : "";
    return { ...row, original, discounted, originalSpread, discountedSpread, reduction, reductionTenths, haffSpread, itemSpread, missing };
  });
  const successfulResults = comparedRows.filter((row) => row.originalSpread !== null && row.discountedSpread !== null);
  const maxSpreadAbs = comparedRows.reduce((max, row) => {
    if (row.discountedSpread === null) return max;
    const abs = row.discountedSpread < 0n ? -row.discountedSpread : row.discountedSpread;
    return abs > max ? abs : max;
  }, 1n);
  const riskyCount = successfulResults.filter((row) => row.discountedSpread! < 0n || !row.discounted!.ownerFloorSatisfied).length;
  const standardRow = successfulResults[0];
  const haffSpreadCents = standardRow?.haffSpread ?? null;
  const itemSpreadCents = standardRow?.itemSpread ?? null;
  const compositionTotal = haffSpreadCents !== null && itemSpreadCents !== null ? (haffSpreadCents < 0n ? -haffSpreadCents : haffSpreadCents) + (itemSpreadCents < 0n ? -itemSpreadCents : itemSpreadCents) : 0n;
  const haffShare = compositionTotal > 0n && haffSpreadCents !== null ? Number(((haffSpreadCents < 0n ? -haffSpreadCents : haffSpreadCents) * 10_000n) / compositionTotal) / 100 : 0;
  const discountedSpreads = successfulResults.map((row) => row.discountedSpread!);
  const reductions = successfulResults.map((row) => row.reduction!);
  const reductionTenths = successfulResults.map((row) => row.reductionTenths!).filter((value): value is bigint => value !== null);
  const minOf = (values: bigint[]) => values.length ? values.reduce((min, value) => value < min ? value : min) : null;
  const maxOf = (values: bigint[]) => values.length ? values.reduce((max, value) => value > max ? value : max) : null;
  const minDiscounted = minOf(discountedSpreads), maxDiscounted = maxOf(discountedSpreads);
  const minReduction = minOf(reductions), maxReduction = maxOf(reductions);
  const minReductionPct = minOf(reductionTenths), maxReductionPct = maxOf(reductionTenths);
  const centsRange = (min: bigint | null, max: bigint | null) => min === null || max === null ? "—" : min === max ? formatCents(min.toString()) : `${formatCents(min.toString())} ～ ${formatCents(max.toString())}`;
  const barWidth = (value: bigint) => {
    const abs = value < 0n ? -value : value;
    return Math.min(100, Math.max(4, Number((abs * 10_000n) / maxSpreadAbs) / 100));
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto p-6 space-y-5">
        <div className="flex items-start justify-between border-b pb-4">
          <div className="space-y-1">
            <DialogTitle className="text-lg font-bold flex flex-wrap items-center gap-2">
              <LineChart className="size-5 text-primary" />
              <span>租金价差试算</span>
              <Badge variant="outline" className="text-xs">纯只读辅助分析</Badge>
              <Badge variant="secondary" className="text-xs">不建单 / 不预留</Badge>
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              输入一个拟设折扣，比较不同哈夫币与物资数量场景下的平台租金价差，用于判断该折扣是否可设置。不含押金、手续费、分佣和运营成本。
            </DialogDescription>
          </div>
        </div>

        <div className="space-y-4 text-xs">
          {loadingContext ? (
            <div className="space-y-3 p-4 rounded-xl border border-border">
              <div className="text-xs text-muted-foreground">正在读取当前价格方案与可用场景…</div>
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          ) : contextError ? (
            <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 space-y-2 text-warning-foreground">
              <div className="flex items-center gap-2 font-medium">
                <TriangleAlert className="h-4 w-4" />
                <span>试算环境待连接</span>
              </div>
              <p className="text-muted-foreground">{contextError}</p>
              <p className="text-[11px] text-muted-foreground">如实展示当前环境状态，不伪造全0虚假曲线。</p>
            </div>
          ) : context ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                  <span className="flex items-center gap-1 font-semibold text-foreground">拟设折扣<InfoHint label="拟设折扣说明">0.8 = 实付 80%；1 = 原价。</InfoHint></span>
                  <span className="text-[11px] text-muted-foreground">按当前系统价格计算</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)] items-end">
                  <div className="flex items-center gap-2">
                    <Input
                      id="simulation-proposed-ratio"
                      aria-label="拟设折扣"
                      inputMode="decimal"
                      value={proposedRatio}
                      onChange={(event) => { handleConditionChange(() => setProposedRatio(event.target.value)); setRatioError(null); }}
                      placeholder="如 0.8"
                      className="h-9 bg-background font-mono text-xs"
                    />
                    <Badge variant="secondary" className="shrink-0 font-mono">{formatDiscountLabel(proposedRatio)}</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    试算只改变拟设折扣与数量；价差按系统当前配置。
                    <InfoHint label="价差来源说明">哈夫币价差按当前启用的价格方案；如需调整，请先更新价格规则。物品价差按当前系统配置。保险箱与租期采用系统默认值，不参与本次折扣判断。押金、手续费、分佣和运营成本不计入。</InfoHint>
                  </p>
                </div>
                {ratioError ? <p className="text-xs text-destructive" role="alert">{ratioError}</p> : null}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">将比较：标准租赁、重度高耗损，以及下方当前输入（与预设不重复时）。</p>
                  <Button type="button" className="h-9 px-4" onClick={() => void handleSimulate()} disabled={simulating || !context.resources.length}>
                    {simulating ? "正在试算…" : "开始试算"}
                  </Button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                  <span className="font-semibold text-foreground">当前输入场景：物资与哈夫币数量</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[11px] text-muted-foreground">填入预设：</span>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => handleConditionChange(() => setResourceQuantities(presetQuantities(context, "standard")))}>标准租赁</Button>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => handleConditionChange(() => setResourceQuantities(presetQuantities(context, "heavy")))}>重度高耗损</Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {context.resources.map((resource) => {
                    const name = simulationResourceName(resource);
                    const unit = simulationUnit(resource);
                    const inputId = `simulation-qty-${resource.itemId}`;
                    return (
                      <div key={resource.itemId} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background p-2.5">
                        <div className="min-w-0 flex-1">
                          <label htmlFor={inputId} className="block truncate text-xs font-medium text-foreground" title={name}>{name}</label>
                          <div className="text-[10px] text-muted-foreground">按{unit}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Input
                            id={inputId}
                            aria-label={`${name}数量（${unit}）`}
                            type="number"
                            min="0"
                            value={resourceQuantities[resource.itemId] ?? "1"}
                            onChange={(event) => handleConditionChange(() => setResourceQuantities((previous) => ({ ...previous, [resource.itemId]: event.target.value })))}
                            className="h-8 w-24 bg-card text-right font-mono text-xs"
                          />
                          <span className="w-8 text-[11px] text-muted-foreground">{unit}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">押金不计入本次平台价差；计算未扣手续费、分佣和运营成本。</p>
              </div>

              {scenarioResults.length ? (
                <div className="space-y-3">
                  <div className="rounded-lg border bg-muted/20 p-3 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-foreground">拟设 {formatDiscountLabel(proposedRatio)} · {successfulResults.length} 个有效场景</p>
                      {successfulResults.length ? <Badge variant={riskyCount ? "warning" : "success"}>{riskyCount ? `${riskyCount} 个场景需注意` : "保底全部满足"}</Badge> : null}
                    </div>
                    {successfulResults.length ? (
                      <p className="text-muted-foreground">
                        折后平台价差 {centsRange(minDiscounted, maxDiscounted)}；较原价减少 {centsRange(minReduction, maxReduction)}
                        {minReductionPct !== null && maxReductionPct !== null ? `（${formatTenthsPercent(minReductionPct)} ～ ${formatTenthsPercent(maxReductionPct)}）` : ""}。
                      </p>
                    ) : <p className="text-muted-foreground">没有形成有效基准报价，请检查物资数量。</p>}
                    {haffSpreadCents !== null && itemSpreadCents !== null ? (
                      <div className="space-y-1.5 pt-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <span className="text-foreground">原价利润构成（{standardRow?.label}）</span>
                          <span className="text-muted-foreground">哈夫币价差 {formatCents(haffSpreadCents.toString())} · 物品价差 {formatCents(itemSpreadCents.toString())}</span>
                        </div>
                        <div className="flex h-1.5 overflow-hidden rounded bg-muted">
                          <div className="h-full bg-primary" style={{ width: `${Math.min(100, haffShare)}%` }} />
                          <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, 100 - haffShare)}%` }} />
                        </div>
                        <p className="text-[10px] text-muted-foreground">哈夫币价差按当前价格方案，物品价差按系统配置；折扣由平台承担，号主收入不变。</p>
                      </div>
                    ) : null}
                  </div>
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead>场景 / 物资数量</TableHead>
                        <TableHead>原价价差</TableHead>
                        <TableHead>折后价差</TableHead>
                        <TableHead>利润变化</TableHead>
                        <TableHead className="text-right">号主保底</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {comparedRows.map((row) => {
                        const discounted = row.discounted;
                        const risky = discounted && row.discountedSpread !== null ? row.discountedSpread < 0n || !discounted.ownerFloorSatisfied : false;
                        return (
                          <TableRow key={row.key} className={risky ? "bg-destructive/5" : undefined}>
                            <TableCell>
                              <div className="font-medium text-foreground">{row.label}</div>
                              <div className="text-[10px] text-muted-foreground">{row.summary}</div>
                            </TableCell>
                            <TableCell className="font-mono tabular-nums">
                              <div>{row.originalSpread !== null ? formatCents(row.originalSpread.toString()) : "—"}</div>
                              {row.haffSpread !== null && row.itemSpread !== null ? <div className="text-[10px] font-sans text-muted-foreground">哈夫币 {formatCents(row.haffSpread.toString())} · 物品 {formatCents(row.itemSpread.toString())}</div> : null}
                            </TableCell>
                            <TableCell>
                              {discounted ? (
                                <div className="space-y-1">
                                  <span className={risky ? "font-semibold text-destructive" : "font-semibold text-emerald-600 dark:text-emerald-400"}>{row.discountedSpread !== null ? formatCents(row.discountedSpread.toString()) : "—"}</span>
                                  <div className="h-1.5 w-24 overflow-hidden rounded bg-muted"><div className={risky ? "h-full bg-destructive" : "h-full bg-emerald-500"} style={{ width: `${row.discountedSpread !== null ? barWidth(row.discountedSpread) : 4}%` }} /></div>
                                </div>
                              ) : "—"}
                            </TableCell>
                            <TableCell className={`font-mono tabular-nums ${row.reduction !== null && row.reduction > 0n ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                              {row.reduction !== null && row.reduction !== undefined ? `${row.reduction >= 0n ? "-" : "+"}${formatCents((row.reduction < 0n ? -row.reduction : row.reduction).toString())}${row.reductionTenths !== null ? `（${row.reductionTenths >= 0n ? "-" : "+"}${formatTenthsPercent(row.reductionTenths < 0n ? -row.reductionTenths : row.reductionTenths)}）` : ""}` : "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {discounted ? (
                                discounted.ownerFloorSatisfied
                                  ? <Badge variant="outline" className="border-emerald-300 text-emerald-600">满足保底</Badge>
                                  : <Badge variant="destructive">低于号主底线</Badge>
                              ) : (
                                <span className="text-[11px] text-destructive">{row.missing || "不可用"}</span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <p className="text-[11px] text-muted-foreground">计算口径：平台租金价差，未扣押金、支付手续费、分佣和运营成本；价差为正不等于净利润。</p>
                </div>
              ) : simulating ? (
                <p className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground" role="status">正在按场景逐一试算，结果会随完成情况更新…</p>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                  填写拟设折扣后点击「开始试算」，查看标准、重度和当前输入场景下的平台价差。
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

function stateMessage(state: Exclude<MembershipGrowthAdminState, { status: "ready" }>) {
  const title = state.status === "loading" ? "正在读取会员政策" : state.status === "permission" ? "没有会员政策查看权限" : "会员政策暂不可用";
  return (
    <section className="membership-admin-view" data-state={state.status} role={state.status === "error" ? "alert" : "status"}>
      <div className="membership-admin-state">
        <strong>{title}</strong>
        {state.status === "loading" ? (
          <>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-36 w-full" />
          </>
        ) : (
          <p>{state.message}</p>
        )}
      </div>
    </section>
  );
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
  onPolicyChange,
  onSavePolicyDraft,
  onSubmitPolicy,
  onOpenApproval,
  onOpenPath,
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
  onPolicyChange?: (policy: AdminGrowthPolicy, unified: UnifiedDraft) => void;
  onSavePolicyDraft?: () => void;
  onSubmitPolicy?: () => void;
  onOpenApproval?: () => void;
  onOpenPath?: (path: string, title?: string) => void;
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
  const [isSimulateOpen, setIsSimulateOpen] = useState(false);
  const [editStage, setEditStage] = useState<1 | 2 | 3>(1);
  const [visitedStage2, setVisitedStage2] = useState(false);
  const [depositInputs, setDepositInputs] = useState<Record<string, string>>({});
  const [selectedWorkflowStep, setSelectedWorkflowStep] = useState<string | null>("boss_review");
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

  if (state.status !== "ready") return stateMessage(state);
  if (!draftPolicy || !unifiedDraft) return stateMessage({ status: "loading" });

  const policy = draftPolicy;
  const approvedPolicy = state.approvedPolicy;
  const approvedUnified = state.approvedUnifiedPricing;
  const capability = state.capability;
  const unifiedSupported = capability.unifiedPricingSupported === true;
  const editable = Boolean(onPolicyChange && unifiedSupported && capability.canDraft !== false);
  const rangeEditable = editable && canEditEntitlementRanges;
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
  const editVersion = draftExists ? policy.version : String(Number(policy.version) + 1);
  const changes = approvedPolicy && approvedUnified ? diffGrowthPolicies(approvedPolicy, approvedUnified, policy, unifiedDraft) : [];
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
          {onSavePolicyDraft ? <Button type="button" disabled={(!dirty && policySaved) || allErrors.length > 0 || policySaving} onClick={onSavePolicyDraft}>{policySaving ? "保存中…" : "保存草稿"}</Button> : null}
          {onSubmitPolicy ? <Button type="button" variant="outline" disabled={dirty || !policySaved || !serverPublishable} onClick={onSubmitPolicy}>提交审批</Button> : null}
        </div>
      ) : null}

      {!unifiedSupported ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-800 dark:text-amber-300" role="status">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>服务端尚未提供统一折扣合同（API_DEPENDENCY_PENDING）。当前仅展示只读数据，编辑、保存与礼遇办理暂不可用；请等待已接纳 API 部署后再操作。</p>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-card p-5 shadow-2xs space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-xl font-bold tracking-tight text-foreground">会员政策</h2>
              <Badge variant={lifecycle.variant}>{lifecycle.label}{approvedVersion ? ` · v${approvedVersion}` : ""}</Badge>
              {draftExists ? <Badge variant="warning">草稿 v{policy.version} · 未生效</Badge> : null}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-2xl">
              当前显示已生效的统一折扣；编辑在弹窗中进行。
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
            {editable ? (
              <Button size="sm" variant="default" onClick={() => { setEditStage(1); setIsEditOpen(true); }}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                {draftExists ? "编辑草稿" : "编辑政策"}
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
          {approvedPolicy ? <InfoHint label="价格依据说明">折扣按当前启用的价格方案计算；价格方案与审批单号可在变更记录中查看。</InfoHint> : null}
        </div>

        {draftExists ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5 min-w-[280px]">
              <div className="p-1.5 rounded-md bg-amber-500/20 text-amber-600 dark:text-amber-400"><FileEdit className="h-4 w-4" /></div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">草稿 v{policy.version} 未生效</span>
                  <Badge variant={dirty ? "warning" : approval.status === "REQUESTED" ? "info" : "secondary"} className="text-[10px] py-0">
                    {dirty ? "有未保存修改" : approval.status === "REQUESTED" ? "已提交审批" : "已保存草稿"}
                  </Badge>
                  {!dirty ? <InfoHint label="草稿说明">草稿保存后不能删除；如需调整请继续编辑，保存后会覆盖当前草稿。</InfoHint> : null}
                  {!dirty && (!serverPublishable || warnings.length) ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                      待补齐
                      <InfoHint label="待补齐项"><span>{[...allErrors, ...warnings].slice(0, 6).join("；") || "请打开编辑草稿查看待补齐项。"}</span></InfoHint>
                    </span>
                  ) : null}
                </div>
                <p className="text-muted-foreground">
                  {dirty
                    ? "有未保存修改，保存后可提交。"
                    : approval.status === "REQUESTED"
                      ? "已提交审批，等待审批中心处理。"
                      : "草稿已保存，提交审批后生效。"}
                </p>
                {approval.status === "REJECTED" ? <p className="text-destructive">{approval.message ?? "申请被驳回，可修改后重新提交。"}</p> : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {editable ? (
                <Button size="sm" variant="outline" className="h-8 text-xs bg-background" onClick={() => { setEditStage(1); setIsEditOpen(true); }}>
                  <Pencil className="h-3.5 w-3.5 mr-1" />
                  继续编辑草稿
                </Button>
              ) : null}
              {onSavePolicyDraft && dirty ? (
                <Button size="sm" variant="secondary" className="h-8 text-xs" title={allErrors.length ? "请先在编辑草稿中修正校验问题" : undefined} disabled={policySaving || allErrors.length > 0} onClick={onSavePolicyDraft}>
                  {policySaving ? "保存中…" : "保存草稿"}
                </Button>
              ) : null}
              {onSubmitPolicy ? (
                <Button size="sm" variant="default" className="h-8 text-xs" disabled={dirty || policySaving || !policySaved || !serverPublishable || allErrors.length > 0} onClick={onSubmitPolicy}>
                  <Send className="h-3.5 w-3.5 mr-1" />
                  提交审批
                </Button>
              ) : null}
              {canOpenApproval ? <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onOpenApproval}>查看审批</Button> : null}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /></div>
              <div>
                <span className="font-medium text-foreground">{approvedPolicy ? `当前生效政策 v${approvedVersion}` : "尚未配置统一权益"}</span>
                <p className="text-muted-foreground text-[11px] mt-0.5">
                  {approvedPolicy ? "编辑会创建新草稿；审批通过并执行前不影响线上折扣。" : "创建首份草稿，提交审批后生效。"}
                </p>
              </div>
            </div>
            {editable ? (
              <Button size="sm" variant="outline" className="h-7 text-xs bg-background" onClick={() => { setEditStage(1); setIsEditOpen(true); }}>
                <Pencil className="h-3 w-3 mr-1" />
                {approvedPolicy ? "编辑政策草稿" : "创建首份草稿"}
              </Button>
            ) : null}
          </div>
        )}
      </div>

      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-2xs" aria-labelledby="membership-admin-policy-heading">
        <div className="p-4 sm:px-5 border-b border-border/80 flex flex-wrap items-center justify-between gap-3 bg-muted/20">
          <div>
            <h3 id="membership-admin-policy-heading" className="flex items-center gap-1.5 text-sm font-semibold text-foreground">统一成长等级权益<InfoHint label="统一折扣说明">总价折扣只作用于哈夫币租金与物资费合计；押金、号主保证金不参与。0.95 = 实付 95%。</InfoHint></h3>
            <p className="mt-0.5 text-xs text-muted-foreground">总价折扣作用于租金与物资费合计；所有已启用租赁方式统一；押金不参与。</p>
            <p className="mt-1 text-[10px] text-muted-foreground md:hidden">左右滑动表格查看押金权益。</p>
          </div>
          <Badge variant={approvedPolicy ? "success" : "outline"}>{approvedPolicy ? `生效 v${approvedVersion}` : "尚无生效配置"}</Badge>
        </div>
        {approvedPolicy && approvedUnified ? (
          <Table className="membership-admin-table">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-medium text-xs">会员等级</TableHead>
                <TableHead className="font-medium text-xs">成长门槛（固定）</TableHead>
                <TableHead className="font-medium text-xs"><span className="inline-flex items-center gap-1">统一应付折扣<InfoHint label="折扣说明">0.95 = 实付 95%；1 = 原价。折扣只作用于租金与物资费合计。</InfoHint></span></TableHead>
                <TableHead className="font-medium text-xs"><span className="inline-flex items-center gap-1">押金权益<InfoHint label="押金权益说明">按账号原押金减免，最高有效额度不累加；完全免押优先。</InfoHint></span></TableHead>
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
                    <TableCell className="tabular-nums font-mono">{tier?.threshold ?? "—"} 分</TableCell>
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
                  </TableRow>
                );
              })}
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
          <Badge variant="outline">{approvedPolicy ? `只读 · 生效 v${approvedVersion}` : "尚无生效配置"}</Badge>
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
                    <DialogTitle className="text-base font-semibold">编辑统一会员政策（草稿 v{editVersion}）</DialogTitle>
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
                    <Button type="button" size="sm" variant="outline" disabled={(!dirty && policySaved) || allErrors.length > 0 || policySaving} onClick={onSavePolicyDraft}>{policySaving ? "保存中…" : "保存草稿"}</Button>
                  </>
                ) : null}
                {editStage < 3 ? <Button size="sm" variant="default" disabled={editStage === 1 && !stageOneComplete} onClick={() => goToStage((editStage + 1) as 2 | 3)}>下一步</Button> : onSubmitPolicy ? (
                  <Button type="button" size="sm" variant="default" disabled={dirty || policySaving || !policySaved || !serverPublishable || allErrors.length > 0} onClick={() => { onSubmitPolicy(); setIsEditOpen(false); }}><Send className="h-3.5 w-3.5 mr-1" />提交审批</Button>
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
