import assert from "node:assert/strict";

/** Directly calls the full security handler; no HTTP listener or alternate approval path is created. */
export async function runNativeDistributionApproval({ handleAdminSecurity, security, plan, actors, origin, totp, verifyBuild, verifyResource, summary, save, recoveringRejectedRequest=false }) {
  const [first, second] = actors;
  assert(first && second && first.userId !== second.userId && first.username.toLowerCase() !== second.username.toLowerCase() && first.cookie && second.cookie, "TWO_DISTINCT_ADMIN_SESSIONS_REQUIRED");
  assert(plan.scope === "NATIVE" && plan.approvalBody?.operationCode === "distribution.policy.publish" && plan.approvalBody?.payload?.config?.scope === "NATIVE", "NATIVE_POLICY_PLAN_REQUIRED");
  async function verifySession(actor) {
    const current = await security.adminAuth.api.getSession({ headers: new Headers({ cookie: actor.cookie }) });
    assert(current?.user?.id === actor.userId && current.user.twoFactorEnabled === true && current.user.suspended !== true && current.session?.id && (!actor.sessionId || current.session.id === actor.sessionId) && current.session.locked !== true, "APPROVAL_ADMIN_SESSION_INVALID");
  }
  const sessionsAt = performance.now();
  try { await verifySession(first); await verifySession(second); }
  finally { (summary.timings ??= {}).sessionValidationMs = Math.round(performance.now() - sessionsAt); save(); }
  async function call(actor, step, path, body, key) {
    const startedAt = new Date().toISOString(), started = performance.now(); let sent = false, recorded = false;
    const record = status => { summary.steps.push({ step, ...(key ? { idempotencyKey: key } : {}), status, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started) }); recorded = true; };
    try {
      verifyBuild(); await verifyResource(); await verifySession(actor);
      summary.pending = { step, ...(key ? { idempotencyKey: key } : {}), startedAt, sent: false }; save();
      const result = { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, json(value) { this.body = value; } };
      const request = { method: body === undefined ? "GET" : "POST", originalUrl: "/api/v1/admin/security/approvals" + path,
        headers: { origin, cookie: actor.cookie, ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body }) };
      summary.pending.sent = true; sent = true; save();
      await handleAdminSecurity(request, result, security);
      record(result.statusCode); delete summary.pending; save();
      assert.equal(result.statusCode, 200, "DISTRIBUTION_APPROVAL_REJECTED:" + step);
      return result.body;
    } catch (error) {
      if (!recorded) { record(sent ? "OUTCOME_UNKNOWN" : "NOT_SENT"); save(); }
      throw error;
    }
  }
  const key = plan.approvalKey, operationCode = plan.approvalBody.operationCode, triggerCondition = plan.approvalBody.triggerCondition;
  assert(typeof key === "string" && /^legacy_policy_[a-f0-9]{40}$/.test(key), "DISTRIBUTION_APPROVAL_KEY_INVALID");
  const getTemplate = async () => {
    const result = await call(first, "templates", "/templates");
    assert(Array.isArray(result?.templates), "DISTRIBUTION_APPROVAL_TEMPLATE_UNAVAILABLE");
    const matches = result.templates.filter(t => t.operationCode === operationCode && t.triggerCondition === triggerCondition);
    assert(matches.length <= 1, "DISTRIBUTION_APPROVAL_TEMPLATE_AMBIGUOUS"); return matches[0];
  };
  let template = await getTemplate();
  if (!template || Array.isArray(template.candidates) && template.candidates.length === 0) {
    assert(!recoveringRejectedRequest, "RECOVERY_ACKNOWLEDGED_TEMPLATE_MISSING");
    const expectedVersion = template ? template.version : 0;
    assert(Number.isSafeInteger(expectedVersion) && expectedVersion >= 0, "DISTRIBUTION_APPROVAL_TEMPLATE_VERSION_UNKNOWN");
    await call(first, "configure-template", "/templates/update", { operationCode, triggerCondition, candidateUsernames: [second.username], expectedVersion }, key + ":template");
    template = await getTemplate();
  }
  assert(template?.candidates?.some(c => c.username?.toLowerCase() === second.username.toLowerCase() && c.isBoss === true && c.eligible === true), "EXISTING_TEMPLATE_SECOND_BOSS_NOT_ELIGIBLE");
  const created = await call(first, "request", "/requests", structuredClone(plan.approvalBody), key + ":request");
  assert(created?.requestId && created.requestId === created.approvalRequestId && created.status === "PENDING", "DISTRIBUTION_APPROVAL_REQUEST_MISMATCH");
  summary.approvalRequestId = created.requestId; save();
  const decided = await call(second, "decision", "/requests/decision", { requestId: created.requestId, decision: "APPROVE", password: second.password, totpCode: totp(second.totp) }, key + ":decision");
  assert(decided?.requestId === created.requestId && decided.status === "APPROVED", "DISTRIBUTION_APPROVAL_DECISION_MISMATCH");
  const executed = await call(first, "execute", "/requests/execute", { requestId: created.requestId, password: first.password, totpCode: totp(first.totp) }, key + ":execute");
  assert(executed?.requestId === created.requestId && executed.status === "EXECUTED" && executed.executionStatus === "SUCCEEDED" && executed.resultCode === "DISTRIBUTION_POLICY_INITIALIZED" && executed.businessResultRef === plan.policyId, "DISTRIBUTION_APPROVAL_EXECUTION_MISMATCH");
  summary.status = "POLICY_COMMIT_ACK_READBACK_REQUIRED"; summary.policyId = plan.policyId; save();
  const detail = await call(first, "approval-readback", "/requests/detail?requestId=" + encodeURIComponent(created.requestId));
  assert(detail?.requestId === created.requestId && detail.status === "EXECUTED" && detail.operation?.code === operationCode && detail.decision?.decision === "APPROVED" && detail.decision.approver?.id === second.userId && detail.execution?.status === "SUCCEEDED" && detail.execution.resultCode === "DISTRIBUTION_POLICY_INITIALIZED" && detail.execution.resultDetail === plan.policyId && detail.execution.executor?.id === first.userId, "DISTRIBUTION_APPROVAL_READBACK_MISMATCH");
}
