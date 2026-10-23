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
type RelationEntry=Pick<FinanceEntry,'sourceSystem'|'subjectId'> & {evidence:{originalNumber?:string|null};historical:Pick<HistoricalFinanceDisplay,'recordedAmountCents'>};
function orderMatch(entry:RelationEntry,log:Raw,source:Raw,order:FinanceOrderFact):Match|null {
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

function observationMatch(entry:RelationEntry,log:Raw,source:Raw,candidate:Raw,access?:HistoricalRelationAccess):Match|null {
  if(candidate.source_type!=='LEGACY_MYSQL'||candidate.source_system!==entry.sourceSystem||candidate.subject_id!==entry.subjectId
    ||candidate.source_id!==String(log.sourceId))return null;
  const original=originalSource(candidate);if(!original)return null;
  const value=money(candidate.amount),logAt=epoch(log.createdAt);
  if(value===null||value!==entry.historical!.recordedAmountCents||logAt===null||Date.parse(source.at??'')!==logAt)return null;
  const permitted=access?.isBoss===true||access?.financeDocumentRead===true;
  if(String(log.changeType)==='1002'&&String(log.action)==='2'&&candidate.source_entity==='la_withdraw_apply'
    &&String(original.userId)===String(log.userId)&&['1','2','3','4','5'].includes(String(original.status))&&epoch(original.create_time)===logAt){
    const number=text(original.sn);if(!number||entry.evidence.originalNumber&&entry.evidence.originalNumber!==number)return null;
    return {kind:'WITHDRAWAL',number,ref:`HISTORY_WITHDRAWAL:${candidate.id}`,path:`/finance/documents/${encodeURIComponent('HISTORY_WITHDRAWAL:'+candidate.id)}`,role:'WITHDRAWER',status:String(original.status),statusLabel:withdrawalStates[String(original.status)]??null,allowed:permitted,fee:money(candidate.fee,true),net:money(candidate.net,true)};
  }
  if(String(log.changeType)==='1001'&&String(log.action)==='1'&&candidate.source_entity==='la_distribution_order'
    &&String(original.user_id)===String(log.userId)&&String(original.status)==='2'&&String(original.is_delete)==='0'&&['1','2'].includes(String(original.order_type))
    &&['1','2','3'].includes(String(original.level))&&epoch(original.settle_time)===logAt){
    const number=text(original.sn);if(!number||entry.evidence.originalNumber&&entry.evidence.originalNumber!==number)return null;
    return {kind:'DISTRIBUTION',number,ref:`HISTORY_DISTRIBUTION:${candidate.id}`,path:`/finance/documents/${encodeURIComponent('HISTORY_DISTRIBUTION:'+candidate.id)}`,role:'BENEFICIARY',status:'2',statusLabel:distributionStates['2']!,allowed:permitted,purpose:['DISTRIBUTION_INCOME','分销收入']};
  }
  return null;
}

type ReverseLinks={state:HistoricalFinanceDisplay['association']['state'];related:FinanceEntry['related'];reasonCodes:string[]};
const relationKey=(system:unknown,subject:unknown,reference:unknown)=>[system,subject,reference].join('\u0000');
function relationIndex(sources:Raw[],orders:FinanceOrderFact[]){
  const rows=new Map<string,Raw>(),references=new Map<string,Raw[]>(),logs=new Map<string,Raw[]>(),orderReferences=new Map<string,FinanceOrderFact[]>();
  for(const row of sources){
    if(rows.has(String(row.id)))continue;rows.set(String(row.id),row);
    const key=relationKey(row.source_system,row.subject_id,row.source_id);
    if(['la_distribution_order','la_withdraw_apply'].includes(row.source_entity)){const group=references.get(key);if(group)group.push(row);else references.set(key,[row]);}
    if(row.source_type==='LEGACY_MYSQL'&&row.source_entity==='la_log_earnings'){
      const reference=relationKey(row.source_system,row.subject_id,snapshot(row).referenceId),group=logs.get(reference);if(group)group.push(row);else logs.set(reference,[row]);
    }
  }
  for(const order of orders){const key=relationKey(order.sourceSystem,order.ownerId,order.sourceId),group=orderReferences.get(key);if(group)group.push(order);else orderReferences.set(key,[order]);}
  return{rows,references,logs,orderReferences,orders};
}
type RelationIndex=ReturnType<typeof relationIndex>;
function logEntry(row:Raw):RelationEntry{return{sourceSystem:row.source_system,subjectId:row.subject_id,evidence:{originalNumber:row.reference_no??null},historical:historicalObservationDisplay(row)};}
function logMatches(row:Raw,original:Raw,index:RelationIndex,access?:HistoricalRelationAccess):Match[]{
  const entry=logEntry(row),key=relationKey(row.source_system,row.subject_id,original.sourceId),matches:Match[]=[];
  if(String(original.changeType)==='1001')for(const order of index.orderReferences.get(key)??[]){const match=orderMatch(entry,original,row,order);if(match)matches.push(match);}
  for(const candidate of index.references.get(key)??[]){const match=observationMatch(entry,original,row,candidate,access);if(match)matches.push(match);}
  return[...new Map(matches.map(match=>[match.kind+'\u0000'+match.ref,match])).values()];
}
const historyLink=(row:Raw):FinanceEntry['related'][number]=>({ref:`HISTORY_EARNINGS:${row.id}`,label:text(snapshot(row).legacyLogNumber)??String(row.source_id),path:`/finance/documents/${encodeURIComponent('HISTORY_EARNINGS:'+row.id)}`});
function reverseLinks(documentRef:string,index:RelationIndex,access?:HistoricalRelationAccess):ReverseLinks{
  const result=(state:ReverseLinks['state'],reasonCodes:string[]=[]):ReverseLinks=>({state,related:[],reasonCodes});
  if(!(access?.isBoss||access?.financeDocumentRead))return result('DENIED');
  const application=documentRef.startsWith('HISTORY_WITHDRAWAL:')?index.rows.get(documentRef.slice('HISTORY_WITHDRAWAL:'.length)):undefined;
  const order=documentRef.startsWith('LEGACY_ORDER:')?index.orders.find(order=>order.ref===documentRef):undefined;
  if(!application&&!order)return result('UNRESOLVED');
  const root=application?originalSource(application):null;
  if(application&&(application.source_entity!=='la_withdraw_apply'||!root))return result('UNRESOLVED',['HISTORICAL_RELATION_EVIDENCE_UNAVAILABLE']);
  if(order&&order.objectReadable!==true)return result('DENIED');
  const key=application?relationKey(application.source_system,application.subject_id,application.source_id):relationKey(order!.sourceSystem,order!.ownerId,order!.sourceId);
  const candidates=index.logs.get(key)??[],matches:Raw[]=[];let ambiguous=false;
  for(const row of candidates){
    const original=originalSource(row);if(!original||String(original.changeType)!==(application?'1002':'1001'))continue;
    const targets=logMatches(row,original,index,access);
    if(targets.some(match=>match.ref===documentRef)){if(targets.length!==1)ambiguous=true;else matches.push(row);}
  }
  if(ambiguous||matches.length>1)return result('AMBIGUOUS',['ORIGINAL_ORDER_REFERENCE_AMBIGUOUS']);
  if(matches.length!==1)return result('UNRESOLVED',['ORIGINAL_ORDER_REFERENCE_UNRESOLVED']);
  const debit=matches[0]!,related=[historyLink(debit)];
  if(application){
    const returns=candidates.filter(row=>['1003','1004','1005'].includes(String(snapshot(row).legacyChangeType)));
    if(returns.length>1)return result('AMBIGUOUS',['ORIGINAL_ORDER_REFERENCE_AMBIGUOUS']);
    if(returns.length){
      const row=returns[0]!,original=originalSource(row),debitOriginal=originalSource(debit)!,eventAt=original?epoch(original.createdAt):null;
      // This proves an original display link only; it grants no opening admission or channel payment fact.
      if(!original||!['1003','1004'].includes(String(original.changeType))||String(root!.status)!=='4'||String(original.action)!=='1'
        ||String(original.userId)!==String(root!.userId)||money(original.amount)!==money(root!.money)||eventAt===null
        ||eventAt<epoch(debitOriginal.createdAt)!||eventAt<epoch(root!.create_time)!||Date.parse(row.at??'')!==eventAt
        ||row.reference_no&&row.reference_no!==root!.sn)return result('UNRESOLVED',['HISTORICAL_RETURN_EVENT_TIME_UNAVAILABLE']);
      related.push(historyLink(row));
    }
  }
  return{state:'MATCHED',related,reasonCodes:[]};
}

/** Exact source/party/amount/event proofs only; no query, accounting effect or mutation of supplied facts. */
export function resolveHistoricalReverseLinks(documentRef:string,sources:Raw[],orders:FinanceOrderFact[],access?:HistoricalRelationAccess):ReverseLinks{
  return reverseLinks(documentRef,relationIndex(sources,orders),access);
}

/** Enrichment only; the original entries, financial effect and source identity are never replaced. */
export function enrichHistoricalObservations(entries:FinanceEntry[],sources:Raw[],orders:FinanceOrderFact[],access?:HistoricalRelationAccess):void {
  const index=relationIndex(sources,orders),reverse=new Map<string,ReverseLinks>();
  const resolve=(ref:string)=>{let value=reverse.get(ref);if(!value){value=reverseLinks(ref,index,access);reverse.set(ref,value);}return value;};
  for(const entry of entries){
    if(!entry.historical)continue;
    const source=index.rows.get(entry.id.slice('history:'.length)),original=source?originalSource(source):null;
    if(!source||!original){entry.reasonCodes.push('HISTORICAL_RELATION_EVIDENCE_UNAVAILABLE');continue;}
    if(source.source_entity==='la_withdraw_apply'){
      const result=resolve(entry.documentRef);entry.historical.association={...emptyAssociation(result.state),...(result.state==='MATCHED'?{kind:'WITHDRAWAL' as const,documentRef:result.related[0]!.ref,number:result.related[0]!.label,path:result.related[0]!.path??null,role:'WITHDRAWER' as const}:{})};
      entry.related.push(...result.related);entry.reasonCodes.push(...result.reasonCodes);continue;
    }
    if(source.source_entity!=='la_log_earnings')continue;
    const type=entry.historical.changeType;
    if(['1003','1004','1005'].includes(type??'')){
      const candidates=index.references.get(relationKey(entry.sourceSystem,entry.subjectId,original.sourceId))??[];
      const matched=candidates.filter(candidate=>candidate.source_entity==='la_withdraw_apply').map(candidate=>({candidate,result:resolve(`HISTORY_WITHDRAWAL:${candidate.id}`)}));
      const links=matched.filter(({result})=>result.state==='MATCHED'&&result.related.some(link=>link.ref===entry.documentRef));
      if(links.length!==1){entry.historical.association=emptyAssociation(links.length>1||matched.some(({result})=>result.state==='AMBIGUOUS')?'AMBIGUOUS':matched.some(({result})=>result.state==='DENIED')?'DENIED':'UNRESOLVED');entry.reasonCodes.push('HISTORICAL_RETURN_EVENT_TIME_UNAVAILABLE');continue;}
      const candidate=links[0]!.candidate,number=text(originalSource(candidate)!.sn)!,ref=`HISTORY_WITHDRAWAL:${candidate.id}`,path=`/finance/documents/${encodeURIComponent(ref)}`;
      entry.historical.association={state:'MATCHED',kind:'WITHDRAWAL',documentRef:ref,number,path,role:'WITHDRAWER',originalStatus:'4',originalStatusLabel:withdrawalStates['4']!};entry.related.push({ref,label:number,path});continue;
    }
    if(type!=='1001'&&type!=='1002')continue;
    const unique=logMatches(source,original,index,access);
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
