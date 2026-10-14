import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(tree, "package.json"));
const React = require("react");
const { Window } = require("happy-dom");
const ts = require("typescript");
const compiled = ts.transpileModule(fs.readFileSync(path.join(tree, "apps/web/src/components/supply-workspaces.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
class ProbeWebAuthError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const profileReply = (userId) => ({ user: { id: userId, username: `PRIVATE_${userId}`, phoneNumber: "13800138000" } });
const identityReply = (identityStatus = "VERIFIED") => ({ accountStatus: "ACTIVE", identityStatus, ageStatus: "ADULT", provider: "none", eligibleForProtectedTrade: false });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function probe({ rows = [], detail = null, identityStatus = "UNVERIFIED", authRead, confirm = () => false, writeReply, pages = null, mine = null, viaFetch = null } = {}) {
  const window = new Window({ url: "http://127.0.0.1:3100/account" });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, CustomEvent: window.CustomEvent, FocusEvent: window.FocusEvent, DOMException: window.DOMException, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  // Base UI AlertDialog（t2 交付的真实依赖，非桩）所需的最小环境。
  const PreviousResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // F1-t/F2：滚动恢复与请求轨迹都是真实断言面，不再用空实现吞掉。
  const scrollToCalls = [];
  window.scrollTo = (...args) => { scrollToCalls.push(args); };
  window.confirm = confirm;
  const session = { status: "authenticated", userId: "user_A", identityVersion: 1, revalidations: 0, revalidate() { this.revalidations += 1; } };
  const identityListeners = new Set();
  const store = { getSnapshot: () => session, subscribe: (listener) => { identityListeners.add(listener); return () => identityListeners.delete(listener); } };
  const router = { replace() {}, push() {} };
  let writes = 0;
  const calls = { myAccounts: [], mine: [], fetch: [] };
  let pageCursor = 0;
  const previousFetch = globalThis.fetch;
  // viaFetch：走真实 supply-client（含 myAccountsQuery 归一），在传输层拦截，请求不得到达真实 API。
  if (viaFetch) globalThis.fetch = async (url, init) => { calls.fetch.push(String(url)); return viaFetch(String(url), init); };
  const module = new Module(path.join(tree, "account-module-probe.cjs"));
  module.filename = path.join(tree, "account-module-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    // supply-workspaces.tsx 现在带列表 CSS 副作用导入（my-rental-accounts.css），探针按仓库既有约定桩掉。
    if (name.endsWith(".css")) return {};
    if (name === "next/link") return ({ scroll: _scroll, ...props }) => React.createElement("a", props);
    if (name === "next/navigation") return { useRouter: () => router };
    if (name === "./auth/auth-overlay-provider") return { useAuthOverlay: () => ({ open() {} }) };
    // This suite probes the parent's read permission; the real security control has its own React suite.
    if (name === "./account/account-security-controls") return { AccountSecurityControls: ({ userId, canAct }) => canAct() ? React.createElement("p", null, `PRIVATE_${userId} 138****8000`) : null };
    if (name === "./account/personal-wallet") return { PersonalWallet: () => null };
    if (name === "./account/personal-invitations") return { PersonalInvitations: () => null };
    if (name === "./account/credit-center") return { CreditCenter: () => null };
    if (name === "@heroui/react") return { Chip: ({ children }) => React.createElement("span", null, children) };
    if (name === "./session/user-session-provider") return { useUserSession: () => session, useUserSessionStore: () => store, publishUserSessionChange() {} };
    if (name === "./layout/service-shell") return { ServiceShell: ({ children }) => React.createElement("main", null, children) };
    if (name === "./auth/auth-form") return {
      AuthForm: () => null,
      WebAuthError: ProbeWebAuthError,
      maskPhone: () => "138****8000",
      webAuthRequest: async (route, body, signal) => {
        if (body) { writes += 1; if (writeReply) return writeReply(route, body); throw new Error("writes are not part of this UI probe"); }
        if (authRead) return authRead(route, session, signal);
        return route === "/get-session" ? { user: { id: "user_A", username: "legacy_login", phoneNumber: "13800138000" } } : { accountStatus: "ACTIVE", identityStatus, ageStatus: "UNKNOWN", provider: "none", eligibleForProtectedTrade: false };
      },
    };
    if (name === "@/app/user-account-status") return require(path.join(tree, "apps/web/src/app/user-account-status.ts"));
    if (name === "./favorites/favorites-panel") return { FavoritesPanel: () => null };
    if (name === "./supply/skin-media-thumb") return { SkinMediaThumb: () => null };
    if (name === "./favorites/favorites-context") return { FavoritesProvider: ({ children }) => children };
    if (name === "./order/legacy-order-workspace") return { LegacyOrderWorkspace: () => null };
    if (name === "./order/order-workspace") return { OrderWorkspace: () => null };
    if (name === "./account/account-center") return {
      AccountCenterFrame: ({ children }) => children,
      AccountOverview: () => null,
      resolveAccountView: (view) => view || "overview",
      accountSectionLabels: { wallet: "我的钱包", invite: "分销中心", credit: "信用与保证金" },
      accountViewTitle: (view) => ({ overview: "总览", membership: "会员中心", favorites: "我的收藏", rentals: "租入订单", leased: "出租订单", accounts: "出租账号", wallet: "我的钱包", credit: "信用与保证金", invite: "邀请与佣金", identity: "实名认证", security: "账号安全" }[view] ?? "总览"),
    };
    // 当前网络信息卡有专属用例（network-info），本套只桩掉渲染。
    if (name === "./account/network-info") return { NetworkInfoPanel: () => null, CurrentNetworkFields: () => null };
    // 注销确认弹窗用真实 Base UI AlertDialog（t2 交付的 ui/alert-dialog），不桩掉。
    if (name === "./ui/alert-dialog") {
      const alertPath = path.join(tree, "apps/web/src/components/ui/alert-dialog.tsx");
      const child = new Module(alertPath);
      child.filename = alertPath; child.paths = Module._nodeModulePaths(path.dirname(alertPath));
      child.require = (request) => { if (request.endsWith(".css")) return {}; return require(request); };
      child._compile(ts.transpileModule(fs.readFileSync(alertPath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, alertPath);
      return child.exports;
    }
    if (name === "../lib/supply-client") {
      const actual = require(path.join(tree, "apps/web/src/lib/supply-client.ts"));
      // viaFetch：不桩 supplyApi，走真实客户端（URL 由 myAccountsQuery 归一）到传输层拦截器。
      if (viaFetch) return actual;
      return { ...actual, supplyApi: {
        myAccounts: async (query) => {
          calls.myAccounts.push(String(query ?? ""));
          if (typeof pages === "function") return pages(String(query ?? ""), calls.myAccounts.length);
          if (Array.isArray(pages)) { const page = pages[Math.min(pageCursor, pages.length - 1)]; pageCursor += 1; return page; }
          return { items: rows, nextCursor: null };
        },
        mine: async (accountId) => {
          calls.mine.push(accountId);
          if (mine) return mine(accountId);
          return detail ? { ...detail, account: { ...detail.account, id: accountId } } : detail;
        },
      } };
    }
    if (name.startsWith("../lib/")) return require(path.join(tree, "apps/web/src/lib", `${name.slice(7)}.ts`));
    return require(name);
  };
  module._compile(compiled, module.filename);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  const commits = [];
  return {
    host, session, commits, window, exports: module.exports, calls, scrollToCalls,
    get writes() { return writes; },
    // 共享会话变化（登录身份切换）与真实订阅同路径触发。
    sessionChange() { for (const listener of [...identityListeners]) listener(); },
    // 滚动/焦点恢复走 requestAnimationFrame（下一帧），探针里真实推进定时器后才能断言。
    async frames() { await new Promise(setImmediate); await new Promise((resolve) => setTimeout(resolve, 40)); },
    // Alert Dialog 弹层经 Portal 挂到 body（host 之外），查询与点击走 document。
    popup: () => window.document.querySelector('[data-slot="alert-dialog-content"]'),
    async clickDocButton(text) {
      const button = [...window.document.querySelectorAll("button")].find((item) => item.textContent === text);
      assert.ok(button, "doc button: " + text);
      await React.act(async () => { button.click(); });
      await new Promise(setImmediate);
    },
    async render(view, accountId) {
      await React.act(async () => { root.render(React.createElement(React.Profiler, { id: "account-module", onRender: () => commits.push(host.textContent) }, React.createElement(module.exports.AccountWorkspace, { view, accountId }))); });
      await new Promise(setImmediate);
    },
    async click(selector) {
      await React.act(async () => { host.querySelector(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    },
    captureHandler(selector) {
      const button = host.querySelector(selector);
      assert.ok(button, `missing action: ${selector}`);
      const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
      const handler = button[propsKey]?.onClick;
      assert.equal(typeof handler, "function");
      return async () => { await React.act(async () => { handler(); await new Promise(setImmediate); }); };
    },
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); globalThis.ResizeObserver = PreviousResizeObserver; if (viaFetch) globalThis.fetch = previousFetch; },
  };
}

test("empty account management has one publishing action and no duplicate detail pane", async () => {
  const p = await probe();
  try {
    await p.render("accounts");
    assert.equal(p.host.querySelectorAll("a[href='/publish']").length, 1);
    assert.equal(p.host.querySelector(".supply-account-detail"), null);
    assert.match(p.host.textContent, /审核进度与接单状态/);
    assert.doesNotMatch(p.host.textContent, /安全收取租金/);
  } finally { await p.close(); }
});

test("a submitted account detail links to its orders and offers withdrawal before editing", async () => {
  const rows = [{ id: "account_A", title: "账号A", game_name: "三角洲行动", review_state: "SUBMITTED", sequence: "1", owner_paused: false }];
  const detail = { account: { id: "account_A", revision: "1", owner_paused: false, staff_restricted: false }, version: { reviewState: "SUBMITTED", declaration: { title: "账号A", mediaBindings: [] } }, decisions: [], blockers: [] };
  const p = await probe({ rows, detail });
  try {
    await p.render("accounts", "account_A");
    assert.equal(p.host.querySelector(".supply-account-list"), null);
    assert.equal(p.host.querySelector(".account-record-links a").getAttribute("href"), "/account?view=leased&accountId=account_A");
    assert.equal(p.host.querySelector("a[href^='/publish?']"), null);
    assert.match(p.host.textContent, /撤回审核/);
    assert.match(p.host.textContent, /不代表订单收入或资金到账/);
  } finally { await p.close(); }
});

test("identity stays read-only and account safety does not duplicate age or bypass cancellation confirmation", async () => {
  const p = await probe({ identityStatus: "UNKNOWN" });
  try {
    await p.render("identity");
    assert.match(p.host.textContent, /实名状态暂无法确认/);
    assert.match(p.host.textContent, /线上实名服务暂未开放/);
    assert.equal(p.host.querySelector("input"), null);
    assert.doesNotMatch(p.host.textContent, /核验渠道|provider|fixture/);
    await p.render("security");
    assert.match(p.host.textContent, /138\*\*\*\*8000/);
    assert.doesNotMatch(p.host.textContent, /年龄状态|提交注销申请/);
    await p.click(".account-danger-zone button");
    assert.equal(p.writes, 0);
  } finally { await p.close(); }
});

test("security view keeps the destructive cancellation zone last", async () => {
  const p = await probe({ identityStatus: "UNKNOWN" });
  try {
    await p.render("security");
    const sections = [...p.host.querySelectorAll("section")];
    assert.ok(sections.length, "页面有分区");
    assert.equal(sections.at(-1).id, "account-cancellation", "注销区保持最底部，后面不再有普通模块");
    assert.ok(sections.at(-1).classList.contains("account-danger-zone"));
    assert.match(sections.at(-1).textContent, /注销账号/);
  } finally { await p.close(); }
});

for (const view of ["identity", "security"]) {
  test(`${view}: mismatched, null and 401 reads clear old data, block old actions, and can recover`, async () => {
    for (const failure of ["mismatch", "null", "session401", "identity401"]) {
      let phase = "ready";
      const p = await probe({ confirm: () => true, authRead: async (route, session) => {
        if (phase === "fail") {
          if (route === "/get-session") {
            if (failure === "mismatch") return profileReply("user_B");
            if (failure === "null") return null;
            if (failure === "session401") throw new ProbeWebAuthError(401, "UNAUTHENTICATED");
          } else if (failure === "identity401") throw new ProbeWebAuthError(401, "UNAUTHENTICATED");
        }
        return route === "/get-session" ? profileReply(session.userId) : identityReply();
      } });
      try {
        await p.render(view);
        const oldAction = view === "security" ? p.captureHandler(".account-danger-zone button") : null;
        phase = "fail";
        await p.click(".account-module-heading button");
        if (oldAction) await oldAction();
        assert.equal(p.writes, 0, failure);
        assert.equal(p.session.revalidations, 1, failure);
        assert.doesNotMatch(p.host.textContent, /PRIVATE_user_A|实名已验证/, failure);
        assert.equal(p.host.querySelector(".account-fact-list"), null, failure);
        assert.equal(p.host.querySelector(".account-danger-zone"), null, failure);
        phase = "ready";
        await p.click(".account-module-heading button");
        assert.match(p.host.textContent, view === "security" ? /PRIVATE_user_A/ : /实名已验证/);
        if (view === "security") {
          await p.click(".account-danger-zone button");
          await p.clickDocButton("确认注销");
          assert.equal(p.writes, 1, "a fresh consistent read must not remain permanently locked");
        }
      } finally { await p.close(); }
    }
  });

  test(`${view}: changed user or identity version hides old data at commit time and blocks pending actions`, async () => {
    for (const mode of ["delay", "failure", "version"]) {
      const pending = deferred();
      let phase = "A";
      const p = await probe({ confirm: () => true, authRead: async (route, session) => {
        if (route === "/get-session") {
          if (phase === "B") {
            if (mode === "failure") throw new Error("unavailable");
            return pending.promise;
          }
          return profileReply(session.userId);
        }
        return identityReply(phase === "A" ? "VERIFIED" : "UNVERIFIED");
      } });
      try {
        await p.render(view);
        const oldAction = view === "security" ? p.captureHandler(".account-danger-zone button") : null;
        phase = "B";
        p.session.userId = mode === "version" ? "user_A" : "user_B";
        p.session.identityVersion = 2;
        const previousCommits = p.commits.length;
        await p.render(view);
        assert.ok(p.commits.slice(previousCommits).every((commit) => !/PRIVATE_user_A|实名已验证/.test(commit)), mode);
        if (oldAction) await oldAction();
        assert.equal(p.writes, 0, mode);
        assert.equal(p.host.querySelector(".account-fact-list"), null, mode);
        assert.equal(p.host.querySelector(".account-danger-zone"), null, mode);
        if (mode !== "failure") {
          await React.act(async () => { pending.resolve(profileReply(p.session.userId)); await new Promise(setImmediate); });
          assert.match(p.host.textContent, view === "security" ? new RegExp(`PRIVATE_${p.session.userId}`) : /尚未验证/);
        }
      } finally { pending.resolve(null); await p.close(); }
    }
  });

  test(`${view}: a late old refresh cannot replace a newer consistent identity read`, async () => {
    const pendingA = deferred();
    let phase = "A";
    const p = await probe({ authRead: async (route, session) => {
      if (route === "/get-session") return phase === "A_DELAY" ? pendingA.promise : profileReply(session.userId);
      return identityReply(phase === "A" ? "VERIFIED" : "UNVERIFIED");
    } });
    try {
      await p.render(view);
      phase = "A_DELAY";
      await p.click(".account-module-heading button");
      phase = "B"; p.session.userId = "user_B"; p.session.identityVersion = 2;
      await p.render(view);
      await React.act(async () => { pendingA.resolve(profileReply("user_A")); await new Promise(setImmediate); });
      assert.doesNotMatch(p.host.textContent, /PRIVATE_user_A|实名已验证/);
      assert.match(p.host.textContent, view === "security" ? /PRIVATE_user_B/ : /尚未验证/);
    } finally { pendingA.resolve(null); await p.close(); }
  });
}

test("security rechecks the latest shared identity after the confirmation dialog before sending", async () => {
  const p = await probe({ writeReply: async () => ({ status: "CANCELLED" }) });
  try {
    await p.render("security");
    await p.click(".account-danger-zone button");
    assert.ok(p.popup(), "注销确认弹窗已打开");
    // 弹窗打开期间共享身份变化：确认提交时重新核对主体与资格，不得发送。
    p.session.userId = "user_B";
    p.session.identityVersion = 2;
    await p.clickDocButton("确认注销");
    assert.equal(p.writes, 0);
    assert.equal(p.popup(), null, "资格失效即关闭弹窗");
  } finally { await p.close(); }
});

test("security blocks the captured old handler while a same-user refresh is still pending", async () => {
  const pendingRead = deferred();
  let refreshing = false;
  const p = await probe({ confirm: () => true, authRead: async (route, session) => {
    if (route === "/get-session") return refreshing ? pendingRead.promise : profileReply(session.userId);
    return identityReply();
  } });
  try {
    await p.render("security");
    const oldAction = p.captureHandler(".account-danger-zone button");
    refreshing = true;
    await p.click(".account-module-heading button");
    await oldAction();
    assert.equal(p.writes, 0);
    assert.doesNotMatch(p.host.textContent, /PRIVATE_user_A/);
    assert.equal(p.host.querySelector(".account-fact-list"), null);
    await React.act(async () => { pendingRead.resolve(profileReply("user_A")); await new Promise(setImmediate); });
    await p.click(".account-danger-zone button");
    await p.clickDocButton("确认注销");
    assert.equal(p.writes, 1, "a valid refresh can restore the confirmed action");
  } finally { pendingRead.resolve(null); await p.close(); }
});

test("security revokes its confirmed read when the cancellation endpoint returns 401", async () => {
  const p = await probe({ confirm: () => true, authRead: async (route, session) => route === "/get-session" ? profileReply(session.userId) : identityReply(), writeReply: async () => { throw new ProbeWebAuthError(401, "UNAUTHENTICATED"); } });
  try {
    await p.render("security");
    const oldAction = p.captureHandler(".account-danger-zone button");
    await p.click(".account-danger-zone button");
    await p.clickDocButton("确认注销");
    assert.equal(p.writes, 1, "the only attempted request is intercepted by the local stub");
    assert.equal(p.session.revalidations, 1);
    assert.doesNotMatch(p.host.textContent, /PRIVATE_user_A/);
    assert.equal(p.host.querySelector(".account-fact-list"), null);
    await oldAction();
    assert.equal(p.writes, 1, "the revoked handler cannot send another request");
  } finally { await p.close(); }
});

test("security discards a cancellation response after the read scope has changed", async () => {
  const pendingWrite = deferred();
  let failRead = false;
  const p = await probe({ confirm: () => true, writeReply: () => pendingWrite.promise, authRead: async (route, session) => {
    if (failRead) throw new Error("unavailable");
    return route === "/get-session" ? profileReply(session.userId) : identityReply();
  } });
  try {
    await p.render("security");
    const oldAction = p.captureHandler(".account-danger-zone button");
    await p.click(".account-danger-zone button");
    await p.clickDocButton("确认注销");
    await oldAction();
    assert.equal(p.writes, 1, "the write is intercepted by a local stub");
    failRead = true; p.session.identityVersion = 2;
    await p.render("security");
    await React.act(async () => { pendingWrite.resolve({ status: "CANCELLED" }); await new Promise(setImmediate); });
    assert.doesNotMatch(p.host.textContent, /账号已注销|PRIVATE_user_A/);
    assert.equal(p.session.revalidations, 0);
  } finally { pendingWrite.resolve({ status: "CANCELLED" }); await p.close(); }
});

test("renter and owner each use one order workspace without source controls or engineering copy", async () => {
 const p=await probe();
 try{for(const view of ["rentals","leased"]){await p.render(view);assert.equal(p.host.querySelector(".order-source-nav"),null);assert.equal(p.host.querySelector('[data-testid="order-entry-transition-note"]'),null);assert.doesNotMatch(p.host.textContent,/当前订单|历史订单|统一入口尚未完成|旧平台|新平台/);}}finally{await p.close();}
});

test("注销确认走 Alert Dialog：取消不发写，确认只发一次，全程无 window.confirm", async () => {
  const p = await probe({ confirm: () => { throw new Error("window.confirm 不应被调用"); }, writeReply: async () => ({ status: "CANCELLED" }) });
  try {
    await p.render("security");
    // IM-09：模块级刷新入口带业务作用域标注。
    assert.equal(p.host.querySelector(".account-module-heading button").getAttribute("aria-label"), "刷新账号资料");
    await p.click(".account-danger-zone button");
    const popup = p.popup();
    assert.ok(popup, "弹窗已打开");
    assert.equal(popup.getAttribute("role"), "alertdialog", "真实 Alert Dialog 语义");
    assert.match(popup.textContent, /确认注销账号？/);
    assert.match(popup.textContent, /这与“退出登录”不同/, "注销与退出登录必须区分（引号统一为项目现行体系，IM-06）");
    assert.match(popup.textContent, /未完成订单/, "后果与未完成事项按正式合同表达");
    assert.ok([...popup.querySelectorAll("button")].some(button => button.textContent === "暂不注销"), "安全取消动作在场");
    assert.equal(p.writes, 0, "打开弹窗不产生写入");
    await p.clickDocButton("暂不注销");
    assert.equal(p.popup(), null, "取消关闭弹窗");
    assert.equal(p.writes, 0, "取消不发出注销写入");
    await p.click(".account-danger-zone button");
    await p.clickDocButton("确认注销");
    assert.equal(p.writes, 1, "确认只发出一次注销写入（window.confirm 探针未被触发）");
    assert.equal(p.popup(), null, "结果确定后弹窗关闭");
    assert.match(p.host.textContent, /账号已注销/);
  } finally { await p.close(); }
});

test("注销提交前重新核主体：弹窗期间共享身份变化则确认不发写", async () => {
  const p = await probe({ writeReply: async () => ({ status: "CANCELLED" }) });
  try {
    await p.render("security");
    await p.click(".account-danger-zone button");
    assert.ok(p.popup());
    p.session.userId = "user_B";
    p.session.identityVersion = 2;
    await p.clickDocButton("确认注销");
    assert.equal(p.writes, 0);
    assert.equal(p.popup(), null, "资格失效即关闭弹窗");
  } finally { await p.close(); }
});

test("注销未知结果不显示成功，普通状态刷新不解除未决意图", async () => {
  const p = await probe({ writeReply: async () => { throw new Error("network lost"); } });
  try {
    await p.render("security");
    await p.click(".account-danger-zone button");
    await p.clickDocButton("确认注销");
    assert.match(p.host.textContent, /注销结果尚未确认/);
    assert.doesNotMatch(p.host.textContent, /账号已注销/, "未知结果不得显示成功");
    assert.equal(p.popup(), null, "未知结果弹窗关闭，恢复责任留在页面");
    assert.equal(p.host.querySelector('[data-testid="cancel-account"]'), null, "入口被「刷新确认结果」取代，防盲重发");
    await p.click('[data-testid="cancel-refresh"]');
    assert.equal(p.writes, 1, "刷新只读取账号状态，不重发注销");
    assert.equal(Boolean(p.host.querySelector('[data-testid="cancel-account"]')), false, "普通ACTIVE读取不能证明原注销请求未提交");
  } finally { await p.close(); }
});

test("共享未决写互斥判定只读不改共享槽，且注销源码不再使用 window.confirm", async () => {
  const p = await probe();
  try {
    const { hasPendingSubjectWrite } = p.exports;
    const slot = { current: { userId: "user_A", intent: { action: "nickname", expected: "待确认昵称" }, accepted: false, target: "" } };
    const original = slot.current;
    assert.equal(hasPendingSubjectWrite(slot, "user_A"), true, "同主体任何未决写（昵称或安全设置）都互斥注销");
    assert.equal(hasPendingSubjectWrite(slot, "user_B"), false);
    assert.equal(hasPendingSubjectWrite(undefined, "user_A"), false);
    assert.equal(hasPendingSubjectWrite(slot, null), false);
    assert.equal(slot.current, original, "判定不覆盖、不清除、不重新生成共享意图");
    const source = fs.readFileSync(path.join(tree, "apps/web/src/components/supply-workspaces.tsx"), "utf8");
    assert.doesNotMatch(source, /window\.confirm/, "注销路径不再使用原生确认");
    assert.match(source, /ConfirmAlertDialog/, "接入正式 Alert Dialog");
  } finally { await p.close(); }
});

test("unknown cancellation survives tab navigation without resubmission", async () => {
 const p = await probe({writeReply: async () => { throw new Error("network lost"); }});
 try {
  await p.render("security"); await p.click(".account-danger-zone button"); await p.clickDocButton("确认注销");
  await p.render("overview"); await p.render("security");
  assert.match(p.host.textContent, /注销结果尚未确认/);
  assert.equal(Boolean(p.host.querySelector('[data-testid="cancel-account"]')), false);
  assert.equal(p.writes, 1);
 } finally { await p.close(); }
});

// ══ t4（2026-10-14）F1-t / F2 / 身份防线补测：真实请求 URL 带 after、第二页追加新记录、末页终止、错误重试、
//    往返恢复（滚动/焦点/游标/筛选）与迟到响应/401/403/404 撤销。所有请求均被 fixture/传输层拦截，不达真实 API。 ══
const accountRow = (id, extra = {}) => ({ id, title: `账号 ${id}`, game_name: "三角洲行动", review_state: "PUBLISHED", sequence: "1", owner_paused: false, staff_restricted: false, ...extra });
const detailOf = (id) => ({ account: { id, revision: "1", owner_paused: false, staff_restricted: false }, version: { reviewState: "PUBLISHED", declaration: { title: `账号 ${id}`, mediaBindings: [] } }, decisions: [], blockers: [] });
const rowIds = (p) => [...p.host.querySelectorAll("[data-account-row]")].map((node) => node.getAttribute("data-account-row"));
const { SupplyRequestError } = require(path.join(tree, "apps/web/src/lib/supply-client.ts"));

test("F1-t: /me/accounts 请求真的带 after（不是 cursor），第二页追加新记录并以短页终止", async () => {
  const pageOne = [accountRow("acc-A"), accountRow("acc-B")];
  const pageTwo = [accountRow("acc-C")];
  const p = await probe({ viaFetch: (url) => {
    const parsed = new URL(url, "http://127.0.0.1:3100");
    assert.equal(parsed.pathname, "/api/supply/me/accounts", "只允许列表只读请求到达传输层");
    return Response.json(parsed.searchParams.get("after") === null ? { items: pageOne, nextCursor: "acc-B" } : { items: pageTwo, nextCursor: null });
  } });
  try {
    await p.render("accounts");
    const first = new URL(p.calls.fetch[0], "http://127.0.0.1:3100");
    assert.equal(first.pathname, "/api/supply/me/accounts");
    assert.equal(first.searchParams.get("limit"), "50");
    assert.equal(first.searchParams.has("after"), false, "首页不带 after");
    assert.equal(first.searchParams.has("cursor"), false, "cursor 不是本合同参数");
    assert.deepEqual(rowIds(p), ["acc-A", "acc-B"]);
    assert.ok(p.host.querySelector(".mra-list-foot button"), "未到末页仍有加载更多");
    assert.equal(p.host.textContent.includes("已加载全部"), false, "未到末页不声称全部");
    await p.click(".mra-list-foot button");
    assert.equal(p.calls.fetch.length, 2);
    const second = new URL(p.calls.fetch[1], "http://127.0.0.1:3100");
    assert.equal(second.searchParams.get("after"), "acc-B", "第二页以上一页末 id 作为 after");
    assert.equal(second.searchParams.has("cursor"), false, "绝不能出现 cursor（/me/accounts 只读 after）");
    assert.deepEqual(rowIds(p), ["acc-A", "acc-B", "acc-C"], "第二页追加的是新记录，不是重复首页");
    assert.match(p.host.textContent, /已加载 3 个/);
    assert.match(p.host.textContent, /已加载全部 3 个/, "短页即末页，分页终止");
    assert.equal(p.host.querySelector(".mra-list-foot button"), null, "末页不再提供加载更多");
  } finally { await p.close(); }
});

test("F1-t: 续页失败保留已加载记录，错误重试仍用同一个 after，不重复首页", async () => {
  let failed = false;
  const afterValues = [];
  const p = await probe({ pages: (params) => {
    const after = new URLSearchParams(params).get("after");
    afterValues.push(after);
    if (after === null) return { items: [accountRow("acc-A"), accountRow("acc-B")], nextCursor: "acc-B" };
    if (!failed) { failed = true; throw new SupplyRequestError(0, null); }
    return { items: [accountRow("acc-C")], nextCursor: null };
  } });
  try {
    await p.render("accounts");
    await p.click(".mra-list-foot button");
    assert.deepEqual(rowIds(p), ["acc-A", "acc-B"], "失败不清已加载记录");
    const error = p.host.querySelector(".supply-notice.is-error[role='alert']");
    assert.ok(error, "网络未知结果保留错误提示与重试");
    await p.click(".supply-notice.is-error button");
    assert.deepEqual(afterValues, [null, "acc-B", "acc-B"], "重试复用同一 after，不回首页");
    assert.deepEqual(rowIds(p), ["acc-A", "acc-B", "acc-C"], "重试后追加新记录");
    assert.match(p.host.textContent, /已加载全部 3 个/);
    assert.equal(p.host.querySelector(".supply-notice.is-error"), null, "恢复后错误提示清除");
  } finally { await p.close(); }
});

test("F2: 开详情不清已加载列表/游标/筛选，返回恢复滚动与来源行焦点", async () => {
  const pages = [{ items: [accountRow("acc-A", { review_state: "DRAFT" }), accountRow("acc-B")], nextCursor: "acc-B" }, { items: [accountRow("acc-C")], nextCursor: null }];
  const p = await probe({ pages, detail: detailOf("acc-B") });
  try {
    await p.render("accounts");
    Object.defineProperty(p.window, "scrollY", { configurable: true, get: () => 320 });
    p.window.dispatchEvent(new p.window.Event("scroll"));
    await p.click(".mra-chip:nth-child(6)"); // 已上架：只筛已加载记录
    assert.deepEqual(rowIds(p), ["acc-B"]);
    const listReads = p.calls.myAccounts.length;
    await p.render("accounts", "acc-B");
    assert.ok(p.host.querySelector(".supply-account-detail"), "详情渲染");
    assert.deepEqual(p.calls.mine, ["acc-B"]);
    await p.render("accounts");
    await p.frames();
    assert.equal(p.calls.myAccounts.length, listReads, "往返不重拉列表（F2 生命周期分离）");
    assert.deepEqual(rowIds(p), ["acc-B"], "已加载记录与筛选保留");
    assert.match(p.host.querySelector(".mra-chip[aria-pressed='true']").textContent, /已上架/);
    assert.ok(p.scrollToCalls.some((args) => args[1] === 320), `返回恢复滚动位置 320，实际 ${JSON.stringify(p.scrollToCalls)}`);
    assert.equal(p.host.ownerDocument.activeElement?.id, "account-row-title-acc-B", "焦点回到来源行标题链");
    await p.click(".mra-list-foot button");
    assert.match(p.calls.myAccounts.at(-1), /after=acc-B/, "游标在往返后仍保留");
    assert.deepEqual(rowIds(p), ["acc-B", "acc-C"], "翻页继续追加新记录");
  } finally { await p.close(); }
});

test("F2: 切换详情只换详情作用域，迟到的旧详情响应不回填", async () => {
  const pendingA = deferred();
  const p = await probe({ pages: [{ items: [accountRow("acc-A"), accountRow("acc-B")], nextCursor: null }], mine: (id) => (id === "acc-A" ? pendingA.promise : Promise.resolve(detailOf(id))) });
  try {
    await p.render("accounts", "acc-A");
    const listReads = p.calls.myAccounts.length;
    await p.render("accounts", "acc-B");
    assert.deepEqual(p.calls.mine, ["acc-A", "acc-B"], "切详情按需重读详情");
    assert.equal(p.calls.myAccounts.length, listReads, "列表不重拉");
    assert.match(p.host.textContent, /账号 acc-B/);
    await React.act(async () => { pendingA.resolve(detailOf("acc-A")); await new Promise(setImmediate); });
    assert.doesNotMatch(p.host.textContent, /账号 acc-A/, "迟到的旧详情响应不得覆盖新详情");
  } finally { pendingA.resolve(detailOf("acc-A")); await p.close(); }
});

test("身份切换撤销旧私有列表，迟到响应不回填", async () => {
  const pendingA = deferred();
  const p = await probe({ pages: (params, call) => (call === 1 ? pendingA.promise : Promise.resolve({ items: [accountRow("acc-B")], nextCursor: null })) });
  try {
    await p.render("accounts");
    p.session.userId = "user_B";
    p.sessionChange();
    await p.render("accounts");
    await React.act(async () => { pendingA.resolve({ items: [accountRow("acc-A")], nextCursor: null }); await new Promise(setImmediate); });
    assert.match(p.host.textContent, /登录身份已变化，旧账号资料已清除。/);
    assert.deepEqual(rowIds(p), ["acc-B"], "旧身份的迟到列表响应不得回填");
  } finally { pendingA.resolve({ items: [], nextCursor: null }); await p.close(); }
});

test("列表读取 401 要求登录并撤全部，403 撤列表如实表达无权", async () => {
  for (const [status, expected] of [[401, /登录后才能查看你的出租账号/], [403, /没有权限查看/]]) {
    const p = await probe({ pages: () => { throw new SupplyRequestError(status, { error: { code: "DENIED", message: "denied" } }); } });
    try {
      await p.render("accounts");
      assert.match(p.host.textContent, expected, String(status));
      assert.deepEqual(rowIds(p), [], `${status}: 撤销不可再见的私有行`);
      assert.equal(p.host.querySelector(".supply-account-list"), null, String(status));
    } finally { await p.close(); }
  }
});

test("详情 404 只撤详情并如实表达，列表与游标保留", async () => {
  const pages = [{ items: [accountRow("acc-A"), accountRow("acc-B")], nextCursor: "acc-B" }];
  const p = await probe({ pages, mine: () => { throw new SupplyRequestError(404, { error: { code: "NOT_FOUND", message: "账号不存在", requestId: "r-1" } }); } });
  try {
    await p.render("accounts");
    await p.render("accounts", "acc-A");
    assert.equal(p.host.querySelector(".supply-account-detail"), null);
    assert.match(p.host.textContent, /账号资料读取失败/);
    assert.doesNotMatch(p.host.textContent, /账号不存在/, "详情 404 不写成账号不存在");
    await p.render("accounts");
    assert.deepEqual(rowIds(p), ["acc-A", "acc-B"], "详情失败不撤列表");
    assert.ok(p.host.querySelector(".mra-list-foot button"), "游标保留");
  } finally { await p.close(); }
});

test("confirmed account detail refreshes the cached row without losing pagination or position", async () => {
  const next = detailOf("acc-A");
  next.account.owner_paused = true;
  next.account.staff_restricted = true;
  next.version.sequence = "2";
  next.version.declaration.title = "更新后的账号";
  const p = await probe({ pages: [{ items: [accountRow("acc-A"), accountRow("acc-B")], nextCursor: "acc-B" }], mine: () => next });
  try {
    await p.render("accounts");
    Object.defineProperty(p.window, "scrollY", { value: 320, configurable: true });
    p.window.dispatchEvent(new p.window.Event("scroll"));
    await p.render("accounts", "acc-A");
    await p.render("accounts");
    await p.frames();
    const row = p.host.querySelector('[data-account-row="acc-A"]');
    assert.match(row.textContent, /已暂停接单/);
    assert.match(row.textContent, /客服限制/);
    assert.match(row.textContent, /更新后的账号/);
    assert.match(row.textContent, /版本 2/);
    assert.deepEqual(rowIds(p), ["acc-A", "acc-B"]);
    assert.ok(p.host.querySelector(".mra-list-foot button"), "next page remains available");
    assert.equal(p.calls.myAccounts.length, 1, "do not discard and refetch the list");
    assert.ok(p.scrollToCalls.some(args => args[1] === 320));
    assert.equal(p.window.document.activeElement.id, "account-row-title-acc-A");
  } finally { await p.close(); }
});

test("adopting an account detail refresh updates cached review and availability states", async () => {
  let reads = 0;
  const latest = detailOf("acc-A");
  latest.account.owner_paused = true;
  latest.account.staff_restricted = true;
  latest.version.reviewState = "WITHDRAWN";
  latest.version.sequence = "3";
  latest.version.declaration.title = "权威新标题";
  const p = await probe({ rows: [accountRow("acc-A")], mine: () => ++reads === 1 ? detailOf("acc-A") : latest });
  try {
    await p.render("accounts");
    await p.render("accounts", "acc-A");
    await p.clickDocButton("刷新状态");
    await p.clickDocButton("采用最新状态");
    await p.render("accounts");
    const row = p.host.querySelector('[data-account-row="acc-A"]');
    assert.match(row.textContent, /已撤回/);
    assert.match(row.textContent, /已暂停接单/);
    assert.match(row.textContent, /客服限制/);
    assert.match(row.textContent, /权威新标题/);
    assert.match(row.textContent, /版本 3/);
    assert.equal(p.calls.myAccounts.length, 1);
  } finally { await p.close(); }
});
