import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { prepareLegacyPathRecord, recordLegacyPathRecord, recordLegacyPathRecords } from "../src/legacy-load/legacy-path-records";

const source = { id: "11", user_id: "22", img_paths: "accountsImage/20261103/a.png, accountsImage/20261103/b.jpg,accountsImage/20261103/a.png", punishment_img_url: "accountsImage/20261102/c.jpg" };
const actor = { id: "admin_1", sessionId: "session_1", requestId: "request_1" };

function fakeClient(active = true) {
  let stored: { accountId: string; observationVersionId: string; sourceDigest: string; displayPaths: string[]; penaltyPaths: string[] } | null = null;
  let writes = 0, audits = 0;
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls, get writes() { return writes; }, get audits() { return audits; },
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: active ? [{ locked: false, twoFactorEnabled: true, suspended: false }] : [] };
      if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: active ? [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] : [] };
      if (sql.includes('SELECT "role_id" AS "roleId" FROM "zzsh_iam"."admin_user_role"')) return { rows: [] };
      if (sql.includes("JOIN zzsh_supply.legacy_supply_map")) return { rows: [{ accountId: "account_1", ownerUserId: prepareLegacyPathRecord(source).ownerUserId, legacyId: "11", gameId: "game_1", observationVersionId: "version_1", sourceDigest: prepareLegacyPathRecord(source).sourceDigest }] };
      if (sql.startsWith("SELECT account_id AS")) return { rows: stored ? [stored] : [] };
      if (sql.startsWith("INSERT INTO zzsh_supply.legacy_account_media_paths")) { writes++; stored = JSON.parse(String(values[0]))[0]; return { rows: [], rowCount: 1 }; }
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { audits++; return { rows: [], rowCount: 1 }; }
      throw new Error("UNEXPECTED_SQL");
    },
  };
}

test("source paths are ordered arrays bound to the entire source row", () => {
  const result = prepareLegacyPathRecord(source);
  assert.deepEqual(result.displayPaths, ["accountsImage/20261103/a.png", "accountsImage/20261103/b.jpg"]);
  assert.deepEqual(result.penaltyPaths, ["accountsImage/20261102/c.jpg"]);
  assert.notEqual(result.sourceDigest, prepareLegacyPathRecord({ ...source, user_id: "23" }).sourceDigest);
  assert.throws(() => prepareLegacyPathRecord({ ...source, img_paths: "../private.png" }));
});

test("two accounts use one session check and one batched mapping/insert", async () => {
  const source2 = { ...source, id: "12", user_id: "23" }, records = [source, source2];
  let sessionChecks = 0, mappingQueries = 0, inserts = 0;
  const client = { async query(sql: string) {
    if (sql.includes('FROM "zzsh_auth_admin"."session"')) { sessionChecks++; return { rows: [{ locked: false, twoFactorEnabled: true, suspended: false }] }; }
    if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] };
    if (sql.includes('SELECT "role_id" AS "roleId" FROM "zzsh_iam"."admin_user_role"')) return { rows: [] };
    if (sql.includes("JOIN zzsh_supply.legacy_supply_map")) { mappingQueries++; return { rows: records.map((row, index) => ({ accountId: `account_${index + 1}`, ownerUserId: prepareLegacyPathRecord(row).ownerUserId, legacyId: row.id, gameId: "game_1", observationVersionId: `version_${index + 1}`, sourceDigest: prepareLegacyPathRecord(row).sourceDigest })) }; }
    if (sql.startsWith("SELECT account_id AS")) return { rows: [] };
    if (sql.startsWith("INSERT INTO zzsh_supply.legacy_account_media_paths")) { inserts++; return { rows: [] }; }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) return { rows: [] };
    throw new Error("UNEXPECTED_SQL");
  } } as unknown as PoolClient;
  const result = await recordLegacyPathRecords(client, records.map((sourceRow, index) => ({ accountId: `account_${index + 1}`, sourceRow })), actor);
  assert.deepEqual(result, { inserted: 2, replayed: 0 }); assert.equal(sessionChecks, 1); assert.equal(mappingQueries, 1); assert.equal(inserts, 1);
});

test("recording checks the original mapping and replays without duplicate writes", async () => {
  const fake = fakeClient(), client = fake as unknown as PoolClient;
  assert.deepEqual(await recordLegacyPathRecord(client, "account_1", source, actor), { accountId: "account_1", replayed: false });
  assert.deepEqual(await recordLegacyPathRecord(client, "account_1", source, actor), { accountId: "account_1", replayed: true });
  assert.equal(fake.writes, 1); assert.equal(fake.audits, 1);
  const audit = fake.calls.find(call => call.sql.includes('INSERT INTO "zzsh_iam"."audit_event"'))!;
  assert.doesNotMatch(String(audit.values.at(-1)), /accountsImage/);
  await assert.rejects(recordLegacyPathRecord(client, "account_1", { ...source, user_id: "23" }, actor));
  assert.equal(fake.writes, 1);
});

test("an unauthorized actor cannot record source paths", async () => {
  const fake = fakeClient(false);
  await assert.rejects(recordLegacyPathRecord(fake as unknown as PoolClient, "account_1", source, actor));
  assert.equal(fake.writes, 0); assert.equal(fake.audits, 0);
});

test("a permitted administrator outside the account game scope cannot write", async () => {
  const fake = fakeClient(), base = fake.query.bind(fake);
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes('FROM "zzsh_iam"."admin_security"') && !sql.includes("game_scope_mode")) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }] };
    if (sql.includes("WITH role_permissions")) return { rows: [{ permissionCode: "supply.catalog.manage" }] };
    if (sql.includes("game_scope_mode")) return { rows: [{ mode: "SELECTED_GAMES", gameIds: ["other_game"] }] };
    return base(sql, values);
  } } as unknown as PoolClient;
  await assert.rejects(recordLegacyPathRecord(client, "account_1", source, actor));
  assert.equal(fake.writes, 0); assert.equal(fake.audits, 0);
});
