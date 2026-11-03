import type { PoolClient } from "pg";
import { SecurityApiError } from "./security-core";
import { normalizeGrowthInstant, readMembershipGrowthTierBatch, projectAdmittedEmptyGrowthTier } from "./membership-growth-integration";
import { streamDirectoryMembershipFacts } from "./user-directory-membership-stream";
import { legacyZeroReadSubjectIds, hasLegacyZeroReadAdmission, type LegacyZeroReadAdmission } from "./membership-growth-read-admission";

export type DirectoryMembershipTier = "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND" | "BLACK_GOLD" | "UNKNOWN";
export const DIRECTORY_MEMBERSHIP_TIERS = ["PENDING", "STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "BLACK_GOLD"] as const;
export type DirectoryMembershipTierFilter = (typeof DIRECTORY_MEMBERSHIP_TIERS)[number];
export type KnownMembershipTiers = { known: Map<string, DirectoryMembershipTier>; candidateCount: number };
export type DirectoryMembershipDistribution = { asOfUtc: string; total: number; counts: Record<DirectoryMembershipTierFilter, number> };
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Membership projection evidence is unavailable");

/** The caller retains the existing directory RR/READ ONLY transaction, permissions and cancellation guard. */
async function visitDirectoryMembership(client: PoolClient, asOfUtc: string, visit: (id: string, tier: DirectoryMembershipTierFilter) => void, userId?: string): Promise<number> {
  const asOf = normalizeGrowthInstant(asOfUtc);
  let total = 0;
  let fastAdmission: LegacyZeroReadAdmission | null = null;
  const consume = async (ids: string[], snapshot?: Parameters<typeof readMembershipGrowthTierBatch>[3]) => {
    if (ids.length === 0) return;
    const projections = await readMembershipGrowthTierBatch(client, ids, asOf, snapshot);
    if (projections.size !== ids.length) throw unavailable();
    for (const id of ids) {
      const projection = projections.get(id);
      if (!projection || projection.subjectId !== id || normalizeGrowthInstant(projection.growth.asOfUtc) !== asOf) throw unavailable();
      const tier = projection.growth.knowledge === "KNOWN" ? projection.growth.effectiveTier : "PENDING";
      if (tier === null || !(DIRECTORY_MEMBERSHIP_TIERS as readonly string[]).includes(tier)) throw unavailable();
      visit(id, tier as DirectoryMembershipTierFilter);
      total++;
    }
  };
  if (userId !== undefined) {
    await consume((await client.query<{ id: string }>('SELECT u.id FROM zzsh_auth_user."user" u WHERE u.id=$1', [userId])).rows.map(row => row.id));
    return total;
  }
  for await (const chunk of streamDirectoryMembershipFacts(client, asOf)) {
    if ("kind" in chunk) {
      const ids = legacyZeroReadSubjectIds(chunk.admission, client, asOf);
      if (fastAdmission || !ids.length || normalizeGrowthInstant(chunk.asOfUtc) !== asOf) throw unavailable();
      fastAdmission = chunk.admission;
      const sample = projectAdmittedEmptyGrowthTier(ids[0]!, asOf), tier = sample.growth.effectiveTier;
      if (sample.growth.knowledge !== "KNOWN" || tier === null || tier === "UNKNOWN" || !(DIRECTORY_MEMBERSHIP_TIERS as readonly string[]).includes(tier)) throw unavailable();
      for (const id of ids) { visit(id, tier); total++; }
    } else {
      if (chunk.subjects.some(row => hasLegacyZeroReadAdmission(fastAdmission, client, asOf, row.userId))) throw unavailable();
      await consume(chunk.subjects.map(row => row.userId), chunk);
    }
  }
  return total;
}

/** Skinny server-only map for the existing directory count/sort/page SQL; no full projections survive a batch. */
export async function readKnownMembershipTiers(client: PoolClient, asOfUtc: string, userId?: string): Promise<KnownMembershipTiers> {
  const known = new Map<string, DirectoryMembershipTier>();
  const candidateCount = await visitDirectoryMembership(client, asOfUtc, (id, tier) => { if (tier !== "PENDING") known.set(id, tier); }, userId);
  return { known, candidateCount };
}

/** Growth tier distribution only. Policy benefits and current manual entitlements remain separate contracts. */
export async function readDirectoryMembershipDistribution(client: PoolClient, asOfUtc: string, userId?: string): Promise<DirectoryMembershipDistribution> {
  const counts = Object.fromEntries(DIRECTORY_MEMBERSHIP_TIERS.map(tier => [tier, 0])) as Record<DirectoryMembershipTierFilter, number>;
  const total = await visitDirectoryMembership(client, asOfUtc, (_id, tier) => { counts[tier]++; }, userId);
  return { asOfUtc: normalizeGrowthInstant(asOfUtc), total, counts };
}
