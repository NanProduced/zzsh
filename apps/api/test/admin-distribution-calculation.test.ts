import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {freezePaymentDistributionBasis} from '../src/finance/distribution-payment-basis';
import {prepareAccrualFromFrozenPayment} from '../src/finance/distribution-accrual';
import {readEarningCalculation,readAdminEarningCalculations,readAdminEarningEventActions} from '../src/finance/distribution-earning-read';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),at='2026-10-19T11:51:09.000001Z';
function original(scope:'LOCAL_CONTROLLED'|'NATIVE'='LOCAL_CONTROLLED',uniform=false){
 const config={schema:'distribution-policy.v1',scope:'LOCAL_CONTROLLED',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary'],minimumAccrualCents:'1',settlementDelayDays:7,
  levels:[{code:'FROZEN_LEVEL',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null}]} as const;
 const frozenConfig=uniform?{...config,schema:'distribution-policy.v2',scope,rateMode:'UNIFORM',renterPercent:'5',ownerPercent:'5',levels:[]}:{...config,scope};
 const basis=freezePaymentDistributionBasis({orderId:'order-1',gameId:'delta',currency:'CNY',confirmationId:'payment-1',acceptedAt:at,paymentDigest:'a'.repeat(64),admissionId:'admission-1',admissionRevision:'1',origin:'NATIVE',accountMode:'ordinary',estimate:{baseCents:'9999',sourceDigest:'b'.repeat(64)},
  policy:{versionId:'policy-original',digest:sha(canonicalize(frozenConfig)),config:structuredClone(frozenConfig) as never},facts:[
   {role:'RENTER_REFERRAL',partyUserId:'renter',relation:{knowledge:'KNOWN_NONE',id:null,childUserId:'renter',parentUserId:null,sourceDigest:null},beneficiary:null},
   {role:'OWNER_REFERRAL',partyUserId:'owner',relation:{knowledge:'KNOWN_PARENT',id:'relation-1',childUserId:'owner',parentUserId:'referrer',sourceDigest:'c'.repeat(64)},beneficiary:{userId:'referrer',active:true,eligibility:'ELIGIBLE',commissionFrozen:false,levelCode:'FROZEN_LEVEL'}}]});
 const posting={id:'posting-1',order_id:'order-1',payment_confirmation_id:'payment-1',version_hash:'d'.repeat(64),early:false,manual_reason:null,
  captured_cents:'15908',owner_net_cents:'9000',renter_refund_cents:'5000',platform_contribution_cents:'1908',compensation_fee_cents:'0',posted_at:at};
 const postingDigest=sha(canonicalize(posting)),allocation=prepareAccrualFromFrozenPayment(basis,{origin:'NATIVE',orderId:'order-1',confirmationId:'payment-1',postingId:posting.id,postingDigest,postedAt:at,classification:'NORMAL',calculationMode:'SYSTEM',capturedCents:'15908',ownerNetCents:'9000',renterRefundCents:'5000',platformContributionCents:'1908',compensationFeeCents:'0'});
 assert.equal(allocation.knowledge,'KNOWN');if(allocation.knowledge!=='KNOWN')throw Error('fixture must close');
 const item=allocation.items[0]!,seed={id:'earning-1',beneficiaryUserId:'referrer',role:'OWNER_REFERRAL',source:{id:'order-1',digest:postingDigest},amountCents:'95',policyVersion:basis.policyVersion,policyDigest:basis.policyDigest,relationDigest:item.relationDigest,baseDigest:allocation.digest,economicKey:item.economicKey,dueAt:item.dueAt};
 const {digest,...body}=basis,canonical_seed=canonicalize(seed);
 return{id:'earning-1',order_id:'order-1',payment_confirmation_id:'payment-1',posting_id:posting.id,economic_key:item.economicKey,beneficiary_user_id:'referrer',beneficiary_role:'OWNER_REFERRAL',amount_cents:'95',canonical_seed,seed_digest:sha(canonical_seed),basis_digest:digest,posting_digest:postingDigest,canonical_basis:canonicalize(body),payment_basis_digest:digest,posting};
}
function reader(rows:Record<string,any>[]){
 const seen:{sql:string;args:unknown[]}[]=[];
 const client={query:async(sql:string,args:unknown[])=>{seen.push({sql,args});return{rows};}} as never;
 return{client,seen};
}
test('admin exact root batch uses original posting base, frozen policy and ratio rather than estimate/current policy',async()=>{
 const f=original(),p=reader([f]),result=await readAdminEarningCalculations(p.client,['earning-1','missing','earning-1']);
 assert.equal(p.seen.length,1);assert.deepEqual(p.seen[0]!.args,[['earning-1','missing']]);
 assert(p.seen[0]!.sql.includes('WHERE e.id=ANY($1::text[])'));assert(!p.seen[0]!.sql.includes('distribution_policy_version'));
 const known=result.get('earning-1')!;assert.equal(known.knowledge,'KNOWN');assert.equal(known.policyVersion,'policy-original');assert.equal(known.levelCode,'FROZEN_LEVEL');assert.equal(known.percent,'5');assert.equal(known.baseCents,'1908');assert.equal(known.formula,'FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE');
 assert.deepEqual(known.reasonCodes,[]);assert.equal(result.get('missing')?.knowledge,'UNKNOWN');
 assert(!/canonical_seed|canonical_basis|referrer|renter|owner/.test(JSON.stringify(known)));
});
test('admin missing or wrongly bound frozen sources keep every calculation field unknown',async()=>{
 const f=original(),changedSeed={...JSON.parse(f.canonical_seed),role:'RENTER_REFERRAL'},changedBasis={...JSON.parse(f.canonical_basis),policyVersion:'other'};
 const changes=[{canonical_basis:null},{canonical_seed:'{'},{seed_digest:'f'.repeat(64)},{payment_basis_digest:'f'.repeat(64)},
  {order_id:'foreign'},{payment_confirmation_id:'foreign'},{beneficiary_role:'RENTER_REFERRAL'},{beneficiary_user_id:'foreign'},{amount_cents:'96'},
  {canonical_seed:canonicalize(changedSeed),seed_digest:sha(canonicalize(changedSeed))},
  {canonical_basis:canonicalize(changedBasis),payment_basis_digest:sha(canonicalize(changedBasis)),basis_digest:sha(canonicalize(changedBasis))},
  {posting:null},{posting:{...f.posting,order_id:'foreign'}},{posting:{...f.posting,compensation_fee_cents:'1'}},{posting_id:'foreign'},{economic_key:'foreign'}];
 for(const patch of changes){const result=(await readAdminEarningCalculations(reader([{...f,...patch}]).client,['earning-1'])).get('earning-1')!;
  assert.equal(result.knowledge,'UNKNOWN',JSON.stringify(patch));for(const key of ['policyVersion','levelCode','percent','baseCents','formula'] as const)assert.equal(result[key],null);assert(result.reasonCodes.length);}
});
test('a signed but inconsistent level, ratio, amount or allocation digest cannot become a known admin calculation',async()=>{
 for(const mutation of ['level','ratio','amount','baseDigest']){
  const f=original();
  if(mutation==='level'||mutation==='ratio'){
   const basis=JSON.parse(f.canonical_basis),role=basis.roles.find((r:any)=>r.role==='OWNER_REFERRAL');if(mutation==='level')role.levelCode='MISSING';else role.ratio.numerator='1';
   f.canonical_basis=canonicalize(basis);f.basis_digest=f.payment_basis_digest=sha(f.canonical_basis);
  }else{const seed=JSON.parse(f.canonical_seed);if(mutation==='amount')seed.amountCents=f.amount_cents='96';else seed.baseDigest='f'.repeat(64);f.canonical_seed=canonicalize(seed);f.seed_digest=sha(f.canonical_seed);}
  assert.equal((await readAdminEarningCalculations(reader([f]).client,['earning-1'])).get('earning-1')?.knowledge,'UNKNOWN');
 }
});
test('batch handles more rows without N+1, ignores unrelated results, and fails actual SQL errors loudly',async()=>{
 const f=original(),p=reader([f,{...f,id:'unrequested'}]);const result=await readAdminEarningCalculations(p.client,['earning-1',...Array.from({length:99},(_,n)=>'missing-'+n)]);
 assert.equal(result.size,100);assert.equal(p.seen.length,1);assert(!result.has('unrequested'));
 const empty=reader([]);assert.equal((await readAdminEarningCalculations(empty.client,[])).size,0);assert.equal(empty.seen.length,0);
 const denied={query:async()=>{throw Object.assign(Error('denied'),{code:'42501'});}} as never;
 await assert.rejects(readAdminEarningCalculations(denied,['earning-1']),(e:any)=>e.code==='42501');
});
test('event actions preserve ACCRUE/SETTLE/REVOKE/RECOVER even when both last actions share EARNING_REVOKED',async()=>{
 const rows=(['ACCRUE','SETTLE','REVOKE','RECOVER'] as const).map((action,n)=>({event_id:'event-'+n,earning_id:'earning-1',action,expected_version:String(n),result_version:String(n+1),source_digest:'a'.repeat(64),economic_root_id:'earning-1',kind:n===0?'EARNING_PENDING':n===1?'EARNING_SETTLED':'EARNING_REVOKED',subject_user_id:'referrer',beneficiary_user_id:'referrer'}));
 const p=reader(rows),keys=rows.map(r=>r.event_id),r=await readAdminEarningEventActions(p.client,[...keys,'missing']);assert.equal(p.seen.length,1);assert.deepEqual(p.seen[0]!.args,[[...keys,'missing']]);
 assert(p.seen[0]!.sql.includes('WHERE t.finance_event_id=ANY($1::text[])'));for(const row of rows)assert.equal(r.get(row.event_id)?.action,row.action);assert.equal(r.get('missing')?.knowledge,'UNKNOWN');
});
test('event missing receipts, wrong root/subject/kind/action/version and duplicate evidence remain unknown',async()=>{
 const valid={event_id:'event-1',earning_id:'earning-1',action:'RECOVER',expected_version:'3',result_version:'4',source_digest:'a'.repeat(64),economic_root_id:'earning-1',kind:'EARNING_REVOKED',subject_user_id:'referrer',beneficiary_user_id:'referrer'};
 for(const patch of [{economic_root_id:'other'},{subject_user_id:'other'},{kind:'EARNING_SETTLED'},{action:'OTHER'},{action:'ACCRUE'},{expected_version:'4'},{source_digest:null}]){const r=(await readAdminEarningEventActions(reader([{...valid,...patch}]).client,['event-1'])).get('event-1')!;assert.equal(r.knowledge,'UNKNOWN');assert.equal(r.action,null);}
 const duplicate=await readAdminEarningEventActions(reader([valid,valid]).client,['event-1']);assert.equal(duplicate.get('event-1')?.knowledge,'UNKNOWN');
 const empty=reader([]);assert.equal((await readAdminEarningEventActions(empty.client,[])).size,0);assert.equal(empty.seen.length,0);
});

test('native frozen policy scope is verified for both user and admin calculations',async()=>{
 for(const uniform of [false,true]){
  const f=original('NATIVE',uniform),p=reader([f]);
  const admin=(await readAdminEarningCalculations(p.client,['earning-1'])).get('earning-1')!;
  assert.equal(admin.knowledge,'KNOWN');assert.equal(admin.percent,'5');
  const user=await readEarningCalculation(p.client,{userId:'referrer'} as never,{id:'native:earning-1',order_id:'order-1',role:'OWNER_REFERRAL',source_amount:'95'},true,2);
  assert.equal(user.knowledge,'KNOWN');if(user.knowledge==='KNOWN'){assert.equal(user.scope,'NATIVE');assert.equal(user.percent,'5');}
 }
});
