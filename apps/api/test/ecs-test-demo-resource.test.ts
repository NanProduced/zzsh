import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { assertEcsTestDemoAssembly, assertEcsTestDemoResource, createEcsTestDemoResource, createLocalDemoCloneResource, demoFinanceScope,
  readEcsTestDemoRegistration, verifyLocalDemoCloneProof, type DemoFinanceResource } from "../src/finance/ecs-test-demo-resource";
import {assertEcsTestDemoRuntimeAssembly,createEcsTestDemoRuntime,preflightEcsTestDemoRuntime} from "../src/finance/ecs-test-demo-runtime";
import {declareLocalSandboxWithdrawalTarget} from "../src/finance/local-sandbox-withdrawal-target";
import { createDemoNativeWithdrawalScope } from "../src/finance/native-withdrawal-resource";
import { localWithdrawalDayWindow, quoteControlledWithdrawal, withdrawalPolicyForScope } from "../src/finance/controlled-withdrawal";
import { submitDeclaredControlledPayout } from "../src/finance/controlled-withdrawal-worker";
import { TEAM_TEST_WITHDRAWAL_POLICY } from "../src/finance/withdrawal-business-policy";
import {assertDistributionOrderScopeResource,assertSandboxDistributionOrder,createEcsDemoDistributionOrderScope,createPaymentDistributionStore} from "../src/finance/distribution-payment-store";
import { assertSyntheticChannelRequestCapability, createEcsDemoCollectionCapability, createEcsDemoRefundCapability, createPaymentRequest, demoForChannelRequestCapability, markDemoPaymentActionReady, readDemoPaymentRequestMatch, readDemoPaymentRequestForAcceptance } from "../src/order/channel-payment-store";
import { assertLocalSandboxRefundResource, captureLocalSandboxRefundTerminalFact } from "../src/order/local-sandbox-refund-source";
import { canonicalize } from "../src/supply/content-hash";
import * as refundSource from "../src/order/local-sandbox-refund-source";
import * as refundStore from "../src/order/channel-refund-store";
import * as rentalRefund from "../src/finance/native-rental-refund-store";
import { runEcsDemoRefundStep } from "../src/order/local-sandbox-refund-worker";

type Input = Parameters<typeof createEcsTestDemoResource>[0];
const input = (): Input => ({
  env: { APP_PROFILE: "ecs-test", NODE_ENV: "production", ECS_TEST_DEMO_FINANCE_ENABLED: "true",
    JOINPAY_COLLECTION_ENABLED: "false", JOINPAY_REFUND_ENABLED: "false", JOINPAY_PAYOUT_ENABLED: "false", JOINPAY_ACCOUNTS_ENABLED: "false" },
  config: { profile: "ecs-test", provider: "real", testOperationsEnabled: false,
    database: { target: "ecs-test", targetProfile: "ecs-test", name: "zzsh_ecs_test_demo", user: "demo_runtime", runtimeUser: "demo_runtime",
      host: "postgres", port: 5432, password: "synthetic", ssl: { rejectUnauthorized: true, ca: "synthetic" } } } as Input["config"],
  resource: { database: "zzsh_ecs_test_demo", databaseOid: 111, systemIdentifier: "1234567890123",
    marker: "zzsh:ecs-test:v1", owner: "demo_owner", ownerOid: 222, migrationRole:"demo_migration",migrationRoleOid:224, runtimeRole: "demo_runtime", runtimeRoleOid: 333 },
  origins: { apiOrigin: "https://api-test.example.test", userOrigin: "https://test.example.test", adminOrigin: "https://admin-test.example.test", secureCookies: true },
  reference: "synthetic_demo", sourceSnapshotSha256: "a".repeat(64), restoreReceiptSha256: "b".repeat(64), administratorId: "synthetic_admin",
});
const scope = () => { const value = createEcsTestDemoResource(input()); assert(value); return value; };

test("demo amount rejection occurs before a target or balance write",async()=>{
  let connections=0;
  const pool={connect:async()=>{connections++;throw Error("unexpected connection");}} as unknown as Pool;
  const actor={userId:"user_fixture",sessionId:"session_fixture",requestId:"request_fixture"};
  const demo=scope(),withdrawalScope=createDemoNativeWithdrawalScope(demo);
  for(const amountCents of ["100","1000001"]){
    await assert.rejects(declareLocalSandboxWithdrawalTarget(pool,actor,{bankBindingId:"bank_"+"a".repeat(32),bankBindingRevision:"1",amountCents},"target-key",demo,withdrawalScope),
      (error:unknown)=>(error as {status?:number;code?:string}).status===422&&(error as {code?:string}).code==="DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE");
  }
  assert.equal(connections,0);
});

test("demo withdrawal uses the shared rule and rejects values not supported by its database guards",async()=>{
  const demo=scope(),policy={...TEAM_TEST_WITHDRAWAL_POLICY};
  const bound=createDemoNativeWithdrawalScope(demo,policy),applied=withdrawalPolicyForScope(bound,"BANK_CARD",["user_fixture"]);
  const runtime=createEcsTestDemoRuntime({...input(),appId:"synthetic_app",withdrawalPolicy:policy});assert(runtime);
  assert.equal(withdrawalPolicyForScope(runtime.withdrawal.scope,"BANK_CARD",["user_fixture"]).version,applied.version);
  assert.equal(applied.minCents,"200");assert.equal(applied.maxCents,"1000000");assert.equal(applied.maxAcceptedPerWindow,2);
  assert.deepEqual(applied.fee,{kind:"FIXED",cents:"100"});
  const at="2026-11-08T00:00:00.000Z",body={amountCents:"500",destinationId:"bank_fixture",policyVersion:applied.version,expectedWalletVersion:"1"};
  const facts={userId:"user_fixture",active:true,localAdmissionEligible:true,coverageKnown:true,availableCents:"1000",ledgerRevision:"1",now:at,
    destination:{id:"bank_fixture",userId:"user_fixture",mode:"LOCAL_CONTROLLED" as const,kind:"BANK_CARD" as const,active:true},
    usage:{...localWithdrawalDayWindow(at),quotaCount:0}};
  const quote=quoteControlledWithdrawal(body,applied,facts);
  assert.deepEqual([quote.grossCents,quote.netCents,quote.feeCents],["500","400","100"]);
  for(const change of [{fee:{kind:"FIXED" as const,cents:"50"}},{minCents:"500"},{maxIntents:3},{version:"other"}])
    assert.throws(()=>createDemoNativeWithdrawalScope(demo,{...policy,...change}),/DEMO_WITHDRAWAL_POLICY_SCHEMA_MISMATCH/);
  const pool={connect:async()=>{throw Error("unexpected connection");}} as unknown as Pool;
  const actor={userId:"user_fixture",sessionId:"session_fixture",requestId:"request_fixture"};
  await assert.rejects(declareLocalSandboxWithdrawalTarget(pool,actor,{bankBindingId:"bank_"+"a".repeat(32),bankBindingRevision:"1",amountCents:"199"},"target-key",demo,bound),
    (error:unknown)=>(error as {code?:string}).code==="DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE");
  await assert.rejects(declareLocalSandboxWithdrawalTarget(pool,actor,{bankBindingId:"bank_"+"a".repeat(32),bankBindingRevision:"1",amountCents:"500"},"target-key",scope(),bound),/Matching withdrawal scope required/);
  assert.throws(()=>createDemoNativeWithdrawalScope(demo,{...policy,quotaUtcOffsetMinutes:0}),/DEMO_WITHDRAWAL_POLICY_TIMEZONE_UNSUPPORTED/);
  assert.throws(()=>createDemoNativeWithdrawalScope(demo,{...policy,reviewStrategy:"MERCHANT_REVIEW_REQUIRED"}),/DEMO_WITHDRAWAL_REVIEW_UNSUPPORTED/);
});

test("demo withdrawal runtime must use the same branded payment resource",()=>{
  const options=input(),runtime=createEcsTestDemoRuntime({...options,appId:"synthetic_app"});assert(runtime);
  const assembled={...options.origins,distributionEarnings:runtime.earnings,nativeWithdrawalScope:runtime.withdrawal.scope};
  assert.doesNotThrow(()=>assertEcsTestDemoRuntimeAssembly(runtime,assembled));
  assert.throws(()=>assertEcsTestDemoRuntimeAssembly(runtime,{...assembled,nativeWithdrawalScope:{...runtime.withdrawal.scope}}));
  assert.throws(()=>assertEcsTestDemoRuntimeAssembly(runtime,{...assembled,joinpayWithdrawal:{}}));
});

function clientFor(value: DemoFinanceResource, changed: { identity?: Record<string, unknown>; lock?: Record<string, unknown>;
  business?: Record<string, unknown>; ownership?: Record<string, unknown> } = {}) {
  const proof = readEcsTestDemoRegistration(value), calls: string[] = [];
  const query = async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith("SELECT set_config")) return { rows: [] };
    if (sql.includes('AS "databaseName"')) return { rows: [{ databaseName: "zzsh_ecs_test_demo", currentUser: "demo_runtime", owner: "demo_owner",
      isSuperuser: false, canCreateRole: false, canCreateDb: false, canReplicate: false, canBypassRls: false, canCreateDatabase: false,
      canCreateIamSchema: false, canCreateUserSchema: false, canCreateAdminSchema: false, canCreateSupplySchema: false, canCreateContentSchema: false,
      canCreateOrderSchema: false, canUpdateAudit: false, canDeleteAudit: false, canTruncateAudit: false, ...changed.business }] };
    if (sql.includes('AS "ownsBusinessSchema"')) return { rows: [{ ownsBusinessSchema: false, ownsBusinessRelation: false, hasPrivilegedMembership: false, ...changed.ownership }] };
    if (sql.includes("FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=$1 FOR SHARE")) return { rows: [{
      canonical_registration: proof.canonical, registration_digest: proof.digest, active: true, demo_xid: "100", ...changed.lock }] };
    if (sql.includes("AS database_oid")) return { rows: [{ database: "zzsh_ecs_test_demo", database_oid: "111", system_identifier: "1234567890123",
      marker: "zzsh:ecs-test:v1", owner: "demo_owner", owner_oid: "222", runtime_role: "demo_runtime", runtime_role_oid: "333",
      owner_super:false,owner_bypass:false,owner_createdb:false,owner_createrole:false,owner_replication:false,owner_login:false,owner_has_membership:false,
      migration_role_oid:'224',schema_owner:'demo_migration',migration_super:false,migration_bypass:false,migration_createrole:false,migration_createdb:false,migration_replication:false,migration_login:false,migration_has_membership:false,
      rolsuper: false, rolbypassrls: false, runtime_owns_business_routine: false, canonical_registration: proof.canonical,
      registration_digest: proof.digest, active: true, demo_xid: "100", ...changed.identity }] };
    throw new Error("unexpected query");
  };
  return { client: { query, getTransactionStatus:()=> 'T', connectionParameters:{host:'127.0.0.1',port:55434,
    database:proof.registration.resource.database,user:proof.registration.resource.runtimeRole} } as unknown as PoolClient, calls };
}

test("demo payout succeeds on its first submission and reuses the original controlled operation",async()=>{
  const demo=scope(),bound=createDemoNativeWithdrawalScope(demo),base=clientFor(demo),token="synthetic-lease";
  const row={id:"intent",user_id:"user",admission_id:"admission",destination_id:"destination",payout_key:"payout",
    state:"SUBMITTING",operation_version:"1",lease_token_hash:createHash("sha256").update(token).digest("hex"),
    lease_until:new Date(Date.now()+60000),scenario:"IMMEDIATE_SUCCESS",net_cents:"400",fee_cents:"100"};
  let operation:Record<string,unknown>|undefined,insertions=0;
  const client={...base.client,release(){},query:async(sql:string,values:unknown[]=[])=>{
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
    if(sql.startsWith("SELECT to_regclass('zzsh_order.withdrawal_intent')"))return {rows:[{complete:true}]};
    if(sql.startsWith("SELECT user_id FROM zzsh_order.withdrawal_intent"))return {rows:[{user_id:row.user_id}]};
    if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return {rows:[{id:row.user_id}]};
    if(sql.startsWith("SELECT i.*,d.scenario"))return {rows:[row]};
    if(sql.startsWith("SELECT i.id FROM zzsh_order.withdrawal_intent"))return {rows:[{id:row.id}]};
    if(sql.startsWith("SELECT * FROM zzsh_order.controlled_payout_operation"))return {rows:operation?[operation]:[]};
    if(sql.startsWith("INSERT INTO zzsh_order.controlled_payout_operation")){
      insertions++;operation={id:values[0],payout_key:values[2],scenario:values[3],final_evidence_canonical:values[4]};return {rows:[]};
    }
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,values);
  }} as unknown as PoolClient;
  const pool={connect:async()=>client} as unknown as Pool;
  const first=await submitDeclaredControlledPayout(pool,row.id,token,"1",bound);
  assert.equal(first.evidence.outcome,"SUCCEEDED");assert.equal(first.evidence.mode,"LOCAL_CONTROLLED");
  assert.equal(first.operationReplayed,false);assert.equal(operation?.scenario,"IMMEDIATE_SUCCESS");
  const replay=await submitDeclaredControlledPayout(pool,row.id,token,"1",bound);
  assert.equal(replay.operationReplayed,true);assert.deepEqual(replay.evidence,first.evidence);assert.equal(insertions,1);
});

test("demo refunds admit immediate or original timeout evidence, but not an unrelated scenario",async()=>{
  const demo=scope(),capability=createEcsDemoRefundCapability(demo),base=clientFor(demo);
  const terminal={mode:"LOCAL_CONTROLLED",intentId:"refund",refundOrderNo:"refund-no",originalPaymentTrxNo:"payment-no",
    amountCents:"200",currency:"CNY",terminal:"SUCCEEDED",refundTransactionNo:"local-refund-no",completedAt:"2026-11-08T00:00:00.000Z"};
  const canonical=canonicalize(terminal),digest=createHash("sha256").update(canonical).digest("hex");let scenario="IMMEDIATE_SUCCESS";
  const row={id:"refund",posting_id:"posting",order_id:"order",payment_confirmation_id:"payment",renter_user_id:"user",
    merchant_identity_id:"merchant",original_payment_trx_no:"payment-no",original_payment_order_no:"order-no",responsibility_version_hash:"a".repeat(64),
    refund_order_no:"refund-no",amount_cents:"200",currency:"CNY",basis_kind:"POSTING",operation_id:"operation",final_canonical:canonical,final_digest:digest};
  const client={...base.client,query:async(sql:string,values:unknown[]=[])=>{
    if(sql.startsWith("SELECT to_regclass('zzsh_order.local_controlled_refund_operation')"))return {rows:[{complete:true}]};
    if(sql.startsWith("SELECT i.id,i.posting_id"))return {rows:[{...row,scenario}]};
    if(sql==="SELECT pg_current_xact_id()::text AS xid")return {rows:[{xid:"101"}]};
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,values);
  }} as unknown as PoolClient;
  const input={intentId:"refund",owner:"worker",version:"1"};
  assert.equal((await captureLocalSandboxRefundTerminalFact(client,{demo,capability},input)).terminal,"SUCCEEDED");
  scenario="TIMEOUT_THEN_SUCCEED";assert.equal((await captureLocalSandboxRefundTerminalFact(client,{demo,capability},input)).terminal,"SUCCEEDED");
  scenario="UNREVIEWED";await assert.rejects(captureLocalSandboxRefundTerminalFact(client,{demo,capability},input));
  await assert.rejects(captureLocalSandboxRefundTerminalFact(client,{demo,capability:createEcsDemoCollectionCapability(demo)},input));
});

test("demo refund records its immediate result once and uses the original liability",async t=>{
  const demo=scope(),capability=createEcsDemoRefundCapability(demo),seen:unknown[][]=[];let claimed=false,operation=false;
  const lease={owner:"worker",version:"1",operation:"SUBMIT" as const,intent:{intentId:"refund",renterUserId:"user",
    originalPayment:{merchantIdentityId:"merchant",transactionNo:"payment-no"}}};
  t.mock.method(refundSource,"assertLocalSandboxRefundResource",async()=>({reference:"demo"}) as never);
  t.mock.method(refundSource,"localRefundRegistration",()=>({reference:"demo"}) as never);
  t.mock.method(refundStore,"claimRefundIntent",async()=>{if(claimed)return null;claimed=true;return lease as never;});
  t.mock.method(refundStore,"lockRefundFunds",async()=>{});
  t.mock.method(refundSource,"captureLocalSandboxRefundTerminalFact",async()=>({intentId:"refund"}) as never);
  t.mock.method(rentalRefund,"consumeLocalSandboxRentalRefundTerminal",async()=>({event:"CONSUMED"}) as never);
  const client={release(){},query:async(sql:string,values:unknown[]=[])=>{
    if(["BEGIN","COMMIT","ROLLBACK","SET CONSTRAINTS ALL IMMEDIATE"].includes(sql)||sql.startsWith("SELECT set_config"))return {rows:[]};
    if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return {rows:[{id:"user"}]};
    if(sql.startsWith("SELECT id,refund_order_no"))return {rows:[{id:"refund",refund_order_no:"refund-no",original_payment_trx_no:"payment-no",amount_cents:"200",currency:"CNY",live:true}]};
    if(sql.startsWith("SELECT id FROM zzsh_order.local_controlled_refund_operation"))return {rows:operation?[{id:"operation"}]:[]};
    if(sql.startsWith("SELECT to_char(clock_timestamp()"))return {rows:[{at:"2026-11-08T00:00:00.000Z"}]};
    if(sql.startsWith("INSERT INTO zzsh_order.local_controlled_refund_operation")){seen.push(values);operation=true;return {rows:[]};}
    throw Error("Unexpected demo refund query");
  }} as unknown as PoolClient;
  const pool={connect:async()=>client} as unknown as Pool;
  const first=await runEcsDemoRefundStep(pool,{demo,capability},"refund","worker");
  assert.equal(first.action,"SUBMIT");assert.equal(first.bankArrival,"UNKNOWN");assert.equal(seen.length,1);assert.equal(seen[0]![10],"IMMEDIATE_SUCCESS");
  const replay=await runEcsDemoRefundStep(pool,{demo,capability},"refund","worker");assert.equal(replay.action,"NONE");assert.equal(seen.length,1);
});

test("demo runtime refuses a partial cashier schema before exposing test payments",async()=>{
  const runtime=createEcsTestDemoRuntime({...input(),appId:"synthetic_app"});assert(runtime);
  for(const [baseReady,cashierReady,expected] of [[false,true,"ECS_TEST_DEMO_FINANCE_SCHEMA_NOT_READY"],[true,false,"TEST_CASHIER_SCHEMA_NOT_READY"],[true,true,null]] as const){
    const base=clientFor(runtime.demo),calls:string[]=[];
    const client={...base.client,release(){},query:async(sql:string,...values:unknown[])=>{
      calls.push(sql);
      if(["BEGIN","COMMIT","ROLLBACK","SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"].includes(sql))return {rows:[]};
      if(sql.includes("test_channel_request_guard"))return {rows:[{ready:cashierReady}]};
      if(sql.includes("guard_ecs_test_demo_finance_registration"))return {rows:[{ready:baseReady}]};
      return (base.client.query as (...args:any[])=>Promise<any>)(sql,...values);
    }} as unknown as PoolClient;
    const pool={connect:async()=>client} as unknown as Pool;
    if(expected)await assert.rejects(preflightEcsTestDemoRuntime(pool,runtime),error=>error instanceof Error&&error.message===expected);
    else await preflightEcsTestDemoRuntime(pool,runtime);
    assert.equal(calls.some(sql=>/^(INSERT|UPDATE|DELETE|ALTER|CREATE|TRUNCATE)\b/i.test(sql)),false);
    if(!baseReady)assert.equal(calls.some(sql=>sql.includes("test_channel_request_guard")),false);
  }
});

test("demo collection capability is bound to the test resource and cannot be used for refunds", async()=>{
  const demo=scope(), base=clientFor(demo), collection=createEcsDemoCollectionCapability(demo), refund=createEcsDemoRefundCapability(demo);
  const client={...base.client,query:async(sql:string,...values:unknown[])=>{
    if(sql.includes("current_database() AS db, current_user AS actor"))return {rows:[{db:"zzsh_ecs_test_demo",actor:"demo_runtime"}]};
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,...values);
  }} as unknown as PoolClient;
  assert.equal(await assertSyntheticChannelRequestCapability(client,collection,"COLLECTION"),"CONTROLLED_TEST");
  assert.equal(await assertSyntheticChannelRequestCapability(client,refund,"REFUND"),"CONTROLLED_TEST");
  await assert.rejects(assertSyntheticChannelRequestCapability(client,collection,"REFUND"));
  await assert.rejects(assertSyntheticChannelRequestCapability(client,refund,"COLLECTION"));
  await assert.rejects(assertSyntheticChannelRequestCapability(client,{...collection},"COLLECTION"));
  assert.equal(demoForChannelRequestCapability(collection),undefined);
  assert.equal(demoForChannelRequestCapability(refund),demo);
  assert.equal(demoForChannelRequestCapability(collection,"COLLECTION"),demo);
  assert.equal(demoForChannelRequestCapability(refund,"COLLECTION"),undefined);
  const noQuery={query:async()=>{throw Error("unexpected refund query");}} as unknown as PoolClient;
  await assert.rejects(assertLocalSandboxRefundResource(noQuery,{demo,capability:collection}),/Registered test refund capabilities differ/);
  const refundClient={...base.client,query:async(sql:string,...values:unknown[])=>{
    if(sql.startsWith("SELECT to_regclass('zzsh_order.local_controlled_refund_operation')"))return {rows:[{complete:true}]};
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,...values);
  }} as unknown as PoolClient;
  await assert.doesNotReject(assertLocalSandboxRefundResource(refundClient,{demo,capability:refund}));
});

test("test cashier only reads and accepts its own original ready request",async()=>{
  const demo=scope(),base=clientFor(demo),capability=createEcsDemoCollectionCapability(demo),merchant='ecs_demo_'+readEcsTestDemoRegistration(demo).digest.slice(0,32);
  let row:Record<string,string>|null={id:'payreq_1',order_id:'order_1',channel:'CONTROLLED',evidence_level:'CONTROLLED_TEST',state:'ACTION_READY',merchant_identity_id:merchant,config_profile_id:merchant,protocol_version:'TEST_CASHIER_V1',key_version_ref:'NO_REAL_PROVIDER'};
  const client={...base.client,query:async(sql:string,...values:unknown[])=>{
    if(sql.includes('current_database() AS db, current_user AS actor'))return {rows:[{db:'zzsh_ecs_test_demo',actor:'demo_runtime'}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.includes('FROM zzsh_order.payment_request WHERE order_id=$1'))return {rows:row?[row]:[]};
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,...values);
  }} as unknown as PoolClient;
  assert.equal(await readDemoPaymentRequestMatch(client,{orderId:'order_1',capability}),true);
  assert.equal(await readDemoPaymentRequestForAcceptance(client,{orderId:'order_1',capability}),'payreq_1');
  row={...row!,merchant_identity_id:'other_scope'};
  assert.equal(await readDemoPaymentRequestMatch(client,{orderId:'order_1',capability}),false);
  await assert.rejects(readDemoPaymentRequestForAcceptance(client,{orderId:'order_1',capability}));
  row=null;assert.equal(await readDemoPaymentRequestMatch(client,{orderId:'order_1',capability}),null);
});

test("test cashier readiness is attached once to its original controlled request",async()=>{
  const demo=scope(),base=clientFor(demo),capability=createEcsDemoCollectionCapability(demo),merchant='ecs_demo_'+readEcsTestDemoRegistration(demo).digest.slice(0,32);
  const row:Record<string,string>={id:'payreq_1',order_id:'order_1',channel:'CONTROLLED',evidence_level:'CONTROLLED_TEST',state:'SUBMITTING',revision:'1',merchant_identity_id:merchant,config_profile_id:merchant,protocol_version:'TEST_CASHIER_V1',key_version_ref:'NO_REAL_PROVIDER',channel_order_no:'ZZ-1',amount_cents:'125',method:'WEIXIN_NATIVE'};
  let observations=0,updates=0;
  const client={...base.client,query:async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('current_database() AS db, current_user AS actor'))return {rows:[{db:'zzsh_ecs_test_demo',actor:'demo_runtime'}]};
    if(sql.includes('FROM zzsh_order.payment_request WHERE id=$1 FOR UPDATE'))return {rows:[{...row}]};
    if(sql.startsWith('UPDATE zzsh_order.payment_request SET state=')){assert.equal(values[1],'ACTION_READY');updates++;row.state='ACTION_READY';row.revision='2';return {rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO zzsh_order.payment_channel_observation')){observations++;assert.equal(values[11],'CONTROLLED_TEST');assert.equal(values[12],'E1');return {rows:[]};}
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,values);
  }} as unknown as PoolClient;
  await markDemoPaymentActionReady(client,{orderId:'order_1',requestId:'payreq_1',capability});
  await markDemoPaymentActionReady(client,{orderId:'order_1',requestId:'payreq_1',capability});
  assert.equal(updates,1);assert.equal(observations,1);
  await assert.rejects(markDemoPaymentActionReady(client,{orderId:'order_other',requestId:'payreq_1',capability}));
  assert.equal(updates,1);assert.equal(observations,1);
});

test("demo collection creates the ordinary payment request with a controlled source", async t=>{
  const demo=scope(), base=clientFor(demo), capability=createEcsDemoCollectionCapability(demo), statements:string[]=[];
  const resource:typeof import('../src/finance/ecs-test-demo-resource')=require('../src/finance/ecs-test-demo-resource');
  const util:typeof import('../src/supply/supply-util')=require('../src/supply/supply-util');
  let admitted=false;
  t.mock.method(resource,'ensureEcsTestDemoOrderAdmission',async()=>{admitted=true;return 'synthetic_admission';});
  t.mock.method(util,'withIdempotency',async(...[_client,_scope,_key,_fingerprint,authorize,action]:Parameters<typeof util.withIdempotency>)=>{
    await authorize(null);return {replayed:false,...await action()};
  });
  const client={...base.client,query:async(sql:string,values:unknown[]=[])=>{
    statements.push(sql);
    if(sql.includes('current_database() AS db, current_user AS actor'))return {rows:[{db:'zzsh_ecs_test_demo',actor:'demo_runtime'}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.startsWith('SELECT renter_user_id FROM zzsh_order.rental_order'))return {rows:[{renter_user_id:'renter'}]};
    if(sql.includes('FROM zzsh_order.payment_request WHERE order_id=$1'))return {rows:[]};
    if(sql.startsWith('SELECT renter_user_id, status, display_no'))return {rows:[{renter_user_id:'renter',status:'PENDING_PAYMENT',display_no:'ZZ-1',currency:'CNY',total:'125'}]};
    if(sql.startsWith('SELECT hold_until > clock_timestamp()'))return {rows:[{open:true,has_confirmation:false}]};
    if(sql.startsWith('SELECT 1 FROM zzsh_order.payment_request WHERE channel='))return {rows:[],rowCount:0};
    if(sql.startsWith('INSERT INTO zzsh_order.payment_request'))return {rows:[{id:values[0],order_id:values[1],channel:values[2],merchant_identity_id:values[3],config_profile_id:values[4],protocol_version:values[5],key_version_ref:values[6],platform_order_no:values[7],channel_order_no:values[8],amount_cents:values[9],currency:'CNY',wire_amount_yuan:values[10],method:values[11],evidence_level:values[12],state:'SUBMITTING',created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z'}]};
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,values);
  }} as unknown as PoolClient;
  const result=await createPaymentRequest(client,{actor:{userId:'renter'},orderId:'order_1',idempotencyKey:'request_key',method:'WEIXIN_NATIVE',capability});
  assert.equal(admitted,true);assert.equal(result.status,202);
  assert.equal((result.body as {channel:string}).channel,'CONTROLLED');assert.equal((result.body as {evidenceLevel:string}).evidenceLevel,'CONTROLLED_TEST');
  assert.equal((result.body as {amountCents:string}).amountCents,'125');assert.equal((result.body as {method:string}).method,'WEIXIN_NATIVE');
  assert.equal(statements.filter(sql=>sql.startsWith('INSERT INTO zzsh_order.payment_request')).length,1);
});

test("demo distribution read-only paths verify the original resource without acquiring write locks",async()=>{
  const demo=scope(),distribution=createEcsDemoDistributionOrderScope(demo),base=clientFor(demo);
  const client={...base.client,query:async(sql:string,...values:unknown[])=>{
    if(sql.startsWith('SELECT id FROM zzsh_order.distribution_order_admission'))return {rows:[{id:'admission'}],rowCount:1};
    if(sql.includes('FROM zzsh_order.payment_confirmation p JOIN'))return {rows:[],rowCount:0};
    return (base.client.query as (...args:any[])=>Promise<any>)(sql,...values);
  }} as unknown as PoolClient;
  await assertDistributionOrderScopeResource(client,distribution,'READ_ORIGINAL');
  await assertSandboxDistributionOrder(client,distribution,'order_1','READ_ORIGINAL');
  await assert.rejects(createPaymentDistributionStore(distribution).readOriginal(client,'order_1','payment_1','READ_ORIGINAL'));
  assert(!base.calls.some(sql=>sql.includes('FOR SHARE')||sql.includes('pg_current_xact_id()')));
  await assertDistributionOrderScopeResource(client,distribution);
  assert(base.calls.some(sql=>sql.includes('FOR SHARE')),'writes retain the locked registration gate');
});

test("demo money capability is explicit, excludes all real Joinpay and copies only public registration fields", () => {
  const disabled = input(); disabled.env.ECS_TEST_DEMO_FINANCE_ENABLED = "false"; assert.equal(createEcsTestDemoResource(disabled), undefined);
  delete disabled.env.ECS_TEST_DEMO_FINANCE_ENABLED; assert.equal(createEcsTestDemoResource(disabled), undefined);
  const valid = input(); Object.assign(valid.resource, { password: "synthetic-secret" }); Object.assign(valid.origins, { secret: "synthetic-secret" });
  const value = createEcsTestDemoResource(valid); assert(value); assert(!readEcsTestDemoRegistration(value).canonical.includes("synthetic-secret"));
  assertEcsTestDemoAssembly(value, valid.origins);
  assert.throws(() => readEcsTestDemoRegistration({ ...value }));
  for (const provider of ["joinpayCollection", "joinpayRefund", "joinpayWithdrawal", "joinpayAccountObservation"]) {
    assert.throws(() => assertEcsTestDemoAssembly(value, { ...valid.origins, [provider]: {} }));
  }
  assert.throws(() => assertEcsTestDemoAssembly(value, { ...valid.origins, userOrigin: "https://other.example.test" }));
  for (const key of ["JOINPAY_COLLECTION_ENABLED", "JOINPAY_REFUND_ENABLED", "JOINPAY_PAYOUT_ENABLED", "JOINPAY_ACCOUNTS_ENABLED"]) {
    for (const flag of ["true", undefined]) { const changed = input(); changed.env[key] = flag; assert.throws(() => createEcsTestDemoResource(changed)); }
  }
  for (const env of [{ NODE_ENV: "development" }, { APP_PROFILE: "production" }, { ECS_TEST_DEMO_FINANCE_ENABLED: "yes" }]) {
    const changed = input(); Object.assign(changed.env, env); assert.throws(() => createEcsTestDemoResource(changed));
  }
  for (const change of [{ profile: "production" }, { provider: "fake" }, { testOperationsEnabled: true }]) {
    const changed = input(); Object.assign(changed.config, change); assert.throws(() => createEcsTestDemoResource(changed));
  }
  for (const change of [{ name: "zzsh_prod" }, { target: "production" }, { user: "demo_owner" }, { ssl: { rejectUnauthorized: false } }]) {
    const changed = input(); Object.assign(changed.config.database, change); assert.throws(() => createEcsTestDemoResource(changed));
  }
  for (const change of [{ databaseOid: 0 }, { runtimeRoleOid: 222 }, { marker: "zzsh:regression-test:v1" }, { runtimeRole: "demo_owner" }]) {
    const changed = input(); Object.assign(changed.resource, change); assert.throws(() => createEcsTestDemoResource(changed));
  }
  for (const change of [{ apiOrigin: "http://api-test.example.test" }, { userOrigin: "https://test.example.test/" }, { secureCookies: false }]) {
    const changed = input(); Object.assign(changed.origins, change); assert.throws(() => createEcsTestDemoResource(changed));
  }
});

test("local clone requires the pinned completed receipt, exact loopback and live nonce; it cannot enable ECS or production",async()=>{
  const doc={schema:'zzsh.r07-demo-clone-restored.v1',status:'RESTORED_AND_VERIFIED',
    verification:{sameExportedSnapshot:true,dataSummaryMatched:true,keySetsMatched:true,objectAclMatched:true,roleSecurityMatchedWithDeclaredExceptions:true,
      rlsAndDefinerMatched:true,runtimeAccessTested:true,sourceWrites:0,intentionalExceptions:[{code:'OWNER_DEPRIVILEGED',role:'zzsh'},{code:'DATABASE_EPOCH_CHANGED'}]},
    source:{database:'zzsh_test_regression',oid:'16390',marker:'zzsh:regression-test:v1',systemIdentifier:'7704972584346443810',archiveSha256:'a'.repeat(64),aclSha256:'b'.repeat(64)},
    target:{database:'zzsh_test_r07_delivery_20261108',oid:'411',marker:'zzsh:r07-delivery-clone:v1',systemIdentifier:'7705473419326033954',
      host:'127.0.0.1',port:55434,nonce:'1234567890abcdef',owner:{name:'zzsh',oid:'222'},migration:{name:'zzsh_regression_migration',oid:'223'},runtime:{name:'zzsh_regression_runtime',oid:'333'}}};
  const bytes=Buffer.from(JSON.stringify(doc)),hash=createHash('sha256').update(bytes).digest('hex'),proof=verifyLocalDemoCloneProof(bytes,hash);
  const config={profile:'dev',provider:'fake',testOperationsEnabled:false,host:'127.0.0.1',port:4232,
    database:{target:'local-compose',targetProfile:'dev',host:'127.0.0.1',port:55434,name:doc.target.database,user:'zzsh_regression_runtime',runtimeUser:'zzsh_regression_runtime'}} as Parameters<typeof createLocalDemoCloneResource>[0]['config'];
  const env={APP_PROFILE:'dev',NODE_ENV:'development',LOCAL_DEMO_CLONE_FINANCE_ENABLED:'true',JOINPAY_COLLECTION_ENABLED:'false',
    JOINPAY_REFUND_ENABLED:'false',JOINPAY_PAYOUT_ENABLED:'false',JOINPAY_ACCOUNTS_ENABLED:'false'};
  const origins={apiOrigin:'http://127.0.0.1:4232',userOrigin:'http://127.0.0.1:4230',adminOrigin:'http://127.0.0.1:4231',secureCookies:false};
  const args={config,env,origins,proof,reference:'fixture',administratorId:'synthetic_admin'},value=createLocalDemoCloneResource(args);
  assert.equal(demoFinanceScope(value),'LOCAL_DEMO_SIMULATED');assertEcsTestDemoAssembly(value,origins);
  assert.throws(()=>verifyLocalDemoCloneProof(bytes,'c'.repeat(64)));
  for(const changed of [{status:'RESTORE_IN_PROGRESS'},{verification:{...doc.verification,dataSummaryMatched:false}},
    {target:{...doc.target,port:5432}},{target:{...doc.target,oid:'0'}}]){
    const altered=Buffer.from(JSON.stringify({...doc,...changed}));assert.throws(()=>verifyLocalDemoCloneProof(altered,createHash('sha256').update(altered).digest('hex')));
  }
  for(const changed of [{NODE_ENV:'production'},{APP_PROFILE:'ecs-test'},{JOINPAY_PAYOUT_ENABLED:'true'},{ECS_TEST_DEMO_FINANCE_ENABLED:'true'}])
    assert.throws(()=>createLocalDemoCloneResource({...args,env:{...env,...changed}}));
  assert.throws(()=>createLocalDemoCloneResource({...args,origins:{...origins,userOrigin:'https://test.example.test'}}));
  const identity={database:doc.target.database,database_oid:'411',system_identifier:doc.target.systemIdentifier,marker:doc.target.marker,
    owner:'zzsh',owner_oid:'222',runtime_role:'zzsh_regression_runtime',runtime_role_oid:'333',clone_nonce:doc.target.nonce,
    migration_role_oid:'223',schema_owner:'zzsh_regression_migration',migration_super:false,migration_bypass:false,migration_createrole:false,migration_createdb:false,migration_replication:false};
  const business={databaseName:doc.target.database,currentUser:'zzsh_regression_runtime',owner:'zzsh'};
  await assertEcsTestDemoResource(clientFor(value,{identity,business}).client,value);
  for(const changed of [{clone_nonce:'different'},{migration_role_oid:'224'},{migration_super:true}])
    await assert.rejects(assertEcsTestDemoResource(clientFor(value,{identity:{...identity,...changed},business}).client,value));
});

test("each operation rechecks exact DB, least privilege, active registration and one transaction", async () => {
  const value = scope(), p = clientFor(value); await assertEcsTestDemoResource(p.client, value);
  assert(p.calls.some(sql => sql.includes("FOR SHARE")));
  // The Compose migration account is a separate, restricted LOGIN role; runtime remains a non-owner non-member.
  await assertEcsTestDemoResource(clientFor(value, { identity: { migration_login: true } }).client, value);
  for (const identity of [{ database: "zzsh_prod" }, { database_oid: "999" }, { system_identifier: "999" }, { marker: "other" },
    { owner_oid: "999" }, { runtime_role_oid: "999" }, { owner_login: true }, { owner_has_membership: true }, { migration_has_membership: true }, { migration_super: true }, { migration_bypass: true }, { rolsuper: true }, { rolbypassrls: true }, { runtime_owns_business_routine: true },
    { active: false }, { canonical_registration: "{}" }, { registration_digest: "f".repeat(64) }]) {
    await assert.rejects(assertEcsTestDemoResource(clientFor(value, { identity }).client, value));
  }
  for (const ownership of [{ ownsBusinessSchema: true }, { ownsBusinessRelation: true }, { hasPrivilegedMembership: true }]) {
    await assert.rejects(assertEcsTestDemoResource(clientFor(value, { ownership }).client, value));
  }
  for (const lock of [{ active: false }, { demo_xid: "101" }, { registration_digest: "f".repeat(64) }]) {
    await assert.rejects(assertEcsTestDemoResource(clientFor(value, { lock }).client, value));
  }
  const read = clientFor(value, { identity: { active: false } });
  assert.equal((await assertEcsTestDemoResource(read.client, value, "READ_ORIGINAL")).active, false);
  assert(!read.calls.some(sql => sql.includes("FOR SHARE")));
});
