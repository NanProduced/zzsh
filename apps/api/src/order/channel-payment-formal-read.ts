import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { assertFormalCollectionStart, assertFormalInitialAdmission, readFormalCollectionAdmission,
  JoinpayCollectionProfileError, type FormalCollectionAdmission } from "./joinpay-collection-profile";
import { centsToJoinpayYuan, decodeJoinpayJson } from "./joinpay-protocol";

export type ChannelPaymentReadOptions = Readonly<{ formalAdmission?: FormalCollectionAdmission;
  formalWriteRouteReady?: boolean; qrHostAllowlist?: readonly string[] }>;
type Row = Record<string, any>;
type Client = Pick<PoolClient, "query">;
export type FormalObservation = { source: "NOTIFY" | "QUERY"; evidenceLevel: "JOINPAY_VERIFIED";
  channelStatus: "SUCCEEDED" | "FAILED" | "CREATED_UNPAID"; channelTrxNo: string | null;
  providerPaidAtRaw: string | null; providerPaidAt: string | null; providerTimeZone: "EXPLICIT_OFFSET";
  providerTimeOffsetMinutes: number; evidenceRef: string; observedAt: string };
type FormalRead = { capability: boolean; qrUrl: string | null; observation: FormalObservation | null; unknowns: string[] };
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function document(value: unknown, digest: unknown, limit: number): Row | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit || sha(value) !== digest) return null;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}
function admissionDocument(options: ChannelPaymentReadOptions, reference: unknown, digest: unknown, canonical: unknown): Row | null {
  if (!options.formalAdmission || typeof reference !== "string" || typeof digest !== "string") return null;
  try {
    const current = readFormalCollectionAdmission(options.formalAdmission);
    assertFormalInitialAdmission(options.formalAdmission, reference, digest);
    const doc = document(canonical, digest, 262144);
    return doc?.kind === "JOINPAY_FORMAL_SERVER_REVIEW" && doc.reference === reference
      && ["appId", "database", "runtimeUser", "merchantIdentityId", "wireMerchantNo"].every(k => doc[k] === current[k as keyof typeof current]) ? doc : null;
  } catch (error) { if (error instanceof JoinpayCollectionProfileError) return null; throw error; }
}
const accepted = (doc: Row, operation: string, profileId: string, digest: string, keyRef: string) =>
  Array.isArray(doc.acceptedProfiles) && doc.acceptedProfiles.some((p: Row) => p?.operation === operation
    && p.profileId === profileId && p.profileSha256 === digest && p.keyVersionRef === keyRef);

/** Only accepted hostnames; URLs, ports, suffix matches and credentials cannot expand the allowlist. */
export function allowedQrUrl(value: unknown, allowlist: readonly string[] | undefined): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value) || !allowlist?.length) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443")
      && allowlist.some(host => typeof host === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host) && host === url.hostname) ? url.href : null;
  } catch { return null; }
}

const readinessSql = `SELECT current_database() AS database,current_user AS runtime_user,
  to_regclass('zzsh_order.joinpay_collection_binding') IS NOT NULL
  AND to_regclass('zzsh_order.joinpay_collection_attempt') IS NOT NULL
  AND to_regclass('zzsh_order.joinpay_collection_observation') IS NOT NULL
  AND to_regclass('zzsh_order.joinpay_collection_evidence') IS NOT NULL
  AND (SELECT count(*)=3 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.joinpay_collection_binding')
    AND attname IN('formal_admission_ref','formal_admission_sha256','formal_admission_canonical') AND NOT attisdropped)
  AND (SELECT count(*)=3 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.payment_confirmation')
    AND attname IN('joinpay_request_id','joinpay_evidence_id','joinpay_anchor_id') AND NOT attisdropped) AS formal_ready`;
const originalSql = `SELECT b.*,
  (SELECT to_jsonb(e) || jsonb_build_object('provider_paid_at',${utc("e.provider_paid_at")},'observed_at',${utc("e.created_at")},
      'raw_base64',encode(CASE WHEN e.operation='NOTIFY' THEN e.raw_query ELSE
        (SELECT x.raw_body FROM zzsh_order.joinpay_collection_observation x WHERE x.id=e.origin_observation_id AND x.request_id=e.request_id) END,'base64'))
    FROM zzsh_order.joinpay_collection_evidence e WHERE e.request_id=b.request_id
      AND e.schema_outcome='VALID' AND e.signature_outcome='MATCH' AND e.binding_outcome='MATCH' AND e.event IN('E4','E5','E6')
    ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS observation,
  (SELECT jsonb_build_object('request_id',o.request_id,'raw_base64',encode(o.raw_body,'base64'),'raw_sha256',o.raw_sha256,
    'profile_id',a.profile_id,'profile_sha256',a.profile_sha256,'key_version_ref',a.key_version_ref)
    FROM zzsh_order.joinpay_collection_observation o JOIN zzsh_order.joinpay_collection_attempt a ON a.id=o.attempt_id AND a.request_id=o.request_id
    WHERE o.request_id=b.request_id AND a.operation='SUBMIT' AND o.event IN('E1','E1P') AND o.response_complete AND o.http_status=200
      AND o.transport_failure IS NULL AND o.schema_outcome='VALID' AND o.signature_outcome='MATCH' AND o.binding_outcome='MATCH'
    ORDER BY o.created_at DESC,o.id DESC LIMIT 1) AS qr
FROM zzsh_order.joinpay_collection_binding b JOIN zzsh_order.payment_request r ON r.id=b.request_id
WHERE b.request_id=$1 AND r.order_id=$2`;

function rawOriginal(row: Row): Buffer | null {
  if (typeof row.raw_base64 !== "string" || row.raw_base64.length > 90000) return null;
  const raw = Buffer.from(row.raw_base64, "base64");
  return raw.length > 0 && raw.length <= 65536 && sha(raw) === row.raw_sha256 ? raw : null;
}
function timeAtOffset(raw: unknown, offset: number): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const date = new Date(raw.replace(" ", "T") + "Z");
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970 && date.toISOString().slice(0, 19).replace("T", " ") === raw
    ? new Date(date.getTime() - offset * 60000).toISOString() : null;
}
function formalObservation(e: Row | null, b: Row, r: Row, options: ChannelPaymentReadOptions): FormalObservation | null {
  if (!e || e.request_id !== r.id || !["QUERY", "NOTIFY"].includes(e.operation) || !["E4", "E5", "E6"].includes(e.event)
    || e.schema_outcome !== "VALID" || e.signature_outcome !== "MATCH" || e.binding_outcome !== "MATCH"
    || e.initial_admission_ref !== b.formal_admission_ref || e.initial_admission_sha256 !== b.formal_admission_sha256 || !rawOriginal(e)) return null;
  const a = admissionDocument(options, e.admission_ref, e.admission_sha256, e.admission_canonical);
  const p = document(e.profile_canonical, e.profile_sha256, 131072), op = p?.operations?.[e.operation];
  if (!a || !p || !accepted(a, e.operation, e.profile_id, e.profile_sha256, e.key_version_ref)
    || p.profileId !== e.profile_id || p.evidenceMode !== "OFFICIAL" || p.merchantIdentityId !== r.merchant_identity_id
    || p.wireMerchantNo !== b.wire_merchant_no || op?.keyVersionRef !== e.key_version_ref
    || !Number.isInteger(op.timeOffsetMinutes) || Math.abs(op.timeOffsetMinutes) > 840) return null;
  const paid = timeAtOffset(e.provider_paid_at_raw, op.timeOffsetMinutes);
  if (e.event === "E4" && (!paid || !e.provider_paid_at || Date.parse(e.provider_paid_at) !== Date.parse(paid)
    || typeof e.channel_trx_no !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.channel_trx_no))) return null;
  return { source: e.operation, evidenceLevel: "JOINPAY_VERIFIED", channelStatus: e.event === "E4" ? "SUCCEEDED" : e.event === "E5" ? "FAILED" : "CREATED_UNPAID",
    channelTrxNo: e.channel_trx_no ?? null, providerPaidAtRaw: e.provider_paid_at_raw ?? null, providerPaidAt: e.event === "E4" ? paid : null,
    providerTimeZone: "EXPLICIT_OFFSET", providerTimeOffsetMinutes: op.timeOffsetMinutes, evidenceRef: `sha256:${e.raw_sha256}`, observedAt: e.observed_at };
}

/** Local immutable evidence only. No key resolver, provider call, lock, lease or acceptance service. */
export async function readFormalPaymentEvidence(client: Client, order: Row, request: Row | null,
  options: ChannelPaymentReadOptions): Promise<FormalRead> {
  const result: FormalRead = { capability: false, qrUrl: null, observation: null, unknowns: [] };
  if (!options.formalAdmission && request?.evidence_level !== "JOINPAY_CANDIDATE") return result;
  const deployed = (await client.query(readinessSql)).rows[0];
  if (deployed?.formal_ready !== true) { result.unknowns.push("FORMAL_SCHEMA_NOT_DEPLOYED"); return result; }
  if (options.formalAdmission) {
    try {
      const a = readFormalCollectionAdmission(options.formalAdmission);
      if (a.database !== deployed.database || a.runtimeUser !== deployed.runtime_user) {
        result.unknowns.push("FORMAL_RESOURCE_MISMATCH"); return result;
      }
    } catch (error) { if (!(error instanceof JoinpayCollectionProfileError)) throw error; }
  }
  if (options.formalAdmission) {
    try {
      const a = assertFormalCollectionStart(options.formalAdmission);
      result.capability = options.formalWriteRouteReady === true && a.database === deployed.database && a.runtimeUser === deployed.runtime_user
        && !!options.qrHostAllowlist?.some(h => allowedQrUrl(`https://${h}/`, [h]));
    } catch (error) { if (!(error instanceof JoinpayCollectionProfileError)) throw error; }
  }
  if (!request || request.channel !== "JOINPAY" || request.evidence_level !== "JOINPAY_CANDIDATE") return result;
  const b = (await client.query(originalSql, [request.id, order.id])).rows[0];
  const initial = b && admissionDocument(options, b.formal_admission_ref, b.formal_admission_sha256, b.formal_admission_canonical);
  if (!b || !initial || initial.merchantIdentityId !== request.merchant_identity_id || initial.wireMerchantNo !== b.wire_merchant_no
    || !accepted(initial, "SUBMIT", request.config_profile_id, b.initial_profile_sha256, request.key_version_ref)) {
    result.unknowns.push("FORMAL_INITIAL_ADMISSION_UNAVAILABLE"); return result;
  }
  result.observation = formalObservation(b.observation, b, request, options);
  if (!result.observation) result.unknowns.push("FORMAL_OBSERVATION_UNAVAILABLE");
  if (!result.capability || order.status !== "PENDING_PAYMENT" || order.hold_expired !== false || order.has_confirmation
    || !["ACTION_READY", "PROCESSING_UNCONFIRMED"].includes(request.state)) return result;
  const q = b.qr, raw = q && rawOriginal(q);
  if (!q || !raw || q.request_id !== request.id || q.profile_id !== request.config_profile_id
    || q.profile_sha256 !== b.initial_profile_sha256 || q.key_version_ref !== request.key_version_ref
    || request.currency !== "CNY" || typeof request.amount_cents !== "string" || !/^(0|[1-9][0-9]*)$/.test(request.amount_cents)) return result;
  const decoded = decodeJoinpayJson(raw);
  if (!decoded.ok || !["100", "102", "10083001"].includes(decoded.raw.get("ra_Code")?.value ?? "")
    || decoded.raw.get("r1_MerchantNo")?.value !== b.wire_merchant_no || decoded.raw.get("r2_OrderNo")?.value !== request.channel_order_no
    || decoded.raw.get("r3_Amount")?.value !== centsToJoinpayYuan(request.amount_cents) || decoded.raw.get("r4_Cur")?.value !== "1"
    || decoded.raw.get("r6_FrpCode")?.value !== request.method) return result;
  result.qrUrl = allowedQrUrl(decoded.raw.get("rc_Result")?.value, options.qrHostAllowlist);
  return result;
}
