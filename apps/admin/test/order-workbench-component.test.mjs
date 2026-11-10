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
Object.defineProperty(browser.navigator, "locks", { configurable: true, value: { request: async (_name, _options, callback) => callback({}) } });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
const { createRoot } = await import("react-dom/client");
const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({ configFile: false, root: adminRoot, plugins: [react()], resolve: { alias: { "@": path.join(adminRoot, "src") } }, server: { middlewareMode: true, hmr: false } });
const { OrderWorkbenchPane } = await vite.ssrLoadModule("/src/views/im-support-orders.tsx");
const { useOrderGroupCloudPins } = await vite.ssrLoadModule("/src/views/im-support-group-settings.tsx");
const { createFixtureDeps, fixtureById } = await vite.ssrLoadModule("/test/fixtures/order-workbench-fixtures.ts");

const timers = new Map();
let timerId = 0;
const realFetch = globalThis.fetch;
after(async () => { await vite.close(); });
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { if (ms === 5000) { timers.set(++timerId, fn); return timerId; } return realSetInterval(fn, ms); };
globalThis.clearInterval = (id) => { if (!timers.has(id)) realClearInterval(id); };

async function mount(t, caseId, { select = true, fixture, request, props } = {}) {
  const item = fixture ?? fixtureById(caseId);
  const deps = createFixtureDeps(item);
  const requestFn = request ? request(deps.request) : deps.request;
  globalThis.fetch = deps.fetchStub;
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const paneProps = {
    identity: `fixture:${caseId}`, adminUserId: "admin-fixture", operatorName: "小周",
    client: deps.client, connection: "CONNECTED", active: true, sendAllowed: true, request: requestFn, onAuthError: () => undefined,
    ...props,
  };
  await act(async () => {
    root.render(createElement(OrderWorkbenchPane, paneProps));
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
  return { node, root, deps, item, settle, until, props: paneProps };
}
const rows = (node) => [...node.querySelectorAll(".im-wb-queue .im-wb-row")];
const messageRows = (node) => [...node.querySelectorAll(".order-team-messages li[data-message-id]")];
const click = async (button) => { assert.ok(button, "control available"); await act(async () => button.click()); };
const byText = (node, text) => [...node.querySelectorAll("button")].find((button) => button.textContent.includes(text));
const openGroupSettings = async (node, until) => {
  await until(() => node.querySelector(".order-team-conversation"), "chat rendered");
  await click(node.querySelector('[data-action="open-group-settings"]'));
  await until(() => document.querySelector('[data-settings-drawer="true"]'), "group settings drawer");
  return [...document.querySelectorAll('[data-settings-drawer="true"]')].at(-1);
};

test("the order list marks an automatic stage-card review without opening any write path", async (t) => {
  const base = fixtureById("ready-three");
  const fixture = { ...base, info: { ...base.info, stageCards: [{ kind: "ORDER_OPENING", kindLabel: "开租确认", state: "UNKNOWN" }] } };
  const { node, until } = await mount(t, "stage-card-unknown", { fixture, select: false });
  await until(() => rows(node).length === 3, "three loaded groups");
  const marked = node.querySelector('.im-wb-queue .im-wb-row[data-order-id="order-8842"]');
  assert.match(marked.textContent, /自动卡待核对/);
  const other = node.querySelector('.im-wb-queue .im-wb-row[data-order-id="order-7710"]');
  assert.doesNotMatch(other.textContent, /自动卡待核对/, "only the order with an UNKNOWN card is marked");
});

test("READY group list, role-attributed chat and the complementary order rail come from the loaded projections", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => rows(node).length === 3, "three loaded groups");
  assert.match(rows(node)[0].textContent, /ZZ20261011008842/, "full display number stays addressable, never a guessed tail");
  assert.doesNotMatch(rows(node)[0].textContent, /满配六套 · 资源账号/, "the order-group list title is the order number only");
  assert.match(rows(node)[0].textContent, /暂无消息/, "the list keeps a quiet latest-message fallback");
  assert.match(rows(node)[0].textContent, /订单群已就绪/);
  assert.match(rows(node)[2].textContent, /建群待人工核查/, "teamState NEEDS_REVIEW is reported, not smoothed over");
  assert.equal(rows(node)[0].getAttribute("data-active"), "true", "the first loaded group is selected");
  assert.match(node.querySelector(".im-wb-queue-head b").textContent, /3/);

  await until(() => node.querySelector(".order-team-messages li[data-message-id]"), "chat rendered");
  const messages = [...node.querySelectorAll(".order-team-messages li[data-message-id]")];
  const buyer = messages.find((row) => row.textContent.includes("付款后从哪里交接"));
  assert.match(buyer.textContent, /小林/, "sender name comes from the member table");
  assert.match(buyer.textContent, /租客/, "party BUYER is labelled 租客");
  const staff = messages.find((row) => row.textContent.includes("我来协助本次交接"));
  assert.equal(staff.getAttribute("data-self"), "true", "the operator's own messages sit on the right");
  assert.match(staff.textContent, /负责客服/);
  assert.ok(node.querySelector(".order-team-system"), "the join notification is a system marker, not a speaker line");
  assert.equal(node.querySelectorAll(".im-wb-thumb").length, 2, "both staged opening screenshots render");

  const aside = node.querySelector("#im-order-details");
  assert.match(aside.textContent, /满配六套 · 资源账号（含安全箱）/, "the rail complements the header with the account title");
  assert.match(aside.textContent, /三角洲行动/);
  assert.match(aside.textContent, /租客小林/);
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
  assert.doesNotMatch(aside.textContent, /未确认期初|未开租/, "the rail does not repeat the stage facts shown above the chat");
});

test("admin custom conversation opens the platform message menu on a row", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector(".order-team-messages li[data-message-id]"), "chat rendered");
  const buyer = [...node.querySelectorAll(".order-team-messages li[data-message-id]")].find((row) => row.textContent.includes("付款后从哪里交接"));
  const buyerSurface = buyer.querySelector("p, .im-wb-bub, .message-media, .message-image, .order-card");
  assert.ok(buyerSurface, "the bubble is the context-menu surface");
  await act(async () => buyerSurface.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 160, clientY: 160 })));
  await until(() => document.querySelector('.message-action-menu[role="menu"]'), "buyer menu");
  const buyerItems = [...document.querySelectorAll('.message-action-menu [role="menuitem"]')].map((item) => item.textContent.trim());
  assert.ok(buyerItems.includes("复制"), "text message offers copy");
  assert.ok(buyerItems.includes("回复"), "sendable group offers reply");
  assert.ok(buyerItems.includes("删除"), "any visible message offers local delete");
  assert.ok(!buyerItems.includes("撤回"), "another member's message cannot be revoked");
  assert.ok(!buyerItems.includes("置顶会话") && !buyerItems.includes("群设置"), "in-chat menu never exposes group-level actions");
  await act(async () => document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await until(() => !document.querySelector('.message-action-menu[role="menu"]'), "menu closed");

  const staff = [...node.querySelectorAll(".order-team-messages li[data-message-id]")].find((row) => row.textContent.includes("我来协助本次交接"));
  const staffSurface = staff.querySelector("p, .im-wb-bub, .message-media, .message-image, .order-card");
  assert.ok(staffSurface, "the staff bubble is the context-menu surface");
  await act(async () => staffSurface.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 180, clientY: 200 })));
  await until(() => document.querySelector('.message-action-menu[role="menu"]'), "staff menu");
  const staffItems = [...document.querySelectorAll('.message-action-menu [role="menuitem"]')].map((item) => item.textContent.trim());
  assert.ok(staffItems.includes("撤回"), "the operator can revoke their own message");
});

test("admin composer inserts a selected group mention", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector("textarea"), "composer ready");
  const input = node.querySelector("textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, "@");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await until(() => document.querySelector(".order-team-mention-item"), "typing @ opens the mention list");
  const item = document.querySelector(".order-team-mention-item");
  const name = item.querySelector("span").textContent.trim();
  assert.ok(name, "the mention item names a member");
  await act(async () => item.click());
  assert.match(node.querySelector("textarea").value, new RegExp(`@${name} `), "the selected member replaces the @ query");
});

test("unknown historical senders degrade neutrally instead of borrowing a name", async (t) => {
  const { node, until } = await mount(t, "unknown-sender");
  await until(() => node.textContent.includes("成员表已无此账号"), "history loaded");
  const row = [...node.querySelectorAll(".order-team-messages li[data-message-id]")].find((item) => item.textContent.includes("成员表已无此账号"));
  assert.match(row.textContent, /未署名成员/);
  assert.doesNotMatch(row.textContent, /租客|号主|负责客服/, "an unmapped sender is never attributed to a known party");
});

test("more staff members stay counted in the header while the rail keeps only the two parties", async (t) => {
  const { node, until } = await mount(t, "multi-staff");
  await until(() => /成员 6/.test(node.querySelector(".im-wb-chat-actions")?.textContent ?? ""), "six members");
  const aside = node.querySelector("#im-order-details");
  const parties = [...aside.querySelectorAll(".im-rail-party")].map((row) => row.textContent.replace(/\s+/g, ""));
  assert.deepEqual(parties, ["租客林小林小林", "号主老陈"], "the rail names only the renter and owner");
  assert.doesNotMatch(node.querySelector(".im-wb-chat-title").textContent, /共同可见|负责客服|协作客服/, "the header does not repeat a role roster as noise");
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
  assert.match(first.querySelector(".im-order-parties").textContent, /请等待双方确认/, "an operator without permission is not offered proxy confirmation");
  assert.match(first.textContent, /等待双方确认开租/);
  assert.match(first.textContent, /开租清单 v1/);
  await closePanel(oneAck.until);

  const stale = await mount(t, "stale-decision");
  const second = await openPanel(stale);
  assert.deepEqual(parties(second), ["租客待确认", "号主待确认"], "confirmations recorded on an older hash do not count for v3");
  assert.match(second.textContent, /有结束申请待处理/);
});

test("settlement unavailable keeps the conversation readable and never defaults to 待录入", async (t) => {
  const { node, until } = await mount(t, "settlement-unavailable");
  await until(() => node.querySelector(".order-team-messages li[data-message-id]"), "history still loaded");
  const task = node.querySelector(".im-support-fulfillment");
  assert.match(task.textContent, /本单结算记录不可用/);
  assert.match(task.textContent, /本环境未启用结算记录/);
  assert.match(task.textContent, /不影响本单沟通/);
  assert.doesNotMatch(task.textContent, /未找到此内容|无权/, "404 never claims a permission problem");
  assert.doesNotMatch(task.textContent, /未确认期初|核对并录入期初/, "a failed read is not presented as a missing opening");
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
  await until(() => node.querySelector(".order-team-messages li[data-message-id]"), "history loaded");
  assert.match(node.textContent, /当前只可阅读/);
  assert.equal(node.querySelector("textarea"), null, "read-only replaces the composer instead of leaving a dead input");
  assert.equal(node.querySelector(".order-team-send"), null);
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
  assert.deepEqual(inputs.map((input) => input.value), ["10", "3"], "the opening is seeded from the frozen projection");
  await click(byText(document.body, "提交开租清单"));
  assert.equal(deps.writes.length, 0, "opening waits for confirmation");
  await click(byText(document.body, "确认发起开租确认"));
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
  const scopeHint = node.querySelector('[aria-label="订单群列表范围说明"]');
  assert.ok(scopeHint, "the list scope keeps an accessible hint");
  assert.equal(scopeHint.getAttribute("title"), null, "no native browser title is used");
  assert.match(scopeHint.getAttribute("aria-label") ?? "", /订单群列表范围说明/);
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
  assert.match(node.querySelector(".order-team-text-retry").textContent, /发送结果待确认/);
  assert.equal(node.querySelector("textarea").value, "第一条", "the draft survives the unknown result");
  await click([...node.querySelectorAll(".order-team-text-retry button")].find((button) => button.textContent.includes("原消息重试")));
  await until(() => !node.querySelector(".order-team-text-retry"), "responsibility settled");
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
    staff: { buyerRentalAmount: "10018000", ownerRentalAmount: "9000000", buyerTotal: "10086000", ownerTotal: "9500000", platformContribution: "1018000" },
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
  assert.match(aside.textContent, /租客合计/);
  assert.match(aside.textContent, /¥100,860.00/, "the rail shows the renter total from the frozen staff quote");
  assert.doesNotMatch(aside.textContent, /account-8842|tenant-account|owner-account|10001|20002|30003/, "no account or user UUIDs");
  assert.doesNotMatch(aside.textContent, /复制|已复制/, "the removed copy controls do not come back");
  assert.doesNotMatch(aside.textContent, /买家合计|号主合计|平台贡献/, "no settlement split is repeated");
});

test("an image failure is scoped to the selected order", async (t) => {
  const { node, until } = await mount(t, "ready-three");
  await until(() => node.querySelector(".im-wb-thumb img"), "image ready");
  await act(async () => node.querySelector(".im-wb-thumb img").dispatchEvent(new Event("error")));
  await until(() => node.querySelector(".message-image-failed"), "image failure shown");
  await act(async () => rows(node)[1].click());
  await until(() => node.querySelector(".im-wb-chat-title").textContent.includes("ZZ20261010007710"), "another order selected");
  assert.equal(node.querySelector(".message-image-failed"), null, "a failed image from the previous order does not poison the new order");
});

test("a new identity returns the narrow workbench to its selectable list", async (t) => {
  const { node, root, deps, until } = await mount(t, "ready-three");
  await until(() => node.querySelector(".order-team-conversation"), "original chat");
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
  const copied = [];
  Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  t.after(() => { delete browser.navigator.clipboard; });
  const terms = {
    viewerParty: "STAFF", basis: "QUOTE", currency: "CNY", scale: 2, version: "quote-v1", rentalAmount: null, depositAmount: null, paidTotal: null,
    lines: [
      { itemId: "item_haff", name: "哈夫币", quantity: "10000000", unitPrice: null, amount: null, buyerUnitPrice: "1", ownerUnitPrice: "0.8", buyerAmount: "10000000", ownerAmount: "8000000", platformContribution: "2000000" },
      { itemId: "item_case", name: "装备箱", quantity: "3", unitPrice: null, amount: null, buyerUnitPrice: "6000", ownerUnitPrice: "5000", buyerAmount: "18000", ownerAmount: "15000", platformContribution: "3000" },
      { itemId: "item_zero", name: "零号弹匣", quantity: "0", unitPrice: null, amount: null, buyerUnitPrice: "7000", ownerUnitPrice: "6000", buyerAmount: "0", ownerAmount: "0", platformContribution: "0" },
      { itemId: "item_unknown_qty", name: "神秘物资", quantity: "未确认", unitPrice: null, amount: null, buyerUnitPrice: "0", ownerUnitPrice: "0", buyerAmount: "0", ownerAmount: "0", platformContribution: "0" },
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
  await until(() => node.querySelector(".order-team-messages li[data-message-id] .order-card"), "stage card rendered");
  const card = node.querySelector(".order-team-messages li[data-message-id] .order-card");
  assert.equal(card.getAttribute("data-kind"), "ORDER_OPENING", "the shared card keeps its kind");
  assert.equal(card.getAttribute("data-party"), "STAFF", "the admin workbench reads the staff projection");
  assert.equal(card.querySelector(".order-card-head .order-card-title").textContent, "开租确认", "the dark header names the stage");
  assert.ok(card.querySelector(".order-card-head .order-card-icon"), "the header keeps its document icon");
  const acks = [...card.querySelectorAll(".order-card-ack")].map(ack => [ack.querySelector(".order-card-ack-name").textContent, ack.getAttribute("data-state"), ack.querySelector(".order-card-ack-state").textContent, Boolean(ack.querySelector(".order-card-ack-mark svg"))]);
  assert.deepEqual(acks, [["租客", "confirmed", "已确认", true], ["号主", "pending", "待确认", true]], "both party steps show a meaningful mark");
  assert.match(card.querySelector(".order-card-account").textContent, /满配六套 · 资源账号（含安全箱）/);
  assert.equal(card.querySelector(".order-card-game"), null, "the game name is not repeated inside the card");
  assert.match(card.textContent, /自动确认/, "the opening card keeps the auto-confirm deadline fact");
  const infoHint = card.querySelector(".order-card-head .order-card-info");
  assert.match(infoHint?.getAttribute("aria-label") ?? "", /金额按订单冻结价展示/);
  assert.equal(infoHint?.getAttribute("title"), null, "explanatory copy does not use a native browser title");
  assert.doesNotMatch(card.textContent, /双方未确认时，将于/, "the long inline hint is not printed in the chat card");
  assert.doesNotMatch(card.textContent, /account-8842|稳定 ID/, "no account stable id is rendered");
  const figures = Object.fromEntries([...card.querySelectorAll(".order-card-figure")]
    .map(figure => [figure.querySelector("dt").textContent, figure.querySelector("dd").textContent]));
  assert.deepEqual(figures, { 租客合计: "¥100,180.00", 号主合计: "¥80,150.00" }, "staff sees both sides");
  assert.equal(card.querySelector(".order-card-platform strong").textContent, "¥20,030.00", "staff sees the platform contribution");
  const itemToggle = card.querySelector(".order-card-items-toggle");
  assert.match(itemToggle.querySelector(".order-card-row-label").textContent, /物品清单（2 项）/, "quantity 0 is not counted but an unreadable quantity stays");
  assert.equal(itemToggle.querySelector(".order-card-row-value").textContent, "租客 ¥180.00 · 号主 ¥150.00");
  await act(async () => itemToggle.click());
  assert.deepEqual([...card.querySelectorAll(".order-card-line")].map(line => line.querySelector(".order-card-line-name").textContent), ["装备箱", "神秘物资"], "only positive or unreadable items are listed");
  const unknownLine = [...card.querySelectorAll(".order-card-line")].find(line => line.textContent.includes("神秘物资"));
  assert.match(unknownLine.querySelector(".order-card-line-qty").textContent, /数量待核对/, "an unreadable quantity is never shown as 0");
  assert.doesNotMatch(card.textContent, /零号弹匣/, "quantity 0 never renders a row");
  assert.match(card.querySelector(".order-card-no").textContent, /订单 ZZ20261011008842/, "the footer carries only the order display number");
  const copy = card.querySelector('button[aria-label="复制订单号 ZZ20261011008842"]');
  assert.ok(copy, "the copy control names the order number");
  await act(async () => copy.click());
  await until(() => copied.length === 1, "order number copied");
  assert.deepEqual(copied, ["ZZ20261011008842"], "the clipboard receives the display number");
  assert.match(card.querySelector(".order-card-copy-state").textContent, /已复制/, "the copy result is announced");
  assert.equal(card.querySelector(".order-card-action").tagName, "BUTTON", "the footer action keeps the admin callback");
  assert.equal(card.closest(".im-wb-bub"), null, "the card replaces the text bubble instead of nesting inside it");
  assert.equal(card.closest(".order-team-msg-body").getAttribute("data-card"), "true", "the message body is widened for the card");

  const row = card.closest("[data-message-id]");
  assert.ok(row, "the card stays a message row");
  await act(async () => card.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 160, clientY: 180 })));
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
  await until(() => node.querySelector(".order-team-msg-body .message-quoted"), "quoted reply rendered");
  const quote = node.querySelector(".order-team-msg-body .message-quoted");
  assert.match(quote.textContent, /小林：你好，付款后从哪里交接？/);
  await act(async () => quote.dispatchEvent(new browser.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 360, clientY: 260 })));
  await until(() => browser.document.querySelector('.message-action-menu [data-action="jump"]'), "quote jump menu");
  await act(async () => browser.document.querySelector('.message-action-menu [data-action="jump"]').click());
  await until(() => node.querySelector(".message-quote-target"), "jumped message highlighted");
  const revoked = node.querySelector('.im-wb-bub[data-revoked="true"]');
  assert.ok(revoked, "revoked message keeps an explicit state");
  assert.match(revoked.textContent, /消息已撤回/);
  assert.equal(revoked.closest(".order-team-messages li[data-message-id]").querySelector(".order-team-msg-status"), null, "a revoked message does not claim 已发送");
});

test("the group settings drawer groups users and staff, marks the responsible admin and renders no identifiers", async (t) => {
  browser.localStorage.clear();
  const { node, until } = await mount(t, "multi-staff");
  await until(() => /成员 6/.test(node.querySelector(".im-wb-chat-actions")?.textContent ?? ""), "six members");
  const drawer = await openGroupSettings(node, until);
  assert.equal(drawer.getAttribute("role"), "dialog");
  assert.equal(drawer.getAttribute("data-settings-drawer"), "true");
  assert.ok(drawer.closest(".im-og-settings-dialog"), "settings render in their own dialog surface");
  assert.equal(drawer.closest("#im-order-details"), null, "settings are never layered over the live order rail");
  assert.match(drawer.textContent, /满配六套 · 资源账号/);
  assert.match(drawer.textContent, /群成员 6 · 用户 2 · 客服 4/);

  const userGroup = drawer.querySelector('[data-member-group="USER"]');
  const staffGroup = drawer.querySelector('[data-member-group="STAFF"]');
  assert.ok(userGroup, "user members have their own group");
  assert.ok(staffGroup, "staff members have their own group");
  assert.equal(userGroup.querySelectorAll(".im-og-member").length, 2);
  assert.match(userGroup.textContent, /租客/);
  assert.match(userGroup.textContent, /号主/);
  assert.match(userGroup.textContent, /只读/);
  assert.equal(staffGroup.querySelectorAll(".im-og-member").length, 4);
  assert.match(staffGroup.textContent, /负责客服/);
  assert.match(staffGroup.textContent, /协作客服/);
  assert.equal(staffGroup.querySelectorAll('[data-relation="responsible"]').length, 1, "only one responsible marker");
  assert.doesNotMatch(drawer.textContent, /10001|20002|30003|30004|30005|30006|tenant-account|owner-account|staff-b-account|staff-c-account/, "no user or account UUID reaches the drawer");
  assert.doesNotMatch(drawer.textContent, /用户编号|稳定账号ID|account-8842/, "administrative identifiers stay out of the group settings");
  assert.doesNotMatch(drawer.textContent, /我的群昵称/, "there is no my-group-nickname editor");
  assert.equal(drawer.querySelector('input[placeholder*="昵称"], input[aria-label*="昵称"]'), null);

  await act(async () => drawer.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await until(() => !node.querySelector('[data-settings-drawer="true"]'), "drawer closed");
  assert.ok(node.querySelector("#im-order-details .im-rail-value"), "the existing order rail still renders after closing settings");
});

test("admin invites use the order-scoped bounded picker and report permission, unavailable and wired success", async (t) => {
  browser.localStorage.clear();
  const targets = Array.from({ length: 12 }, (_, index) => ({ adminUserId: `admin-candidate-${index}`, displayName: `候选管理员${index}` }));
  const reads = [];
  const writes = [];
  let readMode = "denied";
  const { node, root, until, settle, props } = await mount(t, "ready-three", {
    request: (base) => async (path, body) => {
      if (path.startsWith("/orders/order-8842/member-candidates")) {
        reads.push(path);
        if (readMode === "denied") throw Object.assign(new Error("synthetic forbidden"), { status: 403 });
        if (readMode === "unavailable") throw Object.assign(new Error("synthetic unavailable"), { status: 503 });
        return { targets, limit: 50 };
      }
      if (path === "/orders/order-8842/members" && body) {
        writes.push({ path, body });
        return { status: "JOINED", members: [] };
      }
      return base(path);
    },
  });
  const drawer = await openGroupSettings(node, until);
  await click(drawer.querySelector('[data-action="open-admin-invite"]'));
  await until(() => /当前账号无权读取可邀请成员/.test(drawer.textContent), "permission is named without raw identifiers");
  assert.equal(drawer.querySelectorAll('[data-action="invite-admin-candidate"]').length, 0);
  assert.match(reads[0], /^\/orders\/order-8842\/member-candidates\?limit=50$/, "the picker uses the scoped bounded read");

  readMode = "unavailable";
  await click(drawer.querySelector('[data-action="retry-invite-candidates"]'));
  await until(() => /服务端未就绪：成员邀请暂不可用/.test(drawer.textContent), "missing endpoint is explicit");
  assert.equal(drawer.querySelectorAll('[data-action="invite-admin-candidate"]').length, 0);

  readMode = "ready";
  await click(drawer.querySelector('[data-action="retry-invite-candidates"]'));
  await until(() => drawer.querySelectorAll('[data-action="invite-admin-candidate"]').length > 0, "bounded admin candidates");
  const candidates = [...drawer.querySelectorAll('[data-action="invite-admin-candidate"]')];
  assert.equal(candidates.length, 8, "the picker never renders the whole candidate pool");
  assert.match(drawer.textContent, /可邀请现有管理员/, "any administrator can invite, not only the responsible one");
  assert.doesNotMatch(drawer.textContent, /admin-candidate-0|admin-candidate-1/, "no admin UUID is rendered");
  const target = [...drawer.querySelectorAll(".im-og-candidate")].find((item) => item.textContent.includes("候选管理员1"));
  assert.ok(target, "candidate remains selectable by name");
  await click(target.querySelector('[data-action="invite-admin-candidate"]'));
  await until(() => writes.length === 1, "invite reaches the contract path");
  assert.deepEqual(writes[0], { path: "/orders/order-8842/members", body: { adminUserId: "admin-candidate-1" } }, "the write body only carries the chosen admin id");
  await until(() => /已邀请 候选管理员1/.test(drawer.textContent), "success is shown only after the server accepts");

  const overridden = [];
  await act(async () => root.render(createElement(OrderWorkbenchPane, {
    ...props, inviteGroupMember: async (orderId, adminUserId) => { overridden.push([orderId, adminUserId]); },
  })));
  const second = [...drawer.querySelectorAll(".im-og-candidate")].find((item) => item.textContent.includes("候选管理员2"));
  await click(second.querySelector('[data-action="invite-admin-candidate"]'));
  await until(() => overridden.length === 1, "a typed callback overrides the default transport");
  assert.deepEqual(overridden[0], ["order-8842", "admin-candidate-2"]);
  assert.equal(writes.length, 1, "the overridden transport is the only writer");
  await settle();
});

test("pin, mute and local hide are per-admin preferences and hiding never leaves the group", async (t) => {
  browser.localStorage.clear();
  const { node, root, deps, until, props } = await mount(t, "ready-three");
  await until(() => rows(node).length === 3, "three loaded groups");
  await act(async () => rows(node)[1].click());
  await until(() => node.querySelector(".im-wb-chat-title")?.textContent.includes("ZZ20261010007710"), "second order selected");

  const drawer = await openGroupSettings(node, until);
  assert.match(drawer.textContent, /只隐藏本机列表/);
  await click(drawer.querySelector('[data-pref="pin"]'));
  await until(() => rows(node)[0].textContent.includes("置顶"), "pinned row moved first locally");
  await click(drawer.querySelector('[data-pref="mute"]'));
  await until(() => rows(node)[0].textContent.includes("免打扰"), "muted marker is local");

  let leaveCalls = 0;
  deps.client.leave = () => { leaveCalls += 1; return Promise.resolve(); };
  await click(drawer.querySelector('[data-pref="hide"]'));
  await until(() => rows(node).length === 2, "hidden row disappears from the local list");
  assert.equal(leaveCalls, 0, "hiding never calls NIM leave");
  assert.equal(deps.writes.length, 0, "hiding never writes to the order or settlement API");
  const stored = JSON.parse(browser.localStorage.getItem("zzsh.im-support.order-group-prefs.admin-fixture"));
  assert.deepEqual(stored["order-7710"], { pinned: true, muted: true, hidden: true }, "preferences persist under the admin user id");

  await act(async () => root.render(createElement(OrderWorkbenchPane, { ...props, adminUserId: "admin-other" })));
  await until(() => rows(node).length === 3, "another admin keeps their own unfiltered list");
  await act(async () => root.render(createElement(OrderWorkbenchPane, { ...props, adminUserId: "admin-fixture" })));
  await until(() => rows(node).length === 2, "the original admin preference is restored");
  await click(node.querySelector('[data-action="restore-hidden-order-groups"]'));
  await until(() => rows(node).length === 3, "restore only clears the local hide marker");
});

test("order-group avatars repeat the order tail in the list and the chat header", async (t) => {
  browser.localStorage.clear();
  const { node, until } = await mount(t, "ready-three");
  await until(() => rows(node).length === 3, "three loaded groups");
  const listMarks = rows(node).map((row) => row.querySelector(".im-wb-order-av"));
  assert.deepEqual(listMarks.map((mark) => mark.textContent), ["8842", "7710", "3906"], "the tail of each order number is the mark");
  assert.ok(new Set(listMarks.map((mark) => mark.dataset.tone)).size >= 2, "adjacent orders do not share one tone");
  await until(() => node.querySelector(".im-wb-chat-head .im-wb-order-av"), "chat header mark");
  const header = node.querySelector(".im-wb-chat-head .im-wb-order-av");
  assert.equal(header.textContent, listMarks[0].textContent, "the header repeats the selected row's tail");
  assert.equal(header.dataset.tone, listMarks[0].dataset.tone, "the header repeats the selected row's tone");
});

test("cloud-pinned team ids win over local pins and toggle through the cloud port", async (t) => {
  browser.localStorage.clear();
  browser.localStorage.setItem("zzsh.im-support.order-group-prefs.admin-fixture", JSON.stringify({ "order-8842": { pinned: true } }));
  const toggles = [];
  const { node, until } = await mount(t, "ready-three", {
    select: false,
    props: {
      cloudPinnedTeamIds: new Set(["team-order-7710"]),
      onToggleCloudPin: (orderId, teamId, pinned) => { toggles.push([orderId, teamId, pinned]); },
    },
  });
  await until(() => rows(node).length === 3, "three loaded groups");
  assert.match(rows(node)[0].textContent, /ZZ20261010007710/, "the cloud pin outranks the stale local pin");
  assert.match(rows(node)[0].textContent, /置顶/);
  assert.doesNotMatch(rows(node)[1].textContent, /置顶/, "a local pin is not shown while cloud pins are authoritative");

  await act(async () => rows(node)[0].click());
  const drawer = await openGroupSettings(node, until);
  assert.match(drawer.textContent, /云信账号同步，跨设备生效/);
  await click(drawer.querySelector('[data-pref="pin"]'));
  await until(() => toggles.length === 1, "the pin toggle reaches the cloud port");
  assert.deepEqual(toggles[0], ["order-7710", "team-order-7710", false]);
});

test("cloud pin hook keeps only this account's team conversations", async (t) => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let api;
  let reads = 0;
  const calls = [];
  const client = {
    accountId: "viewer",
    async getStickTopConversationIds() { reads += 1; return ["viewer|2|111", "other|2|222", "viewer|not-a-team", "viewer|2|333"]; },
    async setConversationStickTop(conversationId, pinned) { calls.push([conversationId, pinned]); },
  };
  function Probe({ client: current }) {
    api = useOrderGroupCloudPins(current);
    return createElement("output", { "data-status": api.status, "data-teams": [...api.teamIds].sort().join(","), "data-error": api.error ?? "" });
  }
  t.after(async () => { await act(async () => root.unmount()); node.remove(); });
  await act(async () => root.render(createElement(Probe, { client })));
  for (let attempt = 0; attempt < 100 && node.querySelector("output")?.dataset.status !== "CLOUD"; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  const output = node.querySelector("output");
  assert.equal(output.dataset.status, "CLOUD");
  assert.equal(output.dataset.teams, "111,333", "other accounts and malformed conversation ids are ignored");
  assert.equal(reads, 1);
  await act(async () => api.toggle("333", true));
  assert.deepEqual(calls, [["viewer|2|333", true]]);
  await act(async () => api.toggle("333", false));
  assert.deepEqual(calls.at(-1), ["viewer|2|333", false]);
  assert.equal(node.querySelector("output").dataset.teams, "111");
  client.setConversationStickTop = async () => { throw Object.assign(new Error("forbidden"), { code: 403 }); };
  await act(async () => { await api.toggle("111", true).catch(() => undefined); });
  assert.equal(node.querySelector("output").dataset.status, "LOCAL", "a forbidden cloud write falls back to local pins");
  assert.match(node.querySelector("output").dataset.error, /403/);
  assert.equal(node.querySelector("output").dataset.teams, "", "the cloud set is cleared when falling back to local");
});

test("staff preview cards are platform-support cards without user profile fields or UUIDs", async (t) => {
  browser.localStorage.clear();
  const { node, until } = await mount(t, "multi-staff");
  const drawer = await openGroupSettings(node, until);
  const userGroup = drawer.querySelector('[data-member-group="USER"]');
  const staffGroup = drawer.querySelector('[data-member-group="STAFF"]');
  assert.equal(userGroup.querySelector('[aria-label^="预览客服信息"]'), null, "user members do not get the admin card");
  const preview = staffGroup.querySelector('[aria-label="预览客服信息 小周"]');
  assert.ok(preview, "staff name/avatar exposes the shared hover-card trigger");
  assert.ok(staffGroup.querySelector('[data-slot="hover-card-trigger"]'), "the existing admin hover-card primitive is reused");

  await click(preview);
  await until(() => document.body.querySelector('[aria-label^="平台客服预览"]'), "admin card opened");
  const card = document.body.querySelector('[aria-label^="平台客服预览"]');
  assert.match(card.textContent, /小周/);
  assert.match(card.textContent, /平台客服/);
  assert.match(card.textContent, /负责客服/);
  assert.doesNotMatch(card.textContent, /会员|信用分|脱敏手机|实名状态|用户编号|风险/, "user profile facts never enter the admin card");
  assert.doesNotMatch(card.textContent, /30003|viewer|10001|20002/, "no member or account UUID is rendered");
  assert.doesNotMatch(card.textContent, /可接待|已暂停|未上线/, "presence is not invented when the projection has none");
  assert.equal(document.body.querySelector('[aria-label^="用户预览"]'), null, "the user preview card is not used for an administrator");
});

test("a cancelled order keeps the opening card as history but disables confirmation", async (t) => {
  const base = fixtureById("ready-three");
  const fixture = {
    ...base,
    info: { ...base.info, orderStatus: "CANCELLED", cancelReason: "PRESTART_TERMINATED", openingState: "DRAFT", openingAcks: { renter: false, owner: false } },
    history: [...base.history, {
      messageClientId: "m-cancelled-opening", messageServerId: "srv-cancelled-opening", senderId: "tenant-account", receiverId: "team-8842",
      createTime: Date.parse("2026-10-11T01:34:00Z"), messageType: 0, text: "",
      card: { kind: "ORDER_OPENING", orderId: "order-8842", cardId: "card-cancelled" },
    }],
  };
  const { node, until } = await mount(t, "ready-three-cancelled", { fixture });
  await until(() => node.querySelector(".order-team-messages li[data-message-id] .order-card"), "cancelled opening card rendered");
  const card = node.querySelector(".order-team-messages li[data-message-id] .order-card");
  assert.match(card.querySelector(".order-card-terminal").textContent, /订单已取消（未开租终止），开租确认已失效。/);
  const confirm = card.querySelector(".order-card-confirm .order-card-confirm-button");
  assert.ok(confirm, "the cancelled card keeps a visible confirmation control");
  assert.equal(confirm.disabled, true, "the confirmation control is visibly disabled");
  assert.equal(confirm.textContent, "确认开租");
  assert.equal(card.querySelector(".order-card-action").textContent.includes("订单详情"), true, "only the order-detail path remains");
  assert.equal(card.querySelectorAll(".order-card-ack-mark svg").length, 2, "pending marks remain visible as history");
});
