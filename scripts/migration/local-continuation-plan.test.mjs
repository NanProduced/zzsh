import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertNextBusinessPopulation, buildNextContinuationRows, expectedContinuationImports, inspectUnresolvedRefundSource, NEXT_CONTINUATION_POLICY } from './local-source-adapter.mjs';

const source = (id, admission, reasons = []) => ({sourceId:id, parentSourceDigest:id.repeat(64), source:{legacyOrderId:id, admission, reasons}, admission, reasons, commissionEvidence:[], targetParentReady:true});
const rows = () => [source('1','PARAMETER_COMPLETE'), source('2','ISOLATED',['MISSING_BASE_BOT'])];
const manifest = () => ({sourceRef:'synthetic-source', files:{continuations:{rows:2}}, domains:{continuations:{source:2,parameterComplete:1,isolated:1,preparedEvidence:{policy:NEXT_CONTINUATION_POLICY,readyComplete:1,readyIsolated:1,readyUnprepared:0,unreadyEmitted:0,unreadyUnprepared:0}}}});
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
 const unready=manifest();unready.domains.continuations.preparedEvidence.readyIsolated=0;unready.domains.continuations.preparedEvidence.unreadyEmitted=1;
 assert.throws(()=>expectedContinuationImports(unready,true),/COVERAGE_UNPROVEN/);
 assert.throws(()=>plan(rows().slice(0,1)),/COUNT_MISMATCH/);
 const wrong=parents();wrong[1].sourceDigest='f'.repeat(64);assert.throws(()=>plan(rows(),manifest(),wrong),/PARENT_MISMATCH/);
 const altered=rows();altered[1].admission='PARAMETER_COMPLETE';assert.throws(()=>plan(altered),/ADMISSION_MISMATCH/);
 assert.throws(()=>plan([rows()[0],rows()[0]]),/SOURCE_DUPLICATE/);
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
