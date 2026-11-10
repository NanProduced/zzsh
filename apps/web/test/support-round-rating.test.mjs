import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4241/support" });
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

const vite = await createServer({
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/components\/session\/user-session-provider$/, replacement: path.join(webRoot, "test", "stubs", "user-session-provider.tsx") },
      { find: /^@\/components\/auth\/auth-overlay-provider$/, replacement: path.join(webRoot, "test", "stubs", "auth-overlay-provider.tsx") },
      { find: /^@\//, replacement: `${path.join(webRoot, "src")}/` },
    ],
  },
  server: { middlewareMode: true, hmr: false },
});
const { CustomerSupportWorkspace } = await vite.ssrLoadModule("/src/components/support/customer-support-workspace.tsx");
const { UserSessionProvider } = await vite.ssrLoadModule("/test/stubs/user-session-provider.tsx");
const { AuthOverlayProvider } = await vite.ssrLoadModule("/test/stubs/auth-overlay-provider.tsx");
after(async () => { await vite.close(); });

function renderWorkspace(props = {}) {
  return createElement(UserSessionProvider, null, createElement(AuthOverlayProvider, null, createElement(CustomerSupportWorkspace, {
    preview: false, embedded: true, visible: true, initialType: "SERVICE", onClose: () => {}, ...props,
  })));
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

function rowOf(overrides = {}) {
  return {
    id: "round-1", threadId: "thread-1", roundId: "round-1", roundSeq: 1, threadState: "IDLE",
    type: "SERVICE", state: "CLOSED", conversationId: "team-1", messageScopeState: "READY", canSend: true,
    assignedAdmin: null, peerAccountId: "staff-a", adminReadAt: null,
    createdAt: "2023-01-01T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00Z", ...overrides,
  };
}

async function mountSupport(t, { row, history = [], ratingMode = "success", closeMode = "success" }) {
  const originalFetch = globalThis.fetch;
  let currentRow = { ...row };
  const ratingRequests = [];
  const closeRequests = [];
  let consultationGets = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url.startsWith("/api/orders/")) return new Response(JSON.stringify({ items: [], nextCursor: null }));
    if (url.includes("/im/token")) return new Response(JSON.stringify({ appKey: "synthetic", accountId: "preview-user", token: "synthetic", transport: "local-fake" }));
    if (/\/im\/consultations\/[^/]+\/close$/.test(url)) {
      closeRequests.push({ url, method, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      if (closeMode === "failure") return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "结束咨询失败，请稍后重试。" } }), { status: 500 });
      if (closeMode === "conflict") return new Response(JSON.stringify({ error: { code: "CONFLICT", message: "本轮咨询已结束" } }), { status: 409 });
      currentRow = { ...currentRow, state: "CLOSED", threadState: "IDLE", rating: { available: true, submitted: false, dismissed: false, score: null } };
      return new Response(JSON.stringify({ consultation: currentRow }));
    }
    if (/\/im\/consultations\/[^/]+\/rating(?:\/dismiss)?$/.test(url)) {
      ratingRequests.push({ url, method, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      if (ratingMode === "failure") return new Response(JSON.stringify({ message: "synthetic failure" }), { status: 500 });
      // 服务端 409 的形状与 apps/api 一致：只有 error.message，没有 rating 字段。
      if (ratingMode === "conflict-submitted") return new Response(JSON.stringify({ error: { code: "CONFLICT", message: "本轮已评价", requestId: "synthetic" } }), { status: 409 });
      if (ratingMode === "conflict-dismissed") return new Response(JSON.stringify({ error: { code: "CONFLICT", message: "本轮评价已关闭", requestId: "synthetic" } }), { status: 409 });
      if (ratingMode === "conflict-unknown") return new Response(JSON.stringify({ error: { code: "CONFLICT", message: "Rating was not recorded", requestId: "synthetic" } }), { status: 409 });
      if (ratingMode === "conflict-rating-body") return new Response(JSON.stringify({ rating: { available: false, submitted: true, dismissed: false, score: 4 } }), { status: 409 });
      // Deliberately keep available=true: the local resolution must survive a stale poll.
      return new Response(JSON.stringify({ rating: currentRow.rating }));
    }
    if (url.includes("/im/consultations")) {
      if (method === "POST") return new Response(JSON.stringify({ consultation: currentRow }));
      consultationGets += 1;
      return new Response(JSON.stringify({ consultations: [currentRow] }));
    }
    if (url.includes("/im/message-access")) return new Response(JSON.stringify({ authorized: true }));
    if (url.includes("/im/messages")) {
      if (method === "GET") return new Response(JSON.stringify({ messages: history }));
      return new Response(JSON.stringify({ message: {} }));
    }
    throw new Error(`unexpected support fetch ${url}`);
  };
  const host = browser.document.createElement("div");
  host.className = "support-dialog-content";
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
  const render = (visible = true) => root.render(renderWorkspace({ visible }));
  await act(async () => render(true));
  const until = async (predicate, label = "condition") => {
    for (let index = 0; index < 160; index += 1) { if (predicate()) return; await settle(); }
    throw new Error(`${label} timed out`);
  };
  await until(
    () => row.state === "CLOSED" && row.rating?.available ? host.querySelector(".support-rating-card") : host.querySelector("textarea"),
    row.state === "CLOSED" && row.rating?.available ? "rating card" : "support composer",
  );
  return {
    host, root, ratingRequests, closeRequests,
    until,
    get consultationGets() { return consultationGets; },
    setRow: (patch) => { currentRow = { ...currentRow, ...patch }; },
    refresh: async () => {
      const before = consultationGets;
      await act(async () => render(false));
      await act(async () => render(true));
      await until(() => consultationGets > before, "consultation refresh");
    },
    click: async (element) => { await act(async () => element.click()); },
  };
}

function selfHistory(createTime, overrides = {}) {
  return [{
    messageClientId: "self-1", messageServerId: "srv-self-1", conversationId: "team-1",
    senderId: "preview-user", receiverId: "team-1", createTime, text: "我发的问题", messageType: 0, ...overrides,
  }];
}

test("an ended round never adds a system notice; the rating card is the only end signal", async (t) => {
  const waiting = await mountSupport(t, { row: rowOf({ state: "WAITING", threadState: "WAITING" }) });
  await waiting.until(() => waiting.host.querySelector("textarea"), "WAITING chat");
  assert.equal(Boolean(waiting.host.querySelector(".support-system-notice")), false, "waiting has no duplicate notice");

  const active = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", assignedAdmin: { id: "staff-a", name: "客服甲" } }) });
  await active.until(() => active.host.querySelector("textarea"), "ACTIVE chat");
  assert.equal(Boolean(active.host.querySelector(".support-system-notice")), false, "active has no join notice");

  const ended = await mountSupport(t, {
    row: rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } }),
    history: selfHistory(1_700_000_000_000),
  });
  await ended.until(() => ended.host.querySelector(".support-rating-card"), "closed rating card");
  assert.equal(Boolean(ended.host.querySelector(".support-system-notice")), false, "no ended notice competes with the rating");
  assert.doesNotMatch(ended.host.textContent, /本轮已结束，聊天记录保留|继续咨询/, "the dev-flavoured explanation is gone");
  const composer = ended.host.querySelector("textarea");
  assert.ok(composer, "a closed round keeps the normal composer");
  assert.equal(composer.disabled, false, "the user can type directly after the round ends");
  assert.equal(Boolean(ended.host.querySelector('[data-action="continue-consultation"]')), false, "no continue CTA");

  const closedEmpty = await mountSupport(t, { row: rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } }) });
  await closedEmpty.until(() => closedEmpty.host.querySelector(".support-rating-card"), "closed empty rating card");
  assert.equal(Boolean(closedEmpty.host.querySelector(".support-message-empty")), false, "the rating card replaces the empty-state explanation");
  assert.equal(Boolean(closedEmpty.host.querySelector(".support-system-notice")), false);
});

test("a bot-only round shows the bot message without a system notice", async (t) => {
  const createdAt = "2026-10-29T00:00:00.000Z";
  const botWelcome = (senderId) => [{
    messageClientId: `bot-${senderId}`, messageServerId: `srv-bot-${senderId}`, conversationId: "team-1",
    senderId, receiverId: "preview-user", createTime: Date.parse(createdAt) + 5_000,
    text: "您好，欢迎咨询洲洲商行，客服稍后接入。", messageType: 0,
  }];
  const active = await mountSupport(t, {
    row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", createdAt, assignedAdmin: { id: "staff-a", name: "客服甲" } }),
    history: botWelcome("platform-bot"),
  });
  await active.until(() => active.host.querySelector('.support-message[data-from="agent"]'), "bot bubble");
  assert.equal(Boolean(active.host.querySelector(".support-system-notice")), false, "the bot message speaks for itself");
  const waiting = await mountSupport(t, {
    row: rowOf({ state: "WAITING", threadState: "WAITING", createdAt }),
    history: botWelcome("platform-bot"),
  });
  await waiting.until(() => waiting.host.querySelector('.support-message[data-from="agent"]'), "waiting bot bubble");
  assert.equal(Boolean(waiting.host.querySelector(".support-system-notice")), false, "waiting never adds a second welcome");
});

test("join and welcome notices are removed once the current round has messages", async (t) => {
  const createdAt = "2026-10-29T00:00:00.000Z";
  const active = await mountSupport(t, {
    row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", createdAt, assignedAdmin: { id: "staff-a", name: "客服甲" } }),
    history: [{
      messageClientId: "agent-1", messageServerId: "srv-agent-1", conversationId: "team-1",
      senderId: "staff-a", receiverId: "preview-user", createTime: Date.parse(createdAt) + 60_000,
      text: "你好", messageType: 0,
    }],
  });
  await active.until(() => active.host.querySelector('.support-message[data-from="agent"]'), "agent reply");
  assert.equal(Boolean(active.host.querySelector(".support-system-notice")), false, "the join notice never appears");

  const waiting = await mountSupport(t, {
    row: rowOf({ state: "WAITING", threadState: "WAITING", createdAt }),
    history: selfHistory(Date.parse(createdAt) + 60_000),
  });
  await waiting.until(() => waiting.host.querySelector('.support-message[data-self="true"]'), "waiting self message");
  assert.equal(Boolean(waiting.host.querySelector(".support-system-notice")), false, "no welcome notice trails the user's message");
  assert.equal(Boolean(waiting.host.querySelector(".support-waiting-note")), false, "the waiting note stays removed");
});

test("outgoing read state only follows a real adminReadAt", async (t) => {
  const createTime = 1_700_000_100_000;
  const read = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", adminReadAt: new Date(createTime).toISOString() }), history: selfHistory(createTime) });
  await read.until(() => read.host.querySelector(".support-message-status"), "read status");
  assert.equal(read.host.querySelector(".support-message-status").textContent, "已读");
  assert.equal(read.host.querySelector(".support-message-status").getAttribute("data-read"), "read");

  const afterRead = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", adminReadAt: new Date(createTime - 1_000).toISOString() }), history: selfHistory(createTime) });
  await afterRead.until(() => afterRead.host.querySelector(".support-message-status"), "sent status");
  assert.equal(afterRead.host.querySelector(".support-message-status").textContent, "未读");
  assert.equal(afterRead.host.querySelector(".support-message-status").getAttribute("data-read"), "sent");

  const never = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", adminReadAt: null }), history: selfHistory(createTime) });
  await never.until(() => never.host.querySelector(".support-message-status"), "unknown read status");
  assert.equal(never.host.querySelector(".support-message-status").textContent, "未读", "message presence never implies read");
  assert.doesNotMatch(never.host.textContent, /已读/);

  const mixed = await mountSupport(t, {
    row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", adminReadAt: new Date(createTime + 1_000).toISOString() }),
    history: [
      ...selfHistory(createTime, { messageClientId: "self-old", messageServerId: "srv-self-old" }),
      ...selfHistory(createTime + 2_000, { messageClientId: "self-new", messageServerId: "srv-self-new", text: "稍后补发的问题" }),
    ],
  });
  await mixed.until(() => mixed.host.querySelectorAll(".support-message-status").length === 2, "every self message carries a read state");
  assert.deepEqual([...mixed.host.querySelectorAll(".support-message-status")].map((node) => node.textContent), ["已读", "未读"], "read watermark splits older and newer self messages");
  assert.equal(mixed.host.querySelectorAll('.support-message[data-self="true"]').length, 2, "both self messages render");

  const refreshed = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", adminReadAt: null }), history: selfHistory(createTime) });
  await refreshed.until(() => refreshed.host.querySelector(".support-message-status")?.textContent === "未读", "initial unread state");
  refreshed.setRow({ adminReadAt: new Date(createTime).toISOString() });
  await refreshed.refresh();
  await refreshed.until(() => refreshed.host.querySelector(".support-message-status")?.textContent === "已读", "read state after consultation refresh");
});

test("read state is scoped to the current round, not the persistent thread history", async (t) => {
  const previousMessageTime = 1_700_000_000_000;
  const roundStartTime = previousMessageTime + 5_000;
  const currentMessageTime = previousMessageTime + 10_000;
  const adminReadAt = new Date(currentMessageTime).toISOString();
  const previousRound = await mountSupport(t, {
    row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", createdAt: new Date(roundStartTime).toISOString(), adminReadAt }),
    history: selfHistory(previousMessageTime),
  });
  await previousRound.until(() => previousRound.host.querySelector('.support-message[data-self="true"]'), "previous round message");
  assert.equal(Boolean(previousRound.host.querySelector(".support-message-status")), false, "a message sent before this round started carries no current-round read claim");

  const currentRound = await mountSupport(t, {
    row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", createdAt: new Date(roundStartTime).toISOString(), adminReadAt }),
    history: [
      ...selfHistory(previousMessageTime, { messageClientId: "self-prev", messageServerId: "srv-self-prev" }),
      ...selfHistory(currentMessageTime, { messageClientId: "self-current", messageServerId: "srv-self-current", text: "本轮的问题" }),
    ],
  });
  await currentRound.until(() => currentRound.host.querySelector(".support-message-status"), "current round status");
  assert.equal(currentRound.host.querySelector(".support-message-status").textContent, "已读", "the latest self message inside the round and adminReadAt is read");

  const noRoundStart = await mountSupport(t, {
    row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", createdAt: undefined, adminReadAt: new Date(previousMessageTime).toISOString() }),
    history: selfHistory(previousMessageTime),
  });
  await noRoundStart.until(() => noRoundStart.host.querySelector('.support-message[data-self="true"]'), "missing round start message");
  assert.equal(Boolean(noRoundStart.host.querySelector(".support-message-status")), false, "without a valid round start no message claims a read state");
});

test("rating card only appears on a closed, available round with five labelled levels", async (t) => {
  const page = await mountSupport(t, { row: rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } }) });
  await page.until(() => page.host.querySelector(".support-rating-card"), "rating card");
  assert.match(page.host.querySelector(".support-rating-card").textContent, /您对本次服务满意吗？/);
  const options = [...page.host.querySelectorAll(".support-rating-option")];
  assert.deepEqual(options.map((option) => option.getAttribute("aria-label")), ["很不满", "不满意", "一般", "满意", "很满意"]);
  assert.ok(options.every((option) => option.querySelector('span[aria-hidden="true"]').textContent.trim().length > 0), "each level carries an emoji");
  assert.equal(options.map((option) => option.getAttribute("aria-pressed")).join(","), "false,false,false,false,false");
  assert.equal(page.host.querySelector(".support-rating-card textarea"), null, "the card carries no comment box");
  assert.equal(page.host.querySelector(".support-rating-actions"), null, "the card carries no submit/dismiss button row");
  const close = page.host.querySelector(".support-rating-close");
  assert.equal(close.getAttribute("aria-label"), "不评价");
  assert.equal(close.getAttribute("title"), "不评价");
  assert.equal(page.host.querySelector(".support-rating-card").getAttribute("aria-busy"), "false");

  const polling = await mountSupport(t, { row: rowOf({ rating: { available: false, submitted: false, dismissed: false, score: null } }) });
  assert.equal(polling.host.querySelector(".support-rating-card"), null, "unavailable round starts without a card");
  polling.setRow({ rating: { available: true, submitted: false, dismissed: false, score: null } });
  await polling.refresh();
  await polling.until(() => polling.host.querySelector(".support-rating-card"), "rating card after consultation refresh");
  polling.setRow({ rating: { available: false, submitted: true, dismissed: false, score: 5 } });
  await polling.refresh();
  await polling.until(() => polling.host.querySelector(".support-rating-card") === null, "rating card removed by refresh");
});

test("rating is hidden during WAITING/ACTIVE and when the server says unavailable", async (t) => {
  for (const [label, row] of [
    ["WAITING", rowOf({ state: "WAITING", threadState: "WAITING", rating: { available: true, submitted: false, dismissed: false, score: null } })],
    ["ACTIVE", rowOf({ state: "ACTIVE", threadState: "ACTIVE", rating: { available: true, submitted: false, dismissed: false, score: null } })],
    ["unavailable", rowOf({ rating: { available: false, submitted: true, dismissed: false, score: 5 } })],
  ]) {
    const page = await mountSupport(t, { row });
    await page.until(() => page.host.querySelector(".support-message-viewport, textarea"), `${label} workspace`);
    assert.equal(Boolean(page.host.querySelector(".support-rating-card")), false, `${label} never shows the rating card`);
  }
});

test("tapping an emoji posts the exact rating path and body, then shows thanks and stays gone", async (t) => {
  const page = await mountSupport(t, { row: rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } }) });
  await page.until(() => page.host.querySelector(".support-rating-card"), "rating card");
  await page.click(page.host.querySelectorAll(".support-rating-option")[3]);
  await page.until(() => page.ratingRequests.length === 1, "rating POST");
  assert.equal(page.ratingRequests[0].url, "/api/im/consultations/round-1/rating");
  assert.equal(page.ratingRequests[0].method, "POST");
  assert.deepEqual(page.ratingRequests[0].body, { score: 4 }, "the emoji alone submits the score");
  await page.until(() => page.host.querySelector(".support-rating-card") === null, "card removed");
  assert.match(page.host.querySelector(".support-rating-thanks").textContent, /感谢您的评价/);
  assert.doesNotMatch(page.host.textContent, /您对本次服务满意吗？/);
  await page.refresh();
  assert.equal(page.host.querySelector(".support-rating-card"), null, "a stale available=true poll cannot re-open the card");
  assert.match(page.host.querySelector(".support-rating-thanks").textContent, /感谢您的评价/);
});

test("a failed rating keeps the card and the chosen level with an inline error", async (t) => {
  const page = await mountSupport(t, { row: rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } }), ratingMode: "failure" });
  await page.until(() => page.host.querySelector(".support-rating-card"), "rating card");
  await page.click(page.host.querySelectorAll(".support-rating-option")[2]);
  await page.until(() => page.host.querySelector(".support-rating-error"), "inline rating error");
  assert.match(page.host.querySelector(".support-rating-error").textContent, /评价提交失败/);
  assert.ok(page.host.querySelector(".support-rating-card"), "failure keeps the card");
  assert.equal(page.host.querySelectorAll(".support-rating-option")[2].getAttribute("aria-pressed"), "true", "failure keeps the score");
  assert.equal(page.host.querySelector(".support-rating-thanks"), null);
});

test("a 409 with an existing rating resolves the card instead of reporting failure", async (t) => {
  const availableRow = () => rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } });

  const alreadySubmitted = await mountSupport(t, { row: availableRow(), ratingMode: "conflict-submitted" });
  await alreadySubmitted.until(() => alreadySubmitted.host.querySelector(".support-rating-card"), "rating card");
  await alreadySubmitted.click(alreadySubmitted.host.querySelectorAll(".support-rating-option")[4]);
  await alreadySubmitted.until(() => alreadySubmitted.host.querySelector(".support-rating-card") === null, "409 submit card removed");
  assert.match(alreadySubmitted.host.querySelector(".support-rating-thanks").textContent, /感谢您的评价/, "a timed-out retry of an accepted rating is not a failure");
  assert.equal(alreadySubmitted.host.querySelector(".support-rating-error"), null, "no failure copy for a proven submitted rating");

  const alreadyDismissed = await mountSupport(t, { row: availableRow(), ratingMode: "conflict-dismissed" });
  await alreadyDismissed.until(() => alreadyDismissed.host.querySelector(".support-rating-card"), "rating card");
  await alreadyDismissed.click(alreadyDismissed.host.querySelectorAll(".support-rating-option")[2]);
  await alreadyDismissed.until(() => alreadyDismissed.host.querySelector(".support-rating-card") === null, "409 dismissed card removed");
  assert.equal(alreadyDismissed.host.querySelector(".support-rating-error"), null, "a closed round is not reported as a submit failure");
  assert.equal(alreadyDismissed.host.querySelector(".support-rating-thanks"), null, "dismissed must not claim a submitted rating");

  const dismissAfterSubmit = await mountSupport(t, { row: availableRow(), ratingMode: "conflict-submitted" });
  await dismissAfterSubmit.until(() => dismissAfterSubmit.host.querySelector(".support-rating-card"), "rating card");
  await dismissAfterSubmit.click(dismissAfterSubmit.host.querySelector(".support-rating-close"));
  await dismissAfterSubmit.until(() => dismissAfterSubmit.host.querySelector(".support-rating-card") === null, "409 dismiss card removed");
  assert.match(dismissAfterSubmit.host.querySelector(".support-rating-thanks").textContent, /感谢您的评价/, "an already submitted round resolves the dismiss as submitted");

  const ratingBody = await mountSupport(t, { row: availableRow(), ratingMode: "conflict-rating-body" });
  await ratingBody.until(() => ratingBody.host.querySelector(".support-rating-card"), "rating card");
  await ratingBody.click(ratingBody.host.querySelectorAll(".support-rating-option")[3]);
  await ratingBody.until(() => ratingBody.host.querySelector(".support-rating-card") === null, "409 rating body card removed");
  assert.match(ratingBody.host.querySelector(".support-rating-thanks").textContent, /感谢您的评价/, "a 409 carrying rating facts resolves from the body");

  const unparseable = await mountSupport(t, { row: availableRow(), ratingMode: "conflict-unknown" });
  await unparseable.until(() => unparseable.host.querySelector(".support-rating-card"), "rating card");
  await unparseable.click(unparseable.host.querySelectorAll(".support-rating-option")[1]);
  await unparseable.until(() => unparseable.host.querySelector(".support-rating-error"), "unknown 409 error");
  assert.match(unparseable.host.querySelector(".support-rating-error").textContent, /评价提交失败/, "an unprovable 409 keeps the existing failure copy");
  assert.ok(unparseable.host.querySelector(".support-rating-card"), "the card stays when the outcome is unknown");
});

test("closing the rating posts the dismiss path, hides the card and stays gone across polls", async (t) => {
  const page = await mountSupport(t, { row: rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } }) });
  await page.until(() => page.host.querySelector(".support-rating-card"), "rating card");
  await page.click(page.host.querySelector(".support-rating-close"));
  await page.until(() => page.ratingRequests.length === 1, "dismiss POST");
  assert.equal(page.ratingRequests[0].url, "/api/im/consultations/round-1/rating/dismiss");
  assert.equal(page.ratingRequests[0].method, "POST");
  assert.equal(page.ratingRequests[0].body, null, "dismiss sends no body");
  await page.until(() => page.host.querySelector(".support-rating-card") === null, "dismissed card removed");
  assert.equal(page.host.querySelector(".support-rating-thanks"), null, "dismiss never claims a submitted rating");
  await page.refresh();
  assert.equal(page.host.querySelector(".support-rating-card"), null, "dismissed state survives a stale poll");
});

test("the user workspace never exposes group controls", async (t) => {
  const page = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE", assignedAdmin: { id: "staff-a", name: "客服甲" } }) });
  await page.until(() => page.host.querySelector(".support-message-viewport, textarea"), "active workspace");
  assert.doesNotMatch(page.host.textContent, /群成员|群设置|拉人|退群/);
  const source = readFileSync(new URL("../src/components/support/customer-support-workspace.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /群成员|群设置|拉人|退群/);
});

test("end-consultation entry appears only for an ACTIVE round", async (t) => {
  const waiting = await mountSupport(t, { row: rowOf({ state: "WAITING", threadState: "WAITING" }) });
  await waiting.until(() => waiting.host.querySelector("textarea"), "WAITING composer");
  assert.equal(waiting.host.querySelector('[data-action="end-consultation"]'), null, "waiting rounds cannot be ended by the user");

  const active = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE" }) });
  await active.until(() => active.host.querySelector('[data-action="end-consultation"]'), "ACTIVE close entry");
  assert.match(active.host.querySelector('[data-action="end-consultation"]').textContent, /结束本次咨询/);

  const closed = await mountSupport(t, { row: rowOf({ rating: { available: true, submitted: false, dismissed: false, score: null } }) });
  await closed.until(() => closed.host.querySelector(".support-rating-card"), "closed rating card");
  assert.equal(closed.host.querySelector('[data-action="end-consultation"]'), null, "ended rounds do not offer a second close");
});

test("ending an ACTIVE consultation confirms first, then refreshes into the rating card", async (t) => {
  const page = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE" }) });
  await page.until(() => page.host.querySelector('[data-action="end-consultation"]'), "close entry");
  await page.click(page.host.querySelector('[data-action="end-consultation"]'));
  await page.until(() => browser.document.querySelector('[role="alertdialog"]'), "confirm dialog");
  const dialog = browser.document.querySelector('[role="alertdialog"]');
  assert.match(dialog.textContent, /结束本次咨询/);
  assert.match(dialog.textContent, /聊天记录保留/);
  assert.match(dialog.textContent, /重新发起/);

  const cancel = [...dialog.querySelectorAll("button")].find((button) => /继续咨询/.test(button.textContent));
  assert.ok(cancel, "confirmation keeps a safe cancel action");
  await page.click(cancel);
  await page.until(() => browser.document.querySelector('[role="alertdialog"]') === null, "cancel closes the dialog");
  assert.equal(page.closeRequests.length, 0, "cancel never calls the close endpoint");

  await page.click(page.host.querySelector('[data-action="end-consultation"]'));
  await page.until(() => browser.document.querySelector('[role="alertdialog"]'), "dialog reopened");
  const confirm = [...browser.document.querySelectorAll('[role="alertdialog"] button')].find((button) => /确认结束/.test(button.textContent));
  assert.ok(confirm, "confirmation offers an explicit end action");
  await page.click(confirm);
  await page.until(() => page.closeRequests.length === 1, "close POST");
  assert.equal(page.closeRequests[0].url, "/api/im/consultations/round-1/close");
  assert.equal(page.closeRequests[0].method, "POST");
  assert.match(page.closeRequests[0].body.operationId, /^support_close_/);
  await page.until(() => page.host.querySelector(".support-rating-card"), "rating card after close");
  assert.equal(page.host.querySelector('[data-action="end-consultation"]'), null, "the closed round cannot be ended again");
});

test("a failed end-consultation keeps the round active and reports the failure", async (t) => {
  const page = await mountSupport(t, { row: rowOf({ state: "ACTIVE", threadState: "ACTIVE" }), closeMode: "failure" });
  await page.until(() => page.host.querySelector('[data-action="end-consultation"]'), "close entry");
  await page.click(page.host.querySelector('[data-action="end-consultation"]'));
  await page.until(() => browser.document.querySelector('[role="alertdialog"]'), "confirm dialog");
  const confirm = [...browser.document.querySelectorAll('[role="alertdialog"] button')].find((button) => /确认结束/.test(button.textContent));
  await page.click(confirm);
  await page.until(() => page.host.querySelector(".support-inline-error"), "close failure alert");
  assert.match(page.host.querySelector(".support-inline-error").textContent, /结束咨询失败/);
  assert.equal(browser.document.querySelector('[role="alertdialog"]'), null, "failure closes the confirmation so the alert is visible");
  assert.ok(page.host.querySelector('[data-action="end-consultation"]'), "failure keeps the active round operable");
  assert.equal(page.host.querySelector(".support-rating-card"), null, "failure never fakes a rating card");
});
