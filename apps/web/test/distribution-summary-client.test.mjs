import {test} from 'node:test';import {strict as assert} from 'node:assert';
import {distributionSummary,readDistributionSummary} from '../src/lib/distribution-summary-client.ts';
const known=(cents)=>({knowledge:'KNOWN',cents,count:'1',reasonCodes:[]});
const body={contractVersion:'distribution-self-summary.v1',asOf:'2026-11-02T03:00:00.000000Z',subjectId:'self',
 native:{settled:known('100'),pending:known('50'),recovery:known('30'),revoked:known('0'),orders:known('0')},
 legacy:{settled:known('200'),pending:known('40'),expired:known('0'),coverage:'UNKNOWN'},
 flow:{accrued:known('10'),settled:known('100'),monthSettled:known('90'),reversed:known('0'),recovered:known('0')},
 network:{inviter:known('0'),leader:{...known('0'),count:'2'}},
 trend:[{date:'2026-11-02',cents:'100',knowledge:'KNOWN'}],
 recent:[{id:'native:1',source:'NATIVE',beneficiaryId:'self',beneficiaryName:'我',role:'OWNER_REFERRAL',amountCents:'100',state:'SETTLED',occurredAt:'2026-11-02T00:00:00.000000Z'}],reasonCodes:[]};
test('self distribution summary retains native/legacy separation and exact cents',()=>{const r=distributionSummary(body,'self');assert.equal(r.native.settled.cents,'100');assert.equal(r.legacy.settled.cents,'200');assert.equal(r.flow.monthSettled.cents,'90');assert.equal(r.network.leader.count,'2');assert.equal(r.recent[0].source,'NATIVE');assert.throws(()=>distributionSummary({...body,subjectId:'other'},'self'));assert.throws(()=>distributionSummary({...body,native:{...body.native,settled:{knowledge:'KNOWN',cents:null,count:'0',reasonCodes:[]}}},'self'));});
test('summary read is GET same-origin and fails closed on API errors',async()=>{const previous=globalThis.fetch,seen=[];globalThis.fetch=async(url,options)=>{seen.push({url:String(url),options});return Response.json(body)};try{const r=await readDistributionSummary();assert.equal(r.subjectId,'self');assert.equal(seen[0].url,'/api/account/distribution/summary');assert.equal(seen[0].options.credentials,'same-origin');globalThis.fetch=async()=>Response.json({error:{code:'FORBIDDEN'}},{status:403});await assert.rejects(readDistributionSummary(),e=>e.status===403);}finally{globalThis.fetch=previous;}});
test('unified summary and recent records share exact typed record facts without replacing compatibility metrics',()=>{
 const amount='1000000000000000000001233',unified={scope:'COMMISSION_RECORDS',knowledge:'KNOWN',count:'2',mappedRecordCount:'2',amountCents:amount,knownSubtotalCents:amount,unknownStateCount:'0',unclassifiedRecordCount:'0',states:[{state:'SETTLED',count:'2',amountCents:amount}],coverage:{knowledge:'KNOWN',cutoff:null,reasonCodes:[]},reasonCodes:[]};
 const record={id:'history:entry',key:'commission:'+'a'.repeat(64),effectiveState:'SETTLED',amountCents:'1234',occurredAt:body.asOf,stateKnowledge:'KNOWN',detail:{source:{type:'LEGACY_MYSQL',system:'legacy',entity:'commission',id:'entry'},stateBasis:'SOURCE_RECORD',originalState:'SETTLED',originalAmountCents:'1234',currentResponsibility:{knowledge:'UNKNOWN',reason:'NOT_ADMITTED'},currentFinance:{knowledge:'UNKNOWN',reason:'NOT_ADMITTED'},accountingEffect:'OBSERVATION_ONLY_NO_NEW_CREDIT',bankArrival:'UNKNOWN',reasonCodes:[],privatePayload:'MUST_STRIP'}};
 const result=distributionSummary({...body,unified,recentRecords:[record]},'self');assert.equal(result.unified.amountCents,amount);assert.equal(result.native.settled.cents,'100');assert.equal(result.recentRecords[0].detail.originalAmountCents,'1234');assert.doesNotMatch(JSON.stringify(result),/MUST_STRIP/);
 assert.throws(()=>distributionSummary({...body,unified,recentRecords:[record,record]},'self'));assert.throws(()=>distributionSummary({...body,unified:{...unified,count:null}},'self'));
 assert.equal(distributionSummary(body,'self').unified,undefined,'old DTO remains compatible, never auto-summed');
});
test('summary request binds to the initiating subject instead of accepting the response subject as authority',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>Response.json({...body,subjectId:'another-user'});
 try{await assert.rejects(readDistributionSummary(undefined,'self'),error=>error.status===401&&error.code==='IDENTITY_CHANGED');}finally{globalThis.fetch=previous;}
});
