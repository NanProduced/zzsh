import { test } from "node:test";
import assert from "node:assert/strict";
import { executeQualification } from "./local-distribution-qualification-runner.mjs";

function fixture(failure = "") {
  const calls = [], summary = {}, batches = ["a", "b"].map(id => ({ bodyDigest: id, body: { subjects: [{ userId: id }] } }));
  let callsToQualify = 0, destroyed;
  const client = { query: async sql => { calls.push(sql); if (failure === "commit" && sql === "COMMIT" || failure === "rollback" && sql === "ROLLBACK") throw Error("connection lost"); return { rows: [] }; }, release: value => { destroyed = value; calls.push("RELEASE"); } };
  const pool = { connect: async () => { calls.push("POOL_CONNECT"); return client; }, end: async () => calls.push("POOL_END") };
  const lock = { connect: async () => calls.push("LOCK_CONNECT"), query: async sql => { calls.push(sql); return { rows: [{ ok: failure !== "lock" }] }; }, end: async () => calls.push("LOCK_END") };
  const params = { pool, lock, identity: async () => ({ oid: "41", owner: "zzsh", owner_oid: 10, marker: "marker", role: "runtime", role_oid: "11" }), plan: { target: { ownerOid: 10 }, batches }, authority: { approvalRef: "ref", attempt: "a", notBefore: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }, actor: { userId: "boss", sessionId: "session" }, registry: { database: "zzsh_test_regression" }, target: { nonce: "nonce" }, sourceDigest: "source", summary, save: () => calls.push("SAVE"), verifyBuild: () => { if (failure === "drift" && callsToQualify === 1) throw Error("build changed"); },
    bind: async (_, __, review) => { calls.push("BIND:" + review.bodyDigest); return review; }, qualify: async (_, __, body, review) => { calls.push("QUALIFY:" + review.bodyDigest); callsToQualify++; if (failure === "batch" && callsToQualify === 2 || failure === "rollback") throw Error("rejected"); return { status: 200, body: { bodyDigest: review.bodyDigest, participants: body.subjects.length, financialEffects: false } }; } };
  return { params, calls, summary, get destroyed() { return destroyed; } };
}

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

test("commit acknowledgement loss is unknown and never automatically retried", async () => {
  const f = fixture("commit"); await assert.rejects(executeQualification(f.params), /connection lost/);
  assert.equal(f.summary.status, "COMMIT_UNKNOWN"); assert(!f.calls.includes("ROLLBACK"));
  assert.equal(f.summary.transaction.status,'COMMIT_UNKNOWN'); assert.equal(f.summary.transaction.committedBatches,undefined);
  assert.equal(f.calls.filter(s => s === "COMMIT").length, 1); assert.equal(f.destroyed, true);
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
