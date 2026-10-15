import assert from "node:assert/strict";
import { test } from "node:test";
import { groupFirearms, gunsmithRecoveryTarget, schemeCounts } from "../src/views/supply-gunsmith/model.ts";

const classifications = [{ id: "c1", name: "步枪" }];
const firearm = (id, codeCount) => ({ id, gameId: "g1", code: id, name: id, classificationId: "c1", enabled: true, sortOrder: 0, mediaId: null, codeCount, revision: "1", updatedAt: "", sourceNamespace: null, sourceToken: null, sourceNote: null });

test("F6 coverage counters share the range of the groups they are given", () => {
  const all = groupFirearms(classifications, [firearm("f1", 2), firearm("f2", 3)]);
  assert.deepEqual(schemeCounts(all, f => f.codeCount > 0), { total: 2, withCodes: 2, withoutCodes: 0 });
  // 搜索只命中一把已覆盖的枪：待录入必须仍是 0，不能拿全目录分母虚构出一把缺码枪。
  const searched = groupFirearms(classifications, [firearm("f1", 2)]);
  assert.deepEqual(schemeCounts(searched, f => f.codeCount > 0), { total: 1, withCodes: 1, withoutCodes: 0 });
  const mixed = groupFirearms(classifications, [firearm("f1", 0), firearm("f2", 1)]);
  assert.deepEqual(schemeCounts(mixed, f => f.codeCount > 0), { total: 2, withCodes: 1, withoutCodes: 1 });
  assert.deepEqual(schemeCounts([], () => true), { total: 0, withCodes: 0, withoutCodes: 0 }, "zero search hits are an empty range, not missing codes");
});

test("recovery targets come from the recorded method and path, never a guessed resource", () => {
  for (const [record, expected] of [
    [{ entity: "classification", method: "POST", path: "/supply/games/g1/firearm-classifications" }, { operation: "supply.gunsmith.classification.create" }],
    [{ entity: "classification", method: "PUT", path: "/supply/firearm-classifications/c1" }, { operation: "supply.gunsmith.classification.update", resourceId: "c1" }],
    [{ entity: "firearm", method: "POST", path: "/supply/games/g1/firearms" }, { operation: "supply.gunsmith.firearm.create" }],
    [{ entity: "firearm", method: "PUT", path: "/supply/firearms/f1" }, { operation: "supply.gunsmith.firearm.update", resourceId: "f1" }],
    [{ entity: "alias", method: "POST", path: "/supply/games/g1/firearms/f1/aliases" }, { operation: "supply.gunsmith.alias.create" }],
    [{ entity: "alias", method: "PUT", path: "/supply/firearm-aliases/a1" }, { operation: "supply.gunsmith.alias.update", resourceId: "a1" }],
    [{ entity: "code", method: "POST", path: "/supply/gunsmith/codes" }, { operation: "supply.gunsmith.code.create" }],
    [{ entity: "code", method: "PUT", path: "/supply/gunsmith/codes/code-1" }, { operation: "supply.gunsmith.code.update", resourceId: "code-1" }],
    [{ entity: "code", method: "POST", path: "/supply/gunsmith/codes/code-1/withdraw" }, { operation: "supply.gunsmith.code.withdraw", resourceId: "code-1" }],
    [{ entity: "code", method: "POST", path: "/supply/gunsmith/codes/code-1/restore" }, { operation: "supply.gunsmith.code.restore", resourceId: "code-1" }],
  ]) assert.deepEqual(gunsmithRecoveryTarget(record), expected, record.path);
  for (const record of [
    { entity: "firearm", method: "PUT", path: "/supply/games/g1/firearms" },
    { entity: "code", method: "PUT", path: "/supply/unknown/things/code-1" },
    { entity: "code", method: "DELETE", path: "/supply/gunsmith/codes/code-1" },
  ]) assert.equal(gunsmithRecoveryTarget(record), null, `${record.path} has no contracted recovery target`);
});
