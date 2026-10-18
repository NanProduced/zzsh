import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { confirmLegacySkinIdentity, importLegacySkinOwner, legacyCatalogRecordDigest } from "../src/supply/catalog";
import { buildLegacySkinIndex, declarableLegacySkinIds, LEGACY_SKIN_FIELD_TYPE_HINT, mapLegacySkinHolding, splitLegacySkinColumn } from "../src/legacy-load/legacy-skin-holdings";

const NAMESPACE = "legacy_mysql_restore";
const ARTIFACT = "delta-skin-catalog/candidate-standard.json";
const ARTIFACT_SHA = "a".repeat(64);
const AUDIT = { requestId: "req_directed_test", sessionId: "ses_directed_test" };
const evidence = (record: Record<string, unknown>) => ({ artifact: ARTIFACT, artifactSha256: ARTIFACT_SHA, recordDigest: legacyCatalogRecordDigest(record) });

class Stub {
  queries: Array<{ text: string; values: unknown[] }> = [];
  audits: Array<{ action: unknown; objectType: unknown; objectId: unknown; details: Record<string, unknown> }> = [];
  ownerRow: { id: string; name: string } | undefined;
  ownerName: string | undefined = "威龙";
  skinRow: Record<string, unknown> | undefined;
  query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount?: number }> => {
    this.queries.push({ text, values });
    if (text.startsWith("SELECT id,name FROM zzsh_supply.skin_owner")) return { rows: this.ownerRow ? [this.ownerRow] : [], rowCount: this.ownerRow ? 1 : 0 };
    if (text.startsWith(`SELECT id,naming_state AS "namingState"`)) return { rows: this.skinRow ? [this.skinRow] : [], rowCount: this.skinRow ? 1 : 0 };
    if (text.startsWith("SELECT name,enabled FROM zzsh_supply.skin_owner")) return { rows: this.ownerName ? [{ name: this.ownerName, enabled: true }] : [] };
    if (text.startsWith(`SELECT naming_state AS "namingState" FROM zzsh_supply.skin WHERE id=$1`)) return { rows: [{ namingState: "VERIFIED" }] };
    if (text.startsWith(`SELECT catalog_revision::text AS revision FROM zzsh_supply.game`)) return { rows: [{ revision: "7" }] };
    if (text.startsWith(`UPDATE "zzsh_supply"."game" SET "catalog_revision"`)) return { rows: [], rowCount: 1 };
    if (text.startsWith("INSERT INTO zzsh_supply.skin_owner")) return { rows: [], rowCount: 1 };
    if (text.startsWith("UPDATE zzsh_supply.skin SET owner_kind")) return { rows: [], rowCount: 1 };
    if (text.startsWith(`INSERT INTO "zzsh_iam"."audit_event"`)) {
      this.audits.push({ action: values[4], objectType: values[5], objectId: values[6], details: JSON.parse(String(values[10])) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error("unexpected query: " + text);
  };
}
const client = (stub: Stub) => stub as unknown as PoolClient;
const writes = (stub: Stub) => stub.queries
  .filter((entry) => /^(INSERT|UPDATE)/.test(entry.text) && !entry.text.includes(`"zzsh_iam"."audit_event"`))
  .map((entry) => entry.text.slice(0, 48));

test("legacy owner import writes the owner and a bound audit in the same call, then verifies on replay", async () => {
  const stub = new Stub();
  const record = { namespace: NAMESPACE, kind: "AGENT", code: "df_skin_owner_test", name: "威龙" };
  const input = { kind: "AGENT" as const, code: "df_skin_owner_test", name: "威龙", evidence: evidence(record), audit: AUDIT, reason: "directed test owner" };
  const created = await importLegacySkinOwner(client(stub), "admin_test", true, "game_test", input);
  assert.equal(created.code, "df_skin_owner_test");
  assert.equal(writes(stub).length, 2);
  assert.equal(stub.audits.length, 1);
  assert.equal(stub.audits[0]!.action, "supply.catalog.legacy_owner_imported");
  assert.equal(stub.audits[0]!.objectType, "skin_owner");
  assert.equal(stub.audits[0]!.details.result, "CREATED");
  assert.equal(stub.audits[0]!.details.recordDigest, evidence(record).recordDigest);
  assert.equal(stub.audits[0]!.details.evidenceArtifact, ARTIFACT);

  stub.ownerRow = { id: created.id, name: "威龙" };
  stub.queries = [];
  const replay = await importLegacySkinOwner(client(stub), "admin_test", true, "game_test", input);
  assert.equal(replay.id, created.id);
  assert.deepEqual(writes(stub), []);
  assert.equal(stub.audits.length, 2);
  assert.equal(stub.audits[1]!.details.result, "REPLAY_VERIFIED");

  stub.ownerRow = { id: created.id, name: "别的人" };
  await assert.rejects(() => importLegacySkinOwner(client(stub), "admin_test", true, "game_test", input), /conflict/i);
  assert.equal(stub.audits.length, 2);

  const wrongEvidence = { ...input, evidence: { ...evidence(record), recordDigest: "b".repeat(64) } };
  stub.ownerRow = undefined;
  stub.queries = [];
  await assert.rejects(() => importLegacySkinOwner(client(stub), "admin_test", true, "game_test", wrongEvidence), /evidence does not match/i);
  assert.deepEqual(stub.queries, []);
  assert.equal(stub.audits.length, 2);
});

test("legacy skin identity confirmation records the exact source tuple and rejects mismatched evidence", async () => {
  const stub = new Stub();
  const skinRow = { id: "skin_test", namingState: "PENDING", ownerKind: null, ownerId: null, firearmId: null, baseName: null, sourceNamespace: NAMESPACE, sourceField: "gold_skin", sourceToken: "威龙-壮志凌云" };
  stub.skinRow = { ...skinRow };
  const record = { namespace: NAMESPACE, code: "df_skin_gold_test", sourceField: "gold_skin", sourceToken: "威龙-壮志凌云", ownerKind: "AGENT", ownerId: "owner_1", baseName: "壮志凌云" };
  const input = { code: "df_skin_gold_test", ownerRef: { kind: "AGENT" as const, id: "owner_1" }, baseName: "壮志凌云", aliases: ["壮志凌云"], evidence: evidence(record), audit: AUDIT, reason: "directed test identity" };
  const confirmed = await confirmLegacySkinIdentity(client(stub), "admin_test", true, "game_test", input);
  assert.equal(confirmed.namingState, "VERIFIED");
  assert.equal(stub.audits.length, 1);
  assert.equal(stub.audits[0]!.action, "supply.catalog.legacy_identity_confirmed");
  assert.equal(stub.audits[0]!.details.sourceField, "gold_skin");
  assert.equal(stub.audits[0]!.details.sourceToken, "威龙-壮志凌云");
  assert.equal(stub.audits[0]!.details.result, "CREATED");
  assert.equal(stub.audits[0]!.details.displayName, "威龙-壮志凌云");

  stub.skinRow = { ...skinRow, namingState: "VERIFIED", ownerKind: "AGENT", ownerId: "owner_1", baseName: "壮志凌云" };
  stub.queries = [];
  const replay = await confirmLegacySkinIdentity(client(stub), "admin_test", true, "game_test", input);
  assert.equal(replay.namingState, "VERIFIED");
  assert.deepEqual(writes(stub), []);
  assert.equal(stub.audits.length, 2);
  assert.equal(stub.audits[1]!.details.result, "REPLAY_VERIFIED");

  stub.skinRow = { ...skinRow, namingState: "VERIFIED", ownerKind: "AGENT", ownerId: "owner_other", baseName: "壮志凌云" };
  await assert.rejects(() => confirmLegacySkinIdentity(client(stub), "admin_test", true, "game_test", input), /conflict/i);
  assert.equal(stub.audits.length, 2);

  stub.skinRow = { ...skinRow };
  stub.queries = [];
  const wrongEvidence = { ...input, evidence: { ...evidence(record), recordDigest: "c".repeat(64) } };
  await assert.rejects(() => confirmLegacySkinIdentity(client(stub), "admin_test", true, "game_test", wrongEvidence), /evidence does not match/i);
  assert.deepEqual(writes(stub), []);
  assert.equal(stub.audits.length, 2);

  const wrongOwner = { ...input, ownerRef: { kind: "AGENT" as const, id: "owner_missing" }, evidence: evidence({ ...record, ownerId: "owner_missing" }) };
  stub.ownerName = undefined;
  stub.queries = [];
  await assert.rejects(() => confirmLegacySkinIdentity(client(stub), "admin_test", true, "game_test", wrongOwner), /owner does not belong/i);
  assert.equal(stub.audits.length, 2);
});

test("legacy catalog record digest is canonical across key order", () => {
  const left = legacyCatalogRecordDigest({ namespace: NAMESPACE, kind: "AGENT", code: "c", name: "n" });
  const right = legacyCatalogRecordDigest({ name: "n", code: "c", kind: "AGENT", namespace: NAMESPACE });
  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
  assert.notEqual(left, legacyCatalogRecordDigest({ namespace: NAMESPACE, kind: "MELEE_TYPE", code: "c", name: "n" }));
});

// SKIN-CATALOG-INTEGRATION-6: old four holding columns -> skin ids, per account.
const holdingCatalog = [
  { skinId: "skin_luna", gameId: "g", sourceField: "agent_skin", sourceToken: "天际线", namingState: "VERIFIED" as const, enabled: true, formVisible: true },
  { skinId: "skin_gu", gameId: "g", sourceField: "gold_skin", sourceToken: "蛊-不羁人生", namingState: "VERIFIED" as const, enabled: true, formVisible: true },
  { skinId: "skin_claw", gameId: "g", sourceField: "knife_skin", sourceToken: "赤霄（爪刀）", namingState: "PENDING" as const, enabled: false, formVisible: false },
  { skinId: "skin_m4", gameId: "g", sourceField: "weapon_skin", sourceToken: "M4棱镜攻势", namingState: "PENDING" as const, enabled: false, formVisible: false },
  { skinId: "skin_deep", gameId: "g", sourceField: "gold_skin", sourceToken: "深蓝- 不破誓约", namingState: "VERIFIED" as const, enabled: true, formVisible: true },
  { skinId: "skin_other", gameId: "other", sourceField: "agent_skin", sourceToken: "狂怒", namingState: "VERIFIED" as const, enabled: true, formVisible: true },
];
const holdingRules = [
  { field: "weapon_skin" as const, token: "0", decision: "INVALID" as const },
  { field: "knife_skin" as const, token: "赤霄", decision: "PENDING_DECISION" as const },
  { field: "knife_skin" as const, token: "M7棱镜攻势", decision: "HISTORICAL" as const },
];
const observed = (columns: Partial<Record<"knife_skin" | "agent_skin" | "weapon_skin" | "gold_skin", string | null>>) =>
  ({ knife_skin: null, agent_skin: null, weapon_skin: null, gold_skin: null, ...columns });

test("legacy holding columns split on comma, keep inner spaces and never infer quality", () => {
  assert.deepEqual(splitLegacySkinColumn(null), []);
  assert.deepEqual(splitLegacySkinColumn(" , "), []);
  assert.deepEqual(splitLegacySkinColumn("天际线, 天际线,深蓝- 不破誓约"), ["天际线", "深蓝- 不破誓约"]);
  assert.throws(() => splitLegacySkinColumn(7 as never));
  assert.deepEqual(LEGACY_SKIN_FIELD_TYPE_HINT, { knife_skin: "MELEE_TYPE", agent_skin: "AGENT", weapon_skin: "FIREARM", gold_skin: "AGENT" });
});

test("legacy holding maps only exact source tuples and keeps every unresolved token visible", () => {
  const index = buildLegacySkinIndex(holdingCatalog, holdingRules);
  const full = mapLegacySkinHolding({ accountKey: "acct-1", gameId: "g", columns: observed({ agent_skin: "天际线", gold_skin: "蛊-不羁人生,深蓝- 不破誓约" }) }, index, "139");
  assert.deepEqual(full.mappedSkinIds, ["skin_deep", "skin_gu", "skin_luna"]);
  assert.equal(full.complete, true);
  assert.deepEqual(declarableLegacySkinIds(full), ["skin_deep", "skin_gu", "skin_luna"]);

  const partial = mapLegacySkinHolding({ accountKey: "acct-2", gameId: "g", columns: {
    knife_skin: "赤霄,赤霄（爪刀）,M7棱镜攻势", weapon_skin: "0,M4棱镜攻势,不存在", agent_skin: "狂怒,天际线，水墨云图", gold_skin: "" } }, index, "139");
  assert.deepEqual(partial.mappedSkinIds, []);
  assert.deepEqual(partial.pending.map((p) => p.skinId), ["skin_claw", "skin_m4"]);
  assert.deepEqual(partial.unresolved.map((u) => `${u.field}:${u.token}:${u.reason}`), [
    "knife_skin:赤霄:PENDING_DECISION",
    "knife_skin:M7棱镜攻势:HISTORICAL_ONLY",
    "agent_skin:狂怒:CROSS_GAME",
    "agent_skin:天际线，水墨云图:AMBIGUOUS_SEPARATOR",
    "weapon_skin:0:INVALID_TOKEN",
    "weapon_skin:不存在:NOT_IN_CATALOG",
  ]);
  assert.equal(partial.complete, false);
  assert.equal(declarableLegacySkinIds(partial), null, "unresolved holdings are never written as an empty or partial declaration");

  // Four observed empty columns (null or "") are a real, legal empty holding.
  const empty = mapLegacySkinHolding({ accountKey: "acct-3", gameId: "g", columns: { knife_skin: null, agent_skin: "", weapon_skin: null, gold_skin: " , " } }, index, "139");
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.unobservedColumns, []);
  assert.deepEqual(declarableLegacySkinIds(empty), []);
  assert.notEqual(empty.digest, mapLegacySkinHolding({ accountKey: "acct-3", gameId: "g", columns: observed({}) }, index, "140").digest, "digest binds the catalog revision");
});

test("SK6-R1-01 a missing or undefined column is unobserved, never an empty column", () => {
  const index = buildLegacySkinIndex(holdingCatalog, holdingRules);
  const map = (columns: unknown) => mapLegacySkinHolding({ accountKey: "acct-m", gameId: "g", columns: columns as never }, index, "139");
  const legalEmpty = map(observed({}));
  const legalVerified = map(observed({ agent_skin: "天际线" }));
  assert.equal(legalEmpty.complete, true);
  assert.deepEqual(declarableLegacySkinIds(legalVerified), ["skin_luna"]);
  const cases: Array<[string, unknown, string[]]> = [
    ["no column", {}, ["knife_skin", "agent_skin", "weapon_skin", "gold_skin"]],
    ["only one column with a verified token", { agent_skin: "天际线" }, ["knife_skin", "weapon_skin", "gold_skin"]],
    ["three columns, gold missing", { knife_skin: null, agent_skin: "天际线", weapon_skin: "" }, ["gold_skin"]],
    ["explicit undefined", { ...observed({ agent_skin: "天际线" }), weapon_skin: undefined }, ["weapon_skin"]],
  ];
  for (const [label, columns, missing] of cases) {
    const holding = map(columns);
    assert.equal(holding.complete, false, label);
    assert.equal(declarableLegacySkinIds(holding), null, label);
    assert.deepEqual(holding.unobservedColumns, missing, label);
    assert.notEqual(holding.digest, legalEmpty.digest, `${label}: unobserved must not seal like an observed empty holding`);
    assert.notEqual(holding.digest, legalVerified.digest, `${label}: unobserved must not seal like an observed partial holding`);
  }
  assert.throws(() => map(null), /required/);
});

test("SK6-R1-03 source ambiguity stays unresolved after the catalog entry is verified", () => {
  const yingfeng = { field: "knife_skin" as const, token: "影锋", decision: "SOURCE_AMBIGUOUS" as const, sources: [
    { dictField: "knife_skin", dictTypeId: 1, dictDataId: 3, state: "HISTORICAL_SOFT_DELETED" as const },
    { dictField: "knife_skin", dictTypeId: null, dictDataId: 29, state: "CURRENT" as const },
  ] };
  const m7 = { field: "weapon_skin" as const, token: "M7棱镜攻势", decision: "SOURCE_AMBIGUOUS" as const, sources: [
    { dictField: "weapon_skin", dictTypeId: null, dictDataId: 36, state: "CURRENT" as const },
    { dictField: "weapon_skin_legacy", dictTypeId: 3, dictDataId: 12, state: "HISTORICAL_SOFT_DELETED" as const },
    { dictField: "knife_skin", dictTypeId: 1, dictDataId: 27, state: "HISTORICAL_SOFT_DELETED" as const },
  ] };
  const entries = (state: "PENDING" | "VERIFIED") => [
    ...holdingCatalog,
    { skinId: "skin_yingfeng", gameId: "g", sourceField: "knife_skin", sourceToken: "影锋", namingState: state, enabled: state === "VERIFIED", formVisible: state === "VERIFIED" },
    { skinId: "skin_m7", gameId: "g", sourceField: "weapon_skin", sourceToken: "M7棱镜攻势", namingState: state, enabled: state === "VERIFIED", formVisible: state === "VERIFIED" },
  ];
  const columns = observed({ knife_skin: "影锋", weapon_skin: "M7棱镜攻势" });
  // Control: without the source rule, a future verification alone would make the old token declarable.
  const unguarded = mapLegacySkinHolding({ accountKey: "a", gameId: "g", columns }, buildLegacySkinIndex(entries("VERIFIED"), holdingRules), "200");
  assert.deepEqual(declarableLegacySkinIds(unguarded), ["skin_m7", "skin_yingfeng"]);
  for (const state of ["PENDING", "VERIFIED"] as const) {
    const index = buildLegacySkinIndex(entries(state), [...holdingRules, yingfeng, m7]);
    const holding = mapLegacySkinHolding({ accountKey: "a", gameId: "g", columns }, index, state === "PENDING" ? "139" : "200");
    assert.deepEqual(holding.unresolved.map((u) => `${u.field}:${u.token}:${u.reason}`), ["knife_skin:影锋:SOURCE_AMBIGUOUS", "weapon_skin:M7棱镜攻势:SOURCE_AMBIGUOUS"], state);
    assert.deepEqual(holding.mappedSkinIds, [], state);
    assert.deepEqual(holding.pending, [], state);
    assert.equal(declarableLegacySkinIds(holding), null, state);
    assert.deepEqual(holding.tokens, [{ field: "knife_skin", token: "影锋" }, { field: "weapon_skin", token: "M7棱镜攻势" }], "raw tokens are kept");
  }
  // The same text in another column is another source tuple: no cross-column merge.
  const other = mapLegacySkinHolding({ accountKey: "a", gameId: "g", columns: observed({ knife_skin: "M7棱镜攻势" }) }, buildLegacySkinIndex(entries("VERIFIED"), [...holdingRules, yingfeng, m7]), "200");
  assert.deepEqual(other.unresolved.map((u) => u.reason), ["HISTORICAL_ONLY"]);
});

test("legacy holding index rejects duplicate tuples, conflicting rules and unknown columns", () => {
  assert.throws(() => buildLegacySkinIndex([...holdingCatalog, { ...holdingCatalog[0]!, skinId: "dup" }]), /Duplicate/);
  assert.throws(() => buildLegacySkinIndex(holdingCatalog, [{ field: "agent_skin", token: "天际线", decision: "INVALID" }]), /Conflicting/);
  // A rule other than SOURCE_AMBIGUOUS on a catalog key is a conflict, never a silent priority.
  for (const decision of ["HISTORICAL", "PENDING_DECISION"] as const) {
    assert.throws(() => buildLegacySkinIndex(holdingCatalog, [{ field: "weapon_skin", token: "M4棱镜攻势", decision }]), /Conflicting/);
  }
  const src = (id: number) => ({ dictField: "weapon_skin", dictTypeId: null, dictDataId: id, state: "CURRENT" as const });
  assert.throws(() => buildLegacySkinIndex(holdingCatalog, [
    { field: "weapon_skin", token: "M4棱镜攻势", decision: "SOURCE_AMBIGUOUS", sources: [src(35), src(13)] },
    { field: "weapon_skin", token: "M4棱镜攻势", decision: "HISTORICAL" },
  ]), /Conflicting/);
  assert.throws(() => buildLegacySkinIndex(holdingCatalog, [{ field: "weapon_skin", token: "M4棱镜攻势", decision: "SOURCE_AMBIGUOUS", sources: [src(35)] }]), /two or more/);
  assert.throws(() => buildLegacySkinIndex(holdingCatalog, [{ field: "weapon_skin", token: "M4棱镜攻势", decision: "SOURCE_AMBIGUOUS", sources: [src(35), src(35)] }]), /two or more/);
  assert.throws(() => buildLegacySkinIndex(holdingCatalog, [{ field: "knife_skin", token: "赤霄", decision: "ALIAS_OF", targetField: "knife_skin", targetToken: "missing" }]), /Alias target/);
  const alias = buildLegacySkinIndex(holdingCatalog, [{ field: "knife_skin", token: "赤霄", decision: "ALIAS_OF", targetField: "knife_skin", targetToken: "赤霄（爪刀）" }]);
  assert.deepEqual(mapLegacySkinHolding({ accountKey: "a", gameId: "g", columns: observed({ knife_skin: "赤霄" }) }, alias, "1").pending.map((p) => p.skinId), ["skin_claw"]);
  assert.throws(() => mapLegacySkinHolding({ accountKey: "a", gameId: "g", columns: { ...observed({}), skin: "x" } as never }, alias, "1"), /Unexpected/);
});