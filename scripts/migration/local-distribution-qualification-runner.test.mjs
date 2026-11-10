import { test } from "node:test";
import assert from "node:assert/strict";
import { executeQualification, qualificationReviewResource, assertQualificationRecoveryPreimage } from "./local-distribution-qualification-runner.mjs";

test('qualification review binds R07 port, cluster, database, owner, marker and role',()=>{
 const instance={host:'127.0.0.1',port:55433,systemIdentifier:'123'},target={oid:'41',migrationRoleOid:'11',instance},registry={instance,database:'zzsh_test_regression',owner:'zzsh',marker:'marker',roles:{migration:{name:'migration',oid:'11'}}};
 const current={oid:'41',system_identifier:'123',database:registry.database,owner:'zzsh',owner_oid:10,marker:'marker',role:'migration',role_oid:'11',read_only:'off'};
 assert.equal(qualificationReviewResource(current,registry,target).port,55433);
 assert.equal(qualificationReviewResource({...current,read_only:'on'},registry,target,{readOnly:true}).port,55433);
 assert.throws(()=>qualificationReviewResource(current,registry,target,{readOnly:true}),/DISTRIBUTION_QUALIFICATION_INSTANCE_CHANGED/);
 for(const changed of [{system_identifier:'9'},{oid:'42'},{database:'other'},{owner:'other'},{marker:'other'},{role:'runtime'},{role_oid:'12'},{read_only:'on'}])assert.throws(()=>qualificationReviewResource({...current,...changed},registry,target),/DISTRIBUTION_QUALIFICATION_INSTANCE_CHANGED/);
 assert.throws(()=>qualificationReviewResource(current,{...registry,instance:{...instance,port:55432}},target),/DISTRIBUTION_QUALIFICATION_INSTANCE_CHANGED/);
 assert.throws(()=>qualificationReviewResource(current,{...registry,instance:{...instance,systemIdentifier:'9'}},target),/DISTRIBUTION_QUALIFICATION_INSTANCE_CHANGED/);
 assert.equal(qualificationReviewResource({oid:'41',owner:'zzsh',owner_oid:10,marker:'marker',role:'runtime',role_oid:'11'},{database:'zzsh_test_regression'},{nonce:'n'}).port,55432);
});
test('qualification review accepts only the registered next-round profile and exact cluster',()=>{
 const instance={host:'127.0.0.1',port:55435,systemIdentifier:'123'},migrationProfile='LOCAL_MIGRATION_NEXT_V1';
 const nonce='a'.repeat(24),target={oid:'41',nonce,migrationRoleOid:'11',instance,migrationProfile},registry={instance,nonce,migrationProfile,database:'zzsh_test_regression',owner:'zzsh',marker:'marker',roles:{migration:{name:'migration',oid:'11'}}};
 const current={oid:'41',nonce,system_identifier:'123',database:registry.database,owner:'zzsh',owner_oid:10,marker:'marker',role:'migration',role_oid:'11',read_only:'off'};
 assert.equal(qualificationReviewResource(current,registry,target).port,55435);
 assert.throws(()=>qualificationReviewResource(current,{...registry,migrationProfile:undefined},target));
 assert.throws(()=>qualificationReviewResource(current,registry,{...target,migrationProfile:undefined}));
 assert.throws(()=>qualificationReviewResource({...current,system_identifier:'999'},registry,target));
 assert.throws(()=>qualificationReviewResource({...current,nonce:'b'.repeat(24)},registry,target));
});

test('retry rechecks all subjects, policy, audit and original keys before any batch',async()=>{
 const plan={accepted:[{userId:'u'}],ineligible:[],unresolved:[{userId:'x'}],existing:[],batches:[{bodyDigest:'a'}],policyId:'p'},actor={userId:'boss'};
 const client=(changed=false)=>({query:async sql=>sql.includes('jsonb_to_recordset')?{rows:[{n:changed?1:0}]}:{rows:[{participants:2,receipts:0,audits:0,policy_heads:1}]}});
 assert.equal((await assertQualificationRecoveryPreimage(client(),plan,actor)).status,'ORIGINAL_QUALIFICATION_PREIMAGE_RECHECKED');
 await assert.rejects(assertQualificationRecoveryPreimage(client(true),plan,actor),/DISTRIBUTION_RECOVERY_PREIMAGE_CHANGED/);
 await assert.rejects(assertQualificationRecoveryPreimage({query:async sql=>sql.includes('jsonb_to_recordset')?{rows:[{n:0}]}:{rows:[{participants:2,receipts:1,audits:0,policy_heads:1}]}},plan,actor),/DISTRIBUTION_RECOVERY_PREIMAGE_CHANGED/);
});

function fixture(failure = "") {
  const calls = [], summary = {}, batches = ["a", "b"].map(id => ({ bodyDigest: id, body: { subjects: [{ userId: id }] } }));
  let callsToQualify = 0, destroyed, lockChecks = 0;
  const client = { query: async sql => { calls.push(sql); if (failure === "commit" && sql === "COMMIT" || failure === "rollback" && sql === "ROLLBACK") throw Error("connection lost"); return { rows: [], command: failure === 'commit-tag' && sql === 'COMMIT' ? 'ROLLBACK' : failure === 'rollback-tag' && sql === 'ROLLBACK' ? 'UNKNOWN' : sql }; }, release: value => { destroyed = value; calls.push("RELEASE"); } };
  const pool = { connect: async () => { calls.push("POOL_CONNECT"); return client; }, end: async () => calls.push("POOL_END") };
  const lock = { connect: async () => calls.push("LOCK_CONNECT"), query: async sql => { calls.push(sql); if (sql.includes('pg_locks')) return { rows: [{ database: 'postgres', system_identifier: '123', held: failure !== 'lock-lost' || ++lockChecks === 1 }] }; return { rows: [{ ok: failure !== "lock" }] }; }, end: async () => calls.push("LOCK_END") };
  const params = { pool, lock, identity: async () => ({ oid: "41", owner: "zzsh", owner_oid: 10, marker: "marker", role: "runtime", role_oid: "11" }), plan: { target: { ownerOid: 10 }, batches }, authority: { approvalRef: "ref", attempt: "a", notBefore: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, actor: { userId: "boss", sessionId: "session" }, registry: { database: "zzsh_test_regression" }, target: { nonce: "nonce" }, sourceDigest: "source", summary, save: () => calls.push("SAVE"), verifyBuild: () => { if (failure === "drift" && callsToQualify === 1) throw Error("build changed"); },
    bind: async (_, __, review) => { calls.push("BIND:" + review.bodyDigest); return review; }, qualify: async (_, __, body, review) => { calls.push("QUALIFY:" + review.bodyDigest); callsToQualify++; if (failure === "batch" && callsToQualify === 2 || failure === "rollback" || failure === 'rollback-tag') throw Error("rejected"); return { status: 200, body: { bodyDigest: review.bodyDigest, participants: body.subjects.length, financialEffects: false } }; } };
  return { params, calls, summary, get destroyed() { return destroyed; } };
}

function nextFixture(failure = '') {
  const f = fixture(), migrationProfile = 'LOCAL_MIGRATION_NEXT_V1', nonce = 'a'.repeat(24);
  const instance = { host: '127.0.0.1', port: 55435, systemIdentifier: '123' };
  const registered = { migrationProfile, host: instance.host, port: instance.port, instance, database: 'zzsh_test_regression',
    oid: '41', nonce, marker: 'marker', owner: 'zzsh', migrationRole: 'migration', migrationRoleOid: '11', lockKey: '806006', maintenanceDatabase: 'postgres' };
  f.params.registeredTarget = registered;
  f.params.target = { ...registered, migrationRoleOid: '11' };
  f.params.registry = { migrationProfile, instance, nonce, database: registered.database, owner: registered.owner, marker: registered.marker,
    roles: { migration: { name: 'migration', oid: '11' } } };
  f.params.identity = async () => ({ oid: '41', nonce, system_identifier: '123', database: registered.database,
    owner: 'zzsh', owner_oid: 10, marker: 'marker', role: 'migration', role_oid: '11', read_only: 'off' });
  const queryLock = f.params.lock.query;
  f.params.lock.query = async sql => sql.includes('pg_try_advisory_lock($1') ? { rows: [{ acquired: true }] }
    : sql === 'SELECT pg_backend_pid() AS pid' ? { rows: [{ pid: 123 }] } : queryLock(sql);
  const connect = f.params.pool.connect;
  f.params.pool.connect = async () => {
    const client = await connect(), query = client.query;
    client.getTransactionStatus = () => 'T';
    client.query = async sql => {
      if (sql.includes('pg_try_advisory_xact_lock')) { f.calls.push('FENCE'); return { rows: [{ acquired: failure !== 'busy' }] }; }
      if (sql.includes('pg_locks')) return { rows: [{ database: registered.database, oid: '41', nonce, system_identifier: '123', held: failure !== 'lost' }] };
      return query(sql);
    };
    return client;
  };
  return f;
}

test('next-round qualification holds the target fence before any qualification write', async () => {
  const f = nextFixture(); await executeQualification(f.params);
  assert.equal(f.summary.transaction.fence, 'HELD_UNTIL_TRANSACTION_END');
  assert(f.calls.indexOf('BEGIN') < f.calls.indexOf('FENCE') && f.calls.indexOf('FENCE') < f.calls.indexOf('QUALIFY:a'));
  for (const failure of ['busy', 'lost']) {
    const rejected = nextFixture(failure);
    await assert.rejects(executeQualification(rejected.params), /TARGET_FENCE_(BUSY|EPOCH_LOST)/);
    assert.equal(rejected.summary.rollbackAck, true); assert(!rejected.calls.some(call => call.startsWith('QUALIFY:')));
  }
  const missing = nextFixture(); delete missing.params.registeredTarget;
  await assert.rejects(executeQualification(missing.params), /DISTRIBUTION_FENCE_TARGET_CHANGED/);
  assert(!missing.calls.includes('BEGIN'));
});

test("all batches share one locked transaction and one commit", async () => {
  const f = fixture(); await executeQualification(f.params);
  assert.equal(f.summary.status, "COMMITTED_ACK_READBACK_REQUIRED"); assert.equal(f.summary.batches.length, 2);
  assert.equal(f.summary.transaction.status, 'COMMIT_ACKNOWLEDGED'); assert.equal(f.summary.transaction.committedBatches,2);
  assert(f.summary.batches.every(b=>b.status==='ACK_IN_OPEN_TRANSACTION'&&Number.isFinite(b.elapsedMs)));
  assert.equal(f.calls.filter(s => s === "BEGIN").length, 1); assert.equal(f.calls.filter(s => s === "COMMIT").length, 1);
  assert(!f.calls.includes("ROLLBACK")); assert.equal(f.summary.lockReleased, true); assert.equal(f.summary.clientsClosed, true);
});

test("a later batch failure rolls back every earlier batch", async () => {
  const f = fixture("batch"); await assert.rejects(executeQualification(f.params), /rejected/);
  assert.equal(f.summary.status, "STOPPED"); assert.equal(f.summary.rollbackAck, true);
  assert.equal(f.summary.transaction.status,'ROLLBACK_ACKNOWLEDGED'); assert.equal(f.summary.transaction.committedBatches,undefined);
  assert(f.calls.includes("ROLLBACK")); assert(!f.calls.includes("COMMIT")); assert.equal(f.summary.lockReleased, true);
});

test('final constraint timeout is finite and never extends the approved window',async()=>{
 const f=fixture();f.params.now=()=>Date.parse(f.params.authority.expiresAt)-5000;await executeQualification(f.params);
 assert.equal(f.summary.timings.constraintBudgetMs,4000);assert(f.calls.some(x=>x.includes("set_config('statement_timeout'")));
 const expired=fixture();expired.params.now=()=>Date.parse(expired.params.authority.expiresAt)-1500;
 await assert.rejects(executeQualification(expired.params),/DISTRIBUTION_AUTHORITY_EXPIRED_BEFORE_CONSTRAINTS/);
 assert.equal(expired.summary.rollbackAck,true);assert(!expired.calls.includes('SET CONSTRAINTS ALL IMMEDIATE'));assert(!expired.calls.includes('COMMIT'));
});

test('the optional qualification index is prepared once inside the transaction and reused only for those batches',async()=>{
 const f=fixture(),token=Object.freeze({kind:'INDEX'}),original=f.params.bind,seen=[];
 f.params.bind=async (...args)=>{seen.push(args[4]);return original(...args)};
 f.params.prepareIndex=async(client,actor,scope)=>{assert.equal(client!==undefined,true);assert.equal(actor.userId,'boss');assert.equal(scope.bodyDigest,'a');f.calls.push('INDEX');return token;};
 await executeQualification(f.params);
 assert.deepEqual(seen,[undefined,token,token]);assert.equal(f.calls.filter(x=>x==='INDEX').length,1);
 assert(f.calls.indexOf('BEGIN')<f.calls.indexOf('INDEX'));assert(f.calls.indexOf('INDEX')<f.calls.indexOf('QUALIFY:a'));
 assert.equal(f.summary.transaction.status,'COMMIT_ACKNOWLEDGED');
});

test('a rejected index rolls back before any qualification batch',async()=>{
 const f=fixture();f.params.prepareIndex=async()=>{throw Error('source changed')};
 await assert.rejects(executeQualification(f.params),/source changed/);
 assert.equal(f.summary.transaction.status,'ROLLBACK_ACKNOWLEDGED');assert.equal(f.summary.rollbackAck,true);
 assert(!f.calls.some(x=>x.startsWith('QUALIFY:')));assert(!f.calls.includes('COMMIT'));
});

test("commit acknowledgement loss is unknown and never automatically retried", async () => {
  const f = fixture("commit"); await assert.rejects(executeQualification(f.params), /connection lost/);
  assert.equal(f.summary.status, "COMMIT_UNKNOWN"); assert(!f.calls.includes("ROLLBACK"));
  assert.equal(f.summary.transaction.status,'COMMIT_UNKNOWN'); assert.equal(f.summary.transaction.committedBatches,undefined);
  assert.equal(f.calls.filter(s => s === "COMMIT").length, 1); assert.equal(f.destroyed, true);
});

test('unexpected transaction command tags preserve unknown outcomes and discard the client', async () => {
  const commit = fixture('commit-tag'); await assert.rejects(executeQualification(commit.params), /DISTRIBUTION_COMMIT_ACK_UNCONFIRMED/);
  assert.equal(commit.summary.status, 'COMMIT_UNKNOWN'); assert.equal(commit.summary.transaction.status, 'COMMIT_UNKNOWN');
  assert.equal(commit.destroyed, true); assert(!commit.calls.includes('ROLLBACK'));
  const rollback = fixture('rollback-tag'); await assert.rejects(executeQualification(rollback.params), /rejected/);
  assert.equal(rollback.summary.rollbackAck, false); assert.equal(rollback.summary.transaction.status, 'ROLLBACK_UNKNOWN');
  assert.equal(rollback.destroyed, true); assert(!rollback.calls.includes('COMMIT'));
});

test('loss of the maintenance lock before commit rolls back the qualification transaction', async () => {
  const f = fixture('lock-lost'); await assert.rejects(executeQualification(f.params), /TARGET_MAINTENANCE_LOCK_LOST/);
  assert.equal(f.summary.status, 'STOPPED'); assert.equal(f.summary.transaction.status, 'ROLLBACK_ACKNOWLEDGED');
  assert.equal(f.summary.rollbackAck, true); assert(f.calls.includes('ROLLBACK')); assert(!f.calls.includes('COMMIT'));
});

test("failed rollback destroys the connection; busy lock makes no business connection", async () => {
  const r = fixture("rollback"); await assert.rejects(executeQualification(r.params));
  assert.equal(r.summary.rollbackAck, false); assert.equal(r.destroyed, true);
  const l = fixture("lock"); await assert.rejects(executeQualification(l.params), /DISTRIBUTION_MAINTENANCE_LOCK_BUSY/);
  assert(!l.calls.includes("POOL_CONNECT")); assert(!l.calls.includes("BEGIN"));
});

test("a build changed between batches stops and rolls back", async () => {
  const f = fixture("drift"); await assert.rejects(executeQualification(f.params), /build changed/);
  assert.equal(f.summary.status, "STOPPED"); assert.equal(f.summary.rollbackAck, true);
  assert(f.calls.includes("ROLLBACK")); assert(!f.calls.includes("COMMIT"));
});

test("a failed pool close still closes the lock client and is not a finished readback", async () => {
  const f=fixture();f.params.pool.end=async()=>{throw Error('pool close failed')};
  await assert.rejects(executeQualification(f.params),/DISTRIBUTION_LOCK_RELEASE_UNCONFIRMED/);
  assert.equal(f.summary.status,'COMMITTED_ACK_READBACK_REQUIRED');assert.equal(f.summary.poolClosed,false);
  assert.equal(f.summary.lockClientClosed,true);assert.equal(f.summary.clientsClosed,false);
});
