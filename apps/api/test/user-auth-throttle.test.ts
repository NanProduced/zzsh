import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";

import { isUserAuthPathAllowed } from "../src/auth/auth-runtime";
import {
  createMemoryUserAuthThrottle,
  readUserThrottleHmacKey,
  readUserThrottleMode,
  createPostgresUserAuthThrottle,
  createUserAuthThrottle,
  decideSignIn,
  signInSubjects,
  throttleDigest,
  ThrottleDependencyError,
  USER_AUTH_BASE_DEFAULT,
  USER_AUTH_BASE_RULES,
  userAuthPathProtection,
  userThrottleContract,
  USER_THROTTLE_PROPOSAL,
  withUserAuthThrottle,
} from "../src/auth/user-auth-throttle";
import {
  parseUserClientIpConfig,
  resolveBffClientIp,
  resolveUserClientIp,
  USER_CLIENT_IP_FORWARD_HEADER,
} from "../src/auth/user-client-ip";

const KEY = "k".repeat(40);
const PHONE = "+8613800138000";
const IP = "198.51.100.10";
const OTHER_IP = "198.51.100.11";
const policy = { ...USER_THROTTLE_PROPOSAL, accountCaptchaAfter: 3, pairMax: 4, ipMax: 5, smsPhonePerDay: 3, smsIpPerMinute: 2, smsIpPerDay: 4, smsIpCaptchaAfter: 2, captchaCost: 1 };

function throttle() {
  return createMemoryUserAuthThrottle({ hmacKey: KEY, policy, captchaCost: 1 });
}

function signInRequest(body: Record<string, unknown>, ip = IP, path = "/sign-in/phone-number"): Request {
  const headers = new Headers({ "content-type": "application/json", [USER_CLIENT_IP_FORWARD_HEADER]: ip });
  return new Request(`http://127.0.0.1/api/auth/user${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

test("proposal constants and native SMS path allowlist keep their declared values", () => {
  assert.equal(USER_THROTTLE_PROPOSAL.accountCaptchaAfter, 3);
  assert.equal(isUserAuthPathAllowed("/phone-number/send-otp"), false);
  assert.equal(isUserAuthPathAllowed("/phone-number/request-password-reset"), false);
  assert.equal(isUserAuthPathAllowed("/security/captcha/challenge"), true);
  assert.equal(isUserAuthPathAllowed("/sign-in/identifier"), true);
});

test("client ip ignores forged headers, walks trusted hops, and does not use the proxy as a bucket", () => {
  const closed = parseUserClientIpConfig({});
  assert.equal(resolveUserClientIp({ headers: { "x-forwarded-for": "1.2.3.4", [USER_CLIENT_IP_FORWARD_HEADER]: "9.9.9.9" }, socket: { remoteAddress: "::ffff:203.0.113.8" } }, closed), "203.0.113.8");
  assert.equal(resolveUserClientIp({ headers: { "x-forwarded-for": "not-an-ip, ::ffff:2001:db8::1" }, socket: { remoteAddress: "127.0.0.1" } }, closed), "127.0.0.1");
  const trusted = parseUserClientIpConfig({ USER_TRUSTED_PROXIES: "loopback,10.0.0.0/8" });
  assert.equal(resolveUserClientIp({ headers: { "x-forwarded-for": "2001:db8::2, 8.8.8.8, 10.1.1.1", [USER_CLIENT_IP_FORWARD_HEADER]: "203.0.113.9" }, socket: { remoteAddress: "127.0.0.1" } }, trusted), "203.0.113.9");
  assert.equal(resolveUserClientIp({ headers: { "x-forwarded-for": "bad, 198.51.100.7, 10.0.0.2" }, socket: { remoteAddress: "::1" } }, trusted), "198.51.100.7");
  assert.equal(resolveUserClientIp({ headers: { "x-forwarded-for": "10.0.0.2" }, socket: { remoteAddress: "127.0.0.1" } }, trusted), undefined);
  assert.equal(resolveUserClientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }, trusted), undefined);
  assert.throws(() => parseUserClientIpConfig({ USER_TRUSTED_PROXIES: "everyone" }));
  assert.equal(resolveBffClientIp(new Headers({ "x-forwarded-for": "1.1.1.1", [USER_CLIENT_IP_FORWARD_HEADER]: "9.9.9.9" }), closed), undefined);
  assert.equal(resolveBffClientIp(new Headers({ "x-forwarded-for": "198.51.100.4, 10.1.1.1", [USER_CLIENT_IP_FORWARD_HEADER]: "1.2.3.4" }), trusted), undefined);
  assert.equal(resolveBffClientIp(new Headers({ "x-forwarded-for": "198.51.100.4, 10.1.1.1", [USER_CLIENT_IP_FORWARD_HEADER]: "1.2.3.4" }), trusted, undefined, true), "198.51.100.4");
  assert.equal(resolveBffClientIp(new Headers({ "x-forwarded-for": "1.1.1.1" }), closed, "203.0.113.5"), "203.0.113.5");
});

test("sign-in counts once, keeps frozen and agreement off the password bucket, and does not hard-lock another ip", async () => {
  const store = throttle();
  let calls = 0;
  const handler = async (request: Request) => {
    calls += 1;
    const body = await request.json() as { password?: string };
    if (body.password === "frozen") return Response.json({ code: "ACCOUNT_FROZEN" }, { status: 403 });
    if (body.password === "terms") return Response.json({ code: "BAD_REQUEST" }, { status: 400 });
    if (body.password === "down") return Response.json({ code: "INTERNAL_ERROR" }, { status: 503 });
    if (body.password === "secret") return Response.json({ status: true }, { status: 200 });
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  };
  const wrapped = withUserAuthThrottle(handler, store, KEY);
  const subjects = signInSubjects(KEY, PHONE, IP);
  assert.notEqual(subjects.account, throttleDigest(KEY, "admin", "phone", PHONE));
  for (let index = 0; index < 2; index += 1) {
    const response = await wrapped(signInRequest({ phoneNumber: PHONE, password: "nope" }));
    assert.equal(response.status, 401);
  }
  assert.equal(calls, 2);
  const captcha = await wrapped(signInRequest({ phoneNumber: PHONE, password: "nope" }));
  assert.equal(captcha.status, 401);
  assert.equal((await captcha.json()).error.reason, "CAPTCHA_REQUIRED");
  const blocked = await wrapped(signInRequest({ phoneNumber: PHONE, password: "secret" }));
  assert.equal(blocked.status, 403);
  assert.equal(calls, 3);
  assert.equal((await blocked.clone().json()).upgrade, "CAPTCHA_REQUIRED");
  const otherIp = await wrapped(signInRequest({ phoneNumber: PHONE, password: "secret" }, OTHER_IP));
  assert.equal(otherIp.status, 403);
  const frozen = await wrapped(signInRequest({ phoneNumber: "+8613800138001", password: "frozen" }, OTHER_IP));
  assert.equal(frozen.status, 403);
  const frozenBody = await frozen.json() as { code?: string; error?: { reason?: string } };
  assert.equal(frozenBody.code, "ACCOUNT_FROZEN");
  assert.equal(frozenBody.error, undefined);
  const again = await wrapped(signInRequest({ phoneNumber: "+8613800138001", password: "secret" }, OTHER_IP));
  assert.equal(again.status, 200);
  const terms = await wrapped(signInRequest({ phoneNumber: "+8613800138002", password: "terms" }, OTHER_IP));
  assert.equal(terms.status, 400);
  const down = await wrapped(signInRequest({ phoneNumber: "+8613800138003", password: "down" }, OTHER_IP));
  assert.equal(down.status, 503);
  const afterDown = await wrapped(signInRequest({ phoneNumber: "+8613800138003", password: "secret" }, OTHER_IP));
  assert.equal(afterDown.status, 200);
  const identifier = await wrapped(signInRequest({ identifier: "+8613800138019", password: "nope", kind: "phone" }, "203.0.113.9", "/sign-in/identifier"));
  assert.equal(identifier.status, 401);
  assert.equal(calls, 9);
});

test("shared ip limits one nat without letting an attacker consume another account's pair", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, policy: { ...policy, ipMax: 1, pairMax: 10, accountCaptchaAfter: 9 }, captchaCost: 1 });
  const handler = async () => Response.json({}, { status: 401 });
  const wrapped = withUserAuthThrottle(handler, store, KEY);
  assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE, password: "nope" }, IP))).status, 401);
  assert.equal((await wrapped(signInRequest({ phoneNumber: "+8613800138009", password: "secret" }, IP))).status, 429);
  assert.equal((await wrapped(signInRequest({ phoneNumber: "+8613800138009", password: "secret" }, OTHER_IP))).status, 401);
  const retry = Number((await wrapped(signInRequest({ phoneNumber: PHONE, password: "nope" }, IP))).headers.get("retry-after"));
  assert.ok(retry >= 1);
});

test("missing and loopback addresses do not share a hard bucket", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, policy: { ...policy, pairMax: 1, ipMax: 1, accountCaptchaAfter: 9 }, captchaCost: 1 });
  let calls = 0;
  const wrapped = withUserAuthThrottle(async () => { calls += 1; return Response.json({}, { status: 401 }); }, store, KEY);
  const request = new Request("http://127.0.0.1/api/auth/user/sign-in/phone-number", {
    method: "POST", headers: { "content-type": "application/json", [USER_CLIENT_IP_FORWARD_HEADER]: "127.0.0.1" },
    body: JSON.stringify({ phoneNumber: PHONE, password: "nope" }),
  });
  const second = request.clone();
  assert.equal((await wrapped(request)).status, 401);
  assert.equal((await wrapped(second)).status, 401);
  assert.equal(calls, 2);
});

test("sms phone quota is shared, released on known failure, and otp failures are not password failures", async () => {
  const store = throttle();
  for (let index = 0; index < policy.smsPhonePerDay; index += 1) {
    const held = await store.holdSmsPhone(null, PHONE);
    assert.equal(held.decision, "allow");
    if (index === 0 && held.ticket) await store.releaseSmsPhone(held.ticket);
  }
  const heldAgain = await store.holdSmsPhone(null, PHONE);
  assert.equal(heldAgain.decision, "allow");
  assert.equal((await store.holdSmsPhone(null, PHONE)).decision, "limited");
  const subjects = signInSubjects(KEY, PHONE, undefined);
  const admitted = await store.admitSignIn(subjects, undefined);
  assert.equal(admitted.decision, "allow");
});

test("sms ip unknown counts and a known cooldown releases", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, policy: { ...policy, smsIpPerMinute: 1, smsIpCaptchaAfter: 9 }, captchaCost: 1 });
  const first = await store.admitSmsIp(IP, undefined);
  assert.equal(first.decision, "allow");
  await store.settleSmsIp(first.ticket, "unknown");
  const blocked = await store.admitSmsIp(IP, undefined);
  assert.equal(blocked.decision, "limited");
  await store.settleSmsIp(first.ticket, "release");
  const released = await store.admitSmsIp(OTHER_IP, undefined);
  assert.equal(released.decision, "allow");
  await store.settleSmsIp(released.ticket, "release");
  assert.equal((await store.admitSmsIp(OTHER_IP, undefined)).decision, "allow");
});

test("concurrent admits stay inside the pair cap", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, policy: { ...policy, pairMax: 3, ipMax: 100, accountCaptchaAfter: 100 }, captchaCost: 1 });
  const subjects = signInSubjects(KEY, PHONE, IP);
  const results = await Promise.all(Array.from({ length: 12 }, () => store.admitSignIn(subjects, undefined)));
  assert.equal(results.filter((result) => result.decision === "allow").length, 3);
  assert.equal(results.filter((result) => result.decision === "limited").length, 9);
});

test("captcha is one-time, realm-separated and expiry rejects without counting a password failure", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const altcha = require("altcha-lib") as { solveChallenge(input: Record<string, unknown>): Promise<{ counter: number; derivedKey: string }> };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pbkdf2 = require("altcha-lib/algorithms/pbkdf2") as { deriveKey: unknown };
  const user = createMemoryUserAuthThrottle({ hmacKey: KEY, policy: { ...policy, accountCaptchaAfter: 1 }, captchaCost: 1 });
  const admin = createMemoryUserAuthThrottle({ hmacKey: KEY, realm: "admin", policy: { ...policy, accountCaptchaAfter: 1 }, captchaCost: 1 });
  const subjects = signInSubjects(KEY, PHONE, undefined);
  await user.settleSignIn({ outcome: "credential", account: subjects.account });
  const required = await user.admitSignIn(subjects, undefined);
  assert.equal(required.decision, "captcha");
  const challenge = required.challenge as { parameters: Record<string, unknown>; signature: string };
  const solution = await altcha.solveChallenge({ challenge, deriveKey: pbkdf2.deriveKey });
  const payload = Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
  const adminSubjects = signInSubjects(KEY, PHONE, undefined, "admin");
  await admin.settleSignIn({ outcome: "credential", account: adminSubjects.account });
  assert.equal((await admin.admitSignIn(adminSubjects, payload)).decision, "captcha");
  assert.equal((await user.admitSignIn(subjects, payload)).decision, "allow");
  assert.equal((await user.admitSignIn(subjects, payload)).decision, "captcha");
  const expired = await user.challenge();
  expired.parameters.expiresAt = 1;
  const expiredPayload = Buffer.from(JSON.stringify({ challenge: expired, solution: { counter: 0, derivedKey: "aa" } })).toString("base64");
  assert.equal((await user.admitSignIn(subjects, expiredPayload)).decision, "captcha");
});

test("audit failure is not a 429 and the fallback has no phone", async () => {
  const store = createMemoryUserAuthThrottle({
    hmacKey: KEY,
    policy,
    audit: () => { throw new Error(`audit down ${PHONE}`); },
  });
  const subjects = signInSubjects(KEY, PHONE, IP);
  await store.admitSignIn(subjects, undefined);
  await store.settleSignIn({ outcome: "credential", ...subjects });
  assert.equal(store.fallbackLogs.length, 1);
  assert.equal(JSON.stringify(store.fallbackLogs).includes(PHONE), false);
  assert.equal(store.fallbackLogs[0]!.subjectPrefix.length, 8);
});

test("store outage is 503 and does not call the credential handler", async () => {
  let called = false;
  const store = createUserAuthThrottle({ hmacKey: KEY, store: "postgres", pool: { connect: async () => { throw new Error("db down"); } } as unknown as Pool });
  const wrapped = withUserAuthThrottle(async () => { called = true; return Response.json({ status: true }); }, store, KEY);
  const response = await wrapped(signInRequest({ phoneNumber: PHONE, password: "secret" }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.reason, "AUTH_DEPENDENCY_UNAVAILABLE");
  assert.equal(called, false);
});

test("postgres lock order is sorted and parameters are digests", async () => {
  const seen: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      if (sql.includes("SELECT purpose")) return { rows: [] };
      if (sql.includes("extract(epoch FROM clock_timestamp())")) return { rows: [{ now: String(Date.now()) }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const store = createPostgresUserAuthThrottle(pool, { hmacKey: KEY, policy, captchaCost: 1 });
  const subjects = signInSubjects(KEY, PHONE, IP);
  assert.equal((await store.admitSignIn(subjects, undefined)).decision, "allow");
  const locks = seen.filter((query) => query.sql.includes("pg_advisory_xact_lock")).map((query) => String(query.params?.[0]));
  assert.deepEqual(locks, [...locks].sort());
  assert.equal(seen.some((query) => query.sql.includes("zzsh_iam")), true);
  assert.equal(JSON.stringify(seen).includes(PHONE), false);
  assert.equal(JSON.stringify(seen).includes(IP), false);
  assert.equal(decideSignIn([], subjects, false, Date.now(), policy).decision, "allow");
});

test("Root: committed sign-in and SMS responses survive a later throttle settlement failure", async () => {
  const oldWarn = console.warn; console.warn = () => {};
  try {
    const loginStore = { realm: "user", mode: "candidate", admitSignIn: async () => ({ decision: "allow", ticket: "original" }), settleSignIn: async () => { throw new Error("meter down"); } } as any;
    const original = new Response(JSON.stringify({ status: true }), { status: 200, headers: { "set-cookie": "zzsh_user.session_token=SYNTHETIC; HttpOnly" } });
    const login = withUserAuthThrottle(async () => original, loginStore, KEY);
    const response = await login(signInRequest({ phoneNumber: PHONE, password: "correct" }));
    assert.equal(response, original); assert.match(response.headers.get("set-cookie")!, /SYNTHETIC/);
    const smsStore = { realm: "user", mode: "candidate", admitSmsIp: async () => ({ decision: "allow", ticket: "original_sms" }), settleSmsIp: async () => { throw new Error("meter down"); } } as any;
    const sent = Response.json({ status: true, challengeId: "challenge_original" });
    const sms = withUserAuthThrottle(async () => sent, smsStore, KEY);
    const result = await sms(signInRequest({ phoneNumber: PHONE }, IP, "/phone-registration/send-otp"));
    assert.equal(result, sent); assert.equal((await result.json()).challengeId, "challenge_original");
  } finally { console.warn = oldWarn; }
});

test("Root: postgres requires a stable independent HMAC outside production too", () => {
  assert.throws(() => readUserThrottleHmacKey({ NODE_ENV: "test", USER_AUTH_THROTTLE_STORE: "postgres" }, process.cwd()), /required/);
  assert.equal(readUserThrottleHmacKey({ NODE_ENV: "test", USER_AUTH_THROTTLE_STORE: "memory" }, process.cwd()), undefined);
  assert.equal(readUserThrottleHmacKey({ NODE_ENV: "test", USER_AUTH_THROTTLE_STORE: "postgres", USER_AUTH_THROTTLE_HMAC_KEY: KEY }, process.cwd()), KEY);
});

test("Root: failed SQL audit rolls back only its savepoint and keeps the counter transaction", async () => {
  const queries: string[] = [], oldWarn = console.warn;
  let aborted = false;
  console.warn = () => {};
  const client: any = { release() {}, query: async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith("ROLLBACK TO SAVEPOINT")) { aborted = false; return { rows: [], rowCount: 0 }; }
    if (aborted) throw Object.assign(new Error("aborted"), { code: "25P02" });
    if (sql === "SELECT audit_probe") { aborted = true; throw Object.assign(new Error("denied"), { code: "42501" }); }
    if (sql.includes("AS failures")) return { rows: [{ failures: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  try {
    const store = createPostgresUserAuthThrottle({ connect: async () => client } as any, { hmacKey: KEY, audit: async held => { await held.query("SELECT audit_probe"); } });
    const result = await store.settleSignIn({ outcome: "credential", ...signInSubjects(KEY, PHONE, IP) });
    assert.equal(result.captchaNow, false);
    assert.ok(queries.includes("SAVEPOINT user_auth_throttle_audit"));
    assert.ok(queries.includes("ROLLBACK TO SAVEPOINT user_auth_throttle_audit"));
    assert.equal(queries.at(-1), "COMMIT");
    assert.equal(store.fallbackLogs.length, 1);
  } finally { console.warn = oldWarn; }
});

const ALLOWED_POSTS = [
  "/sign-in/identifier", "/sign-in/phone-number", "/sign-out",
  "/phone-registration/send-otp", "/phone-registration/complete",
  "/profile/nickname", "/security/challenge/send", "/security/challenge/verify",
  "/security/password", "/security/email", "/security/phone", "/security/recovery/complete", "/security/operation",
  "/security/sessions/revoke", "/security/sessions/revoke-others", "/security/sessions/revoke-all",
];

test("default mode does not publish the proposal and base protection stays on the allowlist", () => {
  assert.deepEqual(userThrottleContract(), { mode: "base", store: "memory", shared: false, proposalPublished: false });
  assert.equal(userThrottleContract({ USER_AUTH_THROTTLE_MODE: "candidate", USER_AUTH_THROTTLE_STORE: "postgres" }).proposalPublished, false);
  assert.equal(userThrottleContract({ USER_AUTH_THROTTLE_STORE: "postgres" }).shared, true);
  assert.throws(() => readUserThrottleMode({ USER_AUTH_THROTTLE_MODE: "on" }), /base or candidate/);
  for (const path of ALLOWED_POSTS) {
    assert.equal(isUserAuthPathAllowed(path), true);
    const protection = userAuthPathProtection(path, "base");
    assert.equal(protection, "base-resolved-ip");
    assert.ok((USER_AUTH_BASE_RULES[path] ?? USER_AUTH_BASE_DEFAULT).max >= 1);
  }
  assert.equal(userAuthPathProtection("/security/captcha/challenge", "base"), "unpublished");
  assert.equal(userAuthPathProtection("/security/captcha/challenge", "candidate"), "base-resolved-ip");
  assert.equal(userAuthPathProtection("/get-session", "base"), "read-allowlist");
  assert.equal(userAuthPathProtection("/sign-in/identifier", "candidate"), "proposal");
  assert.equal(userAuthPathProtection("/security/password", "candidate"), "base-resolved-ip");
  assert.equal(isUserAuthPathAllowed("/identity/status"), false);
  assert.equal(isUserAuthPathAllowed("/phone-number/send-otp"), false);
});

test("base mode keeps a resolved-ip limit and does not put unknown or loopback addresses in one bucket", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "base", policy, captchaCost: 1 });
  let calls = 0;
  const wrapped = withUserAuthThrottle(async () => { calls += 1; return Response.json({ status: true }, { status: 401 }); }, store, KEY);
  for (let index = 0; index < 3; index += 1) assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE, password: "nope" }))).status, 401);
  const limited = await wrapped(signInRequest({ phoneNumber: "+8613800138099", password: "nope" }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.reason, "RATE_LIMITED");
  assert.equal(calls, 3);
  const open = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "base", policy, captchaCost: 1 });
  const forwarded = withUserAuthThrottle(async () => Response.json({ status: true }), open, KEY);
  for (let index = 0; index < 5; index += 1) {
    const loopback = new Request("http://127.0.0.1/api/auth/user/sign-in/phone-number", {
      method: "POST", headers: { "content-type": "application/json", [USER_CLIENT_IP_FORWARD_HEADER]: "127.0.0.1" },
      body: JSON.stringify({ phoneNumber: PHONE, password: "nope" }),
    });
    const forged = new Request("http://127.0.0.1/api/auth/user/sign-out", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": IP }, body: "{}",
    });
    assert.equal((await forwarded(loopback)).status, 200);
    assert.equal((await forwarded(forged)).status, 200);
  }
});

test("candidate sign-in stays on the proposal while other posts keep the base limit", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "candidate", policy: { ...policy, accountCaptchaAfter: 9, pairMax: 20, ipMax: 20 }, captchaCost: 1 });
  let posts = 0;
  const wrapped = withUserAuthThrottle(async () => { posts += 1; return Response.json({ ok: true }); }, store, KEY);
  for (let index = 0; index < USER_AUTH_BASE_DEFAULT.max; index += 1) {
    assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE }, IP, "/security/password"))).status, 200);
  }
  assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE }, IP, "/security/password"))).status, 429);
  assert.equal(posts, USER_AUTH_BASE_DEFAULT.max);
  const fourth = await wrapped(signInRequest({ phoneNumber: "+8613800138077", password: "nope" }));
  assert.notEqual(fourth.status, 429);
});

test("login and SMS digests differ, and every SMS hold shares one phone quota", async () => {
  assert.notEqual(throttleDigest(KEY, "user", "sign-in-phone", PHONE), throttleDigest(KEY, "user", "sms-phone", PHONE));
  const store = throttle();
  assert.equal((await store.holdSmsPhone(null, PHONE)).decision, "allow");
  assert.equal((await store.holdSmsPhone(null, PHONE)).decision, "allow");
  assert.equal((await store.holdSmsPhone(null, PHONE)).decision, "allow");
  assert.equal((await store.holdSmsPhone(null, PHONE)).decision, "limited");
});

test("a sign-in proof does not satisfy SMS, and the window edge follows the injected clock", async () => {
  const altcha = require("altcha-lib") as { solveChallenge(input: Record<string, unknown>): Promise<{ counter: number; derivedKey: string }> };
  const pbkdf2 = require("altcha-lib/algorithms/pbkdf2") as { deriveKey: unknown };
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "candidate", policy: { ...policy, accountCaptchaAfter: 1, smsIpCaptchaAfter: 1, smsIpPerMinute: 100, smsIpPerDay: 100 }, captchaCost: 1 });
  const subjects = signInSubjects(KEY, PHONE, undefined);
  await store.settleSignIn({ outcome: "credential", account: subjects.account });
  const issued = await store.challenge("sign-in");
  assert.equal(issued.parameters.data, "user:sign-in");
  const payload = Buffer.from(JSON.stringify({ challenge: issued, solution: await altcha.solveChallenge({ challenge: issued, deriveKey: pbkdf2.deriveKey }) })).toString("base64");
  assert.equal((await store.admitSignIn(subjects, payload)).decision, "allow");
  const sent = await store.admitSmsIp(IP, undefined);
  assert.equal(sent.decision, "allow");
  await store.settleSmsIp(sent.ticket, "sent");
  assert.equal((await store.admitSmsIp(IP, payload)).decision, "captcha");
  const now = 1_700_000_000_000;
  const edge = now - policy.signInWindowSeconds * 1000;
  const pair = signInSubjects(KEY, PHONE, IP).pair!;
  const row = { purpose: "sign-in", subject: pair, kind: "failure" as const, ticket: "ab".repeat(16), at: edge };
  assert.equal(decideSignIn([row], signInSubjects(KEY, PHONE, IP), false, now, { ...policy, pairMax: 1 }).decision, "allow");
  assert.equal(decideSignIn([{ ...row, at: edge + 1 }], signInSubjects(KEY, PHONE, IP), false, now, { ...policy, pairMax: 1 }).decision, "limited");
});

test("memory cleanup removes a bounded number of old subjects", async () => {
  let clock = 0;
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "candidate", now: () => clock, policy: { ...policy, daySeconds: 10, signInWindowSeconds: 10, pairMax: 10, ipMax: 10, accountCaptchaAfter: 100 }, captchaCost: 1 });
  for (const phone of ["+8613800138011", "+8613800138012"]) {
    assert.equal((await store.admitSignIn(signInSubjects(KEY, phone, IP), undefined)).decision, "allow");
  }
  clock = 20_000;
  assert.deepEqual(await store.sweepExpired(2), { events: 2, proofs: 0 });
  assert.equal((await store.sweepExpired(10)).events > 0, true);
});

test("postgres decisions use the database clock, and a missing relation is not a 429", async () => {
  const subjects = signInSubjects(KEY, PHONE, IP);
  const clockPool = { connect: async () => ({ release() {}, query: async (sql: string) => {
    if (sql.includes("pg_try_advisory")) return { rows: [{ ok: false }], rowCount: 1 };
    if (sql.includes("SELECT purpose")) return { rows: [{ purpose: "sign-in", subject: subjects.pair, kind: "reserved", ticket: "ab".repeat(16), at: new Date(4_000) }] };
    if (sql.includes("extract(epoch FROM clock_timestamp())")) return { rows: [{ now: "5000" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } }) } as unknown as Pool;
  const clockStore = createPostgresUserAuthThrottle(clockPool, { hmacKey: KEY, mode: "candidate", policy: { ...policy, pairMax: 1 } });
  assert.equal((await clockStore.admitSignIn(subjects, undefined)).decision, "limited");
  const missing = createPostgresUserAuthThrottle({ connect: async () => ({ release() {}, query: async (sql: string) => {
    if (sql.includes("pg_try_advisory")) return { rows: [{ ok: false }], rowCount: 1 };
    if (sql.includes("INSERT")) throw Object.assign(new Error("relation missing"), { code: "42P01" });
    if (sql.includes("extract(epoch FROM clock_timestamp())")) return { rows: [{ now: String(Date.now()) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } }) } as unknown as Pool, { hmacKey: KEY, mode: "candidate", policy });
  await assert.rejects(() => missing.admitSignIn(signInSubjects(KEY, "+8613800138066", OTHER_IP), undefined), (error: unknown) => error instanceof ThrottleDependencyError);
});

test("a durable phone denial is audited only after the business client is released", async () => {
  const subject = throttleDigest(KEY, "user", "sms-phone", PHONE);
  const rows = Array.from({ length: 3 }, () => ({ purpose: "sms-phone", subject, kind: "sent", ticket: "cd".repeat(16), at: new Date() }));
  let businessOpen = true;
  let connects = 0;
  const answer = async (sql: string) => {
    if (sql.includes("pg_try_advisory")) return { rows: [{ ok: false }], rowCount: 1 };
    if (sql.includes("SELECT purpose")) return { rows, rowCount: rows.length };
    if (sql.includes("extract(epoch FROM clock_timestamp())")) return { rows: [{ now: String(Date.now()) }], rowCount: 1 };
    if (sql === "SELECT denial_audit") {
      assert.equal(businessOpen, false);
      assert.equal(connects, 1);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const pool = { connect: async () => { connects += 1; return { release() {}, query: (sql: string) => answer(sql) }; } } as unknown as Pool;
  const store = createPostgresUserAuthThrottle(pool, { hmacKey: KEY, mode: "candidate", policy, audit: async (held) => { await held.query("SELECT denial_audit"); } });
  const business = { query: (sql: string) => answer(sql), release() {} };
  const held = await store.holdSmsPhone(business as unknown as import("pg").PoolClient, PHONE);
  assert.equal(held.decision, "limited");
  assert.equal(connects, 0);
  assert.equal(held.rejection?.purpose, "sms-phone");
  businessOpen = false;
  await store.recordRejection(held.rejection!);
  assert.equal(connects, 1);
});

test("postgres sweep is locked, ordered and capped", async () => {
  const seen: Array<{ sql: string; params?: unknown[] }> = [];
  let locked = true;
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, params?: unknown[]) => {
    seen.push({ sql, params });
    if (sql.includes("pg_try_advisory")) return { rows: [{ ok: locked }], rowCount: 1 };
    return { rows: [], rowCount: 2 };
  } }) } as unknown as Pool;
  const store = createPostgresUserAuthThrottle(pool, { hmacKey: KEY, mode: "base" });
  assert.deepEqual(await store.sweepExpired(2), { events: 2, proofs: 2 });
  assert.equal(seen.some((query) => query.params?.[0] === "user-auth-throttle-sweep"), true);
  assert.equal(seen.filter((query) => query.sql.includes("FOR UPDATE SKIP LOCKED") && query.params?.[0] === 2).length, 2);
  seen.length = 0;
  locked = false;
  assert.deepEqual(await store.sweepExpired(2), { events: 0, proofs: 0 });
  assert.equal(seen.some((query) => query.sql.includes("DELETE")), false);
});

test("candidate challenge issuance binds the action and base mode does not publish it", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "candidate", policy, captchaCost: 1 });
  const base = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "base", policy, captchaCost: 1 });
  const wrapped = withUserAuthThrottle(async () => Response.json({}), store, KEY);
  const hidden = withUserAuthThrottle(async () => Response.json({ published: true }), base, KEY);
  assert.equal((await hidden(new Request("http://127.0.0.1/api/auth/user/security/captcha/challenge"))).status, 404);
  const missing = await wrapped(new Request("http://127.0.0.1/api/auth/user/security/captcha/challenge"));
  assert.equal(missing.status, 400);
  const issued = await wrapped(new Request("http://127.0.0.1/api/auth/user/security/captcha/challenge?action=sms-send"));
  assert.equal(issued.status, 200);
  assert.equal((await issued.json()).challenge.parameters.data, "user:sms-send");
});


test("Root R1: accepted login and SMS survive both settlement and diagnostic failures", async () => {
  const oldWarn = console.warn;
  console.warn = () => { throw new Error("synthetic diagnostic sink unavailable"); };
  try {
    const loginStore = { realm: "user", mode: "candidate", admitSignIn: async () => ({ decision: "allow", ticket: "held" }), settleSignIn: async () => { throw new Error("synthetic settlement failure"); } } as any;
    const loggedIn = new Response("{}", { status: 200, headers: { "set-cookie": "zzsh_user.session_token=SYNTHETIC; HttpOnly" } });
    const login = withUserAuthThrottle(async () => loggedIn, loginStore, KEY);
    const response = await login(signInRequest({ phoneNumber: PHONE, password: "correct" }));
    assert.equal(response, loggedIn);
    assert.match(response.headers.get("set-cookie")!, /SYNTHETIC/);

    const smsStore = { realm: "user", mode: "candidate", admitSmsIp: async () => ({ decision: "allow", ticket: "sms-held" }), settleSmsIp: async () => { throw new Error("synthetic settlement failure"); } } as any;
    const sent = Response.json({ status: true, challengeId: "original_synthetic_challenge" });
    const sms = withUserAuthThrottle(async () => sent, smsStore, KEY);
    const result = await sms(signInRequest({ phoneNumber: PHONE }, IP, "/phone-registration/send-otp"));
    assert.equal(result, sent);
    assert.equal((await result.json()).challengeId, "original_synthetic_challenge");
  } finally { console.warn = oldWarn; }
});

test("Root R1: a failed rollback destroys the throttle client instead of pooling it", async () => {
  const released: Array<boolean | undefined> = [];
  const oldWarn = console.warn;
  console.warn = () => {};
  const pool = { connect: async () => ({
    query: async (sql: string) => {
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      throw new Error(sql === "ROLLBACK" ? "synthetic rollback unavailable" : "synthetic query failed");
    },
    release: (destroy?: boolean) => { released.push(destroy); },
  }) } as unknown as Pool;
  try {
    const store = createPostgresUserAuthThrottle(pool, { hmacKey: KEY, mode: "base" });
    await assert.rejects(() => store.admitBase(IP, { path: "/security/password", windowSeconds: 10, max: 100 }), ThrottleDependencyError);
    assert.ok(released.length > 0);
    assert.equal(released.every((destroy) => destroy === true), true);
  } finally { console.warn = oldWarn; }
});

type R1StoreQuery = { sql: string; parameters: readonly unknown[] };

function r1StorePool(seen: R1StoreQuery[], sweepLock: () => boolean, now: number): Pool {
  return { connect: async () => ({ release() {}, query: async (sql: string, parameters: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    seen.push({ sql: text, parameters });
    if (/pg_try_advisory_xact_lock/.test(text)) return { rows: [{ ok: sweepLock() }], rowCount: 1 };
    if (/extract\(epoch FROM clock_timestamp\(\)\)/.test(text)) return { rows: [{ now: String(now) }], rowCount: 1 };
    if (/^DELETE.*FOR UPDATE SKIP LOCKED/.test(text)) return { rows: [], rowCount: 2 };
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)|^SELECT pg_advisory|^SELECT purpose|^DELETE|^INSERT/.test(text)) return { rows: [], rowCount: 0 };
    throw new Error("unsupported synthetic throttle SQL");
  } }) } as unknown as Pool;
}

function r1ContainsTime(parameters: readonly unknown[], milliseconds: number, seconds: number): boolean {
  return parameters.some((value) => value instanceof Date ? value.getTime() === milliseconds
    : typeof value === "number" ? value === milliseconds || value === milliseconds / 1000 || value === seconds
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) === milliseconds || Number(value) === milliseconds / 1000 || Number(value) === seconds : false);
}

test("Root R1: base SQL binds purpose, the actual window and explicit per-event expiry", async () => {
  const seen: R1StoreQuery[] = [], now = 1_800_000_000_000;
  const store = createPostgresUserAuthThrottle(r1StorePool(seen, () => false, now), { hmacKey: KEY, mode: "base" });
  assert.equal((await store.admitBase(IP, { path: "/synthetic-base", windowSeconds: 13, max: 100 })).decision, "allow");
  const read = seen.find((entry) => /^SELECT purpose/.test(entry.sql));
  const insert = seen.find((entry) => /^INSERT/.test(entry.sql));
  assert.ok(read && insert);
  assert.match(read.sql, /\bpurpose\s*=\s*\$/);
  assert.match(read.sql, /\boccurred_at\s*>/);
  assert.match(read.sql, /\bexpires_at\s*>/);
  assert.ok(read.parameters.includes("base"));
  assert.ok(r1ContainsTime(read.parameters, now - 13_000, 13));
  assert.match(insert.sql, /\bexpires_at\b/);
  assert.ok(r1ContainsTime(insert.parameters, now + 13_000, 13));
  const subjectLock = seen.findIndex((entry) => /pg_advisory_xact_lock/.test(entry.sql));
  assert.ok(subjectLock >= 0 && subjectLock < seen.indexOf(read) && seen.indexOf(read) < seen.indexOf(insert));
});

test("Root R1: cleanup follows stored expiry, caps both tables and skips a competing sweeper", async () => {
  const seen: R1StoreQuery[] = [];
  let locked = true;
  const store = createPostgresUserAuthThrottle(r1StorePool(seen, () => locked, 1_800_000_000_000), { hmacKey: KEY, mode: "base" });
  assert.deepEqual(await store.sweepExpired(2), { events: 2, proofs: 2 });
  const deletes = seen.filter((entry) => /^DELETE.*FOR UPDATE SKIP LOCKED/.test(entry.sql));
  assert.equal(deletes.length, 2);
  for (const entry of deletes) {
    assert.match(entry.sql, /\bexpires_at\s*<=/);
    assert.match(entry.sql, /ORDER BY(?:\s+\w+\.)?\s*expires_at/);
    assert.doesNotMatch(entry.sql, /occurred_at\s*<=/);
    const limit = /\bLIMIT\s+\$(\d+)/.exec(entry.sql);
    assert.ok(limit);
    assert.equal(entry.parameters[Number(limit[1]) - 1], 2);
  }
  seen.length = 0;
  assert.deepEqual(await store.sweepExpired(100_000), { events: 2, proofs: 2 });
  for (const entry of seen.filter((query) => /^DELETE.*FOR UPDATE SKIP LOCKED/.test(query.sql))) {
    const limit = /\bLIMIT\s+\$(\d+)/.exec(entry.sql)!;
    assert.equal(entry.parameters[Number(limit[1]) - 1], 1000);
  }
  seen.length = 0;
  locked = false;
  assert.deepEqual(await store.sweepExpired(2), { events: 0, proofs: 0 });
  assert.equal(seen.some((entry) => /^DELETE/.test(entry.sql)), false);
});

test("Root R1: memory base events expire at their own rule window", async () => {
  let now = 1_800_000_000_000;
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "base", now: () => now });
  assert.equal((await store.admitBase(IP, { path: "/synthetic-short", windowSeconds: 13, max: 100 })).decision, "allow");
  assert.equal((await store.admitBase(IP, { path: "/synthetic-long", windowSeconds: 60, max: 100 })).decision, "allow");
  now += 14_000;
  assert.deepEqual(await store.sweepExpired(1), { events: 1, proofs: 0 });
  now += 47_000;
  assert.deepEqual(await store.sweepExpired(100), { events: 1, proofs: 0 });
});


function strictBaseWithoutProposalCounters() {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "base" });
  const unexpected = async () => { throw new Error("Base mode must not run unpublished proposal counters"); };
  store.admitSignIn = unexpected;
  store.settleSignIn = unexpected;
  store.admitSmsIp = unexpected;
  store.settleSmsIp = unexpected;
  return store;
}

function missingIpSignIn(value?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (value) headers.set(USER_CLIENT_IP_FORWARD_HEADER, value);
  return new Request("http://127.0.0.1/api/auth/user/sign-in/phone-number", { method: "POST", headers, body: JSON.stringify({ phoneNumber: PHONE, password: "synthetic_wrong" }) });
}

test("Root R1: strict base rejects unresolved and loopback IP before the auth handler", async () => {
  let calls = 0;
  const wrapped = withUserAuthThrottle(async () => { calls += 1; return Response.json({}, { status: 401 }); }, strictBaseWithoutProposalCounters(), KEY, { requireResolvedIp: true });
  for (const address of [undefined, "127.0.0.1", "::1"]) {
    const response = await wrapped(missingIpSignIn(address));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.reason, "AUTH_DEPENDENCY_UNAVAILABLE");
    assert.equal(response.headers.get("retry-after"), null, "a missing trusted IP is a dependency failure, not an exhausted quota");
  }
  assert.equal(calls, 0);
});

test("Root R1: strict candidate challenge does not issue a proof without a resolved IP", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "candidate", captchaCost: 1 });
  let issued = 0;
  store.challenge = async () => { issued += 1; throw new Error("Proof issuance must not run"); };
  const wrapped = withUserAuthThrottle(async () => { throw new Error("No upstream challenge handler"); }, store, KEY, { requireResolvedIp: true });
  const response = await wrapped(new Request("http://127.0.0.1/api/auth/user/security/captcha/challenge?action=sign-in"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.reason, "AUTH_DEPENDENCY_UNAVAILABLE");
  assert.equal(issued, 0);
});

test("Root R1: strict candidate POST rejects an unresolved IP before proposal admission", async () => {
  const store = createMemoryUserAuthThrottle({ hmacKey: KEY, mode: "candidate", captchaCost: 1 });
  let admissions = 0, calls = 0;
  store.admitSignIn = async () => { admissions += 1; throw new Error("Unresolved IP must be rejected before proposal admission"); };
  const wrapped = withUserAuthThrottle(async () => { calls += 1; return Response.json({}, { status: 401 }); }, store, KEY, { requireResolvedIp: true });
  const response = await wrapped(missingIpSignIn());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.reason, "AUTH_DEPENDENCY_UNAVAILABLE");
  assert.equal(admissions, 0);
  assert.equal(calls, 0);
});

test("Root R1: strict base leaves the three read-only GET paths available without an IP", async () => {
  let calls = 0;
  const wrapped = withUserAuthThrottle(async () => { calls += 1; return Response.json({ readable: true }); }, strictBaseWithoutProposalCounters(), KEY, { requireResolvedIp: true });
  for (const path of ["/get-session", "/security/overview", "/security/sessions"]) {
    const response = await wrapped(new Request("http://127.0.0.1/api/auth/user" + path));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).readable, true);
  }
  assert.equal(calls, 3);
});

test("Root R1: strict base keeps the existing resolved-IP sign-in and registration rules", async () => {
  let calls = 0;
  const wrapped = withUserAuthThrottle(async () => { calls += 1; return Response.json({}, { status: 401 }); }, strictBaseWithoutProposalCounters(), KEY, { requireResolvedIp: true });
  for (const path of ["/sign-in/phone-number", "/sign-in/identifier"]) {
    for (let index = 0; index < 3; index += 1) assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE, password: "synthetic_wrong" }, IP, path))).status, 401);
    assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE, password: "synthetic_wrong" }, IP, path))).status, 429);
  }
  for (const path of ["/phone-registration/send-otp", "/phone-registration/complete"]) {
    for (let index = 0; index < 5; index += 1) assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE }, IP, path))).status, 401);
    assert.equal((await wrapped(signInRequest({ phoneNumber: PHONE }, IP, path))).status, 429);
  }
  assert.equal(calls, 16);
});

test("Root R1: production defaults to resolved-IP enforcement while the explicit local fixture can opt out", async () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    let calls = 0;
    const upstream = async () => { calls += 1; return Response.json({}, { status: 401 }); };
    const production = withUserAuthThrottle(upstream, strictBaseWithoutProposalCounters(), KEY);
    assert.equal((await production(missingIpSignIn())).status, 503);
    assert.equal(calls, 0);
    const localFixture = withUserAuthThrottle(upstream, strictBaseWithoutProposalCounters(), KEY, { requireResolvedIp: false });
    assert.equal((await localFixture(missingIpSignIn())).status, 401);
    assert.equal(calls, 1);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});
