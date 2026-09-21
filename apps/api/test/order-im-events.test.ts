import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";

import {
  OrderImEventRecoveryLifecycle, buildStaffApprovalBasis, isHumanClientSource, normalizeClientSource, orderImEventsActivateApp,
  parseSupplierMessageEvent, recoverOrderFirstResponse, verifySupplierRequest,
} from "../src/im/order-im-events";
import { YunxinServerApiClient } from "../src/im/yunxin-provider";

const APP_KEY = "oim4b_synthetic_app";
const APP_SECRET = "synthetic-secret-value";
const NOW = 1_789_500_000_000;

function signedHeaders(rawBody: string, overrides: Partial<Record<"appkey" | "curtime" | "md5" | "checksum", string>> = {}) {
  const md5 = createHash("md5").update(rawBody).digest("hex");
  const curtime = String(NOW);
  return {
    appkey: APP_KEY,
    curtime,
    md5,
    checksum: createHash("sha1").update(`${APP_SECRET}${md5}${curtime}`).digest("hex"),
    ...overrides,
  };
}

test("supplier signature verification accepts only exact raw-body MD5 and CheckSum", () => {
  const rawBody = Buffer.from(JSON.stringify({ eventType: 1, convType: "TEAM" }), "utf8");
  const headers = signedHeaders(rawBody.toString("utf8"));
  assert.deepEqual(verifySupplierRequest({ rawBody, headers, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW, freshnessMs: 300_000 }), { ok: true, curTime: NOW, stale: false });
  assert.equal(verifySupplierRequest({ rawBody, headers: { ...headers, appkey: "other" }, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW, freshnessMs: 300_000 }).ok, false);
  assert.equal(verifySupplierRequest({ rawBody, headers: { ...headers, md5: "0".repeat(32) }, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW, freshnessMs: 300_000 }).ok, false);
  assert.equal(verifySupplierRequest({ rawBody, headers: { ...headers, checksum: "0".repeat(40) }, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW, freshnessMs: 300_000 }).ok, false);
  assert.equal(verifySupplierRequest({ rawBody, headers: { ...headers, curtime: "not-a-time" }, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW, freshnessMs: 300_000 }).ok, false);
  assert.equal(verifySupplierRequest({ rawBody, headers: {}, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW, freshnessMs: 300_000 }).ok, false);
  // A valid signature stays trusted past the freshness window; staleness is reported separately.
  assert.deepEqual(verifySupplierRequest({ rawBody, headers, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW + 600_000, freshnessMs: 300_000 }),
    { ok: true, curTime: NOW, stale: true });
  const tampered = verifySupplierRequest({ rawBody: Buffer.from(rawBody.toString("utf8").replace("TEAM", "PERSON")), headers, appKey: APP_KEY, appSecret: APP_SECRET, nowMs: NOW, freshnessMs: 300_000 });
  assert.deepEqual(tampered, { ok: false, reason: "body-md5-mismatch" });
});

test("robot client sends and cross-App activation are excluded by shape", () => {
  assert.equal(isHumanClientSource("8"), true);
  assert.equal(isHumanClientSource(" 8 "), true);
  assert.equal(isHumanClientSource("32"), false);
  assert.equal(isHumanClientSource(" 32 "), false);
  assert.equal(isHumanClientSource(null), false);
  // Numeric official sources normalize; illegal shapes stay unknown instead of silently human.
  assert.equal(normalizeClientSource(32), "32");
  assert.equal(normalizeClientSource("WEB"), "WEB");
  assert.equal(normalizeClientSource(""), null);
  assert.equal(normalizeClientSource(true), null);
  assert.equal(normalizeClientSource(32.5), null);
  assert.equal(normalizeClientSource({ clientType: 8 }), null);
  assert.equal(normalizeClientSource("x".repeat(33)), null);
  assert.equal(isHumanClientSource(normalizeClientSource(32)), false);
  assert.equal(isHumanClientSource(normalizeClientSource(undefined)), false);
  assert.equal(orderImEventsActivateApp({ appKey: "app_a" }, "app_a"), true);
  assert.equal(orderImEventsActivateApp({ appKey: "app_a" }, "app_b"), false);
  assert.equal(orderImEventsActivateApp(undefined, "app_a"), false);
  assert.equal(orderImEventsActivateApp({ appKey: "app_a" }, undefined), false);
  const basis = buildStaffApprovalBasis({ platformSubjectId: "admin_1", memberJoinedAt: new Date("2026-09-20T00:00:00.000Z"), scope: "game_1" });
  assert.deepEqual(basis, {
    basisVersion: 1, platformSubjectId: "admin_1", party: "STAFF", memberState: "JOINED",
    memberJoinedAt: "2026-09-20T00:00:00.000Z", permissions: ["im.support.read", "im.support.accept"], scope: "game_1", adminStatus: "ACTIVE",
  });
});

test("supplier event parsing keeps only whitelisted identifiers", () => {
  const copy = parseSupplierMessageEvent({
    eventType: "1", convType: "TEAM", to: "63941858026", fromAccount: "zza123", msgType: "TEXT",
    msgTimestamp: "1789500000000", msgidServer: "4291065454174142469", msgidClient: "client-1", resendFlag: "1", body: "secret text", attach: "secret attach",
  }, 1);
  assert.equal(copy.ok, true);
  if (!copy.ok) return;
  assert.deepEqual({ teamId: copy.event.teamId, fromAccount: copy.event.fromAccount, msgType: copy.event.msgType, server: copy.event.messageServerId, client: copy.event.messageClientId, resend: copy.event.resend },
    { teamId: "63941858026", fromAccount: "zza123", msgType: "TEXT", server: "4291065454174142469", client: "client-1", resend: true });
  assert.equal(copy.event.occurredAt.toISOString(), new Date(1789500000000).toISOString());
  assert.equal(parseSupplierMessageEvent({ eventType: 1, convType: "PERSON", to: "1", fromAccount: "a", msgType: "TEXT", msgTimestamp: "1789500000000" }, 1).ok, false);
  assert.equal(parseSupplierMessageEvent({ eventType: 2, convType: "TEAM", to: "1", fromAccount: "a", msgType: "TEXT", msgTimestamp: "1789500000000" }, 1).ok, false);
  assert.equal(parseSupplierMessageEvent({ eventType: 1, convType: "TEAM", to: "abc", fromAccount: "a", msgType: "TEXT", msgTimestamp: "1789500000000" }, 1).ok, false);
  const emptyClient = parseSupplierMessageEvent({ eventType: 1, convType: "TEAM", to: "1", fromAccount: "a", msgType: "PICTURE", msgTimestamp: "1789500000000", msgidServer: "2", msgidClient: "" }, 1);
  assert.equal(emptyClient.ok, true);
  if (emptyClient.ok) assert.equal(emptyClient.event.messageClientId, null);
  const preSend = parseSupplierMessageEvent({ eventType: 2, to: "63941858026", fromAccount: "zza123", fromClientType: "WEB", msgType: "TEXT", msgTimestamp: "1789500000000", msgidClient: "client-2" }, 2);
  assert.equal(preSend.ok, true);
  if (preSend.ok) { assert.equal(preSend.event.messageServerId, null); assert.equal(preSend.event.fromClientType, "WEB"); }
  assert.equal(parseSupplierMessageEvent({ eventType: 2, to: "63941858026", fromAccount: "zza123", msgType: "TEXT", msgTimestamp: "1789500000000" }, 2).ok, true);
  // The official numeric client source is normalized at the parse boundary, not dropped to null.
  const numericSource = parseSupplierMessageEvent({ eventType: 2, to: "63941858026", fromAccount: "zza123", fromClientType: 32, msgType: "TEXT", msgTimestamp: "1789500000000" }, 2);
  assert.equal(numericSource.ok, true);
  if (numericSource.ok) assert.equal(numericSource.event.fromClientType, "32");
});

test("provider readTeamMessage uses the narrow conversation endpoint with explicit team checks", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new YunxinServerApiClient({
    appKey: APP_KEY, appSecret: APP_SECRET,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ code: 200, msg: "success", data: {
        message_server_id: "4291065454174142469", message_client_id: "client-1", sender_id: "zza123",
        team_id: 63941858026, message_type: 1, create_time: 1789500000000, text: "must not leak", attachment: { url: "https://example.invalid" },
      } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const fact = await client.readTeamMessage({ teamId: "63941858026", operatorAccountId: "zzs_system", messageServerId: "4291065454174142469", messageTime: 1789500000000 });
  assert.deepEqual(fact, { messageServerId: "4291065454174142469", messageClientId: "client-1", senderId: "zza123", teamId: "63941858026", messageType: 1, createTime: 1789500000000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/im\/v2\.1\/conversations\/zzs_system%7C2%7C63941858026\/messages\/4291065454174142469\?/);
  assert.match(calls[0]!.url, /check_team_valid=true/);
  assert.match(calls[0]!.url, /check_team_member_valid=true/);
  assert.match(calls[0]!.url, /message_time=1789500000000/);
  assert.equal(calls[0]!.method, "GET");
  assert.ok(!JSON.stringify(fact).includes("must not leak"));
});

test("provider readTeamMessage maps confirmed absence to null and rejects mismatched facts", async () => {
  const notFound = new YunxinServerApiClient({
    appKey: APP_KEY, appSecret: APP_SECRET,
    fetch: (async () => new Response(JSON.stringify({ code: 107404, msg: "message not exist" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  assert.equal(await notFound.readTeamMessage({ teamId: "1", operatorAccountId: "acc", messageServerId: "2" }), null);
  const teamGone = new YunxinServerApiClient({
    appKey: APP_KEY, appSecret: APP_SECRET,
    fetch: (async () => new Response(JSON.stringify({ code: 108404, msg: "team not exist" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  assert.equal(await teamGone.readTeamMessage({ teamId: "1", operatorAccountId: "acc", messageServerId: "2" }), null);
  const mismatched = new YunxinServerApiClient({
    appKey: APP_KEY, appSecret: APP_SECRET,
    fetch: (async () => new Response(JSON.stringify({ code: 200, data: { message_server_id: 999, sender_id: "a", team_id: 1, message_type: 0, create_time: 1 } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  await assert.rejects(mismatched.readTeamMessage({ teamId: "1", operatorAccountId: "acc", messageServerId: "2" }));
  await assert.rejects(notFound.readTeamMessage({ teamId: "1", operatorAccountId: "acc", messageServerId: "not-a-number" }));
  // An unsafe JSON number cannot be trusted to identify a message: fail closed instead of guessing.
  const unsafeNumber = new YunxinServerApiClient({
    appKey: APP_KEY, appSecret: APP_SECRET,
    fetch: (async () => new Response(JSON.stringify({ code: 200, data: { message_server_id: 4291065454174142469, message_client_id: null, sender_id: "a", team_id: 1, message_type: 0, create_time: 1 } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  await assert.rejects(unsafeNumber.readTeamMessage({ teamId: "1", operatorAccountId: "acc", messageServerId: "4291065454174142469" }));
});

test("recovery surfaces startup failure and awaits the in-flight sweep on shutdown", async () => {
  const broken = { query: async () => { throw new Error("database unavailable"); } } as unknown as Pool;
  await assert.rejects(recoverOrderFirstResponse({ pool: broken, appId: APP_KEY, appSecret: APP_SECRET }));
  let finished = false;
  const slow = { query: async () => { await new Promise((resolve) => setTimeout(resolve, 200)); finished = true; return { rows: [] }; } } as unknown as Pool;
  const lifecycle = new OrderImEventRecoveryLifecycle();
  lifecycle.start({ pool: slow, appId: APP_KEY, appSecret: APP_SECRET }, 60_000);
  await lifecycle.beforeApplicationShutdown();
  assert.equal(finished, true);
});
