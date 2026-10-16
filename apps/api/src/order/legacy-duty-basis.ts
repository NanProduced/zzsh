import type { PoolClient } from "pg";
import { canonicalize } from "../supply/content-hash";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { conflict, sha256Hex } from "../supply/supply-util";
import { planLegacyContinuation, type LegacyCommand } from "./legacy-continuation-calc";
import { readLegacyContinuationBinding, readLegacyContinuationEvidence, readLegacyContinuationHead } from "./legacy-continuation-evidence";
import { assertLegacyCommissionEvidence, deriveLegacyFacts, legacyCommissionMaturity, legacyPlanYuanToCents, legacyTimeMicros, readSealedLegacyFacts, type LegacyDutyRow, type LegacyEvidenceRow, type LegacyHeadRow } from "./legacy-continuation-model";

export type LegacyDutyBasis = { state: "UNKNOWN"; reason: string } | {
  state: "KNOWN"; dutyId: string; orderId: string; kind: LegacyDutyRow["kind"]; beneficiaryUserId: string; amountCents: string; currency: "CNY";
  parentSourceDigest: string; parentSourceId: string; sourceRecordEntity: "la_distribution_order" | "la_order" | "legacy_continuation_version"; sourceRecordDigest: string; basisFactsDigest: string; effectiveFactsDigest: string;
  continuationVersionId: string | null; admissionId: string | null; basisEvidenceId: string; revision: string; maturityAt: string | null;
  sourceTimeKind: "CONFIRMED_AT" | "COMPLETED_AT" | "MATURES_AT" | "DISPOSED_AT" | "SOURCE_COMPLETED_AT";
  sourceTime: string; effectiveHeadId: string | null; effectiveHeadRevision: string | null; currentNetRefundCents:string|null;sourceIsSettle: string | null; fundsDisposition: "AVAILABLE" | "HELD" | "CONFISCATED" | "UNKNOWN";
};
type Version = LegacyHeadRow & { actor: { realm: "user" | "admin"; userId: string }; planFingerprint: string; commissionRevisions: unknown; createdAt: string };
const utc = (x: string) => `to_char(${x} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Caller owns current authority and the complete T/F lock prefix. This resolves facts, never funds or permissions. */
export async function readLegacyDutyBasis(client: PoolClient, orderId: string, duty: LegacyDutyRow): Promise<LegacyDutyBasis> {
  if (duty.orderId !== orderId || duty.settledBy === "LEGACY_RECORDS" || !duty.counterpartyUserId) return { state: "UNKNOWN", reason: "DUTY_NOT_PAYABLE" };
  const binding = await readLegacyContinuationBinding(client, orderId), head = await readLegacyContinuationHead(client, orderId);
  const effective = await readLegacyContinuationEvidence(client, orderId, head), effectiveFacts = effective ? readSealedLegacyFacts(effective) : null;
  const sourceState = effectiveFacts?.evidence.source.isSettle ?? (await client.query<{ state: string }>(`SELECT source_snapshot->>'is_settle' AS state FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1`, [orderId])).rows[0]?.state;
  const fundsDisposition: "AVAILABLE" | "HELD" | "CONFISCATED" | null = sourceState === "0" ? "AVAILABLE" : sourceState === "2" ? "HELD" : sourceState === "3" ? "CONFISCATED" : null;
  if (!fundsDisposition && duty.kind !== "COMMISSION" && duty.kind !== "OWNER_CREDIT") return { state: "UNKNOWN", reason: "FUNDS_DISPOSITION_UNRESOLVED" };
  let currentNetRefundCents:string|null=null;
  if(duty.kind==="RENTER_REFUND" && effectiveFacts){const source=effectiveFacts.evidence.source;if(source.returnOrderMoney===null)return {state:"UNKNOWN",reason:"CURRENT_REFUND_UNKNOWN"};const gross=BigInt(legacyPlanYuanToCents(source.returnOrderMoney)),detain=source.detainMoney===null?0n:BigInt(legacyPlanYuanToCents(source.detainMoney));
    if(gross<detain)return {state:"UNKNOWN",reason:"CURRENT_REFUND_UNKNOWN"};currentNetRefundCents=(gross-detain).toString();
    if(currentNetRefundCents!==duty.amountCents || effectiveFacts.amounts.refundNet!==undefined && effectiveFacts.amounts.refundNet!==null && legacyPlanYuanToCents(effectiveFacts.amounts.refundNet)!==currentNetRefundCents)return {state:"UNKNOWN",reason:"CURRENT_REFUND_AMOUNT_MISMATCH"};}
  const common = { state: "KNOWN" as const, dutyId: duty.id, orderId, kind: duty.kind, beneficiaryUserId: duty.counterpartyUserId, amountCents: duty.amountCents, currency: "CNY" as const, parentSourceDigest: binding.sourceDigest,parentSourceId:binding.legacyId, revision: duty.revision, maturityAt: duty.maturityAt,
    effectiveHeadId: head?.id ?? null, effectiveHeadRevision: head?.revision ?? null,currentNetRefundCents, sourceIsSettle: sourceState ?? null, fundsDisposition: fundsDisposition ?? "UNKNOWN" as const };
  if (duty.admissionId) {
    const a = (await client.query<{ canonical: string; digest: string; sourceCanonical: string; sourceDigest: string }>(`SELECT admission_canonical AS canonical,admission_digest AS digest,source_canonical AS "sourceCanonical",source_record_digest AS "sourceDigest" FROM zzsh_order.legacy_order_duty_admission WHERE id=$1 AND duty_id=$2 AND order_id=$3`, [duty.admissionId,duty.id,orderId])).rows[0];
    if (!a || sha256Hex(a.canonical) !== a.digest || sha256Hex(a.sourceCanonical) !== a.sourceDigest) return { state: "UNKNOWN", reason: "COMMISSION_ADMISSION_UNRESOLVED" };
    const input = JSON.parse(a.canonical) as import("./legacy-continuation-evidence").LegacyCompletedCommissionImport & { beneficiaryUserId: string; amountCents: string; maturityAt: string };
    const maturity = legacyCommissionMaturity(input.time,input.cutoff);
    assertLegacyCommissionEvidence(input.sourceRecord,binding.legacyId,input.commission);
    if (binding.sourceOrderStatus !== 4 || duty.kind !== "COMMISSION" || input.commission.id !== duty.sourceRecordId || input.commission.status !== "1" || input.sourceDigest !== binding.sourceDigest || input.beneficiaryUserId !== duty.counterpartyUserId || legacyOwnerUserId("legacy_mysql_restore","la_user",input.commission.beneficiaryId) !== duty.counterpartyUserId
      || input.amountCents !== duty.amountCents || legacyPlanYuanToCents(input.commission.storedEarnings) !== duty.amountCents || maturity.maturityAt !== duty.maturityAt || a.sourceDigest !== input.sourceRecord.digest
      || (input.time.kind === "COMPLETED_AT" && (!binding.completedAt || legacyTimeMicros(binding.completedAt) !== legacyTimeMicros(input.time.at)))) return { state: "UNKNOWN", reason: "COMMISSION_ADMISSION_BINDING" };
    return { ...common, sourceRecordEntity:"la_distribution_order",sourceRecordDigest: a.sourceDigest, basisFactsDigest: a.digest, effectiveFactsDigest: effective?.factsDigest ?? a.digest, continuationVersionId: null, admissionId: duty.admissionId,basisEvidenceId:duty.admissionId, sourceTimeKind: input.time.kind, sourceTime: input.time.at };
  }
  if (duty.source === "LEGACY_IMPORT" && duty.kind === "RENTER_REFUND" && duty.sourceStatus === "COMPLETED_UNREFUNDED") {
    const audit = (await client.query<{ id:string;sourceSnapshot:Record<string,string|null>;details: { settlementRecord: { canonical: string; digest: string }; parentSourceDigest: string } }>(`SELECT a.id,a.details,l.source_snapshot AS "sourceSnapshot" FROM zzsh_iam.audit_event a JOIN zzsh_order.legacy_order_read_snapshot l ON l.id=a.object_id WHERE a.object_id=$1 AND a.action='order.legacy.liability.import' AND a.outcome='SUCCESS' AND a.details->>'dutyId'=$2 AND a.details->>'classification'='COMPLETED_UNREFUNDED' ORDER BY a.occurred_at,a.id LIMIT 1`,[orderId,duty.id])).rows[0];
    const fact=audit?.details;
    if (!audit || !fact || fact.parentSourceDigest !== binding.sourceDigest || sha256Hex(fact.settlementRecord.canonical) !== fact.settlementRecord.digest || binding.sourceOrderStatus !== 4 || !binding.completedAt) return { state: "UNKNOWN", reason: "HISTORICAL_REFUND_BASIS_UNRESOLVED" };
    const row = JSON.parse(fact.settlementRecord.canonical) as Record<string,string|null>, gross = row.return_order_money === null ? null : BigInt(legacyPlanYuanToCents(row.return_order_money!));
    if(!Object.hasOwn(row,"detain_money") || !audit.sourceSnapshot || sha256Hex(canonicalize(audit.sourceSnapshot))!==binding.sourceDigest || Object.keys(audit.sourceSnapshot).some(k=>row[k]!==audit.sourceSnapshot[k]))return {state:"UNKNOWN",reason:"HISTORICAL_REFUND_SOURCE_MISMATCH"};
    const detain = row.detain_money === null || /^-(0|[1-9]\d{0,21})(?:\.\d{1,2})?$/.test(row.detain_money!) ? 0n : BigInt(legacyPlanYuanToCents(row.detain_money!));
    if (gross === null || gross < detain || (gross-detain).toString() !== duty.amountCents || duty.counterpartyUserId !== binding.renterUserId) return { state: "UNKNOWN", reason: "HISTORICAL_REFUND_AMOUNT_MISMATCH" };
    return { ...common,currentNetRefundCents:(gross-detain).toString(),sourceRecordEntity:"la_order", sourceRecordDigest: fact.settlementRecord.digest, basisFactsDigest: fact.settlementRecord.digest, effectiveFactsDigest: effective?.factsDigest ?? fact.settlementRecord.digest, continuationVersionId: null, admissionId: null,basisEvidenceId:audit.id, sourceTimeKind: "SOURCE_COMPLETED_AT", sourceTime: binding.completedAt };
  }
  const command = duty.kind === "DEPOSIT_COMPENSATION" ? "CONFISCATE" : "CONFIRM";
  const v = (await client.query<Version>(`SELECT id,order_id AS "orderId",revision::text,input_evidence_id AS "inputEvidenceId",result_evidence_id AS "resultEvidenceId",stage,is_settle AS "isSettle",command,amounts,actor,plan_fingerprint AS "planFingerprint",commission_revisions AS "commissionRevisions",${utc("created_at")} AS "createdAt" FROM zzsh_order.legacy_continuation_version WHERE order_id=$1 AND command=$2 ORDER BY revision DESC LIMIT 1`, [orderId, command])).rows[0];
  if (!v || !effective || !effectiveFacts || BigInt(v.revision)>BigInt(head?.revision ?? "0")) return { state: "UNKNOWN", reason: "FINAL_COMMAND_MISSING" };
  const rows = (await client.query<LegacyEvidenceRow>(`SELECT id,order_id AS "orderId",evidence_version::text AS "evidenceVersion",source_kind AS "sourceKind",source_digest AS "sourceDigest",facts_digest AS "factsDigest",facts_canonical AS "factsCanonical",facts FROM zzsh_order.legacy_continuation_evidence WHERE order_id=$1 AND id=ANY($2::text[])`, [orderId,[v.inputEvidenceId,v.resultEvidenceId]])).rows;
  const before = rows.find(r => r.id === v.inputEvidenceId), result = rows.find(r => r.id === v.resultEvidenceId);
  if (!before || !result || before.sourceDigest !== binding.sourceDigest || result.sourceDigest !== binding.sourceDigest) return { state: "UNKNOWN", reason: "FINAL_COMMAND_EVIDENCE_MISSING" };
  const facts = readSealedLegacyFacts(before), role = v.actor.realm === "admin" ? "admin" : v.actor.userId === binding.renterUserId ? "renter" : v.actor.userId === binding.ownerUserId ? "owner" : "other";
  const cmd: LegacyCommand = { kind: command === "CONFIRM" ? "confirm" : "confiscate", caller: { role, legacyUserId: role === "renter" ? binding.legacyRenterId : role === "owner" ? binding.legacyOwnerId : "" } };
  const plan = planLegacyContinuation(facts.evidence,cmd);
  if (!plan.ok || plan.fingerprint !== v.planFingerprint || canonicalize(plan.commissionRevisions) !== canonicalize(v.commissionRevisions) || canonicalize(deriveLegacyFacts(facts,plan,cmd,before.id,v.id)) !== canonicalize(readSealedLegacyFacts(result))) throw conflict("FINAL_COMMAND_EVIDENCE_MISMATCH");
  let amount: string | null = null, beneficiary: string | null = null, sourceRecordDigest = result.factsDigest;
  if (duty.kind === "COMMISSION") {
    const c = plan.commissionRevisions.find(c => c.id === duty.sourceRecordId), original = facts.evidence.source.commissions.find(c => c.id === duty.sourceRecordId), proof = facts.commissionEvidence?.find(p => p.sourceRecordId === duty.sourceRecordId);
    if (!c?.recalculable || !original || !proof) return { state: "UNKNOWN", reason: "COMMISSION_FINAL_BASIS_MISSING" };
    assertLegacyCommissionEvidence(proof,binding.legacyId,original); sourceRecordDigest = proof.digest; amount = legacyPlanYuanToCents(c.legalEarnings); beneficiary = legacyOwnerUserId("legacy_mysql_restore","la_user",c.beneficiaryId);
    if (duty.maturityAt !== legacyCommissionMaturity({kind:"COMPLETED_AT",at:v.createdAt,evidenceDigest:result.factsDigest},v.createdAt).maturityAt) return { state: "UNKNOWN", reason: "COMMISSION_MATURITY_MISMATCH" };
  } else { amount = legacyPlanYuanToCents(plan.amounts[duty.kind === "RENTER_REFUND" ? "refundNet" : duty.kind === "OWNER_CREDIT" ? "ownerNet" : "depositCompensation"]!); beneficiary = duty.kind === "RENTER_REFUND" ? binding.renterUserId : binding.ownerUserId; if (duty.sourceRecordId !== v.id) return {state:"UNKNOWN",reason:"DUTY_COMMAND_MISMATCH"}; }
  if (amount !== duty.amountCents || beneficiary !== duty.counterpartyUserId) return { state: "UNKNOWN", reason: "FINAL_AMOUNT_OR_BENEFICIARY_MISMATCH" };
  return { ...common,sourceRecordEntity:duty.kind==="COMMISSION"?"la_distribution_order":"legacy_continuation_version",sourceRecordDigest,basisFactsDigest:result.factsDigest,effectiveFactsDigest:effective.factsDigest,continuationVersionId:v.id,admissionId:null,basisEvidenceId:result.id,sourceTimeKind:command === "CONFIRM" ? "CONFIRMED_AT" : "DISPOSED_AT",sourceTime:v.createdAt };
}
