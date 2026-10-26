import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { assertAdminContextInTransaction, type AdminContext } from '../auth/auth-security';
import { ADMIN_PERMISSION, hasPermission, requirePermission } from '../auth/admin-authorization';
import { assertGameScopeUsable, gameScopeSql, readAdminGameScope, gameScopeSignature } from '../auth/admin-scope';
import { requireAdminAccess } from '../supply/supply-routes';
import { invalid, notFound } from '../supply/supply-util';
import { SecurityApiError } from '../auth/security-core';
import { canonicalize } from '../supply/content-hash';
import { earningProjection, readAdminEarningCalculations, readAdminEarningEventActions, type AdminEarningCalculation } from './distribution-earning-read';
import { readAdminLegacyDutyFinances } from './legacy-duty-finance-store';

type Actor = AdminContext;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const unavailable=(message:string)=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE',message);
const utc=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const key=(value:string)=>{if(typeof value!=='string'||!ID.test(value))throw invalid('Exact distribution object is required');return value;};
async function authorize(c:PoolClient,actor:Actor){
 await assertAdminContextInTransaction(c,actor);
 const access=await requireAdminAccess(c,actor.userId);
 if(access.passwordChangeRequired)throw new SecurityApiError(403,'FORBIDDEN','Password change required');
 return access;
}
async function installed(c:PoolClient,tables:readonly string[]){
 const row=(await c.query(`SELECT bool_and(to_regclass(name) IS NOT NULL) AS ready FROM unnest($1::text[]) name`,[tables])).rows[0];
 return row?.ready===true;
}
const unknownCalculation=(reason:string):AdminEarningCalculation=>({knowledge:'UNKNOWN',policyVersion:null,levelCode:null,percent:null,baseCents:null,formula:null,reasonCodes:[reason]});
export type AdminDistributionOrder = {
 schema:'admin-distribution-order.v1';knowledge:'KNOWN'|'UNAVAILABLE';contextKey:string;order:{id:string;origin:'NATIVE'|'LEGACY';number:string|null};
 items:Array<{id:string;origin:'NATIVE'|'LEGACY_MYSQL';beneficiary:{userId:string|null;name:string|null};role:string;amountCents:string;state:string;fundsDisposition:string;occurredAt:string;dueAt:string|null;dueAtKnowledge:string;calculation:AdminEarningCalculation;channelArrival:'UNKNOWN';documentRef:string|null;recoveryRequiredCents:string|null;events:Array<{eventId:string;knowledge:'KNOWN'|'UNKNOWN';action:string|null;occurredAt:string|null}>}>;
 truncated:boolean;coverage:'THIS_AUTHORIZED_ORDER_ONLY';currentLegacyCommissions:Array<{dutyId:string;subjectId:string|null;amountCents:string|null;knowledge:'KNOWN'|'UNKNOWN';state:string;finalization:'POSTED'|'FINALIZED_ZERO'|'UNKNOWN';documentRef:string|null}>;
 reasonCodes:string[];
};

/** Order-read authority admits this order's commission amounts, never its private platform base. */
export async function readAdminDistributionOrder(c:PoolClient,actor:Actor,input:{orderId:string;origin:'NATIVE'|'LEGACY'}):Promise<AdminDistributionOrder>{
 key(input.orderId);if(!['NATIVE','LEGACY'].includes(input.origin))throw invalid('Explicit distribution order origin required');
 const access=await authorize(c,actor);requirePermission(access,ADMIN_PERMISSION.orderRead);
 const gameScope=await readAdminGameScope(c,actor.userId);assertGameScopeUsable(gameScope,access.isBoss);
 const table=input.origin==='NATIVE'?'rental_order':'legacy_order_read_snapshot';
 if(!await installed(c,['zzsh_order.'+table]))throw unavailable('Original distribution order source unavailable');
 const legacy=input.origin==='LEGACY';
 const order=(await c.query(`SELECT o.id,${legacy?'o.original_order_no':'o.display_no'} AS number${legacy?',o.source_system,o.legacy_id,o.source_digest':''}
  FROM zzsh_order.${table} o WHERE o.id=$1 AND ${gameScopeSql('o.game_id','$2','$3')}`,[input.orderId,actor.userId,access.isBoss])).rows[0];
 if(!order)throw notFound();
 const contextKey=createHash('sha256').update(canonicalize([actor.userId,actor.sessionId,[...access.permissions].sort(),gameScopeSignature(gameScope),input])).digest('hex');
 const base:AdminDistributionOrder={schema:'admin-distribution-order.v1',knowledge:'UNAVAILABLE',contextKey,order:{id:input.orderId,origin:input.origin,number:typeof order.number==='string'&&order.number.trim()?order.number:null},items:[],truncated:false,coverage:'THIS_AUTHORIZED_ORDER_ONLY',currentLegacyCommissions:[],reasonCodes:[]};
 if(!await installed(c,[legacy?'zzsh_order.personal_finance_observation':'zzsh_order.rental_referral_earning']))return{...base,reasonCodes:['DISTRIBUTION_SOURCE_NOT_INSTALLED']};
 const rows=legacy?(await c.query(`SELECT 'history:'||o.id AS id,'LEGACY_MYSQL'::text AS origin,o.user_id,o.legacy_user_id,o.source_system,o.source_entity,o.source_id,o.source_digest,o.source_canonical,o.snapshot,
   CASE o.snapshot->>'sourceStatus' WHEN '1' THEN 'PENDING' WHEN '2' THEN 'SETTLED' WHEN '3' THEN 'EXPIRED' ELSE 'UNKNOWN' END AS state,
   CASE o.snapshot->>'level' WHEN '1' THEN 'TASK_REFERRAL' WHEN '2' THEN 'RENTER_REFERRAL' WHEN '3' THEN 'OWNER_REFERRAL' ELSE 'UNKNOWN' END AS role,
   o.snapshot->>'amount' AS source_amount,${utc('o.source_event_at')} AS occurred_at,NULL::text AS due_at,'HISTORICAL_STATUS_ONLY'::text AS funds_disposition,NULL::text AS recovery_required_cents,o.included_in_opening AS included,'0'::text AS version,o.snapshot->>'orderId' AS order_id,
   o.user_id AS beneficiary_user_id,u.name AS beneficiary_name
   FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id
   WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND o.source_entity='la_distribution_order' AND o.source_system=$1 AND o.snapshot->>'orderId'=$2
   ORDER BY o.source_event_at DESC,o.id COLLATE "C" DESC LIMIT 101`,[order.source_system,String(order.legacy_id)])).rows
  :(await c.query(`SELECT 'native:'||e.id AS id,'NATIVE'::text AS origin,e.id AS earning_id,e.order_id,e.beneficiary_user_id,u.name AS beneficiary_name,e.beneficiary_role AS role,e.state,e.amount_cents::text AS source_amount,
   ${utc('e.created_at')} AS occurred_at,${utc('e.due_at')} AS due_at,e.funds_disposition,e.recovery_required_cents::text,e.version::text
   FROM zzsh_order.rental_referral_earning e LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id
   WHERE e.order_id=$1 ORDER BY e.created_at DESC,e.id COLLATE "C" DESC LIMIT 101`,[input.orderId])).rows;
 const visible=rows.slice(0,100),financial=hasPermission(access,ADMIN_PERMISSION.financeRead),userReadable=hasPermission(access,ADMIN_PERMISSION.userDirectoryRead);
 const documentReadable=hasPermission(access,ADMIN_PERMISSION.financeDocumentRead);
 const calculations=!legacy&&await installed(c,['zzsh_order.payment_distribution_basis','zzsh_order.settlement_posting'])?await readAdminEarningCalculations(c,visible.map(r=>r.earning_id)):new Map<string,AdminEarningCalculation>();
 const events=new Map<string,Array<{eventId:string;knowledge:'KNOWN'|'UNKNOWN';action:string|null;occurredAt:string|null}>>();let eventsTruncated=false;
 if(!legacy&&visible.length&&await installed(c,['zzsh_order.rental_referral_transition','zzsh_order.finance_event'])){
  const changes=(await c.query(`SELECT t.earning_id,t.finance_event_id AS event_id,${utc('e.created_at')} AS occurred_at FROM zzsh_order.rental_referral_transition t LEFT JOIN zzsh_order.finance_event e ON e.id=t.finance_event_id WHERE t.earning_id=ANY($1::text[]) ORDER BY e.created_at,t.finance_event_id COLLATE "C" LIMIT 501`,[visible.map(r=>r.earning_id)])).rows;
  eventsTruncated=changes.length>500;const shown=changes.slice(0,500),actions=await readAdminEarningEventActions(c,shown.map(r=>r.event_id));
  for(const row of shown){if(!visible.some(v=>v.earning_id===row.earning_id))throw unavailable('Commission transition root differs');const a=actions.get(row.event_id);const list=events.get(row.earning_id)??[];list.push({eventId:row.event_id,knowledge:a?.knowledge??'UNKNOWN',action:a?.knowledge==='KNOWN'?a.action:null,occurredAt:typeof row.occurred_at==='string'?row.occurred_at:null});events.set(row.earning_id,list);}
 }
 const seen=new Set<string>();
 const items=visible.map(row=>{
  if(seen.has(row.id)||legacy&&(row.source_system!==order.source_system||String(row.order_id)!==String(order.legacy_id))||!legacy&&row.order_id!==input.orderId)throw unavailable('Distribution order/source binding differs');seen.add(row.id);
  const projected=earningProjection(row);
  const original=legacy?unknownCalculation('HISTORICAL_CALCULATION_NOT_RECORDED'):calculations.get(row.earning_id)??unknownCalculation('ORIGINAL_BASIS_UNAVAILABLE');
  const calculation=financial?original:{...original,baseCents:null,reasonCodes:[...original.reasonCodes,'INTERNAL_COMMISSION_BASE_REDACTED']};
  return{id:projected.id,origin:projected.origin as 'NATIVE'|'LEGACY_MYSQL',beneficiary:{userId:userReadable?row.beneficiary_user_id:null,name:typeof row.beneficiary_name==='string'?row.beneficiary_name:null},role:projected.role,amountCents:projected.amount.amountCents,state:projected.state,fundsDisposition:projected.fundsDisposition,occurredAt:projected.occurredAt,dueAt:projected.dueAt,dueAtKnowledge:projected.dueAtKnowledge,calculation,channelArrival:'UNKNOWN' as const,documentRef:documentReadable?(legacy?`HISTORY_DISTRIBUTION:${row.id.slice('history:'.length)}`:`DISTRIBUTION:${row.earning_id}`):null,recoveryRequiredCents:projected.recoveryRequiredCents,events:events.get(row.earning_id)??[]};
 });
 const reasonCodes:string[]=[];let legacyTruncated=false;let currentLegacyCommissions:AdminDistributionOrder['currentLegacyCommissions']=[];
 if(legacy){
  reasonCodes.push('HISTORY_IS_OBSERVATION_NOT_CURRENT_COMMISSION');
  if(await installed(c,['zzsh_order.legacy_order_duty','zzsh_order.legacy_duty_finance_fact'])){
   const duties=await readAdminLegacyDutyFinances(c,{orderId:input.orderId});
   const matched=[...duties.values()].filter(d=>d.kind==='COMMISSION');legacyTruncated=matched.length>100;
   currentLegacyCommissions=matched.slice(0,100).map(d=>{const known=d.knowledge==='KNOWN'&&d.parentSourceId===String(order.legacy_id)&&d.parentSourceDigest===order.source_digest;return{dutyId:d.dutyId,subjectId:userReadable?d.subjectId:null,amountCents:known?d.amountCents:null,knowledge:known?'KNOWN' as const:'UNKNOWN' as const,state:d.state,finalization:known?d.finalization:'UNKNOWN' as const,documentRef:documentReadable&&known?`LEGACY_DUTY:${d.dutyId}`:null};});
  }else reasonCodes.push('CURRENT_LEGACY_COMMISSION_NOT_INSTALLED');
 }
 return{...base,knowledge:'KNOWN',items,truncated:rows.length>100||legacyTruncated||eventsTruncated,currentLegacyCommissions,reasonCodes:[...reasonCodes,...(rows.length>100||legacyTruncated?['ORDER_COMMISSION_ROWS_TRUNCATED']:[]),...(eventsTruncated?['COMMISSION_EVENTS_TRUNCATED']:[]),'ACCRUAL_DUE_DATE_IS_NOT_POSTING_TIME','LOCAL_POSTING_IS_NOT_CHANNEL_ARRIVAL']};
}

export type AdminDistributionRelations={schema:'admin-distribution-relations.v1';knowledge:'KNOWN'|'UNAVAILABLE';subjectId:string;participant:{knowledge:'KNOWN'|'UNKNOWN';eligibility:string;commissionFrozen:boolean|null;legacyLevelCode:string|null};relations:Array<{type:'INVITER'|'DISTRIBUTION_LEADER';knowledge:'KNOWN_PARENT'|'KNOWN_NONE'|'UNKNOWN';parentUserId:string|null;parentName:string|null;sourceType:string|null;policyVersion:string|null}>;reasonCodes:string[]};
/** Existing directory plus distribution read authority; no impersonation of a beneficiary's self endpoint. */
export async function readAdminDistributionRelations(c:PoolClient,actor:Actor,userId:string):Promise<AdminDistributionRelations>{
 key(userId);const access=await authorize(c,actor);requirePermission(access,ADMIN_PERMISSION.userDirectoryRead);
 if(!access.isBoss&&!access.permissions.has('personal.distribution.policy.read')&&!access.permissions.has('personal.distribution.policy.manage'))throw new SecurityApiError(403,'FORBIDDEN','Distribution relation read permission required');
 if(!(await c.query('SELECT id FROM zzsh_auth_user."user" WHERE id=$1',[userId])).rows[0])throw notFound();
 const base:AdminDistributionRelations={schema:'admin-distribution-relations.v1',knowledge:'UNAVAILABLE',subjectId:userId,participant:{knowledge:'UNKNOWN',eligibility:'UNKNOWN',commissionFrozen:null,legacyLevelCode:null},relations:[],reasonCodes:[]};
 if(!await installed(c,['zzsh_order.distribution_participant','zzsh_order.invitation_relation']))return{...base,reasonCodes:['DISTRIBUTION_RELATION_SOURCE_NOT_INSTALLED']};
 const participant=(await c.query('SELECT eligibility,commission_frozen,level_code,inviter_knowledge,leader_knowledge FROM zzsh_order.distribution_participant WHERE user_id=$1',[userId])).rows[0];
 const rows=(await c.query(`SELECT r.type,r.parent_user_id,r.source_type,r.policy_version_id,u.name AS parent_name FROM zzsh_order.invitation_relation r LEFT JOIN zzsh_auth_user."user" u ON u.id=r.parent_user_id WHERE r.child_user_id=$1 ORDER BY r.type,r.id COLLATE "C" LIMIT 3`,[userId])).rows;
 const relations=(['INVITER','DISTRIBUTION_LEADER'] as const).map(type=>{
  const matched=rows.filter(r=>r.type===type),declared=participant?.[type==='INVITER'?'inviter_knowledge':'leader_knowledge'];
  const known=rows.length<=2&&matched.length===1&&declared==='KNOWN_PARENT'&&typeof matched[0].parent_user_id==='string'&&ID.test(matched[0].parent_user_id);
  return{type,knowledge:known?'KNOWN_PARENT' as const:declared==='KNOWN_NONE'&&!matched.length?'KNOWN_NONE' as const:'UNKNOWN' as const,parentUserId:known?matched[0].parent_user_id:null,parentName:known&&typeof matched[0].parent_name==='string'?matched[0].parent_name:null,sourceType:known?matched[0].source_type:null,policyVersion:known?matched[0].policy_version_id:null};
 });
 return{...base,knowledge:'KNOWN',participant:participant?{knowledge:'KNOWN',eligibility:participant.eligibility,commissionFrozen:typeof participant.commission_frozen==='boolean'?participant.commission_frozen:null,legacyLevelCode:typeof participant.level_code==='string'?participant.level_code:null}:base.participant,relations,reasonCodes:['REGISTRATION_INVITER_AND_COMMISSION_LEADER_ARE_DISTINCT','CURRENT_RELATION_DOES_NOT_REWRITE_FROZEN_ORDERS',...(relations.some(r=>r.knowledge==='UNKNOWN')?['RELATION_SOURCE_NOT_CLOSED']:[])]};
}
