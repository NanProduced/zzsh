import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/support" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.CustomEvent = browser.CustomEvent;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

// 捕获 5 秒定时器，好在测试里手动触发一次目录刷新，而不是靠真实等待。
const intervalCallbacks = [];
const realSetInterval = browser.setInterval.bind(browser);
const realClearInterval = browser.clearInterval.bind(browser);
let fakeIntervalId = 0;
browser.setInterval = (callback, delay) => {
  if (delay === 5_000) {
    const id = `test-${++fakeIntervalId}`;
    intervalCallbacks.push({ callback, delay, id, active: true });
    return id;
  }
  return realSetInterval(callback, delay);
};
browser.clearInterval = (id) => {
  const entry = intervalCallbacks.find((item) => item.id === id);
  if (entry) entry.active = false;
  else realClearInterval(id);
};
globalThis.setInterval = browser.setInterval;
globalThis.clearInterval = browser.clearInterval;

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ImSupportView } = await vite.ssrLoadModule("/src/views/im-support-view.tsx");
after(async () => { await vite.close(); });

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function snapshot(permissions, adminUserId = "admin-a") {
  return {
    authenticated: true,
    adminUserId,
    user: { name: "客服 A", username: adminUserId, displayUsername: "客服 A", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: `session-${adminUserId}`, locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions,
  };
}

const baseConsultation = {
  type: "SERVICE",
  state: "ACTIVE",
  assignedAdmin: { id: "admin-a", name: "客服 A" },
  conversationType: "TEAM",
  messageScopeState: "READY",
  version: 1,
  lastMessageAt: "2026-09-17T00:05:00.000Z",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:05:00.000Z",
};
const makeConsultation = (tag) => ({
  ...baseConsultation,
  id: `consultation-${tag}`,
  subjectRef: tag === "a" ? "listing-9" : null,
  conversationId: `team-${tag}`,
  peerAccountId: `user-${tag}`,
  user: { id: `user-${tag}`, name: `用户 ${tag.toUpperCase()}`, username: `user-${tag}` },
});

const permissions = ["im.support.read", "im.support.accept"];
let currentAdmin = "admin-a";
let closedIds = [];
let pendingCloses = new Map();
let closeBehavior = () => "hold";
const requests = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  const method = init.method ?? "GET";
  requests.push({ path: `${url.pathname}${url.search}`, method });
  if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: currentAdmin, token: "test-token", transport: "local-fake" });
  if (url.pathname.endsWith("/im/consultations") && method === "GET") {
    const rows = ["a", "b"]
      .map(makeConsultation)
      .filter((row) => !closedIds.includes(row.id))
      .map((row) => ({ ...row, assignedAdmin: { id: currentAdmin, name: currentAdmin === "admin-a" ? "客服 A" : "客服 B" } }));
    return response({ consultations: rows });
  }
  if (url.pathname.endsWith("/im/message-access")) return response({ authorized: true });
  if (url.pathname.endsWith("/context")) return response({ consultationId: "c-1", version: 1, service: { type: "SERVICE", state: "ACTIVE", messageScopeState: "READY", handler: null }, user: { status: "available", publicId: "user-7", displayName: "测试用户甲", avatar: null }, subject: { status: "absent" }, membership: { status: "unavailable", reason: "membership_projection_not_integrated" } });
  if (url.pathname.includes("/users/")) return response({ userId: "user-7", maskedPhone: "138****8000", accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", source: { kind: "LOCAL" }, registeredAt: "2026-01-05T00:00:00.000Z" });
  if (url.pathname.endsWith("/im/messages")) return response({ messages: [] });
  const closeMatch = /\/consultations\/([A-Za-z0-9._:-]+)\/close$/.exec(url.pathname);
  if (closeMatch && method === "POST") {
    const id = closeMatch[1];
    const behavior = closeBehavior(id);
    if (behavior === "network") throw new TypeError("Failed to fetch");
    if (behavior === "server-error") return response({ error: { code: "INTERNAL_ERROR" } }, 500);
    if (behavior === "denied") return response({ error: { code: "FORBIDDEN" } }, 403);
    if (behavior === "hold") return new Promise((resolve) => { pendingCloses.set(id, resolve); });
    closedIds = [...closedIds, id];
    return response({ consultation: { ...makeConsultation(id.endsWith("a") ? "a" : "b"), state: "CLOSED" } });
  }
  throw new Error(`unexpected test request ${method} ${url.pathname}${url.search}`);
};

const closePosts = (tag) => requests.filter((request) => request.method === "POST" && (tag
  ? request.path.endsWith(`/consultations/consultation-${tag}/close`)
  : /\/consultations\/[^/]+\/close$/.test(request.path))).length;
const consultationsGets = () => requests.filter((request) => request.method === "GET" && request.path.split("?")[0].endsWith("/im/consultations")).length;

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}
async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

async function mount(t, adminUserId = "admin-a") {
  currentAdmin = adminUserId;
  closedIds = [];
  pendingCloses = new Map();
  closeBehavior = () => "hold";
  requests.length = 0;
  // 只保留本用例活跃的定时器记录，避免上一个用例的条目干扰
  intervalCallbacks.splice(0, intervalCallbacks.length);
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
    browser.document.querySelectorAll(".im-wb-dialog").forEach((dialog) => dialog.remove());
  });
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions, adminUserId), onRefresh: async () => snapshot(permissions, adminUserId) })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-row").length > 0);
  return { rootNode, root };
}

const closeDialog = () => browser.document.querySelector(".im-wb-dialog");
const closeButton = (rootNode) => rootNode.querySelector('[data-action="close-consultation"]');
const confirmButton = () => browser.document.querySelector('[data-action="confirm-close-consultation"]');

async function pick(rootNode, tag) {
  const row = [...rootNode.querySelectorAll(".im-wb-row")].find((item) => item.textContent.includes(`用户 ${tag.toUpperCase()}`));
  assert.ok(row, `queue lists 用户 ${tag.toUpperCase()}`);
  await act(async () => { row.click(); });
  await settle();
}
async function openConfirm(rootNode, tag) {
  await pick(rootNode, tag);
  await act(async () => { closeButton(rootNode).click(); });
  await waitFor(() => closeDialog());
}

test("case column shows only proven current facts, not an inferred stage or turn", async (t) => {
  const { rootNode } = await mount(t);
  assert.equal(rootNode.querySelector(".im-wb-stepper"), null, "no inferred case stepper");
  assert.equal(rootNode.querySelector(".im-wb-next"), null, "no inferred next-step card");
  assert.doesNotMatch(rootNode.textContent, /案件进度|轮到你回复|已加载消息/);
  const aside = rootNode.querySelector(".im-wb-details");
  assert.ok(aside, "case column still renders");
  for (const label of ["本次服务", "服务状态", "当前接待", "发起时间", "关联对象"]) {
    assert.match(aside.textContent, new RegExp(label), `case column states ${label}`);
  }
});

test("ending a consultation is confirmed, cancel is free, and double submit stays single-flight", async (t) => {
  const { rootNode } = await mount(t);
  await openConfirm(rootNode, "a");
  const dialog = closeDialog();
  assert.match(dialog.textContent, /结束咨询/);
  assert.match(dialog.textContent, /客服 A/, "the dialog names the current assignee");
  assert.match(dialog.textContent, /listing-9/, "the dialog names the linked subject");
  assert.match(dialog.textContent, /不可撤销/, "the dialog states the consequence");
  assert.equal(closePosts(), 0, "opening the confirmation does not submit anything");

  const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "取消");
  await act(async () => { cancel.click(); });
  await settle();
  assert.equal(closePosts(), 0, "cancelling the confirmation never posts");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 2);

  await act(async () => { closeButton(rootNode).click(); });
  await waitFor(() => closeDialog());
  await act(async () => { confirmButton().click(); confirmButton().click(); });
  await settle();
  assert.equal(closePosts("a"), 1, "double submitting the confirmation stays single-flight");

  await act(async () => { pendingCloses.get("consultation-a")(response({ consultation: { ...makeConsultation("a"), state: "CLOSED" } })); });
  await settle();
  assert.equal(browser.document.querySelector(".im-wb-dialog"), null, "the dialog closes after a confirmed close");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 1, "the closed consultation leaves the queue");
});

test("an unknown close outcome is never inferred from the directory", async (t) => {
  const { rootNode } = await mount(t);
  closeBehavior = () => "network";
  await openConfirm(rootNode, "a");
  await act(async () => { confirmButton().click(); });
  await settle();

  assert.equal(closePosts("a"), 1, "the failed attempt is not retried automatically");
  assert.match(rootNode.textContent, /结束结果未确认/, "the operator is told the outcome is unknown");
  assert.match(rootNode.textContent, /无法确认/, "the copy says the platform cannot confirm it here");
  assert.doesNotMatch(rootNode.textContent, /仍进行中|可以重新结束/, "no inferred 'still active, you may close again' claim");
  assert.equal(rootNode.querySelector('[data-action="recheck-close-outcome"]'), null, "no directory read is dressed up as a result check");
  const button = closeButton(rootNode);
  assert.equal(button.disabled, true, "no further close can be submitted while the outcome is unknown");
  assert.match(button.textContent, /结束结果未确认/);

  // 目录读取（轮询或任意刷新）不能清掉未知状态，也不能产生新的 close。
  const getsBefore = consultationsGets();
  const postsBefore = closePosts();
  for (const entry of intervalCallbacks.filter((item) => item.active && item.delay === 5_000)) {
    await act(async () => { entry.callback(); await Promise.resolve(); });
  }
  await settle();
  assert.ok(consultationsGets() > getsBefore, "the directory really was re-read");
  assert.match(rootNode.textContent, /结束结果未确认/, "a directory re-read cannot clear the unknown state");
  assert.equal(closePosts(), postsBefore, "a directory re-read never produces another close");
  assert.equal(closeButton(rootNode).disabled, true);
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 2, "the row is not optimistically removed");
  await pick(rootNode, "b");
  assert.equal(rootNode.querySelector('.im-wb-notice[data-tone="warn"]'), null, "the unknown banner belongs to A, not to every conversation");
  assert.match(rootNode.textContent, /结束结果未确认，待平台核对/, "A still carries the marker in the queue row");
});

test("a close that succeeds while another conversation is selected still settles on the original one", async (t) => {
  const { rootNode } = await mount(t);
  await openConfirm(rootNode, "a");
  await act(async () => { confirmButton().click(); });
  await settle();
  assert.equal(closePosts("a"), 1);

  await pick(rootNode, "b");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 2);
  assert.equal(closeButton(rootNode).disabled, true, "while A is in flight B cannot close either");

  await act(async () => { pendingCloses.get("consultation-a")(response({ consultation: { ...makeConsultation("a"), state: "CLOSED" } })); });
  await settle();
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 1, "A leaves the queue even though B was selected when the receipt arrived");
  assert.match(rootNode.textContent, /咨询已结束/, "the original close reports its own result");
});

test("a close that fails after switching away still records the unknown on the original consultation", async (t) => {
  const { rootNode } = await mount(t);
  await openConfirm(rootNode, "a");
  await act(async () => { confirmButton().click(); });
  await settle();

  await pick(rootNode, "b");
  await act(async () => { pendingCloses.get("consultation-a")(response({ error: { code: "INTERNAL_ERROR" } }, 500)); });
  await settle();
  assert.equal(closePosts("a"), 1, "the unknown outcome is not re-posted");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 2, "A stays in the queue");

  await pick(rootNode, "a");
  assert.match(rootNode.textContent, /结束结果未确认/, "A carries the unknown responsibility, not B");
  assert.equal(closeButton(rootNode).disabled, true);
  assert.doesNotMatch(rootNode.textContent, /仍进行中|可以重新结束/);
});

test("a receipt for the previous identity never lands on the new one", async (t) => {
  const { rootNode, root } = await mount(t);
  await openConfirm(rootNode, "a");
  await act(async () => { confirmButton().click(); });
  await settle();
  assert.equal(closePosts("a"), 1);

  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions, "admin-b"), onRefresh: async () => snapshot(permissions, "admin-b") })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-row").length === 2);

  await act(async () => { pendingCloses.get("consultation-a")(response({ consultation: { ...makeConsultation("a"), state: "CLOSED" } })); });
  await settle();
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 2, "the old identity's receipt cannot remove rows from the new identity's queue");
  assert.doesNotMatch(rootNode.textContent, /咨询已结束|结束结果未确认/, "the old identity's result never lands on the new one");
});

test("a definite rejection keeps the consultation actionable instead of marking the outcome unknown", async (t) => {
  const { rootNode } = await mount(t);
  closeBehavior = () => "denied";
  await openConfirm(rootNode, "a");
  await act(async () => { confirmButton().click(); });
  await settle();
  assert.equal(closePosts("a"), 1);
  assert.doesNotMatch(rootNode.textContent, /结束结果未确认/, "a 4xx is a definite answer, not an unknown outcome");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 2);
  await pick(rootNode, "a");
  assert.equal(closeButton(rootNode).disabled, false, "a definite rejection can still be acted on again");
});

// —— 单独撤销接待/发送权限时，已经发出去的关闭回执仍要收敛 ——
const readOnly = ["im.support.read"];
const revokeSend = async (root, permissions = readOnly) => {
  await act(async () => { root.render(createElement(ImSupportView, { snapshot: snapshot(permissions), onRefresh: async () => snapshot(permissions) })); });
  await settle();
};

test("a close in flight when only the send permission is revoked still converges", async (t) => {
  const { rootNode, root } = await mount(t);
  await openConfirm(rootNode, "a");
  await act(async () => { confirmButton().click(); });
  await settle();
  assert.equal(closePosts("a"), 1);

  await revokeSend(root);
  assert.equal(closeButton(rootNode).disabled, true, "a revoked send permission stops any new close");

  await act(async () => { pendingCloses.get("consultation-a")(response({ consultation: { ...makeConsultation("a"), state: "CLOSED" } })); });
  await settle();
  assert.equal(closePosts("a"), 1, "converging never re-posts the close");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 1, "the receipt still settles on the original consultation");
  assert.match(rootNode.textContent, /咨询已结束/);
  assert.doesNotMatch(rootNode.textContent, /结束结果未确认/);
});

test("a close that returns UNKNOWN after a send-only revoke keeps the original intent", async (t) => {
  const { rootNode, root } = await mount(t);
  await openConfirm(rootNode, "a");
  await act(async () => { confirmButton().click(); });
  await settle();
  assert.equal(closePosts("a"), 1);

  await revokeSend(root);
  await act(async () => { pendingCloses.get("consultation-a")(response({ error: { code: "INTERNAL_ERROR" } }, 500)); });
  await settle();

  assert.equal(closePosts("a"), 1, "the unknown outcome is not re-posted after the permission change");
  assert.equal(rootNode.querySelectorAll(".im-wb-row").length, 2, "A stays in the queue instead of silently dropping out");
  assert.match(rootNode.textContent, /结束结果未确认/, "the unknown responsibility is kept, not discarded with the permission");
  assert.match(rootNode.textContent, /结束结果未确认，待平台核对/, "the queue row keeps the marker for A");
  assert.equal(closeButton(rootNode).disabled, true);
  assert.doesNotMatch(rootNode.textContent, /仍进行中|可以重新结束/);
});
