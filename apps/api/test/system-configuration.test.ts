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
import { resolveSmsTemplates } from "../src/auth/sms-templates";

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
  defaultAccountSample: string | null = "asset_fixture";
  accountSample: Record<string, unknown> | null = null;
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
    else if (sql.startsWith("SELECT id FROM zzsh_supply.media_asset")) rows = this.defaultAccountSample ? [{ id: this.defaultAccountSample }] : [];
    else if (sql.includes('FROM "zzsh_supply"."media_asset"') && sql.includes('WHERE "id" = $1')) rows = this.accountSample ? [this.accountSample] : [];
    else if (sql.includes('FROM "zzsh_supply"."media_asset"')) rows = this.sample ? [{ publicStorageKey: KEY }] : [];
    else if (sql.includes("to_regclass('zzsh_order.settlement_refund_policy')")) rows = [{ available: true }];
    else if (sql.includes("FROM zzsh_order.settlement_refund_policy")) rows = [{ normalDays: 0, earlyDays: 7, revision: "1" }];
    else if (sql.includes("to_regclass('zzsh_order.opening_auto_confirm_policy')")) rows = [{ available: true }];
    else if (sql.includes("FROM zzsh_order.opening_auto_confirm_policy")) rows = [{ waitMinutes: 40, revision: "1" }];
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

test("watermark preview only signs a valid display sample for a Boss and rechecks access before delivery", async () => {
  const f = setup();
  f.pool.accountSample = { id: "asset_fixture", accountId: "account_fixture", ownershipKind: "USER_SUPPLY", purpose: "ACCOUNT_DISPLAY", publicStorageKey: KEY,
    technicalState: "READY", accessClass: "PUBLIC_DISPLAY", reviewState: "APPROVED", width: 1280, height: 720 };
  let previewCount = 0, revoke = false, revokeSample = false;
  f.options.mediaStorage = { ...f.storage, accountMedia: {
    createUpload() { throw new Error("preview does not create a grant"); },
    async readUpload() { throw new Error("preview does not read an upload"); },
    async signOriginal() { throw new Error("preview does not sign originals"); },
    async generateVariants() { throw new Error("preview does not persist variants"); },
    async previewVariants(key, source, watermark) {
      previewCount++;
      assert.equal(f.pool.activeClients, 0);
      assert.equal(key, KEY); assert.equal(source.width, 1280); assert.equal(watermark.enabled, false);
      if (revoke) f.pool.isBoss = false;
      if (revokeSample && f.pool.accountSample) f.pool.accountSample.accessClass = "PRIVATE_REVIEW";
      return [{ maxEdge: 640, url: "https://images.example.com/preview?fixture=640" }, { maxEdge: 1920, url: "https://images.example.com/preview?fixture=1920" }];
    },
  } };
  const request = { ...f.request("/account-image-watermark/preview", "POST"), body: { assetId: "asset_fixture" as string | null, enabled: false, logoAssetId: null, position: "se", sizePercent: 12, opacityPercent: 55, marginPercent: 2 } };
  const invoke = async () => {
    const response = new ResponseFixture();
    await handleSystemConfiguration(request, response as SupplyResponse, f.options);
    return response;
  };
  f.pool.isBoss = false;
  assert.equal((await invoke()).code, 403);
  assert.equal(previewCount, 0);
  f.pool.isBoss = true;
  f.pool.accountSample.purpose = "ACCOUNT_EVIDENCE";
  assert.equal((await invoke()).code, 404);
  assert.equal(previewCount, 0);
  f.pool.accountSample.purpose = "ACCOUNT_DISPLAY";
  const allowed = await invoke();
  assert.equal(allowed.code, 200);
  assert.equal(allowed.headers["cache-control"], "no-store");
  assert.deepEqual(allowed.body.images.map((image: { maxEdge: number }) => image.maxEdge), [640, 1920]);
  request.body.assetId = null;
  f.pool.defaultAccountSample = null;
  const missingSample = await invoke();
  assert.equal(missingSample.code, 200);
  assert.deepEqual(missingSample.body, { images: [], state: "NO_SAMPLE" }, "no default sample must not invent an image");
  f.pool.defaultAccountSample = "asset_fixture";
  assert.equal((await invoke()).code, 200, "an eligible account image can be selected automatically");
  request.body.assetId = "asset_fixture";
  f.pool.accountSample = { ...f.pool.accountSample, ownershipKind: "PLATFORM_CONTENT", accountId: null, purpose: "CONTENT_MEDIA" };
  assert.equal((await invoke()).code, 200, "approved public platform media can be a custom sample");
  f.pool.accountSample.accessClass = "PRIVATE_REVIEW";
  assert.equal((await invoke()).code, 404, "private content must not be used as a preview sample");
  f.pool.accountSample.accessClass = "PUBLIC_DISPLAY";
  revokeSample = true;
  const revokedSample = await invoke();
  assert.equal(revokedSample.code, 404, "a sample revoked during preview must not be returned");
  assert.doesNotMatch(JSON.stringify(revokedSample.body), /images\.example/);
  revokeSample = false;
  f.pool.accountSample.accessClass = "PUBLIC_DISPLAY";
  revoke = true;
  const rejected = await invoke();
  assert.equal(rejected.code, 403);
  assert.doesNotMatch(JSON.stringify(rejected.body), /images\.example/);
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

test("SMS configuration is Boss-only, distinguishes shared templates and never exposes credentials",async()=>{
  const f=setup();f.options.userSmsConfiguration=resolveSmsTemplates({signName:"合成签名",templateCode:"SMS_SHARED",templates:{LOGIN:"SMS_LOGIN",OWNER_ORDER_PAID:"SMS_OWNER"}});
  const result=await f.run("/sms");assert.equal(result.code,200);assert.equal(result.body.provider,"aliyun");
  assert.equal(result.body.providerVerification,"NOT_RUN");assert.equal(result.body.scenes.length,6);
  assert.deepEqual(result.body.additionalScenes.map((row:{scene:string})=>row.scene),["CHANGE_MOBILE","FORGOT_PASSWORD"]);
  assert.ok(result.body.additionalScenes.every((row:{source:string;trigger:string})=>row.source==="SHARED"&&row.trigger==="CONNECTED"));
  assert.equal(result.body.scenes.find((row:{scene:string})=>row.scene==="LOGIN").source,"SCENE");
  assert.equal(result.body.scenes.find((row:{scene:string})=>row.scene==="REGISTER").source,"SHARED");
  assert.equal(result.body.scenes.find((row:{scene:string})=>row.scene==="RENTAL_EXPIRY").source,"NOT_CONFIGURED");
  assert.doesNotMatch(JSON.stringify(result.body),/private-ak|private-secret|accessKey|AppCode/);
  f.pool.isBoss=false;assert.equal((await f.run("/sms")).code,403);
  f.pool.isBoss=true;delete f.options.userSmsConfiguration;const disabled=await f.run("/sms");
  assert.equal(disabled.body.provider,"disabled");assert.ok(disabled.body.scenes.every((row:{source:string})=>row.source==="NOT_CONFIGURED"));
  assert.ok(disabled.body.additionalScenes.every((row:{source:string})=>row.source==="NOT_CONFIGURED"));
});

test("settlement refund policy is Boss-only and rejects cross-origin or invalid changes", async () => {
  const f = setup();
  const read = await f.run("/settlement-refund-policy");
  assert.equal(read.code, 200);
  assert.deepEqual(read.body, { normalDays: 0, earlyDays: 7, revision: "1", available: true });
  f.pool.isBoss = false;
  assert.equal((await f.run("/settlement-refund-policy")).code, 403);
  f.pool.isBoss = true;
  const denied = f.request("/settlement-refund-policy", "PUT", { origin: "https://attacker.invalid" });
  denied.body = { normalDays: 0, earlyDays: 7, expectedRevision: "1" };
  const deniedResponse = new ResponseFixture();
  await handleSystemConfiguration(denied, deniedResponse as SupplyResponse, f.options);
  assert.equal(deniedResponse.code, 403);
  const invalidRequest = f.request("/settlement-refund-policy", "PUT");
  invalidRequest.body = { normalDays: -1, earlyDays: 7, expectedRevision: "1" };
  const invalidResponse = new ResponseFixture();
  await handleSystemConfiguration(invalidRequest, invalidResponse as SupplyResponse, f.options);
  assert.equal(invalidResponse.code, 400);
});

test("opening auto-confirm policy is Boss-only and rejects 0 or out-of-range minutes", async () => {
  const f = setup();
  const read = await f.run("/opening-auto-confirm");
  assert.equal(read.code, 200);
  assert.deepEqual(read.body, { waitMinutes: 40, revision: "1", available: true });
  f.pool.isBoss = false;
  assert.equal((await f.run("/opening-auto-confirm")).code, 403);
  f.pool.isBoss = true;
  const invalid = f.request("/opening-auto-confirm", "PUT");
  invalid.body = { waitMinutes: 0, expectedRevision: "1" };
  const response = new ResponseFixture();
  await handleSystemConfiguration(invalid, response as SupplyResponse, f.options);
  assert.equal(response.code, 400);
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

test("Admin BFF exposes SMS configuration only through the guarded read route",async()=>{
  const f=setup();f.options.userSmsConfiguration=resolveSmsTemplates({signName:"合成签名",templateCode:"SMS_SHARED"});
  const options={apiOrigin:API,adminOrigin:ORIGIN,adminSecurityOptions:f.options,supply:f.options} as unknown as AdminBffOptions;
  for(const [method,status] of [["GET",200],["POST",404]] as const){
    const request=f.request("/sms",method);request.originalUrl="/api/bff/admin/system/sms";
    const response=new ResponseFixture();await handleAdminBff(request,response as never,options);assert.equal(response.code,status);
  }
  f.pool.isBoss=false;const request=f.request("/sms");request.originalUrl="/api/bff/admin/system/sms";
  const response=new ResponseFixture();await handleAdminBff(request,response as never,options);assert.equal(response.code,403);
});

test("Admin BFF dispatches opening auto-confirm without bypassing validation", async () => {
  const f = setup();
  const options = { apiOrigin: API, adminOrigin: ORIGIN, adminSecurityOptions: f.options, supply: f.options } as unknown as AdminBffOptions;
  const read = f.request("/opening-auto-confirm"); read.originalUrl = "/api/bff/admin/system/opening-auto-confirm";
  const response = new ResponseFixture(); await handleAdminBff(read, response as never, options);
  assert.equal(response.code, 200); assert.equal(response.body.waitMinutes, 40);
  const invalid = f.request("/opening-auto-confirm", "PUT"); invalid.originalUrl = "/api/bff/admin/system/opening-auto-confirm";
  invalid.body = { waitMinutes: 10081, expectedRevision: "1" };
  const rejected = new ResponseFixture(); await handleAdminBff(invalid, rejected as never, options);
  assert.equal(rejected.code, 400);
});

test("Admin BFF dispatches the refund wait policy without bypassing validation", async () => {
  const f = setup();
  const options = { apiOrigin: API, adminOrigin: ORIGIN, adminSecurityOptions: f.options, supply: f.options } as unknown as AdminBffOptions;
  const read = f.request("/settlement-refund-policy"); read.originalUrl = "/api/bff/admin/system/settlement-refund-policy";
  const response = new ResponseFixture(); await handleAdminBff(read, response as never, options);
  assert.equal(response.code, 200); assert.equal(response.body.earlyDays, 7);
  const invalid = f.request("/settlement-refund-policy", "PUT"); invalid.originalUrl = "/api/bff/admin/system/settlement-refund-policy";
  invalid.body = { normalDays: 1, earlyDays: -1, expectedRevision: "1" };
  const rejected = new ResponseFixture(); await handleAdminBff(invalid, rejected as never, options);
  assert.equal(rejected.code, 400);
});
