import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import sharp from "sharp";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { createFakeRealNameProvider } from "../src/auth/user-identity";
import { createLocalMediaStorage } from "../src/supply/media";
import { canonicalize } from "../src/supply/content-hash";
import { validateFundingPolicy } from "../src/supply/funding-policy";
import {
  confirmBreach,
  createGuaranteePaymentIntent,
  decideGuaranteeRefund,
  decideRecovery,
  readCreditSnapshot,
  readGuaranteeContext,
  readGuaranteeTransactions,
  recordGuaranteePaymentResult,
  recordGuaranteeRefundResult,
  requestGuaranteeRefund,
  requestRecovery,
  requiredGuaranteeCents,
  reverseBreach,
} from "../src/credit/credit-guarantee";

const USER_ORIGIN = "http://127.0.0.1:4290";
const ADMIN_ORIGIN = "http://127.0.0.1:4291";
const API_ORIGIN = "http://127.0.0.1:4292";
const DATABASE = "zzsh_test_credit_guarantee";
const RUNTIME_ROLE = "zzsh_credit_guarantee_r";
const OWNER_ROLE = "zzsh";
const CREDENTIAL_FILE = process.env.CREDIT_GUARANTEE_CREDENTIALS_FILE
  ?? "E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/credit_guarantee/credentials.json";

type CookieJar = { values: Map<string, string>; update: (response: Response) => void; header: () => string };
type Staff = {
  id: string;
  jar: CookieJar;
  username?: string;
  password?: string;
  totpSecret?: string;
  totpEncoding?: "base32" | "utf8";
};
type Credentials = {
  host: string; port: number; database: string; oid: string; owner: string; marker: string;
  advisoryLock: string;
  runtime: { role: string; oid: string; password: string };
  maintenance: { role: string; passwordFile: string; scope: string };
};
type AdminProfile = {
  profilePath: string;
  document: any;
  alias: string;
  userId: string;
  username: string; password: string; totpSecret: string; totpEncoding: "base32" | "utf8";
  stableAuth: { env: Record<string, string>; workingDirectory: string; bindings: Record<string, { path: string; sha256: string }> };
};

type LocalAuthModule = {
  totp: (input: { secret: string; encoding: "base32" | "utf8" }) => string;
  validateProfile: (profile: unknown) => unknown;
  writePrivate: (path: string, data: unknown) => void;
};

let localAuthPromise: Promise<LocalAuthModule> | undefined;
const importEsm = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<LocalAuthModule>;
async function localAuth(): Promise<LocalAuthModule> {
  localAuthPromise ??= importEsm(pathToFileURL(resolve(process.cwd(), "../../scripts/local-auth.mjs")).href);
  return localAuthPromise;
}

function loadCredentials(): { value: Credentials; maintenancePassword: string } {
  const value = JSON.parse(readFileSync(CREDENTIAL_FILE, "utf8")) as Credentials;
  assert.equal(value.database, DATABASE);
  assert.equal(value.oid, "893390");
  assert.equal(value.owner, OWNER_ROLE);
  assert.equal(value.marker, "zzsh:credit-guarantee:v1");
  assert.equal(value.runtime.role, RUNTIME_ROLE);
  const passwordPath = isAbsolute(value.maintenance.passwordFile)
    ? value.maintenance.passwordFile
    : resolve(dirname(CREDENTIAL_FILE), value.maintenance.passwordFile);
  return { value, maintenancePassword: readFileSync(passwordPath, "utf8").trim() };
}

function loadAdminProfile(path: string): AdminProfile {
  const profile = JSON.parse(readFileSync(path, "utf8")) as any;
  const actor = profile.actors?.boss;
  const stableAuth = profile.stableAuth;
  assert.equal(profile.version, 1);
  assert.equal(profile.localTest, true);
  assert.equal(profile.resource, "credit_guarantee");
  assert.ok(actor, "stable credit_guarantee boss actor is required");
  const totp = actor.totp ?? {};
  assert.equal(actor.realm, "admin");
  assert.equal(actor.origin, ADMIN_ORIGIN);
  assert.equal(actor.userId, "admin_80768cba2f044bce8c86c04442d8dd95");
  assert.equal(typeof actor.username, "string");
  assert.equal(typeof actor.password, "string");
  assert.equal(typeof (totp.secret ?? actor.totpSecret), "string");
  const encoding = totp.encoding ?? actor.totpEncoding ?? "base32";
  assert.ok(encoding === "base32" || encoding === "utf8");
  assert.equal(stableAuth.env.AUTH_API_ORIGIN, API_ORIGIN);
  assert.equal(stableAuth.env.AUTH_USER_ORIGIN, USER_ORIGIN);
  assert.equal(stableAuth.env.AUTH_ADMIN_ORIGIN, ADMIN_ORIGIN);
  assert.equal(resolve(stableAuth.workingDirectory).toLowerCase(), resolve("E:/zzsh/zzsh/apps/api").toLowerCase());
  for (const binding of Object.values(stableAuth.bindings ?? {}) as Array<{ path: string; sha256: string }>) {
    const boundPath = isAbsolute(binding.path) ? binding.path : resolve(stableAuth.workingDirectory, binding.path);
    assert.equal(createHash("sha256").update(readFileSync(boundPath)).digest("hex"), binding.sha256.toLowerCase());
  }
  return { profilePath: path, document: profile, alias: "boss", userId: actor.userId, username: actor.username, password: actor.password, totpSecret: totp.secret ?? actor.totpSecret, totpEncoding: encoding, stableAuth };
}

function cookieJar(): CookieJar {
  const values = new Map<string, string>();
  return {
    values,
    update(response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair, ...attrs] = raw.split(";");
        const index = pair?.indexOf("=") ?? -1;
        if (index < 1) continue;
        const name = pair!.slice(0, index).trim();
        const value = pair!.slice(index + 1).trim();
        if (attrs.some((attr) => attr.trim().toLowerCase() === "max-age=0")) values.delete(name);
        else values.set(name, value);
      }
    },
    header: () => [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
  };
}

async function jsonBody(response: Response): Promise<Record<string, any> | null> {
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, any> : null;
}

async function request(base: string, path: string, body: Record<string, unknown> | undefined, jar: CookieJar, origin: string, method?: string, extra: Record<string, string> = {}) {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(base + path, {
    method: verb,
    headers: { origin, ...(verb === "GET" ? {} : { "content-type": "application/json" }), ...(jar.header() ? { cookie: jar.header() } : {}), ...extra },
    body: verb === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  jar.update(response);
  return { response, body: await jsonBody(response) };
}

function key(prefix: string): Record<string, string> {
  return { "idempotency-key": `${prefix}_${randomUUID().replaceAll("-", "")}` };
}

async function signInStaff(base: string, actor: { username: string; password: string; totpSecret: string; totpEncoding: "base32" | "utf8"; userId?: string }): Promise<Staff> {
  const auth = await localAuth();
  const jar = cookieJar();
  const login = await request(base, "/api/bff/admin/auth/sign-in/username", { username: actor.username, password: actor.password }, jar, ADMIN_ORIGIN);
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  assert.equal(login.body?.twoFactorRedirect, true, "admin actor must already be enrolled; no bootstrap/reset fallback");
  const verified = await request(base, "/api/bff/admin/auth/two-factor/verify-totp", { code: auth.totp({ secret: actor.totpSecret, encoding: actor.totpEncoding }) }, jar, ADMIN_ORIGIN);
  assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
  const session = await request(base, "/api/bff/admin/session", undefined, jar, ADMIN_ORIGIN);
  assert.equal(session.body?.authenticated, true);
  assert.equal(String(session.body?.adminUserId), actor.userId ?? String(session.body?.adminUserId));
  return { id: String(session.body?.adminUserId), jar, username: actor.username, password: actor.password, totpSecret: actor.totpSecret, totpEncoding: actor.totpEncoding };
}

async function signInExistingStaff(base: string, profile: AdminProfile): Promise<Staff> {
  return signInStaff(base, profile);
}

async function activateStaff(base: string, username: string, temporaryPassword: string, checkpoint: (patch: Record<string, unknown>) => Promise<void>): Promise<Staff> {
  const auth = await localAuth();
  const jar = cookieJar();
  assert.equal((await request(base, "/api/bff/admin/auth/sign-in/username", { username, password: temporaryPassword }, jar, ADMIN_ORIGIN)).response.status, 200);
  const password = randomBytes(24).toString("base64url");
  assert.equal((await request(base, "/api/bff/admin/auth/change-password", { currentPassword: temporaryPassword, newPassword: password }, jar, ADMIN_ORIGIN)).response.status, 200);
  await checkpoint({ stage: "password_changed", password });
  const enabled = await request(base, "/api/bff/admin/auth/two-factor/enable", { password }, jar, ADMIN_ORIGIN);
  assert.equal(enabled.response.status, 200);
  const secret = new URL(String(enabled.body?.totpURI)).searchParams.get("secret");
  assert.ok(secret);
  await checkpoint({ stage: "totp_issued", password, totpSecret: secret, totpEncoding: "base32" });
  assert.equal((await request(base, "/api/bff/admin/auth/two-factor/verify-totp", { code: auth.totp({ secret, encoding: "base32" }) }, jar, ADMIN_ORIGIN)).response.status, 200);
  assert.equal((await request(base, "/api/bff/admin/security/enrollment/activate", {}, jar, ADMIN_ORIGIN)).response.status, 200);
  const session = await request(base, "/api/bff/admin/session", undefined, jar, ADMIN_ORIGIN);
  assert.equal(session.body?.authenticated, true);
  const id = String(session.body?.adminUserId);
  await checkpoint({ stage: "activated", id, username, password, totpSecret: secret, totpEncoding: "base32" });
  return { id, jar, username, password, totpSecret: secret, totpEncoding: "base32" };
}

async function savePrivateCheckpoint(path: string, receipt: Record<string, any>, patch: Record<string, unknown>): Promise<void> {
  const auth = await localAuth();
  receipt.checkpoints.push({ at: new Date().toISOString(), ...patch });
  auth.writePrivate(path, receipt);
}

async function persistOperatorProfile(profile: AdminProfile, operator: Staff): Promise<void> {
  assert.ok(operator.username && operator.password && operator.totpSecret && operator.totpEncoding);
  const auth = await localAuth();
  const next = structuredClone(profile.document);
  next.actors ??= {};
  next.actors.operator = {
    realm: "admin",
    kind: "username",
    origin: ADMIN_ORIGIN,
    userId: operator.id,
    username: operator.username,
    password: operator.password,
    totp: { encoding: operator.totpEncoding, secret: operator.totpSecret },
  };
  auth.validateProfile(next);
  auth.writePrivate(profile.profilePath, next);
}

async function reuseOrCreateOperator(base: string, boss: Staff, profile: AdminProfile, runId: string): Promise<Staff> {
  const stored = profile.document.actors?.operator;
  if (stored) {
    assert.equal(stored.realm, "admin");
    assert.equal(stored.origin, ADMIN_ORIGIN);
    return signInStaff(base, {
      username: String(stored.username), password: String(stored.password),
      totpSecret: String(stored.totp?.secret ?? stored.totpSecret),
      totpEncoding: stored.totp?.encoding ?? stored.totpEncoding ?? "base32",
      userId: String(stored.userId),
    });
  }
  const operatorCreated = await request(base, "/api/bff/admin/security/admins/create", { name: `信用业务运营-${runId}`, allowPermissions: ["supply.catalog.manage", "supply.rules.edit", "supply.rules.activate", "supply.review.read", "supply.review.decide", "supply.quote.internal.read", "supply.guarantee.verify", "supply.guarantee.revoke", "credit.read", "credit.decide", "credit.guarantee.read", "credit.guarantee.manage"] }, boss.jar, ADMIN_ORIGIN, "POST", key("admin-create"));
  assert.equal(operatorCreated.response.status, 200);
  const username = String(operatorCreated.body?.username);
  const temporaryPassword = String(operatorCreated.body?.temporaryPassword);
  assert.ok(username && temporaryPassword && username !== "undefined" && temporaryPassword !== "undefined");
  const receiptPath = join(dirname(profile.profilePath), "receipts", "operator.receipt.json");
  const receipt: Record<string, any> = { resource: "credit_guarantee", actor: "operator", username, checkpoints: [] };
  await savePrivateCheckpoint(receiptPath, receipt, { stage: "create_accepted", username, temporaryPassword });
  try {
    const operator = await activateStaff(base, username, temporaryPassword, (patch) => savePrivateCheckpoint(receiptPath, receipt, patch));
    await persistOperatorProfile(profile, operator);
    return operator;
  } catch (error) {
    await savePrivateCheckpoint(receiptPath, receipt, { stage: "activation_failed", errorCode: error instanceof Error ? error.name : "UNKNOWN" });
    throw error;
  }
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await run(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

const HAFF_RULE = {
  schema: "haff-ratio-v1",
  baseBySafeBox: { "box-a": "50" },
  vitalityDeltaByLevel: { "6": "0" },
  bearDeltaByLevel: { "6": "0" },
  dailyDeltaByTermOption: { "daily-10m": "0" },
  options: { standard: { delta: "0", enabled: true } },
  spreadDelta: "10",
};

const fundingPolicy = (version: string, mode: "NOT_REQUIRED" | "FIXED_CENTS") => ({
  schema: "funding-policy-v1", policyVersion: version,
  recommendation: {
    schema: "deposit-recommendation-v1", algorithm: "delta-deposit-owner-declared-v1", version: "1", currency: "CNY", unit: "cent",
    inputSpec: { schema: "deposit-recommendation-input-v1", identityFields: ["accountId", "gameId", "listingVersionId", "priceVersionId", "ruleReleaseId"], attributeFields: { safeBoxCode: "declaration.attributes.safe_box_code", vitality: "declaration.attributes.vit_level", bear: "declaration.attributes.bear_level", dive: "declaration.attributes.dive_level", skinIds: "declaration.skins[].skinId" }, currency: "CNY", unit: "cent" },
    parameters: { safeBoxWeightsByCode: { "box-a": "5000" }, vitalityAtLeast7Cents: "5000", bearAtLeast7Cents: "5000", diveAtLeast3Cents: "5000", skinGroupById: { "skin-a": "LEGACY_GOLD" }, skinWeights: { LEGACY_GOLD: { firstCents: "5000", subsequentCents: "2500" }, LEGACY_AGENT: { firstCents: "5000", subsequentCents: "2500" }, LEGACY_KNIFE: { firstCents: "5000", subsequentCents: "2500" }, LEGACY_WEAPON: { firstCents: "5000", subsequentCents: "2500" } }, rounding: { mode: "CEIL", unitCents: "5000", zeroFallbackCents: "5000" }, upperLimitCents: "120000" },
  },
  ownerDepositRules: { schema: "owner-deposit-rule-v1", currency: "CNY", unit: "cent", normal: { minCents: "1", zeroAllowed: false }, fullPayoutSelected: { minCents: "30000", zeroAllowed: false }, capCents: "120000" },
  guaranteeRequirement: { schema: "account-guarantee-requirement-v1", version: "1", scope: "GAME_ACCOUNT", currency: "CNY", unit: "cent", mode, requiredCents: mode === "NOT_REQUIRED" ? "0" : "30000" },
  proofValidity: { schema: "guarantee-proof-validity-v1", satisfiedMode: "FIXED_DAYS", satisfiedDays: "7" },
  vipWaiver: true, svipWaiver: true, fullPayoutPolicyRef: "credit-business-test-full-payout", fullPayoutPolicyVersion: "1", disclosureVersion: "credit-business-test-disclosure-v1",
});

const adminProfilePath = process.env.CREDIT_GUARANTEE_ADMIN_PROFILE_FILE?.trim();
test("credit business PG/API G0 then G1/G2 with maintenance fixture separation", { skip: !process.env.CREDIT_GUARANTEE_RUN_BUSINESS ? "set CREDIT_GUARANTEE_RUN_BUSINESS=1 for the approved business window" : !adminProfilePath ? "existing active admin profile is required; bootstrap/reset fallback is disabled" : false }, async () => {
  const { value: credentials, maintenancePassword } = loadCredentials();
  const adminProfile = loadAdminProfile(adminProfilePath!);
  const runtimePool = new Pool({ host: credentials.host, port: credentials.port, database: credentials.database, user: credentials.runtime.role, password: credentials.runtime.password, application_name: "credit-guarantee-business-runtime", max: 4 });
  const maintenanceRoot = new Pool({ host: credentials.host, port: credentials.port, database: "postgres", user: credentials.maintenance.role, password: maintenancePassword, application_name: "credit-guarantee-business-maintenance", max: 2 });
  const maintenanceData = new Pool({ host: credentials.host, port: credentials.port, database: credentials.database, user: credentials.maintenance.role, password: maintenancePassword, application_name: "credit-guarantee-business-fixture", max: 2 });
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  let guard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let f3RuntimePool: Pool | undefined;
  let runtimeClosedByApp = false;
  try {
    const lockKey = BigInt(credentials.advisoryLock);
    guard = await maintenanceRoot.connect();
    assert.equal((await guard.query(`SELECT current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker,d.oid::text AS oid FROM pg_database d WHERE d.datname=$1`, [credentials.database])).rows[0]?.oid, "893390");
    assert.equal((await guard.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1`, [credentials.database])).rows[0]?.n, 0);
    assert.equal((await guard.query(`SELECT pg_try_advisory_lock($1::bigint) AS acquired`, [lockKey])).rows[0]?.acquired, true);
    assert.equal(adminProfile.stableAuth.env.AUTH_API_ORIGIN, API_ORIGIN);
    assert.equal(adminProfile.stableAuth.env.AUTH_USER_ORIGIN, USER_ORIGIN);
    assert.equal(adminProfile.stableAuth.env.AUTH_ADMIN_ORIGIN, ADMIN_ORIGIN);
    const authOptions = {
      ...loadAuthRuntimeConfig(adminProfile.stableAuth.env, adminProfile.stableAuth.workingDirectory, { testOperationsEnabled: true }),
      pool: runtimePool,
      creditGuaranteeEnabled: true,
      mediaStorage: createLocalMediaStorage(join(process.cwd(), "tmp", "credit-guarantee-business-media", runId)),
      realNameProvider: createFakeRealNameProvider("VERIFIED_ADULT"),
      userObligationReader: async () => "NONE" as const,
      orderHoldSeconds: 3600,
    };
    app = await createApp({ health: { dependencies: { postgres: { check: async () => undefined, close: async () => undefined }, redis: { check: async () => undefined, close: async () => undefined } } }, database: { pool: runtimePool }, auth: authOptions });
    await app.listen(4292, "127.0.0.1");
    let base = await app.getUrl();
    const boss = await signInExistingStaff(base, adminProfile);
    const operator = await reuseOrCreateOperator(base, boss, adminProfile, runId);
    const selfAuditCreated = await request(base, "/api/bff/admin/security/admins/create", { name: `信用自审边界-${runId}`, allowPermissions: ["credit.decide"] }, boss.jar, ADMIN_ORIGIN, "POST", key("self-audit-admin-create"));
    assert.equal(selfAuditCreated.response.status, 200, JSON.stringify(selfAuditCreated.body));
    const selfAuditUsername = String(selfAuditCreated.body?.username);
    const selfAuditTemporaryPassword = String(selfAuditCreated.body?.temporaryPassword);
    assert.ok(selfAuditUsername && selfAuditTemporaryPassword && selfAuditUsername !== "undefined" && selfAuditTemporaryPassword !== "undefined");
    const selfAuditReceiptPath = join(dirname(adminProfile.profilePath), "receipts", `self-audit-${runId}.receipt.json`);
    const selfAuditReceipt: Record<string, any> = { resource: "credit_guarantee", actor: "self-audit", username: selfAuditUsername, checkpoints: [] };
    const selfAuditAdmin = await activateStaff(base, selfAuditUsername, selfAuditTemporaryPassword, (patch) => savePrivateCheckpoint(selfAuditReceiptPath, selfAuditReceipt, patch));
    await transaction(maintenanceData, async (client) => {
      const now = new Date();
      await client.query(`INSERT INTO zzsh_auth_user."user" (id,name,email,"emailVerified","createdAt","updatedAt","phoneNumber","phoneNumberVerified",suspended) VALUES ($1,$2,$3,false,$4,$4,$5,true,false) ON CONFLICT(id) DO NOTHING`, [selfAuditAdmin.id, `自审测试主体-${runId}`, `${selfAuditAdmin.id}@fixture.zzsh.invalid`, now, `+861360${String((Number.parseInt(runId.slice(0, 8), 16) % 1_000_000)).padStart(6, "0")}`]);
    });
    const selfAuditRequestId = `credit_recovery_self_audit_${runId}`;
    await transaction(maintenanceData, (client) => client.query(`INSERT INTO zzsh_credit.credit_recovery_request(id,user_id,request_key,request_fingerprint,reason,status,eligibility_snapshot,score_before,completed_orders) VALUES($1,$2,$3,$4,$5,'PENDING',$6::jsonb,90,1)`, [selfAuditRequestId, selfAuditAdmin.id, `self-audit-key-${runId}`, "a".repeat(64), "自审边界 fixture", JSON.stringify({ eligible: true, testOnly: true })]));
    let fixtureSequence = 0;
    const seedUser = async (label: string, name: string): Promise<{ jar: CookieJar; id: string }> => {
      const phoneSuffix = String((Number.parseInt(runId.slice(0, 8), 16) % 1_000_000 + fixtureSequence++) % 1_000_000).padStart(6, "0");
      const phoneNumber = `+8613600${phoneSuffix}`;
      const id = `credit_business_${runId}_${label}`;
      const password = `CreditFixture#${runId}${label}`;
      const { hashPassword } = await import("better-auth/crypto");
      await transaction(maintenanceData, async (client) => {
        const now = new Date();
        await client.query(`INSERT INTO zzsh_auth_user."user" (id,name,email,"emailVerified","createdAt","updatedAt","phoneNumber","phoneNumberVerified",suspended) VALUES ($1,$2,$3,false,$4,$4,$5,true,false)`, [id, name, `${id}@fixture.zzsh.invalid`, now, phoneNumber]);
        await client.query(`INSERT INTO zzsh_auth_user.account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,'credential',$2,$3,$4,$4)`, [`account_${id}`, id, await hashPassword(password), now]);
        await client.query(`INSERT INTO zzsh_iam.user_identity_state (user_id,account_status,identity_status,age_status,provider,version,updated_at) VALUES ($1,'ACTIVE','UNVERIFIED','UNKNOWN','none',1,$2)`, [id, now]);
      });
      const jar = cookieJar();
      const login = await request(base, "/api/auth/user/sign-in/phone-number", { phoneNumber, password }, jar, USER_ORIGIN);
      assert.equal(login.response.status, 200, JSON.stringify(login.body));
      assert.equal((await request(base, "/api/auth/user/identity/verify", { fullName: name, documentNumber: "110101199001010000" }, jar, USER_ORIGIN)).response.status, 200);
      const credit = await request(base, "/api/bff/user/credit", undefined, jar, USER_ORIGIN);
      assert.equal(credit.response.status, 200, JSON.stringify(credit.body));
      assert.equal(credit.body?.credit?.score, 100, JSON.stringify(credit.body));
      return { jar, id };
    };
    const owner = await seedUser("owner", `号主-${runId}`); const renter = await seedUser("renter", `租客-${runId}`);
    const games = await request(base, "/api/bff/admin/supply/games", undefined, boss.jar, ADMIN_ORIGIN);
    assert.equal(games.response.status, 200, JSON.stringify(games.body));
    let gameId = String(games.body?.games?.find((game: any) => game.code === "delta")?.id ?? "");
    if (!gameId) {
      const gameResponse = await request(base, "/api/bff/admin/supply/games", { code: "delta", name: "三角洲行动", description: "信用业务正式helper fixture" }, boss.jar, ADMIN_ORIGIN, "POST", key("game"));
      assert.equal(gameResponse.response.status, 200, JSON.stringify(gameResponse.body));
      gameId = String(gameResponse.body?.game?.id);
    }
    assert.ok(gameId);
    await maintenanceData.query(`INSERT INTO zzsh_supply.admin_supply_scope (admin_user_id,game_id,granted_by_admin_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [operator.id, gameId, boss.id]);
    const entry = async (kind: string, body: Record<string, unknown>) => {
      const response = await request(base, `/api/bff/admin/supply/games/${gameId}/${kind}`, body, operator.jar, ADMIN_ORIGIN, "POST", key(kind));
      assert.equal(response.response.status, 200, JSON.stringify(response.body)); return String(response.body?.id);
    };
    const haffItem = await entry("items", { code: `haff_base_${runId}`, name: "哈夫币", unit: "HAFF_BASE", required: true });
    const pieceItem = await entry("items", { code: `credit_piece_${runId}`, name: "信用测试物资", unit: "PIECE", required: false });
    const makeRelease = async (mode: "NOT_REQUIRED" | "FIXED_CENTS", generation: string) => {
      const price = await request(base, "/api/bff/admin/supply/price-drafts", { gameId, mode: "SPREAD" }, operator.jar, ADMIN_ORIGIN, "POST", key("price")); assert.equal(price.response.status, 200, JSON.stringify(price.body));
      const term = await request(base, "/api/bff/admin/supply/term-drafts", { gameId }, operator.jar, ADMIN_ORIGIN, "POST", key("term")); assert.equal(term.response.status, 200, JSON.stringify(term.body));
      const agreement = await request(base, "/api/bff/admin/supply/agreement-drafts", { gameId, title: `信用协议-${runId}`, body: "本地受控业务fixture协议" }, operator.jar, ADMIN_ORIGIN, "POST", key("agreement")); assert.equal(agreement.response.status, 200, JSON.stringify(agreement.body));
      const priceId = String(price.body?.id); const termId = String(term.body?.id); const agreementId = String(agreement.body?.id);
      const policy = fundingPolicy(`credit-business-${runId}-${generation}`, mode);
      assert.ok(validateFundingPolicy(policy));
      const pricedItems = (await maintenanceData.query<{ id: string; unit: string }>(`SELECT id,unit FROM zzsh_supply.billable_item WHERE game_id=$1 AND enabled=true AND (required=true OR id=$2 OR id=$3) ORDER BY id`, [gameId, haffItem, pieceItem])).rows;
      const priceLines = pricedItems.map((item) => item.unit === "HAFF_BASE"
        ? { itemId: item.id, pricingKind: "HAFF_RATIO" as const }
        : { itemId: item.id, pricingKind: "FIXED_UNIT" as const, unitQuantity: "1", buyerUnitAmount: "2", ownerUnitAmount: "1.5" });
      assert.ok(priceLines.some((line) => line.itemId === haffItem));
      assert.ok(priceLines.some((line) => line.itemId === pieceItem));
      assert.equal((await request(base, `/api/bff/admin/supply/price-drafts/${priceId}`, { expectedRevision: "1", haffRule: HAFF_RULE, roundingPolicy: "HALF_UP_CENT_V1", fundingPolicy: policy, lines: priceLines }, operator.jar, ADMIN_ORIGIN, "PUT", key("price-config"))).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/term-drafts/${termId}`, { expectedRevision: "1", options: [{ code: "daily-10m", name: "日消耗10M", dailyConsumption: "10000000" }] }, operator.jar, ADMIN_ORIGIN, "PUT", key("term-config"))).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/price-drafts/${priceId}/seal`, { expectedRevision: "2" }, operator.jar, ADMIN_ORIGIN, "POST", key("price-seal"))).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/term-drafts/${termId}/seal`, { expectedRevision: "2" }, operator.jar, ADMIN_ORIGIN, "POST", key("term-seal"))).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/agreement-drafts/${agreementId}/seal`, { expectedRevision: "1" }, operator.jar, ADMIN_ORIGIN, "POST", key("agreement-seal"))).response.status, 200);
      const release = await request(base, "/api/bff/admin/supply/releases", { gameId, priceVersionId: priceId, termVersionId: termId, agreementVersionId: agreementId, expectedGeneration: generation }, boss.jar, ADMIN_ORIGIN, "POST", key("release")); assert.equal(release.response.status, 200, JSON.stringify(release.body));
      return { releaseId: String(release.body?.releaseId), priceId, policy };
    };
    const currentGeneration = async () => String((await maintenanceData.query<{ generation: string }>(`SELECT COALESCE(MAX(generation),0)::text AS generation FROM zzsh_supply.rule_release WHERE game_id=$1`, [gameId])).rows[0]?.generation ?? "0");
    const g0Release = await makeRelease("NOT_REQUIRED", await currentGeneration());
    const publish = async (release: { releaseId: string; priceId: string }, label: string, expectSubmit?: number, actor: { jar: CookieJar; id: string } = owner) => {
      const jar = actor.jar;
      const created = await request(base, "/api/v1/supply/accounts", { gameId }, jar, USER_ORIGIN, "POST", key("account")); assert.equal(created.response.status, 200, JSON.stringify(created.body)); const accountId = String(created.body?.accountId); const prefix = `/api/v1/supply/accounts/${accountId}`;
      let draft = await request(base, `${prefix}/drafts`, { expectedRevision: "1" }, jar, USER_ORIGIN, "POST", key("draft")); assert.equal(draft.response.status, 200, JSON.stringify(draft.body));
      const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#244" } }).png().toBuffer();
      const media = await request(base, "/api/v1/supply/media/upload-intents", { gameId, accountId, mime: "image/png", size: bytes.length, purpose: "ACCOUNT_DISPLAY" }, jar, USER_ORIGIN, "POST", key("media-intent")); assert.equal(media.response.status, 200, JSON.stringify(media.body));
      const upload = await fetch(`${base}/api/v1/supply/media/uploads/${media.body?.intentId}`, { method: "PUT", headers: { origin: USER_ORIGIN, cookie: jar.header(), "content-type": "image/png", "x-upload-token": String(media.body?.uploadToken), ...key("upload") }, body: new Uint8Array(bytes) }); assert.equal(upload.status, 200); const asset = await upload.json() as { assetId: string };
      const requiredItems = (await maintenanceData.query<{ id: string }>(`SELECT id FROM zzsh_supply.billable_item WHERE game_id=$1 AND required=true AND enabled=true ORDER BY id`, [gameId])).rows;
      const inventory = [...requiredItems.map((item) => ({ itemId: item.id, quantity: "60000000" })), { itemId: pieceItem, quantity: "10" }];
      draft = await request(base, `${prefix}/draft`, { expectedRevision: draft.body?.account.revision, title: `信用账号-${label}`, description: "隔离业务fixture", attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6, dive_level: 0, service_window_start_minute: 540, service_window_end_minute: 1380, service_window_timezone: "Asia/Shanghai", service_window_cross_midnight: false, owner_deposit_declaration: { schema: "owner-deposit-declaration-v1", amountCents: "1", declarationVersion: `credit-business-owner-${runId}` }, full_payout_declaration: { schema: "full-payout-declaration-v1", selected: false } }, termOptionCode: "daily-10m", pricingOptionCode: "standard", inventory, skins: [], entitlements: [], mediaBindings: [{ assetId: asset.assetId, position: 0 }] }, jar, USER_ORIGIN, "PUT", key("draft-save")); assert.equal(draft.response.status, 200, JSON.stringify(draft.body));
      const quote = await request(base, `${prefix}/quote`, { expectedRevision: draft.body?.account.revision }, jar, USER_ORIGIN, "POST", key("quote")); assert.equal(quote.response.status, 200, JSON.stringify(quote.body));
      const versionId = String(quote.body?.version?.id); const contentHash = String(quote.body?.version?.contentHash);
      const accepted = await request(base, `${prefix}/accept-rules`, { expectedRevision: quote.body?.account?.revision, versionId, releaseId: release.releaseId, contentHash }, jar, USER_ORIGIN, "POST", key("accept")); assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
      const submitted = await request(base, `${prefix}/submit`, { expectedRevision: accepted.body?.account?.revision, versionId, releaseId: release.releaseId, contentHash }, jar, USER_ORIGIN, "POST", key("submit"));
      if (expectSubmit !== undefined) {
        assert.equal(submitted.response.status, expectSubmit, JSON.stringify(submitted.body));
        assert.equal(submitted.body?.error?.code, "CONFLICT", JSON.stringify(submitted.body));
        assert.equal(submitted.body?.error?.message, "PUBLISHER_BAIL_UNCONFIRMED", JSON.stringify(submitted.body));
      } else assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
      if (expectSubmit !== undefined) return { accountId, versionId, releaseId: release.releaseId, contentHash, acceptedRevision: String(accepted.body?.account?.revision), submitted };
      const publicRead = await request(base, `/api/v1/supply/listings/${accountId}`, undefined, cookieJar(), API_ORIGIN); assert.equal(publicRead.response.status, 200, JSON.stringify(publicRead.body));
      return { accountId, versionId, releaseId: release.releaseId, contentHash, acceptedRevision: String(accepted.body?.account?.revision), submitted };
    };
    const g0Account = await publish(g0Release, "g0");
    const creditBefore = (await maintenanceData.query(`SELECT (SELECT count(*) FROM zzsh_credit.user_credit_state)::int AS states,(SELECT count(*) FROM zzsh_credit.credit_event)::int AS events`)).rows[0];
    const confirmation = await request(base, "/api/bff/user/order-confirmations", { accountId: g0Account.accountId, versionId: g0Account.versionId, releaseId: g0Account.releaseId }, renter.jar, USER_ORIGIN, "POST", key("g0-confirm")); assert.equal(confirmation.response.status, 200, JSON.stringify(confirmation.body));
    const order = await request(base, "/api/v2/orders", { confirmationToken: confirmation.body?.confirmationToken }, renter.jar, USER_ORIGIN, "POST", key("g0-order")); assert.equal(order.response.status, 200, JSON.stringify(order.body));
    const creditAfter = (await maintenanceData.query(`SELECT (SELECT count(*) FROM zzsh_credit.user_credit_state)::int AS states,(SELECT count(*) FROM zzsh_credit.credit_event)::int AS events`)).rows[0]; assert.deepEqual(creditAfter, creditBefore);
    const fixedRelease = await makeRelease("FIXED_CENTS", await currentGeneration());
    const fixed = await publish(fixedRelease, "fixed-missing-proof", 409);
    const finalRelease = await makeRelease("NOT_REQUIRED", await currentGeneration());
    const finalA = await publish(finalRelease, "g1-first-race");
    const finalB = await publish(finalRelease, "g1-second-threshold");
    const finalC = await publish(finalRelease, "g2-required");
    const readerCounts = async () => (await maintenanceData.query(`SELECT (SELECT count(*) FROM zzsh_credit.user_credit_state)::int AS states,(SELECT count(*) FROM zzsh_credit.credit_event)::int AS events,(SELECT count(*) FROM zzsh_order.owner_guarantee_requirement)::int AS requirements,(SELECT count(*) FROM zzsh_order.owner_guarantee_payment)::int AS payments`)).rows[0];
    const readContextNoWrite = async (account: { accountId: string; versionId: string }) => {
      const before = await readerCounts();
      const context = await transaction(runtimePool, (client) => readGuaranteeContext(client, account.accountId, owner.id, account.versionId));
      const after = await readerCounts();
      assert.deepEqual(after, before);
      assert.ok(context);
      return context;
    };
    const concurrentInput = { userId: owner.id, sourceType: "ACCOUNT", sourceId: finalA.accountId, subjectRole: "OWNER" as const, visibleReason: "业务测试首次并发确认违约", internalBasis: "业务测试首次并发依据", actorAdminId: operator.id };
    const concurrent = await Promise.all([transaction(runtimePool, (client) => confirmBreach(client, concurrentInput)), transaction(runtimePool, (client) => confirmBreach(client, concurrentInput))]);
    assert.deepEqual(concurrent.map((result) => result.duplicate).sort(), [false, true]);
    const context90 = await readContextNoWrite(finalA);
    assert.equal(context90.state, "NOT_REQUIRED");
    assert.equal(context90.score, 90);
    const secondBreach = await transaction(runtimePool, (client) => confirmBreach(client, { userId: owner.id, sourceType: "ACCOUNT", sourceId: finalB.accountId, subjectRole: "OWNER", visibleReason: "业务测试80分边界违约", internalBasis: "业务测试80分边界依据", actorAdminId: operator.id }));
    assert.equal(secondBreach.duplicate, false);
    const context80 = await readContextNoWrite(finalB);
    assert.equal(context80.state, "NOT_REQUIRED");
    assert.equal(context80.score, 80);
    const exemptCounts = await readerCounts();
    await assert.rejects(
      () => transaction(runtimePool, (client) => createGuaranteePaymentIntent(client, { context: context80, userId: owner.id, requestKey: `business-exempt-${runId}`, requestFingerprint: "d".repeat(64) })),
      /Guarantee payment is not currently required/,
    );
    assert.deepEqual(await readerCounts(), exemptCounts);
    const g1 = await transaction(runtimePool, (client) => confirmBreach(client, { userId: owner.id, sourceType: "ACCOUNT", sourceId: g0Account.accountId, subjectRole: "OWNER", visibleReason: "业务测试幂等重放违约", internalBasis: "业务测试幂等重放依据", actorAdminId: operator.id }));
    const concurrentReplay = await Promise.all([transaction(runtimePool, (client) => confirmBreach(client, { userId: owner.id, sourceType: "ACCOUNT", sourceId: g0Account.accountId, subjectRole: "OWNER", visibleReason: "业务测试幂等重放违约", internalBasis: "业务测试幂等重放依据", actorAdminId: operator.id })), transaction(runtimePool, (client) => confirmBreach(client, { userId: owner.id, sourceType: "ACCOUNT", sourceId: g0Account.accountId, subjectRole: "OWNER", visibleReason: "业务测试幂等重放违约", internalBasis: "业务测试幂等重放依据", actorAdminId: operator.id }))]);
    assert.deepEqual(concurrentReplay.map((result) => result.duplicate), [true, true]);
    const snapshot = await transaction(runtimePool, (client) => readCreditSnapshot(client, owner.id)); assert.equal(snapshot?.score, 70);
    await transaction(runtimePool, (client) => reverseBreach(client, { eventId: g1.event.id, visibleReason: "业务测试撤销", internalBasis: "业务测试撤销依据", actorAdminId: operator.id }));
    const reversedSnapshot = await transaction(runtimePool, (client) => readCreditSnapshot(client, owner.id)); assert.equal(reversedSnapshot?.score, 80);
    await assert.rejects(
      () => transaction(runtimePool, (client) => requestRecovery(client, { userId: owner.id, requestKey: `business-recovery-ineligible-${runId}`, requestFingerprint: "c".repeat(64), reason: "业务测试恢复资格边界", obligationReader: async () => "NONE" })),
      /RECENT_CONFIRMED_BREACH|NO_COMPLETED_ORDER/,
    );
    const thirdBreach = await transaction(runtimePool, (client) => confirmBreach(client, { userId: owner.id, sourceType: "ACCOUNT", sourceId: finalC.accountId, subjectRole: "OWNER", visibleReason: "业务测试70分保证金资格违约", internalBasis: "业务测试70分保证金资格依据", actorAdminId: operator.id }));
    assert.equal(thirdBreach.duplicate, false);
    const staleCounts = await readerCounts();
    await assert.rejects(
      () => transaction(runtimePool, (client) => createGuaranteePaymentIntent(client, { context: context80, userId: owner.id, requestKey: `business-stale-context-${runId}`, requestFingerprint: "e".repeat(64) })),
      /Guarantee context changed/,
    );
    assert.deepEqual(await readerCounts(), staleCounts);
    const g2Context = await readContextNoWrite(finalC);
    assert.equal(g2Context.state, "REQUIRED");
    assert.equal(g2Context.score, 70);
    assert.equal(g2Context.creditRevision, (await transaction(runtimePool, (client) => readCreditSnapshot(client, owner.id)))?.revision);
    assert.equal(g2Context.versionId, finalC.versionId);
    assert.equal(g2Context.releaseId, finalRelease.releaseId);
    assert.ok(g2Context.baseCents !== null);
    assert.equal(g2Context.requiredCents, requiredGuaranteeCents(g2Context.baseCents));
    assert.ok(BigInt(g2Context.requiredCents) <= 10000n);
    const currentBinding = (await maintenanceData.query<{ currentReleaseId: string; currentVersionId: string }>(`SELECT g.current_release_id AS "currentReleaseId",a.current_version_id AS "currentVersionId" FROM zzsh_supply.game g JOIN zzsh_supply.rental_account a ON a.game_id=g.id WHERE a.id=$1`, [finalC.accountId])).rows[0];
    assert.ok(currentBinding);
    assert.equal(currentBinding.currentReleaseId, finalRelease.releaseId);
    assert.equal(currentBinding.currentVersionId, finalC.versionId);
    const walletRevisionBeforeGuarantee = await transaction(runtimePool, (client) => client.query(`SELECT ledger_revision::text AS ledger_revision,read_revision::text AS read_revision FROM zzsh_order.wallet_revision WHERE user_id=$1`, [owner.id]));
    const failedPayment = await transaction(runtimePool, (client) => createGuaranteePaymentIntent(client, { context: g2Context!, userId: owner.id, requestKey: `business-payment-failed-${runId}`, requestFingerprint: "f".repeat(64) }));
    const paymentCountBeforeReplay = await readerCounts();
    const pendingContext = await readContextNoWrite(finalC);
    assert.equal(pendingContext.state, "PAYMENT_PENDING");
    const replayedPending = await transaction(runtimePool, (client) => createGuaranteePaymentIntent(client, { context: pendingContext!, userId: owner.id, requestKey: `business-payment-failed-${runId}`, requestFingerprint: "f".repeat(64) }));
    assert.equal(replayedPending.paymentId, failedPayment.paymentId); assert.equal(replayedPending.duplicate, true); assert.deepEqual(await readerCounts(), paymentCountBeforeReplay);
    await transaction(runtimePool, (client) => recordGuaranteePaymentResult(client, { paymentId: String(failedPayment.paymentId), outcome: "FAILED", receipt: { provider: "LOCAL_CONTROLLED", step: "failed-attempt" } }));
    const payment = await transaction(runtimePool, (client) => createGuaranteePaymentIntent(client, { context: g2Context!, userId: owner.id, requestKey: `business-payment-${runId}`, requestFingerprint: "a".repeat(64) }));
    await transaction(runtimePool, (client) => recordGuaranteePaymentResult(client, { paymentId: String(payment.paymentId), outcome: "UNKNOWN", receipt: { provider: "LOCAL_CONTROLLED", step: "unknown" } }));
    const captured = await transaction(runtimePool, (client) => recordGuaranteePaymentResult(client, { paymentId: String(payment.paymentId), outcome: "CONFIRMED", receivedAmountCents: g2Context!.requiredCents, providerTransactionId: `business-tx-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "confirmed" } })); assert.ok(captured.financeEventId && captured.ledgerEntryRef);
    const captureLedger = await transaction(runtimePool, (client) => client.query(`SELECT line_no,account_code,debit_cents::text AS debit,credit_cents::text AS credit,counterparty_user_id,details FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no`, [captured.financeEventId]));
    assert.deepEqual(captureLedger.rows.map((row: any) => [row.line_no, row.account_code, row.debit, row.credit, row.counterparty_user_id]), [[1, "GUARANTEE_CASH", g2Context!.requiredCents, "0", null], [2, "GUARANTEE_HELD", "0", g2Context!.requiredCents, owner.id]]);
    const captureSources = await transaction(runtimePool, (client) => client.query(`SELECT p.source_digest AS payment_source_digest,r.canonical_payload,r.payload_digest,root.source_digest AS root_source_digest,root.source_id,root.source_entity FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.owner_guarantee_reconciliation r ON r.payment_id=p.id AND r.observed_state='CONFIRMED' JOIN zzsh_order.finance_event e ON e.id=p.finance_event_id JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id WHERE p.id=$1`, [payment.paymentId]));
    const captureDigest = createHash("sha256").update(canonicalize(captureSources.rows[0]?.canonical_payload)).digest("hex");
    assert.equal(captureSources.rows[0]?.payment_source_digest, captureDigest);
    assert.equal(captureSources.rows[0]?.payload_digest, captureDigest);
    assert.equal(captureSources.rows[0]?.root_source_digest, captureDigest);
    assert.equal(captureSources.rows[0]?.source_id, payment.paymentId);
    assert.equal(captureSources.rows[0]?.source_entity, "owner_guarantee_payment");
    assert.equal(captureLedger.rows[0]?.details?.sourceDigest, captureDigest);
    await assert.rejects(
      () => transaction(runtimePool, (client) => recordGuaranteePaymentResult(client, { paymentId: String(payment.paymentId), outcome: "CONFIRMED", receivedAmountCents: g2Context!.requiredCents, providerTransactionId: `business-tx-other-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "changed" } })),
      /differs from the original transaction/,
    );
    await assert.rejects(
      () => transaction(runtimePool, async (client) => {
        const details = (await client.query<{ details: unknown }>(`SELECT details FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no LIMIT 1`, [captured.financeEventId])).rows[0]?.details;
        await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details) VALUES($1,$2,3,'GUARANTEE_CASH',$3,0,NULL,$4::jsonb)`, [`business-unbalanced-${runId}`, captured.financeEventId, g2Context!.requiredCents, JSON.stringify(details)]);
      }),
      /guarantee ledger entry is unadmitted|guarantee ledger line differs from exact template|guarantee ledger batch incomplete or unbalanced/,
    );
    const refund = await transaction(runtimePool, (client) => requestGuaranteeRefund(client, { userId: owner.id, requirementId: String(payment.requirementId), requestKey: `business-refund-${runId}`, requestFingerprint: "b".repeat(64), obligationReader: async () => "NONE" }));
    await transaction(runtimePool, (client) => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "PROCESSING", receipt: { provider: "LOCAL_CONTROLLED", step: "processing" } }));
    await transaction(runtimePool, (client) => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "UNKNOWN", receipt: { provider: "LOCAL_CONTROLLED", step: "unknown" } }));
    await transaction(runtimePool, (client) => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "FAILED", receipt: { provider: "LOCAL_CONTROLLED", step: "failed" } }));
    const refundRetry = await transaction(runtimePool, (client) => requestGuaranteeRefund(client, { userId: owner.id, requirementId: String(payment.requirementId), requestKey: `business-refund-retry-${runId}`, requestFingerprint: "c".repeat(64), obligationReader: async () => "NONE" }));
    await transaction(runtimePool, (client) => decideGuaranteeRefund(client, { refundId: String(refundRetry.refundId), actorAdminId: operator.id, decision: "APPROVE", reason: "业务测试责任确认" }));
    const refunded = await transaction(runtimePool, (client) => recordGuaranteeRefundResult(client, { refundId: String(refundRetry.refundId), outcome: "SUCCEEDED", providerRefundId: `business-rf-${runId}`, refundedAmountCents: g2Context!.requiredCents, receipt: { provider: "LOCAL_CONTROLLED", step: "succeeded" } })); assert.ok(refunded.financeEventId && refunded.ledgerEntryRef);
    const refundLedger = await transaction(runtimePool, (client) => client.query(`SELECT line_no,account_code,debit_cents::text AS debit,credit_cents::text AS credit,counterparty_user_id,details FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no`, [refunded.financeEventId]));
    assert.deepEqual(refundLedger.rows.map((row: any) => [row.line_no, row.account_code, row.debit, row.credit, row.counterparty_user_id]), [[1, "GUARANTEE_CASH", "0", g2Context!.requiredCents, null], [2, "GUARANTEE_HELD", g2Context!.requiredCents, "0", owner.id]]);
    const refundSources = await transaction(runtimePool, (client) => client.query(`SELECT f.source_digest AS refund_source_digest,r.canonical_payload,r.payload_digest,root.source_digest AS root_source_digest,root.source_id,root.source_entity FROM zzsh_order.owner_guarantee_refund f JOIN zzsh_order.owner_guarantee_reconciliation r ON r.refund_id=f.id AND r.observed_state='SUCCEEDED' JOIN zzsh_order.finance_event e ON e.id=f.finance_event_id JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id WHERE f.id=$1`, [refundRetry.refundId]));
    const refundDigest = createHash("sha256").update(canonicalize(refundSources.rows[0]?.canonical_payload)).digest("hex");
    assert.equal(refundSources.rows[0]?.refund_source_digest, refundDigest);
    assert.equal(refundSources.rows[0]?.payload_digest, refundDigest);
    assert.equal(refundSources.rows[0]?.root_source_digest, refundDigest);
    assert.equal(refundSources.rows[0]?.source_id, refundRetry.refundId);
    assert.equal(refundSources.rows[0]?.source_entity, "owner_guarantee_refund");
    assert.equal(refundLedger.rows[0]?.details?.sourceDigest, refundDigest);
    await assert.rejects(
      () => transaction(runtimePool, (client) => recordGuaranteeRefundResult(client, { refundId: String(refundRetry.refundId), outcome: "SUCCEEDED", providerRefundId: `business-rf-other-${runId}`, refundedAmountCents: g2Context!.requiredCents, receipt: { provider: "LOCAL_CONTROLLED", step: "changed" } })),
      /differs from the original transaction/,
    );
    const transactions = await transaction(runtimePool, (client) => readGuaranteeTransactions(client, owner.id)); const transactionHistory = transactions.find((row: any) => row.requirementId === payment.requirementId); assert.ok(transactionHistory); assert.deepEqual(transactionHistory.paymentHistory.map((item: any) => item.id), [failedPayment.paymentId, payment.paymentId]); assert.deepEqual(transactionHistory.refundHistory.map((item: any) => item.id), [refund.refundId, refundRetry.refundId]); assert.ok(transactions.some((row: any) => row.paymentFinanceEventId === captured.financeEventId && row.refundFinanceEventId === refunded.financeEventId));
    const secondaryGame = (await maintenanceData.query<{ id: string }>(`SELECT id FROM zzsh_supply.game WHERE code <> 'delta' ORDER BY id LIMIT 1`)).rows[0]; assert.ok(secondaryGame, "a second existing game is required for the scope fixture");
    const scopeAccountId = `credit_scope_account_${runId}`; const scopeRequirementId = `credit_scope_requirement_${runId}`; const scopePaymentId = `credit_scope_payment_${runId}`; const scopeRefundId = `credit_scope_refund_${runId}`;
    await transaction(maintenanceData, async (client) => {
      await client.query(`INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id,display_no) VALUES($1,$2,$3,$4)`, [scopeAccountId, owner.id, secondaryGame!.id, `SCOPE-B-${runId}`]);
      await client.query(`INSERT INTO zzsh_order.owner_guarantee_requirement(id,owner_user_id,account_id,game_id,listing_version_id,price_version_id,rule_release_id,policy_version,base_cents,required_cents,score_snapshot,status) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,12000,600,70,'COVERED')`, [scopeRequirementId, owner.id, scopeAccountId, secondaryGame!.id, `scope-price-${runId}`, `scope-release-${runId}`, `scope-policy-${runId}`]);
      await client.query(`INSERT INTO zzsh_order.owner_guarantee_payment(id,requirement_id,owner_user_id,request_key,request_fingerprint,merchant_order_no,amount_cents,status,provider,provider_request_state) VALUES($1,$2,$3,$4,$5,$6,600,'UNKNOWN','HUIJU','UNKNOWN')`, [scopePaymentId, scopeRequirementId, owner.id, `scope-payment-${runId}`, "d".repeat(64), `scope-merchant-${runId}`]);
      await client.query(`INSERT INTO zzsh_order.owner_guarantee_refund(id,requirement_id,payment_id,owner_user_id,request_key,request_fingerprint,amount_cents,status,provider,provider_request_state,release_policy_state) VALUES($1,$2,$3,$4,$5,$6,600,'UNKNOWN','HUIJU','UNKNOWN','OWNER_DECISION_REQUIRED')`, [scopeRefundId, scopeRequirementId, scopePaymentId, owner.id, `scope-refund-${runId}`, "e".repeat(64)]);
    });
    const scopedTransactions = await transaction(runtimePool, (client) => readGuaranteeTransactions(client, owner.id, { userId: operator.id, isBoss: false }));
    assert.equal(scopedTransactions.some((row: any) => row.accountId === scopeAccountId || row.paymentHistory.some((item: any) => item.merchantOrderNo === `scope-merchant-${runId}`)), false);
    const bossTransactions = await transaction(runtimePool, (client) => readGuaranteeTransactions(client, owner.id, { userId: boss.id, isBoss: true }));
    assert.equal(bossTransactions.some((row: any) => row.accountId === scopeAccountId && row.paymentHistory[0]?.merchantOrderNo === `scope-merchant-${runId}`), true);
    const walletRevisionAfterGuarantee = await transaction(runtimePool, (client) => client.query(`SELECT ledger_revision::text AS ledger_revision,read_revision::text AS read_revision FROM zzsh_order.wallet_revision WHERE user_id=$1`, [owner.id]));
    assert.deepEqual(walletRevisionAfterGuarantee.rows, walletRevisionBeforeGuarantee.rows);
    const userCreditOverview = await request(base, "/api/bff/user/credit", undefined, owner.jar, USER_ORIGIN);
    assert.equal(userCreditOverview.response.status, 200, JSON.stringify(userCreditOverview.body));
    assert.equal(userCreditOverview.body?.credit?.score, 70);
    assert.ok(Array.isArray(userCreditOverview.body?.guarantees));
    const adminCreditOverview = await request(base, `/api/bff/admin/credit/users/${encodeURIComponent(owner.id)}`, undefined, operator.jar, ADMIN_ORIGIN);
    assert.equal(adminCreditOverview.response.status, 200, JSON.stringify(adminCreditOverview.body));
    assert.ok(Array.isArray(adminCreditOverview.body?.guarantees));
    assert.ok(Array.isArray(adminCreditOverview.body?.transactions));
    assert.equal(adminCreditOverview.body.transactions.some((row: any) => row.accountId === scopeAccountId || row.paymentHistory?.some((item: any) => item.merchantOrderNo === `scope-merchant-${runId}`)), false);
    assert.equal((await request(base, "/api/bff/user/credit", undefined, owner.jar, "https://evil.invalid")).response.status, 403);
    assert.ok([401, 403].includes((await request(base, `/api/bff/admin/credit/users/${encodeURIComponent(owner.id)}`, undefined, owner.jar, USER_ORIGIN)).response.status));
    const foreignScope = (await maintenanceData.query<{ ownerUserId: string }>(`SELECT a.owner_user_id AS "ownerUserId" FROM zzsh_supply.rental_account a JOIN zzsh_supply.game g ON g.id=a.game_id WHERE g.code <> 'delta' ORDER BY a.id LIMIT 1`)).rows[0];
    assert.ok(foreignScope);
    assert.equal((await request(base, `/api/bff/admin/credit/users/${encodeURIComponent(foreignScope.ownerUserId)}`, undefined, operator.jar, ADMIN_ORIGIN)).response.status, 404);
    const selfAuditResponse = await request(base, `/api/bff/admin/credit/recovery-requests/${selfAuditRequestId}/decision`, { decision: "APPROVE", reason: "自审禁止测试" }, selfAuditAdmin.jar, ADMIN_ORIGIN, "POST", key("self-audit-decision"));
    assert.equal(selfAuditResponse.response.status, 403, JSON.stringify(selfAuditResponse.body));
    const selfAuditAfter = (await maintenanceData.query<{ status: string; decision: string | null }>(`SELECT status,decision FROM zzsh_credit.credit_recovery_request WHERE id=$1`, [selfAuditRequestId])).rows[0];
    assert.deepEqual(selfAuditAfter, { status: "PENDING", decision: null });
    // F3: enable the capability only after the independent G0/G1/G2 window.
    // The same formal gate is then consumed by publish, confirmation and order.
    console.log("F3_STAGE restart-enabled-app");
    await app.close(); app = undefined;
    await runtimePool.end().catch(() => undefined);
    f3RuntimePool = new Pool({ host: credentials.host, port: credentials.port, database: credentials.database, user: credentials.runtime.role, password: credentials.runtime.password, application_name: "credit-guarantee-f3-runtime", max: 4 });
    app = await createApp({
      health: { dependencies: { postgres: { check: async () => undefined, close: async () => undefined }, redis: { check: async () => undefined, close: async () => undefined } } },
      database: { pool: f3RuntimePool }, auth: { ...authOptions, pool: f3RuntimePool, creditGuaranteeEnabled: true },
    });
    await app.listen(4292, "127.0.0.1");
    assert.equal(await app.getUrl(), "http://127.0.0.1:4292");
    // Keep the trusted Origin headers unchanged; use a fresh fetch pool after the restart.
    base = "http://localhost:4292";

    console.log("F3_STAGE low-uncovered-publish");
    const lowUncovered = await publish(finalRelease, "f3-low-uncovered", 409);
    const staleAccount = await publish(finalRelease, "f3-stale-covered", 409);

    console.log("F3_STAGE paid70");
    const readF3ContextNoWrite = async (account: { accountId: string; versionId: string }) => { const context = await transaction(f3RuntimePool!, (client) => readGuaranteeContext(client, account.accountId, owner.id, account.versionId)); assert.ok(context); return context; };
    const paidContext = await readF3ContextNoWrite(finalA);
    assert.equal(paidContext.score, 70); assert.equal(paidContext.state, "REQUIRED");
    const f3Payment = await transaction(f3RuntimePool, (client) => createGuaranteePaymentIntent(client, { context: paidContext!, userId: owner.id, requestKey: `f3-paid-${runId}`, requestFingerprint: "f".repeat(64) }));
    const f3Captured = await transaction(f3RuntimePool, (client) => recordGuaranteePaymentResult(client, { paymentId: String(f3Payment.paymentId), outcome: "CONFIRMED", receivedAmountCents: paidContext!.requiredCents, providerTransactionId: `f3-tx-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "f3-confirmed" } }));
    assert.ok(f3Captured.financeEventId && f3Captured.ledgerEntryRef);
    const staleContext = await readF3ContextNoWrite(staleAccount);
    const stalePayment = await transaction(f3RuntimePool, (client) => createGuaranteePaymentIntent(client, { context: staleContext!, userId: owner.id, requestKey: `f3-stale-payment-${runId}`, requestFingerprint: "5".repeat(64) }));
    await transaction(f3RuntimePool, (client) => recordGuaranteePaymentResult(client, { paymentId: String(stalePayment.paymentId), outcome: "CONFIRMED", receivedAmountCents: staleContext!.requiredCents, providerTransactionId: `f3-stale-tx-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "f3-stale-confirmed" } }));
    const staleResubmitted = await request(base, `/api/v1/supply/accounts/${staleAccount.accountId}/submit`, { expectedRevision: staleAccount.acceptedRevision, versionId: staleAccount.versionId, releaseId: staleAccount.releaseId, contentHash: staleAccount.contentHash }, owner.jar, USER_ORIGIN, "POST", key("f3-stale-resubmit"));
    assert.equal(staleResubmitted.response.status, 200, JSON.stringify(staleResubmitted.body));
    const staleConfirmation = await request(base, "/api/bff/user/order-confirmations", { accountId: staleAccount.accountId, versionId: staleAccount.versionId, releaseId: staleAccount.releaseId }, renter.jar, USER_ORIGIN, "POST", key("f3-stale-confirmation"));
    assert.equal(staleConfirmation.response.status, 200, JSON.stringify(staleConfirmation.body));
    const liveConfirmation = await request(base, "/api/bff/user/order-confirmations", { accountId: finalA.accountId, versionId: finalA.versionId, releaseId: finalA.releaseId }, renter.jar, USER_ORIGIN, "POST", key("f3-live-confirmation"));
    assert.equal(liveConfirmation.response.status, 200, JSON.stringify(liveConfirmation.body));
    const paidOrder = await request(base, "/api/v2/orders", { confirmationToken: liveConfirmation.body?.confirmationToken }, renter.jar, USER_ORIGIN, "POST", key("f3-paid-order"));
    assert.equal(paidOrder.response.status, 200, JSON.stringify(paidOrder.body));

    const lowUncoveredBreach = await transaction(f3RuntimePool, (client) => confirmBreach(client, {
      userId: owner.id, sourceType: "ACCOUNT", sourceId: lowUncovered.accountId, subjectRole: "OWNER",
      visibleReason: "F3旧确认失效测试", internalBasis: "F3信用版本变化受控依据", actorAdminId: operator.id,
    }));
    assert.equal(lowUncoveredBreach.duplicate, false);

    const staleOrderCount = Number((await maintenanceData.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE account_id=$1`, [staleAccount.accountId])).rows[0].n);
    const staleOrder = await request(base, "/api/v2/orders", { confirmationToken: staleConfirmation.body?.confirmationToken }, renter.jar, USER_ORIGIN, "POST", key("f3-stale-order"));
    assert.equal(staleOrder.response.status, 409, JSON.stringify(staleOrder.body));
    assert.equal(staleOrder.body?.error?.code, "CONFIRMATION_CHANGED");
    assert.equal(Number((await maintenanceData.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_order WHERE account_id=$1`, [staleAccount.accountId])).rows[0].n), staleOrderCount);

    console.log("F3_STAGE underpaid-and-refund");
    const underpaidContext = await readF3ContextNoWrite(finalB);
    const underpaidPayment = await transaction(f3RuntimePool, (client) => createGuaranteePaymentIntent(client, { context: underpaidContext!, userId: owner.id, requestKey: `f3-underpaid-${runId}`, requestFingerprint: "7".repeat(64) }));
    await transaction(f3RuntimePool, (client) => recordGuaranteePaymentResult(client, { paymentId: String(underpaidPayment.paymentId), outcome: "CONFIRMED", receivedAmountCents: "1", providerTransactionId: `f3-underpaid-tx-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "f3-underpaid" } }));
    const underpaidAfter = await readF3ContextNoWrite(finalB);
    assert.equal(underpaidAfter.state, "REQUIRED"); assert.equal(underpaidAfter.reasonCode, "PAYMENT_UNDERPAID");
    const underpaidConfirmation = await request(base, "/api/bff/user/order-confirmations", { accountId: finalB.accountId, versionId: finalB.versionId, releaseId: finalB.releaseId }, renter.jar, USER_ORIGIN, "POST", key("f3-underpaid-confirmation"));
    assert.equal(underpaidConfirmation.response.status, 503, JSON.stringify(underpaidConfirmation.body));

    const refundRequest = await transaction(f3RuntimePool, (client) => requestGuaranteeRefund(client, { userId: owner.id, requirementId: String(f3Payment.requirementId), requestKey: `f3-refund-${runId}`, requestFingerprint: "8".repeat(64), obligationReader: async () => "NONE" }));
    await transaction(f3RuntimePool, (client) => recordGuaranteeRefundResult(client, { refundId: String(refundRequest.refundId), outcome: "PROCESSING", receipt: { provider: "LOCAL_CONTROLLED", step: "f3-refund-processing" } }));
    const refundContext = await readF3ContextNoWrite(finalA);
    assert.equal(refundContext.state, "REFUND_PROCESSING");
    const refundOccupiedConfirmation = await request(base, "/api/bff/user/order-confirmations", { accountId: finalA.accountId, versionId: finalA.versionId, releaseId: finalA.releaseId }, renter.jar, USER_ORIGIN, "POST", key("f3-refund-occupied-confirmation"));
    assert.notEqual(refundOccupiedConfirmation.response.status, 200, JSON.stringify(refundOccupiedConfirmation.body));

    console.log("F3_STAGE score80-and-100");
    await transaction(f3RuntimePool, (client) => reverseBreach(client, { eventId: lowUncoveredBreach.event.id, visibleReason: "F3恢复到80", internalBasis: "F3门禁边界恢复依据", actorAdminId: operator.id }));
    await transaction(f3RuntimePool, (client) => reverseBreach(client, { eventId: thirdBreach.event.id, visibleReason: "F3恢复80边界", internalBasis: "F3 80免缴依据", actorAdminId: operator.id }));
    assert.equal((await transaction(f3RuntimePool, (client) => readCreditSnapshot(client, owner.id)))?.score, 80);
    const score80Account = await publish(finalRelease, "f3-score80");
    const score80Confirmation = await request(base, "/api/bff/user/order-confirmations", { accountId: score80Account.accountId, versionId: score80Account.versionId, releaseId: score80Account.releaseId }, renter.jar, USER_ORIGIN, "POST", key("f3-score80-confirmation"));
    assert.equal(score80Confirmation.response.status, 200, JSON.stringify(score80Confirmation.body));
    const score80Order = await request(base, "/api/v2/orders", { confirmationToken: score80Confirmation.body?.confirmationToken }, renter.jar, USER_ORIGIN, "POST", key("f3-score80-order"));
    assert.equal(score80Order.response.status, 200, JSON.stringify(score80Order.body));
    const score100Account = await publish(finalRelease, "f3-score100", undefined, renter);
    const score100Confirmation = await request(base, "/api/bff/user/order-confirmations", { accountId: score100Account.accountId, versionId: score100Account.versionId, releaseId: score100Account.releaseId }, owner.jar, USER_ORIGIN, "POST", key("f3-score100-confirmation"));
    assert.equal(score100Confirmation.response.status, 200, JSON.stringify(score100Confirmation.body));
    const score100Order = await request(base, "/api/v2/orders", { confirmationToken: score100Confirmation.body?.confirmationToken }, owner.jar, USER_ORIGIN, "POST", key("f3-score100-order"));
    assert.equal(score100Order.response.status, 200, JSON.stringify(score100Order.body));
    console.log(JSON.stringify({ evidenceClass: "LOCAL_PG_LOCAL_HTTP", f3: { enabled: true, lowUncoveredRejected: lowUncovered.submitted.response.status, paid70Order: paidOrder.body?.order?.id, staleConfirmationRejected: staleOrder.body?.error?.code, underpaidRejected: underpaidConfirmation.body?.error?.code, refundState: refundContext.state, score80Order: score80Order.body?.order?.id, score100Order: score100Order.body?.order?.id, providerRequests: 0 } }));
    console.log(JSON.stringify({ evidenceClass: "LOCAL_PG_LOCAL_HTTP", runId, g0: { accountId: g0Account.accountId, orderId: order.body?.order?.id, creditUnchanged: true }, g0FixedMissingProofStatus: fixed.submitted.response.status, g1: { firstConcurrentEventId: concurrent.find((result) => !result.duplicate)?.event.id, firstConcurrentScoreAfter: 90, replayEventId: g1.event.id, replayScoreAfter: snapshot?.score, reversedScoreAfter: reversedSnapshot?.score, concurrentFirstResults: concurrent.map((result) => result.duplicate), replayResults: concurrentReplay.map((result) => result.duplicate) }, g2: { contextAccountId: g2Context.accountId, contextScore: g2Context.score, contextRevision: g2Context.creditRevision, paymentFinanceEventId: captured.financeEventId, refundFinanceEventId: refunded.financeEventId, walletRevisionUnchanged: true, providerRequests: 0 }, http: { userOverview: true, adminOverview: true, evilOriginRejected: true, userToAdminRejected: true, foreignScopeRejected: true, selfAuditRejected: true } }));
  } finally {
    if (app) { await app.close().catch(() => undefined); runtimeClosedByApp = true; }
    if (guard) { await guard.query(`SELECT pg_advisory_unlock($1::bigint)`, [BigInt(credentials.advisoryLock)]).catch(() => undefined); guard.release(); }
    if (!runtimeClosedByApp) await runtimePool.end(); if (f3RuntimePool) await f3RuntimePool.end().catch(() => undefined); await maintenanceData.end(); await maintenanceRoot.end();
  }
});


