import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";

import { isUserAuthPathAllowed } from "../src/auth/auth-runtime";
import {
  createMemoryUserAuthThrottle,
  createPostgresUserAuthThrottle,
  createUserAuthThrottle,
  decideSignIn,
  signInSubjects,
  throttleDigest,
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

test("proposal stays unpublished and native sms paths stay closed", () => {
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
  assert.equal(resolveBffClientIp(new Headers({ "x-forwarded-for": "198.51.100.4, 10.1.1.1" }), trusted), "198.51.100.4");
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
