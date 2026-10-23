import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheParent = path.resolve(rootPath, "../../tmp");
await mkdir(cacheParent, { recursive: true });
const cacheDir = await mkdtemp(path.join(cacheParent, "membership-workspace-test-"));
const browser = new Window({ url: "http://127.0.0.1:4291/membership-growth" });
for (const key of ["document", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "HTMLInputElement"]) globalThis[key] = browser[key];
globalThis.window = browser;
globalThis.sessionStorage = browser.sessionStorage;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
browser.matchMedia = query => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const { createRoot } = await import("react-dom/client");
const stubs = {
  name: "membership-workspace-boundaries",
  enforce: "pre",
  configResolved(config) {
    // This suite only loads SSR modules; do not start a client optimizer against app caches.
    config.optimizeDeps.include = [];
    config.optimizeDeps.noDiscovery = true;
  },
  resolveId(id, importer) {
    if (!importer?.endsWith("membership-benefits-workspace.tsx")) return;
    if (id === "./approval-audit-view") return "\0membership-approval-host";
    if (id === "./membership-entitlement-form") return "\0membership-domain-form";
  },
  load(id) {
    if (id === "\0membership-approval-host") return 'import {createElement} from "react";export function ApprovalAuditView(props){globalThis.__approvalProps=props;return createElement("div",{"data-testid":"existing-approval-host"},props.initialRequestId||"原请求恢复")}';
    if (id === "\0membership-domain-form") return 'import {createElement} from "react";export function MembershipEntitlementForm(props){globalThis.__entitlementFormProps=props;return createElement("div",{"data-testid":"domain-form"},props.error||"领域表单")}export function InfoHint(props){return createElement("span",{"data-testid":"info-hint"},props.label)}';
  },
};
const vite = await createServer({ configFile: false, root: rootPath, cacheDir, plugins: [react(), stubs], resolve: { alias: { "@": path.join(rootPath, "src") } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
const { MembershipBenefitsWorkspace, useMembershipApprovalRequest } = await vite.ssrLoadModule("/src/views/membership-benefits-workspace.tsx");
const { inspectPending, pendingWriteSubject } = await vite.ssrLoadModule("/src/views/approval/pending-writes.ts");
after(async () => {
  await vite.close(); await browser.happyDOM.abort();
  assert.equal(path.dirname(path.resolve(cacheDir)), cacheParent);
  assert.match(path.basename(cacheDir), /^membership-workspace-test-/);
  await rm(cacheDir, { recursive: true, force: true });
});

let identity = 0;
function snapshot(permissions = ["membership.growth.read.summary", "membership.entitlement.request", "membership.entitlement.revoke", "approval.request.create", "user.directory.read", "user.phone.lookup"]) {
  identity++;
  return { authenticated: true, adminUserId: `actor-${identity}`, user: { twoFactorEnabled: true }, security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false }, session: { id: `session-${identity}`, locked: false, pinConfigured: true, createdAt: null, expiresAt: null }, permissions };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const record = { id: "entitlement-1", userId: "user-source", userSummary: { name: "来源用户", image: null, maskedPhone: "138****0000" }, gameId: "delta", gameName: "三角洲", kind: "FRIEND", scopeKey: "game:delta", startsAtUtc: "2026-10-23T00:00:00Z", endsAtUtc: "2026-11-10T00:00:00Z", status: "ACTIVE", depositWaived: false, approvedPolicyId: "policy-approved", approvalRequestId: "approval-old", pricingSummary: { knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: "ordinary", payableRatio: "0.9" } };
const context = { schema: "membership-entitlement-context.v1", subject: { userId: "user-source", name: "来源用户", image: null, maskedPhone: null }, game: { id: "delta", name: "三角洲" }, approvedMeta: { id: "policy-approved", version: "1", effectiveAtUtc: "2026-10-01T00:00:00Z", ruleReleaseId: "sealed-1", priceVersionId: "price-1", payloadHash: "a".repeat(64), sourceRef: "source" }, ranges: null, rangeSource: "INDEPENDENT", capability: { canRequest: true, reasonCode: "OK" }, existingEntitlements: [record] };
const draft = { kind: "FRIEND", scopeKey: "game:delta", startsAtUtc: "2026-10-23T00:00:00Z", endsAtUtc: "2026-11-20T00:00:00Z", pricingMode: "ordinary", priceVersionId: "price-1", payableRatio: "0.88", costBasisRef: "cost-ref", depositWaived: true, reason: "运营确认" };
function page(overrides = {}) { return { schema: "membership-entitlements.v1", asOfUtc: "2026-10-23T00:00:00Z", total: 40, page: 1, pageSize: 20, contextKey: "scope-1", items: [record], ...overrides }; }
const options = { games: [{ id: "delta", name: "三角洲" }], capability: { canRead: true, canRequest: true } };
function installFetch(handler = () => undefined) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), "http://test");
    const pathname = parsed.pathname.replace("/api/bff/admin", "");
    const call = { path: pathname, url: String(url), params: parsed.searchParams, init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const response = await handler(call);
    if (response !== undefined) return response;
    if (pathname.endsWith("entitlement-options")) return json(options);
    if (pathname.endsWith("/entitlements")) return json(page({ page: Number(parsed.searchParams.get("page") || 1) }));
    if (pathname.endsWith("entitlement-context")) return json(context);
    if (pathname.endsWith("requests/detail")) return json({ requestId: parsed.searchParams.get("requestId"), operationCode: "membership.entitlement.replace" });
    throw new Error("Unexpected fixture request " + pathname);
  };
  return calls;
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function until(check) { for (let count = 0; count < 150; count++) { if (check()) return; await settle(); } throw new Error("Workspace condition timed out"); }
function button(text, scope = browser.document.body) { return [...scope.querySelectorAll("button")].find(item => item.textContent.trim() === text || item.getAttribute("aria-label") === text); }
async function click(element) { assert.ok(element, "button exists"); await act(async () => { element.click(); }); await settle(); }
async function mounted(Component, props) {
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Component, props))); await settle();
  return { host, async render(next) { await act(async () => root.render(createElement(Component, next))); await settle(); }, async dispose() { await act(async () => root.unmount()); host.remove(); await settle(); } };
}
let hook;
function HookHost({ actor }) { hook = useMembershipApprovalRequest(actor); return createElement("span", null, hook.pending.state); }
const createBody = { operationCode: "membership.entitlement.grant", triggerCondition: "membership.entitlement.grant.requested", payloadVersion: 1, payload: { userId: "user-source", gameId: "delta" }, summary: "办理礼遇" };

test("create hook locks synchronously, preserves original key on UNKNOWN, and only reads recovery", async () => {
  let accept = false;
  const calls = installFetch(call => {
    if (call.path === "/security/approvals/requests") throw new Error("network acknowledgement lost");
    if (call.path.endsWith("/recovery")) return json({ knowledge: accept ? "KNOWN" : "UNRESOLVED", key: call.params.get("key"), operation: "approval.request.create", targetRequestId: null, ...(accept ? { originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "original-request", status: "PENDING" } } : {}) });
    if (call.path.endsWith("requests/detail")) return json({ requestId: "original-request", operationCode: createBody.operationCode });
  });
  const actor = snapshot(), view = await mounted(HookHost, { actor });
  try {
    await act(async () => { await Promise.all([hook.submit(createBody), hook.submit(createBody)]); });
    assert.equal(calls.filter(call => call.init.method === "POST").length, 1);
    assert.equal(hook.pending.state, "valid");
    const key = hook.pending.record.idempotencyKey;
    await act(async () => { await hook.submit(createBody); await hook.recover(); });
    assert.equal(hook.pending.state, "valid");
    assert.equal(hook.pending.record.idempotencyKey, key);
    assert.equal(calls.filter(call => call.init.method === "POST").length, 1);
    assert.equal(calls.find(call => call.path.endsWith("/recovery")).params.get("key"), key);
    accept = true;
    await act(async () => { await hook.recover(); });
    assert.equal(hook.pending.state, "absent");
    assert.equal(hook.requestId, "original-request");
  } finally { await view.dispose(); }
});

test("accepted-but-unreadable keeps responsibility, and late actor responses cannot expose an old request", async () => {
  let readFails = true;
  const calls = installFetch(call => {
    if (call.path === "/security/approvals/requests") return json({ requestId: "accepted-request" });
    if (call.path.endsWith("requests/detail")) return readFails ? json({ error: { code: "INTERNAL_ERROR" } }, 500) : json({ requestId: "accepted-request", operationCode: createBody.operationCode });
    if (call.path.endsWith("/recovery")) return json({ knowledge: "KNOWN", key: call.params.get("key"), operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt: { approvalRequestId: "accepted-request", status: "PENDING" } });
  });
  const actor = snapshot(), view = await mounted(HookHost, { actor });
  try {
    let id;
    await act(async () => { id = await hook.submit(createBody); });
    assert.equal(id, "accepted-request"); assert.equal(hook.pending.record.kind, "readback");
    await act(async () => { await hook.submit(createBody); });
    assert.equal(calls.filter(call => call.init.method === "POST").length, 1);
    readFails = false; await act(async () => { await hook.recover(); });
    assert.equal(hook.pending.state, "absent");
    let release;
    globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
    let pending;
    await act(async () => { pending = hook.submit(createBody); });
    const other = snapshot(); await view.render({ actor: other });
    await act(async () => { release(json({ requestId: "old-actor-request" })); await pending; });
    assert.equal(hook.requestId, null); assert.equal(hook.pending.state, "absent");
    assert.equal(inspectPending(pendingWriteSubject(actor.adminUserId, actor.session.id, "", "approval.request.create")).state, "valid");
  } finally { await view.dispose(); }
});

test("unreadable original-key storage blocks submission before any POST", async () => {
  const calls = installFetch();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("storage disabled"); } });
  const view = await mounted(HookHost, { actor: snapshot() });
  try {
    await act(async () => { await hook.submit(createBody); });
    assert.equal(hook.pending.state, "unreadable");
    assert.equal(calls.length, 0);
  } finally { await view.dispose(); Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: browser.sessionStorage }); }
});

test("create recovery rejects a missing request id and impossible original terminal status", async () => {
  let receipt = { status: "PENDING" };
  const calls = installFetch(call => {
    if (call.path === "/security/approvals/requests") throw new Error("lost acknowledgement");
    if (call.path.endsWith("/recovery")) return json({ knowledge: "KNOWN", key: call.params.get("key"), operation: "approval.request.create", targetRequestId: null, originalResponseStatus: 200, outcome: "ACCEPTED", receipt });
  });
  const view = await mounted(HookHost, { actor: snapshot() });
  try {
    await act(async () => { await hook.submit(createBody); await hook.recover(); });
    assert.equal(hook.pending.state, "valid"); assert.match(hook.error, /申请号/);
    receipt = { approvalRequestId: "invalid-terminal", status: "EXECUTED" };
    await act(async () => { await hook.recover(); });
    assert.equal(hook.pending.state, "valid"); assert.equal(hook.requestId, null);
    assert.equal(calls.some(call => call.path.endsWith("requests/detail")), false);
  } finally { await view.dispose(); }
});

test("a first explicit rejection clears its responsibility while denied recovery keeps an UNKNOWN", async () => {
  let reject = true;
  installFetch(call => {
    if (call.path === "/security/approvals/requests") {
      if (reject) return json({ error: { code: "FORBIDDEN" } }, 403);
      throw new Error("lost acknowledgement");
    }
    if (call.path.endsWith("/recovery")) return json({ error: { code: "FORBIDDEN" } }, 403);
  });
  const view = await mounted(HookHost, { actor: snapshot() });
  try {
    await act(async () => { await hook.submit(createBody); });
    assert.equal(hook.pending.state, "absent");
    reject = false; await act(async () => { await hook.submit(createBody); });
    const key = hook.pending.record.idempotencyKey;
    await act(async () => { await hook.recover(); });
    assert.equal(hook.pending.state, "valid"); assert.equal(hook.pending.record.idempotencyKey, key);
    assert.match(hook.error, /无权查询原结果/);
  } finally { await view.dispose(); }
});

test("replacement keeps target and approved policy, reuses approval host, and policy stays mounted", async () => {
  const calls = installFetch(call => call.path === "/security/approvals/requests" ? json({ requestId: "replacement-approval" }) : undefined);
  function Policy() { const [count, setCount] = useState(0); return createElement("button", { onClick: () => setCount(value => value + 1) }, "草稿" + count); }
  const actor = snapshot(), view = await mounted(MembershipBenefitsWorkspace, { snapshot: actor, policy: createElement(Policy) });
  try {
    await until(() => button("替换/续期", view.host));
    await click(button("会员政策", view.host)); await click(button("草稿0", view.host));
    await click(button("礼遇管理", view.host)); await click(button("会员政策", view.host));
    assert.ok(button("草稿1", view.host));
    await click(button("礼遇管理", view.host)); await click(button("替换/续期", view.host));
    await until(() => browser.document.querySelector('[data-testid="domain-form"]'));
    assert.equal(globalThis.__entitlementFormProps.initial.scopeKey, record.scopeKey);
    await act(async () => { await globalThis.__entitlementFormProps.onSubmit({ ...draft, kind: "PRESTIGE" }); });
    assert.equal(calls.some(call => call.path === "/security/approvals/requests"), false);
    assert.match(globalThis.__entitlementFormProps.error, /保留原礼遇类型与范围/);
    await act(async () => { await globalThis.__entitlementFormProps.onSubmit(draft); }); await settle();
    const write = calls.find(call => call.path === "/security/approvals/requests");
    assert.equal(write.body.operationCode, "membership.entitlement.replace");
    assert.equal(write.body.payload.replaceEntitlementId, record.id);
    assert.equal(write.body.payload.policyId, "policy-approved");
    assert.equal(write.body.payload.scopeKey, record.scopeKey);
    assert.equal(globalThis.__approvalProps.initialRequestId, "replacement-approval");
    assert.equal(globalThis.__approvalProps.objectOnly, true);
    assert.match(view.host.textContent, /已提交审批/);
    assert.equal(record.status, "ACTIVE");
  } finally { await view.dispose(); }
});

test("list409 hides obsolete rows and retries without the old scope token", async () => {
  let conflict = true;
  const calls = installFetch(call => {
    if (call.path.endsWith("/entitlements") && call.params.get("page") === "2") return conflict ? json({ error: { code: "CONFLICT" } }, 409) : json(page({ page: 2, contextKey: "scope-2" }));
  });
  const view = await mounted(MembershipBenefitsWorkspace, { snapshot: snapshot() });
  try {
    await until(() => view.host.querySelector("tbody tr"));
    await click(button("下一页", view.host));
    await until(() => view.host.textContent.includes("读取范围已变化"));
    assert.equal(view.host.querySelector("tbody tr"), null);
    assert.equal(calls.filter(call => call.path.endsWith("/entitlements")).at(-1).params.get("contextKey"), "scope-1");
    conflict = false; await click(button("重试", view.host));
    await until(() => view.host.querySelector("tbody tr"));
    assert.equal(calls.filter(call => call.path.endsWith("/entitlements")).at(-1).params.has("contextKey"), false);
  } finally { await view.dispose(); }
});

test("request-only operators use the authorized source user and never probe directory or full lists", async () => {
  const calls = installFetch(call => call.path.endsWith("entitlement-options") ? json({ ...options, capability: { canRead: false, canRequest: true } }) : undefined);
  const actor = snapshot(["approval.request.create", "membership.entitlement.request"]);
  const view = await mounted(MembershipBenefitsWorkspace, { snapshot: actor, initialUserId: "user-source", initialGameId: "delta" });
  try {
    await until(() => button("办理礼遇", view.host)); await click(button("办理礼遇", view.host));
    await until(() => globalThis.__entitlementFormProps.context.subject.userId === "user-source");
    assert.equal(calls.some(call => call.path === "/users" || call.path === "/users/lookup" || call.path.endsWith("/entitlements")), false);
    assert.equal(browser.document.querySelector('input[aria-label="查找用户"]'), null);
    assert.equal(view.host.querySelector('[role="tab"][data-value="policy"]'), null);
    await act(async () => { await globalThis.__entitlementFormProps.onSubmit(draft); });
    assert.equal(calls.some(call => call.path === "/security/approvals/requests"), false);
    assert.match(globalThis.__entitlementFormProps.error, /已有同范围礼遇/);
  } finally { await view.dispose(); }
});

test("revocation is a target-bound approval request, never an optimistic status mutation", async () => {
  const calls = installFetch(call => {
    if (call.path === "/security/approvals/requests") return json({ requestId: "revoke-approval" });
    if (call.path.endsWith("requests/detail")) return json({ requestId: "revoke-approval", operationCode: "membership.entitlement.revoke" });
  });
  const view = await mounted(MembershipBenefitsWorkspace, { snapshot: snapshot() });
  try {
    await until(() => button("申请撤销", view.host)); await click(button("申请撤销", view.host));
    await until(() => browser.document.querySelector('textarea[aria-label="撤销原因"]'));
    const input = browser.document.querySelector('textarea[aria-label="撤销原因"]');
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, "权益核对后撤销"); input.dispatchEvent(new browser.Event("input", { bubbles: true })); });
    await click(button("提交撤销审批"));
    await until(() => calls.some(call => call.path === "/security/approvals/requests"));
    const write = calls.find(call => call.path === "/security/approvals/requests");
    assert.equal(write.body.operationCode, "membership.entitlement.revoke");
    assert.deepEqual(write.body.payload, { entitlementId: record.id, gameId: record.gameId, scopeKey: record.scopeKey, reason: "权益核对后撤销" });
    assert.equal(calls.some(call => call.init.method === "DELETE" || call.init.method === "PUT"), false);
    assert.equal(record.status, "ACTIVE");
  } finally { await view.dispose(); }
});

test("a refresh403 removes visible old rows rather than retaining an unauthorized projection", async () => {
  let denied = false;
  installFetch(call => call.path.endsWith("/entitlements") && denied ? json({ error: { code: "FORBIDDEN" } }, 403) : undefined);
  const view = await mounted(MembershipBenefitsWorkspace, { snapshot: snapshot() });
  try {
    await until(() => view.host.querySelector("tbody tr"));
    denied = true; await click(button("刷新礼遇", view.host));
    await until(() => view.host.textContent.includes("无权查看这部分内容"));
    assert.equal(view.host.querySelector("tbody tr"), null);
  } finally { await view.dispose(); }
});

test("user choice reuses exact-phone POST lookup and keeps the phone out of every URL", async () => {
  const calls = installFetch(call => {
    if (call.path === "/users/lookup") return json({ paginationMode: "page", items: [{ userId: "user-lookup", name: "匹配用户", image: null, username: null, displayUsername: null, maskedPhone: "138****8000", accountStatus: "ACTIVE", suspended: false, identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: null, registeredAtSource: "UNKNOWN", createdAt: "2026-10-01", updatedAt: "2026-10-01" }], total: 1, page: 1, pageSize: 10, contextKey: "a".repeat(64), nextCursor: null, limit: 10 });
  });
  const view = await mounted(MembershipBenefitsWorkspace, { snapshot: snapshot() });
  try {
    await until(() => button("选择用户", view.host)); await click(button("选择用户", view.host));
    const input = browser.document.querySelector('input[aria-label="查找用户"]');
    assert.ok(input);
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, "13800138000"); input.dispatchEvent(new browser.Event("input", { bubbles: true })); });
    await click(button("查询")); await until(() => calls.some(call => call.path === "/users/lookup"));
    assert.equal(calls.find(call => call.path === "/users/lookup").body.phone, "13800138000");
    assert.equal(calls.some(call => call.url.includes("13800138000")), false);
    await until(() => [...browser.document.querySelectorAll("button")].some(item => item.textContent.includes("匹配用户")));
    await click([...browser.document.querySelectorAll("button")].find(item => item.textContent.includes("匹配用户")));
    await until(() => calls.some(call => call.path.endsWith("/entitlements") && call.params.get("userId") === "user-lookup"));
  } finally { await view.dispose(); }
});
