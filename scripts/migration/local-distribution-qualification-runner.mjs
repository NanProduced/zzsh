import assert from "node:assert/strict";
import { acquireMigrationTransactionFence, assertMaintenanceLockHeld, captureMaintenanceLockEpoch, isRegisteredMigrationInstance, NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';

/** Keep the original R06 default, while R07 must bind the exact registered cluster and port. */
export function qualificationReviewResource(current,registry,target,{readOnly=false}={}){
  assert(typeof readOnly==='boolean','DISTRIBUTION_QUALIFICATION_INSTANCE_CHANGED');
  const instance=target.instance;
  if(instance){
    const next=target.migrationProfile===NEXT_MIGRATION_PROFILE;
    assert(instance.host==='127.0.0.1'&&(next?isRegisteredMigrationInstance({host:instance.host,port:instance.port,instance,migrationProfile:registry.migrationProfile}):[55432,55433].includes(instance.port))
      &&(target.migrationProfile??null)===(registry.migrationProfile??null)&&/^[0-9]+$/.test(instance.systemIdentifier??'')
      &&(!next||/^[a-f0-9]{24}$/.test(target.nonce??'')&&target.nonce===registry.nonce&&current.nonce===target.nonce)
      &&JSON.stringify(instance)===JSON.stringify(registry.instance??null)&&current.oid===target.oid
      &&current.system_identifier===instance.systemIdentifier&&current.database===registry.database&&current.owner===registry.owner
      &&current.marker===registry.marker&&current.role===registry.roles?.migration?.name&&String(current.role_oid)===String(registry.roles?.migration?.oid)
      &&String(current.role_oid)===String(target.migrationRoleOid)&&current.read_only===(readOnly?'on':'off'),'DISTRIBUTION_QUALIFICATION_INSTANCE_CHANGED');
  }else assert(!registry.instance,'DISTRIBUTION_QUALIFICATION_INSTANCE_CHANGED');
  return {host:instance?.host??'127.0.0.1',port:instance?.port??55432,database:registry.database,oid:Number(current.oid),owner:current.owner,ownerOid:current.owner_oid,marker:current.marker,role:current.role,roleOid:Number(current.role_oid),
    ...(target.migrationProfile===NEXT_MIGRATION_PROFILE?{migrationProfile:target.migrationProfile,systemIdentifier:instance.systemIdentifier,nonce:target.nonce}:{})};
}

/** Recheck every original subject and idempotency key under the write transaction and lock. */
export async function assertQualificationRecoveryPreimage(client,plan,actor){
  assert(Array.isArray(plan.accepted)&&Array.isArray(plan.ineligible)&&Array.isArray(plan.unresolved)&&Array.isArray(plan.existing)&&plan.existing.length===0,'DISTRIBUTION_RECOVERY_PREIMAGE_CHANGED');
  const mismatches={accepted:0,ineligible:0,unresolved:0};
  for(const [name,items,eligibility] of [['accepted',plan.accepted,'UNKNOWN'],['ineligible',plan.ineligible,'INELIGIBLE'],['unresolved',plan.unresolved,'UNKNOWN']]){
    for(let i=0;i<items.length;i+=1000){const result=await client.query(`SELECT count(*)::int AS n FROM jsonb_to_recordset($1::jsonb) x("userId" text,"sourceDigest" text,revision text,frozen boolean)
      LEFT JOIN zzsh_order.distribution_participant p ON p.user_id=x."userId" WHERE p.user_id IS NULL OR p.source_type<>'LEGACY_MYSQL' OR p.source_digest IS DISTINCT FROM x."sourceDigest"
      OR p.revision::text IS DISTINCT FROM x.revision OR p.eligibility IS DISTINCT FROM $2 OR p.policy_version_id IS NOT NULL OR p.level_code IS NOT NULL OR p.commission_frozen IS DISTINCT FROM x.frozen`,[JSON.stringify(items.slice(i,i+1000)),eligibility]);
      assert(Number.isSafeInteger(result.rows[0]?.n),'DISTRIBUTION_RECOVERY_PREIMAGE_CHANGED');mismatches[name]+=result.rows[0].n;
    }
  }
  const scope=JSON.stringify(['admin',actor.userId,'distribution.legacy-qualification.v1',null]),keys=plan.batches.map(row=>'legacy-qualification-'+row.bodyDigest);
  const totals=(await client.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_participant WHERE source_type='LEGACY_MYSQL') participants,
    (SELECT count(*)::int FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[])) receipts,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action='distribution.legacy_qualification.admitted' AND object_id=$3 AND outcome='SUCCESS') audits,
    (SELECT count(*)::int FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE' AND current_version_id=$3) policy_heads`,[scope,keys,plan.policyId])).rows[0];
  assert(Object.values(mismatches).every(value=>value===0)&&totals?.participants===plan.accepted.length+plan.ineligible.length+plan.unresolved.length
    &&totals.receipts===0&&totals.audits===0&&totals.policy_heads===1,'DISTRIBUTION_RECOVERY_PREIMAGE_CHANGED');
  return {status:'ORIGINAL_QUALIFICATION_PREIMAGE_RECHECKED',mismatches,counts:totals};
}

/** One transaction across the reviewed batches. An uncertain COMMIT is never retried. */
export async function executeQualification({ pool, lock, identity, plan, authority, actor, registry, registeredTarget, target, sourceDigest, bind, qualify, prepareIndex, verifyBuild, summary, save, verifyRecovery, now = Date.now }) {
  let client, locked = false, started = false, commitSent = false;
  let lockError, poolError;
  lock.on?.('error', error => { lockError ??= error; }); pool.on?.('error', error => { poolError ??= error; });
  const checkLock = async () => {
    assert(!lockError && !poolError, 'DISTRIBUTION_MAINTENANCE_CONNECTION_LOST');
    await assertMaintenanceLockHeld(lock, { lockKey: '806006', maintenanceDatabase: 'postgres', instance: target.instance ?? null });
    assert(!lockError && !poolError, 'DISTRIBUTION_MAINTENANCE_CONNECTION_LOST');
  };
  const timings = summary.timings ??= {}, lockAt = performance.now();
  summary.transaction = { status: "NOT_STARTED", plannedBatches: plan.batches.length };
  try {
    await lock.connect();
    locked = (await lock.query("SELECT pg_try_advisory_lock(806006) AS ok")).rows[0]?.ok === true;
    timings.maintenanceLockMs = Math.round(performance.now() - lockAt); save();
    assert(locked, "DISTRIBUTION_MAINTENANCE_LOCK_BUSY");
    await checkLock();
    let fenceEpoch;
    if (target.migrationProfile === NEXT_MIGRATION_PROFILE) {
      assert(isRegisteredMigrationInstance(registeredTarget) && registeredTarget.migrationProfile === target.migrationProfile
        && registeredTarget.oid === target.oid && registeredTarget.nonce === target.nonce
        && JSON.stringify(registeredTarget.instance) === JSON.stringify(target.instance), 'DISTRIBUTION_FENCE_TARGET_CHANGED');
      fenceEpoch = await captureMaintenanceLockEpoch(lock, registeredTarget);
    }
    const beginAt = performance.now(); verifyBuild(); client = await pool.connect(); client.on?.('error', error => { poolError ??= error; }); await client.query("BEGIN"); started = true;
    summary.transaction.status = "OPEN"; timings.transactionBeginMs = Math.round(performance.now() - beginAt); save();
    const identityAt = performance.now();
    const current = await identity(client, "migration", false); assert.equal(current.owner_oid, plan.target.ownerOid);
    timings.targetIdentityMs = Math.round(performance.now() - identityAt); save();
    const resource = qualificationReviewResource(current,registry,target);
    if (fenceEpoch) {
      await acquireMigrationTransactionFence(client, registeredTarget, fenceEpoch);
      summary.transaction.fence = 'HELD_UNTIL_TRANSACTION_END'; save();
    }
    if(verifyRecovery){summary.recoveryPreflight=await verifyRecovery(client);save();}
    const reviewFor=batch=>({ ref: authority.approvalRef, attempt: authority.attempt, actor: { userId: actor.userId, sessionId: actor.sessionId }, resource, nonce: target.nonce, notBefore: authority.notBefore, expiresAt: authority.expiresAt, sourceDigest, bodyDigest: batch.bodyDigest, phase: "QUALIFY" });
    let qualificationIndex;
    if(prepareIndex){
      assert(plan.batches.length>0,'DISTRIBUTION_QUALIFICATION_BATCH_REQUIRED');
      const at=performance.now(),seed=await bind(client,actor,reviewFor(plan.batches[0]));
      qualificationIndex=await prepareIndex(client,actor,seed);timings.qualificationIndexMs=Math.round(performance.now()-at);save();
    }
    summary.batches = [];
    for (const batch of plan.batches) {
      const batchAt = performance.now(), startedAt = new Date().toISOString();
      try {
        verifyBuild();
        const review = reviewFor(batch);
        const admission = await bind(client, actor, review, "execute", qualificationIndex), result = await qualify(client, actor, batch.body, admission);
        assert(result.status === 200 && result.body.bodyDigest === batch.bodyDigest && result.body.participants === batch.body.subjects.length && result.body.financialEffects === false, "DISTRIBUTION_BATCH_RECEIPT_DIFFERS");
        summary.batches.push({ bodyDigest: batch.bodyDigest, participants: result.body.participants, status: "ACK_IN_OPEN_TRANSACTION", startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - batchAt) }); save();
      } catch (error) {
        summary.failedBatch = { bodyDigest: batch.bodyDigest, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - batchAt) }; save(); throw error;
      }
    }
    const verifyAt = performance.now(); verifyBuild();
    const remaining=Math.floor(Date.parse(authority.expiresAt)-now());assert(remaining>2000,'DISTRIBUTION_AUTHORITY_EXPIRED_BEFORE_CONSTRAINTS');
    const constraintBudgetMs=Math.min(120000,remaining-1000);await client.query("SELECT set_config('statement_timeout',$1,true)",[constraintBudgetMs+'ms']);
    timings.constraintBudgetMs=constraintBudgetMs;save();await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    timings.constraintsMs = Math.round(performance.now() - verifyAt); save();
    assert(now() < Date.parse(authority.expiresAt), "DISTRIBUTION_AUTHORITY_EXPIRED_BEFORE_COMMIT");
    await checkLock(); verifyBuild();
    const commitAt = performance.now(); summary.transaction.status = "COMMIT_REQUESTED"; save();
    commitSent = true; try { assert.equal((await client.query("COMMIT"))?.command, "COMMIT", "DISTRIBUTION_COMMIT_ACK_UNCONFIRMED"); } finally { timings.commitMs = Math.round(performance.now() - commitAt); }
    started = false; summary.transaction.status = "COMMIT_ACKNOWLEDGED"; summary.transaction.committedBatches = summary.batches.length; summary.status = "COMMITTED_ACK_READBACK_REQUIRED";
  } catch (error) {
    if (timings.maintenanceLockMs === undefined) timings.maintenanceLockMs = Math.round(performance.now() - lockAt);
    summary.status = commitSent ? "COMMIT_UNKNOWN" : "STOPPED"; summary.error = { code: error.code ?? error.name };
    if (commitSent) summary.transaction.status = "COMMIT_UNKNOWN";
    if (started && !commitSent) { const rollbackAt=performance.now(); try { summary.rollbackAck = (await client.query("ROLLBACK"))?.command === "ROLLBACK"; summary.transaction.status = summary.rollbackAck ? "ROLLBACK_ACKNOWLEDGED" : "ROLLBACK_UNKNOWN"; } catch { summary.rollbackAck = false; summary.transaction.status = "ROLLBACK_UNKNOWN"; } finally { timings.rollbackMs=Math.round(performance.now()-rollbackAt); } }
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
