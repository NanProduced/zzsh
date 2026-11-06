import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {applyLevelCommand,managedDistributionPolicy,parseLevelCommand} from '../src/finance/distribution-level-management';
import {validateDistributionPolicy} from '../src/finance/distribution-policy';
import {freezePaymentDistributionBasis,type PaymentReferralFacts} from '../src/finance/distribution-payment-basis';
import {prepareAccrualFromFrozenPayment,type CompletedDistributionFacts} from '../src/finance/distribution-accrual';

const base={scope:'NATIVE',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary'],minimumAccrualCents:'1',settlementDelayDays:7};
const levels=[{code:'legacy_1',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null},{code:'legacy_2',rank:2,default:false,renterPercent:'10',ownerPercent:'10',upgrade:null}];
const source={...base,schema:'distribution-policy.v3',levels,legacySource:{receiptSha256:'a'.repeat(64),configurationSha256:'b'.repeat(64),levelsSha256:'c'.repeat(64),levelNames:{legacy_1:'默认',legacy_2:'高级'}}};
const old=()=>validateDistributionPolicy(structuredClone(source),'NATIVE');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

test('managed levels preserve original version and legacy calculation basis',()=>{
 const original=old(),originalBytes=canonicalize(original),converted=managedDistributionPolicy(original);
 assert.equal(converted.baseMode,'LEGACY_RENTAL');assert.equal(converted.levelNames.legacy_2,'高级');
 const updated=applyLevelCommand(original,{action:'UPSERT',code:'legacy_2',name:'白银',rank:2,renterPercent:'12',ownerPercent:'10',isDefault:false});
 assert.equal(updated.config.schema,'distribution-policy.v4');assert.equal(updated.config.baseMode,'LEGACY_RENTAL');assert.equal(updated.config.levelNames.legacy_2,'白银');
 assert.equal(canonicalize(original),originalBytes);assert.equal(updated.config.levels[1]!.renterPercent,'12');
});
test('uniform version converts to one explicit default with the same economics',()=>{
 const uniform=validateDistributionPolicy({...base,schema:'distribution-policy.v2',rateMode:'UNIFORM',renterPercent:'8',ownerPercent:'7',levels:[]},'NATIVE');
 const converted=managedDistributionPolicy(uniform);
 assert.equal(converted.baseMode,'PLATFORM_CONTRIBUTION');assert.deepEqual(converted.levels.map(l=>[l.default,l.renterPercent,l.ownerPercent]),[[true,'8','7']]);
});
test('default cannot be deleted or unset; deleting a non-default yields explicit reassignment target',()=>{
 assert.throws(()=>applyLevelCommand(old(),{action:'DELETE',code:'legacy_1'}));
 assert.throws(()=>applyLevelCommand(old(),{action:'UPSERT',code:'legacy_1',name:'默认',rank:1,renterPercent:'5',ownerPercent:'5',isDefault:false}));
 const deleted=applyLevelCommand(old(),{action:'DELETE',code:'legacy_2'});assert.equal(deleted.removedCode,'legacy_2');assert.equal(deleted.defaultCode,'legacy_1');
 const reassigned=applyLevelCommand(old(),{action:'UPSERT',code:'legacy_2',name:'高级',rank:2,renterPercent:'10',ownerPercent:'10',isDefault:true});
 assert.equal(reassigned.defaultCode,'legacy_2');assert.equal(reassigned.config.levels.filter(l=>l.default).length,1);
});
test('invalid levels, duplicate ranks, over-allocation and unknown source fail closed',()=>{
 assert.throws(()=>parseLevelCommand({action:'DELETE',code:'',extra:true}));
 assert.throws(()=>applyLevelCommand(old(),{action:'UPSERT',code:null,name:'新档',rank:1,renterPercent:'10',ownerPercent:'10',isDefault:false},()=>'level_new'));
 assert.throws(()=>applyLevelCommand(old(),{action:'UPSERT',code:null,name:'新档',rank:3,renterPercent:'95',ownerPercent:'10',isDefault:false},()=>'level_new'));
 assert.throws(()=>applyLevelCommand(old(),{action:'UPSERT',code:'missing',name:'新档',rank:3,renterPercent:'5',ownerPercent:'5',isDefault:false}));
 assert.throws(()=>validateDistributionPolicy({...managedDistributionPolicy(old()),levelNames:{legacy_1:'默认'},baseMode:'BAD'},'NATIVE'));
});
test('an earlier payment keeps its frozen level and base after editing and deleting that level',()=>{
 const previous=old(),changed=applyLevelCommand(previous,{action:'UPSERT',code:'legacy_2',name:'新档',rank:2,renterPercent:'20',ownerPercent:'10',isDefault:false}).config;
 const facts:PaymentReferralFacts[]=(['RENTER_REFERRAL','OWNER_REFERRAL'] as const).map((role,n)=>({role,partyUserId:`party${n}`,relation:{knowledge:'KNOWN_PARENT',id:`relation${n}`,childUserId:`party${n}`,parentUserId:`parent${n}`,sourceDigest:'d'.repeat(64)},beneficiary:{userId:`parent${n}`,active:true,eligibility:'ELIGIBLE',commissionFrozen:false,levelCode:'legacy_2'}}));
 const freeze=(policy:typeof previous)=>freezePaymentDistributionBasis({orderId:'order',gameId:'game',currency:'CNY',confirmationId:'payment',acceptedAt:'2026-10-04T03:00:00.000000Z',paymentDigest:'a'.repeat(64),admissionId:'admission',admissionRevision:'1',origin:'NATIVE',accountMode:'ordinary',estimate:{baseCents:'5000',sourceDigest:'a'.repeat(64)},policy:{versionId:policy===previous?'before':'after',digest:sha(canonicalize(policy)),config:policy},facts});
 const before=freeze(previous),after=freeze(changed);
 const posting:CompletedDistributionFacts={origin:'NATIVE',orderId:'order',confirmationId:'payment',postingId:'posting',postingDigest:'e'.repeat(64),postedAt:'2026-10-04T03:12:10.123456Z',classification:'NORMAL',calculationMode:'SYSTEM',capturedCents:'10000',ownerNetCents:'4000',renterRefundCents:'1000',platformContributionCents:'5000',compensationFeeCents:'200'};
 const oldResult=prepareAccrualFromFrozenPayment(before,posting),newResult=prepareAccrualFromFrozenPayment(after,posting);
 assert.equal(oldResult.baseCents,'5000');assert.equal(newResult.baseCents,'5000');
 assert.deepEqual(oldResult.items.map(x=>x.amountCents).sort(),['500','500']);assert.deepEqual(newResult.items.map(x=>x.amountCents).sort(),['1000','500']);
 assert.equal(applyLevelCommand(changed,{action:'DELETE',code:'legacy_2'}).defaultCode,'legacy_1');
 assert.deepEqual(prepareAccrualFromFrozenPayment(before,posting).items.map(x=>x.amountCents).sort(),['500','500']);
});
