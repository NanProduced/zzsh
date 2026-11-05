import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {canonicalize} from '../supply/content-hash';
import {sourceYuanToCents} from './finance-money';

export type WalletPurpose = 'OWNER_RENTAL_INCOME'|'DISTRIBUTION_INCOME'|'WITHDRAWAL_DEBIT'|'WITHDRAWAL_REJECTED_RETURN'|'TRANSFER_FAILED_RETURN'|'WECHAT_WITHDRAWAL_FAILED_RETURN'|'PLATFORM_CREDIT'|'PLATFORM_DEBIT'|'DEPOSIT_COMPENSATION'|'TASK_SETTLEMENT'|'UNKNOWN';
export type WalletHistoryEvidence = {purpose:WalletPurpose;amountSemantics:'BALANCE_RECORD'|'UNVERIFIED'};
type Row = Record<string,any>;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const epoch=(v:unknown)=>/^[1-9]\d{0,9}$/.test(String(v))&&Number(v)<=4294967295?Number(v):null;
const at=(v:unknown)=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
const amount=(v:unknown)=>{try{return sourceYuanToCents(v);}catch{return null;}};
const key=(system:unknown,id:unknown)=>JSON.stringify([system,String(id)]);

/** Validate the stored source and the original fields, never the decoded ID alone. */
function original(row:Row,userId:string):Row|null{
 try{
  const s=row.snapshot,p=s?.rawSource;
  if(row.user_id!==userId||row.source_type!=='LEGACY_MYSQL'||row.source_system!=='legacy_mysql_restore'||!object(s)||!object(p)||p.entity!==row.source_entity
   ||typeof row.source_canonical!=='string'||sha(row.source_canonical)!==row.source_digest||canonicalize(s)!==row.source_canonical
   ||typeof p.canonical!=='string'||sha(p.canonical)!==p.digest)return null;
  const raw=JSON.parse(p.canonical);if(!object(raw)||canonicalize(raw)!==p.canonical||String(raw.id)!==row.source_id
   ||String(s.sourceId)!==row.source_id||String(s.sourceUserId)!==row.legacy_user_id)return null;
  if(row.source_entity==='la_log_earnings'){
   if(row.source_kind!=='HISTORICAL_EARNINGS_LOG'||String(raw.userId)!==row.legacy_user_id||String(raw.sourceId)!==s.referenceId
    ||amount(raw.amount)===null||raw.amount!==s.amount||raw.leftAmount!==s.leftAmount||String(raw.action)!==String(s.action)
    ||String(raw.changeType)!==String(s.legacyChangeType)||raw.sn!==s.legacyLogNumber||String(raw.createdAt)!==String(s.createdAt)
    ||epoch(raw.createdAt)===null||at(row.source_event_at)!==epoch(raw.createdAt)!*1000)return null;
  }else if(row.source_entity==='la_distribution_order'){
   if(row.source_kind!=='HISTORICAL_DISTRIBUTION'||String(raw.user_id)!==row.legacy_user_id||raw.earnings!==s.amount
    ||raw.sn!==s.sourceNumber||String(raw.status)!==String(s.sourceStatus)||String(raw.order_id)!==String(s.orderId)
    ||String(raw.order_type)!==String(s.sourceOrderType)||String(raw.settle_time)!==String(s.sourceSettlementTime)
    ||epoch(raw.update_time)===null||at(row.source_event_at)!==epoch(raw.update_time)!*1000)return null;
  }else if(row.source_entity==='la_withdraw_apply'){
   if(row.source_kind!=='HISTORICAL_WITHDRAWAL'||String(raw.userId)!==row.legacy_user_id||raw.money!==s.amount
    ||raw.sn!==s.referenceSn||String(raw.status)!==String(s.sourceStatus)||String(raw.create_time)!==String(s.createdAt)
    ||epoch(raw.create_time)===null||at(row.source_event_at)!==epoch(raw.create_time)!*1000)return null;
  }else return null;
  return raw;
 }catch{return null;}
}

function originalReference(log:Row,raw:Row):string|null{
 try{
  const p=log.snapshot.sourceSupplement;if(!object(p)||p.entity!=='la_log_earnings'||typeof p.canonical!=='string'||sha(p.canonical)!==p.digest)return null;
  const full=JSON.parse(p.canonical);if(!object(full)||canonicalize(full)!==p.canonical)return null;
  for(const field of ['id','sn','action','amount','userId','sourceId','createdAt','changeType','leftAmount'])
   if(!Object.hasOwn(full,field)||canonicalize(full[field])!==canonicalize(raw[field]))return null;
  return typeof full.sourceSn==='string'&&full.sourceSn.length>0&&full.sourceSn===log.snapshot.referenceSn?full.sourceSn:null;
 }catch{return null;}
}

function orderCandidate(order:Row,log:Row,raw:Row,ref:string,userId:string):boolean{
 try{
  const source=order.source_snapshot,logTime=epoch(raw.createdAt),orderTime=epoch(source?.confirm_time);
  return order.owner_user_id===userId&&order.source_system===log.source_system&&order.source_entity==='la_order'
   &&order.legacy_id===String(raw.sourceId)&&order.original_order_no===ref&&order.legacy_owner_id===log.legacy_user_id
   &&object(source)&&sha(canonicalize(source))===order.source_digest&&String(source.id)===order.legacy_id
   &&source.order_sn===ref&&String(source.sale_user_id)===log.legacy_user_id&&String(source.order_status)==='4'&&String(source.pay_is)==='1'
   &&logTime!==null&&orderTime!==null&&logTime>=orderTime&&at(order.source_completed_at)===orderTime*1000
   &&amount(source.sale_earnings)!==null&&amount(source.full_payout_money)!==null&&amount(raw.amount)!==null
   &&BigInt(amount(source.sale_earnings)!)>=BigInt(amount(source.full_payout_money)!)
   &&BigInt(amount(source.sale_earnings)!)-BigInt(amount(source.full_payout_money)!)===BigInt(amount(raw.amount)!);
 }catch{return false;}
}
function observationCandidate(candidate:Row,log:Row,raw:Row,ref:string,userId:string):boolean{
 const source=original(candidate,userId),logTime=epoch(raw.createdAt);
 if(!source||candidate.source_system!==log.source_system||candidate.legacy_user_id!==log.legacy_user_id
  ||candidate.source_id!==String(raw.sourceId)||logTime===null)return false;
 if(candidate.source_entity==='la_distribution_order'){
  const settled=epoch(source.settle_time);
  return source.sn===ref&&String(source.status)==='2'&&String(source.is_delete)==='0'
   &&['1','2'].includes(String(source.order_type))&&['1','2','3'].includes(String(source.level))
   &&amount(source.earnings)!==null&&amount(source.earnings)===amount(raw.amount)
   &&settled!==null&&settled>=logTime;
 }
 if(candidate.source_entity==='la_withdraw_apply'){
  const created=epoch(source.create_time),type=String(raw.changeType);
  return source.sn===ref&&amount(source.money)!==null&&amount(source.money)===amount(raw.amount)
   &&created!==null&&created<=logTime&&(['1002'].includes(type)?['1','2','3','4','5'].includes(String(source.status)):String(source.status)==='4');
 }
 return false;
}

function withdrawalTimelineValid(application:Row,log:Row,raw:Row,ref:string,observations:Row[],userId:string):boolean{
 const source=original(application,userId);if(!source)return false;
 const related=observations.filter(o=>o.user_id===userId&&o.source_system===log.source_system&&o.source_entity==='la_log_earnings'
  &&o.snapshot?.referenceId===String(raw.sourceId)
  &&['1002','1003','1004','1005'].includes(String(o.snapshot?.legacyChangeType)));
 const proofs=related.map(row=>({row,raw:original(row,userId)}));
 if(proofs.some(p=>!p.raw||!originalReference(p.row,p.raw)||p.row.legacy_user_id!==log.legacy_user_id))return false;
 const matched=proofs.filter(p=>originalReference(p.row,p.raw!)===ref);
 const debits=matched.filter(p=>String(p.raw!.changeType)==='1002'),returns=matched.filter(p=>String(p.raw!.changeType)!=='1002');
 if(debits.length!==1||returns.length>1||!matched.some(p=>p.row.id===log.id))return false;
 const debit=debits[0]!.raw!,debitAt=epoch(debit.createdAt),applyAt=epoch(source.create_time),type=String(raw.changeType);
 if(String(debit.action)!=='2'||amount(debit.amount)!==amount(source.money)||debitAt===null||applyAt===null||debitAt<applyAt)return false;
 if(type!=='1002'&&returns.length!==1)return false;
 if(returns.length){const back=returns[0]!.raw!,backAt=epoch(back.createdAt);
  if(String(back.action)!=='1'||amount(back.amount)!==amount(source.money)||backAt===null||backAt<debitAt||String(source.status)!=='4')return false;
 }
 return true;
}

export function walletHistoricalPurpose(log:Row,observations:Row[],orders:Row[],userId:string):WalletPurpose{
 const raw=original(log,userId);if(!raw)return 'UNKNOWN';
 const type=String(raw.changeType),action=String(raw.action),direct:Record<string,[string,WalletPurpose]>={
  '1006':['1','PLATFORM_CREDIT'],'1007':['2','PLATFORM_DEBIT'],'1008':['1','DEPOSIT_COMPENSATION'],'1009':['1','TASK_SETTLEMENT']};
 if(direct[type])return action===direct[type]![0]?direct[type]![1]:'UNKNOWN';
 if(!(['1001','1002','1003','1004','1005'].includes(type))||action!==(type==='1002'?'2':'1'))return 'UNKNOWN';
 const ref=originalReference(log,raw);if(!ref||! /^[1-9]\d{0,23}$/.test(String(raw.sourceId)))return 'UNKNOWN';
 const relevantObs=observations.filter(o=>o.user_id===userId&&o.source_system===log.source_system&&o.source_id===String(raw.sourceId)
  &&o.source_entity===(type==='1001'?'la_distribution_order':'la_withdraw_apply'));
 const relevantOrders=type==='1001'?orders.filter(o=>o.owner_user_id===userId&&o.source_system===log.source_system&&o.legacy_id===String(raw.sourceId)):[];
 // A same-key unreadable source could be the other side of a collision, so do not choose a winner.
 if(relevantObs.some(o=>!original(o,userId))||relevantOrders.some(o=>!object(o.source_snapshot)||sha(canonicalize(o.source_snapshot))!==o.source_digest))return 'UNKNOWN';
 const matches=[...relevantObs.filter(o=>observationCandidate(o,log,raw,ref,userId)).map(o=>o.source_entity),
  ...relevantOrders.filter(o=>orderCandidate(o,log,raw,ref,userId)).map(()=> 'la_order')];
 if(matches.length!==1)return 'UNKNOWN';
 if(type==='1001')return matches[0]==='la_order'?'OWNER_RENTAL_INCOME':'DISTRIBUTION_INCOME';
 const application=relevantObs.find(o=>observationCandidate(o,log,raw,ref,userId));
 if(!application||!withdrawalTimelineValid(application,log,raw,ref,observations,userId))return 'UNKNOWN';
 return ({'1002':'WITHDRAWAL_DEBIT','1003':'WITHDRAWAL_REJECTED_RETURN','1004':'TRANSFER_FAILED_RETURN','1005':'WECHAT_WITHDRAWAL_FAILED_RETURN'} as Record<string,WalletPurpose>)[type]??'UNKNOWN';
}

/** Bounded page enrichment: one subject-scoped observation query and one subject-scoped order query. */
export async function readWalletHistoricalPurposes(client:PoolClient,userId:string,entries:Row[]):Promise<Map<string,WalletHistoryEvidence>>{
 const logs=entries.filter(e=>e.kind==='HISTORICAL'&&e.source_kind==='HISTORICAL_EARNINGS_LOG'&&typeof e.id==='string'&&e.id.startsWith('history:'));
 if(!logs.length)return new Map();
 const ids=logs.map(e=>e.id.slice(8)),keys=[...new Map(logs.filter(e=>typeof e.source_system==='string'&&typeof e.business_id==='string')
  .map(e=>[key(e.source_system,e.business_id),[e.source_system,e.business_id] as [string,string]])).values()];
 const systems=keys.map(k=>k[0]),references=keys.map(k=>k[1]);
 const observations=(await client.query(`/* wallet purpose observations */ SELECT id,user_id,legacy_user_id,source_kind,source_type,source_system,source_entity,source_id,source_digest,source_canonical,source_event_at,snapshot
  FROM zzsh_order.personal_finance_observation o WHERE o.user_id=$1 AND o.source_type='LEGACY_MYSQL' AND
   ((o.id=ANY($2::text[]) AND o.source_kind='HISTORICAL_EARNINGS_LOG' AND o.source_entity='la_log_earnings') OR
    (o.source_kind IN('HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL') AND (o.source_system,o.source_id) IN (SELECT * FROM unnest($3::text[],$4::text[]))) OR
    (o.source_kind='HISTORICAL_EARNINGS_LOG' AND o.source_entity='la_log_earnings' AND o.snapshot->>'legacyChangeType' IN('1002','1003','1004','1005')
     AND (o.source_system,o.snapshot->>'referenceId') IN (SELECT * FROM unnest($3::text[],$4::text[])))) LIMIT 1001`,[userId,ids,systems,references])).rows;
 if(observations.length>1000)return new Map(logs.map(e=>[e.id,{purpose:'UNKNOWN' as const,amountSemantics:'UNVERIFIED' as const}]));
 const orders=keys.length?(await client.query(`/* wallet purpose orders */ SELECT owner_user_id,legacy_owner_id,source_system,source_entity,legacy_id,source_digest,original_order_no,source_snapshot,source_completed_at
  FROM zzsh_order.legacy_order_read_snapshot o WHERE o.owner_user_id=$1 AND o.source_entity='la_order'
   AND (o.source_system,o.legacy_id) IN (SELECT * FROM unnest($2::text[],$3::text[]))`,[userId,systems,references])).rows:[];
 const result=new Map<string,WalletHistoryEvidence>();
 for(const entry of logs){
  const log=observations.find(o=>o.id===entry.id.slice(8)),raw=log?original(log,userId):null;
  const action=String(raw?.action),cents=amount(raw?.amount),expected=cents===null?null:(BigInt(cents)*(action==='2'?-1n:1n)).toString();
  const verified=!!log&&!!raw&&['1','2'].includes(action)&&entry.source_type===log.source_type&&entry.source_system===log.source_system
   &&entry.source_id===log.source_id&&entry.business_id===log.snapshot.referenceId&&at(entry.at)===at(log.source_event_at)&&entry.delta===expected;
  result.set(entry.id,verified?{purpose:walletHistoricalPurpose(log,observations,orders,userId),amountSemantics:'BALANCE_RECORD'}:{purpose:'UNKNOWN',amountSemantics:'UNVERIFIED'});
 }
 return result;
}
