import type { PoolClient } from "pg";

import { SecurityApiError } from "./security-core";
import { readMembershipGrowthBatch } from "./membership-growth-integration";

/** 目录显示的会员等级：与详情/快速核对使用同一投影、同一 asOf。 */
export type DirectoryMembershipTier =
  | "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND" | "BLACK_GOLD" | "UNKNOWN";

/** 等级筛选值：PENDING 表示投影未确知（不是普通会员）。 */
export const DIRECTORY_MEMBERSHIP_TIERS = ["PENDING", "STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "BLACK_GOLD"] as const;
export type DirectoryMembershipTierFilter = (typeof DIRECTORY_MEMBERSHIP_TIERS)[number];

/**
 * 可能“已确知”等级的用户集合：原生零贡献注册用户、持久化了旧源覆盖回执的用户、有成长贡献的用户。
 * 其余用户按同一完备性判定只能是待核，因此这个集合是投影可能返回 KNOWN 的全集。
 */
const CANDIDATE_SQL = `SELECT u.id FROM zzsh_auth_user."user" u
  WHERE EXISTS (SELECT 1 FROM zzsh_iam.membership_growth_contribution c WHERE c.user_id = u.id)
     OR EXISTS (SELECT 1 FROM zzsh_iam.membership_growth_legacy_coverage l WHERE l.user_id = u.id)
     OR (NOT EXISTS (SELECT 1 FROM zzsh_iam.audit_event e WHERE e.object_id = u.id AND e.action = 'user.legacy_owner.migrated' AND e.outcome = 'SUCCESS')
         AND EXISTS (SELECT 1 FROM zzsh_iam.user_rental_membership m WHERE m.user_id = u.id AND m.source_ref = 'registration:v1')
         AND NOT EXISTS (SELECT 1 FROM zzsh_order.rental_order o WHERE o.renter_user_id = u.id))`;

/** 投影规模上限：超出说明投影还没有可查询的等价层，本包不静默降级成全量逐人读取。 */
export const DIRECTORY_MEMBERSHIP_CANDIDATE_LIMIT = 50_000;

export type KnownMembershipTiers = {
  /** 已确知等级：userId -> 等级。 */
  known: Map<string, DirectoryMembershipTier>;
  /** 候选规模。 */
  candidateCount: number;
};

/**
 * 计算目录中已确知会员等级的用户与等级，使用与列表/快速核对/详情完全相同的批量投影。
 * 不逐用户调用完整 reader，也不使用旧的 growth_state 字段绕过完备性判定。
 */
export async function readKnownMembershipTiers(client: PoolClient, asOfUtc: string): Promise<KnownMembershipTiers> {
  const candidates = (await client.query<{ id: string }>(CANDIDATE_SQL)).rows.map((row) => row.id);
  const known = new Map<string, DirectoryMembershipTier>();
  if (candidates.length === 0) return { known, candidateCount: 0 };
  if (candidates.length > DIRECTORY_MEMBERSHIP_CANDIDATE_LIMIT) {
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Membership tier filter is not available at the current projection size");
  }
  const projections = await readMembershipGrowthBatch(client, candidates, asOfUtc);
  for (const [userId, projection] of projections) {
    if (projection.growth.knowledge !== "KNOWN") continue;
    const tier = projection.growth.effectiveTier;
    known.set(userId, (tier ?? "UNKNOWN") as DirectoryMembershipTier);
  }
  return { known, candidateCount: candidates.length };
}
