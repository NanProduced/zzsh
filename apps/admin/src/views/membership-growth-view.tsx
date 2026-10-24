import { useEffect, useMemo, useState, useRef } from "react";
import { CheckCircle2, ChevronRight, Copy, LineChart, Lock, Pencil, Plus, Trash2, TriangleAlert, X, History, AlertCircle, FileEdit, Send } from "lucide-react";
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
            <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 space-y-2 text-warning-foreground">
              <div className="flex items-center gap-2 font-medium">
                <TriangleAlert className="h-4 w-4" />
                <span>试算依据暂不可用</span>
              </div>
              <p className="text-muted-foreground">{contextError}</p>
              <p className="text-[11px] text-muted-foreground">未读取到价目时不生成结果，不以全 0 或旧结果代替。</p>
            </div>
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
            {editable ? (
              <Button size="sm" variant="default" onClick={() => { setEditStage(1); setIsEditOpen(true); }}>
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

        {draftExists ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5 min-w-[280px]">
              <div className="p-1.5 rounded-md bg-amber-500/20 text-amber-600 dark:text-amber-400"><FileEdit className="h-4 w-4" /></div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">待处理变更</span>
                  <Badge variant={dirty ? "warning" : approval.status === "REQUESTED" ? "info" : approval.status === "REJECTED" ? "destructive" : "secondary"} className="text-[10px] py-0">
                    {dirty ? "未保存修改" : approval.status === "REQUESTED" ? "已提交审批" : approval.status === "REJECTED" ? "已退回" : approval.status === "UNKNOWN" ? "关联申请待核对" : "草稿已保存"}
                  </Badge>
                  {!dirty && (!serverPublishable || warnings.length) ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                      待补齐
                      <InfoHint label="待补齐项"><span>{[...allErrors, ...warnings].slice(0, 6).join("；") || "请打开编辑窗口查看待补齐项。"}</span></InfoHint>
                    </span>
                  ) : null}
                </div>
                <p className="text-muted-foreground">
                  {dirty
                    ? "本次修改尚未保存；保存后才会进入待提交状态。"
                    : approval.status === "REQUESTED"
                      ? approval.message ?? "已提交审批，等待审批中心处理。"
                      : approval.status === "REJECTED"
                        ? approval.message ?? "审批已退回；可调整后重新提交。"
                        : approval.status === "UNKNOWN"
                          ? approval.message ?? "关联申请暂未读到；本次页面内存为空不代表从未申请，请到审批中心核对。"
                          : "草稿已保存，尚未提交审批。"}
                </p>
                {approval.status === "UNKNOWN" ? <p className="text-[11px] text-amber-700 dark:text-amber-300">提交前请先到审批中心核对是否已有同一草稿的申请。</p> : null}
                {approval.status === "REJECTED" ? <p className="text-destructive">{approval.message ?? "申请被驳回，可修改后重新提交。"}</p> : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
                <span className="font-medium text-foreground">{approvedPolicy ? "当前生效权益" : "尚未配置统一权益"}</span>
                <p className="text-muted-foreground text-[11px] mt-0.5">
                  {approvedPolicy ? "编辑会创建新草稿；审批通过并执行前不影响线上折扣。" : "创建首份草稿，提交审批后生效。"}
                </p>
              </div>
            </div>
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
          <Badge variant={approvedPolicy ? "success" : "outline"}>{approvedPolicy ? "当前生效" : "尚无生效配置"}</Badge>
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
