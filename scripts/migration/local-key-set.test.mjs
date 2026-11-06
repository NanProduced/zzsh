import assert from "node:assert/strict";
import test from "node:test";
import { compareKeySets } from "./local-key-set.mjs";

const rows = ids => ids.map(legacy_id => ({ legacy_id }));

test("identical sets pass regardless of order", () => {
  const result = compareKeySets(["3", "1", "2"], rows(["1", "2", "3"]));
  assert.equal(result.equal, true);
  assert.equal(result.missing, 0);
  assert.equal(result.extra, 0);
  assert.equal(result.sourceDigest, result.targetDigest);
});

test("a swapped object is caught even though both totals match", () => {
  const result = compareKeySets(["1", "2", "3"], rows(["1", "2", "4"]));
  assert.equal(result.source, 3);
  assert.equal(result.target, 3);
  assert.equal(result.equal, false);
  assert.deepEqual(result.missingSample, ["3"]);
  assert.deepEqual(result.extraSample, ["4"]);
  assert.notEqual(result.sourceDigest, result.targetDigest);
});

test("missing and extra are reported separately with a bounded sample", () => {
  const result = compareKeySets(["1", "2", "3", "4"], rows(["1", "5", "6"]), { sample: 1 });
  assert.equal(result.missing, 3);
  assert.equal(result.extra, 2);
  assert.equal(result.missingSample.length, 1);
  assert.equal(result.extraSample.length, 1);
});

test("an empty target fails an expected source instead of passing as zero", () => {
  const result = compareKeySets(["1", "2"], []);
  assert.equal(result.equal, false);
  assert.equal(result.missing, 2);
  assert.equal(result.target, 0);
});

test("numeric and string keys compare as the same object", () => {
  assert.equal(compareKeySets([1, 2], rows(["1", "2"])).equal, true);
  assert.equal(compareKeySets(["1"], [{ legacy_id: 1 }]).equal, true);
});
