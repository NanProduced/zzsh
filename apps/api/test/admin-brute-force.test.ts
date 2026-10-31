// 离线：管理员防爆破——客户端 IP 信任链、锁定阶梯、fail-closed、ALTCHA 校验与防重放、handler 包装、接线与安全头。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ADMIN_BRUTE_FORCE_POLICY, ADMIN_CAPTCHA_REQUIRED_REASON, ADMIN_GENERIC_CREDENTIAL_ERROR, adminAuthSubject, adminAuthSubjects,
  createAdminBruteForce, createAdminCaptcha, createMemoryAdminAuthThrottle, createPostgresAdminAuthThrottle, gateAdminAuth, lockSecondsForLevel,
  readAdminAltchaHmacKey, recordAdminAuthFailure, withAdminBruteForce, type AdminAuthThrottleStore,
} from "../src/auth/admin-brute-force";
import { ADMIN_CLIENT_IP_FORWARD_HEADER, parseAdminClientIpConfig, resolveAdminClientIp } from "../src/auth/admin-client-ip";
import { adminSecurityHeaders } from "../src/auth/auth-runtime";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const altcha = require("altcha-lib") as { solveChallenge: (o: Record<string, unknown>) => Promise<unknown> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pbkdf2 = require("altcha-lib/algorithms/pbkdf2") as { deriveKey: unknown };

const KEY = "k".repeat(40);
const pool = {} as any;

async function solvedPayload(captcha: ReturnType<typeof createAdminCaptcha>): Promise<string> {
  const challenge = await captcha.challenge();
  const solution = await altcha.solveChallenge({ challenge, deriveKey: pbkdf2.deriveKey });
  return Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
}

test("client IP: default ignores forwarding headers; trusted proxy uses rightmost untrusted hop", () => {
  const def = parseAdminClientIpConfig({});
  assert.deepEqual(def, { trustedProxies: [], header: "x-forwarded-for" });
  const spoof = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "::ffff:10.0.0.9" } };
  assert.equal(resolveAdminClientIp(spoof, def), "10.0.0.9");
  const cfg = parseAdminClientIpConfig({ ADMIN_TRUSTED_PROXIES: "loopback,10.0.0.0/8" });
  assert.equal(resolveAdminClientIp({ headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8, 10.1.1.1" }, socket: { remoteAddress: "127.0.0.1" } }, cfg), "8.8.8.8");
  assert.equal(resolveAdminClientIp({ headers: { "x-forwarded-for": "8.8.8.8" }, socket: { remoteAddress: "203.0.113.5" } }, cfg), "203.0.113.5");
  const real = parseAdminClientIpConfig({ ADMIN_TRUSTED_PROXIES: "127.0.0.1", ADMIN_CLIENT_IP_HEADER: "X-Real-IP" });
  assert.equal(resolveAdminClientIp({ headers: { "x-real-ip": "7.7.7.7" }, socket: { remoteAddress: "127.0.0.1" } }, real), "7.7.7.7");
  assert.throws(() => parseAdminClientIpConfig({ ADMIN_TRUSTED_PROXIES: "everyone" }));
  assert.throws(() => parseAdminClientIpConfig({ ADMIN_CLIENT_IP_HEADER: "cf-connecting-ip" }));
});

test("subjects are digests and lock ladder is 1m/5m/30m/1h cap", () => {
  assert.ok(!adminAuthSubject("account", "boss").includes("boss"));
  assert.ok(!adminAuthSubjects("id:boss", "1.2.3.4").join().includes("1.2.3.4"));
  assert.deepEqual([1, 2, 3, 4, 9].map(lockSecondsForLevel), [60, 300, 1800, 3600, 3600]);
});

test("memory store: 5 failures lock with escalating ladder, audits failures and lockouts", async () => {
  let now = 1_000_000;
  const store = createMemoryAdminAuthThrottle(() => now);
  const subjects = adminAuthSubjects("id:boss", "1.1.1.1");
  const lockFor = async () => {
    let last;
    for (let i = 0; i < ADMIN_BRUTE_FORCE_POLICY.lockThreshold; i += 1) last = await store.recordFailure("sign-in", subjects, { requestId: "r" });
    return (last!.lockedUntil!.getTime() - now) / 1000;
  };
  assert.equal(await lockFor(), 60);
  assert.ok((await store.status("sign-in", subjects)).lockedUntil);
  now += 61_000;
  assert.equal((await store.status("sign-in", subjects)).lockedUntil, undefined);
  assert.equal(await lockFor(), 300);
  now += 301_000;
  assert.equal(await lockFor(), 1800);
  now += 1_801_000;
  assert.equal(await lockFor(), 3600);
  now += 3_601_000;
  assert.equal(await lockFor(), 3600);
  assert.ok(store.audits.some((a) => a.action === "admin.auth.lockout"));
  assert.ok(store.audits.some((a) => a.action === "admin.auth.failure"));
  // 不同 scope 互不影响
  assert.equal((await store.status("step-up", subjects)).failures, 0);
});

test("gate fails closed when the store is unavailable", async () => {
  const broken: AdminAuthThrottleStore = {
    status: async () => { throw new Error("db down"); },
    recordFailure: async () => { throw new Error("db down"); },
    clear: async () => { throw new Error("db down"); },
    consumeCaptcha: async () => { throw new Error("db down"); },
  };
  const bf = createAdminBruteForce({ pool, hmacKey: KEY, store: broken });
  await assert.rejects(gateAdminAuth(bf, "sign-in", ["x"], { required: true, payload: undefined }), (e: any) => e.status === 429);
  assert.equal(await recordAdminAuthFailure(bf, "sign-in", ["x"], "r"), undefined);
});

test("ALTCHA: solved payload verifies once; replay, tampering and wrong key are rejected", async () => {
  const store = createMemoryAdminAuthThrottle();
  const captcha = createAdminCaptcha(KEY, store, 200);
  const payload = await solvedPayload(captcha);
  assert.equal(await captcha.verify(payload), true);
  assert.equal(await captcha.verify(payload), false);
  assert.equal(await captcha.verify("not-base64-json"), false);
  assert.equal(await captcha.verify(undefined), false);
  const other = createAdminCaptcha("o".repeat(40), createMemoryAdminAuthThrottle(), 200);
  assert.equal(await other.verify(await solvedPayload(captcha)), false);
});

test("HMAC key: required in production, min length, absent in dev", () => {
  assert.throws(() => readAdminAltchaHmacKey({ NODE_ENV: "production" }));
  assert.throws(() => readAdminAltchaHmacKey({ ADMIN_ALTCHA_HMAC_KEY: "short" }));
  assert.equal(readAdminAltchaHmacKey({}), undefined);
  assert.equal(readAdminAltchaHmacKey({ ADMIN_ALTCHA_HMAC_KEY: KEY }), KEY);
});

function signIn(body: Record<string, unknown>, ip = "5.5.5.5"): Request {
  return new Request("http://api/api/auth/admin/sign-in/username", {
    method: "POST",
    headers: { "content-type": "application/json", [ADMIN_CLIENT_IP_FORWARD_HEADER]: ip },
    body: JSON.stringify(body),
  });
}

test("wrapper: generic error, captcha after 3 failures, lockout after 5, strips altcha and preserves the resolved SDK IP", async () => {
  const store = createMemoryAdminAuthThrottle();
  const bf = createAdminBruteForce({ pool, hmacKey: KEY, store });
  const seen: Array<{ body: Record<string, unknown>; ip: string | null }> = [];
  const handler = withAdminBruteForce(async (request) => {
    const body = JSON.parse(await request.text());
    seen.push({ body, ip: request.headers.get(ADMIN_CLIENT_IP_FORWARD_HEADER) });
    return body.password === "right"
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : new Response(JSON.stringify({ code: "INVALID_USERNAME_OR_PASSWORD", message: "Invalid username or password" }), { status: 401 });
  }, bf);
  for (let i = 1; i <= 2; i += 1) {
    const r = await handler(signIn({ username: "boss", password: "bad" }));
    const json = await r.json() as any;
    assert.equal(r.status, 401);
    assert.equal(json.message, ADMIN_GENERIC_CREDENTIAL_ERROR);
    assert.equal(json.captchaRequired, undefined);
  }
  const third = await (await handler(signIn({ username: "boss", password: "bad" }))).json() as any;
  assert.equal(third.error.reason, ADMIN_CAPTCHA_REQUIRED_REASON);
  // 第 4 次未带验证码：403 + CAPTCHA_REQUIRED，不触达上游
  const before = seen.length;
  const blocked = await handler(signIn({ username: "boss", password: "right" }));
  assert.equal(blocked.status, 403);
  assert.equal(((await blocked.json()) as any).error.reason, ADMIN_CAPTCHA_REQUIRED_REASON);
  assert.equal(seen.length, before);
  // 同一 IP、换账号也需要验证码（按 IP 计数）
  assert.equal((await handler(signIn({ username: "other", password: "bad" }))).status, 403);
  // 带验证码后继续错误直至锁定
  const r4 = await handler(signIn({ username: "boss", password: "bad", altcha: await solvedPayload(bf.captcha) }));
  assert.equal(r4.status, 401);
  assert.equal(seen.at(-1)!.body.altcha, undefined);
  assert.equal(seen.at(-1)!.ip, "5.5.5.5");
  const r5 = await handler(signIn({ username: "boss", password: "bad", altcha: await solvedPayload(bf.captcha) }));
  assert.equal(r5.status, 429);
  const locked = await handler(signIn({ username: "boss", password: "right", altcha: await solvedPayload(bf.captcha) }));
  assert.equal(locked.status, 429);
  // 其他 IP、其他账号不受影响
  assert.equal((await handler(signIn({ username: "fresh", password: "right" }, "6.6.6.6"))).status, 200);
});

test("wrapper passes through non-throttled paths untouched", async () => {
  const bf = createAdminBruteForce({ pool, hmacKey: KEY, store: createMemoryAdminAuthThrottle() });
  let called = 0;
  const handler = withAdminBruteForce(async () => { called += 1; return new Response("{}", { status: 401 }); }, bf);
  await handler(new Request("http://api/api/auth/admin/get-session"));
  await handler(new Request("http://api/api/auth/admin/sign-out", { method: "POST", body: "{}" }));
  assert.equal(called, 2);
  assert.equal((await bf.store.status("sign-in", adminAuthSubjects(undefined, "5.5.5.5"))).failures, 0);
});

test("security headers: DENY/frame-ancestors/nosniff/referrer; HSTS only over https", () => {
  const plain = adminSecurityHeaders("http://127.0.0.1:4251", false);
  assert.equal(plain["X-Frame-Options"], "DENY");
  assert.match(plain["Content-Security-Policy"]!, /frame-ancestors 'none'/);
  assert.equal(plain["X-Content-Type-Options"], "nosniff");
  assert.equal(plain["Referrer-Policy"], "no-referrer");
  assert.equal(plain["Strict-Transport-Security"], undefined);
  assert.ok(adminSecurityHeaders("https://admin.example", false)["Strict-Transport-Security"]);
  assert.ok(adminSecurityHeaders("http://x", true)["Strict-Transport-Security"]);
});

test("wiring: admin realm only, migration 0116, BFF IP forwarding and captcha route", () => {
  const runtime = readFileSync(resolve("src/auth/auth-runtime.ts"), "utf8");
  assert.match(runtime, /const adminWebHandler = withAdminBruteForce\(/);
  assert.doesNotMatch(runtime, /userWebHandler = withAdminBruteForce/);
  assert.match(runtime, /mountAdminSecurityHeaders\(app, options\.apiOrigin\)/);
  assert.match(runtime, /ipAddressHeaders: \[ADMIN_CLIENT_IP_FORWARD_HEADER\]/);
  const security = readFileSync(resolve("src/auth/auth-security.ts"), "utf8");
  assert.match(security, /gateAdminAuth\(bf, "step-up"/);
  assert.match(security, /gateAdminAuth\(bf, "recovery"/);
  assert.match(security, /path === "\/captcha\/challenge"/);
  const bff = readFileSync(resolve("src/bff/admin-bff.ts"), "utf8");
  assert.match(bff, /headers\.set\(ADMIN_CLIENT_IP_FORWARD_HEADER, clientIp\)/);
  assert.match(bff, /"\/security\/captcha\/challenge"/);
  const sql = readFileSync(resolve("migrations/business/0116_admin_auth_throttle.sql"), "utf8");
  for (const table of ["admin_auth_failure", "admin_auth_lockout", "admin_auth_captcha_used"]) assert.match(sql, new RegExp(`zzsh_iam\\.${table}`));
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { tag: string }) => entry.tag === "0116_admin_auth_throttle"));
});


test("Root: unrelated email cannot change a username credential subject",async()=>{
  const store=createMemoryAdminAuthThrottle(),bf=createAdminBruteForce({pool,hmacKey:KEY,store});let entered=0;
  const handler=withAdminBruteForce(async()=>{entered++;return new Response(JSON.stringify({code:"INVALID_USERNAME_OR_PASSWORD"}),{status:401});},bf);
  for(let n=0;n<3;n++)assert.equal((await handler(signIn({username:"boss",email:"noise"+n+"@example.invalid",password:"bad"},"198.51.100."+(n+1)))).status,401);
  assert.equal((await handler(signIn({username:"boss",email:"new@example.invalid",password:"bad"},"198.51.100.99"))).status,403);
  assert.equal(entered,3);
  assert.equal((await store.status("sign-in",adminAuthSubjects("id:boss",undefined))).failures,3);
});


test("Root: audit failure and logging failure never roll back the authoritative failure count",async()=>{
  let count=0,committed=0,aborted=false,savepointRollbacks=0,fullRollbacks=0;
  const client:any={release(){},query:async(sql:string)=>{
    if(sql==="BEGIN"){count=committed;return{rows:[]};}
    if(sql.startsWith("ROLLBACK TO SAVEPOINT")){aborted=false;savepointRollbacks++;return{rows:[]};}
    if(sql==="ROLLBACK"){aborted=false;count=committed;fullRollbacks++;return{rows:[]};}
    if(aborted)throw Object.assign(Error("aborted"),{code:"25P02"});
    if(sql.includes("INSERT INTO \"zzsh_iam\".\"admin_auth_failure\""))count++;
    if(sql.includes("COUNT(*)::int AS \"failures\""))return{rows:[{failures:count}]};
    if(sql.includes("INSERT INTO \"zzsh_iam\".\"audit_event\"")){aborted=true;throw Object.assign(Error("synthetic audit denied"),{code:"42501"});}
    if(sql==="COMMIT")committed=count;return{rows:[],rowCount:1};}};
  const store=createPostgresAdminAuthThrottle({connect:async()=>client} as any),warn=console.warn;
  console.warn=()=>{throw Error("synthetic log sink failed");};
  try{for(let i=1;i<=3;i++)assert.equal((await store.recordFailure("sign-in",["account:fixture"],{requestId:"fixture"})).failures,i);}
  finally{console.warn=warn;}
  assert.equal(committed,3);assert.equal(savepointRollbacks,3);assert.equal(fullRollbacks,0);
});

test("Root: two-factor buckets use only the SDK cookie of the configured security mode",async()=>{
  for(const secureCookies of [false,true]){
    const bf=createAdminBruteForce({pool,hmacKey:KEY,store:createMemoryAdminAuthThrottle(),secureCookies});
    const handler=withAdminBruteForce(async()=>new Response(JSON.stringify({code:"INVALID_TOTP"}),{status:401}),bf);
    for(let i=1;i<=5;i++){
      const real=secureCookies?"__Secure-zzsh_admin.two_factor":"zzsh_admin.two_factor",other=secureCookies?"zzsh_admin.two_factor":"__Secure-zzsh_admin.two_factor";
      const request=new Request("http://api/api/auth/admin/two-factor/verify-totp",{method:"POST",headers:{"content-type":"application/json",cookie:other+"=noise"+i+"; unrelated.two_factor=noise"+i+"; "+real+"=fixed-challenge"},body:JSON.stringify({code:"bad"})});
      assert.equal((await handler(request)).status,i===5?429:401);
    }
  }
});
