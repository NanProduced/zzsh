import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

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
