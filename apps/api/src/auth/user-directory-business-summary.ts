import type { PoolClient } from "pg";
import { gameScopeSql } from "./admin-scope";
import { readMembershipGrowthBatch, type GrowthEntitlementSummary, type GrowthProjectionDto } from "./membership-growth-integration";
import { SecurityApiError } from "./security-core";
import type { AdminDirectoryViewer } from "./user-directory";

export type MembershipSummary = {
  state: "ready";
  asOfUtc: string;
  growth: Pick<GrowthProjectionDto, "knowledge" | "sourceState" | "benefitsState" | "normalTier" | "effectiveTier" | "blackGold" | "grace">;
  entitlements: GrowthEntitlementSummary[];
} | { state: "denied"; permission: "membership.growth.read.summary" };

export type CreditSummary = {
  state: "ready";
  knowledge: "KNOWN" | "NOT_INITIALIZED";
  score: number | null;
  revision: string | null;
} | { state: "denied"; permission: "credit.read"; reason?: "NO_GAME_SCOPE" | "OUT_OF_SCOPE" };

export type UserDirectoryBusinessSummary = { membershipSummary: MembershipSummary; creditSummary: CreditSummary };
export type UserDirectoryBusinessViewer = Pick<AdminDirectoryViewer, "adminId" | "isBoss"> & {
  membershipSummaryRead?: boolean;
  creditRead?: boolean;
  businessScopeUsable?: boolean;
};

const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "User business summary is unavailable");

/** Shared by credit filters and their list/detail projection; legacy scope is unchanged. */
export function directoryCreditScopeSql(userColumn:string,adminParam:string,bossParam:string):string {
  return `(${bossParam}::boolean OR EXISTS(SELECT 1 FROM zzsh_supply.rental_account a WHERE a.owner_user_id=${userColumn} AND ${gameScopeSql("a.game_id",adminParam,bossParam)})
    OR EXISTS(SELECT 1 FROM zzsh_order.rental_order o WHERE (o.owner_user_id=${userColumn} OR o.renter_user_id=${userColumn}) AND ${gameScopeSql("o.game_id",adminParam,bossParam)}))`;
}

/** Orphan events are inconsistent evidence, never a clean not-initialized credit account. */
export function directoryCreditNotInitializedSql(userColumn:string):string {
  return `(NOT EXISTS(SELECT 1 FROM zzsh_credit.user_credit_state c WHERE c.user_id=${userColumn})
    AND NOT EXISTS(SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=${userColumn}))`;
}

/** Caller supplies the authorized page IDs and the same read transaction for list and detail. */
export async function readUserDirectoryBusinessSummaries(client: PoolClient, viewer: UserDirectoryBusinessViewer, userIds: readonly string[], asOfUtc = new Date().toISOString()): Promise<Map<string, UserDirectoryBusinessSummary>> {
  const ids = [...new Set(userIds)], summaries = new Map<string, UserDirectoryBusinessSummary>();
  for (const id of ids) summaries.set(id, {
    membershipSummary: { state: "denied", permission: "membership.growth.read.summary" },
    creditSummary: { state: "denied", permission: "credit.read", ...(viewer.creditRead && !viewer.isBoss && viewer.businessScopeUsable === false ? { reason: "NO_GAME_SCOPE" } : {}) },
  });
  if (ids.length === 0) return summaries;
  if (viewer.membershipSummaryRead) {
    const memberships = await readMembershipGrowthBatch(client, ids, asOfUtc);
    for (const id of ids) {
      const membership = memberships.get(id);
      if (!membership) throw unavailable();
      const { knowledge, sourceState, benefitsState, normalTier, effectiveTier, blackGold, grace } = membership.growth;
      summaries.get(id)!.membershipSummary = {
        state: "ready", asOfUtc: membership.growth.asOfUtc,
        growth: { knowledge, sourceState, benefitsState, normalTier, effectiveTier, blackGold, grace },
        entitlements: membership.entitlements.filter(entitlement => entitlement.status === "ACTIVE"),
      };
    }
  }
  if (viewer.creditRead && (viewer.isBoss || viewer.businessScopeUsable !== false)) {
    const rows = (await client.query<{ userId: string; score: number | null; revision: string | null; inScope: boolean; notInitialized:boolean }>(
      `SELECT /* directory-credit-summaries */ target.user_id AS "userId",c.score,c.revision::text AS revision,
       ${directoryCreditScopeSql("target.user_id","$2","$3")} AS "inScope",
       ${directoryCreditNotInitializedSql("target.user_id")} AS "notInitialized"
       FROM unnest($1::text[]) target(user_id) LEFT JOIN zzsh_credit.user_credit_state c ON c.user_id=target.user_id`, [ids, viewer.adminId, viewer.isBoss],
    )).rows;
    for (const id of ids) {
      const row = rows.find(value => value.userId === id);
      if (!row || typeof row.inScope !== "boolean") throw unavailable();
      if (!row.inScope) summaries.get(id)!.creditSummary = { state: "denied", permission: "credit.read", reason: "OUT_OF_SCOPE" };
      else if (row.revision === null && row.score === null) {
        if(row.notInitialized!==true)throw unavailable();
        summaries.get(id)!.creditSummary = { state: "ready", knowledge: "NOT_INITIALIZED", score: null, revision: null };
      }
      else {
        if (typeof row.score !== "number" || !Number.isInteger(row.score) || typeof row.revision !== "string" || !/^[1-9]\d*$/.test(row.revision)) throw unavailable();
        summaries.get(id)!.creditSummary = { state: "ready", knowledge: "KNOWN", score: row.score, revision: row.revision };
      }
    }
  }
  return summaries;
}
