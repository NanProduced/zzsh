import { test } from "node:test";
import assert from "node:assert/strict";
import { runNativeDistributionApproval } from "./local-distribution-policy-approval.mjs";

function fixture(variation = "") {
  const calls = [], summary = { steps: [] }, first = { userId: "boss1", username: "boss-one", password: "private-one", totp: "otp-one", cookie: "cookie-one" }, second = { userId: "boss2", username: "boss-two", password: "private-two", totp: "otp-two", cookie: "cookie-two" };
  let template = variation === 'empty-template' || variation === 'version-conflict' || variation === 'existing', configured = false;
  const handler = async (req, res) => {
    calls.push({ url: req.originalUrl, key: req.headers["idempotency-key"], cookie: req.headers.cookie, body: req.body });
    const path = req.originalUrl.split("?")[0];
    let body;
    if (path.endsWith("/templates")) body = { templates: template || variation === "wrong-template" || variation === 'not-eligible' ? [{ operationCode: "distribution.policy.publish", triggerCondition: "distribution.policy.publish.requested", version: 1, candidates: !configured && (variation === 'empty-template' || variation === 'version-conflict') ? [] : [{ username: variation === "wrong-template" ? "another" : "boss-two", isBoss: true, eligible: variation !== 'not-eligible' }] }] : [] };
    else if (path.endsWith("/templates/update")) { if (variation === 'version-conflict') { res.status(409).json({}); return; } template = true; configured = true; body = {}; }
    else if (path.endsWith("/requests/decision")) { assert.equal(req.body.password, "private-two"); assert.equal(req.body.totpCode, "code-otp-two"); body = { requestId: "r1", status: "APPROVED" }; }
    else if (path.endsWith("/requests/execute")) { assert.equal(req.body.password, "private-one"); assert.equal(req.body.totpCode, "code-otp-one"); if (variation === "unknown") throw Error("lost commit acknowledgement"); if (variation === 'http-503') { res.status(503).json({}); return; } if (variation === 'no-response') return; body = variation === 'bad-success' ? {} : { requestId: "r1", status: "EXECUTED", executionStatus: "SUCCEEDED", resultCode: "DISTRIBUTION_POLICY_INITIALIZED", businessResultRef: "policy_1" }; }
    else if (path.endsWith("/requests/detail")) body = { requestId: "r1", status: "EXECUTED", operation: { code: "distribution.policy.publish" }, decision: { decision: "APPROVED", approver: { id: "boss2" } }, execution: { status: "SUCCEEDED", resultCode: "DISTRIBUTION_POLICY_INITIALIZED", resultDetail: "policy_1", executor: { id: "boss1" } } };
    else if (path.endsWith("/requests")) body = { requestId: "r1", approvalRequestId: "r1", status: "PENDING" };
    else throw Error("unexpected path");
    res.status(200).json(body);
  };
  const security = { adminAuth: { api: { getSession: async ({ headers }) => ({ user: { id: headers.get("cookie") === "cookie-one" ? "boss1" : "boss2", twoFactorEnabled: true }, session: { id: "session", locked: false } }) } } };
  const plan = { scope: "NATIVE", approvalKey: "legacy_policy_" + "a".repeat(40), policyId: "policy_1", approvalBody: { operationCode: "distribution.policy.publish", triggerCondition: "distribution.policy.publish.requested", payload: { config: { scope: "NATIVE" } } } };
  return { calls, summary, params: { handleAdminSecurity: handler, security, plan, actors: [first, second], origin: "http://127.0.0.1:4231", totp: x => "code-" + x, verifyBuild: () => {}, verifyResource: async () => {}, summary, save: () => {} } };
}

test("native policy uses two sessions, full security handler, step-up and verified execution", async () => {
  const f = fixture(); await runNativeDistributionApproval(f.params);
  assert.equal(f.summary.status, "POLICY_COMMIT_ACK_READBACK_REQUIRED");
  assert(Number.isFinite(f.summary.timings.sessionValidationMs));
  assert(f.summary.steps.every(step => Number.isFinite(step.elapsedMs) && step.startedAt && step.finishedAt));
  assert.deepEqual(f.calls.map(c => c.url.split("?")[0].split("/").slice(-1)[0]), ["templates", "update", "templates", "requests", "decision", "execute", "detail"]);
  assert.equal(f.calls.find(c => c.url.endsWith("decision")).cookie, "cookie-two");
  assert.equal(f.calls.find(c => c.url.endsWith("execute")).cookie, "cookie-one");
  assert.equal(f.calls.find(c => c.url.endsWith('/templates/update')).body.expectedVersion, 0);
  assert(!/private-one|private-two|otp-one|otp-two|cookie-one|cookie-two/.test(JSON.stringify(f.summary)));
  assert(f.calls.filter(c => c.key).every(c => c.key.startsWith(f.params.plan.approvalKey)));
});

test("an existing template without the second Boss is not silently overwritten", async () => {
  const f = fixture("wrong-template"); await assert.rejects(runNativeDistributionApproval(f.params), /EXISTING_TEMPLATE_SECOND_BOSS_NOT_ELIGIBLE/);
  assert.equal(f.calls.length, 1); assert(!f.calls.some(c => c.url.endsWith("/templates/update")));
});

test('recovery reuses the acknowledged template and the original request key',async()=>{
 const f=fixture('existing');await runNativeDistributionApproval({...f.params,recoveringRejectedRequest:true});
 assert(!f.calls.some(c=>c.url.endsWith('/templates/update')));
 assert.equal(f.calls.find(c=>c.url.endsWith('/requests')).key,f.params.plan.approvalKey+':request');
 const missing=fixture();await assert.rejects(runNativeDistributionApproval({...missing.params,recoveringRejectedRequest:true}),/RECOVERY_ACKNOWLEDGED_TEMPLATE_MISSING/);
 assert(!missing.calls.some(c=>c.url.endsWith('/templates/update')||c.url.endsWith('/requests')));
});

test("existing empty template is extended with the second Boss using its exact version", async () => {
  const f=fixture('empty-template');await runNativeDistributionApproval(f.params);
  const configured=f.calls.find(c=>c.url.endsWith('/templates/update'));
  assert.equal(configured.body.expectedVersion,1);assert.deepEqual(configured.body.candidateUsernames,['boss-two']);
  assert.equal(f.summary.status,'POLICY_COMMIT_ACK_READBACK_REQUIRED');
});

test("a stale template version or ineligible second Boss stops before requesting a policy", async () => {
  for(const reason of ['version-conflict','not-eligible']){
    const f=fixture(reason);await assert.rejects(runNativeDistributionApproval(f.params));
    assert(!f.calls.some(c=>c.url.endsWith('/requests')));assert.equal(f.summary.pending,undefined);
  }
});

test("requester cannot be the second approver", async () => {
  const f=fixture();f.params.actors[1].userId=f.params.actors[0].userId;
  await assert.rejects(runNativeDistributionApproval(f.params),/TWO_DISTINCT_ADMIN_SESSIONS_REQUIRED/);assert.equal(f.calls.length,0);
});

test("unknown execution outcome retains the original key without automatic retry", async () => {
  const f = fixture("unknown"); await assert.rejects(runNativeDistributionApproval(f.params), /acknowledgement/);
  assert.equal(f.summary.pending.step, "execute"); assert(f.summary.pending.idempotencyKey.endsWith(":execute"));
  assert.equal(f.summary.pending.sent, true); assert.equal(f.summary.steps.at(-1).status, 'OUTCOME_UNKNOWN');
  assert(Number.isFinite(f.summary.steps.at(-1).elapsedMs));
  assert.equal(f.calls.filter(c => c.url.endsWith("/requests/execute")).length, 1);
  assert(!/private-one|private-two|otp-one|otp-two|cookie-one|cookie-two/.test(JSON.stringify(f.summary)));
});

test('server errors or malformed success preserve the original approval request for readback', async () => {
  for (const variation of ['http-503', 'no-response', 'bad-success']) {
    const f = fixture(variation); await assert.rejects(runNativeDistributionApproval(f.params), /DISTRIBUTION_APPROVAL_OUTCOME_UNKNOWN:execute/);
    assert.equal(f.summary.pending.step, 'execute'); assert.equal(f.summary.pending.sent, true);
    assert.equal(f.summary.pending.idempotencyKey, f.params.plan.approvalKey + ':execute');
    assert.equal(f.summary.steps.at(-1).status, 'OUTCOME_UNKNOWN');
    assert.equal(f.calls.filter(c => c.url.endsWith('/requests/execute')).length, 1);
  }
});

test("invalid admin session or target identity stops before every policy write", async () => {
  const f = fixture(); f.params.security.adminAuth.api.getSession = async () => ({ user: { id: "unexpected", twoFactorEnabled: true }, session: { id: "s" } });
  await assert.rejects(runNativeDistributionApproval(f.params), /APPROVAL_ADMIN_SESSION_INVALID/); assert.equal(f.calls.length, 0);
  const r = fixture(); r.params.verifyResource = async () => { throw Error("target changed"); };
  await assert.rejects(runNativeDistributionApproval(r.params), /target changed/); assert.equal(r.calls.length, 0);
  const s = fixture(); s.params.actors[0].sessionId = 'different-session';
  await assert.rejects(runNativeDistributionApproval(s.params), /APPROVAL_ADMIN_SESSION_INVALID/); assert.equal(s.calls.length, 0);
});
