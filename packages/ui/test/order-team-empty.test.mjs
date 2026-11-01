import assert from "node:assert/strict";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { createOfflineAdminSource } from "../../../apps/admin/test/offline-admin-source.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createOfflineAdminSource({ root });
const { OrderTeamChatEmptyState, OrderTeamPanel } = await source.ssrLoadModule("/packages/ui/src/order-team-panel.tsx");
after(() => source.close());

const access = (overrides = {}) => ({
  orderId: "order_A", displayNo: "ZZ-A", orderStatus: "COMPLETED", stage: "SETTLED",
  rentalStartedAt: "2026-10-01T00:00:00.000Z", dueAt: null,
  openingState: "CONFIRMED", openingAcks: { renter: true, owner: true }, endState: "POSTED",
  orderEndedAt: null, sendUntil: null, assignmentState: "ASSIGNED", teamState: "READY",
  appId: "app", teamId: "team", name: "订单A", gameName: "三角洲行动",
  account: { id: "acct", title: "账号A" }, viewerAccountId: "viewer", conversationId: "conv_A",
  canRead: true, canSend: false, members: [],
  supportEscalation: { firstResponseAt: null, remindDueAt: null, addRound: 0, state: "NOT_STARTED", needsManualReview: false, noEligibleStaff: false },
  ...overrides,
});

function renderEmpty(props) {
  const browser = new Window();
  const host = browser.document.createElement("div");
  host.innerHTML = renderToStaticMarkup(React.createElement(OrderTeamChatEmptyState, { reading: false, ...props }));
  return host;
}

const stepStates = (host) => [...host.querySelectorAll(".order-team-chat-empty .order-team-stage-steps li")].map((node) => node.dataset.state);

test("an empty settled order group shows the six steps as complete instead of a bare no-messages line", () => {
  const host = renderEmpty({ info: access({ stage: "SETTLED", orderStatus: "COMPLETED" }) });
  const empty = host.querySelector(".order-team-chat-empty");
  assert.ok(empty, "the empty chat state renders");
  assert.equal(empty.getAttribute("role"), "status");
  assert.match(empty.textContent, /还没有消息/);
  assert.deepEqual([...empty.querySelectorAll(".order-team-stage-steps li")].map((node) => node.textContent), ["已付款", "客服与群", "账号与开租", "租用中", "结束确认", "结算完成"]);
  assert.deepEqual(stepStates(host), ["done", "done", "done", "done", "done", "done"]);
  assert.equal(empty.querySelector("a"), null, "no fabricated order link without a callback or href");
  const withoutStage = renderEmpty({ info: access({ stage: undefined, orderStatus: "COMPLETED" }) });
  assert.deepEqual(stepStates(withoutStage), ["done", "done", "done", "done", "done", "done"], "COMPLETED resolves to settlement without a projected stage");
});

test("the empty timeline highlights the current step and keeps later steps pending", () => {
  const host = renderEmpty({ info: access({ stage: "RENTING", orderStatus: "PAID" }) });
  const steps = [...host.querySelectorAll(".order-team-chat-empty .order-team-stage-steps li")];
  assert.deepEqual(stepStates(host), ["done", "done", "done", "current", "pending", "pending"]);
  assert.equal(steps[3].getAttribute("aria-current"), "step");
  assert.equal(steps.filter((node) => node.hasAttribute("aria-current")).length, 1);
});

test("the empty state offers order details only when the panel has a real link", () => {
  const href = "/account?view=rentals&orderId=order_A";
  const host = renderEmpty({ info: access(), orderDetailHref: href });
  const link = host.querySelector(".order-team-chat-empty-link");
  assert.equal(link.textContent, "查看订单详情");
  assert.equal(link.getAttribute("href"), href);
});

async function mountPanel(messages) {
  const browser = new Window({ url: "http://127.0.0.1:3100/account?view=rentals" });
  const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => (ms === 5000 ? { fake: true } : realSetInterval(fn, ms));
  globalThis.clearInterval = (id) => { if (!id?.fake) realClearInterval(id); };
  Object.assign(globalThis, {
    window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Node: browser.Node,
    Event: browser.Event, requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const node = browser.document.createElement("div");
  browser.document.body.append(node);
  const reactRoot = createRoot(node);
  const info = access();
  const client = { accountId: "viewer", transport: "local-fake", onMessages: () => () => {}, async getMessageHistory() { return messages; } };
  const request = async (url) => {
    assert.match(String(url), /^\/api\/orders\/order_A\/im\?operation=read$/);
    return info;
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const until = async (predicate) => { for (let n = 0; n < 200; n += 1) { if (predicate()) return; await settle(); } throw new Error("panel read timed out"); };
  await act(async () => {
    reactRoot.render(React.createElement(OrderTeamPanel, {
      identity: "viewer", realm: "user", client, connection: "CONNECTED", active: true,
      polling: true, compact: true, selectedOrderId: "order_A", request, onAuthError: () => {},
    }));
  });
  return {
    node,
    until,
    async dispose() {
      await act(async () => reactRoot.unmount());
      browser.happyDOM.abort();
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

test("an empty order group renders the stage timeline, and a real message removes it", async () => {
  const empty = await mountPanel([]);
  try {
    await empty.until(() => empty.node.querySelector(".order-team-chat-empty .order-team-stage-steps"));
    const emptyState = empty.node.querySelector(".order-team-chat-empty");
    assert.equal(emptyState.getAttribute("role"), "status");
    assert.deepEqual(stepStates(empty.node), ["done", "done", "done", "done", "done", "done"]);
    assert.equal(emptyState.querySelector(".order-team-chat-empty-link").getAttribute("href"), "/account?view=rentals&orderId=order_A");
  } finally {
    await empty.dispose();
  }
  const message = { messageClientId: "m1", messageServerId: "s1", conversationId: "conv_A", senderId: "staff", createTime: Date.now(), text: "你好", messageType: 0 };
  const conversation = await mountPanel([message]);
  try {
    await conversation.until(() => conversation.node.querySelector("[data-message-id]"));
    assert.equal(conversation.node.querySelector(".order-team-chat-empty"), null);
    assert.equal(conversation.node.querySelector(".order-team-stage-steps"), null, "messages never mount the empty-state timeline");
  } finally {
    await conversation.dispose();
  }
});
