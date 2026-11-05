import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LocalSession, localOrigin, totp, validateProfile } from "../local-auth.mjs";
import { runNativeDistributionApproval } from "./local-distribution-policy-approval.mjs";
import { assertHistoricalFinanceUnchanged } from "./local-distribution-qualification-plan.mjs";

/** Check the execution window and sealed build immediately before approval transactions commit. */
export function guardedApprovalPool(pool, check) {
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect(), query = client.query, release = client.release;
      client.query = function (...args) {
        if (typeof args[0] === "string" && args[0].trim().toUpperCase() === "COMMIT") check();
        return query.apply(this, args);
      };
      client.release = function (...args) { client.query = query; client.release = release; return release.apply(this, args); };
      return client;
    },
  };
}

/** Existing auth runtime is mounted only to an inert sink; no route or lifecycle can serve traffic. */
async function approveLocked({ input, plan, registry, credentials, target, base, Pool, sha, pinned, protectedInput, moduleFromBuild, identity, readTarget, canonicalize, verifyBuild, summary, save }) {
  const d = input.distribution, approval = d.approval;
  assert(d.scope === "NATIVE" && approval && Date.parse(input.window?.notBefore) <= Date.now() && Date.now() < Date.parse(input.window?.expiresAt), "LOCAL_NATIVE_APPROVAL_WINDOW_REQUIRED");
  const matchesBefore = actual => actual.headCompatible && !actual.policyActive && canonicalize(actual.plan.accepted) === canonicalize(plan.accepted) && canonicalize(actual.plan.existing) === canonicalize(plan.existing) && canonicalize(actual.plan.ineligible) === canonicalize(plan.ineligible) && actual.plan.exceptions.length === 0;
  const before = await readTarget();
  assert(matchesBefore(before) && before.resource.owner_oid === plan.target.ownerOid, "DISTRIBUTION_APPROVAL_TARGET_CHANGED");
  assertHistoricalFinanceUnchanged(plan.historicalFinance,before.history,canonicalize);
  const profile = validateProfile(pinned(protectedInput(approval.profile?.path), approval.profile?.sha256));
  const apiOrigin = localOrigin(approval.apiOrigin), adminOrigin = localOrigin(approval.adminOrigin), userOrigin = localOrigin(approval.userOrigin);
  assert(new Set([apiOrigin, adminOrigin, userOrigin]).size === 3, "DISTRIBUTION_LOCAL_ORIGINS_REQUIRED");
  function secret(entry, name) {
    const path = protectedInput(entry?.path), expected = resolve("E:/zzsh/zzsh/apps/api/.secrets", name);
    assert.equal(path.toLowerCase(), expected.toLowerCase(), "DISTRIBUTION_EXISTING_AUTH_SECRET_REQUIRED");
    const bytes = readFileSync(path); assert.equal(sha(bytes), entry.sha256, "DISTRIBUTION_AUTH_SECRET_CHANGED");
    const value = bytes.toString("utf8").trim(); assert(value.length >= 32, "DISTRIBUTION_AUTH_SECRET_INVALID"); return value;
  }
  const adminSecret = secret(approval.adminSecret, "auth_admin_secret"), userSecret = secret(approval.userSecret, "auth_user_secret");
  assert.notEqual(adminSecret, userSecret, "DISTRIBUTION_AUTH_REALMS_MUST_DIFFER");
  const names = [approval.firstActor, approval.secondActor];
  assert(names.every(name => typeof name === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(name)) && names[0] !== names[1], "DISTRIBUTION_ADMIN_ALIASES_REQUIRED");
  const actors = names.map(name => {
    const actor = profile.actors[name], binding = approval.sessions?.[name], state = pinned(protectedInput(binding?.path), binding?.sha256);
    assert(actor?.realm === "admin" && actor.origin === apiOrigin && actor.userId && actor.username && actor.password && actor.totp && Array.isArray(state.cookies), "DISTRIBUTION_REGISTERED_ADMIN_REQUIRED");
    const session = new LocalSession(apiOrigin, "admin", state.cookies), cookie = session.cookies.filter(c => c.path === "/" && !c.secure).map(c => `${c.name}=${c.value}`).join("; ");
    assert(cookie, "DISTRIBUTION_REGISTERED_SESSION_REQUIRED"); return { ...actor, cookie };
  });
  const actorProof = pinned(protectedInput(input.actor.path), input.actor.sha256);
  assert(actorProof?.realm === 'admin' && actorProof.resourceOid === target.oid && actorProof.nonce === target.nonce && (actorProof.id ?? actorProof.actorId) === actors[0].userId && actorProof.sessionId, 'DISTRIBUTION_APPROVAL_ACTOR_CHANGED');
  actors[0].sessionId = actorProof.sessionId;
  const { createControlledRegressionResource } = moduleFromBuild("finance/controlled-regression-resource");
  const { createReviewedLocalNativeDistributionScope } = moduleFromBuild("finance/distribution-policy-store");
  const { createDistributionPolicyApprovalExecutor } = moduleFromBuild("finance/distribution-policy-approval");
  const { mountAuthHandlers } = moduleFromBuild("auth/auth-runtime"), { handleAdminSecurity } = moduleFromBuild("auth/auth-security");
  assert(typeof createReviewedLocalNativeDistributionScope === "function", "LOCAL_NATIVE_SCOPE_BUILD_REQUIRED");
  const scopeConfig = { profile: "test", provider: "fake", testOperationsEnabled: true, database: { target: "local-compose", targetProfile: "test", host: "127.0.0.1", port: 55432, name: registry.database, user: credentials.runtime.name, runtimeUser: credentials.runtime.name } };
  const proof = createControlledRegressionResource(scopeConfig, { resourceOid: Number(target.oid), nonce: target.nonce, runtimeRoleOid: Number(credentials.runtime.oid) }, "DISTRIBUTION");
  const scope = createReviewedLocalNativeDistributionScope(proof, { owner: "zzsh", ownerOid: plan.target.ownerOid });
  const pool = new Pool({ ...base, user: credentials.runtime.name, password: credentials.runtime.password, max: 2 });
  const routeSink = new Proxy({}, { get: () => () => routeSink });
  const app = { getHttpAdapter: () => ({ getInstance: () => routeSink }), get: () => { throw Error("OFFLINE_LIFECYCLE_FORBIDDEN"); } };
  const verifyResource = async () => {
    assert(Date.parse(input.window.notBefore) <= Date.now() && Date.now() < Date.parse(input.window.expiresAt), "LOCAL_NATIVE_APPROVAL_WINDOW_EXPIRED");
    const c = await pool.connect(); let begun = false;
    try { await c.query("BEGIN READ ONLY"); begun = true; const current = await identity(c, "runtime", true); assert.equal(current.owner_oid, plan.target.ownerOid, "DISTRIBUTION_OWNER_CHANGED"); assert.equal((await c.query("ROLLBACK")).command, "ROLLBACK"); begun = false; }
    finally { try { if (begun) await c.query("ROLLBACK"); } finally { c.release(); } }
  };
  try {
    const timed=async(name,work)=>{const at=performance.now();try{return await work()}finally{(summary.timings??={})[name]=Math.round(performance.now()-at);save();}};
    await timed('approvalResourcePreflightMs',async()=>{await verifyResource();verifyBuild();});
    const security = await timed('authAssemblyMs',()=>mountAuthHandlers(app, { pool, apiOrigin, adminOrigin, userOrigin, userSecret, adminSecret, secureCookies: false, testOperationsEnabled: false, localSmsMock: false }));
    security.pool = guardedApprovalPool(pool, () => { verifyBuild(); assert(Date.now() < Date.parse(input.window.expiresAt), "LOCAL_NATIVE_APPROVAL_WINDOW_EXPIRED"); });
    security.distributionPolicyWriteScope = scope;
    security.approvalOperationExecutor = (client, body, actor, requestId) => {
      assert.equal(body.operationCode, "distribution.policy.publish", "OFFLINE_APPROVAL_OPERATION_FORBIDDEN");
      return createDistributionPolicyApprovalExecutor(scope)(client, body, actor, requestId);
    };
    summary.steps = [];
    await timed('approvalFlowMs',()=>runNativeDistributionApproval({ handleAdminSecurity, security, plan, actors, origin: adminOrigin, totp, verifyBuild, verifyResource, summary, save }));
  } finally { try{await pool.end();summary.clientsClosed=true}catch(error){summary.clientsClosed=false;throw error}finally{save();} }
  const after = await readTarget(); verifyBuild();
  assert(after.policyActive && after.headCompatible && canonicalize(after.plan.accepted) === canonicalize(plan.accepted) && canonicalize(after.plan.existing) === canonicalize(plan.existing) && canonicalize(after.plan.ineligible) === canonicalize(plan.ineligible) && after.plan.exceptions.length === 0, "DISTRIBUTION_POLICY_READBACK_CHANGED");
  assertHistoricalFinanceUnchanged(plan.historicalFinance,after.history,canonicalize);
  summary.historicalFinanceReadback=after.history;
  summary.status = "NATIVE_POLICY_APPROVED_READBACK_PASSED"; summary.policyActive = true;
}

/** The existing regression maintenance lock protects policy initialization and its readback. */
export async function approveLocalNativePolicy(params) {
  const { Client, credentials, base, summary, save } = params;
  const lock = new Client({ ...base, database: "postgres", user: credentials.migration.name, password: credentials.migration.password });
  let locked = false;const lockAt=performance.now();
  try {
    await lock.connect(); locked = (await lock.query("SELECT pg_try_advisory_lock(806006) AS ok")).rows[0]?.ok === true;
    (summary.timings??={}).maintenanceLockMs=Math.round(performance.now()-lockAt);save();
    assert(locked, "DISTRIBUTION_MAINTENANCE_LOCK_BUSY");
    await approveLocked(params);
  } finally {
    if(summary.timings?.maintenanceLockMs===undefined)(summary.timings??={}).maintenanceLockMs=Math.round(performance.now()-lockAt);
    if (locked) try { summary.lockReleased = (await lock.query("SELECT pg_advisory_unlock(806006) AS ok")).rows[0]?.ok === true; } catch { summary.lockReleased = false; }
    try{await lock.end();summary.lockClientClosed=true}catch{summary.lockClientClosed=false}
    if (locked && (!summary.lockReleased || !summary.lockClientClosed) && summary.policyId) summary.status = "POLICY_COMMIT_ACK_READBACK_REQUIRED";
    save();
  }
  assert(summary.lockReleased && summary.lockClientClosed, "DISTRIBUTION_LOCK_RELEASE_UNCONFIRMED");
}
