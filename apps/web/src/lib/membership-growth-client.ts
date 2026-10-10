import type { MembershipGrowthData, MembershipGrowthViewState } from "../components/account/membership-growth-panel";

const TIERS = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "BLACK_GOLD", "UNKNOWN"] as const;
const GRACE = ["NONE", "ACTIVE", "RECOVERED", "EXPIRED", "UNKNOWN"] as const;
const ENTITLEMENT_STATES = ["PENDING", "APPROVED_PENDING_EXECUTION", "EXECUTED_PENDING_START", "ACTIVE", "EXPIRED", "REPLACED", "REVOKED"] as const;

type RecordValue = Record<string, unknown>;

export class MembershipGrowthRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, body: unknown) {
    const payload = isRecord(body) && isRecord(body.error) ? body.error : null;
    super(typeof payload?.message === "string" ? payload.message : "会员成长暂时无法读取");
    this.name = "MembershipGrowthRequestError";
    this.status = status;
    this.code = typeof payload?.code === "string" ? payload.code : status === 0 ? "NETWORK_ERROR" : "INTERNAL_ERROR";
  }
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new MembershipGrowthRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: `会员成长字段缺失：${field}` } });
  return value;
}

function tier(value: unknown): MembershipGrowthData["tier"] {
  if (typeof value !== "string" || !(TIERS as readonly string[]).includes(value)) throw new MembershipGrowthRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: "会员成长档位字段无效" } });
  return value as MembershipGrowthData["tier"];
}

function grace(value: unknown): MembershipGrowthData["grace"] {
  if (!isRecord(value) || typeof value.state !== "string" || !(GRACE as readonly string[]).includes(value.state)) throw new MembershipGrowthRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: "会员保级字段无效" } });
  return { state: value.state as MembershipGrowthData["grace"]["state"], fromTier: value.fromTier === null ? null : tier(value.fromTier), until: value.until === null ? null : text(value.until, "grace.until"), gapPoints: value.gapPoints === null ? null : text(value.gapPoints, "grace.gapPoints") };
}

function asReady(body: RecordValue): MembershipGrowthData {
  const growth = isRecord(body.growth) ? body.growth : null;
  if (!growth || growth.schema !== "membership-growth-v1" || growth.knowledge !== "KNOWN") throw new MembershipGrowthRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: "会员成长数据未闭合" } });
  const entitlements = Array.isArray(body.entitlements) ? body.entitlements : [];
  const benefits = Array.isArray(growth.benefits) ? growth.benefits : [];
  const comparison = Array.isArray(growth.comparison) ? growth.comparison : [];
  const contributions = Array.isArray(growth.contributions) ? growth.contributions : [];
  const next = growth.nextTier === null ? null : isRecord(growth.nextTier) ? { tier: tier(growth.nextTier.tier) as Exclude<MembershipGrowthData["tier"], "BLACK_GOLD" | "STANDARD" | "UNKNOWN">, threshold: text(growth.nextTier.threshold, "nextTier.threshold"), remaining: text(growth.nextTier.remaining, "nextTier.remaining") } : null;
  return {
    tier: tier(growth.effectiveTier), rollingPoints: text(growth.rollingPoints, "rollingPoints"), lifetimePoints: text(growth.lifetimePoints, "lifetimePoints"), asOf: text(growth.asOfUtc, "asOfUtc"), nextTier: next, grace: grace(growth.grace), nextExpiryAt: growth.nextExpiryAtUtc === null ? null : text(growth.nextExpiryAtUtc, "nextExpiryAtUtc"),
    benefits: benefits.filter(isRecord).map((item) => ({ label: text(item.label, "benefits.label"), value: text(item.value, "benefits.value"), ...(typeof item.sourceVersion === "string" ? { sourceVersion: item.sourceVersion } : {}) })),
    comparison: comparison.filter(isRecord).map((item) => ({ tier: text(item.tier, "comparison.tier"), deposit: text(item.deposit, "comparison.deposit"), pricing: text(item.pricing, "comparison.pricing") })),
    entitlements: entitlements.filter(isRecord).map((item) => ({ kind: item.kind === "PRESTIGE" ? "PRESTIGE" : "FRIEND", label: typeof item.label === "string" ? item.label : item.kind === "PRESTIGE" ? "尊享礼遇" : "挚友礼遇", scope: text(item.scopeKey, "entitlements.scopeKey"), endsAt: text(item.endsAtUtc, "entitlements.endsAtUtc"), state: ENTITLEMENT_STATES.includes(item.status as typeof ENTITLEMENT_STATES[number]) ? item.status as MembershipGrowthData["entitlements"][number]["state"] : "PENDING", depositWaived: item.depositWaived === true })),
    contributions: contributions.filter(isRecord).map((item) => ({ label: text(item.label, "contributions.label"), effectiveAt: text(item.effectiveAt, "contributions.effectiveAt"), amountCents: text(item.amountCents, "contributions.amountCents"), exitsAt: text(item.exitsAt, "contributions.exitsAt"), kind: item.kind === "CORRECTION" ? "CORRECTION" : "CONSUMPTION" })),
    pendingCount: typeof growth.pendingCount === "number" && Number.isInteger(growth.pendingCount) && growth.pendingCount >= 0 ? growth.pendingCount : 0,
  };
}

export async function readMyMembershipGrowth(signal?: AbortSignal): Promise<MembershipGrowthViewState> {
  let response: Response;
  try {
    response = await fetch("/api/account/membership-growth", { credentials: "same-origin", cache: "no-store", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MembershipGrowthRequestError(0, null);
  }
  const body = await response.json().catch(() => null);
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  if (response.status === 403) return { status: "permission", message: "当前身份没有查看成长档案的权限" };
  if (response.status === 404) return { status: "unknown", message: "成长服务尚未接线" };
  if (response.status === 401) throw new MembershipGrowthRequestError(response.status, body);
  if (!response.ok || !isRecord(body)) throw new MembershipGrowthRequestError(response.status, body);
  const growth = isRecord(body.growth) ? body.growth : null;
  if (growth?.knowledge === "UNKNOWN") return { status: "unknown", message: "消费来源尚未完成核验，暂不展示成长积分" };
  try {
    return { status: "ready", data: asReady(body) };
  } catch (error) {
    if (error instanceof MembershipGrowthRequestError) throw error;
    throw new MembershipGrowthRequestError(200, null);
  }
}
