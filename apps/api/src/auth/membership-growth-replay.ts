/** 等级阈值与贡献回放。从 membership-growth 原样移出，判定不变。 */
import {
  fail,
  formatInstant,
  GRACE_WINDOW_US,
  GROWTH_WINDOW_US,
  MEMBERSHIP_GROWTH_SCHEMA,
  parseCents,
  parseId,
  parseInstant,
  roundHalfUpCents,
} from "./membership-growth-money";

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

function isGrowthSourceType(value: unknown): value is GrowthSourceType {
  return value === "RENTAL_SETTLEMENT" || value === "MATERIAL_CONSUMPTION" || value === "MINIMUM_BILLING" || value === "REFUND_CORRECTION";
}

function normalRank(tier: NormalGrowthTier): number {
  return NORMAL_GROWTH_TIERS.indexOf(tier);
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
