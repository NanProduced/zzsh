import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { loadInformation } from "./information-module.mjs";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const React = requireFromTree("react");
const typescript = requireFromTree("typescript");

function loadTs(file, overrides = {}) {
  const module = new Module(file);
  module.filename = file;
  module.paths = Module._nodeModulePaths(path.dirname(file));
  const native = module.require.bind(module);
  module.require = (name) => overrides[name] ?? native(name);
  module._compile(typescript.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: typescript.ModuleKind.CommonJS, jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
  return module.exports;
}

const icons = new Proxy({}, { get: () => (props) => React.createElement("span", props) });
const session = { status: "authenticated", userId: "user-A", identityVersion: 1, revalidate() {} };
let currentSession = { status: "authenticated", userId: "user-A", identityVersion: 1 };
const store = { getSnapshot: () => currentSession };
const componentPath = path.join(tree, "apps/web/src/components/account/credit-center.tsx");
const clientPath = path.join(tree, "apps/web/src/lib/credit-guarantee-client.ts");
const supplyClientPath = path.join(tree, "apps/web/src/lib/supply-client.ts");
const orderClientPath = path.join(tree, "apps/web/src/lib/order-client.ts");
const walletClientPath = path.join(tree, "apps/web/src/lib/personal-wallet-client.ts");
const historyClientPath = path.join(tree, "apps/web/src/lib/owner-guarantee-history-client.ts");
const historyPath = path.join(tree, "apps/web/src/components/account/owner-guarantee-history.tsx");
function loadHistory() {
  const wallet = loadTs(walletClientPath);
  const client = loadTs(historyClientPath, { "./personal-wallet-client.ts": wallet });
  return loadTs(historyPath, { "@/components/session/user-session-provider": { useUserSession: () => session, useUserSessionStore: () => store }, "@/lib/owner-guarantee-history-client": client, "@/lib/personal-wallet-client": wallet, "@/lib/order-client": loadTs(orderClientPath), "@/components/ui/information": loadInformation({ "lucide-react": icons }), "./owner-guarantee-history.css": {} });
}

function setupStorage(throws = false) {
  const values = new Map();
  globalThis.sessionStorage = { getItem: (key) => values.get(key) ?? null, setItem: (_key, _value) => { if (throws) throw Error("STORAGE_DENIED"); values.set(_key, _value); }, removeItem: (key) => values.delete(key), clear: () => values.clear() };
  return values;
}

function overview() { return { creditState: "INITIALIZED", credit: { userId: "user-A", score: 70, revision: "1", initializedAt: "2026-01-01", events: [] }, recoveryRequests: [], guarantees: [], transactions: [] }; }
function historyOverview() { return { ...overview(), transactions: [{ requirementId: "req-1", accountId: "account-1", paymentStatus: "CONFIRMED", refundStatus: "UNKNOWN", paymentFinanceEventId: "event-2", refundFinanceEventId: null, paymentHistory: [{ id: "pay-1", requirementId: "req-1", merchantOrderNo: "merchant-1", amountCents: "500", status: "FAILED", providerTransactionId: null, financeEventId: null, ledgerEntryRef: null }, { id: "pay-2", requirementId: "req-1", merchantOrderNo: "merchant-2", amountCents: "500", observedAmountCents: "500", status: "CONFIRMED", providerTransactionId: "provider-2", financeEventId: "event-2", ledgerEntryRef: "line-2" }], refundHistory: [{ id: "refund-1", requirementId: "req-1", paymentId: "pay-2", amountCents: "500", status: "FAILED", providerRefundId: null, financeEventId: null, ledgerEntryRef: null }, { id: "refund-2", requirementId: "req-1", paymentId: "pay-2", amountCents: "500", status: "UNKNOWN", providerRefundId: null, financeEventId: null, ledgerEntryRef: null }] }] }; }

async function mount(fetchImpl, { history = false } = {}) {
  Object.assign(session, { status: "authenticated", userId: "user-A", identityVersion: 1 });
  currentSession = { status: "authenticated", userId: "user-A", identityVersion: 1 };
  const browser = new Window({ url: "http://127.0.0.1:3100/account" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, DOMException: browser.DOMException, IS_REACT_ACT_ENVIRONMENT: true });
  // F owner-guarantee-history is an independent read; existing credit-call counting tests isolate it unless opted in.
  globalThis.fetch = history ? fetchImpl : async (url, init) => String(url).includes("/api/account/wallet/guarantees") ? new Response(JSON.stringify({ error: { code: "GUARANTEE_HISTORY_UNAVAILABLE" } }), { status: 503 }) : fetchImpl(url, init);
  const module = loadTs(componentPath, { "lucide-react": icons, "next/link": ({ scroll, ...props }) => React.createElement("a", props), "./credit-center.css": {}, "../session/user-session-provider": { useUserSession: () => session, useUserSessionStore: () => store }, "../../lib/credit-guarantee-client": loadTs(clientPath), "../../lib/supply-client": loadTs(supplyClientPath), "../../lib/order-client": loadTs(orderClientPath), "@/components/ui/information": loadInformation({ "lucide-react": icons }), "./owner-guarantee-history": loadHistory() });
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = requireFromTree("react-dom/client").createRoot(host);
  await React.act(async () => root.render(React.createElement(module.CreditCenter, { scope: "user-A:1" })));
  await new Promise(setImmediate);
  return { browser, host, root, component: module.CreditCenter, client: loadTs(clientPath) };
}

test("credit overview uses the explicitly supported read route", async () => {
  const original = globalThis.fetch;
  const reads = [];
  const controller = new AbortController();
  try {
    globalThis.fetch = async (url, init) => {
      reads.push({ url, method: init.method });
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.signal, controller.signal);
      return String(url) === "/api/account/credit/overview"
        ? new Response(JSON.stringify(overview()), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "PREVIEW_READ_ONLY" } }), { status: 403 });
    };
    const result = await loadTs(clientPath).readMyCredit(controller.signal);
    assert.equal(result.credit.score, 70);
    assert.deepEqual(reads, [{ url: "/api/account/credit/overview", method: "GET" }]);
  } finally { globalThis.fetch = original; }
});

test("credit write library still refuses a POST when the original intent cannot be persisted", async () => {
  setupStorage(true);
  const client = loadTs(clientPath);
  const intent = client.makeCreditWriteIntent("user-A:1", "/recovery-requests", { reason: "申请说明" });
  await assert.rejects(client.submitCreditWrite(intent), error => error.code === "WRITE_INTENT_STORAGE_UNAVAILABLE");
});

test("credit read distinguishes explicit uninitialized state from legacy unknown and rejects contradictions", async () => {
  const original = globalThis.fetch, client = loadTs(clientPath);
  try {
    const missing = { ...overview(), creditState: "NOT_INITIALIZED", credit: null };
    globalThis.fetch = async (_url, init) => { assert.equal(init.method, "GET");return Response.json(missing); };
    assert.equal((await client.readMyCredit()).creditState, "NOT_INITIALIZED");
    const { creditState: _state, ...legacy } = missing;
    globalThis.fetch = async () => Response.json(legacy);assert.equal((await client.readMyCredit()).creditState, "UNKNOWN");
    for (const body of [{ ...overview(), creditState: "NOT_INITIALIZED" }, { ...missing, creditState: "INITIALIZED" }, { ...missing, creditState: "INVENTED" }]) {
      globalThis.fetch = async () => Response.json(body);await assert.rejects(() => client.readMyCredit(), error => error.code === "CREDIT_CONTRACT_REQUIRED");
    }
  } finally { globalThis.fetch = original; }
});

test("credit page presents uninitialized state and does not submit any initialization or command", async () => {
  const calls = [],mounted = await mount(async (url, init) => { calls.push({url:String(url),method:init?.method});return Response.json({ ...overview(), creditState: "NOT_INITIALIZED", credit: null }); });
  try {
    assert.match(mounted.host.textContent, /信用档案尚未初始化/);assert.equal(mounted.host.querySelector('[role="meter"]'),null);assert.ok(calls.every(call => call.method === "GET"));assert.doesNotMatch(mounted.host.textContent,/100分/);
  } finally { await React.act(async () => mounted.root.unmount());await mounted.browser.happyDOM.abort(); }
});

test("read page preserves accepted intent across refresh and never replays or clears it", async () => {
  const storage = setupStorage(false);
  const client = loadTs(clientPath);
  const intent = client.makeCreditWriteIntent("user-A:1", "/recovery-requests", { reason: "申请说明" });
  assert.equal(client.persistCreditWritePhase(intent, "readback"), true);
  const saved = [...storage.values()][0];
  let reads = 0;
  const mounted = await mount(async (_url, init) => { assert.equal(init?.method, "GET"); reads += 1; return new Response(JSON.stringify(overview())); });
  try {
    assert.match(mounted.host.textContent, /原操作已接受/);
    assert.equal(mounted.host.querySelector("textarea"), null);
    const reread = [...mounted.host.querySelectorAll("button")].find((item) => item.textContent.includes("刷新"));
    await React.act(async () => reread.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })));
    await new Promise(setImmediate);
    assert.equal(reads, 2);
    assert.equal([...storage.values()][0], saved);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("late A phase or clear cannot overwrite a newer B write intent", () => {
  const storage = setupStorage(false);
  const client = loadTs(clientPath);
  const a = client.makeCreditWriteIntent("scope-A", "/recovery-requests", { reason: "A申请" });
  const b = client.makeCreditWriteIntent("scope-A", "/recovery-requests", { reason: "B申请" });
  assert.equal(client.persistCreditWritePhase(a, "readback"), false);
  client.clearCreditWriteIntent(a);
  assert.equal(JSON.parse([...storage.values()][0]).key, b.key);
  assert.equal(client.persistCreditWritePhase(b, "readback"), true);
});

test("CreditCenter renders every payment and refund attempt", async () => {
  setupStorage(false);
  const mounted = await mount(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? {} : historyOverview()), { status: 200 }));
  try {
    assert.match(mounted.host.textContent, /支付尝试 2 笔/);
    assert.match(mounted.host.textContent, /退款尝试 2 笔/);
    assert.match(mounted.host.textContent, /merchant-1/);
    assert.match(mounted.host.textContent, /退还结果待确认/);
    assert.doesNotMatch(mounted.host.textContent, /refund-2|provider-2|event-2|line-2/);
    assert.match(mounted.host.textContent, /已观察收款金额\s*待核定/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("credit recovery read preserves nullable decision reason and refuses malformed reason/status", async () => {
  const previousFetch = globalThis.fetch;
  const row = { id: "recovery-private", status: "REJECTED", reason: "申请理由", decisionReason: "尚有未处理责任", scoreBefore: 70, createdAt: "2026-10-12T00:00:00Z", decidedAt: null };
  try {
    for (const reason of ["尚有未处理责任", null, undefined]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...overview(), recoveryRequests: [{ ...row, decisionReason: reason }] }));
      const result = await loadTs(clientPath).readMyCredit();
      assert.equal(result.recoveryRequests[0].decisionReason, reason ?? null);
    }
    for (const bad of [{ ...row, decisionReason: {} }, { ...row, status: "unrecognized" }]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...overview(), recoveryRequests: [bad] }));
      await assert.rejects(loadTs(clientPath).readMyCredit(), error => error.code === "CREDIT_CONTRACT_REQUIRED");
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("credit recovery records separate application and decision reasons without inventing dates", async () => {
  setupStorage(false);
  const row = { id: "hidden-request-id", status: "REJECTED", reason: "用户的申请内容", decisionReason: "仍有未处理责任", scoreBefore: 70, createdAt: "2026-10-12T00:00:00Z", decidedAt: null };
  const mounted = await mount(async (_url, init) => { assert.equal(init?.method, "GET"); return new Response(JSON.stringify({ ...overview(), recoveryRequests: [row, { ...row, id: "pending-id", status: "PENDING", decisionReason: null }] })); });
  try {
    const section = mounted.host.querySelector('[aria-labelledby="credit-recovery-records"]');
    assert.match(section.textContent, /申请内容：用户的申请内容/);
    assert.match(section.textContent, /处理理由：仍有未处理责任/);
    assert.match(section.textContent, /已驳回/);
    assert.match(section.textContent, /处理时间：时间暂未提供/);
    assert.match(section.textContent, /等待处理/);
    assert.doesNotMatch(section.textContent, /hidden-request-id|pending-id/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("missing decision reason is not replaced by the applicant's explanation", async () => {
  setupStorage(false);
  const mounted = await mount(async () => new Response(JSON.stringify({ ...overview(), recoveryRequests: [{ id: "r", status: "APPROVED", reason: "申请说明", decisionReason: null, scoreBefore: 70, createdAt: "2026-10-12T00:00:00Z", decidedAt: null }] })));
  try { const text = mounted.host.querySelector('[aria-labelledby="credit-recovery-records"]').textContent; assert.match(text, /已通过/); assert.match(text, /处理理由：暂未提供/); assert.doesNotMatch(text, /处理理由：申请说明/); }
  finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("credit score rejects coerced or invalid values and preserves zero and unknown", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const score of [null, 0, 70, 100]) {
      const payload = overview(); payload.credit.score = score;
      globalThis.fetch = async () => new Response(JSON.stringify(payload));
      assert.equal((await loadTs(clientPath).readMyCredit()).credit.score, score);
    }
    for (const score of [undefined, "100", -1, 101, 70.5, {}]) {
      const payload = overview(); payload.credit.score = score;
      globalThis.fetch = async () => new Response(JSON.stringify(payload));
      await assert.rejects(loadTs(clientPath).readMyCredit(), error => error.code === "CREDIT_CONTRACT_REQUIRED");
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("credit meter marks only confirmed 100 as success and never renders unknown as zero", async () => {
  for (const score of [null, 0, 70, 100]) {
    setupStorage(false);
    const payload = overview(); payload.credit.score = score;
    const mounted = await mount(async () => new Response(JSON.stringify(payload)));
    try {
      const meter = mounted.host.querySelector('[role="meter"]');
      if (score === null) { assert.equal(meter, null); assert.match(mounted.host.textContent, /信用分待确认/); }
      else { assert.equal(meter.getAttribute("aria-valuenow"), String(score)); assert.equal(meter.dataset.state, score === 100 ? "full" : "known"); }
      assert.equal(mounted.host.querySelector("textarea"), null);
      assert.doesNotMatch(mounted.host.textContent, /提交恢复申请|记录缴纳意图|申请原路退还|连续 7 天/);
    } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
  }
});

test("guarantee groups deduplicate account contexts without adding money or hiding distinct responsibilities", async () => {
  setupStorage(false);
  const first = { accountId: "account-1", displayNo: "公开账号88", gameId: "delta", versionId: "v1", priceVersionId: "p1", releaseId: "r1", baseCents: "10000", requiredCents: "500", score: 70, state: "REQUIRED", reference: "private-hash" };
  const second = { ...first, displayNo: null, versionId: "v2", requiredCents: "600", state: "SATISFIED", reference: "guarantee:private-requirement" };
  const third = { ...first, accountId: "account-2", displayNo: null, state: "NOT_REQUIRED", requiredCents: "0" };
  const mounted = await mount(async (_url, init) => { assert.equal(init?.method, "GET"); return new Response(JSON.stringify({ ...overview(), guarantees: [first, { ...first }, second, third] })); });
  try {
    const groups = mounted.host.querySelectorAll(".credit-guarantee-list article");
    assert.equal(groups.length, 2);
    assert.equal(groups[0].querySelectorAll(".credit-responsibility").length, 2);
    assert.match(groups[0].textContent, /2 项保证金责任/);
    assert.match(groups[0].textContent, /¥5\.00/); assert.match(groups[0].textContent, /¥6\.00/);
    assert.doesNotMatch(groups[0].textContent, /¥11\.00|private-hash|private-requirement/);
    assert.equal(groups[0].querySelector("a").textContent, "公开账号88");
    assert.equal(groups[1].querySelector("a").textContent, "出租账号");
    assert.match(groups[1].textContent, /该账号暂无可显示的公开名称/);
    assert.doesNotMatch(groups[1].textContent, /account-2/);
    assert.equal(groups[0].querySelector("a").getAttribute("href"), "/account?view=accounts&accountId=account-1");
    assert.match(groups[1].textContent, /当前责任无需缴纳，不代表已缴或已退/);
    assert.equal([...mounted.host.querySelectorAll("button")].filter((b) => !b.closest(".owner-guarantee-history")).length, 1, "credit commands only; F history retry is separate");
    const headings = [...mounted.host.querySelectorAll("h3")].map(item => item.textContent);
    assert.deepEqual(headings, ["当前信用", "信用变动明细", "出租账号保证金", "收款与原路退还进度", "我的信用恢复申请", "号主上架保证金"], "F history section is hosted last and independent of credit readiness");
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("UNKNOWN guarantee placeholder zero remains unknown while NOT_REQUIRED zero stays confirmed", async () => {
  setupStorage(false);
  const guarantee = { accountId: "account-unknown", displayNo: null, gameId: "delta", versionId: null, priceVersionId: "price", releaseId: "release", baseCents: null, requiredCents: "0", score: null, state: "UNKNOWN", reference: null, reasonCode: "CREDIT_UNINITIALIZED" };
  const mounted = await mount(async () => new Response(JSON.stringify({ ...overview(), guarantees: [guarantee, { ...guarantee, accountId: "account-no-quote", reasonCode: "STANDARD_QUOTE_UNAVAILABLE" }, { ...guarantee, accountId: "account-not-required", state: "NOT_REQUIRED", score: 100, baseCents: "10000" }] })));
  try {
    const requirements = [...mounted.host.querySelectorAll(".credit-responsibility dl")].map(list => [...list.querySelectorAll("div")].find(row => row.querySelector("dt")?.textContent === "当前应缴要求").querySelector("dd").textContent);
    assert.deepEqual(requirements, ["待核定", "待核定", "¥0.00"]);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("late aborted A read cannot replace a later A after A to B to A scope changes", async () => {
  setupStorage(false);
  const reads = [];
  const mounted = await mount(async (_url, init) => new Promise(resolve => reads.push({ signal: init.signal, resolve })));
  try {
    Object.assign(session, { userId: "user-B", identityVersion: 2 }); currentSession = { ...session };
    await React.act(async () => mounted.root.render(React.createElement(mounted.component, { scope: "user-B:2" })));
    Object.assign(session, { userId: "user-A", identityVersion: 3 }); currentSession = { ...session };
    await React.act(async () => mounted.root.render(React.createElement(mounted.component, { scope: "user-A:3" })));
    assert.equal(reads.length, 3);
    const payload = overview(); payload.credit.score = 100;
    await React.act(async () => { reads[2].resolve(new Response(JSON.stringify(payload))); await new Promise(setImmediate); });
    await React.act(async () => { reads[0].resolve(new Response(JSON.stringify(overview()))); reads[1].resolve(new Response(JSON.stringify(overview()))); await new Promise(setImmediate); });
    assert.equal(reads[0].signal.aborted, true);
    assert.equal(mounted.host.querySelector('[role="meter"]').getAttribute("aria-valuenow"), "100");
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("credit read failure stays distinct from empty data and recovers with GET retry", async () => {
  setupStorage(false); let reads = 0;
  const mounted = await mount(async (_url, init) => { assert.equal(init.method, "GET"); return ++reads === 1 ? new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), { status: 403 }) : new Response(JSON.stringify(overview())); });
  try {
    assert.match(mounted.host.textContent, /没有读取此信息的权限/);
    assert.doesNotMatch(mounted.host.textContent, /暂无恢复申请记录/);
    const retry = [...mounted.host.querySelectorAll("button")].find(button => button.textContent === "重试");
    await React.act(async () => retry.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })));
    await new Promise(setImmediate);
    assert.equal(mounted.host.querySelector('[role="alert"]'), null);
    assert.match(mounted.host.textContent, /暂无恢复申请记录/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("store identity change before props render discards the old GET response", async () => {
  setupStorage(false);
  let complete;
  const mounted = await mount(async () => new Promise(resolve => { complete = resolve; }));
  try {
    currentSession = { status: "authenticated", userId: "user-B", identityVersion: 2 };
    await React.act(async () => { complete(new Response(JSON.stringify(overview()))); await new Promise(setImmediate); });
    assert.equal(mounted.host.querySelector('[role="meter"]'), null);
    assert.match(mounted.host.textContent, /正在读取信用状态/);
    assert.doesNotMatch(mounted.host.textContent, /暂无恢复申请记录/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("wrong credit subject and 401 discard private data and revalidate the session", async () => {
  const original = session.revalidate;
  let revalidations = 0; session.revalidate = () => revalidations++;
  try {
    for (const wrongSubject of [true, false]) {
      setupStorage(false);
      const payload = overview(); payload.credit.userId = "user-B";
      const mounted = await mount(async () => wrongSubject ? new Response(JSON.stringify(payload)) : new Response(JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED" } }), { status: 401 }));
      try { assert.equal(mounted.host.querySelector('[role="meter"]'), null); assert.match(mounted.host.textContent, /登录身份已变化|登录状态已变化/); }
      finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
    }
    assert.equal(revalidations, 2);
  } finally { session.revalidate = original; }
});

test("F1: displayNo-less accounts are distinguished by authorized summary names, never by internal ids", async () => {
  setupStorage(false);
  const first = { accountId: "account-a", displayNo: null, gameId: "delta", versionId: "v1", priceVersionId: "p1", releaseId: "r1", baseCents: "10000", requiredCents: "0", score: 100, state: "NOT_REQUIRED", reference: null };
  const second = { ...first, accountId: "account-b", versionId: "v2" };
  const third = { ...first, accountId: "account-c", versionId: "v3" };
  const summaries = { items: [
    { id: "account-a", title: "三角洲 · 极品改装号", game_name: "三角洲行动", review_state: "PUBLISHED", sequence: "1", owner_paused: false, staff_restricted: false },
    { id: "account-b", title: "三角洲 · 满改M4", game_name: "三角洲行动", review_state: "PUBLISHED", sequence: "2", owner_paused: false, staff_restricted: false },
    { id: "account-c", title: null, game_name: "三角洲行动", review_state: "PUBLISHED", sequence: "3", owner_paused: false, staff_restricted: false },
  ], nextCursor: null };
  const reads = [];
  const mounted = await mount(async (url, init) => {
    reads.push({ url: String(url), method: init?.method });
    assert.equal(init?.method, "GET");
    return String(url).startsWith("/api/supply/me/accounts")
      ? new Response(JSON.stringify(summaries))
      : new Response(JSON.stringify({ ...overview(), guarantees: [first, second, third] }));
  });
  try {
    const groups = mounted.host.querySelectorAll(".credit-guarantee-list article");
    assert.equal(groups.length, 3);
    assert.equal(groups[0].querySelector("a").textContent, "三角洲 · 极品改装号");
    assert.equal(groups[1].querySelector("a").textContent, "三角洲 · 满改M4");
    assert.equal(groups[2].querySelector("a").textContent, "出租账号");
    // 编号有值时才辅助显示；缺名称时不暴露内部ID、不伪造业务号。
    assert.doesNotMatch(mounted.host.textContent, /account-a|account-b|account-c/);
    assert.match(groups[0].textContent, /三角洲行动/);
    // 摘要使用有界列表，不逐账号请求。
    const summaryReads = reads.filter(r => r.url.startsWith("/api/supply/me/accounts"));
    assert.equal(summaryReads.length, 1);
    assert.match(summaryReads[0].url, /limit=50/);
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

test("F1: account summary failure never blocks the credit read and stays silent", async () => {
  setupStorage(false);
  const only = { accountId: "account-a", displayNo: null, gameId: "delta", versionId: "v1", priceVersionId: "p1", releaseId: "r1", baseCents: "10000", requiredCents: "0", score: 100, state: "NOT_REQUIRED", reference: null };
  const mounted = await mount(async (url, init) => {
    assert.equal(init?.method, "GET");
    return String(url).startsWith("/api/supply/me/accounts")
      ? new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }), { status: 503 })
      : new Response(JSON.stringify({ ...overview(), guarantees: [only] }));
  });
  try {
    assert.match(mounted.host.textContent, /当前信用/);
    assert.match(mounted.host.textContent, /出租账号/);
    assert.match(mounted.host.textContent, /该账号暂无可显示的公开名称/);
    // 摘要失败不阻塞主读取，也不额外给出会误操作的入口。
    assert.equal([...mounted.host.querySelectorAll("button")].filter((b) => !b.closest(".owner-guarantee-history")).length, 1, "credit commands only; F history retry is separate");
  } finally { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); }
});

// R1：摘要读取的授权会变；任何一次权威结果变化都必须让旧名称消失。
const SUMMARY_ROW = { id: "account-1", title: "PREVIOUS_AUTHORIZED_TITLE", game_name: "三角洲行动", review_state: "PUBLISHED", sequence: "1", owner_paused: false, staff_restricted: false };
const ticks = async (n = 16) => { for (let i = 0; i < n; i += 1) await React.act(async () => { await new Promise(setImmediate); }); };
const cleanup = async (mounted) => { await React.act(async () => mounted.root.unmount()); await mounted.browser.happyDOM.abort(); };
const refreshCredit = async (mounted) => {
  const button = [...mounted.host.querySelectorAll("button")].find((b) => b.textContent.includes("刷新"));
  assert(button, "刷新按钮");
  await React.act(async () => { button.dispatchEvent(new mounted.browser.MouseEvent("click", { bubbles: true })); });
  await ticks();
};
const summaryThen = (mounted, laterResponse, counter) => async (url, init) => {
  assert.equal(init?.method, "GET");
  if (String(url).startsWith("/api/supply/me/accounts")) {
    counter.reads += 1;
    return counter.reads === 1
      ? new Response(JSON.stringify({ items: [SUMMARY_ROW], nextCursor: null }))
      : laterResponse();
  }
  return new Response(JSON.stringify(historyOverview()));
};

test("R1: an authoritative empty account list after refresh drops the previously shown name", async () => {
  setupStorage(false);
  const counter = { reads: 0 };
  const mounted = await mount(summaryThen(null, () => new Response(JSON.stringify({ items: [], nextCursor: null })), counter));
  try {
    await ticks();
    assert.match(mounted.host.textContent, /PREVIOUS_AUTHORIZED_TITLE/);
    const readsBefore = counter.reads;
    await refreshCredit(mounted);
    await ticks();
    assert(counter.reads > readsBefore, "刷新后必须重新读取摘要，而不是沿用旧结果");
    assert.doesNotMatch(mounted.host.textContent, /PREVIOUS_AUTHORIZED_TITLE/);
    // 收退记录仍引用该账号，但名称回到中性降级，且不暴露内部 ID。
    assert.equal(mounted.host.querySelector(".credit-transactions a").textContent, "出租账号");
    assert.doesNotMatch(mounted.host.textContent, /account-1/);
  } finally { await cleanup(mounted); }
});

test("R1: a 403 on the account summary withdraws the name without blocking the credit read", async () => {
  setupStorage(false);
  const counter = { reads: 0 };
  const mounted = await mount(summaryThen(null, () => new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), { status: 403 }), counter));
  try {
    await ticks();
    assert.match(mounted.host.textContent, /PREVIOUS_AUTHORIZED_TITLE/);
    await refreshCredit(mounted);
    await ticks();
    assert.doesNotMatch(mounted.host.textContent, /PREVIOUS_AUTHORIZED_TITLE/);
    // 摘要授权与信用读取是两种权限：信用主体仍在，只是名称降级。
    assert.match(mounted.host.textContent, /当前信用/);
    assert.equal([...mounted.host.querySelectorAll("button")].filter((b) => !b.closest(".owner-guarantee-history")).length, 1, "credit commands only; F history retry is separate");
  } finally { await cleanup(mounted); }
});

test("R1: a 401 on the account summary withdraws the name and refreshes identity", async () => {
  setupStorage(false);
  const original = session.revalidate;
  let revalidations = 0; session.revalidate = () => { revalidations += 1; };
  const counter = { reads: 0 };
  const mounted = await mount(summaryThen(null, () => new Response(JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED" } }), { status: 401 }), counter));
  try {
    await ticks();
    assert.match(mounted.host.textContent, /PREVIOUS_AUTHORIZED_TITLE/);
    await refreshCredit(mounted);
    await ticks();
    assert.doesNotMatch(mounted.host.textContent, /PREVIOUS_AUTHORIZED_TITLE/);
    assert.equal(revalidations, 1);
  } finally { session.revalidate = original; await cleanup(mounted); }
});

// ══ t4（2026-10-14）F1-t 信用摘要跨页收全：有界分页带 after（不是 cursor）、覆盖所需账号即停、中途失败整体清空。 ══
const summaryRow = (id, title) => ({ id, title, game_name: "三角洲行动", review_state: "PUBLISHED", sequence: "1", owner_paused: false, staff_restricted: false });
const summaryGuarantee = (accountId, versionId) => ({ accountId, displayNo: null, gameId: "delta", versionId, priceVersionId: "p1", releaseId: "r1", baseCents: "10000", requiredCents: "0", score: 100, state: "NOT_REQUIRED", reference: null });

test("F1-t: 信用摘要跨页收全，分页请求带 after 不带 cursor，覆盖所需账号即停", async () => {
  setupStorage(false);
  const reads = [];
  const mounted = await mount(async (url, init) => {
    assert.equal(init?.method, "GET");
    const parsed = new URL(String(url), "http://127.0.0.1:3100");
    if (parsed.pathname === "/api/supply/me/accounts") {
      reads.push(parsed.searchParams);
      return new Response(JSON.stringify(parsed.searchParams.get("after") === null
        ? { items: [summaryRow("account-a", "第一页标题")], nextCursor: "account-a" }
        : { items: [summaryRow("account-b", "无关账号"), summaryRow("account-c", "第二页标题")], nextCursor: "account-never" }));
    }
    return new Response(JSON.stringify({ ...overview(), guarantees: [summaryGuarantee("account-a", "v1"), summaryGuarantee("account-c", "v2")] }));
  });
  try {
    await ticks();
    const groups = mounted.host.querySelectorAll(".credit-guarantee-list article");
    assert.equal(groups.length, 2);
    assert.equal(groups[0].querySelector("a").textContent, "第一页标题");
    assert.equal(groups[1].querySelector("a").textContent, "第二页标题", "跨页收全：第二页里的账号也有名称");
    assert.equal(reads.length, 2, "覆盖所需 accountId 后停止，服务端仍有游标也不再读");
    assert.equal(reads[0].get("after"), null);
    assert.equal(reads[0].get("limit"), "50");
    assert.equal(reads[1].get("after"), "account-a", "第二页用上页 nextCursor 作为 after");
    for (const params of reads) assert.equal(params.has("cursor"), false, "cursor 不是 /me/accounts 的合同参数");
  } finally { await cleanup(mounted); }
});

test("F1-t: 摘要分页中途失败时整体清空，不半真半假保留部分名称", async () => {
  setupStorage(false);
  const mounted = await mount(async (url) => {
    const parsed = new URL(String(url), "http://127.0.0.1:3100");
    if (parsed.pathname === "/api/supply/me/accounts") {
      return new Response(JSON.stringify(parsed.searchParams.get("after") === null
        ? { items: [summaryRow("account-a", "第一页标题")], nextCursor: "account-a" }
        : { error: { code: "INTERNAL_ERROR" } }), { status: parsed.searchParams.get("after") === null ? 200 : 503 });
    }
    return new Response(JSON.stringify({ ...overview(), guarantees: [summaryGuarantee("account-a", "v1"), summaryGuarantee("account-c", "v2")] }));
  });
  try {
    await ticks();
    assert.doesNotMatch(mounted.host.textContent, /第一页标题/, "中途失败不保留半套名称");
    assert.match(mounted.host.textContent, /当前信用/, "信用主读取不被摘要失败阻塞");
    assert.match(mounted.host.textContent, /该账号暂无可显示的公开名称/);
    assert.doesNotMatch(mounted.host.textContent, /account-a|account-c/, "不露内部 ID");
  } finally { await cleanup(mounted); }
});

test("F1-t: 首页已覆盖所需账号即停，不继续翻页", async () => {
  setupStorage(false);
  const reads = [];
  const mounted = await mount(async (url) => {
    const parsed = new URL(String(url), "http://127.0.0.1:3100");
    if (parsed.pathname === "/api/supply/me/accounts") {
      reads.push(parsed.searchParams);
      return new Response(JSON.stringify({ items: [summaryRow("account-a", "覆盖即停标题"), summaryRow("account-x", "多余")], nextCursor: "account-x" }));
    }
    return new Response(JSON.stringify({ ...overview(), guarantees: [summaryGuarantee("account-a", "v1")] }));
  });
  try {
    await ticks();
    assert.equal(reads.length, 1, "有界收集：覆盖即停，不做无用翻页");
    assert.equal(mounted.host.querySelector(".credit-guarantee-list a").textContent, "覆盖即停标题");
  } finally { await cleanup(mounted); }
});

test("E-F-016 owner guarantee history stays readable when the main credit read fails", async () => {
  const original = globalThis.fetch;
  const urls = [];
  const history = { contractVersion: "owner-guarantee-history.read.v1", subjectId: "user-A", asOf: "2026-10-01T00:00:00Z", snapshotVersion: "snap-1", items: [], nextCursor: null, coverage: { knowledge: "UNKNOWN", count: null, mappedRecordCount: null, reason: "SOURCE_PENDING", cutoff: null }, postedHeld: { knowledge: "UNKNOWN", amountCents: null, scope: "POSTED_LEDGER_ONLY", reason: "NOT_POSTED" }, liability: { knowledge: "UNKNOWN", amountCents: null }, channelArrival: "UNKNOWN" };
  try {
    const { host, root } = await mount(async (url) => {
      urls.push(String(url));
      if (String(url).includes("/api/account/wallet/guarantees")) return new Response(JSON.stringify(history), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "x" } }), { status: 500 });
    }, { history: true });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    assert.ok(urls.some((u) => u.includes("/api/account/wallet/guarantees")), "history read is issued independently");
    assert.match(host.textContent, /号主上架保证金/);
    assert.match(host.textContent, /待核定/, "unknown liability is shown as pending, not zero");
    await React.act(async () => root.unmount());
  } finally { globalThis.fetch = original; }
});
