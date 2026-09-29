import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { confirmLegacySkinIdentity, importLegacySkinOwner, legacyCatalogRecordDigest } from "../src/supply/catalog";

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
