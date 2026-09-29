import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseLegacyReadSnapshot } from "../src/supply/legacy-listing-read";

const valid = { schema: "legacy-listing-read-v1", resourceNo: "SOURCE-1", haffRentYuan: "2038.00", goodsYuan: "20.00", depositYuan: "50.00", termDays: "102", dailyHaffBase: "10000000" };
test("historical read amounts remain exact source strings, including a legitimate zero", () => {
  assert.deepEqual(parseLegacyReadSnapshot(valid), valid);
  assert.equal(parseLegacyReadSnapshot({ ...valid, depositYuan: "0.00" }).depositYuan, "0.00");
});
test("historical public snapshot refuses private fields, missing values and numeric coercion", () => {
  for (const extra of ["ownerUserId", "mobile", "ownerRatioB", "quote", "canCreateOrder"])
    assert.throws(() => parseLegacyReadSnapshot({ ...valid, [extra]: "untrusted" }));
  for (const bad of [1, null, ["20.00"], " 20.00", "20.00 ", "1e2", "-1.00", "20", "20.001"])
    assert.throws(() => parseLegacyReadSnapshot({ ...valid, goodsYuan: bad }));
  for (const bad of [0, null, "0", "01", "1.5", "-1"])
    assert.throws(() => parseLegacyReadSnapshot({ ...valid, termDays: bad }));
  const { depositYuan: omitted, ...missing } = valid;
  assert.throws(() => parseLegacyReadSnapshot(missing));
});
