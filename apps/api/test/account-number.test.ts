import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { accountNumberCandidates, assignAccountNumber, parseAccountNumber, prepareAccountNumberBackfill, publicAccountNumber, PUBLIC_ACCOUNT_NUMBER_PATTERN } from "../src/supply/account-number";
import { parseNumberLookupQuery } from "../src/supply/public-listing-lookup";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createHash } from "node:crypto";
import { candidatePredicates } from "../src/supply/listing-candidates";
import { withIdempotency } from "../src/supply/supply-util";

function numberClient() {
  type Row = { id: string; display_no: string | null; legacyNumber: string | null; sourceMapped: boolean; game: string };
  const rows = new Map<string, Row>([
    ["native-a", { id: "native-a", display_no: null, legacyNumber: null, sourceMapped: false, game: "game-a" }],
    ["native-b", { id: "native-b", display_no: null, legacyNumber: null, sourceMapped: false, game: "game-a" }],
    ["legacy-a", { id: "legacy-a", display_no: null, legacyNumber: "0000123", sourceMapped: true, game: "game-a" }],
  ]);
  const writes: string[] = [], reads: string[] = [], counters = new Map<string, bigint>();
  let sequence = 0, ready = true, failUpdate = false, date = "2026-10-18";
  const client = { query: async (sql: string, args: any[] = []) => {
    reads.push(sql); let result: unknown[] = [], changed: number | undefined;
    if (sql.includes("SELECT id,display_no") && sql.includes("FOR UPDATE")) result = rows.has(args[0]) ? [rows.get(args[0])!] : [];
    else if (sql.includes("to_regprocedure")) result = [{ ready }];
    else if (sql.includes("SELECT zzsh_supply.next_dated_account_display_no()")) {
      const next = (counters.get(date) ?? 0n) + 1n;
      if (next > 999999n) throw Object.assign(new Error("ACCOUNT_NUMBER_DAY_EXHAUSTED"), { code: "54000" });
      counters.set(date, next); sequence++;
      result = [{ number: "ZZ" + date.replaceAll("-", "") + next.toString().padStart(6, "0") }];
    }
    else if (sql.includes("UPDATE zzsh_supply.rental_account")) { if (failUpdate) throw Object.assign(new Error("unique fixture"), { code: "23505" }); rows.get(args[0])!.display_no = args[1]; writes.push(args[0]); changed=1; }
    else if (sql.includes("WHERE a.id<>$2")) result = [...rows.values()].filter(r => r.id !== args[1] && r.display_no === args[0]).slice(0, 1);
    else if (sql.includes("SELECT DISTINCT a.id")) result = [...rows.values()].filter(r => (!args[1] || r.game === args[1]) && (r.display_no === args[0] || sql.includes("h.snapshot") && r.legacyNumber === args[0])).map(r => ({ id: r.id }));
    else if (sql.includes("WHERE a.id=$1")) result = rows.has(args[0]) ? [rows.get(args[0])!] : [];
    else if (sql.includes("ORDER BY a.id LIMIT $2")) result = [...rows.values()].filter(r => !args[0] || r.id > args[0]).slice(0, args[1]);
    else throw new Error("Unexpected number query");
    return { rows: result, rowCount: changed ?? result.length };
  } } as unknown as PoolClient;
  return { client, rows, writes, reads, counters, date: (value: string) => { date = value; }, sequence: () => sequence, ready: (value: boolean) => { ready = value; }, failUpdate: () => { failUpdate = true; } };
}

test("real allocator persists a stable independent ZZ date number and replay does not consume again", async () => {
  const f = numberClient(); const first = await assignAccountNumber(f.client, "native-a");
  assert.equal(first, "ZZ20261018000001"); assert.equal(f.rows.get("native-a")!.display_no, first);
  assert.equal(await assignAccountNumber(f.client, "native-a"), first); assert.equal(f.sequence(), 1); assert.deepEqual(f.writes, ["native-a"]);
  assert(!f.reads.some(q => q.includes("zzsh_order") || q.includes("admin_login")));
});
test("distinct account assignments use the same caller client and retain distinct numbers", async () => {
  const f = numberClient(); const [one, two] = await Promise.all([assignAccountNumber(f.client, "native-a"), assignAccountNumber(f.client, "native-b")]);
  assert.notEqual(one, two); assert.equal(f.writes.length, 2);
  // Real concurrent calls, but a fake client: PostgreSQL UPSERT/UNIQUE races remain NOT_RUN.
});
test("native takeover uses a new canonical number and preserves old leading zeroes only for internal aliases", async () => {
  const f = numberClient(); assert.equal(await assignAccountNumber(f.client, "legacy-a"), "ZZ20261018000001"); assert.equal(f.sequence(), 1);
  assert.deepEqual(await accountNumberCandidates(f.client, "0000123", "game-a"), ["legacy-a"]);
});
test("missing or duplicate old aliases do not determine new canonical allocation", async () => {
  const f = numberClient(); f.rows.get("legacy-a")!.legacyNumber = null;
  assert.equal(await assignAccountNumber(f.client, "legacy-a"),'ZZ20261018000001'); assert.equal(f.sequence(), 1);
  f.rows.get("legacy-a")!.legacyNumber = "0000123"; f.rows.set("other", { ...f.rows.get("legacy-a")!, id: "other", game: "game-b" });
  assert.equal(await assignAccountNumber(f.client, "legacy-a"),'ZZ20261018000001'); assert.equal(f.writes.length, 1);
  assert.equal((await accountNumberCandidates(f.client, "0000123", null)).length, 2);
  assert.deepEqual(await accountNumberCandidates(f.client, "0000123", "game-a"), ["legacy-a"]);
});

test("same-game old aliases remain ambiguous internally while canonical assignments stay independent", async () => {
  const f = numberClient(); f.rows.set("same-game-target", { ...f.rows.get("legacy-a")!, id: "same-game-target" });
  assert.equal((await accountNumberCandidates(f.client, "0000123", "game-a")).length, 2);
  for (const accountId of ["legacy-a", "same-game-target"])
    assert.match(await assignAccountNumber(f.client, accountId),/^ZZ20261018\d{6}$/);
  assert.equal(f.writes.length, 2); assert.equal(f.sequence(), 2);
  const plan = await prepareAccountNumberBackfill(f.client);
  assert(plan.items.filter(item => ["legacy-a", "same-game-target"].includes(item.accountId)).every(item => item.action === "KEEP_EXISTING" && !item.writeAllowed));
});
test("missing allocator capability and unique constraint failure never return success", async () => {
  const f = numberClient(); f.ready(false);
  await assert.rejects(assignAccountNumber(f.client, "native-a"), (e: any) => e.status === 503); assert.equal(f.writes.length, 0);
  f.ready(true); f.failUpdate(); await assert.rejects(assignAccountNumber(f.client, "native-a"), (e: any) => e.status === 409); assert.equal(f.rows.get("native-a")!.display_no, null);
});
test("backfill preparation separates existing, source, conflict and new assignment; it never writes", async () => {
  const f = numberClient(); f.rows.get("native-a")!.display_no = "EXISTING"; f.rows.get("legacy-a")!.legacyNumber = null;
  const plan = await prepareAccountNumberBackfill(f.client); assert.equal(plan.writeAllowed, false);
  assert.deepEqual(new Set(plan.items.map(r => r.action)), new Set(["REVIEW_CANONICAL", "PUBLIC_ADMISSION_REQUIRED", "ALLOCATE_NATIVE"])); assert.equal(f.writes.length, 0); assert.equal(f.sequence(), 0);
});
test("number/query shape remains exact text, rejects duplicate/mixed parameters and preserves literal characters", () => {
  assert.equal(parseAccountNumber(" 0000123 "), "0000123"); assert.equal(parseAccountNumber("A%_1"), "A%_1");
  assert.deepEqual(parseNumberLookupQuery(new URLSearchParams("number=AC0000000001&gameId=game-a")), { number: "AC0000000001", gameId: "game-a" });
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

test("legacy canonical assignment uses the dated counter independently of old aliases", async () => {
  const f=numberClient();f.rows.set('duplicate-old',{...f.rows.get('legacy-a')!,id:'duplicate-old'});
  const number=await assignAccountNumber(f.client,'legacy-a');
  assert.match(number,/^ZZ20261018\d{6}$/);assert.notEqual(number,'0000123');assert.equal(f.sequence(),1);
  assert.equal(await assignAccountNumber(f.client,'legacy-a'),number);assert.equal(f.sequence(),1);
  assert.equal((await accountNumberCandidates(f.client,'0000123','game-a')).length,2);
});

test("a pre-existing legacy alias in the canonical field stops rather than being kept or overwritten",async()=>{
 const f=numberClient();f.rows.get('legacy-a')!.display_no='0000123';
 await assert.rejects(assignAccountNumber(f.client,'legacy-a'),(e:any)=>e.status===409);
 assert.equal(f.sequence(),0);assert.equal(f.writes.length,0);assert.equal(f.rows.get('legacy-a')!.display_no,'0000123');
});

test("public lookup rejects old or internal identifiers before a candidate query",()=>{
 for(const number of ['0000123','legacy_account_a','AC1','ac0000000001','A%_1'])assert.throws(()=>parseNumberLookupQuery(new URLSearchParams({number})),(e:any)=>e.status===400);
 assert.equal(parseNumberLookupQuery(new URLSearchParams('number=AC0000000001')).number,'AC0000000001');
});

test("public canonical candidates never consult aliases; internal alias ambiguity is preserved",async()=>{
 const f=numberClient();f.rows.get('native-a')!.display_no='AC0000000001';f.rows.get('legacy-a')!.legacyNumber='AC0000000001';
 assert.deepEqual(await accountNumberCandidates(f.client,'AC0000000001','game-a',false),['native-a']);
 assert(!f.reads.at(-1)!.includes('legacy_supply_map'));assert.equal((await accountNumberCandidates(f.client,'AC0000000001','game-a')).length,2);
});

test("a generated canonical collision stops without writing or choosing another number",async()=>{
 const f=numberClient();f.rows.get('native-b')!.display_no='ZZ20261018000001';
 await assert.rejects(assignAccountNumber(f.client,'native-a'),(e:any)=>e.status===409);
 assert.equal(f.sequence(),1);assert.equal(f.writes.length,0);assert.equal(f.rows.get('native-a')!.display_no,null);
});

test("an empty conditional update never returns an unpersisted generated number",async()=>{
 const f=numberClient(),client={query:async(sql:string,args:unknown[])=>sql.startsWith('UPDATE zzsh_supply.rental_account')?{rows:[],rowCount:0}:f.client.query(sql,args)} as unknown as PoolClient;
 await assert.rejects(assignAccountNumber(client,'native-a'),(e:any)=>e.status===409);
 assert.equal(f.sequence(),1);assert.equal(f.rows.get('native-a')!.display_no,null);assert.equal(f.writes.length,0);
});

test("dated ZZ canonical numbers preserve calendar dates, nonzero counters and exact text alongside existing AC", () => {
  for (const number of ["ZZ20261018000001", "ZZ20240229999999", "ZZ20000229000001", "ZZ99991231999999", "AC0000000001", "AC9007199254740993"])
    assert.equal(publicAccountNumber(number), number);
  for (const number of ["ZZ20260229000001", "ZZ19000229000001", "ZZ20260431000001", "ZZ20261301000001", "ZZ00000101000001", "ZZ20261018000000", "ZZ202610181000000", "zz20261018000001", "20261018000001", 20261018000001])
    assert.equal(publicAccountNumber(number), null);
});

test("public ZZ lookup requires a persisted match and never interprets an old alias or UUID as a new number", async () => {
  const f = numberClient(); f.rows.get("native-a")!.display_no = "ZZ20261018000001";
  f.rows.get("legacy-a")!.legacyNumber = "ZZ20261018000002";
  assert.equal(parseNumberLookupQuery(new URLSearchParams("number=ZZ20261018000001")).number, "ZZ20261018000001");
  assert.deepEqual(await accountNumberCandidates(f.client, "ZZ20261018000001", null, false), ["native-a"]);
  assert.deepEqual(await accountNumberCandidates(f.client, "ZZ20261018000002", null, false), []);
  assert(!f.reads.at(-1)!.includes("legacy_supply_map")); assert.equal(f.writes.length, 0);
});

test("an old AC allocator alone is not sufficient capability and must never be consumed", async () => {
  const f = numberClient();
  const client = { query: async (sql: string, args: unknown[]) => sql.includes("to_regprocedure")
    ? { rows: [{ ready: !sql.includes("next_dated_account_display_no") }], rowCount: 1 }
    : f.client.query(sql, args) } as unknown as PoolClient;
  await assert.rejects(assignAccountNumber(client, "native-a"), (e: any) => e.status === 503);
  assert.equal(f.sequence(), 0); assert.equal(f.writes.length, 0);
});

test("new assignments reject a generator returning a compatibility AC number", async () => {
  const f = numberClient();
  const client = { query: async (sql: string, args: unknown[]) => sql.includes("SELECT zzsh_supply.next_dated_account_display_no()")
    ? { rows: [{ number: "AC0000000001" }], rowCount: 1 }
    : f.client.query(sql, args) } as unknown as PoolClient;
  await assert.rejects(assignAccountNumber(client, "native-a"), (e: any) => e.status === 503);
  assert.equal(f.writes.length, 0);
});

test("existing AC and ZZ assignments replay without consulting a new allocator or rewriting any value", async () => {
  const f = numberClient(); f.ready(false);
  for (const number of ["AC9007199254740993", "ZZ20261018000009"]) {
    f.rows.get("native-a")!.display_no = number;
    assert.equal(await assignAccountNumber(f.client, "native-a"), number);
  }
  assert.equal(f.sequence(), 0); assert.equal(f.writes.length, 0);
  assert(!f.reads.some(sql => sql.includes("to_regprocedure") || sql.includes("next_dated_account_display_no")));
});

test("a database-day change starts its own counter without changing yesterday's assigned number", async () => {
  const f = numberClient(); f.counters.set("2026-10-18", 999998n);
  const previous = await assignAccountNumber(f.client, "native-a");
  f.date("2026-10-19");
  assert.equal(await assignAccountNumber(f.client, "native-b"), "ZZ20261019000001");
  assert.equal(previous, "ZZ20261018999999"); assert.equal(await assignAccountNumber(f.client, "native-a"), previous);
  assert.equal(f.counters.get("2026-10-18"), 999999n);
  // The date here is supplied by a fake PG function; real Shanghai clock/UTC boundary probes are separate.
});

test("the six-digit daily limit fails closed without wrapping or changing an account", async () => {
  const f = numberClient(); f.counters.set("2026-10-18", 999999n);
  await assert.rejects(assignAccountNumber(f.client, "native-a"), (e: any) => e.status === 503 && e.code === "EVIDENCE_UNAVAILABLE");
  assert.equal(f.rows.get("native-a")!.display_no, null); assert.equal(f.writes.length, 0);
  assert.equal(f.counters.get("2026-10-18"), 999999n);
  const fault = Object.assign(new Error("unrelated database fault"), { code: "54000" });
  const client = { query: async (sql: string, args: unknown[]) => {
    if (sql.includes("SELECT zzsh_supply.next_dated_account_display_no()")) throw fault;
    return f.client.query(sql, args);
  } } as unknown as PoolClient;
  await assert.rejects(assignAccountNumber(client, "native-a"), error => error === fault);
});

test("market number search uses the common lexical namespace and keeps the query as a string", () => {
  const values: unknown[] = [];
  const clauses = candidatePredicates({}, "ZZ20261018000001", value => { values.push(value); return "$1"; });
  assert(clauses[0]?.includes(`a.display_no ~ '${PUBLIC_ACCOUNT_NUMBER_PATTERN}'`));
  assert.deepEqual(values, ["%ZZ20261018000001%"]);
  assert(new RegExp(PUBLIC_ACCOUNT_NUMBER_PATTERN).test("ZZ20261018000001"));
  assert(new RegExp(PUBLIC_ACCOUNT_NUMBER_PATTERN).test("AC0000000001"));
  assert(!new RegExp(PUBLIC_ACCOUNT_NUMBER_PATTERN).test("0000123"));
});

test("the existing idempotency command replays the original date number across days and rejects a changed body", async () => {
  const f = numberClient(); let receipt: unknown[] = [], authorizationCalls = 0;
  const client = { query: async (sql: string, args: any[] = []) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM "zzsh_supply"."idempotency_record"')) return { rows: receipt, rowCount: receipt.length };
    if (sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) {
      receipt = [{ requestFingerprint: args[2], responseStatus: args[3], responseBody: JSON.parse(args[4]), publishRequired: args[5] }];
      return { rows: [], rowCount: 1 };
    }
    return f.client.query(sql, args);
  } } as unknown as PoolClient;
  const scope = { realm: "user" as const, principalId: "owner", operation: "supply.account.create" };
  const authorize = async () => { authorizationCalls++; };
  const action = async () => ({ status: 201, body: { displayNo: await assignAccountNumber(client, "native-a") } });
  const first = await withIdempotency(client, scope, "original-key", "original-body", authorize, action);
  f.date("2026-10-19"); f.ready(false);
  const replay = await withIdempotency(client, scope, "original-key", "original-body", authorize, action);
  assert.deepEqual(replay.body, first.body); assert.equal(replay.replayed, true); assert.equal(authorizationCalls, 2);
  assert.equal(f.sequence(), 1); assert.deepEqual(f.writes, ["native-a"]);
  await assert.rejects(withIdempotency(client, scope, "original-key", "changed-body", authorize, action), (e: any) => e.status === 409);
  assert.equal(f.sequence(), 1); assert.equal(authorizationCalls, 3);
});
