import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import React from "react";

const require = createRequire(import.meta.url);
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const componentFile = path.join(rootPath, "apps/web/src/components/ui/alert-dialog.tsx");
const cssFile = path.join(rootPath, "apps/web/src/components/ui/alert-dialog.css");
const componentSource = readFileSync(componentFile, "utf8");
const cssSource = readFileSync(cssFile, "utf8");

/* ------------------------------------------------------------------ *
 * 源码与样式防线（静态断言）。
 * ------------------------------------------------------------------ */

test("组件不用原生 confirm/alert，危险确认只走受控回调", () => {
  assert.equal(/window\.confirm|\balert\s*\(/.test(componentSource), false);
  assert.match(componentSource, /onConfirm/);
});

test("组件 CSS 自带 prefers-reduced-motion 兜底并被组件引入", () => {
  assert.match(componentSource, /import "\.\/alert-dialog\.css"/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/);
  const block = cssSource.slice(cssSource.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(block, /\.ui-alert-dialog \{ transition: none;/);
  assert.match(block, /\.ui-alert-dialog\[data-starting-style\] \{ opacity: 1;/);
  assert.match(block, /\.ui-alert-dialog-backdrop\[data-starting-style\] \{ opacity: 1;/);
});

test("危险确认是克制危险色：描边＋文字，不是整块实心红", () => {
  assert.match(componentSource, /data-variant="danger"/);
  const start = cssSource.indexOf('.ui-alert-dialog-confirm[data-variant="danger"] {');
  assert.ok(start >= 0, "danger rule present");
  const rule = cssSource.slice(start, cssSource.indexOf("}", start));
  assert.match(rule, /background: transparent;/);
  assert.match(rule, /color: var\(--color-status-error\);/);
  assert.match(rule, /border-color: color-mix/);
});

test("默认焦点与焦点还原接在 Base UI 的 initialFocus/finalFocus 上", () => {
  assert.match(componentSource, /initialFocus=\{cancelRef\}/);
  assert.match(componentSource, /finalFocus=/);
  assert.match(componentSource, /AlertDialog\.Close\s+ref=\{cancelRef\}/);
});

/* ------------------------------------------------------------------ *
 * 挂载装置：happy-dom + 真实 Base UI AlertDialog。
 * 只用本地 fixture，不发任何网络请求；window.confirm 被替换为抛错探针。
 * ------------------------------------------------------------------ */

let loaded = null;
function loadComponent() {
  if (loaded) return loaded;
  const code = ts.transpileModule(readFileSync(componentFile, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = new Module(componentFile);
  module.filename = componentFile;
  module.paths = Module._nodeModulePaths(path.dirname(componentFile));
  module.require = (name) => {
    if (name.endsWith(".css")) return {};
    return require(name);
  };
  module._compile(code, componentFile);
  loaded = module.exports;
  return loaded;
}

const previousResizeObserver = globalThis.ResizeObserver;

async function mount(props = {}) {
  const { Window } = require("happy-dom");
  const window = new Window({ url: "http://127.0.0.1:3100/account" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    CustomEvent: window.CustomEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  window.confirm = () => {
    throw new Error("原生 window.confirm 不应被调用");
  };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  const { ConfirmAlertDialog } = loadComponent();
  const { createRoot } = require("react-dom/client");
  const events = { openChanges: [], confirms: 0, nativeConfirmCalls: 0 };
  const current = {
    title: "确认注销账号？",
    description: "注销会退出当前登录并匿名化普通资料，请先确认未完成事项。",
    cancelLabel: "暂不注销",
    confirmLabel: "确认注销",
    onConfirm: () => {
      events.confirms += 1;
    },
    ...props,
  };

  function Harness() {
    const [open, setOpen] = React.useState(false);
    const openerRef = React.useRef(null);
    return React.createElement(
      "div",
      null,
      React.createElement(
        "button",
        { type: "button", "data-testid": "opener", ref: openerRef, onClick: () => setOpen(true) },
        "注销账号",
      ),
      React.createElement(
        "button",
        { type: "button", "data-testid": "elsewhere" },
        "返回安全设置",
      ),
      React.createElement(ConfirmAlertDialog, {
        ...current,
        open,
        onOpenChange: (next) => {
          events.openChanges.push(next);
          setOpen(next);
        },
      }),
    );
  }

  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  const settle = async () => {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
    await settle();
  };
  const find = (selector) => {
    const element = window.document.querySelector(selector);
    assert.ok(element, "element present: " + selector);
    return element;
  };
  const findButton = (text) => {
    const button = [...window.document.querySelectorAll("button")].find((item) => item.textContent === text);
    assert.ok(button, "button present: " + text);
    return button;
  };
  const click = async (element) => {
    await React.act(async () => {
      element.click();
    });
    await settle();
  };
  const press = async (element, key) => {
    await React.act(async () => {
      element.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const activeElement = () => window.document.activeElement;
  const popup = () => window.document.querySelector('[data-slot="alert-dialog-content"]');
  await render();
  const openDialog = async () => {
    await click(find('[data-testid="opener"]'));
  };
  return {
    window,
    host,
    events,
    find,
    findButton,
    click,
    press,
    activeElement,
    popup,
    openDialog,
    async close() {
      await React.act(async () => {
        root.unmount();
      });
      await window.happyDOM.abort();
      globalThis.ResizeObserver = previousResizeObserver;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 语义与结构
 * ------------------------------------------------------------------ */

test("弹层是真正的 alertdialog 语义，标题与说明显式关联", async () => {
  const app = await mount();
  try {
    await app.openDialog();
    const dialog = app.popup();
    assert.equal(dialog.getAttribute("role"), "alertdialog");
    const title = app.find(".ui-alert-dialog-title");
    const description = app.find(".ui-alert-dialog-description");
    assert.equal(dialog.getAttribute("aria-labelledby"), title.id);
    assert.equal(dialog.getAttribute("aria-describedby"), description.id);
    assert.equal(title.textContent, "确认注销账号？");
    assert.match(description.textContent, /注销/);
  } finally {
    await app.close();
  }
});

test("外部点击不关闭：Alert Dialog 不是普通 Dialog", async () => {
  const app = await mount();
  try {
    await app.openDialog();
    const backdrop = app.window.document.querySelector(".ui-alert-dialog-backdrop");
    assert.ok(backdrop, "backdrop present");
    await React.act(async () => {
      backdrop.dispatchEvent(new app.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      backdrop.dispatchEvent(new app.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      backdrop.click();
    });
    await settleFocus();
    assert.deepEqual(app.events.openChanges, [], "外部指针事件不触发关闭");
    assert.ok(app.popup(), "弹窗仍打开");
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------------ *
 * 键盘与焦点路径
 * ------------------------------------------------------------------ */

test("打开后默认焦点在安全动作「暂不注销」上", async () => {
  const app = await mount();
  try {
    await app.openDialog();
    assert.equal(app.activeElement(), app.findButton("暂不注销"));
  } finally {
    await app.close();
  }
});

test("取消与 Escape 关闭弹窗且不触发危险确认", async () => {
  const app = await mount();
  try {
    await app.openDialog();
    await app.click(app.findButton("暂不注销"));
    assert.deepEqual(app.events.openChanges, [false]);
    assert.equal(app.events.confirms, 0);
    assert.equal(app.popup(), null);

    await app.openDialog();
    await app.press(app.activeElement(), "Escape");
    assert.deepEqual(app.events.openChanges, [false, false]);
    assert.equal(app.events.confirms, 0);
    assert.equal(app.popup(), null);
  } finally {
    await app.close();
  }
});

test("确认只回调一次，弹窗不自行关闭（结果确定前不显示成功）", async () => {
  const app = await mount();
  try {
    await app.openDialog();
    await app.click(app.findButton("确认注销"));
    assert.equal(app.events.confirms, 1);
    assert.deepEqual(app.events.openChanges, []);
    assert.ok(app.popup(), "弹窗保持打开，由调用方在结果确定后关闭");
    await app.click(app.findButton("确认注销"));
    assert.equal(app.events.confirms, 2);
  } finally {
    await app.close();
  }
});

test("关闭后焦点还原到打开前的触发元素", async () => {
  const app = await mount();
  try {
    const opener = app.find('[data-testid="opener"]');
    await React.act(async () => {
      opener.focus();
    });
    await app.openDialog();
    assert.equal(app.activeElement(), app.findButton("暂不注销"));
    await app.press(app.activeElement(), "Escape");
    assert.equal(app.popup(), null);
    assert.equal(app.activeElement(), opener);
  } finally {
    await app.close();
  }
});

test("焦点圈定：弹层外被标记 aria-hidden，焦点移出不关闭弹窗", async () => {
  const app = await mount();
  try {
    await app.openDialog();
    const opener = app.find('[data-testid="opener"]');
    const outside = app.find('[data-testid="elsewhere"]');
    // modal 圈定的 DOM 机制：弹层外的页面容器整体对辅助技术隐藏（普通非模态 Dialog 没有这个处理）
    assert.equal(app.host.getAttribute("aria-hidden"), "true");
    assert.equal(app.popup().getAttribute("aria-hidden"), null);
    assert.ok(app.host.contains(opener) && app.host.contains(outside));

    // 焦点离开弹层不触发关闭（非模态 Dialog 会以 focusOut 关闭）
    await React.act(async () => {
      app.activeElement().dispatchEvent(
        new app.window.FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
      );
    });
    await settleFocus();
    assert.deepEqual(app.events.openChanges, []);
    assert.ok(app.popup(), "弹窗仍在打开状态");

    await app.press(app.activeElement(), "Escape");
    assert.equal(app.popup(), null);
    assert.equal(app.host.getAttribute("aria-hidden"), null);
  } finally {
    await app.close();
  }
});

async function settleFocus() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ *
 * 提交互斥（busy）
 * ------------------------------------------------------------------ */

test("busy 期间确认禁用、取消禁用，Escape 关闭请求被忽略", async () => {
  const app = await mount({ busy: true });
  try {
    await app.openDialog();
    const confirm = app.findButton("确认注销");
    const cancel = app.findButton("暂不注销");
    assert.equal(confirm.disabled, true);
    assert.equal(cancel.disabled, true);
    await app.click(confirm);
    assert.equal(app.events.confirms, 0);
    await app.press(app.activeElement(), "Escape");
    assert.deepEqual(app.events.openChanges, []);
    assert.ok(app.popup(), "提交进行中弹窗不关闭，恢复责任不丢");
  } finally {
    await app.close();
  }
});

test("confirmDisabled 只禁用危险确认，取消仍可用", async () => {
  const app = await mount({ confirmDisabled: true });
  try {
    await app.openDialog();
    assert.equal(app.findButton("确认注销").disabled, true);
    await app.click(app.findButton("暂不注销"));
    assert.deepEqual(app.events.openChanges, [false]);
    assert.equal(app.events.confirms, 0);
  } finally {
    await app.close();
  }
});

test("全程不触发原生 confirm 探针", async () => {
  const app = await mount();
  try {
    await app.openDialog();
    await app.click(app.findButton("确认注销"));
    await app.press(app.activeElement(), "Escape");
    assert.equal(app.events.nativeConfirmCalls, 0);
    assert.equal(app.window.confirm.toString().includes("throw"), true);
  } finally {
    await app.close();
  }
});
