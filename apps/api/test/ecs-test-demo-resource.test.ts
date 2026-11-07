import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { assertEcsTestDemoAssembly, assertEcsTestDemoResource, createEcsTestDemoResource, createLocalDemoCloneResource, demoFinanceScope,
  readEcsTestDemoRegistration, verifyLocalDemoCloneProof, type DemoFinanceResource } from "../src/finance/ecs-test-demo-resource";
import {assertEcsTestDemoRuntimeAssembly,createEcsTestDemoRuntime} from "../src/finance/ecs-test-demo-runtime";
import {declareLocalSandboxWithdrawalTarget} from "../src/finance/local-sandbox-withdrawal-target";
import {assertDistributionOrderScopeResource,assertSandboxDistributionOrder,createEcsDemoDistributionOrderScope,createPaymentDistributionStore} from "../src/finance/distribution-payment-store";

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
  for(const amountCents of ["100","1000001"]){
    await assert.rejects(declareLocalSandboxWithdrawalTarget(pool,actor,{bankBindingId:"bank_"+"a".repeat(32),bankBindingRevision:"1",amountCents},"target-key",scope()),
      (error:unknown)=>(error as {status?:number;code?:string}).status===422&&(error as {code?:string}).code==="DEMO_WITHDRAW_AMOUNT_OUT_OF_RANGE");
  }
  assert.equal(connections,0);
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
