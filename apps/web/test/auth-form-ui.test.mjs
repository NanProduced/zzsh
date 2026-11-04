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
    await p.input("auth-identifier", "13800138000"); await p.click("获取验证码"); assert.equal(p.calls.filter(item => String(item.url).endsWith("/phone-registration/send-otp")).length, 0);
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

test("legacy public number is an explicit password-only choice, never guessed from a numeric identifier", async () => {
  const p = await mountAuthComponent(file, "AuthForm");
  try {
    await p.click("密码登录");await p.input("auth-identifier", "00012345");await p.input("auth-password", " old ");await p.input("auth-terms", true);await p.submit();
    assert.equal(p.calls.filter(call=>call.url.endsWith("/sign-in/identifier")).length,0);
    await p.click("旧平台账号编号");assert.equal(p.host.querySelector("#auth-identifier").value, "");
    await p.input("auth-identifier", "00012345");await p.input("auth-password", " old ");await p.submit();
    const call=p.calls.find(call=>call.url.endsWith("/sign-in/identifier"));assert.equal(call.body.kind,"legacy-number");assert.equal(call.body.identifier,"00012345");assert.equal(call.body.password," old ");assert.equal(p.successes,1);
    assert.equal(p.calls.filter(call=>call.url.includes("/sign-in/legacy-number")).length,0);
  } finally { await p.close(); }
});

test("switching from a legacy number to OTP or recovery clears the alias and password", async () => {
  const p=await mountAuthComponent(file,"AuthForm");
  try {
    await p.click("密码登录");await p.click("旧平台账号编号");await p.input("auth-identifier","00012345");await p.input("auth-password","existing");
    await p.click("验证码登录");assert.equal(p.host.querySelector("#auth-identifier").value,"");assert.equal(p.host.querySelector("#auth-password"),null);
    await p.click("密码登录");assert.equal(p.host.querySelector("#auth-identifier").type,"tel");
    await p.click("旧平台账号编号");await p.input("auth-identifier","00012345");await p.click("忘记密码");
    assert.equal(p.host.querySelector("#auth-identifier").value,"");assert.equal(p.host.querySelector("#auth-identifier").type,"tel");
    assert.equal(p.calls.filter(call=>call.method==='POST').length,0);
  } finally { await p.close(); }
});

test("lost legacy login restores its original identifier kind and only accepts the same session public number", async () => {
  const slot={current:null};
  const first=await mountAuthComponent(file,"AuthForm",{pendingWrite:slot},{fetch:async url=>{if(url.endsWith('/sign-in/identifier'))throw new Error('lost');return reply();}});
  try{await first.click("密码登录");await first.click("旧平台账号编号");await first.input("auth-identifier","00012345");await first.input("auth-password","existing");await first.input("auth-terms",true);await first.submit();assert.equal(slot.current.identifierKind,'legacy-number');assert.equal(slot.current.subject,'00012345');}finally{await first.close();}
  let same=false;
  const restored=await mountAuthComponent(file,"AuthForm",{pendingWrite:slot},{fetch:async url=>url.endsWith('/get-session')?Response.json({user:{id:'user_A',username:same?'00012345':'different',phoneNumber:'13800138000'}}):reply()});
  try{assert.equal(restored.host.querySelector('#auth-identifier').value,'00012345');assert.equal(restored.host.querySelector('#auth-password').value,'');await restored.submit();await restored.click('重新确认结果');assert.equal(restored.successes,0);same=true;await restored.click('重新确认结果');assert.equal(restored.successes,1);assert.equal(restored.calls.filter(call=>call.url.endsWith('/sign-in/identifier')).length,0);}finally{await restored.close();}
});
test("invitation link passes the displayed code only through unified phone registration, never password login", async () => {
  const p = await mountAuthComponent(file, "AuthForm", {inviteCode:"fxOriginal"}, {fetch:async()=>reply()});
  try { assert.equal(p.host.querySelector("#auth-invite-code").value,"fxOriginal");await fillSms(p);await p.submit();assert.equal(p.calls.find(item=>item.url.endsWith("/phone-registration/complete")).body.inviteCode,"fxOriginal");assert.match(p.host.textContent,/登录已有账号不会更改邀请关系/); } finally { await p.close(); }
  const password = await mountAuthComponent(file,"AuthForm",{inviteCode:"fxOriginal"});
  try {await password.click("密码登录");await password.input("auth-identifier","13800138000");await password.input("auth-password","existing");await password.input("auth-terms",true);await password.submit();assert.equal(password.calls.find(item=>item.url.endsWith("/sign-in/identifier")).body.inviteCode,undefined);}finally{await password.close();}
});
test("malformed displayed invitation fails before registration write and keeps the field editable", async () => {
  const p=await mountAuthComponent(file,"AuthForm",{inviteCode:"invalid code"},{fetch:async()=>reply()});
  try{await fillSms(p);await p.submit();assert.equal(p.calls.filter(item=>item.url.endsWith("/complete")).length,0);assert.match(p.host.textContent,/邀请码仅支持/);assert.equal(p.host.querySelector("#auth-invite-code").disabled,false);}finally{await p.close();}
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

test("a new legacy login clears the previous receipt subject before its response can be lost", async () => {
  const slot = { current: { mode: "login", outcome: "accepted", contact: "OLD0001", subject: "OLD0001", identifierKind: "legacy-number", userId: "previous_user", challengeId: "", proofId: "" } };
  const gate = deferred();
  const p = await mountAuthComponent(file, "AuthForm", { pendingWrite: slot }, { confirm: async () => "guest", fetch: async url => {
    if (url.endsWith("/sign-in/identifier")) await gate.promise;
    return reply();
  } });
  try {
    await p.click("重新确认结果"); await p.click("使用新的验证码登录");
    await p.click("密码登录"); await p.click("旧平台账号编号");
    await p.input("auth-identifier", "NEW0002"); await p.input("auth-password", "existing"); await p.input("auth-terms", true); await p.submit();
    assert.equal(p.calls.filter(call => call.url.endsWith("/sign-in/identifier")).length, 1);
    assert.equal(slot.current.subject, "NEW0002"); assert.equal(slot.current.identifierKind, "legacy-number");
    assert.equal(slot.current.userId, null, "closing now must preserve only the new, unresolved subject");
  } finally { await p.close(); gate.resolve(); }
});

test("an accepted legacy receipt cannot be completed by a different session after reopening", async () => {
  const slot = { current: { mode: "login", outcome: "accepted", contact: "SN0001", subject: "SN0001", identifierKind: "legacy-number", userId: "user_A", challengeId: "", proofId: "" } };
  const p = await mountAuthComponent(file, "AuthForm", { pendingWrite: slot }, { confirmUserId: "user_B" });
  try {
    await p.click("重新确认结果"); await p.submit(); await p.click("重新确认结果");
    assert.equal(p.successes, 0); assert.equal(slot.current.userId, "user_A");
    assert.equal(p.calls.filter(call => call.method === "POST").length, 0);
    assert.equal(p.host.querySelector("#auth-identifier").disabled, true);
  } finally { await p.close(); }
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

test("both document names are keyboard-reachable reading links that neither tick consent nor submit", async () => {
  const p = await mountAuthComponent(file, "AuthForm");
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

test("missing legal documents have no publication placeholder while read failures stay visible", async () => {
  const pending = await mountAuthComponent(file, "AuthForm", {}, { fetch: async () => Response.json({ terms: null, privacy: null }) });
  try {
    await pending.settle();
    assert.doesNotMatch(pending.host.textContent, /正式协议尚未发布/);
    assert.equal(pending.host.querySelector("#auth-terms").checked, false);
  } finally { await pending.close(); }
  const unavailable = await mountAuthComponent(file, "AuthForm", {}, { fetch: async () => new Response(null, { status: 503 }) });
  try {
    await unavailable.settle();
    assert.match(unavailable.host.textContent, /协议暂时无法读取，请稍后重试/);
  } finally { await unavailable.close(); }
});

test("closing and reopening the form cannot launder an unknown identity write into a fresh retry", async () => {
  const slot = { current: null };
  const first = await mountAuthComponent(file, "AuthForm", { pendingWrite: slot }, {
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

  const second = await mountAuthComponent(file, "AuthForm", { pendingWrite: slot }, {
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
