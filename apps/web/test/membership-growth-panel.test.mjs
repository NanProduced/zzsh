import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = fileURLToPath(new URL("..", import.meta.url));

test("membership growth panel keeps black-gold, grace and unknown states distinct", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3100/account" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  const { MembershipGrowthPanel } = await vite.ssrLoadModule("/src/components/account/membership-growth-panel.tsx");
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const ready = { status: "ready", data: { tier: "BLACK_GOLD", rollingPoints: "120", lifetimePoints: "50000", asOf: "2026-10-10T00:00:00.000Z", nextTier: null, grace: { state: "NONE", fromTier: null, until: null, gapPoints: null }, nextExpiryAt: null, benefits: [{ label: "租客押金", value: "按配置", sourceVersion: "b1" }], entitlements: [{ kind: "FRIEND", label: "挚友礼遇", scope: "game:delta", endsAt: "2026-10-20T00:00:00.000Z", state: "ACTIVE", depositWaived: false }], contributions: [], pendingCount: 0 } };
  await act(async () => root.render(createElement(MembershipGrowthPanel, { state: ready })));
  assert.match(host.textContent, /黑金会员/);
  assert.match(host.textContent, /终身/);
  assert.doesNotMatch(host.textContent, /保级至/);
  const grace = { ...ready, data: { ...ready.data, tier: "GOLD", grace: { state: "ACTIVE", fromTier: "GOLD", until: "2026-10-17T00:00:00.000Z", gapPoints: "240" }, nextTier: { tier: "PLATINUM", threshold: "20000", remaining: "9760" } } };
  await act(async () => root.render(createElement(MembershipGrowthPanel, { state: grace })));
  assert.match(host.textContent, /保留至/);
  assert.match(host.textContent, /240/);
  const unknown = { status: "unknown", message: "成长服务尚未接线" };
  await act(async () => root.render(createElement(MembershipGrowthPanel, { state: unknown })));
  assert.match(host.textContent, /成长服务尚未接线/);
  assert.doesNotMatch(host.textContent, /0分/);
  await act(async () => root.unmount());
  await vite.close();
  await browser.happyDOM.abort();
});
