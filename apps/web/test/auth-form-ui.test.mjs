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
