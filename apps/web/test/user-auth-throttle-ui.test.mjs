import assert from "node:assert/strict";
import { test } from "node:test";
import { mountAuthComponent, deferred } from "./react-auth-harness.mjs";
import { buildUserAuthUpstreamHeaders, USER_AUTH_PATHS, USER_CLIENT_IP_FORWARD_HEADER } from "../src/lib/user-auth-forward.ts";

const challenge = {
  parameters: {
    algorithm: "PBKDF2/SHA-256",
    nonce: "00112233445566778899aabbccddeeff",
    salt: "ffeeddccbbaa99887766554433221100",
    cost: 1,
    keyLength: 32,
    keyPrefix: "00",
  },
  signature: "ab".repeat(32),
};

test("password login retries the original request after a challenge and drops a late one", async () => {
  let phase = "challenge";
  const p = await mountAuthComponent("apps/web/src/components/auth/auth-form.tsx", "AuthForm", {}, {
    fetch: async (url, body) => {
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
      if (!String(url).includes("/api/auth/user")) return Response.json({});
      if (String(url).endsWith("/sign-in/identifier")) await gate.promise;
      return Response.json({ error: { code: "FORBIDDEN", reason: "CAPTCHA_REQUIRED" }, challenge }, { status: 403 });
    },
  });
  try {
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
  const trusted = buildUserAuthUpstreamHeaders(new Request("http://127.0.0.1/", { headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.8", [USER_CLIENT_IP_FORWARD_HEADER]: "1.2.3.4" } }), {
    requestId: "req_bff", webOrigin: "http://127.0.0.1:3100", env: { USER_TRUSTED_PROXIES: "loopback,10.0.0.0/8" },
  });
  assert.equal(trusted.get(USER_CLIENT_IP_FORWARD_HEADER), "198.51.100.4");
});
