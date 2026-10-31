import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4381/settings" });
browser.Element.prototype.scrollIntoView = function () {};
for (const name of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "DOMRect", "DOMException", "Storage", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Response", "Headers", "AbortController"]) {
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
const vite = await createServer({
  root: adminRoot,
  configFile: false,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/self-settings-component"),
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});

const { ProfileView } = await vite.ssrLoadModule("/src/views/self-settings/profile-view.tsx");
const { SessionsView } = await vite.ssrLoadModule("/src/views/self-settings/sessions-view.tsx");
const { ActivityView } = await vite.ssrLoadModule("/src/views/self-settings/activity-view.tsx");
const api = await vite.ssrLoadModule("/src/views/self-settings/self-settings-api.ts");
const { AdminApiError } = await vite.ssrLoadModule("/src/api.ts");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

const settle = async (ms = 25) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const networkError = () => new AdminApiError(0, "NETWORK_ERROR", undefined, "/self/x");
const serverError = () => new AdminApiError(503, "INTERNAL_ERROR", "req-503", "/self/x");
const forbiddenError = () => new AdminApiError(403, "FORBIDDEN", undefined, "/self/x");
const rejectedError = () => new AdminApiError(400, "INVALID_ARGUMENT", undefined, "/self/x");
const notFoundError = () => new AdminApiError(404, "NOT_FOUND", undefined, "/self/x");
const conflictError = () => new AdminApiError(409, "CONFLICT", undefined, "/self/x");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(Component, props) {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  const view = {
    host,
    get el() {
      return host;
    },
    rerender: (next) => {
      act(() => {
        root.render(createElement(Component, next));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
  view.rerender(props);
  return view;
}

const text = (view) => view.el.textContent ?? "";
const byText = (view, needle) => text(view).includes(needle);
const buttons = (view) => [...view.el.querySelectorAll("button")];
const buttonByText = (view, needle) => buttons(view).find((node) => (node.textContent ?? "").includes(needle));
const input = (view) => view.el.querySelector("input");
const dialog = (view) => view.el.ownerDocument.querySelector('[data-slot="dialog-content"]:not([data-closed])');
const dialogButton = (view, needle) => [...dialog(view).querySelectorAll("button")].find((node) => (node.textContent ?? "").includes(needle));
const rows = (view) => view.el.querySelectorAll("ol > li");
const click = async (node) => {
  await act(async () => {
    node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
};
const confirmRevoke = async (view) => {
  const box = view.el.ownerDocument.querySelector('[role="dialog"]') ?? view.el;
  const [pw, code] = [box.querySelector('input[type="password"]'), box.querySelector('input[inputmode="numeric"]')];
  assert.ok(pw && code, "注销确认必须要求本人密码与动态码");
  await type(view, pw, "fixture-password");
  await type(view, code, "123456");
  await click(dialogButton(view, "确认注销"));
};
const type = async (view, node, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(node, value);
    node.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
};

// ---------------------------------------------------------------------------
// 局部 API 适配：真实 adminRequest 路径与方法
// ---------------------------------------------------------------------------

function stubFetch(body) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body, headers: options.headers ?? {} });
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body ?? {} };
  };
  return calls;
}

test("adapter: 六个调用都走既有 adminRequest 与合同 §0.1 路径", async () => {
  const calls = stubFetch({});
  await api.readProfile();
  await api.updateProfileDisplayName("新的显示名称");
  await api.readSessions();
  await api.revokeSession({ sessionId: "session_fixture_other", password: "pw", totpCode: "123456" });
  await api.revokeOtherSessions({ sessionIds: ["session_fixture_other"], password: "pw", totpCode: "123456" });
  await api.readSecurityActivity({ cursor: "C1", action: "admin.frozen", limit: 20 });
  assert.deepEqual(
    calls.map((call) => [call.url.replace("/api/bff/admin", ""), call.method, call.body]),
    [
      ["/self/profile", "GET", undefined],
      ["/self/profile", "POST", JSON.stringify({ displayName: "新的显示名称" })],
      ["/self/sessions", "GET", undefined],
      ["/security/self-sessions/revoke", "POST", JSON.stringify({ scope: "one", sessionIds: ["session_fixture_other"], password: "pw", totpCode: "123456" })],
      ["/security/self-sessions/revoke", "POST", JSON.stringify({ scope: "others", sessionIds: ["session_fixture_other"], password: "pw", totpCode: "123456" })],
      ["/self/security-activity?limit=20&cursor=C1&action=admin.frozen", "GET", undefined],
    ],
  );
  assert.equal(calls[1].headers["content-type"], "application/json", "写请求应带 JSON 头");
  assert.ok(String(calls[1].headers["idempotency-key"] ?? "").startsWith("idem_"), "非 GET 由 adminRequest 自动带幂等键");
  assert.ok(!calls[0].url.includes("undefined"), "GET 不应拼出 undefined 参数");
});

test("master: 资料成功必须有合法信封、本人身份和提交名称", async (t) => {
  for (const response of [{}, { status: true, profile: { ...PROFILE, adminUserId: "other" } }, { status: true, profile: { ...PROFILE } }]) {
    let refreshes = 0;
    const view = mount(ProfileView, profileProps({ saveDisplayName: async () => response, onSessionRefresh: () => { refreshes++; } }));
    try {
      await settle(); await type(view, input(view), "本次新名称"); await click(buttonByText(view, "保存显示名称"));
      assert.equal(byText(view, "显示名称已保存。"), false);
      assert.ok(byText(view, "未收到明确结果"));
      assert.equal(refreshes, 0);
    } finally { view.unmount(); }
  }
});

test("master: 批量注销适配器传递固定目标集合", async () => {
  const calls = stubFetch({});
  await api.revokeOtherSessions({ sessionIds: ["fixed-a", "fixed-b"], password: "pw", totpCode: "123456" });
  assert.deepEqual(JSON.parse(calls[0].body), { scope: "others", sessionIds: ["fixed-a", "fixed-b"], password: "pw", totpCode: "123456" });
});

test("master: 批量确认保存确切id，成功计数必须匹配确认集合", async () => {
  let sent;
  const view = mount(SessionsView, sessionProps({ revokeOtherSessions: async (value) => {
    sent = value; return { status: true, revokedSessionCount: 0 };
  } }));
  try {
    await settle(); await click(buttonByText(view, "退出其他设备")); await confirmRevoke(view);
    assert.deepEqual(sent, { sessionIds: ["session_fixture_other"], password: "fixture-password", totpCode: "123456" });
    assert.ok(byText(view, "无法确认"));
    assert.equal(byText(view, "已确认注销"), false);
  } finally { view.unmount(); }
});

test("master: 两页收到403后立即清投影并撤下写入口", async () => {
  for (const [Component, propsFn, label] of [[ProfileView, profileProps, "保存显示名称"], [SessionsView, sessionProps, "退出其他设备"]]) {
    const view = mount(Component, propsFn());
    try {
      await settle();
      if(Component === ProfileView) await type(view,input(view),"待保存草稿");
      view.rerender(propsFn({ load: async () => { throw forbiddenError(); } }));
      await settle();
      assert.ok(!buttonByText(view,label),"403不能保留写入口");
      assert.equal(byText(view,Component===ProfileView?"ZZ00001":"session_fixture_other"),false);
    } finally { view.unmount(); }
  }
});

test("master: 切身份发生在快照刷新中时，两页不得启动旧身份后续读回", async () => {
  for (const [Component, propsFn] of [[ProfileView, profileProps], [SessionsView, sessionProps]]) {
    const refresh=deferred(); let oldReads=0;
    const old=propsFn({
      load:async()=>{oldReads++;return Component===ProfileView?{...PROFILE}:structuredClone(SESSIONS_BODY);},
      saveDisplayName:async({displayName})=>({status:true,profile:{...PROFILE,displayName}}),
      onSessionRefresh:()=>refresh.promise,
    });
    const view=mount(Component,old);
    try{
      await settle();
      if(Component===ProfileView){await type(view,input(view),"旧身份新名");await click(buttonByText(view,"保存显示名称"));}
      else{await click(buttonByText(view,"注销该会话"));await confirmRevoke(view);}
      view.rerender(propsFn({adminUserId:"admin_new",sessionId:"session_new",
        load:async()=>Component===ProfileView?{...PROFILE,adminUserId:"admin_new",zzNumber:"ZZ00002",displayName:"新身份"}:
          {sessions:[{...SESSIONS_BODY.sessions[0],id:"session_new"}]}}));
      await settle(); await act(async()=>refresh.resolve()); await settle();
      assert.equal(oldReads,1,"旧快照回调不得重新发旧读取");
      assert.equal(byText(view,Component===ProfileView?"ZZ00001":"session_fixture_other"),false);
    }finally{view.unmount();}
  }
});

test("master: 资料未知态不能再次提交，只读回后明确重新编辑", async () => {
  let writes=0;
  const view=mount(ProfileView,profileProps({saveDisplayName:async()=>{writes++;throw networkError();}}));
  try{
    await settle();await type(view,input(view),"新名称");await click(buttonByText(view,"保存显示名称"));
    assert.equal(buttonByText(view,"保存显示名称").disabled,true);
    await click(buttonByText(view,"核对当前资料"));
    assert.equal(writes,1);
    assert.ok(buttonByText(view,"按当前资料重新编辑"));
  }finally{view.unmount();}
});

test("master: 已知锁定或非ACTIVE时三页不发起读取", async () => {
  for (const [Component, propsFn] of [[ProfileView, profileProps], [SessionsView, sessionProps], [ActivityView, activityProps]]) {
    for (const status of [{locked:true},{accountStatus:"FROZEN"},{accountStatus:"PENDING_ENROLLMENT"}]) {
      let reads=0;
      const view=mount(Component,propsFn({...status,load:async()=>{reads++;throw serverError();}}));
      try{await settle();assert.equal(reads,0);}finally{view.unmount();}
    }
  }
});

test("master: 路由404但目标仍在时不能宣称注销成功", async () => {
  let writes=0;
  const view=mount(SessionsView,sessionProps({revokeSession:async()=>{writes++;throw notFoundError();}}));
  try{
    await settle();await click(buttonByText(view,"注销该会话"));await confirmRevoke(view);await settle();
    assert.equal(writes,1);
    assert.ok(byText(view,"仍在本人有效列表"));
    assert.equal(byText(view,"已确认注销"),false);
    assert.equal(byText(view,"已不在本人有效"),false);
  }finally{view.unmount();}
});

test("master: 预览模式可查看资料表单与会话确认，不能提交写", async () => {
  const profile=mount(ProfileView,profileProps({saveDisplayName:undefined,writeDisabledReason:"只预览，不保存"}));
  try{
    await settle();await type(profile,input(profile),"预览名字");
    assert.equal(buttonByText(profile,"保存显示名称").disabled,true);
    await act(async()=>profile.el.querySelector("form").dispatchEvent(new window.Event("submit",{bubbles:true,cancelable:true})));
    assert.equal(byText(profile,"显示名称已保存。"),false);
  }finally{profile.unmount();}
  const sessions=mount(SessionsView,sessionProps({revokeSession:undefined,revokeOtherSessions:undefined,writeDisabledReason:"只预览，不注销"}));
  try{
    await settle();await click(buttonByText(sessions,"退出其他设备"));
    assert.ok(dialog(sessions));
    assert.equal(dialogButton(sessions,"确认注销").disabled,true);
    await click(dialogButton(sessions,"取消"));
  }finally{sessions.unmount();}
});

test("adapter: 无游标与无筛选时不发送空参数", async () => {
  const calls = stubFetch({});
  await api.readSecurityActivity({ cursor: null, action: "" });
  assert.equal(calls[0].url, "/api/bff/admin/self/security-activity?limit=20");
});

// ---------------------------------------------------------------------------
// A. 个人资料
// ---------------------------------------------------------------------------

const PROFILE = {
  adminUserId: "admin_fixture_0001",
  zzNumber: "ZZ00001",
  displayName: "示例管理员",
  avatarUrl: null,
  updatedAt: "2026-10-14T09:12:33.000Z",
};

const profileProps = (extra) => ({
  adminUserId: "admin_fixture_0001",
  sessionId: "sess-1",
  accountStatus: "ACTIVE",
  locked: false,
  load: async () => ({ ...PROFILE }),
  saveDisplayName: async () => ({ status: true, profile: { ...PROFILE } }),
  ...extra,
});

test("profile: 渲染合同字段；zzNumber 为 null 时显示未提供且不给复制", async () => {
  const view = mount(ProfileView, profileProps());
  await settle();
  assert.ok(byText(view, "ZZ00001"), text(view));
  assert.ok(byText(view, "示例管理员"));
  assert.ok(buttonByText(view, "复制"), "有编号时应提供复制");
  assert.ok(byText(view, "资料最后变更时间"), "updatedAt 应可见，作为读回核对证据");

  view.rerender(profileProps({ load: async () => ({ ...PROFILE, zzNumber: null }) }));
  await settle();
  assert.ok(byText(view, "未提供"), "缺编号显示未提供");
  assert.ok(!buttonByText(view, "复制"), "缺编号时不得留下无效复制按钮");
  assert.ok(!byText(view, "admin_fixture_0001"), "绝不用内部 ID 顶替 ZZ 编号");
  view.unmount();
});

test("profile: 响应身份与当前管理员不一致时停止显示", async () => {
  const view = mount(ProfileView, profileProps({ load: async () => ({ ...PROFILE, adminUserId: "someone_else" }) }));
  await settle();
  assert.ok(byText(view, "不属于当前管理员"), text(view));
  assert.ok(!byText(view, "ZZ00001"), "不得把他人资料渲染成本人页面");
  view.unmount();
});

test("profile: 无改动不发送写请求；仅首尾空白不算修改；取消恢复已读事实", async () => {
  const writes = [];
  const view = mount(ProfileView, profileProps({
    saveDisplayName: ({ displayName }) => {
      writes.push(displayName);
      return Promise.resolve({ status: true, profile: { ...PROFILE, displayName } });
    },
  }));
  await settle();
  assert.equal(input(view).value, "示例管理员", "读取后应回填已读事实");
  const save = buttonByText(view, "保存显示名称");
  assert.ok(save.disabled);
  await click(save);
  assert.equal(writes.length, 0);
  assert.ok(byText(view, "没有改动，无需保存。"));

  await type(view, input(view), "示例管理员   ");
  assert.equal(buttonByText(view, "保存显示名称").disabled, true);
  await type(view, input(view), "示例管理员二号");
  assert.equal(buttonByText(view, "保存显示名称").disabled, false);
  await click(buttonByText(view, "放弃修改"));
  assert.equal(input(view).value, "示例管理员");
  view.unmount();
});

test("profile: 保存成功→刷新快照并重读；刷新失败与保存结果分开显示", async () => {
  const writes = [];
  let reads = 0;
  let refreshFails = false;
  const view = mount(ProfileView, profileProps({
    load: async () => {
      reads += 1;
      return { ...PROFILE, displayName: writes.length ? writes[writes.length - 1] : PROFILE.displayName };
    },
    saveDisplayName: ({ displayName }) => {
      writes.push(displayName);
      return Promise.resolve({ status: true, profile: { ...PROFILE, displayName } });
    },
    onSessionRefresh: async () => {
      if (refreshFails) throw networkError();
    },
  }));
  await settle();
  await type(view, input(view), "新名字");
  await click(buttonByText(view, "保存显示名称"));
  await settle(60);
  assert.deepEqual(writes, ["新名字"]);
  assert.ok(byText(view, "显示名称已保存。"), text(view));
  assert.equal(reads, 2, "成功后应重新读取权威事实");

  refreshFails = true;
  await type(view, input(view), "再改一次");
  await click(buttonByText(view, "保存显示名称"));
  await settle(60);
  assert.ok(byText(view, "顶部当前用户显示刷新失败"), "快照刷新失败单独说明");
  assert.ok(byText(view, "资料已保存"), "不得因刷新失败反推资料未保存");
  view.unmount();
});

test("profile: 网络中断进未知态不自动重发；读回同名且 updatedAt 未变时不下结论", async () => {
  let writes = 0;
  let serverName = PROFILE.displayName;
  let serverUpdatedAt = PROFILE.updatedAt;
  const view = mount(ProfileView, profileProps({
    load: async () => ({ ...PROFILE, displayName: serverName, updatedAt: serverUpdatedAt }),
    saveDisplayName: async () => {
      writes += 1;
      throw networkError();
    },
  }));
  await settle();
  await type(view, input(view), "新名字");
  await click(buttonByText(view, "保存显示名称"));
  await settle(80);
  assert.equal(writes, 1, "未知态绝不自动重发");
  assert.ok(byText(view, "未收到明确结果"), text(view));

  serverName = "新名字";
  await click(buttonByText(view, "核对当前资料"));
  await settle(60);
  // 同名提交无副作用、updatedAt 未变 → 只能表达当前事实。
  assert.ok(byText(view, "无法据此确认原请求是否执行"), text(view));
  assert.doesNotMatch(text(view), /已保存成功/);
  assert.equal(writes, 1, "核对是只读动作");

  // 更新时间可能来自其他修改，同样不证明原请求。
  serverUpdatedAt = "2026-10-15T00:00:00.000Z";
  await click(buttonByText(view, "核对当前资料"));
  await settle(60);
  assert.ok(byText(view, "无法据此确认原请求是否执行"), text(view));
  assert.equal(writes, 1, "两次核对仍不触发任何写");
  view.unmount();
});

test("profile: 400 保留输入并说明拒绝；5xx 归入未知态；缺写回调时禁用并说明", async () => {
  const view = mount(ProfileView, profileProps({ saveDisplayName: () => Promise.reject(rejectedError()) }));
  await settle();
  await type(view, input(view), "新名字");
  await click(buttonByText(view, "保存显示名称"));
  await settle(60);
  assert.ok(byText(view, "保存被拒绝"), text(view));
  assert.equal(input(view).value, "新名字", "拒绝后输入保留以便修正");
  view.unmount();

  const offline = mount(ProfileView, { adminUserId: PROFILE.adminUserId, sessionId: "s", accountStatus: "ACTIVE", locked: false, load: async () => ({ ...PROFILE }) });
  await settle();
  assert.ok(byText(offline, "暂未开放"), "缺写合同必须说明而不是摆出必然失败的按钮");
  assert.equal(buttonByText(offline, "保存显示名称").disabled, true);
  assert.equal(input(offline).disabled, true);
  offline.unmount();
});

test("profile: 提交中重复点击只发一次；冻结禁用写", async () => {
  const gate = deferred();
  let writes = 0;
  const view = mount(ProfileView, profileProps({
    saveDisplayName: () => {
      writes += 1;
      return gate.promise;
    },
  }));
  await settle();
  await type(view, input(view), "新名字");
  await click(buttonByText(view, "保存显示名称"));
  assert.ok(buttonByText(view, "保存中…"));
  await click(buttonByText(view, "保存中…"));
  assert.equal(writes, 1);
  gate.resolve({ status: true, profile: { ...PROFILE, displayName: "新名字" } });
  await settle(60);

  const frozen = mount(ProfileView, profileProps({ accountStatus: "FROZEN" }));
  await settle();
  assert.ok(byText(frozen, "账号已冻结"));
  assert.ok(!buttonByText(frozen, "保存显示名称"));
  view.unmount();
  frozen.unmount();
});

test("profile: 切身份后旧响应不得落到新身份", async () => {
  const gate = deferred();
  let first = true;
  const load = () => {
    if (first) {
      first = false;
      return gate.promise;
    }
    return Promise.resolve({ ...PROFILE, adminUserId: "admin_new", zzNumber: "ZZ-NEW", displayName: "新同事" });
  };
  const view = mount(ProfileView, { adminUserId: PROFILE.adminUserId, sessionId: "s", accountStatus: "ACTIVE", locked: false, load });
  await settle();
  view.rerender({ adminUserId: "admin_new", sessionId: "s", accountStatus: "ACTIVE", locked: false, load });
  await settle();
  gate.resolve(PROFILE);
  await settle(60);
  assert.ok(byText(view, "ZZ-NEW"), text(view));
  assert.ok(!byText(view, "ZZ00001"), "旧身份的迟到响应必须被隔离");
  view.unmount();
});

// ---------------------------------------------------------------------------
// B. 设备与会话
// ---------------------------------------------------------------------------

const SESSIONS_BODY = {
  sessions: [
    { id: "session_fixture_current", isCurrent: true, createdAt: "2026-10-14T01:00:00.000Z", expiresAt: "2026-10-21T01:00:00.000Z", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", locked: false },
    { id: "session_fixture_other", isCurrent: false, createdAt: "2026-10-10T08:00:00.000Z", expiresAt: "2026-10-17T08:00:00.000Z", userAgent: null, locked: true },
  ],
};
const REVOKE_OK = { status: true, revokedSessionCount: 1 };

const sessionProps = (extra) => ({
  adminUserId: "admin_fixture_0001",
  sessionId: "session_fixture_current",
  accountStatus: "ACTIVE",
  locked: false,
  load: async () => structuredClone(SESSIONS_BODY),
  revokeSession: async () => ({ ...REVOKE_OK }),
  revokeOtherSessions: async () => ({ status: true, revokedSessionCount: 1 }),
  ...extra,
});

test("sessions: 当前会话不给注销入口；UA 缺失显示未提供；锁态如实标注", async () => {
  const view = mount(SessionsView, sessionProps());
  await settle();
  assert.ok(byText(view, "当前会话"));
  assert.equal(buttons(view).filter((node) => (node.textContent ?? "").includes("注销该会话")).length, 1, "只有非当前会话提供注销");
  assert.ok(buttonByText(view, "退出其他设备（1）"));
  assert.ok(byText(view, "不是设备清单"), "必须说明会话与设备的关系");
  assert.ok(byText(view, "已锁屏"), "locked=true 应显示锁态");
  assert.ok(byText(view, "Mozilla/5.0"), "UA 作为原始字符串展示");
  assert.ok(byText(view, "未提供"), "UA 为 null 时显示未提供而不是猜测");
  assert.ok(!byText(view, "来源 IP"), "合同不返回 IP，界面也不得出现");
  assert.ok(!byText(view, "最近活跃"), "合同明确最近活跃不可得");
  view.unmount();
});

test("sessions: 只有一个当前会话时表达没有其他会话，而不是整页空态", async () => {
  const view = mount(SessionsView, sessionProps({ load: async () => ({ sessions: [SESSIONS_BODY.sessions[0]] }) }));
  await settle();
  assert.ok(byText(view, "没有其他会话。"), text(view));
  assert.ok(!buttonByText(view, "退出其他设备"), "空集合不得提供批量写");
  view.unmount();
});

test("sessions: 取消确认零请求；确认后只注销该会话并重读列表", async () => {
  const revoked = [];
  let reads = 0;
  const view = mount(SessionsView, sessionProps({
    revokeSession: ({ sessionId }) => {
      revoked.push(sessionId);
      return Promise.resolve({ ...REVOKE_OK });
    },
    load: async () => {
      reads += 1;
      return structuredClone(SESSIONS_BODY);
    },
  }));
  await settle();
  await click(buttonByText(view, "注销该会话"));
  assert.ok(dialog(view));
  await click(dialogButton(view, "取消"));
  assert.equal(revoked.length, 0, "取消不得发出请求");
  assert.equal(dialog(view), null);

  await click(buttonByText(view, "注销该会话"));
  await confirmRevoke(view);
  await settle(60);
  assert.deepEqual(revoked, ["session_fixture_other"], "只允许注销非当前会话");
  assert.equal(reads, 2, "成功后以服务端列表为准重新读取");
  assert.ok(byText(view, "已确认注销该会话"), text(view));
  assert.ok(byText(view, "当前列表需另行读取确认"), "历史完成结论与当前列表读回分开表述");
  assert.ok(!byText(view, "处理中…"), "撤销完成后行级 pending 必须清零");
  assert.equal(buttonByText(view, "退出其他设备").disabled, false, "重读推进序号后不得把动作永久禁用");
  view.unmount();
});

test("sessions: 批量撤销结论只覆盖本次确认集合", async () => {
  const view = mount(SessionsView, sessionProps({ revokeOtherSessions: async () => ({ status: true, revokedSessionCount: 1 }) }));
  await settle();
  await click(buttonByText(view, "退出其他设备"));
  assert.match(dialog(view).textContent, /当前会话保留/);
  await confirmRevoke(view);
  await settle(60);
  assert.ok(byText(view, "本次选择的 1 个有效会话"), text(view));
  assert.ok(byText(view, "此后新登录的会话不在该结论范围内"));
  view.unmount();
});

test("sessions: 响应丢失不本地删行、不自动重发；读回后目标已不在则判定达成", async () => {
  let writes = 0;
  let revoked = false;
  const view = mount(SessionsView, sessionProps({
    revokeSession: () => {
      writes += 1;
      return Promise.reject(networkError());
    },
    load: async () => {
      // 读回时目标已消失：模拟撤销其实已生效。
      return revoked ? { sessions: [SESSIONS_BODY.sessions[0]] } : structuredClone(SESSIONS_BODY);
    },
  }));
  await settle();
  await click(buttonByText(view, "注销该会话"));
  await confirmRevoke(view);
  await settle(60);
  assert.equal(writes, 1, "未知态绝不自动重发");
  assert.ok(byText(view, "无法确认"), text(view));
  assert.ok(byText(view, "列表未做本地改动"));
  assert.equal(buttons(view).filter((node) => (node.textContent ?? "").includes("注销该会话")).length, 1, "原行仍在");

  revoked = true;
  await click(buttonByText(view, "重新读取列表"));
  await settle(60);
  assert.ok(byText(view, "已不在本人有效会话列表中"), text(view));
  assert.match(text(view), /已撤销、已过期或本就无效/);
  assert.equal(writes, 1, "核对只读，不重发撤销");
  view.unmount();
});

test("sessions: 读回后目标仍在列表时不推断原请求终态", async () => {
  const view = mount(SessionsView, sessionProps({
    revokeSession: () => Promise.reject(networkError()),
  }));
  await settle();
  await click(buttonByText(view, "注销该会话"));
  await confirmRevoke(view);
  await settle(60);
  await click(buttonByText(view, "重新读取列表"));
  await settle(60);
  assert.ok(byText(view, "原请求结果仍无法确认"), text(view));
  view.unmount();
});

test("sessions: 404 后以列表核实目标已不在；409 当前会话保护给出登出指引", async () => {
  let removed = false;
  const gone = mount(SessionsView, sessionProps({
    revokeSession: () => { removed = true; return Promise.reject(notFoundError()); },
    load: async () => ({ sessions: removed ? [SESSIONS_BODY.sessions[0]] : SESSIONS_BODY.sessions }),
  }));
  await settle();
  await click(buttonByText(gone, "注销该会话"));
  await confirmRevoke(gone);
  await settle(60);
  assert.ok(byText(gone, "已不在本人有效会话列表中"), text(gone));
  assert.ok(!byText(gone, "重新读取列表"), "404 已是明确结论，不诱导重放");
  gone.unmount();

  const protectedSelf = mount(SessionsView, sessionProps({ revokeSession: () => Promise.reject(conflictError()) }));
  await settle();
  await click(buttonByText(protectedSelf, "注销该会话"));
  await confirmRevoke(protectedSelf);
  await settle(60);
  assert.ok(byText(protectedSelf, "当前登录会话"), text(protectedSelf));
  assert.ok(byText(protectedSelf, "登出流程"));
  protectedSelf.unmount();
});

test("sessions: 撤销信封不合法时按合同异常，不当成成功", async () => {
  const view = mount(SessionsView, sessionProps({ revokeSession: async () => ({ status: true }) }));
  await settle();
  await click(buttonByText(view, "注销该会话"));
  await confirmRevoke(view);
  await settle(60);
  assert.ok(byText(view, "revokedSessionCount"), text(view));
  assert.ok(!byText(view, "已确认注销"), "合同异常不得显示为成功");
  view.unmount();
});

test("sessions: 处理中互斥；未标记当前会话时禁用全部注销；空列表按异常处理", async () => {
  const gate = deferred();
  const mutex = mount(SessionsView, sessionProps({
    load: async () => ({ sessions: [...structuredClone(SESSIONS_BODY).sessions, { ...SESSIONS_BODY.sessions[1], id: "s-third" }] }),
    revokeSession: () => gate.promise,
  }));
  await settle();
  const targets = buttons(mutex).filter((node) => (node.textContent ?? "").includes("注销该会话"));
  assert.equal(targets.length, 2);
  await click(targets[0]);
  await confirmRevoke(mutex);
  assert.ok(byText(mutex, "处理中…"), text(mutex));
  assert.ok(buttons(mutex).filter((node) => (node.textContent ?? "").includes("注销该会话")).every((node) => node.disabled), "并发注销会改变目标集合，必须互斥");
  assert.ok(buttonByText(mutex, "退出其他设备").disabled);
  gate.resolve({ ...REVOKE_OK });
  await settle(60);
  mutex.unmount();

  const unmarked = mount(SessionsView, sessionProps({ load: async () => ({ sessions: [{ ...SESSIONS_BODY.sessions[1] }] }) }));
  await settle();
  assert.ok(byText(unmarked, "未标记当前会话"), text(unmarked));
  assert.ok(buttons(unmarked).filter((node) => (node.textContent ?? "").includes("注销该会话")).every((node) => node.disabled));
  unmarked.unmount();

  const empty = mount(SessionsView, sessionProps({ load: async () => ({ sessions: [] }) }));
  await settle();
  assert.ok(byText(empty, "包括当前会话"), "已登录却读到空列表属异常，不能显示成没有会话");
  empty.unmount();
});

test("sessions: 缺少写合同时只读展示并说明；合同异常保留为失败", async () => {
  const offline = mount(SessionsView, { adminUserId: "a", sessionId: "session_fixture_current", accountStatus: "ACTIVE", locked: false, load: async () => structuredClone(SESSIONS_BODY) });
  await settle();
  assert.ok(byText(offline, "尚未接入"), text(offline));
  assert.ok(buttons(offline).filter((node) => (node.textContent ?? "").includes("注销该会话")).every((node) => node.disabled));
  offline.unmount();

  const bad = mount(SessionsView, sessionProps({ load: async () => ({ sessions: [{ id: "s-1", userAgent: null }] }) }));
  await settle();
  assert.ok(byText(bad, "不符合本人设置合同"), text(bad));
  assert.ok(buttonByText(bad, "重新读取"));
  bad.unmount();
});

test("sessions: 切身份后旧响应不落新身份", async () => {
  const gate = deferred();
  let first = true;
  const load = () => {
    if (first) {
      first = false;
      return gate.promise;
    }
    return Promise.resolve({ sessions: [{ ...SESSIONS_BODY.sessions[0], id: "sess_new", userAgent: "Edge/141" }] });
  };
  const view = mount(SessionsView, { adminUserId: "a1", sessionId: "sess_old", accountStatus: "ACTIVE", locked: false, load, revokeSession: async () => ({ ...REVOKE_OK }) });
  await settle();
  view.rerender({ adminUserId: "a2", sessionId: "sess_new", accountStatus: "ACTIVE", locked: false, load, revokeSession: async () => ({ ...REVOKE_OK }) });
  await settle();
  gate.resolve(structuredClone(SESSIONS_BODY));
  await settle(60);
  assert.ok(byText(view, "Edge/141"), text(view));
  assert.ok(!byText(view, "Mozilla/5.0"), "旧身份的会话投影必须清理");
  view.unmount();
});

// ---------------------------------------------------------------------------
// C. 本人安全活动
// ---------------------------------------------------------------------------

const COVERAGE = { scope: "SELF_SECURITY_ACTIVITY", recordedActions: ["admin.password.changed", "admin.frozen"], notRecorded: ["sign_in", "sign_out"] };
const event = (id, overrides = {}) => ({
  eventId: id,
  occurredAt: "2026-10-14T02:00:00.000Z",
  action: "admin.password.changed",
  category: "credential",
  outcome: "SUCCESS",
  reason: null,
  actor: { kind: "self", ref: null },
  details: {},
  requestId: `req_${id}`,
  ...overrides,
});

function activityHarness(pages) {
  const calls = [];
  let index = 0;
  return {
    calls,
    load: (input) => {
      calls.push(input);
      const next = typeof pages === "function" ? pages(index, input) : pages[Math.min(index, pages.length - 1)];
      index += 1;
      return typeof next === "function" ? next(input) : Promise.resolve(structuredClone(next));
    },
  };
}

const activityProps = (extra) => ({
  adminUserId: "admin_fixture_0001",
  sessionId: "sess-1",
  accountStatus: "ACTIVE",
  locked: false,
  ...extra,
});

test("activity: 首次读取渲染真实事件；有下一页时不显示已读到底", async () => {
  const h = activityHarness([
    { events: [event("e1")], nextCursor: "C1", coverage: COVERAGE },
    { events: [event("e2", { action: "admin.frozen", actor: { kind: "other", ref: "ZZ00002" } })], nextCursor: null, coverage: COVERAGE },
  ]);
  const view = mount(ActivityView, activityProps({ load: h.load }));
  await settle();
  assert.ok(byText(view, "登录密码已修改"), text(view));
  assert.ok(byText(view, "本人发起"));
  assert.ok(!byText(view, "admin.password.changed"), "正文不展示原始动作码");
  assert.ok(view.el.querySelector('[title="admin.password.changed"]'), "原码仅保留在悬停提示");
  assert.ok(view.el.querySelector('[aria-label="复制请求编号"]'), "请求编号收进复制图标");
  assert.ok(!byText(view, "请求编号 req_e1"), "正文不平铺请求编号");
  assert.ok(!byText(view, "当前查询没有更多记录"), "分页未完时不得显示终点");
  assert.equal(buttonByText(view, "上一页").disabled, true);
  assert.equal(buttonByText(view, "下一页").disabled, false);

  await click(buttonByText(view, "下一页"));
  assert.equal(h.calls[1].cursor, "C1", "下一页必须带服务端返回的游标");
  await settle();
  assert.ok(byText(view, "第 2 页"));
  assert.ok(byText(view, "由 ZZ00002 对本人账号执行"), "他人操作不得写成本人");
  assert.ok(!byText(view, "当前查询没有更多记录"), "不再显示冗余终点提示");
  assert.equal(buttonByText(view, "下一页").disabled, true);
  view.unmount();
});

test("activity: 覆盖范围披露如实呈现，不估算登录历史", async () => {
  const h = activityHarness([{ events: [event("e1")], nextCursor: null, coverage: COVERAGE }]);
  const view = mount(ActivityView, activityProps({ load: h.load }));
  await settle();
  assert.ok(byText(view, "未纳入记录：登录、退出登录"), text(view));
  assert.ok(!byText(view, "最后登录"), "不存在的数据不得出现在界面上");
  view.unmount();
});

test("activity: 筛选值来自服务端 coverage，草稿与应用分离", async () => {
  const h = activityHarness([{ events: [event("e1")], nextCursor: null, coverage: COVERAGE }]);
  const view = mount(ActivityView, activityProps({ load: h.load }));
  await settle();
  assert.ok(view.el.querySelector('[aria-label="事件类型筛选"]'), "首次读取成功后应出现事件类型筛选");
  assert.ok(byText(view, "全部事件类型"), "触发器默认展示全部");
  assert.ok(!byText(view, "应用筛选"), "筛选即选即用，不再需要应用按钮");
  view.unmount();

  // 已提交筛选时给出「清除筛选」，提交动作才把 action 变化发给后端。
  const filtered = activityHarness([{ events: [event("e1")], nextCursor: null, coverage: COVERAGE }]);
  const second = mount(ActivityView, activityProps({ initialQuery: { action: "admin.frozen" }, load: filtered.load }));
  await settle();
  assert.equal(filtered.calls[0].action, "admin.frozen", "进入页面即按已提交筛选读取");
  assert.ok(buttonByText(second, "清除筛选"));
  await click(buttonByText(second, "清除筛选"));
  assert.equal(filtered.calls[1].action, "", "清除后才提交空筛选");
  second.unmount();
});

test("activity: 真实空列表与筛选无结果分别表达", async () => {
  const empty = mount(ActivityView, activityProps({ load: async () => ({ events: [], nextCursor: null, coverage: COVERAGE }) }));
  await settle();
  assert.ok(byText(empty, "暂无可展示的安全活动"), text(empty));
  assert.ok(byText(empty, "不等于历史已清空"));
  empty.unmount();

  const filtered = mount(ActivityView, activityProps({
    initialQuery: { action: "admin.frozen" },
    load: async () => ({ events: [], nextCursor: null, coverage: COVERAGE }),
  }));
  await settle();
  assert.ok(byText(filtered, "当前筛选没有匹配记录"), text(filtered));
  assert.ok(byText(filtered, "事件类型：账号被冻结"), "无结果状态必须回显生效条件");
  assert.ok(buttonByText(filtered, "清除筛选"));
  filtered.unmount();
});

test("activity: 同查询刷新失败保留旧数据并标注为旧", async () => {
  const h = activityHarness([
    { events: [event("e1"), event("e2", { eventId: "e2" })], nextCursor: null, coverage: COVERAGE },
    () => Promise.reject(serverError()),
  ]);
  const view = mount(ActivityView, activityProps({ load: h.load }));
  await settle();
  assert.equal(rows(view).length, 2);
  await click(buttonByText(view, "重新读取"));
  await settle(60);
  assert.equal(rows(view).length, 2, "刷新失败必须保留上一次读到的事实");
  assert.ok(byText(view, "旧数据"), text(view));
  assert.ok(byText(view, "刷新失败，下方仍是上一次成功读取到的结果"));
  view.unmount();
});

test("activity: 换查询失败不串旧数据，重试绑定实际失败的那一页", async () => {
  const h = activityHarness([
    { events: [event("e1")], nextCursor: "C1", coverage: COVERAGE },
    () => Promise.reject(serverError()),
    { events: [event("e9", { eventId: "e9" })], nextCursor: null, coverage: COVERAGE },
  ]);
  const view = mount(ActivityView, activityProps({ load: h.load }));
  await settle();
  await click(buttonByText(view, "下一页"));
  await settle(60);
  assert.equal(rows(view).length, 0, "第 2 页失败不得沿用第 1 页数据");
  assert.ok(byText(view, "服务暂时无法完成请求"), text(view));
  assert.ok(!byText(view, "旧数据"), "非刷新失败不标注旧数据");
  await click(buttonByText(view, "重试本次查询"));
  assert.equal(h.calls[2].cursor, "C1", "重试必须重放到失败的那一页游标");
  await settle(60);
  assert.ok(byText(view, "第 2 页"));
  view.unmount();
});

test("activity: 403 清空数据；后续 5xx 与恢复分别表达", async () => {
  let mode = "ok";
  const view = mount(ActivityView, activityProps({
    load: () => {
      if (mode === "403") return Promise.reject(forbiddenError());
      if (mode === "other") return Promise.reject(serverError());
      return Promise.resolve({ events: [event("e1")], nextCursor: null, coverage: COVERAGE });
    },
  }));
  await settle();
  assert.equal(rows(view).length, 1);

  mode = "403";
  await click(buttonByText(view, "重新读取"));
  await settle(60);
  assert.ok(byText(view, "无权读取本人安全活动"), text(view));
  assert.equal(rows(view).length, 0, "失权后旧数据必须清空");
  assert.ok(!byText(view, "旧数据"), "403 不走保留旧数据分支");

  mode = "other";
  await click(buttonByText(view, "重新读取"));
  await settle(60);
  assert.ok(byText(view, "服务暂时无法完成请求"), "刷新失败必须单独可见");
  assert.ok(byText(view, "无权读取本人安全活动"), "没有新的权威读取结果时，上一次 403 结论不被悄悄抹掉");

  mode = "ok";
  await click(buttonByText(view, "重新读取"));
  await settle(60);
  assert.equal(rows(view).length, 1, "恢复后按当前身份重新显示");
  assert.ok(!byText(view, "无权读取"));
  view.unmount();
});

test("activity: 合同异常与未知枚举都不当成功；原始 details 不透传", async () => {
  const h = activityHarness([
    {
      events: [event("e1", { details: { revokedSessionCount: 2, commandId: "idem_secret" }, reason: "岗位调整" })],
      nextCursor: null,
      coverage: COVERAGE,
    },
    { events: [{ ...event("e2"), outcome: "PARTIAL" }], nextCursor: null, coverage: COVERAGE },
    { events: [event("e3")], coverage: COVERAGE },
  ]);
  const view = mount(ActivityView, activityProps({ load: h.load }));
  await settle();
  assert.ok(byText(view, "注销会话数：2"), text(view));
  assert.ok(byText(view, "原因：岗位调整"));
  assert.ok(!byText(view, "idem_secret"), "命令标识等未列入白名单的 details 不得出现");

  await click(buttonByText(view, "重新读取"));
  await settle(60);
  assert.ok(byText(view, "outcome 不是 SUCCESS/FAILURE"), text(view));
  assert.equal(rows(view).length, 1, "合同异常按刷新失败处理：保留上一次读到的事实");
  assert.ok(byText(view, "旧数据"));

  await click(buttonByText(view, "重新读取"));
  await settle(60);
  assert.ok(byText(view, "缺少 nextCursor"), "缺游标不能当成已到底");
  view.unmount();
});

test("activity: 切身份清空投影并隔离旧响应", async () => {
  const gate = deferred();
  let first = true;
  const load = () => {
    if (first) {
      first = false;
      return gate.promise;
    }
    return Promise.resolve({ events: [], nextCursor: null, coverage: COVERAGE });
  };
  const view = mount(ActivityView, activityProps({ load }));
  await settle();
  view.rerender(activityProps({ adminUserId: "admin_other", load }));
  await settle();
  gate.resolve({ events: [event("old")], nextCursor: null, coverage: COVERAGE });
  await settle(60);
  assert.equal(rows(view).length, 0, "旧身份迟到响应不得落到新身份");
  view.unmount();
});

test("sessions: 设备解析、脚本标记、IP 脱敏与地区、最近活跃与「N 天后过期」", async () => {
  const now = Date.now();
  const body = { sessions: [
    { id: "session_fixture_current", isCurrent: true, createdAt: new Date(now - 3600e3).toISOString(), expiresAt: new Date(now + 7 * 86400e3 + 60e3).toISOString(), userAgent: "Mozilla/5.0 Chrome/141", locked: false, ipAddress: "10.0.0.8", ipMasked: false, region: "本机/内网", lastActiveAt: new Date(now - 60e3).toISOString(), client: { label: "Chrome 141 · Windows 10/11", isScript: false, deviceType: "desktop" } },
    { id: "session_script", isCurrent: false, createdAt: new Date(now - 7200e3).toISOString(), expiresAt: new Date(now + 3 * 86400e3 + 60e3).toISOString(), userAgent: "node", locked: false, ipAddress: "203.0.*.*", ipMasked: true, region: "广东省 深圳市 · 电信", lastActiveAt: null, client: { label: "脚本/非浏览器客户端 (node)", isScript: true, deviceType: "script" } },
  ] };
  const view = mount(SessionsView, sessionProps({ load: async () => structuredClone(body) }));
  try {
    await settle();
    assert.ok(byText(view, "Chrome 141 · Windows 10/11"));
    assert.ok(byText(view, "7 天后过期") && byText(view, "3 天后过期"), text(view));
    assert.ok(byText(view, "最近活跃") && byText(view, "刚刚"));
    assert.ok(byText(view, "203.0.*.*") && byText(view, "广东省 深圳市 · 电信"));
    assert.equal(view.el.querySelectorAll('[aria-label="复制会话引用"]').length, 2);
    assert.ok(!byText(view, "会话引用 session_script"), "会话引用不直接铺在正文里");
    assert.ok([...view.el.querySelectorAll("span,div")].some((n) => n.textContent === "脚本/非浏览器客户端"), "node UA 必须标记");
    await click(buttonByText(view, "注销该会话"));
    assert.equal(dialogButton(view, "确认注销").disabled, true, "未填密码与动态码不得提交");
  } finally { view.unmount(); }
});
