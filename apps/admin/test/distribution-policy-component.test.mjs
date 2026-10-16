import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const config = { schema: "distribution-policy.v1", scope: "LOCAL_CONTROLLED", enabled: false, participation: "ALL_USERS", depth: 1, selfRebate: false, accountModes: ["ordinary"], minimumAccrualCents: "1", settlementDelayDays: 7, levels: [{ code: "L1", rank: 1, default: true, renterPercent: "1.5", ownerPercent: "0.5", upgrade: null }] };
const known = { knowledge: "KNOWN", policy: { versionId: "dp-1", revision: "3", digest: "d", config, createdAt: "2026-10-01T00:00:00.000Z" } };
const snap = (perms, boss = false) => ({ authenticated: true, adminUserId: "a1", session: { id: "s1", locked: false, pinConfigured: true, createdAt: null, expiresAt: null }, security: { isBoss: boss }, permissions: perms, permissionCodes: perms });

test("E-GAP-014 admin distribution policy: real read, revision-guarded write, fail closed", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3101/" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0), cancelAnimationFrame: (id) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true });
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const m = await vite.ssrLoadModule("/src/views/distribution-policy-panel.tsx");
    assert.throws(() => m.parseDistributionPolicyRead({ knowledge: "KNOWN", policy: { ...known.policy, config: { ...config, scope: "GLOBAL" } } }));
    assert.throws(() => m.parseDistributionPolicyRead({ knowledge: "KNOWN", policy: { ...known.policy, config: { ...config, levels: [] } } }));
    assert.throws(() => m.parseDistributionPolicyRead([]));
    assert.equal(m.parseDistributionPolicyRead({ knowledge: "UNKNOWN", policy: null, reason: "POLICY_NOT_CONFIGURED" }).knowledge, "UNKNOWN");
    const calls = [];
    let reply = () => new Response(JSON.stringify(known), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = browser.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method ?? "GET", body: init.body }); return reply(url, init); };
    const { createRoot } = await import("react-dom/client");
    const mount = async (s) => { const host = browser.document.createElement("div"); browser.document.body.append(host); const root = createRoot(host); await act(async () => root.render(createElement(m.DistributionPolicyPanel, { snapshot: s }))); await act(async () => new Promise((r) => setTimeout(r, 20))); return { host, root }; };
    // no permission: no request at all
    let v = await mount(snap([]));
    assert.match(v.host.textContent, /没有分销政策权限/); assert.equal(calls.length, 0); v.root.unmount();
    // read-only
    v = await mount(snap(["personal.distribution.policy.read"]));
    assert.match(calls[0].url, /\/distribution\/policy$/); assert.equal(calls[0].method, "GET");
    assert.match(v.host.textContent, /本地受控政策/); assert.match(v.host.textContent, /1\.5%/); assert.match(v.host.textContent, /只读/);
    assert.equal(v.host.querySelector("textarea"), null); v.root.unmount();
    // manage: PUT carries expectedRevision and reason; 409 surfaces conflict, never success
    calls.length = 0;
    v = await mount(snap(["personal.distribution.policy.manage"]));
    const box = v.host.querySelector("[aria-label='切换分销政策开关']");
    await act(async () => box.click());
    const ta = v.host.querySelector("textarea");
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(ta, "试运行开启"); ta.dispatchEvent(new browser.Event("input", { bubbles: true })); ta.dispatchEvent(new browser.Event("change", { bubbles: true })); });
    reply = (url, init) => init.method === "PUT" ? new Response(JSON.stringify({ code: "CONFLICT" }), { status: 409, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify(known), { status: 200, headers: { "content-type": "application/json" } });
    const submit = [...v.host.querySelectorAll("button")].find((b) => b.textContent === "提交变更");
    await act(async () => { submit.click(); await new Promise((r) => setTimeout(r, 20)); });
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put); const body = JSON.parse(put.body);
    assert.equal(body.expectedRevision, "3"); assert.equal(body.config.enabled, true); assert.equal(body.reason, "试运行开启");
    assert.match(v.host.textContent, /已被他人修改/); assert.doesNotMatch(v.host.textContent, /已提交/); v.root.unmount();
    // server error fails closed, no default percentages shown
    reply = () => new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    v = await mount(snap([], true));
    assert.match(v.host.textContent, /未就绪/); assert.doesNotMatch(v.host.textContent, /%/); v.root.unmount();
  } finally { await vite.close(); }
});
