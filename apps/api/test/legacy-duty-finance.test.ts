import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {planLegacyDutyFinalization,verifyLegacyDutyFinalization,parseLegacyDutyPostingInput,legacyDutyBasisFromTrade,type LegacyFinanceDuty,type LegacyDutyFinalBasis,type LegacyDutyFundingProof} from '../src/finance/legacy-duty-finance';
import {readLegacyCommissionFinance,readLegacyCommissionFinanceVersion} from '../src/finance/legacy-duty-finance-store';
const at='2026-10-01T00:00:00.000001Z',due='2026-10-08T00:00:00.000001Z',orderId='legacy_order_'+'a'.repeat(40),dutyId='legacy_duty_'+'b'.repeat(40);
const duty:LegacyFinanceDuty={id:dutyId,orderId,kind:'RENTER_REFUND',sourceRecordId:'confirm-v1',counterpartyUserId:'renter',amountCents:'8200',currency:'CNY',revision:'2',status:'PENDING',source:'CONTINUATION',sourceStatus:null,continuationVersionId:'confirm-v1',admissionId:null,maturityAt:null,settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};
const basis:LegacyDutyFinalBasis={kind:'CONFIRMED_CONTINUATION',dutyId,orderId,dutyKind:duty.kind,sourceRecordId:duty.sourceRecordId,subjectId:'renter',amountCents:'8200',currency:'CNY',dutyRevision:'2',parentSourceDigest:'1'.repeat(64),parentSourceId:'101',sourceRecordEntity:'legacy_continuation_version',sourceRecordDigest:'2'.repeat(64),basisFactsDigest:'3'.repeat(64),evidenceId:'current-result',evidenceDigest:'4'.repeat(64),continuationVersionId:'confirm-v1',admissionId:null,effectiveHeadId:'release-v2',effectiveHeadRevision:'2',sourceTimeKind:'CONFIRMED_AT',sourceTime:at,maturityAt:null,finalAmountKnown:true,netRefundKnown:true,currentNetRefundCents:'8200',fundsDisposition:'AVAILABLE'};
const witness={openingBasisId:'basis-fixture',openingSourceDigest:'9'.repeat(64),coveredSetDigest:'0'.repeat(64),historyCoverageVersion:'history_fixture:'+'e'.repeat(64),historyReferenceDigest:'e'.repeat(64),historyCutoff:'2026-09-13T13:31:22.000Z',sourceCount:'0'};
const funding:LegacyDutyFundingProof={contractVersion:'legacy-duty-finance.v1',dutyId,orderId,kind:duty.kind,subjectId:'renter',amountCents:'8200',currency:'CNY',originalSourceSystem:'legacy_mysql_restore',originalSourceEntity:'la_order',originalSourceId:'101',originalSourceDigest:basis.parentSourceDigest,originalOrderNumber:'FIXTURE',finalEvidenceDigest:basis.evidenceDigest,coverageDecision:'NOT_PREVIOUSLY_CREDITED',coverageEvidenceDigest:createHash('sha256').update(canonicalize(witness)).digest('hex'),sourceStatus:'CONFIRMED_UNPAID_LIABILITY',evidenceRef:'fixture-only-source-not-a-bank-receipt',witness};
const input={dutyId,expectedRevision:'2',expectedEvidenceDigest:basis.evidenceDigest,expectedAmountCents:'8200'};
function settled(d:LegacyFinanceDuty,p:ReturnType<typeof planLegacyDutyFinalization>){return{...d,status:'SETTLED',revision:(BigInt(d.revision)+1n).toString(),settledBy:'FINANCE',settledRefType:p.ref.type,settledRefId:p.ref.id,settledRefDigest:p.ref.digest};}
function actual(p:ReturnType<typeof planLegacyDutyFinalization>){return{canonical:p.canonical,digest:p.factDigest,rootId:p.rootId,eventId:p.eventId,eventKind:'LEGACY_DUTY_SETTLED',ref:p.ref,lines:p.lines};}

test('refund is exactly net 87-5=82, with a positive payable line, never a cash/channel result',()=>{
 const p=planLegacyDutyFinalization(duty,basis,funding,input,due);assert.equal(p.lines[1]!.credit,'8200');assert.equal(p.lines[1]!.account,'RENTER_REFUND_PAYABLE');assert.equal(p.lines[0]!.account,'LEGACY_LIABILITY_SOURCE');assert.equal(verifyLegacyDutyFinalization(settled(duty,p),actual(p)),'POSTED_POSITIVE_REFUND');
 assert.throws(()=>planLegacyDutyFinalization({...duty,amountCents:'8700'},basis,funding,{...input,expectedAmountCents:'8700'},due));
});

test('reviewed historical DETAINED and original completed net refund both require AVAILABLE; held never becomes a new refund',()=>{
 for(const sourceStatus of ['COMPLETED_UNREFUNDED','DETAINED']){
  const d={...duty,source:'LEGACY_IMPORT',sourceStatus,sourceRecordId:'101',continuationVersionId:null},b={...basis,kind:'HISTORICAL_UNREFUNDED_ADMISSION' as const,sourceRecordId:'101',sourceRecordEntity:'la_order' as const,continuationVersionId:null,effectiveHeadId:null,effectiveHeadRevision:null,sourceTimeKind:'SOURCE_COMPLETED_AT' as const};
  const p=planLegacyDutyFinalization(d,b,funding,input,due);assert.equal(p.lines[1]!.credit,'8200');assert.equal(p.lines[1]!.account,'RENTER_REFUND_PAYABLE');assert.equal(verifyLegacyDutyFinalization(settled(d,p),actual(p)),'POSTED_POSITIVE_REFUND');
  for(const fundsDisposition of ['HELD','CONFISCATED','UNKNOWN'] as const)assert.throws(()=>planLegacyDutyFinalization(d,{...b,fundsDisposition},funding,input,due),/DUTY_FUNDS_DISPOSITION_NOT_PAYABLE/);
  for(const patch of [{netRefundKnown:false},{currentNetRefundCents:null},{currentNetRefundCents:'8700'}])assert.throws(()=>planLegacyDutyFinalization(d,{...b,...patch},funding,input,due),/DUTY_FUNDS_DISPOSITION_NOT_PAYABLE/);
  assert.throws(()=>planLegacyDutyFinalization({...d,sourceStatus:'REFUND_RECORD_EXISTS'},b,funding,input,due),/HISTORICAL_UNPAID_REFUND_EVIDENCE_REQUIRED/);
 }
});
test('unknown, stale, held, legacy settled, wrong direction/source/subject/currency never become a posted final duty',()=>{
 for(const patch of [{revision:'3'},{currency:'USD'},{counterpartyUserId:null},{status:'SETTLED',settledBy:'LEGACY_RECORDS'},{status:'VOID'},{amountCents:'-1'}])assert.throws(()=>planLegacyDutyFinalization({...duty,...patch} as any,basis,funding,input,due));
 for(const patch of [{finalAmountKnown:false},{netRefundKnown:false},{fundsDisposition:'HELD'},{amountCents:'8700'},{subjectId:'owner'},{basisFactsDigest:'broken'},{kind:'COMPLETED_COMMISSION_ADMISSION'}])assert.throws(()=>planLegacyDutyFinalization(duty,{...basis,...patch} as any,funding,input,due));
 for(const patch of [{coverageDecision:'ALREADY_CREDITED'},{originalSourceEntity:'la_distribution_order'},{sourceStatus:'PENDING'},{amountCents:'8700'},{finalEvidenceDigest:'f'.repeat(64)}])assert.throws(()=>planLegacyDutyFinalization(duty,basis,{...funding,...patch} as any,input,due));
});
test('zero needs final evidence, a dedicated event ref, and exactly zero ledger rows',()=>{
 const d={...duty,amountCents:'0'},b={...basis,amountCents:'0',currentNetRefundCents:'0'},f={...funding,amountCents:'0'},p=planLegacyDutyFinalization(d,b,f,{...input,expectedAmountCents:'0'},due);
 assert.equal(p.ref.type,'FINANCE_EVENT');assert.equal(p.lines.length,0);assert.equal(verifyLegacyDutyFinalization(settled(d,p),actual(p)),'FINALIZED_ZERO');
 assert.equal(verifyLegacyDutyFinalization(settled(d,p),{...actual(p),lines:[{id:'fake-zero',line:1,account:'WALLET_AVAILABLE',debit:'0',credit:'0',subject:'renter'}]}),'UNKNOWN');
 assert.throws(()=>planLegacyDutyFinalization(d,{...b,finalAmountKnown:false} as any,f,{...input,expectedAmountCents:'0'},due));
});
test('commission consumes exactly confirmed+7 or original maturity, including microseconds; pending never pays',()=>{
 const d={...duty,kind:'COMMISSION' as const,status:'MATURED',sourceRecordId:'501',admissionId:'admission-501',continuationVersionId:null,maturityAt:due},b={...basis,kind:'COMPLETED_COMMISSION_ADMISSION' as const,dutyKind:'COMMISSION' as const,sourceRecordId:'501',admissionId:'admission-501',evidenceId:'admission-501',continuationVersionId:null,effectiveHeadId:null,effectiveHeadRevision:null,sourceTimeKind:'COMPLETED_AT' as const,maturityAt:due,sourceRecordEntity:'la_distribution_order' as const,currentNetRefundCents:null},f={...funding,kind:'COMMISSION' as const,originalSourceEntity:'la_distribution_order' as const,originalSourceId:'501',originalSourceDigest:basis.sourceRecordDigest};
 const p=planLegacyDutyFinalization(d,b,f,input,due);assert.equal(p.lines[1]!.account,'WALLET_AVAILABLE');assert.equal(p.lines[0]!.account,'DISTRIBUTION_EXPENSE');
 assert.equal(verifyLegacyDutyFinalization(settled(d,p),actual(p)),'NONE');
 assert.doesNotThrow(()=>planLegacyDutyFinalization(d,{...b,sourceTimeKind:'MATURES_AT',sourceTime:due},f,input,due));
 assert.doesNotThrow(()=>planLegacyDutyFinalization(d,{...b,fundsDisposition:'UNKNOWN',netRefundKnown:false},f,input,due));
 for(const bad of [{...b,sourceTimeKind:'MATURES_AT' as const,sourceTime:at},{...b,maturityAt:'2026-10-15T00:00:00.000001Z'}])assert.throws(()=>planLegacyDutyFinalization(d,bad,f,input,due));
 assert.throws(()=>planLegacyDutyFinalization(d,b,f,input,'2026-10-08T00:00:00.000000Z'));assert.throws(()=>planLegacyDutyFinalization({...d,status:'PENDING'},b,f,input,due));
});
test('same ref id with another type/digest, reversed line, wrong subject or incomplete batch is UNKNOWN',()=>{
 const p=planLegacyDutyFinalization(duty,basis,funding,input,due),d=settled(duty,p),a=actual(p);
 for(const patch of [{settledRefType:'FINANCE_EVENT'},{settledRefDigest:'f'.repeat(64)},{counterpartyUserId:'other'},{revision:'4'}])assert.equal(verifyLegacyDutyFinalization({...d,...patch},a),'UNKNOWN');
 for(const lines of [p.lines.slice(1),p.lines.map(l=>({...l,debit:l.credit,credit:l.debit})),p.lines.map(l=>({...l,subject:'other'}))])assert.equal(verifyLegacyDutyFinalization(d,{...a,lines}),'UNKNOWN');
 assert.equal(verifyLegacyDutyFinalization(d,{...a,eventKind:'EARNING_PENDING'}),'UNKNOWN');
 assert.equal(verifyLegacyDutyFinalization({...d,settledBy:'LEGACY_RECORDS',settledRefType:null,settledRefId:null,settledRefDigest:null},a),'NONE');
});
test('posting intent never accepts caller-authored facts, funding, currency or extra fields',()=>{
 assert.equal(canonicalize(parseLegacyDutyPostingInput(input)),canonicalize(input));for(const extra of [{facts:basis},{funding},{currency:'CNY'},{approved:true}])assert.throws(()=>parseLegacyDutyPostingInput({...input,...extra}));
});
test('T final basis adapter binds explicit admission/command/head metadata; omitted fields never mean completed admission',()=>{
 const raw={state:'KNOWN',dutyId,orderId,kind:duty.kind,beneficiaryUserId:'renter',amountCents:'8200',currency:'CNY',revision:'2',parentSourceDigest:basis.parentSourceDigest,parentSourceId:'101',sourceRecordEntity:basis.sourceRecordEntity,sourceRecordDigest:basis.sourceRecordDigest,basisFactsDigest:basis.basisFactsDigest,effectiveFactsDigest:basis.evidenceDigest,basisEvidenceId:basis.evidenceId,continuationVersionId:'confirm-v1',admissionId:null,effectiveHeadId:'release-v2',effectiveHeadRevision:'2',sourceTimeKind:'CONFIRMED_AT',sourceTime:at,maturityAt:null,currentNetRefundCents:'8200',fundsDisposition:'AVAILABLE'};
 const known=legacyDutyBasisFromTrade(duty,raw);assert.equal(known.knowledge,'KNOWN');if(known.knowledge==='KNOWN')assert.equal(known.basis.kind,'CONFIRMED_CONTINUATION');
 for(const field of ['admissionId','continuationVersionId','effectiveHeadId','effectiveHeadRevision']){const bad={...raw} as any;delete bad[field];assert.equal(legacyDutyBasisFromTrade(duty,bad).knowledge,'UNKNOWN');}
 assert.equal(legacyDutyBasisFromTrade(duty,{...raw,admissionId:'foreign-admission'}).knowledge,'UNKNOWN');
 assert.throws(()=>planLegacyDutyFinalization(duty,basis,{...funding,originalSourceId:'999'},input,due));
});
test('own historical commission annotation verifies full positive/zero facts in one bounded page query, not a raw SETTLED label',async()=>{
 for(const amount of ['1234','0','999999999999999999999999']){
  const d={...duty,kind:'COMMISSION' as const,status:'MATURED',sourceRecordId:'501',admissionId:'admission-501',continuationVersionId:null,maturityAt:due,amountCents:amount},b={...basis,kind:'COMPLETED_COMMISSION_ADMISSION' as const,dutyKind:'COMMISSION' as const,sourceRecordId:'501',admissionId:'admission-501',evidenceId:'admission-501',continuationVersionId:null,effectiveHeadId:null,effectiveHeadRevision:null,sourceTimeKind:'COMPLETED_AT' as const,maturityAt:due,sourceRecordEntity:'la_distribution_order' as const,currentNetRefundCents:null,amountCents:amount},f={...funding,kind:'COMMISSION' as const,amountCents:amount,originalSourceEntity:'la_distribution_order' as const,originalSourceId:'501',originalSourceDigest:basis.sourceRecordDigest},p=planLegacyDutyFinalization(d,b,f,{...input,expectedAmountCents:amount},due),current=settled(d,p);
  const raw={...actual(p),duty_id:dutyId,event_id:p.eventId,root_id:p.rootId,event_kind:'LEGACY_DUTY_SETTLED',event_subject:'renter',ref_type:p.ref.type,ref_id:p.ref.id,facts_canonical:p.canonical,facts_digest:p.factDigest,root_kind:'LEGACY_CONTINUATION_DUTY',root_type:'LEGACY_CONTINUATION',root_system:'zzsh',root_entity:'legacy_order_duty',root_source:dutyId,root_subject:'renter',root_role:'COMMISSION',root_digest:p.factDigest,root_policy:null,basis_id:null,maturity:due,
   actual_duty:{id:dutyId,order_id:orderId,kind:'COMMISSION',source_record_id:'501',counterparty_user_id:'renter',amount_cents:amount,currency:'CNY',revision:current.revision,status:current.status,source:current.source,source_status:current.sourceStatus,continuation_version_id:null,admission_id:'admission-501',settled_by:'FINANCE',settled_ref_type:p.ref.type,settled_ref_id:p.ref.id,settled_ref_digest:p.ref.digest},actual_lines:p.lines.map(l=>({...l,details:{legacyDutyId:dutyId,legacyOrderId:orderId,legacyOrderNumber:f.originalOrderNumber,factsDigest:p.factDigest}}))};
  const queries:{sql:string;args:any[]}[]=[],client={query:async(sql:string,args:any[]=[])=>{queries.push({sql,args});return{rows:sql.includes('financial version')?[{version:'f'.repeat(32)}]:[raw]};}} as any;
  const result=await readLegacyCommissionFinance(client,'renter',['501']);assert.equal(result.get('501')?.knowledge,'KNOWN');assert.equal((result.get('501') as any).amountCents,amount);assert.equal((result.get('501') as any).zeroFinalization,amount==='0');assert.deepEqual(queries[0]!.args,['renter',['501']]);assert.match(queries[0]!.sql,/'amount_cents',d.amount_cents::text/);assert.equal(queries.length,1);
  assert.equal(await readLegacyCommissionFinanceVersion(client,'renter'),'f'.repeat(32));raw.root_digest='a'.repeat(64);await assert.rejects(readLegacyCommissionFinance(client,'renter',['501']),(e:any)=>e.status===503);
 }
 await assert.rejects(readLegacyCommissionFinance({query:async()=>{throw Error('must not query');}} as any,'renter',Array(51).fill('501')),(e:any)=>e.status===400);
});
