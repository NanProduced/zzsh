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
  const startUrl = options.url ?? "http://127.0.0.1:4200/account";
  const window = new Window({ url: startUrl });
  const startLocation = new URL(startUrl);
  const nav = { pathname: options.pathname ?? startLocation.pathname };
  const router = { pushes: [], replaces: [], push: target => { router.pushes.push(target); }, replace: target => { router.replaces.push(target); } };
  Object.assign(globalThis, { window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement, Element: window.Element, Event: window.Event, MouseEvent: window.MouseEvent, CustomEvent: window.CustomEvent, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true });
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
  // The real provider hands out a memoised snapshot, so a closure created on an earlier render keeps
  // the status that render saw. Mirror that: a fresh session object per render, never live getters,
  // otherwise stale-closure bugs (a long-lived effect calling auth.open) stay invisible here.
  let session = {
    status: identity.status,
    userId: identity.userId,
    identityVersion: identity.identityVersion,
    confirm: async () => { confirmations++; const status = options.confirm ? await options.confirm() : "authenticated"; identity.status = status; identity.userId = status === "authenticated" ? options.confirmUserId ?? "user_A" : null; return status; },
    revalidate() { confirmations++; options.revalidate?.(); },
    signOut: async () => { identity.status = "guest"; identity.userId = null; },
  };
  const syncSession = () => {
    const next = { ...session };
    next.status = identity.status;
    next.userId = identity.userId;
    next.identityVersion = identity.identityVersion;
    session = next;
  };
  const store = { getSnapshot: () => identity };
  const DialogContext = React.createContext(null);
  const dialogStub = {
    Root: ({ open, onOpenChange, children }) => open ? React.createElement(DialogContext.Provider, { value: { onOpenChange } }, children) : null,
    Trigger: ({ children }) => children,
    Portal: ({ children }) => children,
    Overlay: () => null,
    Content: ({ children, onOpenAutoFocus, onCloseAutoFocus, ...rest }) => React.createElement("div", { ...rest, role: "dialog", "aria-modal": true }, children),
    Title: ({ children }) => React.createElement("h2", null, children),
    Description: ({ children, asChild }) => asChild ? children : React.createElement("p", null, children),
    Close: ({ children, onClick, ...rest }) => {
      const context = React.useContext(DialogContext);
      return React.createElement("button", { ...rest, type: "button", onClick: (event) => { onClick?.(event); context?.onOpenChange?.(false); } }, children);
    },
  };
  const cache = new Map();
  const resolveSource = specifier => {
    const base = path.join(rootPath, "apps/web/src", specifier.slice(2));
    return [base + ".tsx", base + ".ts"].find(candidate => fs.existsSync(candidate));
  };
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = new Module(file); module.filename = file; module.paths = Module._nodeModulePaths(path.dirname(file)); cache.set(file, module);
    module.require = (name) => {
      if (name === "@/components/session/user-session-provider") return { useUserSession: () => session, useUserSessionStore: () => store, publishUserSessionChange() {} };
      if (name === "@/lib/web-auth-request") return load(path.join(rootPath, "apps/web/src/lib/web-auth-request.ts"));
      if (name === "../auth/auth-form" || name === "./auth-form") return load(path.join(rootPath, "apps/web/src/components/auth/auth-form.tsx"));
      // The support rail's own children: the workspace pulls in Radix popover, the IM client and
      // workspace packages that cannot run under happy-dom, and the contact popover is Radix too.
      // Routing tests only need the rail's trigger chain, so both stand in as null renders.
      if (name === "./contact-popover") return { ContactPopover: () => null };
      if (name === "./customer-support-workspace") return { CustomerSupportWorkspace: () => null };
      // Sibling imports inside src/ resolve like a bundler would; the two stubs above still win.
      if (name.startsWith("./") || name.startsWith("../")) {
        const base = path.resolve(path.dirname(module.filename), name);
        const candidate = [base + ".tsx", base + ".ts", path.join(base, "index.tsx"), path.join(base, "index.ts")].find(option => fs.existsSync(option));
        if (candidate) return load(candidate);
      }
      // A test may stand in for the coordinator when it only exercises a consumer such as /login.
      if (name === "@/components/auth/auth-overlay-provider") {
        if (options.authOverlay) return options.authOverlay;
        const provider = resolveSource(name);
        if (provider) return load(provider);
      }
      if (name === "next/navigation") return {
        useRouter: () => router,
        usePathname: () => nav.pathname,
        useSearchParams: () => new URLSearchParams(window.location.search),
      };
      // Real Radix cannot run here: its dismissable-layer dispatches an Event from a different realm
      // than happy-dom's document. The dialog renders inline in tests; focus semantics are proven in a browser.
      if (name === "@radix-ui/react-dialog") return dialogStub;
      if (name === "next/link") return { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { ...rest, href: String(href) }, children) };
      if (name.endsWith(".css")) return {};
      if (name.startsWith("@/")) { const resolved = resolveSource(name); if (resolved) return load(resolved); }
      return require(name);
    };
    module._compile(code, file); return module.exports;
  };
  const Component = load(path.join(rootPath, relativePath))[componentName];
  const { createRoot } = require("react-dom/client");
  const host = window.document.createElement("div"); window.document.body.append(host); const root = createRoot(host);
  let currentProps = { onSuccess: () => successes++, ...props };
  // Lets a test mount the coordinator with a real consumer (for example the legacy /login page)
  // instead of a stub, so the composition itself is what gets asserted.
  if (options.child) currentProps.children = React.createElement(load(path.join(rootPath, options.child.path))[options.child.name]);
  const render = async (changes = {}) => { syncSession(); currentProps = { ...currentProps, ...changes }; await React.act(async () => { const element = React.createElement(Component, currentProps); root.render(options.strictMode ? React.createElement(React.StrictMode, null, element) : element); }); };
  await render();
  const settle = () => React.act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  const findButton = text => { const buttons = [...host.querySelectorAll("button")]; const button = buttons.find(item => item.textContent === text) ?? buttons.find(item => item.getAttribute("aria-label") === text); assert.ok(button, "button present: " + text); return button; };
  const click = async text => { await React.act(async () => findButton(text).click()); await settle(); };
  const input = async (id, value) => {
    const element = host.querySelector("#" + id); assert.ok(element, "input present: " + id);
    await React.act(async () => {
      if (element.type === "checkbox") { if (element.checked !== value) element.click(); }
      else { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); element.dispatchEvent(new window.Event("change", { bubbles: true })); }
    }); await settle();
  };
  const submit = async (selector = "form") => { const form = host.querySelector(selector); assert.ok(form); await React.act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))); await settle(); };
  return { host, window, calls, identity, get session() { return session; }, store, nav, router, render, click, input, submit, findButton, settle, React, get confirmations() { return confirmations; }, get successes() { return successes; }, async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); globalThis.fetch = originalFetch; } };
}
