import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Component evidence for the admin order workbench. Every scenario comes from the
 * synthetic samples in test/fixtures. Nothing here touches a real order, payment
 * or NIM group, and no write reaches a real backend.
 */

const browser = new Window({ url: "http://127.0.0.1:4293/support" });
Object.assign(globalThis, {
  window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element,
  Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
const { createRoot } = await import("react-dom/client");
const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({ configFile: false, root: adminRoot, plugins: [react()], resolve: { alias: { "@": path.join(adminRoot, "src") } }, server: { middlewareMode: true, hmr: false } });
const { OrderWorkbenchPane } = await vite.ssrLoadModule("/src/views/im-support-orders.tsx");
const { createFixtureDeps, fixtureById } = await vite.ssrLoadModule("/test/fixtures/order-workbench-fixtures.ts");

const timers = new Map();
let timerId = 0;
const realFetch = globalThis.fetch;
after(async () => { await vite.close(); });
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { if (ms === 5000) { timers.set(++timerId, fn); return timerId; } return realSetInterval(fn, ms); };
globalThis.clearInterval = (id) => { if (!timers.has(id)) realClearInterval(id); };

async function mount(t, caseId, { select = true } = {}) {
  const item = fixtureById(caseId);
  const deps = createFixtureDeps(item);
  globalThis.fetch = deps.fetchStub;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => {
    root.render(createElement(OrderWorkbenchPane, {
      identity: `fixture:${caseId}`, adminUserId: "admin-fixture", operatorName: "小周",
      client: deps.client, connection: "CONNECTED", active: true, sendAllowed: true, request: deps.request, onAuthError: () => undefined,
    }));
  });
  t.after(async () => {
    await act(async () => root.unmount());
    node.remove();
    globalThis.fetch = realFetch;
  });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const until = async (predicate, label) => {
    for (let n = 0; n < 200; n += 1) { if (predicate()) return; await settle(); }
    throw new Error(`condition timed out: ${label ?? caseId}`);
  };
  if (select) {
    await until(() => node.querySelector(".im-wb-queue .im-wb-row"), "list loaded");
    await act(async () => node.querySelector(".im-wb-queue .im-wb-row").click());
  }
  return { node, root, deps, item, settle, until };
}
const rows = (node) => [...node.querySelectorAll(".im-wb-queue .im-wb-row")];
const click = async (button) => { assert.ok(button, "control available"); await act(async () => button.click()); };
const byText = (node, text) => [...node.querySelectorAll("button")].find((button) => button.textContent.includes(text));

test("READY group list, role-attributed chat and 本单详情 come from the loaded projections", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => rows(node).length === 3, "three loaded groups");
  assert.match(rows(node)[0].textContent, /满配六套 · 资源账号/);
  assert.match(rows(node)[0].textContent, /ZZ20261011008842/, "full display number stays addressable, never a guessed tail");
  assert.match(rows(node)[0].textContent, /订单群已就绪/);
  assert.match(rows(node)[2].textContent, /建群待人工核查/, "teamState NEEDS_REVIEW is reported, not smoothed over");
  assert.equal(rows(node)[0].getAttribute("data-active"), "true", "the first loaded group is selected");
  assert.match(node.querySelector(".im-wb-queue-head b").textContent, /3/);

  await until(() => node.querySelector(".im-wb-msg"), "chat rendered");
  const messages = [...node.querySelectorAll(".im-wb-msg")];
  const buyer = messages.find((row) => row.textContent.includes("付款后从哪里交接"));
  assert.match(buyer.textContent, /小林/, "sender name comes from the member table");
  assert.match(buyer.textContent, /买家/, "party BUYER is labelled 买家, never 租客 by guess");
  const staff = messages.find((row) => row.textContent.includes("我来协助本次交接"));
  assert.equal(staff.getAttribute("data-self"), "true", "the operator's own messages sit on the right");
  assert.match(staff.textContent, /负责客服/);
  assert.ok(node.querySelector(".im-wb-sys"), "the join notification is a system marker, not a speaker line");
  assert.equal(node.querySelectorAll(".im-wb-thumb").length, 2, "both staged opening screenshots render");

  const aside = node.querySelector("#im-order-details");
  assert.match(aside.textContent, /account-8842/, "stable account id is shown in full");
  assert.match(aside.textContent, /ZZ20261011008842/);
  assert.match(aside.textContent, /哈夫币/);
  assert.match(aside.textContent, /10000000/, "frozen quantities are copied from the projection verbatim");
  assert.doesNotMatch(aside.textContent, /区服|计划租期|实付金额/, "no cover, server, planned period or payment amount is invented");
  assert.match(aside.querySelector(".im-support-fulfillment").textContent, /待核对期初/);
  assert.match(aside.textContent, /未开租/);
});

test("unknown historical senders degrade neutrally instead of borrowing a name", async (t) => {
  const { node, until } = await mount(t, "unknown-sender");
  await until(() => node.textContent.includes("成员表已无此账号"), "history loaded");
  const row = [...node.querySelectorAll(".im-wb-msg")].find((item) => item.textContent.includes("成员表已无此账号"));
  assert.match(row.textContent, /未署名成员/);
  assert.doesNotMatch(row.textContent, /买家|号主|负责客服/, "an unmapped sender is never attributed to a known party");
});

test("more staff members render as more members, and roles stay non-exclusive", async (t) => {
  const { node, until } = await mount(t, "multi-staff");
  await until(() => node.querySelectorAll(".im-order-members [data-slot=item]").length === 6, "six members");
  assert.match(node.querySelector(".im-wb-chat-actions").textContent, /成员 6/);
  const members = [...node.querySelectorAll(".im-order-members [data-slot=item]")].map((item) => item.textContent);
  assert.equal(members.filter((text) => /负责客服/.test(text)).length, 1);
  assert.equal(members.filter((text) => /协作客服/.test(text)).length, 3);
});

test("party confirmation binds to the same version only", async (t) => {
  const oneAck = await mount(t, "opening-one-ack");
  await oneAck.settle();
  const parties = (node) => [...node.querySelectorAll(".im-order-parties [data-slot=item]")].map((row) => row.textContent.replace(/\s+/g, ""));
  assert.deepEqual(parties(oneAck.node), ["租客待确认", "号主已确认"], "opening acks are per party on the same version");
  assert.match(oneAck.node.querySelector(".im-order-parties").textContent, /客服不能代替/, "the operator is never offered a proxy confirmation");
  assert.match(oneAck.node.querySelector(".im-support-fulfillment").textContent, /等待双方确认期初/);
  assert.match(oneAck.node.textContent, /期初清单 v1/);

  const stale = await mount(t, "stale-decision");
  await stale.settle();
  assert.deepEqual(parties(stale.node), ["租客待确认", "号主待确认"], "confirmations recorded on an older hash do not count for v3");
  assert.match(stale.node.querySelector(".im-support-fulfillment").textContent, /有结束申请待处理/);
});

test("settlement unavailable keeps the conversation readable and never defaults to 待录入", async (t) => {
  const { node, until } = await mount(t, "settlement-unavailable");
  await until(() => node.querySelector(".im-wb-msg"), "history still loaded");
  const task = node.querySelector(".im-support-fulfillment");
  assert.match(task.textContent, /本单进度暂时读不到/);
  assert.match(task.textContent, /不影响在这里沟通/);
  assert.doesNotMatch(task.textContent, /待核对期初|核对并录入期初/, "a failed read is not presented as a missing opening");
  assert.ok(byText(node, "重新读取"), "the only offered action is another read");
  assert.equal(node.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
});

test("send-only revocation keeps history and draft but blocks new sends", async (t) => {
  const { node, until, settle } = await mount(t, "send-only");
  await until(() => node.querySelector(".im-wb-msg"), "history loaded");
  assert.match(node.textContent, /当前只可阅读/);
  const textarea = node.querySelector("textarea");
  assert.equal(textarea.disabled, true, "the composer is read-only");
  assert.equal(byText(node, "发送").disabled, true);
  assert.ok(node.querySelector(".im-wb-thumb"), "already loaded images stay visible");
  await settle();
  assert.match(node.textContent, /期初截图已发/, "loaded history is never cleared by a send revocation");
});

test("the check panel is opened from the task card and writes the frozen quantities", async (t) => {
  const { node, deps, until, settle } = await mount(t, "ready-three");
  await until(() => node.querySelector(".im-support-fulfillment"), "task card");
  assert.equal(document.body.querySelector(".im-order-panel"), null, "quantities are not inline in the rail");
  await click(node.querySelector('[data-action="open-fulfillment-panel"]'));
  await until(() => document.body.querySelector(".im-order-panel"), "panel opened");
  const inputs = [...document.body.querySelectorAll(".im-support-fulfillment-lines input")];
  assert.deepEqual(inputs.map((input) => input.value), ["10000000", "3"], "the opening is seeded from the frozen projection");
  await click(byText(document.body, "期初代录"));
  await until(() => deps.writes.length === 1, "opening written");
  assert.equal(deps.writes[0].path.endsWith("/orders/order-8842/openings"), true);
  assert.deepEqual(deps.writes[0].body, { lines: [{ itemId: "item_haff", quantity: "10000000" }, { itemId: "item_case", quantity: "3" }] });
  assert.match(String(deps.writes[0].key), /^im_ful_record-opening_order-8842_/, "the frozen intent keeps a stable idempotency key");
  await settle();
});

test("search filters only the loaded list and never claims a full count", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => rows(node).length === 3, "loaded");
  const search = node.querySelector('.im-wb-search input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(search, "7710");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await until(() => rows(node).length === 1, "filtered to one row");
  assert.match(rows(node)[0].textContent, /ZZ20261010007710/);
  assert.match(node.querySelector(".im-wb-queue-head b").textContent, /3/, "the header count still reports the loaded set, not the filter result");
  assert.match(node.querySelector(".im-wb-filter-note").textContent, /不代表全部/);
});

test("empty, read failure and forbidden lists stay three different answers", async (t) => {
  const empty = await mount(t, "list-empty", { select: false });
  await empty.settle();
  assert.equal(empty.node.querySelectorAll(".order-team-empty").length, 1, "one whole-area state");
  assert.match(empty.node.textContent, /暂无可访问的订单/);
  assert.equal(empty.node.querySelector(".order-team-grid"), null);
  assert.doesNotMatch(empty.node.textContent, /重新确认授权|选择订单查看/, "a successful empty list is neither an error nor an authorization prompt");

  const failed = await mount(t, "list-error", { select: false });
  await failed.settle();
  assert.match(failed.node.textContent, /订单列表读取失败/);
  assert.ok(byText(failed.node, "重新读取"));
  assert.doesNotMatch(failed.node.textContent, /重新确认授权/, "a read failure is not framed as lost authorization");

  const denied = await mount(t, "list-forbidden", { select: false });
  await denied.settle();
  assert.match(denied.node.textContent, /暂时无法访问订单群/);
  assert.ok(byText(denied.node, "重新确认授权"));
});

test("an unknown text result keeps responsibility and replays the original message", async (t) => {
  const { node, until, settle } = await mount(t, "unknown-image");
  await until(() => node.querySelector("textarea"), "composer ready");
  const textarea = node.querySelector("textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(textarea, "第一条");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(node.querySelector('form button[type="submit"]'));
  await until(() => node.textContent.includes("原消息重试"), "unknown kept");
  assert.match(node.querySelector(".im-wb-pending").textContent, /结果未确认/);
  assert.equal(node.querySelector("textarea").value, "第一条", "the draft survives the unknown result");
  await click(node.querySelector('[data-action="order-retry-text"]'));
  await until(() => !node.querySelector(".im-wb-pending"), "responsibility settled");
  await settle();
});

test("the frozen inventory dialog opens, closes, reopens and stays bound to its order", async (t) => {
  const { node, until, settle } = await mount(t, "ready-three");
  await until(() => node.querySelector('[data-action="order-open-inventory"]'), "inventory entry");
  assert.equal(document.body.querySelector(".im-order-inventory-dialog"), null, "nothing is mounted until it is opened");

  const trigger = node.querySelector('[data-action="order-open-inventory"]');
  await click(trigger);
  await until(() => document.body.querySelector(".im-order-inventory-dialog"), "dialog opened");
  assert.match(document.body.querySelector(".im-order-inventory-dialog").textContent, /ZZ20261011008842/, "the dialog names the order it was opened for");
  assert.match(document.body.querySelector(".im-order-inventory-dialog").textContent, /哈夫币/);

  const closeBtn = document.body.querySelector(`[data-action="close-inventory"]`) ?? document.querySelector(`[data-action="close-inventory"]`);
  assert.ok(closeBtn, "close control present: " + (document.body.querySelector(".im-order-inventory-dialog")?.outerHTML ?? "no dialog").slice(0, 260));
  await click(closeBtn);
  await until(() => !document.body.querySelector(".im-order-inventory-dialog"), "closed by the button");
  await until(() => document.activeElement === node.querySelector('[data-action="order-open-inventory"]'), "focus returns to the trigger");

  await click(node.querySelector('[data-action="order-open-inventory"]'));
  await until(() => document.body.querySelector(".im-order-inventory-dialog"), "reopens after a full close");
  const dialogEl = document.body.querySelector(".im-order-inventory-dialog");
  await act(async () => { dialogEl.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();
  assert.ok(!document.body.querySelector(".im-order-inventory-dialog"), "Escape closes the list dialog too");

  // Switching orders must never leave another order's list on screen.
  await click(node.querySelector('[data-action="order-open-inventory"]'));
  await until(() => document.body.querySelector(".im-order-inventory-dialog"), "opened again");
  await act(async () => rows(node)[1].click());
  await until(() => !document.body.querySelector(".im-order-inventory-dialog"), "selecting another order closes it");
  await until(() => node.querySelector('[data-action="order-open-inventory"]'), "the new order's rail is loaded");
  await act(async () => rows(node)[0].click());
  await until(() => node.querySelector(".im-wb-chat-title").textContent.includes("ZZ20261011008842"), "returned to the first order");
  assert.equal(document.body.querySelector(".im-order-inventory-dialog"), null, "A-B-A cannot resurrect an old dialog without an explicit open");
  await act(async () => rows(node)[1].click());
  await until(() => node.querySelector(".im-wb-chat-title").textContent.includes("ZZ20261010007710"), "selected the second order again");
  await click(node.querySelector('[data-action="order-open-inventory"]'));
  await until(() => document.body.querySelector(".im-order-inventory-dialog"), "reopened for the new order");
  assert.match(document.body.querySelector(".im-order-inventory-dialog").textContent, /ZZ20261010007710/, "the dialog follows the order that is now selected");
});

test("a long inventory stays summarized in the rail and complete in its dialog", async (t) => {
  const { node, until } = await mount(t, "inventory-many");
  await until(() => node.querySelector('[data-action="order-open-inventory"]'), "inventory ready");
  assert.equal(node.querySelectorAll("#im-order-details .im-order-table tbody tr").length, 4, "the rail shows a bounded summary");
  assert.match(node.querySelector("#im-order-details").textContent, /共 24 项/);
  await click(node.querySelector('[data-action="order-open-inventory"]'));
  await until(() => document.body.querySelector(".im-order-inventory-dialog"), "inventory opened");
  const dialog = document.body.querySelector(".im-order-inventory-dialog");
  assert.equal(dialog.querySelectorAll("tbody tr").length, 24, "full inventory is retained");
  assert.match(dialog.textContent, /按数量计价/);
  assert.doesNotMatch(dialog.textContent, /FIXED_UNIT|PER_UNIT|HAFF_RATIO/, "the main view speaks the business language");
  assert.ok(dialog.querySelector(".im-order-inventory-scroll"), "only the inventory body owns scrolling");
});

test("late clipboard success cannot mark another order as copied", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector('[aria-label="复制稳定账号ID"]'), "copy ready");
  const previous = Object.getOwnPropertyDescriptor(browser.navigator, "clipboard");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: { writeText: () => gate } });
  t.after(() => { if (previous) Object.defineProperty(browser.navigator, "clipboard", previous); else delete browser.navigator.clipboard; });
  await click(node.querySelector('[aria-label="复制稳定账号ID"]'));
  await act(async () => rows(node)[1].click());
  await until(() => node.querySelector(".im-wb-chat-title").textContent.includes("ZZ20261010007710"), "another order selected");
  await act(async () => release());
  assert.equal(node.querySelector(".im-rail-copy-status"), null, "old clipboard completion is not applied to the new value");
  await click(node.querySelector('[aria-label="复制稳定账号ID"]'));
  await until(() => /已复制稳定账号ID/.test(node.querySelector(".im-rail-copy-status")?.textContent ?? ""), "current copy confirmed");
});

test("an image failure is scoped to the selected order", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector(".im-wb-thumb img"), "image ready");
  await act(async () => node.querySelector(".im-wb-thumb img").dispatchEvent(new Event("error")));
  await until(() => node.querySelector(".im-wb-thumb-failed"), "image failure shown");
  await act(async () => rows(node)[1].click());
  await until(() => node.querySelector(".im-wb-chat-title").textContent.includes("ZZ20261010007710"), "another order selected");
  assert.equal(node.querySelector(".im-wb-thumb-failed"), null, "a failed image from the previous order does not poison the new order");
});

test("a new identity returns the narrow workbench to its selectable list", async (t) => {
  const { node, root, deps, until } = await mount(t, "ready-three");
  await until(() => node.querySelector(".im-wb-chat"), "original chat");
  assert.equal(node.querySelector(".order-team-grid").getAttribute("data-pane"), "chat");
  const search = node.querySelector('[aria-label="搜索订单群"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(search, "满配");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => root.render(createElement(OrderWorkbenchPane, { identity: "fixture:next-session", adminUserId: "admin-fixture", operatorName: "小周", client: deps.client, connection: "CONNECTED", active: true, sendAllowed: true, request: deps.request, onAuthError: () => undefined })));
  await until(() => node.querySelectorAll(".im-wb-queue .im-wb-row").length === 3, "new scoped directory");
  assert.equal(node.querySelector(".order-team-grid").getAttribute("data-pane"), "list", "the new session can choose a group instead of being trapped in the old chat pane");
  assert.equal(node.querySelector('[aria-label="搜索订单群"]').value, "", "old scoped search text is cleared");
});
