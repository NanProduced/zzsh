import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Module } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { DEFAULT_RESOURCES } from "@zzsh/content";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
function fixture(relative, resource) {
  const cache = new Map();
  const primitive = tag => ({ children, asChild, onOpenAutoFocus, onCloseAutoFocus, side, sideOffset, collisionPadding, ...props }) => React.createElement(tag, props, children);
  const overlay = { Root: primitive("div"), Trigger: primitive("div"), Portal: primitive("div"), Overlay: primitive("div"), Content: primitive("section"), Title: primitive("h2"), Close: primitive("button") };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const native = createRequire(file);
    new Function("require", "exports", ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(name => {
      if (name === "react") return { ...React, useState: value => [value, () => {}], useEffect() {}, useRef: value => ({ current: value }) };
      if (name.includes("public-content-provider")) return { usePublicContent: () => ({ resource, status: "ready", retry() {} }) };
      if (name.endsWith(".css")) return {};
      if (name === "@/components/brand/brand-logo") return { BrandLogo: () => React.createElement("img", { alt: "洲洲商行" }) };
      if (name === "@/components/support/support-contact-button") return { SupportContactButton: ({ children }) => React.createElement("button", null, children) };
      if (name.startsWith("@radix-ui/react-")) return overlay;
      if (name === "next/link") return ({ children, ...props }) => React.createElement("a", props, children);
      if (name.startsWith(".")) {
        const target = [path.resolve(path.dirname(file), name + ".ts"), path.resolve(path.dirname(file), name + ".tsx")].find(existsSync);
        if (target) return load(target);
      }
      return native(name);
    }, exports);
    return exports;
  }
  return load(path.join(root, relative));
}

const payload = { kind: "contact", title: "不应显示的标题", description: "不应显示的说明", handle: "不应显示的联系号", imageAlt: "不应显示的alt", enabled: false, qrMediaId: "m1" };
const resource = { payload, media: [{ id: "m1", url: "/api/content/media/m1/content" }] };

test("real contact and market QR consumers replace the picture while keeping code-owned copy", () => {
  const { ContactPopover } = fixture("apps/web/src/components/support/contact-popover.tsx", resource);
  const contact = renderToStaticMarkup(React.createElement(ContactPopover, { kind: "follow", children: "打开关注" }));
  assert.match(contact, /关注我们/); assert.match(contact, /获取洲洲商行的活动与资讯/);
  assert.match(contact, /src="\/api\/content\/media\/m1\/content"/); assert.match(contact, /alt="关注我们二维码"/);
  assert.doesNotMatch(contact, /不应显示/);
  const { ManagedMarketContact } = fixture("apps/web/src/components/content/market-content.tsx", resource);
  const market = renderToStaticMarkup(React.createElement(ManagedMarketContact, { channel: "MARKET_PLAYER_GROUP" }));
  assert.match(market, /玩家交流群二维码/); assert.match(market, /玩家交流用途/); assert.doesNotMatch(market, /不应显示/);
});

test("market banner keeps its code-owned destination and current media revocation removes the QR", () => {
  const { ManagedMarketBanner } = fixture("apps/web/src/components/content/market-content.tsx", { ...resource, payload: { ...payload, kind: "banner", mediaId: "m1", mobileMediaId: null, linkUrl: "/evil" } });
  const banner = renderToStaticMarkup(React.createElement(ManagedMarketBanner));
  assert.match(banner, /href="#account-list"/); assert.match(banner, /alt="三角洲行动账号租赁专区"/); assert.doesNotMatch(banner, /不应显示|\/evil/);
  const { ContactPopover } = fixture("apps/web/src/components/support/contact-popover.tsx", { ...resource, media: [{ id: "m1", url: null }] });
  const revoked = renderToStaticMarkup(React.createElement(ContactPopover, { kind: "follow", children: "打开关注" }));
  assert.doesNotMatch(revoked, /src="\/api\/content\/media/); assert.match(revoked, /暂时无法读取/);
});

test("footer falls back when absent, respects published empty values and only renders eligible QR media", () => {
  const render = resource => renderToStaticMarkup(React.createElement(fixture("apps/web/src/components/layout/portal-footer.tsx", resource).PortalFooter));
  const fallback = render(null);
  assert.match(fallback, /浙ICP备2026028260号/); assert.match(fallback, /33010802014464/);
  assert.match(fallback, /href="\/updates"/); assert.doesNotMatch(fallback, /抖音|微信|哔哩哔哩/);
  const base = DEFAULT_RESOURCES["placement:FOOTER"];
  const empty = { ...base, copyright: "", icp: "", policeRegion: "", policeCode: "", help: [], support: [], socials: [], complaint: false };
  const blank = render({ state: "available", payload: empty, media: [] });
  assert.doesNotMatch(blank, /浙ICP备|租号流程|投诉建议/); assert.match(blank, /平台动态/);
  const social = { ...empty, socials: [{ label: "二维码渠道", href: null, qrMediaId: "m1" }] };
  assert.match(render({ state: "available", payload: social, media: [{ id: "m1", url: "/api/content/media/m1/content" }] }), /二维码渠道/);
  assert.doesNotMatch(render({ state: "available", payload: social, media: [{ id: "m1", url: null }] }), /二维码渠道/);
  assert.doesNotMatch(render({ state: "withdrawn", payload: null, media: [] }), /浙ICP备|租号流程/);
});

test("shared provider reads footer once per route and retains a published hide through a transient failure", async t => {
  const { Window } = await import("happy-dom"), { act } = React;
  const browser = new Window({ url: "http://127.0.0.1/" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const file = path.join(root, "apps/web/src/components/content/public-content-provider.tsx"), module = new Module(file), native = createRequire(file);
  let pathname = "/one", footerCalls = 0;
  const hidden = { schema: "content-resource.v1", key: "placement:FOOTER", source: "MANAGED", state: "withdrawn", payload: null, media: [] };
  module.filename = file; module.paths = Module._nodeModulePaths(path.dirname(file));
  module.require = name => name === "next/navigation" ? { usePathname: () => pathname } : name === "@/lib/content-public" ? {
    fetchContentResources: async () => [],
    fetchFooterResource: async () => { footerCalls++; if (footerCalls === 1) return hidden; throw new Error("temporary failure"); },
  } : native(name);
  module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  const { PublicContentProvider, usePublicContent } = module.exports, { createRoot } = await import("react-dom/client");
  const container = browser.document.createElement("div"); browser.document.body.appendChild(container); const app = createRoot(container);
  function Consumer() { return React.createElement("span", null, usePublicContent("placement:FOOTER").resource?.state ?? "fallback"); }
  const render = () => React.createElement(PublicContentProvider, null, React.createElement(Consumer), React.createElement(Consumer));
  await act(async () => { app.render(render()); });
  assert.equal(container.textContent, "withdrawnwithdrawn"); assert.equal(footerCalls, 1);
  pathname = "/two";
  await act(async () => { app.render(render()); });
  assert.equal(container.textContent, "withdrawnwithdrawn"); assert.equal(footerCalls, 2);
  t.after(async () => { await act(async () => app.unmount()); await browser.happyDOM.abort(); });
});
