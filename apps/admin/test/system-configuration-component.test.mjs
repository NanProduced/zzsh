import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const snapshot = (isBoss = true, adminUserId = "boss_1") => ({
  authenticated: true, adminUserId,
  user: { name: "管理员", username: adminUserId, twoFactorEnabled: true },
  security: { status: "ACTIVE", isBoss, passwordChangeRequired: false },
  session: { id: `session_${adminUserId}`, locked: false, pinConfigured: false, createdAt: null, expiresAt: null },
  permissions: ["content.platform.read"],
});
const storage = (over = {}) => ({
  backend: "oss", configured: true, configurationSource: "DEPLOYMENT_ENVIRONMENT",
  target: { bucket: "zzsh-staging-example", region: "oss-cn-shenzhen", endpoint: "https://oss-cn-shenzhen-internal.aliyuncs.com", objectPrefix: "zzsh-rebuild/staging/media/" },
  credentialMode: "ACCESS_KEY", automaticCredentialRefresh: false,
  limits: { maxBytes: 10 * 1024 * 1024, allowedMimes: ["image/jpeg", "image/png", "image/webp"] },
  check: { state: "NOT_RUN", checkedAt: null, scope: "PUBLIC_CONTENT_DERIVATIVE", integrity: "NOT_RUN" },
  ...over,
});
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const checked = (state, integrity = "NOT_RUN") => ({ state, checkedAt: "2026-10-31T08:00:00.000Z", scope: "PUBLIC_CONTENT_DERIVATIVE", integrity });

for (const condition of ["locked", "FROZEN", "PENDING_ENROLLMENT", "password-change"]) {
  test(`same session ${condition} clears existing configuration and rejects late results`, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const h = await harness(t, (_url, _init, n) => n === 1 ? response(storage()) : pending);
    assert.match(h.text(), /zzsh-staging-example/);
    const blocked = snapshot();
    if (condition === "locked") blocked.session.locked = true;
    else if (condition === "password-change") blocked.security.passwordChangeRequired = true;
    else blocked.security.status = condition;
    await h.render(0, blocked);
    assert.doesNotMatch(h.text(), /zzsh-staging-example/);
    assert.equal(h.requests.length, 1);
    await h.render(0, snapshot());
    assert.equal(h.requests.length, 2);
    await h.render(0, blocked);
    assert.equal(h.requests[1].init.signal.aborted, true);
    await act(async () => release(response(storage()))); await h.settle();
    assert.doesNotMatch(h.text(), /zzsh-staging-example/);
    assert.equal(h.container.querySelectorAll("button,a").length, 0);
  });
}

async function harness(t, handler, initialSnapshot = snapshot()) {
  const browser = new Window({ url: "http://127.0.0.1:3101/system" });
  for (const key of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "DOMRect", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement", "HTMLSelectElement", "DocumentFragment", "SVGElement"]) if (browser[key]) globalThis[key] = browser[key];
  Object.assign(globalThis, {
    window: browser, localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const beforeFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (input, init = {}) => { const url = new URL(String(input), browser.location.href); requests.push({ url, init }); return handler(url, init, requests.length); };
  const source = await createOfflineAdminSource({ root: fileURLToPath(new URL("../../../", import.meta.url)) });
  const module = await source.ssrLoadModule("/apps/admin/src/views/system-configuration-view.tsx");
  const { createRoot } = await import("react-dom/client");
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container);
  let identity = initialSnapshot;
  const render = async (refreshNonce = 0, nextSnapshot = identity) => { identity = nextSnapshot; await act(async () => root.render(createElement(module.SystemConfigurationView, { snapshot: identity, refreshNonce }))); };
  const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const click = async (text) => { const button = [...browser.document.body.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === text || node.textContent.trim() === text); assert.ok(button, `button ${text}`); await act(async () => button.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }))); await settle(); };
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = beforeFetch; container.remove(); await source.close(); await browser.happyDOM.abort(); });
  await render(); await settle();
  return { container, browser, requests, render, settle, click, module, text: () => container.textContent };
}

test("Boss reads deployment target without editable secrets, and GET has no write body", async t => {
  const h = await harness(t, () => response(storage({ accessKeySecret: "must-not-render", stsToken: "must-not-persist" })));
  assert.match(h.text(), /系统配置/); assert.match(h.text(), /媒体存储/); assert.match(h.text(), /zzsh-staging-example/);
  assert.match(h.text(), /已装配/); assert.match(h.text(), /尚未检查/); assert.doesNotMatch(h.text(), /读取通过|must-not-/);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url.pathname, "/api/bff/admin/system/storage");
  assert.equal(h.requests[0].init.method, "GET"); assert.equal(h.requests[0].init.body, undefined);
  assert.equal(h.container.querySelectorAll("input,textarea,select").length, 0);
  assert.equal(h.browser.localStorage.length, 0);
  assert.equal(h.container.querySelector("a").getAttribute("href"), "/content?tab=media");
});

test("Boss opens the account watermark rule on demand and saves with its current revision", async t => {
  const policy = { revision: "4", enabled: true, logoAssetId: "asset_logo", position: "se", sizePercent: 12, opacityPercent: 55, marginPercent: 2 };
  const path = "/api/bff/admin/system/account-image-watermark";
  const h = await harness(t, (url, init) => {
    if (url.pathname === path) return response({ policy, previewAvailable: false });
    if (url.pathname.endsWith("/storage")) return response(storage());
    return response({});
  });
  assert.equal(h.requests.some(request => request.url.pathname === path), false);
  await h.click("设置水印");
  const dialogText = () => h.browser.document.body.textContent;
  assert.match(dialogText(), /当前无法生成预览/);
  assert.match(h.browser.document.body.querySelector('img[alt="水印 Logo预览"]').getAttribute("src"), /asset_logo/);
  assert.doesNotMatch(dialogText(), /Logo 素材编号|预览用账号展示图编号/);
  await h.click("保存水印设置");
  const requests = h.requests.filter(request => request.url.pathname === path);
  assert.deepEqual(requests.map(request => request.init.method), ["GET", "PUT"]);
  const { revision, ...settings } = policy;
  assert.deepEqual(JSON.parse(requests[1].init.body), { ...settings, expectedRevision: revision });
  assert.match(new Headers(requests[1].init.headers).get("idempotency-key"), /^account-image-watermark-/);
  assert.match(dialogText(), /水印规则已保存/);
});

test("watermark chooses a PNG and previews with an automatic or selected sample", async t => {
  const path = "/api/bff/admin/system/account-image-watermark";
  const policy = { revision: "1", enabled: true, logoAssetId: null, position: "se", sizePercent: 12, opacityPercent: 55, marginPercent: 2 };
  const options = { items: [
    { id: "logo_png", mime: "image/png", width: 300, height: 100, byteSize: "1000" },
    { id: "sample_jpeg", mime: "image/jpeg", width: 1280, height: 720, byteSize: "2000" },
  ], nextCursor: null, limit: 20 };
  const h = await harness(t, (url, init) => {
    if (url.pathname === path) return response({ policy, previewAvailable: true });
    if (url.pathname === path + "/preview") return response(JSON.parse(init.body).assetId === null
      ? { images: [], state: "NO_SAMPLE" } : { images: [{ maxEdge: 640, url: "https://example.invalid/640" }] });
    if (url.pathname.endsWith("/content/media-options")) return response(options);
    if (url.pathname.endsWith("/storage")) return response(storage());
    return response({});
  });
  await h.click("设置水印");
  await h.click("选择图片");
  const logoDialog = [...h.browser.document.querySelectorAll("[role=dialog]")].find(dialog => dialog.querySelector(".content-image-option"));
  assert.ok(logoDialog);
  assert.equal(logoDialog.querySelectorAll(".content-image-option").length, 1, "Logo picker only offers PNG");
  const logo = logoDialog.querySelector('img[src*="logo_png"]').closest("button");
  await act(async () => logo.dispatchEvent(new h.browser.MouseEvent("click", { bubbles: true }))); await h.settle();
  await h.click("预览封面和详情");
  const previews = () => h.requests.filter(request => request.url.pathname === path + "/preview");
  assert.equal(JSON.parse(previews()[0].init.body).assetId, null);
  assert.equal(JSON.parse(previews()[0].init.body).logoAssetId, "logo_png");
  assert.match(h.browser.document.body.textContent, /暂无可用的账号图片，请选择或上传预览底图/);
  const chooseSample = [...h.browser.document.body.querySelectorAll("button")].find(button => button.textContent.trim() === "选择图片" && button.closest(".content-media-field")?.textContent.includes("更换预览底图"));
  await act(async () => chooseSample.dispatchEvent(new h.browser.MouseEvent("click", { bubbles: true }))); await h.settle();
  const sample = h.browser.document.querySelector('img[src*="sample_jpeg"]').closest("button");
  await act(async () => sample.dispatchEvent(new h.browser.MouseEvent("click", { bubbles: true }))); await h.settle();
  await h.click("预览封面和详情");
  assert.equal(JSON.parse(previews()[1].init.body).assetId, "sample_jpeg");
});

test("Boss can inspect SMS scene configuration without exposing credentials",async t=>{
  const scenes=['IDENTITY','REGISTER','LOGIN','BIND','RENTAL_EXPIRY','OWNER_ORDER_PAID'].map((scene,index)=>({
    scene,templateCode:index===4?null:'SMS_FIXTURE',source:index===4?'NOT_CONFIGURED':index===2?'SCENE':'SHARED',
    trigger:index>=4?'NOT_CONNECTED':'CONNECTED',
  }));
  const h=await harness(t,url=>response(url.pathname.endsWith('/sms')?{provider:'aliyun',signName:'测试签名',providerVerification:'NOT_RUN',scenes,accessKey:'must-not-render'}:storage()));
  assert.equal(h.requests.length,1);await h.click('查看短信配置');
  assert.equal(h.requests.at(-1).url.pathname,'/api/bff/admin/system/sms');
  const smsText = h.browser.document.body.textContent;
  assert.match(smsText,/登录/);assert.match(smsText,/租期到期提醒/);assert.match(smsText,/共用验证码模板/);
  assert.match(smsText,/模板已审核或短信已送达/);assert.doesNotMatch(smsText,/must-not-render/);
  assert.match(smsText,/更新 API 后可查看更换手机号和找回密码模板/);
});

test("SMS configuration displays new scenes and their actual fallback sources",async t=>{
  const scenes=['IDENTITY','REGISTER','LOGIN','BIND','RENTAL_EXPIRY','OWNER_ORDER_PAID'].map(scene=>({
    scene,templateCode:scene==='RENTAL_EXPIRY'||scene==='OWNER_ORDER_PAID'?null:'SMS_FIXTURE',
    source:scene==='RENTAL_EXPIRY'||scene==='OWNER_ORDER_PAID'?'NOT_CONFIGURED':'SCENE',
    trigger:scene==='RENTAL_EXPIRY'||scene==='OWNER_ORDER_PAID'?'NOT_CONNECTED':'CONNECTED',
  }));
  const additionalScenes=[
    {scene:'CHANGE_MOBILE',templateCode:'SMS_BIND',source:'RELATED',trigger:'CONNECTED'},
    {scene:'FORGOT_PASSWORD',templateCode:'SMS_FORGOT',source:'SCENE',trigger:'CONNECTED'},
  ];
  const h=await harness(t,url=>response(url.pathname.endsWith('/sms')?{provider:'aliyun',signName:'测试签名',providerVerification:'NOT_RUN',scenes,additionalScenes}:storage()));
  await h.click('查看短信配置');
  const rows=[...h.browser.document.body.querySelectorAll('[data-sms-scene]')].map(row=>row.textContent);
  assert(rows.some(row=>/更换手机号.*SMS_BIND.*复用绑定手机模板.*已接入/.test(row)));
  assert(rows.some(row=>/找回密码.*SMS_FORGOT.*场景专用.*已接入/.test(row)));
  assert.doesNotMatch(h.browser.document.body.textContent,/更新 API 后可查看/);
});

test("refund wait policy reads lazily and retries an unknown save with the original key and values", async t => {
  let writes = 0;
  const h = await harness(t, (url, init) => {
    if (!url.pathname.endsWith("/settlement-refund-policy")) return response(storage());
    if (init.method === "GET") return response({ normalDays: 0, earlyDays: 7, revision: "1", available: true });
    writes++;
    if (writes === 1) throw new Error("synthetic connection loss");
    return response({ policy: { normalDays: 1, earlyDays: 7, revision: "2", available: true }, changed: true });
  });
  assert.equal(h.requests.length, 1);
  await h.click("设置退款等待期"); await h.settle();
  assert.match(h.browser.document.body.textContent, /已结算订单保持原到期时间/);
  const input = [...h.browser.document.body.querySelectorAll("input")].find(item => item.value === "0");
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, "value").set.call(input, "1");
    input.dispatchEvent(new h.browser.Event("input", { bubbles: true }));
  });
  const clickDialog = async text => {
    const button = [...h.browser.document.body.querySelectorAll("button")].find(item => item.textContent.trim() === text);
    assert.ok(button && !button.disabled, text);
    await act(async () => button.click()); await h.settle();
  };
  await clickDialog("保存设置");
  assert.match(h.browser.document.body.textContent, /保存结果暂未确认/);
  await clickDialog("重试原操作");
  const requests = h.requests.filter(item => item.init.method === "PUT");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers["idempotency-key"], requests[1].init.headers["idempotency-key"]);
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.deepEqual(JSON.parse(requests[0].init.body), { normalDays: 1, earlyDays: 7, expectedRevision: "1" });
  assert.match(h.browser.document.body.textContent, /保存操作已确认/);
});

test("ordinary content reader has no system request or configuration disclosure", async t => {
  const h = await harness(t, () => { throw new Error("request must not occur"); }, snapshot(false));
  assert.equal(h.requests.length, 0); assert.match(h.text(), /仅 Boss/); assert.doesNotMatch(h.text(), /zzsh-staging/);
  assert.equal(h.container.querySelectorAll("button,a").length, 0);
});

test("local storage displays supported image scope without inventing an OSS target", async t => {
  const h = await harness(t, () => response(storage({ backend: "local", target: null, credentialMode: "NOT_APPLICABLE", automaticCredentialRefresh: null })));
  assert.match(h.text(), /本地存储/); assert.match(h.text(), /应用服务器本地目录/); assert.match(h.text(), /JPEG \/ PNG \/ WEBP/); assert.match(h.text(), /10 MiB/);
  assert.doesNotMatch(h.text(), /Bucket|Endpoint|zzsh-staging/);
});

test("sample read success names hash verification and keeps upload/private coverage separate", async t => {
  const h = await harness(t, url => response(storage({ check: url.pathname.endsWith("/check") ? checked("PASS", "PASS") : storage().check })));
  await h.click("检查读取");
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].url.pathname, "/api/bff/admin/system/storage/check"); assert.equal(h.requests[1].init.method, "GET");
  assert.match(h.text(), /样本读取通过/); assert.match(h.text(), /内容哈希一致/); assert.match(h.text(), /上传、私有图片权限和历史图片覆盖仍需分别验证/);
  assert.match(h.text(), /北京时间/);
});

test("no public sample is not reported as unavailable or passed", async t => {
  const h = await harness(t, () => response(storage({ check: checked("NO_PUBLIC_SAMPLE") })));
  assert.match(h.text(), /无公开样本/); assert.match(h.text(), /不能判断存储是否可用/); assert.doesNotMatch(h.text(), /样本读取通过|样本读取失败/);
});

test("refresh failure removes the old successful check and target", async t => {
  const h = await harness(t, (_url, _init, n) => n === 1 ? response(storage({ check: checked("PASS", "PASS") })) : response({ error: { code: "INTERNAL_ERROR" } }, 500));
  assert.match(h.text(), /样本读取通过/);
  await h.click("刷新配置");
  assert.doesNotMatch(h.text(), /样本读取通过|内容哈希一致|zzsh-staging-example/); assert.ok(h.container.querySelector('[role="alert"]'));
});

test("late previous response cannot replace refreshed data even when transport ignores abort", async t => {
  let release;
  const old = new Promise(resolve => { release = resolve; });
  const h = await harness(t, (_url, _init, n) => n === 1 ? old : response(storage({ target: { ...storage().target, bucket: "new-current-bucket" } })));
  await h.render(1); await h.settle();
  assert.equal(h.requests[0].init.signal.aborted, true); assert.match(h.text(), /new-current-bucket/);
  await act(async () => release(response(storage({ target: { ...storage().target, bucket: "old-late-bucket" }, check: checked("PASS", "PASS") })))); await h.settle();
  assert.match(h.text(), /new-current-bucket/); assert.doesNotMatch(h.text(), /old-late-bucket|样本读取通过/);
});

test("identity downgrade hides prior settings immediately and aborts outstanding request", async t => {
  let release;
  const h = await harness(t, () => new Promise(resolve => { release = resolve; }));
  await h.render(0, snapshot(false, "operator_2")); await h.settle();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].init.signal.aborted, true);
  await act(async () => release(response(storage()))); await h.settle();
  assert.match(h.text(), /仅 Boss/); assert.doesNotMatch(h.text(), /zzsh-staging-example/);
});

test("STS without renewal warns explicitly, and long paths can wrap on a single-column layout", async t => {
  const h = await harness(t, () => response(storage({ credentialMode: "STS", automaticCredentialRefresh: false, target: { ...storage().target, objectPrefix: "long/".repeat(60) } })));
  assert.match(h.text(), /临时凭据不会自动续期/); assert.match(h.text(), /STS 临时凭据/);
  assert.match(h.container.querySelector("dl").className, /grid-cols-1/); assert.match(h.container.querySelector("dl").className, /sm:grid-cols-2/);
  assert.ok([...h.container.querySelectorAll("dd")].some(node => node.classList.contains("break-all")));
});

test("malformed successful response is rejected rather than rendered as healthy", async t => {
  const h = await harness(t, () => response(storage({ configured: "true", check: { state: "PASS" } })));
  assert.ok(h.container.querySelector('[role="alert"]')); assert.doesNotMatch(h.text(), /样本读取通过|zzsh-staging-example/);
  const parse = h.module.parseSystemStorageConfiguration;
  assert.doesNotThrow(() => parse(storage()));
  for (const bad of [null, storage({ target: null }), storage({ limits: { maxBytes: -1, allowedMimes: [] } }), storage({ check: { ...checked("PASS"), checkedAt: "bad-date" } })]) assert.throws(() => parse(bad), /SYSTEM_STORAGE_CONTRACT_REQUIRED/);
});
