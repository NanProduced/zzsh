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

async function mount(t, caseId, { select = true, fixture } = {}) {
  const item = fixture ?? fixtureById(caseId);
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

test("READY group list, role-attributed chat and the complementary order rail come from the loaded projections", async (t) => {
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
  assert.match(aside.textContent, /满配六套 · 资源账号（含安全箱）/, "the rail complements the header with the account title");
  assert.match(aside.textContent, /三角洲行动/);
  assert.match(aside.textContent, /买家小林/);
  assert.match(aside.textContent, /号主老陈/);
  assert.match(aside.textContent, /哈夫币/);
  assert.match(aside.textContent, /10,000,000 哈夫币/, "frozen quantities are copied from the projection verbatim");
  assert.match(aside.textContent, /金额待核对/, "without a frozen quote the amount stays unknown, never 0");
  assert.doesNotMatch(aside.textContent, /¥0\.00/, "an unknown amount is never rendered as 0");
  assert.doesNotMatch(aside.textContent, /account-8842|tenant-account|owner-account|10001|20002|30003/, "no account or user UUID is repeated in the rail");
  assert.doesNotMatch(aside.textContent, /用户编号|稳定账号ID|订单编号|ZZ20261011008842/, "order identity facts stay in the chat header");
  assert.doesNotMatch(aside.textContent, /买家合计|号主合计|平台贡献/, "the settlement split stays on the order page");
  assert.doesNotMatch(aside.textContent, /区服|计划租期|实付金额/, "no cover, server, planned period or payment amount is invented");
  assert.equal(aside.querySelector('[data-action="order-open-inventory"]').getAttribute("href"), "/orders/order-8842", "the full list links the existing order detail page");
  assert.ok(aside.querySelector('[data-action="open-fulfillment-panel"]'), "the limited fulfillment action stays in the rail");
  assert.doesNotMatch(aside.textContent, /待核对期初|未开租/, "the rail does not repeat the stage facts shown above the chat");
});

test("admin custom conversation opens the platform message menu on a row", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector(".im-wb-msg"), "chat rendered");
  const buyer = [...node.querySelectorAll(".im-wb-msg")].find((row) => row.textContent.includes("付款后从哪里交接"));
  await act(async () => buyer.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 160, clientY: 160 })));
  await until(() => document.querySelector('.message-action-menu[role="menu"]'), "buyer menu");
  const buyerItems = [...document.querySelectorAll('.message-action-menu [role="menuitem"]')].map((item) => item.textContent.trim());
  assert.ok(buyerItems.includes("复制"), "text message offers copy");
  assert.ok(buyerItems.includes("回复"), "sendable group offers reply");
  assert.ok(buyerItems.includes("删除"), "any visible message offers local delete");
  assert.ok(!buyerItems.includes("撤回"), "another member's message cannot be revoked");
  await act(async () => document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await until(() => !document.querySelector('.message-action-menu[role="menu"]'), "menu closed");

  const staff = [...node.querySelectorAll(".im-wb-msg")].find((row) => row.textContent.includes("我来协助本次交接"));
  await act(async () => staff.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 200 })));
  await until(() => document.querySelector('.message-action-menu[role="menu"]'), "staff menu");
  const staffItems = [...document.querySelectorAll('.message-action-menu [role="menuitem"]')].map((item) => item.textContent.trim());
  assert.ok(staffItems.includes("撤回"), "the operator can revoke their own message");
});

test("unknown historical senders degrade neutrally instead of borrowing a name", async (t) => {
  const { node, until } = await mount(t, "unknown-sender");
  await until(() => node.textContent.includes("成员表已无此账号"), "history loaded");
  const row = [...node.querySelectorAll(".im-wb-msg")].find((item) => item.textContent.includes("成员表已无此账号"));
  assert.match(row.textContent, /未署名成员/);
  assert.doesNotMatch(row.textContent, /买家|号主|负责客服/, "an unmapped sender is never attributed to a known party");
});

test("more staff members stay counted in the header while the rail keeps only the two parties", async (t) => {
  const { node, until } = await mount(t, "multi-staff");
  await until(() => /成员 6/.test(node.querySelector(".im-wb-chat-actions")?.textContent ?? ""), "six members");
  const aside = node.querySelector("#im-order-details");
  const parties = [...aside.querySelectorAll(".im-rail-party")].map((row) => row.textContent.replace(/\s+/g, ""));
  assert.deepEqual(parties, ["买家林小林小林", "号主老陈"], "the rail names only the renter and owner");
  assert.match(node.querySelector(".im-wb-chat-title").textContent, /负责客服/, "staff roles stay in the chat header");
  assert.doesNotMatch(aside.textContent, /小李|小赵|小孙/, "staff members are not duplicated into the rail");
});

test("party confirmation binds to the same version only", async (t) => {
  const openPanel = async ({ node, until }) => {
    await click(node.querySelector('[data-action="open-fulfillment-panel"]'));
    await until(() => document.body.querySelector(".im-order-panel"), "check panel");
    return document.body.querySelector(".im-order-panel");
  };
  const closePanel = async (until) => {
    await click(document.body.querySelector('[aria-label="关闭核对面板"]'));
    await until(() => !document.body.querySelector(".im-order-panel"), "check panel closed");
  };
  const oneAck = await mount(t, "opening-one-ack");
  const first = await openPanel(oneAck);
  const parties = (root) => [...root.querySelectorAll(".im-order-parties [data-slot=item]")].map((row) => row.textContent.replace(/\s+/g, ""));
  assert.deepEqual(parties(first), ["租客待确认", "号主已确认"], "opening acks are per party on the same version");
  assert.match(first.querySelector(".im-order-parties").textContent, /客服不能代替/, "the operator is never offered a proxy confirmation");
  assert.match(first.textContent, /等待双方确认期初/);
  assert.match(first.textContent, /期初 v1/);
  await closePanel(oneAck.until);

  const stale = await mount(t, "stale-decision");
  const second = await openPanel(stale);
  assert.deepEqual(parties(second), ["租客待确认", "号主待确认"], "confirmations recorded on an older hash do not count for v3");
  assert.match(second.textContent, /有结束申请待处理/);
});

test("settlement unavailable keeps the conversation readable and never defaults to 待录入", async (t) => {
  const { node, until } = await mount(t, "settlement-unavailable");
  await until(() => node.querySelector(".im-wb-msg"), "history still loaded");
  const task = node.querySelector(".im-support-fulfillment");
  assert.match(task.textContent, /本单结算记录不可用/);
  assert.match(task.textContent, /本环境未启用结算记录/);
  assert.match(task.textContent, /不影响本单沟通/);
  assert.doesNotMatch(task.textContent, /未找到此内容|无权/, "404 never claims a permission problem");
  assert.doesNotMatch(task.textContent, /待核对期初|核对并录入期初/, "a failed read is not presented as a missing opening");
  assert.equal(task.querySelector('[role="alert"]'), null, "an unavailable surface is neutral, not a red error");
  assert.ok(byText(node, "重新读取"), "the only offered action is another read");
  assert.equal(node.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
  assert.equal(node.querySelector('[data-action="open-fulfillment-panel"]'), null, "no write panel without a readable settlement");
});

test("a forbidden settlement read still reports the missing permission", async (t) => {
  const { node, until } = await mount(t, "settlement-forbidden");
  await until(() => node.querySelector(".im-support-fulfillment"), "task card loaded");
  const task = node.querySelector(".im-support-fulfillment");
  assert.match(task.textContent, /当前账号无权查看本单结算记录/);
  assert.doesNotMatch(task.textContent, /本环境未启用结算记录/, "403 is not the unavailable-surface copy");
  assert.ok(task.querySelector('[role="alert"]'), "permission failure stays an alert");
  assert.ok(byText(node, "重新读取"), "a denied read can be retried");
  assert.equal(node.querySelectorAll(".im-support-fulfillment-lines input").length, 0);
});

test("a completed order leaves ended facts in the header stage bar instead of repeating them in the rail", async (t) => {
  const base = fixtureById("posted");
  const completed = { ...base, id: "completed-order", info: { ...base.info, orderStatus: "COMPLETED" } };
  const { node, until } = await mount(t, "completed-order", { fixture: completed });
  await until(() => node.querySelector("#im-order-details .im-rail-value"), "account value loaded");
  const aside = node.querySelector("#im-order-details");
  assert.equal(aside.querySelector(".im-support-fulfillment"), null, "no ended status card in the rail");
  assert.doesNotMatch(aside.textContent, /本单已结束|已完成|已取消|已结算/, "ended facts stay in the header stage bar");
  assert.match(aside.textContent, /哈夫币/, "account value stays available for ended orders");
  assert.match(aside.textContent, /查看完整清单/);
  assert.equal(node.querySelector('[data-action="open-fulfillment-panel"]'), null, "ended orders have no write entry");
  assert.equal(document.body.querySelector(".im-order-panel"), null, "no check panel is mounted");
  assert.match(node.querySelector(".order-team-stage").textContent, /结算完成/, "the header keeps the ended stage");
});

test("an active order keeps the existing fulfillment write entry", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector(".im-support-fulfillment"), "task card");
  assert.ok(node.querySelector('[data-action="open-fulfillment-panel"]'), "active orders keep the existing entry");
  assert.equal(node.querySelector('[data-ended="true"]'), null);
  assert.equal(node.querySelector('[data-read-state]'), null);
});

test("send-only revocation keeps history and draft but blocks new sends", async (t) => {
  const { node, until, settle } = await mount(t, "send-only");
  await until(() => node.querySelector(".im-wb-msg"), "history loaded");
  assert.match(node.textContent, /当前只可阅读/);
  assert.equal(node.querySelector("textarea"), null, "read-only replaces the composer instead of leaving a dead input");
  assert.equal(node.querySelector(".im-wb-send"), null);
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

test("the frozen inventory summary stays compact and links the existing order detail page", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector('[data-action="order-open-inventory"]'), "inventory summary");
  assert.equal(document.body.querySelector(".im-order-inventory-dialog"), null, "the rail does not mount a second full inventory view");
  const link = node.querySelector('[data-action="order-open-inventory"]');
  assert.equal(link.tagName, "A", "the full list is a link, not a local dialog");
  assert.equal(link.getAttribute("href"), "/orders/order-8842", "the link targets the existing order detail page");
  assert.match(link.textContent, /查看完整清单/);
  const aside = node.querySelector("#im-order-details");
  assert.match(aside.textContent, /冻结清单 · 2 项/);
  assert.equal(aside.querySelectorAll(".im-rail-value-item").length, 1, "only the visible resource rows are summarized");
  assert.match(aside.textContent, /装备箱/);
  assert.match(aside.textContent, /3 件/);
  assert.doesNotMatch(aside.textContent, /计价口径|按数量计价|HAFF_RATIO|FIXED_UNIT/, "the rail keeps business language");

  await act(async () => rows(node)[1].click());
  await until(() => node.querySelector(".im-wb-chat-title").textContent.includes("ZZ20261010007710"), "another order selected");
  await until(() => node.querySelector('[data-action="order-open-inventory"]')?.getAttribute("href") === "/orders/order-7710", "the link follows the selected order");
  await act(async () => rows(node)[0].click());
  await until(() => node.querySelector('[data-action="order-open-inventory"]').getAttribute("href") === "/orders/order-8842", "returning to the first order restores its link");
});

test("a long inventory stays a bounded summary instead of expanding every row", async (t) => {
  const { node, until } = await mount(t, "inventory-many");
  await until(() => node.querySelector('[data-action="order-open-inventory"]'), "inventory ready");
  const aside = node.querySelector("#im-order-details");
  assert.equal(aside.querySelectorAll(".im-rail-value-item").length, 3, "the rail caps the visible resource rows");
  assert.match(aside.textContent, /物品资源 · 24 项/);
  assert.match(aside.textContent, /另有 21 项物品资源/, "the rest stays collapsed");
  assert.match(aside.textContent, /冻结清单 · 24 项/);
  assert.doesNotMatch(aside.textContent, /合成资源项目 4/, "the fourth row is not expanded");
  assert.equal(node.querySelector('[data-action="order-open-inventory"]').getAttribute("href"), "/orders/order-8842");
});

test("the rail treats zero-quantity inventory as absent and sums only frozen quote amounts", async (t) => {
  const base = fixtureById("ready-three");
  const terms = {
    viewerParty: "STAFF", basis: "QUOTE", currency: "CNY", scale: 2, version: "quote-v1", rentalAmount: null, depositAmount: null, paidTotal: null,
    lines: [
      { itemId: "item_haff", name: "哈夫币", quantity: "10000000", unitPrice: null, amount: null, buyerUnitPrice: "1", ownerUnitPrice: "0.8", buyerAmount: "10000000", ownerAmount: "8000000", platformContribution: "2000000" },
      { itemId: "item_case", name: "装备箱", quantity: "3", unitPrice: null, amount: null, buyerUnitPrice: "6000", ownerUnitPrice: "5000", buyerAmount: "18000", ownerAmount: "15000", platformContribution: "3000" },
    ],
  };
  const fixture = {
    ...base,
    info: {
      ...base.info, terms,
      frozenInventory: [
        { itemId: "item_haff", quantity: "10000000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", name: "哈夫币" },
        { itemId: "item_case", quantity: "3", unit: "PIECE", pricingKind: "FIXED_UNIT", name: "装备箱" },
        { itemId: "item_empty", quantity: "0", unit: "PIECE", pricingKind: "FIXED_UNIT", name: "零号弹匣" },
      ],
    },
  };
  const { node, until } = await mount(t, "ready-three-zero", { fixture });
  await until(() => node.querySelector("#im-order-details .im-rail-value"), "value loaded");
  const aside = node.querySelector("#im-order-details");
  assert.match(aside.textContent, /10,000,000 哈夫币/, "havoc total comes from the frozen inventory");
  assert.match(aside.textContent, /¥100,000.00/, "havoc amount comes from the frozen quote line");
  assert.match(aside.textContent, /物品资源 · 1 项/);
  assert.match(aside.textContent, /¥180.00/, "item total is the exact sum of the frozen line amounts");
  assert.doesNotMatch(aside.textContent, /零号弹匣/, "quantity 0 is absent, not an exception");
  assert.doesNotMatch(aside.textContent, /异常/, "zero is never reported as abnormal");
  assert.match(aside.textContent, /冻结清单 · 2 项/, "the count only includes present rows");
  assert.doesNotMatch(aside.textContent, /account-8842|tenant-account|owner-account|10001|20002|30003/, "no account or user UUIDs");
  assert.doesNotMatch(aside.textContent, /复制|已复制/, "the removed copy controls do not come back");
  assert.doesNotMatch(aside.textContent, /买家合计|号主合计|平台贡献/, "no settlement split is repeated");
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

test("the admin custom conversation renders an order-stage card with both sides", async (t) => {
  const base = fixtureById("ready-three");
  const terms = {
    viewerParty: "STAFF", basis: "QUOTE", currency: "CNY", scale: 2, version: "quote-v1", rentalAmount: null, depositAmount: null, paidTotal: null,
    lines: [
      { itemId: "item_haff", name: "哈夫币", quantity: "10000000", unitPrice: null, amount: null, buyerUnitPrice: "1", ownerUnitPrice: "0.8", buyerAmount: "10000000", ownerAmount: "8000000", platformContribution: "2000000" },
      { itemId: "item_case", name: "装备箱", quantity: "3", unitPrice: null, amount: null, buyerUnitPrice: "6000", ownerUnitPrice: "5000", buyerAmount: "18000", ownerAmount: "15000", platformContribution: "3000" },
    ],
    staff: { buyerRentalAmount: "10018000", ownerRentalAmount: "8015000", buyerTotal: "10018000", ownerTotal: "8015000", platformContribution: "2003000" },
  };
  const fixture = {
    ...base,
    info: { ...base.info, openingState: "PARTIAL", openingAcks: { renter: true, owner: false }, terms },
    history: [...base.history, {
      messageClientId: "m-card", messageServerId: "srv-card", senderId: "tenant-account", receiverId: "team-8842",
      createTime: Date.parse("2026-10-11T01:34:00Z"), messageType: 0, text: "",
      card: { kind: "ORDER_OPENING", orderId: "order-8842", cardId: "card-1" },
    }],
  };
  const { node, until } = await mount(t, "ready-three-card", { fixture });
  await until(() => node.querySelector(".im-wb-msg .order-card"), "stage card rendered");
  const card = node.querySelector(".im-wb-msg .order-card");
  assert.equal(card.getAttribute("data-kind"), "ORDER_OPENING", "the shared card keeps its kind");
  assert.equal(card.getAttribute("data-party"), "STAFF", "the admin workbench reads the staff projection");
  assert.match(card.textContent, /账号信息与开租确认/);
  assert.match(card.textContent, /买家 已确认/, "both party chips are shown");
  assert.match(card.textContent, /号主 待确认/);
  const figures = Object.fromEntries([...card.querySelectorAll(".order-card-figure")]
    .map(figure => [figure.querySelector("dt").textContent, figure.querySelector("dd").textContent]));
  assert.deepEqual(figures, { 买家合计: "¥100,180.00", 号主合计: "¥80,150.00" }, "staff sees both sides");
  assert.equal(card.querySelector(".order-card-platform strong").textContent, "¥20,030.00", "staff sees the platform contribution");
  assert.equal(card.closest(".im-wb-bub"), null, "the card replaces the text bubble instead of nesting inside it");
  assert.equal(card.closest(".im-wb-msg-body").getAttribute("data-card"), "true", "the message body is widened for the card");

  const row = card.closest("[data-message-id]");
  assert.ok(row, "the card stays a message row");
  await act(async () => row.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 160, clientY: 180 })));
  await until(() => document.querySelector('.message-action-menu[role="menu"]'), "card menu");
  const labels = [...document.querySelectorAll('.message-action-menu [role="menuitem"]')].map((item) => item.textContent.trim());
  assert.ok(labels.includes("删除"), "delete stays available on a card row");
  assert.ok(labels.includes("回复"), "reply is still offered");
  await act(async () => document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await until(() => !document.querySelector(".message-action-menu"), "menu closed");
});

test("quoted replies are visible on the admin side and revoked messages stay explicit", async (t) => {
  const base = fixtureById("ready-three");
  const fixture = {
    ...base,
    history: [...base.history,
      { messageClientId: "m-quote", messageServerId: "srv-quote", senderId: "viewer", receiverId: "team-8842",
        createTime: Date.parse("2026-10-11T01:40:00Z"), messageType: 0, text: "123",
        reply: { messageId: "srv-1", senderId: "tenant-account", text: "你好，付款后从哪里交接？" } },
      { messageClientId: "m-revoked", messageServerId: "srv-revoked", senderId: "viewer", receiverId: "team-8842",
        createTime: Date.parse("2026-10-11T01:41:00Z"), messageType: 0, text: "", revoked: true },
    ],
  };
  const { node, until } = await mount(t, "ready-three", { fixture });
  await until(() => node.querySelector(".im-wb-bub .message-quoted"), "quoted reply rendered");
  const quote = node.querySelector(".im-wb-bub .message-quoted");
  assert.match(quote.textContent, /小林：你好，付款后从哪里交接？/);
  await act(async () => quote.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 360, clientY: 260 })));
  await until(() => browser.document.querySelector('.message-action-menu [data-action="jump"]'), "quote jump menu");
  await act(async () => browser.document.querySelector('.message-action-menu [data-action="jump"]').click());
  await until(() => node.querySelector(".message-quote-target"), "jumped message highlighted");
  const revoked = node.querySelector('.im-wb-bub[data-revoked="true"]');
  assert.ok(revoked, "revoked message keeps an explicit state");
  assert.match(revoked.textContent, /消息已撤回/);
  assert.equal(revoked.closest(".im-wb-msg").querySelector(".im-wb-msg-status"), null, "a revoked message does not claim 已发送");
});
