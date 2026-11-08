// Actual local source + common money kernel with a synthetic SQL adapter. No PostgreSQL/provider claim.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {canonicalize} from '../src/supply/content-hash';
import {withTransaction} from '../src/auth/security-core';
import {createSandboxChannelRequestCapability} from '../src/order/channel-payment-store';
import {captureLocalSandboxRefundTerminalFact,assertLocalSandboxRefundTerminalFact} from '../src/order/local-sandbox-refund-source';
import {consumeLocalSandboxRentalRefundTerminal,consumeNativeRentalRefundTerminal} from '../src/finance/native-rental-refund-store';
import {runLocalSandboxRefundStep,LocalSandboxRefundCommitUnknown} from '../src/order/local-sandbox-refund-worker';
import {claimRefundIntent,recordRefundTransportFailure} from '../src/order/channel-refund-store';
import {sandboxFixture,sandboxClient} from './local-financial-sandbox-fixture';
import {localFinancialSandboxRegistration} from '../src/finance/local-financial-sandbox-resource';

const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const sandbox=sandboxFixture(),base=sandboxClient(sandbox),p=localFinancialSandboxRegistration(sandbox),capability=createSandboxChannelRequestCapability(sandbox);
 const options={sandbox,capability},controls={live:true,expireAtUserLock:false,changeAtUserLock:false,auditFailure:false,operationPresent:true,xid:'110',commitUnknownAt:0};
 const row:any={id:'refund_fixture',posting_id:'posting_fixture',order_id:'order_fixture',payment_confirmation_id:'paid_fixture',renter_user_id:'renter_fixture',
  payment_source:'CONTROLLED',evidence_level:'CONTROLLED_TEST',merchant_identity_id:'local_sandbox_'+p.digest.slice(0,32),original_payment_trx_no:'sandbox_pay_fixture',
  original_payment_order_no:'ZZ_TEST_FIXTURE',responsibility_version_hash:'b'.repeat(64),refund_order_no:'RF'+'1'.repeat(28),amount_cents:'200',currency:'CNY',
  state:'UNKNOWN',budget_disposition:'ALLOCATED',requires_review:false,revision:'1',lease_version:'2',lease_owner:'worker_fixture',lease_until:new Date(Date.now()+60000),
  due_at:'2026-11-02T00:00:00.000000Z',basis_kind:'POSTING',liability_root_id:null,liability_event_id:null,sandbox_registration_ref:p.registration.reference,
  terminal_evidence_id:null,terminal_root_id:null,terminal_event_id:null,provider_refund_trx_no:null,completed_at:null};
 const operationId='local_refund_op_'+sha(row.id).slice(0,40),terminal={mode:'LOCAL_CONTROLLED',intentId:row.id,refundOrderNo:row.refund_order_no,
  originalPaymentTrxNo:row.original_payment_trx_no,amountCents:row.amount_cents,currency:'CNY',terminal:'SUCCEEDED',refundTransactionNo:'local_refund_trx_'+sha(row.id).slice(0,40),completedAt:'2026-11-02T10:00:00.000Z'};
 const operation={id:operationId,scenario:'TIMEOUT_THEN_SUCCEED',final_canonical:canonicalize(terminal),final_digest:sha(canonicalize(terminal))};
 const state={row,evidence:undefined as any,roots:[] as any[],events:[] as any[],entries:[] as any[],audits:[] as any[],observations:[] as any[],revision:'1'};
 let before:any,commits=0;const seen:string[]=[];
 const one=(value?:unknown)=>({rows:value?[value]:[],rowCount:value?1:0});
 const query=async(sql:string,args:any[]=[]):Promise<any>=>{
  seen.push(sql);
  if(sql==='BEGIN'){before=structuredClone(state);return one();}
  if(sql==='ROLLBACK'){if(before)Object.assign(state,before);return one();}
  if(sql==='COMMIT'){commits++;before=undefined;if(controls.commitUnknownAt===commits)throw Error('synthetic commit ACK lost');return one();}
  if(sql==='SET CONSTRAINTS ALL IMMEDIATE'||sql.startsWith('SELECT set_config'))return one();
  if(sql.includes('local_financial_sandbox_registration')||sql.includes('AS "databaseName"')||sql.includes('AS "ownsBusinessSchema"'))return base.query(sql,args);
  if(sql.startsWith("SELECT to_regclass('zzsh_order.local_controlled_refund_operation')"))return one({complete:true});
  if(sql.includes('current_database() AS db'))return one({db:p.registration.resource.database,actor:p.registration.resource.runtimeRole});
  if(sql.includes("current_setting('transaction_isolation')"))return one({isolation:'read committed'});
  if(sql.startsWith('SELECT i.id,i.posting_id'))return controls.operationPresent&&args[4]===state.row.lease_owner&&String(args[5])===String(state.row.lease_version)
   ?one({...state.row,operation_id:operation.id,scenario:operation.scenario,final_canonical:operation.final_canonical,final_digest:operation.final_digest}):one();
  if(sql==='SELECT pg_current_xact_id()::text AS xid')return one({xid:controls.xid});
  if(sql.startsWith('SELECT pg_current_xact_id()::text AS xid,'))return one({xid:controls.xid,
   live:state.row.state==='SUCCEEDED'&&state.row.terminal_evidence_id===args[1]||controls.live&&new Date(state.row.lease_until).getTime()>Date.now()&&state.row.lease_owner===args[3]&&String(state.row.lease_version)===String(args[4])});
  if(sql.includes('pg_advisory_xact_lock'))return one();
  if(sql.startsWith('SELECT id FROM zzsh_auth_user.')){if(controls.expireAtUserLock)controls.live=false;if(controls.changeAtUserLock)state.row.original_payment_trx_no='changed_original_trx';return one({id:row.renter_user_id});}
  if(sql.includes('SELECT ledger_revision'))return one({ledger_revision:state.revision});
  if(sql.startsWith('SELECT id,refund_order_no,original_payment_trx_no'))return one({...state.row,live:controls.live&&state.row.state==='SUBMITTING'&&state.row.lease_owner===args[1]&&state.row.lease_version===args[2]});
  if(sql.startsWith("SELECT to_char(clock_timestamp()"))return one({at:'2026-11-02T10:00:00.000Z'});
  if(sql.startsWith('INSERT INTO zzsh_order.local_controlled_refund_operation')){
   assert.equal(controls.operationPresent,false);assert.equal(args[1],row.id);assert.equal(args[2],p.registration.reference);
   assert.equal(args[10],'TIMEOUT_THEN_SUCCEED');
   controls.operationPresent=true;Object.assign(operation,{id:args[0],final_canonical:args[6],final_digest:args[7]});return one();
  }
  if(sql.includes('FROM zzsh_order.channel_refund_intent WHERE id=$1')&&(sql.includes('FOR UPDATE')||sql.startsWith('SELECT id, posting_id')))return one(structuredClone(state.row));
  if(sql.includes('native refund original immutable liability'))return one({valid:true});
  if(sql.startsWith('INSERT INTO zzsh_order.local_controlled_refund_evidence')){
   assert(seen.some(q=>q.includes('pg_advisory_xact_lock')));assert(seen.some(q=>q.includes('FROM zzsh_order.channel_refund_intent WHERE id=$1 FOR UPDATE')));
   state.evidence??={id:args[0],facts_canonical:args[6],facts_digest:args[7]};return one();
  }
  if(sql.startsWith('SELECT id,facts_canonical,facts_digest'))return one(state.evidence);
  if(sql.includes('local_controlled_refund_terminal_complete'))return one({complete:state.row.state==='SUCCEEDED'&&state.entries.length===2});
  if(sql.startsWith('INSERT INTO zzsh_order.finance_economic_root')){assert(sql.includes('LOCAL_CONTROLLED_RENTAL_REFUND'));assert(sql.includes('zzsh-local-controlled'));state.roots.push(args);return one();}
  if(sql.startsWith('INSERT INTO zzsh_order.finance_event')){state.events.push(args);state.revision=String(BigInt(state.revision)+1n);return one();}
  if(sql.startsWith('INSERT INTO zzsh_order.settlement_ledger_entry')){state.entries.push(args);return one();}
  if(sql.startsWith('UPDATE zzsh_order.channel_refund_intent SET state=$2,budget_disposition')){
   Object.assign(state.row,{state:args[1],budget_disposition:args[2],terminal_evidence_id:args[3],terminal_root_id:args[4],terminal_event_id:args[5],provider_refund_trx_no:args[6],completed_at:args[7],revision:String(BigInt(state.row.revision)+1n)});return{rows:[],rowCount:1};
  }
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){if(controls.auditFailure)throw Error('synthetic audit unavailable');state.audits.push(args);return one();}
  if(sql.startsWith('SELECT id FROM zzsh_order.local_controlled_refund_operation'))return controls.operationPresent?one({id:operation.id}):one();
  if(sql.startsWith('UPDATE zzsh_order.channel_refund_intent SET\n      state=CASE')){
   if(!['READY','SUBMITTING','UNKNOWN'].includes(state.row.state)||state.row.lease_until&&new Date(state.row.lease_until).getTime()>Date.now())return one();
   Object.assign(state.row,{state:state.row.state==='READY'?'SUBMITTING':'UNKNOWN',lease_version:String(BigInt(state.row.lease_version)+1n),lease_owner:args[1],lease_until:new Date(Date.now()+30000),revision:String(BigInt(state.row.revision)+1n)});return one(structuredClone(state.row));
  }
  if(sql.startsWith("UPDATE zzsh_order.channel_refund_intent SET state='UNKNOWN'")){
   if(!controls.live||state.row.lease_owner!==args[2]||state.row.lease_version!==args[1])return one();
   state.row.state='UNKNOWN';state.row.revision=String(BigInt(state.row.revision)+1n);return one(structuredClone(state.row));
  }
  if(sql.startsWith('INSERT INTO zzsh_order.channel_refund_observation')){state.observations.push(args);return one();}
  throw Error('Unexpected synthetic local refund query');
 };
 const client={query,release(){}} as unknown as PoolClient,pool={connect:async()=>client} as unknown as Pool;
 const capture=()=>captureLocalSandboxRefundTerminalFact(client,options,{intentId:row.id,owner:state.row.lease_owner,version:state.row.lease_version});
 return{sandbox,options,controls,state,seen,client,pool,capture,operation};
}

test('local refund fact comes from original durable operation, grants no formal capability and cannot be copied or cross-transaction reused',async()=>{
 const f=fixture(),fact=await f.capture();assert(!f.seen.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)));
 await assertLocalSandboxRefundTerminalFact(f.client,fact);
 await assert.rejects(assertLocalSandboxRefundTerminalFact(f.client,{...fact}));
 await assert.rejects(assertLocalSandboxRefundTerminalFact({query:f.client.query} as PoolClient,fact));
 const before=f.seen.length;await assert.rejects(consumeNativeRentalRefundTerminal(f.client,{fact,requestId:'request_fixture'}));assert.equal(f.seen.length,before);
 f.controls.xid='111';await assert.rejects(assertLocalSandboxRefundTerminalFact(f.client,fact));
});

test('local source rejects amount/operation tampering, caller-selected unpaid release and replaced worker lease before any evidence/money write',async()=>{
 for(const change of ['DIGEST','AMOUNT','FAILED','LEASE','DEMO_ONLY_SCENARIO']){
  const f=fixture();
  if(change==='DIGEST')f.operation.final_digest='0'.repeat(64);
  if(change==='DEMO_ONLY_SCENARIO')f.operation.scenario='IMMEDIATE_SUCCESS';
  if(change==='AMOUNT'||change==='FAILED'){const doc=JSON.parse(f.operation.final_canonical);if(change==='AMOUNT')doc.amountCents='201';else doc.terminal='FAILED_NO_EXECUTION';f.operation.final_canonical=canonicalize(doc);f.operation.final_digest=sha(f.operation.final_canonical);}
  if(change==='LEASE'){
   const fact=await f.capture();f.state.row.lease_version='4';await assert.rejects(consumeLocalSandboxRentalRefundTerminal(f.client,{fact,requestId:'request_fixture'}));
  }else await assert.rejects(f.capture());
  assert(!f.seen.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)));
 }
});

test('actual local source and shared terminal kernel write one exact liability/clearing batch and replay without a second financial event',async()=>{
 const f=fixture();const result=await withTransaction(f.pool,async c=>consumeLocalSandboxRentalRefundTerminal(c,{fact:await f.capture(),requestId:'request_fixture'}));
 assert.equal(result.event,'CONSUMED');assert.equal(f.state.row.state,'SUCCEEDED');assert.equal(f.state.row.budget_disposition,'CONSUMED');assert.equal(f.state.events.length,1);
 assert.deepEqual(f.state.entries.map(p=>[p[3],p[4],p[5]]),[['RENTER_REFUND_PAYABLE','200','0'],['PAYOUT_CLEARING','0','200']]);
 assert.equal(JSON.parse(f.state.entries[0]![7]).dataOrigin,'LOCAL_CONTROLLED');
 const replay=await withTransaction(f.pool,async c=>consumeLocalSandboxRentalRefundTerminal(c,{fact:await f.capture(),requestId:'replay_fixture'}));
 assert.equal(replay.event,'REPLAYED');assert.equal(f.state.events.length,1);assert.equal(f.state.entries.length,2);
});

test('lease expiry while acquiring original user lock cannot persist an early FK/evidence or consume liability',async()=>{
 const f=fixture(),fact=await f.capture();f.controls.expireAtUserLock=true;
 await assert.rejects(withTransaction(f.pool,c=>consumeLocalSandboxRentalRefundTerminal(c,{fact,requestId:'request_fixture'})));
 assert.equal(f.state.evidence,undefined);assert.equal(f.state.events.length,0);assert.equal(f.state.row.budget_disposition,'ALLOCATED');
});

test('audit failure rolls local evidence/root/event/entries and terminal back while preserving original channel operation for recovery',async()=>{
 const f=fixture();f.controls.auditFailure=true;
 await assert.rejects(withTransaction(f.pool,async c=>consumeLocalSandboxRentalRefundTerminal(c,{fact:await f.capture(),requestId:'request_fixture'})));
 assert.equal(f.state.evidence,undefined);assert.equal(f.state.roots.length,0);assert.equal(f.state.events.length,0);assert.equal(f.state.entries.length,0);assert.equal(f.state.row.budget_disposition,'ALLOCATED');
 f.controls.auditFailure=false;await withTransaction(f.pool,async c=>consumeLocalSandboxRentalRefundTerminal(c,{fact:await f.capture(),requestId:'recover_fixture'}));assert.equal(f.state.events.length,1);
});

test('missing original operation remains UNKNOWN without resubmit; committed result with lost ACK preserves original intent and terminal event',async()=>{
 const absent=fixture();absent.controls.operationPresent=false;
 absent.state.row.lease_until=new Date(0);
 const outcome=await runLocalSandboxRefundStep(absent.pool,absent.options,absent.state.row.id,'worker_recovery');
 assert(outcome.action==='QUERY');assert.equal(outcome.terminal,null);assert.equal(absent.state.row.state,'UNKNOWN');assert.equal(absent.state.events.length,0);
 assert(!absent.seen.some(sql=>sql.startsWith('INSERT INTO zzsh_order.local_controlled_refund_operation')));
 const f=fixture();f.state.row.lease_until=new Date(0);f.controls.commitUnknownAt=2;
 await assert.rejects(runLocalSandboxRefundStep(f.pool,f.options,f.state.row.id,'worker_recovery'),e=>e instanceof LocalSandboxRefundCommitUnknown&&e.intentId===f.state.row.id&&e.phase==='RESULT');
 // This adapter models a committed COMMIT whose acknowledgement was lost; ROLLBACK cannot undo it.
 assert.equal(f.state.row.state,'SUCCEEDED');assert.equal(f.state.events.length,1);
});

test('actual submit persists one local operation before its lost acknowledgement, then queries that same operation to consume once',async()=>{
 const f=fixture();f.controls.operationPresent=false;f.state.row.state='READY';f.state.row.lease_until=null;
 const submitted=await runLocalSandboxRefundStep(f.pool,f.options,f.state.row.id,'worker_submit');
 assert.equal(submitted.action,'SUBMIT');assert.equal(submitted.bankArrival,'UNKNOWN');assert.equal(f.state.row.state,'UNKNOWN');
 assert.equal(f.state.events.length,0);assert.equal(f.state.observations.length,1);assert.equal(f.controls.operationPresent,true);
 f.state.row.lease_until=null;
 const queried=await runLocalSandboxRefundStep(f.pool,f.options,f.state.row.id,'worker_query');
 assert.equal(queried.action,'QUERY');assert.equal(f.state.row.state,'SUCCEEDED');assert.equal(f.state.events.length,1);assert.equal(f.state.entries.length,2);
 assert.equal(f.seen.filter(sql=>sql.startsWith('INSERT INTO zzsh_order.local_controlled_refund_operation')).length,1);
 const done=await runLocalSandboxRefundStep(f.pool,f.options,f.state.row.id,'worker_done');assert.equal(done.action,'NONE');assert.equal(f.state.events.length,1);
});

test('sandbox claim and transport writeback take funds then user then intent, and reject a changed original binding before update',async()=>{
 for(const operation of ['CLAIM','TRANSPORT'] as const){
  for(const changed of [false,true]){
   const f=fixture();f.controls.changeAtUserLock=changed;
   if(operation==='CLAIM')f.state.row.lease_until=null;
   const run=()=>operation==='CLAIM'
    ?claimRefundIntent(f.client,{intentId:f.state.row.id,owner:'worker_next',ttlSeconds:30,requestId:'claim_lock_order',capability:f.options.capability})
    :recordRefundTransportFailure(f.client,{intentId:f.state.row.id,owner:f.state.row.lease_owner,version:f.state.row.lease_version,reason:'TIMEOUT',requestId:'transport_lock_order',capability:f.options.capability});
   if(changed)await assert.rejects(run(),/binding changed/);else await run();
   const funds=f.seen.findIndex(sql=>sql.includes('pg_advisory_xact_lock')),
    user=f.seen.findIndex(sql=>sql.startsWith('SELECT id FROM zzsh_auth_user.')),
    intent=f.seen.findIndex(sql=>sql.includes('FROM zzsh_order.channel_refund_intent WHERE id=$1')&&sql.includes('FOR UPDATE'));
   assert(funds>=0&&funds<user&&user<intent,'an intent lock before funds recreates the terminal/claim lock cycle');
   if(changed)assert(!f.seen.some(sql=>sql.startsWith('UPDATE zzsh_order.channel_refund_intent')));
  }
 }
});
