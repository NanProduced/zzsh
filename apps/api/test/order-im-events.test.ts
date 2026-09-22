import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";

import {
  OrderImEventRecoveryLifecycle, buildStaffApprovalBasis, clientSourcesConflict, conflictingApproval, conflictingDelivery,
  deliverySourceOf, isHumanClientSource, normalizeClientSource, orderImEventsActivateApp, parseSupplierMessageEvent,
  recoverOrderFirstResponse, verifySupplierRequest, mountOrderImEventHandlers,
} from "../src/im/order-im-events";
import { YunxinServerApiClient } from "../src/im/yunxin-provider";
import { createApp } from "../src/app";

const APP_KEY = "oim4b_synthetic_app";
const APP_SECRET = "synthetic-secret-value";
const NOW = 1_789_500_000_000;

function signedHeadersAt(rawBody: string, curtime = String(NOW), appkey = APP_KEY) {
  const md5 = createHash("md5").update(rawBody).digest("hex");
  return {
    appkey,
    curtime,
    md5,
    checksum: createHash("sha1").update(`${APP_SECRET}${md5}${curtime}`).digest("hex"),
  };
}
const signedHeaders = (rawBody: string, overrides: Partial<Record<"appkey" | "curtime" | "md5" | "checksum", string>> = {}) => ({ ...signedHeadersAt(rawBody), ...overrides });

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

test("documented client source aliases normalize; REST, unknown and malformed values cannot count as human", () => {
  for (const [name, number] of [["AOS", 1], ["IOS", 2], ["PC", 4], ["WEB", 16], ["REST", 32], ["MAC", 64], ["HARMONY", 65]] as const) {
    assert.equal(normalizeClientSource(name), name);
    assert.equal(normalizeClientSource(number), name);
    assert.equal(normalizeClientSource(String(number)), name);
  }
  for (const source of ["AOS", "IOS", "PC", "WEB", "MAC", "HARMONY"]) assert.equal(isHumanClientSource(source), true);
  for (const source of ["REST", 32, "32", "8", 8, "WINPHONE", "UNKNOWN", undefined, null, {}, [], true, 32.5, " 16 ", "x".repeat(33)]) {
    assert.equal(isHumanClientSource(source), false, `unexpected human source ${String(source)}`);
  }
  assert.equal(normalizeClientSource({ clientType: 16 }), null);
  assert.equal(normalizeClientSource(""), null);
  assert.equal(normalizeClientSource(true), null);
  assert.equal(normalizeClientSource(32.5), null);
  assert.equal(normalizeClientSource({ clientType: 8 }), null);
  assert.equal(normalizeClientSource("x".repeat(33)), null);
  assert.equal(clientSourcesConflict("WEB", 16), false);
  assert.equal(clientSourcesConflict("WEB", "WEB"), false);
  assert.equal(clientSourcesConflict("WEB", "MAC"), true);
  assert.equal(clientSourcesConflict("WEB", "WINPHONE"), true);
  assert.equal(clientSourcesConflict("WEB", undefined), true);
  assert.equal(clientSourcesConflict(undefined, "WEB"), true);
  assert.equal(clientSourcesConflict(undefined, undefined), true);
  assert.equal(clientSourcesConflict("WEB", null), true);
  assert.equal(clientSourcesConflict("WEB", {}), true);
  assert.equal(clientSourcesConflict("WEB", 8), true);
  assert.equal(isHumanClientSource(normalizeClientSource(32)), false);
  assert.equal(isHumanClientSource(normalizeClientSource(undefined)), false);
  assert.equal(isHumanClientSource("32"), false);
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

test("duplicate, approval and recovery metadata share source alias/conflict semantics", () => {
  const timestamp = new Date(NOW);
  const base = { type: "send_approved", status: "VERIFIED", messageType: "TEXT", occurredAt: timestamp };
  assert.equal(conflictingApproval([
    { ...base, metadata: { fromClientType: "WEB" } },
    { ...base, metadata: { fromClientType: 16 } },
  ]), false);
  assert.equal(conflictingApproval([
    { ...base, metadata: { fromClientType: "WEB" } },
    { ...base, metadata: { fromClientType: "MAC" } },
  ]), true);
  assert.equal(conflictingApproval([
    { ...base, metadata: {} },
    { ...base, metadata: { fromClientType: "WEB" } },
  ]), true);
  assert.equal(conflictingApproval([
    { ...base, metadata: {} },
    { ...base, metadata: {} },
  ]), true);

  const eventResult = parseSupplierMessageEvent({ eventType: 1, convType: "TEAM", to: "1", fromAccount: "staff", msgType: "TEXT", msgTimestamp: NOW, msgidServer: "2", msgidClient: "client", fromClientType: 16 }, 1);
  assert.equal(eventResult.ok, true);
  if (!eventResult.ok) return;
  const existing = { id: "event", status: "WAITING_AUTH", sender_account_id: "staff", occurred_at: timestamp.toISOString(), message_client_id: "client", message_type: "TEXT", metadata: { source: "WEB" } };
  assert.equal(conflictingDelivery(existing, eventResult.event), false);
  assert.equal(deliverySourceOf({ source: "16" }), "WEB");
  assert.equal(deliverySourceOf({ source: "MAC" }), "MAC");
  assert.equal(conflictingDelivery({ ...existing, metadata: { source: "WEB" } }, { ...eventResult.event, fromClientType: "MAC" }), true);
  // Historical rows without source remain readable without rewriting or inventing a source.
  assert.equal(deliverySourceOf({ reason: "legacy" }), null);
  assert.equal(conflictingDelivery({ ...existing, metadata: {} }, eventResult.event), true);
  for (const fromClientType of [undefined, null, {}, 8]) {
    const retry = parseSupplierMessageEvent({
      eventType: 1, convType: "TEAM", to: "1", fromAccount: "staff", msgType: "TEXT",
      msgTimestamp: String(NOW), msgidServer: "2", msgidClient: "client",
      ...(fromClientType === undefined ? {} : { fromClientType }),
    }, 1);
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(conflictingDelivery(existing, retry.event), true, `untrusted retry source ${String(fromClientType)}`);
  }
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
  if (numericSource.ok) assert.equal(numericSource.event.fromClientType, "REST");
});

test("actual Nest/Express callback parser accepts only a fresh signed empty copy probe without business effects", async () => {
  let databaseAttempts = 0;
  let now = NOW;
  const pool = {
    async connect() { databaseAttempts += 1; throw new Error("synthetic persistence failure"); },
  } as unknown as Pool;
  const app = await createApp({ health: { dependencies: {
    postgres: { check: async () => undefined, close: async () => undefined },
    redis: { check: async () => undefined, close: async () => undefined },
  } }, logSink: { write: () => undefined } });
  mountOrderImEventHandlers(app as unknown as INestApplication, { pool, appId: APP_KEY, appSecret: APP_SECRET, now: () => now, freshnessMs: 300_000 });
  await app.listen(0, "127.0.0.1");
  try {
    const base = await app.getUrl();
    const send = (path: string, body: string, headers = signedHeaders(body)) => fetch(`${base}${path}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: body || undefined,
    });
    let response = await send("/api/v1/im/order-events/copy", "");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(databaseAttempts, 0);

    assert.equal((await send("/api/v1/im/order-events/copy", "{}")).status, 400);
    assert.equal((await send("/api/v1/im/order-events/copy", "{")).status, 400);
    assert.equal((await send("/api/v1/im/order-events/copy", "", { ...signedHeadersAt(""), checksum: "0".repeat(40) })).status, 403);
    assert.equal((await send("/api/v1/im/order-events/copy", "", signedHeadersAt("", String(NOW), "other-app"))).status, 403);
    assert.equal((await send("/api/v1/im/order-events/copy", "", signedHeadersAt("", String(NOW - 400_000)))).status, 403);
    assert.equal((await send("/api/v1/im/order-events/pre-send", "")).status, 400);
    assert.equal(databaseAttempts, 0);

    const business = JSON.stringify({ eventType: 1, convType: "TEAM", to: "63941858026", fromAccount: "admin-1", fromClientType: "WEB", msgType: "TEXT", msgTimestamp: NOW, msgidServer: "4291065454174142469", msgidClient: "client-1" });
    response = await send("/api/v1/im/order-events/copy", business);
    assert.equal(response.status, 503);
    assert.equal(databaseAttempts, 1);
  } finally {
    now = NOW;
    await app.close();
  }
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
