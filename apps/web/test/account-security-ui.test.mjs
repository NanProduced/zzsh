import { test } from "node:test";
import assert from "node:assert/strict";
import { mountAuthComponent, deferred } from "./react-auth-harness.mjs";
const file = "apps/web/src/components/account/account-security-controls.tsx";
const overview = { userId: "user_A", nickname: "自己的昵称", phoneNumber: "+8613800138000", email: null, passwordState: "not-set" };
const response = value => Response.json(value);
function handler(options = {}) {
  return async (url, body) => {
    if (url.endsWith("/overview")) { if (options.read) return options.read(); return response(overview); }
    if (url.endsWith("/challenge/send")) return response({ status: true, challengeId: (body.stage === "target" ? "b" : "a").repeat(32), cooldownUntil: new Date(Date.now() + 60_000).toISOString() });
    if (url.endsWith("/challenge/verify")) return response({ status: true, proofId: body.challengeId });
    if (url.endsWith("/operation")) return response({ status: "completed" });
    if (options.write) return options.write(url, body);
    return response({ status: true });
  };
}
async function passwordReady(p) { await p.click("设置密码"); await p.click("获取验证码"); await p.input("security-code", "123456"); await p.click("验证现有身份"); await p.input("security-password", "new-valid-password"); await p.input("security-password-confirm", "new-valid-password"); }

test("security overview distinguishes unavailable from unset and never displays placeholder email", async () => {
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler({ read: async () => response({ ...overview, passwordState: "unavailable" }) }) });
  try { assert.match(p.host.textContent, /暂无法确认/); assert.doesNotMatch(p.host.textContent, /未设置，可继续/); assert.match(p.host.textContent, /未绑定/); }
  finally { await p.close(); }
});

for (const status of [0, 401, 503]) test(`accepted password write followed by ${status || "network"} read failure blocks every repeat write`, async () => {
  let accepted = false, recovered = false;
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler({
    read: async () => { if (accepted && !recovered) { if (!status) throw new Error("lost read"); return responseWithStatus(status); } return response({ ...overview, passwordState: accepted ? "set" : "not-set" }); },
    write: async () => { accepted = true; return response({ status: true }); },
  }) });
  try {
    await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); assert.match(p.host.textContent, /操作已接受/);
    if (status === 401) { assert.equal(p.confirmations, 1); assert.equal(p.host.querySelector("#security-nickname"), null); }
    else await p.submit('form[aria-label="设置或修改密码"]');
    assert.equal(p.calls.filter(item => item.url.endsWith("/security/password")).length, 1);
    recovered = true; await p.click("只查询操作结果"); assert.match(p.host.textContent, /操作结果已确认/);
    assert.equal(p.calls.filter(item => item.url.endsWith("/security/password")).length, 1);
  } finally { await p.close(); }
});
function responseWithStatus(status) { return Response.json({ error: { code: status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR" } }, { status }); }

test("unknown password write keeps the same receipt and only retries reads", async () => {
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler({ write: async () => { throw new Error("lost write result"); } }) });
  try {
    await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); assert.match(p.host.textContent, /写入结果未知/);
    await p.submit('form[aria-label="设置或修改密码"]'); assert.equal(p.calls.filter(item => item.url.endsWith("/security/password")).length, 1);
    await p.click("只查询操作结果"); assert.equal(p.calls.filter(item => item.url.endsWith("/security/password")).length, 1);
  } finally { await p.close(); }
});

test("changing a staged email target clears both proofs and cannot submit the prior destination", async () => {
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler() });
  try {
    await p.click("绑定邮箱"); await p.input("security-target", "first@example.invalid"); await p.click("获取验证码"); await p.input("security-code", "123456"); await p.click("验证现有身份");
    await p.click("获取验证码"); await p.input("security-code", "123456"); await p.click("验证新联系方式");
    await p.input("security-target", "second@example.invalid"); await p.submit('form[aria-label="绑定或更换邮箱"]');
    assert.equal(p.calls.filter(item => item.url.endsWith("/security/email")).length, 0); assert.equal(p.host.querySelector("#security-code").value, ""); assert.match(p.host.textContent, /先验证现有身份/);
  } finally { await p.close(); }
});

test("unconfirmed identity hides all private security facts and discards a late response", async () => {
  const gate = deferred(); let allowed = true;
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => allowed }, { initialStatus: "authenticated", fetch: handler({ read: async () => { await gate.promise; return response(overview); } }) });
  try {
    allowed = false; await p.render(); gate.resolve(); await p.settle(); assert.doesNotMatch(p.host.textContent, /user_A|自己的昵称|138/); assert.match(p.host.textContent, /确认登录身份/);
  } finally { gate.resolve(); await p.close(); }
});

for (const path of ["overview", "challenge/send", "challenge/verify", "password"]) test(`definite 401 from ${path} invalidates cached security facts through the shared session`, async () => {
  let reject = false, allowed = true;
  const normal = handler();
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => allowed }, {
    initialStatus: "authenticated", revalidate: () => { allowed = false; },
    fetch: async (url, body) => reject && url.endsWith("/security/" + path) ? responseWithStatus(401) : normal(url, body),
  });
  try {
    if (path === "overview") { reject = true; await p.click("刷新"); }
    else if (path === "password") { await passwordReady(p); reject = true; await p.submit('form[aria-label="设置或修改密码"]'); }
    else { await p.click("设置密码"); if (path.endsWith("verify")) { await p.click("获取验证码"); await p.input("security-code", "123456"); } reject = true; await p.click(path.endsWith("send") ? "获取验证码" : "验证现有身份"); }
    assert.equal(p.confirmations, 1); assert.doesNotMatch(p.host.textContent, /user_A|自己的昵称|138/); assert.match(p.host.textContent, /确认登录身份/);
  } finally { await p.close(); }
});

test("password validation stays inside its workflow, associates fields, and focuses the invalid field", async () => {
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler() });
  try {
    await passwordReady(p); await p.input("security-password", "short"); await p.input("security-password-confirm", "different"); await p.submit('form[aria-label="设置或修改密码"]');
    const form = p.host.querySelector('form[aria-label="设置或修改密码"]');
    assert.ok(form.querySelector('#security-result[role="alert"]')); assert.equal(p.window.document.activeElement.id, "security-password");
    for (const id of ["security-password", "security-password-confirm"]) { const field = form.querySelector('#' + id); assert.equal(field.getAttribute("aria-invalid"), "true"); assert.equal(field.getAttribute("aria-describedby"), "security-result"); }
    assert.equal(p.calls.filter(item => item.url.endsWith("/security/password")).length, 0);
  } finally { await p.close(); }
});

test("background overview reads retain nickname drafts and do not describe read errors as OTP errors", async () => {
  let rejected = false;
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler({ read: async () => rejected ? responseWithStatus(403) : response(overview) }) });
  try {
    await p.input("security-nickname", "尚未保存的草稿"); await p.click("刷新"); assert.equal(p.host.querySelector("#security-nickname").value, "尚未保存的草稿");
    rejected = true; await p.click("刷新"); assert.doesNotMatch(p.host.querySelector("#security-result").textContent, /验证码/); assert.match(p.host.textContent, /资料无法读取/);
  } finally { await p.close(); }
});

test("successful sensitive changes restore focus to the original action", async () => {
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler() });
  try {
    p.findButton("设置密码").focus(); await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]');
    await p.React.act(async () => new Promise(resolve => setTimeout(resolve, 1)));
    assert.equal(p.window.document.activeElement.textContent, "设置密码"); assert.equal(p.host.querySelector('form[aria-label="设置或修改密码"]'), null);
  } finally { await p.close(); }
});

test("an unknown write stays locked until the server confirms the unused proof expired", async () => {
  let expired = false;
  const normal = handler({ write: async () => { throw new Error("write never delivered"); } });
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: async (url, body) => url.endsWith("/operation") ? response({ status: expired ? "expired" : "unconfirmed" }) : normal(url, body) });
  try {
    await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); await p.click("只查询操作结果"); assert.ok(p.findButton("确认保存密码").disabled); assert.match(p.host.textContent, /5 分钟/);
    expired = true; await p.click("只查询操作结果"); assert.equal(p.host.querySelector("#security-password"), null); assert.match(p.host.textContent, /原验证过期且操作未完成/); assert.ok(!p.findButton("获取验证码").disabled);
    assert.equal(p.calls.filter(item => item.url.endsWith("/security/password")).length, 1);
  } finally { await p.close(); }
});

test("unknown nickname write uses shared sign-out to end its scope; failed exit never permits a repeat write", async () => {
  let allowed = true, exitAllowed = false;
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => allowed }, { initialStatus: "authenticated", fetch: handler({ write: async () => { throw new Error("write unknown"); } }) });
  p.session.signOut = async () => { if (!exitAllowed) throw new Error("exit unknown"); allowed = false; };
  try {
    await p.input("security-nickname", "新的昵称"); await p.submit('form[aria-label="修改昵称"]'); await p.click("退出登录后重新确认"); assert.match(p.host.textContent, /原操作结果仍未知/); assert.ok(p.findButton("保存昵称").disabled);
    exitAllowed = true; await p.click("退出登录后重新确认"); await p.render(); assert.doesNotMatch(p.host.textContent, /user_A|自己的昵称/); assert.equal(p.calls.filter(c => c.url.endsWith("/profile/nickname")).length, 1);
  } finally { await p.close(); }
});

for (const changeUser of [false, true]) test(`completion focus survives a confirmed same-user remount but never follows ${changeUser ? "a different subject" : "a stale removed control"}`, async () => {
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

test("completion never takes focus back after the user moves to a separate page control", async () => {
  const gate = deferred();
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true }, { initialStatus: "authenticated", fetch: handler({ write: async () => { await gate.promise; return response({ status: true }); } }) });
  try {
    p.findButton("设置密码").focus(); await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]');
    const search = p.window.document.createElement("input"); search.id = "external-search"; p.window.document.body.append(search); search.focus();
    gate.resolve(); await p.settle(); await p.React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    assert.equal(p.window.document.activeElement.id, "external-search");
  } finally { gate.resolve(); await p.close(); }
});

test("same-subject remount retains the scoped nickname draft; a different subject never sees it", async () => {
  let id = "user_A"; const nicknameDraft = { current: null };
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: id, canAct: () => true, nicknameDraft }, { initialStatus: "authenticated", fetch: handler({ read: async () => response({ ...overview, userId: id }) }) });
  try {
    await p.input("security-nickname", "尚未保存的私人草稿"); await p.render({ key: "same-user-confirmed" }); assert.equal(p.host.querySelector("#security-nickname").value, "尚未保存的私人草稿");
    id = "user_B"; p.identity.userId = id; await p.render({ key: "changed-user", userId: id }); assert.equal(p.host.querySelector("#security-nickname").value, overview.nickname);
  } finally { await p.close(); }
});

test("a same-subject confirmation remount retains an in-flight write lock and reconciles it without resending", async () => {
  const gate = deferred(), nicknameDraft = { current: null }, pendingWrite = { current: null }; let committed = false;
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true, nicknameDraft, pendingWrite }, { initialStatus: "authenticated", fetch: handler({ read: async () => response({ ...overview, nickname: committed ? "新昵称" : overview.nickname }), write: async () => { await gate.promise; committed = true; return response({ status: true }); } }) });
  try {
    await p.input("security-nickname", "新昵称"); await p.submit('form[aria-label="修改昵称"]'); await p.render({ key: "same-user-confirmed" }); assert.ok(p.findButton("保存昵称").disabled); assert.match(p.host.textContent, /写入结果未知/);
    await p.submit('form[aria-label="修改昵称"]'); assert.equal(p.calls.filter(c => c.url.endsWith("/profile/nickname")).length, 1);
    gate.resolve(); await p.settle(); await p.click("只查询操作结果"); assert.equal(pendingWrite.current, null); assert.equal(nicknameDraft.current, null); assert.equal(p.calls.filter(c => c.url.endsWith("/profile/nickname")).length, 1);
  } finally { gate.resolve(); await p.close(); }
});

test("inherited pending receipt can hand focus across remount after overview initially failed", async () => {
  let readable = false; const pendingWrite = { current: { userId: "user_A", intent: { action: "password", operationId: "a".repeat(32) }, accepted: false, target: "" } };
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => true, pendingWrite }, { initialStatus: "authenticated", fetch: handler({ read: async () => readable ? response(overview) : responseWithStatus(503) }) });
  try {
    readable = true; p.findButton("只查询操作结果").focus(); await p.click("只查询操作结果"); await p.render({ key: "confirmed-current-scope" }); await p.settle(); await p.React.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    assert.equal(p.window.document.activeElement.getAttribute("data-security-action"), "password"); assert.equal(pendingWrite.current, null);
  } finally { await p.close(); }
});

for (const branch of ["receipt", "accepted-overview"]) for (const restoredIdentity of ["same-user", "guest", "different-user"]) test(`${branch} 401 clears private projections, retains the write outcome, and restores only ${restoredIdentity}`, async () => {
  let allowed = true, rejected = false, committed = false;
  const operationId = "a".repeat(32);
  const pendingWrite = { current: branch === "receipt" ? { userId: "user_A", intent: { action: "password", operationId }, accepted: false, target: "" } : null };
  const normal = handler({ read: async () => rejected && branch === "accepted-overview" ? responseWithStatus(401) : response({ ...overview, passwordState: committed ? "set" : "not-set" }), write: async () => { committed = true; rejected = true; return response({ status: true }); } });
  const p = await mountAuthComponent(file, "AccountSecurityControls", { userId: "user_A", canAct: () => allowed, pendingWrite }, { initialStatus: "authenticated", revalidate: () => { allowed = false; }, fetch: async (url, body) => {
    if (url.endsWith("/sessions")) return response({ sessions: [{ id: "old-session", isCurrent: true, createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z", userAgent: "OLD_PRIVATE_DEVICE" }] });
    if (rejected && branch === "receipt" && url.endsWith("/operation")) return responseWithStatus(401);
    return normal(url, body);
  } });
  try {
    if (branch === "receipt") { rejected = true; await p.click("只查询操作结果"); }
    else { await p.click("管理有效会话"); await passwordReady(p); await p.submit('form[aria-label="设置或修改密码"]'); }
    assert.equal(p.confirmations, 1); assert.doesNotMatch(p.host.textContent, /自己的昵称|138|OLD_PRIVATE_DEVICE/); assert.equal(p.host.querySelector("#security-nickname"), null);
    assert.equal(pendingWrite.current.intent.operationId, operationId); assert.equal(pendingWrite.current.accepted, branch === "accepted-overview");
    const writes = branch === "receipt" ? 0 : 1; assert.equal(p.calls.filter(c => c.url.endsWith("/security/password")).length, writes);
    if (restoredIdentity === "same-user") {
      rejected = false; allowed = true; await p.render({ key: "same-confirmed-user" }); assert.ok(p.findButton("只查询操作结果").disabled === false); assert.ok(p.host.querySelector('[data-security-action="password"]').disabled);
      await p.click("只查询操作结果"); assert.equal(pendingWrite.current, null); const receipts = p.calls.filter(c => c.url.endsWith("/operation")); assert.ok(receipts.every(c => c.body.operationId === operationId));
      assert.equal(p.calls.filter(c => c.url.endsWith("/challenge/send")).length, branch === "receipt" ? 0 : 1);
    } else {
      // AccountWorkspace drops transient data only after guest or a different UID is confirmed.
      pendingWrite.current = null; p.identity.status = restoredIdentity === "guest" ? "guest" : "authenticated"; p.identity.userId = restoredIdentity === "guest" ? null : "user_B";
      await p.render({ key: "scope-ended", userId: p.identity.userId ?? "guest" }); assert.doesNotMatch(p.host.textContent, /自己的昵称|138|OLD_PRIVATE_DEVICE|只查询操作结果/);
    }
    assert.equal(p.calls.filter(c => c.url.endsWith("/security/password")).length, writes);
  } finally { await p.close(); }
});
