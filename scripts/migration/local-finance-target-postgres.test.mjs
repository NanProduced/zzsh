import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { acquireMigrationSessionFence, acquireMigrationTransactionFence, assertLiveTarget, assertMigrationFenceHeld, captureMaintenanceLockEpoch, guardedMigrationTargetPool, releaseMigrationSessionFence, targetIdentityQuery } from './local-target-registry.mjs';
import { executeQualification } from './local-distribution-qualification-runner.mjs';
import { guardCreditPoolClient } from './local-credit-initialization-plan.mjs';

const enabled = Boolean(process.env.ZZSH_SYNTH_FINANCE_TARGET_PORT || process.env.ZZSH_SYNTH_FINANCE_TARGET_SYSTEM);

test('next-round finance guard rejects a different PostgreSQL cluster, epoch, role or endpoint', { skip: !enabled }, async t => {
  const port = Number(process.env.ZZSH_SYNTH_FINANCE_TARGET_PORT), system = process.env.ZZSH_SYNTH_FINANCE_TARGET_SYSTEM;
  assert.equal(port, 61683); assert.match(system ?? '', /^[0-9]+$/);
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url)), { Pool, Client } = require('pg');
  const { assertFinanceMaintenanceResource, isReviewedFinanceMaintenanceEndpoint } = require('../../apps/api/dist/src/finance/personal-finance-maintenance.js');
  const { bindReviewedLegacyInvitationFacts } = require('../../apps/api/dist/src/finance/legacy-invitation-facts-maintenance.js');
  const { createControlledRegressionResource } = require('../../apps/api/dist/src/finance/controlled-regression-resource.js');
  const { createReviewedLocalNativeDistributionScope, assertDistributionPolicyWriteReadyInTransaction } = require('../../apps/api/dist/src/finance/distribution-policy-store.js');
  const { prepareLegacyBankImport, legacyBankImportRequestId, importLegacyBankBinding, readbackLegacyBankBinding, releaseLegacyBankImportPlan } = require('../../apps/api/dist/src/finance/legacy-withdrawal-bank-import.js');
  const { legacyOwnerUserId } = require('../../apps/api/dist/src/supply/legacy-user-migration.js');
  const { readLegacyBankTargetSet } = await import('./local-legacy-bank-runner.mjs');
  const base = { host: '127.0.0.1', port, database: 'zzsh_test_regression', user: 'postgres', password: 'synthetic-only-password', connectionTimeoutMillis: 3000 };
  const admin = new Pool({ ...base, max: 1 }); t.after(() => admin.end());
  const identity = (await admin.query(`SELECT current_database() AS database,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas,
    (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('zzsh','zzsh_regression_migration','zzsh_regression_runtime')) AS roles`)).rows[0];
  assert.deepEqual(identity, { database: 'zzsh_test_regression', marker: 'zzsh:synthetic:finance-target-v1', system, schemas: 0, roles: 0 });
  const nonce = 'a'.repeat(24);
  await admin.query(`CREATE ROLE zzsh NOLOGIN;
    CREATE ROLE zzsh_regression_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD 'synthetic-only-password';
    CREATE ROLE zzsh_regression_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD 'synthetic-only-password';
    ALTER DATABASE zzsh_test_regression OWNER TO zzsh;
    ALTER DATABASE zzsh_test_regression SET zzsh.regression_run = '${nonce}';
    COMMENT ON DATABASE zzsh_test_regression IS 'zzsh:regression-test:v1';
    GRANT CONNECT ON DATABASE zzsh_test_regression TO zzsh_regression_migration;
    GRANT CONNECT ON DATABASE zzsh_test_regression TO zzsh_regression_runtime;
    CREATE SCHEMA zzsh_order AUTHORIZATION zzsh_regression_migration;
    CREATE TABLE zzsh_order.finance_opening_basis(id text PRIMARY KEY);
    ALTER TABLE zzsh_order.finance_opening_basis OWNER TO zzsh_regression_migration;
    CREATE TABLE zzsh_order.distribution_participant(id text PRIMARY KEY);
    CREATE TABLE zzsh_order.distribution_invite_code(id text PRIMARY KEY);
    CREATE TABLE zzsh_order.invitation_relation(id text PRIMARY KEY);
    CREATE TABLE zzsh_order.distribution_policy_version(id text PRIMARY KEY);
    CREATE TABLE zzsh_order.distribution_policy_head(id text PRIMARY KEY);
    ALTER TABLE zzsh_order.distribution_participant OWNER TO zzsh_regression_migration;
    ALTER TABLE zzsh_order.distribution_invite_code OWNER TO zzsh_regression_migration;
    ALTER TABLE zzsh_order.invitation_relation OWNER TO zzsh_regression_migration;
    CREATE FUNCTION zzsh_order.distribution_policy_contract_version() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 2';
    CREATE SCHEMA zzsh_iam; CREATE SCHEMA zzsh_auth_admin; CREATE SCHEMA zzsh_auth_user; CREATE SCHEMA zzsh_supply; CREATE SCHEMA zzsh_content;
    CREATE TABLE zzsh_iam.audit_event(id text PRIMARY KEY,actor_type text,actor_id text,session_id text,action text,object_type text,object_id text,
      outcome text,request_id text,reason text,occurred_at timestamptz,details jsonb);
    CREATE TABLE zzsh_iam.admin_security(admin_user_id text PRIMARY KEY,status text,is_boss boolean,password_change_required boolean);
    CREATE TABLE zzsh_iam.user_identity_state(user_id text PRIMARY KEY,account_status text);
    CREATE TABLE zzsh_auth_user."user"(id text PRIMARY KEY);
    CREATE TABLE zzsh_auth_admin."user"(id text PRIMARY KEY,"twoFactorEnabled" boolean,suspended boolean);
    CREATE TABLE zzsh_auth_admin.session(id text PRIMARY KEY,"userId" text,locked boolean,"expiresAt" timestamptz,"pinHash" text,"pinFailures" integer);
    CREATE TABLE zzsh_order.withdrawal_bank_binding(id text PRIMARY KEY,user_id text UNIQUE,revision bigint,sealed_details text,card_mask text,holder_mask text,
      created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp());
    INSERT INTO zzsh_iam.admin_security VALUES ('synthetic-admin','ACTIVE',true,false);
    INSERT INTO zzsh_auth_admin."user" VALUES ('synthetic-admin',true,false);
    INSERT INTO zzsh_auth_admin.session VALUES ('synthetic-session','synthetic-admin',false,'2099-01-01Z',NULL,0);
    GRANT USAGE ON SCHEMA zzsh_iam,zzsh_auth_admin TO zzsh_regression_migration;
    GRANT USAGE ON SCHEMA zzsh_order,zzsh_iam,zzsh_auth_admin,zzsh_auth_user,zzsh_supply,zzsh_content TO zzsh_regression_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA zzsh_iam,zzsh_auth_admin TO zzsh_regression_migration;
    GRANT SELECT,UPDATE ON zzsh_iam.admin_security,zzsh_iam.user_identity_state,zzsh_auth_admin.session,zzsh_auth_user."user" TO zzsh_regression_runtime;
    GRANT SELECT ON zzsh_auth_admin."user" TO zzsh_regression_runtime;
    GRANT SELECT,INSERT ON zzsh_iam.audit_event,zzsh_order.withdrawal_bank_binding TO zzsh_regression_runtime`);
  const row = (await admin.query(`SELECT d.oid::int AS oid,d.datdba::int AS "ownerOid",r.oid::int AS "roleOid",
    (SELECT oid::int FROM pg_roles WHERE rolname='zzsh_regression_runtime') AS "runtimeRoleOid"
    FROM pg_database d JOIN pg_roles r ON r.rolname='zzsh_regression_migration' WHERE d.datname=current_database()`)).rows[0];
  const resource = { host: '127.0.0.1', port, database: 'zzsh_test_regression', oid: row.oid, owner: 'zzsh',
    marker: 'zzsh:regression-test:v1', role: 'zzsh_regression_migration', roleOid: row.roleOid,
    migrationProfile: 'LOCAL_MIGRATION_NEXT_V1', systemIdentifier: system, nonce };
  const actor = { userId: 'synthetic-admin', sessionId: 'synthetic-session', requestId: 'synthetic-request' };
  const review = { actor, resource, notBefore: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
  const client = new Client({ ...base, user: resource.role }); await client.connect(); t.after(() => client.end());
  await client.query('BEGIN READ ONLY');
  try {
    assert.equal(isReviewedFinanceMaintenanceEndpoint(resource), true);
    await assert.doesNotReject(assertFinanceMaintenanceResource(client, actor, review));
    for (const change of [{ systemIdentifier: '999' }, { nonce: 'b'.repeat(24) }, { oid: resource.oid + 1 }, { roleOid: resource.roleOid + 1 }, { port: 61684 }])
      await assert.rejects(assertFinanceMaintenanceResource(client, actor, { ...review, resource: { ...resource, ...change } }));
    await assert.rejects(assertFinanceMaintenanceResource(client, { ...actor, sessionId: 'other' }, review));
  } finally { assert.equal((await client.query('ROLLBACK')).command, 'ROLLBACK'); }
  const invitation = { ref: 'synthetic-review', attempt: 'attempt-1', actor: {userId:actor.userId,sessionId:actor.sessionId}, resource: { ...resource, ownerOid: row.ownerOid },
    notBefore: review.notBefore, expiresAt: review.expiresAt, sourceDigest: '1'.repeat(64), bodyDigest: '2'.repeat(64), phase: 'IMPORT' };
  await client.query('BEGIN');
  try {
    await assert.doesNotReject(bindReviewedLegacyInvitationFacts(client, actor, invitation));
    for (const change of [{ systemIdentifier: '999' }, { nonce: 'b'.repeat(24) }, { oid: resource.oid + 1 }, { roleOid: resource.roleOid + 1 }, { port: 61684 }])
      await assert.rejects(bindReviewedLegacyInvitationFacts(client, actor, { ...invitation, resource: { ...invitation.resource, ...change } }));
    await assert.rejects(bindReviewedLegacyInvitationFacts(client, { ...actor, sessionId: 'other' }, invitation));
  } finally { assert.equal((await client.query('ROLLBACK')).command, 'ROLLBACK'); }
  const migrationInstance = { host:'127.0.0.1',port,systemIdentifier:system,migrationProfile:'LOCAL_MIGRATION_NEXT_V1' };
  const config = {profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',targetProfile:'test',host:'127.0.0.1',port,
    name:'zzsh_test_regression',user:'zzsh_regression_runtime',runtimeUser:'zzsh_regression_runtime'}};
  const makeScope = instance => createReviewedLocalNativeDistributionScope(createControlledRegressionResource({...config,database:{...config.database,port:instance.port}},
    {resourceOid:row.oid,nonce,runtimeRoleOid:row.runtimeRoleOid,migrationInstance:instance},'DISTRIBUTION'),{owner:'zzsh',ownerOid:row.ownerOid,instance});
  const runtime = new Client({ ...base, user:'zzsh_regression_runtime' }); await runtime.connect(); t.after(() => runtime.end());
  await runtime.query('BEGIN');
  try {
    await assert.doesNotReject(assertDistributionPolicyWriteReadyInTransaction(runtime,makeScope(migrationInstance)));
    await assert.rejects(assertDistributionPolicyWriteReadyInTransaction(runtime,makeScope({...migrationInstance,systemIdentifier:'999'})));
    await assert.rejects(assertDistributionPolicyWriteReadyInTransaction(runtime,makeScope({...migrationInstance,port:61684})));
    assert.throws(()=>createControlledRegressionResource(config,{resourceOid:row.oid,nonce,runtimeRoleOid:row.runtimeRoleOid,migrationInstance},'WITHDRAWAL'));
  } finally { assert.equal((await runtime.query('ROLLBACK')).command, 'ROLLBACK'); }
  const legacyId='101',userId=legacyOwnerUserId('legacy_mysql_restore','la_user',legacyId),sourceDigest='a'.repeat(64);
  await admin.query('INSERT INTO zzsh_auth_user."user"(id) VALUES ($1)',[userId]);
  await admin.query("INSERT INTO zzsh_iam.user_identity_state VALUES ($1,'ACTIVE')",[userId]);
  await admin.query(`INSERT INTO zzsh_iam.audit_event(id,action,object_type,object_id,outcome,details) VALUES
    ('synthetic-owner-audit','user.legacy_owner.migrated','user',$1,'SUCCESS',$2::jsonb)`,
    [userId,JSON.stringify({sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',legacyId,sourceDigest})]);
  const bankTarget={round:'next',host:'127.0.0.1',port,database:'zzsh_test_regression',databaseOid:row.oid,marker:resource.marker,nonce,
    owner:'zzsh',ownerOid:row.ownerOid,runtimeUser:'zzsh_regression_runtime',runtimeRoleOid:row.runtimeRoleOid,
    migrationUser:'zzsh_regression_migration',migrationRoleOid:row.roleOid,instance:{host:'127.0.0.1',port,systemIdentifier:system},migrationProfile:'LOCAL_MIGRATION_NEXT_V1'};
  const bankSource={sourceReceiptSha256:'1'.repeat(64),sourceDumpSha256:'2'.repeat(64),sourceCutoff:'2026-11-01T00:00:00.000Z'};
  const bankOptions={database:bankTarget.database,runtimeUser:bankTarget.runtimeUser,protection:{currentKeyVersion:'synthetic-v1',keyFor:()=>Buffer.alloc(32,7)}};
  const bankPlan=prepareLegacyBankImport([{user_id:legacyId,name:'虚构用户',card_no:'0000000000000015',create_time:'1760000000',update_time:'1760000001'}],
    new Map([[legacyId,sourceDigest]]),bankSource,bankTarget,{userId:actor.userId,sessionId:actor.sessionId});
  try {
    const requestId=legacyBankImportRequestId(bankPlan,legacyId,bankOptions);
    await runtime.query('BEGIN');
    try {assert.equal((await importLegacyBankBinding(runtime,bankPlan,legacyId,bankOptions,requestId)).status,'IMPORTED');
      assert.equal((await runtime.query('COMMIT')).command,'COMMIT');}
    catch(error){await runtime.query('ROLLBACK');throw error;}
    await runtime.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      assert.equal(await readbackLegacyBankBinding(runtime,bankPlan,legacyId,bankOptions),true);
      assert.equal((await readLegacyBankTargetSet(runtime,1)).status,'BANK_TARGET_SET_READBACK_PASSED');
    } finally {assert.equal((await runtime.query('ROLLBACK')).command,'ROLLBACK');}
  } finally {releaseLegacyBankImportPlan(bankPlan);}
  const fenceTarget = { ...resource, host: base.host, port, oid: String(row.oid), instance: migrationInstance,
    lockKey: '806006', maintenanceDatabase: 'postgres' };
  const oldOwner = new Client({ ...base, database:'postgres', user:'zzsh_regression_migration' });
  const newOwner = new Client({ ...base, database:'postgres', user:'zzsh_regression_migration' });
  const contender = new Client({ ...base, user:'zzsh_regression_runtime' });
  let oldOpen=false, newOpen=false, contenderOpen=false;
  try {
    await oldOwner.connect(); oldOpen=true; await newOwner.connect(); newOpen=true; await contender.connect(); contenderOpen=true;
    assert.equal((await oldOwner.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok, true);
    const oldEpoch = await captureMaintenanceLockEpoch(oldOwner, fenceTarget);
    await runtime.query('BEGIN');
    await acquireMigrationTransactionFence(runtime, fenceTarget, oldEpoch);
    await oldOwner.end(); oldOpen=false;
    assert.equal((await newOwner.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok, true);
    const newEpoch = await captureMaintenanceLockEpoch(newOwner, fenceTarget);
    await contender.query('BEGIN');
    await assert.rejects(acquireMigrationTransactionFence(contender, fenceTarget, newEpoch), /TARGET_FENCE_BUSY/);
    assert.equal((await contender.query('ROLLBACK')).command, 'ROLLBACK');
    assert.equal((await runtime.query('COMMIT')).command, 'COMMIT');
    await contender.query('BEGIN');
    await acquireMigrationTransactionFence(contender, fenceTarget, newEpoch);
    assert.equal((await contender.query('ROLLBACK')).command, 'ROLLBACK');
    await contender.query('BEGIN');
    await assert.rejects(acquireMigrationTransactionFence(contender, fenceTarget, oldEpoch), /TARGET_FENCE_EPOCH_LOST/);
    assert.equal((await contender.query('ROLLBACK')).command, 'ROLLBACK');
    assert.equal((await newOwner.query('SELECT pg_advisory_unlock(806006::bigint) AS ok')).rows[0].ok, true);
  } finally {
    if (oldOpen) await oldOwner.end();
    if (newOpen) await newOwner.end();
    if (contenderOpen) await contender.end();
  }
  const sessionOwner = new Client({ ...base, database:'postgres', user:'zzsh_regression_migration' });
  const successor = new Client({ ...base, database:'postgres', user:'zzsh_regression_migration' });
  const follower = new Client({ ...base, user:'zzsh_regression_runtime' });
  let sessionOwnerOpen=false, successorOpen=false, followerOpen=false;
  try {
    await sessionOwner.connect(); sessionOwnerOpen=true; await successor.connect(); successorOpen=true; await follower.connect(); followerOpen=true;
    assert.equal((await sessionOwner.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok, true);
    const sessionEpoch = await captureMaintenanceLockEpoch(sessionOwner, fenceTarget);
    await acquireMigrationSessionFence(runtime, fenceTarget, sessionEpoch);
    await runtime.query('BEGIN'); await assertMigrationFenceHeld(runtime, fenceTarget, sessionEpoch);
    assert.equal((await runtime.query('COMMIT')).command, 'COMMIT');
    await sessionOwner.end(); sessionOwnerOpen=false;
    assert.equal((await successor.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok, true);
    const successorEpoch = await captureMaintenanceLockEpoch(successor, fenceTarget);
    await follower.query('BEGIN');
    await assert.rejects(acquireMigrationTransactionFence(follower, fenceTarget, successorEpoch), /TARGET_FENCE_BUSY/);
    assert.equal((await follower.query('ROLLBACK')).command, 'ROLLBACK');
    await assert.rejects(assertMigrationFenceHeld(runtime, fenceTarget, sessionEpoch), /TARGET_FENCE_EPOCH_LOST/);
    await releaseMigrationSessionFence(runtime, fenceTarget);
    await follower.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await acquireMigrationTransactionFence(follower, fenceTarget, successorEpoch);
    assert.equal((await follower.query('ROLLBACK')).command, 'ROLLBACK');
    assert.equal((await successor.query('SELECT pg_advisory_unlock(806006::bigint) AS ok')).rows[0].ok, true);
  } finally {
    if (sessionOwnerOpen) await sessionOwner.end();
    if (successorOpen) await successor.end();
    if (followerOpen) await follower.end();
  }
  await admin.query(`CREATE TABLE zzsh_order.synthetic_qualification(id text PRIMARY KEY);
    GRANT INSERT,SELECT ON zzsh_order.synthetic_qualification TO zzsh_regression_migration`);
  const registered = { ...fenceTarget, migrationRole:'zzsh_regression_migration', migrationRoleOid:String(row.roleOid),
    runtimeRole:'zzsh_regression_runtime', runtimeRoleOid:String(row.runtimeRoleOid) };
  const registry = { ...registered, roles:{ migration:{name:registered.migrationRole,oid:registered.migrationRoleOid} } };
  const qualificationPool = new Pool({ ...base, user:registered.migrationRole, max:1 });
  const qualificationLock = new Client({ ...base, database:'postgres', user:registered.migrationRole });
  const summary = {}, batch = { bodyDigest:'synthetic-digest', body:{subjects:[{userId:'synthetic-subject'}]} };
  await executeQualification({ pool:qualificationPool, lock:qualificationLock, registeredTarget:registered, registry, target:registered,
    identity:async client=>{const value=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,value);return value;},
    plan:{target:{ownerOid:row.ownerOid},batches:[batch]},
    authority:{approvalRef:'synthetic',attempt:'1',notBefore:'2026-01-01T00:00:00.000Z',expiresAt:'2099-01-01T00:00:00.000Z'},
    actor, sourceDigest:'synthetic', summary, save(){}, verifyBuild(){}, bind:async (_client,_actor,review)=>review,
    qualify:async (client,_actor,body,review)=>{await client.query("INSERT INTO zzsh_order.synthetic_qualification VALUES ('synthetic')");
      return {status:200,body:{bodyDigest:review.bodyDigest,participants:body.subjects.length,financialEffects:false}};} });
  assert.equal(summary.transaction.fence,'HELD_UNTIL_TRANSACTION_END');
  assert.equal(summary.transaction.status,'COMMIT_ACKNOWLEDGED');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM zzsh_order.synthetic_qualification')).rows[0].n,1);
  await admin.query(`CREATE TABLE zzsh_order.synthetic_growth(id text PRIMARY KEY);
    GRANT INSERT,SELECT ON zzsh_order.synthetic_growth TO zzsh_regression_migration`);
  const cli = require('../../apps/api/dist/src/auth/membership-growth-legacy-cli.js');
  const growthMaintenance = require('../../apps/api/dist/src/auth/membership-growth-legacy-maintenance.js');
  const { canonicalize } = require('../../apps/api/dist/src/supply/content-hash.js');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const source = { subjectUserId:'synthetic-subject', cutoff:'2026-10-18T00:00:00.000000Z', fromExclusive:null,
    sourceExtractSha256:'b'.repeat(64), sourceSetSha256:hash(canonicalize({subjectUserId:'synthetic-subject',cutoff:'2026-10-18T00:00:00.000000Z',fromExclusive:null,expectedSourceKeys:[]})),
    expectedSourceKeys:[], refundReviewEvidenceRefs:['SYNTHETIC_NONE'] };
  const business=Buffer.from(JSON.stringify({schema:'legacy-growth-maintenance-package-v1',reason:'Synthetic transaction test',
    source:{receipt:source,inputs:[],corrections:[],admitted:{receiptDigests:[hash(canonicalize(source))],componentDigests:[],correctionDigests:[]},gameIdBySettlementId:{}}}));
  const now=Date.now(), key='legacy-growth:synthetic-fence-0001';
  const approval=Buffer.from(JSON.stringify({schema:'legacy-growth-maintenance-approval-v2',status:'APPROVED',approvalRef:'SYNTHETIC-GROWTH-FENCE',attempt:1,mode:'APPLY',
    businessPackageSha256:hash(business),executionKey:key,actor:{adminId:actor.userId,sessionId:actor.sessionId},
    windowStartUtc:new Date(now-60000).toISOString(),windowEndUtc:new Date(now+600000).toISOString(),
    resource:{databaseName:registered.database,databaseOid:registered.oid,owner:registered.owner,runtimeRole:registered.migrationRole,
      bindingKind:'DATABASE_COMMENT',databaseComment:registered.marker}}));
  const input=cli.readLegacyGrowthMaintenanceRun({LEGACY_GROWTH_ENABLED:'true',LEGACY_GROWTH_PACKAGE_FILE:'business',LEGACY_GROWTH_PACKAGE_SHA256:hash(business),
    LEGACY_GROWTH_APPROVAL_FILE:'approval',LEGACY_GROWTH_APPROVAL_SHA256:hash(approval),LEGACY_GROWTH_MODE:'APPLY'},
    file=>file==='business'?business:approval,now,{databaseName:registered.database,databaseUser:registered.migrationRole}).input;
  t.mock.method(growthMaintenance,'applyLegacyGrowthMaintenance',async client=>{
    await client.query("INSERT INTO zzsh_order.synthetic_growth VALUES ('synthetic')");
    return {replayed:false,receipt:{coverageFingerprint:'c'.repeat(64),sourceReceiptDigest:'d'.repeat(64)}};
  });
  const growthPool = new Pool({ ...base, user:registered.migrationRole, max:1, idleTimeoutMillis:0 });
  const growthOwner = new Client({ ...base, database:'postgres', user:registered.migrationRole });
  const growthSuccessor = new Client({ ...base, database:'postgres', user:registered.migrationRole });
  const growthContender = new Client({ ...base, user:registered.runtimeRole });
  let growthOwnerOpen=false, growthSuccessorOpen=false, growthContenderOpen=false;
  try {
    await growthOwner.connect(); growthOwnerOpen=true; await growthSuccessor.connect(); growthSuccessorOpen=true; await growthContender.connect(); growthContenderOpen=true;
    assert.equal((await growthOwner.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok,true);
    const growthEpoch=await captureMaintenanceLockEpoch(growthOwner,registered), fenceClient=await growthPool.connect();
    await acquireMigrationSessionFence(fenceClient,registered,growthEpoch);
    const fencePid=fenceClient.processID; fenceClient.release();
    const fencedPool=guardedMigrationTargetPool(growthPool,async client=>{
      assert.equal(client.getTransactionStatus(),'I'); assert.equal(client.processID,fencePid);
    });
    let successorEpoch;
    await cli.runLegacyGrowthMaintenanceApply(fencedPool,input,{},async client=>{
      await assertMigrationFenceHeld(client,registered,growthEpoch);
      await growthOwner.end(); growthOwnerOpen=false;
      assert.equal((await growthSuccessor.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok,true);
      successorEpoch=await captureMaintenanceLockEpoch(growthSuccessor,registered);
      await growthContender.query('BEGIN');
      await assert.rejects(acquireMigrationTransactionFence(growthContender,registered,successorEpoch),/TARGET_FENCE_BUSY/);
      assert.equal((await growthContender.query('ROLLBACK')).command,'ROLLBACK');
    });
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM zzsh_order.synthetic_growth')).rows[0].n,1);
    const finalClient=await growthPool.connect(); await releaseMigrationSessionFence(finalClient,registered); finalClient.release();
    await growthContender.query('BEGIN'); await acquireMigrationTransactionFence(growthContender,registered,successorEpoch);
    assert.equal((await growthContender.query('ROLLBACK')).command,'ROLLBACK');
    assert.equal((await growthSuccessor.query('SELECT pg_advisory_unlock(806006::bigint) AS ok')).rows[0].ok,true);
  } finally {
    await growthPool.end();
    if(growthOwnerOpen) await growthOwner.end();
    if(growthSuccessorOpen) await growthSuccessor.end();
    if(growthContenderOpen) await growthContender.end();
  }
  const secondLegacyId='102',secondUserId=legacyOwnerUserId('legacy_mysql_restore','la_user',secondLegacyId),secondDigest='b'.repeat(64);
  await admin.query('INSERT INTO zzsh_auth_user."user"(id) VALUES ($1)',[secondUserId]);
  await admin.query("INSERT INTO zzsh_iam.user_identity_state VALUES ($1,'ACTIVE')",[secondUserId]);
  await admin.query(`INSERT INTO zzsh_iam.audit_event(id,action,object_type,object_id,outcome,details) VALUES
    ('synthetic-owner-audit-2','user.legacy_owner.migrated','user',$1,'SUCCESS',$2::jsonb)`,
    [secondUserId,JSON.stringify({sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',legacyId:secondLegacyId,sourceDigest:secondDigest})]);
  const syntheticSource={rows:[{user_id:secondLegacyId,name:'虚构用户',card_no:'0000000000000016',create_time:'1760000000',update_time:'1760000001'}],
    userDigests:new Map([[secondLegacyId,secondDigest]]),source:{sourceReceiptSha256:'1'.repeat(64),sourceDumpSha256:'2'.repeat(64),sourceCutoff:'2026-11-01T00:00:00.000Z'}};
  const syntheticSelection={selected:new Map([[secondLegacyId,secondDigest]]),sourceReceiptSha256:'1'.repeat(64),datasetSha256:'3'.repeat(64)};
  t.mock.module(new URL('./local-legacy-bank-source.mjs',import.meta.url),{namedExports:{
    captureBoundLegacyBankSource:async()=>({}),useBoundLegacyBankSource:()=>syntheticSource,releaseBoundLegacyBankSource(){},
    captureBoundLegacyBankSelection:async()=>({}),useBoundLegacyBankSelection:()=>syntheticSelection,releaseBoundLegacyBankSelection(){} }});
  const bankRunner=await import('./local-legacy-bank-runner.mjs?synthetic-fence');
  const bankApi=require('../../apps/api/dist/src/finance/legacy-withdrawal-bank-import.js');
  const token=await bankRunner.prepareLocalLegacyBankRun({sourceInput:{},selectionInput:{path:'synthetic',sha256:syntheticSelection.datasetSha256},
    canonicalize, target:bankTarget,operator:{userId:actor.userId,sessionId:actor.sessionId},options:bankOptions,api:bankApi});
  const bankPlanSummary=bankRunner.describeLocalLegacyBankRun(token),buildSha256='4'.repeat(64);
  const bankAuthority={schema:'zzsh.local-legacy-bank-authority.v1',purpose:'LOCAL_MIGRATION_BANK_IMPORT',binding:bankPlanSummary.binding,
    commitment:bankPlanSummary.commitment,buildSha256,maxWrites:1,notBefore:'2020-01-01T00:00:00.000Z',expiresAt:'2099-01-01T00:00:00.000Z'};
  const bankWritePool=new Pool({...base,user:registered.runtimeRole,max:1,idleTimeoutMillis:0});
  const bankReadPool=new Pool({...base,user:registered.runtimeRole,max:1});
  let loseBankLock=false;
  const withBankLock=async fn=>{
    const lock=new Client({...base,database:'postgres',user:registered.migrationRole});let lockOpen=false,fencePid;
    try {
      await lock.connect();lockOpen=true;assert.equal((await lock.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok,true);
      const epoch=await captureMaintenanceLockEpoch(lock,registered),holder=await bankWritePool.connect();
      try {await acquireMigrationSessionFence(holder,registered,epoch);fencePid=holder.processID;} finally {holder.release();}
      const writePool=guardedMigrationTargetPool(bankWritePool,async client=>assert.equal(client.processID,fencePid));let checks=0;
      const verifyWrite=async client=>{if(loseBankLock&&++checks===2){await lock.end();lockOpen=false;}await assertMigrationFenceHeld(client,registered,epoch);};
      const verifyRead=async()=>{const client=await writePool.connect();try{await assertMigrationFenceHeld(client,registered,epoch);}finally{client.release();}};
      await fn({writePool,verifyWrite,verifyRead});
    } finally {
      if(fencePid){const holder=await bankWritePool.connect();try{await releaseMigrationSessionFence(holder,registered);}finally{holder.release();}}
      if(lockOpen){await lock.query('SELECT pg_advisory_unlock(806006::bigint)');await lock.end();}
    }
  };
  const verifyReadTarget=async client=>{const value=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,value,'runtime');assert.equal(value.read_only,'on');};
  try {
    loseBankLock=true;
    const failed=await bankRunner.executeLocalLegacyBankRun(token,{authority:bankAuthority,buildSha256,verifyBuild:async()=>{},withMaintenanceLock:withBankLock,
      writePool:bankWritePool,readPool:bankReadPool,verifyReadTarget,persistBatch:async()=>{}});
    assert.equal(failed.rollbackAck,true);assert.equal(failed.status,'STOPPED');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM zzsh_order.withdrawal_bank_binding WHERE user_id=$1',[secondUserId])).rows[0].n,0);
    loseBankLock=false;
    const applied=await bankRunner.executeLocalLegacyBankRun(token,{authority:bankAuthority,buildSha256,verifyBuild:async()=>{},withMaintenanceLock:withBankLock,
      writePool:bankWritePool,readPool:bankReadPool,verifyReadTarget,persistBatch:async()=>{}});
    assert.equal(applied.counts.imported,1);assert.equal(applied.counts.readbackMatched,1);
    assert.equal(applied.status,'READBACK_MISMATCH');assert.equal(applied.targetSet.status,'BANK_TARGET_SET_REVIEW_REQUIRED');
  } finally {bankRunner.releaseLocalLegacyBankRun(token);await bankWritePool.end();await bankReadPool.end();}
  await admin.query(`CREATE TABLE zzsh_order.synthetic_credit(id text PRIMARY KEY);
    GRANT INSERT,SELECT ON zzsh_order.synthetic_credit TO zzsh_regression_runtime`);
  const creditOwner=new Client({...base,database:'postgres',user:registered.migrationRole});
  const creditWriter=new Client({...base,user:registered.runtimeRole});let creditOwnerOpen=false,creditWriterOpen=false;
  try {
    await creditOwner.connect();creditOwnerOpen=true;await creditWriter.connect();creditWriterOpen=true;
    assert.equal((await creditOwner.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok,true);
    const creditEpoch=await captureMaintenanceLockEpoch(creditOwner,registered);
    await acquireMigrationSessionFence(creditWriter,registered,creditEpoch);
    guardCreditPoolClient(creditWriter,{afterBegin:async client=>assertMigrationFenceHeld(client,registered,creditEpoch),
      beforeCommit:async client=>assertMigrationFenceHeld(client,registered,creditEpoch)});
    await creditWriter.query('BEGIN');await creditWriter.query("INSERT INTO zzsh_order.synthetic_credit VALUES ('synthetic')");
    await creditOwner.end();creditOwnerOpen=false;
    await assert.rejects(creditWriter.query('COMMIT'),/TARGET_FENCE_EPOCH_LOST/);
    assert.equal((await creditWriter.query('ROLLBACK')).command,'ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM zzsh_order.synthetic_credit')).rows[0].n,0);
    await releaseMigrationSessionFence(creditWriter,registered);
  } finally {if(creditOwnerOpen)await creditOwner.end();if(creditWriterOpen)await creditWriter.end();}
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM zzsh_order.finance_opening_basis')).rows[0].n, 0);
});
