import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { assertContinuationCommissionCoverage, assertContinuationSourceCoverage, assertLegacyLiabilitySourceCoverage, assertNextBusinessPopulation, buildNextContinuationRows, expectedContinuationImports, includeContinuationCommission, inspectUnresolvedRefundSource, NEXT_CONTINUATION_COMMISSION_POLICY, NEXT_CONTINUATION_POLICY, sourceContinuation } from './local-source-adapter.mjs';

const source = (id, admission, reasons = []) => ({sourceId:id, parentSourceDigest:id.repeat(64), source:{legacyOrderId:id, admission, reasons}, admission, reasons, commissionEvidence:[], targetParentReady:true});
const rows = () => [source('1','PARAMETER_COMPLETE'), source('2','ISOLATED',['MISSING_BASE_BOT'])];
const manifest = () => ({sourceRef:'synthetic-source', files:{continuations:{rows:2}}, domains:{continuations:{source:2,parameterComplete:1,isolated:1,unsupportedStatuses:{'2':0,'6':0,'7':0},preparedEvidence:{policy:NEXT_CONTINUATION_POLICY,commissionPolicy:NEXT_CONTINUATION_COMMISSION_POLICY,readyComplete:1,readyIsolated:1,readyUnprepared:0,unreadyEmitted:0,unreadyUnprepared:0}}}});
const parents = () => rows().map(r => ({legacyId:r.sourceId,parentOrderId:'order-'+r.sourceId,sourceDigest:r.parentSourceDigest}));
const admit = s => ({admission:s.admission,reasons:s.reasons});
const plan = (r=rows(),m=manifest(),p=parents()) => buildNextContinuationRows({manifest:m,rows:r,parents:p,sourceAsOf:'2026-11-10T00:00:00.000000Z',admit});

test('NEXT preserves ISOLATED source and binds the original parent without inventing a result',()=>{
 const r=rows(),before=structuredClone(r),result=plan(r);
 assert.equal(expectedContinuationImports(manifest(),true),2);
 assert.equal(result.length,2);assert.deepEqual(result[1].body.source,before[1].source);
 assert.deepEqual(result[1].body.commissionEvidence,[]);assert.deepEqual(r,before);
 assert(!Object.hasOwn(result[1].body,'paymentSuccess'));assert(!Object.hasOwn(result[1].body,'refund'));
});

test('old profile retains original parameter-complete count and old missing field remains accepted',()=>{
 const m={domains:{continuations:{parameterComplete:1}}};
 assert.equal(expectedContinuationImports(m,false),1);assert.throws(()=>expectedContinuationImports(m,true),/COVERAGE_UNPROVEN/);
});

test('NEXT accepts only selected business scope, while old/synthetic profiles keep their original mode',()=>{
 for(const mode of ['FULL_CAPTURED_SOURCE','SCENARIO_SELECTION','LEGACY_SCENARIO_SELECTION',null]) {
  assert.throws(()=>assertNextBusinessPopulation({mode},true),/NEXT_SELECTED_BUSINESS_SCOPE_REQUIRED/);
  assert.doesNotThrow(()=>assertNextBusinessPopulation({mode},false));
 }
 assert.doesNotThrow(()=>assertNextBusinessPopulation({mode:'SELECTED_BUSINESS_SCOPE'},true));
});

test('missing coverage, dropped rows, changed parent, admission and duplicate source fail closed',()=>{
 const m=manifest();m.domains.continuations.preparedEvidence.readyUnprepared=1;
 assert.throws(()=>expectedContinuationImports(m,true),/COVERAGE_UNPROVEN/);
 const oldCommissionPolicy=manifest();delete oldCommissionPolicy.domains.continuations.preparedEvidence.commissionPolicy;
 assert.throws(()=>expectedContinuationImports(oldCommissionPolicy,true),/COVERAGE_UNPROVEN/);
 const unready=manifest();unready.domains.continuations.preparedEvidence.readyIsolated=0;unready.domains.continuations.preparedEvidence.unreadyEmitted=1;
 assert.throws(()=>expectedContinuationImports(unready,true),/COVERAGE_UNPROVEN/);
 assert.throws(()=>plan(rows().slice(0,1)),/COUNT_MISMATCH/);
 const wrong=parents();wrong[1].sourceDigest='f'.repeat(64);assert.throws(()=>plan(rows(),manifest(),wrong),/PARENT_MISMATCH/);
 const altered=rows();altered[1].admission='PARAMETER_COMPLETE';assert.throws(()=>plan(altered),/ADMISSION_MISMATCH/);
 assert.throws(()=>plan([rows()[0],rows()[0]]),/SOURCE_DUPLICATE/);
});

test('continuation evidence preserves active and settled commissions without making deleted pending rows payable',()=>{
 const raw=(id,status,is_delete='0')=>({id,order_id:'1',order_type:'1',user_id:'44',ratio:'20',level:'2',status,earnings:'1.00',is_delete});
 const input=[raw('101','1'),raw('102','2'),raw('103','3'),raw('104','2','1'),raw('105','1','1')];
 const selected=input.filter(includeContinuationCommission);
 assert.deepEqual(selected.map(x=>x.id),['101','102','103','104']);
 assert.throws(()=>includeContinuationCommission(raw('106','1','unknown')),/DELETE_STATE_UNKNOWN/);
 const mapped=sourceContinuation({id:'1'},null,[],selected,{}),canonical=value=>JSON.stringify(value,Object.keys(value).sort());
 const proofs=selected.map(r=>{const value=canonical(r);return{sourceRecordId:r.id,canonical:value,digest:createHash('sha256').update(value).digest('hex'),evidenceRef:'source:la_distribution_order:'+r.id};});
 const continuation={sourceId:'1',source:mapped,commissionEvidence:proofs};
 assert.doesNotThrow(()=>assertContinuationCommissionCoverage([continuation],input,'source'));
 const missing=structuredClone(continuation);missing.source.commissions=missing.source.commissions.filter(r=>r.id!=='102');missing.commissionEvidence=missing.commissionEvidence.filter(r=>r.sourceRecordId!=='102');
 assert.throws(()=>assertContinuationCommissionCoverage([missing],input,'source'),/SOURCE_SET_CHANGED/);
 const changed=structuredClone(continuation);changed.source.commissions.find(r=>r.id==='102').status='1';
 assert.throws(()=>assertContinuationCommissionCoverage([changed],input,'source'),/SOURCE_FACT_CHANGED/);
 const alteredProof=structuredClone(continuation);alteredProof.commissionEvidence[0].digest='a'.repeat(64);
 assert.throws(()=>assertContinuationCommissionCoverage([alteredProof],input,'source'),/SOURCE_FACT_CHANGED/);
 assert.throws(()=>assertContinuationCommissionCoverage([continuation],[...input,input[0]],'source'),/SOURCE_DUPLICATE/);
});

test('settled original commission reaches the actual cancellation rule',()=>{
 const calc=createRequire(import.meta.url)('../../apps/api/dist/src/order/legacy-continuation-calc.js');
 const order={id:'7',order_status:'3',is_settle:'0',user_id:'11',sale_user_id:'22',pay_money:'100.00'};
 const account={id:'33'},paid=[{id:'9',order_id:'7',pay_order_sn:'P7',pay_money:'100.00'}];
 const original={id:'17',order_id:'7',order_type:'1',user_id:'44',ratio:'20',level:'2',status:'2',earnings:'1.00',is_delete:'0'};
 const input=sourceContinuation(order,account,paid,[original].filter(includeContinuationCommission),{});
 const result=calc.planLegacyContinuation(calc.admitLegacyEvidence(input),{kind:'support_cancel',caller:{role:'admin',legacyUserId:''},refundCents:'5000',ownerCents:'3000'});
 assert.equal(result.ok,false);assert.equal(result.code,'COMMISSION_ALREADY_PAID');
});

test('continuation prices, quantities, payment and policy must match the independently read source',()=>{
 const order={id:'7',accounts_id:'33',pay_is:'1',is_delete:'0',order_status:'3',is_settle:'0',user_id:'11',sale_user_id:'22',pay_money:'100.00',awm_bullet_price:'8.00',expend_haff:'12'};
 const account={id:'33',base_bot:'50',awm_bullet_price:'6.00',is_full_payout:'1'};
 const paid={id:'9',order_id:'7',order_type:'1',pay_is:'1',pay_order_sn:'P7',pay_money:'100.00'};
 const tradePolicy=[{id:'policy',type:'trade',name:'advanceOrderSetRatio',value:'70'},...Array.from({length:14},(_,i)=>({id:'p'+i,type:'expendConfig',name:'item'+i,value:String(i)}))];
 const policy={advanceOrderSetRatio:'70',expend:Object.fromEntries(tradePolicy.slice(1).map(row=>[row.name,row.value]))};
 const row={sourceId:'7',source:sourceContinuation(order,account,[paid],[],policy)};
 const sources={orders:[order],accounts:[account],pays:[paid],tradePolicy};
 assert.doesNotThrow(()=>assertContinuationSourceCoverage([row],sources));
 for(const change of [x=>{x.source.orderPrices.awm='99.00';},x=>{x.source.baseBot='42';},x=>{x.source.quantities.expendHaff='13';},
  x=>{x.source.paidPay=[];},x=>{x.source.policy.advanceOrderSetRatio='90';}]) {
  const changed=structuredClone(row);change(changed);
  assert.throws(()=>assertContinuationSourceCoverage([changed],sources),/CONTINUATION_SOURCE_FACT_CHANGED/);
 }
 assert.throws(()=>assertContinuationSourceCoverage([],sources),/ORDER_SET_CHANGED/);
 assert.throws(()=>assertContinuationSourceCoverage([row],{...sources,accounts:[]}),/ORDER_UNAVAILABLE/);
 assert.throws(()=>assertContinuationSourceCoverage([row],{...sources,tradePolicy:[...tradePolicy,tradePolicy[1]]}),/POLICY_INVALID/);
});

test('liability source closure includes multiple original refunds and rejects omitted or changed records',()=>{
 const orders=[{id:'1',pay_is:'1',order_status:'4',is_settle:'0'},{id:'2',pay_is:'1',order_status:'5',is_settle:'0',return_order_money:'5.00'}];
 const refunds=[{id:'r1',order_type:'order',order_id:'2'},{id:'r2',order_type:'order',order_id:'2'}],ready=new Set(['1','2']);
 const liabilities=[{sourceId:'1',classification:'COMPLETED_UNREFUNDED',originalOrder:orders[0],refundRecords:[],targetParentReady:true},
  {sourceId:'2',classification:'REFUND_RECORD_EXISTS',originalOrder:orders[1],refundRecords:refunds,targetParentReady:true}];
 const proof=assertLegacyLiabilitySourceCoverage(liabilities,orders,refunds,ready);
 assert.equal(proof.total,2);assert.equal(proof.byClassification.REFUND_RECORD_EXISTS,1);
 assert.throws(()=>assertLegacyLiabilitySourceCoverage(liabilities.slice(0,1),orders,refunds,ready),/LIABILITY_SOURCE_FACT_CHANGED/);
 const changed=structuredClone(liabilities);changed[1].refundRecords.pop();
 assert.throws(()=>assertLegacyLiabilitySourceCoverage(changed,orders,refunds,ready),/LIABILITY_SOURCE_FACT_CHANGED/);
 assert.throws(()=>assertLegacyLiabilitySourceCoverage(liabilities,[orders[0],{...orders[1],return_order_money:'bad'}],refunds,ready),/LIABILITY_SOURCE_AMOUNT_INVALID/);
});

test('unresolved refund source retains exact original order fields; malformed or missing evidence is never treated as absence',()=>{
 const canonical=value=>JSON.stringify(value,Object.keys(value).sort());
 const make=value=>{const original=typeof value==='string'?value:canonical(value);return {associationState:'UNRESOLVED',rawSource:{entity:'la_refund_record',canonical:original,digest:createHash('sha256').update(original).digest('hex')}};};
 assert.equal(inspectUnresolvedRefundSource(make({order_id:'123',order_sn:'ORDER-123'}),canonical),null);
 assert.equal(inspectUnresolvedRefundSource(make({order_id:'123'}),canonical),'SOURCE_ORDER_FIELDS_MISSING');
 assert.equal(inspectUnresolvedRefundSource(make({order_sn:'ORDER-123'}),canonical),'SOURCE_ORDER_FIELDS_MISSING');
 assert.equal(inspectUnresolvedRefundSource(make({order_id:'123',order_sn:''}),canonical),null);
 assert.equal(inspectUnresolvedRefundSource(make({order_id:null,order_sn:'ORDER-123'}),canonical),null);
 assert.equal(inspectUnresolvedRefundSource(make({order_id:null,order_sn:''}),canonical),'SOURCE_ORDER_IDENTIFIERS_UNUSABLE');
 assert.equal(inspectUnresolvedRefundSource(make('{bad-json'),canonical),'SOURCE_JSON_INVALID');
 const altered=make({order_id:'123',order_sn:'ORDER-123'});altered.rawSource.digest='a'.repeat(64);
 assert.equal(inspectUnresolvedRefundSource(altered,canonical),'SOURCE_DIGEST_MISMATCH');
});
