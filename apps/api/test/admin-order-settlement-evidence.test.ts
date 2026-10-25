import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {loadAdminFinanceFacts,projectAdminFinanceLedger,readAdminFinanceDocument,type FinanceFacts} from '../src/finance/admin-finance-read';
import type {FinanceOrderFact} from '../src/finance/admin-finance-order-read';
import * as dutyStore from '../src/finance/legacy-duty-finance-store';
import {planLegacyDutyFinalization,type LegacyFinanceDuty,type LegacyDutyFinalBasis,type LegacyDutyFundingProof} from '../src/finance/legacy-duty-finance';

const at='2026-10-23T00:00:00.000001Z',oldOrderId='legacy_order_'+'a'.repeat(40);
function order(legacy=false):FinanceOrderFact{return{ref:(legacy?'LEGACY_ORDER:':'ORDER:')+(legacy?oldOrderId:'order1'),id:legacy?oldOrderId:'order1',number:'ORIGINAL',sourceType:legacy?'LEGACY_MYSQL':'NATIVE',sourceSystem:legacy?'legacy_mysql_restore':'zzsh',sourceId:legacy?'101':'order1',sourceDigest:legacy?'1'.repeat(64):null,kind:'SETTLEMENT',state:legacy?'HISTORICAL_ORDER_RECORDED':'ORDER_RECORDED',occurredAt:at,importedAt:at,ownerId:'owner',renterId:'renter',accountId:'account',dueCents:'15908',recordedPaidCents:null,depositCents:'5000',originalOrderStatus:'COMPLETED',originalPaymentStatus:null,objectReadable:true,legacySource:legacy?{entity:'la_order',snapshot:{return_order_money:'82.00'},completedAt:at}:undefined};}
function entries(refund='5000',owner='9000'){
 const captured=(BigInt(refund)+BigInt(owner)+1908n).toString();
 return[['CAPTURED_PAYMENT_SOURCE','-'+captured,null],['OWNER_AVAILABLE',owner,'owner'],['RENTER_REFUND_PAYABLE',refund,'renter'],['PLATFORM_HAFF_SPREAD','1908',null]]
  .filter(([,amount])=>amount!=='0').map(([account,delta,subject],i)=>projectAdminFinanceLedger({id:'line'+i,account_code:account,delta,subject_id:subject,subject_name:subject,at,recorded_at:at,finance_event_id:'event',event_kind:'SETTLEMENT_POSTED',posting_id:'posting',source_kind:'RENTAL_SETTLEMENT',source_type:'NATIVE',source_system:'zzsh',source_entity:'settlement_posting',source_id:'posting',order_id:'order1',payment_confirmation_id:'payment',settlement_version_id:'version',version_hash:'a'.repeat(64),captured_cents:captured,owner_net_cents:owner,renter_refund_cents:refund,platform_contribution_cents:'1908',refund_due_at:at}));
}
function facts(legacy=false,lines=legacy?[]:entries()):FinanceFacts{return{entries:lines,subjects:[],revisions:[],withdrawalsReady:false,orders:[order(legacy)],asOf:at,version:'v1'};}
const evidence=(f:FinanceFacts)=>((readAdminFinanceDocument(f,f.orders![0]!.ref) as any).orderSettlement);

test('ordinary native document reuses its exact complete receipt and keeps refund payment unknown',()=>{
 const f=facts(),read=evidence(f);assert.ok(read,'ordinary order document must include authorized settlement evidence');
 assert.equal(read.schema,'admin-order-settlement-evidence.v1');assert.equal(read.posting.state,'POSTED');
 assert.deepEqual([read.captured.cents,read.ownerNet.cents,read.refundPayable.cents],['15908','9000','5000']);
 assert.equal(read.refundPayable.knowledge,'KNOWN');assert.equal(read.refunded.knowledge,'UNKNOWN');assert.equal(read.refunded.cents,null);assert.equal(read.channel.state,'UNKNOWN');
 assert.equal(read.platformContribution.knowledge,'KNOWN');assert.equal(read.platformContribution.cents,'1908');
 assert(read.reasonCodes.includes('PLATFORM_CONTRIBUTION_IS_NOT_NET_PROFIT'));
 assert.equal(f.entries.length,4);assert.equal(read.documentRef,'ORDER:order1');
});
test('native proved zero stays known while a missing receipt or contradictory header stays unknown',()=>{
 const zero=evidence(facts(false,entries('0','0')));assert.equal(zero.refundPayable.cents,'0');assert.equal(zero.ownerNet.cents,'0');assert.equal(zero.ownerNet.knowledge,'KNOWN');
 const absent=evidence(facts(false,[]));assert.equal(absent.posting.state,'NOT_POSTED');assert.equal(absent.refundPayable.cents,null);assert.equal(absent.platformContribution.cents,null);
 const f=facts();f.entries[0]!.evidence.refundPayableCents='5001';const bad=evidence(f);assert.equal(bad.posting.state,'UNKNOWN');assert.equal(bad.refundPayable.cents,null);assert.equal(bad.platformContribution.cents,null);
 const partial=facts();partial.entries=partial.entries.filter(row=>row.subjectId==='renter');assert.equal(evidence(partial).refundPayable.cents,null);assert.equal(evidence(partial).platformContribution.cents,null);
 const wrongParty=facts();wrongParty.entries.find(row=>row.accountCode==='OWNER_AVAILABLE')!.subjectId='other';assert.equal(evidence(wrongParty).ownerNet.cents,null);
});
test('object scope withholds only the new projection and leaves the existing finance document untouched',()=>{
 const f=facts();f.orders![0]!.objectReadable=false;const read=readAdminFinanceDocument(f,'ORDER:order1') as any;
 assert.equal(read.orderSettlement,undefined);assert.equal(read.entries.length,4);
});
test('legacy history remains a source observation, not captured funds or a current refund',()=>{
 const read=evidence(facts(true));assert.equal(read.historicalRefund.cents,'8200');assert.equal(read.historicalRefund.knowledge,'KNOWN');
 assert.equal(read.captured.cents,null);assert.equal(read.refundPayable.cents,null);assert.equal(read.refunded.cents,null);assert.equal(read.readiness,'UNAVAILABLE');
 assert.equal(read.platformContribution.cents,null);assert.equal(read.platformContribution.knowledge,'UNKNOWN','legacy has no verified platform component');
});

function legacyFixture(amount='8200',suffix='b',kind:LegacyFinanceDuty['kind']='RENTER_REFUND'){
 const dutyId='legacy_duty_'+suffix.repeat(40),subject=kind==='RENTER_REFUND'?'renter':'owner',hash=(v:unknown)=>createHash('sha256').update(canonicalize(v)).digest('hex');
 const duty:LegacyFinanceDuty={id:dutyId,orderId:oldOrderId,kind,sourceRecordId:'confirm-v1',counterpartyUserId:subject,amountCents:amount,currency:'CNY',revision:'2',status:'PENDING',source:'CONTINUATION',sourceStatus:null,continuationVersionId:'confirm-v1',admissionId:null,maturityAt:null,settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};
 const basis:LegacyDutyFinalBasis={kind:'CONFIRMED_CONTINUATION',dutyId,orderId:oldOrderId,dutyKind:duty.kind,sourceRecordId:duty.sourceRecordId,subjectId:subject,amountCents:amount,currency:'CNY',dutyRevision:'2',parentSourceDigest:'1'.repeat(64),parentSourceId:'101',sourceRecordEntity:'legacy_continuation_version',sourceRecordDigest:'2'.repeat(64),basisFactsDigest:'3'.repeat(64),evidenceId:'result-1',evidenceDigest:'4'.repeat(64),continuationVersionId:'confirm-v1',admissionId:null,effectiveHeadId:'release-v2',effectiveHeadRevision:'2',sourceTimeKind:'CONFIRMED_AT',sourceTime:'2026-10-01T00:00:00.000000Z',maturityAt:null,finalAmountKnown:true,netRefundKnown:true,currentNetRefundCents:amount,fundsDisposition:'AVAILABLE'};
 const empty=createHash('sha256').update('').digest('hex'),witness={openingBasisId:'opening',openingSourceDigest:'9'.repeat(64),coveredSetDigest:'0'.repeat(64),historyCoverageVersion:'history:'+empty,historyReferenceDigest:empty,historyCutoff:'2026-09-13T00:00:00.000Z',sourceCount:'0'};
 const funding:LegacyDutyFundingProof={contractVersion:'legacy-duty-finance.v1',dutyId,orderId:oldOrderId,kind:duty.kind,subjectId:subject,amountCents:amount,currency:'CNY',originalSourceSystem:'legacy_mysql_restore',originalSourceEntity:'la_order',originalSourceId:'101',originalSourceDigest:basis.parentSourceDigest,originalOrderNumber:'ORIGINAL',finalEvidenceDigest:basis.evidenceDigest,coverageDecision:'NOT_PREVIOUSLY_CREDITED',coverageEvidenceDigest:hash(witness),sourceStatus:'CONFIRMED_UNPAID_LIABILITY',evidenceRef:basis.evidenceId,witness};
 const plan=planLegacyDutyFinalization(duty,basis,funding,{dutyId,expectedRevision:'2',expectedEvidenceDigest:basis.evidenceDigest,expectedAmountCents:amount},at);
 Object.assign(duty,{revision:'3',status:'SETTLED',settledBy:'FINANCE',settledRefType:plan.ref.type,settledRefId:plan.ref.id,settledRefDigest:plan.ref.digest});
 const actual_duty={id:duty.id,order_id:duty.orderId,kind:duty.kind,source_record_id:duty.sourceRecordId,counterparty_user_id:duty.counterpartyUserId,amount_cents:duty.amountCents,currency:duty.currency,revision:duty.revision,status:duty.status,source:duty.source,source_status:duty.sourceStatus,continuation_version_id:duty.continuationVersionId,admission_id:duty.admissionId,settled_by:duty.settledBy,settled_ref_type:duty.settledRefType,settled_ref_id:duty.settledRefId,settled_ref_digest:duty.settledRefDigest};
 const row={requested_duty_id:dutyId,actual_duty,maturity:null,duty_id:dutyId,order_id:oldOrderId,kind:duty.kind,subject_user_id:subject,root_id:plan.rootId,event_id:plan.eventId,event_kind:'LEGACY_DUTY_SETTLED',event_subject:subject,root_kind:'LEGACY_CONTINUATION_DUTY',root_type:'LEGACY_CONTINUATION',root_system:'zzsh',root_entity:'legacy_order_duty',root_source:dutyId,root_subject:subject,root_role:duty.kind,root_digest:plan.factDigest,root_policy:null,basis_id:null,ref_type:plan.ref.type,ref_id:plan.ref.id,facts_canonical:plan.canonical,facts_digest:plan.factDigest,posted_at:at,zero_finalization:plan.zero,actual_lines:plan.lines.map(line=>({...line,details:{legacyDutyId:dutyId,legacyOrderId:oldOrderId,legacyOrderNumber:'ORIGINAL',factsDigest:plan.factDigest}}))};
 return{duty,row};
}
const readBatch=dutyStore.readAdminLegacyDutyFinances;
test('legacy positive and exact zero reuse the original verifier in one narrow read without locks or mutations',async()=>{
 assert.equal(typeof readBatch,'function');const positive=legacyFixture(),zero=legacyFixture('0','c'),calls:{sql:string;values:unknown[]}[]=[];
 const client={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return{rows:[positive.row,zero.row]};}};
 const read=await readBatch(client as any,{orderId:oldOrderId});assert.equal(calls.length,1);assert.deepEqual(calls[0]!.values,[oldOrderId]);assert.match(calls[0]!.sql,/d\.order_id=\$1/);assert.doesNotMatch(calls[0]!.sql,/FOR UPDATE|INSERT INTO|UPDATE |DELETE |pg_advisory|lease/i);
 assert.equal(read.get(positive.duty.id)!.amountCents,'8200');assert.equal(read.get(zero.duty.id)!.amountCents,'0');assert.equal(read.get(zero.duty.id)!.finalization,'FINALIZED_ZERO');
 const f=facts(true) as any;f.orderSettlementFacts={legacyDutyReady:true,duties:[read.get(positive.duty.id)]};const projected=evidence(f);assert.equal(projected.refundPayable.cents,'8200');assert.equal(projected.refunded.cents,null);assert.equal(projected.dutyRefs[0].documentRef,'LEGACY_DUTY:'+positive.duty.id);
});
test('legacy wrong source, missing fact, conflicting row or mismatched original batch stays unknown; SQL failures propagate',async()=>{
 assert.equal(typeof readBatch,'function');const fixture=legacyFixture(),client=(rows:unknown[])=>({query:async()=>({rows})});
 for(const rows of [[{...fixture.row,duty_id:null}],[{...fixture.row,root_source:'other'}],[{...fixture.row,facts_digest:'f'.repeat(64)}],[{...fixture.row,facts_canonical:'{}'}],[fixture.row,fixture.row],[{...fixture.row,actual_lines:[]}],[{...fixture.row,order_id:'other'}],...['revision','currency','amount_cents','settled_by','settled_ref_type'].map(field=>[{...fixture.row,actual_duty:{...fixture.row.actual_duty,[field]:({revision:'4',currency:'USD',amount_cents:'1.5',settled_by:'LEGACY_RECORDS',settled_ref_type:'FINANCE_EVENT'} as Record<string,string>)[field]}}])]){
  const read=await readBatch(client(rows) as any,{dutyId:fixture.duty.id});assert.equal(read.get(fixture.duty.id)!.knowledge,'UNKNOWN');assert.equal(read.get(fixture.duty.id)!.amountCents,null);
 }
 await assert.rejects(()=>readBatch({query:async()=>{throw new Error('SQL_DENIED');}} as any,{orderId:oldOrderId}),/SQL_DENIED/);
 assert.equal((await readBatch(client([]) as any,{orderId:oldOrderId})).size,0);
 const zero=legacyFixture('0','c');const badZero=await readBatch(client([{...zero.row,actual_lines:fixture.row.actual_lines}]) as any,{dutyId:zero.duty.id});assert.equal(badZero.get(zero.duty.id)!.knowledge,'UNKNOWN');
});
test('legacy proved owner credit and zero refund stay separate from source refund and channel payment',async()=>{
 const owner=legacyFixture('7700','d','OWNER_CREDIT'),refund=legacyFixture('0','e'),read=await readBatch({query:async()=>({rows:[owner.row,refund.row]})} as any,{orderId:oldOrderId}),f=facts(true) as any;
 f.orderSettlementFacts={legacyDutyReady:true,duties:[...read.values()]};const projected=evidence(f);assert.equal(projected.posting.state,'POSTED');assert.equal(projected.ownerNet.cents,'7700');assert.equal(projected.refundPayable.cents,'0');assert.equal(projected.refundPayable.knowledge,'KNOWN');assert.equal(projected.historicalRefund.cents,'8200');assert.equal(projected.refunded.cents,null);assert.equal(projected.refundDueAt,null);assert.equal(projected.channel.state,'UNKNOWN');
 f.orderSettlementFacts.duties=[{...read.get(owner.duty.id),kind:'DEPOSIT_COMPENSATION'}];assert.equal(evidence(f).ownerNet.knowledge,'UNKNOWN');
});
test('r1 proved zero responsibility is FINALIZED_ZERO, never POSTED, and NONE or absence does not prove zero',async()=>{
 const zero=legacyFixture('0'),read=await readBatch({query:async()=>({rows:[zero.row]})} as any,{orderId:oldOrderId}),f=facts(true) as any;
 f.orderSettlementFacts={legacyDutyReady:true,duties:[...read.values()]};const projected=evidence(f);assert.equal(projected.posting.state,'FINALIZED_ZERO');assert.equal(projected.posting.postedAt,at);assert.equal(projected.refundPayable.knowledge,'KNOWN');assert.equal(projected.refundPayable.cents,'0');assert.equal(projected.captured.cents,null);assert.equal(projected.refunded.cents,null);assert.equal(projected.channel.state,'UNKNOWN');
 f.orderSettlementFacts.duties=[{...read.get(zero.duty.id),finalization:'NONE'}];assert.equal(evidence(f).posting.state,'UNKNOWN');f.orderSettlementFacts.duties=[];assert.equal(evidence(f).posting.state,'UNKNOWN');
});
test('legacy ambiguity, source binding drift and a settled historical label do not become current responsibility',async()=>{
 const first=legacyFixture(),second=legacyFixture('5000','c'),read=await readBatch({query:async()=>({rows:[first.row,second.row]})} as any,{orderId:oldOrderId}),f=facts(true) as any;
 f.orderSettlementFacts={legacyDutyReady:true,duties:[...read.values()]};const ambiguous=evidence(f);assert.equal(ambiguous.refundPayable.knowledge,'UNKNOWN');assert.equal(ambiguous.refundPayable.cents,null);assert.equal(ambiguous.dutyRefs.length,2);
 f.orderSettlementFacts.duties=[{...read.get(first.duty.id),parentSourceDigest:'f'.repeat(64)}];const drift=evidence(f);assert.equal(drift.refundPayable.cents,null);assert.equal(drift.dutyRefs[0].documentRef,null);assert.equal(drift.historicalRefund.cents,'8200');
 const historic=await readBatch({query:async()=>({rows:[{...first.row,actual_duty:{...first.row.actual_duty,settled_by:'LEGACY_RECORDS'}}]})} as any,{orderId:oldOrderId});f.orderSettlementFacts.duties=[...historic.values()];assert.equal(evidence(f).refunded.cents,null);assert.equal(evidence(f).dutyRefs.length,1);
});

function detailReader(duty=legacyFixture(),options:{ready?:boolean;objectReadable?:boolean;direct?:boolean;invalidFact?:boolean}={}){
 const queries:{sql:string;values:unknown[]}[]=[],o=order(true),rawOrder={id:o.id,original_order_no:o.number,legacy_id:o.sourceId,source_system:o.sourceSystem,source_entity:'la_order',source_digest:o.sourceDigest,owner_user_id:o.ownerId,renter_user_id:o.renterId,account_id:o.accountId,due:o.dueCents,recorded_paid:null,deposit:o.depositCents,order_status:'4',pay_status:'1',at,imported_at:at,completed_at:at,source_snapshot:o.legacySource!.snapshot,object_readable:options.objectReadable!==false,account_readable:false};
 const ledger=options.direct?duty.row.actual_lines.map((line,i)=>({id:'duty-line-'+i,account_code:line.account,delta:(BigInt(line.credit)-BigInt(line.debit)).toString(),subject_id:line.subject,subject_name:line.subject,at,recorded_at:at,finance_event_id:duty.row.event_id,event_kind:'LEGACY_DUTY_SETTLED',source_kind:'LEGACY_CONTINUATION_DUTY',source_type:'LEGACY_CONTINUATION',source_system:'zzsh',source_entity:'legacy_order_duty',source_id:duty.duty.id,beneficiary_role:duty.duty.kind,order_id:null})):[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  queries.push({sql,values});
  if(sql.startsWith('SELECT to_regclass'))return{rows:[{ready:true,withdrawals:false,native_orders:false,legacy_orders:true,native_distribution:false,legacy_duty_finance:options.ready!==false}]};
  if(sql.includes('AS finance_version'))return{rows:[{finance_version:'v1'}]};
  if(sql.includes('clock_timestamp()'))return{rows:[{at}]};
  if(sql.includes('admin exact legacy duty complete financial facts'))return{rows:[options.invalidFact?{...duty.row,root_source:'wrong'}:duty.row]};
  if(sql.startsWith('WITH finance_scoped_rows'))return{rows:sql.includes('FROM zzsh_order.settlement_ledger_entry l')?ledger:[]};
  if(sql.startsWith('WITH finance_order_rows'))return{rows:values.some(value=>Array.isArray(value)&&value.includes(o.ref))?[rawOrder]:[]};
  if(sql.startsWith('WITH finance_reverse_candidates'))return{rows:[]};
  if(sql.startsWith('SELECT id,COALESCE(name,id)'))return{rows:[{id:'owner',name:'owner'},{id:'renter',name:'renter'}]};
  throw new Error('Unexpected SQL: '+sql.slice(0,100));
 }};
 return{client:client as any,queries,duty};
}
const relationAccess={adminId:'admin',isBoss:true,orderRead:true,financeDocumentRead:true,resourceRead:false};
test('ordinary legacy document adds one exact duty batch without duplicating its ledger or historical entries',async()=>{
 const r=detailReader(),facts=await loadAdminFinanceFacts(r.client,{documentRef:'LEGACY_ORDER:'+oldOrderId},relationAccess),detail=readAdminFinanceDocument(facts,'LEGACY_ORDER:'+oldOrderId);
 assert.equal(detail.orderSettlement!.refundPayable.cents,'8200');assert.equal(detail.entries.length,0);assert.equal(detail.document.entryCount,0);assert(detail.related.some(link=>link.ref==='LEGACY_DUTY:'+r.duty.duty.id));
 const queries=r.queries.filter(query=>query.sql.includes('admin exact legacy duty'));assert.equal(queries.length,1);assert.deepEqual(queries[0]!.values,[oldOrderId]);
});
test('r1 ordinary legacy loader exposes a verified zero finalization without claiming posting or adding ledger rows',async()=>{
 const r=detailReader(legacyFixture('0')),facts=await loadAdminFinanceFacts(r.client,{documentRef:'LEGACY_ORDER:'+oldOrderId},relationAccess),detail=readAdminFinanceDocument(facts,'LEGACY_ORDER:'+oldOrderId);
 assert.equal(detail.orderSettlement!.posting.state,'FINALIZED_ZERO');assert.equal(detail.orderSettlement!.posting.postedAt,at);assert.equal(detail.orderSettlement!.refundPayable.cents,'0');assert.equal(detail.orderSettlement!.refunded.cents,null);assert.equal(detail.entries.length,0);assert.equal(detail.document.entryCount,0);assert.equal(r.queries.filter(query=>query.sql.includes('admin exact legacy duty')).length,1);
});
test('legacy financial root closes its source-qualified old-order link only after full receipt and object proof',async()=>{
 for(const invalidFact of [false,true]){
  const r=detailReader(undefined,{direct:true,invalidFact}),ref='LEGACY_DUTY:'+r.duty.duty.id,facts=await loadAdminFinanceFacts(r.client,{documentRef:ref},relationAccess),detail=readAdminFinanceDocument(facts,ref);
  assert.equal(detail.related.some(link=>link.ref==='LEGACY_ORDER:'+oldOrderId),!invalidFact);assert.equal(detail.entries.length,2);assert.equal(r.queries.filter(query=>query.sql.includes('admin exact legacy duty')).length,1);
  if(!invalidFact)assert(r.queries.some(query=>query.sql.startsWith('WITH finance_order_rows')&&query.values.some(value=>Array.isArray(value)&&value.includes('LEGACY_ORDER:'+oldOrderId))));
 }
});
test('unreadable objects and absent old finance relation do not trigger a duty query or invent empty-known amounts',async()=>{
 const denied=detailReader(undefined,{objectReadable:false}),a=await loadAdminFinanceFacts(denied.client,{documentRef:'LEGACY_ORDER:'+oldOrderId},relationAccess);assert.equal(readAdminFinanceDocument(a,'LEGACY_ORDER:'+oldOrderId).orderSettlement,undefined);assert.equal(denied.queries.filter(query=>query.sql.includes('admin exact legacy duty')).length,0);
 const missing=detailReader(undefined,{ready:false}),b=await loadAdminFinanceFacts(missing.client,{documentRef:'LEGACY_ORDER:'+oldOrderId},relationAccess),read=readAdminFinanceDocument(b,'LEGACY_ORDER:'+oldOrderId).orderSettlement!;assert.equal(read.readiness,'UNAVAILABLE');assert.equal(read.refundPayable.cents,null);assert.equal(missing.queries.filter(query=>query.sql.includes('admin exact legacy duty')).length,0);
});
