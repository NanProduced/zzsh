import assert from "node:assert/strict";

/** One transaction across the reviewed batches. An uncertain COMMIT is never retried. */
export async function executeQualification({ pool, lock, identity, plan, authority, actor, registry, target, sourceDigest, bind, qualify, verifyBuild, summary, save, now = Date.now }) {
  let client, locked = false, started = false, commitSent = false;
  const timings = summary.timings ??= {}, lockAt = performance.now();
  summary.transaction = { status: "NOT_STARTED", plannedBatches: plan.batches.length };
  try {
    await lock.connect();
    locked = (await lock.query("SELECT pg_try_advisory_lock(806006) AS ok")).rows[0]?.ok === true;
    timings.maintenanceLockMs = Math.round(performance.now() - lockAt); save();
    assert(locked, "DISTRIBUTION_MAINTENANCE_LOCK_BUSY");
    const beginAt = performance.now(); verifyBuild(); client = await pool.connect(); await client.query("BEGIN"); started = true;
    summary.transaction.status = "OPEN"; timings.transactionBeginMs = Math.round(performance.now() - beginAt); save();
    const identityAt = performance.now();
    const current = await identity(client, "migration", false); assert.equal(current.owner_oid, plan.target.ownerOid);
    timings.targetIdentityMs = Math.round(performance.now() - identityAt); save();
    const resource = { host: "127.0.0.1", port: 55432, database: registry.database, oid: Number(current.oid), owner: current.owner, ownerOid: current.owner_oid, marker: current.marker, role: current.role, roleOid: Number(current.role_oid) };
    summary.batches = [];
    for (const batch of plan.batches) {
      const batchAt = performance.now(), startedAt = new Date().toISOString();
      try {
        verifyBuild();
        const review = { ref: authority.approvalRef, attempt: authority.attempt, actor: { userId: actor.userId, sessionId: actor.sessionId }, resource, nonce: target.nonce, notBefore: authority.notBefore, expiresAt: authority.expiresAt, sourceDigest, bodyDigest: batch.bodyDigest, phase: "QUALIFY" };
        const admission = await bind(client, actor, review), result = await qualify(client, actor, batch.body, admission);
        assert(result.status === 200 && result.body.bodyDigest === batch.bodyDigest && result.body.participants === batch.body.subjects.length && result.body.financialEffects === false, "DISTRIBUTION_BATCH_RECEIPT_DIFFERS");
        summary.batches.push({ bodyDigest: batch.bodyDigest, participants: result.body.participants, status: "ACK_IN_OPEN_TRANSACTION", startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - batchAt) }); save();
      } catch (error) {
        summary.failedBatch = { bodyDigest: batch.bodyDigest, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - batchAt) }; save(); throw error;
      }
    }
    const verifyAt = performance.now(); verifyBuild(); await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    timings.constraintsMs = Math.round(performance.now() - verifyAt); save();
    assert(now() < Date.parse(authority.expiresAt), "DISTRIBUTION_AUTHORITY_EXPIRED_BEFORE_COMMIT");
    const commitAt = performance.now(); summary.transaction.status = "COMMIT_REQUESTED"; save();
    commitSent = true; try { await client.query("COMMIT"); } finally { timings.commitMs = Math.round(performance.now() - commitAt); }
    started = false; summary.transaction.status = "COMMIT_ACKNOWLEDGED"; summary.transaction.committedBatches = summary.batches.length; summary.status = "COMMITTED_ACK_READBACK_REQUIRED";
  } catch (error) {
    if (timings.maintenanceLockMs === undefined) timings.maintenanceLockMs = Math.round(performance.now() - lockAt);
    summary.status = commitSent ? "COMMIT_UNKNOWN" : "STOPPED"; summary.error = { code: error.code ?? error.name };
    if (commitSent) summary.transaction.status = "COMMIT_UNKNOWN";
    if (started && !commitSent) { const rollbackAt=performance.now(); try { await client.query("ROLLBACK"); summary.rollbackAck = true; summary.transaction.status = "ROLLBACK_ACKNOWLEDGED"; } catch { summary.rollbackAck = false; summary.transaction.status = "ROLLBACK_UNKNOWN"; } finally { timings.rollbackMs=Math.round(performance.now()-rollbackAt); } }
    throw error;
  } finally {
    try { client?.release(summary.status === "COMMIT_UNKNOWN" || summary.rollbackAck === false); summary.clientReleased = true; } catch { summary.clientReleased = false; }
    if (locked) try { summary.lockReleased = (await lock.query("SELECT pg_advisory_unlock(806006) AS ok")).rows[0]?.ok === true; } catch { summary.lockReleased = false; }
    try { await pool.end(); summary.poolClosed = true; } catch { summary.poolClosed = false; }
    try { await lock.end(); summary.lockClientClosed = true; } catch { summary.lockClientClosed = false; }
    summary.clientsClosed = summary.clientReleased && summary.poolClosed && summary.lockClientClosed; save();
  }
  assert(summary.lockReleased && summary.clientsClosed, "DISTRIBUTION_LOCK_RELEASE_UNCONFIRMED");
}
