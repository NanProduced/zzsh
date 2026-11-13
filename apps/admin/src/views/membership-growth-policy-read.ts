import { AdminApiError, hasPermission, type SessionSnapshot } from "../api";
import { bootstrapGrowthPolicy, type AdminGrowthCatalog, type AdminGrowthPolicy, type AdminGrowthSubject, type AdminPolicyChangeDiff, type AdminPolicyChangePerson, type AdminPolicyChangeProjection, type AdminPolicyChangeRead, type AdminPolicyChangeRequest, type AdminPolicyChangeStep, type AdminPolicyRequestedValue, type AdminPricingMode } from "./membership-growth-view";
import { UNIFIED_PRICING_SCHEMA, UNIFIED_PRICING_SCOPE, type AdminGrowthCapability, type UnifiedPricingProjection } from "./membership-unified-contract";

export type PolicyBootstrap = {
  ruleReleaseId: string;
  priceVersionId: string;
  haffSchema: "haff-ratio-v1" | "haff-ratio-v2" | null;
  releaseMode: "SPREAD" | "PERCENT";
  enabledModes: AdminPricingMode[];
  nextVersionNo: number;
  expectedVersion: string;
};

export type PolicyMeta = {
  id: string;
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAtUtc: string | null;
  ruleReleaseId: string;
  priceVersionId: string;
  sourceRef: string;
  payloadHash: string;
};

export type PolicyResponse = {
  approvedMeta?: { id: string; version: string; effectiveAtUtc: string | null; priceVersionId?: string; payloadHash?: string } | null;
  approvedPolicy?: Record<string, any> | null;
  approvedUnifiedPricing?: UnifiedPricingProjection | null;
  policy: Record<string, any> | null;
  unifiedPricing?: UnifiedPricingProjection | null;
  meta: PolicyMeta | null;
  capability?: AdminGrowthCapability;
  catalog: AdminGrowthCatalog;
  thresholds: Record<string, string>;
  bootstrap?: PolicyBootstrap | null;
  policyChange?: unknown;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function personOf(value: unknown): AdminPolicyChangePerson | null {
  const record = recordOf(value);
  const id = textOf(record?.id);
  return id ? { id, name: textOf(record?.name) } : null;
}

function stepOf(value: unknown): AdminPolicyChangeStep | null {
  const record = recordOf(value);
  const key = textOf(record?.key)?.toUpperCase();
  const label = textOf(record?.label);
  const state = textOf(record?.state)?.toUpperCase();
  if (!key || !label || !["SUBMITTED", "APPROVAL", "EXECUTION", "EFFECTIVE"].includes(key)) return null;
  if (!state || !["COMPLETED", "CURRENT", "PENDING", "FAILED", "UNKNOWN"].includes(state)) return null;
  return {
    key: key as AdminPolicyChangeStep["key"],
    label,
    state: state as AdminPolicyChangeStep["state"],
    actor: personOf(record?.actor),
    atUtc: textOf(record?.atUtc),
    note: textOf(record?.note),
  };
}

function diffOf(value: unknown): AdminPolicyChangeDiff | null {
  const record = recordOf(value);
  const label = textOf(record?.label);
  if (!label) return null;
  const format = textOf(record?.format)?.toUpperCase();
  const risk = textOf(record?.risk)?.toUpperCase();
  return {
    label,
    baseline: textOf(record?.baseline),
    requested: textOf(record?.requested),
    format: format === "DISCOUNT" || format === "CENTS" ? format : "TEXT",
    risk: risk === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "LOW",
  };
}

function requestedValuesOf(value: unknown): AdminPolicyRequestedValue[] | null {
  if (!Array.isArray(value) || value.length > 19) return null;
  const values: AdminPolicyRequestedValue[] = [];
  for (const item of value) {
    const row = recordOf(item), label = textOf(row?.label), format = row?.format;
    if (!label || typeof format !== "string" || !["TEXT", "DISCOUNT", "CENTS"].includes(format) || row?.value !== null && typeof row?.value !== "string") return null;
    values.push({ label, value: row!.value as string | null, format: format as AdminPolicyRequestedValue["format"] });
  }
  return values;
}

/** Optional read projection; absence or an incomplete shape never means there is no request. */
export function normalizePolicyChange(raw: unknown): AdminPolicyChangeRead {
  if (raw === undefined) return { status: "UNAVAILABLE", message: "暂时无法读取申请状态，请稍后刷新。" };
  if (raw === null) return { status: "UNAVAILABLE", message: "暂时无法读取申请状态，请稍后刷新。" };
  const record = recordOf(raw);
  const knowledge = textOf(record?.knowledge)?.toUpperCase();
  if (!record || !knowledge || !["KNOWN", "UNKNOWN", "FORBIDDEN"].includes(knowledge)) {
    return { status: "UNAVAILABLE", message: "申请信息暂不完整，请刷新或查看原申请。" };
  }
  if (knowledge === "KNOWN" && record.request === undefined) {
    return { status: "UNAVAILABLE", message: "申请信息暂不完整，请刷新或查看原申请。" };
  }
  const requestRecord = record.request === null || record.request === undefined ? null : recordOf(record.request);
  if (record.request !== null && record.request !== undefined && (!requestRecord || !textOf(requestRecord.id))) {
    return { status: "UNAVAILABLE", message: "申请信息暂不完整，请刷新或查看原申请。" };
  }
  const reference = recordOf(record.draftReference);
  const request: AdminPolicyChangeRequest | null = requestRecord ? {
    id: textOf(requestRecord.id)!,
    operationCode: textOf(requestRecord.operationCode),
    approvalStatus: textOf(requestRecord.approvalStatus) ?? "UNKNOWN",
    executionStatus: textOf(requestRecord.executionStatus),
    reason: textOf(requestRecord.reason),
    submittedBy: personOf(requestRecord.submittedBy),
    submittedAtUtc: textOf(requestRecord.submittedAtUtc),
    plannedEffectiveAtUtc: textOf(requestRecord.plannedEffectiveAtUtc),
    steps: Array.isArray(requestRecord.steps) ? requestRecord.steps.map(stepOf).filter((step): step is AdminPolicyChangeStep => step !== null) : null,
  } : null;
  const diffSource = Array.isArray(record.immutableDiff) ? record.immutableDiff.map(diffOf).filter((diff): diff is AdminPolicyChangeDiff => diff !== null) : null;
  const effective = recordOf(record.effectiveState);
  return {
    status: "READY",
    knownRequestId: request?.id ?? null,
    change: {
      knowledge: knowledge as AdminPolicyChangeProjection["knowledge"],
      draftReference: reference && textOf(reference.id) && textOf(reference.version) && textOf(reference.payloadHash)
        ? { id: textOf(reference.id)!, version: textOf(reference.version)!, payloadHash: textOf(reference.payloadHash)! }
        : null,
      request,
      requestedValues: knowledge === "KNOWN" && request?.operationCode === "membership.benefit.policy.publish" && reference && textOf(reference.id) && textOf(reference.version) && textOf(reference.payloadHash) ? requestedValuesOf(record.requestedValues) : null,
      immutableDiff: diffSource !== null && record.immutableDiff && Array.isArray(record.immutableDiff) && record.immutableDiff.length > 0 && diffSource.length === 0 ? null : diffSource,
      effectiveState: effective && textOf(effective.status) ? {
        status: textOf(effective.status)!,
        effectiveAtUtc: textOf(effective.effectiveAtUtc),
        executed: typeof effective.executed === "boolean" ? effective.executed : null,
      } : null,
      message: textOf(record.message),
    },
  };
}

export type DraftResponse = {
  id: string;
  version: string;
  status: "DRAFT";
  payloadHash: string;
  publishable: boolean;
  warnings: string[];
  unifiedPricing?: UnifiedPricingProjection;
};

export function policyDraftApprovalPayload(meta: PolicyMeta) {
  if (meta.status !== "DRAFT" || !/^[0-9a-f]{64}$/.test(meta.payloadHash)) throw new Error("请先保存当前政策草稿");
  return { policyDraftId: meta.id, policyDraftVersion: Number(meta.version), policyDraftHash: meta.payloadHash, ruleReleaseId: meta.ruleReleaseId, priceVersionId: meta.priceVersionId, sourceRef: meta.sourceRef, effectiveAtUtc: meta.effectiveAtUtc };
}

export type SubjectResponse = { subjectId: string; growth?: { knowledge: "KNOWN" | "UNKNOWN"; effectiveTier: string | null; rollingPoints: string | null; lifetimePoints: string | null; sourceState: string }; authorizationState?: string };

const TIERS = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"] as const;

function mapPolicyPayload(raw: Record<string, any>, meta: { version: string; status: string; effectiveAtUtc: string | null }, catalog: AdminGrowthCatalog, thresholds: Record<string, string>): AdminGrowthPolicy {
  const tierConfig = raw.tiers as Record<string, any>;
  return {
    version: meta.version,
    status: meta.status === "APPROVED" ? "APPROVED" : "DRAFT",
    effectiveAt: meta.effectiveAtUtc,
    catalog,
    tiers: TIERS.map((tier) => {
      const config = tierConfig[tier] ?? {};
      return {
        tier,
        threshold: thresholds[tier] ?? "0",
        tenantDeposit: config.tenantDeposit === "WAIVED" ? "WAIVED" : "ACCOUNT_BASE",
        depositAllowanceCents: typeof config.depositAllowanceCents === "string" ? config.depositAllowanceCents : "0",
      };
    }),
  };
}

export function asPolicy(response: PolicyResponse): AdminGrowthPolicy | null {
  if (response.policy && response.meta) return mapPolicyPayload(response.policy, response.meta, response.catalog, response.thresholds);
  if (!response.policy && response.bootstrap) return bootstrapGrowthPolicy(response.catalog, response.thresholds, response.bootstrap.nextVersionNo);
  return null;
}

export function asApprovedPolicy(response: PolicyResponse): AdminGrowthPolicy | null {
  if (!response.approvedPolicy || !response.approvedMeta) return null;
  return mapPolicyPayload(response.approvedPolicy, { ...response.approvedMeta, status: "APPROVED" }, response.catalog, response.thresholds);
}

function emptyUnifiedProjection(reasonCodes: string[]): UnifiedPricingProjection {
  const unknownTier = () => ({ knowledge: "UNKNOWN" as const, payableRatio: null, reasonCodes });
  const unknownRange = () => ({ knowledge: "UNKNOWN" as const, minPayableRatio: null, maxPayableRatio: null, priceVersionId: null, costBasisRef: null, reasonCodes });
  return {
    schema: UNIFIED_PRICING_SCHEMA,
    scope: UNIFIED_PRICING_SCOPE,
    knowledge: "UNKNOWN",
    tiers: Object.fromEntries(TIERS.map((tier) => [tier, unknownTier()])) as UnifiedPricingProjection["tiers"],
    entitlementRanges: { FRIEND: unknownRange(), PRESTIGE: unknownRange() },
  };
}

export function latestUnified(response: PolicyResponse): UnifiedPricingProjection {
  if (response.unifiedPricing) return response.unifiedPricing;
  if (response.capability?.unifiedPricingSupported === true) return emptyUnifiedProjection(["UNIFIED_PRICING_UNAVAILABLE"]);
  return emptyUnifiedProjection(["POLICY_UNAVAILABLE"]);
}

/** Metadata/deposits only; the server normalizes pricing and ranges from unifiedPricing. */
export function toDraftPolicyBody(policy: AdminGrowthPolicy, versionNo: number): Record<string, unknown> {
  return {
    schema: "membership-growth-v1",
    version: String(versionNo),
    status: "DRAFT",
    effectiveAt: policy.effectiveAt,
    sourceRef: "admin:membership-growth",
    tiers: Object.fromEntries(policy.tiers.map((tier) => [tier.tier, {
      tier: tier.tier,
      tenantDeposit: tier.tenantDeposit,
      ...(tier.depositAllowanceCents !== undefined ? { depositAllowanceCents: tier.depositAllowanceCents } : {}),
    }])),
  };
}

export function subjectOf(response: SubjectResponse | null, subjectId: string | undefined, error: unknown = null): AdminGrowthSubject {
  if (!subjectId) return { subjectId: "", status: "NOT_LOADED", reason: "从用户详情打开会员成长后再读取对象" };
  if (!response) return { subjectId, status: error instanceof AdminApiError && error.status === 403 ? "FORBIDDEN" : "UNKNOWN", reason: error instanceof AdminApiError && error.status === 403 ? "当前身份无权读取成长资料" : "用户成长资料暂时无法确认" };
  if (response.growth?.knowledge !== "KNOWN") return { subjectId, status: "UNKNOWN", reason: "用户成长资料暂时无法确认" };
  return { subjectId, status: "LOADED", userLabel: subjectId, tier: response.growth.effectiveTier ?? "UNKNOWN", rollingPoints: response.growth.rollingPoints ?? undefined, lifetimePoints: response.growth.lifetimePoints ?? undefined };
}

export function policyFailure(error: unknown, response: PolicyResponse | null): string {
  if (error instanceof AdminApiError && error.status === 403) return "当前管理员没有会员成长读取权限";
  if (error instanceof AdminApiError && error.status === 404) return "会员成长功能尚未启用";
  if (response && !response.policy && !response.bootstrap) return "当前没有可用的价格配置，暂时不能建立草稿";
  if (error instanceof AdminApiError) return "会员成长政策暂时无法读取";
  return "尚未读取到会员政策；功能保持未启用或等待首个草稿";
}

export function membershipGrowthAccess(snapshot: Extract<SessionSnapshot, { authenticated: true }>) {
  const boss = snapshot.security.isBoss;
  const canDraft = boss || hasPermission(snapshot, "membership.policy.draft");
  const canRequest = boss || (hasPermission(snapshot, "membership.policy.publish") && hasPermission(snapshot, "approval.request.create"));
  const canReadPolicy = canDraft || hasPermission(snapshot, "membership.policy.publish") || hasPermission(snapshot, "membership.growth.read.summary");
  const canRequestEntitlement = boss || (hasPermission(snapshot, "approval.request.create") && hasPermission(snapshot, "membership.entitlement.request"));
  return { canRead: canReadPolicy || canRequestEntitlement, canReadPolicy, canDraft, canRequest, canRequestEntitlement };
}
