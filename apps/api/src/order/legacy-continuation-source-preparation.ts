import {canonicalize} from '../supply/content-hash';
import {fingerprintRequest,invalid,sha256Hex} from '../supply/supply-util';
import {legacyOwnerUserId} from '../supply/legacy-user-migration';
import {legacyAccountId} from '../legacy-load/legacy-account-seam';
import {initialLegacyFacts,sealLegacyFacts,assertLegacyCommissionEvidence,legacyDecimalEquals,legacyEconomicDutyId,legacyPlanYuanToCents,legacyTimeMicros,readSealedLegacyFacts,type LegacyOrderBinding,type LegacyEvidenceRow,type LegacyHeadRow,type LegacyDutyRow,type LegacyCommissionEvidence} from './legacy-continuation-model';
import type {LegacyContinuationSource,LegacyPolicy} from './legacy-continuation-calc';
import type {LegacyContinuationImport} from './legacy-continuation-evidence';
import type {LegacyInflightRegisterInput} from './legacy-liability-intake';
import {parseLegacyQuantities} from './legacy-continuation-command';

const HEX=/^[a-f0-9]{64}$/,OLD=/^[1-9]\d{0,23}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/,OP='order.legacy.continuation.import';
const POLICY_KEYS=['armor','armorSale','awm','awmSale','barrettBullet','barrettBulletSale','bullet','bulletSale','coffee','coffeeSale','experienceCard','experienceCardSale','helmet','helmetSale'];
type Row=Record<string,unknown>;
type ExtractName='members'|'parameters'|'policy'|'pendingCommissions';
/** Admission hashes come from the reviewed maintenance package, not from a caller's `complete: true`. */
export type LegacyInflightSourceReceipt={schema:'legacy-inflight-source.v1';sourceSystem:'legacy_mysql_restore';cutoff:string;evidenceRef:string;
  extracts:Record<ExtractName,{sha256:string;rows:number}>;memberSetDigest:string;pendingSetDigest:string;
  pendingScope:{entity:'la_distribution_order';status:'1';isDelete:'0';orderTypes:'ALL_SOURCE_TYPES'}};
export type LegacyInflightSourcePacket={receipt:LegacyInflightSourceReceipt;admittedReceiptDigests:readonly string[];texts:Record<ExtractName,string>};
export type LegacyInflightIdentityFact={userId:string;legacyId:string;sourceDigest:string;provider:string;providerReference:string;
  audit:{id:string;objectId:string;action:string;outcome:string;details:{sourceSystem:string;sourceEntity:string;legacyId:string;sourceDigest:string}}};
export type LegacyInflightAccountFact={accountId:string;legacyId:string;ownerUserId:string;gameId:string};
export type LegacyInflightParentFact={binding:LegacyOrderBinding;sourceSnapshot:Record<string,string|null>;sourceEvidence:LegacyEvidenceRow|null;head:LegacyHeadRow|null;duties:LegacyDutyRow[]};
export type LegacyInflightReceiptFact={principalId:string;operation:string;resourceId:string;key:string;fingerprint:string;responseStatus:number;responseBody:{evidenceId?:string;isolated?:unknown[]}};
export type LegacyInflightCurrentFacts={parents:LegacyInflightParentFact[];identities:LegacyInflightIdentityFact[];accounts:LegacyInflightAccountFact[];
  registers:{legacyId:string;source:LegacyInflightRegisterInput}[];receipts:LegacyInflightReceiptFact[]};
export type LegacyInflightCurrentPacket={receipt:{schema:'legacy-inflight-current.v1';databaseOid:number;principalId:string;observedAt:string;sourceReceiptDigest:string;factsSha256:string;scopeLegacyIds:string[]};
  admittedReceiptDigests:readonly string[];json:string};
export type LegacyInflightImportCommand={kind:'SOURCE_IMPORT';operation:typeof OP;resourceId:string;scopeKey:string;idempotencyKey:string;fingerprint:string;body:LegacyContinuationImport;recovery:'SAME_PRINCIPAL_KEY_BODY'};
export type LegacyInflightRegisterCommand={kind:'INFLIGHT_REGISTER';operation:'order.legacy.inflight.registered';resourceId:string;registerId:string;bodyDigest:string;body:LegacyInflightRegisterInput;recovery:'SAME_REGISTER_BODY'};
export type LegacyInflightPreparedSource={source:LegacyContinuationSource;commissionEvidence:LegacyCommissionEvidence[];sourceAsOf:string;evidenceRef:string;factsDigest:string;
  pendingScope:'STATUS1_UNDELETED_AT_CUTOFF';emptyPendingProven:boolean};
export type LegacyInflightPreparedRow={legacyId:string|null;orderId:string|null;group:'MAPPED'|'ISOLATED_REGISTER';state:'READY'|'REPLAY_ONLY'|'MISSING_FACT'|'CONFLICT';reasons:string[];
  prepared:LegacyInflightPreparedSource|null;command:LegacyInflightImportCommand|LegacyInflightRegisterCommand|null;
  duties:{id:string;sourceRecordId:string;beneficiaryUserId:string;amountCents:string;status:'PENDING';maturityAt:null}[]};

const fail=(code:string):never=>{throw invalid(code);};
function object(v:unknown,code='SOURCE_SCHEMA_INVALID'):Row{if(!v||typeof v!=='object'||Array.isArray(v))return fail(code);return v as Row;}
function array(v:unknown,code='SOURCE_SCHEMA_INVALID'):unknown[]{if(!Array.isArray(v))return fail(code);return v;}
function old(v:unknown):string{if(typeof v!=='string'||!OLD.test(v))return fail('SOURCE_ID_INVALID');return v;}
const hash=(v:unknown)=>sha256Hex(canonicalize(v));
const reason=(e:unknown)=>e instanceof Error&&/^[A-Z][A-Z0-9_]{2,100}$/.test(e.message)?e.message:'SOURCE_SCHEMA_INVALID';
const mappedId=(legacyId:string)=>'legacy_order_'+sha256Hex(JSON.stringify(['legacy_mysql_restore','la_order',legacyId])).slice(0,40);
function admitted(receipt:unknown,digests:readonly string[]){const digest=hash(receipt);if(!Array.isArray(digests)||!digests.includes(digest))return fail('SOURCE_RECEIPT_NOT_ADMITTED');return digest;}
function setDigest(rows:readonly unknown[],key:(r:Row)=>string){return hash(rows.map(v=>{const r=object(v);return[key(r),hash(r)];}).sort((a,b)=>a[0]!<b[0]!?-1:a[0]!>b[0]!?1:0));}
function index<T>(rows:readonly T[],key:(r:T)=>string){const result=new Map<string,T>();for(const row of rows){const k=key(row);if(result.has(k))return fail('DUPLICATE_SOURCE_KEY');result.set(k,row);}return result;}
function sourcePacket(p:LegacyInflightSourcePacket){
  const r=p.receipt,receiptDigest=admitted(r,p.admittedReceiptDigests);
  if(r.schema!=='legacy-inflight-source.v1'||r.sourceSystem!=='legacy_mysql_restore'||!r.evidenceRef||r.evidenceRef.length>400)return fail('SOURCE_RECEIPT_INVALID');
  legacyTimeMicros(r.cutoff);
  if(canonicalize(r.pendingScope)!==canonicalize({entity:'la_distribution_order',status:'1',isDelete:'0',orderTypes:'ALL_SOURCE_TYPES'}))return fail('PENDING_SCOPE_UNPROVEN');
  const parsed={} as Record<ExtractName,unknown>;
  for(const key of ['members','parameters','policy','pendingCommissions'] as const){const text=p.texts[key],e=r.extracts[key];if(typeof text!=='string'||!e||!HEX.test(e.sha256)||sha256Hex(text)!==e.sha256)return fail('SOURCE_EXTRACT_SHA_MISMATCH');
    parsed[key]=key==='parameters'?text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)):JSON.parse(text);
    const count=key==='policy'?1:array(parsed[key]).length;if(!Number.isSafeInteger(e.rows)||e.rows<0||count!==e.rows)return fail('SOURCE_EXTRACT_INCOMPLETE');}
  const members=array(parsed.members),parameters=array(parsed.parameters),pending=array(parsed.pendingCommissions),policy=object(parsed.policy) as LegacyPolicy;
  if(!policy.expend||POLICY_KEYS.some(key=>typeof policy.expend[key]!=='string'))return fail('SOURCE_POLICY_INCOMPLETE');
  if(setDigest(members,m=>old(object(m.source).id))!==r.memberSetDigest||setDigest(pending,c=>old(c.id))!==r.pendingSetDigest)return fail('SOURCE_SET_DIGEST_MISMATCH');
  const memberMap=index(members.map(v=>object(v)),m=>old(object(m.source).id)),parameterMap=index(parameters.map(v=>object(v)),s=>old(s.legacyOrderId));
  for(const m of memberMap.values())if(!Object.hasOwn(m,'target')||m.target!==null&&(!m.target||typeof m.target!=='object'||Array.isArray(m.target)))return fail('MEMBER_TARGET_CLASSIFICATION_MISSING');
  const payCounts=new Map<string,number>();for(const m of memberMap.values())if(Array.isArray(m.paidPayOrders))for(const v of m.paidPayOrders){const id=(v as Row)?.id;if(typeof id==='string')payCounts.set(id,(payCounts.get(id)??0)+1);}
  if(memberMap.size!==parameterMap.size||[...memberMap.keys()].some(k=>!parameterMap.has(k)))return fail('PARAMETER_MEMBER_SET_MISMATCH');
  const pendingMap=index(pending.map(v=>object(v)),c=>old(c.id));
  for(const c of pendingMap.values()){old(c.order_id);old(c.user_id);if(c.status!=='1'||c.is_delete!=='0'||typeof c.order_type!=='string'||!['1','2'].includes(c.order_type))return fail('PENDING_SOURCE_TYPE_OR_STATUS_MISMATCH');
    for(const key of ['create_time','update_time'])if(typeof c[key]!=='string'||!/^\d{1,10}$/.test(c[key] as string)||BigInt(c[key] as string)*1000000n>legacyTimeMicros(r.cutoff))return fail('PENDING_SOURCE_TIME_UNPROVEN');}
  return{r,receiptDigest,members:memberMap,parameters:parameterMap,pending:[...pendingMap.values()],policy,duplicatePayIds:new Set([...payCounts].filter(([,n])=>n>1).map(([id])=>id))};
}
function currentPacket(p:LegacyInflightCurrentPacket|null,sourceDigest:string,databaseOid:number,principalId:string|null,members:ReadonlyMap<string,Row>){
  if(!p)return null;
  admitted(p.receipt,p.admittedReceiptDigests);const r=p.receipt;legacyTimeMicros(r.observedAt);
  if(r.schema!=='legacy-inflight-current.v1'||r.databaseOid!==databaseOid||typeof principalId!=='string'||r.principalId!==principalId||r.sourceReceiptDigest!==sourceDigest||sha256Hex(p.json)!==r.factsSha256)return fail('CURRENT_READ_BINDING_MISMATCH');
  const scope=new Set(r.scopeLegacyIds);if(scope.size!==r.scopeLegacyIds.length||[...scope].some(k=>!members.has(k)))return fail('CURRENT_READ_SCOPE_MISMATCH');
  const facts=object(JSON.parse(p.json)) as unknown as LegacyInflightCurrentFacts;
  for(const k of ['parents','identities','accounts','registers','receipts'] as const)array(facts[k],'CURRENT_READ_INCOMPLETE');
  const parents=index(facts.parents,p=>old(p.binding.legacyId)),identities=index(facts.identities,i=>old(i.legacyId)),accounts=index(facts.accounts,a=>old(a.legacyId)),registers=index(facts.registers,r=>old(r.legacyId));
  if([...parents.keys(),...registers.keys()].some(k=>!scope.has(k)))return fail('CURRENT_READ_SCOPE_MISMATCH');
  return{r,facts,scope,parents,identities,accounts,registers};
}
function identity(f:LegacyInflightIdentityFact|undefined,legacyId:string,userId:string,sourceDigest?:string){
  if(!f)return fail('PARTY_IDENTITY_UNREAD');
  const a=f.audit;if(f.legacyId!==legacyId||f.userId!==userId||userId!==legacyOwnerUserId('legacy_mysql_restore','la_user',legacyId)||f.provider!=='legacy_mysql_restore'||f.providerReference!=='la_user:'+legacyId||!HEX.test(f.sourceDigest)||sourceDigest!==undefined&&f.sourceDigest!==sourceDigest
    ||!a||!a.id||a.objectId!==userId||a.action!=='user.legacy_owner.migrated'||a.outcome!=='SUCCESS'||a.details?.sourceSystem!=='legacy_mysql_restore'||a.details.sourceEntity!=='la_user'||a.details.legacyId!==legacyId||a.details.sourceDigest!==f.sourceDigest)return fail('PARTY_IDENTITY_SOURCE_MISMATCH');
}
function account(f:LegacyInflightAccountFact|undefined,source:LegacyContinuationSource,ownerUserId:string,gameId?:string){
  if(!f)return fail('ACCOUNT_BINDING_UNREAD');
  if(f.legacyId!==source.accountId||f.accountId!==legacyAccountId('legacy_mysql_restore','la_rental_accounts',f.legacyId)||f.ownerUserId!==ownerUserId||!ID.test(f.gameId)||gameId!==undefined&&f.gameId!==gameId)return fail('ACCOUNT_BINDING_MISMATCH');return f;
}
function prepareSource(raw:Row,member:Row,pending:readonly Row[],policy:LegacyPolicy,cutoff:string,evidenceRef:string):LegacyInflightPreparedSource{
  const o=object(member.source),snapshot=object(member.originalOrderSnapshot),id=old(o.id);
  const pairs={legacyOrderId:'id',orderStatus:'order_status',isSettle:'is_settle',renterId:'user_id',ownerId:'sale_user_id',accountId:'accounts_id',profitDot:'profit_dot',payMoney:'pay_money',storedCommissionMoney:'commission_money',depositAmount:'deposit_amount',detainMoney:'detain_money',returnOrderMoney:'return_order_money',saleEarnings:'sale_earnings',fullPayoutMoney:'full_payout_money',isAdvanceSet:'is_advance_set'};
  if(Object.entries(pairs).some(([a,b])=>raw[a]!==o[b])||raw.goodsMoney!==snapshot.goods_money||raw.baseBot!==member.baseBot||o.pay_is!=='1'||!['3','8','9'].includes(String(o.order_status)))return fail('PARAMETER_PARENT_SOURCE_MISMATCH');
  const pays=array(raw.paidPay),originalPays=array(member.paidPayOrders);if(pays.length!==1||originalPays.length!==1)return fail('PAY_SOURCE_COVERAGE_MISMATCH');
  const pay=object(pays[0]),originalPay=object(originalPays[0]);if(originalPay.order_id!==id||originalPay.order_type!=='1'||originalPay.pay_is!=='1'||pay.id!==originalPay.id||pay.payOrderSn!==originalPay.pay_order_sn||pay.orderId!==undefined&&pay.orderId!==id||typeof pay.payMoney!=='string'||typeof originalPay.pay_money!=='string'||!legacyDecimalEquals(pay.payMoney,originalPay.pay_money))return fail('PAY_SOURCE_BINDING_MISMATCH');
  if(Object.hasOwn(raw,'policy')&&canonicalize(raw.policy)!==canonicalize(policy))return fail('PARAMETER_POLICY_MISMATCH');
  const original=pending.filter(c=>c.order_type==='1'&&c.order_id===id).sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0),provided=raw.commissions;
  if(provided===null&&original.length)return fail('PENDING_COMMISSION_COVERAGE_MISMATCH');
  if(provided!==null&&!Array.isArray(provided))return fail('COMMISSION_SOURCE_SCHEMA_INVALID');
  const supplied=provided===null?[]:provided as unknown[];
  const byId=index(supplied.map(v=>object(v)),c=>old(c.id));if(byId.size!==original.length||original.some(c=>!byId.has(old(c.id))))return fail('PENDING_COMMISSION_COVERAGE_MISMATCH');
  const commissions=original.map(c=>({id:old(c.id),beneficiaryId:old(c.user_id),ratio:c.ratio as string,level:String(c.level),status:'1',storedEarnings:c.earnings as string}));
  const proofs=original.map(c=>{const canonical=canonicalize(c);return{sourceRecordId:old(c.id),canonical,digest:sha256Hex(canonical),evidenceRef:evidenceRef+':la_distribution_order:'+c.id};});
  for(let i=0;i<commissions.length;i++){const c=commissions[i]!,proof=proofs[i]!;assertLegacyCommissionEvidence(proof,id,byId.get(c.id) as unknown as LegacyContinuationSource['commissions'][number]);assertLegacyCommissionEvidence(proof,id,c);if(!['2','3'].includes(c.level))return fail('COMMISSION_UNPROVEN');legacyPlanYuanToCents(c.storedEarnings);}
  const source={...raw,quantities:parseLegacyQuantities(raw.quantities),policy:structuredClone(policy),commissions} as unknown as LegacyContinuationSource;
  const facts=initialLegacyFacts(source,proofs);if(facts.evidence.admission!=='PARAMETER_COMPLETE')return fail(facts.evidence.reasons[0]??'EVIDENCE_ISOLATED');
  return{source,commissionEvidence:proofs,sourceAsOf:cutoff,evidenceRef:evidenceRef+':la_order:'+id,factsDigest:sealLegacyFacts(facts).digest,pendingScope:'STATUS1_UNDELETED_AT_CUTOFF',emptyPendingProven:original.length===0};
}
function parent(p:LegacyInflightParentFact|undefined,prepared:LegacyInflightPreparedSource,member:Row,current:NonNullable<ReturnType<typeof currentPacket>>){
  if(!p)return fail('CURRENT_PARENT_TARGET_MISSING');const b=p.binding,s=prepared.source,snap=p.sourceSnapshot;
  if(b.id!==mappedId(s.legacyOrderId)||b.legacyId!==s.legacyOrderId||b.legacyAccountId!==s.accountId||b.legacyOwnerId!==s.ownerId||b.legacyRenterId!==s.renterId||b.sourceOrderStatus!==Number(s.orderStatus)||b.sourcePayStatus!==1||b.paidCents!==legacyPlanYuanToCents(s.payMoney!)||!HEX.test(b.sourceDigest)||hash(snap)!==b.sourceDigest||hash(snap)!==hash(member.originalOrderSnapshot))return fail('CURRENT_PARENT_BINDING_MISMATCH');
  const fields={id:s.legacyOrderId,user_id:s.renterId,sale_user_id:s.ownerId,accounts_id:s.accountId,order_status:s.orderStatus,pay_is:'1'};if(Object.entries(fields).some(([k,v])=>snap[k]!==v)||typeof snap.pay_money!=='string'||!legacyDecimalEquals(snap.pay_money,s.payMoney))return fail('CURRENT_PARENT_SOURCE_MISMATCH');
  identity(current.identities.get(b.legacyOwnerId),b.legacyOwnerId,b.ownerUserId,b.ownerSourceDigest);identity(current.identities.get(b.legacyRenterId),b.legacyRenterId,b.renterUserId,b.renterSourceDigest);
  const a=account(current.accounts.get(b.legacyAccountId),s,b.ownerUserId,b.gameId);if(a.accountId!==b.accountId)return fail('ACCOUNT_BINDING_MISMATCH');return b;
}
function existingImport(p:LegacyInflightParentFact,command:LegacyInflightImportCommand,duties:LegacyInflightPreparedRow['duties'],receipts:readonly LegacyInflightReceiptFact[],principalId:string){
  const related=receipts.filter(r=>r.operation===OP&&r.resourceId===command.resourceId),rows=related.filter(r=>r.key===command.idempotencyKey);
  if(related.some(r=>r.principalId!==principalId)||related.length!==rows.length)return fail('IMPORT_RECEIPT_SOURCE_CONFLICT');
  if(rows.length>1||rows.some(r=>r.principalId!==principalId||r.fingerprint!==command.fingerprint||r.responseStatus!==200))return fail('IMPORT_RECEIPT_CONFLICT');
  if(!p.sourceEvidence){if(p.head||p.duties.length||rows.length)return fail('EVIDENCE_RELATION');return 'READY' as const;}
  const e=p.sourceEvidence;if(e.sourceKind!=='SOURCE_IMPORT'||e.orderId!==command.resourceId||e.sourceDigest!==command.body.sourceDigest||sealLegacyFacts(readSealedLegacyFacts(e)).digest!==sealLegacyFacts(initialLegacyFacts(command.body.source,command.body.commissionEvidence)).digest)return fail('SOURCE_EVIDENCE_CONFLICT');
  if(rows.length!==1||rows[0]!.responseBody.evidenceId!==e.id)return fail('ORIGINAL_IMPORT_RECEIPT_MISSING');
  if(rows[0]!.responseBody.isolated?.length)return fail('ORIGINAL_IMPORT_INCOMPLETE');
  if(!p.head&&p.duties.length!==duties.length)return fail('ORIGINAL_IMPORT_DUTY_CONFLICT');
  for(const d of duties){const found=p.duties.filter(x=>x.id===d.id||x.kind==='COMMISSION'&&x.sourceRecordId===d.sourceRecordId),source=command.body.source.commissions.find(c=>c.id===d.sourceRecordId)!;
    if(found.length!==1)return fail('ORIGINAL_IMPORT_DUTY_MISSING');const actual=found[0]!;if(actual.orderId!==command.resourceId||actual.kind!=='COMMISSION'||actual.id!==d.id||actual.sourceRecordId!==d.sourceRecordId||actual.currency!=='CNY'||actual.counterpartyUserId!==d.beneficiaryUserId||actual.level!==source.level||!legacyDecimalEquals(actual.ratio,source.ratio))return fail('DUTY_SOURCE_BINDING_MISMATCH');
    if(!p.head&&(actual.status!=='PENDING'||actual.amountCents!==d.amountCents||actual.maturityAt!==null||actual.settledBy!==null))return fail('DUTY_REVISION_CONFLICT');}
  return 'REPLAY_ONLY' as const;
}

/** Pure preparation only. Root still owns source admission, fresh transaction authorization and each actual write window. */
export function assembleLegacyContinuationBatch(input:{batchId:string;targetDatabaseOid:number;principalId:string|null;source:LegacyInflightSourcePacket;current:LegacyInflightCurrentPacket|null}){
  if(typeof input.batchId!=='string'||!input.batchId||input.batchId.length>128||!Number.isSafeInteger(input.targetDatabaseOid)||input.targetDatabaseOid<=0||input.principalId!==null&&(typeof input.principalId!=='string'||!ID.test(input.principalId)))return fail('BATCH_BINDING_INVALID');
  const s=sourcePacket(input.source),cur=currentPacket(input.current,s.receiptDigest,input.targetDatabaseOid,input.principalId,s.members);
  const rows:LegacyInflightPreparedRow[]=[];
  for(const [id,member]of [...s.members].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    const isolated=member.target===null,base:LegacyInflightPreparedRow={legacyId:id,orderId:isolated?null:mappedId(id),group:isolated?'ISOLATED_REGISTER':'MAPPED',state:'MISSING_FACT',reasons:[],prepared:null,command:null,duties:[]};
    try{
      const raw=s.parameters.get(id)!;
      if(isolated){
        const source=object(member.source),snapshot=object(member.originalOrderSnapshot);if(source.pay_is!=='1'||!['3','8','9'].includes(String(source.order_status))||member.renterTarget!==null||object(member.quarantine).reason!=='PARTY_MOBILE_DUPLICATE'||['id','accounts_id','sale_user_id','user_id','order_status','pay_is'].some(k=>source[k]!==snapshot[k]))return fail('ISOLATED_PARENT_SOURCE_INVALID');
        if(!cur||!cur.scope.has(id))throw invalid('CURRENT_TARGET_UNREAD');
        const owner=legacyOwnerUserId('legacy_mysql_restore','la_user',old(source.sale_user_id));identity(cur.identities.get(old(source.sale_user_id)),old(source.sale_user_id),owner);
        const a=account(cur.accounts.get(old(source.accounts_id)),{accountId:old(source.accounts_id)} as LegacyContinuationSource,owner);
        if(a.accountId!==member.accountTarget||owner!==member.ownerTarget)return fail('ISOLATED_PARENT_MAPPING_MISMATCH');
        const digest=hash(object(member.originalOrderSnapshot)),body:LegacyInflightRegisterInput={legacyId:id,accountId:a.accountId,ownerUserId:owner,renterUserId:null,sourceOrderStatus:Number(source.order_status),sourcePayStatus:1,sourceDigest:digest,evidenceRef:s.r.evidenceRef+':isolated:'+id,disposition:'ISOLATED_PARTY',reason:'PARTY_MOBILE_DUPLICATE'};
        const prior=cur.registers.get(id);if(prior&&canonicalize(prior.source)!==canonicalize(body))return fail('INFLIGHT_SOURCE_CONFLICT');
        base.command={kind:'INFLIGHT_REGISTER',operation:'order.legacy.inflight.registered',resourceId:a.accountId,registerId:'legacy_inflight_'+sha256Hex(mappedId(id)).slice(0,40),bodyDigest:hash(body),body,recovery:'SAME_REGISTER_BODY'};base.state=prior?'REPLAY_ONLY':'READY';
      }else{
        if(array(member.paidPayOrders).some(p=>s.duplicatePayIds.has(String(object(p).id))))return fail('PAY_SOURCE_KEY_CONFLICT');
        base.prepared=prepareSource(raw,member,s.pending,s.policy,s.r.cutoff,s.r.evidenceRef);
        if(!cur||!cur.scope.has(id))throw invalid('CURRENT_TARGET_UNREAD');
        const p=cur.parents.get(id),b=parent(p,base.prepared,member,cur),body:LegacyContinuationImport={orderId:b.id,sourceDigest:b.sourceDigest,sourceAsOf:base.prepared.sourceAsOf,evidenceRef:base.prepared.evidenceRef,source:base.prepared.source,commissionEvidence:base.prepared.commissionEvidence};
        for(const c of body.source.commissions){const userId=legacyOwnerUserId('legacy_mysql_restore','la_user',c.beneficiaryId);identity(cur.identities.get(c.beneficiaryId),c.beneficiaryId,userId);base.duties.push({id:legacyEconomicDutyId(b.id,'COMMISSION',c.id),sourceRecordId:c.id,beneficiaryUserId:userId,amountCents:legacyPlanYuanToCents(c.storedEarnings),status:'PENDING',maturityAt:null});}
        const command:LegacyInflightImportCommand={kind:'SOURCE_IMPORT',operation:OP,resourceId:b.id,scopeKey:JSON.stringify(['admin',cur.r.principalId,OP,b.id]),idempotencyKey:sha256Hex(JSON.stringify([b.id,base.prepared.factsDigest])),fingerprint:fingerprintRequest(OP,b.id,body),body,recovery:'SAME_PRINCIPAL_KEY_BODY'};
        base.state=existingImport(p!,command,base.duties,cur.facts.receipts,cur.r.principalId);base.command=command;
      }
    }catch(e){const code=reason(e);base.reasons=[code];base.command=null;base.duties=[];base.state=/UNREAD|MISSING|INCOMPLETE/.test(code)?'MISSING_FACT':'CONFLICT';}
    rows.push(base);
  }
  const counts={READY:0,REPLAY_ONLY:0,MISSING_FACT:0,CONFLICT:0},missing:Record<string,number>={};for(const r of rows){counts[r.state]++;for(const code of r.reasons)missing[code]=(missing[code]??0)+1;}
  const commissionParents=rows.filter(r=>r.prepared?.source.commissions.length),commissionRows=commissionParents.flatMap(r=>r.prepared!.source.commissions);
  return{schema:'legacy-inflight-preparation.v1' as const,batchId:input.batchId,writeAllowed:false as const,sourceReceiptDigest:s.receiptDigest,inputDigest:hash({batchId:input.batchId,databaseOid:input.targetDatabaseOid,principalId:input.principalId,sourceReceiptDigest:s.receiptDigest,current:input.current}),rows,counts,missing,
    denominators:{parents:rows.length,mapped:rows.filter(r=>r.group==='MAPPED').length,isolated:rows.filter(r=>r.group==='ISOLATED_REGISTER').length,prepared:rows.filter(r=>r.prepared).length,pendingCommissionParents:commissionParents.length,pendingCommissions:commissionRows.length,pendingBeneficiaries:new Set(commissionRows.map(c=>c.beneficiaryId)).size,provenEmptyPendingParents:rows.filter(r=>r.prepared?.emptyPendingProven).length},
    conserved:rows.length===s.members.size&&Object.values(counts).reduce((n,x)=>n+x,0)===s.members.size,commissionScope:'ONLY_STATUS1_UNDELETED_AT_CUTOFF_NO_ASSERTION_ABOUT_STATUS2_OR3' as const};
}
