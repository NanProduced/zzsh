import {test} from 'node:test';import {strict as assert} from 'node:assert';import {createHash} from 'node:crypto';import type {Pool} from 'pg';import type {AppConfig} from '../src/config/config';import {canonicalize} from '../src/supply/content-hash';import {createNativeWithdrawalScope} from '../src/finance/native-withdrawal-resource';import {localWithdrawalRequestKey} from '../src/finance/controlled-withdrawal';import {readControlledWithdrawalQuote,createControlledWithdrawal} from '../src/finance/controlled-withdrawal-store';
import {createLocalDistributionRuntime} from '../src/finance/distribution-local-runtime';
import {createSandboxNativeWithdrawalScope} from '../src/finance/native-withdrawal-resource';
import {sandboxFixture,sandboxClient,sandboxResource} from './local-financial-sandbox-fixture';
import {readPersonalWallet} from '../src/finance/personal-finance-read';
function fixture(assembled=false,registered=false){
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),key=localWithdrawalRequestKey('admission','1','destination','1'),id='wd_'+hash(canonicalize(['user',key])).slice(0,40),payoutKey='controlled-withdrawal-'+hash(id),now=new Date('2026-10-05T01:00:00.000Z');
 const resource={oid:assembled?12345:869754,name:assembled?'zzsh_test_order_credit_admin_batch2':'zzsh_test_order_personal_finance',role:assembled?'zzsh_order_credit_admin_batch2_r':'zzsh_order_personal_finance_r',marker:'zzsh:order-reservation-test:v1',rolsuper:false,rolbypassrls:false,complete:true},config={profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',host:'127.0.0.1',port:55432,name:resource.name,user:resource.role}} as AppConfig,bindings=[{userId:'user',admissionId:'admission',destinationId:'destination',intentId:id,payoutKey}],scope=assembled?createLocalDistributionRuntime({config,resourceSet:'credit_admin_batch2',receipt:{database:resource.name,resourceOid:12345,owner:'zzsh',marker:resource.marker,migrationRole:'zzsh_order_credit_admin_batch2_m',runtimeRole:resource.role},approvalDigest:'a'.repeat(64),allowedOrderIds:['order'],payment:{appId:'app',merchantScopeId:'merchant'},withdrawalBindings:bindings}).auth.nativeWithdrawalScope!:createNativeWithdrawalScope({config,resourceSet:'personal_finance',resourceOid:869754,bindings}),actor={userId:'user',sessionId:'session',requestId:'request'},body={amountCents:'200',destinationId:'destination',policyVersion:'OWNER_LOCAL_RESTORED_20261003_v1_BANK_CARD',expectedWalletVersion:'9'};
 const sandbox=registered?sandboxFixture():undefined,sandboxBase=sandbox?sandboxClient(sandbox):undefined;
 const actualScope=sandbox?createSandboxNativeWithdrawalScope(sandbox):scope;
 const timing={now,bankRevision:'1'};
 if(registered)Object.assign(resource,{oid:sandboxResource.resourceOid,name:sandboxResource.database,role:sandboxResource.runtimeRole,marker:sandboxResource.marker});
 const destination:any={id:'destination',user_id:'user',admission_id:'admission',revision:'1',cohort_revision:'1',per_intent_cents:'200',max_intents:1,max_gross_cents:'200',admitted_at:new Date('2026-10-05T00:00:00Z'),expires_at:new Date('2026-10-05T02:00:00Z'),resource_oid:resource.oid,resource_name:resource.name,resource_marker:resource.marker,cohort_active:true,active:true,mode:'LOCAL_CONTROLLED',kind:'BANK_CARD',display_mask:'LOCAL_TEST_ONLY',sandbox_registration_ref:registered?'synthetic_daily_sandbox':null},sqls:string[]=[],ledger:any[][]=[];let row:any=null;
 if(registered)Object.assign(destination,{expires_at:Infinity,valid_until:new Date('2026-10-05T16:00:00.000Z'),bank_binding_revision:'1'});
 const pool={connect:async()=>({release(){},query:async(sql:string,args:any[]=[])=>{sqls.push(sql);
  // This fixture admits only controlled reserves; the global channel reservation source is not installed.
  if(sql.includes('/* wallet withdrawal amount schema */'))return{rows:[{controlled:true,channel:false}]};
  if(sandboxBase&&(sql.includes('local_financial_sandbox_registration')||sql.includes('AS "databaseName"')||sql.includes('AS "ownsBusinessSchema"')||sql.startsWith("SELECT set_config('max_parallel_workers_per_gather'")))return sandboxBase.query(sql,args);
  if(registered&&sql.startsWith("SELECT to_regclass('zzsh_order.withdrawal_intent')"))return{rows:[{complete:true}]};
  if(registered&&sql.startsWith('SELECT d.id FROM zzsh_order.withdrawal_destination'))return{rows:destination.id===args[0]&&destination.user_id===args[1]&&destination.admission_id===args[2]&&destination.sandbox_registration_ref===args[3]&&destination.resource_oid===args[4]&&destination.bank_binding_revision===timing.bankRevision?[{id:destination.id}]:[]};
  if(registered&&sql.startsWith('SELECT i.id FROM zzsh_order.withdrawal_intent'))return{rows:row&&row.id===args[0]&&row.user_id===args[1]&&row.admission_id===args[2]&&row.destination_id===args[3]&&row.payout_key===args[4]&&row.sandbox_registration_ref===args[5]?[{id:row.id}]:[]};
  if(sql.includes('FROM pg_database d JOIN pg_roles'))return{rows:[resource]};if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:false}],rowCount:1};if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return{rows:[{accountStatus:'ACTIVE'}]};if(sql.includes('FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};if(sql.includes("to_regclass('zzsh_order.rental_referral_earning')"))return{rows:[{installed:true}]};if(sql.includes('recovery_required_cents'))return{rows:[{count:'0',amount:'0',invalid:0}]};if(sql.includes('SELECT d.*,a.id AS cohort_id'))return{rows:[destination]};if(sql.startsWith('SELECT date_trunc'))return{rows:[{now:timing.now}]};
  if(sql.includes("to_regclass('zzsh_order.wallet_coverage')"))return{rows:[{ready:true}]};if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return{rows:[{id:'user'}],rowCount:1};if(sql.startsWith('SELECT c.origin,b.source_cutoff'))return{rows:[{origin:'NATIVE_GENESIS',coverageVersion:'1'}]};if(sql.startsWith('SELECT c.origin,b.source_kind'))return{rows:[{origin:'NATIVE_GENESIS',source_kind:'NATIVE_GENESIS',opening_amount:'0',covered_count:0}]};if(sql.startsWith('SELECT ledger_revision'))return{rows:[{ledgerRevision:'9',readRevision:'10',version:'9'}]};if(sql.includes('AS available'))return{rows:[{available:'1000',reserved:'0',pending:'0',refund:'0'}]};
  if(sql.startsWith('SELECT state,accepted_at')||sql.startsWith('SELECT 1 FROM zzsh_order.withdrawal_intent WHERE destination_id'))return{rows:[],rowCount:0};if(sql.includes('count(*)::int AS n,COALESCE(sum(gross_cents)'))return{rows:[{n:0,gross:'0'}]};if(sql.includes('FROM "zzsh_supply"."idempotency_record"'))return{rows:[]};
  if(sql.startsWith('INSERT INTO zzsh_order.withdrawal_intent')){row={id:args[0],user_id:args[1],admission_id:args[2],destination_id:args[3],policy_version:args[5],expected_ledger_revision:args[10],accepted_at:new Date(args[11]),gross_cents:args[7],net_cents:args[8],fee_cents:args[9],payout_key:args[12],economic_root_id:args[13],state:'RESERVED',operation_version:'1',funds_disposition:'RESERVED',terminal:null,lease_token_hash:null,conflict_digest:null,sandbox_registration_ref:args[14]??null};return{rows:[row]};}
  if(sql.startsWith('SELECT id,user_id,admission_id'))return{rows:row?[row]:[]};if(sql.startsWith('INSERT INTO zzsh_order.settlement_ledger_entry'))ledger.push(args);
  if(['BEGIN','COMMIT','ROLLBACK','SET CONSTRAINTS ALL IMMEDIATE'].includes(sql)||sql.startsWith('SELECT pg_advisory_xact_lock')||sql.startsWith('INSERT'))return{rows:[]};throw Error('Unexpected native reserve SQL: '+sql);
 }})} as unknown as Pool;return{pool,scope:actualScope,actor,body,key,id,payoutKey,destination,sqls,ledger,timing,get row(){return row;}};
}
test('valid native quote and fresh reserve reuse original fee, identity and ledger rules',async()=>{const f=fixture(),q=await readControlledWithdrawalQuote(f.pool,f.actor,f.body,f.scope);assert.equal(q.quote.requestKey,f.key);assert.equal(q.quote.feeCents,'100');assert.equal(q.quote.netCents,'100');assert.equal(q.quote.globalWithdrawable,'UNKNOWN');const c=await f.pool.connect();try{const wallet=await readPersonalWallet(c,f.actor.userId);assert.equal(wallet.withdrawable.knowledge,'UNKNOWN');assert.equal(wallet.withdrawable.amountCents,null);assert.deepEqual(wallet.withdrawable.reasonCodes,['WITHDRAWAL_RESERVATION_SOURCE_NOT_INSTALLED']);}finally{c.release();}const r=await createControlledWithdrawal(f.pool,f.actor,f.body,f.key,f.scope);assert.equal(r.replayed,false);assert.equal(f.row.id,f.id);assert.equal(f.row.payout_key,f.payoutKey);assert.deepEqual(f.ledger.map(v=>[v[3],v[4],v[5]]),[['WALLET_AVAILABLE','200','0'],['WALLET_RESERVED','0','200']]);});
test('allowed subject does not authorize a different destination/cohort tuple',async()=>{const f=fixture();f.destination.admission_id='foreign';await assert.rejects(readControlledWithdrawalQuote(f.pool,f.actor,f.body,f.scope),/DESTINATION_NOT_ADMITTED/);assert(!f.sqls.some(s=>s.startsWith('INSERT')));});
test('native quote rejects wrong live cohort resource despite a matching configured id',async()=>{const f=fixture();f.destination.resource_oid=833000;await assert.rejects(readControlledWithdrawalQuote(f.pool,f.actor,f.body,f.scope),/CONTROLLED_LOCAL_ADMISSION_UNAVAILABLE/);assert(!f.sqls.some(s=>s.startsWith('INSERT')));});
test('the complete explicit distribution assembly reaches the existing known-wallet quote and 200-cent reservation without fabricating global withdrawable',async()=>{
 const f=fixture(true),quote=await readControlledWithdrawalQuote(f.pool,f.actor,f.body,f.scope);
 assert.equal(quote.quote.grossCents,'200');assert.equal(quote.quote.globalWithdrawable,'UNKNOWN');assert.equal(quote.quote.scope,'LOCAL_CONTROLLED');
 const result=await createControlledWithdrawal(f.pool,f.actor,f.body,f.key,f.scope),body=result.body as {intent:{amountCents:string;evidenceLevel:string}};
 assert.equal(body.intent.amountCents,'200');assert.equal(body.intent.evidenceLevel,'LOCAL_CONTROLLED');
 assert.deepEqual(f.ledger.map(v=>[v[3],v[4],v[5]]),[['WALLET_AVAILABLE','200','0'],['WALLET_RESERVED','0','200']]);
});

test('registered daily environment reuses the same real quote/reserve kernel without a global fixture binding list',async()=>{
 const f=fixture(false,true),q=await readControlledWithdrawalQuote(f.pool,f.actor,f.body,f.scope);
 assert.equal(q.quote.requestKey,f.key);assert.equal(q.quote.feeCents,'100');assert.equal(q.quote.netCents,'100');
 const r=await createControlledWithdrawal(f.pool,f.actor,f.body,f.key,f.scope);
 assert.equal(r.status,200);assert.equal(f.row.sandbox_registration_ref,'synthetic_daily_sandbox');assert.equal(f.row.payout_key,f.payoutKey);
 assert.deepEqual(f.ledger.map(v=>[v[3],v[4],v[5]]),[['WALLET_AVAILABLE','200','0'],['WALLET_RESERVED','0','200']]);
});
test('registered scope rejects old/cross-registration targets before ledger/reserve work',async()=>{
 for(const changed of [{sandbox_registration_ref:null},{sandbox_registration_ref:'foreign'},{resource_oid:2220718},{user_id:'other'}]){
  const f=fixture(false,true);Object.assign(f.destination,changed);
  await assert.rejects(createControlledWithdrawal(f.pool,f.actor,f.body,f.key,f.scope));
  assert.equal(f.row,null);assert.equal(f.ledger.length,0);assert(!f.sqls.some(sql=>sql.startsWith('INSERT')));
 }
});
test('new registered reserves require an unexpired/current bank snapshot without adding an execution expiry to an accepted target',async()=>{
 for(const expired of [true,false]){const f=fixture(false,true);if(expired)f.timing.now=new Date('2026-10-05T16:00:00.000Z');else f.timing.bankRevision='2';
  await assert.rejects(createControlledWithdrawal(f.pool,f.actor,f.body,f.key,f.scope));assert.equal(f.row,null);assert.equal(f.ledger.length,0);}
 const f=fixture(false,true);await createControlledWithdrawal(f.pool,f.actor,f.body,f.key,f.scope);
 assert.equal(f.destination.expires_at,Infinity);assert.equal(f.row.destination_id,'destination');assert.equal(f.row.funds_disposition,'RESERVED');
});


