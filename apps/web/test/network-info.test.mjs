import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mountAuthComponent } from "./react-auth-harness.mjs";
import {
  NetworkInfoError,
  parseNetworkInfo,
  readNetworkInfo,
  resetNetworkInfoCacheForTest,
  IPWHOIS_PROVIDER,
  IPIFY_PROVIDER,
} from "../src/lib/network-info-client.ts";

const file = "apps/web/src/components/account/network-info.tsx";
const securityFile = "apps/web/src/components/account/account-security-controls.tsx";
const PROVIDER = IPWHOIS_PROVIDER;

/** 桩 ipwho.is 与 ipify，其余请求交回默认处理器。 */
const provider = (respond, requests = []) => async (url, body, init) => {
  if (!String(url).includes("ipify.org") && !String(url).includes("ipwho.is")) return Response.json({ status: true });
  requests.push({ url: String(url), init });
  return respond(requests.length);
};

beforeEach(() => {
  resetNetworkInfoCacheForTest();
});

test("解析接受 IPv4 与 IPv6 字面量，拒绝非 IP 的返回", () => {
  assert.deepEqual(parseNetworkInfo({ ip: "203.0.113.9" }), { ip: "203.0.113.9" });
  assert.deepEqual(parseNetworkInfo({ ip: "  2001:db8::1  " }), { ip: "2001:db8::1" }, "IPv6 同样有效并去空白");
  assert.equal(parseNetworkInfo(null), null);
  assert.equal(parseNetworkInfo("203.0.113.9"), null, "裸字符串不是合法返回体");
  assert.equal(parseNetworkInfo(["203.0.113.9"]), null);
  assert.equal(parseNetworkInfo({}), null, "缺 ip 字段即无效");
  assert.equal(parseNetworkInfo({ ip: 20301139 }), null, "非字符串不冒充 IP");
  assert.equal(parseNetworkInfo({ ip: "<html><body>Portal</body></html>" }), null, "门户改写的 HTML 不展示成 IP");
  assert.equal(parseNetworkInfo({ ip: "999.1.1.1" }), null, "越界八位组不是 IPv4");
  assert.equal(parseNetworkInfo({ ip: "" }), null);
});

test("读取只发一次无凭据请求，init 除固定选项外不携带任何平台身份", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ ip: "203.0.113.9" }); };
  try {
    const info = await readNetworkInfo();
    assert.equal(info.ip, "203.0.113.9");
    assert.equal(calls.length, 1, "单次读取，不轮询");
    assert.equal(calls[0].url, PROVIDER);
    const init = calls[0].init;
    assert.deepEqual(Object.keys(init).sort(), ["cache", "credentials", "method", "mode", "redirect", "referrerPolicy", "signal"], "没有 headers、没有 body、没有额外选项");
    assert.equal(init.credentials, "omit", "不发送平台 Cookie");
    assert.equal(init.referrerPolicy, "no-referrer", "不带来源页面");
    assert.equal(init.mode, "cors");
    assert.equal(init.cache, "no-store", "不落浏览器缓存");
    assert.equal(init.redirect, "error", "被重定向到门户即失败，不跟随");
    assert.equal(init.method, "GET");
    assert.ok(init.signal instanceof AbortSignal, "保留超时中断能力");
  } finally { globalThis.fetch = original; }
});

test("IPv6 按地址结构校验，不能仅凭字符集接受无效地址", () => {
  for (const ip of [":", "1:2:3", "1::2::3", "12345::1", "::ffff:999.1.1.1", "01.2.3.4"]) {
    assert.equal(parseNetworkInfo({ ip }), null, ip);
  }
  for (const ip of ["::1", "::", "::ffff:192.0.2.1", "2001:db8:0:1:2:3:4:5"]) {
    assert.deepEqual(parseNetworkInfo({ ip }), { ip }, ip);
  }
});

test("响应头之后的超时和断流不会误报为无效 IP", async () => {
  const original = globalThis.fetch;
  try {
    for (const [error, reason] of [[new DOMException("timed out", "TimeoutError"), "timeout"], [new TypeError("stream failed"), "unreachable"]]) {
      globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => { throw error; } });
      await assert.rejects(readNetworkInfo(), value => value instanceof NetworkInfoError && value.reason === reason);
    }
  } finally { globalThis.fetch = original; }
});

test("StrictMode effect 重放复用一次查询，挂载不产生重复外呼", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const p = await mountAuthComponent(file, "CurrentNetworkFields", {}, {
    strictMode: true,
    fetch: provider(count => count === 1 ? gate : Response.json({ ip: "203.0.113.9" }), requests),
  });
  try {
    assert.equal(requests.length, 1, "StrictMode 不重复外呼");
    release(Response.json({ ip: "203.0.113.9" }));
    await p.settle();
    assert.match(p.host.textContent, /203\.0\.113\.9/);
    assert.equal(requests.length, 1, "解决后仍保持单次请求");
  } finally { release(Response.json({ ip: "203.0.113.9" })); await p.close(); }
});

test("限流、超时、断网、非 2xx 与坏返回分别给出可区分的失败原因", async () => {
  const original = globalThis.fetch;
  const stub = value => { resetNetworkInfoCacheForTest(); globalThis.fetch = value; };
  try {
    stub(async () => Response.json({ ip: "203.0.113.9" }, { status: 429 }));
    await assert.rejects(readNetworkInfo(), error => error instanceof NetworkInfoError && error.reason === "rate-limited");

    stub(async () => { throw new DOMException("timed out", "TimeoutError"); });
    await assert.rejects(readNetworkInfo(), error => error instanceof NetworkInfoError && error.reason === "timeout");

    stub(async () => { throw new TypeError("Failed to fetch"); });
    await assert.rejects(readNetworkInfo(), error => error instanceof NetworkInfoError && error.reason === "unreachable");

    stub(async () => new Response("upstream boom", { status: 502 }));
    await assert.rejects(readNetworkInfo(), error => error instanceof NetworkInfoError && error.reason === "unreachable");

    stub(async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "application/json" } }));
    await assert.rejects(readNetworkInfo(), error => error instanceof NetworkInfoError && error.reason === "invalid");

    stub(async () => Response.json({ ip: "<html>Portal</html>" }));
    await assert.rejects(readNetworkInfo(), error => error instanceof NetworkInfoError && error.reason === "invalid");
  } finally { globalThis.fetch = original; }
});

test("挂载即查询一次，展示当前公网 IP，有详情时展示地理位置与运营商", async () => {
  const requests = [];
  const mockPayload = {
    ip: "203.0.113.9",
    type: "IPv4",
    country: "中国",
    region: "浙江省",
    city: "杭州市",
    connection: { isp: "中国电信", org: "China Telecom", asn: 4134 },
  };
  const p = await mountAuthComponent(file, "CurrentNetworkFields", {}, {
    initialStatus: "authenticated",
    fetch: provider(() => Response.json(mockPayload), requests),
  });
  try {
    await p.settle();
    assert.equal(requests.length, 1, "单次查询，不轮询");
    assert.equal(requests[0].init.credentials, "omit");
    assert.equal(requests[0].init.referrerPolicy, "no-referrer");
    const text = p.host.textContent;
    assert.match(text, /当前公网 IP/);
    assert.match(text, /203\.0\.113\.9/);
    assert.match(text, /基于当前网络出口查询，位置仅供参考/);
    assert.match(text, /浙江省 · 杭州市/);
    assert.match(text, /中国电信/);
    assert.ok(p.host.querySelector('button[aria-label="复制当前公网 IP"]'), "复制入口");
  } finally { await p.close(); }
});

test("429 额度耗尽且无可靠 IP 时整块隐藏，不留失效节点与空白", async () => {
  const requests = [];
  const p = await mountAuthComponent(file, "CurrentNetworkFields", {}, {
    initialStatus: "authenticated",
    fetch: provider(() => new Response(null, { status: 429 }), requests),
  });
  try {
    await p.settle();
    assert.equal(p.host.querySelector(".sec-network"), null);
    assert.doesNotMatch(p.host.textContent, /203\.0\.113\.9/);
  } finally { await p.close(); }
});

test("读取未完成前只展示占位，卸载后迟到的返回不改写已卸载的界面", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const p = await mountAuthComponent(file, "CurrentNetworkFields", {}, {
    initialStatus: "authenticated",
    fetch: provider(() => gate),
  });
  try {
    await p.settle();
    assert.match(p.host.textContent, /当前公网 IP/);
    assert.ok(p.host.querySelector(".sec-network-value") && !/203\.0\.113\.9/.test(p.host.textContent), "未返回前不出现任何 IP 值");
  } finally { await p.close(); }
  release(Response.json({ ip: "203.0.113.9" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.host.textContent, "", "卸载后迟到的返回不再写入 DOM");
});

test("集成：只有当前会话卡查询公网 IP，其他会话行与刷新会话列表都不触发外呼", async () => {
  const session = (id, isCurrent) => ({ id, isCurrent, createdAt: "2026-10-11T02:00:00Z", expiresAt: "2026-11-11T02:00:00Z", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
  const requests = [];
  const p = await mountAuthComponent(securityFile, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, {
    initialStatus: "authenticated",
    fetch: async (url, body, init) => {
      if (String(url).includes("ipify.org") || String(url).includes("ipwho.is")) { requests.push({ url: String(url), init }); return Response.json({ ip: "203.0.113.9" }); }
      if (String(url).endsWith("/overview")) return Response.json({ userId: "user_A", nickname: "自己的昵称", phoneNumber: "+8613800138000", email: null, passwordState: "set" });
      if (String(url).endsWith("/security/sessions")) return Response.json({ sessions: [session("s_current", true), session("s_other", false)] });
      return Response.json({ status: true });
    },
  });
  try {
    await p.settle();
    assert.equal(requests.length, 1, "两个会话只产生一次查询");
    assert.equal(requests[0].init.credentials, "omit", "查询不带平台凭据");
    const current = p.host.querySelector('[aria-labelledby="sec-current-session-heading"]');
    const others = p.host.querySelector('[aria-labelledby="sec-other-sessions-heading"]');
    assert.match(current.textContent, /203\.0\.113\.9/, "当前会话卡展示查询结果");
    assert.doesNotMatch(others.textContent, /当前公网 IP|203\.0\.113\.9/, "其他会话行不出现当前网络信息");

    await p.click("刷新会话列表");
    assert.equal(requests.length, 1, "刷新会话列表不会重新外呼公网 IP");
    assert.match(p.host.textContent, /退出全部会话/, "安全页操作不受网络信息影响");
  } finally { await p.close(); }
});
