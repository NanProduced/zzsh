import { strict as assert } from "node:assert";
import test from "node:test";

import { admitTestDatabase, assertEmptyIsolatedBusinessData, fixtureAgreementAcceptance, installedBusinessTruncate, type TestDatabaseAdmission } from "./database-test-support";

const MARKER = "zzsh:order-reservation-test:v1";
const base: TestDatabaseAdmission = {
  exists: false,
  owner: "zzsh",
  marker: MARKER,
  allowConnections: true,
  isTemplate: false,
  databaseOid: "700001",
  expectedOwner: "zzsh",
  expectedMarker: MARKER,
  expectedOid: null,
  databaseName: "zzsh_test_order_fixture",
  allowFlag: "ORDER_TEST_ALLOW_NEW_RESOURCE",
};

function decide(input: TestDatabaseAdmission, env: Record<string, string | undefined>) {
  let created = 0;
  const decision = admitTestDatabase(input, env);
  if (decision === "CREATE") created += 1;
  return { decision, created };
}

test("existing registered database is reused without any admission flag", () => {
  const r = decide({ ...base, exists: true }, {});
  assert.equal(r.decision, "REUSE");
  assert.equal(r.created, 0);
});

test("missing database is refused before any creation", () => {
  assert.throws(() => decide(base, {}), /ORDER_TEST_ALLOW_NEW_RESOURCE=1/);
});

test("the suite's own flag admits creation once", () => {
  const r = decide(base, { ORDER_TEST_ALLOW_NEW_RESOURCE: "1" });
  assert.equal(r.decision, "CREATE");
  assert.equal(r.created, 1);
});

test("another suite's flag does not license this creation", () => {
  assert.throws(() => decide(base, { SUPPLY_TEST_ALLOW_NEW_RESOURCE: "1", CONTENT_TEST_ALLOW_NEW_RESOURCE: "1" }), /ORDER_TEST_ALLOW_NEW_RESOURCE=1/);
});

test("owner drift on an existing database is refused", () => {
  assert.throws(() => decide({ ...base, exists: true, owner: "other" }, { ORDER_TEST_ALLOW_NEW_RESOURCE: "1" }), /owner changed/);
});

test("marker drift on an existing database is refused", () => {
  assert.throws(() => decide({ ...base, exists: true, marker: "zzsh:other:v1" }, {}), /marker is missing or mismatched/);
});

test("closed database is not reused", () => {
  assert.throws(() => decide({ ...base, exists: true, allowConnections: false }, {}), /not accepting connections/);
});

test("template database is not reused", () => {
  assert.throws(() => decide({ ...base, exists: true, isTemplate: true }, {}), /must not be a template/);
});

test("fixture databases are identified by the absence of a marker", () => {
  assert.equal(decide({ ...base, exists: true, marker: null, expectedMarker: null }, {}).decision, "REUSE");
  assert.throws(() => decide({ ...base, exists: true, marker: MARKER, expectedMarker: null }, {}), /marker is missing or mismatched/);
});

test("missing identity metadata cannot stand in for a verified unmarked fixture", () => {
  const fixture = { ...base, exists: true, marker: null, expectedMarker: null };
  assert.throws(() => decide({ ...fixture, marker: undefined }, {}), /marker is missing or mismatched/);
  assert.throws(() => decide({ ...fixture, allowConnections: undefined }, {}), /not accepting connections/);
  assert.throws(() => decide({ ...fixture, isTemplate: undefined }, {}), /must not be a template/);
});

test("only the exact value 1 is an admission", () => {
  for (const value of ["0", "true", "", " yes ", "1; DROP"]) {
    assert.throws(() => decide(base, { ORDER_TEST_ALLOW_NEW_RESOURCE: value }), /ORDER_TEST_ALLOW_NEW_RESOURCE=1/);
  }
  assert.throws(() => decide(base, { ORDER_TEST_ALLOW_NEW_RESOURCE: undefined }), /ORDER_TEST_ALLOW_NEW_RESOURCE=1/);
});

test("a registered OID that no longer matches the database is refused", () => {
  assert.throws(() => admitTestDatabase({ ...base, exists: true, expectedOid: "700002" }, {}), /not OID 700002/);
  assert.equal(admitTestDatabase({ ...base, exists: true, expectedOid: "700001" }, {}), "REUSE");
});

test("repeat reuse never produces r1/r2 resources", () => {
  let created = 0;
  for (let i = 0; i < 3; i += 1) created += decide({ ...base, exists: true }, {}).created;
  assert.equal(created, 0);
});

test("fixture consent uses the exact server-confirmed reference", () => {
  const ref = { versionId: "agreement_1", digest: "a".repeat(64) };
  assert.deepEqual(fixtureAgreementAcceptance({ agreementAcceptance: ref }), ref);
  assert.throws(() => fixtureAgreementAcceptance({}));
});

const legalPresent = { version: "zzsh_content.legal_document_version", acceptance: "zzsh_content.document_acceptance" };
const legalAbsent = { version: null, acceptance: null };
const categoryBefore0159 = { skin: "zzsh_supply.skin", category: "zzsh_supply.skin_category", category_column: true };
const categoryAfter0159 = { skin: "zzsh_supply.skin", category: null, category_column: false };
function cleanupFixture(skin: Record<string, unknown>, legal: Record<string, unknown> = legalPresent, occupied?: string) {
  const calls: { sql: string; names?: string[] }[] = [];
  const pool = { query: async (sql: string, values?: [string[]]) => {
    calls.push({ sql, names: values?.[0] });
    assert.match(sql, /^SELECT/);
    if (sql.includes("AS category_column")) return { rows: [skin] };
    if (sql.includes("AS acceptance")) return { rows: [legal] };
    if (sql.includes("FROM unnest")) return { rows: values![0].map(name => ({ name })) };
    if (sql.includes("AS row_count")) return { rows: occupied ? [{ table_name: occupied, row_count: 1 }] : [{ table_name: "zzsh_supply.skin", row_count: 0 }], rowCount: 1 };
    throw new Error("UNEXPECTED_CLEANUP_QUERY");
  } };
  return { pool: pool as never, calls };
}

test("latest cleanup includes both immutable legal children before auth parents", async () => {
  const sql = await installedBusinessTruncate(cleanupFixture(categoryAfter0159).pool);
  assert.match(sql, /"document_acceptance"/); assert.match(sql, /"legal_document_version"/);
  assert.ok(sql.indexOf('"document_acceptance"') < sql.indexOf('"zzsh_auth_user"'));
  assert.doesNotMatch(sql, /"skin_category"|legacy_owner_guarantee_(?:observation|coverage)/);
});

test("historical-prefix cleanup omits tables proven absent", async () => {
  const sql = await installedBusinessTruncate(cleanupFixture(categoryBefore0159, legalAbsent).pool);
  assert.doesNotMatch(sql, /"document_acceptance"|"legal_document_version"/);
  assert.match(sql, /"zzsh_supply"\."skin_category"/);
});

test("partial or unobserved legal schema cannot be silently cleaned", async () => {
  await assert.rejects(() => installedBusinessTruncate(cleanupFixture(categoryAfter0159, { version: "present", acceptance: null }).pool), /legal cleanup schema is incomplete/);
  await assert.rejects(() => installedBusinessTruncate(cleanupFixture(categoryAfter0159, {}).pool), /legal cleanup schema must be observed/);
});

test("partial or unobserved skin category schema is refused", async () => {
  for (const skin of [
    { ...categoryBefore0159, category_column: false }, { ...categoryAfter0159, category_column: true },
    { ...categoryAfter0159, skin: null }, { skin: "zzsh_supply.skin", category: null }, {},
  ]) await assert.rejects(() => installedBusinessTruncate(cleanupFixture(skin).pool), /skin (?:category )?cleanup schema/);
});

test("order empty-target preflight counts the actually installed old and new inventories", async () => {
  for (const [skin, hasCategory] of [[categoryBefore0159, true], [categoryAfter0159, false]] as const) {
    const fixture = cleanupFixture(skin);
    await assertEmptyIsolatedBusinessData(fixture.pool);
    const names = fixture.calls.find(call => call.sql.includes("FROM unnest"))!.names!;
    assert.equal(names.includes('"zzsh_supply"."skin_category"'), hasCategory);
    assert.ok(names.includes('"zzsh_supply"."skin"'));
    assert.ok(fixture.calls.every(call => !/\b(?:TRUNCATE|DELETE|UPDATE|INSERT)\b/i.test(call.sql)));
    const countQuery = fixture.calls.find(call => call.sql.includes("AS row_count"))!.sql;
    assert.equal(countQuery.includes('"zzsh_supply"."skin_category"'), hasCategory);
  }
  const occupied = cleanupFixture(categoryBefore0159, legalPresent, "zzsh_supply.skin_category");
  await assert.rejects(() => assertEmptyIsolatedBusinessData(occupied.pool), /registered test target contains rows/);
});
