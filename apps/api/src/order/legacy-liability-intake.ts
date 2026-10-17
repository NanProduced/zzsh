import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { assertGameScope, conflict, fingerprintRequest, invalid, newSupplyId, sha256Hex, withIdempotency } from "../supply/supply-util";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { legacyEconomicDutyId, legacyOrderAdvisoryKey, legacyPlanYuanToCents, type LegacyContinuationActor } from "./legacy-continuation-model";
import { lockLegacyContinuationOrder, readLegacyContinuationBinding } from "./legacy-continuation-evidence";

type HistoricalDisposition = "COMPLETED_UNREFUNDED" | "DETAINED" | "POSTED_CONFISCATION" | "REFUND_RECORD_EXISTS";
export type LegacyHistoricalLiabilityInput = { orderId: string; parentSourceDigest: string; classification: HistoricalDisposition; evidenceRef: string; settlementRecord: { canonical: string; digest: string }; refundRecord?: { canonical: string; digest: string } };
/** Separately reviewed maintenance input. No public import or channel execution. */
export async function importLegacyHistoricalLiability(client: PoolClient, actor: LegacyContinuationActor, input: LegacyHistoricalLiabilityInput) {
  input = structuredClone(input);
  if (!input || !["COMPLETED_UNREFUNDED", "DETAINED", "POSTED_CONFISCATION", "REFUND_RECORD_EXISTS"].includes(input.classification) || !input.evidenceRef || input.evidenceRef.length > 512) throw invalid("LIABILITY_SOURCE_INVALID");
  const binding = await readLegacyContinuationBinding(client, input.orderId), operation = "order.legacy.liability.import";
  return withIdempotency(client, { realm: "admin", principalId: actor.userId, operation, resourceId: input.orderId }, sha256Hex(input.orderId), fingerprintRequest(operation, input.orderId, input), async () => {
    if (actor.realm !== "admin") throw conflict("IMPORT_NOT_AUTHORIZED");
    await assertAdminContextInTransaction(client, actor);
    const access = await loadEffectiveAdminAccess(client, actor.userId); requirePermission(access, "supply.catalog.manage"); requirePermission(access, "order.read");
    await assertGameScope(client, actor.userId, access?.isBoss === true, binding.gameId);
    if (binding.sourceDigest !== input.parentSourceDigest || binding.sourcePayStatus !== 1) throw conflict("LIABILITY_SOURCE_BINDING");
  }, async () => {
    await lockLegacyContinuationOrder(client, input.orderId);
    const row = (await client.query<{ source: Record<string, string | null>; deposit: string | null }>(`SELECT source_snapshot AS source,deposit_amount_cents::text AS deposit FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1`, [input.orderId])).rows[0];
    if (!row || sha256Hex(canonicalize(row.source)) !== input.parentSourceDigest) throw conflict("LIABILITY_SOURCE_BINDING");
    let source: Record<string, string | null>;
    try { source = JSON.parse(input.settlementRecord.canonical); } catch { throw conflict("LIABILITY_SOURCE_EVIDENCE_MISSING"); }
    if (!source || typeof source !== "object" || Array.isArray(source) || input.settlementRecord.canonical.length > 65536 || canonicalize(source) !== input.settlementRecord.canonical || sha256Hex(input.settlementRecord.canonical) !== input.settlementRecord.digest
      || Object.keys(row.source).some(k => source[k] !== row.source[k]) || !Object.hasOwn(source, "detain_money")) throw conflict("LIABILITY_SOURCE_EVIDENCE_MISMATCH");
    const detained = source.is_settle;
    const expected = input.classification === "COMPLETED_UNREFUNDED" ? detained === "0" && binding.sourceOrderStatus === 4
      : input.classification === "DETAINED" ? detained === "2" && binding.sourceOrderStatus === 4
      : input.classification === "POSTED_CONFISCATION" ? detained === "3"
      // 61 = cancelled with a positive original return AND a refund record (cancelledPositiveReturn); zero/absent return is another class.
      : binding.sourceOrderStatus === 5 && typeof source.return_order_money === "string" && BigInt(legacyPlanYuanToCents(source.return_order_money)) > 0n;
    if (!expected) throw conflict("LIABILITY_CLASSIFICATION_MISMATCH");
    if (input.classification === "REFUND_RECORD_EXISTS") {
      const proof = input.refundRecord; let record: Record<string, unknown> | null = null;
      try { if (proof) record = JSON.parse(proof.canonical); } catch { /* rejected below */ }
      if (!proof || !record || canonicalize(record) !== proof.canonical || sha256Hex(proof.canonical) !== proof.digest || record.order_id !== binding.legacyId || typeof record.id !== "string" || !/^[1-9]\d{0,23}$/.test(record.id)) throw conflict("REFUND_RECORD_EVIDENCE_MISSING");
    } else if (input.refundRecord) throw invalid("UNEXPECTED_REFUND_RECORD");
    let dutyId: string | null = null;
    if (input.classification === "COMPLETED_UNREFUNDED" || input.classification === "DETAINED" || input.classification === "POSTED_CONFISCATION") {
      const refund = input.classification !== "POSTED_CONFISCATION", kind = refund ? "RENTER_REFUND" : "DEPOSIT_COMPENSATION";
      let amount: string;
      if (refund) {
        if (source.return_order_money === null || source.return_order_money === undefined) throw conflict("REFUND_AMOUNT_UNPROVEN");
        const gross = BigInt(legacyPlanYuanToCents(source.return_order_money)), raw = source.detain_money;
        const detain = raw === null || /^-(0|[1-9]\d{0,21})(?:\.\d{1,2})?$/.test(raw!) ? 0n : BigInt(legacyPlanYuanToCents(raw!));
        if (gross < detain) throw conflict("REFUND_NET_NEGATIVE"); amount = (gross - detain).toString();
      } else { if (row.deposit === null || !/^(0|[1-9]\d{0,23})$/.test(row.deposit)) throw conflict("DEPOSIT_AMOUNT_UNPROVEN"); amount = row.deposit; }
      dutyId = legacyEconomicDutyId(input.orderId, kind, binding.legacyId);
      const existing = (await client.query<{ id: string; amount: string; status: string }>(`SELECT id,amount_cents::text AS amount,status FROM zzsh_order.legacy_order_duty WHERE order_id=$1 AND kind=$2 AND source_record_id=$3`, [input.orderId, kind, binding.legacyId])).rows[0];
      if (existing && (existing.id !== dutyId || existing.amount !== amount)) throw conflict("LIABILITY_ECONOMIC_KEY_CONFLICT");
      if (!existing) await client.query(`INSERT INTO zzsh_order.legacy_order_duty(id,order_id,kind,source_record_id,counterparty_user_id,amount_cents,currency,status,source,source_status,source_digest,settled_by)
        VALUES($1,$2,$3,$4,$5,$6,'CNY',$7,'LEGACY_IMPORT',$8,$9,$10)`, [dutyId,input.orderId,kind,binding.legacyId,refund ? binding.renterUserId : binding.ownerUserId,amount,refund ? "PENDING" : "SETTLED",input.classification,input.parentSourceDigest,refund ? null : "LEGACY_RECORDS"]);
    }
    await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: operation, objectType: "rental_order", objectId: input.orderId, outcome: "SUCCESS", details: { classification: input.classification, sourceStatus: detained, parentSourceDigest: input.parentSourceDigest, evidenceRef: input.evidenceRef, settlementRecord: input.settlementRecord, refundRecord: input.refundRecord ?? null, dutyId, channelState: "UNKNOWN" } });
    return { status: 200, body: { classification: input.classification, dutyId, channelState: "UNKNOWN" } };
  });
}

export type LegacyInflightRegisterInput = { legacyId: string; accountId: string; ownerUserId: string; renterUserId: string | null; sourceOrderStatus: number; sourcePayStatus: number; sourceDigest: string; evidenceRef: string; disposition: "ISOLATED_PARTY" | "REVIEW_REQUIRED" | "UNKNOWN"; reason: string };
/** An unbindable renter still occupies its real account. Inserts run in a closed import batch, or under the same account lock. */
export async function registerLegacyInflight(client: PoolClient, actor: LegacyContinuationActor, input: LegacyInflightRegisterInput) {
  input = structuredClone(input);
  if (actor.realm !== "admin" || !/^[1-9]\d{0,23}$/.test(input.legacyId) || ![3,8,9].includes(input.sourceOrderStatus) || input.sourcePayStatus !== 1 || !/^[a-f0-9]{64}$/.test(input.sourceDigest) || !input.evidenceRef || input.evidenceRef.length > 512 || !input.reason || input.reason.length > 500 || !["ISOLATED_PARTY","REVIEW_REQUIRED","UNKNOWN"].includes(input.disposition)) throw invalid("INFLIGHT_REGISTER_INVALID");
  await assertAdminContextInTransaction(client, actor);
  const access = await loadEffectiveAdminAccess(client, actor.userId); requirePermission(access, "supply.catalog.manage"); requirePermission(access, "order.read");
  // Match reservation's prefix. The maintenance-only function never removes occupancy.
  await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [input.ownerUserId]);
  const account = (await client.query<{ gameId: string; owner: string }>(`SELECT game_id AS "gameId",owner_user_id AS owner FROM zzsh_supply.rental_account WHERE id=$1`, [input.accountId])).rows[0];
  if (!account || account.owner !== input.ownerUserId) throw conflict("INFLIGHT_ACCOUNT_UNBOUND");
  await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR SHARE`, [account.gameId]);
  const locked = (await client.query<{ gameId: string; owner: string }>(`SELECT game_id AS "gameId",owner_user_id AS owner FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`, [input.accountId])).rows[0];
  if (!locked || locked.gameId !== account.gameId || locked.owner !== input.ownerUserId) throw conflict("INFLIGHT_ACCOUNT_CHANGED");
  await assertGameScope(client, actor.userId, access?.isBoss === true, account.gameId);
  const mappedId = "legacy_order_" + sha256Hex(JSON.stringify(["legacy_mysql_restore","la_order",input.legacyId])).slice(0,40);
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [legacyOrderAdvisoryKey(mappedId)]);
  const id = "legacy_inflight_" + sha256Hex(mappedId).slice(0,40), prior = (await client.query<{ source: LegacyInflightRegisterInput }>(`SELECT jsonb_build_object('legacyId',legacy_id,'accountId',account_id,'ownerUserId',owner_user_id,'renterUserId',renter_user_id,'sourceOrderStatus',source_order_status,'sourcePayStatus',source_pay_status,'sourceDigest',source_digest,'evidenceRef',evidence_ref,'disposition',disposition,'reason',reason) AS source FROM zzsh_order.legacy_inflight_register WHERE id=$1`, [id])).rows[0];
  if (prior && canonicalize(prior.source) !== canonicalize(input)) throw conflict("INFLIGHT_SOURCE_CONFLICT");
  if (!prior) {
    await client.query(`INSERT INTO zzsh_order.legacy_inflight_register(id,source_system,source_entity,legacy_id,account_id,owner_user_id,renter_user_id,source_order_status,source_pay_status,source_digest,evidence_ref,disposition,reason,created_by_admin_id) VALUES($1,'legacy_mysql_restore','la_order',$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11)`, [id,input.legacyId,input.accountId,input.ownerUserId,input.renterUserId,input.sourceOrderStatus,input.sourceDigest,input.evidenceRef,input.disposition,input.reason,actor.userId]);
    await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: "order.legacy.inflight.registered", objectType: "rental_account", objectId: input.accountId, outcome: "SUCCESS", details: { registerId: id, sourceDigest: input.sourceDigest, disposition: input.disposition, legacyOrderId: input.legacyId } });
  }
  return { registerId: id, replayed: !!prior };
}

export type LegacyCommissionSourceFact = { orderId: string; dutyId: string; sourceRecord: { canonical: string; digest: string }; evidenceRef: string;
  parentCancellation?: { canonical: string; digest: string; notPayableCanonical: string; notPayableDigest: string } };
/** Reviewed source import only; the public void command may reference the returned audit ID, never caller-supplied assertions. */
export async function recordLegacyCommissionSourceFact(client: PoolClient, actor: LegacyContinuationActor, input: LegacyCommissionSourceFact) {
  input=structuredClone(input);const binding=await readLegacyContinuationBinding(client,input.orderId),operation="order.legacy.duty.source_fact_reviewed";
  if (!input.evidenceRef || input.evidenceRef.length>512 || !input.sourceRecord || input.sourceRecord.canonical.length>32768 || sha256Hex(input.sourceRecord.canonical)!==input.sourceRecord.digest) throw invalid("VOID_SOURCE_FACT_REQUIRED");
  const source=JSON.parse(input.sourceRecord.canonical) as Record<string,string>;
  if (!source || canonicalize(source)!==input.sourceRecord.canonical || source.order_id!==binding.legacyId || !/^[1-9]\d{0,23}$/.test(source.id??"") || !/^[1-9]\d{0,23}$/.test(source.user_id??"")) throw conflict("VOID_SOURCE_FACT_REQUIRED");
  return withIdempotency(client,{realm:"admin",principalId:actor.userId,operation,resourceId:input.dutyId},sha256Hex(input.sourceRecord.digest),fingerprintRequest(operation,input.dutyId,input),async()=>{
    if(actor.realm!=="admin")throw conflict("IMPORT_NOT_AUTHORIZED");await assertAdminContextInTransaction(client,actor);const access=await loadEffectiveAdminAccess(client,actor.userId);requirePermission(access,"supply.catalog.manage");requirePermission(access,"order.legacy.continue");await assertGameScope(client,actor.userId,access?.isBoss===true,binding.gameId);
  },async()=>{
    const {duties}=await lockLegacyContinuationOrder(client,input.orderId),duty=duties.find(d=>d.id===input.dutyId);
    if(!duty || duty.kind!=="COMMISSION" || duty.sourceRecordId!==source.id || duty.counterpartyUserId!==legacyOwnerUserId("legacy_mysql_restore","la_user",source.user_id!))throw conflict("VOID_SOURCE_FACT_REQUIRED");
    let cancelled=false;
    if(source.status!=="3"){
      const p=input.parentCancellation;if(!p || p.canonical.length>65536 || sha256Hex(p.canonical)!==p.digest || sha256Hex(p.notPayableCanonical)!==p.notPayableDigest)throw conflict("VOID_SOURCE_FACT_REQUIRED");
      const parent=JSON.parse(p.canonical) as Record<string,string>,decision=JSON.parse(p.notPayableCanonical) as Record<string,string>;
      if(canonicalize(parent)!==p.canonical || parent.id!==binding.legacyId || parent.order_status!=="5" || parent.user_id!==binding.legacyRenterId || parent.sale_user_id!==binding.legacyOwnerId || parent.accounts_id!==binding.legacyAccountId
        || canonicalize(decision)!==p.notPayableCanonical || decision.parentCancellationDigest!==p.digest || decision.sourceRecordDigest!==input.sourceRecord.digest || decision.decision!=="NOT_PAYABLE" || !decision.sourceRuleEvidenceRef)throw conflict("VOID_SOURCE_FACT_REQUIRED");
      cancelled=true;
    }else if(input.parentCancellation)throw invalid("UNEXPECTED_CANCELLATION_EVIDENCE");
    const id=newSupplyId("audit");
    await client.query(`INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
      VALUES($1,'admin',$2,$3,$4,'rental_order',$5,'SUCCESS',$6,'Reviewed immutable legacy source fact',clock_timestamp(),$7::jsonb)`,[id,actor.userId,actor.sessionId,operation,input.orderId,actor.requestId,JSON.stringify({sourceRecordId:source.id,parentSourceDigest:binding.sourceDigest,sourceStatus:source.status,parentCancelledNotPayable:cancelled,sourceRecord:input.sourceRecord,parentCancellation:input.parentCancellation??null,evidenceRef:input.evidenceRef})]);
    return {status:200,body:{sourceFactAuditId:id,sourceRecordId:source.id,channelState:"UNKNOWN"}};
  });
}
