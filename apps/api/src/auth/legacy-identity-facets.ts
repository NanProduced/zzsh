/**
 * Independent identity facets for migrated users. Old manual tier, new consumption tier, courtesy (礼遇) and
 * distribution are separate facts; none derives another. Original FLOAT ratios are kept as source text.
 */
export type LegacyRatioText = { sourceText: string; sourceType: "FLOAT UNSIGNED" } | { sourceText: null; status: "SOURCE_PENDING" };
export type LegacyDistributionLevel = { legacyLevelId: string; name: string | null; selfRatio: LegacyRatioText; firstRatio: LegacyRatioText; secondRatio: LegacyRatioText; isDelete: string | null };

const FLOAT_TEXT = /^(0|[1-9]\d*)(\.\d+)?(e[+-]?\d+)?$/i;

export function legacyRatioText(raw: unknown): LegacyRatioText {
  if (raw === null || raw === undefined) return { sourceText: null, status: "SOURCE_PENDING" };
  if (typeof raw !== "string" || !FLOAT_TEXT.test(raw)) throw new Error("RATIO_SOURCE_TEXT_INVALID");
  return { sourceText: raw, sourceType: "FLOAT UNSIGNED" }; // never parseFloat / rescale / map to new shares
}

export function mapLegacyDistributionLevel(row: Record<string, unknown>): LegacyDistributionLevel {
  const id = row.legacy_level_id;
  if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)) throw new Error("LEVEL_ID_INVALID");
  return { legacyLevelId: id, name: typeof row.name === "string" ? row.name : null, selfRatio: legacyRatioText(row.self_ratio_source_text), firstRatio: legacyRatioText(row.first_ratio_source_text), secondRatio: legacyRatioText(row.second_ratio_source_text), isDelete: typeof row.is_delete === "string" ? row.is_delete : null };
}

export type ImpactSet = "RISK_11" | "ISOLATED_54" | "RETAINED_46" | "NONE";
export type LegacyIdentityInput = {
  impact: ImpactSet;
  mappedUserId: string | null;
  legacyManualTier: string | null;
  distribution: { levelId: string | null; isDistribution: string | null; isFreeze: string | null } | null;
  currentConsumptionTier: string | null;
  activeCourtesies: { id: string; grantRef: string; endsAt: string }[];
};
export type IdentityFacets = {
  subject: { mappedUserId: string | null; ownership: "MAPPED" | "NONE_ISOLATED" };
  manualTier: { legacyValue: string | null; status: "HISTORICAL_ONLY" };
  consumptionTier: { value: string | null; status: "PROJECTED" | "UNKNOWN" };
  courtesies: { id: string; grantRef: string; endsAt: string }[];
  distribution: { levelId: string | null; eligibility: "ELIGIBLE" | "NOT_ELIGIBLE" | "UNKNOWN"; commissionFrozen: boolean | null };
  restrictions: { accountSuspended: false; newOrderOrWithdrawal: "OWNER_DECISION_REQUIRED" | "NONE_PROPOSED" };
  grants: { assets: false; permissions: false };
};

const flag = (v: string | null | undefined) => (v === "1" ? true : v === "0" ? false : null);

export function mapLegacyIdentityFacets(i: LegacyIdentityInput): IdentityFacets {
  if (i.impact === "ISOLATED_54" && i.mappedUserId !== null) throw new Error("ISOLATED_SUBJECT_CANNOT_BE_MAPPED");
  if (i.activeCourtesies.some((c) => !c.grantRef)) throw new Error("COURTESY_WITHOUT_GRANT_BASIS");
  const elig = flag(i.distribution?.isDistribution);
  return {
    subject: { mappedUserId: i.mappedUserId, ownership: i.mappedUserId ? "MAPPED" : "NONE_ISOLATED" },
    manualTier: { legacyValue: i.legacyManualTier, status: "HISTORICAL_ONLY" },
    consumptionTier: { value: i.currentConsumptionTier, status: i.currentConsumptionTier ? "PROJECTED" : "UNKNOWN" },
    courtesies: i.activeCourtesies,
    distribution: { levelId: i.distribution?.levelId ?? null, eligibility: elig === null ? "UNKNOWN" : elig ? "ELIGIBLE" : "NOT_ELIGIBLE", commissionFrozen: flag(i.distribution?.isFreeze) },
    // Whole-account suspension is never derived from risk; the narrower restriction awaits the Owner.
    restrictions: { accountSuspended: false, newOrderOrWithdrawal: i.impact === "RISK_11" ? "OWNER_DECISION_REQUIRED" : "NONE_PROPOSED" },
    grants: { assets: false, permissions: false },
  };
}
