import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { allHelpArticles } from "../src/content/help/index.ts";
import { buildHelpNavData, flattenHelpNavArticles, getHelpArticleNeighbors } from "../src/components/help/nav-data.ts";
import { stripHelpSearchQuery } from "../src/components/help/help-url.ts";

const require = createRequire(import.meta.url);

function transpile(rel) {
  const source = readFileSync(new URL(rel, import.meta.url), "utf8");
  return ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
}

test("neighbors follow the flattened help-nav order for all 22 articles", () => {
  const nav = buildHelpNavData(allHelpArticles);
  const order = flattenHelpNavArticles(nav).map((a) => a.slug);
  assert.equal(order.length, 22);
  assert.equal(new Set(order).size, 22, "every article appears exactly once in nav order");
  for (let index = 0; index < order.length; index++) {
    const { prev, next } = getHelpArticleNeighbors(nav, order[index]);
    const expectedPrev = index > 0 ? order[index - 1] : null;
    const expectedNext = index < order.length - 1 ? order[index + 1] : null;
    assert.equal(prev?.slug ?? null, expectedPrev, `${order[index]} prev`);
    assert.equal(next?.slug ?? null, expectedNext, `${order[index]} next`);
    if (prev) assert.equal(`/help/${prev.slug}`, `/help/${order[index - 1]}`);
    if (next) assert.equal(`/help/${next.slug}`, `/help/${order[index + 1]}`);
  }
  const first = getHelpArticleNeighbors(nav, order[0]);
  assert.equal(first.prev, null);
  const last = getHelpArticleNeighbors(nav, order[order.length - 1]);
  assert.equal(last.next, null);
  assert.deepEqual(getHelpArticleNeighbors(nav, "no-such-slug"), { prev: null, next: null });
});

function setupPager({ prev, next, pathname = "/help/rental-getting-started" } = {}) {
  const code = transpile("../src/components/help/help-article-pager.tsx");
  const effects = [];
  const pushes = [];
  const keyHandlers = [];
  const heading = { attrs: {}, focusArgs: null, setAttribute(name, value) { this.attrs[name] = value; }, hasAttribute(name) { return name in this.attrs; }, focus(args) { this.focusArgs = args; } };
  const scrolls = [];
  const state = { pathname, reducedMotion: false };
  const refs = [];
  const exports = {};
  class HTMLElementShim {}
  new Function("require", "exports", "window", "document", "HTMLElement", code)(name => {
    if (name === "react") return {
      ...React,
      useEffect: (fn) => effects.push(fn),
      useRef: (value) => (refs[0] ??= { current: value }),
    };
    if (name === "next/navigation") return { useRouter: () => ({ push: (href) => pushes.push(href) }), usePathname: () => state.pathname };
    return require(name);
  }, exports, {
    matchMedia: (query) => ({ matches: state.reducedMotion, media: query }),
    scrollTo: (options) => scrolls.push(options),
  }, {
    addEventListener: (type, fn) => { if (type === "keydown") keyHandlers.push(fn); },
    removeEventListener() {},
    querySelector: (selector) => (selector === "main h1" ? heading : null),
  }, HTMLElementShim);
  const render = () => exports.HelpArticlePager({ prev, next });
  const runEffects = () => effects.splice(0).forEach((fn) => fn());
  const fireKey = (init) => {
    let prevented = 0;
    for (const fn of keyHandlers) fn({ preventDefault: () => prevented++, target: null, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init });
    return prevented;
  };
  return { render, runEffects, pushes, heading, scrolls, fireKey, HTMLElementShim, state };
}

test("pager renders prev/next links with correct hrefs and edge placeholders", () => {
  const prev = { slug: "rental-check-before-order", title: "下单前需要核对哪些信息？" };
  const next = { slug: "rental-confirm-and-return", title: "确认收货与归还" };
  const html = renderToStaticMarkup(setupPager({ prev, next }).render());
  assert.match(html, /aria-label="上一篇 \/ 下一篇"/);
  assert.ok(html.includes('href="/help/rental-check-before-order"'));
  assert.ok(html.includes('href="/help/rental-confirm-and-return"'));
  assert.ok(html.includes('rel="prev"') && html.includes('rel="next"'));
  assert.ok(html.includes("下单前需要核对哪些信息？") && html.includes("确认收货与归还"));
  assert.ok(html.includes("上一篇") && html.includes("下一篇"));

  const edge = renderToStaticMarkup(setupPager({ prev: null, next }).render());
  assert.ok(!edge.includes('rel="prev"'));
  assert.ok(edge.includes('help-pager-link--placeholder'));
  assert.ok(edge.includes('href="/help/rental-confirm-and-return"'));

  const none = setupPager({ prev: null, next: null });
  assert.equal(none.render(), null, "pager without neighbors renders nothing");
});

test("ArrowLeft/ArrowRight navigate between articles and ignore editable targets and modifiers", () => {
  const prev = { slug: "rental-check-before-order", title: "上一篇标题" };
  const next = { slug: "rental-confirm-and-return", title: "下一篇标题" };
  const p = setupPager({ prev, next });
  p.render();
  p.runEffects();
  assert.equal(p.fireKey({ key: "ArrowRight" }), 1);
  assert.deepEqual(p.pushes, ["/help/rental-confirm-and-return"]);
  assert.equal(p.fireKey({ key: "ArrowLeft" }), 1);
  assert.deepEqual(p.pushes, ["/help/rental-confirm-and-return", "/help/rental-check-before-order"]);
  // 修饰键组合不触发
  assert.equal(p.fireKey({ key: "ArrowRight", ctrlKey: true }), 0);
  // 输入控件内不拦截
  const editable = new p.HTMLElementShim();
  editable.closest = (sel) => (sel.includes("input") ? {} : null);
  assert.equal(p.fireKey({ key: "ArrowRight", target: editable }), 0);
  assert.equal(p.pushes.length, 2);
  // 边界：只有 prev 时 ArrowRight 无效
  const edge = setupPager({ prev, next: null });
  edge.render();
  edge.runEffects();
  assert.equal(edge.fireKey({ key: "ArrowRight" }), 0);
  assert.equal(edge.fireKey({ key: "ArrowLeft" }), 1);
  assert.deepEqual(edge.pushes, ["/help/rental-check-before-order"]);
});

test("pager skips focus management on first mount, then moves focus to the heading after navigation, respecting reduced motion", () => {
  const prev = { slug: "a", title: "a" };
  const next = { slug: "b", title: "b" };
  const p = setupPager({ prev, next, pathname: "/help/a" });
  p.render();
  p.runEffects();
  assert.equal(p.heading.focusArgs, null, "first mount must not steal focus or scroll");
  assert.equal(p.scrolls.length, 0);
  // 模拟跳转到下一篇：pathname 变化触发焦点管理
  p.state.pathname = "/help/b";
  p.render();
  p.runEffects();
  assert.equal(p.heading.attrs.tabindex, "-1");
  assert.deepEqual(p.heading.focusArgs, { preventScroll: true });
  assert.deepEqual(p.scrolls.at(-1), { top: 0, behavior: "smooth" });
  const p2 = setupPager({ prev, next, pathname: "/help/a" });
  p2.render();
  p2.runEffects();
  p2.state.reducedMotion = true;
  p2.state.pathname = "/help/b";
  p2.render();
  p2.runEffects();
  assert.deepEqual(p2.scrolls.at(-1), { top: 0, behavior: "auto" });
});

function setupShell() {
  const code = transpile("../src/components/help/help-shell.tsx");
  const effects = [];
  const keyHandlers = [];
  const clickHandlers = [];
  const focused = [];
  const pushes = [];
  const exports = {};
  class HTMLElementShim {
    constructor() {}
    closest() { return null; }
  }
  new Function("require", "exports", "window", "document", "HTMLElement", code)(name => {
    if (name === "react") return { ...React, useEffect: (fn) => effects.push(fn) };
    if (name === "next/navigation") return { useRouter: () => ({ push: (href) => pushes.push(href) }) };
    if (name.startsWith("@/components/layout/service-shell")) return { ServiceShell: (props) => props.children };
    if (name === "./help-url") return { stripHelpSearchQuery };
    return require(name);
  }, exports, {}, {
    addEventListener: (type, fn) => { if (type === "keydown") keyHandlers.push(fn); else clickHandlers.push(fn); },
    removeEventListener() {},
    querySelector: (selector) => (selector === 'form.site-search input[type="search"]'
      ? { focus: (args) => focused.push(args) }
      : null),
  }, HTMLElementShim);
  const tree = exports.HelpShell({ children: React.createElement("p", null, "帮助内容"), breadcrumbs: [], title: "帮助中心", description: "", initialQuery: "" });
  const fireKey = (init) => {
    let prevented = 0;
    for (const fn of keyHandlers) fn({ preventDefault: () => prevented++, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init });
    return prevented;
  };
  return { tree, effects, focused, pushes, fireKey, HTMLElementShim };
}

test("help shell focuses the search box on / and Ctrl+K without stealing editable keys", () => {
  const s = setupShell();
  const html = renderToStaticMarkup(s.tree);
  assert.ok(html.includes("帮助内容"));
  s.effects.forEach((fn) => fn());
  assert.equal(s.fireKey({ key: "/" }), 1);
  assert.deepEqual(s.focused.at(-1), { preventScroll: true });
  assert.equal(s.fireKey({ key: "k", ctrlKey: true }), 1);
  assert.equal(s.fireKey({ key: "K", metaKey: true }), 1);
  assert.equal(s.focused.length, 3);
  // Shift+/ 或 Alt+/ 不触发
  assert.equal(s.fireKey({ key: "/", shiftKey: true }), 0);
  assert.equal(s.fireKey({ key: "/", altKey: true }), 0);
  // 输入控件内不拦截
  const editable = new s.HTMLElementShim();
  editable.closest = (sel) => (sel.includes("input") ? {} : null);
  assert.equal(s.fireKey({ key: "/", target: editable }), 0);
  assert.equal(s.focused.length, 3);
});
