import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { readAdminGameScope, scopeAllowsGame } from "./admin-scope";

import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess, type EffectiveAdminAccess } from "./admin-authorization";
import type { ApprovalOperationExecutor, ApprovalOperationExecutorInput } from "./auth-security";
import { validateBenefitPolicy, validateEntitlementCandidate, type EntitlementCandidate, type GrowthBenefitPolicy, type GrowthPricingContract } from "./membership-growth";
import { membershipGrowthEnabled } from "./membership-growth-integration";
import { SecurityApiError } from "./security-core";
import { canonicalize } from "../supply/content-hash";

const OPERATION_CODES = new Set(["membership.benefit.policy.publish", "membership.entitlement.grant", "membership.entitlement.replace", "membership.entitlement.revoke"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function conflict(message: string): never {
  throw new SecurityApiError(409, "CONFLICT", message);
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) conflict("Membership operation payload is invalid");
  return value as Record<string, unknown>;
}

function text(payload: Record<string, unknown>, field: string, max = 512): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) conflict(`${field} is invalid`);
  return value;
}

function pricing(payload: Record<string, unknown>): GrowthPricingContract {
  const value = payload.pricing;
  if (!value || typeof value !== "object" || Array.isArray(value)) conflict("pricing is invalid");
  return value as GrowthPricingContract;
}

function checkBusinessPermission(access: EffectiveAdminAccess, code: string): void {
  if (!access.isBoss && !hasPermission(access, code)) conflict("Membership operation permission is required");
}

async function assertGameScope(client: PoolClient, access: EffectiveAdminAccess, adminUserId: string, gameId: string): Promise<void> {
  if (access.isBoss) return;
  const allowed = scopeAllowsGame(await readAdminGameScope(client, adminUserId), false, gameId);
  if (!allowed) conflict("Membership operation is outside the administrator game scope");
}

export async function assertSealedRuleRelease(client: PoolClient, ruleReleaseId: string, priceVersionId: string): Promise<void> {
  const row = (await client.query<{ releaseId: string; priceVersionId: string; status: string }>(
    `SELECT r.id AS "releaseId", r.price_version_id AS "priceVersionId", p.status
       FROM zzsh_supply.rule_release r JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
      WHERE r.id=$1`, [ruleReleaseId],
  )).rows[0];
  if (!row || row.status !== "SEALED" || row.priceVersionId !== priceVersionId) conflict("Membership policy must bind to the same SEALED price release");
}

type ApprovedPolicyPayload = { id: string; version: number; policy: GrowthBenefitPolicy; sourceRef: string };

async function loadApprovedPolicy(client: PoolClient, policyId: string): Promise<ApprovedPolicyPayload> {
  // Approved policy versions are append-only for runtime; entitlement FK keeps the referenced version.
  const row = (await client.query<{ id: string; version: number; policyPayload: GrowthBenefitPolicy; sourceRef: string }>(
    `SELECT id, version, policy_payload AS "policyPayload", source_ref AS "sourceRef"
       FROM zzsh_iam.membership_growth_policy WHERE id=$1 AND status='APPROVED'`, [policyId],
  )).rows[0];
  if (!row) conflict("Approved membership policy is unavailable");
  const validation = validateBenefitPolicy(row.policyPayload);
  if (!validation.valid || !validation.publishable) conflict("Approved membership policy is not publishable");
  return { ...row, policy: row.policyPayload };
}

type DraftPolicyForApproval = { id: string; version: number; status: string; effectiveAt: string | null; ruleReleaseId: string; priceVersionId: string; sourceRef: string; policyPayload: GrowthBenefitPolicy; payloadHash: string; approvedPayloadHash?: string };

async function loadDraftPolicyForApproval(client: PoolClient, payload: Record<string, unknown>): Promise<DraftPolicyForApproval> {
  const id = text(payload, "policyDraftId");
  const version = payload.policyDraftVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) conflict("policyDraftVersion is invalid");
  const payloadHash = text(payload, "policyDraftHash", 64);
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) conflict("policyDraftHash is invalid");
  // Runtime policies are append-only; a row lock would require forbidden UPDATE privilege.
  const row = (await client.query<DraftPolicyForApproval>(
    `SELECT id, version::int AS version, status, effective_at AS "effectiveAt", rule_release_id AS "ruleReleaseId", price_version_id AS "priceVersionId", source_ref AS "sourceRef", policy_payload AS "policyPayload", payload_hash AS "payloadHash"
       FROM zzsh_iam.membership_growth_policy WHERE id=$1`, [id],
  )).rows[0];
  if (!row || row.status !== "DRAFT") conflict("Membership policy draft is unavailable");
  if (row.version !== version || row.payloadHash !== payloadHash) conflict("Membership policy draft hash/version changed");
  if (row.ruleReleaseId !== text(payload, "ruleReleaseId") || row.priceVersionId !== text(payload, "priceVersionId") || row.sourceRef !== text(payload, "sourceRef")) conflict("Membership policy draft binding changed");
  const expectedEffectiveAt = payload.effectiveAtUtc === undefined ? null : text(payload, "effectiveAtUtc");
  const actualEffectiveAt = row.effectiveAt === null ? null : new Date(row.effectiveAt).toISOString();
  if (actualEffectiveAt !== (expectedEffectiveAt === null ? null : new Date(expectedEffectiveAt).toISOString())) conflict("Membership policy draft effective time changed");
  const approvedPolicy = { ...row.policyPayload, status: "APPROVED" as const };
  const validation = validateBenefitPolicy(approvedPolicy);
  if (!validation.valid || !validation.publishable) conflict("Membership policy draft is not publishable");
  const approvedPayloadHash = createHash("sha256").update(canonicalize({ schema: "membership-growth-draft-v1", policy: approvedPolicy, versionNo: row.version, ruleReleaseId: row.ruleReleaseId, priceVersionId: row.priceVersionId, sourceRef: row.sourceRef, effectiveAtUtc: actualEffectiveAt })).digest("hex");
  return { ...row, policyPayload: approvedPolicy, approvedPayloadHash };
}

function candidateFromPayload(payload: Record<string, unknown>, requestedBy: string): EntitlementCandidate {
  const userId = text(payload, "userId");
  const kind = payload.kind;
  if (kind !== "FRIEND" && kind !== "PRESTIGE") conflict("kind is invalid");
  const startsAt = text(payload, "startsAtUtc");
  const endsAt = text(payload, "endsAtUtc");
  const scopeKey = text(payload, "scopeKey");
  const reason = text(payload, "reason", 500);
  const pricingValue = pricing(payload);
  return { userId, kind, scopeKey, startsAt, endsAt, pricing: pricingValue, depositWaived: payload.depositWaived === true, reason, requestedBy };
}

export async function lockReplacementEntitlement(client: PoolClient, payload: Record<string, unknown>, candidate: EntitlementCandidate, gameId: string): Promise<{ id: string; userId: string; kind: string; scopeKey: string }> {
  const id = text(payload, "replaceEntitlementId");
  const row = (await client.query<{ id: string; userId: string; gameId: string; kind: string; scopeKey: string; status: string }>(
    `SELECT id, user_id AS "userId", game_id AS "gameId", kind, scope_key AS "scopeKey", status
       FROM zzsh_iam.membership_entitlement WHERE id=$1 FOR UPDATE`, [id],
  )).rows[0];
  if (!row || !["EXECUTED_PENDING_START", "ACTIVE"].includes(row.status)) conflict("Entitlement to replace is not active");
  if (row.userId !== candidate.userId || row.gameId !== gameId || row.kind !== candidate.kind || row.scopeKey !== candidate.scopeKey) conflict("Replacement must keep the same recipient, game and entitlement scope");
  return row;
}

async function insertEntitlement(client: PoolClient, payload: Record<string, unknown>, input: ApprovalOperationExecutorInput, policyId: string): Promise<string> {
  const candidate = candidateFromPayload(payload, input.requestedBy);
  const gameId = text(payload, "gameId");
  const validation = validateEntitlementCandidate(candidate, "UNKNOWN", (await loadApprovedPolicy(client, policyId)).policy);
  if (!validation.valid) conflict(`Membership entitlement is invalid: ${validation.errors.join(",")}`);
  const id = `entitlement_${randomUUID().replaceAll("-", "")}`;
  const configured = candidate.pricing.haff;
  if (configured.status !== "CONFIGURED") conflict("Entitlement pricing is not configured");
  await client.query(
    `INSERT INTO zzsh_iam.membership_entitlement
       (id,user_id,game_id,kind,scope_key,starts_at,ends_at,pricing_schema,pricing_payload,price_version_id,cost_basis_ref,deposit_waived,approved_policy_id,approval_request_id,approved_payload_hash,status)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,'EXECUTED_PENDING_START')`,
    [id, candidate.userId, gameId, candidate.kind, candidate.scopeKey, candidate.startsAt, candidate.endsAt, configured.schema, JSON.stringify(candidate.pricing), candidate.pricing.priceVersionId, configured.costBasisRef, candidate.depositWaived === true, policyId, input.requestId, input.operationPayloadHash],
  );
  return id;
}

export const executeMembershipGrowthOperation: ApprovalOperationExecutor = async (client, input, actor, requestId) => {
  if (!membershipGrowthEnabled()) throw new SecurityApiError(404, "NOT_FOUND", "Membership growth is disabled");
  if (!OPERATION_CODES.has(input.operationCode)) throw new SecurityApiError(409, "CONFLICT", "Membership operation is not supported");
  const payload = payloadRecord(input.operationPayload);
  const effective = await loadEffectiveAdminAccess(client, actor.userId);
  if (!effective) conflict("Administrator access is unavailable");
  if (input.operationCode === "membership.benefit.policy.publish") {
    checkBusinessPermission(effective, ADMIN_PERMISSION.membershipPolicyPublish);
    const draft = payload.policyDraftId ? await loadDraftPolicyForApproval(client, payload) : null;
    const policy = draft?.policyPayload ?? payloadRecord(payload.policy) as GrowthBenefitPolicy;
    const result = validateBenefitPolicy(policy as GrowthBenefitPolicy);
    if (!result.valid || !result.publishable) conflict("Membership policy is not publishable");
    const versionNo = draft?.version ?? payload.versionNo;
    if (typeof versionNo !== "number" || !Number.isSafeInteger(versionNo) || versionNo < 1) conflict("versionNo is invalid");
    const ruleReleaseId = draft?.ruleReleaseId ?? text(payload, "ruleReleaseId");
    const priceVersionId = draft?.priceVersionId ?? text(payload, "priceVersionId");
    const effectiveAtUtc = draft?.effectiveAt ?? text(payload, "effectiveAtUtc");
    const sourceRef = draft?.sourceRef ?? text(payload, "sourceRef");
    await assertSealedRuleRelease(client, ruleReleaseId, priceVersionId);
    for (const tier of Object.values((policy as GrowthBenefitPolicy).tiers)) {
      for (const contract of [...Object.values(tier.pricing), tier.entitlementCap]) {
        if (contract && typeof contract === "object" && "status" in contract && contract.status === "NOT_PRICED") conflict("Membership policy contains an unpriced contract");
        if (contract && typeof contract === "object" && "priceVersionId" in contract && contract.priceVersionId !== priceVersionId) conflict("Membership policy price version differs from the sealed release");
      }
    }
    const id = `growth_policy_${randomUUID().replaceAll("-", "")}`;
    await client.query(`INSERT INTO zzsh_iam.membership_growth_policy (id,version,status,effective_at,rule_release_id,price_version_id,source_ref,policy_schema,policy_payload,payload_hash,approval_request_id,approved_by_admin_id) VALUES ($1,$2,'APPROVED',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`, [id, versionNo, effectiveAtUtc, ruleReleaseId, priceVersionId, sourceRef, "membership-growth-v1", JSON.stringify(policy), draft?.approvedPayloadHash ?? input.operationPayloadHash, input.requestId, actor.userId]);
    return { resultCode: "MEMBERSHIP_POLICY_PUBLISHED", resultDetail: id };
  }
  if (input.operationCode === "membership.entitlement.revoke") {
    checkBusinessPermission(effective, ADMIN_PERMISSION.membershipEntitlementRevoke);
    const id = text(payload, "entitlementId");
    const gameId = text(payload, "gameId");
    const scopeKey = text(payload, "scopeKey");
    const reason = text(payload, "reason", 500);
    await assertGameScope(client, effective, actor.userId, gameId);
    const result = await client.query(`UPDATE zzsh_iam.membership_entitlement SET status='REVOKED', revoked_reason=$2, updated_at=clock_timestamp() WHERE id=$1 AND game_id=$3 AND scope_key=$4 AND status IN ('EXECUTED_PENDING_START','ACTIVE')`, [id, reason, gameId, scopeKey]);
    if (result.rowCount !== 1) conflict("Entitlement is not active or already terminal");
    return { resultCode: "MEMBERSHIP_ENTITLEMENT_REVOKED", resultDetail: id };
  }
  checkBusinessPermission(effective, ADMIN_PERMISSION.membershipEntitlementExecute);
  const policyId = text(payload, "policyId");
  const gameId = text(payload, "gameId");
  const scopeKey = text(payload, "scopeKey");
  await assertGameScope(client, effective, actor.userId, gameId);
  const candidate = candidateFromPayload(payload, input.requestedBy);
  const replacement = input.operationCode === "membership.entitlement.replace" ? await lockReplacementEntitlement(client, payload, candidate, gameId) : null;
  const newId = await insertEntitlement(client, payload, input, policyId);
  if (replacement) {
    const updated = await client.query(`UPDATE zzsh_iam.membership_entitlement SET status='REPLACED', replaced_by_id=$2, updated_at=clock_timestamp() WHERE id=$1 AND user_id=$3 AND game_id=$4 AND kind=$5 AND scope_key=$6 AND status IN ('EXECUTED_PENDING_START','ACTIVE')`, [replacement.id, newId, candidate.userId, gameId, candidate.kind, scopeKey]);
    if (updated.rowCount !== 1) conflict("Entitlement to replace is not active");
    return { resultCode: "MEMBERSHIP_ENTITLEMENT_REPLACED", resultDetail: newId };
  }
  return { resultCode: "MEMBERSHIP_ENTITLEMENT_GRANTED", resultDetail: newId };
};

