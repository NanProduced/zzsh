import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {earningsPage,earningsDetail,readEarnings,readEarningDetail,commissionRecord,commissionRecordSummary,commissionRecordMoney} from '../src/lib/distribution-earnings-client.ts';
import {distributionSummary,readDistributionSummary} from '../src/lib/distribution-summary-client.ts';
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

test('self distribution summary retains native/legacy separation and exact cents',()=>{
 const known=(cents)=>({knowledge:'KNOWN',cents,count:'1',reasonCodes:[]});
 const summaryBody={contractVersion:'distribution-self-summary.v1',asOf:'2026-11-02T03:00:00.000000Z',subjectId:'self',
  native:{settled:known('100'),pending:known('50'),recovery:known('30'),revoked:known('0'),orders:known('0')},
  legacy:{settled:known('200'),pending:known('40'),expired:known('0'),coverage:'UNKNOWN'},
  flow:{accrued:known('10'),settled:known('100'),monthSettled:known('90'),reversed:known('0'),recovered:known('0')},
  network:{inviter:known('0'),leader:{...known('0'),count:'2'}},
  trend:[{date:'2026-11-02',cents:'100',knowledge:'KNOWN'}],
  recent:[{id:'native:1',source:'NATIVE',beneficiaryId:'self',beneficiaryName:'我',role:'OWNER_REFERRAL',amountCents:'100',state:'SETTLED',occurredAt:'2026-11-02T00:00:00.000000Z'}],reasonCodes:[]};
 const r=distributionSummary(summaryBody,'self');assert.equal(r.native.settled.cents,'100');assert.equal(r.legacy.settled.cents,'200');assert.equal(r.flow.monthSettled.cents,'90');assert.equal(r.network.leader.count,'2');assert.equal(r.recent[0].source,'NATIVE');assert.throws(()=>distributionSummary({...summaryBody,subjectId:'other'},'self'));assert.throws(()=>distributionSummary({...summaryBody,native:{...summaryBody.native,settled:{knowledge:'KNOWN',cents:null,count:'0',reasonCodes:[]}}},'self'));
});

test('summary read is GET same-origin and fails closed on API errors',async()=>{
 const known=(cents)=>({knowledge:'KNOWN',cents,count:'1',reasonCodes:[]});
 const summaryBody={contractVersion:'distribution-self-summary.v1',asOf:'2026-11-02T03:00:00.000000Z',subjectId:'self',
  native:{settled:known('100'),pending:known('50'),recovery:known('30'),revoked:known('0'),orders:known('0')},
  legacy:{settled:known('200'),pending:known('40'),expired:known('0'),coverage:'UNKNOWN'},
  flow:{accrued:known('10'),settled:known('100'),monthSettled:known('90'),reversed:known('0'),recovered:known('0')},
  network:{inviter:known('0'),leader:{...known('0'),count:'2'}},
  trend:[{date:'2026-11-02',cents:'100',knowledge:'KNOWN'}],
  recent:[{id:'native:1',source:'NATIVE',beneficiaryId:'self',beneficiaryName:'我',role:'OWNER_REFERRAL',amountCents:'100',state:'SETTLED',occurredAt:'2026-11-02T00:00:00.000000Z'}],reasonCodes:[]};
 const previous=globalThis.fetch,seen=[];globalThis.fetch=async(url,options)=>{seen.push({url:String(url),options});return Response.json(summaryBody)};
 try{const r=await readDistributionSummary();assert.equal(r.subjectId,'self');assert.equal(seen[0].url,'/api/account/distribution/summary');assert.equal(seen[0].options.credentials,'same-origin');globalThis.fetch=async()=>Response.json({error:{code:'FORBIDDEN'}},{status:403});await assert.rejects(readDistributionSummary(),e=>e.status===403);}finally{globalThis.fetch=previous;}
});


/* --- Uniform Distribution Consumer Rules --- */

import {distributionTerms,readMyDistributionTerms,invitationRead,inviteesPage,readMyInvitees,pendingLeaderBinding,bindLeader,recoverLeaderBinding} from '../src/lib/invitation-client.ts';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4202';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4200';
const {GET:termsGet}=await import('../src/lib/invitation-proxy.ts');
const {GET:earningsGet}=await import('../src/lib/distribution-earnings-proxy.ts');
const uniformAt='2026-10-04T00:00:00.000000Z',context=(path)=>({params:Promise.resolve({path})});
const terms=(patch={})=>({schema:'distribution-terms.self.v2',subjectId:'self',scope:'LOCAL_CONTROLLED',knowledge:'KNOWN',applicable:true,reason:null,policyVersion:'p2',participantPolicyVersion:'p1',level:null,rateMode:'UNIFORM',rates:{renterPercent:'0',ownerPercent:'2.125'},accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:0,...patch});
const calc=(patch={})=>({knowledge:'KNOWN',policyVersion:'frozen-p2',beneficiaryLevelCode:null,rateMode:'UNIFORM',percent:'0',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'LOCAL_CONTROLLED',orderNumber:null,...patch});
const detail=(calculation=calc())=>({contractVersion:'distribution-earnings.read.v1',subjectId:'self',snapshotVersion:'self-snapshot',asOf:uniformAt,projectionVersion:2,item:{id:'native:one',origin:'NATIVE',state:'SETTLED',role:'RENTER_REFERRAL',amount:{currency:'CNY',unit:'cent',amountCents:'0'},occurredAt:at,dueAt:at,dueAtKnowledge:'KNOWN',fundsDisposition:'SETTLED',recoveryRequiredCents:null,includedInOpening:false,version:'2',accountingEffect:'EXISTING_LEDGER_EVENT',businessReference:{type:'RENTAL_ORDER',id:'order'},channelArrivalKnowledge:'UNKNOWN',currentFinance:null,calculation}});

test('uniform self terms preserve real zero and null grade; legacy exact DTO is unchanged',()=>{
 const v=distributionTerms(terms(),'self',2);assert.equal(v.rateMode,'UNIFORM');assert.equal(v.level,null);assert.equal(v.rates.renterPercent,'0');assert.equal(v.settlementDelayDays,0);
 const level={code:'OLD',rank:1,renterPercent:'3',ownerPercent:'2'},legacy={...terms(),schema:'distribution-terms.self.v1',level};delete legacy.rateMode;delete legacy.rates;
 assert.deepEqual(distributionTerms(legacy,'self',1),legacy);assert.throws(()=>distributionTerms(legacy,'self',2));
 const migrated={...legacy,schema:'distribution-terms.self.v2',rateMode:'LEVEL',rates:{renterPercent:'3',ownerPercent:'2'}};assert.deepEqual(distributionTerms(migrated,'self',2),migrated);
});
test('uniform terms fail closed on invalid grade/rates/private fields and another subject',()=>{
 for(const p of [{level:{code:'OLD',rank:1,renterPercent:'0',ownerPercent:'2.125'}},{rates:null},{rateMode:'LEVEL'},{rates:{renterPercent:'-1',ownerPercent:'2'}},{rates:{renterPercent:'101',ownerPercent:'2'}},{rates:{renterPercent:'0',ownerPercent:'2',baseCents:'PRIVATE'}},{levels:[]}])assert.throws(()=>distributionTerms(terms(p),'self',2));
 assert.throws(()=>distributionTerms(terms(),'other',2),e=>e.status===401);
 const unknown=terms({knowledge:'UNKNOWN',applicable:null,reason:'COMMISSION_FREEZE_STATE_UNKNOWN',rateMode:null,rates:null,accountModes:null,minimumAccrualCents:null,settlementDelayDays:null});assert.equal(distributionTerms(unknown,'self',2).rates,null);
 assert.throws(()=>distributionTerms({...unknown,rates:{renterPercent:'0',ownerPercent:'0'}},'self',2));
 const off=distributionTerms(terms({applicable:false,reason:'POLICY_DISABLED'}),'self',2);assert.equal(off.applicable,false);assert.equal(off.rates.renterPercent,'0');
});
test('self client explicitly requests terms projection 2, carries identity and rejects downgrade',async()=>{
 const previous=globalThis.fetch;let seen;try{globalThis.fetch=async(url,o)=>{seen={url:String(url),o};return Response.json(terms());};await readMyDistributionTerms('self');assert.equal(seen.url,'/api/account/distribution/terms?projectionVersion=2');assert.equal(seen.o.credentials,'same-origin');assert.equal(seen.o.cache,'no-store');
  const legacy={...terms(),schema:'distribution-terms.self.v1',level:{code:'L',rank:1,renterPercent:'0',ownerPercent:'2'}};delete legacy.rateMode;delete legacy.rates;globalThis.fetch=async()=>Response.json(legacy);await assert.rejects(readMyDistributionTerms('self'),e=>e.status===502);
 }finally{globalThis.fetch=previous;}
});
test('terms BFF forwards version 2 only at the terms seam and keeps default v1 exact',async()=>{
 const previous=globalThis.fetch;let seen,calls=0;try{globalThis.fetch=async(url,o)=>{calls++;seen={url:String(url),o};return Response.json(terms());};const r=await termsGet(new Request('http://127.0.0.1:4200/api/account/distribution/terms?projectionVersion=2',{headers:{cookie:'zzsh_user.session_token=u; zzsh_admin.session_token=a'}}),context(['terms']));assert.equal(r.status,200);assert.deepEqual(await r.json(),terms());assert.equal(seen.url,'http://127.0.0.1:4202/api/v1/users/me/distribution/terms?projectionVersion=2');assert.equal(seen.o.headers.get('cookie'),'zzsh_user.session_token=u');assert.equal(r.headers.get('cache-control'),'no-store');
  const n=calls;for(const suffix of ['/terms?projectionVersion=1','/terms?projectionVersion=2&projectionVersion=2','/terms?userId=other','?projectionVersion=2'])assert.equal((await termsGet(new Request('http://127.0.0.1:4200/api/account/distribution'+suffix),context(suffix.startsWith('/terms')?['terms']:[]))).status,400);assert.equal(calls,n);
 }finally{globalThis.fetch=previous;}
});
test('server binding capability is independent from new-accrual enabled; absence never grants it',()=>{
 const overview={scope:'LOCAL_CONTROLLED',subjectId:'self',policyKnowledge:'KNOWN',policyVersion:'p2',policyEnabled:false,canBindLeader:true,participant:{knowledge:'KNOWN',eligibility:'ELIGIBLE',levelCode:null,revision:'1'},ownCode:{knowledge:'KNOWN',code:'SELF'},inviter:{knowledge:'KNOWN_NONE',relation:null},leader:{knowledge:'KNOWN_NONE',relation:null}};
 assert.equal(invitationRead(overview,'self').canBindLeader,true);assert.equal(invitationRead({...overview,canBindLeader:false},'self').canBindLeader,false);const old={...overview};delete old.canBindLeader;assert.equal(invitationRead(old,'self').canBindLeader,false);
 for(const p of [{policyKnowledge:'UNKNOWN',policyVersion:null,policyEnabled:null},{participant:{knowledge:'UNKNOWN',eligibility:'UNKNOWN',levelCode:null,revision:null}},{leader:{knowledge:'UNKNOWN',relation:null}}])assert.throws(()=>invitationRead({...overview,...p},'self'));
});
test('uniform earning calculation preserves frozen rate/null grade and never discloses private base',()=>{
 const d=detail(calc({baseCents:'PRIVATE_BASE',canonical_basis:'PRIVATE_RAW',partyUserId:'PRIVATE_PARTY'})),v=earningsDetail(d,'self','native:one',2);assert.equal(v.item.calculation.rateMode,'UNIFORM');assert.equal(v.item.calculation.beneficiaryLevelCode,null);assert.equal(v.item.calculation.percent,'0');assert.doesNotMatch(JSON.stringify(v),/PRIVATE_BASE|PRIVATE_RAW|PRIVATE_PARTY/);
 for(const p of [{beneficiaryLevelCode:'OLD_GRADE'},{rateMode:'OTHER'},{rateMode:undefined,beneficiaryLevelCode:null}])assert.throws(()=>earningsDetail(detail(calc(p)),'self','native:one',2));
 const old=earningsDetail(detail(calc({rateMode:undefined,beneficiaryLevelCode:'OLD'})),'self','native:one',2);assert.equal(old.item.calculation.beneficiaryLevelCode,'OLD');assert.equal(Object.hasOwn(old.item.calculation,'rateMode'),false);
 assert.equal(earningsDetail(detail({knowledge:'UNKNOWN',reason:'UNIFORM_CALCULATION_REQUIRES_VERSION_2'}),'self','native:one',2).item.calculation.knowledge,'UNKNOWN');
});
test('earning detail client/BFF carry calculationVersion 2 together; bad or list-only inputs never reach API',async()=>{
 const previous=globalThis.fetch;let seen,calls=0;try{globalThis.fetch=async(url,o)=>{seen={url:String(url),o};calls++;return Response.json(detail());};await readEarningDetail('self','native:one');assert.equal(new URL(seen.url,'http://fixture.invalid').searchParams.get('calculationVersion'),'2');
  const root='http://127.0.0.1:4200/api/account/earnings';const r=await earningsGet(new Request(root+'/native%3Aone?projectionVersion=2&calculationVersion=2'),context(['native:one']));assert.equal(r.status,200);assert.equal((await r.json()).item.calculation.rateMode,'UNIFORM');assert.equal(new URL(seen.url).searchParams.get('calculationVersion'),'2');assert.equal(seen.o.method,'GET');
  const n=calls;for(const suffix of ['?projectionVersion=2&calculationVersion=2','/native%3Aone?projectionVersion=1&calculationVersion=2','/native%3Aone?projectionVersion=2&calculationVersion=3','/native%3Aone?projectionVersion=2&calculationVersion=2&calculationVersion=2'])assert.equal((await earningsGet(new Request(root+suffix),context(suffix.startsWith('/native')?['native:one']:[]))).status,400);assert.equal(calls,n);
 }finally{globalThis.fetch=previous;}
});

test('Native calculation source stays Native; unknown scopes and fabricated arrival reject',()=>{
 const v=earningsDetail(detail(calc({scope:'NATIVE'})),'self','native:one',2);assert.equal(v.item.calculation.scope,'NATIVE');assert.equal(v.item.channelArrivalKnowledge,'UNKNOWN');
 assert.throws(()=>earningsDetail(detail(calc({scope:'OTHER'})),'self','native:one',2));const falseArrival=detail(calc({scope:'NATIVE'}));falseArrival.item.channelArrivalKnowledge='KNOWN';assert.throws(()=>earningsDetail(falseArrival,'self','native:one',2));
});
test('NATIVE self terms survive the parser and only LOCAL/NATIVE scopes are accepted',()=>{
 const native=terms({scope:'NATIVE'});assert.equal(distributionTerms(native,'self',2).scope,'NATIVE');
 assert.equal(distributionTerms({...native,knowledge:'UNKNOWN',applicable:null,reason:'COMMISSION_FREEZE_STATE_UNKNOWN',rateMode:null,rates:null,accountModes:null,minimumAccrualCents:null,settlementDelayDays:null},'self',2).scope,'NATIVE');
 assert.equal(distributionTerms(terms(),'self',2).scope,'LOCAL_CONTROLLED');
 for(const bad of [{scope:'GLOBAL'},{scope:'LOCAL_CONTROLLED '},{scope:null}])assert.throws(()=>distributionTerms(terms(bad),'self',2));
});
test('invitation overview carries NATIVE but rejects any undeclared scope',()=>{
 const overview={scope:'LOCAL_CONTROLLED',subjectId:'self',policyKnowledge:'KNOWN',policyVersion:'p2',policyEnabled:false,canBindLeader:true,participant:{knowledge:'KNOWN',eligibility:'ELIGIBLE',levelCode:null,revision:'1'},ownCode:{knowledge:'KNOWN',code:'SELF'},inviter:{knowledge:'KNOWN_NONE',relation:null},leader:{knowledge:'KNOWN_NONE',relation:null}};
 assert.equal(invitationRead({...overview,scope:'NATIVE'},'self').scope,'NATIVE');
 for(const scope of ['GLOBAL','LOCAL','native',null])assert.throws(()=>invitationRead({...overview,scope},'self'));
});


const invUser='self',invBody={code:'FX0001',policyVersion:'policy',expectedParticipantRevision:'1'},invRelation={id:'relation',type:'DISTRIBUTION_LEADER',childUserId:invUser,parentUserId:'parent',policyVersion:'policy'};
const invUnknown={scope:'LOCAL_CONTROLLED',subjectId:invUser,policyKnowledge:'UNKNOWN',policyVersion:null,policyEnabled:null,participant:{knowledge:'UNKNOWN',eligibility:'UNKNOWN',levelCode:null,revision:null},ownCode:{knowledge:'UNKNOWN',code:null},inviter:{knowledge:'UNKNOWN',relation:null},leader:{knowledge:'UNKNOWN',relation:null}};
const invLinked={...invUnknown,leader:{knowledge:'KNOWN_PARENT',relation:{id:'relation',parentUserId:'parent',sourceType:'LOCAL_CONTROLLED',boundAt:'2026-10-04T02:00:00Z'}}};

test('legacy parent DTO keeps original binding time unknown even when an older response supplies migration time',()=>{const r=invitationRead({...invLinked,leader:{...invLinked.leader,relation:{...invLinked.leader.relation,sourceType:'LEGACY_MYSQL'}}},invUser);assert.equal(r.leader.relation.boundAt,null);assert.equal(r.leader.relation.boundAtKnowledge,'UNKNOWN');});
test('partial list contract retains mapped counts and hides legacy import timestamps; inconsistent partial sources reject',()=>{
 const partial={subjectId:invUser,knowledge:'UNKNOWN',type:'INVITER',snapshotVersion:'snapshot',count:null,mappedRelationCount:'2',nextCursor:'next',items:[{id:'r',type:'INVITER',nickname:'已确认用户',boundAt:'2026-10-04T00:00:00Z',sourceType:'LEGACY_MYSQL'}]};
 const page=inviteesPage(partial,invUser,'INVITER');assert.equal(page.count,null);assert.equal(page.mappedRelationCount,'2');assert.equal(page.items[0].boundAt,null);assert.equal(page.items[0].boundAtKnowledge,'UNKNOWN');
 for(const patch of [{mappedRelationCount:null},{mappedRelationCount:'0'},{snapshotVersion:null},{type:'ALL'},{count:'2'},{items:[partial.items[0],partial.items[0]]}])assert.throws(()=>inviteesPage({...partial,...patch},invUser,'INVITER'));
 assert.throws(()=>inviteesPage({...partial,subjectId:'other'},invUser,'INVITER'),e=>e.status===401);
});
async function withInvBrowser(run){const previous=globalThis.fetch,storage=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),nav=Object.getOwnPropertyDescriptor(globalThis,'navigator'),values=new Map();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,_opts,fn)=>fn({})}}});try{await run(values);}finally{globalThis.fetch=previous;if(storage)Object.defineProperty(globalThis,'localStorage',storage);else delete globalThis.localStorage;if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator;}}
test('unknown qualification and parents are preserved; inconsistent projection or another identity is rejected',()=>{assert.equal(invitationRead(invUnknown,invUser).participant.eligibility,'UNKNOWN');assert.throws(()=>invitationRead({...invUnknown,subjectId:'other'},invUser),e=>e.status===401);assert.throws(()=>invitationRead({...invUnknown,leader:{knowledge:'KNOWN_NONE',relation:invLinked.leader.relation}},invUser));assert.throws(()=>invitationRead({...invUnknown,policyKnowledge:'KNOWN'},invUser));});
test('list UNKNOWN retains null count rather than displaying a fabricated zero',async()=>{const previous=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({subjectId:invUser,knowledge:'UNKNOWN',count:null,items:[],nextCursor:null});assert.equal((await readMyInvitees(invUser,'ALL')).count,null);globalThis.fetch=async()=>Response.json({subjectId:invUser,knowledge:'UNKNOWN',count:'0',items:[],nextCursor:null});await assert.rejects(readMyInvitees(invUser,'ALL'));}finally{globalThis.fetch=previous;}});
test('binding ACK loss persists original key and recovers through GET without repeating POST',()=>withInvBrowser(async()=>{let posts=0,key;globalThis.fetch=async(u,o)=>{if(o.method==='POST'){posts++;key=o.headers['idempotency-key'];assert(pendingLeaderBinding(invUser));throw Error('lost ACK');}assert(String(u).includes('/bind/receipt?key='+key));return Response.json({subjectId:invUser,knowledge:'UNKNOWN',receipt:null});};await assert.rejects(bindLeader(invUser,invBody,()=>true));await assert.rejects(bindLeader(invUser,invBody,()=>true),e=>e.code==='BINDING_UNRESOLVED');assert.equal(await recoverLeaderBinding(invUser,()=>true),null);assert(pendingLeaderBinding(invUser));globalThis.fetch=async u=>String(u).includes('/receipt?')?Response.json({subjectId:invUser,knowledge:'KNOWN',receipt:{relation:invRelation}}):Response.json(invLinked);assert.equal((await recoverLeaderBinding(invUser,()=>true)).leader.relation.id,'relation');assert.equal(posts,1);assert.equal(pendingLeaderBinding(invUser),null);}));
test('accepted write then 401 readback or late identity change retains marker',()=>withInvBrowser(async()=>{globalThis.fetch=async(_u,o)=>o.method==='POST'?Response.json({relation:invRelation}):Response.json({error:{code:'UNAUTHENTICATED'}},{status:401});await assert.rejects(bindLeader(invUser,invBody,()=>true),e=>e.status===401);assert(pendingLeaderBinding(invUser));assert.equal(pendingLeaderBinding('other'),null);let active=false;assert.equal(await recoverLeaderBinding(invUser,()=>active),null);}));
test('definite rejection can clear marker; malformed accepted response remains unresolved',()=>withInvBrowser(async()=>{globalThis.fetch=async()=>Response.json({error:{code:'CONFLICT'}},{status:409});await assert.rejects(bindLeader(invUser,invBody,()=>true));assert.equal(pendingLeaderBinding(invUser),null);globalThis.fetch=async()=>Response.json({relation:{...invRelation,childUserId:'other'}});await assert.rejects(bindLeader(invUser,invBody,()=>true));assert(pendingLeaderBinding(invUser));}));
test('corrupt storage and another tab lock prevent submission',()=>withInvBrowser(async values=>{let posts=0;globalThis.fetch=async()=>{posts++;throw Error();};navigator.locks.request=async(_k,_o,fn)=>fn(null);await assert.rejects(bindLeader(invUser,invBody,()=>true));values.set('zzsh.invitation.binding.pending.v1:'+invUser,'broken');assert.throws(()=>pendingLeaderBinding(invUser),e=>e.code==='PENDING_MARKER_UNREADABLE');assert.equal(posts,0);}));
