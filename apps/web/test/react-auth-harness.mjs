import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(rootPath, "package.json"));
const React = require("react");
const ts = require("typescript");
const { Window } = require("happy-dom");
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

export async function mountAuthComponent(relativePath, componentName, props = {}, options = {}) {
  const window = new Window({ url: "http://127.0.0.1:4200/account" });
  Object.assign(globalThis, { window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Element: window.Element, Event: window.Event, MouseEvent: window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  window.confirm = () => true;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, method: init.method });
    return options.fetch ? options.fetch(url, body, init) : Response.json({ status: true, userId: "user_A", passwordSet: false, cooldownUntil: new Date(Date.now() + 60_000).toISOString() });
  };
  const identity = { status: options.initialStatus ?? "guest", userId: options.initialStatus === "authenticated" ? "user_A" : null, identityVersion: 1 };
  let confirmations = 0, successes = 0;
  const session = { ...identity, confirm: async () => { confirmations++; const status = options.confirm ? await options.confirm() : "authenticated"; identity.status = status; identity.userId = status === "authenticated" ? options.confirmUserId ?? "user_A" : null; return status; }, revalidate() { confirmations++; options.revalidate?.(); }, signOut: async () => { identity.status = "guest"; identity.userId = null; } };
  const store = { getSnapshot: () => identity };
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = new Module(file); module.filename = file; module.paths = Module._nodeModulePaths(path.dirname(file)); cache.set(file, module);
    module.require = (name) => {
      if (name === "@/components/session/user-session-provider") return { useUserSession: () => session, useUserSessionStore: () => store, publishUserSessionChange() {} };
      if (name === "@/lib/web-auth-request") return load(path.join(rootPath, "apps/web/src/lib/web-auth-request.ts"));
      if (name === "../auth/auth-form") return load(path.join(rootPath, "apps/web/src/components/auth/auth-form.tsx"));
      return require(name);
    };
    module._compile(code, file); return module.exports;
  };
  const Component = load(path.join(rootPath, relativePath))[componentName];
  const { createRoot } = require("react-dom/client");
  const host = window.document.createElement("div"); window.document.body.append(host); const root = createRoot(host);
  let currentProps = { onSuccess: () => successes++, ...props };
  const render = async (changes = {}) => { currentProps = { ...currentProps, ...changes }; await React.act(async () => { root.render(React.createElement(Component, currentProps)); }); };
  await render();
  const settle = () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  const findButton = text => { const button = [...host.querySelectorAll("button")].find(item => item.textContent === text); assert.ok(button, "button present: " + text); return button; };
  const click = async text => { await React.act(async () => findButton(text).click()); await settle(); };
  const input = async (id, value) => {
    const element = host.querySelector("#" + id); assert.ok(element, "input present: " + id);
    await React.act(async () => {
      if (element.type === "checkbox") { if (element.checked !== value) element.click(); }
      else { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); element.dispatchEvent(new window.Event("change", { bubbles: true })); }
    }); await settle();
  };
  const submit = async (selector = "form") => { const form = host.querySelector(selector); assert.ok(form); await React.act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))); await settle(); };
  return { host, window, calls, identity, session, store, render, click, input, submit, findButton, settle, React, get confirmations() { return confirmations; }, get successes() { return successes; }, async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); globalThis.fetch = originalFetch; } };
}
