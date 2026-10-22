import { createHash } from 'node:crypto';
import { canonicalize } from '../supply/content-hash';
import { sourceSignedYuanToCents, sourceYuanToCents } from './personal-finance-read';
import type { FinanceEntry } from './admin-finance-read';
import type { FinanceOrderFact } from './admin-finance-order-read';

export type HistoricalFinancePurpose = 'SETTLEMENT_INCOME'|'OWNER_RENTAL_INCOME'|'DISTRIBUTION_INCOME'
  |'WITHDRAWAL_APPLICATION'|'WITHDRAWAL_DEBIT'|'WITHDRAWAL_REJECTED_RETURN'|'TRANSFER_FAILED_RETURN'|'WECHAT_WITHDRAWAL_FAILED_RETURN'
  |'PLATFORM_CREDIT'|'PLATFORM_DEBIT'|'DEPOSIT_COMPENSATION'|'TASK_SETTLEMENT'|'UNKNOWN';
export type HistoricalFinanceDisplay = {
  changeType:string|null; purposeCode:HistoricalFinancePurpose; purposeLabel:string; originalLogNumber:string|null;
  recordedAmountCents:string|null; balanceAfterCents:string|null; feeCents:string|null; netCents:string|null;
  originalStatus:string|null; originalStatusLabel:string|null; channelState:'UNVERIFIED';
  association:{state:'MATCHED'|'UNRESOLVED'|'AMBIGUOUS'|'DENIED';kind:'ORDER'|'WITHDRAWAL'|'DISTRIBUTION'|'TASK'|'UNKNOWN';
    documentRef:string|null;number:string|null;path:string|null;role:'OWNER'|'BENEFICIARY'|'WITHDRAWER'|null;
    originalStatus:string|null;originalStatusLabel:string|null};
};
export type HistoricalRelationAccess = {adminId:string;isBoss:boolean;orderRead:boolean;financeDocumentRead:boolean;resourceRead?:boolean};
type Raw = Record<string,any>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const text=(value:unknown):string|null=>typeof value==='string'&&value.length>0&&value.length<=255&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
const code=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='string'&&/^-?\d{1,24}$/.test(value)?value:null;
const money=(value:unknown,signed=false):string|null=>{try{return signed?sourceSignedYuanToCents(value):sourceYuanToCents(value);}catch{return null;}};
const epoch=(value:unknown):number|null=>{const str=String(value);return /^[1-9]\d{0,9}$/.test(str)&&Number(str)<=4294967295?Number(str)*1000:null;};
const emptyAssociation=(state:HistoricalFinanceDisplay['association']['state']='UNRESOLVED'):HistoricalFinanceDisplay['association']=>({state,kind:'UNKNOWN',documentRef:null,number:null,path:null,role:null,originalStatus:null,originalStatusLabel:null});
const purposes:Record<string,[HistoricalFinancePurpose,string]>={
  '1001':['SETTLEMENT_INCOME','结算入账'],'1002':['WITHDRAWAL_DEBIT','提现申请扣款'],'1003':['WITHDRAWAL_REJECTED_RETURN','提现拒绝回退'],
  '1004':['TRANSFER_FAILED_RETURN','转账失败回退'],'1005':['WECHAT_WITHDRAWAL_FAILED_RETURN','微信零钱提现失败回退'],
  '1006':['PLATFORM_CREDIT','平台加款'],'1007':['PLATFORM_DEBIT','平台减款'],'1008':['DEPOSIT_COMPENSATION','押金补偿'],'1009':['TASK_SETTLEMENT','任务结算'],
};
const withdrawalStates:Record<string,string>={'1':'旧平台待提现','2':'旧平台提现中','3':'旧平台记为成功','4':'旧平台记为失败','5':'旧平台转账中'};
const distributionStates:Record<string,string>={'1':'旧平台待结算','2':'旧平台已结算','3':'旧平台已失效'};
const snapshot=(row:Raw):Raw=>row.extra_evidence?.snapshot??{};
export function historicalObservationDisplay(row:Raw):HistoricalFinanceDisplay {
  const source=snapshot(row),changeType=row.source_entity==='la_log_earnings'?code(source.legacyChangeType):null;
  const [purposeCode,purposeLabel]=row.source_entity==='la_withdraw_apply'?['WITHDRAWAL_APPLICATION','提现申请记录'] as const:
    row.source_entity==='la_distribution_order'?['DISTRIBUTION_INCOME','分销收益记录'] as const:purposes[changeType??'']??['UNKNOWN','用途待核'];
  const originalStatus=code(row.source_status);
  return {changeType,purposeCode,purposeLabel,originalLogNumber:row.source_entity==='la_log_earnings'?text(source.legacyLogNumber):null,
    recordedAmountCents:money(row.amount),balanceAfterCents:money(row.balance_after,true),feeCents:money(row.fee,true),netCents:money(row.net,true),
    originalStatus,originalStatusLabel:row.source_entity==='la_withdraw_apply'?withdrawalStates[originalStatus??'']??null:row.source_entity==='la_distribution_order'?distributionStates[originalStatus??'']??null:null,
    channelState:'UNVERIFIED',association:emptyAssociation()};
}

/** Only immutable source bytes close a relationship; decoded IDs alone never do. */
function originalSource(row:Raw):Raw|null {
  const evidence=row.extra_evidence,source=snapshot(row),proof=source.rawSource;
  try{
    if(row.source_type!=='LEGACY_MYSQL'||!proof||proof.entity!==row.source_entity||typeof proof.canonical!=='string'
      ||sha(proof.canonical)!==proof.digest||typeof evidence.canonical!=='string'||sha(evidence.canonical)!==row.source_digest
      ||canonicalize(source)!==evidence.canonical)return null;
    const original=JSON.parse(proof.canonical);
    if(canonicalize(original)!==proof.canonical||String(original.id)!==row.source_id||String(source.sourceId)!==row.source_id
      ||String(source.sourceUserId)!==String(evidence.legacyUserId))return null;
    if(row.source_entity==='la_log_earnings'){
      if(String(original.userId)!==String(evidence.legacyUserId)||source.referenceId!==String(original.sourceId)
        ||source.amount!==original.amount||source.leftAmount!==original.leftAmount||String(source.action)!==String(original.action)
        ||String(source.legacyChangeType)!==String(original.changeType)||source.legacyLogNumber!==original.sn
        ||String(source.createdAt)!==String(original.createdAt)||source.amount!==row.amount||source.leftAmount!==row.balance_after
        ||String(source.action)!==String(row.action))return null;
    }else if(row.source_entity==='la_withdraw_apply'){
      if(String(original.userId)!==String(evidence.legacyUserId)||source.amount!==original.money||source.fee!==original.handling_fee
        ||source.net!==original.left_money||String(source.sourceStatus)!==String(original.status)
        ||source.referenceId!==String(original.id)||source.referenceSn!==original.sn||String(source.createdAt)!==String(original.create_time)
        ||source.amount!==row.amount||source.fee!==row.fee||source.net!==row.net||String(source.sourceStatus)!==String(row.source_status)
        ||epoch(source.createdAt)!==Date.parse(row.at??''))return null;
    }else if(row.source_entity==='la_distribution_order'){
      if(String(original.user_id)!==String(evidence.legacyUserId)||source.amount!==original.earnings||source.sourceNumber!==original.sn
        ||String(source.sourceStatus)!==String(original.status)||String(source.orderId)!==String(original.order_id)
        ||String(source.sourceOrderType)!==String(original.order_type)||String(source.sourceSettlementTime)!==String(original.settle_time)
        ||source.amount!==row.amount||String(source.sourceStatus)!==String(row.source_status)||epoch(source.sourceUpdatedAt)!==Date.parse(row.at??''))return null;
    }else return null;
    return original;
  }catch{return null;}
}

type Match={kind:'ORDER'|'WITHDRAWAL'|'DISTRIBUTION';number:string;ref:string;path:string|null;role:'OWNER'|'BENEFICIARY'|'WITHDRAWER';status:string|null;statusLabel:string|null;allowed:boolean;purpose?:[HistoricalFinancePurpose,string];fee?:string|null;net?:string|null};
function orderMatch(entry:FinanceEntry,log:Raw,source:Raw,order:FinanceOrderFact):Match|null {
  const proof=order.legacySource;
  if(!proof||order.sourceType!=='LEGACY_MYSQL'||order.sourceSystem!==entry.sourceSystem||proof.entity!=='la_order'
    ||order.sourceId!==String(log.sourceId)||order.ownerId!==entry.subjectId||!order.sourceDigest)return null;
  try{
    const original=proof.snapshot;
    if(sha(canonicalize(original))!==order.sourceDigest||String(original.id)!==order.sourceId||text(original.order_sn)!==order.number||String(original.sale_user_id)!==String(log.userId)
      ||String(original.order_status)!=='4'||String(original.pay_is)!=='1'||String(log.action)!=='1'||String(log.changeType)!=='1001')return null;
    const earnings=money(original.sale_earnings),fee=money(original.full_payout_money),at=epoch(original.confirm_time),logAt=epoch(log.createdAt);
    if(earnings===null||fee===null||BigInt(earnings)<BigInt(fee)||BigInt(earnings)-BigInt(fee)!==BigInt(entry.historical!.recordedAmountCents??'-1')
      ||at===null||at!==logAt||at!==Date.parse(proof.completedAt??'')||source.at===null||Date.parse(source.at)!==logAt)return null;
    if(entry.evidence.originalNumber&&entry.evidence.originalNumber!==order.number)return null;
    return {kind:'ORDER',number:order.number,ref:order.ref,path:`/orders/${encodeURIComponent(order.id)}`,role:'OWNER',status:'4',statusLabel:'旧平台已完成',allowed:order.objectReadable===true,purpose:['OWNER_RENTAL_INCOME','号主租赁收入']};
  }catch{return null;}
}

function observationMatch(entry:FinanceEntry,log:Raw,source:Raw,candidate:Raw,access?:HistoricalRelationAccess):Match|null {
  if(candidate.source_type!=='LEGACY_MYSQL'||candidate.source_system!==entry.sourceSystem||candidate.subject_id!==entry.subjectId
    ||candidate.source_id!==String(log.sourceId))return null;
  const original=originalSource(candidate);if(!original)return null;
  const value=money(candidate.amount),logAt=epoch(log.createdAt);
  if(value===null||value!==entry.historical!.recordedAmountCents||logAt===null||Date.parse(source.at??'')!==logAt)return null;
  const permitted=access?.isBoss===true||access?.financeDocumentRead===true;
  if(String(log.changeType)==='1002'&&String(log.action)==='2'&&candidate.source_entity==='la_withdraw_apply'
    &&['1','2','3','4','5'].includes(String(original.status))&&epoch(original.create_time)===logAt){
    const number=text(original.sn);if(!number||entry.evidence.originalNumber&&entry.evidence.originalNumber!==number)return null;
    return {kind:'WITHDRAWAL',number,ref:`HISTORY_WITHDRAWAL:${candidate.id}`,path:`/finance/documents/${encodeURIComponent('HISTORY_WITHDRAWAL:'+candidate.id)}`,role:'WITHDRAWER',status:String(original.status),statusLabel:withdrawalStates[String(original.status)]??null,allowed:permitted,fee:money(candidate.fee,true),net:money(candidate.net,true)};
  }
  if(String(log.changeType)==='1001'&&String(log.action)==='1'&&candidate.source_entity==='la_distribution_order'
    &&String(original.status)==='2'&&String(original.is_delete)==='0'&&['1','2'].includes(String(original.order_type))
    &&['1','2','3'].includes(String(original.level))&&epoch(original.settle_time)===logAt){
    const number=text(original.sn);if(!number||entry.evidence.originalNumber&&entry.evidence.originalNumber!==number)return null;
    return {kind:'DISTRIBUTION',number,ref:`HISTORY_DISTRIBUTION:${candidate.id}`,path:`/finance/documents/${encodeURIComponent('HISTORY_DISTRIBUTION:'+candidate.id)}`,role:'BENEFICIARY',status:'2',statusLabel:distributionStates['2']!,allowed:permitted,purpose:['DISTRIBUTION_INCOME','分销收入']};
  }
  return null;
}

/** Enrichment only; the original entries, financial effect and source identity are never replaced. */
export function enrichHistoricalObservations(entries:FinanceEntry[],sources:Raw[],orders:FinanceOrderFact[],access?:HistoricalRelationAccess):void {
  const rows=new Map(sources.map(row=>[String(row.id),row]));
  const candidateRows=new Map<string,Raw[]>(),candidateOrders=new Map<string,FinanceOrderFact[]>();
  for(const row of sources){if(!['la_distribution_order','la_withdraw_apply'].includes(row.source_entity))continue;const key=[row.source_system,row.subject_id,row.source_id].join('\u0000');candidateRows.set(key,[...(candidateRows.get(key)??[]),row]);}
  for(const order of orders){const key=[order.sourceSystem,order.ownerId,order.sourceId].join('\u0000');candidateOrders.set(key,[...(candidateOrders.get(key)??[]),order]);}
  for(const entry of entries){
    if(!entry.historical)continue;
    const source=rows.get(entry.id.slice('history:'.length)),original=source?originalSource(source):null;
    if(!source||!original){entry.reasonCodes.push('HISTORICAL_RELATION_EVIDENCE_UNAVAILABLE');continue;}
    if(source.source_entity!=='la_log_earnings')continue;
    const type=entry.historical.changeType;
    if(['1003','1004','1005'].includes(type??'')){entry.reasonCodes.push('HISTORICAL_RETURN_EVENT_TIME_UNAVAILABLE');continue;}
    if(type!=='1001'&&type!=='1002')continue;
    const matches:Match[]=[];
    const candidateKey=[entry.sourceSystem,entry.subjectId,String(original.sourceId)].join('\u0000');
    if(type==='1001')for(const order of candidateOrders.get(candidateKey)??[]){const match=orderMatch(entry,original,source,order);if(match)matches.push(match);}
    for(const candidate of candidateRows.get(candidateKey)??[]){const match=observationMatch(entry,original,source,candidate,access);if(match)matches.push(match);}
    const unique=[...new Map(matches.map(match=>[match.kind+'\u0000'+match.ref,match])).values()];
    if(unique.length!==1){entry.historical.association=emptyAssociation(unique.length?'AMBIGUOUS':'UNRESOLVED');entry.reasonCodes.push(unique.length?'ORIGINAL_ORDER_REFERENCE_AMBIGUOUS':'ORIGINAL_ORDER_REFERENCE_UNRESOLVED');continue;}
    const match=unique[0]!;
    if(!match.allowed){entry.historical.association=emptyAssociation('DENIED');continue;}
    entry.historical.association={state:'MATCHED',kind:match.kind,documentRef:access?.isBoss||access?.financeDocumentRead?match.ref:null,number:match.number,path:match.path,role:match.role,originalStatus:match.status,originalStatusLabel:match.statusLabel};
    if(match.purpose){[entry.historical.purposeCode,entry.historical.purposeLabel]=match.purpose;}
    if(match.fee!==undefined)entry.historical.feeCents=match.fee;
    if(match.net!==undefined)entry.historical.netCents=match.net;
    entry.related.push({ref:match.ref,label:match.number,...(match.path?{path:match.path}:{})});
  }
}
