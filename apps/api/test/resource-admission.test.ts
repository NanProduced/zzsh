import { strict as assert } from "node:assert";
import test from "node:test";

import { admitTestDatabase, fixtureAgreementAcceptance, installedBusinessTruncate, type TestDatabaseAdmission } from "./database-test-support";

const MARKER = "zzsh:order-reservation-test:v1";
const base: TestDatabaseAdmission = {
  exists: false,
  owner: "zzsh",
  marker: MARKER,
  allowConnections: true,
  isTemplate: false,
  expectedOwner: "zzsh",
  expectedMarker: MARKER,
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

test("latest cleanup includes both immutable legal children before auth parents", async () => {
  const sql = await installedBusinessTruncate({ query: async () => ({ rows: [{ version: "zzsh_content.legal_document_version", acceptance: "zzsh_content.document_acceptance" }] }) } as never);
  assert.match(sql, /"document_acceptance"/); assert.match(sql, /"legal_document_version"/);
  assert.ok(sql.indexOf('"document_acceptance"') < sql.indexOf('"zzsh_auth_user"'));
});

test("historical-prefix cleanup omits tables proven absent", async () => {
  const sql = await installedBusinessTruncate({ query: async () => ({ rows: [{ version: null, acceptance: null }] }) } as never);
  assert.doesNotMatch(sql, /"document_acceptance"|"legal_document_version"/);
});

test("partial or unobserved legal schema cannot be silently cleaned", async () => {
  await assert.rejects(() => installedBusinessTruncate({ query: async () => ({ rows: [{ version: "present", acceptance: null }] }) } as never));
  await assert.rejects(() => installedBusinessTruncate({ query: async () => ({ rows: [] }) } as never));
});
