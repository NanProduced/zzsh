import { test } from "node:test";
import assert from "node:assert/strict";
import { mountAuthComponent, deferred } from "./react-auth-harness.mjs";
const file = "apps/web/src/components/auth/auth-form.tsx";
const reply = extra => Response.json({ status: true, userId: "user_A", passwordSet: false, cooldownUntil: new Date(Date.now() + 60_000).toISOString(), ...extra });
const terms = {id:"terms_fixture", digest:"a".repeat(64)};
const privacy = {id:"privacy_fixture", digest:"b".repeat(64)};
const mountLogin = (props = {}, options = {}) => mountAuthComponent(file, "AuthForm", props, {
  ...options,
  fetch: (url, body, init) => String(url).endsWith("/legal-documents/current")
    ? options.legalResponse?.() ?? Response.json({terms, privacy})
    : options.fetch?.(url, body, init) ?? reply(),
});
async function fillSms(p) { await p.input("auth-identifier", "13800138000"); await p.input("auth-terms", true); await p.click("获取验证码"); await p.input("phone-registration-code", "1234"); }

test("phone login and recovery use four digits while email recovery stays six", async () => {
  for (const mode of ["login", "phone-recovery", "email-recovery"]) {
    const p = await mountLogin({}, { fetch: async url => url.endsWith("/challenge/send") ? reply({ challengeId: "a".repeat(32) }) : url.endsWith("/challenge/verify") ? reply({ proofId: "b".repeat(32) }) : reply() });
    try {
      const recovery = mode !== "login", email = mode === "email-recovery", valid = email ? "123456" : "1234";
      if (recovery) { await p.click("密码登录"); await p.click("忘记密码"); if (email) await p.click("邮箱验证"); }
      await p.input("auth-identifier", email ? "bound@example.invalid" : "13800138000");
      if (!recovery) await p.input("auth-terms", true);
      await p.click("获取验证码");
      assert.equal(p.host.querySelectorAll(".auth-pin-slot").length, valid.length);
      await p.input("phone-registration-code", "123"); await p.submit();
      assert.match(p.host.textContent, new RegExp(`填写 ${valid.length} 位数字`));
      const endpoint = recovery ? "/challenge/verify" : "/phone-registration/complete";
      assert.equal(p.calls.filter(call => call.url.endsWith(endpoint)).length, 0);
      await p.input("phone-registration-code", valid);
      assert.equal([...p.host.querySelectorAll(".auth-pin-slot")].map(slot => slot.textContent).join(""), valid);
      await p.submit();
      assert.equal(p.calls.find(call => call.url.endsWith(endpoint))?.body.code, valid);
    } finally { await p.close(); }
  }
});

test("rejected password login uses credential copy, associates the field and focuses it", async () => {
  const p = await mountLogin( {}, { fetch: async () => Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }) });
  try {
    await p.click("密码登录"); await p.input("auth-identifier", "13800138000"); await p.input("auth-terms", true); await p.input("auth-password", "existing-wrong-password"); await p.submit();
    assert.match(p.host.textContent, /手机号或密码不正确/); assert.doesNotMatch(p.host.textContent, /验证码可能/);
    const field = p.host.querySelector("#auth-password"); assert.equal(field.getAttribute("aria-invalid"), "true"); assert.equal(field.getAttribute("aria-describedby"), "auth-status"); assert.equal(p.window.document.activeElement.id, "auth-password");
  } finally { await p.close(); }
});

test("real React phone OTP registration logs in without a password step; consent is required", async () => {
  const p = await mountLogin( {}, { fetch: async () => reply() });
  try {
    assert.equal(p.host.querySelectorAll('input[name="terms"]').length, 1);
    assert.equal(p.host.querySelector('[role="alert"]'), null);
    await p.input("auth-identifier", "13800138000"); await p.click("获取验证码"); assert.equal(p.calls.filter(item => String(item.url).endsWith("/phone-registration/send-otp")).length, 0);
    assert.match(p.host.querySelector(".auth-consent [role='alert']").textContent, /请勾选同意协议/);
    assert.equal(p.host.querySelector("#auth-terms").getAttribute("aria-describedby"), "auth-consent-error");
    await p.input("auth-terms", true); await p.click("获取验证码"); await p.input("phone-registration-code", "1234"); await p.submit();
    assert.equal(p.successes, 1); assert.equal(p.confirmations, 1);
    assert.ok(p.calls.find(item => item.url.endsWith("/complete"))?.body.password === undefined);
    assert.doesNotMatch(p.host.textContent, /账号名|用户名|强制|设置新密码/);
  } finally { await p.close(); }
});

test("phone password login preserves a short exact string and supports a password manager", async () => {
  const p = await mountLogin();
  try {
    await p.click("密码登录"); await p.input("auth-identifier", "0086 138-0013-8000"); await p.input("auth-password", " old "); await p.input("auth-terms", true);
    assert.equal(p.host.querySelector("#auth-password").getAttribute("autocomplete"), "current-password");
    assert.equal(p.host.querySelector("#auth-password").hasAttribute("minlength"), false);
    await p.submit(); const call = p.calls.find(item => item.url.endsWith("/sign-in/identifier"));
    assert.ok(call.body.password === " old "); assert.equal(call.body.kind, "phone"); assert.equal(call.body.identifier, "13800138000"); assert.equal(p.successes, 1);
  } finally { await p.close(); }
});

test("password login accepts only a phone and requires setting a different new password after legacy verification", async () => {
  const p = await mountLogin( {}, {fetch: async (url, body) => {
    if (url.endsWith("/sign-in/identifier") && !body.newPassword) {
      return Response.json({error:{code:"CONFLICT",reason:"LEGACY_PASSWORD_CHANGE_REQUIRED"}},{status:409});
    }
    return reply();
  }});
  try {
    await p.click("密码登录");
    assert.doesNotMatch(p.host.textContent, /旧平台账号编号/);
    await p.input("auth-identifier","00012345"); await p.input("auth-password","original"); await p.input("auth-terms",true); await p.submit();
    assert.equal(p.calls.filter(call => call.url.endsWith("/sign-in/identifier")).length,0);
    await p.input("auth-identifier","13800138000"); await p.input("auth-password","original"); await p.submit();
    assert.equal(p.successes,0);
    assert.match(p.host.textContent,/原密码已验证/);
    await p.input("auth-new-password","different-fixture-password");
    await p.input("auth-password-confirm","different-fixture-password");
    await p.submit();
    const calls=p.calls.filter(call => call.url.endsWith("/sign-in/identifier"));
    assert.equal(calls.length,2); assert.equal(calls[1].body.kind,"phone");
    assert.equal(calls[1].body.password,"original"); assert.equal(calls[1].body.newPassword,"different-fixture-password");
    assert.equal(p.successes,1);
  } finally { await p.close(); }
});
test("invitation link passes the displayed code only through unified phone registration, never password login", async () => {
  const p = await mountLogin( {inviteCode:"fxOriginal"}, {fetch:async()=>reply()});
  try { assert.equal(p.host.querySelector("#auth-invite-code").value,"fxOriginal");await fillSms(p);await p.submit();assert.equal(p.calls.find(item=>item.url.endsWith("/phone-registration/complete")).body.inviteCode,"fxOriginal");assert.match(p.host.textContent,/登录已有账号不会更改邀请关系/); } finally { await p.close(); }
  const password = await mountLogin({inviteCode:"fxOriginal"});
  try {await password.click("密码登录");await password.input("auth-identifier","13800138000");await password.input("auth-password","existing");await password.input("auth-terms",true);await password.submit();assert.equal(password.calls.find(item=>item.url.endsWith("/sign-in/identifier")).body.inviteCode,undefined);}finally{await password.close();}
});
test("malformed displayed invitation fails before registration write and keeps the field editable", async () => {
  const p=await mountLogin({inviteCode:"invalid code"},{fetch:async()=>reply()});
  try{await fillSms(p);await p.submit();assert.equal(p.calls.filter(item=>item.url.endsWith("/complete")).length,0);assert.match(p.host.textContent,/邀请码仅支持/);assert.equal(p.host.querySelector("#auth-invite-code").disabled,false);}finally{await p.close();}
});

test("accepted write plus failed session read offers only confirmation and cannot send a second write", async () => {
  let recovered = false;
  const p = await mountLogin( {}, { confirm: async () => recovered ? "authenticated" : "error" });
  try {
    await fillSms(p); await p.submit();
    assert.match(p.host.textContent, /操作已接受/); await p.submit();
    assert.equal(p.calls.filter(item => item.url.endsWith("/complete")).length, 1); assert.equal(p.successes, 0);
    recovered = true; await p.click("重新确认结果"); assert.equal(p.successes, 1);
    assert.equal(p.calls.filter(item => item.url.endsWith("/complete")).length, 1);
  } finally { await p.close(); }
});

test("unknown login result may request a new challenge only after server-confirmed guest", async () => {
  const p = await mountLogin( {}, { fetch: async url => { if (url.endsWith("/complete")) throw new Error("lost response"); return reply(); }, confirm: async () => "guest" });
  try {
    await fillSms(p); await p.submit(); assert.match(p.host.textContent, /结果暂时无法确认/); await p.submit();
    assert.equal(p.calls.filter(item => item.url.endsWith("/complete")).length, 1);
    await p.click("重新确认结果"); assert.match(p.host.textContent, /使用新的验证码登录/); await p.click("使用新的验证码登录");
    assert.equal(p.host.querySelector("#phone-registration-code").value, ""); assert.equal(p.successes, 0);
  } finally { await p.close(); }
});

test("a different confirmed user cannot complete the previous login intent", async () => {
  const p = await mountLogin( {}, { confirmUserId: "user_B" });
  try { await fillSms(p); await p.submit(); assert.equal(p.successes, 0); assert.match(p.host.textContent, /操作已接受/); }
  finally { await p.close(); }
});

test("a new phone login clears the previous receipt subject before its response can be lost", async () => {
  const slot = { current: { mode: "login", outcome: "accepted", contact: "OLD0001", subject: "OLD0001", identifierKind: "legacy-number", userId: "previous_user", challengeId: "", proofId: "" } };
  const gate = deferred();
  const p = await mountLogin( { pendingWrite: slot }, { confirm: async () => "guest", fetch: async url => {
    if (url.endsWith("/sign-in/identifier")) await gate.promise;
    return reply();
  } });
  try {
    await p.click("重新确认结果"); await p.click("使用新的验证码登录");
    await p.click("密码登录");
    await p.input("auth-identifier", "13800138000"); await p.input("auth-password", "existing"); await p.input("auth-terms", true); await p.submit();
    assert.equal(p.calls.filter(call => call.url.endsWith("/sign-in/identifier")).length, 1);
    assert.equal(slot.current.subject, "13800138000"); assert.equal(slot.current.identifierKind, "phone");
    assert.equal(slot.current.userId, null, "closing now must preserve only the new, unresolved subject");
  } finally { await p.close(); gate.resolve(); }
});

test("an accepted legacy receipt cannot be completed by a different session after reopening", async () => {
  const slot = { current: { mode: "login", outcome: "accepted", contact: "SN0001", subject: "SN0001", identifierKind: "legacy-number", userId: "user_A", challengeId: "", proofId: "" } };
  const p = await mountLogin( { pendingWrite: slot }, { confirmUserId: "user_B" });
  try {
    await p.click("重新确认结果"); await p.submit(); await p.click("重新确认结果");
    assert.equal(p.successes, 0); assert.equal(slot.current.userId, "user_A");
    assert.equal(p.calls.filter(call => call.method === "POST").length, 0);
    assert.equal(p.host.querySelector("#auth-identifier").disabled, true);
  } finally { await p.close(); }
});

test("changing return intent or unmounting discards a late login callback", async () => {
  const gate = deferred();
  const p = await mountLogin( { next: "/publish" }, { fetch: async url => { if (url.endsWith("/complete")) await gate.promise; return reply(); } });
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
  const p = await mountLogin( {}, { fetch: async url => {
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
  const p = await mountLogin( {}, { fetch: async url => {
    if (url.endsWith("/challenge/send")) return reply({ challengeId: "a".repeat(32) });
    if (url.endsWith("/challenge/verify")) return reply({ proofId: "a".repeat(32) });
    if (url.endsWith("/recovery/complete")) throw new Error("write delivery unknown");
    if (url.endsWith("/operation")) return expired ? Response.json({ status: "expired" }) : Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
    return reply();
  } });
  try {
    await p.click("密码登录"); await p.click("忘记密码"); await p.input("auth-identifier", "13800138000"); await p.click("获取验证码"); await p.input("phone-registration-code", "1234"); await p.submit();
    await p.input("auth-password", "new-valid-password"); await p.input("auth-password-confirm", "new-valid-password"); await p.submit(); await p.click("重新确认结果"); assert.ok(p.findButton("重置密码").disabled); assert.equal(p.host.querySelector("#auth-password").value, "");
    expired = true; await p.click("重新确认结果"); assert.equal(p.host.querySelector("#auth-password"), null); assert.equal(p.host.querySelector("#auth-identifier").value, "13800138000"); assert.ok(!p.findButton("获取验证码").disabled); assert.equal(p.calls.filter(c => c.url.endsWith("/recovery/complete")).length, 1);
  } finally { await p.close(); }
});

test("both document names are keyboard-reachable reading links that neither tick consent nor submit", async () => {
  const p = await mountLogin();
  try {
    const links = [...p.host.querySelectorAll(".auth-consent a")];
    assert.equal(links.length, 2, "both document names must be real anchors");
    for (const link of links) {
      assert.equal(link.getAttribute("href").startsWith("/legal/"), true, "each name has its own public reading target");
      assert.equal(link.getAttribute("target"), "_blank", "the document opens in its own tab");
      assert.match(link.getAttribute("rel") ?? "", /noopener/, "the new tab gets a safe rel");
      assert.match(link.getAttribute("aria-label") ?? "", /新窗口/, "the new window is announced");
      assert.equal(link.tabIndex >= 0, true, "the link stays in the keyboard order");
    }
    assert.equal(p.host.querySelector("#auth-terms").checked, false, "consent starts unticked");
    let submissions = 0;
    p.host.querySelector("form").addEventListener("submit", () => { submissions += 1; });
    await p.React.act(async () => { links[0].dispatchEvent(new p.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
    await p.settle();
    assert.equal(p.host.querySelector("#auth-terms").checked, false, "reading a document never ticks consent");
    assert.equal(submissions, 0, "reading a document never submits the form");
    assert.equal(p.calls.filter(item => !String(item.url).includes("/legal-documents/")).length, 0, "reading a document sends nothing");
    assert.equal(p.host.querySelector(".auth-policy-notice"), null, "the link is the reading path, not an in-form notice");
  } finally { await p.close(); }
});

test("missing legal documents and a retriable read failure stay visible beside consent", async () => {
  const pending = await mountLogin( {}, { legalResponse: () => Response.json({ terms: null, privacy: null }) });
  try {
    await pending.settle();
    assert.match(pending.host.textContent, /暂时无法查看完整协议/);
    assert.equal(pending.host.querySelector("#auth-terms").checked, false);
  } finally { await pending.close(); }
  let ready = false;
  const unavailable = await mountLogin({}, { legalResponse: () => ready ? Response.json({terms, privacy}) : new Response(null, { status: 503 }) });
  try {
    await unavailable.settle();
    assert.match(unavailable.host.textContent, /暂时无法读取协议，请重试/);
    await unavailable.click("密码登录");
    await unavailable.input("auth-identifier", "13800138000");
    await unavailable.input("auth-password", "original-fixture");
    await unavailable.submit();
    assert.equal(unavailable.calls.filter(call => call.method === "POST").length, 0);
    ready = true;
    await unavailable.click("重新读取");
    assert.equal(unavailable.host.querySelector("#auth-identifier").value, "13800138000");
    assert.equal(unavailable.host.querySelector("#auth-password").value, "original-fixture");
    assert.equal(unavailable.host.querySelector(".auth-consent-note"), null);
  } finally { await unavailable.close(); }
});

test("closing and reopening the form cannot launder an unknown identity write into a fresh retry", async () => {
  const slot = { current: null };
  const first = await mountLogin( { pendingWrite: slot }, {
    fetch: async url => {
      if (String(url).endsWith("/complete")) throw new Error("lost response");
      return reply();
    },
  });
  try {
    await fillSms(first); await first.submit();
    assert.match(first.host.textContent, /结果暂时无法确认/);
    assert.equal(first.calls.filter(item => item.url.endsWith("/complete")).length, 1);
    assert.equal(slot.current?.outcome, "unknown", "the receipt is kept by the owner of the dialog");
  } finally { await first.close(); }

  const second = await mountLogin( { pendingWrite: slot }, {
    fetch: async url => {
      if (String(url).endsWith("/get-session")) return Response.json({ user: { id: "user_A", phoneNumber: "13800138000" } });
      return reply();
    },
  });
  try {
    assert.match(second.host.textContent, /结果暂时无法确认/, "the inherited receipt is restored after remounting");
    assert.ok(second.findButton("重新确认结果"), "the only way forward is reading the result");
    await second.submit();
    assert.equal(second.calls.filter(item => String(item.url).includes("/complete")).length, 0, "reopening must not start a second identity write");
    await second.click("重新确认结果");
    assert.equal(second.successes, 1, "the receipt resolves only after this subject is confirmed");
    assert.equal(second.calls.filter(item => item.url.endsWith("/complete")).length, 0);
    assert.equal(slot.current, null, "the responsibility is released once the server confirms it");
  } finally { await second.close(); }
});


/* --- Auth Form Throttle & PoW Tests --- */

import { buildUserAuthUpstreamHeaders, USER_AUTH_PATHS, USER_CLIENT_IP_FORWARD_HEADER } from "../src/lib/user-auth-forward.ts";

const challenge = {
  parameters: {
    algorithm: "PBKDF2/SHA-256",
    nonce: "00112233445566778899aabbccddeeff",
    salt: "ffeeddccbbaa99887766554433221100",
    cost: 1,
    keyLength: 32,
    keyPrefix: "00",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    data: "user:sign-in",
  },
  signature: "ab".repeat(32),
};

// The login form blocks submission until both published legal documents are readable, so every
// sign-in fixture must answer the consent read with two versioned summaries.
const publishedLegalDocs = {
  terms: { id: "terms_20261103", docType: "PLATFORM_TERMS", title: "平台服务协议", digest: "1".repeat(64), effectiveAt: "2026-11-03T00:00:00.000Z" },
  privacy: { id: "privacy_20261103", docType: "PLATFORM_PRIVACY", title: "用户隐私政策", digest: "2".repeat(64), effectiveAt: "2026-11-03T00:00:00.000Z" },
};

test("password login retries the original request after a challenge and drops a late one", async () => {
  let phase = "challenge";
  const p = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm", {}, {
    fetch: async (url, body) => {
      if (String(url).includes("/api/legal-documents/")) return Response.json(publishedLegalDocs);
      if (!String(url).includes("/api/auth/user")) return Response.json({});
      if (phase === "challenge" && !body?.captcha) {
        phase = "retry";
        return Response.json({ error: { code: "FORBIDDEN", reason: "CAPTCHA_REQUIRED" }, challenge, captchaRequired: true }, { status: 403 });
      }
      assert.equal(body.password, "existing-password");
      assert.equal(typeof body.captcha, "string");
      return Response.json({ status: true, userId: "user_A" });
    },
  });
  try {
    await p.settle();
    await p.click("密码登录");
    await p.input("auth-identifier", "13800138000");
    await p.input("auth-terms", true);
    await p.input("auth-password", "existing-password");
    await p.submit();
    const loginCalls = () => p.calls.filter((item) => String(item.url).endsWith("/sign-in/identifier"));
    const started = Date.now();
    while (Date.now() - started < 3000 && loginCalls().length < 2) await p.settle();
    const logins = loginCalls();
    assert.equal(logins.length, 2, p.host.textContent);
    assert.equal(logins[1].body.identifier, logins[0].body.identifier);
    assert.equal(logins[1].body.password, "existing-password");
    assert.equal(typeof logins[1].body.captcha, "string");
    assert.equal(p.successes, 1);
  } finally { await p.close(); }
});

test("a changed return intent ignores a late challenge instead of replaying it", async () => {
  const gate = deferred();
  const p = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm", { next: "/publish" }, {
    fetch: async (url) => {
      if (String(url).includes("/api/legal-documents/")) return Response.json(publishedLegalDocs);
      if (!String(url).includes("/api/auth/user")) return Response.json({});
      if (String(url).endsWith("/sign-in/identifier")) await gate.promise;
      return Response.json({ error: { code: "FORBIDDEN", reason: "CAPTCHA_REQUIRED" }, challenge }, { status: 403 });
    },
  });
  try {
    await p.settle();
    await p.click("密码登录");
    await p.input("auth-identifier", "13800138000");
    await p.input("auth-terms", true);
    await p.input("auth-password", "existing-password");
    const form = p.host.querySelector("form");
    await p.React.act(async () => form.dispatchEvent(new p.window.Event("submit", { bubbles: true, cancelable: true })));
    await p.render({ next: "/account" });
    gate.resolve();
    await p.settle();
    assert.equal(p.calls.filter((item) => String(item.url).endsWith("/sign-in/identifier")).length, 1);
    assert.equal(p.successes, 0);
  } finally { await p.close(); }
});

test("bff strips a forged internal ip and forwards only a resolved client", () => {
  const forged = {
    headers: new Headers({ [USER_CLIENT_IP_FORWARD_HEADER]: "9.9.9.9", "x-forwarded-for": "198.51.100.8", "user-agent": "ua" }),
    socket: { remoteAddress: "203.0.113.8" },
  };
  forged.headers.get = ((original) => (name) => name === "user-agent" ? "ua\u0000tail" : original.call(forged.headers, name))(forged.headers.get);
  const headers = buildUserAuthUpstreamHeaders(forged, { requestId: "req_test", webOrigin: "http://127.0.0.1:3100", env: {} });
  assert.equal(headers.get(USER_CLIENT_IP_FORWARD_HEADER), "203.0.113.8");
  assert.equal(headers.get("user-agent"), "uatail");
  assert.equal(USER_AUTH_PATHS.has("/phone-number/send-otp"), false);
  assert.equal(USER_AUTH_PATHS.has("/security/captcha/challenge"), true);
  const unassured = buildUserAuthUpstreamHeaders(new Request("http://127.0.0.1/", { headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.8", [USER_CLIENT_IP_FORWARD_HEADER]: "1.2.3.4" } }), {
    requestId: "req_bff", webOrigin: "http://127.0.0.1:3100", env: { USER_TRUSTED_PROXIES: "loopback,10.0.0.0/8" },
  });
  assert.equal(unassured.get(USER_CLIENT_IP_FORWARD_HEADER), null);
  const assured = buildUserAuthUpstreamHeaders(new Request("http://127.0.0.1/", { headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.8", [USER_CLIENT_IP_FORWARD_HEADER]: "1.2.3.4" } }), {
    requestId: "req_bff", webOrigin: "http://127.0.0.1:3100", env: { USER_TRUSTED_PROXIES: "loopback,10.0.0.0/8", USER_EDGE_ASSURED: "true" },
  });
  assert.equal(assured.get(USER_CLIENT_IP_FORWARD_HEADER), "198.51.100.4");
});

test("Root: an already rejected password is not automatically sent a second time", async () => {
  const view = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm");
  const { webAuthWithCaptcha } = view.loadSource("apps/web/src/lib/user-captcha.ts");
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: "UNAUTHENTICATED", reason: "CAPTCHA_REQUIRED" }, challenge }, { status: 401 }); };
  try { await assert.rejects(() => webAuthWithCaptcha("/sign-in/identifier", { identifier: "13800138000", password: "wrong" }, undefined, () => true)); assert.equal(calls, 1); }
  finally { globalThis.fetch = original; await view.close(); }
});

test("a challenge with the wrong shape is rejected before a KDF loop", async () => {
  const view = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm");
  const { solveLocalPow } = view.loadSource("apps/web/src/lib/user-captcha.ts");
  try {
    await assert.rejects(() => solveLocalPow({ ...challenge, parameters: { ...challenge.parameters, algorithm: "SHA-1" } }), (error) => error.reason === "CAPTCHA_REQUIRED");
    await assert.rejects(() => solveLocalPow({ ...challenge, parameters: { ...challenge.parameters, cost: 1_000_001 } }), (error) => error.reason === "CAPTCHA_REQUIRED");
    await assert.rejects(() => solveLocalPow({ ...challenge, parameters: { ...challenge.parameters, keyPrefix: "zzzz" } }), (error) => error.reason === "CAPTCHA_REQUIRED");
  } finally { await view.close(); }
});

test("Root: stale or cancelled proof work stops before starting a KDF", async () => {
  const view = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm");
  const { solveLocalPow } = view.loadSource("apps/web/src/lib/user-captcha.ts");
  const cancelled = new AbortController(); cancelled.abort();
  try {
  await assert.rejects(() => solveLocalPow(challenge, cancelled.signal), error => error.name === "AbortError");
  await assert.rejects(() => solveLocalPow(challenge, undefined, () => false), error => error.name === "AbortError");
  } finally { await view.close(); }
});

test("Root: invalid proxy configuration cannot silently remove IP protection", () => {
  assert.throws(() => buildUserAuthUpstreamHeaders(new Request("http://127.0.0.1/"), { requestId: "req_bad_config", webOrigin: "http://127.0.0.1", env: { USER_TRUSTED_PROXIES: "everyone" } }), /TRUSTED_PROXIES/);
});


test("Root R1: missing, invalid or expired proof time is rejected before any KDF", async () => {
  const view = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm");
  const { solveLocalPow } = view.loadSource("apps/web/src/lib/user-captcha.ts");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto"); let kdfs = 0;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: { importKey: async () => { kdfs++; return {}; }, deriveBits: async () => { kdfs++; return new Uint8Array(32).buffer; } } } });
  try {
    for (const expiresAt of [undefined, null, "2000000000", NaN, Infinity, 0, Math.floor(Date.now() / 1000) - 1]) {
      await assert.rejects(() => solveLocalPow({ ...challenge, parameters: { ...challenge.parameters, expiresAt } }), error => error.reason === "CAPTCHA_REQUIRED");
    }
    assert.equal(kdfs, 0);
  } finally { Object.defineProperty(globalThis, "crypto", descriptor); await view.close(); }
});

test("Root R1: expiry during a KDF prevents proof replay and leaves signed parameters unchanged", async () => {
  const view = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm");
  const { webAuthWithCaptcha, solveLocalPow } = view.loadSource("apps/web/src/lib/user-captcha.ts");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto"), realNow = Date.now, originalFetch = globalThis.fetch;
  const start = 2_000_000_000_000; let now = start, kdfs = 0, calls = 0;
  const expiring = { ...challenge, parameters: { ...challenge.parameters, expiresAt: Math.floor(start / 1000) + 1 } };
  const signed = JSON.stringify(expiring);
  Date.now = () => now;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: { importKey: async () => ({}), deriveBits: async () => { kdfs++; now = start + 1000; return new Uint8Array(32).buffer; } } } });
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: "FORBIDDEN", reason: "CAPTCHA_REQUIRED" }, challenge: expiring }, { status: 403 }); };
  try {
    await assert.rejects(() => solveLocalPow(expiring), error => error.reason === "CAPTCHA_REQUIRED");
    assert.equal(kdfs, 1); assert.equal(JSON.stringify(expiring), signed);
    now = start; kdfs = 0;
    await assert.rejects(() => webAuthWithCaptcha("/sign-in/identifier", { identifier: "13800138000", password: "existing-password" }, undefined, () => true), error => error.reason === "CAPTCHA_REQUIRED");
    assert.equal(calls, 1, "expired work never re-posts the credential body"); assert.equal(kdfs, 1);
    assert.equal(JSON.stringify(expiring), signed);
  } finally { globalThis.fetch = originalFetch; Date.now = realNow; Object.defineProperty(globalThis, "crypto", descriptor); await view.close(); }
});
