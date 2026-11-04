import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {earningsPage,earningsDetail,readEarnings,readEarningDetail,commissionRecord,commissionRecordSummary,commissionRecordMoney} from '../src/lib/distribution-earnings-client.ts';
const at='2026-10-04T00:00:00.000000Z',base={contractVersion:'distribution-earnings.read.v1',subjectId:'self',snapshotVersion:'source-v1',asOf:at};
export const old={id:'history:old',origin:'LEGACY_MYSQL',state:'SETTLED',role:'RENTER_REFERRAL',amount:{currency:'CNY',unit:'cent',amountCents:'1234'},occurredAt:at,dueAt:null,dueAtKnowledge:'UNKNOWN',fundsDisposition:'HISTORICAL_STATUS_ONLY',recoveryRequiredCents:null,includedInOpening:true,version:null,accountingEffect:'OBSERVATION_ONLY_NO_NEW_CREDIT',businessReference:{type:'LEGACY_UNRESOLVED',id:'legacy'},channelArrivalKnowledge:'UNKNOWN'};
const page={...base,state:'ALL',knowledge:'UNKNOWN',count:null,mappedRecordCount:'1',reason:'HISTORICAL_EARNINGS_COVERAGE_NOT_CLOSED',totalAmountKnowledge:'UNKNOWN',items:[old],nextCursor:null};

test('U04 frozen calculation disclosure is preserved while private base, parties and payload are stripped',()=>{
 const native={...old,id:'native:new',origin:'NATIVE',state:'SETTLED',fundsDisposition:'SETTLED',dueAt:at,dueAtKnowledge:'KNOWN',version:'2',includedInOpening:false,accountingEffect:'EXISTING_LEDGER_EVENT',businessReference:{type:'RENTAL_ORDER',id:'order'},
  calculation:{knowledge:'KNOWN',policyVersion:'frozen-policy',beneficiaryLevelCode:'LEVEL_A',percent:'5',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'LOCAL_CONTROLLED',orderNumber:null,platformContributionCents:'PRIVATE_BASE',compensationFeeCents:'PRIVATE_FEE',partyUserId:'PRIVATE_PARTY',payload:{private:'PRIVATE_RAW'}}};
 const r=earningsDetail({...base,projectionVersion:2,item:native},'self',native.id);
 assert.equal(r.item.calculation.percent,'5');assert.equal(r.item.calculation.policyVersion,'frozen-policy');assert.equal(r.item.calculation.orderNumber,null);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_BASE|PRIVATE_FEE|PRIVATE_PARTY|PRIVATE_RAW/);
 const v3=earningsDetail({...base,projectionVersion:2,item:{...native,calculation:{...native.calculation,basis:'LEGACY_RENTAL_CAPTURE_MINUS_OWNER_AND_REFUND',beneficiaryLevelCode:'legacy_2',beneficiaryLevelName:'白银会员',percent:'30'}}},'self',native.id);
 assert.equal(v3.item.calculation.beneficiaryLevelName,'白银会员');
 assert.equal(v3.item.calculation.basis,'LEGACY_RENTAL_CAPTURE_MINUS_OWNER_AND_REFUND');
 assert.doesNotMatch(JSON.stringify(v3),/PRIVATE_BASE|PRIVATE_FEE|PRIVATE_PARTY|PRIVATE_RAW/);
 const history=earningsDetail({...base,projectionVersion:2,item:{...old,calculation:{knowledge:'NOT_RECORDED',reason:'HISTORICAL_CALCULATION_NOT_RECORDED'}}},'self',old.id);
 const recorded=earningsDetail({...base,projectionVersion:2,item:{...old,calculation:{knowledge:'RECORDED_SOURCE',percent:'20.00',levelId:'3',baseCents:'PRIVATE_BASE'}}},'self',old.id);
 assert.deepEqual(recorded.item.calculation,{knowledge:'RECORDED_SOURCE',percent:'20.00',levelId:'3'});
 assert.equal(history.item.calculation.knowledge,'NOT_RECORDED');
});
test('history remains an observation and source fields are stripped by the shared DTO',()=>{const r=earningsPage({...page,privateSource:'secret',items:[{...old,sourceDigest:'secret',phone:'secret'}]},'self','ALL');assert.equal(r.count,null);assert.equal(r.items[0].includedInOpening,true);assert.equal(r.items[0].dueAt,null);assert(!JSON.stringify(r).includes('secret'));});
test('mismatched subject, source state, date knowledge, money unit and false channel arrival reject',()=>{assert.throws(()=>earningsPage({...page,subjectId:'other'},'self','ALL'),e=>e.status===401);for(const patch of [{state:'REVOKED'},{dueAt:at,dueAtKnowledge:'KNOWN'},{channelArrivalKnowledge:'KNOWN'},{accountingEffect:'NEW_CREDIT'},{amount:{currency:'CNY',unit:'yuan',amountCents:'1234'}}])assert.throws(()=>earningsPage({...page,items:[{...old,...patch}]},'self','ALL'));assert.throws(()=>earningsDetail({...base,item:old},'self','history:another'));});
test('native recovery keeps settled funds and exact original debt; a false zero debt rejects',()=>{const native={...old,id:'native:new',origin:'NATIVE',state:'RECOVERY_REQUIRED',fundsDisposition:'SETTLED',dueAt:at,dueAtKnowledge:'KNOWN',recoveryRequiredCents:'1234',version:'3',includedInOpening:false,accountingEffect:'EXISTING_LEDGER_EVENT',businessReference:{type:'RENTAL_ORDER',id:'order'}};assert.equal(earningsDetail({...base,item:native},'self',native.id).item.recoveryRequiredCents,'1234');assert.throws(()=>earningsDetail({...base,item:{...native,recoveryRequiredCents:'0'}},'self',native.id));});
test('client explicitly GETs projection 2 for both self list/detail, rejects downgrade and preserves 401',async()=>{const previous=globalThis.fetch,requests=[],amountsByOrigin={scope:'SOURCE_RECORDS_ONLY',native:{knowledge:'UNKNOWN',amountCents:null},historical:{knowledge:'UNKNOWN',amountCents:null},mappedHistoricalAmountCents:'1234'};globalThis.fetch=async(url,options)=>{requests.push({url:String(url),options});return Response.json(String(url).includes('/history%3Aold')?{...base,projectionVersion:2,item:old}:{...page,projectionVersion:2,amountsByOrigin});};try{await readEarnings('self','ALL');await readEarningDetail('self','history:old');assert(requests.every(r=>r.options.method===undefined&&r.options.credentials==='same-origin'&&new URL(r.url,'http://fixture.invalid').searchParams.get('projectionVersion')==='2'));globalThis.fetch=async()=>Response.json(page);await assert.rejects(readEarnings('self','ALL'),e=>e.status===502);globalThis.fetch=async()=>Response.json({error:{code:'UNAUTHENTICATED'}},{status:401});await assert.rejects(readEarnings('self','ALL'),e=>e.status===401);}finally{globalThis.fetch=previous;}});
test('exact per-origin amounts require their own coverage; old responses retain UNKNOWN and cannot claim a wallet total',()=>{
 const amountsByOrigin={scope:'SOURCE_RECORDS_ONLY',native:{knowledge:'KNOWN',amountCents:'999999999999999999999999'},historical:{knowledge:'KNOWN',amountCents:'1234'},mappedHistoricalAmountCents:'1234'},known={...page,projectionVersion:2,knowledge:'KNOWN',count:'1',reason:null,totalAmountKnowledge:'KNOWN',amountsByOrigin};
 const r=earningsPage(known,'self','ALL');assert.equal(r.amountsByOrigin.native.amountCents,amountsByOrigin.native.amountCents);assert.equal(r.amountsByOrigin.historical.amountCents,'1234');assert.equal(earningsPage(page,'self','ALL').amountsByOrigin,undefined);assert.equal('currentFinance' in earningsPage(page,'self','ALL').items[0],false);
 for(const patch of [{scope:'WALLET_AVAILABLE'},{historical:{knowledge:'UNKNOWN',amountCents:null}},{historical:{knowledge:'KNOWN',amountCents:'0'}},{native:{knowledge:'KNOWN',amountCents:1.1}}])assert.throws(()=>earningsPage({...known,amountsByOrigin:{...amountsByOrigin,...patch}},'self','ALL'));
 assert.throws(()=>earningsPage({...known,amountsByOrigin:undefined},'self','ALL'));
});
test('legacy new financial finalization remains separate from original status/amount and requires a full typed positive or zero reference',()=>{
 const currentFinance={knowledge:'KNOWN',state:'SETTLED',amountCents:'0',zeroFinalization:true,reference:{type:'FINANCE_EVENT',id:'final-zero',digest:'a'.repeat(64)}},r=earningsDetail({...base,projectionVersion:2,item:{...old,state:'PENDING',currentFinance}},'self',old.id).item;assert.equal(r.state,'PENDING');assert.equal(r.amount.amountCents,'1234');assert.equal(r.currentFinance.amountCents,'0');assert.equal(r.currentFinance.zeroFinalization,true);
 for(const patch of [{zeroFinalization:false},{reference:{...currentFinance.reference,type:'LEDGER_ENTRY'}},{reference:{...currentFinance.reference,digest:'broken'}}])assert.throws(()=>earningsDetail({...base,projectionVersion:2,item:{...old,currentFinance:{...currentFinance,...patch}}},'self',old.id));
 assert.equal(earningsDetail({...base,projectionVersion:2,item:old},'self',old.id).item.currentFinance.knowledge,'UNKNOWN');assert.equal(earningsDetail({...base,item:old},'self',old.id).item.currentFinance,undefined);
});
test('current responsibility is additive: original amount/state stay and VOID/MATURED/revised duty is fully typed',()=>{
 const responsibility=(patch={})=>({knowledge:'KNOWN',dutyId:'legacy_duty_x',orderId:'legacy_order_y',state:'MATURED',amountCents:'900',currency:'CNY',revision:'2',revised:true,maturityAt:'2026-10-05T00:00:00.000000Z',settledBy:null,...patch});
 const r=earningsDetail({...base,projectionVersion:2,item:{...old,currentResponsibility:responsibility()}},'self',old.id).item;
 assert.equal(r.amount.amountCents,'1234');assert.equal(r.state,'SETTLED');assert.equal(r.currentFinance.knowledge,'UNKNOWN');assert.equal(r.currentResponsibility.state,'MATURED');assert.equal(r.currentResponsibility.amountCents,'900');
 assert.equal(earningsDetail({...base,projectionVersion:2,item:{...old,currentResponsibility:responsibility({state:'VOID'})}},'self',old.id).item.currentResponsibility.state,'VOID');
 assert.equal(earningsDetail({...base,projectionVersion:2,item:{...old,currentResponsibility:responsibility({state:'SETTLED',settledBy:'LEGACY_RECORDS'})}},'self',old.id).item.currentResponsibility.settledBy,'LEGACY_RECORDS');
 for(const patch of [{state:'PAID'},{currency:'USD'},{revision:'0'},{settledBy:'FINANCE'},{state:'SETTLED',settledBy:null},{revised:'yes'},{maturityAt:'2026-10-05T00:00:00Z'},{amountCents:'1.2'}])assert.throws(()=>earningsDetail({...base,projectionVersion:2,item:{...old,currentResponsibility:responsibility(patch)}},'self',old.id));
 const native={...old,id:'native:new',origin:'NATIVE',state:'SETTLED',fundsDisposition:'SETTLED',dueAt:at,dueAtKnowledge:'KNOWN',version:'2',includedInOpening:false,accountingEffect:'EXISTING_LEDGER_EVENT',businessReference:{type:'RENTAL_ORDER',id:'order'}};
 assert.equal(earningsDetail({...base,projectionVersion:2,item:native},'self',native.id).item.currentResponsibility,null);
 assert.throws(()=>earningsDetail({...base,projectionVersion:2,item:{...native,currentResponsibility:responsibility()}},'self',native.id));
 assert.equal(earningsDetail({...base,item:old},'self',old.id).item.currentResponsibility,undefined);
});

const record=(entry=old,patch={})=>({id:entry.id,key:'commission:'+'b'.repeat(64),effectiveState:entry.state,amountCents:entry.amount.amountCents,occurredAt:at,stateKnowledge:'KNOWN',detail:{source:{type:entry.origin,system:'frozen-source',entity:'commission',id:'source-one'},stateBasis:'SOURCE_RECORD',originalState:entry.state,originalAmountCents:entry.amount.amountCents,currentResponsibility:{knowledge:'UNKNOWN',reason:'LEGACY_RESPONSIBILITY_NOT_ADMITTED'},currentFinance:{knowledge:'UNKNOWN',reason:'LEGACY_FINANCE_NOT_ADMITTED_OR_NOT_FINALIZED'},accountingEffect:'OBSERVATION_ONLY_NO_NEW_CREDIT',bankArrival:'UNKNOWN',reasonCodes:[]},...patch});
const recordSummary=(patch={})=>({scope:'COMMISSION_RECORDS',knowledge:'KNOWN',count:'1',mappedRecordCount:'1',amountCents:'1234',knownSubtotalCents:'1234',unknownStateCount:'0',unclassifiedRecordCount:'0',states:[{state:'SETTLED',count:'1',amountCents:'1234'}],coverage:{knowledge:'KNOWN',cutoff:at,reasonCodes:[]},reasonCodes:[],...patch});
const v2=(items=[old],patch={})=>({...page,projectionVersion:2,amountsByOrigin:{scope:'SOURCE_RECORDS_ONLY',native:{knowledge:'UNKNOWN',amountCents:null},historical:{knowledge:'UNKNOWN',amountCents:null},mappedHistoricalAmountCents:'1234'},items,...patch});
test('MCA001: v2 source amount coverage and current-state completeness remain independent knowledge dimensions',()=>{
 for(const knowledge of ['KNOWN','UNKNOWN'])for(const totalAmountKnowledge of ['KNOWN','UNKNOWN']){
  const amountsByOrigin={scope:'SOURCE_RECORDS_ONLY',native:{knowledge:totalAmountKnowledge==='KNOWN'?'KNOWN':'UNKNOWN',amountCents:totalAmountKnowledge==='KNOWN'?'0':null},historical:{knowledge:'KNOWN',amountCents:'1234'},mappedHistoricalAmountCents:'1234'};
  const result=earningsPage(v2([old],{knowledge,count:knowledge==='KNOWN'?'1':null,totalAmountKnowledge,amountsByOrigin}),'self','ALL',2);
  assert.equal(result.knowledge,knowledge);assert.equal(result.count,knowledge==='KNOWN'?'1':null);assert.equal(result.totalAmountKnowledge,totalAmountKnowledge);assert.deepEqual(result.amountsByOrigin,amountsByOrigin);
 }
 assert.throws(()=>earningsPage({...page,totalAmountKnowledge:'KNOWN'},'self','ALL',1),'v1 retains its original unknown-total contract');
 assert.throws(()=>earningsPage(v2([old],{totalAmountKnowledge:'KNOWN'}),'self','ALL',2),'known source totals still require each source coverage proof');
});
test('MCA001: known original amounts do not close four unknown current commission states or synthesize totals',()=>{
 const pending={...old,state:'PENDING'},r=record(pending,{effectiveState:'UNKNOWN',stateKnowledge:'UNKNOWN'});r.detail={...r.detail,stateBasis:'UNKNOWN'};
 const summary=recordSummary({knowledge:'UNKNOWN',count:null,mappedRecordCount:'4',amountCents:null,knownSubtotalCents:'4936',unknownStateCount:'4',unclassifiedRecordCount:'4',states:[{state:'UNKNOWN',count:'4',amountCents:'4936'}]});
 const result=earningsPage(v2([{...pending,record:r}],{mappedRecordCount:'4',totalAmountKnowledge:'KNOWN',amountsByOrigin:{scope:'SOURCE_RECORDS_ONLY',native:{knowledge:'KNOWN',amountCents:'0'},historical:{knowledge:'KNOWN',amountCents:'4936'},mappedHistoricalAmountCents:'4936'},recordSummary:summary,nextCursor:'original-signed-cursor'}),'self','ALL',2);
 assert.equal(result.knowledge,'UNKNOWN');assert.equal(result.count,null);assert.equal(result.totalAmountKnowledge,'KNOWN');assert.equal(result.recordSummary.knowledge,'UNKNOWN');assert.equal(result.recordSummary.amountCents,null);assert.equal(result.recordSummary.knownSubtotalCents,'4936');assert.equal(result.recordSummary.unclassifiedRecordCount,'4');assert.equal(result.items[0].record.effectiveState,'UNKNOWN');assert.equal(result.items[0].record.amountCents,'1234');assert.equal(result.nextCursor,'original-signed-cursor');
});
test('unified record keeps one economic key through responsibility revisions and preserves original facts',()=>{
 const duty={knowledge:'KNOWN',dutyId:'duty',orderId:'order',state:'MATURED',amountCents:'900',currency:'CNY',revision:'2',revised:true,maturityAt:at,settledBy:null};
 const first=record(old,{effectiveState:'MATURED',amountCents:'900'});first.detail={...first.detail,stateBasis:'CURRENT_RESPONSIBILITY',currentResponsibility:duty};
 const second={...first,effectiveState:'VOID',amountCents:'0',detail:{...first.detail,currentResponsibility:{...duty,state:'VOID',amountCents:'0',revision:'3'}}};
 const a=earningsDetail({...base,projectionVersion:2,item:{...old,currentResponsibility:duty,record:first}},'self',old.id).item;
 const b=earningsDetail({...base,projectionVersion:2,item:{...old,currentResponsibility:second.detail.currentResponsibility,record:second}},'self',old.id).item;
 assert.equal(a.record.key,b.record.key);assert.equal(b.record.amountCents,'0');assert.equal(b.record.effectiveState,'VOID');assert.equal(b.amount.amountCents,'1234');assert.equal(b.state,'SETTLED');assert.equal(b.record.detail.bankArrival,'UNKNOWN');
 for(const patch of [{id:'history:other'},{detail:{...first.detail,source:{...first.detail.source,type:'NATIVE'}}},{detail:{...first.detail,originalAmountCents:'0'}},{detail:{...first.detail,bankArrival:'PAID'}},{amountCents:'1e3'},{stateKnowledge:'UNKNOWN'}])assert.throws(()=>earningsDetail({...base,projectionVersion:2,item:{...old,record:{...first,...patch}}},'self',old.id));
});
test('v2 filtering uses effective UNKNOWN or MATURED while v1 remains original-state compatible',()=>{
 const pending={...old,state:'PENDING'},unknown=record(pending,{effectiveState:'UNKNOWN',stateKnowledge:'UNKNOWN'});unknown.detail={...unknown.detail,stateBasis:'UNKNOWN'};
 const payload=v2([{...pending,record:unknown}],{state:'UNKNOWN'});
 assert.equal(earningsPage(payload,'self','UNKNOWN',2).items[0].state,'PENDING');assert.equal(earningsPage(payload,'self','UNKNOWN',2).items[0].record.effectiveState,'UNKNOWN');
 assert.throws(()=>earningsPage({...payload,state:'PENDING'},'self','PENDING',2));
 const duty={knowledge:'KNOWN',dutyId:'duty',orderId:'order',state:'MATURED',amountCents:'900',currency:'CNY',revision:'1',revised:false,maturityAt:at,settledBy:null},matured=record(old,{effectiveState:'MATURED',amountCents:'900'});matured.detail={...matured.detail,stateBasis:'CURRENT_RESPONSIBILITY',currentResponsibility:duty};
 assert.equal(earningsPage(v2([{...old,currentResponsibility:duty,record:matured}],{state:'MATURED'}),'self','MATURED',2).items[0].record.amountCents,'900');
 assert.throws(()=>earningsPage({...page,state:'UNKNOWN',items:[]},'self','UNKNOWN',1));
 assert.equal(earningsPage({...page,state:'PENDING',items:[pending]},'self','PENDING',1).items[0].state,'PENDING');
});
test('record aggregates exceed single-amount bounds without floating-point loss and never become wallet money',()=>{
 const sum='1000000000000000000001233',summary=recordSummary({count:'2',mappedRecordCount:'2',amountCents:sum,knownSubtotalCents:sum,states:[{state:'SETTLED',count:'2',amountCents:sum}]});
 assert.equal(commissionRecordSummary(summary).amountCents,sum);assert.equal(commissionRecordMoney(sum),'¥10,000,000,000,000,000,000,012.33');assert.equal(commissionRecordMoney('9007199254740993'),'¥90,071,992,547,409.93');
 assert.equal(commissionRecordMoney(null),'待核定');for(const value of ['-1','1e24','1.2','01',123])assert.throws(()=>commissionRecordMoney(value));
 assert.throws(()=>commissionRecord(record(old,{amountCents:sum})));assert.throws(()=>commissionRecordSummary({...summary,knownSubtotalCents:'0'}));
});
test('partial record knowledge preserves null totals and reports global unclassified records on empty filters',()=>{
 const summary=recordSummary({knowledge:'UNKNOWN',count:null,mappedRecordCount:'0',amountCents:null,knownSubtotalCents:'0',unclassifiedRecordCount:'1',states:[]});
 assert.equal(commissionRecordSummary(summary).count,null);assert.equal(earningsPage(v2([],{state:'PENDING',mappedRecordCount:'0',recordSummary:summary}),'self','PENDING',2).recordSummary.unclassifiedRecordCount,'1');
 assert.throws(()=>commissionRecordSummary({...summary,knowledge:'KNOWN',count:'0',amountCents:'0'}));
 assert.throws(()=>commissionRecordSummary({...summary,unknownStateCount:'1'}));
 assert.throws(()=>earningsPage(v2([],{mappedRecordCount:'0',recordSummary:summary}),'self','ALL',2));
 assert.throws(()=>commissionRecordSummary({...summary,count:'0'}));
});
test('duplicate economic records or inconsistent summary totals fail closed instead of multiplying records',()=>{
 const a={...old,record:record()},b={...old,id:'history:other',record:{...record(),id:'history:other'}};
 assert.throws(()=>earningsPage(v2([a,b],{mappedRecordCount:'2'}),'self','ALL',2));
 assert.throws(()=>earningsPage(v2([a],{recordSummary:recordSummary({mappedRecordCount:'2',count:'2',states:[{state:'SETTLED',count:'2',amountCents:'1234'}]})}),'self','ALL',2));
 assert.throws(()=>commissionRecordSummary(recordSummary({states:[{state:'SETTLED',count:'1',amountCents:'1234'},{state:'SETTLED',count:'0',amountCents:'0'}]})));
});
