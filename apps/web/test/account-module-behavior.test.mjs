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

async function probe({ rows = [], detail = null, identityStatus = "UNVERIFIED", authRead, confirm = () => false, writeReply } = {}) {
  const window = new Window({ url: "http://127.0.0.1:3100/account" });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, DOMException: window.DOMException, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  window.scrollTo = () => {};
  window.confirm = confirm;
  const session = { status: "authenticated", userId: "user_A", identityVersion: 1, revalidations: 0, revalidate() { this.revalidations += 1; } };
  const store = { getSnapshot: () => session, subscribe: () => () => {} };
  const router = { replace() {}, push() {} };
  let writes = 0;
  const module = new Module(path.join(tree, "account-module-probe.cjs"));
  module.filename = path.join(tree, "account-module-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "next/link") return ({ scroll: _scroll, ...props }) => React.createElement("a", props);
    if (name === "next/navigation") return { useRouter: () => router };
    // This suite probes the parent's read permission; the real security control has its own React suite.
    if (name === "./account/account-security-controls") return { AccountSecurityControls: ({ userId, canAct }) => canAct() ? React.createElement("p", null, `PRIVATE_${userId} 138****8000`) : null };
    if (name === "./account/personal-wallet") return { PersonalWallet: () => null };
    if (name === "./account/personal-invitations") return { PersonalInvitations: () => null };
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
    if (name === "./favorites/favorites-context") return { FavoritesProvider: ({ children }) => children };
    if (name === "./order/order-workspace") return { OrderWorkspace: () => null };
    if (name === "./account/account-center") return {
      AccountCenterFrame: ({ children }) => children,
      AccountOverview: () => null,
      resolveAccountView: (view) => view || "overview",
      accountSectionLabels: { wallet: "我的钱包", invite: "分销中心" },
    };
    if (name === "../lib/supply-client") {
      const actual = require(path.join(tree, "apps/web/src/lib/supply-client.ts"));
      return { ...actual, supplyApi: { myAccounts: async () => ({ items: rows, nextCursor: null }), mine: async () => detail } };
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
    host, session, commits,
    get writes() { return writes; },
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
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); },
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
  let p;
  p = await probe({ confirm: () => { p.session.userId = "user_B"; p.session.identityVersion = 2; return true; } });
  try {
    await p.render("security");
    await p.click(".account-danger-zone button");
    assert.equal(p.writes, 0);
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
    assert.equal(p.writes, 1, "a valid refresh can restore the confirmed action");
  } finally { pendingRead.resolve(null); await p.close(); }
});

test("security revokes its confirmed read when the cancellation endpoint returns 401", async () => {
  const p = await probe({ confirm: () => true, authRead: async (route, session) => route === "/get-session" ? profileReply(session.userId) : identityReply(), writeReply: async () => { throw new ProbeWebAuthError(401, "UNAUTHENTICATED"); } });
  try {
    await p.render("security");
    const oldAction = p.captureHandler(".account-danger-zone button");
    await p.click(".account-danger-zone button");
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
    await oldAction();
    assert.equal(p.writes, 1, "the write is intercepted by a local stub");
    failRead = true; p.session.identityVersion = 2;
    await p.render("security");
    await React.act(async () => { pendingWrite.resolve({ status: "CANCELLED" }); await new Promise(setImmediate); });
    assert.doesNotMatch(p.host.textContent, /账号已注销|PRIVATE_user_A/);
    assert.equal(p.session.revalidations, 0);
  } finally { pendingWrite.resolve({ status: "CANCELLED" }); await p.close(); }
});
