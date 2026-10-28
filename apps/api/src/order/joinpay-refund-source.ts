import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { assertRefundResource, formalRefundBinding, lockFormalRefundContext, type FormalRefundRow } from "./channel-refund-store";
import { assertFormalRefundProfile, describeRefundProfile, inspectRefundProfile, readFormalRefundAdmission, readRefundProfileEvidence, refundCompleteTimeToUtc, refundFailureMayRelease,
  refundWayAccepted, RefundProfileError, type BoundRefundProfile, type FormalRefundAdmission, type RefundBinding, type RefundOperation } from "./joinpay-refund-profile";
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex"), ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export type RefundSourceOptions = { admission: FormalRefundAdmission; profileFor: (operation: RefundOperation, binding: Readonly<RefundBinding>, pinned?: Readonly<{ profileId: string; profileSha256: string; keyVersionRef: string }>) => BoundRefundProfile; keyFor: (ref: string) => string };
export type NativeRefundTerminalFact = Readonly<{ evidenceId: string; intentId: string; postingId: string | null; orderId: string; paymentConfirmationId: string;
  basisKind?: "POSTING" | "REVIEW_CONFIRMATION"; abnormalConfirmationId?: string | null;
  renterUserId: string; merchantIdentityId: string; originalPaymentTrxNo: string; originalPaymentOrderNo: string; responsibilityVersionHash: string;
  refundOrderNo: string; amountCents: string; currency: "CNY"; terminal: "SUCCEEDED" | "FAILED_NO_EXECUTION"; refundTransactionNo: string | null;
  completedAt: string | null; sourceObservationId: string; factsDigest: string }>;
type FactBody = Omit<NativeRefundTerminalFact, "factsDigest">;
/** 纯比较没有事实能力；用于同原号重放与迟到冲突判定。 */
export function refundTerminalConflicts(original:{terminal:string;refundTransactionNo:string|null;completedAt:string|null},incoming:{terminal:string;refundTransactionNo:string|null;completedAt:string|null}):boolean {
  return original.terminal!==incoming.terminal || original.refundTransactionNo!==incoming.refundTransactionNo || original.completedAt!==incoming.completedAt;
}
type RawObservation = { id: string; intent_id: string; operation: RefundOperation; raw_body: Buffer | null; raw_sha256: string | null; response_complete: boolean;
  http_status: number | null; transport_failure: string | null; evidence_level: string; event: string; profile_id: string; profile_canonical: string; profile_sha256: string; key_version_ref: string };
const facts = new WeakMap<object, { client: PoolClient; xid: string; database: string; actor: string; value: NativeRefundTerminalFact }>();
function mint(client: PoolClient, xid: string, body: FactBody, factsDigest: string, admission: FormalRefundAdmission): NativeRefundTerminalFact {
  const a = readFormalRefundAdmission(admission), fact = Object.freeze({ ...body, factsDigest });
  facts.set(fact, { client, xid, database: a.database, actor: a.runtimeUser, value: fact }); return fact;
}
async function inspectOriginal(client: PoolClient, options: RefundSourceOptions, row: FormalRefundRow, observationId: string) {
  const binding = formalRefundBinding(row, options.admission), raw = (await client.query<RawObservation>(`SELECT id,intent_id,operation,raw_body,raw_sha256,response_complete,http_status,transport_failure,
    evidence_level,event,profile_id,profile_canonical,profile_sha256,key_version_ref FROM zzsh_order.joinpay_refund_observation WHERE id=$1 AND intent_id=$2`, [observationId, row.id])).rows[0];
  if (!raw || !["QUERY", "NOTIFY"].includes(raw.operation) || raw.evidence_level !== "PROVIDER_RESPONSE" || raw.event === "STALE" || !raw.response_complete
    || raw.transport_failure !== null || (raw.operation === "QUERY" ? raw.http_status !== 200 : raw.http_status !== null) || !raw.raw_body || !raw.raw_sha256 || sha(raw.raw_body) !== raw.raw_sha256
    || sha(raw.profile_canonical) !== raw.profile_sha256) return null;
  const profile = options.profileFor(raw.operation, Object.freeze({ ...binding }), Object.freeze({ profileId: raw.profile_id, profileSha256: raw.profile_sha256, keyVersionRef: raw.key_version_ref }));
  const view = describeRefundProfile(profile, raw.operation); assertFormalRefundProfile(options.admission, profile, raw.operation);
  if (view.profileId !== raw.profile_id || view.profileSha256 !== raw.profile_sha256 || view.keyVersionRef !== raw.key_version_ref || readRefundProfileEvidence(profile) !== raw.profile_canonical) throw conflict("Refund evidence profile differs");
  let key: string; try { key = options.keyFor(view.keyVersionRef); } catch { throw new RefundProfileError("REFUND_KEY_UNAVAILABLE"); }
  let body: string | Uint8Array = raw.raw_body;
  if (raw.operation === "NOTIFY") { try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.raw_body); } catch { return null; } }
  const decision = inspectRefundProfile(profile, raw.operation, body, binding, key);
  if (decision.signature !== "MATCH") return null;
  if (decision.result === "CHANNEL_REPORTED_SUCCEEDED" && decision.providerRefundTrxNo && decision.completedAtRaw && refundWayAccepted(profile, decision.refundWay)) {
    return { raw, terminal: "SUCCEEDED" as const, refundTransactionNo: decision.providerRefundTrxNo, completedAt: refundCompleteTimeToUtc(profile, decision.completedAtRaw), completedAtRaw: decision.completedAtRaw };
  }
  if (decision.result === "CHANNEL_REPORTED_FAILED" && refundFailureMayRelease(profile, decision)) return { raw, terminal: "FAILED_NO_EXECUTION" as const,
    refundTransactionNo: decision.providerRefundTrxNo ?? null, completedAt: decision.completedAtRaw ? refundCompleteTimeToUtc(profile, decision.completedAtRaw) : null, completedAtRaw: decision.completedAtRaw ?? null };
  return null;
}
function bodyFor(r: FormalRefundRow, observationId: string, terminal: "SUCCEEDED" | "FAILED_NO_EXECUTION", trx: string | null, at: string | null): FactBody {
  const base: FactBody = { evidenceId: `rfe_${sha(JSON.stringify([r.id, observationId, terminal])).slice(0, 40)}`, intentId: r.id, postingId: r.posting_id, orderId: r.order_id,
    paymentConfirmationId: r.payment_confirmation_id, renterUserId: r.renter_user_id, merchantIdentityId: r.merchant_identity_id,
    originalPaymentTrxNo: r.original_payment_trx_no, originalPaymentOrderNo: r.original_payment_order_no, responsibilityVersionHash: r.responsibility_version_hash,
    refundOrderNo: r.refund_order_no, amountCents: r.amount_cents, currency: "CNY", terminal, refundTransactionNo: trx, completedAt: at, sourceObservationId: observationId };
  return r.basis_kind === "REVIEW_CONFIRMATION"
    ? { ...base, postingId: null, basisKind: "REVIEW_CONFIRMATION", abnormalConfirmationId: r.payment_confirmation_id }
    : base;
}
/** 只读原件再验；数据库cached status/verified/canonical均不能单独产事实。 */
export async function readVerifiedRefundTerminalFact(client: PoolClient, options: RefundSourceOptions, evidenceId: string): Promise<NativeRefundTerminalFact> {
  if (!ID.test(evidenceId)) throw invalid(); const xid = await assertRefundResource(client, options.admission);
  const e = (await client.query(`SELECT id,intent_id,observation_id,terminal,refund_transaction_no,completed_at::text,facts_canonical,facts_digest FROM zzsh_order.joinpay_refund_evidence WHERE id=$1`, [evidenceId])).rows[0];
  if (!e || sha(e.facts_canonical) !== e.facts_digest) throw notFound(); const row = await lockFormalRefundContext(client, options.admission, e.intent_id);
  const checked = await inspectOriginal(client, options, row, e.observation_id); if (!checked) throw conflict("Original refund source did not verify");
  const body = bodyFor(row, e.observation_id, checked.terminal, checked.refundTransactionNo, checked.completedAt), canonical = JSON.stringify(body);
  if (body.evidenceId !== e.id || canonical !== e.facts_canonical || sha(canonical) !== e.facts_digest || e.terminal !== body.terminal || e.refund_transaction_no !== body.refundTransactionNo
    || (e.completed_at === null ? null : new Date(e.completed_at).toISOString()) !== body.completedAt) throw conflict("Original refund terminal binding differs");
  return mint(client, xid, body, e.facts_digest, options.admission);
}
/** 由原事务先保存raw，再调用；无完整官方成功/失败依据时不抢占唯一终态。 */
export async function captureRefundTerminalFact(client: PoolClient, options: RefundSourceOptions, intentId: string, observationId: string): Promise<NativeRefundTerminalFact | null> {
  const xid = await assertRefundResource(client, options.admission), row = await lockFormalRefundContext(client, options.admission, intentId);
  if (row.requires_review || row.state === "REVIEW_REQUIRED") return null;
  const checked = await inspectOriginal(client, options, row, observationId); if (!checked) return null;
  if (row.terminal_evidence_id) {
    const original = await readVerifiedRefundTerminalFact(client, options, row.terminal_evidence_id);
    if (refundTerminalConflicts(original,checked)) {
      await client.query(`UPDATE zzsh_order.channel_refund_intent SET requires_review=true,revision=revision+1 WHERE id=$1 AND NOT requires_review`, [intentId]); return null;
    }
    return original;
  }
  const body = bodyFor(row, observationId, checked.terminal, checked.refundTransactionNo, checked.completedAt), canonical = JSON.stringify(body), digest = sha(canonical);
  await client.query(`INSERT INTO zzsh_order.joinpay_refund_evidence(id,intent_id,observation_id,operation,terminal,refund_transaction_no,completed_at_raw,completed_at,facts_canonical,facts_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [body.evidenceId, intentId, observationId, checked.raw.operation, body.terminal, body.refundTransactionNo,
      checked.completedAtRaw, body.completedAt, canonical, digest]);
  return mint(client, xid, body, digest, options.admission);
}
export async function assertJoinpayRefundTerminalFact(client: PoolClient, fact: unknown): Promise<NativeRefundTerminalFact> {
  const p = fact && typeof fact === "object" ? facts.get(fact) : null; if (!p || p.client !== client) throw invalid("Native refund fact is not verified on this transaction");
  const row = (await client.query(`SELECT current_database() AS db,current_user AS actor,pg_current_xact_id()::text AS xid`)).rows[0];
  if (row?.xid !== p.xid || row.db !== p.database || row.actor !== p.actor) throw invalid("Native refund fact transaction or resource differs"); return p.value;
}
