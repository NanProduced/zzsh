import { createHmac, hkdfSync } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "./security-core";

const unavailable = () => new SecurityApiError(503, "IDENTITY_DEPENDENCY_UNAVAILABLE", "实名绑定服务暂时不可用，请稍后重试");

/** Dedicated persistent master key; auth-secret rotation must not change existing identity subjects. */
export function deriveIdentitySubjectKey(subjectMasterKey: string): Buffer {
  if (subjectMasterKey.length < 32) throw unavailable();
  return Buffer.from(hkdfSync("sha256", subjectMasterKey, "zzsh:user-identity-subject:v1", "document-subject-hmac", 32));
}

export function normalizeIdentityDocument(value: string): string {
  let normalized = value.trim().replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9-]{6,64}$/.test(normalized)) throw new SecurityApiError(400, "INVALID_ARGUMENT", "证件号码格式不正确");
  if (/^\d{15}$/.test(normalized)) {
    const body = normalized.slice(0,6)+"19"+normalized.slice(6);
    normalized=body+mainlandIdentityCheckDigit(body);
  }
  return normalized;
}

function mainlandIdentityCheckDigit(body: string): string {
  const weights=[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
  return "10X98765432"[[...body].reduce((sum,digit,index)=>sum+Number(digit)*weights[index]!,0)%11]!;
}

function identityDocumentAliases(normalized: string): string[] {
  return /^\d{17}[0-9X]$/.test(normalized)&&normalized.slice(6,8)==="19"&&mainlandIdentityCheckDigit(normalized.slice(0,17))===normalized[17]
    ? [normalized,normalized.slice(0,6)+normalized.slice(8,17)] : [normalized];
}

export function identitySubjectDigest(documentNumber: string, key: Buffer | undefined): string {
  if (!key || key.length < 32) throw unavailable();
  return createHmac("sha256", key).update("zzsh:user-identity-subject:v1\0").update(normalizeIdentityDocument(documentNumber)).digest("hex");
}

/** Public verification is first-time or the same subject; maintenance rebinding is a separate trusted capability. */
export async function assertPublicIdentitySubjectContinuity(client:PoolClient,userId:string,documentNumber:string,key:Buffer|undefined):Promise<void>{
  const normalized=normalizeIdentityDocument(documentNumber),digest=identitySubjectDigest(normalized,key);
  const row=(await client.query<{identityStatus:string;subjectDigest:string|null;legacyMatches:boolean}>(`/* public-identity-subject-continuity */
    SELECT s.identity_status AS "identityStatus",b.subject_digest AS "subjectDigest",
      COALESCE(b.user_id IS NULL AND s.provider='legacy_mysql_restore'
        AND regexp_replace(upper(btrim(d.id_card_no)), '[[:space:]]', '', 'g')=ANY($2::text[]),false) AS "legacyMatches"
    FROM zzsh_iam.user_identity_state s LEFT JOIN zzsh_iam.user_identity_subject b ON b.user_id=s.user_id
    LEFT JOIN zzsh_iam.user_identity_display_source d ON d.user_id=s.user_id WHERE s.user_id=$1`,[userId,identityDocumentAliases(normalized)])).rows[0];
  if(!row||row.identityStatus!=="VERIFIED")return;
  if(row.subjectDigest===digest||row.subjectDigest===null&&row.legacyMatches===true)return;
  throw new SecurityApiError(403,"FORBIDDEN",row.subjectDigest?"暂不支持自行变更实名主体，请联系客服复核；原有实名资格保持不变":"缺少可核实的原实名主体依据，请联系客服复核；原有实名资格保持不变");
}

const SLOT_SQL = `/* identity-subject-capacity */
WITH matching AS (
  SELECT b.user_id FROM zzsh_iam.user_identity_subject b
  JOIN zzsh_iam.user_identity_state s ON s.user_id=b.user_id
  WHERE b.subject_digest=$1 AND s.account_status<>'CANCELLED'
  UNION
  SELECT d.user_id FROM zzsh_iam.user_identity_display_source d
  JOIN zzsh_iam.user_identity_state s ON s.user_id=d.user_id
  WHERE s.identity_status='VERIFIED' AND s.account_status<>'CANCELLED'
    AND NOT EXISTS (SELECT 1 FROM zzsh_iam.user_identity_subject current_binding WHERE current_binding.user_id=d.user_id)
    AND regexp_replace(upper(btrim(d.id_card_no)), '[[:space:]]', '', 'g')=ANY($3::text[])
)
SELECT EXISTS(SELECT 1 FROM matching WHERE user_id=$2) AS "alreadyBound",
       (SELECT count(*)::text FROM (SELECT user_id FROM matching WHERE user_id<>$2 LIMIT 2) occupied) AS occupied`;

/** The caller owns the user lock; subject locks are sorted for both old and new bindings. */
export async function assertIdentitySubjectCapacity(client: PoolClient, userId: string, documentNumber: string, key: Buffer | undefined, lock: boolean): Promise<string> {
  const digest = identitySubjectDigest(documentNumber, key), normalized = normalizeIdentityDocument(documentNumber);
  try {
    if (lock) {
      const prior = (await client.query<{ subjectDigest: string }>(
        `SELECT subject_digest AS "subjectDigest" FROM zzsh_iam.user_identity_subject WHERE user_id=$1`, [userId],
      )).rows[0]?.subjectDigest;
      for (const subject of [...new Set([digest, ...(prior ? [prior] : [])])].sort()) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,806101))`, [subject]);
      }
    }
    const slots = (await client.query<{ alreadyBound: boolean; occupied: string }>(SLOT_SQL, [digest, userId, identityDocumentAliases(normalized)])).rows[0];
    if (!slots || typeof slots.alreadyBound !== "boolean" || !/^[0-2]$/.test(slots.occupied)) throw unavailable();
    if (!slots.alreadyBound && Number(slots.occupied) >= 2) throw new SecurityApiError(409, "IDENTITY_ACCOUNT_LIMIT", "同一实名最多绑定两个未注销账号");
    return digest;
  } catch (error) {
    if (error instanceof SecurityApiError) throw error;
    throw unavailable();
  }
}

export async function recordVerifiedIdentitySubject(client: PoolClient, userId: string, digest: string, source: "NATIVE_VERIFICATION" | "LEGACY_IMPORT"): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw unavailable();
  try {
    await client.query(`INSERT INTO zzsh_iam.user_identity_subject(user_id,subject_digest,source)
      VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET subject_digest=EXCLUDED.subject_digest,source=EXCLUDED.source,recorded_at=clock_timestamp()`,
    [userId,digest,source]);
  } catch { throw unavailable(); }
}

type LegacyIdentitySubjectInput = { userId: string; sourceRef: string; documentNumber: string };

/** NEXT strict batches preserve legacy duplicates but never replace an existing subject. */
export async function recordLegacyIdentitySubjects(client: PoolClient, entries: LegacyIdentitySubjectInput[], key: Buffer | undefined): Promise<void> {
  if ((client as PoolClient & { getTransactionStatus?: () => string }).getTransactionStatus?.() !== "T") throw unavailable();
  if (!Array.isArray(entries) || entries.length > 100 || entries.some(entry => !entry
    || typeof entry.userId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.userId)
    || typeof entry.sourceRef !== "string" || !/^la_user:[0-9]{1,32}$/.test(entry.sourceRef)
    || typeof entry.documentNumber !== "string") || new Set(entries.map(entry => entry.userId)).size !== entries.length) throw unavailable();
  if (!entries.length) return;
  const planned = entries.map(entry => ({ userId: entry.userId, sourceRef: entry.sourceRef,
    subjectDigest: identitySubjectDigest(entry.documentNumber, key) }));
  const ids = planned.map(entry => entry.userId);
  const users = await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE`, [ids]);
  if (users.rowCount !== ids.length) throw new SecurityApiError(409, "CONFLICT", "旧实名用户来源不一致");
  const digests = [...new Set(planned.map(entry => entry.subjectDigest))].sort();
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(x.digest,806101))
    FROM unnest($1::text[]) WITH ORDINALITY AS x(digest,ordinal) ORDER BY x.ordinal`, [digests]);
  const states = new Map((await client.query<{ user_id: string; provider: string; provider_reference: string | null; identity_status: string }>(
    `SELECT user_id,provider,provider_reference,identity_status FROM zzsh_iam.user_identity_state
      WHERE user_id=ANY($1::text[]) ORDER BY user_id COLLATE "C" FOR UPDATE`, [ids])).rows.map(row => [row.user_id,row]));
  const subjects = new Map((await client.query<{ user_id: string; subject_digest: string; source: string }>(
    `SELECT user_id,subject_digest,source FROM zzsh_iam.user_identity_subject
      WHERE user_id=ANY($1::text[]) ORDER BY user_id COLLATE "C" FOR UPDATE`, [ids])).rows.map(row => [row.user_id,row]));
  const missing: typeof planned = [];
  for (const entry of planned) {
    const state = states.get(entry.userId), subject = subjects.get(entry.userId);
    if (!state || state.provider !== "legacy_mysql_restore" || state.provider_reference !== entry.sourceRef || state.identity_status !== "VERIFIED"
      || subject && (subject.source !== "LEGACY_IMPORT" || subject.subject_digest !== entry.subjectDigest))
      throw new SecurityApiError(409, "CONFLICT", "旧实名主体与当前身份冲突");
    if (!subject) missing.push(entry);
  }
  if (missing.length) {
    const inserted = await client.query(`INSERT INTO zzsh_iam.user_identity_subject(user_id,subject_digest,source)
      SELECT x.user_id,x.subject_digest,'LEGACY_IMPORT' FROM unnest($1::text[],$2::text[]) AS x(user_id,subject_digest)
      ORDER BY x.user_id COLLATE "C" ON CONFLICT(user_id) DO NOTHING RETURNING user_id`,
    [missing.map(entry => entry.userId),missing.map(entry => entry.subjectDigest)]);
    if (inserted.rowCount !== missing.length) throw new SecurityApiError(409, "CONFLICT", "旧实名主体写入冲突");
  }
}

/** Trusted importer only: retain grandfathered duplicates; do not mint verification or apply the new-binding cap. */
export async function recordLegacyIdentitySubject(client: PoolClient, userId: string, documentNumber: string, key: Buffer | undefined): Promise<void> {
  const state = (await client.query<{ identityStatus: string; provider: string }>(
    `SELECT identity_status AS "identityStatus",provider FROM zzsh_iam.user_identity_state WHERE user_id=$1`, [userId],
  )).rows[0];
  if (!state || state.provider !== "legacy_mysql_restore" || state.identityStatus !== "VERIFIED") {
    throw new SecurityApiError(409,"CONFLICT","旧实名来源尚未核实");
  }
  await recordVerifiedIdentitySubject(client,userId,identitySubjectDigest(documentNumber,key),"LEGACY_IMPORT");
}
