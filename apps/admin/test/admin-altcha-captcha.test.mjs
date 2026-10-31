import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.CustomEvent = browser.CustomEvent;
globalThis.MutationObserver = browser.MutationObserver;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = browser.matchMedia.bind(browser);
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/admin-altcha"),
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { LoginView } = await vite.ssrLoadModule("/src/views/login-view.tsx");
const { AuthShell } = await vite.ssrLoadModule("/src/components/devl/auth-shell.tsx");
const inShell = (props) => createElement(AuthShell, null, createElement(LoginView, props));
const { ALTCHA_CHALLENGE_URL } = await vite.ssrLoadModule("/src/components/altcha-field.tsx");
const { adminRequest, AdminApiError, friendlyError, stepUpCaptcha, isStepUpBody } = await vite.ssrLoadModule("/src/api.ts");

after(async () => { await vite.close(); await browser.happyDOM.abort(); });

async function render(element) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return { host, unmount: () => act(async () => root.unmount()) };
}

const loginProps = { identifier: "zz00001", loading: false, onIdentifier() {}, onSubmit() {}, onRecovery() {} };

test("login view renders the self-hosted ALTCHA widget only when captcha is required", async () => {
  const plain = await render(inShell(loginProps));
  assert.equal(plain.host.querySelector("altcha-widget"), null);
  await plain.unmount();

  const gated = await render(inShell({ ...loginProps, captchaRequired: true, captchaRound: 1 }));
  const widget = gated.host.querySelector("altcha-widget");
  assert.ok(widget, "widget rendered");
  assert.equal(widget.getAttribute("challenge"), ALTCHA_CHALLENGE_URL);
  assert.equal(ALTCHA_CHALLENGE_URL, "/api/bff/admin/security/captcha/challenge");
  const submit = gated.host.querySelector('button[type="submit"]');
  assert.equal(submit.disabled, true, "submit blocked until the challenge is solved");
  await gated.unmount();
});

test("step-up store consumes payloads once and rotates the challenge", () => {
  assert.equal(isStepUpBody({ password: "p", totpCode: "123456" }), true);
  assert.equal(isStepUpBody({ password: "p" }), false);
  assert.equal(isStepUpBody(undefined), false);
  stepUpCaptcha.setRequired(true);
  const before = stepUpCaptcha.snapshot().round;
  stepUpCaptcha.setPayload("solved");
  assert.equal(stepUpCaptcha.take(), "solved");
  assert.equal(stepUpCaptcha.take(), undefined);
  assert.ok(stepUpCaptcha.snapshot().round > before);
  stepUpCaptcha.setRequired(false);
  assert.equal(stepUpCaptcha.snapshot().required, false);
});

test("adminRequest attaches the step-up payload and tracks CAPTCHA_REQUIRED", async () => {
  const seen = [];
  const original = globalThis.fetch;
  let reply = () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", reason: "CAPTCHA_REQUIRED" } }), { status: 401, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (_url, init) => { seen.push(JSON.parse(init.body)); return reply(); };
  try {
    stepUpCaptcha.setRequired(false);
    await assert.rejects(adminRequest("/security/reauth", { password: "x".repeat(12), totpCode: "123456" }), (error) => error instanceof AdminApiError && error.reason === "CAPTCHA_REQUIRED");
    assert.equal(seen[0].altcha, undefined);
    assert.equal(stepUpCaptcha.snapshot().required, true);

    stepUpCaptcha.setPayload("solved-payload");
    reply = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    await adminRequest("/security/reauth", { password: "x".repeat(12), totpCode: "123456" });
    assert.equal(seen[1].altcha, "solved-payload");
    assert.equal(stepUpCaptcha.snapshot().required, false);

    await adminRequest("/workspace/notes", { text: "n" });
    assert.equal(seen[2].altcha, undefined, "non step-up bodies never carry the payload");
  } finally { globalThis.fetch = original; }
  assert.equal(friendlyError(new AdminApiError(403, "FORBIDDEN", undefined, "/security/reauth", [], [], "CAPTCHA_REQUIRED")), "请先完成人机验证后重试。");
  assert.equal(friendlyError(new AdminApiError(401, "UNAUTHENTICATED", undefined, "/auth/sign-in/username", [], [], "CAPTCHA_REQUIRED")), "账号或密码错误，请完成人机验证后重试。");
});
