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


test("usability shared nodes: node buttons select their id without bubbling into the parent pane", async () => {
  const { createRequire } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const native = createRequire(import.meta.url), { Window } = native("happy-dom");
  const { act, createElement } = native("react"), { createRoot } = native("react-dom/client");
  const { createOfflineAdminSource } = await import(new URL("./offline-admin-source.mjs", import.meta.url).href);
  const browser = new Window({ url: "http://127.0.0.1:3101/approvals/fixture" });
  globalThis.window = browser; globalThis.document = browser.document;
  for (const key of ["HTMLElement", "Element", "Node", "Event", "CustomEvent", "ShadowRoot", "HTMLInputElement", "HTMLButtonElement", "ResizeObserver", "MutationObserver", "DOMMatrixReadOnly", "DOMRect"]) if (browser[key]) globalThis[key] = browser[key];
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
  globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
  globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const source = await createOfflineAdminSource({ root: fileURLToPath(new URL("..", import.meta.url)) });
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host), selected = []; let paneClicks = 0;
  try {
    const { WorkflowCanvas } = await source.ssrLoadModule("/src/components/approvals-ui/workflow-canvas.tsx");
    await act(async () => root.render(createElement("div", { onClick: () => paneClicks++ },
      createElement(WorkflowCanvas, { policy: requestPolicy(detail()), onSelectStep: id => selected.push(id) }))));
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    for (const label of ["提交申请：已提交", "批准：尚无批准决定"]) {
      const node = [...host.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === label);
      assert.ok(node, label);
      const wrapper = node.closest(".react-flow__node");
      assert.ok(wrapper);
      assert.equal(wrapper.style.pointerEvents, "all", "the real ReactFlow node wrapper must accept pointer events");
      await act(async () => node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })));
    }
    assert.deepEqual(selected, ["request", "approved"]);
    console.log("APPROVAL_SHARED_NODE_EVENTS " + JSON.stringify({ selected, paneClicks }));
    assert.equal(paneClicks, 0, "the two actual node callbacks must stop the click before the parent pane");
  } finally {
    await act(async () => root.unmount()); await source.close(); await browser.happyDOM.abort();
  }
});
