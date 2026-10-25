import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, type EffectiveAdminAccess } from "./admin-authorization";
import { assertGameScopeUsable, gameScopeSignature, gameScopeSql, readAdminGameScope, scopeAllowsGame } from "./admin-scope";
import { entitlementCapForMode, entitlementPricingSummary, isNotPriced, isTotalDiscountContract, NORMAL_GROWTH_TIERS, parseDepositAllowanceCents, sealedEnabledRentalModes, validateBenefitPolicy, type EntitlementRanges, type GrowthBenefitPolicy } from "./membership-growth";
import { membershipGrowthEnabled, normalizeGrowthInstant } from "./membership-growth-integration";
import { SecurityApiError } from "./security-core";
import { readDirectoryUserSummaries } from "./user-directory-summary";
import { canonicalize } from "../supply/content-hash";
import { projectUnifiedMembershipPricing } from "./membership-unified-pricing";
import { hashApprovalPayload, readDecisions, readRequestById, requestScope, virtualRequestStatus } from "./approval-audit";
import { membershipBusinessPermission } from "./approval-business";

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

type PolicyDraftReference = { id: string; version: string; payloadHash: string };
export type MembershipPolicyWorkspaceReference = PolicyDraftReference & { status: string; approvalRequestId?: string | null };
type PolicyChangePerson = { id: string; name: string | null };
type PolicyChangeStep = { key: "SUBMITTED" | "APPROVAL" | "EXECUTION" | "EFFECTIVE"; label: string; state: "COMPLETED" | "CURRENT" | "PENDING" | "FAILED" | "UNKNOWN"; actor: PolicyChangePerson | null; atUtc: string | null; note?: string | null };
type PolicyChangeRequest = { id: string; operationCode: string; approvalStatus: string; executionStatus: string; reason?: string | null; submittedBy?: PolicyChangePerson | null; submittedAtUtc?: string | null; plannedEffectiveAtUtc?: string | null; steps?: PolicyChangeStep[] };
type PolicyRequestedValue = { label: string; value: string | null; format: "DISCOUNT" | "CENTS" | "TEXT" };
export type MembershipPolicyChangeProjection = {
  knowledge: "KNOWN" | "UNKNOWN" | "FORBIDDEN";
  draftReference: PolicyDraftReference | null;
  request: PolicyChangeRequest | null;
  immutableDiff: null;
  requestedValues: PolicyRequestedValue[] | null;
  effectiveState: { status: "EFFECTIVE" | "PENDING_EFFECTIVE" | "NOT_EFFECTIVE" | "UNKNOWN"; effectiveAtUtc: string | null; executed: boolean } | null;
  message: string | null;
};
const POLICY_PUBLISH = "membership.benefit.policy.publish";
const policyUnknown = (request?: { id: string; operationCode: string }): MembershipPolicyChangeProjection => ({ knowledge: "UNKNOWN", draftReference: null,
  request: request ? { ...request, approvalStatus: "UNKNOWN", executionStatus: "UNKNOWN" } : null, immutableDiff: null, requestedValues: null, effectiveState: null, message: "政策变更关联或执行依据尚未核清" });
type PolicyRecord = { id: string; version: string; status: string; payloadHash: string; effectiveAtUtc: string | null; ruleReleaseId: string; priceVersionId: string; sourceRef: string; policyPayload: Record<string, unknown>; approvalRequestId?: string; approvedByAdminId?: string };
type PolicyChangeFacts = { draft: PolicyRecord | null; draftHaffRule: unknown; publishedCount: string; published: PolicyRecord | null; executionStatus: string | null; resultCode: string | null; resultDetail: string | null;
  executedBy: string | null; executedAtUtc: string | null; submittedAtUtc: string; expiresAtUtc: string; decidedAtUtc: string | null; requestedName: string | null; decidedName: string | null; executedName: string | null };

/** Requested configuration only: no baseline reconstruction, costs or current-release fallback. */
function policyRequestedValues(policy: Record<string, unknown>, originalHaffRule: unknown): PolicyRequestedValue[] {
  const rows: PolicyRequestedValue[] = [], labels = { STANDARD: "普通会员", SILVER: "银卡会员", GOLD: "金卡会员", PLATINUM: "铂金会员", DIAMOND: "钻石会员" };
  let pricing: ReturnType<typeof projectUnifiedMembershipPricing> | null = null;
  try { pricing = projectUnifiedMembershipPricing(policy as GrowthBenefitPolicy, sealedEnabledRentalModes(originalHaffRule)); } catch { /* Unverifiable original terms stay unknown; deposit facts are independent. */ }
  for (const tier of NORMAL_GROWTH_TIERS) {
    rows.push({ label: `${labels[tier]} · 应付比例`, value: pricing?.tiers[tier].knowledge === "KNOWN" ? pricing.tiers[tier].payableRatio : null, format: "DISCOUNT" });
    const config = (policy as GrowthBenefitPolicy).tiers?.[tier]; let deposit: string | null = null, allowance: string | null = null;
    try {
      if (!config || !["ACCOUNT_BASE", "WAIVED"].includes(config.tenantDeposit)) throw new Error("Unknown original deposit rule");
      const cents = parseDepositAllowanceCents(config.depositAllowanceCents, config.tenantDeposit === "WAIVED");
      deposit = config.tenantDeposit === "WAIVED" ? "完全免押" : BigInt(cents) > 0n ? "按额度减免" : "不减免";
      if (config.tenantDeposit === "ACCOUNT_BASE") allowance = cents;
    } catch { /* No zero or waiver is invented for malformed original fields. */ }
    rows.push({ label: `${labels[tier]} · 押金规则`, value: deposit, format: "TEXT" });
    if (config?.tenantDeposit === "ACCOUNT_BASE") rows.push({ label: `${labels[tier]} · 每单押金减免额度`, value: allowance, format: "CENTS" });
  }
  for (const [kind, label] of [["FRIEND", "挚友礼遇"], ["PRESTIGE", "尊享礼遇"]] as const) {
    const range = pricing?.entitlementRanges[kind];
    rows.push({ label: `${label} · 最低应付比例`, value: range?.knowledge === "KNOWN" ? range.minPayableRatio : null, format: "DISCOUNT" });
    rows.push({ label: `${label} · 最高应付比例`, value: range?.knowledge === "KNOWN" ? range.maxPayableRatio : null, format: "DISCOUNT" });
  }
  return rows;
}

/** One policy object, one caller transaction and one asOf. No history pages, candidate loops or writes. */
export async function readMembershipPolicyChange(client: PoolClient, viewer: { userId: string; access: EffectiveAdminAccess }, workspace: MembershipPolicyWorkspaceReference | null,
  currentEffectivePolicyId: string | null, evaluatedAtUtc: string): Promise<MembershipPolicyChangeProjection> {
  if (!hasPermission(viewer.access, ADMIN_PERMISSION.approvalRequestRead)) return { knowledge: "FORBIDDEN", draftReference: null, request: null, immutableDiff: null, requestedValues: null, effectiveState: null, message: "当前身份无权读取审批变更详情" };
  const draft = workspace?.status === "DRAFT" ? workspace : null;
  if (draft && (!ID.test(draft.id) || !/^[1-9]\d*$/.test(draft.version) || !/^[a-f0-9]{64}$/.test(draft.payloadHash))) return policyUnknown();
  const publishedRequestId = workspace?.status === "APPROVED" ? workspace.approvalRequestId ?? null : null;
  if (publishedRequestId !== null && !ID.test(publishedRequestId)) return policyUnknown();
  try {
    const asOf = normalizeGrowthInstant(evaluatedAtUtc, "asOf");
    const context = (await client.query<{ blockingCount: string; totalCount: string; requestId: string | null }>(
      `/* membership-policy-change-context */ WITH relevant AS MATERIALIZED (
         SELECT r.id,r.created_at,(r.status='EXECUTION_FAILED' OR r.status IN ('PENDING','APPROVED') AND r.expires_at>$2::timestamptz) AS blocking
         FROM zzsh_iam.approval_request r WHERE r.operation_code=$1 AND (
           r.status='EXECUTION_FAILED' OR r.status IN ('PENDING','APPROVED') AND r.expires_at>$2::timestamptz
           OR $3::text IS NOT NULL AND r.operation_payload->>'policyDraftId'=$3
           OR $4::text IS NOT NULL AND r.id=$4)
       ) SELECT count(*) FILTER (WHERE blocking)::text AS "blockingCount",count(*)::text AS "totalCount",
         (SELECT id FROM relevant ORDER BY blocking DESC,created_at DESC,id DESC LIMIT 1) AS "requestId" FROM relevant`,
      [POLICY_PUBLISH, asOf, draft?.id ?? null, publishedRequestId],
    )).rows[0];
    if (!context || !/^(0|[1-9]\d*)$/.test(context.blockingCount) || !/^(0|[1-9]\d*)$/.test(context.totalCount)) return policyUnknown();
    const blocking = BigInt(context.blockingCount), total = BigInt(context.totalCount);
    if (blocking > total || blocking > 1n || blocking === 0n && total > 1n) return policyUnknown();
    if (total === 0n) return context.requestId !== null || publishedRequestId !== null ? policyUnknown()
      : { knowledge: "KNOWN", draftReference: null, request: null, immutableDiff: null, requestedValues: null, effectiveState: null, message: null };
    if (typeof context.requestId !== "string" || !ID.test(context.requestId)) return policyUnknown();
    if (!await requestScope(client, viewer.userId, context.requestId, viewer.access.isBoss)) return { knowledge: "FORBIDDEN", draftReference: null, request: null, immutableDiff: null, requestedValues: null, effectiveState: null, message: "当前身份无权读取该审批变更" };
    const row = await readRequestById(client, context.requestId);
    if (!row || row.id !== context.requestId || row.operationCode !== POLICY_PUBLISH) return policyUnknown();
    if (!viewer.access.isBoss && row.requestedBy !== viewer.userId && !hasPermission(viewer.access, membershipBusinessPermission(POLICY_PUBLISH, "DECIDE")!)) {
      return { knowledge: "FORBIDDEN", draftReference: null, request: null, immutableDiff: null, requestedValues: null, effectiveState: null, message: "当前身份无权读取该会员业务详情" };
    }
    const visible = { id: row.id, operationCode: row.operationCode }, payload = row.operationPayload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !["PENDING", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED", "EXECUTED", "EXECUTION_FAILED"].includes(row.status)) return policyUnknown(visible);
    let decision: Awaited<ReturnType<typeof readDecisions>> extends Map<string, infer D> ? D | undefined : never;
    try { decision = (await readDecisions(client, [row])).get(row.id); }
    catch (error) { if (error instanceof SecurityApiError && (error.status === 400 || error.status === 409)) return policyUnknown(visible); throw error; }
    const facts = (await client.query<PolicyChangeFacts>(
      `/* membership-policy-change-facts */ WITH published AS MATERIALIZED (
         SELECT id,version::text AS version,status,payload_hash AS "payloadHash",effective_at::text AS "effectiveAtUtc",rule_release_id AS "ruleReleaseId",
           price_version_id AS "priceVersionId",source_ref AS "sourceRef",policy_payload AS "policyPayload",approval_request_id AS "approvalRequestId",approved_by_admin_id AS "approvedByAdminId"
         FROM zzsh_iam.membership_growth_policy WHERE approval_request_id=$1
       ) SELECT to_jsonb(draft) AS draft,draft_price.haff_rule AS "draftHaffRule",(SELECT count(*)::text FROM published) AS "publishedCount",(SELECT to_jsonb(p) FROM published p ORDER BY p.id LIMIT 1) AS published,
         e.status AS "executionStatus",e.result_code AS "resultCode",e.result_detail AS "resultDetail",e.executed_by AS "executedBy",e.completed_at::text AS "executedAtUtc",
         r.created_at::text AS "submittedAtUtc",r.expires_at::text AS "expiresAtUtc",a.created_at::text AS "decidedAtUtc",ru.name AS "requestedName",du.name AS "decidedName",eu.name AS "executedName"
       FROM zzsh_iam.approval_request r
       LEFT JOIN LATERAL (SELECT id,version::text AS version,status,payload_hash AS "payloadHash",effective_at::text AS "effectiveAtUtc",rule_release_id AS "ruleReleaseId",price_version_id AS "priceVersionId",source_ref AS "sourceRef",policy_payload AS "policyPayload" FROM zzsh_iam.membership_growth_policy WHERE id=$2) draft ON true
       LEFT JOIN zzsh_supply.rule_release draft_release ON draft_release.id=draft."ruleReleaseId" AND draft_release.price_version_id=draft."priceVersionId"
       LEFT JOIN zzsh_supply.price_version draft_price ON draft_price.id=draft_release.price_version_id AND draft_price.id=draft."priceVersionId" AND draft_price.status='SEALED'
       LEFT JOIN zzsh_iam.approval_decision a ON a.request_id=r.id LEFT JOIN zzsh_iam.approval_execution e ON e.request_id=r.id
       LEFT JOIN zzsh_auth_admin."user" ru ON ru.id=r.requested_by LEFT JOIN zzsh_auth_admin."user" du ON du.id=a.approver_admin_id LEFT JOIN zzsh_auth_admin."user" eu ON eu.id=e.executed_by WHERE r.id=$1`,
      [row.id, typeof payload.policyDraftId === "string" ? payload.policyDraftId : null],
    )).rows[0];
    if (!facts) return policyUnknown(visible);
    try {
      if (hashApprovalPayload(payload).hash !== row.operationPayloadHash || typeof payload.policyDraftId !== "string" || !ID.test(payload.policyDraftId)
        || typeof payload.policyDraftVersion !== "number" || !Number.isSafeInteger(payload.policyDraftVersion) || payload.policyDraftVersion < 1
        || typeof payload.policyDraftHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.policyDraftHash)
        || [payload.ruleReleaseId, payload.priceVersionId, payload.sourceRef].some(value => typeof value !== "string" || !value)) return policyUnknown(visible);
      const frozen = facts.draft;
      if (!frozen || frozen.status !== "DRAFT" || frozen.id !== payload.policyDraftId || frozen.version !== String(payload.policyDraftVersion) || frozen.payloadHash !== payload.policyDraftHash
        || frozen.ruleReleaseId !== payload.ruleReleaseId || frozen.priceVersionId !== payload.priceVersionId || frozen.sourceRef !== payload.sourceRef
        || !frozen.policyPayload || Array.isArray(frozen.policyPayload) || typeof frozen.policyPayload !== "object" || frozen.policyPayload.status !== "DRAFT") return policyUnknown(visible);
      const instant = (value: string | null): string | null => value === null ? null : normalizeGrowthInstant(value, "policyChangeTime");
      const planned = payload.effectiveAtUtc === undefined ? null : typeof payload.effectiveAtUtc === "string" ? instant(payload.effectiveAtUtc) : undefined;
      if (planned === undefined || planned !== instant(frozen.effectiveAtUtc)) return policyUnknown(visible);
      const status = virtualRequestStatus({ ...row, expiresAt: facts.expiresAtUtc }, asOf);
      const rowBlocks = status === "PENDING" || status === "APPROVED" || status === "EXECUTION_FAILED";
      if ((blocking === 1n) !== rowBlocks) return policyUnknown(visible);
      const hasDecision = ["APPROVED", "REJECTED", "EXECUTED", "EXECUTION_FAILED"].includes(row.status) || row.status === "EXPIRED" && Boolean(row.decidedBy);
      if (hasDecision && (!decision || decision.approverId !== row.decidedBy || decision.decision !== (row.status === "REJECTED" ? "REJECTED" : "APPROVED"))
        || !hasDecision && (decision || row.decidedBy !== null || facts.decidedAtUtc !== null)) return policyUnknown(visible);
      const executed = row.status === "EXECUTED", failed = row.status === "EXECUTION_FAILED";
      if (executed && facts.executionStatus !== "SUCCEEDED" || failed && facts.executionStatus !== "FAILED" || !executed && !failed && facts.executionStatus !== null) return policyUnknown(visible);
      if (!/^(0|[1-9]\d*)$/.test(facts.publishedCount) || facts.publishedCount !== (executed ? "1" : "0")) return policyUnknown(visible);
      if (!executed && facts.published !== null) return policyUnknown(visible);
      let effectiveStatus: "EFFECTIVE" | "PENDING_EFFECTIVE" | "NOT_EFFECTIVE" | "UNKNOWN" = failed ? "UNKNOWN" : "NOT_EFFECTIVE";
      let effectiveAt: string | null = null;
      if (executed) {
        const published = facts.published;
        if (!published || published.status !== "APPROVED" || published.approvalRequestId !== row.id || published.version !== frozen.version
          || published.ruleReleaseId !== frozen.ruleReleaseId || published.priceVersionId !== frozen.priceVersionId || published.sourceRef !== frozen.sourceRef
          || published.approvedByAdminId !== facts.executedBy || facts.resultCode !== "MEMBERSHIP_POLICY_PUBLISHED" || facts.resultDetail !== published.id
          || canonicalize(published.policyPayload) !== canonicalize({ ...frozen.policyPayload, status: "APPROVED" }) || !/^[a-f0-9]{64}$/.test(published.payloadHash)) return policyUnknown(visible);
        effectiveAt = instant(published.effectiveAtUtc);
        if (effectiveAt === null || effectiveAt !== planned) return policyUnknown(visible);
        effectiveStatus = effectiveAt > asOf ? "PENDING_EFFECTIVE" : published.id === currentEffectivePolicyId ? "EFFECTIVE" : "UNKNOWN";
      }
      const person = (id: string, name: string | null): PolicyChangePerson => { if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid policy actor"); return { id, name: typeof name === "string" ? name : null }; };
      const submittedAt = instant(facts.submittedAtUtc)!, decidedAt = decision ? instant(facts.decidedAtUtc) : null, executedAt = executed || failed ? instant(facts.executedAtUtc) : null;
      if (!submittedAt || decision && !decidedAt || (executed || failed) && (!executedAt || !facts.executedBy)) return policyUnknown(visible);
      const requester = person(row.requestedBy, facts.requestedName), approver = decision ? person(decision.approverId, facts.decidedName) : null, executor = executed || failed ? person(facts.executedBy!, facts.executedName) : null;
      const approvalStatus = status === "EXPIRED" || status === "CANCELLED" ? status : decision?.decision ?? status;
      const steps: PolicyChangeStep[] = [
        { key: "SUBMITTED", label: "已提交", state: "COMPLETED", actor: requester, atUtc: submittedAt },
        { key: "APPROVAL", label: "审批处理", state: decision ? decision.decision === "REJECTED" ? "FAILED" : "COMPLETED" : status === "PENDING" ? "CURRENT" : "UNKNOWN", actor: approver, atUtc: decidedAt, note: decision?.reason ?? null },
        { key: "EXECUTION", label: "执行发布", state: executed ? "COMPLETED" : failed ? "FAILED" : status === "APPROVED" ? "CURRENT" : "PENDING", actor: executor, atUtc: executedAt },
        { key: "EFFECTIVE", label: "生效", state: effectiveStatus === "EFFECTIVE" ? "COMPLETED" : effectiveStatus === "PENDING_EFFECTIVE" ? "CURRENT" : "PENDING", actor: null, atUtc: effectiveStatus === "EFFECTIVE" ? effectiveAt : null },
      ];
      // This display field needs the original content, not merely a matching stored hash column.
      const requestedDigest = createHash("sha256").update(canonicalize({ schema: "membership-growth-draft-v1", policy: frozen.policyPayload,
        versionNo: payload.policyDraftVersion, ruleReleaseId: frozen.ruleReleaseId, priceVersionId: frozen.priceVersionId,
        sourceRef: frozen.sourceRef, effectiveAtUtc: payload.effectiveAtUtc ?? null })).digest("hex");
      return { knowledge: "KNOWN", draftReference: { id: frozen.id, version: frozen.version, payloadHash: frozen.payloadHash }, immutableDiff: null,
        requestedValues: requestedDigest === frozen.payloadHash ? policyRequestedValues(frozen.policyPayload, facts.draftHaffRule) : null,
        request: { ...visible, approvalStatus, executionStatus: facts.executionStatus ?? "NOT_STARTED", reason: typeof payload.reason === "string" ? payload.reason : row.summary,
          submittedBy: requester, submittedAtUtc: submittedAt, plannedEffectiveAtUtc: planned, steps },
        effectiveState: { status: effectiveStatus, effectiveAtUtc: effectiveAt, executed }, message: effectiveStatus === "UNKNOWN" ? "执行或当前生效依据尚待核对" : null };
    } catch { return policyUnknown(visible); }
  } catch { throw new SecurityApiError(503, "MEMBERSHIP_UNKNOWN", "Policy change is temporarily unavailable"); }
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
