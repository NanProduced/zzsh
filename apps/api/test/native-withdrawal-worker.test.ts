import {test} from 'node:test';import {strict as assert} from 'node:assert';import {createHash} from 'node:crypto';import type {Pool} from 'pg';import type {AppConfig} from '../src/config/config';import {runControlledWithdrawalStep,queryOriginalControlledPayout,submitDeclaredControlledPayout} from '../src/finance/controlled-withdrawal-worker';import {createNativeWithdrawalScope} from '../src/finance/native-withdrawal-resource';
import {createSandboxNativeWithdrawalScope} from '../src/finance/native-withdrawal-resource';
import {sandboxFixture,sandboxClient} from './local-financial-sandbox-fixture';
function fixture(registered=false){
 const resource={oid:869754,name:'zzsh_test_order_personal_finance',role:'zzsh_order_personal_finance_r',marker:'zzsh:order-reservation-test:v1',rolsuper:false,rolbypassrls:false,complete:true},config={profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',host:'127.0.0.1',port:55432,name:resource.name,user:resource.role}} as AppConfig;
 const row:any={id:'intent',user_id:'user',admission_id:'admission',destination_id:'destination',payout_key:'payout',policy_version:'OWNER_LOCAL_RESTORED_20261003_v1_BANK_CARD',expected_ledger_revision:'9',accepted_at:new Date(),gross_cents:'200',net_cents:'100',fee_cents:'100',economic_root_id:'root',state:'RESERVED',operation_version:'1',funds_disposition:'RESERVED',terminal:null,conflict_digest:null,lease_token_hash:null,lease_until:null,scenario:'FAIL_UNPAID'};
 const scope=createNativeWithdrawalScope({config,resourceSet:'personal_finance',resourceOid:869754,bindings:[{userId:'user',admissionId:'admission',destinationId:'destination',intentId:'intent',payoutKey:'payout'}]}),sqls:string[]=[],ledger:any[][]=[],events:any[][]=[];let operation:any=null;const facts=new Map<string,any>();
 const sandbox=registered?sandboxFixture():undefined,capIdentity={active:true},sandboxBase=sandbox?sandboxClient(sandbox,{identity:capIdentity}):undefined;
 const actualScope=sandbox?createSandboxNativeWithdrawalScope(sandbox):scope;
 if(registered){row.sandbox_registration_ref='synthetic_daily_sandbox';row.scenario='TIMEOUT_THEN_SUCCEED';}
 const pool={connect:async()=>({release(){},query:async(sql:string,args:any[]=[])=>{sqls.push(sql);assert(!sql.includes('rental_referral_earning'),'Original worker release must not run a debt gate');
  if(sandboxBase&&(sql.includes('local_financial_sandbox_registration')||sql.includes('AS "databaseName"')||sql.includes('AS "ownsBusinessSchema"')))return sandboxBase.query(sql,args);
  if(registered&&sql.startsWith("SELECT to_regclass('zzsh_order.withdrawal_intent')"))return{rows:[{complete:true}]};
  if(registered&&sql.startsWith('SELECT i.id FROM zzsh_order.withdrawal_intent'))return{rows:row.id===args[0]&&row.user_id===args[1]&&row.admission_id===args[2]&&row.destination_id===args[3]&&row.payout_key===args[4]&&row.sandbox_registration_ref===args[5]?[{id:row.id}]:[]};
  if(sql.includes('FROM pg_database d JOIN pg_roles'))return{rows:[resource]};if(sql.startsWith('SELECT user_id'))return{rows:[{user_id:row.user_id}]};if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return{rows:[{id:row.user_id}]};if(sql.startsWith('SELECT * FROM zzsh_order.withdrawal_intent')||sql.startsWith('SELECT i.*,d.scenario'))return{rows:[row]};if(sql.startsWith('SELECT id,user_id,admission_id'))return{rows:[{...row,version:String(row.operation_version)}]};
  if(sql.startsWith('SELECT date_trunc'))return{rows:[{now:new Date()}]};if(sql.startsWith('SELECT ledger_revision'))return{rows:[{version:'9'}]};if(sql.startsWith('SELECT evidence_digest'))return{rows:facts.has(args[1])?[facts.get(args[1])]:[]};
  if(sql.includes('FROM zzsh_order.controlled_payout_operation'))return{rows:operation?[operation]:[]};if(sql.startsWith('INSERT INTO zzsh_order.controlled_payout_operation')){operation={id:args[0],intent_id:args[1],payout_key:args[2],final_evidence_canonical:args[4],final_evidence_digest:args[5]};return{rows:[]};}
  if(sql.startsWith('INSERT INTO zzsh_order.withdrawal_provider_fact')){facts.set(args[3],{evidence_digest:args[5],producer_lease_hash:args[6]});return{rows:[]};}
  if(sql.startsWith('UPDATE zzsh_order.withdrawal_intent')&&sql.includes('lease_token_hash=$4')){row.state=args[1];row.operation_version=args[2];row.lease_token_hash=args[3];row.lease_until=new Date(args[4]);return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE zzsh_order.withdrawal_intent')){row.state=args[1];row.operation_version=args[2];row.funds_disposition=args[3];row.terminal=args[4]===null?null:JSON.parse(args[4]);row.conflict_digest=args[5];row.lease_token_hash=null;row.lease_until=null;return{rows:[row],rowCount:1};}
  if(sql.startsWith('INSERT INTO zzsh_order.finance_event')){events.push(args);return{rows:[]};}if(sql.startsWith('INSERT INTO zzsh_order.settlement_ledger_entry')){ledger.push(args);return{rows:[]};}
  if(['BEGIN','COMMIT','ROLLBACK','SET CONSTRAINTS ALL IMMEDIATE'].includes(sql)||sql.startsWith('SELECT set_config')||sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"'))return{rows:[]};throw Error('Unexpected native worker SQL: '+sql);
 }})} as unknown as Pool;return{pool,row,scope:actualScope,sqls,ledger,events,capIdentity};
}
test('native scope traverses claim, durable FAIL_UNPAID and shared release without a debt query',async()=>{const f=fixture(),r=await runControlledWithdrawalStep(f.pool,'intent',f.scope);assert.equal(r.action,'SUBMIT');assert.equal(f.row.state,'FAILED');assert.equal(f.row.funds_disposition,'RELEASE_POSTED');assert.equal(f.events.length,1);assert.equal(f.events[0]![2],'RELEASE');assert.deepEqual(f.ledger.map(v=>[v[3],v[4],v[5]]),[['WALLET_RESERVED','200','0'],['WALLET_AVAILABLE','0','200']]);assert.equal(f.row.lease_token_hash,null);});
test('worker cannot operate another payout key even if user and destination match',async()=>{const f=fixture();f.row.payout_key='foreign';await assert.rejects(runControlledWithdrawalStep(f.pool,'intent',f.scope),/INTENT_NOT_ADMITTED/);assert(!f.sqls.some(s=>s.startsWith('UPDATE')||s.startsWith('INSERT')));});
test('original payout query verifies the full target and never invokes debt blocking',async()=>{const f=fixture();const r=await queryOriginalControlledPayout(f.pool,'intent','payout','1',f.scope);assert.equal(r.evidence.outcome,'TIMEOUT');assert.equal(r.evidence.payoutKey,'payout');f.row.admission_id='other';await assert.rejects(queryOriginalControlledPayout(f.pool,'intent','payout','1',f.scope),/INTENT_NOT_ADMITTED/);});

test('registered sandbox retains UNKNOWN after simulated lost ACK and queries the same SQL-backed operation for one payout',async()=>{
 const f=fixture(true),first=await runControlledWithdrawalStep(f.pool,'intent',f.scope);
 assert.equal(first.action,'SUBMIT');assert.equal(f.row.state,'UNKNOWN');assert.equal(f.row.funds_disposition,'RESERVED');assert.equal(f.events.length,0);
 const second=await runControlledWithdrawalStep(f.pool,'intent',f.scope);assert.equal(second.action,'QUERY');assert.equal(f.row.state,'SUCCEEDED');assert.equal(f.row.funds_disposition,'PAYOUT_POSTED');
 assert.equal(f.sqls.filter(sql=>sql.startsWith('INSERT INTO zzsh_order.controlled_payout_operation')).length,1);
 assert.equal(f.events.length,1);assert.equal(f.events[0]![2],'PAYOUT');assert.deepEqual(f.ledger.map(v=>[v[3],v[4],v[5]]),[['WALLET_RESERVED','200','0'],['PAYOUT_CLEARING','0','100'],['WITHDRAW_FEE','0','100']]);
 assert.equal((await runControlledWithdrawalStep(f.pool,'intent',f.scope)).action,'NONE');assert.equal(f.events.length,1);
});
test('immediate success cannot be selected in the ordinary local financial sandbox',async()=>{
 const f=fixture(true),token='synthetic-lease';f.row.scenario='IMMEDIATE_SUCCESS';f.row.state='SUBMITTING';
 f.row.lease_token_hash=createHash('sha256').update(token).digest('hex');f.row.lease_until=new Date(Date.now()+60000);
 await assert.rejects(submitDeclaredControlledPayout(f.pool,'intent',token,'1',f.scope),/Demo payout scope required/);
 assert(!f.sqls.some(sql=>sql.startsWith('INSERT INTO zzsh_order.controlled_payout_operation')));
});
test('registered worker never drives restored/cross-registration intents and revocation keeps pending reserve UNKNOWN',async()=>{
 for(const reference of [null,'foreign']){const f=fixture(true);f.row.sandbox_registration_ref=reference;await assert.rejects(runControlledWithdrawalStep(f.pool,'intent',f.scope));assert(!f.sqls.some(sql=>sql.startsWith('UPDATE')||sql.startsWith('INSERT')));}
 const f=fixture(true);await runControlledWithdrawalStep(f.pool,'intent',f.scope);f.capIdentity.active=false;
 await assert.rejects(runControlledWithdrawalStep(f.pool,'intent',f.scope));assert.equal(f.row.state,'UNKNOWN');assert.equal(f.row.funds_disposition,'RESERVED');assert.equal(f.events.length,0);
});
test('an accepted registered target remains frozen for original-key execution after quote expiry or bank revision changes',async()=>{
 const f=fixture(true);f.row.valid_until=new Date(0);f.row.bank_binding_revision='1';
 await runControlledWithdrawalStep(f.pool,'intent',f.scope);assert.equal(f.row.state,'UNKNOWN');
 // Current bank data is intentionally not a worker input: it cannot redirect an accepted target.
 f.row.valid_until=new Date(0);await runControlledWithdrawalStep(f.pool,'intent',f.scope);
 assert.equal(f.row.state,'SUCCEEDED');assert.equal(f.events.length,1);assert.equal(f.row.destination_id,'destination');assert.equal(f.row.payout_key,'payout');
});


