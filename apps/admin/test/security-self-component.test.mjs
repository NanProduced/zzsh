import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4381/settings" });
browser.Element.prototype.scrollIntoView = function () {};
for (const name of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "DOMRect", "DOMException", "Storage", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"]) {
  globalThis[name] = browser[name];
}
globalThis.window = browser;
for (const name of ["navigator", "localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, name, { value: browser[name], configurable: true });
}
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const source = await createOfflineAdminSource({ root: path.resolve(adminRoot, "../..") });
const { SecuritySelfView } = await source.ssrLoadModule("/apps/admin/src/views/security-self/security-self-view.tsx");

after(async () => {
  await source.close();
  await browser.happyDOM.abort();
});

const settle = async (ms = 25) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const FIXTURE_CODES = ["AAAAA-BBBBB", "CCCCC-DDDDD", "EEEEE-FFFFF", "GGGGG-HHHHH", "IIIII-JJJJJ", "KKKKK-LLLLL"];
const SECRET_CURRENT = "Fixture-Current-0001!";
const SECRET_NEXT = "Fixture-Next-0002!";

function makeStore(seed = [], config = {}) {
  let raw = JSON.stringify(JSON.parse(JSON.stringify(seed)));
  const parse = (text) => {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return { records: [], error: true };
      return { records: parsed, error: false };
    } catch {
      return { records: [], error: true };
    }
  };
  return {
    read: () => (config.readError ? { records: [], error: true } : parse(raw)),
    update: (mutate) => {
      if (config.readError) return { ok: false, records: [], reason: "storage" };
      const current = parse(raw);
      if (current.error) return { ok: false, records: [], reason: "storage" };
      const next = mutate(current.records);
      if (next === null) return { ok: false, records: current.records, reason: "refused" };
      if (config.saveFails) return { ok: false, records: current.records, reason: "storage" };
      raw = JSON.stringify(next);
      const verified = parse(raw);
      if (verified.error) return { ok: false, records: current.records, reason: "storage" };
      return { ok: true, records: verified.records };
    },
    _data: () => parse(raw).records,
    _raw: () => raw,
    _setRaw: (text) => {
      raw = text;
    },
    _append: (record) => {
      raw = JSON.stringify([...parse(raw).records, record]);
    },
  };
}

function makeCommands(overrides = {}) {
  const calls = [];
  const run = (name, fallback) => async (input) => {
    calls.push({ name, input });
    return (overrides[name] ?? fallback)(input);
  };
  const commands = {
    changePassword: run("changePassword", async ({ commandId }) => ({
      commandId,
      receipt: { passwordChanged: true, sessionsRotated: true, revokedSessionCount: 3, newSessionId: "session-2" },
    })),
    setPin: run("setPin", async ({ commandId }) => ({ commandId, receipt: { pinConfigured: true, sessionId: "session-1" } })),
    changePin: run("changePin", async ({ commandId }) => ({ commandId, receipt: { pinChanged: true, sessionId: "session-1" } })),
    generateBackupCodes: run("generateBackupCodes", async ({ commandId }) => ({
      commandId,
      backupCodes: FIXTURE_CODES.slice(),
      receipt: {
        generated: true,
        generation: 3,
        generationId: "bcgen_fixture_3",
        generatedAt: "2026-10-14T02:00:00.000Z",
        codeCount: FIXTURE_CODES.length,
      },
    })),
    readOperation: run("readOperation", async ({ commandId }) => ({ commandId, status: "unconfirmed" })),
  };
  return { calls, commands };
}

function baseProps(overrides = {}) {
  const { calls, commands } = makeCommands(overrides.commandImpl ?? {});
  const refreshCalls = [];
  const props = {
    adminUserId: overrides.adminUserId ?? "admin-1",
    accountLabel: overrides.accountLabel ?? "ZZ00001 · 测试管理员",
    accountStatus: overrides.accountStatus ?? "ACTIVE",
    twoFactorEnabled: overrides.twoFactorEnabled === undefined ? true : overrides.twoFactorEnabled,
    session: overrides.session ?? { id: "session-1", locked: false, pinConfigured: true },
    idleMinutes: overrides.idleMinutes ?? 15,
    compact: overrides.compact ?? false,
    commands,
    refreshSession:
      overrides.refreshSession ??
      (async () => {
        refreshCalls.push(1);
        return {
          accountStatus: "ACTIVE",
          twoFactorEnabled: true,
          session: { id: "session-2", locked: false, pinConfigured: false },
        };
      }),
    onIdleMinutesChange: overrides.onIdleMinutesChange ?? (() => {}),
    onLockSession: overrides.onLockSession ?? (() => {}),
    onOpenRecovery: overrides.onOpenRecovery ?? (() => {}),
    onDirtyChange: overrides.onDirtyChange ?? (() => {}),
    store: overrides.store ?? makeStore(overrides.seed ?? []),
  };
  return { props, calls, refreshCalls };
}

async function mount(initialProps, t) {
  const el = browser.document.createElement("div");
  el.className = "workspace-root";
  browser.document.body.append(el);
  const root = createRoot(el);
  let cleaned = false;
  const render = async (props) => {
    await act(async () => {
      root.render(createElement(SecuritySelfView, props));
    });
    await settle();
  };
  await render(initialProps);
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await act(async () => root.unmount());
    el.remove();
  };
  if (t) t.after(cleanup);
  // data-closed 表示 Base UI 已进入关闭退场（happy-dom 无动画帧，节点可能延迟移除），按已关闭处理。
  const dialog = () => el.querySelector('[data-slot="dialog-content"]:not([data-closed])');
  const btn = (name) => {
    const scope = dialog() ?? el;
    return (
      [...scope.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent.trim()) === name) ??
      [...el.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent.trim()) === name)
    );
  };
  const click = async (node) => {
    assert.ok(node, "expected clickable node");
    await act(async () => {
      node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const type = async (input, value) => {
    assert.ok(input, "expected input");
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
    await act(async () => {
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
  };
  const escape = async () => {
    await act(async () => {
      browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const waitDialogGone = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (!dialog()) return;
      await settle(25);
    }
    assert.ok(!dialog(), "dialog should have closed");
  };
  return { el, render, btn, click, type, escape, dialog, waitDialogGone, cleanup };
}

const pendingRecord = (overrides = {}) => ({
  adminUserId: "admin-1",
  action: "password.change",
  commandId: "idem_seed_1",
  targetKind: "credential",
  createdAt: "2026-10-14T02:00:00.000Z",
  updatedAt: "2026-10-14T02:00:00.000Z",
  outcome: "unknown",
  dispatched: true,
  ...overrides,
});

const fillPassword = async (h) => {
  await h.click(h.btn("修改密码"));
  await h.type(h.el.querySelector("#self-current-password"), SECRET_CURRENT);
  await h.type(h.el.querySelector("#self-new-password"), SECRET_NEXT);
  await h.type(h.el.querySelector("#self-confirm-password"), SECRET_NEXT);
};

async function pickOption(doc, trigger, label) {
  await act(async () => trigger.click());
  for (let i = 0; i < 100 && !doc.querySelector('[role="option"]'); i++) await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  const option = [...doc.querySelectorAll('[role="option"]')].find(item => item.textContent.trim() === label);
  assert.ok(option, "missing option " + label);
  await act(async () => option.click());
}
test("24. preview submission guard blocks valid secrets before storage or command calls", async (t) => {
  for (const kind of ["password", "pin", "backup"]) {
    const store = makeStore();
    const { props, calls } = baseProps({ store });
    const h = await mount({ ...props, commandsUnavailableReason: "界面预览，提交禁用" }, t);
    if (kind === "password") await fillPassword(h);
    if (kind === "pin") {
      await h.click(h.btn("更改 PIN"));
      await h.type(h.el.querySelector("#self-current-pin"), "123456");
      await h.type(h.el.querySelector("#self-new-pin"), "654321");
    }
    if (kind === "backup") {
      await h.click(h.btn("重新生成备份码"));
      await h.type(h.el.querySelector("#self-backup-password"), SECRET_CURRENT);
    }
    const form = h.dialog().querySelector("form");
    assert.equal(form.querySelector('[type="submit"]').disabled, true);
    await act(async () => form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(store._data().length, 0);
    await h.cleanup();
  }
});
test("25. a successful command after unmount cannot start a session refresh", async (t) => {
  let resolveCommand;
  const delayed = new Promise(resolve => { resolveCommand = resolve; });
  const store = makeStore();
  const { props, calls, refreshCalls } = baseProps({ store, commandImpl: { changePassword: () => delayed } });
  const h = await mount(props, t);
  await fillPassword(h); await h.click(h.btn("更新登录密码"));
  const commandId = calls[0].input.commandId;
  await h.cleanup();
  await act(async () => resolveCommand({ commandId, receipt: { passwordChanged: true, sessionsRotated: true, revokedSessionCount: 1, newSessionId: "new-session" } }));
  await settle();
  assert.equal(refreshCalls.length, 0);
  assert.equal(store._data().length, 1);
});

test("1. default facts are rendered truthfully with honest status copy", async (t) => {
  const { props } = baseProps();
  const h = await mount(props, t);
  const text = h.el.textContent;
  assert.equal(h.el.querySelector("h1")?.textContent, "账号安全", "与侧栏同一账号安全分区保持一致");
  assert.ok(text.includes("账号状态：正常"));
  assert.equal(text.includes("安全状态正常"), false);
  assert.ok(text.includes("已启用"));
  assert.ok(text.includes("已配置"));
  assert.ok(text.includes("更改 PIN"));
  assert.ok(text.includes("重新生成备份码"));
  assert.ok(text.includes("闲置自动锁定"));
  assert.ok(text.includes("当前合同要求以本人当前密码发起申请"), "recovery copy must not promise a passwordless request");
  assert.equal(text.includes("剩余"), false, "backup code row must not invent a remaining count");

  let recoveryOpened = 0;
  const { props: recoveryProps } = baseProps({ onOpenRecovery: () => { recoveryOpened += 1; } });
  await h.render(recoveryProps);
  await h.click(h.btn("进入账号恢复"));
  assert.equal(recoveryOpened, 1);

  let idleSelected = null;
  const { props: idleProps } = baseProps({ onIdleMinutesChange: (value) => { idleSelected = value; } });
  await h.render(idleProps);
  const select = h.el.querySelector('[aria-label="当前浏览器闲置锁定时长"]');
  assert.ok(select);
  assert.equal(select.tagName, "BUTTON");
  await pickOption(browser.document, select, "30 分钟");
  assert.equal(idleSelected, 30);
});

test("2. unknown fields stay unknown and compact terminals hide PIN/lock entries", async (t) => {
  const { props } = baseProps({ twoFactorEnabled: null });
  const h = await mount(props, t);
  assert.ok(h.el.textContent.includes("未提供"));
  assert.equal(h.btn("重新生成备份码").disabled, true);

  await h.render({ ...props, twoFactorEnabled: true, compact: true });
  assert.equal(h.el.textContent.includes("会话快捷 PIN"), false);
  assert.equal(h.btn("立即锁定当前会话"), undefined);
  assert.ok(h.el.textContent.includes("小屏终端不提供快捷 PIN"));
  assert.ok(h.el.querySelector('[aria-label="当前浏览器闲置锁定时长"]'));
});

test("3. locked and frozen sessions cannot start security commands", async (t) => {
  const { props } = baseProps({ session: { id: "session-1", locked: true, pinConfigured: true } });
  const h = await mount(props, t);
  assert.equal(h.btn("修改密码").disabled, true);
  assert.equal(h.btn("更改 PIN").disabled, true);
  assert.equal(h.btn("立即锁定当前会话").disabled, true);

  const { props: frozen } = baseProps({ accountStatus: "FROZEN" });
  await h.render(frozen);
  assert.ok(h.el.textContent.includes("账号已冻结"));
  assert.equal(h.btn("修改密码").disabled, true);
  assert.equal(h.btn("重新生成备份码").disabled, true);
});

test("4. password dialog validates locally before touching the command endpoint", async (t) => {
  const { props, calls } = baseProps();
  const h = await mount(props, t);
  await h.click(h.btn("修改密码"));
  assert.ok(h.dialog());
  assert.ok(h.el.textContent.includes("撤销其他设备的全部旧会话"));

  await h.click(h.btn("更新登录密码"));
  assert.ok(h.el.textContent.includes("请输入当前密码。"));
  assert.ok(h.el.textContent.includes("请输入新密码。"));

  await h.type(h.el.querySelector("#self-current-password"), SECRET_CURRENT);
  await h.type(h.el.querySelector("#self-new-password"), "short");
  await h.click(h.btn("更新登录密码"));
  assert.ok(h.el.textContent.includes("新密码至少 12 位。"));

  await h.type(h.el.querySelector("#self-new-password"), SECRET_NEXT);
  await h.type(h.el.querySelector("#self-confirm-password"), "Fixture-Other-0003!");
  await h.click(h.btn("更新登录密码"));
  assert.ok(h.el.textContent.includes("两次输入的新密码不一致。"));

  await h.type(h.el.querySelector("#self-confirm-password"), SECRET_NEXT);
  await h.type(h.el.querySelector("#self-current-password"), SECRET_NEXT);
  await h.click(h.btn("更新登录密码"));
  assert.ok(h.el.textContent.includes("新密码不能与当前密码相同。"));

  assert.equal(calls.length, 0, "no command request may leave the component during validation");
});

test("5. successful password change refreshes the snapshot, wipes secrets and retires the record", async (t) => {
  const store = makeStore();
  const { props, calls, refreshCalls } = baseProps({ store });
  const h = await mount(props, t);
  await fillPassword(h);
  await h.click(h.btn("更新登录密码"));

  assert.equal(calls.length, 1);
  assert.match(calls[0].input.commandId, /^idem_/);
  assert.equal(refreshCalls.length, 1, "the snapshot must be refreshed after a password change");
  assert.ok(h.el.textContent.includes("登录密码已更新"));
  assert.equal(store._data().length, 0, "a verified password change leaves no pending record");

  await h.click(h.btn("完成"));
  await h.waitDialogGone();
  await h.click(h.btn("修改密码"));
  assert.equal(h.el.querySelector("#self-current-password").value, "", "reopened dialog must not retain secrets");
});

test("6. F1: unknown result keeps the original responsibility, clears inputs and offers no old-password retry", async (t) => {
  const store = makeStore();
  const { props, calls } = baseProps({
    store,
    commandImpl: {
      changePassword: async () => {
        throw { status: 500, code: "INTERNAL_ERROR" };
      },
    },
  });
  const h = await mount(props, t);
  await fillPassword(h);
  await h.click(h.btn("更新登录密码"));
  await settle();

  assert.equal(calls.length, 1);
  assert.ok(h.el.textContent.includes("提交后未收到明确结果"));
  assert.equal(h.el.querySelector("#self-current-password"), null, "unknown phase must clear the typed password");
  assert.equal(h.btn("重试相同请求"), undefined, "unknown phase must not offer an old-password retry");

  const [recorded] = store._data();
  assert.equal(recorded.outcome, "unknown");
  assert.equal(recorded.dispatched, true, "unknown outcome marks the command as dispatched");
  assert.equal(JSON.stringify(store._data()).includes(SECRET_CURRENT), false);

  await h.click(h.btn("关闭窗口"));
  await h.waitDialogGone();
  assert.equal(store._data().length, 1, "closing the dialog must not erase the unresolved record");
  assert.ok(h.el.textContent.includes("待核对的安全操作"));

  // 读回授权失败（401）不能删除原记录
  const { props: failingLookup } = baseProps({
    store,
    commandImpl: {
      readOperation: async () => {
        throw { status: 401, code: "UNAUTHENTICATED", reason: "authentication_required" };
      },
    },
  });
  await h.render(failingLookup);
  await h.click(h.btn("核对结果"));
  await settle();
  assert.ok(h.el.textContent.includes("登录会话已失效"), "read authorization failure uses the controlled reason copy");
  assert.ok(h.el.textContent.includes("原待核记录与责任保持不变"));
  await h.click(h.btn("关闭"));
  await h.waitDialogGone();
  assert.equal(store._data().length, 1, "authorization failure on read must keep the original record");
  assert.equal(store._data()[0].commandId, recorded.commandId, "original key keeps");
  assert.equal(store._data()[0].createdAt, recorded.createdAt, "first-submitted time keeps");
});

test("7. F2: unreadable or failed local storage blocks new submissions and preserves raw content", async (t) => {
  // (a) write failure → zero dispatch + blocking message
  {
    const store = makeStore([], { saveFails: true });
    const { props, calls } = baseProps({ store });
    const h = await mount(props, t);
    await fillPassword(h);
    await h.click(h.btn("更新登录密码"));
    await settle();
    assert.equal(calls.length, 0, "no command may be dispatched when the record cannot be durably saved");
    assert.ok(h.el.textContent.includes("本次未提交"));
    await h.cleanup();
  }
  // (b) unreadable raw content → refuse to overwrite, zero dispatch
  {
    const store = makeStore();
    store._setRaw("{corrupt-old-pending-record");
    const { props, calls } = baseProps({ store });
    const h = await mount(props, t);
    assert.ok(h.el.textContent.includes("无法读取本机安全操作记录"));
    await fillPassword(h);
    await h.click(h.btn("更新登录密码"));
    await settle();
    assert.equal(calls.length, 0);
    assert.ok(h.el.textContent.includes("本次未提交"));
    assert.equal(store._raw(), "{corrupt-old-pending-record", "corrupt original content must not be overwritten");
    await h.cleanup();
  }
  // (c) read error → zero dispatch
  {
    const store = makeStore([], { readError: true });
    const { props, calls } = baseProps({ store });
    const h = await mount(props, t);
    await fillPassword(h);
    await h.click(h.btn("更新登录密码"));
    await settle();
    assert.equal(calls.length, 0);
    await h.cleanup();
  }
  // (d) another tab's record written between renders must survive our submission
  {
    const store = makeStore([pendingRecord({ commandId: "idem_other_tab", action: "pin.change", targetKind: "session", targetSessionId: "session-1" })]);
    const { props, calls } = baseProps({
      store,
      commandImpl: { changePassword: async () => { throw { status: 500, code: "INTERNAL_ERROR" }; } },
    });
    const h = await mount(props, t);
    await fillPassword(h);
    store._append(pendingRecord({ commandId: "idem_external_tab", action: "pin.change", targetKind: "session", targetSessionId: "session-1" }));
    await h.click(h.btn("更新登录密码"));
    await settle();
    assert.equal(calls.length, 1);
    const ids = store._data().map((item) => item.commandId);
    assert.equal(ids.includes("idem_other_tab"), true, "existing records must be kept");
    assert.equal(ids.includes("idem_external_tab"), true, "another tab's record must survive our write");
    assert.equal(ids.length, 3);
    await h.cleanup();
  }
});

test("8. F4: contradictory or empty success envelopes are treated as unknown, never as success", async (t) => {
  // empty callback
  {
    const store = makeStore();
    const { props } = baseProps({ store, commandImpl: { changePassword: async () => ({}) } });
    const h = await mount(props, t);
    await fillPassword(h);
    await h.click(h.btn("更新登录密码"));
    await settle();
    assert.equal(h.el.textContent.includes("登录密码已更新"), false, "empty success must not claim the password changed");
    assert.ok(h.el.textContent.includes("提交后未收到明确结果"));
    assert.equal(store._data().length, 1);
    assert.equal(store._data()[0].dispatched, true);
    await h.cleanup();
  }
  // wrong command id echo
  {
    const store = makeStore();
    const { props } = baseProps({
      store,
      commandImpl: { changePassword: async () => ({ commandId: "idem_somebody_else", receipt: { passwordChanged: true } }) },
    });
    const h = await mount(props, t);
    await fillPassword(h);
    await h.click(h.btn("更新登录密码"));
    await settle();
    assert.equal(h.el.textContent.includes("登录密码已更新"), false);
    assert.ok(h.el.textContent.includes("与请求不一致"));
    assert.equal(store._data().length, 1);
    await h.cleanup();
  }
  // no key echo at all: this frontend always sends a key, so a keyless success envelope is not acceptable
  {
    const store = makeStore();
    const { props } = baseProps({
      store,
      commandImpl: {
        changePassword: async () => ({
          receipt: { passwordChanged: true, sessionsRotated: true, revokedSessionCount: 1, newSessionId: "session-2" },
        }),
      },
    });
    const h = await mount(props, t);
    await fillPassword(h);
    await h.click(h.btn("更新登录密码"));
    await settle();
    assert.equal(h.el.textContent.includes("登录密码已更新"), false, "missing key echo must not be treated as success");
    assert.ok(h.el.textContent.includes("提交后未收到明确结果"));
    assert.equal(store._data().length, 1);
    await h.cleanup();
  }
  // backup codes success without codes
  {
    const store = makeStore();
    const { props } = baseProps({
      store,
      commandImpl: { generateBackupCodes: async ({ commandId }) => ({ commandId, receipt: { generated: true } }) },
    });
    const h = await mount(props, t);
    await h.click(h.btn("重新生成备份码"));
    await h.type(h.el.querySelector("#self-backup-password"), SECRET_CURRENT);
    await h.click(h.btn("生成新一批备份码"));
    await settle();
    assert.equal(h.el.textContent.includes(FIXTURE_CODES[0]), false);
    assert.ok(h.el.textContent.includes("提交后未收到明确结果"));
    assert.equal(store._data().length, 1);
    await h.cleanup();
  }
});

test("9. PIN set and change use verified envelopes; invalid_pin and attempt limit keep honest copy", async (t) => {
  const store = makeStore();
  const { props, calls } = baseProps({ store, session: { id: "session-1", locked: false, pinConfigured: false } });
  const h = await mount(props, t);
  await h.click(h.btn("设置 PIN"));
  await h.type(h.el.querySelector("#self-new-pin"), "246810");
  await h.click(h.btn("设置 PIN"));
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.pin, "246810");
  assert.ok(h.el.textContent.includes("会话 PIN 已设置"));
  assert.equal(JSON.stringify(store._data()).includes("246810"), false);
  await h.click(h.btn("完成"));
  await h.waitDialogGone();

  const changeStore = makeStore();
  const { props: changeProps } = baseProps({
    store: changeStore,
    commandImpl: {
      changePin: async () => {
        throw { status: 401, code: "UNAUTHENTICATED", reason: "invalid_pin" };
      },
    },
  });
  await h.render(changeProps);
  await h.click(h.btn("更改 PIN"));
  await h.type(h.el.querySelector("#self-current-pin"), "111111");
  await h.type(h.el.querySelector("#self-new-pin"), "222222");
  await h.click(h.btn("更新 PIN"));
  await settle();
  assert.ok(h.el.textContent.includes("可能已计入尝试次数"));
  assert.equal(changeStore._data().length, 0, "a first-time definitive rejection closes the local record");
  await h.click(h.btn("关闭"));
  assert.ok(h.el.textContent.includes("放弃已输入的 PIN？"));
  await h.click(h.btn("放弃并关闭"));
  await h.waitDialogGone();

  const { props: limitProps } = baseProps({
    commandImpl: {
      changePin: async () => {
        throw { status: 423, code: "FORBIDDEN", reason: "pin_attempt_limit" };
      },
    },
  });
  await h.render(limitProps);
  await h.click(h.btn("更改 PIN"));
  await h.type(h.el.querySelector("#self-current-pin"), "111111");
  await h.type(h.el.querySelector("#self-new-pin"), "222222");
  await h.click(h.btn("更新 PIN"));
  await settle();
  assert.ok(h.el.textContent.includes("PIN 连续错误达到上限"));
  assert.ok(h.el.textContent.includes("完整重新认证"));
});

test("10. backup codes are delivered once; copy failures are honest and codes never persist", async (t) => {
  const store = makeStore();
  const { props, calls } = baseProps({ store });
  const h = await mount(props, t);
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("denied"); } },
  });

  await h.click(h.btn("重新生成备份码"));
  await h.type(h.el.querySelector("#self-backup-password"), SECRET_CURRENT);
  await h.click(h.btn("生成新一批备份码"));
  await settle();
  assert.equal(calls.length, 1);
  for (const code of FIXTURE_CODES) assert.ok(h.el.textContent.includes(code));
  const serialized = JSON.stringify(store._data());
  for (const code of FIXTURE_CODES) assert.equal(serialized.includes(code), false);
  assert.equal(serialized.includes(SECRET_CURRENT), false);

  await h.click(h.btn("复制全部"));
  await settle();
  assert.ok(h.el.textContent.includes("复制失败，请手动选择并保存下方全部代码。"));

  await h.click(h.btn("我已妥善保存"));
  await h.waitDialogGone();
  const [record] = store._data();
  assert.equal(record.action, "backup-codes.generate");
  assert.equal(record.outcome, "completed");
  assert.equal(record.delivered, true);
  assert.equal(record.result.generation, 3);
});

test("11. unacknowledged codes cannot be dismissed by Escape without confirmation", async (t) => {
  const store = makeStore();
  const { props } = baseProps({ store });
  const h = await mount(props, t);
  await h.click(h.btn("重新生成备份码"));
  await h.type(h.el.querySelector("#self-backup-password"), SECRET_CURRENT);
  await h.click(h.btn("生成新一批备份码"));
  await settle();
  assert.ok(h.el.textContent.includes(FIXTURE_CODES[0]));

  await h.escape();
  assert.ok(h.el.textContent.includes("新备份码尚未确认保存"));
  assert.ok(h.el.textContent.includes(FIXTURE_CODES[0]), "codes stay visible while the confirmation is open");
  await h.click(h.btn("继续查看"));
  assert.ok(h.el.textContent.includes(FIXTURE_CODES[0]));

  await h.escape();
  await h.click(h.btn("放弃并关闭"));
  await h.waitDialogGone();
  const [record] = store._data();
  assert.equal(record.delivered, false, "closing without confirmation must not claim the codes were saved");
  assert.ok(h.el.textContent.includes("已生成，新码未交付"));
});

test("12. completed but undelivered codes: acknowledged new generation settles only its own command", async (t) => {
  const store = makeStore();
  let generateAttempt = 0;
  const { props, calls } = baseProps({
    store,
    commandImpl: {
      generateBackupCodes: async ({ commandId }) => {
        generateAttempt += 1;
        if (generateAttempt === 1) throw { status: 0, code: "NETWORK_ERROR" };
        return {
          commandId,
          backupCodes: FIXTURE_CODES.slice(),
          receipt: {
            generated: true,
            generation: 4,
            generationId: "bcgen_fixture_4",
            generatedAt: "2026-10-14T03:00:00.000Z",
            codeCount: FIXTURE_CODES.length,
          },
        };
      },
      readOperation: async ({ commandId }) => ({
        commandId,
        status: "completed",
        action: "backup-codes.generate",
        targetKind: "credential",
        result: { generated: true, generation: 3, generationId: "bcgen_fixture_3", codeCount: 10, generatedAt: "2026-10-14T02:00:00.000Z" },
      }),
    },
  });
  const h = await mount(props, t);
  await h.click(h.btn("重新生成备份码"));
  await h.type(h.el.querySelector("#self-backup-password"), SECRET_CURRENT);
  await h.click(h.btn("生成新一批备份码"));
  await settle();
  assert.ok(h.el.textContent.includes("提交后未收到明确结果"));
  assert.equal(h.el.querySelector("#self-backup-password"), null, "unknown phase clears the typed password");

  await h.click(h.btn("关闭窗口"));
  await h.waitDialogGone();
  assert.ok(h.el.textContent.includes("结果待核对"));

  await h.click(h.btn("核对结果"));
  await settle();
  assert.ok(h.el.textContent.includes("第 3 代"));
  assert.ok(h.el.textContent.includes("明文只交付过一次"));
  await h.click(h.btn("知道了"));
  await h.waitDialogGone();
  assert.equal(calls.filter((call) => call.name === "generateBackupCodes").length, 1, "lookup must not regenerate");
  assert.ok(h.el.textContent.includes("第 3 代已生成，新码未交付"));

  await h.click(h.btn("重新生成备份码"));
  assert.ok(h.el.textContent.includes("尚未核清"), "a pending record must be surfaced before the first submit");
  await h.type(h.el.querySelector("#self-backup-password"), SECRET_CURRENT);
  await h.click(h.btn("生成新一批备份码"));
  await settle();
  assert.equal(calls.filter((call) => call.name === "generateBackupCodes").length, 1, "gate must block before acknowledging");
  assert.ok(h.el.textContent.includes("我了解，仍要发起一次新的独立操作"), "submit surfaces the authoritative gate");
  await h.click(h.btn("我了解，仍要发起一次新的独立操作"));
  await h.click(h.btn("生成新一批备份码"));
  await settle();
  assert.equal(calls.filter((call) => call.name === "generateBackupCodes").length, 2, "explicit new generation uses a new intent");
  const ids = new Set(calls.filter((call) => call.name === "generateBackupCodes").map((call) => call.input.commandId));
  assert.equal(ids.size, 2, "the new generation must use a new command id");
  assert.ok(h.el.textContent.includes(FIXTURE_CODES[0]));
  const backupRecords = store._data().filter((item) => item.action === "backup-codes.generate");
  assert.equal(backupRecords.length, 2, "an older success must not delete other backup records (response order is not server generation order)");
  assert.ok(backupRecords.some((item) => item.commandId === "idem_seed_1" || item.result?.generation === 3), "the earlier undelivered record survives");
  assert.equal(backupRecords.every((item) => item.delivered === false), true);
});

test("13. the four validated read states settle records honestly", async (t) => {
  let nextResult = { status: "unconfirmed" };
  const store = makeStore([
    pendingRecord({ action: "pin.change", targetKind: "session", targetSessionId: "session-1" }),
    pendingRecord({ commandId: "idem_seed_2" }),
  ]);
  const { props } = baseProps({
    store,
    commandImpl: {
      readOperation: async ({ commandId }) => ({ commandId, ...nextResult }),
    },
  });
  const h = await mount(props, t);
  const rowBtn = (label, actionLabel) => {
    const row = [...h.el.querySelectorAll("li")].find((node) => node.textContent.includes(actionLabel));
    assert.ok(row, `expected pending row for ${actionLabel}`);
    return [...row.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
  };

  await h.click(rowBtn("核对结果", "更改会话 PIN"));
  await settle();
  assert.ok(h.el.textContent.includes("未找到记录"));
  await h.click(h.btn("知道了"));
  await h.waitDialogGone();
  assert.equal(store._data().find((item) => item.commandId === "idem_seed_1").outcome, "unconfirmed");
  assert.ok(h.el.textContent.includes("已核对：未找到记录"));

  nextResult = { status: "expired", action: "pin.change" };
  await h.click(rowBtn("核对结果", "更改会话 PIN"));
  await settle();
  assert.ok(h.el.textContent.includes("已超过可核对期"));
  await h.click(h.btn("知道了"));
  await h.waitDialogGone();
  assert.equal(store._data().find((item) => item.commandId === "idem_seed_1").outcome, "expired");

  nextResult = { status: "rejected", action: "password.change", targetKind: "credential", reason: "invalid_current_password" };
  await h.click(rowBtn("核对结果", "修改登录密码"));
  await settle();
  assert.ok(h.el.textContent.includes("已拒绝"));
  assert.ok(h.el.textContent.includes("当前密码不正确"));
  await h.click(h.btn("知道了"));
  await h.waitDialogGone();
  assert.equal(store._data().length, 1, "a rejected receipt retires its local record");
  assert.equal(store._data()[0].commandId, "idem_seed_1");

  nextResult = { status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "session-1", result: { pinChanged: true, sessionId: "session-1" } };
  await h.click(rowBtn("核对结果", "更改会话 PIN"));
  await settle();
  assert.ok(h.el.textContent.includes("已完成"));
  await h.click(h.btn("知道了"));
  await h.waitDialogGone();
  assert.equal(store._data().length, 0, "a completed non-backup receipt retires its local record");
});

test("14. F4: mismatched or invalid read receipts fail read-only and keep the responsibility", async (t) => {
  const cases = [
    { name: "wrong key", result: (record) => ({ commandId: "idem_somebody_else", status: "completed", action: "password.change", targetKind: "credential", result: { passwordChanged: true } }) },
    { name: "wrong action", result: (record) => ({ commandId: record.commandId, status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "another", result: { pinChanged: true } }) },
    { name: "wrong target", result: (record) => ({ commandId: record.commandId, status: "completed", action: "password.change", targetKind: "credential", targetSessionId: "session-x", result: { passwordChanged: true } }) },
    { name: "empty completed body", result: (record) => ({ commandId: record.commandId, status: "completed", action: "password.change", targetKind: "credential", result: {} }) },
    { name: "unknown status", result: (record) => ({ commandId: record.commandId, status: "mystery" }) },
    { name: "rejected without reason", result: (record) => ({ commandId: record.commandId, status: "rejected", action: "password.change", targetKind: "credential" }) },
  ];
  for (const item of cases) {
    const store = makeStore([pendingRecord()]);
    const { props } = baseProps({
      store,
      commandImpl: { readOperation: async (input) => item.result(input) },
    });
    const h = await mount(props, t);
    await h.click(h.btn("核对结果"));
    await settle();
    const text = h.el.textContent;
    assert.ok(text.includes("读取失败"), `${item.name}: must be a read failure`);
    assert.equal(text.includes("已完成"), false, `${item.name}: must not claim completed`);
    assert.equal(text.includes("已超过可核对期"), false, `${item.name}: must not fall through to expired`);
    await h.click(h.btn("关闭"));
    await h.waitDialogGone();
    assert.equal(store._data().length, 1, `${item.name}: record must be kept`);
    assert.equal(store._data()[0].outcome, "unknown", `${item.name}: outcome must remain unresolved`);
    await h.cleanup();
  }
});

test("14b. a PIN receipt whose body session disagrees with the outer target is a read failure", async (t) => {
  const store = makeStore([pendingRecord({ action: "pin.change", targetKind: "session", targetSessionId: "session-1" })]);
  const { props } = baseProps({
    store,
    commandImpl: {
      readOperation: async ({ commandId }) => ({
        commandId,
        status: "completed",
        action: "pin.change",
        targetKind: "session",
        targetSessionId: "session-1",
        result: { pinChanged: true, sessionId: "other-session" },
      }),
    },
  });
  const h = await mount(props, t);
  await h.click(h.btn("核对结果"));
  await settle();
  assert.ok(h.el.textContent.includes("读取失败"));
  assert.equal(h.el.textContent.includes("已完成"), false);
  await h.click(h.btn("关闭"));
  await h.waitDialogGone();
  assert.equal(store._data().length, 1, "responsibility is kept");
  assert.equal(store._data()[0].outcome, "unknown");
});

test("15. F5: a confirmed completion refreshes current session facts; refresh failure offers a read-only retry", async (t) => {
  // refresh succeeds → PIN row follows server facts, not the receipt target
  {
    const store = makeStore([pendingRecord({ action: "pin.set", targetKind: "session", targetSessionId: "session-1" })]);
    const { props } = baseProps({
      store,
      session: { id: "session-1", locked: false, pinConfigured: false },
      refreshSession: async () => ({
        accountStatus: "ACTIVE",
        twoFactorEnabled: true,
        session: { id: "session-2", locked: false, pinConfigured: true },
      }),
      commandImpl: {
        readOperation: async ({ commandId }) => ({ commandId, status: "completed", action: "pin.set", targetKind: "session", targetSessionId: "session-1", result: { pinConfigured: true, sessionId: "session-1" } }),
      },
    });
    const h = await mount(props, t);
    assert.equal(h.btn("设置 PIN") !== undefined, true);
    await h.click(h.btn("核对结果"));
    await settle();
    assert.ok(h.el.textContent.includes("当前会话状态已按服务端事实更新"));
    assert.equal(store._data().length, 0);
    await h.click(h.btn("知道了"));
    await h.waitDialogGone();
    assert.equal(h.btn("更改 PIN") !== undefined, true, "PIN row must follow the refreshed session facts");
    assert.equal(h.btn("设置 PIN"), undefined, "stale initial-set action must not remain");
    await h.cleanup();
  }
  // refresh fails → confirmed result kept + read-only retry with zero extra writes
  {
    let refreshOk = false;
    let refreshCount = 0;
    const store = makeStore([pendingRecord({ action: "pin.set", targetKind: "session", targetSessionId: "session-1" })]);
    const { props, calls } = baseProps({
      store,
      session: { id: "session-1", locked: false, pinConfigured: false },
      refreshSession: async () => {
        refreshCount += 1;
        return refreshOk
          ? { accountStatus: "ACTIVE", twoFactorEnabled: true, session: { id: "session-2", locked: false, pinConfigured: true } }
          : null;
      },
      commandImpl: {
        readOperation: async ({ commandId }) => ({ commandId, status: "completed", action: "pin.set", targetKind: "session", targetSessionId: "session-1", result: { pinConfigured: true, sessionId: "session-1" } }),
      },
    });
    const h = await mount(props, t);
    await h.click(h.btn("核对结果"));
    await settle();
    assert.ok(h.el.textContent.includes("已完成"), "the receipt itself stays confirmed");
    assert.ok(h.el.textContent.includes("原命令已确认完成；但当前会话状态读取失败"));
    assert.equal(refreshCount, 1);
    refreshOk = true;
    await h.click(h.btn("刷新当前状态"));
    await settle();
    assert.equal(refreshCount, 2);
    assert.ok(h.el.textContent.includes("当前会话状态已按服务端事实更新"));
    assert.equal(calls.filter((call) => call.name !== "readOperation").length, 0, "refresh must not send any write");
    await h.cleanup();
  }
});

test("16. historical PIN receipts never rebind the current session", async (t) => {
  const store = makeStore([pendingRecord({ action: "pin.change", targetKind: "session", targetSessionId: "session-old" })]);
  const { props, refreshCalls } = baseProps({
    store,
    session: { id: "session-1", locked: false, pinConfigured: false },
    commandImpl: {
      readOperation: async ({ commandId }) => ({ commandId, status: "completed", action: "pin.change", targetKind: "session", targetSessionId: "session-old", result: { pinChanged: true, sessionId: "session-old" } }),
    },
  });
  const h = await mount(props, t);
  await h.click(h.btn("核对结果"));
  await settle();
  assert.ok(h.el.textContent.includes("更早的会话"), "old target session note");
  assert.equal(refreshCalls.length, 1, "confirmation reads current facts read-only");
  await h.click(h.btn("知道了"));
  await h.waitDialogGone();
  assert.equal(h.btn("设置 PIN") !== undefined, true, "row follows refreshed current facts, not the historical receipt");
  assert.equal(h.btn("更改 PIN"), undefined);
});

test("17. F3: identity, lock and unmount changes clear secrets, close dialogs and drop late results", async (t) => {
  // identity switch clears typed secret and closes the dialog
  {
    const { props } = baseProps();
    const h = await mount(props, t);
    await fillPassword(h);
    assert.ok(h.dialog());
    await h.render({ ...props, adminUserId: "admin-2", accountLabel: "ZZ00002", session: { id: "session-2", locked: false, pinConfigured: true } });
    await h.waitDialogGone();
    const lingeringInput = h.el.querySelector("#self-current-password");
    assert.equal(lingeringInput ? lingeringInput.value : "", "", "old secret must be cleared on identity switch");
    await h.cleanup();
  }
  // late backup-code response must not render under the new identity
  {
    let resolveLate;
    const delayed = new Promise((resolve) => { resolveLate = resolve; });
    const store = makeStore();
    const { props } = baseProps({ store, commandImpl: { generateBackupCodes: () => delayed } });
    const h = await mount(props, t);
    await h.click(h.btn("重新生成备份码"));
    await h.type(h.el.querySelector("#self-backup-password"), SECRET_CURRENT);
    await h.click(h.btn("生成新一批备份码"));
    await h.render({ ...props, adminUserId: "admin-2", accountLabel: "ZZ00002", session: { id: "session-2", locked: false, pinConfigured: true } });
    await act(async () => {
      resolveLate({ backupCodes: FIXTURE_CODES, receipt: { generated: true, generation: 1, codeCount: FIXTURE_CODES.length } });
    });
    await settle();
    assert.equal(h.el.textContent.includes("ZZ00002"), true);
    assert.equal(h.el.textContent.includes(FIXTURE_CODES[0]), false, "late secret result must not render under the new identity");
    await h.waitDialogGone();
    const late = store._data();
    assert.ok(late.every((item) => item.adminUserId === "admin-1"), "responsibility stays in the original identity domain");
    await h.cleanup();
  }
  // late refresh must not overwrite the new identity's facts
  {
    let resolveRefresh;
    const delayedRefresh = new Promise((resolve) => { resolveRefresh = resolve; });
    const store = makeStore();
    const { props } = baseProps({ store, refreshSession: () => delayedRefresh });
    const h = await mount(props, t);
    await fillPassword(h);
    await h.click(h.btn("更新登录密码"));
    await settle();
    await h.render({ ...props, adminUserId: "admin-2", accountLabel: "ZZ00002" });
    await act(async () => {
      resolveRefresh({ accountStatus: "ACTIVE", twoFactorEnabled: true, session: { id: "session-9", locked: false, pinConfigured: false } });
    });
    await settle();
    assert.equal(h.el.textContent.includes("已配置"), true, "late refresh from the old identity must not overwrite current facts");
    await h.cleanup();
  }
  // lock transition closes dialogs
  {
    const { props } = baseProps();
    const h = await mount(props, t);
    await fillPassword(h);
    assert.ok(h.dialog());
    await h.render({ ...props, session: { id: "session-1", locked: true, pinConfigured: true } });
    await h.waitDialogGone();
    const lockedInput = h.el.querySelector("#self-current-password");
    assert.equal(lockedInput ? lockedInput.value : "", "", "lock transition must drop the typed secret");
    await h.cleanup();
  }
});

test("18. unresolved records can only be hidden, never silently cleared", async (t) => {
  const store = makeStore([pendingRecord({ commandId: "idem_hidden_1" })]);
  const { props } = baseProps({ store });
  const h = await mount(props, t);
  assert.ok(h.el.textContent.includes("待核对的安全操作"));
  await h.click(h.btn("隐藏提醒"));
  await settle();
  const [record] = store._data();
  assert.equal(record.dismissed, true, "hiding must keep the record");
  assert.equal(record.outcome, "unknown");
  assert.equal(h.el.textContent.includes("另有 1 条未核清记录已隐藏提醒"), true);
  const toggle = h.btn("另有 1 条未核清记录已隐藏提醒") ?? [...h.el.querySelectorAll("button")].find((node) => node.textContent.includes("已隐藏提醒"));
  assert.ok(toggle);
  await h.click(toggle);
  assert.ok(h.el.textContent.includes("已隐藏提醒 · 结果待核对"));
  const restore = [...h.el.querySelectorAll("button")].find((node) => node.textContent.trim() === "恢复提醒");
  await h.click(restore);
  assert.equal(store._data()[0].dismissed, false, "restoring keeps the same record");
});

test("19. dirty state is reported and Escape never discards typed secrets silently", async (t) => {
  const reported = [];
  const { props } = baseProps({ onDirtyChange: (value) => reported.push(value) });
  const h = await mount(props, t);
  await h.click(h.btn("修改密码"));
  await h.type(h.el.querySelector("#self-current-password"), SECRET_CURRENT);
  assert.equal(reported.at(-1), true);

  await h.escape();
  assert.ok(h.dialog(), "Escape with unsaved input must not close the dialog");
  assert.ok(h.el.textContent.includes("放弃已输入的内容？"));
  await h.click(h.btn("继续编辑"));
  assert.equal(h.el.querySelector("#self-current-password").value, SECRET_CURRENT);

  await h.escape();
  await h.click(h.btn("放弃并关闭"));
  await h.waitDialogGone();
  assert.equal(reported.at(-1), false);
  await h.click(h.btn("修改密码"));
  assert.equal(h.el.querySelector("#self-current-password").value, "");
});

test("20. the gate is bound to the latest authoritative set at submit time", async (t) => {
  const store = makeStore([pendingRecord({ commandId: "idem_gate_1" })]);
  const { props, calls } = baseProps({ store });
  const h = await mount(props, t);
  await fillPassword(h);
  assert.ok(h.el.textContent.includes("尚未核清"), "passive notice is visible before submit");
  await h.click(h.btn("更新登录密码"));
  assert.equal(calls.length, 0, "no command may leave before acknowledgment");
  assert.ok(h.el.textContent.includes("我了解，仍要发起一次新的独立操作"), "submit surfaces the authoritative gate");
  assert.equal(store._data().some((item) => item.commandId !== "idem_gate_1"), false, "gate refusal must not write the new record");

  // 取消路径：关闭弹窗后零提交，原责任保留
  await h.escape();
  await h.click(h.btn("放弃并关闭"));
  await h.waitDialogGone();
  assert.equal(calls.length, 0);
  assert.equal(store._data().length, 1);
  assert.equal(store._data()[0].commandId, "idem_gate_1");

  // 确认路径：确认后同一意图写入并发出；成功后只结算本命令，原责任保留
  await fillPassword(h);
  await h.click(h.btn("更新登录密码"));
  await h.click(h.btn("我了解，仍要发起一次新的独立操作"));
  await h.click(h.btn("更新登录密码"));
  assert.equal(calls.length, 1, "acknowledged submit proceeds");
  assert.equal(store._data().length, 1, "the new intent is settled by its success; the earlier responsibility stays");
  assert.equal(store._data()[0].commandId, "idem_gate_1");
});

test("21. cold-mount external additions are gated against the authoritative set; a changed set requires re-acknowledgement", async (t) => {
  const store = makeStore();
  const { props, calls } = baseProps({ store, commandImpl: { changePassword: async () => { throw { status: 0, code: "NETWORK_ERROR" }; } } });
  const h = await mount(props, t);

  // 另一个标签在本页挂载后才写入未决记录：被动提示不可知，但提交时必须按权威集合拦下
  store._append(pendingRecord({ commandId: "idem_from_other_tab" }));
  await fillPassword(h);
  assert.equal(h.el.textContent.includes("尚未核清"), false, "stale in-memory UI cannot know about the other tab yet");
  await h.click(h.btn("更新登录密码"));
  assert.equal(calls.length, 0);
  assert.ok(h.el.textContent.includes("我了解，仍要发起一次新的独立操作"), "authoritative read gates the submit");
  assert.ok(h.el.textContent.includes("idem_from_other_tab") === false);

  await h.click(h.btn("我了解，仍要发起一次新的独立操作"));
  // 确认后集合又变化（第三个标签写入）：指纹失效，必须重新确认
  store._append(pendingRecord({ commandId: "idem_third_tab" }));
  await h.click(h.btn("更新登录密码"));
  assert.equal(calls.length, 0, "a changed unresolved set must not ride on the earlier acknowledgement");
  assert.ok(h.el.textContent.includes("仍要发起一次新的独立操作"));
  await h.click(h.btn("我了解，仍要发起一次新的独立操作"));
  await h.click(h.btn("更新登录密码"));
  assert.equal(calls.length, 1);
  const ids = store._data().map((item) => item.commandId);
  assert.ok(ids.includes("idem_from_other_tab") && ids.includes("idem_third_tab"), "other tabs' records survive");
  assert.equal(ids.length, 3);
});

test("22. F1: a valid success arriving after an identity switch must not start an old refresh or touch the new facts", async (t) => {
  let resolveCommand;
  const delayed = new Promise((resolve) => { resolveCommand = resolve; });
  let refreshes = 0;
  const store = makeStore();
  const { props, calls } = baseProps({
    store,
    refreshSession: async () => {
      refreshes += 1;
      return { accountStatus: "ACTIVE", twoFactorEnabled: true, session: { id: "old-returned-session", locked: false, pinConfigured: false } };
    },
    commandImpl: { changePassword: () => delayed },
  });
  const h = await mount(props, t);
  await fillPassword(h);
  await h.click(h.btn("更新登录密码"));
  const dispatchedId = calls[0].input.commandId;

  // 切到管理员2（PIN 已配置）之后，A 的合法成功信封才抵达
  await h.render({ ...props, adminUserId: "admin-2", accountLabel: "ZZ00002", session: { id: "new-admin-session", locked: false, pinConfigured: true } });
  await act(async () => {
    resolveCommand({
      commandId: dispatchedId,
      receipt: { passwordChanged: true, sessionsRotated: true, revokedSessionCount: 1, newSessionId: "old-returned-session" },
    });
  });
  await settle();

  assert.equal(refreshes, 0, "an old command must not start a refresh after the identity switched");
  assert.equal(h.el.textContent.includes("设置 PIN"), false, "the new identity's PIN facts must not be overwritten");
  assert.ok(h.btn("更改 PIN"), "administrator B keeps the configured PIN");
  const late = store._data();
  assert.ok(late.every((item) => item.adminUserId === "admin-1"), "responsibility stays in the original identity domain");
  assert.equal(late.length, 1, "the stale success does not settle the old record either");
  assert.equal(late[0].commandId, dispatchedId);
  await h.cleanup();
});
