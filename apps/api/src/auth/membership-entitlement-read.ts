import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, type EffectiveAdminAccess } from "./admin-authorization";
import { assertGameScopeUsable, gameScopeSignature, gameScopeSql, readAdminGameScope, scopeAllowsGame } from "./admin-scope";
import { entitlementCapForMode, entitlementPricingSummary, isNotPriced, isTotalDiscountContract, parseDepositAllowanceCents, sealedEnabledRentalModes, validateBenefitPolicy, type EntitlementRanges, type GrowthBenefitPolicy } from "./membership-growth";
import { membershipGrowthEnabled, normalizeGrowthInstant } from "./membership-growth-integration";
import { SecurityApiError } from "./security-core";
import { readDirectoryUserSummaries } from "./user-directory-summary";
import { canonicalize } from "../supply/content-hash";
import { projectUnifiedMembershipPricing } from "./membership-unified-pricing";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATES = ["PENDING", "APPROVED_PENDING_EXECUTION", "EXECUTED_PENDING_START", "ACTIVE", "EXPIRED", "REPLACED", "REVOKED"] as const;
export type MembershipEntitlementQuery = { page: number; pageSize: number; status?: string; kind?: "FRIEND" | "PRESTIGE"; userId?: string; gameId?: string; contextKey?: string };
type Viewer = { adminId: string; access: EffectiveAdminAccess };
const invalid = () => new SecurityApiError(400, "INVALID_ARGUMENT", "Entitlement query is invalid");

export async function readMembershipEntitlementOptions(client: PoolClient, viewer: Viewer) {
  const canRequest = viewer.access.isBoss || hasPermission(viewer.access, ADMIN_PERMISSION.approvalRequestCreate) && hasPermission(viewer.access, ADMIN_PERMISSION.membershipEntitlementRequest);
  const canRead = viewer.access.isBoss || hasPermission(viewer.access, ADMIN_PERMISSION.membershipGrowthSummaryRead);
  if (!canRequest && !canRead) throw new SecurityApiError(403, "FORBIDDEN", "Membership entitlement permission is required");
  const scope = await readAdminGameScope(client, viewer.adminId);
  assertGameScopeUsable(scope, viewer.access.isBoss);
  const games = (await client.query<{ id: string; name: string }>(
    `SELECT g.id,g.name FROM zzsh_supply.game g WHERE ${gameScopeSql("g.id", "$1", "$2")} ORDER BY (g.current_release_id IS NOT NULL) DESC,g.name,g.id`,
    [viewer.adminId, viewer.access.isBoss],
  )).rows;
  return { schema: "membership-entitlement-options.v1", games, capability: { canRead, canRequest } };
}

export function parseMembershipEntitlementQuery(query: URLSearchParams): MembershipEntitlementQuery {
  const fields = ["page", "pageSize", "status", "kind", "userId", "gameId", "contextKey"];
  for (const key of query.keys()) if (!fields.includes(key) || query.getAll(key).length !== 1) throw invalid();
  const positive = (key: string, fallback: number, max: number) => {
    const value = query.get(key); if (value === null) return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw invalid();
    return Number(value);
  };
  const result: MembershipEntitlementQuery = { page: positive("page", 1, 1_000_000), pageSize: positive("pageSize", 20, 100) };
  for (const key of ["userId", "gameId"] as const) {
    const value = query.get(key); if (value !== null) { if (!ID.test(value)) throw invalid(); result[key] = value; }
  }
  const status = query.get("status"), kind = query.get("kind"), contextKey = query.get("contextKey");
  if (status !== null) { if (!(STATES as readonly string[]).includes(status)) throw invalid(); result.status = status; }
  if (kind !== null) { if (kind !== "FRIEND" && kind !== "PRESTIGE") throw invalid(); result.kind = kind; }
  if (contextKey !== null) { if (!/^[a-f0-9]{64}$/.test(contextKey)) throw invalid(); result.contextKey = contextKey; }
  return result;
}

/** One statement gives count and page the same snapshot, filters and current game authorization. */
async function entitlementPage(client: PoolClient, viewer: Viewer, query: MembershipEntitlementQuery, asOfUtc: string) {
  const scope = await readAdminGameScope(client, viewer.adminId);
  assertGameScopeUsable(scope, viewer.access.isBoss);
  const contextKey = createHash("sha256").update(canonicalize({ adminId: viewer.adminId, boss: viewer.access.isBoss, permissions: [...viewer.access.permissions].sort(), scope: gameScopeSignature(scope), status: query.status ?? null, kind: query.kind ?? null, userId: query.userId ?? null, gameId: query.gameId ?? null, pageSize: query.pageSize })).digest("hex");
  if (query.contextKey !== undefined && query.contextKey !== contextKey) throw new SecurityApiError(409, "CONFLICT", "Entitlement query or authorization changed; reload the first page");
  const result = (await client.query<{ total: string; items: Array<Record<string, unknown>> }>(
    `WITH visible AS (
       SELECT e.id,e.starts_at, CASE WHEN e.status IN ('REVOKED','REPLACED','PENDING','APPROVED_PENDING_EXECUTION') THEN e.status
         WHEN $3::timestamptz>=e.ends_at THEN 'EXPIRED'
         WHEN e.status='EXECUTED_PENDING_START' AND $3::timestamptz<e.starts_at THEN 'EXECUTED_PENDING_START'
         WHEN e.status='EXPIRED' THEN 'EXPIRED' ELSE 'ACTIVE' END AS effective_status
       FROM zzsh_iam.membership_entitlement e WHERE ${gameScopeSql("e.game_id", "$1", "$2")}
         AND ($5::text IS NULL OR e.kind=$5) AND ($6::text IS NULL OR e.user_id=$6) AND ($7::text IS NULL OR e.game_id=$7)
     ), matched AS MATERIALIZED (SELECT * FROM visible WHERE $4::text IS NULL OR effective_status=$4), page_keys AS (
       SELECT * FROM matched ORDER BY starts_at DESC,id DESC LIMIT $8 OFFSET $9
     ), page AS (
       SELECT e.id,e.user_id AS "userId",e.game_id AS "gameId",e.kind,e.scope_key AS "scopeKey",e.starts_at::text AS "startsAtUtc",e.ends_at::text AS "endsAtUtc",
         k.effective_status AS status,e.deposit_waived AS "depositWaived",e.deposit_allowance_cents::text AS "depositAllowanceCents",e.pricing_payload AS "pricingPayload",e.approved_policy_id AS "approvedPolicyId",e.approval_request_id AS "approvalRequestId"
       FROM page_keys k JOIN zzsh_iam.membership_entitlement e ON e.id=k.id
     ) SELECT (SELECT count(*)::text FROM matched) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('gameName',g.name) ORDER BY p."startsAtUtc"::timestamptz DESC,p.id DESC)
       FROM page p LEFT JOIN zzsh_supply.game g ON g.id=p."gameId"),'[]'::jsonb) AS items`,
    [viewer.adminId, viewer.access.isBoss, asOfUtc, query.status ?? null, query.kind ?? null, query.userId ?? null, query.gameId ?? null, query.pageSize, (query.page - 1) * query.pageSize],
  )).rows[0];
  if (!result || !Array.isArray(result.items) || !/^[0-9]+$/.test(result.total) || !Number.isSafeInteger(Number(result.total))) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Entitlement records are unavailable");
  const summaries = await readDirectoryUserSummaries(client, result.items.map((row) => String(row.userId)), viewer.access.permissions);
  return {
    schema: "membership-entitlements.v1" as const, asOfUtc, total: Number(result.total), page: query.page, pageSize: query.pageSize, contextKey,
    items: result.items.map(({ pricingPayload, ...row }) => ({ ...row, depositAllowanceCents: parseDepositAllowanceCents(row.depositAllowanceCents ?? undefined, row.depositWaived), startsAtUtc: normalizeGrowthInstant(String(row.startsAtUtc), "startsAt"), endsAtUtc: normalizeGrowthInstant(String(row.endsAtUtc), "endsAt"), userSummary: summaries.get(String(row.userId)) ?? null, pricingSummary: entitlementPricingSummary(pricingPayload) })),
  };
}

export async function readMembershipEntitlements(client: PoolClient, viewer: Viewer, query: MembershipEntitlementQuery) {
  if (!viewer.access.isBoss && !hasPermission(viewer.access, ADMIN_PERMISSION.membershipGrowthSummaryRead)) throw new SecurityApiError(403, "FORBIDDEN", "Entitlement summary permission is required");
  return entitlementPage(client, viewer, query, new Date().toISOString());
}

export type ApprovedMembershipMeta = { id: string; version: string; effectiveAtUtc: string; ruleReleaseId: string; priceVersionId: string; payloadHash: string; sourceRef: string };
export async function readApprovedMembershipPolicy(client: PoolClient, asOfUtc = new Date().toISOString(), gameId: string | null = null) {
  const row = (await client.query<ApprovedMembershipMeta & { policy: GrowthBenefitPolicy; haffRule: unknown }>(
    `SELECT pol.id,pol.version::text AS version,pol.effective_at::text AS "effectiveAtUtc",pol.rule_release_id AS "ruleReleaseId",pol.price_version_id AS "priceVersionId",pol.payload_hash AS "payloadHash",pol.source_ref AS "sourceRef",pol.policy_payload AS policy,p.haff_rule AS "haffRule"
     FROM zzsh_iam.membership_growth_policy pol JOIN zzsh_supply.rule_release r ON r.id=pol.rule_release_id
     JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.id=pol.price_version_id AND p.status='SEALED'
     WHERE pol.status='APPROVED' AND pol.effective_at<=$1::timestamptz AND ($2::text IS NULL OR r.game_id=$2) ORDER BY pol.version DESC,pol.created_at DESC LIMIT 1`, [asOfUtc, gameId],
  )).rows[0];
  return row ? { ...row, effectiveAtUtc: normalizeGrowthInstant(row.effectiveAtUtc, "effectiveAt") } : null;
}

export async function readMembershipEntitlementContext(client: PoolClient, viewer: Viewer, userId: string, gameId: string) {
  if (!ID.test(userId) || !ID.test(gameId)) throw invalid();
  const canRequest = viewer.access.isBoss || hasPermission(viewer.access, ADMIN_PERMISSION.approvalRequestCreate) && hasPermission(viewer.access, ADMIN_PERMISSION.membershipEntitlementRequest);
  if (!canRequest) throw new SecurityApiError(403, "FORBIDDEN", "Entitlement request permission is required");
  const scope = await readAdminGameScope(client, viewer.adminId);
  if (!scopeAllowsGame(scope, viewer.access.isBoss, gameId)) throw new SecurityApiError(403, "FORBIDDEN", "Entitlement game is outside the administrator scope");
  const subject = (await client.query<{ id: string }>(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1`, [userId])).rows[0];
  const game = (await client.query<{ id: string; name: string }>(`SELECT id,name FROM zzsh_supply.game WHERE id=$1`, [gameId])).rows[0];
  if (!subject || !game) throw new SecurityApiError(404, "NOT_FOUND", "Entitlement recipient or game is unavailable");
  const asOfUtc = new Date().toISOString(), approved = await readApprovedMembershipPolicy(client, asOfUtc, gameId);
  const enabled = approved ? sealedEnabledRentalModes(approved.haffRule) : null;
  const policyReady = approved && enabled && validateBenefitPolicy(approved.policy, { enabledModes: enabled }).publishable;
  let ranges: EntitlementRanges | null = null;
  if (policyReady) {
    if (approved.policy.entitlementRanges !== undefined) {
      ranges = { FRIEND: { byMode: {} }, PRESTIGE: { byMode: {} } };
      for (const kind of ["FRIEND", "PRESTIGE"] as const) for (const mode of enabled) {
        const entry = approved.policy.entitlementRanges[kind].byMode[mode];
        if (entry && !isNotPriced(entry)) ranges[kind].byMode[mode] = { status: "CONFIGURED", kind: "TOTAL_DISCOUNT_RANGE", mode, priceVersionId: entry.priceVersionId, minPayableRatio: entry.minPayableRatio, maxPayableRatio: entry.maxPayableRatio, costBasisRef: entry.costBasisRef };
      }
    }
    else {
      ranges = { FRIEND: { byMode: {} }, PRESTIGE: { byMode: {} } };
      for (const kind of ["FRIEND", "PRESTIGE"] as const) for (const mode of enabled) {
        const cap = entitlementCapForMode(approved.policy.tiers[kind === "FRIEND" ? "GOLD" : "DIAMOND"].entitlementCap, mode);
        ranges[kind].byMode[mode] = cap && !isNotPriced(cap) && isTotalDiscountContract(cap)
          ? { status: "CONFIGURED", kind: "TOTAL_DISCOUNT_RANGE", mode, priceVersionId: cap.priceVersionId, minPayableRatio: cap.payableRatio, maxPayableRatio: "1", costBasisRef: cap.costBasisRef }
          : { status: "NOT_PRICED", reason: "LEGACY_PRICING_REQUIRES_REVIEW" };
      }
    }
  }
  const usable = ranges && Object.values(ranges).some((range) => Object.values(range.byMode).some((entry) => entry?.status === "CONFIGURED"));
  const unifiedPricing = projectUnifiedMembershipPricing(policyReady ? approved.policy : null, enabled);
  const unifiedRanges = unifiedPricing.entitlementRanges;
  const unifiedUsable = Object.values(unifiedRanges).some(range => range.knowledge === "KNOWN");
  const meta: ApprovedMembershipMeta | null = approved ? { id: approved.id, version: approved.version, effectiveAtUtc: approved.effectiveAtUtc, ruleReleaseId: approved.ruleReleaseId, priceVersionId: approved.priceVersionId, payloadHash: approved.payloadHash, sourceRef: approved.sourceRef } : null;
  const existing = await entitlementPage(client, viewer, { userId, gameId, page: 1, pageSize: 100 }, asOfUtc);
  const summary = existing.items.find((item) => item.userSummary)?.userSummary ?? (await readDirectoryUserSummaries(client, [userId], viewer.access.permissions)).get(userId);
  const reasonCode = !membershipGrowthEnabled() ? "FEATURE_DISABLED" : !approved ? "POLICY_UNAVAILABLE" : !usable ? "RANGE_UNAVAILABLE" : !unifiedUsable ? "UNIFIED_RANGE_REQUIRED" : "OK";
  return { schema: "membership-entitlement-context.v1" as const, pricingScope: "ALL_ENABLED_RENTAL_MODES" as const, subject: { userId, name: null, image: null, maskedPhone: null, ...summary }, game, approvedMeta: meta, ranges, unifiedRanges, rangeSource: !ranges ? null : approved?.policy.entitlementRanges !== undefined ? "INDEPENDENT" : "LEGACY_TIER_CAP", capability: { canRequest: reasonCode === "OK", reasonCode, unifiedPricingSupported: true, requiresUnifiedPricing: true }, existingEntitlements: existing.items };
}
