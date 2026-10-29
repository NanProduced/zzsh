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
    send(value: unknown) { result.body = value; result.headersSent = true; },
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
    threadId: `im_thread_${teamId}`,
    roundSeq: 1,
    threadState: "ACTIVE",
    threadScopeId: teamId,
    threadScopeState: "READY",
    threadPeerAccountId: "support-1",
    version: "1",
    lastMessageAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    userName: "User",
    userUsername: "user",
    adminName: null,
  };
}

function threadRow(userId: string, teamId: string) {
  return {
    id: `im_thread_${teamId}`,
    appId: APP_ID,
    userId,
    kind: "SERVICE",
    state: "ACTIVE",
    userAccountId: userAccount(userId),
    peerAccountId: "support-1",
    messageScopeId: teamId,
    messageScopeState: "READY",
    lastRoundSeq: "1",
    version: "1",
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
    // Support threads own the Team; user access is thread-scoped.
    if (text.includes('"zzsh_iam"."im_support_thread"')) {
      const userId = String(values?.[1] ?? "");
      const teamId = String(values?.[2] ?? "");
      const viewer = String(values?.[3] ?? "");
      return allowedTeams.has(teamId) && userId && viewer === userAccount(userId)
        ? { rows: [threadRow(userId, teamId)], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM "zzsh_iam"."im_consultation"') && text.includes('"thread_id" = $2')) {
      const threadId = String(values?.[1] ?? "");
      return { rows: [{ id: `im_consult_${threadId}`, state: "ACTIVE" }], rowCount: 1 };
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

type MediaHarness = {
  transport: InMemoryMessageTransport;
  options: YunxinRouteOptions;
};

/** Offline order-team access: one READY team whose renter is user-1. */
function orderTeamMessageHarness(clock?: () => number): MediaHarness {
  const actor = { userId: "user-1", sessionId: "session-1" };
  const teamId = "9001";
  const orderId = "order-1";
  const accountId = userAccount(actor.userId);
  const query = async (text: string, values?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) return { rows: [], rowCount: 0 };
    if (text.includes("FROM zzsh_order.rental_order o")) {
      return {
        rows: [{
          order_status: "PAID", cancel_reason: null, cancelled_at: null, title: "测试账号", account_id: "account-1",
          quote_snapshot: null, game_name: "测试游戏", term_seconds: null, opening_id: null, opening_status: null,
          opening_confirmed_at: null, intake_open: false, settlement_current: false, settlement_posted_at: null,
          renter_user_id: actor.userId, owner_user_id: "user-owner", game_id: "game-1", display_no: "ZZ1",
          escalation_responsible_admin_id: null, escalation_first_response_at: null, escalation_remind_due_at: null,
          escalation_add_round: 0, escalation_state: "NOT_STARTED",
          app_id: APP_ID, team_id: teamId, team_name: "订单群", team_state: "READY", provision_state: "READY",
        }],
        rowCount: 1,
      };
    }
    if (text.includes("FROM zzsh_order.im_order_member")) {
      return {
        rows: [{
          party: "RENTER", state: "JOINED", platform_subject_id: actor.userId, identity_kind: "USER", realm: "user",
          account_id: accountId, status: "READY", identity_marker: buildYunxinIdentityMarker(key("USER", actor.userId)),
          name: "用户", avatar: null,
        }],
        rowCount: 1,
      };
    }
    if (text.includes("FROM zzsh_order.im_order_group")) {
      const teamIndex = text.includes("team_id=$3") ? 2 : 1;
      if (String(values?.[teamIndex] ?? "") !== teamId) return { rows: [], rowCount: 0 };
      return { rows: [{ order_id: orderId, team_id: teamId, app_id: APP_ID }], rowCount: 1 };
    }
    if (text.includes("zzsh_order.rental_opening_ack") || text.includes("zzsh_supply.billable_item")) return { rows: [], rowCount: 0 };
    if (text.includes('"zzsh_iam"."im_identity_mapping"')) {
      return { rows: [{ accountId, identityMarker: buildYunxinIdentityMarker(key("USER", actor.userId)), status: "READY" }], rowCount: 1 };
    }
    if (text.includes('"zzsh_auth_user"."user"')) return { rows: [{ suspended: false, accountStatus: "ACTIVE" }], rowCount: 1 };
    if (text.includes('"zzsh_auth_user"."session"')) return { rows: [{}], rowCount: 1 };
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
  const transport = new InMemoryMessageTransport(clock);
  return {
    transport,
    options: userRouteOptions({ security, consultation: { pool, appId: APP_ID, messageTransport: transport } as never }),
  };
}

function mediaBody(kind: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  const names: Record<string, [string, string]> = {
    video: ["clip.mp4", "video/mp4"],
    file: ["proof.pdf", "application/pdf"],
    audio: ["voice.mp3", "audio/mpeg"],
  };
  const [name, mimeType] = names[kind]!;
  return {
    conversationId: conversationOf("user-1", "9001"),
    media: {
      kind,
      messageClientId: `${kind}-1`,
      name,
      mimeType,
      size: bytes.length,
      data: bytes.toString("base64"),
      ...(kind === "video" ? { width: 640, height: 360, durationMs: 1_500 } : {}),
      ...(kind === "audio" ? { durationMs: 900 } : {}),
      ...overrides,
    },
  };
}

test("in-memory media transport is order-scoped and idempotent", async () => {
  const transport = new InMemoryMessageTransport();
  const conversationId = conversationOf("user-1", "9001");
  const scope = { appId: APP_ID, orderId: "order-1", teamId: "9001" };
  const input = {
    conversationId,
    scope,
    senderAccountId: userAccount("user-1"),
    receiverAccountId: "support-1",
    messageClientId: "video-1",
    kind: "video" as const,
    name: "clip.mp4",
    mimeType: "video/mp4",
    size: 3,
    body: new Uint8Array([1, 2, 3]),
    width: 640,
    height: 360,
    durationMs: 1_500,
  };
  const first = await transport.sendMedia(input);
  assert.equal(first.messageType, 3);
  assert.ok(first.media);
  assert.equal(first.media!.kind, "video");
  assert.equal(first.media!.url, undefined, "transport never stores a URL");
  const retry = await transport.sendMedia(input);
  assert.equal(retry.messageServerId, first.messageServerId);
  assert.equal(transport.calls.sendMedia, 2);
  assert.deepEqual(await transport.getMediaScope(first.media!.mediaId), { mediaId: first.media!.mediaId, scope });
  assert.equal(await transport.readMedia({ mediaId: first.media!.mediaId, scope: { ...scope, orderId: "order-2" }, viewerAccountId: "user-1" }), null);
  const stored = await transport.readMedia({ mediaId: first.media!.mediaId, scope, viewerAccountId: "user-1" });
  assert.deepEqual([...stored!.body], [1, 2, 3]);
  await assert.rejects(
    () => transport.sendMedia({ ...input, messageClientId: "file-1", kind: "file", name: "proof.pdf", mimeType: "video/mp4" }),
    /Media MIME type is invalid/,
  );
  await assert.rejects(
    () => transport.sendMedia({ ...input, messageClientId: "video-2", size: 100 * 1024 * 1024 + 1, body: new Uint8Array(1) }),
    /Media size is outside the allowed range/,
  );
});

test("IM media body accepts safe metadata and rejects malformed or oversized payloads", async () => {
  const bytes = Buffer.from([1, 2, 3]);
  for (const kind of ["video", "file", "audio"]) {
    const parsed = await parseMessageBody(mediaBody(kind, bytes));
    assert.equal(parsed.kind, "media", kind);
    if (parsed.kind !== "media") throw new Error("media parser returned another kind");
    assert.equal(parsed.media.kind, kind);
    assert.equal(parsed.media.size, 3);
    assert.deepEqual([...parsed.media.body], [1, 2, 3]);
  }
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["unknown kind", mediaBody("video", bytes, { kind: "image" })],
    ["unknown top-level field", { ...mediaBody("video", bytes), url: "/api/im/media/x" }],
    ["unknown media field", mediaBody("video", bytes, { url: "/api/im/media/x" })],
    ["disallowed MIME", mediaBody("file", bytes, { mimeType: "application/x-msdownload" })],
    ["MIME mismatch", mediaBody("video", bytes, { mimeType: "audio/mpeg" })],
    ["missing bytes", mediaBody("video", bytes, { data: "" })],
    ["short bytes", mediaBody("video", bytes, { data: "AA==" })],
    ["oversized video", mediaBody("video", bytes, { size: 100 * 1024 * 1024 + 1 })],
    ["oversized audio", mediaBody("audio", bytes, { size: 20 * 1024 * 1024 + 1 })],
    ["file with duration", mediaBody("file", bytes, { durationMs: 1_000 })],
    ["audio with dimensions", mediaBody("audio", bytes, { width: 10, height: 10 })],
    ["half dimensions", mediaBody("video", bytes, { width: 640, height: undefined })],
    ["control name", mediaBody("video", bytes, { name: "clip\u0000.mp4" })],
    ["both text and media", { ...mediaBody("video", bytes), text: "hello" }],
  ];
  for (const [label, body] of invalid) {
    await assert.rejects(() => parseMessageBody(body), /Media|Message body/, label);
  }
});

async function postUserMedia(options: YunxinRouteOptions, body: unknown) {
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

async function readUserMedia(options: YunxinRouteOptions, mediaId: string) {
  const response = responseCapture();
  const url = `/api/v1/im/user/media/${encodeURIComponent(mediaId)}`;
  await handleYunxinRoute({ method: "GET", url, originalUrl: url, headers: { origin: USER_ORIGIN, cookie: "zzsh_user.session_token=opaque" } }, response, options);
  return response;
}

test("user media routes reuse order-team authorization and authorize downloads", async () => {
  const harness = orderTeamMessageHarness();
  const videoBytes = Buffer.from([1, 2, 3, 4]);
  const sent = await postUserMedia(harness.options, mediaBody("video", videoBytes));
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  const message = messageOf(sent);
  assert.equal(message.messageType, 3);
  const media = message.media as { mediaId: string; kind: string; size: number; url: string; width: number; height: number; durationMs: number };
  assert.equal(media.kind, "video");
  assert.equal(media.size, videoBytes.length);
  assert.equal(media.url, `/api/im/media/${media.mediaId}`);
  assert.deepEqual({ width: media.width, height: media.height, durationMs: media.durationMs }, { width: 640, height: 360, durationMs: 1_500 });

  const retried = await postUserMedia(harness.options, mediaBody("video", videoBytes));
  assert.equal(retried.statusCode, 200);
  assert.equal(messageOf(retried).messageServerId, message.messageServerId);
  assert.equal(harness.transport.calls.sendMedia, 2);

  const history = await readMessages(harness.options, conversationOf("user-1", "9001"));
  const historyMessage = (history.body as { messages: Array<{ messageServerId: string; media?: { url?: string } }> }).messages
    .find((row) => row.messageServerId === message.messageServerId);
  assert.equal(historyMessage?.media?.url, media.url);

  const download = await readUserMedia(harness.options, media.mediaId);
  assert.equal(download.statusCode, 200, JSON.stringify(download.body));
  assert.equal(download.headers.get("content-type"), "video/mp4");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...(download.body as Uint8Array)], [...videoBytes]);

  const file = await postUserMedia(harness.options, mediaBody("file", Buffer.from("%PDF-1.4")));
  assert.equal(file.statusCode, 200, JSON.stringify(file.body));
  const fileMedia = messageOf(file).media as { mediaId: string };
  const fileDownload = await readUserMedia(harness.options, fileMedia.mediaId);
  assert.equal(fileDownload.statusCode, 200);
  assert.equal(fileDownload.headers.get("content-disposition"), "attachment");

  assert.equal((await readUserMedia(harness.options, "fixture-media-unknown")).statusCode, 404);
});

test("user media routes reject unauthenticated, out-of-scope and malformed sends", async () => {
  const harness = orderTeamMessageHarness();
  const bytes = Buffer.from([1, 2, 3]);
  const valid = mediaBody("video", bytes);

  const denied = await postUserMedia({
    ...harness.options,
    security: {
      ...harness.options.security,
      userAuth: { api: { getSession: async () => null } },
    } as never,
  }, valid);
  assert.equal(denied.statusCode, 401);
  assert.equal(harness.transport.calls.sendMedia, 0);

  const crossTeam = await postUserMedia(harness.options, { ...valid, conversationId: conversationOf("user-1", "9999") });
  assert.equal(crossTeam.statusCode, 403);
  assert.equal(errorOf(crossTeam).code, "FORBIDDEN");
  assert.equal(harness.transport.calls.sendMedia, 0);

  const oversized = await postUserMedia(harness.options, mediaBody("video", bytes, { size: 100 * 1024 * 1024 + 1 }));
  assert.equal(oversized.statusCode, 400);
  const badMime = await postUserMedia(harness.options, mediaBody("file", bytes, { mimeType: "application/x-msdownload" }));
  assert.equal(badMime.statusCode, 400);
  const badMetadata = await postUserMedia(harness.options, mediaBody("file", bytes, { durationMs: 1_000 }));
  assert.equal(badMetadata.statusCode, 400);
  assert.equal(harness.transport.calls.sendMedia, 0);
});

test("admin media send fails closed without im.support.read", async () => {
  const transport = new InMemoryMessageTransport();
  const query = async (text: string) => {
    if (text.includes('"zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as never;
  const options = userRouteOptions({
    security: {
      ...userRouteOptions().security,
      pool,
      adminAuth: { api: { getSession: async () => ({ user: { id: "admin-1", twoFactorEnabled: true }, session: { id: "admin-session", locked: false } }) } },
    } as never,
    consultation: { pool, appId: APP_ID, messageTransport: transport } as never,
  });
  const response = responseCapture();
  await handleYunxinRoute({
    method: "POST",
    url: "/api/v1/im/admin/messages",
    originalUrl: "/api/v1/im/admin/messages",
    headers: { origin: "http://127.0.0.1:3101", cookie: "zzsh_admin.session_token=opaque" },
    body: mediaBody("video", Buffer.from([1, 2, 3])),
  }, response, options);
  assert.equal(response.statusCode, 403);
  assert.equal(errorOf(response).code, "FORBIDDEN");
  assert.equal(transport.calls.sendMedia, 0);
});
