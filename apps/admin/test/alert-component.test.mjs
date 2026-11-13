/**
 * ADM-FEEDBACK-REUI-01 · shared feedback base.
 *
 * Covers alert roles, compatibility, dismissal focus and status messages.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement, useRef, useState } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
globalThis.MutationObserver = browser.MutationObserver;
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
const { Alert, AlertTitle, AlertDescription, AlertAction } = await vite.ssrLoadModule("/src/components/ui/alert.tsx");
const { StatusMessage } = await vite.ssrLoadModule("/src/components/ui-elements.tsx");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

function mount(element) {
  const host = browser.document.createElement("div");
  browser.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("nonurgent messages use status semantics and retain their action", () => {
  const ui = mount(createElement(
    Alert,
    { variant: "info", role: "status" },
    createElement("svg", { "data-testid": "icon", "aria-hidden": "true" }),
    createElement(AlertTitle, null, "普通说明"),
    createElement(AlertDescription, null, "非紧急进度不打断管理员。"),
    createElement(AlertAction, null, createElement("button", { type: "button" }, "查看"))
  ));
  const alert = ui.host.querySelector('[data-slot="alert"]');
  assert.equal(alert.getAttribute("role"), "status");
  assert.ok(ui.host.querySelector("svg"));
  assert.equal(ui.host.querySelector("button").textContent, "查看");
  ui.close();
});

test("no-title, no-icon calls and the legacy danger variant still render", () => {
  const ui = mount(createElement(Alert, { variant: "danger" }, createElement(AlertDescription, null, "旧调用只传说明")));
  assert.equal(ui.host.querySelector('[data-slot="alert-title"]'), null);
  assert.equal(ui.host.querySelector("svg"), null);
  assert.equal(ui.host.querySelector('[data-slot="alert"]').getAttribute("role"), "alert");
  assert.equal(ui.host.textContent, "旧调用只传说明");
  ui.close();
});

function DismissHarness({ onDismiss }) {
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(true);
  return createElement(
    "div",
    null,
    createElement("button", { ref: triggerRef, type: "button", "data-testid": "trigger" }, "重新读取"),
    open
      ? createElement(
          Alert,
          {
            variant: "info",
            role: "status",
            onDismiss: () => {
              onDismiss();
              setOpen(false);
            },
            dismissFocusRef: triggerRef,
          },
          createElement(AlertDescription, null, "结果已保留，收起只隐藏提示。")
        )
      : null
  );
}

test("dismiss hides only the notice and returns keyboard focus to the caller target", () => {
  let calls = 0;
  const ui = mount(createElement(DismissHarness, { onDismiss: () => { calls += 1; } }));
  const close = ui.host.querySelector('[data-slot="alert-dismiss"]');
  assert.equal(close.getAttribute("aria-label"), "关闭提示");
  assert.equal(close.tagName, "BUTTON", "native button is keyboard reachable");
  assert.equal(close.getAttribute("type"), "button");
  act(() => close.focus());
  act(() => close.click());
  assert.equal(calls, 1);
  assert.equal(ui.host.querySelector('[data-slot="alert"]'), null, "dismiss only controls display");
  assert.equal(browser.document.activeElement, ui.host.querySelector('[data-testid="trigger"]'), "focus returns to the trigger");
  ui.close();
});

test("alerts without onDismiss expose no close control", () => {
  const ui = mount(createElement(Alert, { variant: "success", role: "status" }, createElement(AlertDescription, null, "已保存")));
  assert.equal(ui.host.querySelector('[data-slot="alert-dismiss"]'), null);
  ui.close();
});

test("StatusMessage routes error, success and warning responsibility through the shared Alert", () => {
  const error = mount(createElement(StatusMessage, { error: "资金读取暂不可用。 请求编号：req-1" }));
  assert.equal(error.host.querySelector('[data-slot="status-message"]').getAttribute("role"), "alert");
  assert.ok(error.host.querySelector('[data-slot="status-message"]').className.includes("bg-destructive/8"));
  assert.match(error.host.textContent, /req-1/);
  error.close();

  const success = mount(createElement(StatusMessage, { success: "会话 PIN 已设置（仅当前会话）。" }));
  assert.equal(success.host.querySelector('[data-slot="status-message"]').getAttribute("role"), "status");
  assert.ok(success.host.querySelector('[data-slot="status-message"]').className.includes("bg-success/8"));
  success.close();

  const permission = mount(createElement(StatusMessage, { tone: "warning", error: "当前账号没有查看角色配置的权限。" }));
  assert.equal(permission.host.querySelector('[data-slot="status-message"]').getAttribute("role"), "alert", "blocking responsibility still interrupts");
  assert.ok(permission.host.querySelector('[data-slot="status-message"]').className.includes("bg-warning/8"));
  permission.close();
});

test("an empty error does not hide a nonempty success message", () => {
  const success = mount(createElement(StatusMessage, { error: "", success: "保存完成的真实说明" }));
  assert.match(success.host.textContent, /保存完成的真实说明/);
  assert.equal(success.host.querySelector('[data-slot="status-message"]').getAttribute("role"), "status");
  success.close();
  const error = mount(createElement(StatusMessage, { error: "读取失败", success: "旧成功说明" }));
  assert.match(error.host.textContent, /读取失败/);
  assert.doesNotMatch(error.host.textContent, /旧成功说明/);
  error.close();
  const empty = mount(createElement(StatusMessage, { error: "", success: "" }));
  assert.equal(empty.host.querySelector('[data-slot="status-message"]'), null);
  empty.close();
});
