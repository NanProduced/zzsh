import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { Window } from "happy-dom";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const server = await createServer({ root: resolve(root, "apps/admin"), configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const file = resolve(root, "packages/ui/src/legacy-account-image.tsx").replaceAll("\\", "/");
const { LegacyAccountImage } = await server.ssrLoadModule(`/@fs/${file}`);

test("only an authorized missing marker shows the migration image", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3100/" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client"), host = browser.document.createElement("div"), app = createRoot(host);
  const first = "/api/supply/listings/account_1/legacy-images/0", second = "/api/v1/supply/listings/account_1/legacy-images/1";
  let response = new Response(null, { status: 404, headers: { "x-zzsh-legacy-missing": "1" } }), calls = 0;
  globalThis.fetch = async (_url, options) => { calls++; assert.equal(options.method, "HEAD"); return response; };
  const render = src => React.act(async () => app.render(React.createElement(LegacyAccountImage, { src, alt: "账号展示图" })));
  const fail = () => React.act(async () => { host.querySelector("img").dispatchEvent(new browser.Event("error")); await Promise.resolve(); });
  try {
    await render(first); await fail(); assert.match(host.querySelector("img").alt, /图片正在迁移中/);
    response = new Response(null, { status: 404 });
    await render(second); await fail(); assert.match(host.querySelector("img").alt, /暂无可展示的图片/);
    await render(first); assert.equal(host.querySelector("img").getAttribute("src"), first, "returning to the same URL retries after a different image");
    await render("/api/v1/supply/accounts/account_1/legacy-images/penalty/1"); assert.match(host.querySelector("img").alt, /暂无可展示的图片/);
    await render("https://external.invalid/image.png"); assert.match(host.querySelector("img").alt, /暂无可展示的图片/); assert.equal(calls, 2);
  } finally { await React.act(async () => app.unmount()); await browser.happyDOM.close(); await server.close(); }
});
