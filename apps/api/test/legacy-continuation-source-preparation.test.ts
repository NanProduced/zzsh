import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {canonicalize} from '../src/supply/content-hash';
import {sha256Hex,conflict} from '../src/supply/supply-util';
import {legacyOwnerUserId} from '../src/supply/legacy-user-migration';
import {legacyAccountId} from '../src/legacy-load/legacy-account-seam';
import {assembleLegacyContinuationBatch,type LegacyInflightCurrentFacts,type LegacyInflightIdentityFact,type LegacyInflightSourceReceipt,type LegacyInflightSourcePacket,type LegacyInflightCurrentPacket,type LegacyInflightImportCommand,type LegacyInflightRegisterCommand} from '../src/order/legacy-continuation-source-preparation';
import {initialLegacyFacts,sealLegacyFacts,projectLegacyContinuation,type LegacyContinuationActor,type LegacyEvidenceRow,type LegacyDutyRow} from '../src/order/legacy-continuation-model';
import {planLegacyContinuation} from '../src/order/legacy-continuation-calc';
import {importLegacyContinuationEvidence} from '../src/order/legacy-continuation-evidence';
import {registerLegacyInflight,type LegacyInflightRegisterInput} from '../src/order/legacy-liability-intake';
import {legacySource} from './legacy-continuation-fixture';

type Raw=Record<string,unknown>;
type Input=Parameters<typeof assembleLegacyContinuationBatch>[0];
const hash=(x:unknown)=>sha256Hex(canonicalize(x)),uid=(id:string)=>legacyOwnerUserId('legacy_mysql_restore','la_user',id),aid=(id:string)=>legacyAccountId('legacy_mysql_restore','la_rental_accounts',id);
const orderId=(id:string)=>'legacy_order_'+sha256Hex(JSON.stringify(['legacy_mysql_restore','la_order',id])).slice(0,40);
const setDigest=(rows:Raw[],key:(r:Raw)=>string)=>hash(rows.map(r=>[key(r),hash(r)]).sort((a,b)=>a[0]!<b[0]!?-1:a[0]!>b[0]!?1:0));
const who:LegacyContinuationActor={realm:'admin',userId:'fixture_admin',sessionId:'fixture_session',requestId:'fixture_request'};
function identity(id:string):LegacyInflightIdentityFact{const sourceDigest=sha256Hex('fixture_identity_'+id);return{userId:uid(id),legacyId:id,sourceDigest,provider:'legacy_mysql_restore',providerReference:'la_user:'+id,audit:{id:'fixture_audit_'+id,objectId:uid(id),action:'user.legacy_owner.migrated',outcome:'SUCCESS',details:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',legacyId:id,sourceDigest}}};}
function commission(id:string,parent:string,beneficiary:string):Raw{return{id,order_id:parent,user_id:beneficiary,status:'1',is_delete:'0',order_type:'1',level:'2',ratio:'10.00',earnings:'1.00',create_time:'1',update_time:'1',settle_time:'2'};}
type Fixture={input:Input;members:Raw[];parameters:Raw[];pending:Raw[];policy:ReturnType<typeof legacySource>['policy'];facts:LegacyInflightCurrentFacts};
function reseal(f:Fixture){
  const texts={members:JSON.stringify(f.members),parameters:f.parameters.map(r=>JSON.stringify(r)).join('\n')+'\n',policy:JSON.stringify(f.policy),pendingCommissions:JSON.stringify(f.pending)};
  const receipt:LegacyInflightSourceReceipt={schema:'legacy-inflight-source.v1',sourceSystem:'legacy_mysql_restore',cutoff:'2026-09-13T13:31:22.123456Z',evidenceRef:'FIXTURE_REVIEWED_SOURCE',extracts:{members:{sha256:sha256Hex(texts.members),rows:f.members.length},parameters:{sha256:sha256Hex(texts.parameters),rows:f.parameters.length},policy:{sha256:sha256Hex(texts.policy),rows:1},pendingCommissions:{sha256:sha256Hex(texts.pendingCommissions),rows:f.pending.length}},memberSetDigest:setDigest(f.members,r=>(r.source as Raw).id as string),pendingSetDigest:setDigest(f.pending,r=>r.id as string),pendingScope:{entity:'la_distribution_order',status:'1',isDelete:'0',orderTypes:'ALL_SOURCE_TYPES'}};
  f.input.source={receipt,admittedReceiptDigests:[hash(receipt)],texts};
  if(f.input.current!==null){const json=JSON.stringify(f.facts),r={schema:'legacy-inflight-current.v1' as const,databaseOid:952624,principalId:who.userId,observedAt:'2026-10-18T05:00:00.123456Z',sourceReceiptDigest:hash(receipt),factsSha256:sha256Hex(json),scopeLegacyIds:f.members.map(r=>(r.source as Raw).id as string)};f.input.current={receipt:r,admittedReceiptDigests:[hash(r)],json};}
}
function fixture(large=false):Fixture{
  const members:Raw[]=[],parameters:Raw[]=[],pending:Raw[]=[],facts:LegacyInflightCurrentFacts={parents:[],identities:[identity('11'),identity('22')],accounts:[],registers:[],receipts:[]},policy=legacySource().policy;
  const count=large?519:3;
  for(let i=0;i<count+1;i++){
    const id=String(1000+i),account=String(50000+i),stage=large?(i===152||i===153||i===513||i===514?'8':i===154||i===155||i>=515&&i<519?'9':'3'):(['3','8','9','3'][i]!);
    const s=legacySource({legacyOrderId:id,accountId:account,orderStatus:stage,detainMoney:'0.00',saleEarnings:stage==='3'?null:'10.00',returnOrderMoney:stage==='3'?null:'87.00'});
    s.paidPay=[{id:String(40000+i),payOrderSn:'FIXTURE_PAY_'+id,payMoney:s.payMoney!}];
    const o:Record<string,string|null>={id,pay_is:'1',order_status:stage,is_settle:s.isSettle,user_id:s.renterId,sale_user_id:s.ownerId,accounts_id:account,profit_dot:s.profitDot,pay_money:s.payMoney,commission_money:s.storedCommissionMoney,deposit_amount:s.depositAmount,detain_money:s.detainMoney,return_order_money:s.returnOrderMoney,sale_earnings:s.saleEarnings,full_payout_money:s.fullPayoutMoney,is_advance_set:s.isAdvanceSet};
    const snapshot={...o,goods_money:s.goodsMoney},isolated=i===count;
    const cs:Raw[]=[];if(!isolated&&(large?i<156:i===0)){const n=large&&(i<5||i===154)?2:1;for(let j=0;j<n;j++){const c=commission(String(10000+pending.length),id,String(3000+pending.length%42));cs.push(c);pending.push(c);}}
    const projected=cs.map(c=>({id:c.id,beneficiaryId:c.user_id,ratio:c.ratio,level:c.level,status:c.status,storedEarnings:c.earnings}));
    const {policy:_policy,...raw}=s;parameters.push({...raw,commissions:cs.length?projected:null});
    const pay=s.paidPay[0]!;members.push({source:o,originalOrderSnapshot:snapshot,baseBot:s.baseBot,target:isolated?null:{legacy_id:id},ownerTarget:uid('22'),renterTarget:isolated?null:uid('11'),accountTarget:aid(account),quarantine:isolated?{reason:'PARTY_MOBILE_DUPLICATE'}:null,paidPayOrders:[{id:pay.id,order_id:id,order_type:'1',pay_is:'1',pay_money:pay.payMoney,pay_order_sn:pay.payOrderSn}]});
    facts.accounts.push({accountId:aid(account),legacyId:account,ownerUserId:uid('22'),gameId:'fixture_game'});
    if(!isolated)facts.parents.push({binding:{id:orderId(id),legacyId:id,accountId:aid(account),legacyAccountId:account,gameId:'fixture_game',ownerUserId:uid('22'),renterUserId:uid('11'),legacyOwnerId:'22',legacyRenterId:'11',ownerSourceDigest:identity('22').sourceDigest,renterSourceDigest:identity('11').sourceDigest,sourceDigest:hash(snapshot),sourceOrderStatus:Number(stage),sourcePayStatus:1,paidCents:'10000'},sourceSnapshot:snapshot,sourceEvidence:null,head:null,duties:[]});
  }
  for(const id of new Set(pending.map(c=>c.user_id as string)))facts.identities.push(identity(id));
  if(large)for(let i=0;i<208;i++)pending.push(commission(String(20000+i),String(900000+i),'3000'));
  const f={members,parameters,pending,policy,facts,input:{batchId:'FIXTURE_INFLIGHT',targetDatabaseOid:952624,principalId:who.userId,source:null as unknown as LegacyInflightSourcePacket,current:{} as LegacyInflightCurrentPacket}};reseal(f);return f;
}
const result=(f:Fixture)=>assembleLegacyContinuationBatch(f.input);
const importCommand=(f:Fixture,index=0)=>{const c=result(f).rows[index]!.command;assert(c?.kind==='SOURCE_IMPORT');return c;};

test('synthetic full520 closes519+1,156+363,162 pending and42 beneficiaries through real preparation',()=>{
  const f=fixture(true),b=result(f);assert(b.conserved);assert.equal(b.writeAllowed,false);assert.deepEqual(b.counts,{READY:520,REPLAY_ONLY:0,MISSING_FACT:0,CONFLICT:0});
  assert.deepEqual(b.denominators,{parents:520,mapped:519,isolated:1,prepared:519,pendingCommissionParents:156,pendingCommissions:162,pendingBeneficiaries:42,provenEmptyPendingParents:363});
  assert.equal(b.rows.filter(r=>r.command?.kind==='SOURCE_IMPORT').length,519);assert.equal(b.rows.filter(r=>r.command?.kind==='INFLIGHT_REGISTER').length,1);
  assert(b.rows.flatMap(r=>r.duties).every(d=>d.status==='PENDING'&&d.maturityAt===null));assert(b.commissionScope.includes('NO_ASSERTION_ABOUT_STATUS2_OR3'));
  f.input.current=null;f.input.principalId=null;const sourceOnly=result(f);assert.equal(sourceOnly.rows.length,520);assert.equal(sourceOnly.denominators.prepared,519);assert.equal(sourceOnly.counts.MISSING_FACT,520);assert(sourceOnly.rows.every(r=>!r.command));
});
test('full pending provenance, raw files and reverse member sets cannot self-certify with a flag or changed SHA',()=>{
  for(const mutate of [(f:Fixture)=>{f.input.source.texts.pendingCommissions='[]';},(f:Fixture)=>{f.input.source.receipt.extracts.pendingCommissions.sha256=sha256Hex('[]');},(f:Fixture)=>{f.input.source.receipt.pendingScope.orderTypes='1' as never;},(f:Fixture)=>{f.input.source.receipt.extracts.members.rows--;}]){const f=fixture();mutate(f);assert.throws(()=>result(f));}
  const missing=fixture();missing.parameters.pop();reseal(missing);assert.throws(()=>result(missing),/PARAMETER_MEMBER_SET_MISMATCH/);
  const duplicate=fixture();duplicate.parameters.push(duplicate.parameters[0]!);reseal(duplicate);assert.throws(()=>result(duplicate),/DUPLICATE_SOURCE_KEY/);
});
test('null pending means proven empty only in complete typed pending scope; missing/null rows never hide a pending record',()=>{
  const f=fixture();assert(result(f).rows[1]!.prepared?.emptyPendingProven);f.parameters[0]!.commissions=null;reseal(f);const b=result(f);assert.equal(b.rows[0]!.state,'CONFLICT');assert.deepEqual(b.rows[0]!.reasons,['PENDING_COMMISSION_COVERAGE_MISMATCH']);assert.equal(b.rows[1]!.state,'READY');
  const missing=fixture();missing.pending=[];reseal(missing);assert.equal(result(missing).rows[0]!.state,'CONFLICT');
  const typed=fixture();typed.pending.push({...typed.pending[0],id:'99100',order_id:(typed.members[1]!.source as Raw).id,order_type:'2'});reseal(typed);assert.equal(result(typed).rows[1]!.state,'READY');assert.equal(result(typed).rows[1]!.prepared!.source.commissions.length,0);
  const terminal=fixture();(terminal.parameters[1]!.commissions as unknown)=[{id:'99101',beneficiaryId:'3000',level:'2',ratio:'10.00',status:'2',storedEarnings:'1.00'}];reseal(terminal);assert.equal(result(terminal).rows[1]!.state,'CONFLICT');assert(!result(terminal).rows[1]!.command);
});
test('raw commission identity, original payment, policy and parent source mismatches isolate one parent',()=>{
  for(const mutate of [(f:Fixture)=>{(f.parameters[0]!.commissions as Raw[])[0]!.beneficiaryId='999';},(f:Fixture)=>{(f.parameters[0]!.commissions as Raw[])[0]!.storedEarnings='2.00';},(f:Fixture)=>{(f.parameters[0]!.paidPay as Raw[])[0]!.payOrderSn='WRONG';},(f:Fixture)=>{f.parameters[0]!.profitDot='3';},(f:Fixture)=>{f.parameters[0]!.policy={...f.policy,advanceOrderSetRatio:'70'};}]){const f=fixture();mutate(f);reseal(f);const b=result(f);assert.equal(b.rows[0]!.state,'CONFLICT');assert.equal(b.rows[1]!.state,'READY');}
  const badTime=fixture();badTime.pending[0]!.create_time='9999999999';reseal(badTime);assert.throws(()=>result(badTime),/PENDING_SOURCE_TIME_UNPROVEN/);
  const payKey=fixture(),first=(payKey.parameters[0]!.paidPay as Raw[])[0]!.id;(payKey.parameters[1]!.paidPay as Raw[])[0]!.id=first;(payKey.members[1]!.paidPayOrders as Raw[])[0]!.id=first;reseal(payKey);assert.equal(result(payKey).rows[0]!.state,'CONFLICT');assert.equal(result(payKey).rows[1]!.state,'CONFLICT');assert.equal(result(payKey).rows[2]!.state,'READY');
  const numericType=fixture();numericType.pending[0]!.order_type=1;reseal(numericType);assert.throws(()=>result(numericType),/PENDING_SOURCE_TYPE_OR_STATUS_MISMATCH/);
  const incompletePolicy=fixture();delete incompletePolicy.policy.expend.armorSale;reseal(incompletePolicy);assert.throws(()=>result(incompletePolicy),/SOURCE_POLICY_INCOMPLETE/);
});
test('current target receipt/resource/scope, identity audits, cents and source digest are required before any command',()=>{
  const f=fixture();f.input.current!.receipt.databaseOid=931888;assert.throws(()=>result(f));
  for(const mutate of [(x:Fixture)=>{x.facts.parents[0]!.binding.paidCents='9999';},(x:Fixture)=>{x.facts.parents[0]!.sourceSnapshot.goods_money='11.00';x.facts.parents[0]!.binding.sourceDigest=hash(x.facts.parents[0]!.sourceSnapshot);},(x:Fixture)=>{x.facts.identities.find(i=>i.legacyId==='11')!.audit.details.sourceDigest='0'.repeat(64);},(x:Fixture)=>{x.facts.accounts[0]!.ownerUserId=uid('999');}]){const x=fixture();mutate(x);reseal(x);assert.equal(result(x).rows[0]!.state,'CONFLICT');assert.equal(result(x).rows[0]!.command,null);}
  const beneficiary=fixture();beneficiary.facts.identities=beneficiary.facts.identities.filter(i=>i.legacyId!=='3000');reseal(beneficiary);const row=result(beneficiary).rows[0]!;assert.equal(row.state,'MISSING_FACT');assert.equal(row.command,null);assert.equal(row.duties.length,0);
});
test('source cutoff retains microseconds and insuranceDAY quantity; source input order does not change command key/body',()=>{
  const f=fixture();(f.parameters[0]!.quantities as Raw).card='4';reseal(f);const a=importCommand(f);assert.equal(a.body.sourceAsOf,'2026-09-13T13:31:22.123456Z');assert.equal(a.body.source.quantities.card,'4');assert.equal(a.body.source.policy.advanceOrderSetRatio,f.policy.advanceOrderSetRatio);
  f.pending.reverse();f.members.reverse();f.parameters.reverse();reseal(f);const b=importCommand(f);assert.deepEqual(a,b);assert.equal(a.body.sourceAsOf.endsWith('123456Z'),true);
});
test('prepared source reads3/8/9 without head; only opposing party confirms, staff cannot confirm',()=>{
  const f=fixture(),b=result(f);for(let i=0;i<3;i++){const command=b.rows[i]!.command as LegacyInflightImportCommand,body=command.body,binding=f.facts.parents[i]!.binding,facts=initialLegacyFacts(body.source,body.commissionEvidence),sealed=sealLegacyFacts(facts),row:LegacyEvidenceRow={id:'fixture_evidence_'+i,orderId:binding.id,evidenceVersion:'1',sourceKind:'SOURCE_IMPORT',sourceDigest:binding.sourceDigest,factsCanonical:sealed.canonical,factsDigest:sealed.digest,facts};
    const role=i===1?'owner':'renter',userId=role==='owner'?binding.ownerUserId:binding.renterUserId,view=projectLegacyContinuation(binding,{realm:'user',userId,sessionId:'fixture',requestId:'fixture'},row,null,[]);assert.equal(view.availability,'KNOWN');assert.equal(view.revision,null);assert(view.capabilities.includes(i===0?'propose':'confirm'));
    if(i){const plan=planLegacyContinuation(facts.evidence,{kind:'confirm',caller:{role,legacyUserId:role==='owner'?'22':'11'}});assert(plan.ok);assert.equal(plan.nextStatus,'4');const admin=planLegacyContinuation(facts.evidence,{kind:'confirm',caller:{role:'admin',legacyUserId:''}});assert(!admin.ok);assert.equal(admin.code,'STAFF_CANNOT_CONFIRM');}}
});

const auth:typeof import('../src/auth/auth-security')=require('../src/auth/auth-security');
const authorization:typeof import('../src/auth/admin-authorization')=require('../src/auth/admin-authorization');
function allowImport(t:TestContext){let allowed=true;t.mock.method(auth,'assertAdminContextInTransaction',async()=>{if(!allowed)throw conflict('FIXTURE_SESSION_REVOKED');});t.mock.method(authorization,'loadEffectiveAdminAccess',async()=>({status:'ACTIVE',isBoss:true,passwordChangeRequired:false,permissions:new Set(['supply.catalog.manage','order.read'])}));return()=>{allowed=false;};}
function importClient(f:Fixture,command:LegacyInflightImportCommand){
  const parent=f.facts.parents.find(p=>p.binding.id===command.resourceId)!,calls:{sql:string;v:unknown[]}[]=[],records=new Map<string,{requestFingerprint:string;responseStatus:number;responseBody:unknown;publishRequired:boolean}>();let evidence:LegacyEvidenceRow|null=null,audits=0,beneficiaryPresent=true;const duties:LegacyDutyRow[]=[];
  const client={query:async(sql:string,v:unknown[]=[])=>{calls.push({sql,v});let rows:unknown[]=[];
    if(sql.includes('FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1'))rows=[parent.binding];
    else if(sql.includes('FROM "zzsh_supply"."idempotency_record"')){const x=records.get(JSON.stringify(v.slice(0,2)));if(x)rows=[x];}
    else if(sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))records.set(JSON.stringify(v.slice(0,2)),{requestFingerprint:v[2] as string,responseStatus:v[3] as number,responseBody:JSON.parse(v[4] as string),publishRequired:false});
    else if(sql.includes('FROM zzsh_order.legacy_continuation_evidence'))rows=evidence?[evidence]:[];
    else if(sql.includes('INSERT INTO zzsh_order.legacy_continuation_evidence'))evidence={id:v[0] as string,orderId:v[1] as string,evidenceVersion:'1',sourceKind:'SOURCE_IMPORT',sourceDigest:v[4] as string,facts:JSON.parse(v[8] as string),factsCanonical:v[9] as string,factsDigest:v[10] as string};
    else if(sql.includes('SELECT 1 FROM zzsh_iam.user_identity_state'))rows=beneficiaryPresent?[{}]:[];
    else if(sql.includes('FROM zzsh_order.legacy_order_duty'))rows=v.length>1?duties.filter(d=>d.sourceRecordId===v[1]):duties;
    else if(sql.includes('INSERT INTO zzsh_order.legacy_order_duty('))duties.push({id:v[0] as string,orderId:v[1] as string,continuationVersionId:null,kind:'COMMISSION',sourceRecordId:v[2] as string,counterpartyUserId:v[3] as string,amountCents:v[4] as string,currency:'CNY',status:'PENDING',source:'LEGACY_IMPORT',sourceStatus:'1',level:v[5] as string,ratio:v[6] as string,maturityAt:v[7] as null,revision:'1',settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null});
    if(/INSERT INTO[^\n]*audit_event/.test(sql))audits++;return{rows,rowCount:rows.length};}} as unknown as PoolClient;
  return{client,calls,duties,records,get evidence(){return evidence;},get audits(){return audits;},setBeneficiary(present:boolean){beneficiaryPresent=present;}};
}
test('real SOURCE_IMPORT matches prepared key/fingerprint, writes no head, empty parents still import; replay and body409 preserve one audit',async t=>{
  const revoke=allowImport(t);for(const index of [0,1]){const f=fixture(),command=importCommand(f,index),p=importClient(f,command),first=await importLegacyContinuationEvidence(p.client,who,command.body);assert.equal(first.status,200);assert(p.evidence);assert.equal(p.evidence.sourceKind,'SOURCE_IMPORT');assert.equal(p.duties.length,index===0?1:0);assert(p.duties.every(d=>d.maturityAt===null));assert(!p.calls.some(q=>q.sql.includes('INSERT INTO zzsh_order.legacy_continuation_version')));
    const receipt=p.records.get(JSON.stringify([command.scopeKey,command.idempotencyKey]));assert(receipt);assert.equal(receipt.requestFingerprint,command.fingerprint);assert.equal(p.audits,1);
    const second=await importLegacyContinuationEvidence(p.client,who,command.body);assert(second.replayed);assert.deepEqual(second.body,first.body);assert.equal(p.audits,1);
    await assert.rejects(()=>importLegacyContinuationEvidence(p.client,who,{...command.body,evidenceRef:'CHANGED_BODY'}),e=>e instanceof Error&&e.message.includes('Idempotency key'));assert.equal(p.audits,1);
    if(index===1){revoke();await assert.rejects(()=>importLegacyContinuationEvidence(p.client,who,command.body),/FIXTURE_SESSION_REVOKED/);}}
});
test('missing-beneficiary writer trap is reproduced: successful replay does not backfill duty; assembler blocks parent first',async t=>{
  allowImport(t);const f=fixture(),command=importCommand(f),p=importClient(f,command);p.setBeneficiary(false);const first=await importLegacyContinuationEvidence(p.client,who,command.body);assert.equal((first.body as {isolated:unknown[]}).isolated.length,1);assert.equal(p.duties.length,0);p.setBeneficiary(true);assert((await importLegacyContinuationEvidence(p.client,who,command.body)).replayed);assert.equal(p.duties.length,0);
  f.facts.identities=f.facts.identities.filter(i=>i.legacyId!=='3000');reseal(f);assert.equal(result(f).rows[0]!.command,null);
});
test('existing success only prepares original-principal replay; changed receipt/body, partial old import and source conflict refuse',async t=>{
  allowImport(t);const f=fixture(),command=importCommand(f),p=importClient(f,command);const applied=await importLegacyContinuationEvidence(p.client,who,command.body);f.facts.parents[0]!.sourceEvidence=p.evidence;f.facts.parents[0]!.duties=p.duties;f.facts.receipts=[{principalId:who.userId,operation:command.operation,resourceId:command.resourceId,key:command.idempotencyKey,fingerprint:command.fingerprint,responseStatus:200,responseBody:applied.body as {evidenceId:string}}];reseal(f);assert.equal(result(f).rows[0]!.state,'REPLAY_ONLY');
  f.facts.receipts[0]!.responseBody.isolated=[{}];reseal(f);assert.equal(result(f).rows[0]!.command,null);delete f.facts.receipts[0]!.responseBody.isolated;
  f.facts.receipts[0]!.principalId='another_admin';reseal(f);assert.equal(result(f).rows[0]!.state,'CONFLICT');
  const changed=structuredClone(command.body);changed.source.depositAmount='58.00';await assert.rejects(()=>importLegacyContinuationEvidence(p.client,who,changed),/SOURCE_EVIDENCE_CONFLICT/);
});
test('isolated1 uses real register contract, deterministic replay and no SOURCE_IMPORT receipt or fabricated renter',async t=>{
  allowImport(t);const f=fixture(),c=result(f).rows.at(-1)!.command;assert(c?.kind==='INFLIGHT_REGISTER');const a=f.facts.accounts.at(-1)!;let prior:LegacyInflightRegisterInput|null=null,audits=0;
  const client={query:async(sql:string,v:unknown[]=[])=>{let rows:unknown[]=[];if(sql.includes('FROM zzsh_supply.rental_account'))rows=[{gameId:a.gameId,owner:a.ownerUserId}];if(sql.includes('FROM zzsh_order.legacy_inflight_register'))rows=prior?[{source:prior}]:[];if(sql.includes('INSERT INTO zzsh_order.legacy_inflight_register'))prior={legacyId:v[1] as string,accountId:v[2] as string,ownerUserId:v[3] as string,renterUserId:v[4] as null,sourceOrderStatus:v[5] as number,sourcePayStatus:1,sourceDigest:v[6] as string,evidenceRef:v[7] as string,disposition:v[8] as 'ISOLATED_PARTY',reason:v[9] as string};if(/INSERT INTO[^\n]*audit_event/.test(sql))audits++;assert(!sql.includes('idempotency_record'));return{rows,rowCount:rows.length};}} as unknown as PoolClient;
  const first=await registerLegacyInflight(client,who,c.body);assert.equal(first.registerId,c.registerId);assert.equal(c.body.renterUserId,null);assert.equal(c.body.disposition,'ISOLATED_PARTY');assert((await registerLegacyInflight(client,who,c.body)).replayed);assert.equal(audits,1);await assert.rejects(()=>registerLegacyInflight(client,who,{...c.body,reason:'CHANGED'}),/INFLIGHT_SOURCE_CONFLICT/);
  f.facts.registers=[{legacyId:c.body.legacyId,source:c.body}];reseal(f);assert.equal(result(f).rows.at(-1)!.state,'REPLAY_ONLY');
});
