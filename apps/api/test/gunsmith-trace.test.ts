import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  LEGACY_GUN_CODE_NAMESPACE,
  LEGACY_GUN_NAMESPACE,
  reconcileGunsmithTrace,
  type LegacyGunsmithCodeRow,
  type LegacyGunsmithGunRow,
  type TracedFirearmRow,
  type TracedGunsmithCodeRow,
} from "../src/supply/gunsmith-trace";

// Recorded CH-1 evidence (rehearsal 2026-10-13): la_gun 68 rows -> 63 migrated
// + 5 soft-delete isolated; la_gun_code 154 rows -> 152 migrated + 2 duplicate
// isolated. The fixture below reproduces that shape exactly.
function buildFixture() {
  const legacyGuns: LegacyGunsmithGunRow[] = [];
  for (let id = 1; id <= 68; id++) legacyGuns.push({ id, name: `枪械-${id}`, isDelete: id >= 64 ? 1 : 0 });

  const legacyCodes: LegacyGunsmithCodeRow[] = [];
  let codeId = 1000;
  const firstCodeOfGun1 = "gun-1-alpha";
  for (let gunId = 1; gunId <= 63; gunId++) {
    const codesForGun = gunId <= 26 ? 3 : 2;
    for (let index = 0; index < codesForGun; index++) {
      const isGun1Alpha = gunId === 1 && index === 0;
      legacyCodes.push({ id: codeId++, gunId, code: isGun1Alpha ? firstCodeOfGun1 : `gun-${gunId}-code-${index}`, isDelete: 0 });
    }
  }
  assert.equal(legacyCodes.length, 152);
  legacyCodes.push({ id: 5001, gunId: 1, code: firstCodeOfGun1, isDelete: 0 });
  legacyCodes.push({ id: 5002, gunId: 1, code: firstCodeOfGun1, isDelete: 0 });
  assert.equal(legacyCodes.length, 154);

  const firearms: TracedFirearmRow[] = legacyGuns
    .filter((gun) => gun.isDelete === 0)
    .map((gun) => ({ id: `firearm_${gun.id}`, name: gun.name, sourceNamespace: LEGACY_GUN_NAMESPACE, sourceToken: String(gun.id) }));
  const canonicalCodeIds = new Set(legacyCodes.filter((code) => code.id < 5000).map((code) => code.id));
  const codes: TracedGunsmithCodeRow[] = legacyCodes
    .filter((code) => canonicalCodeIds.has(code.id))
    .map((code) => ({ id: `code_${code.id}`, firearmId: `firearm_${code.gunId}`, code: code.code, sourceNamespace: LEGACY_GUN_CODE_NAMESPACE, sourceToken: String(code.id) }));
  return { legacyGuns, legacyCodes, firearms, codes };
}

test("CH-1 fixture reconciles cleanly: 68=63+5 soft-delete, 154=152+2 duplicate isolated", () => {
  const { legacyGuns, legacyCodes, firearms, codes } = buildFixture();
  const { issues, summary } = reconcileGunsmithTrace({ legacyGuns, legacyCodes, firearms, codes });
  assert.deepEqual(issues, []);
  assert.deepEqual(summary, {
    legacyGunTotal: 68,
    legacyGunSoftDeleted: 5,
    legacyGunExpectedMigrated: 63,
    legacyCodeTotal: 154,
    legacyCodeSoftDeleted: 0,
    legacyCodeDuplicateIsolated: 2,
    legacyCodeExpectedMigrated: 152,
    targetGunTracedCount: 63,
    targetCodeTracedCount: 152,
    migratedGunCount: 63,
    migratedCodeCount: 152,
  });
  // Conservation in both directions.
  assert.equal(summary.legacyGunTotal, summary.legacyGunExpectedMigrated + summary.legacyGunSoftDeleted);
  assert.equal(summary.legacyCodeTotal, summary.legacyCodeExpectedMigrated + summary.legacyCodeSoftDeleted + summary.legacyCodeDuplicateIsolated);
  assert.equal(summary.targetGunTracedCount, summary.migratedGunCount);
  assert.equal(summary.targetCodeTracedCount, summary.migratedCodeCount);
});

test("soft-deleted legacy rows must not be migrated, rows stay counted as isolated", () => {
  const fixture = buildFixture();
  const softDeletedGun = fixture.legacyGuns.find((gun) => gun.isDelete === 1)!;
  const firearms = [...fixture.firearms, { id: "firearm_leak", name: softDeletedGun.name, sourceNamespace: LEGACY_GUN_NAMESPACE, sourceToken: String(softDeletedGun.id) }];
  const { issues, summary } = reconcileGunsmithTrace({ ...fixture, firearms });
  assert.deepEqual(issues.map((issue) => issue.kind), ["SOFT_DELETED_GUN_MIGRATED", "GUN_COUNT_MISMATCH"]);
  assert.equal(issues[0]!.legacyId, softDeletedGun.id);
  assert.equal(summary.legacyGunSoftDeleted, 5);
  assert.equal(summary.migratedGunCount, 63);
  assert.equal(summary.targetGunTracedCount, 64);
});

test("duplicate legacy codes must stay isolated and are listed separately", () => {
  const fixture = buildFixture();
  const migratedDuplicate: TracedGunsmithCodeRow = { id: "code_5001", firearmId: "firearm_1", code: "gun-1-alpha", sourceNamespace: LEGACY_GUN_CODE_NAMESPACE, sourceToken: "5001" };
  const { issues, summary } = reconcileGunsmithTrace({ ...fixture, codes: [...fixture.codes, migratedDuplicate] });
  assert.deepEqual(issues.map((issue) => issue.kind), ["DUPLICATE_CODE_MIGRATED", "CODE_COUNT_MISMATCH"]);
  assert.equal(issues[0]!.legacyId, 5001);
  assert.equal(summary.legacyCodeDuplicateIsolated, 2);
  assert.equal(summary.migratedCodeCount, 152);
});

test("missing source tokens and unresolved tokens on target rows are detected", () => {
  const fixture = buildFixture();
  const untraced = fixture.firearms[0]!;
  const firearms = [{ ...untraced, sourceNamespace: null, sourceToken: null }, ...fixture.firearms.slice(1)];
  const { issues } = reconcileGunsmithTrace({ ...fixture, firearms });
  // The untraced gun also makes its three codes' parent binding unverifiable.
  assert.deepEqual(issues.map((issue) => issue.kind), ["LIVE_GUN_NOT_MIGRATED", "CODE_TARGET_FIREARM_UNTRACED", "CODE_TARGET_FIREARM_UNTRACED", "CODE_TARGET_FIREARM_UNTRACED"]);

  const unresolved: TracedGunsmithCodeRow = { id: "code_x", firearmId: "firearm_1", code: "ghost", sourceNamespace: LEGACY_GUN_CODE_NAMESPACE, sourceToken: "424242" };
  const withGhost = reconcileGunsmithTrace({ ...fixture, codes: [...fixture.codes, unresolved] });
  assert.deepEqual(withGhost.issues.map((issue) => issue.kind), ["UNRESOLVED_SOURCE_TOKEN", "CODE_COUNT_MISMATCH"]);

  const halfTraced: TracedFirearmRow = { id: "firearm_half", name: "半溯源", sourceNamespace: LEGACY_GUN_NAMESPACE, sourceToken: null };
  const withHalf = reconcileGunsmithTrace({ ...fixture, firearms: [...fixture.firearms, halfTraced] });
  assert.deepEqual(withHalf.issues.map((issue) => issue.kind), ["SOURCE_TRACING_MISSING"]);
});

test("live legacy rows without a migrated target are reported with count mismatch", () => {
  const fixture = buildFixture();
  const missingGun = fixture.legacyGuns[4]!;
  const firearms = fixture.firearms.filter((row) => row.sourceToken !== String(missingGun.id));
  const { issues, summary } = reconcileGunsmithTrace({ ...fixture, firearms });
  // The missing gun's three codes can no longer verify their parent binding.
  assert.deepEqual(issues.map((issue) => issue.kind), ["LIVE_GUN_NOT_MIGRATED", "CODE_TARGET_FIREARM_UNTRACED", "CODE_TARGET_FIREARM_UNTRACED", "CODE_TARGET_FIREARM_UNTRACED"]);
  assert.equal(issues[0]!.legacyId, missingGun.id);
  assert.equal(summary.migratedGunCount, 62);

  const missingCode = fixture.codes[7]!;
  const codes = fixture.codes.filter((row) => row.id !== missingCode.id);
  const withoutCode = reconcileGunsmithTrace({ ...fixture, codes });
  assert.deepEqual(withoutCode.issues.map((issue) => issue.kind), ["LIVE_CODE_NOT_MIGRATED"]);
});

test("identity drift and cross-firearm rebinding are reported", () => {
  const fixture = buildFixture();
  const renamed = { ...fixture.firearms[2]!, name: "改名枪" };
  const firearms = [...fixture.firearms.slice(0, 2), renamed, ...fixture.firearms.slice(3)];
  const renamedResult = reconcileGunsmithTrace({ ...fixture, firearms });
  assert.deepEqual(renamedResult.issues.map((issue) => issue.kind), ["MIGRATED_NAME_MISMATCH"]);

  const rebound = { ...fixture.codes[3]!, firearmId: "firearm_999" };
  const codes = [...fixture.codes.slice(0, 3), rebound, ...fixture.codes.slice(4)];
  const reboundResult = reconcileGunsmithTrace({ ...fixture, codes });
  assert.deepEqual(reboundResult.issues.map((issue) => issue.kind), ["CODE_TARGET_FIREARM_UNTRACED"]);
});

test("hand-maintained rows without any source tuple stay outside the CH-1 scope", () => {
  const fixture = buildFixture();
  const manualGun: TracedFirearmRow = { id: "firearm_manual", name: "手工录入", sourceNamespace: null, sourceToken: null };
  const otherSystemCode: TracedGunsmithCodeRow = { id: "code_manual", firearmId: "firearm_manual", code: "manual", sourceNamespace: "manual:backoffice", sourceToken: "1" };
  const { issues, summary } = reconcileGunsmithTrace({
    ...fixture,
    firearms: [...fixture.firearms, manualGun],
    codes: [...fixture.codes, otherSystemCode],
  });
  assert.deepEqual(issues, []);
  assert.equal(summary.targetGunTracedCount, 63);
  assert.equal(summary.targetCodeTracedCount, 152);
});

test("invalid namespaces are rejected before reconciling", () => {
  const fixture = buildFixture();
  assert.throws(() => reconcileGunsmithTrace({ ...fixture, gunNamespace: "BAD NS" }), /source system and entity/i);
  assert.throws(() => reconcileGunsmithTrace({ ...fixture, codeNamespace: "no-colon" }), /source system and entity/i);
});
