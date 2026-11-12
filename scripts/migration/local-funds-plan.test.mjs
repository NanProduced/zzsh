import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {assertEmptyCoverageReceiptMode,assertFundsWriterCoverage,assertPendingCommissionCoverage,assertRebuiltEmptyCoverageChunk,assertRebuiltEmptyCoverageManifest,compareCompactCoverageEvidence,readCompactCoverageEvidence,readIndividualFinanceHistoryEvidence,continuationCommissionEffects,createEmptyCoverageSink,isPreparedRefundRelationshipVerified,safeLegacyWithdrawalEvidence} from './local-funds-plan.mjs';
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

test('pending commission coverage checks source identities and values, not only counts',()=>{
 const original={id:'1',order_id:'7',status:'1',earnings:'1.00'},source=new Map([[original.id,original]]);
 const rows=[{parentLegacyOrderId:'7',sourceRecord:{...original}}];
 assert.doesNotThrow(()=>assertPendingCommissionCoverage(rows,source));
 for(const changed of [[],[{...rows[0],parentLegacyOrderId:'8'}],[{...rows[0],sourceRecord:{...original,earnings:'2.00'}}],
  [{...rows[0],sourceRecord:{...original,id:'2'}}],[rows[0],rows[0]]])
  assert.throws(()=>assertPendingCommissionCoverage(changed,source),/FUNDS_PENDING_COMMISSION_SOURCE_SET_CHANGED/);
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

test('compact coverage readback requires the exact physical batch receipt and audit',()=>{
 const actor={userId:'fixture_admin',sessionId:'fixture_session'},batchId='history-empty-batch-'+'b'.repeat(40);
 const expected=[{batchId,fingerprint:'a'.repeat(64),body:{schema:'finance-empty-coverage-batch.v1',batchId,coverageCount:2,actor,requestId:'fixture_request',financialEffect:'NONE'}}];
 const receipt=()=>({scope_key:JSON.stringify(['admin',actor.userId,'finance.history.empty_batch.import.v1',null]),key:batchId,request_fingerprint:'a'.repeat(64),response_status:200,publish_required:false,response_body:{...expected[0].body}});
 const audit=()=>({object_id:batchId,action:'finance.history.empty_batch.imported',object_type:'personal_finance_observation_coverage_batch',actor_type:'admin',outcome:'SUCCESS',actor_id:actor.userId,session_id:actor.sessionId,request_id:'fixture_request',details:{...expected[0].body}});
 assert.deepEqual(compareCompactCoverageEvidence(expected,[receipt()],[audit()],actor),{expected:1,matched:1,differences:[]});
 for(const [receipts,audits] of [[[],[audit()]],[[receipt()],[]],[[{...receipt(),request_fingerprint:'f'.repeat(64)}],[audit()]],
  [[{...receipt(),publish_required:true}],[audit()]],[[receipt()],[{...audit(),session_id:'other'}]],[[receipt()],[audit(),audit()]]])
  assert.notDeepEqual(compareCompactCoverageEvidence(expected,receipts,audits,actor).differences,[]);
 assert.throws(()=>compareCompactCoverageEvidence([...expected,...expected],[receipt()],[audit()],actor),/COMPACT_COVERAGE_READBACK_INPUT_INVALID/);
 assert.throws(()=>compareCompactCoverageEvidence(expected,[receipt()],[audit()],{}),/COMPACT_COVERAGE_READBACK_INPUT_INVALID/);
});

test('individual history readback requires its original coverage, receipt and audit',async()=>{
 const actor={userId:'admin',sessionId:'session',requestId:'request',ref:'review',attempt:'attempt'},input={example:'source'};
 const c={id:'coverage',userId:'user',sourceKind:'HISTORICAL_WITHDRAWAL',sourceCount:1,importedCount:1,isolatedCount:0,bodyDigest:'coverage-digest',canonical:'source',inputSha256:'input-digest'},plan={coverage:c,key:'key',bodyDigest:'body-digest'};
 const body={coverageId:c.id,subjectId:c.userId,sourceKind:c.sourceKind,bodyDigest:plan.bodyDigest,importedCount:1,isolatedCount:0,financialEffect:'NONE'};
 const coverage={id:c.id,user_id:c.userId,source_kind:c.sourceKind,source_count:1,imported_count:1,isolated_count:0,body_digest:c.bodyDigest,source_canonical:c.canonical};
 const receipt={scope_key:JSON.stringify(['admin',actor.userId,'finance.history.import',null]),key:plan.key,request_fingerprint:createHash('sha256').update(JSON.stringify(['finance.history.import',c.id,input])).digest('hex'),response_status:200,response_body:body,publish_required:false};
 const audit={object_id:c.id,actor_type:'admin',actor_id:actor.userId,session_id:actor.sessionId,request_id:actor.requestId,outcome:'SUCCESS',details:{...body,coverageBodyDigest:c.bodyDigest,inputSha256:c.inputSha256,sourceCount:1,approvalRef:actor.ref,attempt:actor.attempt}};
 const query=(rows)=>async sql=>({rows:sql.includes('observation_coverage WHERE')?rows.coverage:sql.includes('idempotency_record')?rows.receipts:rows.audits});
 const groups=[{input}],getPlan=()=>plan,all={coverage:[coverage],receipts:[receipt],audits:[audit]};
 assert.deepEqual(await readIndividualFinanceHistoryEvidence(query(all),groups,actor,getPlan),{expected:1,matched:1,differences:[]});
 for(const rows of [{...all,coverage:[]},{...all,receipts:[{...receipt,request_fingerprint:'changed'}]},{...all,audits:[]},{...all,audits:[audit,audit]}])
  assert.equal((await readIndividualFinanceHistoryEvidence(query(rows),groups,actor,getPlan)).matched,0);
 await assert.rejects(readIndividualFinanceHistoryEvidence(query(all),[...groups,...groups],actor,getPlan),/FINANCE_HISTORY_READBACK_INPUT_INVALID/);
});

test('system compact coverage readback binds the system source and original receipt',async()=>{
 const actor={kind:'SYSTEM_FINANCE_MIGRATION',id:'legacy-finance-migration:'+'d'.repeat(64),sourceDatasetSha256:'c'.repeat(64)},batchId='history-empty-batch-'+'b'.repeat(40);
 const body={schema:'finance-empty-coverage-batch.system.v1',batchId,sourceDatasetSha256:actor.sourceDatasetSha256,migrationRunDigest:'d'.repeat(64),requestId:'synthetic',financialEffect:'NONE'};
 const proof={batchId,fingerprint:'a'.repeat(64),body},scope=JSON.stringify(['system',actor.id,'finance.history.empty_batch.import.v1',null]);
 const receipt={scope_key:scope,key:batchId,request_fingerprint:proof.fingerprint,response_status:200,publish_required:false,response_body:body};
 const audit={object_id:batchId,action:'finance.history.empty_batch.imported',object_type:'personal_finance_observation_coverage_batch',actor_type:'system',outcome:'SUCCESS',
  actor_id:actor.id,session_id:null,request_id:'synthetic',source_manifest:actor.sourceDatasetSha256,details:body};
 assert.deepEqual(compareCompactCoverageEvidence([proof],[receipt],[audit],actor),{expected:1,matched:1,differences:[]});
 for(const bad of [{...audit,actor_type:'admin'},{...audit,session_id:'fake'},{...audit,source_manifest:'e'.repeat(64)}])
  assert.notDeepEqual(compareCompactCoverageEvidence([proof],[receipt],[bad],actor).differences,[]);
 const query=async(sql,args)=>sql.includes('count(*)')?{rows:[{n:'1'}]}:sql.includes('idempotency_record')
  ?(assert.equal(args[0],scope),{rows:[receipt]}):{rows:[audit]};
 assert.equal((await readCompactCoverageEvidence(query,[proof],actor)).matched,1);
});

test('old and next migration checkpoints cannot silently exchange empty coverage receipt formats',()=>{
 assert.doesNotThrow(()=>assertEmptyCoverageReceiptMode({},false));
 assert.doesNotThrow(()=>assertEmptyCoverageReceiptMode({receiptMode:'BATCH_V2'},true));
 assert.doesNotThrow(()=>assertEmptyCoverageReceiptMode({receiptMode:'SYSTEM_BATCH_V1'},true));
 assert.throws(()=>assertEmptyCoverageReceiptMode({},true),/EMPTY_COVERAGE_RECEIPT_MODE_UNPROVEN/);
 assert.throws(()=>assertEmptyCoverageReceiptMode({receiptMode:'BATCH_V2'},false),/EMPTY_COVERAGE_RECEIPT_MODE_UNSUPPORTED/);
 assert.throws(()=>assertEmptyCoverageReceiptMode({receiptMode:'SYSTEM_BATCH_V1'},false),/EMPTY_COVERAGE_RECEIPT_MODE_UNSUPPORTED/);
 assert.throws(()=>assertEmptyCoverageReceiptMode({receiptMode:null},false),/EMPTY_COVERAGE_RECEIPT_MODE_UNSUPPORTED/);
 assert.throws(()=>assertEmptyCoverageReceiptMode({},undefined),/EMPTY_COVERAGE_RECEIPT_MODE_UNPROVEN/);
});

test('compact readback queries only the bound batch and reports missing evidence',async()=>{
 const actor={userId:'fixture_admin',sessionId:'fixture_session'},batchId='history-empty-batch-'+'c'.repeat(40);
 const proof={batchId,fingerprint:'a'.repeat(64),body:{schema:'finance-empty-coverage-batch.v1',batchId,actor,requestId:'fixture_request'}};
 const scope=JSON.stringify(['admin',actor.userId,'finance.history.empty_batch.import.v1',null]),calls=[];
 const query=async(sql,args)=>{calls.push(args);if(sql.includes('count(*)'))return{rows:[{n:'1'}]};if(sql.includes('idempotency_record'))return{rows:[{scope_key:scope,key:batchId,request_fingerprint:proof.fingerprint,response_status:200,publish_required:false,response_body:proof.body}]};
  return{rows:[{object_id:batchId,action:'finance.history.empty_batch.imported',object_type:'personal_finance_observation_coverage_batch',actor_type:'admin',outcome:'SUCCESS',actor_id:actor.userId,session_id:actor.sessionId,request_id:'fixture_request',details:proof.body}]};};
 assert.deepEqual(await readCompactCoverageEvidence(query,[proof],actor),{expected:1,matched:1,differences:[]});
 assert.deepEqual(calls,[[scope,[batchId]],[[batchId]],[',"finance.history.empty_batch.import.v1",null]'],[]]);
 assert.equal((await readCompactCoverageEvidence(async sql=>({rows:sql.includes('count(*)')?[{n:'0'}]:[]}),[proof],actor)).matched,0);
 assert((await readCompactCoverageEvidence(async sql=>({rows:sql.includes('count(*)')?[{n:'2'}]:[]}),[proof],actor)).differences.some(row=>row.reason==='BATCH_TOTAL_DIFFERS'));
 let callsOnBadInput=0;await assert.rejects(readCompactCoverageEvidence(async()=>{callsOnBadInput++;return{rows:[]};},[{...proof,batchId:'wrong'}],actor));
 assert.equal(callsOnBadInput,0);
});

test('compact readback keeps queries bounded and detects duplicate batch identities across pages',async()=>{
 const actor={userId:'fixture_admin',sessionId:'fixture_session'},scope=JSON.stringify(['admin',actor.userId,'finance.history.empty_batch.import.v1',null]);
 const proofs=Array.from({length:501},(_,i)=>{const batchId='history-empty-batch-'+i.toString(16).padStart(40,'0');return{batchId,fingerprint:'a'.repeat(64),body:{schema:'finance-empty-coverage-batch.v1',batchId,actor,requestId:'fixture_request'}};});
 const byId=new Map(proofs.map(proof=>[proof.batchId,proof])),sizes=[];
 const query=async(sql,args)=>{if(sql.includes('count(*)'))return{rows:[{n:'501'}]};const ids=sql.includes('idempotency_record')?args[1]:args[0];sizes.push(ids.length);
  return{rows:ids.map(id=>{const p=byId.get(id);return sql.includes('idempotency_record')?{scope_key:scope,key:id,request_fingerprint:p.fingerprint,response_status:200,publish_required:false,response_body:p.body}:
   {object_id:id,action:'finance.history.empty_batch.imported',object_type:'personal_finance_observation_coverage_batch',actor_type:'admin',outcome:'SUCCESS',actor_id:actor.userId,session_id:actor.sessionId,request_id:'fixture_request',details:p.body};})};};
 assert.equal((await readCompactCoverageEvidence(query,proofs,actor)).matched,501);assert.deepEqual(sizes,[500,500,1,1]);
 await assert.rejects(readCompactCoverageEvidence(query,[...proofs,proofs[0]],actor),/COMPACT_COVERAGE_READBACK_INPUT_INVALID/);
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
