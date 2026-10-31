import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";

import { handleSystemConfiguration } from "../src/system/system-configuration-routes";
import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import { createOssMediaStorage, type OssMediaStorageOptions } from "../src/supply/media-oss";
import { createLocalMediaStorage, createUnavailableMediaStorage, type MediaStorage } from "../src/supply/media";
import type { SupplyRuntimeOptions, SupplyResponse } from "../src/supply/supply-routes";
import type { SupplyNodeRequest } from "../src/supply/supply-util";

const ORIGIN = "http://127.0.0.1:3101";
const API = "http://127.0.0.1:3102";
const BYTES = Buffer.from("offline public derivative");
const KEY = createHash("sha256").update(BYTES).digest("hex");
const TARGET: OssMediaStorageOptions = { bucket: "offline-bucket", region: "oss-cn-shenzhen", endpoint: "https://oss-cn-shenzhen.aliyuncs.com", objectPrefix: "staging/" };

class PoolFixture {
  isBoss = true;
  status = "ACTIVE";
  locked = false;
  sessionExists = true;
  sample = true;
  activeClients = 0;
  queries: string[] = [];
  fail = false;
  async query(text: string) {
    this.queries.push(text);
    if (this.fail) throw new Error("raw-pg-password-must-not-escape");
    const sql = text.replace(/\s+/g, " ").trim();
    let rows: unknown[];
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) rows = [];
    else if (sql.includes('FROM "zzsh_auth_admin"."session"')) rows = this.sessionExists ? [{ locked: this.locked, twoFactorEnabled: true, suspended: false }] : [];
    else if (sql.includes('FROM "zzsh_iam"."admin_security"')) rows = [{ status: this.status, isBoss: this.isBoss, passwordChangeRequired: false }];
    else if (sql.startsWith("WITH role_permissions")) rows = [{ permissionCode: "content.platform.read" }];
    else if (sql.includes('FROM "zzsh_supply"."media_asset"')) rows = this.sample ? [{ publicStorageKey: KEY }] : [];
    else throw new Error("Unexpected fixture query: " + sql);
    return { rows, rowCount: rows.length };
  }
  async connect() {
    this.activeClients++;
    return { query: this.query.bind(this), release: () => this.activeClients-- };
  }
}

class ResponseFixture {
  code = 0;
  body: any;
  headers: Record<string, string> = {};
  status(code: number) { this.code = code; return this; }
  setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; }
  json(body: unknown) { this.body = body; return this; }
}

function setup() {
  const pool = new PoolFixture();
  const counts = { reads: 0, writes: 0, heads: 0 };
  const storage = createOssMediaStorage(TARGET, { accessKeyId: "private-ak", accessKeySecret: "private-secret", stsToken: "private-sts" }, {
    createClient: () => ({
      head: async () => { counts.heads++; },
      put: async () => { counts.writes++; },
      get: async () => { counts.reads++; assert.equal(pool.activeClients, 0, "network read must run outside the DB transaction"); return { content: BYTES }; },
    }),
  });
  const options = {
    pool: pool as unknown as Pool,
    apiOrigin: API, adminOrigin: ORIGIN, userOrigin: "http://127.0.0.1:3100", mediaStorage: storage,
    adminAuth: { api: { getSession: async () => ({ user: { id: "boss", twoFactorEnabled: true }, session: { id: "session", locked: false } }) } },
  } as unknown as SupplyRuntimeOptions;
  const request = (path = "/storage", method = "GET", headers: Record<string, string> = {}) => ({ method, originalUrl: "/api/v1/admin/system" + path, headers: { origin: ORIGIN, ...headers } }) as SupplyNodeRequest;
  const run = async (path = "/storage", method = "GET", headers: Record<string, string> = {}) => {
    const response = new ResponseFixture();
    await handleSystemConfiguration(request(path, method, headers), response as SupplyResponse, options);
    return response;
  };
  return { pool, counts, storage, options, request, run };
}

test("system configuration returns only allowlisted instance metadata, no credentials or writes", async () => {
  const f = setup(), result = await f.run();
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.target, TARGET);
  assert.equal(result.body.configurationSource, "DEPLOYMENT_ENVIRONMENT");
  assert.equal(result.body.credentialMode, "STS");
  assert.equal(result.body.automaticCredentialRefresh, false);
  assert.equal(result.body.check.state, "NOT_RUN");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(f.counts, { reads: 0, writes: 0, heads: 0 });
  assert.doesNotMatch(JSON.stringify(result.body), /private-ak|private-secret|private-sts|accessKey|stsToken/);
});

test("OSS configuration and operational prefix remain bound after caller options mutate", async () => {
  const options = { ...TARGET }, seen: string[] = [];
  const storage = createOssMediaStorage(options, { accessKeyId: "id", accessKeySecret: "secret" }, {
    createClient: target => { assert.ok(Object.isFrozen(target)); return { head: async key => { seen.push(key); }, put: async () => {}, get: async key => { seen.push(key); return { content: BYTES }; } }; },
  });
  options.bucket = "different"; options.objectPrefix = "changed/";
  await storage.read(KEY); await storage.write(BYTES, KEY, "image/png");
  assert.deepEqual(seen, ["staging/" + KEY.slice(0, 2) + "/" + KEY, "staging/" + KEY.slice(0, 2) + "/" + KEY]);
  assert.deepEqual(storage.configuration?.target, TARGET);
  assert.equal(storage.configuration?.credentialMode, "ACCESS_KEY");
  assert.ok(Object.isFrozen(storage.configuration));
});

test("local and unavailable configuration never disclose a filesystem path", async () => {
  for (const storage of [createLocalMediaStorage("C:/private/local-root"), createUnavailableMediaStorage()]) {
    const f = setup(); f.options.mediaStorage = storage;
    const result = await f.run();
    assert.equal(result.code, 200); assert.equal(result.body.backend, storage.kind);
    assert.equal(result.body.configured, storage.available); assert.equal(result.body.target, null);
    assert.equal(result.body.credentialMode, "NOT_APPLICABLE");
    assert.doesNotMatch(JSON.stringify(result.body), /private|local-root/);
  }
});

test("an authenticated non-Boss content operator cannot inspect system settings", async () => {
  const f = setup(); f.pool.isBoss = false;
  const result = await f.run("/storage/check");
  assert.equal(result.code, 403); assert.equal(result.body.target, undefined); assert.equal(f.counts.reads, 0);
  assert.ok(!f.pool.queries.some(q => q.includes("media_asset")));
});

test("missing authentication is denied before any configuration or database access", async () => {
  const f = setup(); f.options.adminAuth.api.getSession = async () => null;
  const result = await f.run();
  assert.equal(result.code, 401); assert.equal(result.body.target, undefined);
  assert.equal(f.pool.queries.length, 0); assert.equal(f.counts.reads, 0);
});

test("transactional session recheck denies frozen, locked and expired sessions before storage I/O", async () => {
  for (const [change, expected] of [
    [(f: ReturnType<typeof setup>) => { f.pool.status = "FROZEN"; }, 401],
    [(f: ReturnType<typeof setup>) => { f.pool.locked = true; }, 423],
    [(f: ReturnType<typeof setup>) => { f.pool.sessionExists = false; }, 401],
  ] as const) {
    const f = setup(); change(f);
    assert.equal((await f.run("/storage/check")).code, expected); assert.equal(f.counts.reads, 0);
  }
});

test("unsupported method, path, query and untrusted origin are denied before auth/DB", async () => {
  for (const [path, method, headers, expected] of [
    ["/storage", "PUT", {}, 404], ["/storage/other", "GET", {}, 404],
    ["/storage?bucket=other", "GET", {}, 400],
    ["/storage", "GET", { origin: "http://127.0.0.1:3100" }, 403],
    ["/storage", "GET", { "sec-fetch-site": "cross-site" }, 403],
  ] as const) {
    const f = setup(), result = await f.run(path, method, headers);
    assert.equal(result.code, expected); assert.equal(f.pool.queries.length, 0);
    assert.equal(result.headers["cache-control"], "no-store");
  }
});

test("sample check verifies the derivative hash and remains read-only", async () => {
  const f = setup(), result = await f.run("/storage/check");
  assert.equal(result.code, 200);
  assert.deepEqual({ ...result.body.check, checkedAt: null }, { state: "PASS", checkedAt: null, scope: "PUBLIC_CONTENT_DERIVATIVE", integrity: "PASS" });
  assert.ok(result.body.check.checkedAt); assert.deepEqual(f.counts, { reads: 1, writes: 0, heads: 0 });
  const query = f.pool.queries.find(q => q.includes("media_asset"))!;
  for (const gate of ["CONTENT_MEDIA", "PLATFORM_CONTENT", "APPROVED", "PUBLIC_DISPLAY", "LIMIT 1"]) assert.ok(query.includes(gate));
  assert.ok(f.pool.queries.every(q => !/\b(INSERT|UPDATE|DELETE|FOR UPDATE|FOR SHARE)\b/.test(q)));
});

test("missing sample, corrupt bytes and remote failure remain distinct, with no raw errors", async () => {
  const missing = setup(); missing.pool.sample = false;
  assert.equal((await missing.run("/storage/check")).body.check.state, "NO_PUBLIC_SAMPLE"); assert.equal(missing.counts.reads, 0);
  const corrupt = setup(); corrupt.options.mediaStorage = { ...corrupt.storage, read: async () => Buffer.from("bad") };
  const bad = await corrupt.run("/storage/check");
  assert.equal(bad.body.check.state, "FAILED"); assert.equal(bad.body.check.integrity, "FAILED");
  const failing = setup(); failing.options.mediaStorage = { ...failing.storage, read: async () => { throw new Error("raw-oss-secret-private-ak"); } };
  const failed = await failing.run("/storage/check");
  assert.equal(failed.body.check.state, "FAILED"); assert.equal(failed.body.check.integrity, "NOT_RUN");
  assert.doesNotMatch(JSON.stringify(failed.body), /raw-oss|private-ak/);
});

test("access revoked while OSS read is in flight denies the response", async () => {
  const f = setup();
  f.options.mediaStorage = { ...f.storage, read: async () => { f.pool.isBoss = false; return BYTES; } };
  const result = await f.run("/storage/check");
  assert.equal(result.code, 403); assert.equal(result.body.target, undefined);
});

test("raw PG errors are mapped to a safe error without leaking configuration", async () => {
  const f = setup(); f.pool.fail = true;
  const result = await f.run(); assert.equal(result.code, 500);
  assert.doesNotMatch(JSON.stringify(result.body), /password|private|bucket/);
});

test("real Admin BFF dispatch reaches the same guarded GET route and rejects writes", async () => {
  const f = setup();
  const options = { apiOrigin: API, adminOrigin: ORIGIN, adminSecurityOptions: f.options, supply: f.options } as unknown as AdminBffOptions;
  for (const [method, status] of [["GET", 200], ["POST", 404]] as const) {
    const request = f.request("/storage", method); request.originalUrl = "/api/bff/admin/system/storage";
    const response = new ResponseFixture();
    await handleAdminBff(request, response as never, options);
    assert.equal(response.code, status);
  }
});
