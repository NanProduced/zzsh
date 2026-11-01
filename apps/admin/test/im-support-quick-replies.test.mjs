import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after, beforeEach } from "node:test";
import { Window } from "happy-dom";
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

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});

const {
  readSupportQuickReplies,
  storeSupportQuickReplies,
  SUPPORT_QUICK_REPLIES,
} = await vite.ssrLoadModule("/src/views/im-support-view.tsx");

after(async () => {
  await vite.close();
});

beforeEach(() => {
  browser.localStorage.clear();
});

test("readSupportQuickReplies: returns system defaults when localStorage is empty or uninitialized", () => {
  const replies = readSupportQuickReplies("admin-1");
  assert.equal(replies.length, SUPPORT_QUICK_REPLIES.length);
  assert.equal(replies[0].label, "首次回复");
  assert.equal(replies[0].text, SUPPORT_QUICK_REPLIES[0].text);
});

test("storeSupportQuickReplies & readSupportQuickReplies: isolate quick replies by adminUserId", () => {
  const customRepliesAdmin1 = [
    { label: "问候", text: "您好，我是客服小王，请问有什么可以帮您？" },
    { label: "催付", text: "您的订单尚未支付，请尽快完成支付以锁定商品。" },
  ];
  storeSupportQuickReplies("admin-1", customRepliesAdmin1);

  // admin-1 reads custom replies
  const read1 = readSupportQuickReplies("admin-1");
  assert.equal(read1.length, 2);
  assert.equal(read1[0].label, "问候");
  assert.equal(read1[0].text, "您好，我是客服小王，请问有什么可以帮您？");

  // admin-2 still receives system defaults, isolated from admin-1
  const read2 = readSupportQuickReplies("admin-2");
  assert.equal(read2.length, SUPPORT_QUICK_REPLIES.length);
  assert.equal(read2[0].label, "首次回复");

  // Stored key matches expected prefix
  const raw1 = browser.localStorage.getItem("zzsh-support-quick-replies:admin-1");
  assert.ok(raw1);
  const parsed1 = JSON.parse(raw1);
  assert.equal(parsed1.length, 2);

  const raw2 = browser.localStorage.getItem("zzsh-support-quick-replies:admin-2");
  assert.equal(raw2, null);
});

test("readSupportQuickReplies: gracefully falls back to defaults when stored value is invalid JSON or empty", () => {
  // Invalid JSON syntax
  browser.localStorage.setItem("zzsh-support-quick-replies:admin-corrupt", "{ not valid json ");
  const readCorrupt = readSupportQuickReplies("admin-corrupt");
  assert.equal(readCorrupt.length, SUPPORT_QUICK_REPLIES.length);

  // Empty array in storage
  browser.localStorage.setItem("zzsh-support-quick-replies:admin-empty", "[]");
  const readEmpty = readSupportQuickReplies("admin-empty");
  assert.equal(readEmpty.length, SUPPORT_QUICK_REPLIES.length);

  // Array with malformed / non-object entries
  browser.localStorage.setItem(
    "zzsh-support-quick-replies:admin-filtered",
    JSON.stringify([
      null,
      123,
      { label: "有效回复", text: "这是有效内容" },
      { label: "缺少文本" },
      { text: "缺少标签" },
    ])
  );
  const readFiltered = readSupportQuickReplies("admin-filtered");
  assert.equal(readFiltered.length, 1);
  assert.equal(readFiltered[0].label, "有效回复");
  assert.equal(readFiltered[0].text, "这是有效内容");
});

test("storeSupportQuickReplies: safely handles missing adminUserId or empty arguments", () => {
  // Should not throw or crash when adminUserId is empty
  storeSupportQuickReplies("", [{ label: "test", text: "test" }]);
  assert.equal(browser.localStorage.length, 0);
});

test("quick reply write failures reach the save handler instead of faking persistence",t=>{
  t.mock.method(browser.localStorage,"setItem",()=>{throw new browser.DOMException("quota","QuotaExceededError");});
  assert.throws(()=>storeSupportQuickReplies("admin-review",[{label:"未保存",text:"仍应保留草稿"}]),/quota/);
});
