import {createHash} from 'node:crypto';import type {PoolClient} from 'pg';import {canonicalize} from '../supply/content-hash';import {conflict,invalid} from '../supply/supply-util';
export type NativeOriginResource=Readonly<{resourceSet:string;resourceOid:number}>;
const marker='zzsh:order-reservation-test:v1';
/** New-user registration transaction only. Explicit assembly resource; no environment fallback.
 * An uninstalled template or a resource that does not match the assembly stays UNKNOWN and never
 * reports a fabricated zero. Every database-side failure propagates: the reviewed template
 * currently reports admission and digest failures with the same message, so the caller must not
 * guess that any template error means "not admitted" (a dedicated database contract is pending). */
export async function initializeNativeWalletOrigin(c:PoolClient,userId:string,requestId:string,resource?:NativeOriginResource){
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)||!requestId)throw invalid('Original registration subject/request required');
 const row=(await c.query("SELECT to_regprocedure('zzsh_order.initialize_native_wallet_origin(text,text,text,text)') IS NOT NULL AND to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AS installed,d.oid,current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE datname=current_database()")).rows[0];
 if(!row?.installed)return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_TEMPLATE_NOT_INSTALLED'};
 if(!resource||!/^[a-z][a-z0-9_]{0,20}$/.test(resource.resourceSet)||!Number.isSafeInteger(resource.resourceOid)||resource.resourceOid<=0
  ||Number(row.oid)!==resource.resourceOid||row.name!==`zzsh_test_order_${resource.resourceSet}`||row.role!==`zzsh_order_${resource.resourceSet}_r`||row.marker!==marker)return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'};
 const proof=(await c.query(`SELECT u.id,s.version::text AS identity_version,p.insert_xid::text AS insertion_xid
 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
 JOIN zzsh_order.native_user_insert_proof p ON p.user_id=u.id
 WHERE u.id=$1 AND NOT u.suspended AND s.account_status='ACTIVE' AND s.provider='none'
 AND p.insert_xid=pg_current_xact_id()
 AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=u.id
  AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS')`,[userId])).rows[0];
 if(!proof)throw conflict('Only a proved fresh native user INSERT can initialize wallet origin');
 const source=canonicalize({schema:'native-wallet-origin.v2',userId,insertionXid:proof.insertion_xid,identityVersion:proof.identity_version}),digest=createHash('sha256').update(source).digest('hex');
 const result=(await c.query('SELECT zzsh_order.initialize_native_wallet_origin($1,$2,$3,$4) AS result',[userId,source,digest,requestId])).rows[0]?.result;
 // The 0066 contract defines exactly one structured UNKNOWN (missing admission row); every other
 // non-KNOWN shape or template error is rejected so the registration transaction rolls back.
 if(result&&typeof result==='object'&&Object.keys(result).sort().join(',')==='knowledge,reason'&&result.knowledge==='UNKNOWN'&&result.reason==='NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED')return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'};
 if(result?.knowledge!=='KNOWN'||result?.origin!=='NATIVE_GENESIS'||result?.availableCents!=='0'||result?.reason!==undefined)throw conflict('Native origin initialization result is not verified');return result;
}
