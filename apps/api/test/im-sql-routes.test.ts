import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";

import { mountAuthHandlers } from "../src/auth/auth-runtime";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey, type ImIdentityMapping } from "../src/im/identity-lifecycle";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { handleYunxinRoute, parseMessageBody, type YunxinRouteOptions } from "../src/im/yunxin-routes";
import { MAX_MEDIA_BYTES } from "../src/supply/media";

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
      pool: {} as never,
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
