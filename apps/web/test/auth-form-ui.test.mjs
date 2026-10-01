import { test } from "node:test";
import assert from "node:assert/strict";
import { mountAuthComponent, deferred } from "./react-auth-harness.mjs";
const file = "apps/web/src/components/auth/auth-form.tsx";
const reply = extra => Response.json({ status: true, userId: "user_A", passwordSet: false, cooldownUntil: new Date(Date.now() + 60_000).toISOString(), ...extra });
async function fillSms(p) { await p.input("auth-identifier", "13800138000"); await p.input("auth-terms", true); await p.click("获取验证码"); await p.input("phone-registration-code", "123456"); }

test("rejected password login uses credential copy, associates the field and focuses it", async () => {
  const p = await mountAuthComponent(file, "AuthForm", {}, { fetch: async () => Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }) });
  try {
    await p.click("密码登录"); await p.input("auth-identifier", "13800138000"); await p.input("auth-terms", true); await p.input("auth-password", "existing-wrong-password"); await p.submit();
    assert.match(p.host.textContent, /手机号或密码不正确/); assert.doesNotMatch(p.host.textContent, /验证码可能/);
    const field = p.host.querySelector("#auth-password"); assert.equal(field.getAttribute("aria-invalid"), "true"); assert.equal(field.getAttribute("aria-describedby"), "auth-status"); assert.equal(p.window.document.activeElement.id, "auth-password");
  } finally { await p.close(); }
});

test("real React phone OTP registration logs in without a password step; consent is required", async () => {
  const p = await mountAuthComponent(file, "AuthForm", {}, { fetch: async () => reply() });
  try {
    await p.input("auth-identifier", "13800138000"); await p.click("获取验证码"); assert.equal(p.calls.length, 0);
    await p.input("auth-terms", true); await p.click("获取验证码"); await p.input("phone-registration-code", "123456"); await p.submit();
    assert.equal(p.successes, 1); assert.equal(p.confirmations, 1);
    assert.ok(p.calls.find(item => item.url.endsWith("/complete"))?.body.password === undefined);
    assert.doesNotMatch(p.host.textContent, /账号名|用户名|强制|设置新密码/);
  } finally { await p.close(); }
});

test("phone password login preserves a short exact string and supports a password manager", async () => {
  const p = await mountAuthComponent(file, "AuthForm");
  try {
    await p.click("密码登录"); await p.input("auth-identifier", "0086 138-0013-8000"); await p.input("auth-password", " old "); await p.input("auth-terms", true);
    assert.equal(p.host.querySelector("#auth-password").getAttribute("autocomplete"), "current-password");
    assert.equal(p.host.querySelector("#auth-password").hasAttribute("minlength"), false);
    await p.submit(); const call = p.calls.find(item => item.url.endsWith("/sign-in/identifier"));
    assert.ok(call.body.password === " old "); assert.equal(call.body.kind, "phone"); assert.equal(call.body.identifier, "13800138000"); assert.equal(p.successes, 1);
  } finally { await p.close(); }
});

test("accepted write plus failed session read offers only confirmation and cannot send a second write", async () => {
  let recovered = false;
  const p = await mountAuthComponent(file, "AuthForm", {}, { confirm: async () => recovered ? "authenticated" : "error" });
  try {
    await fillSms(p); await p.submit();
    assert.match(p.host.textContent, /操作已接受/); await p.submit();
    assert.equal(p.calls.filter(item => item.url.endsWith("/complete")).length, 1); assert.equal(p.successes, 0);
    recovered = true; await p.click("重新确认结果"); assert.equal(p.successes, 1);
    assert.equal(p.calls.filter(item => item.url.endsWith("/complete")).length, 1);
  } finally { await p.close(); }
});

test("unknown login result may request a new challenge only after server-confirmed guest", async () => {
  const p = await mountAuthComponent(file, "AuthForm", {}, { fetch: async url => { if (url.endsWith("/complete")) throw new Error("lost response"); return reply(); }, confirm: async () => "guest" });
  try {
    await fillSms(p); await p.submit(); assert.match(p.host.textContent, /结果暂时无法确认/); await p.submit();
    assert.equal(p.calls.filter(item => item.url.endsWith("/complete")).length, 1);
    await p.click("重新确认结果"); assert.match(p.host.textContent, /使用新的验证码登录/); await p.click("使用新的验证码登录");
    assert.equal(p.host.querySelector("#phone-registration-code").value, ""); assert.equal(p.successes, 0);
  } finally { await p.close(); }
});

test("a different confirmed user cannot complete the previous login intent", async () => {
  const p = await mountAuthComponent(file, "AuthForm", {}, { confirmUserId: "user_B" });
  try { await fillSms(p); await p.submit(); assert.equal(p.successes, 0); assert.match(p.host.textContent, /操作已接受/); }
  finally { await p.close(); }
});

test("changing return intent or unmounting discards a late login callback", async () => {
  const gate = deferred();
  const p = await mountAuthComponent(file, "AuthForm", { next: "/publish" }, { fetch: async url => { if (url.endsWith("/complete")) await gate.promise; return reply(); } });
  try {
    await fillSms(p);
    const form = p.host.querySelector("form");
    await p.React.act(async () => form.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })));
    await p.render({ next: "/account?view=favorites" }); gate.resolve(); await p.settle();
    assert.equal(p.successes, 0); assert.equal(p.confirmations, 0);
  } finally { gate.resolve(); await p.close(); }
});

test("email recovery verifies first, enforces 12-128 and preserves unknown write receipt for read only", async () => {
  let restored = false;
  const p = await mountAuthComponent(file, "AuthForm", {}, { fetch: async url => {
    if (url.endsWith("/challenge/send")) return reply({ challengeId: "a".repeat(32) });
    if (url.endsWith("/challenge/verify")) return reply({ proofId: "a".repeat(32) });
    if (url.endsWith("/recovery/complete")) throw new Error("lost recovery response");
    if (url.endsWith("/operation")) return Response.json({ status: restored ? "completed" : "unconfirmed" });
    return reply();
  } });
  try {
    await p.click("密码登录"); await p.click("忘记密码"); await p.click("邮箱验证"); await p.input("auth-identifier", "bound@example.invalid"); await p.click("获取验证码"); await p.input("phone-registration-code", "123456");
    assert.equal(p.host.querySelector("#auth-password"), null); await p.submit(); assert.ok(p.host.querySelector("#auth-password"));
    await p.input("auth-password", "short"); await p.input("auth-password-confirm", "short"); await p.submit();
    assert.equal(p.calls.filter(item => item.url.endsWith("/recovery/complete")).length, 0);
    await p.input("auth-password", "new-valid-password"); await p.input("auth-password-confirm", "new-valid-password"); await p.submit(); await p.submit();
    assert.equal(p.calls.filter(item => item.url.endsWith("/recovery/complete")).length, 1); assert.match(p.host.textContent, /结果暂时无法确认/);
    restored = true; await p.click("重新确认结果"); assert.match(p.host.textContent, /密码已重置/);
    assert.equal(p.calls.filter(item => item.url.endsWith("/recovery/complete")).length, 1);
  } finally { await p.close(); }
});

test("recovery keeps an unknown result locked on 403 and only restarts after a confirmed expired unused proof", async () => {
  let expired = false;
  const p = await mountAuthComponent(file, "AuthForm", {}, { fetch: async url => {
    if (url.endsWith("/challenge/send")) return reply({ challengeId: "a".repeat(32) });
    if (url.endsWith("/challenge/verify")) return reply({ proofId: "a".repeat(32) });
    if (url.endsWith("/recovery/complete")) throw new Error("write delivery unknown");
    if (url.endsWith("/operation")) return expired ? Response.json({ status: "expired" }) : Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
    return reply();
  } });
  try {
    await p.click("密码登录"); await p.click("忘记密码"); await p.input("auth-identifier", "13800138000"); await p.click("获取验证码"); await p.input("phone-registration-code", "123456"); await p.submit();
    await p.input("auth-password", "new-valid-password"); await p.input("auth-password-confirm", "new-valid-password"); await p.submit(); await p.click("重新确认结果"); assert.ok(p.findButton("重置密码").disabled); assert.equal(p.host.querySelector("#auth-password").value, "");
    expired = true; await p.click("重新确认结果"); assert.equal(p.host.querySelector("#auth-password"), null); assert.equal(p.host.querySelector("#auth-identifier").value, "13800138000"); assert.ok(!p.findButton("获取验证码").disabled); assert.equal(p.calls.filter(c => c.url.endsWith("/recovery/complete")).length, 1);
  } finally { await p.close(); }
});
