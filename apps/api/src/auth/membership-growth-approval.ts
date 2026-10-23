import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { readAdminGameScope, scopeAllowsGame } from "./admin-scope";

import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess, type EffectiveAdminAccess } from "./admin-authorization";
import type { ApprovalOperationExecutor, ApprovalOperationExecutorInput } from "./auth-security";
import { entitlementCapForMode, entitlementRangeForMode, GrowthRuleError, isNotPriced, isTotalDiscountContract, sealedEnabledRentalModes, validateBenefitPolicy, validateEntitlementCandidate, type EntitlementCandidate, type GrowthBenefitPolicy, type GrowthPricingContract, type RentalMode } from "./membership-growth";
import { membershipGrowthEnabled } from "./membership-growth-integration";
import { SecurityApiError } from "./security-core";
import { canonicalize } from "../supply/content-hash";
import { projectUnifiedMembershipPricing } from "./membership-unified-pricing";

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

function pricing(payload: Record<string, unknown>): EntitlementCandidate["pricing"] {
  const value = payload.pricing;
  if (!value || typeof value !== "object" || Array.isArray(value)) conflict("pricing is invalid");
  return value as EntitlementCandidate["pricing"];
}

function checkBusinessPermission(access: EffectiveAdminAccess, code: string): void {
  if (!access.isBoss && !hasPermission(access, code)) conflict("Membership operation permission is required");
}

async function assertGameScope(client: PoolClient, access: EffectiveAdminAccess, adminUserId: string, gameId: string): Promise<void> {
  if (access.isBoss) return;
  const allowed = scopeAllowsGame(await readAdminGameScope(client, adminUserId), false, gameId);
  if (!allowed) conflict("Membership operation is outside the administrator game scope");
}

export type SealedReleaseFacts = {
  gameId?: string;
  termVersionId?: string;
  enabledModes: RentalMode[];
  releaseMode: "SPREAD" | "PERCENT";
  haffSchema: string | null;
  /** Bound release catalog used to require complete policy contracts at publish time. */
  catalog: { safeBoxes: string[]; materials: Array<{ itemId: string; unit?: "ROUND" | "PIECE" | "DAY"; name?: string; unitQuantity?: string }>; resources?: Array<{ itemId: string; name: string; unit: string; pricingKind: string }> };
};

export async function assertSealedRuleRelease(client: PoolClient, ruleReleaseId: string, priceVersionId: string): Promise<SealedReleaseFacts> {
  const row = (await client.query<{ releaseId: string; gameId?: string; termVersionId?: string; priceVersionId: string; status: string; mode: string; haffRule: unknown }>(
    `SELECT r.id AS "releaseId", r.game_id AS "gameId", r.term_version_id AS "termVersionId", r.price_version_id AS "priceVersionId", p.status, p.mode, p.haff_rule AS "haffRule"
       FROM zzsh_supply.rule_release r JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
      WHERE r.id=$1`, [ruleReleaseId],
  )).rows[0];
  if (!row || row.status !== "SEALED" || row.priceVersionId !== priceVersionId) conflict("Membership policy must bind to the same SEALED price release");
  // The enabled rental modes come from the sealed release itself; an unreadable shape must fail closed.
  const enabledModes = sealedEnabledRentalModes(row.haffRule);
  if (enabledModes === null || (row.mode !== "SPREAD" && row.mode !== "PERCENT")) conflict("Sealed release pricing modes cannot be verified");
  const haffRule = row.haffRule as Record<string, unknown>;
  const baseBySafeBox = haffRule.baseBySafeBox;
  const safeBoxes = baseBySafeBox && typeof baseBySafeBox === "object" && !Array.isArray(baseBySafeBox) ? Object.keys(baseBySafeBox).sort() : [];
  const resources = (await client.query<{ itemId: string; unit: string; name: string; pricingKind: string; unitQuantity: string | null }>(
    `SELECT l.item_id AS "itemId", i.unit, i.name, l.pricing_kind AS "pricingKind", l.unit_quantity::text AS "unitQuantity"
       FROM zzsh_supply.price_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id
      WHERE l.price_version_id=$1 AND l.customer_tier='STANDARD'
      ORDER BY l.item_id`, [priceVersionId],
  )).rows;
  const materials = resources.filter(resource => resource.pricingKind !== "HAFF_RATIO").map((material): { itemId: string; unit?: "ROUND" | "PIECE" | "DAY"; name?: string; unitQuantity?: string } => ({
    itemId: material.itemId,
    ...(material.unit === "ROUND" || material.unit === "PIECE" || material.unit === "DAY" ? { unit: material.unit } : {}),
    ...(typeof material.name === "string" && material.name.length > 0 ? { name: material.name } : {}),
    ...(typeof material.unitQuantity === "string" && material.unitQuantity.length > 0 ? { unitQuantity: material.unitQuantity } : {}),
  }));
  return { gameId: row.gameId, termVersionId: row.termVersionId, enabledModes, releaseMode: row.mode, haffSchema: typeof haffRule.schema === "string" ? haffRule.schema : null, catalog: { safeBoxes, materials, resources: resources.map(({ itemId, name, unit, pricingKind }) => ({ itemId, name, unit, pricingKind })) } };
}

type ApprovedPolicyPayload = { id: string; version: number; policy: GrowthBenefitPolicy; sourceRef: string; enabledModes: RentalMode[] };

async function loadApprovedPolicy(client: PoolClient, policyId: string, gameId: string): Promise<ApprovedPolicyPayload> {
  // Approved policy versions are append-only for runtime; entitlement FK keeps the referenced version.
  const row = (await client.query<{ id: string; version: number; policyPayload: GrowthBenefitPolicy; sourceRef: string; ruleReleaseId: string; priceVersionId: string }>(
    `SELECT id, version, policy_payload AS "policyPayload", source_ref AS "sourceRef", rule_release_id AS "ruleReleaseId", price_version_id AS "priceVersionId"
       FROM zzsh_iam.membership_growth_policy WHERE id=$1 AND status='APPROVED'
         AND EXISTS (SELECT 1 FROM zzsh_supply.rule_release r WHERE r.id=membership_growth_policy.rule_release_id AND r.game_id=$2)`, [policyId, gameId],
  )).rows[0];
  if (!row) conflict("Approved membership policy is unavailable");
  const sealed = await assertSealedRuleRelease(client, row.ruleReleaseId, row.priceVersionId);
  const validation = validateBenefitPolicy(row.policyPayload, { enabledModes: sealed.enabledModes });
  if (!validation.valid || !validation.publishable) conflict("Approved membership policy is not publishable");
  return { id: row.id, version: row.version, policy: row.policyPayload, sourceRef: row.sourceRef, enabledModes: sealed.enabledModes };
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
  if (payload.depositWaived !== undefined && typeof payload.depositWaived !== "boolean") conflict("depositWaived is invalid");
  return { userId, kind, scopeKey, startsAt, endsAt, pricing: pricingValue, depositWaived: payload.depositWaived === true, ...(payload.depositAllowanceCents === undefined ? {} : { depositAllowanceCents: payload.depositAllowanceCents as string }), reason, requestedBy };
}

/** New submissions use unified pricing; previously approved immutable requests retain their original contract. */
export async function validateUnifiedMembershipPolicySubmission(client: PoolClient, payload: Record<string, unknown>): Promise<void> {
  const draft = await loadDraftPolicyForApproval(client, payload);
  const sealed = await assertSealedRuleRelease(client, draft.ruleReleaseId, draft.priceVersionId);
  if (draft.policyPayload.pricingScope !== "ALL_ENABLED_RENTAL_MODES" || projectUnifiedMembershipPricing(draft.policyPayload, sealed.enabledModes).knowledge !== "KNOWN") conflict("请先保存统一总价折扣政策，再提交审批");
  const validation = validateBenefitPolicy(draft.policyPayload, { enabledModes: sealed.enabledModes, catalog: sealed.catalog, releaseMode: sealed.releaseMode });
  if (!validation.publishable) conflict("统一会员政策仍有待配置或不符合规则的权益");
}

/** Decision and execution share the exact immutable policy/range validation; execution adds locks and mutations. */
export async function validateMembershipEntitlementPayload(client: PoolClient, payload: Record<string, unknown>, requestedBy: string): Promise<{ candidate: EntitlementCandidate; gameId: string; policyId: string }> {
  const policyId = text(payload, "policyId"), gameId = text(payload, "gameId");
  if (!ID.test(policyId) || !ID.test(gameId)) conflict("Entitlement policy or game is invalid");
  const candidate = candidateFromPayload(payload, requestedBy), policy = await loadApprovedPolicy(client, policyId, gameId);
  try {
    const validation = validateEntitlementCandidate(candidate, "UNKNOWN", policy.policy, { enabledModes: policy.enabledModes });
    if (!validation.valid) conflict(`Membership entitlement is invalid: ${validation.errors.join(",")}`);
  } catch (error) {
    if (error instanceof GrowthRuleError) conflict("Membership entitlement contains invalid values");
    throw error;
  }
  return { candidate, gameId, policyId };
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

async function insertEntitlement(client: PoolClient, candidate: EntitlementCandidate, gameId: string, input: ApprovalOperationExecutorInput, policyId: string): Promise<string> {
  const id = `entitlement_${randomUUID().replaceAll("-", "")}`;
  const configured = candidate.pricing;
  let pricingSchema: string;
  let costBasisRef: string;
  if (isTotalDiscountContract(configured)) {
    pricingSchema = "total-discount-v1";
    costBasisRef = configured.costBasisRef;
  } else if (!isNotPriced(configured) && !isTotalDiscountContract(configured) && configured.haff.status === "CONFIGURED") {
    pricingSchema = configured.haff.schema;
    costBasisRef = configured.haff.costBasisRef;
  } else conflict("Entitlement pricing is not configured");
  await client.query(
    `INSERT INTO zzsh_iam.membership_entitlement
       (id,user_id,game_id,kind,scope_key,starts_at,ends_at,pricing_schema,pricing_payload,price_version_id,cost_basis_ref,deposit_waived,approved_policy_id,approval_request_id,approved_payload_hash,deposit_allowance_cents,status)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::numeric,'EXECUTED_PENDING_START')`,
    [id, candidate.userId, gameId, candidate.kind, candidate.scopeKey, candidate.startsAt, candidate.endsAt, pricingSchema, JSON.stringify(candidate.pricing), configured.priceVersionId, costBasisRef, candidate.depositWaived === true, policyId, input.requestId, input.operationPayloadHash, candidate.depositAllowanceCents ?? null],
  );
  return id;
}

/** One existing recipient row serializes grants even when no overlapping entitlement row exists yet. */
async function lockEntitlementRecipient(client: PoolClient, candidate: EntitlementCandidate, gameId: string, excludeId?: string): Promise<void> {
  const subject = (await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [candidate.userId])).rows[0];
  if (!subject) throw new SecurityApiError(404, "NOT_FOUND", "Entitlement recipient is unavailable");
  if (!(await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1`, [gameId])).rows.length) throw new SecurityApiError(404, "NOT_FOUND", "Entitlement game is unavailable");
  const overlap = await client.query(
    `SELECT id FROM zzsh_iam.membership_entitlement WHERE user_id=$1 AND game_id=$2 AND scope_key=$3
       AND status NOT IN ('REVOKED','REPLACED') AND starts_at < $5::timestamptz AND ends_at > $4::timestamptz
       AND ($6::text IS NULL OR id<>$6) LIMIT 1`,
    [candidate.userId, gameId, candidate.scopeKey, candidate.startsAt, candidate.endsAt, excludeId ?? null],
  );
  if (overlap.rows.length) conflict("An entitlement already covers this recipient, scope and time range");
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
    const versionNo = draft?.version ?? payload.versionNo;
    if (typeof versionNo !== "number" || !Number.isSafeInteger(versionNo) || versionNo < 1) conflict("versionNo is invalid");
    const ruleReleaseId = draft?.ruleReleaseId ?? text(payload, "ruleReleaseId");
    const priceVersionId = draft?.priceVersionId ?? text(payload, "priceVersionId");
    const effectiveAtUtc = draft?.effectiveAt ?? text(payload, "effectiveAtUtc");
    const sourceRef = draft?.sourceRef ?? text(payload, "sourceRef");
    const sealed = await assertSealedRuleRelease(client, ruleReleaseId, priceVersionId);
    const result = validateBenefitPolicy(policy as GrowthBenefitPolicy, { enabledModes: sealed.enabledModes, catalog: sealed.catalog, releaseMode: sealed.releaseMode });
    if (!result.valid || !result.publishable) conflict(`Membership policy is not publishable: ${[...result.errors, ...result.warnings].slice(0, 5).join(",")}`);
    if (policy.pricingScope !== undefined && projectUnifiedMembershipPricing(policy, sealed.enabledModes).knowledge !== "KNOWN") conflict("Membership policy requires one total discount and one entitlement range across enabled rental paths");
    for (const tier of Object.values((policy as GrowthBenefitPolicy).tiers)) {
      // Only modes the sealed release enabled carry spendable prices; a disabled mode never blocks a publish.
      for (const mode of sealed.enabledModes) {
        const contract = tier.pricing?.[mode];
        if (!contract || isNotPriced(contract)) conflict("Membership policy contains an unpriced enabled mode");
        if (contract.priceVersionId !== priceVersionId) conflict("Membership policy price version differs from the sealed release");
        if ((policy as GrowthBenefitPolicy).entitlementRanges === undefined) {
          const cap = entitlementCapForMode(tier.entitlementCap, mode);
          if (!cap || isNotPriced(cap)) conflict("Membership policy entitlement cap is missing");
          if (cap.priceVersionId !== priceVersionId) conflict("Membership policy price version differs from the sealed release");
        }
      }
    }
    if ((policy as GrowthBenefitPolicy).entitlementRanges !== undefined) for (const kind of ["FRIEND", "PRESTIGE"] as const) for (const mode of sealed.enabledModes) {
      const range = entitlementRangeForMode(policy as GrowthBenefitPolicy, kind, mode);
      if (!range || isNotPriced(range) || range.priceVersionId !== priceVersionId) conflict("Entitlement range must bind to the sealed price version");
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
  const scopeKey = text(payload, "scopeKey");
  const gameId = text(payload, "gameId");
  await assertGameScope(client, effective, actor.userId, gameId);
  const { candidate, policyId } = await validateMembershipEntitlementPayload(client, payload, input.requestedBy);
  await lockEntitlementRecipient(client, candidate, gameId, input.operationCode === "membership.entitlement.replace" ? text(payload, "replaceEntitlementId") : undefined);
  const replacement = input.operationCode === "membership.entitlement.replace" ? await lockReplacementEntitlement(client, payload, candidate, gameId) : null;
  const newId = await insertEntitlement(client, candidate, gameId, input, policyId);
  if (replacement) {
    const updated = await client.query(`UPDATE zzsh_iam.membership_entitlement SET status='REPLACED', replaced_by_id=$2, updated_at=clock_timestamp() WHERE id=$1 AND user_id=$3 AND game_id=$4 AND kind=$5 AND scope_key=$6 AND status IN ('EXECUTED_PENDING_START','ACTIVE')`, [replacement.id, newId, candidate.userId, gameId, candidate.kind, scopeKey]);
    if (updated.rowCount !== 1) conflict("Entitlement to replace is not active");
    return { resultCode: "MEMBERSHIP_ENTITLEMENT_REPLACED", resultDetail: newId };
  }
  return { resultCode: "MEMBERSHIP_ENTITLEMENT_GRANTED", resultDetail: newId };
};

