import type { Pool, PoolClient } from "pg";
import {createHmac} from "node:crypto";
import {SecurityApiError} from "./security-core";
import type {NativeRealNameProvider} from "./identity-provider";
import { maskIdCard, maskRealName } from "./identity-mask";
import { readLegacyIdentityMasks } from "./legacy-identity-profile";
export { maskIdCard, maskRealName } from "./identity-mask";

/** B5: read-only masked identity display. Full values never leave this module and are never logged. */
export const IDENTITY_MASKING_VERSION = "identity-mask-v1" as const;
export interface IdentityDisplay { realNameMasked: string; idCardMasked: string; maskingVersion: typeof IDENTITY_MASKING_VERSION }
export type IdentityDisplayResult = { identityDisplay: IdentityDisplay; identityDisplayReason: null; identityDisplaySource?: "NATIVE_PROVIDER" | "RECORDED_SOURCE" }
  | { identityDisplay: null; identityDisplayReason: "NOT_RECORDED" | "NOT_VERIFIED" | "STORE_UNAVAILABLE" };

/** Minimal restricted store interface: one self-scoped SELECT, no write path. */
type IdentityDisplayRecord={ realName: string; idCardNo: string;source?:"RECORDED_SOURCE" }|{maskedDisplay:IdentityDisplay;source:"NATIVE_PROVIDER"|"RECORDED_SOURCE"};
export interface IdentityDisplayStore { read(userId: string): Promise<IdentityDisplayRecord | null> }
export function pgIdentityDisplayStore(db: Pool | PoolClient): IdentityDisplayStore {
  return {
    async read(userId) {
      const transactional="release" in db;
      if(transactional)await db.query("SAVEPOINT identity_display_read");
      try{
        const nativeReady=(await db.query<{ready:boolean}>(`SELECT to_regclass('zzsh_iam.user_identity_verified_profile') IS NOT NULL AS ready`)).rows[0]?.ready===true;
        if(nativeReady){
          const row=(await db.query<{nameMask:string;documentMask:string}>(`/* native-identity-display-read */ SELECT p.name_mask AS "nameMask",p.document_mask AS "documentMask"
            FROM zzsh_iam.user_identity_verified_profile p JOIN zzsh_iam.user_identity_state s ON s.user_id=p.user_id
            JOIN zzsh_iam.user_identity_subject b ON b.user_id=p.user_id AND b.subject_digest=p.subject_digest
            WHERE p.user_id=$1 AND s.identity_status='VERIFIED' AND s.provider=p.provider AND s.provider_reference=p.provider_reference AND s.verified_at=p.verified_at`,[userId])).rows[0];
          if(row){
            if(typeof row.nameMask!=="string"||!row.nameMask.includes("*")||row.nameMask.length>64
              ||typeof row.documentMask!=="string"||!row.documentMask.includes("*")||row.documentMask.length>64)throw new Error("invalid native identity masks");
            if(transactional)await db.query("RELEASE SAVEPOINT identity_display_read");
            return{maskedDisplay:{realNameMasked:row.nameMask,idCardMasked:row.documentMask,maskingVersion:IDENTITY_MASKING_VERSION},source:"NATIVE_PROVIDER" as const};
          }
        }
      const legacyReady=(await db.query<{ready:boolean}>(`SELECT to_regclass('zzsh_iam.user_legacy_identity_profile') IS NOT NULL AS ready`)).rows[0]?.ready===true;
      if(legacyReady){
        const row=await readLegacyIdentityMasks(db,userId);
        if(row){
          if(transactional)await db.query("RELEASE SAVEPOINT identity_display_read");
          return {maskedDisplay:{realNameMasked:row.nameMask,idCardMasked:row.documentMask,maskingVersion:IDENTITY_MASKING_VERSION},source:"RECORDED_SOURCE" as const};
        }
      }
      const r = await db.query<{ realName: string; idCardNo: string }>(
        `/* identity-display-read */ SELECT d.real_name AS "realName", d.id_card_no AS "idCardNo"
           FROM zzsh_iam.user_identity_display_source d JOIN zzsh_iam.user_identity_state s ON s.user_id=d.user_id
           WHERE d.user_id = $1 AND s.identity_status='VERIFIED' AND s.provider NOT IN ('aliyun-id2meta','aliyun-market-id2')`, [userId]);
        if(transactional)await db.query("RELEASE SAVEPOINT identity_display_read");
        return r.rows[0]?{...r.rows[0],source:"RECORDED_SOURCE" as const}:null;
      }catch(error){
        if(transactional){await db.query("ROLLBACK TO SAVEPOINT identity_display_read");await db.query("RELEASE SAVEPOINT identity_display_read");}
        throw error;
      }
    },
  };
}

export async function readIdentityDisplay(store: IdentityDisplayStore, userId: string, identityStatus: string | null | undefined): Promise<IdentityDisplayResult> {
  if (identityStatus !== "VERIFIED") return { identityDisplay: null, identityDisplayReason: "NOT_VERIFIED" };
  let row: IdentityDisplayRecord | null;
  try { row = await store.read(userId); }
  catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42501") return { identityDisplay: null, identityDisplayReason: "STORE_UNAVAILABLE" };
    throw new Error("identity display read failed"); // drop driver message/detail to avoid echoing values
  }
  if (!row) return { identityDisplay: null, identityDisplayReason: "NOT_RECORDED" };
  if("maskedDisplay"in row)return{identityDisplay:row.maskedDisplay,identityDisplayReason:null,identityDisplaySource:row.source};
  return { identityDisplay: { realNameMasked: maskRealName(row.realName), idCardMasked: maskIdCard(row.idCardNo), maskingVersion: IDENTITY_MASKING_VERSION }, identityDisplayReason: null,
    ...(row.source?{identityDisplaySource:row.source}:{}) };
}

/** Verified provider response only; hashes/masks are written in the same state/subject transaction, never full PII. */
export async function assertNativeIdentityDisplayReady(client:PoolClient,provider?:string):Promise<void>{
  const ready=(await client.query(`SELECT to_regclass('zzsh_iam.user_identity_verified_profile') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM (VALUES('user_id','INSERT'),('subject_digest','INSERT'),('name_hmac','INSERT'),('name_mask','INSERT'),
      ('document_mask','INSERT'),('provider','INSERT'),('provider_reference','INSERT'),('verified_at','INSERT'),
      ('subject_digest','UPDATE'),('name_hmac','UPDATE'),('name_mask','UPDATE'),('document_mask','UPDATE'),
      ('provider','UPDATE'),('provider_reference','UPDATE'),('verified_at','UPDATE'),('recorded_at','UPDATE')) p(column_name,privilege)
    WHERE NOT COALESCE(has_column_privilege(current_user,to_regclass('zzsh_iam.user_identity_verified_profile'),p.column_name,p.privilege),false)
  ) AND ($1::text IS DISTINCT FROM 'aliyun-market-id2' OR (
    EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_iam.user_identity_verified_profile')
      AND c.conname='user_identity_verified_profile_provider_check' AND c.convalidated
      AND position('aliyun-market-id2' IN pg_get_constraintdef(c.oid))>0)
    AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_iam.user_identity_verification_attempt')
      AND c.conname='user_identity_verification_attempt_disclosure_version_check' AND c.convalidated
      AND position('identity-provider-transfer-market-v1' IN pg_get_constraintdef(c.oid))>0)
  )) AS ready`,[provider??null])).rows[0]?.ready;
  if(ready!==true)throw new SecurityApiError(503,"IDENTITY_DEPENDENCY_UNAVAILABLE","Verified identity profile storage is unavailable");
}

export async function recordNativeIdentityDisplay(client:PoolClient,input:{userId:string;subjectDigest:string;fullName:string;documentNumber:string;provider:NativeRealNameProvider;providerReference:string},key:Buffer|undefined):Promise<void>{
  if(!key||key.length<32||!input.providerReference||!/^[a-f0-9]{64}$/.test(input.subjectDigest))throw new SecurityApiError(503,"IDENTITY_DEPENDENCY_UNAVAILABLE","Verified identity profile is unavailable");
  const nameHmac=createHmac("sha256",key).update("zzsh:verified-real-name:v1\0").update(input.fullName.trim().normalize("NFC")).digest("hex");
  const saved=await client.query(`INSERT INTO zzsh_iam.user_identity_verified_profile(user_id,subject_digest,name_hmac,name_mask,document_mask,provider,provider_reference,verified_at)
    SELECT s.user_id,$2,$3,$4,$5,$6,$7,s.verified_at FROM zzsh_iam.user_identity_state s
      JOIN zzsh_iam.user_identity_subject b ON b.user_id=s.user_id AND b.subject_digest=$2
      WHERE s.user_id=$1 AND s.identity_status='VERIFIED' AND s.provider=$6 AND s.provider_reference=$7 AND s.verified_at IS NOT NULL
    ON CONFLICT(user_id) DO UPDATE SET subject_digest=EXCLUDED.subject_digest,name_hmac=EXCLUDED.name_hmac,
      name_mask=EXCLUDED.name_mask,document_mask=EXCLUDED.document_mask,provider=EXCLUDED.provider,provider_reference=EXCLUDED.provider_reference,
      verified_at=EXCLUDED.verified_at,recorded_at=clock_timestamp() RETURNING user_id`,[input.userId,input.subjectDigest,nameHmac,maskRealName(input.fullName),maskIdCard(input.documentNumber),input.provider,input.providerReference]);
  if(saved.rowCount!==1)throw new SecurityApiError(503,"IDENTITY_DEPENDENCY_UNAVAILABLE","Verified identity profile binding is unavailable");
}
