import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";

import { mountAuthHandlers } from "../src/auth/auth-runtime";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey, type ImIdentityMapping } from "../src/im/identity-lifecycle";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { handleYunxinRoute, parseMessageBody, type YunxinRouteOptions } from "../src/im/yunxin-routes";
import { MAX_MEDIA_BYTES } from "../src/supply/media";
import { InMemoryMessageTransport } from "./im-local-fixtures";

const APP_ID = "provider-test";

function key(kind: ImIdentityKey["kind"], subject: string): ImIdentityKey {
  return { provider: "yunxin", appId: APP_ID, realm: kind === "ADMIN" ? "admin" : "user", kind, platformSubjectId: subject };
}

function mapping(identityKey: ImIdentityKey, status: ImIdentityMapping["status"] = "READY"): ImIdentityMapping {
  return {
    id: "im_1",
    key: identityKey,
    accountId: deriveYunxinAccountId(identityKey),
    identityMarker: buildYunxinIdentityMarker(identityKey),
    status,
    version: 2,
    attemptCount: 1,
    attemptLeaseUntil: null,
    nextRetryAt: null,
    lastFailure: null,
  };
}

function dbRow(identityKey: ImIdentityKey): Record<string, unknown> {
  const value = mapping(identityKey);
  return {
    id: value.id,
    provider: "yunxin",
    appId: identityKey.appId,
    realm: identityKey.realm,
    identityKind: identityKey.kind,
    platformSubjectId: identityKey.platformSubjectId,
    accountId: value.accountId,
    identityMarker: value.identityMarker,
    status: value.status,
    version: String(value.version),
    attemptCount: value.attemptCount,
    attemptLeaseUntil: null,
    nextRetryAt: null,
    lastFailureClass: null,
    lastFailureProviderCode: null,
  };
}

test("SQL repository uses DB clock and stores only a lease hash", async () => {
  const identityKey = key("USER", "user-1");
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: [dbRow(identityKey)] };
    },
  } as never;
  const repository = new YunxinIdentityRepository(pool);
  const claim = await repository.claimProvisionAttempt({ mappingId: "im_1", expectedVersion: 1, now: new Date(0), leaseMs: 30_000 });
  assert.ok(claim?.leaseToken);
  assert.match(calls[0]!.text, /clock_timestamp\(\)/);
  assert.ok(!calls[0]!.text.includes("leaseToken"));
  assert.equal(calls[0]!.values?.[0], "im_1");
  assert.equal(calls[0]!.values?.[1], 1);
  assert.equal(calls[0]!.values?.[3], 30_000);

  await repository.markRetryableFailure({
    mappingId: "im_1",
    expectedVersion: 2,
    leaseToken: claim!.leaseToken,
    failure: { class: "UNKNOWN_RESULT", providerCode: null },
    retryAfterMs: 1_000,
  });
  assert.match(calls[1]!.text, /next_retry_at.*clock_timestamp/s);
  assert.equal(calls[1]!.values?.[3], 1_000);
  assert.equal(calls[1]!.values?.[4], "UNKNOWN_RESULT");
  assert.equal(calls[1]!.values?.[5], null);
});

function responseCapture() {
  const result = {
    headersSent: false,
    statusCode: 200,
    headers: new Map<string, string | string[]>(),
    body: undefined as unknown,
    setHeader(name: string, value: string | string[]) { result.headers.set(name.toLowerCase(), value); return result; },
    status(value: number) { result.statusCode = value; return result; },
    json(value: unknown) { result.body = value; result.headersSent = true; },
  };
  return result;
}

function userRouteOptions(overrides: Partial<YunxinRouteOptions> = {}): YunxinRouteOptions {
  const userKey = key("USER", "user-1");
  const pool = {
    query: async () => ({ rows: [{ suspended: false, accountStatus: "ACTIVE" }] }),
  } as never;
  const security = {
    pool,
    apiOrigin: "http://127.0.0.1:3102",
    userOrigin: "http://127.0.0.1:3100",
    adminOrigin: "http://127.0.0.1:3101",
    userAuth: { api: { getSession: async () => ({ user: { id: "user-1" }, session: { id: "session-1" } }) } },
    adminAuth: { api: { getSession: async () => null } },
  } as unknown as YunxinRouteOptions["security"];
  const repository = {
    findByKey: async () => mapping(userKey),
    listMappings: async () => [mapping(userKey)],
  } as unknown as YunxinRouteOptions["repository"];
  return {
    security,
    appId: APP_ID,
    repository,
    provisioner: { ensure: async (input: { key: ImIdentityKey }) => ({ outcome: "READY", mapping: mapping(input.key) }) } as never,
    tokenService: { issue: async () => ({ accountId: mapping(userKey).accountId, token: "short-lived", issuedAt: 1_000, expiresAt: 601_000, ttlSeconds: 600 }) } as never,
    ...overrides,
  };
}

test("user token route derives the subject from the authenticated session", async () => {
  const options = userRouteOptions();
  const response = responseCapture();
  await handleYunxinRoute({
    method: "GET",
    url: "/api/v1/im/user/token?platformSubjectId=other-user",
    headers: { origin: "http://127.0.0.1:3100", cookie: "zzsh_user.session_token=opaque" },
  }, response, options);
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    appKey: APP_ID,
    accountId: deriveYunxinAccountId(key("USER", "user-1")),
    token: "short-lived",
    issuedAt: "1970-01-01T00:00:01.000Z",
    expiresAt: "1970-01-01T00:10:01.000Z",
    ttlSeconds: 600,
    transport: "nim",
  });
});

test("admin identity listing does not expose the provider marker", async () => {
  const adminKey = key("ADMIN", "admin-1");
  const adminMapping = mapping(adminKey);
  const pool = {
    query: async (text: string) => {
      if (text.includes("admin_security")) return { rows: [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] };
      if (text.includes("zzsh_auth_admin") && text.includes("suspended")) return { rows: [{ suspended: false }] };
      return { rows: [] };
    },
  } as never;
  const options = userRouteOptions({
    security: {
      ...userRouteOptions().security,
      pool,
      adminAuth: { api: { getSession: async () => ({ user: { id: "admin-1", twoFactorEnabled: true }, session: { id: "session-1", locked: false } }) } },
    } as unknown as YunxinRouteOptions["security"],
    repository: {
      findByKey: async (lookup: ImIdentityKey) => lookup.platformSubjectId === "admin-1" ? adminMapping : null,
      listMappings: async () => { throw new Error("app-wide mapping listing must not be used"); },
    } as unknown as YunxinRouteOptions["repository"],
  });
  const response = responseCapture();
  await handleYunxinRoute({ method: "GET", url: "/api/v1/im/admin/identities", headers: { origin: "http://127.0.0.1:3101", cookie: "zzsh_admin.session_token=opaque" } }, response, options);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { identities: [{
    id: "im_1",
    appId: APP_ID,
    realm: "admin",
    kind: "ADMIN",
    platformSubjectId: "admin-1",
    accountId: adminMapping.accountId,
    status: "READY",
    version: 2,
    attemptCount: 1,
    attemptLeaseUntil: null,
    nextRetryAt: null,
    lastFailure: null,
  }] });
});

test("test IM seams fail closed without the explicit test capability", async () => {
  await assert.rejects(
    mountAuthHandlers({} as never, {
      pool: { query: async (sql: string, args: any[]) => ({ rows: sql.includes("unnest") ? args[0].map((name: string) => ({ name, present: true, readable: true })) : [{ version: 1, schemaCreate: false }] }) } as never,
      apiOrigin: "http://127.0.0.1:3102",
      userOrigin: "http://127.0.0.1:3100",
      adminOrigin: "http://127.0.0.1:3101",
      userSecret: "user-secret",
      adminSecret: "admin-secret",
      secureCookies: false,
      testOperationsEnabled: false,
      yunxin: { appId: APP_ID, appKey: "test-app-key", appSecret: "test-app-secret" },
      testYunxinProvider: {} as never,
    }),
    /Test IM providers require test operations capability/,
  );
});

async function noisyPng(width: number, height: number): Promise<Buffer> {
  const bytes = Buffer.alloc(width * height * 3);
  let seed = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = seed >>> 24;
  }
  return sharp(bytes, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
}

function imageBody(bytes: Buffer, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: "viewer|2|1",
    image: {
      messageClientId: "image-1",
      name: "proof.png",
      mimeType: "image/png",
      size: bytes.length,
      data: bytes.toString("base64"),
      ...overrides,
    },
  };
}

test("IM image body uses bounded Base64 and the full decoder", async () => {
  const small = await sharp({ create: { width: 8, height: 4, channels: 3, background: "red" } }).png().toBuffer();
  const parsed = await parseMessageBody(imageBody(small));
  assert.equal(parsed.kind, "image");
  if (parsed.kind !== "image") throw new Error("image parser returned text");
  assert.deepEqual({ width: parsed.image.width, height: parsed.image.height }, { width: 8, height: 4 });

  const sizes: Array<[number, number]> = [[1_250, 1_400], [1_660, 2_100]];
  for (const [width, height] of sizes) {
    const large = await noisyPng(width, height);
    assert.ok(large.length > (width === 1_250 ? 5 * 1024 * 1024 : 10_000_000));
    assert.ok(large.length <= MAX_MEDIA_BYTES);
    const accepted = await parseMessageBody(imageBody(large, { messageClientId: `image-${width}` }));
    assert.equal(accepted.kind, "image");
    if (accepted.kind !== "image") throw new Error("image parser returned text");
    assert.equal(accepted.image.body.length, large.length);
  }

  await assert.rejects(() => parseMessageBody(imageBody(small, { size: MAX_MEDIA_BYTES + 1 })), /Image message is invalid/);
  await assert.rejects(() => parseMessageBody(imageBody(small, { size: 1, data: "" })), /Image data is invalid/);
  await assert.rejects(() => parseMessageBody(imageBody(small, { mimeType: "image/jpeg" })), /Image MIME type is invalid/);
  await assert.rejects(() => parseMessageBody(imageBody(small, { width: 9 })), /Image dimensions are invalid/);
  const corrupted = Buffer.from(small);
  const idat = corrupted.indexOf("IDAT");
  assert.ok(idat > 0);
  corrupted[idat + 8] = (corrupted[idat + 8] ?? 0) ^ 0xff;
  await assert.rejects(() => parseMessageBody(imageBody(corrupted)), /Image bytes are invalid/);
});

const USER_ORIGIN = "http://127.0.0.1:3100";

function userAccount(userId: string): string {
  return deriveYunxinAccountId(key("USER", userId));
}

function conversationOf(userId: string, teamId: string): string {
  return `${userAccount(userId)}|2|${teamId}`;
}

type MessageHarness = {
  transport: InMemoryMessageTransport;
  options: YunxinRouteOptions;
  as(userId: string): void;
};

function consultationRow(userId: string, teamId: string) {
  return {
    id: `im_consult_${teamId}`,
    userId,
    kind: "GENERAL",
    state: "ACTIVE",
    userAccountId: userAccount(userId),
    peerAccountId: "support-1",
    appId: APP_ID,
    assignedAdminId: null,
    subjectRef: null,
    messageScopeType: "TEAM",
    messageScopeId: teamId,
    messageScopeState: "READY",
    messageScopeVersion: "1",
    version: "1",
    lastMessageAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    userName: "User",
    userUsername: "user",
    adminName: null,
  };
}

/** Offline stand-in for the two access checks: identity mapping and consultation scope. */
function messageHarness(input: { clock?: () => number; transport?: InMemoryMessageTransport } = {}): MessageHarness {
  const actor = { userId: "user-1", sessionId: "session-1" };
  const allowedTeams = new Set(["9001", "9002"]);
  const query = async (text: string, values?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) return { rows: [], rowCount: 0 };
    if (text.includes('"im_identity_mapping"')) {
      const identityKey = key("USER", String(values?.[3] ?? ""));
      return { rows: [{ accountId: deriveYunxinAccountId(identityKey), identityMarker: buildYunxinIdentityMarker(identityKey), status: "READY" }], rowCount: 1 };
    }
    // The consultation select joins the user table, so it must be matched first.
    if (text.includes('"zzsh_iam"."im_consultation" c')) {
      const userId = String(values?.[1] ?? "");
      const teamId = String(values?.[2] ?? "");
      return allowedTeams.has(teamId) && userId ? { rows: [consultationRow(userId, teamId)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes("im_order_group")) return { rows: [], rowCount: 0 };
    if (text.includes('"zzsh_auth_user"."session"')) return { rows: [{}], rowCount: 1 };
    if (text.includes('"zzsh_auth_user"."user"')) return { rows: [{ suspended: false, accountStatus: "ACTIVE" }], rowCount: 1 };
    if (text.includes('"zzsh_iam"."user_identity_state"')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as never;
  const security = {
    pool,
    apiOrigin: "http://127.0.0.1:3102",
    userOrigin: USER_ORIGIN,
    adminOrigin: "http://127.0.0.1:3101",
    userAuth: { api: { getSession: async () => ({ user: { id: actor.userId }, session: { id: actor.sessionId } }) } },
    adminAuth: { api: { getSession: async () => null } },
  } as unknown as YunxinRouteOptions["security"];
  const transport = input.transport ?? new InMemoryMessageTransport(input.clock);
  const options = userRouteOptions({
    security,
    consultation: { pool, appId: APP_ID, messageTransport: transport } as never,
  });
  return {
    transport,
    options,
    as(userId: string) { actor.userId = userId; actor.sessionId = `session-${userId}`; },
  };
}

async function postMessage(options: YunxinRouteOptions, body: unknown) {
  const response = responseCapture();
  await handleYunxinRoute({
    method: "POST",
    url: "/api/v1/im/user/messages",
    originalUrl: "/api/v1/im/user/messages",
    headers: { origin: USER_ORIGIN, cookie: "zzsh_user.session_token=opaque" },
    body,
  }, response, options);
  return response;
}

async function readMessages(options: YunxinRouteOptions, conversationId: string) {
  const response = responseCapture();
  const url = `/api/v1/im/user/messages?conversationId=${encodeURIComponent(conversationId)}&limit=50`;
  await handleYunxinRoute({ method: "GET", url, originalUrl: url, headers: { origin: USER_ORIGIN, cookie: "zzsh_user.session_token=opaque" } }, response, options);
  return response;
}

function messageOf(response: ReturnType<typeof responseCapture>) {
  return (response.body as { message: Record<string, unknown> }).message;
}

function errorOf(response: ReturnType<typeof responseCapture>) {
  return (response.body as { error: { code: string; message: string } }).error;
}

test("IM message actions validate fields while the legacy text body still works", async () => {
  const harness = messageHarness();
  const conversationId = conversationOf("user-1", "9001");
  const invalidBodies = [
    { conversationId, action: "forward", text: "hello" },
    { conversationId, action: "reply", replyTo: { messageServerId: "fixture-server-000001" } },
    { conversationId, action: "reply", text: "hello" },
    { conversationId, action: "reply", text: "x".repeat(4_001), replyTo: { messageServerId: "fixture-server-000001" } },
    { conversationId, action: "reply", text: "hello", replyTo: {} },
    { conversationId, action: "reply", text: "hello", replyTo: { messageServerId: "bad id" } },
    { conversationId, action: "reply", text: "hello", replyTo: { messageServerId: "m" }, senderId: "forged" },
    { conversationId, action: "revoke", message: { messageServerId: "m" }, extra: true },
    { conversationId, action: "delete", message: null },
    { conversationId, action: 5 },
  ];
  for (const body of invalidBodies) {
    const response = await postMessage(harness.options, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(errorOf(response).code, "INVALID_ARGUMENT");
  }
  assert.equal(harness.transport.calls.replyText + harness.transport.calls.revoke + harness.transport.calls.hideForViewer, 0);

  const legacy = await postMessage(harness.options, { conversationId, text: " 你好 " });
  assert.equal(legacy.statusCode, 200, JSON.stringify(legacy.body));
  assert.equal(messageOf(legacy).text, "你好");
  assert.equal(messageOf(legacy).senderId, userAccount("user-1"));
  assert.equal(harness.transport.calls.sendText, 1);
});

test("IM replies carry a bounded quote and stay visible to both viewers", async () => {
  const harness = messageHarness();
  const firstConversation = conversationOf("user-1", "9001");
  const secondConversation = conversationOf("user-2", "9001");
  const longText = "长".repeat(200);
  const original = await postMessage(harness.options, { conversationId: firstConversation, text: longText });
  assert.equal(original.statusCode, 200, JSON.stringify(original.body));
  const originalMessage = messageOf(original);

  harness.as("user-2");
  const reply = await postMessage(harness.options, {
    conversationId: secondConversation,
    action: "reply",
    text: "收到",
    replyTo: { messageServerId: originalMessage.messageServerId },
  });
  assert.equal(reply.statusCode, 200, JSON.stringify(reply.body));
  const replyMessage = messageOf(reply);
  assert.equal(replyMessage.text, "收到");
  assert.equal(replyMessage.senderId, userAccount("user-2"));
  const quote = replyMessage.reply as { messageId: string; senderId: string; text: string };
  assert.equal(quote.messageId, originalMessage.messageServerId);
  assert.equal(quote.senderId, userAccount("user-1"));
  assert.equal(quote.text.length, 120);

  const firstView = await readMessages(harness.options, secondConversation);
  harness.as("user-1");
  const secondView = await readMessages(harness.options, firstConversation);
  for (const view of [firstView, secondView]) {
    assert.equal(view.statusCode, 200, JSON.stringify(view.body));
    const messages = (view.body as { messages: Array<Record<string, unknown>> }).messages;
    const seen = messages.find((message) => message.messageServerId === replyMessage.messageServerId);
    assert.ok(seen, "reply is visible after reload");
    assert.deepEqual((seen as { reply: unknown }).reply, quote);
  }
});

test("in-memory transport quotes image replies as [图片]", async () => {
  const transport = new InMemoryMessageTransport();
  const conversationId = conversationOf("user-1", "9001");
  const image = await transport.sendImage({
    conversationId,
    scope: { appId: APP_ID, orderId: "order-1", teamId: "9001" },
    senderAccountId: userAccount("user-1"),
    receiverAccountId: "support-1",
    messageClientId: "image-1",
    name: "proof.png",
    mimeType: "image/png",
    size: 1,
    body: new Uint8Array([1]),
  });
  const reply = await transport.replyText({
    conversationId,
    senderAccountId: userAccount("user-2"),
    receiverAccountId: userAccount("user-1"),
    text: "图收到了",
    replyTo: { messageServerId: image.messageServerId },
  });
  assert.equal(reply.reply?.text, "[图片]");
  assert.equal(reply.reply?.messageId, image.messageServerId);
});

test("IM revoke is sender-only, conversation-scoped, and bounded to two minutes", async () => {
  let now = 1_000_000;
  const harness = messageHarness({ clock: () => now });
  const senderConversation = conversationOf("user-1", "9001");
  const peerConversation = conversationOf("user-2", "9001");
  const original = await postMessage(harness.options, { conversationId: senderConversation, text: "撤回我" });
  const originalMessage = messageOf(original);

  harness.as("user-2");
  const notSender = await postMessage(harness.options, {
    conversationId: peerConversation,
    action: "revoke",
    message: { messageServerId: originalMessage.messageServerId },
  });
  assert.equal(notSender.statusCode, 403);
  assert.equal(errorOf(notSender).code, "FORBIDDEN");

  const crossConversation = await postMessage(harness.options, {
    conversationId: conversationOf("user-2", "9002"),
    action: "revoke",
    message: { messageServerId: originalMessage.messageServerId },
  });
  assert.equal(crossConversation.statusCode, 404);
  assert.equal(errorOf(crossConversation).code, "NOT_FOUND");

  harness.as("user-1");
  const revoked = await postMessage(harness.options, {
    conversationId: senderConversation,
    action: "revoke",
    message: { messageServerId: originalMessage.messageServerId },
  });
  assert.equal(revoked.statusCode, 200, JSON.stringify(revoked.body));
  assert.equal(messageOf(revoked).revoked, true);
  assert.equal(messageOf(revoked).text, "");
  assert.equal(messageOf(revoked).attachment, undefined);

  const second = await postMessage(harness.options, { conversationId: senderConversation, text: "第二条" });
  const secondMessage = messageOf(second);
  now += 121_000;
  const tooLate = await postMessage(harness.options, {
    conversationId: senderConversation,
    action: "revoke",
    message: { messageServerId: secondMessage.messageServerId },
  });
  assert.equal(tooLate.statusCode, 409);
  assert.equal(errorOf(tooLate).code, "CONFLICT");

  // The first revoke already cleared content for both viewers.
  harness.as("user-2");
  const peerView = await readMessages(harness.options, peerConversation);
  const peerMessage = (peerView.body as { messages: Array<Record<string, unknown>> }).messages
    .find((message) => message.messageServerId === originalMessage.messageServerId);
  assert.ok(peerMessage);
  assert.equal(peerMessage.revoked, true);
  assert.equal(peerMessage.text, "");
  assert.equal(peerMessage.attachment, undefined);
});

test("IM delete hides a message only for the requesting viewer", async () => {
  const harness = messageHarness();
  const senderConversation = conversationOf("user-1", "9001");
  const peerConversation = conversationOf("user-2", "9001");
  const original = await postMessage(harness.options, { conversationId: senderConversation, text: "仅本地删除" });
  const originalMessage = messageOf(original);

  harness.as("user-2");
  const deleted = await postMessage(harness.options, {
    conversationId: peerConversation,
    action: "delete",
    message: { messageClientId: originalMessage.messageClientId },
  });
  assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { deleted: true });

  const hiddenFromPeer = await readMessages(harness.options, peerConversation);
  assert.ok(!(hiddenFromPeer.body as { messages: Array<Record<string, unknown>> }).messages
    .some((message) => message.messageServerId === originalMessage.messageServerId));

  harness.as("user-1");
  const stillVisible = await readMessages(harness.options, senderConversation);
  assert.ok((stillVisible.body as { messages: Array<Record<string, unknown>> }).messages
    .some((message) => message.messageServerId === originalMessage.messageServerId));

  const crossConversation = await postMessage(harness.options, {
    conversationId: conversationOf("user-1", "9002"),
    action: "delete",
    message: { messageServerId: originalMessage.messageServerId },
  });
  assert.equal(crossConversation.statusCode, 404);
  assert.equal(errorOf(crossConversation).code, "NOT_FOUND");
});
