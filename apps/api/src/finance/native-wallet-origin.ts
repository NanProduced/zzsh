import {createHash} from 'node:crypto';import type {PoolClient} from 'pg';import {canonicalize} from '../supply/content-hash';import {conflict,invalid} from '../supply/supply-util';
/** New-user registration transaction only. An uninstalled origin template remains UNKNOWN. */
export async function initializeNativeWalletOrigin(c:PoolClient,userId:string,requestId:string){
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)||!requestId)throw invalid('Original registration subject/request required');
 const resource=(await c.query("SELECT to_regprocedure('zzsh_order.initialize_native_wallet_origin(text,text,text,text)') IS NOT NULL AND to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AS installed,d.oid,current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE datname=current_database()")).rows[0];
 if(!resource?.installed)return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_TEMPLATE_NOT_INSTALLED'};
 if(Number(resource.oid)!==869754||resource.name!=='zzsh_test_order_personal_finance'||resource.role!=='zzsh_order_personal_finance_r'||resource.marker!=='zzsh:order-reservation-test:v1')return{knowledge:'UNKNOWN' as const,reason:'NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED'};
 const proof=(await c.query(`SELECT u.id,s.version::text AS identity_version,p.insert_xid::text AS insertion_xid
 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
 JOIN zzsh_order.native_user_insert_proof p ON p.user_id=u.id
 WHERE u.id=$1 AND NOT u.suspended AND s.account_status='ACTIVE' AND s.provider='none'
 AND p.insert_xid=pg_current_xact_id()
 AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=u.id
  AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS')`,[userId])).rows[0];
 if(!proof)throw conflict('Only a proved fresh native user INSERT can initialize wallet origin');
 const source=canonicalize({schema:'native-wallet-origin.v2',userId,insertionXid:proof.insertion_xid,identityVersion:proof.identity_version}),digest=createHash('sha256').update(source).digest('hex');
 const result=(await c.query('SELECT zzsh_order.initialize_native_wallet_origin($1,$2,$3,$4) AS result',[userId,source,digest,requestId])).rows[0]?.result;if(result?.knowledge!=='KNOWN'||result?.origin!=='NATIVE_GENESIS'||result?.availableCents!=='0')throw conflict('Native origin initialization result is not verified');return result;
}


