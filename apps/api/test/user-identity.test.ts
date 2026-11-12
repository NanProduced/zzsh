import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createFakeRealNameProvider, FAKE_REAL_NAME_SCENARIOS, identityAllowsProtectedTrade } from "../src/auth/user-identity";
import type { PoolClient } from "pg";
import { assertIdentitySubjectCapacity, identitySubjectDigest, recordLegacyIdentitySubject, recordLegacyIdentitySubjects, recordVerifiedIdentitySubject } from "../src/auth/identity-subject";

test("fake real-name provider has deterministic safe outcomes", async () => {
  const input = { userId: "user_fixture", fullName: "Fixture User", documentNumber: "fixture-document" };
  const expected = {
    VERIFIED_ADULT: { status: "VERIFIED", ageStatus: "ADULT" },
    VERIFIED_MINOR: { status: "VERIFIED", ageStatus: "MINOR" },
    REJECTED: { status: "REJECTED", ageStatus: "UNKNOWN" },
    UNKNOWN: { status: "UNKNOWN", ageStatus: "UNKNOWN" },
  } as const;
  for (const scenario of FAKE_REAL_NAME_SCENARIOS) {
    if (scenario === "FAULT") {
      await assert.rejects(() => createFakeRealNameProvider(scenario).verify(input), /fault/);
      continue;
    }
    const first = await createFakeRealNameProvider(scenario).verify(input);
    const second = await createFakeRealNameProvider(scenario).verify(input);
    assert.deepEqual({ status: first.status, ageStatus: first.ageStatus }, expected[scenario]);
    assert.deepEqual(first, second);
    assert.doesNotMatch(first.providerReference ?? "", /fixture-document|Fixture User/);
  }
});

test("legacy verified trading access preserves unknown age without admitting minors or unverified users", () => {
  assert.equal(identityAllowsProtectedTrade({ identityStatus: "VERIFIED", ageStatus: "UNKNOWN", provider: "legacy_mysql_restore" }), true);
  for (const provider of ["legacy_mysql_restore", "fake", "none", "REAL_PROVIDER"]) {
    assert.equal(identityAllowsProtectedTrade({ identityStatus: "VERIFIED", ageStatus: "ADULT", provider }), true);
    assert.equal(identityAllowsProtectedTrade({ identityStatus: "VERIFIED", ageStatus: "MINOR", provider }), false);
    for (const identityStatus of ["UNKNOWN", "UNVERIFIED", "REJECTED"]) {
      assert.equal(identityAllowsProtectedTrade({ identityStatus, ageStatus: "UNKNOWN", provider }), false);
    }
    if (provider !== "legacy_mysql_restore") assert.equal(identityAllowsProtectedTrade({ identityStatus: "VERIFIED", ageStatus: "UNKNOWN", provider }), false);
  }
  assert.equal(identityAllowsProtectedTrade(null), false);
});

test("identity subject uses stable purpose-keyed document normalization without exposing an identity", () => {
  const key = Buffer.alloc(32, 7), document = "11010519900101123x";
  const digest = identitySubjectDigest(document, key);
  assert.equal(identitySubjectDigest(`  ${document.toUpperCase()} `, key), digest);
  assert.equal(identitySubjectDigest("110105900101123",key),identitySubjectDigest("110105199001011232",key),"old 15-digit and canonical 18-digit forms cannot claim separate subjects");
  assert.match(digest, /^[a-f0-9]{64}$/); assert.notEqual(identitySubjectDigest(document, Buffer.alloc(32, 8)), digest);
  assert.doesNotMatch(digest, /110105|199001/);
  assert.throws(() => identitySubjectDigest(document, undefined), (error: unknown) => (error as { status?: number }).status === 503);
  assert.throws(() => identitySubjectDigest("110105********123X", key), (error: unknown) => (error as { status?: number }).status === 400);
});

test("identity cap keeps current self re-verification, rejects a third subject and locks old/new in stable order", async () => {
  const key = Buffer.alloc(32, 7), document = "11010519900101123X", locks: string[] = [];
  let slots = { alreadyBound: false, occupied: "1" };
  const client = { query: async (sql: string, values: unknown[]) => {
    if (sql.includes('AS "subjectDigest"')) return { rows: [{ subjectDigest: "a".repeat(64) }] };
    if (sql.includes("pg_advisory_xact_lock")) { locks.push(String(values[0])); return { rows: [{}] }; }
    assert.ok(sql.includes("identity-subject-capacity"));
    assert.equal(values[1], "user"); assert.deepEqual(values[2], [document]);
    assert.equal(sql.includes(document), false, "the source document is a parameter, never interpolated SQL");
    return { rows: [slots] };
  } } as unknown as PoolClient;
  const digest = await assertIdentitySubjectCapacity(client, "user", document, key, true);
  assert.deepEqual(locks, [digest, "a".repeat(64)].sort());
  slots = { alreadyBound: false, occupied: "2" };
  await assert.rejects(assertIdentitySubjectCapacity(client, "user", document, key, false),
    (error: unknown) => (error as { code?: string }).code === "IDENTITY_ACCOUNT_LIMIT");
  slots = { alreadyBound: true, occupied: "2" };
  assert.equal(await assertIdentitySubjectCapacity(client, "user", document, key, false), digest,
    "a grandfathered self binding must not be rejected as a new third account");
});

test("identity binding dependency failures fail closed and never invent a zero count", async () => {
  const key = Buffer.alloc(32, 7), document = "11010519900101123X";
  for (const rows of [[], [{ alreadyBound: false, occupied: null }], [{ alreadyBound: false, occupied: "-1" }]]) {
    const client = { query: async () => ({ rows }) } as unknown as PoolClient;
    await assert.rejects(assertIdentitySubjectCapacity(client, "user", document, key, false),
      (error: unknown) => (error as { code?: string }).code === "IDENTITY_DEPENDENCY_UNAVAILABLE");
  }
  const client = { query: async () => { throw Object.assign(new Error("sensitive driver detail"), { code: "42501" }); } } as unknown as PoolClient;
  await assert.rejects(recordVerifiedIdentitySubject(client, "user", "a".repeat(64), "NATIVE_VERIFICATION"),
    (error: unknown) => (error as Error).message.includes("sensitive") === false && (error as { status?: number }).status === 503);
});

test("trusted legacy subject registration preserves duplicate originals without minting verification", async () => {
  const key = Buffer.alloc(32, 7), document = "11010519900101123X", statements: Array<{ sql: string; values: unknown[] }> = [];
  let state = { identityStatus: "VERIFIED", provider: "legacy_mysql_restore" };
  const client = { query: async (sql: string, values: unknown[]) => {
    statements.push({ sql, values });
    return { rows: sql.includes('AS "identityStatus"') ? [state] : [] };
  } } as unknown as PoolClient;
  await recordLegacyIdentitySubject(client, "legacy-user", document, key);
  assert.equal(statements.length, 2); assert.equal(statements[1]!.values[2], "LEGACY_IMPORT");
  assert.equal(statements[1]!.values.includes(document), false, "the identity table only receives the keyed digest");
  assert.equal(statements.some(row => row.sql.includes("UPDATE zzsh_iam.user_identity_state")), false);
  state = { identityStatus: "UNVERIFIED", provider: "legacy_mysql_restore" };
  await assert.rejects(recordLegacyIdentitySubject(client, "legacy-user", document, key),
    (error: unknown) => (error as { code?: string }).code === "CONFLICT");
});


test("legacy subject batch keeps same-document users distinct and refuses native overwrite", async () => {
  const key = Buffer.alloc(32, 19), documentNumber = "SYNTH-DOC-SHARED", ids = ["fixture_a", "fixture_b"];
  const entries = ids.map((userId, index) => ({ userId, sourceRef: "la_user:" + (index + 1), documentNumber }));
  const calls: Array<{ sql: string; values: unknown[] }> = []; let native = false, transaction = true;
  const client = { getTransactionStatus: () => transaction ? "T" : "I", query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes('FROM zzsh_auth_user."user"')) return { rows: ids.map(id => ({ id })), rowCount: ids.length };
    if (sql.includes("FROM zzsh_iam.user_identity_state")) return { rows: ids.map((user_id, index) => ({ user_id, provider: "legacy_mysql_restore", provider_reference: "la_user:" + (index + 1), identity_status: "VERIFIED" })) };
    if (sql.includes("FROM zzsh_iam.user_identity_subject")) return { rows: native ? [{ user_id: ids[0], subject_digest: identitySubjectDigest(documentNumber,key), source: "NATIVE_VERIFICATION" }] : [] };
    return { rows: [], rowCount: ids.length };
  } } as unknown as PoolClient;
  await recordLegacyIdentitySubjects(client, entries, key);
  assert.equal(calls.length, 5); assert.equal((calls[1]!.values[0] as string[]).length, 1);
  assert.equal(JSON.stringify(calls.map(call => call.values)).includes(documentNumber), false);
  calls.length = 0; native = true;
  await assert.rejects(recordLegacyIdentitySubjects(client, entries, key), (error: unknown) => (error as { status?: number }).status === 409);
  assert(!calls.some(call => call.sql.startsWith("INSERT")));
  calls.length = 0; await assert.rejects(recordLegacyIdentitySubjects(client, [entries[0]!,entries[0]!], key)); assert.equal(calls.length, 0);
  transaction = false; await assert.rejects(recordLegacyIdentitySubjects(client, entries, key));
});
