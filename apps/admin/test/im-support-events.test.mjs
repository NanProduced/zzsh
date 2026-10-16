import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/support" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { ConsultationEventsCard } = await vite.ssrLoadModule("/src/views/im-support-events.tsx");
const { AdminApiError } = await vite.ssrLoadModule("/src/api.ts");

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function waitFor(predicate, timeout = 1_500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

function eventRow(overrides) {
  return {
    id: "event-1",
    type: "CREATED",
    occurredAt: "2026-10-16T02:30:00.000000Z",
    actor: { kind: "system", displayName: "系统" },
    from: null,
    to: null,
    ...overrides,
  };
}

test("events timeline: first page path, projected fields only, unknown type falls back to raw code", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => {
    await act(async () => { root?.unmount(); });
    await vite.close();
  });
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    return {
      events: [
        // 服务端投影不会带 details/accid；这里故意塞进去，断言渲染层不泄漏。
        eventRow({ id: "ev-1", type: "CREATED", actor: { kind: "user", displayName: "用户 甲" }, details: { internal: "内部备注-1" }, accid: "accid-user-a" }),
        eventRow({ id: "ev-2", type: "CLAIMED", occurredAt: "2026-10-16T02:31:00.000000Z", actor: { kind: "admin", displayName: "客服 甲" }, to: { displayName: "客服 甲" }, details: { internal: "内部备注-2" }, accid: "accid-admin-a" }),
        eventRow({ id: "ev-3", type: "TRANSFERRED", occurredAt: "2026-10-16T02:32:00.000000Z", actor: { kind: "admin", displayName: "客服 甲" }, from: { displayName: "客服 甲" }, to: { displayName: "客服 乙" } }),
        eventRow({ id: "ev-4", type: "SOMETHING_NEW", occurredAt: "2026-10-16T02:33:00.000000Z", actor: { kind: "system", displayName: "系统" } }),
        eventRow({ id: "ev-5", type: "UNKNOWN", occurredAt: "2026-10-16T02:34:00.000000Z", actor: { kind: "system", displayName: "系统" } }),
      ],
      nextCursor: null,
    };
  };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-a", request })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 5);

  assert.equal(calls.length, 1, "exactly one first-page request");
  assert.equal(calls[0].length, 1, "the card reads through the GET-style one-argument request channel (same as context)");
  assert.equal(calls[0][0], "/im/consultations/consultation-a/events?limit=20");

  const text = rootNode.textContent;
  assert.match(text, /发起咨询/);
  assert.match(text, /客服接入/);
  assert.match(text, /转交/);
  assert.match(text, /客服 甲 → 客服 乙/, "from → to renders for transfer events");
  assert.match(text, /未知类型/, "server-normalised UNKNOWN gets a neutral label");
  assert.match(text, /SOMETHING_NEW/, "a type outside the label table degrades to the raw code instead of crashing");
  assert.ok([...rootNode.querySelectorAll("time")].every((element) => /\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/.test(element.textContent)), "occurredAt renders localised date+time");
  assert.equal(rootNode.querySelector('.im-wb-event[data-type="SOMETHING_NEW"]') !== null, true);
  assert.doesNotMatch(text, /内部备注|accid/, "raw details and Yunxin accounts never reach the timeline");
  assert.equal(rootNode.querySelector("[data-action='load-earlier-events']"), null, "no pager without nextCursor");
});

test("events timeline: cursor pagination prepends earlier pages", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (calls.length === 1) return { events: [eventRow({ id: "ev-2", type: "CLAIMED", occurredAt: "2026-10-16T02:31:00.000000Z", actor: { kind: "admin", displayName: "客服 甲" }, to: { displayName: "客服 甲" } })], nextCursor: "cursor-abc" };
    return { events: [eventRow({ id: "ev-1", type: "CREATED", occurredAt: "2026-10-16T02:30:00.000000Z", actor: { kind: "user", displayName: "用户 甲" } })], nextCursor: null };
  };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-b", request })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 1);
  const earlier = rootNode.querySelector("[data-action='load-earlier-events']");
  assert.ok(earlier, "nextCursor offers the earlier-page button");
  await act(async () => { earlier.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 2);

  assert.equal(calls[1], "/im/consultations/consultation-b/events?limit=20&cursor=cursor-abc", "the cursor is passed through verbatim for the earlier page");
  const order = [...rootNode.querySelectorAll(".im-wb-event")].map((element) => element.getAttribute("data-type"));
  assert.deepEqual(order, ["CREATED", "CLAIMED"], "earlier pages prepend so the timeline stays ascending");
  assert.equal(rootNode.querySelector("[data-action='load-earlier-events']"), null, "pager disappears when the cursor runs out");
});

test("events timeline: a failed earlier page keeps rows and turns the pager into a retry", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  const calls = [];
  let failEarlier = true;
  const request = async (path) => {
    calls.push(path);
    if (path.includes("cursor=") && failEarlier) throw new AdminApiError(500, "INTERNAL_ERROR");
    if (!path.includes("cursor=")) return { events: [eventRow({ id: "ev-2", type: "CLAIMED", actor: { kind: "admin", displayName: "客服 甲" }, to: { displayName: "客服 甲" } })], nextCursor: "cursor-abc" };
    return { events: [eventRow({ id: "ev-1", type: "CREATED", actor: { kind: "user", displayName: "用户 甲" } })], nextCursor: null };
  };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-b2", request })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 1);
  const clickEarlier = async () => {
    const button = rootNode.querySelector("[data-action='load-earlier-events']");
    await act(async () => { button.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  };
  await clickEarlier();
  await waitFor(() => rootNode.textContent.includes("更早记录读取失败，点击重试"));
  assert.equal(rootNode.querySelectorAll(".im-wb-event").length, 1, "a failed earlier page never clears already-loaded rows");
  failEarlier = false;
  await clickEarlier();
  await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 2);
  assert.deepEqual(calls.filter((path) => path.includes("cursor=")), [
    "/im/consultations/consultation-b2/events?limit=20&cursor=cursor-abc",
    "/im/consultations/consultation-b2/events?limit=20&cursor=cursor-abc",
  ], "retry reuses the same cursor");
});

test("events timeline: 403 explains the permission refusal instead of going blank", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  const request = async () => { throw new AdminApiError(403, "FORBIDDEN"); };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-c", request })); });
  await waitFor(() => rootNode.textContent.includes("当前账号无权查看该咨询的处理记录。"));
  assert.equal(rootNode.querySelector(".im-wb-events"), null);
});

test("events timeline: 404 explains ended/missing/out-of-scope instead of going blank", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  const request = async () => { throw new AdminApiError(404, "NOT_FOUND"); };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-closed", request })); });
  await waitFor(() => rootNode.textContent.includes("处理记录不可读：该咨询已结束、不存在，或当前账号不在可查看范围。"));
  assert.equal(rootNode.querySelector(".im-wb-events"), null);
});

test("events timeline: an empty page says so and an error page offers retry", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  let attempts = 0;
  const request = async () => {
    attempts += 1;
    if (attempts === 1) throw new AdminApiError(500, "INTERNAL_ERROR");
    return { events: [], nextCursor: null };
  };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-d", request })); });
  await waitFor(() => rootNode.textContent.includes("处理记录读取失败。"));
  const retry = rootNode.querySelector("[data-action='retry-events']");
  assert.ok(retry, "error state offers an explicit retry");
  await act(async () => { retry.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await waitFor(() => rootNode.textContent.includes("该咨询暂无处理记录。"));
  assert.equal(attempts, 2);
  assert.equal(rootNode.querySelector("[data-action='load-earlier-events']"), null);
});

test("events timeline: switching consultations drops a stale in-flight response", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  let resolveA;
  const promiseA = new Promise((resolve) => { resolveA = resolve; });
  const request = (path) => {
    if (path.startsWith("/im/consultations/consultation-a/")) return promiseA;
    return Promise.resolve({ events: [eventRow({ id: "ev-b", type: "CREATED", actor: { kind: "user", displayName: "用户 乙" } })], nextCursor: null });
  };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-a", request })); });
  await settle();
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-b", request })); });
  await waitFor(() => rootNode.textContent.includes("用户 乙"), "the newly selected consultation renders its own events");
  await act(async () => {
    resolveA({ events: [eventRow({ id: "ev-a", type: "CREATED", actor: { kind: "user", displayName: "用户 甲" } })], nextCursor: null });
    await promiseA;
  });
  await settle();
  assert.doesNotMatch(rootNode.textContent, /用户 甲/, "a response for the previous consultation never paints into the new one");
  assert.equal(rootNode.querySelectorAll(".im-wb-event").length, 1);
});

// X-R1-03: 先有记录 → 下一页被拒绝。对象级 403/404 与身份 401 必须清掉旧投影
// 与游标并按首屏拒绝态显示；只有网络/5xx 保留旧页可重试。
for (const [status, snippet] of [[403, "当前账号无权查看该咨询的处理记录。"], [404, "处理记录不可读"], [401, "会话已失效"]]) {
  test(`events timeline: a denied earlier page (${status}) clears the old projection and cursor`, async (t) => {
    const rootNode = browser.document.createElement("div");
    browser.document.body.appendChild(rootNode);
    let root;
    t.after(async () => { await act(async () => { root?.unmount(); }); });
    const calls = [];
    const request = async (path) => {
      calls.push(path);
      if (path.includes("cursor=")) throw new AdminApiError(status, status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "UNAUTHORIZED");
      return { events: [eventRow({ id: "ev-first", type: "CREATED", actor: { kind: "user", displayName: "用户 甲" } })], nextCursor: "cursor-abc" };
    };

    root = createRoot(rootNode);
    await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-deny", request })); });
    await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 1);
    const button = rootNode.querySelector("[data-action='load-earlier-events']");
    assert.ok(button, "pager exists while a cursor is available");
    await act(async () => { button.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
    await waitFor(() => rootNode.textContent.includes(snippet));
    assert.equal(rootNode.querySelectorAll(".im-wb-event").length, 0, "denied page clears the old private projection");
    assert.equal(rootNode.querySelector("[data-action='load-earlier-events']"), null, "cursor is dropped with the projection");
    assert.ok(!rootNode.textContent.includes("更早记录读取失败，点击重试"), "object denial is not presented as a transient retry");
    assert.equal(calls.filter((path) => path.includes("cursor=")).length, 1, "no automatic retry of a denied page");
  });
}

test("events timeline: a 503 earlier page keeps rows and the cursor retryable (X-R1-03 control)", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  const request = async (path) => {
    if (path.includes("cursor=")) throw new AdminApiError(503, "UNAVAILABLE");
    return { events: [eventRow({ id: "ev-first", type: "CREATED", actor: { kind: "user", displayName: "用户 甲" } })], nextCursor: "cursor-abc" };
  };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-503", request })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 1);
  await act(async () => { rootNode.querySelector("[data-action='load-earlier-events']").dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await waitFor(() => rootNode.textContent.includes("更早记录读取失败，点击重试"));
  assert.equal(rootNode.querySelectorAll(".im-wb-event").length, 1, "a transient failure keeps the loaded projection");
});

test("events timeline: a stale earlier-page response never paints into a newly selected consultation", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  let root;
  t.after(async () => { await act(async () => { root?.unmount(); }); });
  let resolveEarlier;
  const earlierPromise = new Promise((resolve) => { resolveEarlier = resolve; });
  const request = (path) => {
    if (path.includes("cursor=")) return earlierPromise;
    if (path.startsWith("/im/consultations/consultation-old/")) {
      return Promise.resolve({ events: [eventRow({ id: "ev-old", type: "CREATED", actor: { kind: "user", displayName: "旧咨询用户" } })], nextCursor: "cursor-old" });
    }
    return Promise.resolve({ events: [eventRow({ id: "ev-new", type: "CREATED", actor: { kind: "user", displayName: "新咨询用户" } })], nextCursor: null });
  };

  root = createRoot(rootNode);
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-old", request })); });
  await waitFor(() => rootNode.querySelectorAll(".im-wb-event").length === 1);
  await act(async () => { rootNode.querySelector("[data-action='load-earlier-events']").dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await act(async () => { root.render(createElement(ConsultationEventsCard, { consultationId: "consultation-new", request })); });
  await waitFor(() => rootNode.textContent.includes("新咨询用户"));
  await act(async () => { resolveEarlier({ events: [eventRow({ id: "ev-stale", type: "CLOSED", actor: { kind: "admin", displayName: "迟到的旧页" } })], nextCursor: null }); await earlierPromise; });
  await settle();
  assert.doesNotMatch(rootNode.textContent, /迟到的旧页/, "a stale earlier page never writes into the new consultation");
  assert.equal(rootNode.querySelectorAll(".im-wb-event").length, 1);
});
