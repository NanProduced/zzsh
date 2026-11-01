import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after, beforeEach } from "node:test";
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

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});

const { AftersaleInbox } = await vite.ssrLoadModule("/src/views/im-aftersale-inbox.tsx");

after(async () => {
  await vite.close();
});

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function type(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new browser.Event('input', { bubbles: true }));
    element.dispatchEvent(new browser.Event('change', { bubbles: true }));
  });
  await settle();
}

test("AftersaleInbox: inline discard protection guards busy flight and preserves draft", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  let resolvePostResolver = null;

  const mockRecord = {
    id: "aftersale-101",
    orderSource: "NATIVE",
    orderId: "order-101",
    orderDisplayNo: "ZZ20261101999",
    requesterParty: "RENTER",
    description: "无法登录游戏",
    state: "PENDING",
    handler: { id: "admin-1", name: "客服小李" },
    result: null,
    version: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    resolvedAt: null,
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const method = init.method ?? "GET";

    if (url.pathname.includes("/im/aftersales") && method === "GET") {
      return response({ items: [mockRecord], canSubmit: true, nextCursor: null });
    }

    if (url.pathname.includes("/im/aftersales/aftersale-101/resolve") && method === "POST") {
      return new Promise((resolve) => {
        resolvePostResolver = () => {
          resolve(
            response({
              record: {
                ...mockRecord,
                state: "RESOLVED",
                result: "已核实密码并处理",
                version: 2,
                resolvedAt: "2026-11-01T10:30:00.000Z",
              },
            })
          );
        };
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
  };

  let open = true;
  let dirtyState = false;

  await act(async () => {
    root.render(
      createElement(AftersaleInbox, {
        open,
        onOpenChange: (val) => { open = val; },
        scope: "admin-1:scope",
        adminId: "admin-1",
        canHandle: true,
        canTakeover: true,
        onContact: () => {},
        onDirtyChange: (dirty) => { dirtyState = dirty; },
      })
    );
  });
  await settle();

  // 1. Pick the record (Sheet renders into document.body portal)
  const recordBtn = browser.document.querySelector("div[aria-label='售后记录列表'] button");
  assert.ok(recordBtn, "Expected record item button");
  await act(async () => {
    recordBtn.click();
  });
  await settle();

  // 2. Type draft text into textarea
  const textarea = browser.document.querySelector("textarea");
  assert.ok(textarea, "Expected draft textarea");
  await type(textarea, "这是正在填写的处理说明");

  // Dirty state should now be true
  assert.equal(dirtyState, true);

  // 3. User attempts to switch state to "已处理" while draft is dirty
  const resolvedTabBtn = Array.from(browser.document.querySelectorAll("div[role='group'][aria-label='售后状态'] button"))
    .find((b) => b.textContent.includes("已处理"));
  assert.ok(resolvedTabBtn, "Expected '已处理' tab button");

  await act(async () => {
    resolvedTabBtn.click();
  });
  await settle();

  // Confirmation banner should appear inline
  assert.match(browser.document.body.textContent, /有未提交的处理说明，是否放弃？/);
  const discardBtn = Array.from(browser.document.querySelectorAll("button")).find((b) => b.textContent.includes("确认放弃"));
  const cancelBtn = Array.from(browser.document.querySelectorAll("button")).find((b) => b.textContent.includes("取消"));
  assert.ok(discardBtn, "Expected '确认放弃' button");
  assert.ok(cancelBtn, "Expected '取消' button");

  // 4. Now, user submits save ("保存并标记已处理"), making POST in flight
  const saveBtn = Array.from(browser.document.querySelectorAll("button")).find((b) => b.textContent.includes("保存并标记已处理"));
  assert.ok(saveBtn, "Expected '保存并标记已处理' button");

  await act(async () => {
    saveBtn.click();
  });
  await settle();

  // While in flight, resolvePostResolver has NOT resolved yet:
  assert.equal(discardBtn.disabled, true, "确认放弃 button MUST be disabled while flight/busy");
  assert.equal(saveBtn.disabled, true, "保存 button MUST be disabled while flight/busy");

  // Clicking "确认放弃" while in flight must NOT discard or close
  await act(async () => {
    discardBtn.click();
  });
  await settle();
  assert.equal(open, true, "Sheet must remain open");

  // 5. Complete in-flight post
  await act(async () => {
    if (resolvePostResolver) resolvePostResolver();
  });
  await settle();

  // After completion, notice displayed
  assert.match(browser.document.body.textContent, /已标记为已处理/);

  root.unmount();
  container.remove();
});
