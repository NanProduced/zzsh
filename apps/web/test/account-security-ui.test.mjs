import { test } from "node:test";
import assert from "node:assert/strict";
import { mountAuthComponent, deferred } from "./react-auth-harness.mjs";
const file = "apps/web/src/components/account/account-security-controls.tsx";
const overview = { userId: "user_A", nickname: "自己的昵称", phoneNumber: "+8613800138000", email: null, passwordState: "not-set" };
const iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const safariMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const session = (id, isCurrent, userAgent) => ({ id, isCurrent, createdAt: "2026-10-11T02:00:00Z", expiresAt: "2026-11-11T02:00:00Z", userAgent });
const defaultSessions = [session("s_current", true, chrome), session("s_other", false, iPhone)];
const response = value => Response.json(value);
function handler(options = {}) {
  const sessions = () => options.sessions === undefined ? defaultSessions : options.sessions;
  return async (url, body) => {
    // 第三方公网 IP 查询不是平台写入；不拦下会掉进末尾的通用写入记录器。
    if (String(url).includes("ipify.org") || String(url).includes("ipwho.is")) return response({ ip: "203.0.113.9", success: true });
    if (url.endsWith("/overview")) { if (options.read) return options.read(); return response(overview); }
    if (url.endsWith("/security/sessions")) { const value = sessions(); return value instanceof Error || typeof value === "function" ? (typeof value === "function" ? value(url, body) : (() => { throw value; })()) : response({ sessions: value }); }
    if (url.endsWith("/challenge/send")) return response({ status: true, challengeId: (body.stage === "target" ? "b" : "a").repeat(32), cooldownUntil: new Date(Date.now() + 60_000).toISOString() });
    if (url.endsWith("/challenge/verify")) return response({ status: true, proofId: body.challengeId });
    if (url.endsWith("/operation")) return response({ status: "completed" });
    if (options.write) return options.write(url, body);
    return response({ status: true });
  };
}
const mount = (options = {}, props = {}) => mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true, ...props }, { initialStatus: "authenticated", fetch: handler(options) });
async function passwordReady(p) { await p.click("设置密码"); await p.click("获取验证码"); await p.input("security-code", "123456"); await p.click("验证现有身份"); await p.input("security-password", "new-valid-password"); await p.input("security-password-confirm", "new-valid-password"); }
async function emailReady(p, address = "first@example.invalid") { await p.click("绑定邮箱"); await p.input("security-target", address); await p.click("获取验证码"); await p.input("security-code", "123456"); await p.click("验证现有身份"); await p.click("获取验证码"); await p.input("security-code", "123456"); await p.click("验证新联系方式"); }
const writes = (p, path) => p.calls.filter(item => item.url.endsWith(path));
const dialog = p => p.host.querySelector('[role="dialog"]');
/** 本机浏览器 UA 在真实环境由浏览器提供；测试里改写 happy-dom 的 navigator.userAgent 后重渲染。 */
async function localAgent(p, value) {
  Object.defineProperty(p.window.navigator, "userAgent", { value, configurable: true });
  await p.render();
  await p.settle();
}
const currentCard = p => p.host.querySelector('[aria-labelledby="sec-current-session-heading"]');
function responseWithStatus(status) { return Response.json({ error: { code: status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "INTERNAL_ERROR" } }, { status }); }

test("登录与找回区分密码未知与未设置，且不展示 UUID 或占位邮箱", async () => {
  const p = await mount({ read: async () => response({ ...overview, passwordState: "unavailable" }) });
  try {
    const row = [...p.host.querySelectorAll(".sec-row")].find(item => item.textContent.includes("登录密码"));
    assert.match(row.textContent, /暂无法确认/);
    assert.doesNotMatch(row.textContent, /未设置/);
    assert.doesNotMatch(p.host.textContent, /user_A/);
    assert.match(p.host.textContent, /尚未绑定/);
  } finally { await p.close(); }
});

test("密码三态各自成句，未设置不作为危险状态", async () => {
  for (const [state, expected, forbidden] of [["set", /已设置/, /未设置/], ["not-set", /未设置/, /已设置|暂无法确认/], ["unavailable", /暂时无法确认密码状态/, /未设置/]]) {
    const p = await mount({ read: async () => response({ ...overview, passwordState: state }) });
    try {
      const row = [...p.host.querySelectorAll(".sec-row")].find(item => item.textContent.includes("登录密码"));
      assert.match(row.textContent, expected);
      assert.doesNotMatch(row.textContent, forbidden);
      assert.equal(row.querySelector("[data-password-state]").getAttribute("data-password-state"), state);
    } finally { await p.close(); }
  }
});

test("找回邮箱只按服务端事实脱敏展示，且不暗示邮箱登录", async () => {
  const p = await mount({ read: async () => response({ ...overview, email: "a-very-long-recovery-name@example-team.invalid" }) });
  try {
    const row = [...p.host.querySelectorAll(".sec-row")].find(item => item.textContent.includes("找回邮箱"));
    assert.match(row.textContent, /^.*a-\*\*\*@example-team\.invalid/);
    assert.doesNotMatch(row.textContent, /a-very-long-recovery-name@example-team\.invalid/);
    assert.match(row.textContent, /不支持用邮箱登录/);
    p.findButton("更换邮箱");
  } finally { await p.close(); }
});

test("会话首次进入即读取，当前会话独立展示且不争夺主操作", async () => {
  const p = await mount();
  try {
    await p.settle();
    assert.equal(writes(p, "/security/sessions").length, 1);
    const rows = [...p.host.querySelectorAll(".sec-session")];
    assert.equal(rows.length, 1, "列表只放其他会话");
    assert.match(rows[0].textContent, /iPhone · Safari/);
    assert.doesNotMatch(rows[0].textContent, /Mozilla/);
    const card = currentCard(p);
    assert.match(card.textContent, /正在使用/);
    assert.equal(card.querySelector(".sec-session"), null, "当前会话不再重复占用列表行");
    assert.equal([...card.querySelectorAll("button")].some(node => /退出/.test(node.textContent)), false, "当前会话区不提供退出动作");
  } finally { await p.close(); }
});

test("设备名称保守派生：缺 UA 与无法识别都回退，且两种缺值不混用", async () => {
  const p = await mount({ sessions: [session("s_current", true, chrome), session("s_weird", false, "totally-unknown-agent"), session("s_missing", false, null), session("s_long", false, "x".repeat(512))] });
  try {
    await p.settle();
    const rows = [...p.host.querySelectorAll(".sec-session")];
    const missing = rows.find(node => node.getAttribute("data-record") === "missing");
    const unrecognized = rows.filter(node => node.getAttribute("data-record") === "unrecognized");
    assert.equal(missing.querySelector(".sec-session-title strong").textContent, "设备信息未知", "无记录写「设备信息未知」");
    assert.match(missing.querySelector(".sec-session-detail").textContent, /登录时未记录客户端信息/);
    assert.doesNotMatch(missing.querySelector(".sec-session-detail").textContent, /客户端未识别/, "无记录不混用第二种措辞");
    for (const row of unrecognized) {
      assert.equal(row.querySelector(".sec-session-title strong").textContent, "客户端未识别", "有记录但认不出写「客户端未识别」");
      assert.doesNotMatch(row.querySelector(".sec-session-detail").textContent, /设备信息未知|桌面端网页|移动端网页|Windows|iPhone/, "不猜设备名也不声称设备类型");
    }
    assert.doesNotMatch(p.host.textContent, /xxxxx/);
    assert.doesNotMatch(p.host.textContent, /在线设备/);
  } finally { await p.close(); }
});

test("没有其他会话时保留当前会话并明确空态，区头退出其他会话不可用", async () => {
  const p = await mount({ sessions: [session("s_current", true, chrome)] });
  try {
    await p.settle();
    assert.match(p.host.textContent, /暂无其他有效会话/);
    assert.equal(p.host.querySelectorAll(".sec-session").length, 0);
    assert.ok(currentCard(p).querySelector(".sec-current-hero"), "当前会话摘要保留");
    assert.ok(p.findButton("退出其他会话").disabled);
  } finally { await p.close(); }
});

test("会话读取失败与空列表分开呈现，局部重试不重载安全设置", async () => {
  let fail = false;
  const p = await mount({ sessions: () => fail ? responseWithStatus(503) : response({ sessions: defaultSessions }) });
  try {
    await p.settle();
    fail = true;
    await p.click("刷新会话列表");
    assert.match(p.host.textContent, /结果暂时无法确认，请先重新读取状态/);
    assert.equal(p.host.querySelector(".sec-session"), null);
    assert.doesNotMatch(p.host.textContent, /暂无其他有效会话/);
    // 会话失败不能抹掉已经读到的安全设置事实。
    assert.match(p.host.textContent, /138\*\*\*\*8000/);
    const before = writes(p, "/security/overview").length;
    fail = false;
    await p.click("重新读取");
    assert.equal(writes(p, "/security/overview").length, before);
    assert.equal(p.host.querySelectorAll(".sec-session").length, 1);
  } finally { await p.close(); }
});

test("概况读取在首次成功后失权时撤下旧事实，不独立影响会话读取", async () => {
  let forbidden = false;
  const p = await mount({ read: async () => forbidden ? responseWithStatus(403) : response(overview) });
  try {
    await p.settle();
    assert.match(p.host.textContent, /138\*\*\*\*8000/);
    assert.ok(p.host.querySelector('[data-security-action="password"]'));
    forbidden = true;
    await p.click("刷新");
    // 已失权的联系方式事实与全部写入入口都必须撤下（昵称表单已迁往总览，本页不再有它）。
    assert.doesNotMatch(p.host.textContent, /138\*\*\*\*8000|已绑定|已验证/);
    assert.equal(p.host.querySelectorAll(".sec-row").length, 0);
    assert.equal(p.host.querySelector('[data-security-action="password"]'), null);
    assert.equal([...p.host.querySelectorAll("[data-security-action]")].length, 0);
    assert.ok(p.host.querySelector(".info-local-retry"));
    // 会话读取独立成功，不能被概况失败抹掉。
    assert.equal(p.host.querySelectorAll(".sec-session").length, 1);
    assert.ok(currentCard(p).querySelector(".sec-current-hero"));
  } finally { await p.close(); }
});

test("会话刷新失败后旧目标不能再发起撤销，但已发出的 pending 意图保留", async () => {
  let failSessions = false, delivered = false;
  const p = await mount({
    sessions: () => failSessions ? responseWithStatus(403) : response({ sessions: delivered ? [session("s_current", true, chrome)] : defaultSessions }),
    write: async url => { if (url.includes("revoke")) { delivered = true; failSessions = true; } return response({ status: true }); },
  });
  try {
    await p.settle();
    assert.equal(p.host.querySelectorAll(".sec-session").length, 1);
    assert.ok(![...p.host.querySelectorAll(".sec-session-tools button")].find(n => n.innerText === "退出其他会话").disabled);
    failSessions = true;
    await p.click("刷新会话列表");
    assert.equal(p.host.querySelector(".sec-session"), null);
    const others = [...p.host.querySelectorAll(".sec-session-tools button")].find(n => n.innerText === "退出其他会话");
    assert.ok(others.disabled, "旧快照不得继续作为撤销目标");
    assert.equal(p.host.querySelector(".sec-row-action.is-danger"), null);
    assert.equal(p.host.querySelector(".sec-foot-danger"), null);
    others.click(); await p.settle();
    assert.equal(p.host.querySelector('[role="dialog"]'), null, "点击旧目标不得打开确认框");
    assert.equal(writes(p, "/security/sessions/revoke-others").length, 0);
  } finally { await p.close(); }
});

test("会话合同损坏成为读取失败，不崩页也不退化成空列表", async () => {
  const bad = [
    ["坏日期", { sessions: [{ id: "s1", isCurrent: true, createdAt: "invalid-date", expiresAt: "2026-11-11T02:00:00Z", userAgent: chrome }] }],
    ["非数组", { sessions: "nope" }],
    ["坏 isCurrent", { sessions: [{ id: "s1", isCurrent: "yes", createdAt: "2026-10-11T02:00:00Z", expiresAt: "2026-11-11T02:00:00Z", userAgent: chrome }] }],
    ["缺 id", { sessions: [{ isCurrent: true, createdAt: "2026-10-11T02:00:00Z", expiresAt: "2026-11-11T02:00:00Z", userAgent: chrome }] }],
  ];
  for (const [label, payload] of bad) {
    const p = await mount({ sessions: () => response(payload) });
    try {
      await p.settle();
      assert.ok(p.host.querySelector(".info-local-retry"), `${label} 应成为局部读取失败`);
      assert.equal(p.host.querySelector(".sec-session"), null, label);
      assert.doesNotMatch(p.host.textContent, /暂无其他有效会话/, `${label} 不得退化成空列表`);
      assert.match(p.host.textContent, /138\*\*\*\*8000/, `${label} 不得抹掉独立成功的概况读取`);
    } finally { await p.close(); }
  }
});

test("撤销确认阶段读到坏合同时保持待确认，不误判为已完成", async () => {
  let delivered = false;
  const p = await mount({
    // 语义上"其他会话都已消失"，但时间戳不可解析：只有合同校验能阻止把它当成撤销已完成。
    sessions: () => response({ sessions: delivered ? [{ id: "s_current", isCurrent: true, createdAt: "broken", expiresAt: "2026-11-12T01:12:00.000Z", userAgent: chrome }] : defaultSessions }),
    write: async url => { if (url.includes("revoke")) delivered = true; return response({ status: true }); },
  });
  try {
    await p.settle();
    await p.click("退出其他会话");
    await p.click("确认退出");
    assert.equal(writes(p, "/security/sessions/revoke-others").length, 1);
    assert.match(p.host.textContent, /操作结果待确认/, "坏合同不得被当作撤销已完成");
    assert.ok(p.findButton("重新确认结果"));
  } finally { await p.close(); }
});

test("无法识别的 UA 不声称桌面端，iOS 第三方内核不误报 Safari", async () => {
  const cases = [
    ["totally-unknown-agent", "客户端未识别", null],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1", "iPhone · Chrome", "移动端网页"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15", "iPad · Firefox", "移动端网页"],
  ];
  const p = await mount({ sessions: () => response({ sessions: [session("s_current", true, chrome), ...cases.map(([ua], i) => session(`s_${i}`, false, ua))] }) });
  try {
    await p.settle();
    assert.equal(p.host.querySelectorAll(".sec-session").length, 3, "其他会话列表只放非当前会话");
    for (const [index, [ua, label, kind]] of cases.entries()) {
      const rowNode = p.host.querySelector(`[data-session-id="s_${index}"]`);
      assert.ok(rowNode, `missing session s_${index}`);
      const row = rowNode.textContent.replace(/\s+/g, " ");
      assert.ok(row.includes(label), `${ua} → ${label}, got ${row}`);
      if (kind) assert.ok(row.includes(kind), `${ua} → ${kind}, got ${row}`);
      else assert.ok(!/桌面端网页|移动端网页/.test(row), `无法识别的 UA 不声称设备类型，got ${row}`);
    }
  } finally { await p.close(); }
});

test("会话读取 403 呈现为不可读取而不是空列表，也不承诺重新登录可解", async () => {
  const p = await mount({ sessions: () => responseWithStatus(403) });
  try {
    await p.settle();
    assert.doesNotMatch(p.host.textContent, /暂无其他有效会话/);
    assert.ok(p.host.querySelector(".info-local-retry"));
    assert.match(p.host.textContent, /当前身份无法读取该信息/);
    assert.doesNotMatch(p.host.textContent, /重新确认登录身份/);
  } finally { await p.close(); }
});

for (const status of [0, 401, 503]) test(`已接受的密码写入遇到 ${status || "网络"} 读取失败时阻断一切重复写入`, async () => {
  let accepted = false, recovered = false;
  const p = await mount({
    read: async () => { if (accepted && !recovered) { if (!status) throw new Error("lost read"); return responseWithStatus(status); } return response({ ...overview, passwordState: accepted ? "set" : "not-set" }); },
    write: async () => { accepted = true; return response({ status: true }); },
  });
  try {
    await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); assert.match(p.host.textContent, /操作已接受/);
    if (status === 401) { assert.equal(p.confirmations, 1); assert.equal(p.host.querySelector("#security-nickname"), null); }
    else await p.submit('form[aria-label="设置或修改密码"]');
    assert.equal(writes(p, "/security/password").length, 1);
    recovered = true; await p.click("重新确认结果"); assert.match(p.host.textContent, /操作结果已确认/);
    assert.equal(writes(p, "/security/password").length, 1);
  } finally { await p.close(); }
});

test("结果未知的密码写入沿用同一回执且只重试读取", async () => {
  const p = await mount({ write: async () => { throw new Error("lost write result"); } });
  try {
    await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); assert.match(p.host.textContent, /操作结果待确认/);
    await p.submit('form[aria-label="设置或修改密码"]'); assert.equal(writes(p, "/security/password").length, 1);
    await p.click("重新确认结果"); assert.equal(writes(p, "/security/password").length, 1);
  } finally { await p.close(); }
});

test("关闭分步弹窗不丢失恢复责任，也不会建立第二次意图", async () => {
  const p = await mount({ write: async () => { throw new Error("write unknown"); } });
  try {
    await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]');
    assert.ok(dialog(p));
    await p.click("关闭对话框");
    assert.equal(dialog(p), null);
    // 页面级仍保留待确认责任与冻结的原意图。
    assert.match(p.host.textContent, /操作结果待确认/);
    assert.ok(p.findButton("重新确认结果"));
    assert.ok(p.findButton("设置密码").disabled);
    await p.click("重新确认结果");
    assert.equal(writes(p, "/security/password").length, 1);
    assert.equal(writes(p, "/security/operation").length, 1);
  } finally { await p.close(); }
});

test("改变已暂存的邮箱目标会清空两枚证明且不能提交原目标", async () => {
  const p = await mount();
  try {
    await emailReady(p);
    await p.input("security-target", "second@example.invalid");
    await p.submit('form[aria-label="绑定或更换邮箱"]');
    assert.equal(writes(p, "/security/email").length, 0);
    assert.equal(p.host.querySelector("#security-code").value, "");
    assert.match(p.host.textContent, /先验证现有身份控制权/);
  } finally { await p.close(); }
});

test("验证渠道只列服务端事实支持的方式", async () => {
  const p = await mount({ read: async () => response({ ...overview, phoneNumber: null, email: null }) });
  try {
    await p.click("设置密码");
    assert.equal(p.host.querySelector("#security-channel"), null);
    assert.match(p.host.textContent, /当前没有可用于验证身份的联系方式/);
    assert.ok(p.findButton("获取验证码").disabled);
    assert.equal(writes(p, "/security/challenge/send").length, 0);
  } finally { await p.close(); }
});

test("身份未确认时隐藏全部私密安全事实并丢弃迟到响应", async () => {
  const gate = deferred(); let allowed = true;
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => allowed }, { initialStatus: "authenticated", fetch: handler({ read: async () => { await gate.promise; return response(overview); } }) });
  try {
    allowed = false; await p.render(); gate.resolve(); await p.settle();
    assert.doesNotMatch(p.host.textContent, /user_A|自己的昵称|138|iPhone/);
    assert.match(p.host.textContent, /确认登录身份/);
  } finally { gate.resolve(); await p.close(); }
});

for (const path of ["overview", "sessions", "challenge/send", "challenge/verify", "password"]) test(`${path} 明确 401 经共享会话失效缓存的安全事实`, async () => {
  let reject = false, allowed = true;
  const normal = handler();
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => allowed }, {
    initialStatus: "authenticated", revalidate: () => { allowed = false; },
    fetch: async (url, body) => reject && url.endsWith("/security/" + path) ? responseWithStatus(401) : normal(url, body),
  });
  try {
    await p.settle();
    if (path === "overview") { reject = true; await p.click("刷新"); }
    else if (path === "sessions") { reject = true; await p.click("刷新会话列表"); }
    else if (path === "password") { await passwordReady(p); reject = true; await p.submit('form[aria-label="设置或修改密码"]'); }
    else { await p.click("设置密码"); if (path.endsWith("verify")) { await p.click("获取验证码"); await p.input("security-code", "123456"); } reject = true; await p.click(path.endsWith("send") ? "获取验证码" : "验证现有身份"); }
    assert.equal(p.confirmations, 1);
    assert.doesNotMatch(p.host.textContent, /user_A|自己的昵称|138|iPhone/);
    assert.match(p.host.textContent, /确认登录身份/);
  } finally { await p.close(); }
});

test("密码变更确认后重载会话列表，不留下被换发的旧当前会话", async () => {
  let committed = false;
  const p = await mount({
    read: async () => response({ ...overview, passwordState: committed ? "set" : "not-set" }),
    sessions: () => response({ sessions: committed ? [session("s_new", true, chrome)] : defaultSessions }),
    write: async () => { committed = true; return response({ status: true }); },
  });
  try {
    await p.settle();
    assert.equal(p.host.querySelectorAll(".sec-session").length, 1);
    await passwordReady(p);
    await p.submit('form[aria-label="设置或修改密码"]');
    assert.match(p.host.textContent, /操作已完成/);
    assert.equal(writes(p, "/security/sessions").length, 2, "确认成功后必须再读一次会话");
    const rows = p.host.querySelectorAll(".sec-session");
    assert.equal(rows.length, 0, "被换发的旧会话不留在其他会话列表");
    assert.ok(currentCard(p).querySelector(".sec-current-hero"), "当前会话摘要跟着重载");
    assert.match(p.host.textContent, /暂无其他有效会话/);
  } finally { await p.close(); }
});

test("密码校验留在本次流程内，逐字段关联错误并聚焦到出错的字段", async () => {
  const p = await mount();
  try {
    await passwordReady(p);
    await p.input("security-password", "short");
    await p.input("security-password-confirm", "short-but-different");
    await p.submit('form[aria-label="设置或修改密码"]');
    const form = p.host.querySelector('form[aria-label="设置或修改密码"]');
    assert.ok(form.querySelector('#security-result[role="alert"]'));
    assert.equal(p.window.document.activeElement.id, "security-password");
    const length = form.querySelector("#security-password");
    assert.equal(length.getAttribute("aria-invalid"), "true");
    assert.match(length.getAttribute("aria-describedby"), /security-result/);
    assert.equal(form.querySelector("#security-password-confirm").getAttribute("aria-invalid"), null);
    assert.equal(writes(p, "/security/password").length, 0);
    // 长度通过后，错误改指向确认字段。
    await p.input("security-password", "new-valid-password");
    await p.submit('form[aria-label="设置或修改密码"]');
    assert.equal(form.querySelector("#security-password-confirm").getAttribute("aria-invalid"), "true");
    assert.equal(form.querySelector("#security-password").getAttribute("aria-invalid"), null);
    assert.equal(writes(p, "/security/password").length, 0);
  } finally { await p.close(); }
});

test("密码支持显示切换且不影响自动填充语义", async () => {
  const p = await mount();
  try {
    await passwordReady(p);
    const field = p.host.querySelector("#security-password");
    assert.equal(field.getAttribute("autocomplete"), "new-password");
    assert.equal(field.type, "password");
    await p.click("显示密码");
    assert.equal(p.host.querySelector("#security-password").type, "text");
    assert.equal(p.host.querySelector("#security-password-confirm").type, "text");
    assert.equal(p.host.querySelector(".auth-password-toggle").getAttribute("aria-pressed"), "true");
    await p.click("隐藏密码");
    assert.equal(p.host.querySelector("#security-password").type, "password");
  } finally { await p.close(); }
});

test("敏感变更成功后焦点回到原操作入口", async () => {
  const p = await mount();
  try {
    p.findButton("设置密码").focus();
    await passwordReady(p);
    await p.submit('form[aria-label="设置或修改密码"]');
    await p.React.act(async () => new Promise(resolve => setTimeout(resolve, 1)));
    assert.equal(p.window.document.activeElement.textContent, "设置密码");
    assert.equal(dialog(p), null);
  } finally { await p.close(); }
});

test("未知写入保持锁定，直到服务端确认未使用的证明已过期", async () => {
  let expired = false;
  const normal = handler({ write: async () => { throw new Error("write never delivered"); } });
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: async (url, body) => url.endsWith("/operation") ? response({ status: expired ? "expired" : "unconfirmed" }) : normal(url, body) });
  try {
    await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); await p.click("重新确认结果");
    assert.ok(p.findButton("确认保存密码").disabled);
    assert.match(p.host.textContent, /5 分钟/);
    expired = true; await p.click("重新确认结果");
    assert.equal(p.host.querySelector("#security-password"), null);
    assert.match(p.host.textContent, /原验证过期且操作未完成/);
    assert.ok(!p.findButton("获取验证码").disabled);
    assert.equal(writes(p, "/security/password").length, 1);
  } finally { await p.close(); }
});

test("未知写入经共享登出结束其作用域；登出失败绝不放行重复写入", async () => {
  let allowed = true, exitAllowed = false;
  const p = await mount({ write: async () => { throw new Error("write unknown"); } });
  p.session.signOut = async () => { if (!exitAllowed) throw new Error("exit unknown"); allowed = false; };
  try {
    await passwordReady(p);
    await p.submit('form[aria-label="设置或修改密码"]');
    await p.click("退出登录后重新确认");
    assert.match(p.host.textContent, /原操作结果仍未知/);
    assert.ok(p.findButton("确认保存密码").disabled);
    exitAllowed = true; await p.click("退出登录后重新确认"); await p.render();
    assert.doesNotMatch(p.host.textContent, /user_A|自己的昵称/);
    assert.equal(writes(p, "/security/password").length, 1);
  } finally { await p.close(); }
});

for (const scope of ["one", "others", "all"]) test(`${scope} 撤销在确认弹窗内冻结目标，确认后才发出一次写入`, async () => {
  const revoked = [];
  const p = await mount({ write: async (url, body) => { revoked.push({ url, body }); return response({ status: true, currentRevoked: scope === "all" || scope === "one" && body?.sessionId === "s_current" }); } });
  try {
    await p.settle();
    if (scope === "one") await p.click("退出此会话"); else await p.click(scope === "others" ? "退出其他会话" : "退出全部会话");
    const panel = dialog(p);
    assert.ok(panel, "确认弹窗已打开");
    assert.equal(writes(p, "/security/sessions").length, 1, "打开确认框不产生写入");
    // 目标摘要在打开时冻结。
    assert.match(panel.textContent, /iPhone · Safari/);
    if (scope === "all") assert.match(panel.textContent, /包括当前会话/);
    if (scope === "others") assert.match(panel.textContent, /当前会话继续保留/);
    await p.click("确认退出");
    assert.equal(dialog(p), null);
    assert.equal(revoked.length, 1);
    assert.ok(revoked[0].url.endsWith(scope === "one" ? "/security/sessions/revoke" : "/security/sessions/revoke-" + scope));
    assert.equal(revoked[0].body.sessionId, scope === "one" ? "s_other" : undefined);
  } finally { await p.close(); }
});

test("取消撤销确认不发出任何写入", async () => {
  const p = await mount();
  try {
    await p.settle();
    await p.click("退出其他会话");
    assert.ok(dialog(p));
    await p.click("暂不退出");
    assert.equal(dialog(p), null);
    assert.equal(writes(p, "/security/sessions/revoke").length, 0);
    assert.equal(writes(p, "/security/sessions/revoke-others").length, 0);
  } finally { await p.close(); }
});

test("退出当前会话经共享登出确认结果，而不是重放撤销写入", async () => {
  let signedOut = false;
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, {
    initialStatus: "authenticated",
    confirm: async () => (signedOut ? "guest" : "authenticated"),
    fetch: handler({ sessions: [session("s_current", true, chrome)] }),
  });
  try {
    await p.settle();
    await p.click("退出全部会话");
    await p.click("确认退出");
    assert.equal(writes(p, "/security/sessions/revoke-all").length, 1);
    assert.match(p.host.textContent, /操作结果待确认/);
    signedOut = true;
    await p.click("重新确认结果");
    assert.match(p.host.textContent, /操作结果已确认/);
    assert.equal(writes(p, "/security/sessions/revoke-all").length, 1);
  } finally { await p.close(); }
});

test("撤销结果未知时只查询会话列表，不重放撤销写入", async () => {
  let delivered = false;
  const p = await mount({
    write: async (url) => { if (url.includes("revoke")) { if (!delivered) throw new Error("unknown"); delivered = true; } return response({ status: true }); },
    sessions: () => response({ sessions: delivered ? [session("s_current", true, chrome)] : defaultSessions }),
  });
  try {
    await p.settle();
    await p.click("退出其他会话");
    await p.click("确认退出");
    assert.match(p.host.textContent, /操作结果待确认/);
    assert.equal(writes(p, "/security/sessions/revoke-others").length, 1);
    delivered = true;
    await p.click("重新确认结果");
    assert.equal(writes(p, "/security/sessions/revoke-others").length, 1);
    assert.match(p.host.textContent, /操作结果已确认/);
    assert.equal(p.host.querySelectorAll(".sec-session").length, 0, "其他会话都已退出");
  } finally { await p.close(); }
});

for (const changeUser of [false, true]) test(`完成焦点在同主体重挂载后仍然交接，但绝不跟随${changeUser ? "另一个主体" : "已移除的过期控件"}`, async () => {
  let id = "user_A";
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: id, canAct: () => true }, { initialStatus: "authenticated", fetch: handler({ read: async () => response({ ...overview, userId: id }) }) });
  try {
    p.findButton("设置密码").focus(); await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]');
    if (changeUser) { id = "user_B"; p.identity.userId = id; }
    await p.render({ key: "confirmed-new-scope", userId: id }); await p.settle(); await p.React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    assert.equal(p.window.document.activeElement.getAttribute("data-security-action") === "password", !changeUser);
    assert.equal(p.host.querySelector(".account-security-controls").dataset.userId, id);
  } finally { await p.close(); }
});

test("用户已移开焦点时完成流程不抢回焦点", async () => {
  const gate = deferred();
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler({ write: async () => { await gate.promise; return response({ status: true }); } }) });
  try {
    p.findButton("设置密码").focus(); await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]');
    const search = p.window.document.createElement("input"); search.id = "external-search"; p.window.document.body.append(search); search.focus();
    gate.resolve(); await p.settle(); await p.React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    assert.equal(p.window.document.activeElement.id, "external-search");
  } finally { gate.resolve(); await p.close(); }
});

test("继承的待确认回执可在概况初次读取失败后跨重挂载交接焦点", async () => {
  let readable = false; const pendingWrite = { current: { userId: "user_A", intent: { action: "password", operationId: "a".repeat(32) }, accepted: false, target: "" } };
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true, pendingWrite }, { initialStatus: "authenticated", fetch: handler({ read: async () => readable ? response(overview) : responseWithStatus(503) }) });
  try {
    readable = true;
    p.findButton("重新确认结果").focus();
    await p.click("重新确认结果");
    await p.render({ key: "confirmed-current-scope" }); await p.settle(); await p.React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    assert.equal(p.window.document.activeElement.getAttribute("data-security-action"), "password");
    assert.equal(pendingWrite.current, null);
  } finally { await p.close(); }
});

for (const branch of ["receipt", "accepted-overview"]) for (const restoredIdentity of ["same-user", "guest", "different-user"]) test(`${branch} 401 清除私密投影、保留写入结论，并且只恢复${restoredIdentity}`, async () => {
  let allowed = true, rejected = false, committed = false;
  const operationId = "a".repeat(32);
  const pendingWrite = { current: branch === "receipt" ? { userId: "user_A", intent: { action: "password", operationId }, accepted: false, target: "" } : null };
  const normal = handler({ read: async () => rejected && branch === "accepted-overview" ? responseWithStatus(401) : response({ ...overview, passwordState: committed ? "set" : "not-set" }), write: async () => { committed = true; rejected = true; return response({ status: true }); } });
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => allowed, pendingWrite }, {
    initialStatus: "authenticated", revalidate: () => { allowed = false; }, fetch: async (url, body) => {
      if (url.endsWith("/sessions")) return response({ sessions: [{ id: "old-session", isCurrent: true, createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z", userAgent: iPhone }] });
      if (rejected && branch === "receipt" && url.endsWith("/operation")) return responseWithStatus(401);
      return normal(url, body);
    } });
  try {
    if (branch === "receipt") { rejected = true; await p.click("重新确认结果"); }
    else { await p.settle(); await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); }
    assert.equal(p.confirmations, 1);
    assert.doesNotMatch(p.host.textContent, /自己的昵称|138|iPhone/);
    assert.equal(p.host.querySelector('[data-security-action="phone"]'), null);
    assert.equal(pendingWrite.current.intent.operationId, operationId);
    assert.equal(pendingWrite.current.accepted, branch === "accepted-overview");
    const writeCount = branch === "receipt" ? 0 : 1;
    assert.equal(writes(p, "/security/password").length, writeCount);
    if (restoredIdentity === "same-user") {
      rejected = false; allowed = true; await p.render({ key: "same-confirmed-user" });
      assert.ok(p.findButton("重新确认结果").disabled === false);
      assert.ok(p.host.querySelector('[data-security-action="password"]').disabled);
      await p.click("重新确认结果");
      assert.equal(pendingWrite.current, null);
      const receipts = p.calls.filter(c => c.url.endsWith("/operation"));
      assert.ok(receipts.every(c => c.body.operationId === operationId));
      assert.equal(writes(p, "/security/challenge/send").length, branch === "receipt" ? 0 : 1);
    } else {
      // AccountWorkspace drops transient data only after guest or a different UID is confirmed.
      pendingWrite.current = null; p.identity.status = restoredIdentity === "guest" ? "guest" : "authenticated"; p.identity.userId = restoredIdentity === "guest" ? null : "user_B";
      await p.render({ key: "scope-ended", userId: p.identity.userId ?? "guest" });
      assert.doesNotMatch(p.host.textContent, /自己的昵称|138|iPhone|重新确认结果/);
    }
    assert.equal(writes(p, "/security/password").length, writeCount);
  } finally { await p.close(); }
});

test("安全设置影响说明改为标题旁可聚焦信息按钮，正文不再占整卡", async () => {
  const p = await mount();
  try {
    await p.settle();
    assert.equal(p.host.querySelector(".info-callout"), null, "原「变更后」Callout 已移除");
    assert.doesNotMatch(p.host.textContent, /变更后/);
    const trigger = p.host.querySelector(".sec-info-trigger");
    assert.ok(trigger, "信息按钮存在");
    assert.equal(trigger.getAttribute("aria-label"), "修改安全设置会影响哪些会话？");
    await p.React.act(async () => { trigger.focus(); });
    const content = p.window.document.querySelector(".sec-info-content");
    assert.ok(content, "键盘聚焦后展示说明");
    assert.match(content.textContent, /修改安全设置会影响哪些会话？/);
    assert.match(content.textContent, /修改成功后，其他会话将退出；当前会话更新，到期时间不变。/);
    await p.React.act(async () => { trigger.blur(); });
    assert.equal(p.window.document.querySelector(".sec-info-content"), null, "失焦后收起");
    // 最终提交弹窗仍保留简短影响说明，不把后果全部藏进 Tooltip。
    await passwordReady(p);
    assert.match(dialog(p).textContent, /其他有效会话都会退出/);
  } finally { await p.close(); }
});

test("其他会话行可展开有依据的详细信息，当前会话不走列表展开", async () => {
  const p = await mount();
  try {
    await p.settle();
    const rows = [...p.host.querySelectorAll(".sec-session")];
    assert.equal(rows.length, 1);
    assert.equal(currentCard(p).querySelector(".sec-session-expand"), null, "当前会话不提供列表展开控件");
    const toggle = rows[0].querySelector(".sec-session-expand");
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    const detail = rows[0].querySelector(".sec-session-detail");
    assert.ok(detail.hidden, "默认收起");
    await p.click("详情");
    assert.equal(rows[0].querySelector(".sec-session-detail").hidden, false);
    const text = rows[0].querySelector(".sec-session-detail").textContent;
    assert.match(text, /系统/);
    assert.match(text, /iPhone/);
    assert.match(text, /浏览器/);
    assert.match(text, /Safari/);
    assert.match(text, /客户端类型/);
    // IM-03：行内已展示的时间不在展开里重复整行；时间仍在会话行内可读。
    assert.doesNotMatch(text, /登录时间/);
    assert.doesNotMatch(text, /到期时间/);
    assert.match(rows[0].textContent, /2026\.10\.11/);
    assert.doesNotMatch(text, /Mozilla/, "不铺原始 UA");
    assert.match(text, /不构成可信设备证明/);
    await p.click("收起");
    assert.equal(rows[0].querySelector(".sec-session-detail").hidden, true);
  } finally { await p.close(); }
});

test("会话展开控件是原生按钮并正确关联区域，键盘可达", async () => {
  const p = await mount();
  try {
    await p.settle();
    await localAgent(p, safariMac);
    const toggles = [...p.host.querySelectorAll(".sec-session-expand")];
    assert.ok(toggles.length >= 1, "其他有效会话具有展开详情控件");
    for (const toggle of toggles) {
      assert.equal(toggle.tagName, "BUTTON", "原生 button 才有键盘可达性");
      assert.equal(toggle.getAttribute("type"), "button");
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      const id = toggle.getAttribute("aria-controls");
      assert.ok(id, "aria-controls 指向展开区域");
      const region = p.host.querySelector(`[id="${id}"]`);
      assert.ok(region, "展开区域真实存在");
      assert.ok(region.hidden, "默认收起");
    }
    assert.equal(p.host.querySelector(".sec-record-toggle"), null, "当前会话卡片信息完整展示，不再重复展开冗余详情");
  } finally { await p.close(); }
});

test("缺 UA 会话的展开详情集中说一次登录时未记录，不猜系统不铺三列", async () => {
  const p = await mount({ sessions: [session("s_current", true, chrome), session("s_missing", false, null)] });
  try {
    await p.settle();
    await p.click("详情");
    const detail = [...p.host.querySelectorAll(".sec-session-detail")].find(node => !node.hidden);
    assert.match(detail.textContent, /登录时未记录客户端信息/);
    assert.equal(detail.textContent.match(/登录时未记录/g).length, 1, "同一缺失只表达一次");
    assert.equal(detail.querySelectorAll("dt").length, 0, "缺值不铺系统/浏览器/客户端类型三列");
    assert.doesNotMatch(detail.textContent, /Windows|Chrome|iPhone/, "不猜系统不猜浏览器");
    // IM-07：同一缺失（无 UA）不再出现“无法确认”第二种措辞。
    assert.doesNotMatch(detail.textContent, /无法确认/);
  } finally { await p.close(); }
});

// 当前网络查询必须由用户明确触发，本机时区与会话读取不代表用户同意访问第三方。
test("安全页结构：登录与找回→当前会话→其他有效会话→帮助，当前网络只在明确点击后查询", async () => {
  const p = await mount();
  try {
    await p.settle();
    const root = p.host.querySelector(".account-security-controls");
    const sections = [...root.querySelectorAll("section[aria-labelledby]")];
    const names = sections.map(node => node.getAttribute("aria-labelledby") ?? "");
    const at = (label) => names.findIndex(name => name.includes(label));
    assert.ok(at("sec-login-heading") !== -1, "登录与找回在最前");
    assert.ok(at("sec-current-session-heading") !== -1, "当前会话存在");
    assert.ok(at("sec-other-sessions-heading") !== -1, "其他有效会话存在");
    assert.ok(at("sec-login-heading") < at("sec-current-session-heading"), "顺序：登录与找回 → 当前会话");
    assert.ok(at("sec-current-session-heading") < at("sec-other-sessions-heading"), "顺序：当前会话 → 其他有效会话");
    const helpIndex = [...root.children].findIndex(node => node.classList.contains("sec-help"));
    assert.equal(helpIndex, root.children.length - 1, "帮助入口是控件内最后一个元素");

    // 当前会话：本机浏览器真实可读信息（设备类型/系统/浏览器）＋登录/到期两列＋登录时记录折叠详情。
    await localAgent(p, safariMac);
    const card = currentCard(p);
    const hero = card.querySelector(".sec-current-hero");
    assert.ok(hero, "当前浏览器摘要存在");
    assert.match(hero.textContent, /macOS · Safari/, "本机 UA 保守派生的系统与浏览器");
    assert.match(hero.textContent, /当前浏览器 · 桌面端网页/, "设备类型只标当前浏览器");
    assert.match(hero.textContent, /浏览器时区/);
    assert.ok(hero.querySelector("svg"), "设备类别用 Lucide 线性图标提示");
    assert.doesNotMatch(hero.textContent, /Windows/, "主区不冒充登录时 UA");
    const meta = card.querySelector(".sec-current-meta");
    assert.match(meta.textContent, /登录时间/);
    assert.match(meta.textContent, /到期时间/);
    assert.doesNotMatch(card.querySelector(".sec-current-hero").textContent + meta.textContent, /未记录/, "主区不重复铺缺值");
    assert.equal(card.querySelector(".sec-record-toggle"), null, "当前会话不再提供冗余展开按钮");
    assert.equal(card.querySelector(".sec-record-detail"), null, "当前会话卡片信息直接展示，不重复展开");

    // 当前网络一行内嵌当前会话，页面说明第三方查询，初载只读本机信息。
    const network = card.querySelector(".sec-network");
    assert.ok(network, "当前网络一行属于当前会话");
    assert.equal(p.calls.filter(item => String(item.url).includes("ipify.org") || String(item.url).includes("ipwho.is")).length, 0);
    assert.match(network.textContent, /第三方/);
    await p.click("查询当前网络");
    assert.match(network.textContent, /当前公网 IP/);
    assert.match(network.textContent, /203\.0\.113\.9/, "展示查询到的当前出口 IP");
    assert.match(network.textContent, /基于当前网络出口查询|位置仅供参考|不是登录时的 IP/, "文案区分查询时出口与登录时记录");
    assert.equal(p.host.querySelector(".network-card"), null, "不再另放底部网络大卡");
    assert.equal(p.calls.filter(item => String(item.url).includes("ipify.org") || String(item.url).includes("ipwho.is")).length, 1, "当前会话只查询一次，不轮询");
    // IM-09：刷新入口带业务作用域标注。
    assert.equal([...p.host.querySelectorAll("button")].find(node => node.textContent === "刷新").getAttribute("aria-label"), "刷新安全设置");
    assert.equal([...p.host.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === "刷新会话列表").textContent, "刷新");

    // 其他有效会话：紧凑连续列表＋桌面统一列头；不暴露会话ID，不暗示实时在线，也不回填本机浏览器。
    const othersCard = root.querySelector('[aria-labelledby="sec-other-sessions-heading"]');
    const columns = othersCard.querySelector(".sec-session-columns");
    assert.ok(columns, "桌面统一列头存在");
    assert.deepEqual([...columns.querySelectorAll("span")].map(node => node.textContent), ["设备与浏览器", "登录时间", "操作"]);
    assert.equal(othersCard.querySelectorAll(".sec-session").length, 1, "其他会话列表不含当前会话行");
    assert.doesNotMatch(othersCard.textContent, /s_other/, "不暴露内部会话ID");
    assert.doesNotMatch(othersCard.textContent, /macOS · Safari/, "不把当前浏览器信息填给其他会话");
    assert.match(othersCard.textContent, /2026\.10\.11/, "保留登录记录");
    assert.match(othersCard.textContent, /有效会话不代表设备当前在线/);
  } finally { await p.close(); }
});

test("当前会话展示本机真实可读系统与浏览器，不设冗余展开详情", async () => {
  const p = await mount({ sessions: [session("s_current", true, null), session("s_weird", false, "totally-unknown-agent")] });
  try {
    await p.settle();
    await localAgent(p, chrome);
    const card = currentCard(p);
    const hero = card.querySelector(".sec-current-hero");
    assert.match(hero.textContent, /Windows · Chrome/, "主区展示本机真实可读的系统与浏览器");
    assert.doesNotMatch(hero.textContent + card.querySelector(".sec-current-meta").textContent, /未记录|未知/, "主区不铺缺值");
    assert.equal(card.querySelector(".sec-record-toggle"), null, "当前会话不再设冗余展开按钮");
    // 其他会话保留完整保守派生（含客户端未识别），不受当前会话去噪影响。
    const otherRow = p.host.querySelector(".sec-session");
    assert.equal(otherRow.querySelector(".sec-session-title strong").textContent, "客户端未识别");
  } finally { await p.close(); }
});

// F2 跨页意图互斥（repair-20261014 反例回归底线）：昵称待确认意图不被安全操作覆盖。
test("F2 昵称待确认意图不被安全操作覆盖：入口暂停、说明与返回恢复入口保留", async () => {
  const pendingWrite = { current: { userId: "user_A", intent: { action: "nickname", expected: "待确认昵称" }, accepted: false, target: "" } };
  const original = pendingWrite.current;
  const p = await mount({ write: async () => responseWithStatus(503) }, { pendingWrite });
  try {
    await p.settle();
    assert.match(p.host.textContent, /昵称修改结果待确认/);
    assert.ok(p.host.querySelector('a[href="/account?view=overview"]'), "返回总览的恢复入口");
    assert.ok(p.findButton("退出其他会话").disabled, "他类未决写暂停本页写入口");
    await p.click("退出其他会话");
    if (p.host.querySelector('[role="dialog"]')) await p.click("确认退出");
    assert.equal(pendingWrite.current, original, "原昵称意图对象不被覆盖或清除");
    assert.equal(pendingWrite.current.intent.action, "nickname");
    assert.equal(pendingWrite.current.accepted, false);
    assert.equal(pendingWrite.current.target, "");
    assert.equal(writes(p, "/security/sessions/revoke-others").length, 0, "不发出撤销写入");
    // 卸载/重挂载后互斥与恢复入口仍然成立。
    await p.render({ key: "remount" });
    await p.settle();
    assert.match(p.host.textContent, /昵称修改结果待确认/);
    assert.ok(p.host.querySelector('a[href="/account?view=overview"]'));
    assert.equal(pendingWrite.current, original, "重挂载后仍不覆盖");
    assert.equal(writes(p, "/security/sessions/revoke-others").length, 0);
  } finally { await p.close(); }
});

// §7 永久回归补项（t8 缺项① → t14）：Tooltip 触屏路径——touch pointerdown 开合、触屏后合成 click 不立即关闭、
// 键盘聚焦仍可打开、外部点按关闭；与既有键盘 focus/blur 用例（579 行）互补，不改既有断言。
test("安全说明按钮支持触屏点按开合，合成 click 不误关，键盘聚焦与外部点按可预期", async () => {
  const p = await mount();
  try {
    await p.settle();
    const trigger = p.host.querySelector(".sec-info-trigger");
    assert.ok(trigger, "信息按钮存在");
    assert.equal(p.window.document.querySelector(".sec-info-content"), null, "初始收起");
    const touchPointerDown = () => {
      const event = new p.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      return event;
    };
    // 真实触屏输入必然成对出现 pointerdown→pointerup；Radix TooltipTrigger 以此复位“按下中”状态，
    // 合成 pointerup 保证后续键盘聚焦断言不被 pending pointer 状态干扰。
    const tap = () => p.React.act(async () => {
      trigger.dispatchEvent(touchPointerDown());
      trigger.dispatchEvent(new p.window.MouseEvent("pointerup", { bubbles: true, cancelable: true }));
      await new Promise(resolve => setImmediate(resolve));
    });
    const open = () => p.window.document.querySelector(".sec-info-content");
    // ① 触屏 pointerdown 打开。
    await tap();
    const opened = open();
    assert.ok(opened, "触屏点按展开说明");
    assert.match(opened.textContent, /修改成功后，其他会话将退出；当前会话更新，到期时间不变。/);
    // ② 触屏后的合成 click 不立即关闭（组件抑制该 click，不二次切换）。
    await p.React.act(async () => { trigger.dispatchEvent(new p.window.MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise(resolve => setImmediate(resolve)); });
    assert.ok(open(), "合成 click 不关闭说明");
    // ③ 第二次触屏点按收起。
    await tap();
    assert.equal(open(), null, "再次触屏点按收起");
    // ④ 键盘聚焦仍可打开（触屏路径不回归键盘可达性）。
    await p.React.act(async () => { trigger.focus(); await new Promise(resolve => setImmediate(resolve)); });
    assert.ok(open(), "键盘聚焦仍可打开");
    await tap();
    assert.equal(open(), null, "触屏点按可收起键盘打开的说明");
    // ⑤ 外部点按关闭。
    await tap();
    assert.ok(open(), "重新展开以验证外部关闭");
    const outside = p.window.document.createElement("button");
    p.window.document.body.append(outside);
    await p.React.act(async () => { outside.dispatchEvent(new p.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true })); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(open(), null, "外部点按关闭说明");
  } finally { await p.close(); }
});
