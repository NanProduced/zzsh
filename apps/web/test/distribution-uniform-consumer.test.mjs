import assert from 'node:assert/strict';
import {test} from 'node:test';
import {distributionTerms,readMyDistributionTerms,invitationRead} from '../src/lib/invitation-client.ts';
import {earningsDetail,readEarningDetail} from '../src/lib/distribution-earnings-client.ts';
process.env.ZZSH_API_ORIGIN='http://127.0.0.1:4202';process.env.ZZSH_WEB_ORIGIN='http://127.0.0.1:4200';
const {GET:termsGet}=await import('../src/lib/invitation-proxy.ts');
const {GET:earningsGet}=await import('../src/lib/distribution-earnings-proxy.ts');
const at='2026-10-04T00:00:00.000000Z',context=(path)=>({params:Promise.resolve({path})});
const terms=(patch={})=>({schema:'distribution-terms.self.v2',subjectId:'self',scope:'LOCAL_CONTROLLED',knowledge:'KNOWN',applicable:true,reason:null,policyVersion:'p2',participantPolicyVersion:'p1',level:null,rateMode:'UNIFORM',rates:{renterPercent:'0',ownerPercent:'2.125'},accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:0,...patch});
const calc=(patch={})=>({knowledge:'KNOWN',policyVersion:'frozen-p2',beneficiaryLevelCode:null,rateMode:'UNIFORM',percent:'0',basis:'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE',baseDisclosure:'INTERNAL_SETTLEMENT_ONLY',rounding:'HALF_UP_CENT',cap:'COMBINED_ROLES_NOT_ABOVE_BASE',scope:'LOCAL_CONTROLLED',orderNumber:null,...patch});
const detail=(calculation=calc())=>({contractVersion:'distribution-earnings.read.v1',subjectId:'self',snapshotVersion:'self-snapshot',asOf:at,projectionVersion:2,item:{id:'native:one',origin:'NATIVE',state:'SETTLED',role:'RENTER_REFERRAL',amount:{currency:'CNY',unit:'cent',amountCents:'0'},occurredAt:at,dueAt:at,dueAtKnowledge:'KNOWN',fundsDisposition:'SETTLED',recoveryRequiredCents:null,includedInOpening:false,version:'2',accountingEffect:'EXISTING_LEDGER_EVENT',businessReference:{type:'RENTAL_ORDER',id:'order'},channelArrivalKnowledge:'UNKNOWN',currentFinance:null,calculation}});

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
