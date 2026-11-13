import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { assertUserContextInTransaction } from "../auth/user-identity";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { authorizeSystemOrderMigration, type SystemOrderMigrationActor } from "../legacy-load/system-user-migration";
import { legacyEarlyPartyConfirmed, projectLegacySettlementBasis, readLatestLegacySettlementBasisId, readLegacyProposalBasis, readLegacySettlementBasis } from "./legacy-settlement-basis";
import { assertGameScope, conflict, forbidden, fingerprintRequest, invalid, newSupplyId, notFound, sha256Hex, withIdempotency } from "../supply/supply-util";
import { canonicalize } from "../supply/content-hash";
import type { LegacyContinuationSource } from "./legacy-continuation-calc";
import { legacyContinuationReady } from "./legacy-order-read";
import { assertLegacyCommissionEvidence, initialLegacyFacts, legacyCommissionMaturity, legacyDecimalEquals, legacyEconomicDutyId, legacyOrderAdvisoryKey, legacyPlanYuanToCents, legacyTimeMicros, projectLegacyContinuation, readSealedLegacyFacts, sealLegacyFacts,
  type CompletedCommissionTime, type LegacyCommissionEvidence, type LegacyContinuationActor, type LegacyDutyFinalizationReader, type LegacyDutyRow, type LegacyEvidenceRow, type LegacyHeadRow, type LegacyOrderBinding } from "./legacy-continuation-model";

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const LEGACY_DUTY_FIELDS = `id,order_id AS "orderId",continuation_version_id AS "continuationVersionId",kind,source_record_id AS "sourceRecordId",counterparty_user_id AS "counterpartyUserId",amount_cents::text AS "amountCents",currency,status,source,source_status AS "sourceStatus",level::text,ratio::text,${utc("maturity_at")} AS "maturityAt",revision::text,settled_by AS "settledBy",settled_ref_type AS "settledRefType",settled_ref_id AS "settledRefId",settled_ref_digest AS "settledRefDigest",admission_id AS "admissionId"`;
export async function readLegacyContinuationBinding(client: PoolClient, orderId: string): Promise<LegacyOrderBinding> {
  legacyOrderAdvisoryKey(orderId);
  const row = (await client.query<LegacyOrderBinding>(`SELECT id,legacy_id AS "legacyId",account_id AS "accountId",legacy_account_id AS "legacyAccountId",game_id AS "gameId",
    owner_user_id AS "ownerUserId",renter_user_id AS "renterUserId",legacy_owner_id AS "legacyOwnerId",legacy_renter_id AS "legacyRenterId",
    owner_source_digest AS "ownerSourceDigest",renter_source_digest AS "renterSourceDigest",source_digest AS "sourceDigest",
    source_order_status AS "sourceOrderStatus",source_pay_status AS "sourcePayStatus",recorded_paid_amount_cents::text AS "paidCents",${utc("source_completed_at")} AS "completedAt",source_snapshot->>'is_delete' AS "sourceDeletedFlag"
    FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1`, [orderId])).rows[0];
  if (!row) throw notFound();
  return row;
}
export async function authorizeLegacyContinuation(client: PoolClient, actor: LegacyContinuationActor, binding: LegacyOrderBinding, write = false, userIds: readonly string[] = [binding.ownerUserId,binding.renterUserId]): Promise<{ canOperate: boolean; canReadCommission: boolean; canSettle?:boolean }> {
  if (actor.realm === "user" && ((actor.userId !== binding.ownerUserId && actor.userId !== binding.renterUserId)
    || (binding.sourceDeletedFlag != null && binding.sourceDeletedFlag !== "0"))) throw notFound();
  // F's prefix uses the same ordered parties. No account lock is taken after the order lock.
  if (write) await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [[...new Set([...userIds,binding.ownerUserId,binding.renterUserId])].sort()]);
  let canOperate = false;
  let canReadCommission = false;
  let canSettle = false;
  if (actor.realm === "user") await assertUserContextInTransaction(client, actor);
  else {
    await assertAdminContextInTransaction(client, actor);
    const access = await loadEffectiveAdminAccess(client, actor.userId);
    requirePermission(access, "order.read");
    if (write) requirePermission(access, "order.legacy.continue");
    await assertGameScope(client, actor.userId, access?.isBoss === true, binding.gameId);
    canOperate = access?.isBoss === true || access?.permissions.has("order.legacy.continue") === true;
    canReadCommission = access?.isBoss === true || access?.permissions.has("finance.document.read") === true;
    canSettle = access?.isBoss === true || access?.permissions.has("order.settlement.write") === true;
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
  return { canOperate, canReadCommission, canSettle };
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
  return (await client.query<LegacyHeadRow>(`SELECT id,order_id AS "orderId",revision::text,input_evidence_id AS "inputEvidenceId",result_evidence_id AS "resultEvidenceId",stage,is_settle AS "isSettle",command,amounts,
    (SELECT to_char((to_jsonb(confirmed)->>'refund_due_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM zzsh_order.legacy_continuation_version confirmed
      WHERE confirmed.order_id=zzsh_order.legacy_continuation_version.order_id AND confirmed.command IN('CONFIRM','SUPPORT_CANCEL') ORDER BY confirmed.revision DESC LIMIT 1) AS "refundDueAt"
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
/** Do not offer a write action before the matching database guards are installed. */
export async function legacySupportCancellationReady(client: Pick<PoolClient,"query">): Promise<boolean> {
  const result = await client.query<{ready:boolean}>(`SELECT COALESCE(
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.legacy_continuation_version')
      AND conname='legacy_continuation_version_command_check' AND pg_get_constraintdef(oid) LIKE '%SUPPORT_CANCEL%')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.legacy_continuation_version')
      AND conname='legacy_continuation_version_stage_check' AND pg_get_constraintdef(oid) LIKE '%5%')
    AND position('SUPPORT_CANCEL' IN pg_get_functiondef(to_regprocedure('zzsh_order.check_legacy_continuation_result()')))>0
    AND position('ownerGross' IN pg_get_functiondef(to_regprocedure('zzsh_order.check_legacy_continuation_result()')))>0
    AND position('SUPPORT_CANCEL' IN pg_get_functiondef(to_regprocedure('zzsh_order.guard_legacy_duty()')))>0
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['id','order_id','revision','command','actor','input_evidence_id','result_evidence_id','stage','is_settle','is_advance_set','amounts','commission_revisions','assignments','plan_fingerprint','created_at']) col
      WHERE NOT has_column_privilege(current_user,to_regclass('zzsh_order.legacy_continuation_version'),col,'INSERT'))
    AND has_column_privilege(current_user,to_regclass('zzsh_order.legacy_continuation_version'),'superseded_at','UPDATE')
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['status','revision','decided_at','decided_by','decision_reason','decision_evidence_ref']) col
      WHERE NOT has_column_privilege(current_user,to_regclass('zzsh_order.legacy_order_duty'),col,'UPDATE')),false) AS ready`);
  return result.rows[0]?.ready === true;
}
export async function readLegacyContinuation(client: PoolClient, actor: LegacyContinuationActor, orderId: string, finance?: LegacyDutyFinalizationReader) {
  const binding = await readLegacyContinuationBinding(client, orderId);
  const access = await authorizeLegacyContinuation(client, actor, binding);
  if (!(await legacyContinuationReady(client))) {
    return { continuation: projectLegacyContinuation(binding, actor, null, null, []) };
  }
  const head = await readLegacyContinuationHead(client, orderId), duties = await readLegacyContinuationDuties(client, orderId);
  const evidence = await readLegacyContinuationEvidence(client, orderId, head);
  const disposition = finance ? await finance(client, orderId, duties) : "UNKNOWN";
  const continuation=projectLegacyContinuation(binding, actor, evidence, head, duties, access.canOperate, disposition, access.canReadCommission,access.canSettle===true);
  if (evidence && continuation.stage === "3") {
    const basis=await readLegacySettlementBasis(client,binding,evidence,head);
    continuation.settlementBasis=basis?projectLegacySettlementBasis(basis):null;
    if(actor.realm==="admin" && access.canSettle===true)continuation.lastBasisId=basis?.id??await readLatestLegacySettlementBasisId(client,binding);
    if(!basis){continuation.capabilities=continuation.capabilities.filter(kind=>kind!=="preview"&&kind!=="propose");
      if(!continuation.reasons.includes("OPENING_BASIS_UNVERIFIED"))continuation.reasons.push("OPENING_BASIS_UNVERIFIED");}
  }
  if (evidence && ["8","9","4"].includes(continuation.stage ?? "")) {
    const source=readSealedLegacyFacts(evidence).evidence.source.settlementV2;
    if(source) {
      const basis=await readLegacyProposalBasis(client,binding,source.basisId,source.inputEvidenceId);
      continuation.settlementBasis=basis?projectLegacySettlementBasis(basis):null;
    }
  }
  if(evidence && head && ["8","9"].includes(continuation.stage??"") && readSealedLegacyFacts(evidence).evidence.source.isAdvanceSet==="1") {
    const pending=await legacyEarlyPartyConfirmed(client,binding,head,evidence);continuation.earlyReviewPending=pending;
    if(pending && !continuation.reasons.includes("EARLY_REVIEW_PENDING"))continuation.reasons.push("EARLY_REVIEW_PENDING");
    if(pending && actor.realm==="user")continuation.capabilities=continuation.capabilities.filter(kind=>kind!=="confirm");
  }
  if (continuation.capabilities.includes("support_cancel") && !(await legacySupportCancellationReady(client)))
    continuation.capabilities=continuation.capabilities.filter(kind=>kind!=="support_cancel");
  if(actor.realm!=="admin" || !access.canReadCommission)return {continuation};
  const commissionUsers=[...new Set(duties.filter(d=>d.kind==="COMMISSION"&&d.counterpartyUserId).map(d=>d.counterpartyUserId!))];
  if(!commissionUsers.length)return {continuation};
  const users=(await client.query<{id:string;name:string|null}>(`SELECT id,name FROM zzsh_auth_user."user" WHERE id=ANY($1::text[])`,[commissionUsers])).rows;
  const names=new Map(users.map(user=>[user.id,typeof user.name==="string"&&user.name.trim()?user.name.trim():null]));
  const sources=new Map(duties.map(duty=>[duty.id,duty]));
  return {continuation:{...continuation,duties:continuation.duties.map(d=>{
    const source=sources.get(d.id);
    return source?.kind==="COMMISSION"&&source.counterpartyUserId?{...d,beneficiary:{userId:source.counterpartyUserId,name:names.get(source.counterpartyUserId)??null}}:d;
  })}};
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
/** A system import can only build on the same run's original legacy order and audit. */
export async function readSystemLegacyOrderOrigin(client: PoolClient, actor: SystemOrderMigrationActor, binding: LegacyOrderBinding): Promise<string> {
  const source=(await client.query<{bindingDigest:string}>(`SELECT o.binding_digest AS "bindingDigest" FROM zzsh_order.legacy_order_read_snapshot o
    WHERE o.id=$1 AND o.source_digest=$2 AND o.created_by_migration_id=$3 AND o.migration_manifest_sha256=$4
      AND EXISTS (SELECT 1 FROM zzsh_iam.audit_event e WHERE e.object_type='rental_order' AND e.object_id=o.id
        AND e.action='order.legacy.read_imported' AND e.outcome='SUCCESS' AND e.actor_type='system' AND e.actor_id=$3
        AND e.session_id IS NULL AND e.legacy_migration_manifest_sha256=$4 AND e.details->>'legacyId'=o.legacy_id
        AND e.details->>'sourceDigest'=o.source_digest AND e.details->>'bindingDigest'=o.binding_digest)`,
    [binding.id,binding.sourceDigest,actor.id,actor.sourceDatasetSha256])).rows[0];
  if (!source) throw conflict("LEGACY_SYSTEM_ORDER_SOURCE_UNPROVEN");
  return source.bindingDigest;
}
/** Trusted, separately scoped maintenance caller owns the transaction. No public import endpoint. */
export async function importLegacyContinuationEvidence(client: PoolClient, actor: LegacyContinuationActor | SystemOrderMigrationActor, input: LegacyContinuationImport) {
  input = structuredClone(input);
  const systemActor = "kind" in actor && actor.kind === "SYSTEM_ORDER_MIGRATION" ? actor : null;
  const adminActor = systemActor ? null : actor as LegacyContinuationActor;
  const binding = await readLegacyContinuationBinding(client, input.orderId), facts = initialLegacyFacts(input.source, input.commissionEvidence), sealed = sealLegacyFacts(facts);
  if (systemActor && (!Array.isArray(input.source.commissions) || new Set(input.source.commissions.map(row=>row.id)).size!==input.source.commissions.length))
    throw conflict("COMMISSION_SOURCE_DUPLICATE");
  for (const commission of input.source.commissions) { const proof = input.commissionEvidence?.find(p => p.sourceRecordId === commission.id); if (!proof) throw invalid("COMMISSION_SOURCE_EVIDENCE_MISSING"); assertLegacyCommissionEvidence(proof, binding.legacyId, commission); }
  if (input.sourceDigest !== binding.sourceDigest || input.source.legacyOrderId !== binding.legacyId || input.source.renterId !== binding.legacyRenterId || input.source.ownerId !== binding.legacyOwnerId || input.source.accountId !== binding.legacyAccountId
    || input.source.orderStatus !== String(binding.sourceOrderStatus) || binding.sourcePayStatus !== 1 || input.source.payMoney === null || legacyPlanYuanToCents(input.source.payMoney) !== binding.paidCents) throw conflict("SOURCE_BINDING_MISMATCH");
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest) || typeof input.evidenceRef !== "string" || !input.evidenceRef || input.evidenceRef.length > 512) throw invalid("Invalid source evidence binding");
  legacyTimeMicros(input.sourceAsOf);
  const operation = "order.legacy.continuation.import";
  const key = sha256Hex(JSON.stringify([input.orderId, sealed.digest])), fingerprint = fingerprintRequest(operation, input.orderId, input);
  const payloadDigest = sha256Hex(canonicalize(input));
  const bindingDigest = systemActor ? await readSystemLegacyOrderOrigin(client,systemActor,binding) : null;
  return withIdempotency(client, { realm: systemActor ? "system" : "admin", principalId: systemActor?.id ?? adminActor!.userId, operation, resourceId: input.orderId }, key, fingerprint,
    async replay => {
      if (!systemActor) return authorizeImport(client, adminActor!, binding);
      await authorizeSystemOrderMigration(client, systemActor, {orderId:input.orderId,legacyId:binding.legacyId,sourceDigest:input.sourceDigest,
        bindingDigest:bindingDigest!,operation:"CONTINUATION",payloadDigest});
      const existing = (await client.query<{id:string;sourceDigest:string;factsDigest:string;admission:string;actorId:string|null;manifest:string|null}>(`SELECT id,source_digest AS "sourceDigest",facts_digest AS "factsDigest",admission,
        created_by_migration_id AS "actorId",migration_manifest_sha256 AS manifest FROM zzsh_order.legacy_continuation_evidence
        WHERE order_id=$1 AND source_kind='SOURCE_IMPORT'`,[input.orderId])).rows;
      const audits = (await client.query<{actor_id:string;actor_type:string;session_id:string|null;manifest:string|null;details:Record<string,unknown>}>(`SELECT actor_id,actor_type,session_id,legacy_migration_manifest_sha256 AS manifest,details
        FROM zzsh_iam.audit_event WHERE object_type='rental_order' AND object_id=$1 AND action=$2 AND outcome='SUCCESS'`,[input.orderId,operation])).rows;
      const duties=(await client.query<LegacyDutyRow & {sourceDigest:string}>(`SELECT ${LEGACY_DUTY_FIELDS},source_digest AS "sourceDigest" FROM zzsh_order.legacy_order_duty
        WHERE order_id=$1 AND kind='COMMISSION' AND source='LEGACY_IMPORT'`,[input.orderId])).rows;
      if (!replay) { if (existing.length || audits.length || duties.length) throw conflict("LEGACY_SYSTEM_CONTINUATION_RECEIPT_MISSING"); return; }
      const receipt=(await client.query<{request_fingerprint:string;response_status:number;response_body:unknown;publish_required:boolean}>(`SELECT request_fingerprint,response_status,response_body,publish_required
        FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,[JSON.stringify(["system",systemActor.id,operation,input.orderId]),key])).rows;
      const row=existing[0],audit=audits[0],detail=audit?.details;
      if (replay.publishRequired || existing.length!==1 || audits.length!==1 || receipt.length!==1
          || row?.sourceDigest!==input.sourceDigest || row.factsDigest!==sealed.digest || row.admission!==facts.evidence.admission
          || row.actorId!==systemActor.id || row.manifest!==systemActor.sourceDatasetSha256
          || audit?.actor_type!=="system" || audit.actor_id!==systemActor.id || audit.session_id!==null || audit.manifest!==systemActor.sourceDatasetSha256
          || detail?.evidenceId!==row.id || detail.sourceDigest!==input.sourceDigest || detail.factsDigest!==sealed.digest
          || detail.bindingDigest!==bindingDigest || detail.payloadDigest!==payloadDigest || detail.admission!==row.admission
          || detail.sourceSystem!=="legacy_mysql_restore" || detail.sourceEntity!=="la_order" || detail.legacyId!==binding.legacyId
          || detail.sourceDatasetSha256!==systemActor.sourceDatasetSha256 || detail.migrationRunDigest!==systemActor.id.slice("legacy-order-migration:".length)
          || !Array.isArray(detail.isolated) || detail.isolated.length!==0
          || receipt[0]!.request_fingerprint!==fingerprint || receipt[0]!.response_status!==200 || receipt[0]!.publish_required!==false
          || canonicalize(receipt[0]!.response_body)!==canonicalize({evidenceId:row.id,admission:row.admission,isolated:[]}))
        throw conflict("LEGACY_SYSTEM_CONTINUATION_RECEIPT_DIFFERS");
      const commissions=[3,8,9].includes(binding.sourceOrderStatus)?input.source.commissions.filter(c=>c.status==="1"):[];
      if (duties.length!==commissions.length) throw conflict("LEGACY_SYSTEM_CONTINUATION_DUTY_DIFFERS");
      for (const commission of commissions) {
        const beneficiary=await legacyBeneficiaryUserId(client,commission.beneficiaryId),duty=duties.find(d=>d.id===legacyEconomicDutyId(binding.id,"COMMISSION",commission.id));
        if (!beneficiary || !duty || duty.sourceRecordId!==commission.id || duty.counterpartyUserId!==beneficiary || duty.level!==commission.level
            || !legacyDecimalEquals(duty.ratio,commission.ratio) || duty.source!=="LEGACY_IMPORT" || duty.sourceDigest!==input.sourceDigest)
          throw conflict("LEGACY_SYSTEM_CONTINUATION_DUTY_DIFFERS");
      }
    }, async () => {
      const locked = await lockLegacyContinuationOrder(client, input.orderId);
      const existing = await readLegacyContinuationEvidence(client, input.orderId, null);
      if (existing) {
        if (systemActor) throw conflict("LEGACY_SYSTEM_CONTINUATION_RECEIPT_MISSING");
        if (existing.factsDigest !== sealed.digest) throw conflict("SOURCE_EVIDENCE_CONFLICT");
        return { status: 200, body: { evidenceId: existing.id, admission: facts.evidence.admission } };
      }
      if (locked.head) throw conflict("EVIDENCE_RELATION");
      const id = newSupplyId("legacy_evidence");
      await client.query(`INSERT INTO zzsh_order.legacy_continuation_evidence(id,order_id,evidence_version,source_kind,source_as_of,evidence_ref,source_digest,parameter_digest,admission,reasons,facts,facts_canonical,facts_digest${systemActor ? ",created_by_migration_id,migration_manifest_sha256" : ""})
        VALUES($1,$2,1,'SOURCE_IMPORT',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11${systemActor ? ",$12,$13" : ""})`, [id, input.orderId, input.sourceAsOf, input.evidenceRef, input.sourceDigest, facts.evidence.parameterDigest, facts.evidence.admission, JSON.stringify(facts.evidence.reasons), JSON.stringify(facts), sealed.canonical, sealed.digest,
        ...(systemActor ? [systemActor.id,systemActor.sourceDatasetSha256] : [])]);
      const isolated: Array<{ sourceRecordId: string; reason: string }> = [];
      for (const commission of input.source.commissions) {
        if (commission.status !== "1" || ![3, 8, 9].includes(binding.sourceOrderStatus)) continue;
        const beneficiary = await legacyBeneficiaryUserId(client, commission.beneficiaryId);
        if (!beneficiary) { if (systemActor) throw conflict("PARTY_UNMAPPED"); isolated.push({ sourceRecordId: commission.id, reason: "PARTY_UNMAPPED" }); continue; }
        await insertImportedCommission(client, binding, commission, beneficiary, null, input.sourceDigest);
      }
      await recordAudit(client, { actorType: systemActor ? "system" : "admin", actorId: systemActor?.id ?? adminActor!.userId,
        ...(systemActor ? {legacyMigrationManifestSha256:systemActor.sourceDatasetSha256} : {sessionId:adminActor!.sessionId}),
        requestId: actor.requestId, action: operation, objectType: "rental_order", objectId: input.orderId, outcome: "SUCCESS", details: { evidenceId: id, sourceDigest: input.sourceDigest, factsDigest: sealed.digest, admission: facts.evidence.admission, isolated,
          ...(systemActor ? {sourceSystem:"legacy_mysql_restore",sourceEntity:"la_order",legacyId:binding.legacyId,bindingDigest,payloadDigest,
            sourceDatasetSha256:systemActor.sourceDatasetSha256,migrationRunDigest:systemActor.id.slice("legacy-order-migration:".length)} : {}) } });
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
