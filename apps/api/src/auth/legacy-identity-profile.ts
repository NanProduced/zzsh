import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { maskIdCard, maskRealName } from "./identity-mask";
import { identitySubjectDigest, normalizeIdentityDocument } from "./identity-subject";
import { SecurityApiError } from "./security-core";
import type { Pool, PoolClient } from "pg";

export type LegacyIdentityBinding = { userId: string; sourceRef: string; sourceDigest: string; subjectDigest: string };
export type LegacyIdentityDetails = { realName: string; idCardNo: string };
export type SealedLegacyIdentity = { keyVersion: "v1"; nameMask: string; documentMask: string; nonce: string; tag: string; ciphertext: string };

const unavailable = () => new SecurityApiError(503, "IDENTITY_DEPENDENCY_UNAVAILABLE", "实名资料暂不可用，请稍后重试");
const hexDigest = /^[a-f0-9]{64}$/;
const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** This key is independent of the identity-subject HMAC and can be backed up separately. */
export function legacyIdentityProfileKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw unavailable();
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) throw unavailable();
  return key;
}

function validBinding(binding: LegacyIdentityBinding): boolean {
  return Boolean(binding) && typeof binding.userId === "string" && stableId.test(binding.userId)
    && typeof binding.sourceRef === "string" && /^la_user:[0-9]{1,32}$/.test(binding.sourceRef)
    && typeof binding.sourceDigest === "string" && hexDigest.test(binding.sourceDigest)
    && typeof binding.subjectDigest === "string" && hexDigest.test(binding.subjectDigest);
}

export function validLegacyIdentityDetails(value: LegacyIdentityDetails): boolean {
  if (!value || typeof value.realName !== "string" || !value.realName.trim() || Array.from(value.realName).length > 64
    || /[\p{Cc}\p{Cs}]/u.test(value.realName) || typeof value.idCardNo !== "string"
    || Array.from(value.idCardNo).length > 64 || /[\p{Cc}\p{Cs}]/u.test(value.idCardNo)) return false;
  try { normalizeIdentityDocument(value.idCardNo); return true; } catch { return false; }
}

function aad(binding: LegacyIdentityBinding, value: Pick<SealedLegacyIdentity, "keyVersion" | "nameMask" | "documentMask">): Buffer {
  return Buffer.from(JSON.stringify(["zzsh:legacy-identity-profile:v1", binding.userId, binding.sourceRef, binding.sourceDigest,
    binding.subjectDigest, value.keyVersion, value.nameMask, value.documentMask]));
}

export function sealLegacyIdentityProfile(binding: LegacyIdentityBinding, details: LegacyIdentityDetails,
  profileKey: Buffer | undefined, subjectKey: Buffer | undefined): SealedLegacyIdentity {
  if (!validBinding(binding) || !validLegacyIdentityDetails(details) || profileKey?.length !== 32
    || identitySubjectDigest(details.idCardNo, subjectKey) !== binding.subjectDigest) throw unavailable();
  const mask = { keyVersion: "v1" as const, nameMask: maskRealName(details.realName), documentMask: maskIdCard(details.idCardNo) };
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", profileKey, nonce);
  cipher.setAAD(aad(binding, mask));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(details), "utf8"), cipher.final()]);
  return { ...mask, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

/** All failures collapse to one error; neither driver nor cryptographic details may expose PII. */
export function openLegacyIdentityProfile(binding: LegacyIdentityBinding, sealed: SealedLegacyIdentity,
  profileKey: Buffer | undefined, subjectKey: Buffer | undefined): LegacyIdentityDetails {
  try {
    if (!validBinding(binding) || profileKey?.length !== 32 || sealed.keyVersion !== "v1"
      || !/^[A-Za-z0-9_-]{16}$/.test(sealed.nonce) || !/^[A-Za-z0-9_-]{22}$/.test(sealed.tag)
      || !/^[A-Za-z0-9_-]{1,4096}$/.test(sealed.ciphertext)) throw unavailable();
    const decipher = createDecipheriv("aes-256-gcm", profileKey, Buffer.from(sealed.nonce, "base64url"));
    decipher.setAAD(aad(binding, sealed));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64url")), decipher.final()]);
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "idCardNo,realName") throw unavailable();
    const details = parsed as LegacyIdentityDetails;
    if (!validLegacyIdentityDetails(details) || maskRealName(details.realName) !== sealed.nameMask || maskIdCard(details.idCardNo) !== sealed.documentMask
      || identitySubjectDigest(details.idCardNo, subjectKey) !== binding.subjectDigest) throw unavailable();
    return details;
  } catch { throw unavailable(); }
}

type ProfileRow = { user_id: string; source_ref: string; source_digest: string; subject_digest: string;
  key_version: "v1"; name_mask: string; document_mask: string; nonce: string; authentication_tag: string; ciphertext: string };
const sealedFromRow = (row: ProfileRow): SealedLegacyIdentity => ({ keyVersion: row.key_version, nameMask: row.name_mask,
  documentMask: row.document_mask, nonce: row.nonce, tag: row.authentication_tag, ciphertext: row.ciphertext });
const bindingFromRow = (row: ProfileRow): LegacyIdentityBinding => ({ userId: row.user_id, sourceRef: row.source_ref,
  sourceDigest: row.source_digest, subjectDigest: row.subject_digest });
const profileColumns = `p.user_id,p.source_ref,p.source_digest,p.subject_digest,p.key_version,p.name_mask,p.document_mask,p.nonce,p.authentication_tag,p.ciphertext`;
const currentLegacyJoin = `FROM zzsh_iam.user_legacy_identity_profile p
  JOIN zzsh_iam.user_identity_state s ON s.user_id=p.user_id AND s.identity_status='VERIFIED'
    AND s.provider='legacy_mysql_restore' AND s.provider_reference=p.source_ref
  JOIN zzsh_iam.user_identity_subject b ON b.user_id=p.user_id AND b.source='LEGACY_IMPORT' AND b.subject_digest=p.subject_digest`;

/** The caller owns the batch transaction; exact replay does not replace existing ciphertext. */
export async function recordLegacyIdentityProfiles(client: PoolClient,
  entries: { binding: LegacyIdentityBinding; details: LegacyIdentityDetails }[], profileKey: Buffer | undefined,
  subjectKey: Buffer | undefined): Promise<("CREATED" | "REPLAYED")[]> {
  if (!Array.isArray(entries)) throw unavailable();
  if (!entries.length) return [];
  if (entries.length > 1000 || profileKey?.length !== 32 || entries.some(entry => !entry || !validBinding(entry.binding))
    || new Set(entries.map(entry => entry.binding.userId)).size !== entries.length) throw unavailable();
  for (const { binding, details } of entries) {
    if (!validBinding(binding) || !validLegacyIdentityDetails(details)
      || identitySubjectDigest(details.idCardNo, subjectKey) !== binding.subjectDigest) throw unavailable();
  }
  const ids = entries.map(entry => entry.binding.userId);
  const states = new Map((await client.query<{ user_id: string; provider: string; provider_reference: string; identity_status: string; subject_digest: string; source: string }>(
    `SELECT s.user_id,s.provider,s.provider_reference,s.identity_status,b.subject_digest,b.source
       FROM zzsh_iam.user_identity_state s JOIN zzsh_iam.user_identity_subject b ON b.user_id=s.user_id
      WHERE s.user_id=ANY($1::text[]) ORDER BY s.user_id FOR UPDATE OF s`, [ids])).rows.map(row => [row.user_id, row]));
  const existing = new Map((await client.query<ProfileRow>(`SELECT ${profileColumns} FROM zzsh_iam.user_legacy_identity_profile p
    WHERE p.user_id=ANY($1::text[]) ORDER BY p.user_id FOR UPDATE`, [ids])).rows.map(row => [row.user_id, row]));
  const insert: Record<string, string>[] = [], outcomes: ("CREATED" | "REPLAYED")[] = [];
  for (const { binding, details } of entries) {
    const state = states.get(binding.userId), row = existing.get(binding.userId);
    if (!state || state.provider !== "legacy_mysql_restore" || state.provider_reference !== binding.sourceRef
      || state.identity_status !== "VERIFIED" || state.source !== "LEGACY_IMPORT" || state.subject_digest !== binding.subjectDigest) throw unavailable();
    if (row) {
      if (row.source_ref !== binding.sourceRef || row.source_digest !== binding.sourceDigest || row.subject_digest !== binding.subjectDigest) throw unavailable();
      const saved = openLegacyIdentityProfile(bindingFromRow(row), sealedFromRow(row), profileKey, subjectKey);
      if (saved.realName !== details.realName || saved.idCardNo !== details.idCardNo) throw unavailable();
      outcomes.push("REPLAYED"); continue;
    }
    const sealed = sealLegacyIdentityProfile(binding, details, profileKey, subjectKey);
    insert.push({ user_id: binding.userId, subject_digest: binding.subjectDigest, source_digest: binding.sourceDigest, source_ref: binding.sourceRef,
      key_version: sealed.keyVersion, name_mask: sealed.nameMask, document_mask: sealed.documentMask, nonce: sealed.nonce,
      authentication_tag: sealed.tag, ciphertext: sealed.ciphertext });
    outcomes.push("CREATED");
  }
  if (insert.length) {
    const inserted = await client.query(`INSERT INTO zzsh_iam.user_legacy_identity_profile
      (user_id,subject_digest,source_digest,source_ref,key_version,name_mask,document_mask,nonce,authentication_tag,ciphertext)
      SELECT user_id,subject_digest,source_digest,source_ref,key_version,name_mask,document_mask,nonce,authentication_tag,ciphertext
      FROM jsonb_to_recordset($1::jsonb) AS x(user_id text,subject_digest text,source_digest text,source_ref text,key_version text,
        name_mask text,document_mask text,nonce text,authentication_tag text,ciphertext text)
      ON CONFLICT(user_id) DO NOTHING RETURNING user_id`, [JSON.stringify(insert)]);
    if (inserted.rowCount !== insert.length) throw unavailable();
  }
  return outcomes;
}

export async function recordLegacyIdentityProfile(client: PoolClient, binding: LegacyIdentityBinding,
  details: LegacyIdentityDetails, profileKey: Buffer | undefined, subjectKey: Buffer | undefined): Promise<"CREATED" | "REPLAYED"> {
  return (await recordLegacyIdentityProfiles(client, [{ binding, details }], profileKey, subjectKey))[0]!;
}

export async function readLegacyIdentityMasks(client: Pool | PoolClient, userId: string): Promise<{ nameMask: string; documentMask: string } | null> {
  const row = (await client.query<{ nameMask: string; documentMask: string }>(`SELECT p.name_mask AS "nameMask",p.document_mask AS "documentMask"
    ${currentLegacyJoin} WHERE p.user_id=$1`, [userId])).rows[0];
  if (!row) return null;
  if (typeof row.nameMask !== "string" || !row.nameMask.includes("*") || Array.from(row.nameMask).length > 64
    || typeof row.documentMask !== "string" || !row.documentMask.includes("*") || Array.from(row.documentMask).length > 64
    || /[\p{Cc}\p{Cs}]/u.test(row.nameMask + row.documentMask)) throw unavailable();
  return row;
}

/** Caller checks the admin's permissions and audits successful disclosure in the same transaction. */
export async function readLegacyIdentityForAdmin(client: PoolClient, userId: string,
  profileKey: Buffer | undefined, subjectKey: Buffer | undefined): Promise<LegacyIdentityDetails | null> {
  const row = (await client.query<ProfileRow>(`SELECT ${profileColumns} ${currentLegacyJoin}
    WHERE p.user_id=$1 FOR SHARE OF s,b`, [userId])).rows[0];
  return row ? openLegacyIdentityProfile(bindingFromRow(row), sealedFromRow(row), profileKey, subjectKey) : null;
}
