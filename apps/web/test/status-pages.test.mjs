import test from "node:test";
import assert from "node:assert/strict";
import { mountAuthComponent } from "./react-auth-harness.mjs";

const source = "apps/web/src/components/status/status-content.tsx";
test("404 offers public recovery without retry or authentication", async () => {
  const p = await mountAuthComponent(source, "StatusContent", { kind: "not-found" });
  try {
    assert.equal(p.host.querySelector("h1").textContent, "没有找到这个页面");
    assert.deepEqual([...p.host.querySelectorAll("a")].map(a => a.getAttribute("href")), ["/accounts", "/", "/help"]);
    assert.equal(p.host.querySelector("button"), null);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});
test("read error retries only when requested, with no network or business write", async () => {
  let resets = 0;
  const p = await mountAuthComponent(source, "StatusContent", { kind: "unavailable", onRetry: () => resets++ });
  try {
    assert.equal(resets, 0);
    await p.click("重新加载");
    assert.equal(resets, 1);
    assert.equal(p.calls.length, 0);
    assert.ok(!/500|503|已保存|支付|网络断开/.test(p.host.textContent));
  } finally { await p.close(); }
});
test("forbidden state does not offer retry or demand another login", async () => {
  const p = await mountAuthComponent(source, "StatusContent", { kind: "forbidden" });
  try {
    // 联系客服不再是独立路由：它是右侧常驻工具列弹窗的入口，所以这里是 button 而不是 <a href="/support">。
    assert.deepEqual([...p.host.querySelectorAll("a")].map(a => a.getAttribute("href")), ["/account", "/help"]);
    const contact = [...p.host.querySelectorAll("button")].find(b => b.textContent.includes("联系客服"));
    assert.ok(contact, "forbidden still offers a way to reach customer service");
    assert.ok(![...p.host.querySelectorAll("button")].some(b => /重新加载|登录/.test(b.textContent)), "no retry, no login demand");
    assert.ok(!/登录|已删除|账号不存在/.test(p.host.textContent));
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});
test("failed artwork leaves the heading and recovery actions available", async () => {
  const p = await mountAuthComponent(source, "StatusContent", { kind: "not-found" });
  try {
    const img = p.host.querySelector("img");
    assert.equal(img.alt, "");
    assert.equal(img.width, img.height);
    await p.React.act(async () => img.dispatchEvent(new p.window.Event("error")));
    assert.equal(img.style.visibility, "hidden");
    assert.equal(p.host.querySelector("a").textContent, "浏览账号");
    assert.equal(p.host.querySelector("section").getAttribute("aria-labelledby"), p.host.querySelector("h1").id);
  } finally { await p.close(); }
});
test("read failure without an available retry still provides recovery navigation", async () => {
  const p = await mountAuthComponent(source, "StatusContent", { kind: "unavailable" });
  try {
    assert.equal(p.host.querySelector("button"), null);
    assert.deepEqual([...p.host.querySelectorAll("a")].map(a => a.getAttribute("href")), ["/", "/help"]);
  } finally { await p.close(); }
});
test("an image already broken before React attaches still degrades safely", async () => {
  const p = await mountAuthComponent(source, "StatusContent", { kind: "not-found" });
  try {
    const img = p.host.querySelector("img");
    Object.defineProperty(img, "complete", { value: true, configurable: true });
    Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
    await p.render();
    assert.equal(img.style.visibility, "hidden");
    assert.equal(p.host.querySelector("a").textContent, "浏览账号");
    await p.render({ kind: "forbidden" });
    assert.notEqual(p.host.querySelector("img"), img);
    assert.equal(p.host.querySelector("img").style.visibility, "");
  } finally { await p.close(); }
});


test("Next page boundary delegates recovery to retry without exposing the error", async () => {
  const { createRequire, Module } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const file = new URL("../src/app/error.tsx", import.meta.url);
  const module = new Module(file.pathname);
  module.require = name => name === "@/components/status/status-page" ? { StatusPage: () => null } : require(name);
  module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, file.pathname);
  let retries = 0, resets = 0;
  const page = module.exports.default({ error: new Error("private error detail"), retry: () => retries++, reset: () => resets++ });
  assert.equal(page.props.kind, "unavailable");
  assert.equal(page.props.error, undefined);
  assert.equal(retries, 0);
  page.props.onRetry();
  assert.equal(retries, 1);
  assert.equal(resets, 0);
});

test("Next root boundary delegates to retry and defines an independent document", async () => {
  const { createRequire, Module } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const file = new URL("../src/app/global-error.tsx", import.meta.url);
  const module = new Module(file.pathname);
  module.require = name => name === "react" ? { useEffect() {} }
    : name.endsWith(".css") ? { default: {} }
    : name === "@/components/status/status-content" ? { StatusContent: "status-content" }
    : name === "@/lib/theme" ? {} : require(name);
  module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, file.pathname);
  let retries = 0, resets = 0;
  const doc = module.exports.default({ error: Object.assign(new Error("private root detail"), { digest: "private-digest" }), retry: () => retries++, reset: () => resets++ });
  assert.equal(doc.type, "html");
  assert.equal(doc.props.children.type, "body");
  const content = doc.props.children.props.children[1].props.children;
  assert.equal(content.type, "status-content");
  assert.equal(content.props.kind, "unavailable");
  assert.equal(content.props.error, undefined);
  assert.equal(retries, 0);
  content.props.onRetry();
  assert.equal(retries, 1);
  assert.equal(resets, 0);
});
