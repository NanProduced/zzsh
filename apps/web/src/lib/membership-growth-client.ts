export type GrowthTier = "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND" | "BLACK_GOLD" | "UNKNOWN";
export type GrowthGraceState = "NONE" | "ACTIVE" | "RECOVERED" | "EXPIRED" | "UNKNOWN";
export type EntitlementState = "PENDING" | "APPROVED_PENDING_EXECUTION" | "EXECUTED_PENDING_START" | "ACTIVE" | "EXPIRED" | "REPLACED" | "REVOKED" | "UNKNOWN";
export type EntitlementKind = "FRIEND" | "PRESTIGE" | "UNKNOWN";

export type MembershipGrowthData = {
  subjectId?: string;
  tier: GrowthTier;
  rollingPoints: string;
  lifetimePoints: string;
  asOf: string;
  windowStart: string | null;
  benefitsState: "CONFIGURED" | "NOT_CONFIGURED";
  nextTier: { tier: Exclude<GrowthTier, "BLACK_GOLD" | "STANDARD" | "UNKNOWN">; threshold: string; remaining: string } | null;
  grace: { state: GrowthGraceState; fromTier: GrowthTier | null; until: string | null; gapPoints: string | null };
  nextExpiryAt: string | null;
  benefits: Array<{ label: string; value: string; sourceVersion?: string }>;
  comparison?: Array<{ tier: string; deposit: string; pricing: string }>;
  entitlements: Array<{ id: string; kind: EntitlementKind; label: string; scope: string; startsAt: string; endsAt: string; state: EntitlementState; depositWaived: boolean }>;
  contributions: Array<{ label: string; effectiveAt: string; amountCents: string; exitsAt: string; kind: "CONSUMPTION" | "CORRECTION" }>;
  pendingCount: number;
};

export type MembershipPointEvent = {
  id: string;
  at: string;
  reason: string;
  rollingDelta: string;
  lifetimeDelta: string;
};

export type MembershipGrowthViewState =
  | { status: "loading" }
  | { status: "error"; message: string; retryable?: boolean }
  | { status: "permission"; message: string }
  // 成长来源未闭合时仍保留已获准的独立礼遇，避免未知状态连带隐藏有效权益。
  | { status: "unknown"; message: string; entitlements: MembershipGrowthData["entitlements"] }
  | { status: "ready"; data: MembershipGrowthData };

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

function requiredRecords(value: unknown, field: string): RecordValue[] {
  if (!Array.isArray(value)) throw new MembershipGrowthRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: `会员成长字段缺失：${field}` } });
  if (value.some((item) => !isRecord(item))) throw new MembershipGrowthRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: `会员成长字段无效：${field}` } });
  return value as RecordValue[];
}

function entitlementRecords(body: RecordValue): MembershipGrowthData["entitlements"] {
  const entitlements = requiredRecords(body.entitlements, "entitlements");
  return entitlements.filter(isRecord).map((item) => {
    const kind: EntitlementKind = item.kind === "PRESTIGE" ? "PRESTIGE" : item.kind === "FRIEND" ? "FRIEND" : "UNKNOWN";
    return {
      id: text(item.id, "entitlements.id"),
      kind,
      label: typeof item.label === "string" && item.label ? item.label : "专属礼遇",
      scope: text(item.scopeKey, "entitlements.scopeKey"),
      startsAt: text(item.startsAtUtc, "entitlements.startsAtUtc"),
      endsAt: text(item.endsAtUtc, "entitlements.endsAtUtc"),
      state: (ENTITLEMENT_STATES as readonly string[]).includes(item.status as string) ? (item.status as EntitlementState) : "UNKNOWN",
      depositWaived: item.depositWaived === true,
    };
  });
}

function asReady(body: RecordValue): MembershipGrowthData {
  const growth = isRecord(body.growth) ? body.growth : null;
  if (!growth || growth.schema !== "membership-growth-v1" || growth.knowledge !== "KNOWN") throw new MembershipGrowthRequestError(200, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: "会员成长数据未闭合" } });
  const entitlements = entitlementRecords(body);
  const benefits = requiredRecords(growth.benefits, "benefits");
  const comparison = requiredRecords(growth.comparison, "comparison");
  const contributions = requiredRecords(growth.contributions, "contributions");
  const next = growth.nextTier === null ? null : isRecord(growth.nextTier) ? { tier: tier(growth.nextTier.tier) as Exclude<MembershipGrowthData["tier"], "BLACK_GOLD" | "STANDARD" | "UNKNOWN">, threshold: text(growth.nextTier.threshold, "nextTier.threshold"), remaining: text(growth.nextTier.remaining, "nextTier.remaining") } : null;
  return {
    subjectId: text(body.subjectId, "subjectId"),
    tier: tier(growth.effectiveTier), rollingPoints: text(growth.rollingPoints, "rollingPoints"), lifetimePoints: text(growth.lifetimePoints, "lifetimePoints"), asOf: text(growth.asOfUtc, "asOfUtc"),
    windowStart: typeof growth.windowStartUtc === "string" && growth.windowStartUtc ? growth.windowStartUtc : null,
    benefitsState: growth.benefitsState === "CONFIGURED" ? "CONFIGURED" : "NOT_CONFIGURED",
    nextTier: next, grace: grace(growth.grace), nextExpiryAt: growth.nextExpiryAtUtc === null ? null : text(growth.nextExpiryAtUtc, "nextExpiryAtUtc"),
    benefits: benefits.filter(isRecord).map((item) => ({ label: text(item.label, "benefits.label"), value: text(item.value, "benefits.value"), ...(typeof item.sourceVersion === "string" ? { sourceVersion: item.sourceVersion } : {}) })),
    comparison: comparison.filter(isRecord).map((item) => ({ tier: text(item.tier, "comparison.tier"), deposit: text(item.deposit, "comparison.deposit"), pricing: text(item.pricing, "comparison.pricing") })),
    entitlements,
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
  if (response.status === 401) throw new MembershipGrowthRequestError(response.status, body);
  if (!response.ok || !isRecord(body)) throw new MembershipGrowthRequestError(response.status, body);
  const growth = isRecord(body.growth) ? body.growth : null;
  if (growth?.knowledge === "UNKNOWN") return { status: "unknown", message: "消费来源尚未完成核验，暂不展示成长积分", entitlements: entitlementRecords(body) };
  try {
    return { status: "ready", data: asReady(body) };
  } catch (error) {
    if (error instanceof MembershipGrowthRequestError) throw error;
    throw new MembershipGrowthRequestError(200, null);
  }
}

export type GrowthConsumptionScope = "LIFETIME" | "ROLLING";
export type MembershipGrowthConsumption = {
  subjectId: string; scope: GrowthConsumptionScope; asOf: string; windowStart: string; snapshotVersion: string;
  knowledge: "KNOWN" | "UNKNOWN"; sourceState: string; amountCents: string | null; points: string | null;
  total: number | null; nextCursor: string | null;
  sourceSummary: { contributionCount: number; pendingCount: number; excludedCount: number };
  items: Array<{ id: string; label: string; amountCents: string; effectiveAt: string; recordedAt: string; expiresAt: string; withinWindow: boolean; corrected: boolean; revision: number }>;
};

export async function readMyMembershipGrowthConsumption(subjectId: string, scope: GrowthConsumptionScope, cursor?: string, signal?: AbortSignal): Promise<MembershipGrowthConsumption> {
  const query = new URLSearchParams({ scope, limit: "20", ...(cursor === undefined ? {} : { cursor }) });
  let response: Response;
  try { response = await fetch("/api/account/membership-growth/consumption?" + query, { credentials: "same-origin", cache: "no-store", signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new MembershipGrowthRequestError(0, null); }
  const body = await response.json().catch(() => null);
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  if (!response.ok || !isRecord(body)) throw new MembershipGrowthRequestError(response.status, body);
  const bad = () => new MembershipGrowthRequestError(502, { error: { code: "MEMBERSHIP_CONTRACT_REQUIRED", message: "成长消费明细未闭合" } });
  if (body.subjectId !== subjectId) throw new MembershipGrowthRequestError(401, { error: { code: "IDENTITY_CHANGED", message: "当前身份已变化" } });
  const count = (v: unknown): number => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw bad(); return v; };
  const cents = (v: unknown): string => { if (typeof v !== "string" || !/^-?(0|[1-9]\d{0,23})$/.test(v)) throw bad(); return v; };
  if (body.contractVersion !== "membership-growth.consumption.v1" || body.scope !== scope || !["KNOWN", "UNKNOWN"].includes(String(body.knowledge)) || typeof body.snapshotVersion !== "string" || !/^[a-f0-9]{64}$/.test(body.snapshotVersion) || !isRecord(body.sourceSummary)) throw bad();
  const items = requiredRecords(body.items, "consumption.items");
  if (items.length > 20 || body.nextCursor !== null && (typeof body.nextCursor !== "string" || body.nextCursor.length > 4096)) throw bad();
  const known = body.knowledge === "KNOWN";
  if (!known && (body.total !== null || body.points !== null || body.amountCents !== null || items.length !== 0 || body.nextCursor !== null)) throw bad();
  const mapped = items.map((item) => {
    if (typeof item.id !== "string" || !/^growth_source_[a-f0-9]{48}$/.test(item.id) || typeof item.withinWindow !== "boolean" || typeof item.corrected !== "boolean") throw bad();
    return { id: item.id, label: text(item.label, "consumption.label"), amountCents: cents(item.amountCents), effectiveAt: text(item.effectiveAt, "consumption.effectiveAt"), recordedAt: text(item.recordedAt, "consumption.recordedAt"), expiresAt: text(item.expiresAt, "consumption.expiresAt"), withinWindow: item.withinWindow, corrected: item.corrected, revision: count(item.revision) };
  });
  if (new Set(mapped.map((item) => item.id)).size !== mapped.length || known && (count(body.total) < mapped.length || !cursor && body.nextCursor === null && count(body.total) !== mapped.length) || scope === "ROLLING" && mapped.some((item) => !item.withinWindow)) throw bad();
  return { subjectId, scope, asOf: text(body.asOfUtc, "consumption.asOfUtc"), windowStart: text(body.windowStartUtc, "consumption.windowStartUtc"), snapshotVersion: body.snapshotVersion, knowledge: known ? "KNOWN" : "UNKNOWN", sourceState: text(body.sourceState, "consumption.sourceState"), amountCents: known ? cents(body.amountCents) : null, points: known ? cents(body.points) : null, total: known ? count(body.total) : null, nextCursor: body.nextCursor as string | null, sourceSummary: { contributionCount: count(body.sourceSummary.contributionCount), pendingCount: count(body.sourceSummary.pendingCount), excludedCount: count(body.sourceSummary.excludedCount) }, items: mapped };
}
