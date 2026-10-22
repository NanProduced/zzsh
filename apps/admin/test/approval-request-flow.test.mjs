import assert from "node:assert/strict";
import { test } from "node:test";
import { requestPolicy } from "../src/lib/approvals-ui/request-policy.ts";

const person = { username: "operator", name: "运营" };
function detail(extra = {}) {
  return {
    requestId: "request-1", operationCode: "membership.entitlement.grant", triggerCondition: "MANUAL",
    payloadVersion: 1, payloadHash: "hash", summary: "赠送礼遇", status: "PENDING", requester: person,
    createdAt: "2026-10-23T00:00:00Z", expiresAt: null,
    operation: { code: "membership.entitlement.grant", triggerCondition: "MANUAL", payloadVersion: 1, payloadHash: "hash", executionMode: "GENERIC_TRANSACTION" },
    template: { id: "template-1", version: 2 }, decision: null, execution: null,
    candidates: [{ ...person, username: "reviewer", eligible: true }],
    candidateAvailability: { total: 1, eligible: 1, blockingReasonCode: null },
    history: [], supersedesRequestId: null, supersededByRequestId: null,
    ...extra,
  };
}
const step = (policy, id) => policy.steps.find(item => item.id === id);

test("pending request has one candidate gate, two possible outcomes, and no implied execution", () => {
  const policy = requestPolicy(detail());
  assert.deepEqual(policy.roots, ["request"]);
  assert.deepEqual(step(policy, "review").next, ["approved", "rejected"]);
  assert.equal(step(policy, "review").status, "pending");
  assert.equal(step(policy, "approved").statusLabel, "尚无批准决定");
  assert.equal(step(policy, "approved").status, "inactive");
  assert.equal(step(policy, "rejected").statusLabel, "尚无拒绝决定");
  assert.equal(step(policy, "execution").statusLabel, "尚未执行");
  assert.equal(step(policy, "execution").description, "业务摘要未接入");
});

test("approval is not execution or entitlement activation", () => {
  const policy = requestPolicy(detail({ status: "APPROVED", decision: { decision: "APPROVED", approver: person, reason: "已调整期限", createdAt: null } }));
  assert.equal(step(policy, "approved").status, "complete");
  assert.equal(step(policy, "execution").status, "pending");
  assert.equal(step(policy, "execution").statusLabel, "待执行");
  assert.equal(step(policy, "execution").description, "业务摘要未接入");
  assert.equal(step(policy, "review").facts.find(fact => fact.label === "处理说明").value, "已调整期限");
});

test("rejected, expired, and replaced requests do not imply a successful path", () => {
  const rejected = requestPolicy(detail({ status: "REJECTED", decision: { decision: "REJECTED", approver: person, reason: "范围不符", createdAt: null } }));
  assert.equal(step(rejected, "rejected").status, "complete");
  assert.equal(step(rejected, "approved").status, "inactive");
  assert.equal(step(rejected, "execution").status, "inactive");
  for (const status of ["EXPIRED", "CANCELLED"]) {
    const policy = requestPolicy(detail({ status }));
    assert.equal(step(policy, "review").status, "inactive");
    assert.equal(step(policy, "approved").status, "inactive");
    assert.equal(step(policy, "rejected").status, "inactive");
  }
});

test("unknown and missing projections remain unknown, without a client policy engine", () => {
  const policy = requestPolicy(detail({ status: "FUTURE_STATUS", candidateAvailability: null, candidates: [] }));
  assert.equal(step(policy, "review").status, "unknown");
  assert.equal(step(policy, "approved").status, "unknown");
  assert.equal(step(policy, "review").facts.find(fact => fact.label === "本单可处理").value, "未提供");
  assert.equal(step(policy, "review").statusLabel, "决定记录未读到");
  assert.equal(step(policy, "review").facts.find(fact => fact.label === "申请状态").value, "FUTURE_STATUS");
  assert.equal("quorum" in step(policy, "review"), false);
  assert.equal("threshold" in policy, false);
  const missingEligibility = requestPolicy(detail({ candidates: [{ ...person }] }));
  assert.equal(step(missingEligibility, "review").approvers[0].title, "通用资格未提供");
});

test("execution receipt and actual business result are separate facts", () => {
  const policy = requestPolicy(detail({
    status: "EXECUTED", decision: { decision: "APPROVED", approver: person, reason: null, createdAt: null },
    execution: { status: "SUCCEEDED", resultCode: "APPLIED", resultDetail: null, executor: person, createdAt: null, completedAt: null },
    business: { resultAvailability: "UNRESOLVED", resultReasonCode: "NOT_READY" },
  }));
  assert.equal(step(policy, "execution").status, "complete");
  assert.equal(step(policy, "execution").statusLabel, "执行成功");
  assert.equal(step(policy, "execution").description, "业务结果未读到");
  const failed = requestPolicy(detail({ execution: { status: "FAILED", resultCode: "FAILED", resultDetail: "未执行变更", executor: person, createdAt: null, completedAt: null } }));
  assert.equal(step(failed, "execution").status, "failed");
});
