import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertFundsWriterCoverage,assertRebuiltEmptyCoverageChunk,assertRebuiltEmptyCoverageManifest,continuationCommissionEffects,createEmptyCoverageSink,isPreparedRefundRelationshipVerified,safeLegacyWithdrawalEvidence} from './local-funds-plan.mjs';
import {isExactLegacyRefundRelationship,LEGACY_REFUND_RELATIONSHIP_POLICY} from './local-source-adapter.mjs';

test('a refund relationship needs the original order, user and nonblank matching number',()=>{
 const order={id:'o1',user_id:'u1',order_sn:'order-1'},refund={order_type:'order',order_id:'o1',user_id:'u1',order_sn:'order-1'};
 assert.equal(isExactLegacyRefundRelationship(refund,order),true);
 for(const [r,o] of [[{...refund,user_id:'u2'},order],[{...refund,order_id:'o2'},order],[{...refund,order_sn:'other'},order],
  [{...refund,order_sn:''},{...order,order_sn:''}],[{...refund,order_sn:null},{...order,order_sn:null}],[refund,null]])
  assert.equal(isExactLegacyRefundRelationship(r,o),false);
 assert.equal(isPreparedRefundRelationshipVerified({...refund,order_sn:''},{...order,order_sn:''},undefined),true);
 assert.equal(isPreparedRefundRelationshipVerified({...refund,order_sn:''},{...order,order_sn:''},LEGACY_REFUND_RELATIONSHIP_POLICY),false);
 assert.throws(()=>isPreparedRefundRelationshipVerified(refund,order,'unrecognized-policy'),/LEGACY_REFUND_RELATIONSHIP_POLICY_UNSUPPORTED/);
});

test('settled and void commission evidence never creates another pending duty',()=>{
 const commissions=['1','2','3'].map((status,i)=>({id:String(i+1),beneficiaryId:'44',level:'2',ratio:'20',status,storedEarnings:'1.00'}));
 const modules={'order/legacy-continuation-model':{legacyEconomicDutyId:(_order,_kind,id)=>'duty-'+id,legacyPlanYuanToCents:()=> '100'},
  'supply/legacy-user-migration':{legacyOwnerUserId:()=> 'user-44'}};
 const effects=continuationCommissionEffects([{body:{orderId:'order-1',sourceDigest:'digest',source:{commissions}}}],name=>modules[name]);
 assert.equal(effects.length,1);assert.equal(effects[0].sourceRecordId,'1');assert.equal(effects[0].status,'PENDING');
});

test('streamed empty coverage is checked against regenerated source, exact bytes and ordered manifest',()=>{
 const chunks=[],sink=createEmptyCoverageSink({onChunk:chunk=>chunks.push(chunk)});
 for(let i=0;i<401;i++)sink.push({sourceId:`${i}:PAY`,domain:'pays',input:{coverage:{legacyUserId:String(i),sourceKind:'PAY',sourceCount:0}}});
 const rebuilt=sink.finish().manifest,saved={...rebuilt,chunks:chunks.map(({entries,...descriptor})=>descriptor)};
 assert.equal(chunks.length,2);
 for(let i=0;i<chunks.length;i++)assert.doesNotThrow(()=>assertRebuiltEmptyCoverageChunk(saved.chunks[i],chunks[i],Buffer.from(JSON.stringify(chunks[i].entries))));
 assert.doesNotThrow(()=>assertRebuiltEmptyCoverageManifest(saved,rebuilt,2));
 const changed=structuredClone(chunks[0].entries);changed[0].input.coverage.sourceCount=1;
 assert.throws(()=>assertRebuiltEmptyCoverageChunk(saved.chunks[0],chunks[0],Buffer.from(JSON.stringify(changed))),/EMPTY_COVERAGE_REBUILT_CHUNK_DIFFERS/);
 assert.throws(()=>assertRebuiltEmptyCoverageChunk({...saved.chunks[0],rows:399},chunks[0],Buffer.from(JSON.stringify(chunks[0].entries))),/EMPTY_COVERAGE_REBUILT_CHUNK_DIFFERS/);
 assert.throws(()=>assertRebuiltEmptyCoverageManifest({...saved,chunks:[...saved.chunks].reverse()},rebuilt,2),/EMPTY_COVERAGE_REBUILT_MANIFEST_DIFFERS/);
 assert.throws(()=>assertRebuiltEmptyCoverageManifest({...saved,rows:400},rebuilt,2),/EMPTY_COVERAGE_REBUILT_MANIFEST_DIFFERS/);
 assert.throws(()=>assertRebuiltEmptyCoverageManifest(saved,rebuilt,1),/EMPTY_COVERAGE_REBUILT_MANIFEST_DIFFERS/);
});

test('legacy withdrawal destinations become non-reusable masks and immutable restricted refs, never full identities, payout credentials or URLs',()=>{
 const raw={id:'1',real_name:'张三',bank_card_no:'6222021234567890123',bank_name:'工商银行',mobile:'13812345678',account:'13812345678',money_qr_code:'https://private.example/secret',apply_remark:'PRIVATE-REMARK',pay_search_result:'PRIVATE-CHANNEL-RESPONSE',admin_id:'77'};
 const safe=safeLegacyWithdrawalEvidence(raw,'restricted-fixture:withdraw:1',JSON.stringify),encoded=JSON.stringify(safe);
 assert.deepEqual(safe.legacyDestination,{bankName:'工商银行',cardLast4:'0123',nameMasked:'张**',phoneMasked:'138****5678',accountMasked:'****5678'});assert.equal(safe.legacyOperatorId,'77');assert.equal(safe.restrictedSourceRef,'restricted-fixture:withdraw:1');assert.match(safe.restrictedSourceDigest,/^[a-f0-9]{64}$/);
 for(const value of [raw.bank_card_no,raw.real_name,raw.mobile,raw.account,raw.money_qr_code,raw.apply_remark,raw.pay_search_result])assert(!encoded.includes(value));
 assert.equal(safe.restrictedFields.transfer_voucher,undefined);assert.equal(raw.bank_card_no,'6222021234567890123');
});

test('writer admission rejects a missing row or changed source tuple even when aggregate counts still match',()=>{
 const history=[{domain:'pays',sourceId:'11:HISTORICAL_PAYMENT',input:{observations:[{sourceId:'7',kind:'paymentObservation',amount:'1.00'}]}}],guarantees=[{sourceId:'11',input:{rows:[{source:{id:'8'}}]}}];
 const plan={summary:{pays:{selected:1,planned:1,writer:0},guarantees:{selected:1,planned:1,writer:0}},history,guaranteeHistory:guarantees};
 assert.equal(assertFundsWriterCoverage(plan,history,guarantees).pays.writer,1);assert.equal(plan.summary.pays.writer,0);
 assert.throws(()=>assertFundsWriterCoverage(plan,[],guarantees),/SOURCE_SET_CHANGED/);
 const changed=structuredClone(history);changed[0].input.observations[0].sourceId='9';assert.throws(()=>assertFundsWriterCoverage(plan,changed,guarantees),/SOURCE_SET_CHANGED/);
 assert.throws(()=>assertFundsWriterCoverage({...plan,summary:{...plan.summary,pays:{selected:2,planned:1,writer:0}}},history,guarantees),/COVERAGE_MISMATCH/);
});
