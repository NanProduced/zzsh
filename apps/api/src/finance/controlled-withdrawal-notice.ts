import {createHash} from 'node:crypto';import type {Pool,PoolClient} from 'pg';
import {withTransaction,SecurityApiError} from '../auth/security-core';import {canonicalize} from '../supply/content-hash';import {notFound,conflict,invalid,ensureOnlyFields} from '../supply/supply-util';
import {authorizeFinanceMaintenance} from './personal-finance-maintenance';
import {assertControlledWithdrawalResource} from './controlled-withdrawal-store';import type {ControlledPayoutEvidence} from './controlled-withdrawal';
export type VerifiedControlledNotice=Readonly<{noticeId:string;originalOperationId:string;evidence:Readonly<ControlledPayoutEvidence>;sourceDigest:string}>;
const capabilities=new WeakMap<object,{resourceOid:number}>(),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function validateEvidence(value:unknown):ControlledPayoutEvidence{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid('Declared notice evidence object required');
 const doc=value as Record<string,unknown>,base=['mode','intentId','payoutKey'];
 const fields=doc.outcome==='SUCCEEDED'?['reference','netCents','feeCents']:doc.outcome==='FAILED'?['reference','unpaidConfirmed','transferredCents','chargedFeeCents']:[];
 ensureOnlyFields(doc,[...base,'outcome',...fields]);
 if(doc.mode!=='LOCAL_CONTROLLED'||!['ACKNOWLEDGED','TIMEOUT','SUCCEEDED','FAILED'].includes(String(doc.outcome))||base.slice(1).some(k=>typeof doc[k]!=='string'||!(doc[k] as string).length||(doc[k] as string).length>128))throw invalid('Declared local notice binding invalid');
 if(fields.length&&(typeof doc.reference!=='string'||!doc.reference.trim()||doc.reference.length>128))throw invalid('Declared terminal reference invalid');
 for(const key of fields.filter(k=>k.endsWith('Cents')))if(typeof doc[key]!=='string'||!/^(0|[1-9]\d{0,23})$/.test(doc[key] as string))throw invalid('Declared notice requires unsigned exact cents');
 if(doc.outcome==='FAILED'&&typeof doc.unpaidConfirmed!=='boolean')throw invalid('Declared failure confirmation invalid');
 return doc as ControlledPayoutEvidence;
}
/** Reviewed maintenance transaction only; no public ingress. Same source event returns its original notice. */
export async function declareControlledNotice(c:PoolClient,actor:{userId:string;sessionId:string;requestId:string},input:{noticeId:string;sourceEventKey:string;originalOperationId:string;userId:string;evidence:ControlledPayoutEvidence;approvalDigest:string;reason:string}){
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(input.noticeId)||!input.sourceEventKey||input.sourceEventKey.length>128||!input.originalOperationId||!input.userId||!/^[0-9a-f]{64}$/.test(input.approvalDigest)||input.reason.trim().length<3||input.reason.length>500)throw invalid('Exact reviewed notice declaration required');
 const evidence=validateEvidence(input.evidence),canonical=canonicalize(evidence),digest=sha(canonical);
 const resource=(await c.query("SELECT current_database() AS name,current_user AS role,d.oid,shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE datname=current_database()")).rows[0];
 if(!resource||Number(resource.oid)!==820148||resource.name!=='zzsh_test_m2_auth_auth_compat'||resource.role!=='zzsh_m2_auth_compat_m'||resource.marker!=='zzsh:m2-auth-test:v1')throw conflict('Notice declaration requires original synthetic maintenance resource');
 await authorizeFinanceMaintenance(c,actor);
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['zzsh:controlled-notice:'+input.sourceEventKey]);
 const old=(await c.query("SELECT id,source_digest,original_operation_id,user_id,intent_id,payout_key FROM zzsh_order.controlled_payout_notice WHERE source_system='zzsh-local-declared-notification-v1' AND source_event_key=$1",[input.sourceEventKey])).rows[0];
 if(old){if(old.source_digest!==digest||old.original_operation_id!==input.originalOperationId||old.user_id!==input.userId||old.intent_id!==evidence.intentId||old.payout_key!==evidence.payoutKey)throw conflict('Original notice source event has a different declaration');return{noticeId:old.id,replayed:true,sourceDigest:digest};}
 await c.query('SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE',[input.userId]);
 await c.query('SELECT id FROM zzsh_order.withdrawal_intent WHERE id=$1 FOR UPDATE',[evidence.intentId]);
 await c.query(`INSERT INTO zzsh_order.controlled_payout_notice(id,mode,source_system,source_event_key,original_operation_id,intent_id,payout_key,user_id,evidence_canonical,source_digest,approval_digest,declared_by_admin_id,declaration_reason) VALUES($1,'LOCAL_CONTROLLED_DECLARED_NOTICE','zzsh-local-declared-notification-v1',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[input.noticeId,input.sourceEventKey,input.originalOperationId,evidence.intentId,evidence.payoutKey,input.userId,canonical,digest,input.approvalDigest,actor.userId,input.reason]);
 return{noticeId:input.noticeId,replayed:false,sourceDigest:digest};
}
/** Candidate internal reader only. No public route or arbitrary evidence body. */
export function createControlledNoticeReader(pool:Pool,scope:{resourceOid:820148;allowedNoticeIds:readonly string[]}){
 if(scope.resourceOid!==820148||!scope.allowedNoticeIds.length||scope.allowedNoticeIds.some(id=>!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw conflict('Explicit synthetic notice source required');
 const allowed=new Set(scope.allowedNoticeIds);
 return async(noticeId:string):Promise<VerifiedControlledNotice>=>withTransaction(pool,async c=>{
  if(!allowed.has(noticeId))throw notFound();const resource=await assertControlledWithdrawalResource(c);if(resource.oid!==scope.resourceOid)throw conflict('Notice source resource mismatch');
  if(!(await c.query("SELECT to_regclass('zzsh_order.controlled_payout_notice') IS NOT NULL AS present")).rows[0]?.present)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Controlled notice source is not installed');
  const row=(await c.query(`SELECT n.id,n.original_operation_id,n.evidence_canonical,n.source_digest,n.mode,p.intent_id,p.payout_key FROM zzsh_order.controlled_payout_notice n JOIN zzsh_order.controlled_payout_operation p ON p.id=n.original_operation_id WHERE n.id=$1`,[noticeId])).rows[0];if(!row)throw notFound();
  if(row.mode!=='LOCAL_CONTROLLED_DECLARED_NOTICE'||sha(row.evidence_canonical)!==row.source_digest)throw conflict('Notice source digest or mode differs');let evidence:ControlledPayoutEvidence;try{evidence=validateEvidence(JSON.parse(row.evidence_canonical));}catch{throw conflict('Notice source payload shape differs');}
  if(canonicalize(evidence)!==row.evidence_canonical||evidence.mode!=='LOCAL_CONTROLLED'||evidence.intentId!==row.intent_id||evidence.payoutKey!==row.payout_key||!['ACKNOWLEDGED','TIMEOUT','SUCCEEDED','FAILED'].includes(evidence.outcome))throw conflict('Notice does not bind the original local operation');
  const notice=Object.freeze({noticeId:row.id,originalOperationId:row.original_operation_id,evidence:Object.freeze(evidence),sourceDigest:row.source_digest});capabilities.set(notice,{resourceOid:scope.resourceOid});return notice;
 });
}
export function requireVerifiedControlledNotice(notice:VerifiedControlledNotice,resourceOid:number){const proof=capabilities.get(notice);if(!proof||proof.resourceOid!==resourceOid)throw conflict('Notice is not verified for this resource');return notice;}
