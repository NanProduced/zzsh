import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import {
  legacyOwnerEvidenceDigest,
  legacyOwnerUserId,
  migrateLegacyOwner,
  normalizeLegacyOwnerInput,
  type LegacyOwnerEvidence,
  type LegacyOwnerMigrationInput,
} from "../src/supply/legacy-user-migration";

const ACTOR = { id: "admin-1", sessionId: "session-1", requestId: "request-1" };
const MOBILE = "19900000001";
const NICKNAME = "历史用户单元测试";
const SOURCE_DIGEST = "a".repeat(64);
const OWNER_LEGACY_ID = "17998";

function evidence(overrides: Partial<LegacyOwnerEvidence> = {}): LegacyOwnerEvidence {
  return {
    sourceSystem: "legacy_mysql_restore",
    sourceEntity: "la_user",
    legacyId: OWNER_LEGACY_ID,
    sourceDigest: SOURCE_DIGEST,
    evidenceRef: "r1/restricted/legacy-user-evidence.jsonl",
    nickname: NICKNAME,
    mobile: MOBILE,
    sourceCreatedAt: "2026-05-19T00:00:00.000Z",
    sourceUpdatedAt: "2026-09-12T13:43:54.000Z",
    status: { realNameBound: true, ageAdult: true, disabled: false, deleted: false },
    legacyPassword: null,
    ...overrides,
  };
}

function input(overrides: Partial<LegacyOwnerEvidence> = {}): LegacyOwnerMigrationInput {
  const payload = evidence(overrides);
  return { evidence: payload, evidenceDigest: legacyOwnerEvidenceDigest(payload) };
}

const ACCOUNT_ID = "account-1";
const STANDIN = "user-standin";

type UserRow = { id: string; name: string; email: string; phoneNumber: string | null; phoneNumberVerified: boolean | null; suspended: boolean };
type CredentialRow = { id: string; userId: string; providerId: string; password: string | null; legacyPasswordMd5: string | null; legacyPasswordSalt: string | null; legacyPasswordVersion: string | null; legacyPasswordUpgradedAt: string | null };
type IdentityRow = { user_id: string; account_status: string; identity_status: string; age_status: string; provider: string; provider_reference: string; verified_at: string | null };
type MapRow = { source_system: string; source_entity: string; legacy_id: string; source_digest: string; account_id: string; version_id: string; evidence_ref: string };
type BindingRow = {
  id: string; account_id: string; owner_user_id: string; previous_owner_user_id: string;
  source_system: string; source_entity: string; legacy_id: string; source_digest: string;
  owner_legacy_id: string; owner_source_digest: string; relation_digest: string;
  evidence_ref: string; bound_by_admin_id: string; idempotency_key: string;
};
type RentalAccountRow = { id: string; owner_user_id: string; game_id: string; current_version_id: string | null; owner_paused: boolean; staff_restricted: boolean; restriction_reason: string | null; legacy_hold: string; lifecycle: string; revision: string; display_no: string | null };
type MediaRow = { id: string; account_id: string | null; ownership_kind: string; owner_user_id: string | null; uploaded_by_user_id: string | null };

class FakeClient {
  readonly users = new Map<string, UserRow>();
  readonly credentials = new Map<string, CredentialRow>();
  readonly identities = new Map<string, IdentityRow>();
  readonly audits: Array<{ object_id: string; action: string; details: Record<string, unknown> }> = [];
  readonly idempotency = new Map<string, { requestFingerprint: string; responseStatus: number; responseBody: unknown; publishRequired: boolean }>();
  readonly maps = new Map<string, MapRow>();
  readonly bindings = new Map<string, BindingRow>();
  readonly media = new Map<string, MediaRow>([
    ["asset-1", { id: "asset-1", account_id: ACCOUNT_ID, ownership_kind: "USER_SUPPLY", owner_user_id: STANDIN, uploaded_by_user_id: STANDIN }],
    ["asset-2", { id: "asset-2", account_id: ACCOUNT_ID, ownership_kind: "PLATFORM_CATALOG", owner_user_id: null, uploaded_by_user_id: null }],
  ]);
  readonly accounts = new Map<string, RentalAccountRow>([
    [ACCOUNT_ID, { id: ACCOUNT_ID, owner_user_id: STANDIN, game_id: "game-delta", current_version_id: "version-1", owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "NONE", lifecycle: "ACTIVE", revision: "1", display_no: null }],
  ]);
  readonly objectCounts = new Map<string, number>();
  readonly queries: string[] = [];
  permission = true;
  scope = true;
  failNextIdempotencyRead = false;

  constructor() {
    this.maps.set(ACCOUNT_ID, {
      source_system: "legacy_mysql_restore",
      source_entity: "la_rental_accounts",
      legacy_id: "7768",
      source_digest: "b".repeat(64),
      account_id: ACCOUNT_ID,
      version_id: "observation-1",
      evidence_ref: "fixture",
    });
    this.users.set(STANDIN, { id: STANDIN, name: "RS2-02 owner stand-in", email: "standin@example.invalid", phoneNumber: null, phoneNumberVerified: false, suspended: false });
  }

  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.queries.push(sql);
    if (sql.includes("pg_advisory_xact_lock") || sql.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
    if (sql.includes("idempotency_record") && sql.startsWith("SELECT")) {
      if (this.failNextIdempotencyRead) {
        this.failNextIdempotencyRead = false;
        throw new Error("simulated UNKNOWN idempotency read");
      }
      const row = this.idempotency.get(`${values[0]}|${values[1]}`);
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("admin_security")) {
      return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false } as T], rowCount: 1 };
    }
    if (sql.includes("role_permissions") || sql.includes("admin_user_permission")) {
      return { rows: this.permission ? [{ permissionCode: "supply.catalog.manage" } as T] : [], rowCount: this.permission ? 1 : 0 };
    }
    if (sql.includes("admin_supply_scope")) return { rows: this.scope ? [{ one: 1 } as T] : [], rowCount: this.scope ? 1 : 0 };
    if (sql.startsWith('SELECT "id","name","email","phoneNumber","phoneNumberVerified","suspended" FROM "zzsh_auth_user"."user"')) {
      const rows = [...this.users.values()].filter((row) => row.id === values[0] || row.phoneNumber === values[1]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT "id","suspended" FROM "zzsh_auth_user"."user" WHERE "id"=$1')) {
      const row = this.users.get(String(values[0]));
      return { rows: row ? [{ id: row.id, suspended: row.suspended } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT id FROM zzsh_auth_user') || sql.startsWith('SELECT "id" FROM "zzsh_auth_user"."user" WHERE "id"=$1')) {
      const row = this.users.get(String(values[0]));
      return { rows: row ? [{ id: row.id } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT id FROM zzsh_supply.game")) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT "account_status","identity_status","age_status","provider","provider_reference",to_char("verified_at"')) {
      const row = this.identities.get(String(values[0]));
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT "details"->>\'sourceDigest\' AS "sourceDigest", "details"->>\'evidenceDigest\' AS "evidenceDigest"')) {
      const row = [...this.audits].reverse().find((audit) => audit.object_id === values[0] && audit.action === "user.legacy_owner.migrated");
      return { rows: row ? [{ sourceDigest: row.details.sourceDigest, evidenceDigest: row.details.evidenceDigest } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT "object_id","details" FROM "zzsh_iam"."audit_event"')) {
      const row = [...this.audits].reverse().find((audit) => audit.action === "user.legacy_owner.migrated" && audit.details.sourceEntity === "la_user" && audit.details.legacyId === values[0]);
      return { rows: row ? [{ object_id: row.object_id, details: row.details } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT "id","password","legacyPasswordMd5","legacyPasswordSalt","legacyPasswordVersion","legacyPasswordUpgradedAt"')) {
      const row = [...this.credentials.values()].find((credential) => credential.userId === values[0] && credential.providerId === "credential");
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT 1 FROM "zzsh_iam"."audit_event"')) {
      const row = [...this.audits].reverse().find((audit) => audit.action === "user.legacy_password.upgraded" && audit.object_id === values[0] && audit.details.actorId === values[1]);
      return { rows: row ? [{ one: 1 } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO zzsh_iam.audit_event") || sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')) {
      this.audits.push({ object_id: String(values[6]), action: String(values[4]), details: JSON.parse(String(values[10])) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO "zzsh_auth_user"."user"')) {
      const row: UserRow = { id: String(values[0]), name: String(values[1]), email: String(values[2]), phoneNumber: String(values[4]), phoneNumberVerified: false, suspended: false };
      this.users.set(row.id, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO "zzsh_auth_user"."account"')) {
      const row: CredentialRow = { id: String(values[0]), userId: String(values[1]), providerId: "credential", password: null, legacyPasswordMd5: String(values[2]), legacyPasswordSalt: String(values[3]), legacyPasswordVersion: String(values[4]), legacyPasswordUpgradedAt: null };
      this.credentials.set(row.id, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO "zzsh_iam"."user_identity_state"')) {
      // The statement writes verified_at as a literal NULL: a source update time is not a verification time.
      const row: IdentityRow = { user_id: String(values[0]), account_status: String(values[1]), identity_status: String(values[2]), age_status: String(values[3]), provider: String(values[4]), provider_reference: String(values[5]), verified_at: null };
      this.identities.set(row.user_id, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT source_system,source_entity,legacy_id,source_digest,account_id,version_id,evidence_ref FROM zzsh_supply.legacy_supply_map WHERE account_id=$1")) {
      const row = this.maps.get(String(values[0]));
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT * FROM zzsh_supply.rental_account WHERE id=$1")) {
      const row = this.accounts.get(String(values[0]));
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('SELECT "owner_user_id","source_digest" FROM "zzsh_supply"."legacy_owner_binding"')) {
      const row = this.bindings.get(String(values[0]));
      return { rows: row ? [{ owner_user_id: row.owner_user_id, source_digest: row.source_digest } as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO "zzsh_supply"."legacy_owner_binding"')) {
      const row: BindingRow = { id: String(values[0]), account_id: String(values[1]), owner_user_id: String(values[2]), previous_owner_user_id: String(values[3]), source_system: String(values[4]), source_entity: String(values[5]), legacy_id: String(values[6]), source_digest: String(values[7]), owner_legacy_id: String(values[8]), owner_source_digest: String(values[9]), relation_digest: String(values[10]), evidence_ref: String(values[11]), bound_by_admin_id: String(values[12]), idempotency_key: String(values[13]) };
      this.bindings.set(row.account_id, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT count(*)::int AS ")) {
      const table = /FROM ([a-z_.]+) WHERE/.exec(sql)?.[1] ?? "";
      return { rows: [{ count: this.objectCounts.get(table) ?? 0 } as T], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE "zzsh_supply"."media_asset"')) {
      let count = 0;
      for (const row of this.media.values())
        if (row.account_id === values[0] && row.ownership_kind === "USER_SUPPLY") {
          row.owner_user_id = String(values[1]);
          count += 1;
        }
      return { rows: [], rowCount: count };
    }
    if (sql.startsWith('UPDATE "zzsh_supply"."rental_account"') || sql.startsWith("UPDATE zzsh_supply.rental_account")) {
      const row = this.accounts.get(String(values[0]));
      if (!row || row.owner_user_id !== String(values[2])) return { rows: [], rowCount: 0 };
      row.owner_user_id = String(values[1]);
      row.revision = String(Number(row.revision) + 1);
      return { rows: [{ id: row.id } as T], rowCount: 1 };
    }
    if (sql.includes("audit_event")) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')) {
      this.idempotency.set(`${values[0]}|${values[1]}`, { requestFingerprint: String(values[2]), responseStatus: Number(values[3]), responseBody: JSON.parse(String(values[4])), publishRequired: Boolean(values[5]) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled fake SQL: ${sql}`);
  }
}

function asClient(fake: FakeClient) {
  return fake as unknown as PoolClient;
}

function upgradeCredential(fake: FakeClient, userId: string) {
  const row = [...fake.credentials.values()].find((credential) => credential.userId === userId)!;
  row.password = "upgraded-password-hash";
  row.legacyPasswordMd5 = null;
  row.legacyPasswordSalt = null;
  row.legacyPasswordVersion = null;
  row.legacyPasswordUpgradedAt = "2026-10-09T13:00:00.000000Z";
  fake.audits.push({ object_id: row.id, action: "user.legacy_password.upgraded", details: { actorId: userId, actorType: "user", objectType: "auth_account" } });
}

test("legacy owner evidence is strict and its digest binds every status flag", () => {
  const payload = evidence();
  assert.equal(legacyOwnerEvidenceDigest(payload), legacyOwnerEvidenceDigest(evidence({ mobile: "+86 199-0000-0001" })));
  assert.throws(() => normalizeLegacyOwnerInput({ evidence: payload, evidenceDigest: "0".repeat(64) }), /digest does not match/);
  assert.throws(() => normalizeLegacyOwnerInput(input({ status: { realNameBound: true, ageAdult: true, disabled: false, deleted: false, extra: true } as never })), /status evidence/);
  assert.throws(() => normalizeLegacyOwnerInput(input({ mobile: "12345" })), /mobile/);
  assert.throws(() => normalizeLegacyOwnerInput(input({ legacyPassword: { version: "legacy-md5-v1", md5: "XYZ", salt: "s" } })), /password evidence/);
  assert.throws(() => normalizeLegacyOwnerInput(input({ sourceDigest: "short" })), /source reference/);
});
test("migrateLegacyOwner writes evidence-driven statuses and never invents a password", async () => {
  const fake = new FakeClient();
  const result = await migrateLegacyOwner(asClient(fake), input(), ACTOR);
  assert.equal(result.replayed, false);
  const user = fake.users.get(result.userId)!;
  assert.equal(user.phoneNumber, `+86${MOBILE}`);
  assert.equal(user.phoneNumberVerified, false);
  const identity = fake.identities.get(result.userId)!;
  assert.deepEqual(identity, {
    user_id: result.userId,
    account_status: "ACTIVE",
    identity_status: "VERIFIED",
    age_status: "ADULT",
    provider: "legacy_mysql_restore",
    provider_reference: "la_user:17998",
    verified_at: null,
  });
  assert.equal(fake.credentials.size, 0, "no legacy password means no credential row at all");
  const audit = fake.audits.find((entry) => entry.action === "user.legacy_owner.migrated")!;
  assert.equal(audit.details.evidenceDigest, input().evidenceDigest);
  assert.equal(audit.details.sourceUpdatedAt, "2026-09-12T13:43:54.000Z");
  assert.equal(audit.details.verifiedAt, undefined, "account update time is not a verification time");
  assert.equal(JSON.stringify(fake.audits).includes(MOBILE), false, "the audit trail must not carry the plain mobile");
});

test("unknown, minor, disabled and deleted evidence never upgrades", async () => {
  const unproven = new FakeClient();
  const unprovenResult = await migrateLegacyOwner(asClient(unproven), input({ status: { realNameBound: false, ageAdult: null, disabled: true, deleted: false } }), ACTOR);
  assert.deepEqual(unproven.identities.get(unprovenResult.userId), {
    user_id: unprovenResult.userId,
    account_status: "DEACTIVATED",
    identity_status: "UNVERIFIED",
    age_status: "UNKNOWN",
    provider: "legacy_mysql_restore",
    provider_reference: "la_user:17998",
    verified_at: null,
  });
  const minor = new FakeClient();
  const minorResult = await migrateLegacyOwner(asClient(minor), input({ status: { realNameBound: true, ageAdult: false, disabled: false, deleted: false } }), ACTOR);
  assert.equal(minor.identities.get(minorResult.userId)!.age_status, "MINOR");
  const deleted = new FakeClient();
  const deletedResult = await migrateLegacyOwner(asClient(deleted), input({ status: { realNameBound: true, ageAdult: true, disabled: false, deleted: true } }), ACTOR);
  assert.equal(deleted.identities.get(deletedResult.userId)!.account_status, "CANCELLED");
  assert.equal(deleted.credentials.size, 0);
});

test("a legacy password is preserved as an unusable local credential, not a random one", async () => {
  const fake = new FakeClient();
  const payload = evidence({ legacyPassword: { version: "legacy-md5-v1", md5: "d41d8cd98f00b204e9800998ecf8427e", salt: "ab1c2" } });
  const migrationInput: LegacyOwnerMigrationInput = { evidence: payload, evidenceDigest: legacyOwnerEvidenceDigest(payload) };
  const first = await migrateLegacyOwner(asClient(fake), migrationInput, ACTOR);
  const credential = [...fake.credentials.values()][0]!;
  assert.equal(credential.password, null);
  assert.equal(credential.legacyPasswordMd5, "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(credential.legacyPasswordSalt, "ab1c2");
  assert.equal(credential.legacyPasswordVersion, "legacy-md5-v1");
  const replay = await migrateLegacyOwner(asClient(fake), migrationInput, ACTOR);
  assert.deepEqual(replay, { userId: first.userId, replayed: true });
  assert.equal(fake.credentials.size, 1);
});

test("same source replays to the same user and changed evidence conflicts", async () => {
  const fake = new FakeClient();
  const first = await migrateLegacyOwner(asClient(fake), input(), ACTOR);
  assert.deepEqual(await migrateLegacyOwner(asClient(fake), input(), ACTOR), { userId: first.userId, replayed: true });
  await assert.rejects(() => migrateLegacyOwner(asClient(fake), input({ sourceDigest: "b".repeat(64) }), ACTOR), /Idempotency key was reused/);
  const freshAdmin = { ...ACTOR, id: "admin-3", requestId: "request-3" };
  await assert.rejects(() => migrateLegacyOwner(asClient(fake), input({ nickname: "改名冒充" }), freshAdmin), /conflicts with an existing local user/);
  await assert.rejects(() => migrateLegacyOwner(asClient(fake), input({ status: { realNameBound: false, ageAdult: null, disabled: false, deleted: false } }), freshAdmin), /identity record conflicts/);
  assert.equal(fake.users.size, 2, "only the stand-in plus the migrated user exist");
  assert.equal(fake.identities.size, 1);
});

test("an upgraded legacy credential replays compatibly and stays read-only", async () => {
  const fake = new FakeClient();
  const payload = evidence({ legacyPassword: { version: "legacy-md5-v1", md5: "d41d8cd98f00b204e9800998ecf8427e", salt: "ab1c2" } });
  const migrationInput: LegacyOwnerMigrationInput = { evidence: payload, evidenceDigest: legacyOwnerEvidenceDigest(payload) };
  const first = await migrateLegacyOwner(asClient(fake), migrationInput, ACTOR);
  upgradeCredential(fake, first.userId);
  const credentialBefore = { ...[...fake.credentials.values()][0]! };
  const identityBefore = { ...fake.identities.get(first.userId)! };
  const auditsBefore = fake.audits.length;
  const freshAdmin = { ...ACTOR, id: "admin-4", requestId: "request-4" };
  const replay = await migrateLegacyOwner(asClient(fake), migrationInput, freshAdmin);
  assert.deepEqual(replay, { userId: first.userId, replayed: false }, "a fresh admin's same-source replay is accepted without rewriting state");
  assert.deepEqual([...fake.credentials.values()][0], credentialBefore, "the upgraded credential is never rewritten");
  assert.deepEqual(fake.identities.get(first.userId), identityBefore, "identity state is never rewritten");
  assert.equal(fake.audits.length, auditsBefore, "a compatible replay writes no audit");
  assert.equal(credentialBefore.legacyPasswordMd5, null);
});

test("an upgraded credential without its upgrade audit still conflicts", async () => {
  const fake = new FakeClient();
  const payload = evidence({ legacyPassword: { version: "legacy-md5-v1", md5: "d41d8cd98f00b204e9800998ecf8427e", salt: "ab1c2" } });
  const migrationInput: LegacyOwnerMigrationInput = { evidence: payload, evidenceDigest: legacyOwnerEvidenceDigest(payload) };
  const first = await migrateLegacyOwner(asClient(fake), migrationInput, ACTOR);
  upgradeCredential(fake, first.userId);
  fake.audits.splice(fake.audits.findIndex((audit) => audit.action === "user.legacy_password.upgraded"), 1);
  const freshAdmin = { ...ACTOR, id: "admin-5", requestId: "request-5" };
  await assert.rejects(() => migrateLegacyOwner(asClient(fake), migrationInput, freshAdmin), /credential conflicts with the supplied evidence/);
});

test("a password set with residual legacy md5 stays a conflict", async () => {
  const fake = new FakeClient();
  const payload = evidence({ legacyPassword: { version: "legacy-md5-v1", md5: "d41d8cd98f00b204e9800998ecf8427e", salt: "ab1c2" } });
  const migrationInput: LegacyOwnerMigrationInput = { evidence: payload, evidenceDigest: legacyOwnerEvidenceDigest(payload) };
  const first = await migrateLegacyOwner(asClient(fake), migrationInput, ACTOR);
  upgradeCredential(fake, first.userId);
  const row = [...fake.credentials.values()][0]!;
  row.legacyPasswordMd5 = "d41d8cd98f00b204e9800998ecf8427e";
  row.legacyPasswordSalt = "ab1c2";
  row.legacyPasswordVersion = "legacy-md5-v1";
  const freshAdmin = { ...ACTOR, id: "admin-6", requestId: "request-6" };
  await assert.rejects(() => migrateLegacyOwner(asClient(fake), migrationInput, freshAdmin), /credential conflicts with the supplied evidence/);
});

test("a mobile already owned by another user and missing permission are rejected", async () => {
  const occupied = new FakeClient();
  occupied.users.set("user-other", { id: "user-other", name: "其他用户", email: "other@example.invalid", phoneNumber: `+86${MOBILE}`, phoneNumberVerified: true, suspended: false });
  await assert.rejects(() => migrateLegacyOwner(asClient(occupied), input(), ACTOR), /conflicts with an existing local user/);
  const noPermission = new FakeClient();
  noPermission.permission = false;
  await assert.rejects(() => migrateLegacyOwner(asClient(noPermission), input(), ACTOR), /Permission required/);
  assert.equal(noPermission.users.size, 1);
});

test("an UNKNOWN idempotency read recovers with the original intent", async () => {
  const fake = new FakeClient();
  fake.failNextIdempotencyRead = true;
  await assert.rejects(() => migrateLegacyOwner(asClient(fake), input(), ACTOR), /UNKNOWN idempotency read/);
  assert.equal(fake.identities.size, 0);
  const recovered = await migrateLegacyOwner(asClient(fake), input(), ACTOR);
  assert.equal(fake.identities.size, 1);
  assert.equal(recovered.replayed, false);
});
