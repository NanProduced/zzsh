import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { accountNumberCandidates, assignAccountNumber, parseAccountNumber, prepareAccountNumberBackfill } from "../src/supply/account-number";
import { parseNumberLookupQuery } from "../src/supply/public-listing-lookup";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createHash } from "node:crypto";

function numberClient() {
  type Row = { id: string; display_no: string | null; legacyNumber: string | null; sourceMapped: boolean; game: string };
  const rows = new Map<string, Row>([
    ["native-a", { id: "native-a", display_no: null, legacyNumber: null, sourceMapped: false, game: "game-a" }],
    ["native-b", { id: "native-b", display_no: null, legacyNumber: null, sourceMapped: false, game: "game-a" }],
    ["legacy-a", { id: "legacy-a", display_no: null, legacyNumber: "0000123", sourceMapped: true, game: "game-a" }],
  ]);
  const writes: string[] = [], reads: string[] = []; let sequence = 0, ready = true, failUpdate = false;
  const client = { query: async (sql: string, args: any[] = []) => {
    reads.push(sql); let result: unknown[] = [];
    if (sql.includes("SELECT id,display_no") && sql.includes("FOR UPDATE")) result = rows.has(args[0]) ? [rows.get(args[0])!] : [];
    else if (sql.includes("to_regprocedure")) result = [{ ready }];
    else if (sql.includes("SELECT zzsh_supply.next_account_display_no()")) result = [{ number: "AC" + String(++sequence).padStart(10, "0") }];
    else if (sql.includes("UPDATE zzsh_supply.rental_account")) { if (failUpdate) throw Object.assign(new Error("unique fixture"), { code: "23505" }); rows.get(args[0])!.display_no = args[1]; writes.push(args[0]); }
    else if (sql.includes("WHERE a.id<>$2")) result = [...rows.values()].filter(r => r.id !== args[1] && (r.display_no === args[0] || r.legacyNumber === args[0])).slice(0, 1);
    else if (sql.includes("SELECT DISTINCT a.id")) result = [...rows.values()].filter(r => (!args[1] || r.game === args[1]) && (r.display_no === args[0] || r.legacyNumber === args[0])).map(r => ({ id: r.id }));
    else if (sql.includes("WHERE a.id=$1")) result = rows.has(args[0]) ? [rows.get(args[0])!] : [];
    else if (sql.includes("ORDER BY a.id LIMIT $2")) result = [...rows.values()].filter(r => !args[0] || r.id > args[0]).slice(0, args[1]);
    else throw new Error("Unexpected number query");
    return { rows: result, rowCount: result.length };
  } } as unknown as PoolClient;
  return { client, rows, writes, reads, sequence: () => sequence, ready: (value: boolean) => { ready = value; }, failUpdate: () => { failUpdate = true; } };
}

test("real allocator persists a stable independent AC number and replay does not consume again", async () => {
  const f = numberClient(); const first = await assignAccountNumber(f.client, "native-a");
  assert.equal(first, "AC0000000001"); assert.equal(f.rows.get("native-a")!.display_no, first);
  assert.equal(await assignAccountNumber(f.client, "native-a"), first); assert.equal(f.sequence(), 1); assert.deepEqual(f.writes, ["native-a"]);
  assert(!f.reads.some(q => q.includes("zzsh_order") || q.includes("admin_login")));
});
test("distinct account assignments use the same caller client and retain distinct numbers", async () => {
  const f = numberClient(); const one = await assignAccountNumber(f.client, "native-a"), two = await assignAccountNumber(f.client, "native-b");
  assert.notEqual(one, two); assert.equal(f.writes.length, 2);
  // This is not a PostgreSQL concurrency proof; the sequence/UNIQUE race is NOT_RUN.
});
test("native takeover keeps a trusted old number including leading zeroes, without consuming AC", async () => {
  const f = numberClient(); assert.equal(await assignAccountNumber(f.client, "legacy-a"), "0000123"); assert.equal(f.sequence(), 0);
  assert.deepEqual(await accountNumberCandidates(f.client, "0000123", "game-a"), ["legacy-a"]);
});
test("mapped but missing old-number evidence and conflicting aliases stop assignment", async () => {
  const f = numberClient(); f.rows.get("legacy-a")!.legacyNumber = null;
  await assert.rejects(assignAccountNumber(f.client, "legacy-a"), /来源待核定/); assert.equal(f.sequence(), 0);
  f.rows.get("legacy-a")!.legacyNumber = "0000123"; f.rows.set("other", { ...f.rows.get("legacy-a")!, id: "other", game: "game-b" });
  await assert.rejects(assignAccountNumber(f.client, "legacy-a"), /唯一核定/); assert.equal(f.writes.length, 0);
  assert.equal((await accountNumberCandidates(f.client, "0000123", null)).length, 2);
  assert.deepEqual(await accountNumberCandidates(f.client, "0000123", "game-a"), ["legacy-a"]);
});

test("same-game duplicate old numbers remain ambiguous and are not assigned to either target", async () => {
  const f = numberClient(); f.rows.set("same-game-target", { ...f.rows.get("legacy-a")!, id: "same-game-target" });
  assert.equal((await accountNumberCandidates(f.client, "0000123", "game-a")).length, 2);
  for (const accountId of ["legacy-a", "same-game-target"])
    await assert.rejects(assignAccountNumber(f.client, accountId), (e: any) => e.status === 409);
  assert.equal(f.writes.length, 0); assert.equal(f.sequence(), 0);
  const plan = await prepareAccountNumberBackfill(f.client);
  assert(plan.items.filter(item => ["legacy-a", "same-game-target"].includes(item.accountId)).every(item => item.action === "REVIEW_CONFLICT" && !item.writeAllowed));
});
test("missing allocator capability and unique constraint failure never return success", async () => {
  const f = numberClient(); f.ready(false);
  await assert.rejects(assignAccountNumber(f.client, "native-a"), (e: any) => e.status === 503); assert.equal(f.writes.length, 0);
  f.ready(true); f.failUpdate(); await assert.rejects(assignAccountNumber(f.client, "native-a"), (e: any) => e.status === 409); assert.equal(f.rows.get("native-a")!.display_no, null);
});
test("backfill preparation separates existing, source, conflict and new assignment; it never writes", async () => {
  const f = numberClient(); f.rows.get("native-a")!.display_no = "EXISTING"; f.rows.get("legacy-a")!.legacyNumber = null;
  const plan = await prepareAccountNumberBackfill(f.client); assert.equal(plan.writeAllowed, false);
  assert.deepEqual(new Set(plan.items.map(r => r.action)), new Set(["KEEP_EXISTING", "REVIEW_SOURCE", "ALLOCATE_NATIVE"])); assert.equal(f.writes.length, 0); assert.equal(f.sequence(), 0);
});
test("number/query shape remains exact text, rejects duplicate/mixed parameters and preserves literal characters", () => {
  assert.equal(parseAccountNumber(" 0000123 "), "0000123"); assert.equal(parseAccountNumber("A%_1"), "A%_1");
  assert.deepEqual(parseNumberLookupQuery(new URLSearchParams("number=0000123&gameId=game-a")), { number: "0000123", gameId: "game-a" });
  for (const value of [null, 123, "", "a\u0000b", "x".repeat(129)]) assert.throws(() => parseAccountNumber(value));
  for (const value of ["number=A&number=B", "number=A&q=B", "number=A&cursor=x", "number=A&gameId=a&gameId=b"]) assert.throws(() => parseNumberLookupQuery(new URLSearchParams(value)));
});
test("account numbering appends its own migration without changing the accepted 81-chain", () => {
  const migrations = readMigrationFiles({ migrationsFolder: "migrations/business" }); assert.ok(migrations.length >= 82, "the accepted 81-chain plus 0081 must stay registered");
  const prefix = JSON.stringify(migrations.slice(0, 81).map(m => ({ hash: m.hash, when: String(m.folderMillis) })));
  assert.equal(createHash("sha256").update(prefix).digest("hex"), "bacf5951e5ba9b01e883e62936f545e7d9f31947c81e3aab30a1f787e4d05151");
  // Later companion migrations (e.g. 0082) may append after 0081; they never enter the accepted chain.
  assert.equal(migrations[81]?.folderMillis, 1792147352619);
  for (const migration of migrations.slice(82)) assert.ok(Number(migration.folderMillis) > 1792147352619);
});
