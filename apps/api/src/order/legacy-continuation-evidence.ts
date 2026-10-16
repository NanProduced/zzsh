import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { assertGameScope, conflict, forbidden, fingerprintRequest, invalid, newSupplyId, notFound, sha256Hex, withIdempotency } from "../supply/supply-util";
import { canonicalize } from "../supply/content-hash";
import type { LegacyContinuationSource } from "./legacy-continuation-calc";
import { assertLegacyCommissionEvidence, initialLegacyFacts, legacyCommissionMaturity, legacyDecimalEquals, legacyEconomicDutyId, legacyOrderAdvisoryKey, legacyPlanYuanToCents, legacyTimeMicros, projectLegacyContinuation, readSealedLegacyFacts, sealLegacyFacts,
  type CompletedCommissionTime, type LegacyCommissionEvidence, type LegacyContinuationActor, type LegacyDutyFinalizationReader, type LegacyDutyRow, type LegacyEvidenceRow, type LegacyHeadRow, type LegacyOrderBinding } from "./legacy-continuation-model";

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const LEGACY_DUTY_FIELDS = `id,order_id AS "orderId",continuation_version_id AS "continuationVersionId",kind,source_record_id AS "sourceRecordId",counterparty_user_id AS "counterpartyUserId",amount_cents::text AS "amountCents",currency,status,source,source_status AS "sourceStatus",level::text,ratio::text,${utc("maturity_at")} AS "maturityAt",revision::text,settled_by AS "settledBy",settled_ref_type AS "settledRefType",settled_ref_id AS "settledRefId",settled_ref_digest AS "settledRefDigest",admission_id AS "admissionId"`;
export async function readLegacyContinuationBinding(client: PoolClient, orderId: string): Promise<LegacyOrderBinding> {
  legacyOrderAdvisoryKey(orderId);
  const row = (await client.query<LegacyOrderBinding>(`SELECT id,legacy_id AS "legacyId",account_id AS "accountId",legacy_account_id AS "legacyAccountId",game_id AS "gameId",
    owner_user_id AS "ownerUserId",renter_user_id AS "renterUserId",legacy_owner_id AS "legacyOwnerId",legacy_renter_id AS "legacyRenterId",
    owner_source_digest AS "ownerSourceDigest",renter_source_digest AS "renterSourceDigest",source_digest AS "sourceDigest",
    source_order_status AS "sourceOrderStatus",source_pay_status AS "sourcePayStatus",recorded_paid_amount_cents::text AS "paidCents",${utc("source_completed_at")} AS "completedAt"
    FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1`, [orderId])).rows[0];
  if (!row) throw notFound();
  return row;
}
export async function authorizeLegacyContinuation(client: PoolClient, actor: LegacyContinuationActor, binding: LegacyOrderBinding, write = false, userIds: readonly string[] = [binding.ownerUserId,binding.renterUserId]): Promise<{ canOperate: boolean; canReadCommission: boolean }> {
  if (actor.realm === "user" && actor.userId !== binding.ownerUserId && actor.userId !== binding.renterUserId) throw notFound();
  // F's prefix uses the same ordered parties. No account lock is taken after the order lock.
  if (write) await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [[...new Set([...userIds,binding.ownerUserId,binding.renterUserId])].sort()]);
  let canOperate = false;
  let canReadCommission = false;
  if (actor.realm === "user") await assertUserContextInTransaction(client, actor);
  else {
    await assertAdminContextInTransaction(client, actor);
    const access = await loadEffectiveAdminAccess(client, actor.userId);
    requirePermission(access, "order.read");
    if (write) requirePermission(access, "order.legacy.continue");
    await assertGameScope(client, actor.userId, access?.isBoss === true, binding.gameId);
    canOperate = access?.isBoss === true || access?.permissions.has("order.legacy.continue") === true;
    canReadCommission = access?.isBoss === true || access?.permissions.has("finance.document.read") === true;
  }
  if (write) await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR SHARE`, [binding.gameId]);
  const valid = (await client.query<{ valid: boolean }>(`SELECT NOT EXISTS(
    SELECT 1 FROM (VALUES($1::text,$2::text,$3::text),($4::text,$5::text,$6::text)) AS p(user_id,legacy_id,digest)
    WHERE NOT EXISTS(SELECT 1 FROM zzsh_iam.user_identity_state i JOIN zzsh_iam.audit_event a ON a.object_id=i.user_id
      WHERE i.user_id=p.user_id AND i.provider='legacy_mysql_restore' AND i.provider_reference='la_user:'||p.legacy_id
        AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS' AND a.details->>'sourceSystem'='legacy_mysql_restore'
        AND a.details->>'sourceEntity'='la_user' AND a.details->>'legacyId'=p.legacy_id AND a.details->>'sourceDigest'=p.digest)) AS valid`,
    [binding.ownerUserId, binding.legacyOwnerId, binding.ownerSourceDigest, binding.renterUserId, binding.legacyRenterId, binding.renterSourceDigest])).rows[0]?.valid;
  if (valid !== true) throw conflict("PARTY_UNMAPPED");
  return { canOperate, canReadCommission };
}
/** Pre-read only: FK inserts also take beneficiary locks, so new commissions need the full prefix before head/duty. */
export async function readLegacyContinuationUserIds(client:PoolClient,binding:LegacyOrderBinding):Promise<string[]> {
  const rows=(await client.query<{id:string}>(`WITH current_facts AS(SELECT facts FROM zzsh_order.legacy_continuation_evidence e WHERE e.order_id=$1 AND e.id=COALESCE(
    (SELECT result_evidence_id FROM zzsh_order.legacy_continuation_version WHERE order_id=$1 AND superseded_at IS NULL),
    (SELECT id FROM zzsh_order.legacy_continuation_evidence WHERE order_id=$1 AND source_kind='SOURCE_IMPORT'))),
    ids AS(SELECT $2::text AS id UNION SELECT $3::text UNION SELECT counterparty_user_id FROM zzsh_order.legacy_order_duty WHERE order_id=$1
      UNION SELECT i.user_id FROM current_facts e CROSS JOIN LATERAL jsonb_array_elements(e.facts#>'{evidence,source,commissions}') c
        JOIN zzsh_iam.user_identity_state i ON i.provider='legacy_mysql_restore' AND i.provider_reference='la_user:'||(c->>'beneficiaryId') WHERE c->>'status'='1')
    SELECT u.id FROM ids JOIN zzsh_auth_user."user" u ON u.id=ids.id ORDER BY u.id`,[binding.id,binding.ownerUserId,binding.renterUserId])).rows;
  if(rows.some(r=>typeof r.id!=="string") || !rows.some(r=>r.id===binding.ownerUserId) || !rows.some(r=>r.id===binding.renterUserId))throw conflict("PARTY_UNMAPPED");
  return [...new Set(rows.map(r=>r.id))].sort();
}
export async function readLegacyContinuationHead(client: PoolClient, orderId: string, lock = false): Promise<LegacyHeadRow | null> {
  return (await client.query<LegacyHeadRow>(`SELECT id,order_id AS "orderId",revision::text,input_evidence_id AS "inputEvidenceId",result_evidence_id AS "resultEvidenceId",stage,is_settle AS "isSettle",command,amounts
    FROM zzsh_order.legacy_continuation_version WHERE order_id=$1 AND superseded_at IS NULL${lock ? " FOR UPDATE" : ""}`, [orderId])).rows[0] ?? null;
}
export async function readLegacyContinuationDuties(client: PoolClient, orderId: string, lock = false): Promise<LegacyDutyRow[]> {
  return (await client.query<LegacyDutyRow>(`SELECT ${LEGACY_DUTY_FIELDS} FROM zzsh_order.legacy_order_duty WHERE order_id=$1 ORDER BY id${lock ? " FOR UPDATE" : ""}`, [orderId])).rows;
}
/** Shared T/F lock domain. Caller acquires any users/game/account prefix first. */
export async function lockLegacyContinuationOrder(client: PoolClient, orderId: string): Promise<{ head: LegacyHeadRow | null; duties: LegacyDutyRow[] }> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [legacyOrderAdvisoryKey(orderId)]);
  const head = await readLegacyContinuationHead(client, orderId, true);
  return { head, duties: await readLegacyContinuationDuties(client, orderId, true) };
}
export async function readLegacyContinuationEvidence(client: PoolClient, orderId: string, head: LegacyHeadRow | null): Promise<LegacyEvidenceRow | null> {
  const row = (await client.query<LegacyEvidenceRow>(`SELECT id,order_id AS "orderId",evidence_version::text AS "evidenceVersion",source_kind AS "sourceKind",source_digest AS "sourceDigest",
    facts_digest AS "factsDigest",facts_canonical AS "factsCanonical",facts FROM zzsh_order.legacy_continuation_evidence
    WHERE order_id=$1 AND ${head ? "id=$2" : "source_kind='SOURCE_IMPORT'"}`, head ? [orderId, head.resultEvidenceId] : [orderId])).rows[0] ?? null;
  if (head && !row) throw conflict("EVIDENCE_RELATION");
  if (row) {
    const facts = readSealedLegacyFacts(row);
    if (head && (facts.derivedFromCommandVersionId !== head.id || facts.evidence.source.orderStatus !== String(head.stage) || canonicalize(facts.amounts) !== canonicalize(head.amounts))) throw conflict("EVIDENCE_RELATION");
  }
  return row;
}
export async function readLegacyContinuation(client: PoolClient, actor: LegacyContinuationActor, orderId: string, finance?: LegacyDutyFinalizationReader) {
  const binding = await readLegacyContinuationBinding(client, orderId);
  const access = await authorizeLegacyContinuation(client, actor, binding);
  const head = await readLegacyContinuationHead(client, orderId), duties = await readLegacyContinuationDuties(client, orderId);
  const evidence = await readLegacyContinuationEvidence(client, orderId, head);
  const disposition = finance ? await finance(client, orderId, duties) : "UNKNOWN";
  return { continuation: projectLegacyContinuation(binding, actor, evidence, head, duties, access.canOperate, disposition, access.canReadCommission) };
}

export async function legacyBeneficiaryUserId(client: PoolClient, legacyId: string): Promise<string | null> {
  if (!/^[1-9]\d{0,23}$/.test(legacyId)) return null;
  const userId = legacyOwnerUserId("legacy_mysql_restore", "la_user", legacyId);
  const row = (await client.query(`SELECT 1 FROM zzsh_iam.user_identity_state i WHERE i.user_id=$1 AND i.provider='legacy_mysql_restore' AND i.provider_reference=$2
    AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=i.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS'
      AND a.details->>'sourceSystem'='legacy_mysql_restore' AND a.details->>'sourceEntity'='la_user' AND a.details->>'legacyId'=$3)`, [userId, "la_user:" + legacyId, legacyId])).rowCount;
  return row ? userId : null;
}
async function authorizeImport(client: PoolClient, actor: LegacyContinuationActor, binding: LegacyOrderBinding) {
  if (actor.realm !== "admin") throw forbidden();
  await assertAdminContextInTransaction(client, actor);
  const access = await loadEffectiveAdminAccess(client, actor.userId);
  requirePermission(access, "supply.catalog.manage"); requirePermission(access, "order.read");
  await assertGameScope(client, actor.userId, access?.isBoss === true, binding.gameId);
}
export type LegacyContinuationImport = { orderId: string; sourceDigest: string; sourceAsOf: string; evidenceRef: string; source: LegacyContinuationSource; commissionEvidence: LegacyCommissionEvidence[] };
/** Trusted, separately scoped maintenance caller owns the transaction. No public import endpoint. */
export async function importLegacyContinuationEvidence(client: PoolClient, actor: LegacyContinuationActor, input: LegacyContinuationImport) {
  input = structuredClone(input);
  const binding = await readLegacyContinuationBinding(client, input.orderId), facts = initialLegacyFacts(input.source, input.commissionEvidence), sealed = sealLegacyFacts(facts);
  for (const commission of input.source.commissions) { const proof = input.commissionEvidence?.find(p => p.sourceRecordId === commission.id); if (!proof) throw invalid("COMMISSION_SOURCE_EVIDENCE_MISSING"); assertLegacyCommissionEvidence(proof, binding.legacyId, commission); }
  if (input.sourceDigest !== binding.sourceDigest || input.source.legacyOrderId !== binding.legacyId || input.source.renterId !== binding.legacyRenterId || input.source.ownerId !== binding.legacyOwnerId || input.source.accountId !== binding.legacyAccountId
    || input.source.orderStatus !== String(binding.sourceOrderStatus) || binding.sourcePayStatus !== 1 || input.source.payMoney === null || legacyPlanYuanToCents(input.source.payMoney) !== binding.paidCents) throw conflict("SOURCE_BINDING_MISMATCH");
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest) || typeof input.evidenceRef !== "string" || !input.evidenceRef || input.evidenceRef.length > 512) throw invalid("Invalid source evidence binding");
  legacyTimeMicros(input.sourceAsOf);
  const operation = "order.legacy.continuation.import";
  return withIdempotency(client, { realm: "admin", principalId: actor.userId, operation, resourceId: input.orderId }, sha256Hex(JSON.stringify([input.orderId, sealed.digest])), fingerprintRequest(operation, input.orderId, input),
    async () => { await authorizeImport(client, actor, binding); }, async () => {
      const locked = await lockLegacyContinuationOrder(client, input.orderId);
      const existing = await readLegacyContinuationEvidence(client, input.orderId, null);
      if (existing) {
        if (existing.factsDigest !== sealed.digest) throw conflict("SOURCE_EVIDENCE_CONFLICT");
        return { status: 200, body: { evidenceId: existing.id, admission: facts.evidence.admission } };
      }
      if (locked.head) throw conflict("EVIDENCE_RELATION");
      const id = newSupplyId("legacy_evidence");
      await client.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,parameter_digest,admission,reasons,facts,facts_canonical,facts_digest)
        VALUES($1,$2,1,'SOURCE_IMPORT',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`, [id, input.orderId, input.sourceAsOf, input.evidenceRef, input.sourceDigest, facts.evidence.parameterDigest, facts.evidence.admission, JSON.stringify(facts.evidence.reasons), JSON.stringify(facts), sealed.canonical, sealed.digest]);
      const isolated: Array<{ sourceRecordId: string; reason: string }> = [];
      for (const commission of input.source.commissions) {
        if (commission.status !== "1" || ![3, 8, 9].includes(binding.sourceOrderStatus)) continue;
        const beneficiary = await legacyBeneficiaryUserId(client, commission.beneficiaryId);
        if (!beneficiary) { isolated.push({ sourceRecordId: commission.id, reason: "PARTY_UNMAPPED" }); continue; }
        await insertImportedCommission(client, binding, commission, beneficiary, null, input.sourceDigest);
      }
      await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: operation, objectType: "rental_order", objectId: input.orderId, outcome: "SUCCESS", details: { evidenceId: id, sourceDigest: input.sourceDigest, factsDigest: sealed.digest, admission: facts.evidence.admission, isolated } });
      return { status: 200, body: { evidenceId: id, admission: facts.evidence.admission, isolated } };
    });
}
async function insertImportedCommission(client: PoolClient, binding: LegacyOrderBinding, commission: LegacyContinuationSource["commissions"][number], beneficiary: string, maturityAt: string | null, sourceDigest: string, admissionId: string | null = null) {
  const id = legacyEconomicDutyId(binding.id, "COMMISSION", commission.id), amount = legacyPlanYuanToCents(commission.storedEarnings);
  const existing = (await client.query<LegacyDutyRow>(`SELECT ${LEGACY_DUTY_FIELDS} FROM zzsh_order.legacy_order_duty WHERE order_id=$1 AND kind='COMMISSION' AND source_record_id=$2 FOR UPDATE`, [binding.id, commission.id])).rows[0];
  if (existing) {
    if (existing.counterpartyUserId !== beneficiary || existing.level !== commission.level || !legacyDecimalEquals(existing.ratio, commission.ratio) || (existing.admissionId ?? null) !== admissionId) throw conflict("DUTY_SOURCE_BINDING_MISMATCH");
    // Confirm may already have recalculated this economic key; import never overwrites it.
    return;
  }
  if (!/^[1-9]\d{0,23}$/.test(commission.id) || !["2", "3"].includes(commission.level)) throw invalid("COMMISSION_UNPROVEN");
  await client.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,level,ratio,maturity_at,source_digest,admission_id)
    VALUES($1,$2,'COMMISSION',$3,$4,$5,'CNY','PENDING','LEGACY_IMPORT','1',$6,$7,$8,$9,$10)`, [id, binding.id, commission.id, beneficiary, amount, commission.level, commission.ratio, maturityAt, sourceDigest, admissionId]);
}
export type LegacyCompletedCommissionImport = { orderId: string; sourceDigest: string; finalAmountEvidenceDigest: string; finalAmountEvidenceCanonical: string; timeEvidenceCanonical: string; evidenceRef: string; cutoff: string; time: CompletedCommissionTime; sourceTimeValue: string; sourceTimeUnit: "UNIX_SECONDS" | "RFC3339_UTC"; corroboratingTime?: { time: CompletedCommissionTime; canonical: string }; commission: LegacyContinuationSource["commissions"][number]; sourceRecord: LegacyCommissionEvidence };
/** Independent completed-parent entry: no confirm, account divisor, or whole calc admission. */
export async function importLegacyCompletedCommission(client: PoolClient, actor: LegacyContinuationActor, input: LegacyCompletedCommissionImport) {
  input = structuredClone(input);
  const binding = await readLegacyContinuationBinding(client, input.orderId);
  await authorizeImport(client, actor, binding);
  if (binding.sourceOrderStatus !== 4 || binding.sourcePayStatus !== 1 || binding.sourceDigest !== input.sourceDigest || input.commission.status !== "1") throw conflict("COMPLETED_COMMISSION_SOURCE_INVALID");
  assertLegacyCommissionEvidence(input.sourceRecord, binding.legacyId, input.commission);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(input.time.at) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(input.cutoff)) throw invalid("ISOLATED_MATURITY_EVIDENCE_MISSING");
  const amountCents = legacyPlanYuanToCents(input.commission.storedEarnings);
  const finalProof = canonicalize({ parentSourceDigest: input.sourceDigest, sourceRecordDigest: input.sourceRecord.digest, beneficiaryLegacyId: input.commission.beneficiaryId, amountCents, cutoff: input.cutoff });
  const timeProof = canonicalize({ parentSourceDigest: input.sourceDigest, sourceRecordDigest: input.sourceRecord.digest, kind: input.time.kind, at: input.time.at, sourceValue: input.sourceTimeValue, sourceUnit: input.sourceTimeUnit, cutoff: input.cutoff });
  if (input.sourceTimeUnit === "UNIX_SECONDS" ? !/^(0|[1-9]\d{0,11})$/.test(input.sourceTimeValue) || BigInt(input.sourceTimeValue)*1000000n !== legacyTimeMicros(input.time.at) : input.sourceTimeUnit !== "RFC3339_UTC" || legacyTimeMicros(input.sourceTimeValue) !== legacyTimeMicros(input.time.at)) throw invalid("ISOLATED_MATURITY_EVIDENCE_MISSING");
  if (input.finalAmountEvidenceCanonical !== finalProof || input.finalAmountEvidenceDigest !== sha256Hex(finalProof) || input.timeEvidenceCanonical !== timeProof || input.time.evidenceDigest !== sha256Hex(timeProof) || !input.evidenceRef || input.evidenceRef.length > 512) throw invalid("ISOLATED_MATURITY_EVIDENCE_MISSING");
  if (input.time.kind === "COMPLETED_AT" && (!binding.completedAt || legacyTimeMicros(input.time.at) !== legacyTimeMicros(binding.completedAt))) throw conflict("ISOLATED_COMPLETED_TIME_UNBOUND");
  const maturity = legacyCommissionMaturity(input.time, input.cutoff), beneficiary = await legacyBeneficiaryUserId(client, input.commission.beneficiaryId);
  if (input.corroboratingTime) {
    const other=input.corroboratingTime, expected=canonicalize({ parentSourceDigest: input.sourceDigest, sourceRecordDigest: input.sourceRecord.digest, kind: other.time.kind, at: other.time.at, cutoff: input.cutoff });
    if (other.time.kind===input.time.kind || other.canonical!==expected || sha256Hex(expected)!==other.time.evidenceDigest || legacyCommissionMaturity(other.time,input.cutoff).maturityAt!==maturity.maturityAt
      || other.time.kind==="COMPLETED_AT" && (!binding.completedAt || legacyTimeMicros(other.time.at)!==legacyTimeMicros(binding.completedAt))) throw conflict("ISOLATED_MATURITY_EVIDENCE_CONFLICT");
  }
  if (!beneficiary) return { admission: "ISOLATED", reason: "PARTY_UNMAPPED", sourceRecordId: input.commission.id };
  const operation = "order.legacy.commission.completed-import";
  return withIdempotency(client, { realm: "admin", principalId: actor.userId, operation, resourceId: input.orderId }, sha256Hex(input.commission.id), fingerprintRequest(operation, input.orderId, input),
    async () => { await authorizeImport(client, actor, binding); }, async () => {
      await lockLegacyContinuationOrder(client, input.orderId);
      const dutyId = legacyEconomicDutyId(input.orderId, "COMMISSION", input.commission.id), admissionId = "legacy_admission_" + sha256Hex(dutyId).slice(0, 40);
      const canonical = canonicalize({ schema: "legacy-completed-commission-admission.v1", ...input, beneficiaryUserId: beneficiary, amountCents, maturityAt: maturity.maturityAt });
      const previous = (await client.query<{ digest: string }>(`SELECT admission_digest AS digest FROM zzsh_order.legacy_order_duty_admission WHERE id=$1`, [admissionId])).rows[0];
      if (previous && previous.digest !== sha256Hex(canonical)) throw conflict("COMMISSION_ADMISSION_CONFLICT");
      if (!previous) await client.query(`INSERT INTO zzsh_order.legacy_order_duty_admission(id,duty_id,order_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,level,ratio,parent_source_digest,source_canonical,source_record_digest,final_amount_evidence_canonical,final_amount_evidence_digest,time_kind,source_time,time_evidence_canonical,time_evidence_digest,cutoff,maturity_at,evidence_ref,admission_canonical,admission_digest,reviewed_by,source_time_value,source_time_unit)
        VALUES($1,$2,$3,'COMMISSION',$4,$5,$6,'CNY',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25)`,
        [admissionId,dutyId,input.orderId,input.commission.id,beneficiary,amountCents,input.commission.level,input.commission.ratio,input.sourceDigest,input.sourceRecord.canonical,input.sourceRecord.digest,finalProof,input.finalAmountEvidenceDigest,input.time.kind,input.time.at,timeProof,input.time.evidenceDigest,input.cutoff,maturity.maturityAt,input.evidenceRef,canonical,sha256Hex(canonical),JSON.stringify(actor),input.sourceTimeValue,input.sourceTimeUnit]);
      await insertImportedCommission(client, binding, input.commission, beneficiary, maturity.maturityAt, input.sourceDigest, admissionId);
      await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: operation, objectType: "rental_order", objectId: input.orderId, outcome: "SUCCESS", details: { sourceRecordId: input.commission.id, sourceRecordDigest: input.sourceRecord.digest, parentSourceDigest: input.sourceDigest, admissionId, admissionDigest: sha256Hex(canonical), finalAmountEvidenceDigest: input.finalAmountEvidenceDigest, time: input.time, cutoff: input.cutoff, maturityAt: maturity.maturityAt, maturedByCutoff: maturity.maturedByCutoff } });
      return { status: 200, body: { admission: "IMPORTED", dutyId: legacyEconomicDutyId(input.orderId, "COMMISSION", input.commission.id), maturityAt: maturity.maturityAt } };
    });
}
