import { test } from "node:test";
import assert from "node:assert/strict";
import { approveLocalNativePolicy, guardedApprovalPool, sameQualificationPopulation, assertRejectedPolicyRecovery } from "./local-distribution-policy-runtime.mjs";

test("policy approval preserves the exact source-unknown participant set", () => {
  const expected = { accepted: [{ userId: "eligible" }], existing: [], ineligible: [], unresolved: [{ userId: "unknown", revision: "1", reason: "ORIGINAL_QUALIFICATION_MISSING" }], exceptions: [] };
  assert.equal(sameQualificationPopulation(structuredClone(expected), expected, JSON.stringify), true);
  for (const changed of [
    { ...expected, unresolved: [] },
    { ...expected, unresolved: [{ ...expected.unresolved[0], revision: "2" }] },
    { ...expected, accepted: [...expected.accepted, { userId: "unknown" }] },
    { ...expected, exceptions: [{ reason: "OTHER_SOURCE_DRIFT" }] },
  ]) assert.equal(sameQualificationPopulation(changed, expected, JSON.stringify), false);
});

test('rejected policy recovery binds the old 503, unchanged source and original request key',()=>{
 const sha='a'.repeat(64),target={oid:'42',nonce:'b'.repeat(24),instance:{host:'127.0.0.1',port:55433,systemIdentifier:'123'}};
 const historicalFinance=[{source_kind:'HISTORICAL_PAYMENT',count:'1',digest:sha}],approvalKey='legacy_policy_'+'c'.repeat(40),plan={target,sourceDigest:sha,datasetSha256:sha,inputSha256:sha,approvalKey,approvalBody:{operationCode:'distribution.policy.publish'},accepted:[{userId:'u'}],existing:[],ineligible:[],unresolved:[{userId:'unknown'}],exceptions:[],historicalFinance};
 const failure={status:'STOPPED_READBACK_OR_PREPARE',mode:'--approve',pending:null,financialWrites:0,lockReleased:true,lockClientClosed:true,clientsClosed:true,inputSha256:sha,datasetSha256:sha,sourceDigest:sha,target,steps:[{step:'templates',status:200},{step:'configure-template',status:200,idempotencyKey:approvalKey+':template'},{step:'templates',status:200},{step:'request',status:503,idempotencyKey:approvalKey+':request'}]};
 const probe={schema:'zzsh.round07-distribution-guard-probe.v2',status:'READ_ONLY_ORIGINAL_GUARD_REPRODUCED',failureSha256:sha,previousPlanSha256:sha,target,observed:{status:503,code:'EVIDENCE_UNAVAILABLE',message:'Reviewed local distribution connection differs'},rollbackAck:true,unlockAck:true,connectionsClosed:true,targetWrites:0};
 const args={failure,previousPlan:plan,probe,plan,target,sourceDigest:sha,datasetSha256:sha,failureSha256:sha,previousPlanSha256:sha,canonicalize:JSON.stringify};
 assert.equal(assertRejectedPolicyRecovery(args).originalRequestKey,approvalKey+':request');
 for(const changed of [{...args,failure:{...failure,pending:{step:'request'}}},{...args,failure:{...failure,steps:[...failure.steps.slice(0,3),{...failure.steps[3],status:200}]}},{...args,probe:{...probe,targetWrites:1}},{...args,plan:{...plan,approvalKey:'other'}},{...args,plan:{...plan,unresolved:[]}}])assert.throws(()=>assertRejectedPolicyRecovery(changed),/DISTRIBUTION_REJECTED_RECOVERY_EVIDENCE_CHANGED/);
});

test("expired or changed build prevents the actual approval COMMIT", async () => {
  const statements = [], rawQuery = async sql => { statements.push(sql); return {}; }, rawRelease = () => {};
  const client = { query: rawQuery, release: rawRelease }, pool = { connect: async () => client, query: async () => ({}) };
  const guarded = guardedApprovalPool(pool, () => { throw Error("window expired"); });
  const c = await guarded.connect(); await c.query("BEGIN");
  assert.throws(() => c.query("COMMIT"), /window expired/); await c.query("ROLLBACK"); c.release();
  assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]); assert.equal(c.query, rawQuery); assert.equal(c.release, rawRelease);
});

test("busy regression maintenance lock stops before opening a policy database pool", async () => {
  let closed = false, saved = false;
  class FakeClient { async connect() {} async query() { return { rows: [{ ok: false }] }; } async end() { closed = true; } }
  const params = { Client: FakeClient, credentials: { migration: { name: "migration", password: "fixture" } }, base: {}, summary: {}, save: () => { saved = true; } };
  await assert.rejects(approveLocalNativePolicy(params), /DISTRIBUTION_MAINTENANCE_LOCK_BUSY/);
  assert(closed && saved && params.summary.lockClientClosed); assert.equal(params.summary.policyId, undefined);
});
