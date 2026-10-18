import { computeDeltaQuote, type InternalQuote, type QuoteInput } from "../supply/pricing";
import { parseNonNegativeDecimal, subtractDecimal } from "../supply/decimal";
import { normalizeTime } from "../supply/content-hash";

export const MEMBERSHIP_GROWTH_SCHEMA = "membership-growth-v1" as const;
export const GROWTH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const GRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** E-R3-02: every instant comparison in this model runs on epoch microseconds (PG timestamptz precision, safe integer). */
const GROWTH_WINDOW_US = GROWTH_WINDOW_MS * 1000;
const GRACE_WINDOW_US = GRACE_WINDOW_MS * 1000;

export const NORMAL_GROWTH_TIERS = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND"] as const;
export type NormalGrowthTier = (typeof NORMAL_GROWTH_TIERS)[number];
export type GrowthTier = NormalGrowthTier | "BLACK_GOLD" | "UNKNOWN";
export type RentalMode = "ordinary" | "custom" | "fast";

export const GROWTH_THRESHOLDS: Readonly<Record<NormalGrowthTier, bigint>> = {
  STANDARD: 0n,
  SILVER: 5_000n,
  GOLD: 10_000n,
  PLATINUM: 20_000n,
  DIAMOND: 40_000n,
};

export type GrowthSourceType = "RENTAL_SETTLEMENT" | "MATERIAL_CONSUMPTION" | "MINIMUM_BILLING" | "REFUND_CORRECTION";
export type GrowthContributionStatus = "SETTLED" | "PENDING" | "VOID";

export type GrowthContribution = {
  userId: string;
  sourceKey: string;
  sourceType: GrowthSourceType;
  sourceId: string;
  settlementVersion: string;
  effectiveAt: string;
  recordedAt: string;
  amountCents: string;
  status: GrowthContributionStatus;
  eligible: boolean;
  revision: number;
  previousAmountCents?: string;
  correctionOf?: string;
  correctionMode?: "REPLACE" | "INCREMENT";
};

export type SettledContributionFact = {
  userId: string;
  settlementId: string;
  settlementVersion: string;
  component: GrowthSourceType | "DEPOSIT" | "PENALTY" | "COMPENSATION" | "OWNER_EARNING" | "COMMISSION";
  effectiveAt: string;
  recordedAt: string;
  amountCents: string;
  status: GrowthContributionStatus;
  revision: number;
  previousAmountCents?: string;
  correctionOf?: string;
  correctionMode?: "REPLACE" | "INCREMENT";
};

export type ContributionAdapterResult =
  | { accepted: true; contribution: GrowthContribution }
  | { accepted: false; reason: "SOURCE_NOT_ELIGIBLE" | "NOT_SETTLED" | "IDENTITY_UNKNOWN" };

export class GrowthRuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GrowthRuleError";
  }
}

function fail(code: string, message: string): never {
  throw new GrowthRuleError(code, message);
}

/**
 * Parses an RFC3339 UTC instant with at most microsecond precision (shared normalizeTime) into epoch microseconds.
 * Millisecond and second inputs keep their old meaning; more than six fractional digits are rejected, never truncated.
 */
function parseInstant(value: string, field: string): number {
  if (typeof value !== "string" || value.length < 20 || !value.endsWith("Z")) fail("INVALID_INSTANT", `${field} must be an RFC3339 UTC instant`);
  let canonical: string | null;
  try { canonical = normalizeTime(value); } catch { canonical = null; }
  if (!canonical) fail("INVALID_INSTANT", `${field} is invalid or exceeds microsecond precision`);
  const ms = Date.parse(`${canonical.slice(0, 23)}Z`);
  if (!Number.isFinite(ms)) fail("INVALID_INSTANT", `${field} is invalid`);
  const us = ms * 1000 + Number(canonical.slice(23, 26));
  if (!Number.isSafeInteger(us)) fail("INVALID_INSTANT", `${field} is outside the supported range`);
  return us;
}

/** Formats epoch microseconds; whole milliseconds keep the historical toISOString form (frozen v1–v3 facts unchanged). */
function formatInstant(us: number): string {
  const ms = Math.floor(us / 1000);
  const iso = new Date(ms).toISOString();
  const sub = us - ms * 1000;
  return sub === 0 ? iso : `${iso.slice(0, 23)}${String(sub).padStart(3, "0")}Z`;
}

/** Canonical instant compare/format helpers shared with the integration layer (same microsecond model). */
export function growthInstantMicros(value: string): number {
  return parseInstant(value, "instant");
}
export function growthWindowStartAt(asOf: string): string {
  return formatInstant(parseInstant(asOf, "asOf") - GROWTH_WINDOW_US);
}

function parseCents(value: string, field: string, signed = true): bigint {
  const pattern = signed ? /^-?(0|[1-9]\d{0,23})$/ : /^(0|[1-9]\d{0,23})$/;
  if (typeof value !== "string" || !pattern.test(value)) fail("INVALID_AMOUNT", `${field} must be integer cents`);
  return BigInt(value);
}

function parseId(value: string, field: string, maxLength = 127): string {
  if (typeof value !== "string" || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail("INVALID_REFERENCE", `${field} is invalid`);
  return value;
}

function parseMoneyCents(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) fail("INVALID_AMOUNT", `${field} must be yuan with at most two decimals`);
  const parts = value.split(".");
  const whole = parts[0]!;
  const fraction = parts[1] ?? "";
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
}

function isGrowthSourceType(value: unknown): value is GrowthSourceType {
  return value === "RENTAL_SETTLEMENT" || value === "MATERIAL_CONSUMPTION" || value === "MINIMUM_BILLING" || value === "REFUND_CORRECTION";
}

function normalRank(tier: NormalGrowthTier): number {
  return NORMAL_GROWTH_TIERS.indexOf(tier);
}

export function roundHalfUpCents(cents: bigint): bigint {
  const sign = cents < 0n ? -1n : 1n;
  const absolute = cents < 0n ? -cents : cents;
  return sign * ((absolute + 50n) / 100n);
}

export function normalTierForPoints(points: bigint): NormalGrowthTier {
  let tier: NormalGrowthTier = "STANDARD";
  for (const candidate of NORMAL_GROWTH_TIERS) {
    if (points >= GROWTH_THRESHOLDS[candidate]) tier = candidate;
  }
  return tier;
}

export function growthTierForPoints(points: bigint, lifetimePoints: bigint, existingBlackGold = false): GrowthTier {
  return existingBlackGold || lifetimePoints >= 50_000n ? "BLACK_GOLD" : normalTierForPoints(points);
}

export function contributionFromSettlement(fact: SettledContributionFact): ContributionAdapterResult {
  if (!fact.userId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(fact.userId)) return { accepted: false, reason: "IDENTITY_UNKNOWN" };
  if (!isGrowthSourceType(fact.component)) {
    return { accepted: false, reason: "SOURCE_NOT_ELIGIBLE" };
  }
  if (fact.status !== "SETTLED") return { accepted: false, reason: "NOT_SETTLED" };
  if (fact.component === "REFUND_CORRECTION" && (!fact.correctionOf || !fact.correctionMode)) fail("CORRECTION_REFERENCE_REQUIRED", "refund correction must reference its source and mode");
  parseInstant(fact.effectiveAt, "effectiveAt");
  parseInstant(fact.recordedAt, "recordedAt");
  parseCents(fact.amountCents, "amountCents");
  if (!Number.isSafeInteger(fact.revision) || fact.revision < 0) fail("INVALID_REVISION", "revision is invalid");
  if (fact.previousAmountCents !== undefined) parseCents(fact.previousAmountCents, "previousAmountCents");
  const sourceType = fact.component;
  const sourceKey = fact.correctionOf ?? `${sourceType}:${parseId(fact.settlementId, "settlementId")}`;
  parseId(sourceKey, "sourceKey", 511);
  return {
    accepted: true,
    contribution: {
      userId: fact.userId,
      sourceKey,
      sourceType,
      sourceId: fact.settlementId,
      settlementVersion: fact.settlementVersion,
      effectiveAt: fact.effectiveAt,
      recordedAt: fact.recordedAt,
      amountCents: fact.amountCents,
      status: fact.status,
      eligible: true,
      revision: fact.revision,
      ...(fact.previousAmountCents === undefined ? {} : { previousAmountCents: fact.previousAmountCents }),
      ...(fact.correctionOf === undefined ? {} : { correctionOf: fact.correctionOf }),
      ...(fact.correctionMode === undefined ? {} : { correctionMode: fact.correctionMode }),
    },
  };
}

type ReplaySummary = {
  sourceKey: string;
  amountCents: bigint;
  effectiveAt: number;
  recordedAt: number;
  expiryAt: number;
  correctionEvents: Array<{ at: number; delta: bigint }>;
  initialAmountCents: bigint;
  contribution: GrowthContribution;
};

function canonicalContributions(input: GrowthReplayInput, asOf: number): { rows: ReplaySummary[]; pending: GrowthContribution[]; excluded: Array<{ sourceKey: string; reason: string }> } {
  const grouped = new Map<string, GrowthContribution[]>();
  const pending: GrowthContribution[] = [];
  const excluded: Array<{ sourceKey: string; reason: string }> = [];
  for (const contribution of input.contributions) {
    if (contribution.userId !== input.userId) {
      excluded.push({ sourceKey: contribution.sourceKey, reason: "IDENTITY_MISMATCH" });
      continue;
    }
    parseId(contribution.sourceKey, "sourceKey", 511);
    parseInstant(contribution.effectiveAt, "effectiveAt");
    parseInstant(contribution.recordedAt, "recordedAt");
    parseCents(contribution.amountCents, "amountCents");
    if (!Number.isSafeInteger(contribution.revision) || contribution.revision < 0) fail("INVALID_REVISION", "revision is invalid");
    const recordedAt = parseInstant(contribution.recordedAt, "recordedAt");
    if (recordedAt > asOf) continue;
    const list = grouped.get(contribution.sourceKey) ?? [];
    list.push(contribution);
    grouped.set(contribution.sourceKey, list);
  }
  const rows: ReplaySummary[] = [];
  for (const [sourceKey, revisions] of grouped) {
    const unique = new Map<number, GrowthContribution>();
    for (const revision of revisions) {
      const previous = unique.get(revision.revision);
      if (previous && JSON.stringify(previous) !== JSON.stringify(revision)) fail("SOURCE_REVISION_CONFLICT", `conflicting contribution revision for ${sourceKey}`);
      if (!previous) unique.set(revision.revision, revision);
    }
    const ordered = [...unique.values()].sort((a, b) => a.revision - b.revision);
    const latest = ordered.at(-1)!;
    if (latest.status === "PENDING") {
      pending.push(latest);
      continue;
    }
    if (latest.status === "VOID" || !latest.eligible) {
      excluded.push({ sourceKey, reason: latest.status === "VOID" ? "VOID" : "INELIGIBLE" });
      continue;
    }
    let initialAmountCents: bigint | null = null;
    let resolvedAmountCents: bigint | null = null;
    let effectiveAt: number | null = null;
    const correctionEvents: Array<{ at: number; delta: bigint }> = [];
    for (const revision of ordered) {
      const revisionAmount = parseCents(revision.amountCents, "amountCents");
      const revisionEffectiveAt = parseInstant(revision.effectiveAt, "effectiveAt");
      const revisionRecordedAt = parseInstant(revision.recordedAt, "recordedAt");
      if (initialAmountCents === null) {
        if (revision.correctionMode || revision.correctionOf) fail("CORRECTION_BASE_MISSING", `correction has no base for ${sourceKey}`);
        initialAmountCents = revisionAmount;
        resolvedAmountCents = revisionAmount;
        effectiveAt = revisionEffectiveAt;
        continue;
      }
      const previous = revision.previousAmountCents === undefined ? null : parseCents(revision.previousAmountCents, "previousAmountCents");
      const mode = revision.correctionMode ?? (previous === null ? null : "REPLACE");
      if (mode === "INCREMENT") {
        if (revision.correctionOf !== undefined && revision.correctionOf !== sourceKey) fail("CORRECTION_SOURCE_MISMATCH", `correction source mismatch for ${sourceKey}`);
        resolvedAmountCents! += revisionAmount;
        correctionEvents.push({ at: revisionRecordedAt, delta: revisionAmount });
      } else if (mode === "REPLACE") {
        if (previous !== null && previous !== resolvedAmountCents) fail("CORRECTION_PREVIOUS_MISMATCH", `correction previous amount mismatch for ${sourceKey}`);
        const delta = revisionAmount - resolvedAmountCents!;
        resolvedAmountCents = revisionAmount;
        correctionEvents.push({ at: revisionRecordedAt, delta });
      } else if (revisionAmount !== resolvedAmountCents) {
        fail("CORRECTION_MODE_REQUIRED", `changed source revision requires correction mode for ${sourceKey}`);
      }
    }
    const finalAmountCents = resolvedAmountCents!;
    const originalEffectiveAt = effectiveAt!;
    const expiryAt = originalEffectiveAt + GROWTH_WINDOW_US;
    const recordedAt = parseInstant(latest.recordedAt, "recordedAt");
    if (originalEffectiveAt > asOf) continue;
    rows.push({
      sourceKey,
      amountCents: finalAmountCents,
      effectiveAt: originalEffectiveAt,
      recordedAt,
      expiryAt,
      correctionEvents,
      initialAmountCents: initialAmountCents!,
      contribution: latest,
    });
  }
  return { rows, pending, excluded };
}

export type GrowthGrace = {
  state: "NONE" | "ACTIVE" | "RECOVERED" | "EXPIRED" | "UNKNOWN";
  fromTier: NormalGrowthTier | null;
  droppedAt: string | null;
  until: string | null;
  gapPoints: string | null;
};

export type GrowthReplayInput = {
  userId: string;
  asOf: string;
  contributions: readonly GrowthContribution[];
  previousTier?: GrowthTier;
  lastTierDropAt?: string | null;
  existingBlackGold?: boolean;
};

export type GrowthProjection = {
  schema: typeof MEMBERSHIP_GROWTH_SCHEMA;
  userId: string;
  asOf: string;
  windowStart: string;
  rollingCents: string;
  rollingPoints: string;
  lifetimeCents: string;
  lifetimePoints: string;
  normalTier: NormalGrowthTier;
  effectiveTier: GrowthTier;
  blackGold: "QUALIFIED" | "NOT_QUALIFIED" | "REVIEW_REQUIRED";
  grace: GrowthGrace;
  nextExpiryAt: string | null;
  active: Array<{ sourceKey: string; amountCents: string; effectiveAt: string; expiresAt: string }>;
  pending: Array<{ sourceKey: string; amountCents: string; recordedAt: string }>;
  excluded: Array<{ sourceKey: string; reason: string }>;
};

/** Current confirmed monetary sources, not a fabricated historical points-event ledger. */
export function projectGrowthConsumptionSources(input: GrowthReplayInput): Array<{
  sourceKey: string; sourceType: GrowthSourceType; revision: number; amountCents: string;
  effectiveAt: string; recordedAt: string; expiresAt: string; withinWindow: boolean; corrected: boolean;
}> {
  parseId(input.userId, "userId");
  const asOf = parseInstant(input.asOf, "asOf");
  return canonicalContributions(input, asOf).rows.map((row) => ({
    sourceKey: row.sourceKey, sourceType: row.contribution.sourceType, revision: row.contribution.revision,
    amountCents: row.amountCents.toString(), effectiveAt: formatInstant(row.effectiveAt), recordedAt: formatInstant(row.recordedAt),
    expiresAt: formatInstant(row.expiryAt), withinWindow: row.effectiveAt > asOf - GROWTH_WINDOW_US && row.effectiveAt <= asOf,
    corrected: row.correctionEvents.length > 0,
  }));
}

export function replayGrowthProjection(input: GrowthReplayInput): GrowthProjection {
  const userId = parseId(input.userId, "userId");
  const asOfMs = parseInstant(input.asOf, "asOf"); // epoch microseconds despite the historical name
  const asOf = formatInstant(asOfMs);
  const windowStartMs = asOfMs - GROWTH_WINDOW_US;
  const { rows, pending, excluded } = canonicalContributions(input, asOfMs);
  const active = rows.filter((row) => row.effectiveAt > windowStartMs && row.effectiveAt <= asOfMs);
  const lifetime = rows.filter((row) => row.effectiveAt <= asOfMs);
  const rollingCents = active.reduce((sum, row) => sum + row.amountCents, 0n);
  const lifetimeCents = lifetime.reduce((sum, row) => sum + row.amountCents, 0n);
  const negativeNet = rollingCents < 0n || lifetimeCents < 0n;
  const rollingPoints = roundHalfUpCents(rollingCents);
  const lifetimePoints = roundHalfUpCents(lifetimeCents);
  const normalTier = normalTierForPoints(rollingPoints);
  const blackGold = input.existingBlackGold && lifetimePoints < 50_000n ? "REVIEW_REQUIRED" : input.existingBlackGold || lifetimePoints >= 50_000n ? "QUALIFIED" : "NOT_QUALIFIED";

  const boundaries = new Map<number, bigint>();
  const addBoundary = (at: number, delta: bigint) => boundaries.set(at, (boundaries.get(at) ?? 0n) + delta);
  for (const row of lifetime) {
    addBoundary(row.effectiveAt, row.initialAmountCents);
    let amountAtExpiry = row.initialAmountCents;
    for (const correction of row.correctionEvents) {
      if (correction.at <= asOfMs && correction.at < row.expiryAt) {
        addBoundary(correction.at, correction.delta);
        amountAtExpiry += correction.delta;
      }
    }
    addBoundary(row.expiryAt, -amountAtExpiry);
  }
  let timelineCents = 0n;
  let priorTier: NormalGrowthTier = input.previousTier && input.previousTier !== "BLACK_GOLD" && input.previousTier !== "UNKNOWN" ? input.previousTier : "STANDARD";
  let graceAnchorAt = input.lastTierDropAt ? parseInstant(input.lastTierDropAt, "lastTierDropAt") : null;
  let graceFromTier: NormalGrowthTier | null = input.previousTier && input.previousTier !== "BLACK_GOLD" && input.previousTier !== "UNKNOWN" ? input.previousTier : null;
  for (const [at, delta] of [...boundaries.entries()].sort(([a], [b]) => a - b)) {
    if (at > asOfMs) break;
    timelineCents += delta;
    const nextTier = normalTierForPoints(roundHalfUpCents(timelineCents));
    if (normalRank(nextTier) < normalRank(priorTier)) {
      if (graceAnchorAt === null || at >= graceAnchorAt + GRACE_WINDOW_US) {
        graceAnchorAt = at;
        graceFromTier = priorTier;
      }
    } else if (graceAnchorAt !== null && graceFromTier !== null && normalRank(nextTier) >= normalRank(graceFromTier)) {
      graceAnchorAt = null;
      graceFromTier = null;
    }
    priorTier = nextTier;
  }
  const baselineTier = graceFromTier;
  const droppedAtMs = graceAnchorAt;
  const lowered = baselineTier !== null && normalRank(normalTier) < normalRank(baselineTier);
  const graceUntilMs = droppedAtMs === null ? null : droppedAtMs + GRACE_WINDOW_US;
  let graceState: GrowthGrace["state"] = "NONE";
  if (lowered && blackGold !== "QUALIFIED") {
    graceState = droppedAtMs === null ? "UNKNOWN" : asOfMs < graceUntilMs! ? "ACTIVE" : "EXPIRED";
  } else if (baselineTier && droppedAtMs && normalRank(normalTier) >= normalRank(baselineTier)) {
    graceState = "RECOVERED";
  }
  const effectiveTier: GrowthTier = input.existingBlackGold || blackGold === "QUALIFIED" || blackGold === "REVIEW_REQUIRED"
    ? "BLACK_GOLD"
    : graceState === "ACTIVE" && baselineTier
      ? baselineTier
      : normalTier;
  const threshold = baselineTier ? GROWTH_THRESHOLDS[baselineTier] : 0n;
  const gapPoints = lowered ? (threshold > rollingPoints ? threshold - rollingPoints : 0n) : null;
  const activeView = active.map((row) => ({ sourceKey: row.sourceKey, amountCents: row.amountCents.toString(), effectiveAt: formatInstant(row.effectiveAt), expiresAt: formatInstant(row.expiryAt) }));
  const nextExpiry = active.reduce<number | null>((next, row) => next === null || row.expiryAt < next ? row.expiryAt : next, null);
  const nextExpiryAt = nextExpiry === null ? null : formatInstant(nextExpiry);
  if (negativeNet) return {
    schema: MEMBERSHIP_GROWTH_SCHEMA,
    userId,
    asOf,
    windowStart: formatInstant(windowStartMs),
    rollingCents: rollingCents.toString(),
    rollingPoints: rollingPoints.toString(),
    lifetimeCents: lifetimeCents.toString(),
    lifetimePoints: lifetimePoints.toString(),
    normalTier,
    effectiveTier: "UNKNOWN",
    blackGold: input.existingBlackGold ? "REVIEW_REQUIRED" : "NOT_QUALIFIED",
    grace: { state: "UNKNOWN", fromTier: null, droppedAt: null, until: null, gapPoints: null },
    nextExpiryAt,
    active: activeView,
    pending: pending.map((row) => ({ sourceKey: row.sourceKey, amountCents: row.amountCents, recordedAt: row.recordedAt })),
    excluded: [...excluded, { sourceKey: "__projection__", reason: "NEGATIVE_NET_CONSUMPTION" }],
  };
  return {
    schema: MEMBERSHIP_GROWTH_SCHEMA,
    userId,
    asOf,
    windowStart: formatInstant(windowStartMs),
    rollingCents: rollingCents.toString(),
    rollingPoints: rollingPoints.toString(),
    lifetimeCents: lifetimeCents.toString(),
    lifetimePoints: lifetimePoints.toString(),
    normalTier,
    effectiveTier,
    blackGold,
    grace: {
      state: graceState,
      fromTier: baselineTier,
      droppedAt: droppedAtMs === null ? null : formatInstant(droppedAtMs),
      until: graceUntilMs === null ? null : formatInstant(graceUntilMs),
      gapPoints: gapPoints === null ? null : gapPoints.toString(),
    },
    nextExpiryAt,
    active: activeView,
    pending: pending.map((row) => ({ sourceKey: row.sourceKey, amountCents: row.amountCents, recordedAt: row.recordedAt })),
    excluded,
  };
}

export type NotPricedParameter = { status: "NOT_PRICED"; reason: string };
export type HaffPricingParameter = NotPricedParameter | {
  status: "CONFIGURED";
  kind: "HAFF_RATIO";
  schema: "haff-ratio-v1" | "haff-ratio-v2";
  priceVersionId: string;
  costBasisRef: string;
  baseBySafeBox: Record<string, string>;
  spreadDelta?: string;
};
export type MaterialPricingParameter = NotPricedParameter | {
  status: "CONFIGURED";
  kind: "FIXED_UNIT";
  itemId: string;
  unit: "ROUND" | "PIECE" | "DAY";
  unitQuantity: string;
  buyerUnitAmount: string;
  ownerUnitAmount: string;
  priceVersionId: string;
  costBasisRef: string;
};
export type GrowthPricingContract = {
  mode: RentalMode;
  priceVersionId: string;
  haff: HaffPricingParameter;
  materials: Record<string, MaterialPricingParameter>;
};
export type TierBenefitConfig = {
  tier: NormalGrowthTier;
  tenantDeposit: "ACCOUNT_BASE" | "WAIVED";
  pricing: Record<RentalMode, GrowthPricingContract>;
  entitlementCap: GrowthPricingContract | NotPricedParameter;
};
export type GrowthBenefitPolicy = {
  schema: typeof MEMBERSHIP_GROWTH_SCHEMA;
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAt: string | null;
  sourceRef: string;
  tiers: Record<NormalGrowthTier, TierBenefitConfig>;
  entitlementCaps: { FRIEND: "GOLD"; PRESTIGE: "DIAMOND" };
};

export type PolicyValidation = { valid: boolean; publishable: boolean; errors: string[]; warnings: string[] };

function notPriced(value: unknown): value is NotPricedParameter {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).status === "NOT_PRICED");
}

function validateNotPriced(value: NotPricedParameter, path: string, result: PolicyValidation): void {
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 300) result.errors.push(`${path}.reason`);
  result.warnings.push(`${path}.cost_basis_missing`);
}

function validateHaffPricing(value: HaffPricingParameter, path: string, result: PolicyValidation): void {
  if (!value || typeof value !== "object") { result.errors.push(path); return; }
  if (notPriced(value)) return validateNotPriced(value, path, result);
  if (value.status !== "CONFIGURED" || value.kind !== "HAFF_RATIO" || !["haff-ratio-v1", "haff-ratio-v2"].includes(value.schema)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.priceVersionId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(value.costBasisRef)
    || !value.baseBySafeBox || typeof value.baseBySafeBox !== "object" || Object.keys(value.baseBySafeBox).length === 0) {
    result.errors.push(path);
    return;
  }
  for (const [safeBox, ratio] of Object.entries(value.baseBySafeBox)) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(safeBox) || !/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(ratio)) result.errors.push(`${path}.baseBySafeBox.${safeBox}`);
  if (value.spreadDelta !== undefined && !/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value.spreadDelta)) result.errors.push(`${path}.spreadDelta`);
}

function validateMaterialPricing(value: MaterialPricingParameter, path: string, result: PolicyValidation): void {
  if (!value || typeof value !== "object") { result.errors.push(path); return; }
  if (notPriced(value)) return validateNotPriced(value, path, result);
  if (value.status !== "CONFIGURED" || value.kind !== "FIXED_UNIT" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.itemId)
    || !["ROUND", "PIECE", "DAY"].includes(value.unit)
    || !/^[1-9]\d{0,23}$/.test(value.unitQuantity)
    || !/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value.buyerUnitAmount)
    || !/^(0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value.ownerUnitAmount)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.priceVersionId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(value.costBasisRef)) result.errors.push(path);
}

function validatePricingContract(value: GrowthPricingContract | NotPricedParameter, path: string, result: PolicyValidation): void {
  if (notPriced(value)) return validateNotPriced(value, path, result);
  if (!value || !["ordinary", "custom", "fast"].includes(value.mode) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.priceVersionId) || !value.materials || typeof value.materials !== "object") {
    result.errors.push(path);
    return;
  }
  if (!value.haff || typeof value.haff !== "object") result.errors.push(`${path}.haff`);
  else validateHaffPricing(value.haff, `${path}.haff`, result);
  for (const [itemId, material] of Object.entries(value.materials)) {
    if (!material || typeof material !== "object") { result.errors.push(`${path}.materials.${itemId}`); continue; }
    if (itemId !== (notPriced(material) ? itemId : material.itemId)) result.errors.push(`${path}.materials.${itemId}.itemId`);
    validateMaterialPricing(material, `${path}.materials.${itemId}`, result);
  }
}

export function validateBenefitPolicy(value: GrowthBenefitPolicy): PolicyValidation {
  const result: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
  if (!value || value.schema !== MEMBERSHIP_GROWTH_SCHEMA) result.errors.push("schema");
  if (!value || !["DRAFT", "APPROVED"].includes(value.status)) result.errors.push("status");
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.version)) result.errors.push("version");
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(value.sourceRef)) result.errors.push("sourceRef");
  if (value?.effectiveAt !== null) {
    try { parseInstant(value.effectiveAt, "effectiveAt"); } catch { result.errors.push("effectiveAt"); }
  }
  if (!value?.entitlementCaps || value.entitlementCaps.FRIEND !== "GOLD" || value.entitlementCaps.PRESTIGE !== "DIAMOND") result.errors.push("entitlementCaps");
  for (const tier of NORMAL_GROWTH_TIERS) {
    const config = value?.tiers?.[tier];
    if (!config || config.tier !== tier) {
      result.errors.push(`tiers.${tier}`);
      continue;
    }
    if (config.tenantDeposit !== "ACCOUNT_BASE" && config.tenantDeposit !== "WAIVED") result.errors.push(`tiers.${tier}.tenantDeposit`);
    for (const mode of ["ordinary", "custom", "fast"] as const) validatePricingContract(config.pricing[mode], `tiers.${tier}.pricing.${mode}`, result);
    validatePricingContract(config.entitlementCap, `tiers.${tier}.entitlementCap`, result);
  }
  const pricingDecimalDifference = (left: string, right: string): bigint | null => {
    try { return subtractDecimal(parseNonNegativeDecimal(left, 8, "pricing"), parseNonNegativeDecimal(right, 8, "pricing")).value; } catch { return null; }
  };
  const pricingEffectiveHaff = (base: string, spread: string) => {
    try { return subtractDecimal(parseNonNegativeDecimal(base, 8, "pricing"), parseNonNegativeDecimal(spread, 8, "pricing")); } catch { return null; }
  };
  const comparePricing = (left: GrowthPricingContract | NotPricedParameter, right: GrowthPricingContract | NotPricedParameter, path: string) => {
    if (notPriced(left) || notPriced(right)) {
      result.publishable = false;
      return;
    }
    const leftHaff = left.haff;
    const rightHaff = right.haff;
    if (notPriced(leftHaff) || notPriced(rightHaff)) result.publishable = false;
    else for (const safeBox of new Set([...Object.keys(leftHaff.baseBySafeBox), ...Object.keys(rightHaff.baseBySafeBox)])) {
      if (leftHaff.baseBySafeBox[safeBox] === undefined || rightHaff.baseBySafeBox[safeBox] === undefined) result.errors.push(`${path}.haff.baseBySafeBox.${safeBox}`);
      else {
        const leftSpread = leftHaff.spreadDelta ?? "0";
        const rightSpread = rightHaff.spreadDelta ?? "0";
        const leftEffective = pricingEffectiveHaff(leftHaff.baseBySafeBox[safeBox], leftSpread);
        const rightEffective = pricingEffectiveHaff(rightHaff.baseBySafeBox[safeBox], rightSpread);
        if (leftEffective === null || rightEffective === null || subtractDecimal(rightEffective, leftEffective).value < 0n) result.errors.push(`${path}.haff.${safeBox}.not_monotonic`);
      }
    }
    const itemIds = new Set([...Object.keys(left.materials), ...Object.keys(right.materials)]);
    for (const itemId of itemIds) {
      const lower = left.materials[itemId];
      const higher = right.materials[itemId];
      if (!lower || !higher || notPriced(lower) || notPriced(higher)) { result.publishable = false; continue; }
      if (lower.unit !== higher.unit || lower.unitQuantity !== higher.unitQuantity) result.errors.push(`${path}.materials.${itemId}.contract_mismatch`);
      if ((pricingDecimalDifference(higher.buyerUnitAmount, lower.buyerUnitAmount) ?? 0n) > 0n) result.errors.push(`${path}.materials.${itemId}.buyer_not_monotonic`);
      if ((pricingDecimalDifference(higher.ownerUnitAmount, lower.ownerUnitAmount) ?? 0n) < 0n) result.errors.push(`${path}.materials.${itemId}.owner_not_monotonic`);
    }
  };
  for (let index = 1; index < NORMAL_GROWTH_TIERS.length; index += 1) {
    const lower = value?.tiers?.[NORMAL_GROWTH_TIERS[index - 1]!];
    const higher = value?.tiers?.[NORMAL_GROWTH_TIERS[index]!];
    if (!lower || !higher) continue;
    if (lower.tenantDeposit === "WAIVED" && higher.tenantDeposit !== "WAIVED") result.errors.push(`tiers.${higher.tier}.tenantDeposit.not_monotonic`);
    for (const mode of ["ordinary", "custom", "fast"] as const) comparePricing(lower.pricing[mode], higher.pricing[mode], `pricing.${mode}.${higher.tier}`);
  }
  result.publishable = result.publishable && result.errors.length === 0 && value?.status === "APPROVED" && !result.warnings.some((warning) => warning.includes("cost_basis_missing"));
  result.valid = result.errors.length === 0;
  return result;
}

export function assertValidBenefitPolicy(policy: GrowthBenefitPolicy): void {
  const result = validateBenefitPolicy(policy);
  if (!result.valid) fail("INVALID_BENEFIT_POLICY", result.errors.join(","));
}

export function assertPublishableBenefitPolicy(policy: GrowthBenefitPolicy): void {
  const result = validateBenefitPolicy(policy);
  if (!result.valid || !result.publishable) fail("BENEFIT_POLICY_NOT_PUBLISHABLE", [...result.errors, ...result.warnings].join(","));
}

export type EntitlementKind = "FRIEND" | "PRESTIGE";
export type EntitlementCandidate = {
  id?: string;
  userId: string;
  kind: EntitlementKind;
  scopeKey: string;
  startsAt: string;
  endsAt: string;
  pricing: GrowthPricingContract;
  depositWaived?: boolean;
  reason: string;
  requestedBy: string;
};

export type EntitlementValidation = { valid: boolean; errors: string[]; depositWaived: boolean };

function pricingWithinCap(candidate: GrowthPricingContract, cap: GrowthPricingContract): boolean {
  if (JSON.stringify(candidate) === JSON.stringify(cap)) return true;
  if (candidate.mode !== cap.mode || candidate.priceVersionId !== cap.priceVersionId) return false;
  if (notPriced(candidate.haff) || notPriced(cap.haff)) return false;
  const higher = (left: string, right: string) => subtractDecimal(parseNonNegativeDecimal(left, 8, "pricing"), parseNonNegativeDecimal(right, 8, "pricing")).value > 0n;
  const lower = (left: string, right: string) => subtractDecimal(parseNonNegativeDecimal(left, 8, "pricing"), parseNonNegativeDecimal(right, 8, "pricing")).value < 0n;
  const candidateSpread = candidate.haff.spreadDelta;
  const capSpread = cap.haff.spreadDelta;
  if (candidateSpread !== undefined || capSpread !== undefined) {
    if (candidateSpread === undefined || capSpread === undefined) return false;
    if (subtractDecimal(parseNonNegativeDecimal(candidateSpread, 8, "pricing"), parseNonNegativeDecimal(capSpread, 8, "pricing")).value !== 0n) return false;
  }
  for (const safeBox of Object.keys(candidate.haff.baseBySafeBox)) {
    const candidateBase = candidate.haff.baseBySafeBox[safeBox];
    const capBase = cap.haff.baseBySafeBox[safeBox];
    if (candidateBase === undefined || capBase === undefined || higher(candidateBase, capBase)) return false;
  }
  for (const [itemId, candidateMaterial] of Object.entries(candidate.materials)) {
    const capMaterial = cap.materials[itemId];
    if (!capMaterial || notPriced(candidateMaterial) || notPriced(capMaterial)) return false;
    if (candidateMaterial.unit !== capMaterial.unit || candidateMaterial.unitQuantity !== capMaterial.unitQuantity) return false;
    if (lower(candidateMaterial.buyerUnitAmount, capMaterial.buyerUnitAmount) || lower(candidateMaterial.ownerUnitAmount, capMaterial.ownerUnitAmount)) return false;
  }
  return true;
}

export function validateEntitlementCandidate(candidate: EntitlementCandidate, _membershipTier: GrowthTier, policy: GrowthBenefitPolicy): EntitlementValidation {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.userId)) errors.push("userId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(candidate.scopeKey)) errors.push("scopeKey");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(candidate.requestedBy)) errors.push("requestedBy");
  if (candidate.reason.trim().length < 2 || candidate.reason.length > 500) errors.push("reason");
  const startsAt = parseInstant(candidate.startsAt, "startsAt");
  const endsAt = parseInstant(candidate.endsAt, "endsAt");
  if (endsAt <= startsAt || endsAt - startsAt > GROWTH_WINDOW_US) errors.push("duration");
  const cap = candidate.kind === "FRIEND" ? "GOLD" : "DIAMOND";
  const capConfig = policy.tiers[cap];
  const pricing = candidate.pricing;
  const capPricing = capConfig.entitlementCap;
  const strict: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
  validatePricingContract(pricing, "candidate.pricing", strict);
  const pricingValid = strict.errors.length === 0 && strict.warnings.length === 0;
  if (!pricingValid) errors.push("pricingInvalid");
  if (notPriced(capPricing)) errors.push("costBasisMissing");
  else if (pricingValid) {
    const capStrict: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
    validatePricingContract(capPricing, "cap.pricing", capStrict);
    if (capStrict.errors.length > 0 || capStrict.warnings.length > 0 || !pricingWithinCap(pricing, capPricing)) errors.push("pricingBeyondPolicy");
  }
  return { valid: errors.length === 0, errors, depositWaived: candidate.depositWaived === true };
}

export type ExistingEntitlement = EntitlementCandidate & { status: "PENDING" | "APPROVED_PENDING_EXECUTION" | "EXECUTED_PENDING_START" | "ACTIVE" | "EXPIRED" | "REPLACED" | "REVOKED" };

export function hasOverlappingEntitlement(existing: readonly ExistingEntitlement[], candidate: EntitlementCandidate): boolean {
  const start = parseInstant(candidate.startsAt, "startsAt");
  const end = parseInstant(candidate.endsAt, "endsAt");
  return existing.some((item) => item.userId === candidate.userId && item.scopeKey === candidate.scopeKey && item.status !== "REVOKED" && item.status !== "REPLACED" && item.id !== candidate.id && start < parseInstant(item.endsAt, "endsAt") && end > parseInstant(item.startsAt, "startsAt"));
}

export function entitlementStateAt(entitlement: Pick<ExistingEntitlement, "startsAt" | "endsAt" | "status">, at: string): ExistingEntitlement["status"] {
  if (entitlement.status === "REVOKED" || entitlement.status === "REPLACED") return entitlement.status;
  if (entitlement.status === "PENDING" || entitlement.status === "APPROVED_PENDING_EXECUTION") return entitlement.status;
  const instant = parseInstant(at, "at");
  if (entitlement.status === "EXECUTED_PENDING_START" && instant < parseInstant(entitlement.startsAt, "startsAt")) return "EXECUTED_PENDING_START";
  if (instant >= parseInstant(entitlement.endsAt, "endsAt")) return "EXPIRED";
  return entitlement.status === "EXPIRED" ? "EXPIRED" : "ACTIVE";
}

export type OfferBinding = {
  userId: string;
  accountId: string;
  ownerUserId: string;
  listingVersionId: string;
  ruleReleaseId: string;
  quantityDigest: string;
};

export type GrowthOfferPlan = {
  source: "GROWTH" | "FRIEND" | "PRESTIGE";
  rentalTotalCents: string;
  depositCents: string | null;
  depositWaived: boolean;
  priceVersion: string;
  benefitVersion: string;
  binding: OfferBinding;
  entitlementId?: string;
  validUntil?: string | null;
};

export function quoteToGrowthOfferPlan(quote: InternalQuote, input: Omit<GrowthOfferPlan, "rentalTotalCents" | "depositCents" | "depositWaived" | "priceVersion"> & { source: GrowthOfferPlan["source"] }): GrowthOfferPlan {
  const depositCents = quote.tenantDeposit === null ? null : parseMoneyCents(quote.tenantDeposit.amount, "tenantDeposit").toString();
  return { ...input, priceVersion: quote.priceVersionId, rentalTotalCents: parseMoneyCents(quote.resourceTotal.amount, "resourceTotal").toString(), depositCents, depositWaived: depositCents === "0" };
}

export type GrowthOfferBuildInput = {
  quote: QuoteInput;
  source: GrowthOfferPlan["source"];
  benefitVersion: string;
  binding: OfferBinding;
  entitlementId?: string;
  validUntil?: string | null;
  depositWaivedOverride?: boolean;
};

export function computeGrowthOfferPlan(input: GrowthOfferBuildInput): { knowledge: "KNOWN"; plan: GrowthOfferPlan } | { knowledge: "UNKNOWN"; reason: "QUOTE_UNAVAILABLE"; reasonCodes: string[] } {
  const result = computeDeltaQuote(input.quote);
  if (!result.quotable) return { knowledge: "UNKNOWN", reason: "QUOTE_UNAVAILABLE", reasonCodes: result.reasonCodes };
  const plan = quoteToGrowthOfferPlan(result.quote, {
    source: input.source,
    benefitVersion: input.benefitVersion,
    binding: input.binding,
    ...(input.entitlementId === undefined ? {} : { entitlementId: input.entitlementId }),
    ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
  });
  return { knowledge: "KNOWN", plan: input.depositWaivedOverride === true ? { ...plan, depositWaived: true } : plan };
}

export type OfferChoice =
  | { knowledge: "KNOWN"; selected: GrowthOfferPlan; depositCents: string | null; priceBasis: GrowthOfferPlan["source"]; depositBasis: GrowthOfferPlan["source"] | "UNKNOWN" }
  | { knowledge: "UNKNOWN"; reason: "NO_VALID_PLAN" | "DEPOSIT_UNKNOWN" | "BINDING_MISMATCH" };

export function chooseCompleteOffer(plans: readonly GrowthOfferPlan[], asOf: string): OfferChoice {
  const now = parseInstant(asOf, "asOf");
  const valid = plans.filter((plan) => plan.validUntil === undefined || plan.validUntil === null || parseInstant(plan.validUntil, "validUntil") > now);
  if (valid.length === 0) return { knowledge: "UNKNOWN", reason: "NO_VALID_PLAN" };
  const bindingKey = (binding: OfferBinding) => JSON.stringify(binding);
  const firstBinding = valid[0]!.binding;
  if (!firstBinding || valid.some((plan) => !plan.binding || bindingKey(plan.binding) !== bindingKey(firstBinding))) return { knowledge: "UNKNOWN", reason: "BINDING_MISMATCH" };
  for (const plan of valid) {
    parseCents(plan.rentalTotalCents, "rentalTotalCents", false);
    if (plan.depositCents !== null) parseCents(plan.depositCents, "depositCents", false);
  }
  const selected = [...valid].sort((a, b) => {
    const amount = parseCents(a.rentalTotalCents, "rentalTotalCents", false) - parseCents(b.rentalTotalCents, "rentalTotalCents", false);
    if (amount !== 0n) return amount < 0n ? -1 : 1;
    return a.source === "GROWTH" ? -1 : b.source === "GROWTH" ? 1 : 0;
  })[0]!;
  const waiver = valid.find((plan) => plan.depositWaived);
  const depositBasis = waiver?.source ?? (selected.depositCents === null ? "UNKNOWN" : selected.source);
  if (depositBasis === "UNKNOWN") return { knowledge: "UNKNOWN", reason: "DEPOSIT_UNKNOWN" };
  return { knowledge: "KNOWN", selected, priceBasis: selected.source, depositBasis, depositCents: waiver ? "0" : selected.depositCents };
}
