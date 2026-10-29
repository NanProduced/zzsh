import type { PoolClient } from "pg";
import { recordLegacyConfirmGrowth } from "../auth/membership-growth-legacy-live";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { conflict, ensureOnlyFields, invalid, newSupplyId, notFound, sha256Hex } from "../supply/supply-util";
import { canonicalize } from "../supply/content-hash";
import { planLegacyContinuation, type LegacyCommand, type LegacyQuantities } from "./legacy-continuation-calc";
import { authorizeLegacyContinuation, LEGACY_DUTY_FIELDS, legacyBeneficiaryUserId, lockLegacyContinuationOrder, readLegacyContinuationBinding, readLegacyContinuationEvidence,readLegacyContinuationUserIds } from "./legacy-continuation-evidence";
import { deriveLegacyFacts, legacyContinuationRole, legacyDecimalEquals, legacyEconomicDutyId, legacyPlanYuanToCents, readSealedLegacyFacts, sealLegacyFacts,
  type LegacyContinuationActor, type LegacyDutyFinalizationReader, type LegacyDutyKind, type LegacyDutyRow, type LegacyHeadRow, type LegacyOrderBinding } from "./legacy-continuation-model";

export type LegacyMutationKind = "propose" | "confirm" | "reject" | "hold" | "release" | "confiscate";
export type LegacyMutationInput = { kind: LegacyMutationKind; expectedRevision: string | null; inputEvidenceId: string; planFingerprint: string; quantities?: LegacyQuantities };
const QUANTITIES = ["expendHaff", "barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"] as const;
export function parseLegacyQuantities(value: unknown): LegacyQuantities {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("QUANTITY_INVALID");
  ensureOnlyFields(value as Record<string, unknown>, QUANTITIES);
  const result: Record<string, string | null> = {};
  for (const key of QUANTITIES) {
    const x = (value as Record<string, unknown>)[key];
    if (x !== null && (typeof x !== "string" || x.length > 24 || !/^(0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(x))) throw invalid("QUANTITY_INVALID", key);
    result[key] = x as string | null;
  }
  return result as LegacyQuantities;
}
export function parseLegacyMutation(kind: LegacyMutationKind, body: Record<string, unknown>): LegacyMutationInput {
  ensureOnlyFields(body, ["expectedRevision", "inputEvidenceId", "planFingerprint", ...(kind === "propose" ? ["quantities"] : [])]);
  if (body.expectedRevision !== null && (typeof body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(body.expectedRevision))) throw invalid("Invalid continuation revision");
  if (typeof body.inputEvidenceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.inputEvidenceId)) throw invalid("Invalid evidence identifier");
  if (typeof body.planFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.planFingerprint)) throw invalid("Invalid plan fingerprint");
  return { kind, expectedRevision: body.expectedRevision as string | null, inputEvidenceId: body.inputEvidenceId, planFingerprint: body.planFingerprint, ...(kind === "propose" ? { quantities: parseLegacyQuantities(body.quantities) } : {}) };
}
export type LegacyMutationAuthority={binding:LegacyOrderBinding;userIds:readonly string[];actor:LegacyContinuationActor};
export async function authorizeLegacyMutation(client: PoolClient, actor: LegacyContinuationActor, orderId: string, replay=false):Promise<LegacyMutationAuthority> {
  const binding = await readLegacyContinuationBinding(client, orderId);
  if(actor.realm==="user" && actor.userId!==binding.ownerUserId && actor.userId!==binding.renterUserId)throw notFound();
  const userIds=replay?[binding.ownerUserId,binding.renterUserId].sort():await readLegacyContinuationUserIds(client,binding);
  await authorizeLegacyContinuation(client, actor, binding, true,userIds);
  return {binding,userIds,actor:{...actor}};
}
async function assertUserPrefix(client:PoolClient,actor:LegacyContinuationActor,orderId:string,a:LegacyMutationAuthority){
  if(a.binding.id!==orderId || a.actor.realm!==actor.realm || a.actor.userId!==actor.userId || a.actor.sessionId!==actor.sessionId)throw conflict("CONTINUATION_AUTHORITY_CHANGED");
  if(canonicalize(await readLegacyContinuationUserIds(client,a.binding))!==canonicalize(a.userIds))throw conflict("CONTINUATION_BENEFICIARIES_CHANGED");
}
/** Preserve a definitive business refusal under the same key after rolling back every action effect. */
export async function legacyCommandOutcome(client: PoolClient, actor: LegacyContinuationActor, orderId: string, action: () => Promise<{ status: number; body: unknown }>) {
  await client.query("SAVEPOINT legacy_continuation_action");
  try {
    const result = await action(); await client.query("RELEASE SAVEPOINT legacy_continuation_action"); return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT legacy_continuation_action"); await client.query("RELEASE SAVEPOINT legacy_continuation_action");
    if (!(error instanceof SecurityApiError) || ![400, 409].includes(error.status)) throw error;
    await recordAudit(client, { actorType: actor.realm, actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: "order.legacy.command_refused", objectType: "rental_order", objectId: orderId, outcome: "FAILURE", details: { reason: error.message, status: error.status } });
    return { status: error.status, body: { error: { code: error.code, message: error.message, requestId: actor.requestId }, outcome: "REJECTED" } };
  }
}
async function createDuty(client: PoolClient, binding: LegacyOrderBinding, versionId: string, kind: LegacyDutyKind, sourceId: string, beneficiary: string | null, amountYuan: string, extra?: { level: string; ratio: string; maturityAt: string }) {
  const id = legacyEconomicDutyId(binding.id, kind, sourceId), cents = legacyPlanYuanToCents(amountYuan);
  await client.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,continuation_version_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,level,ratio,maturity_at,source_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,'CNY','PENDING','CONTINUATION',$8,$9,$10,$11,$12)`,
    [id, binding.id, versionId, kind, sourceId, beneficiary, cents, kind === "COMMISSION" ? "1" : null, extra?.level ?? null, extra?.ratio ?? null, extra?.maturityAt ?? null, binding.sourceDigest]);
  return id;
}
async function reviseCommission(client: PoolClient, actor: LegacyContinuationActor, existing: LegacyDutyRow, versionId: string, amountYuan: string, maturityAt: string) {
  if (existing.status !== "PENDING" || existing.settledBy !== null || existing.settledRefId !== null) throw conflict("DUTY_REVISION_CONFLICT");
  const amountCents = legacyPlanYuanToCents(amountYuan);
  const updated = await client.query(`UPDATE zzsh_order.legacy_order_duty SET amount_cents=$3,maturity_at=$4,revision=revision+1,revised_at=clock_timestamp(),revised_by=$5::jsonb,revision_reason='CONFIRM_FINAL_AMOUNT'
    WHERE id=$1 AND revision=$2 AND status='PENDING' AND settled_by IS NULL RETURNING revision::text`, [existing.id, existing.revision, amountCents, maturityAt, JSON.stringify(actor)]);
  if (updated.rowCount !== 1) throw conflict("DUTY_REVISION_CONFLICT");
  await client.query(`INSERT INTO zzsh_order.legacy_order_duty_revision(id,duty_id,revision,before_values,after_values,actor,source_command_version_id,reason)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'CONFIRM_FINAL_AMOUNT')`,
    [newSupplyId("legacy_duty_revision"), existing.id, updated.rows[0]!.revision, JSON.stringify({ amountCents: existing.amountCents, maturityAt: existing.maturityAt }), JSON.stringify({ amountCents, maturityAt }), JSON.stringify(actor), versionId]);
}
type ReviewedVoidCommission = { dutyId: string; sourceRecordId: string; revision: string; sourceFactAuditId: string };
type StoredAudit = { id: string; actorType: string; actorId: string; sessionId: string; requestId: string; action: string; objectType: string; objectId: string; outcome: string; details: Record<string, unknown> };
function canonicalSource(value: unknown, limit: number): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const proof = value as { canonical?: unknown; digest?: unknown };
  if (typeof proof.canonical !== "string" || proof.canonical.length > limit || typeof proof.digest !== "string" || sha256Hex(proof.canonical) !== proof.digest) return null;
  try { const row = JSON.parse(proof.canonical); return row && typeof row === "object" && !Array.isArray(row) && canonicalize(row) === proof.canonical ? row : null; } catch { return null; }
}
/** The original calculation stays sealed. A separately reviewed terminal disposal only removes its payable effect. */
async function readReviewedCommissionVoid(client: PoolClient, binding: LegacyOrderBinding, duty: LegacyDutyRow, source: { id: string; beneficiaryId: string; level: string; ratio: string }): Promise<ReviewedVoidCommission> {
  if (duty.settledBy !== null || duty.settledRefType !== null || duty.settledRefId !== null || duty.settledRefDigest !== null) throw conflict("DUTY_REVISION_CONFLICT");
  const rows = (await client.query<{ sourceDigest: string; decisionEvidenceRef: string | null; decidedBy: LegacyContinuationActor | null; decisionReason: string | null; factAudit: StoredAudit | null; voidAudit: StoredAudit | null }>(`SELECT d.source_digest AS "sourceDigest",d.decision_evidence_ref AS "decisionEvidenceRef",d.decided_by AS "decidedBy",d.decision_reason AS "decisionReason",
    jsonb_build_object('id',f.id,'actorType',f.actor_type,'actorId',f.actor_id,'sessionId',f.session_id,'requestId',f.request_id,'action',f.action,'objectType',f.object_type,'objectId',f.object_id,'outcome',f.outcome,'details',f.details) AS "factAudit",
    jsonb_build_object('id',v.id,'actorType',v.actor_type,'actorId',v.actor_id,'sessionId',v.session_id,'requestId',v.request_id,'action',v.action,'objectType',v.object_type,'objectId',v.object_id,'outcome',v.outcome,'details',v.details) AS "voidAudit"
    FROM zzsh_order.legacy_order_duty d JOIN zzsh_iam.audit_event f ON f.id=d.decision_evidence_ref
    JOIN zzsh_iam.audit_event v ON v.object_id=d.order_id AND v.action='order.legacy.duty.void' AND v.details->>'dutyId'=d.id AND v.details->>'afterRevision'=d.revision::text
    WHERE d.id=$1 AND d.order_id=$2 AND d.revision=$3 AND d.status='VOID'`, [duty.id, binding.id, duty.revision])).rows;
  if (rows.length !== 1) throw conflict("VOID_SOURCE_FACT_REQUIRED");
  const row = rows[0]!, fact = row.factAudit, disposed = row.voidAudit, decided = row.decidedBy;
  const auditBound = (audit: StoredAudit | null, action: string) => !!audit && audit.actorType === "admin" && !!audit.actorId && !!audit.sessionId && !!audit.requestId && audit.action === action && audit.objectType === "rental_order" && audit.objectId === binding.id && audit.outcome === "SUCCESS" && !!audit.details && typeof audit.details === "object" && !Array.isArray(audit.details);
  if (row.sourceDigest !== binding.sourceDigest || !auditBound(fact, "order.legacy.duty.source_fact_reviewed") || !auditBound(disposed, "order.legacy.duty.void") || !fact || !disposed || !decided || decided.realm !== "admin"
    || disposed.actorId !== decided.userId || disposed.sessionId !== decided.sessionId || disposed.requestId !== decided.requestId
    || row.decisionEvidenceRef !== fact.id || disposed.details.sourceFactAuditId !== fact.id || disposed.details.dutyId !== duty.id
    || disposed.details.afterRevision !== duty.revision || disposed.details.beforeRevision !== (BigInt(duty.revision) - 1n).toString()
    || typeof row.decisionReason !== "string" || !row.decisionReason.trim() || row.decisionReason.length > 500 || disposed.details.reason !== row.decisionReason
    || fact.details.sourceRecordId !== source.id || fact.details.parentSourceDigest !== binding.sourceDigest || typeof fact.details.evidenceRef !== "string" || !fact.details.evidenceRef || fact.details.evidenceRef.length > 512) throw conflict("VOID_SOURCE_FACT_REQUIRED");
  const reviewed = canonicalSource(fact.details.sourceRecord, 32768);
  if (!reviewed || reviewed.id !== source.id || reviewed.order_id !== binding.legacyId || reviewed.user_id !== source.beneficiaryId || String(reviewed.level) !== source.level || typeof reviewed.ratio !== "string" || !legacyDecimalEquals(reviewed.ratio, source.ratio) || reviewed.status !== fact.details.sourceStatus) throw conflict("VOID_SOURCE_FACT_REQUIRED");
  if (reviewed.status === "3") {
    if (fact.details.parentCancelledNotPayable !== false || fact.details.parentCancellation != null) throw conflict("VOID_SOURCE_FACT_REQUIRED");
  } else {
    const cancellation = fact.details.parentCancellation as { canonical?: unknown; digest?: unknown; notPayableCanonical?: unknown; notPayableDigest?: unknown } | null;
    const parent = canonicalSource(cancellation, 65536), decision = canonicalSource({ canonical: cancellation?.notPayableCanonical, digest: cancellation?.notPayableDigest }, 65536);
    if (fact.details.parentCancelledNotPayable !== true || !parent || !decision || parent.id !== binding.legacyId || parent.order_status !== "5" || parent.user_id !== binding.legacyRenterId || parent.sale_user_id !== binding.legacyOwnerId || parent.accounts_id !== binding.legacyAccountId
      || decision.parentCancellationDigest !== cancellation?.digest || decision.sourceRecordDigest !== (fact.details.sourceRecord as { digest: string }).digest || decision.decision !== "NOT_PAYABLE" || typeof decision.sourceRuleEvidenceRef !== "string" || !decision.sourceRuleEvidenceRef) throw conflict("VOID_SOURCE_FACT_REQUIRED");
  }
  return { dutyId: duty.id, sourceRecordId: source.id, revision: duty.revision, sourceFactAuditId: fact.id };
}
/** Caller owns transaction and wraps this action with the existing withIdempotency/runIdempotentWrite. */
export async function applyLegacyContinuationCommand(client: PoolClient, actor: LegacyContinuationActor, orderId: string, input: LegacyMutationInput, finance?: LegacyDutyFinalizationReader,authority?:LegacyMutationAuthority) {
  const a=authority??await authorizeLegacyMutation(client,actor,orderId),binding=a.binding,locked=await lockLegacyContinuationOrder(client,orderId);
  await assertUserPrefix(client,actor,orderId,a);
  if ((locked.head?.revision ?? null) !== input.expectedRevision) throw conflict("CONTINUATION_REVISION_CONFLICT");
  const row = await readLegacyContinuationEvidence(client, orderId, locked.head);
  if (!row) throw conflict("NOT_IMPORTED");
  if (row.id !== input.inputEvidenceId) throw conflict("EVIDENCE_RELATION");
  const facts = readSealedLegacyFacts(row), role = legacyContinuationRole(binding, actor);
  if (["hold", "release", "confiscate"].includes(input.kind)) {
    if (role !== "admin") throw conflict("DEPOSIT_ACTOR_INVALID");
    if (!finance) throw conflict("FINANCE_FACT_UNAVAILABLE");
    const disposition = await finance(client, orderId, locked.duties);
    if (disposition === "UNKNOWN") throw conflict("FINANCE_FACT_UNKNOWN");
    if (disposition === "POSTED_POSITIVE_REFUND") throw conflict("DEPOSIT_ALREADY_SETTLED");
    if (!["NONE", "FINALIZED_ZERO"].includes(disposition)) throw conflict("FINANCE_FACT_UNKNOWN");
  }
  const caller = { role, legacyUserId: role === "owner" ? binding.legacyOwnerId : role === "renter" ? binding.legacyRenterId : "" };
  const command: LegacyCommand = input.kind === "propose" ? { kind: "propose", caller, quantities: input.quantities! } : { kind: input.kind, caller };
  const plan = planLegacyContinuation(facts.evidence, command);
  if (!plan.ok) throw conflict(plan.code);
  if (plan.fingerprint !== input.planFingerprint) throw conflict("PLAN_FINGERPRINT_MISMATCH");
  const reviewedVoidCommissions: ReviewedVoidCommission[] = [];
  if (input.kind === "confirm") for (const commission of plan.commissionRevisions) {
    const matches = locked.duties.filter(d => d.kind === "COMMISSION" && d.sourceRecordId === commission.id);
    if (!commission.recalculable || !matches.some(d => d.status === "VOID")) continue;
    const sources = facts.evidence.source.commissions.filter(c => c.id === commission.id), existing = matches[0]!;
    if (matches.length !== 1 || sources.length !== 1) throw conflict("VOID_SOURCE_FACT_REQUIRED");
    const source = sources[0]!, beneficiary = await legacyBeneficiaryUserId(client, commission.beneficiaryId);
    if (!beneficiary || existing.counterpartyUserId !== beneficiary || existing.level !== source.level || !legacyDecimalEquals(existing.ratio, source.ratio)) throw conflict("DUTY_SOURCE_BINDING_MISMATCH");
    if (!a.userIds.includes(beneficiary)) throw conflict("CONTINUATION_BENEFICIARIES_CHANGED");
    reviewedVoidCommissions.push(await readReviewedCommissionVoid(client, binding, existing, source));
  }
  const versionId = newSupplyId("legacy_continuation"), resultId = newSupplyId("legacy_evidence"), revision = (BigInt(locked.head?.revision ?? "0") + 1n).toString();
  const resultFacts = deriveLegacyFacts(facts, plan, command, row.id, versionId), sealed = sealLegacyFacts(resultFacts);
  const clock = (await client.query<{ at: string; maturityAt: string }>(`WITH c AS(SELECT clock_timestamp() AS at) SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,to_char((at+interval '7 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "maturityAt" FROM c`)).rows[0];
  if (!clock?.at || !clock.maturityAt) throw conflict("MATURITY_TIME_UNAVAILABLE");
  if (locked.head) {
    const superseded = await client.query(`UPDATE zzsh_order.legacy_continuation_version SET superseded_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND superseded_at IS NULL`, [locked.head.id, locked.head.revision]);
    if (superseded.rowCount !== 1) throw conflict("CONTINUATION_REVISION_CONFLICT");
  }
  await client.query(`INSERT INTO zzsh_order.legacy_continuation_version(id,order_id,revision,command,actor,input_evidence_id,result_evidence_id,stage,is_settle,is_advance_set,amounts,commission_revisions,assignments,plan_fingerprint,created_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)`,
    [versionId, orderId, revision, input.kind.toUpperCase(), JSON.stringify(actor), row.id, resultId, resultFacts.evidence.source.orderStatus, resultFacts.evidence.source.isSettle, resultFacts.evidence.source.isAdvanceSet === "1" ? 1 : 0, JSON.stringify(resultFacts.amounts), JSON.stringify(plan.commissionRevisions), JSON.stringify(plan.assignments), plan.fingerprint,clock.at]);
  await client.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,derived_from_command_version_id,source_as_of,evidence_ref,source_digest,parameter_digest,admission,reasons,facts,facts_canonical,facts_digest)
    VALUES($1,$2,$3,'DERIVED',$4,clock_timestamp(),$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
    [resultId, orderId, (BigInt(row.evidenceVersion) + 1n).toString(), versionId, "continuation:" + versionId, binding.sourceDigest, resultFacts.evidence.parameterDigest, resultFacts.evidence.admission, JSON.stringify(resultFacts.evidence.reasons), JSON.stringify(resultFacts), sealed.canonical, sealed.digest]);
  const dutyIds: string[] = [], isolated: Array<{ sourceRecordId: string; reason: string }> = [];
  if (input.kind === "confirm") {
    await recordLegacyConfirmGrowth(client, { binding, subjectUserId: binding.renterUserId, recordedAt: clock.at, origin: {
      kind: "CONTINUATION_CONFIRM", command: { id: versionId, revision, createdAt: clock.at, inputEvidenceId: row.id, resultEvidenceId: resultId, planFingerprint: plan.fingerprint, actor }, input: row,
      result: { id: resultId, orderId, evidenceVersion: (BigInt(row.evidenceVersion) + 1n).toString(), sourceKind: "DERIVED", sourceDigest: binding.sourceDigest, factsDigest: sealed.digest, factsCanonical: sealed.canonical, facts: resultFacts },
    } });
    dutyIds.push(await createDuty(client, binding, versionId, "RENTER_REFUND", versionId, binding.renterUserId, plan.amounts.refundNet!));
    dutyIds.push(await createDuty(client, binding, versionId, "OWNER_CREDIT", versionId, binding.ownerUserId, plan.amounts.ownerNet!));
    const now = clock.maturityAt;
    for (const commission of plan.commissionRevisions) {
      if (!commission.recalculable) continue;
      if (reviewedVoidCommissions.some(d => d.sourceRecordId === commission.id)) continue;
      const source = facts.evidence.source.commissions.find(c => c.id === commission.id)!;
      const beneficiary = await legacyBeneficiaryUserId(client, commission.beneficiaryId);
      if (!beneficiary) { isolated.push({ sourceRecordId: commission.id, reason: "PARTY_UNMAPPED" }); continue; }
      if(!a.userIds.includes(beneficiary))throw conflict("CONTINUATION_BENEFICIARIES_CHANGED");
      const existing = locked.duties.find(d => d.kind === "COMMISSION" && d.sourceRecordId === commission.id);
      if (existing) {
        if (existing.counterpartyUserId !== beneficiary || existing.level !== source.level || !legacyDecimalEquals(existing.ratio, source.ratio)) throw conflict("DUTY_SOURCE_BINDING_MISMATCH");
        await reviseCommission(client, actor, existing, versionId, commission.legalEarnings, now); dutyIds.push(existing.id);
      } else dutyIds.push(await createDuty(client, binding, versionId, "COMMISSION", commission.id, beneficiary, commission.legalEarnings, { level: source.level, ratio: source.ratio, maturityAt: now }));
    }
  }
  if (input.kind === "confiscate") dutyIds.push(await createDuty(client, binding, versionId, "DEPOSIT_COMPENSATION", versionId, binding.ownerUserId, plan.amounts.depositCompensation!));
  await recordAudit(client, { actorType: actor.realm, actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: "order.legacy.continuation." + input.kind, objectType: "rental_order", objectId: orderId, outcome: "SUCCESS", details: { inputEvidenceId: row.id, resultEvidenceId: resultId, versionId, before: { revision: locked.head?.revision ?? null, stage: facts.evidence.source.orderStatus }, after: { revision, stage: resultFacts.evidence.source.orderStatus }, dutyIds, isolated, amountsDigest: sha256Hex(canonicalize(resultFacts.amounts)), ...(reviewedVoidCommissions.length ? { reviewedVoidCommissions } : {}) } });
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  return { status: 200, body: { orderId, command: input.kind, revision, versionId, inputEvidenceId: row.id, resultEvidenceId: resultId, stage: resultFacts.evidence.source.orderStatus, channelState: "UNKNOWN" } };
}

export type LegacyDutyCommandInput = { dutyId: string; expectedRevision: string; kind: "mature" | "void"; sourceFactAuditId?: string; reason?: string };
export async function applyLegacyDutyCommand(client: PoolClient, actor: LegacyContinuationActor, orderId: string, input: LegacyDutyCommandInput,authority?:LegacyMutationAuthority) {
  if (!["mature", "void"].includes(input.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.dutyId) || !/^[1-9]\d{0,17}$/.test(input.expectedRevision)) throw invalid("Invalid duty command");
  if (actor.realm !== "admin") throw conflict("DUTY_NOT_AUTHORIZED");
  const a=authority??await authorizeLegacyMutation(client,actor,orderId),binding=a.binding;
  const { duties } = await lockLegacyContinuationOrder(client, orderId), duty = duties.find(d => d.id === input.dutyId);
  await assertUserPrefix(client,actor,orderId,a);
  if (!duty) throw conflict("DUTY_NOT_FOUND");
  if (duty.kind !== "COMMISSION") throw conflict(input.kind === "mature" ? "MATURITY_NOT_APPLICABLE" : "VOID_NOT_AUTHORIZED");
  if (duty.settledBy === "LEGACY_RECORDS") throw conflict("LEGACY_TERMINAL_IMMUTABLE");
  if (duty.revision !== input.expectedRevision || !["PENDING", "MATURED"].includes(duty.status)) throw conflict("DUTY_REVISION_CONFLICT");
  if (input.kind === "mature" && duty.status !== "PENDING") throw conflict("DUTY_TRANSITION_INVALID");
  if (input.kind === "void") {
    if (!input.reason?.trim() || input.reason.length > 500 || !input.sourceFactAuditId) throw invalid("VOID_SOURCE_FACT_REQUIRED");
    const fact = (await client.query(`SELECT 1 FROM zzsh_iam.audit_event WHERE id=$1 AND object_id=$2 AND action='order.legacy.duty.source_fact_reviewed' AND outcome='SUCCESS'
      AND details->>'sourceRecordId'=$3 AND details->>'parentSourceDigest'=$4 AND (details->>'sourceStatus'='3' OR details->>'parentCancelledNotPayable'='true')`, [input.sourceFactAuditId, orderId, duty.sourceRecordId, binding.sourceDigest])).rowCount;
    if (!fact) throw conflict("VOID_SOURCE_FACT_REQUIRED");
  }
  const update = await client.query(`UPDATE zzsh_order.legacy_order_duty SET status=$3,revision=revision+1,decided_at=clock_timestamp(),decided_by=$4::jsonb,decision_reason=$5,decision_evidence_ref=$6
    WHERE id=$1 AND revision=$2 AND status=$7 ${input.kind === "mature" ? "AND maturity_at IS NOT NULL AND maturity_at<=clock_timestamp()" : ""} RETURNING ${LEGACY_DUTY_FIELDS}`,
    [duty.id, input.expectedRevision, input.kind === "mature" ? "MATURED" : "VOID", JSON.stringify(actor), input.reason ?? "MATURITY_REACHED", input.sourceFactAuditId ?? null, duty.status]);
  if (update.rowCount !== 1) throw conflict(input.kind === "mature" ? "MATURITY_NOT_REACHED" : "DUTY_REVISION_CONFLICT");
  await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: "order.legacy.duty." + input.kind, objectType: "rental_order", objectId: orderId, outcome: "SUCCESS", details: { dutyId: duty.id, beforeRevision: duty.revision, afterRevision: update.rows[0]!.revision, sourceFactAuditId: input.sourceFactAuditId ?? null, reason: input.reason ?? null } });
  return { status: 200, body: { dutyId: duty.id, status: update.rows[0]!.status, revision: update.rows[0]!.revision } };
}
