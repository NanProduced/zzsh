import assert from "node:assert/strict";
import { test } from "node:test";
import { captureBoundLegacyBankSelection, captureBoundLegacyBankSource, legacyBankPrivateComparisonDigest, useBoundLegacyBankSelection, useBoundLegacyBankSource } from "./local-legacy-bank-source.mjs";

test("临时盐摘要绑定五列且与输入顺序无关，不输出原始数据", () => {
  const row = { user_id: "1", name: "synthetic-name", card_no: "0000000000000015", create_time: "1760000000", update_time: "1760000001" };
  const second = { ...row, user_id: "2", card_no: "0000000000000023" }, salt = "a".repeat(64);
  const digest = legacyBankPrivateComparisonDigest([row, second], salt);
  assert.match(digest, /^[a-f0-9]{64}$/); assert.equal(digest, legacyBankPrivateComparisonDigest([second, row], salt));
  assert.notEqual(digest, legacyBankPrivateComparisonDigest([{ ...row, card_no: second.card_no }, second], salt));
  assert.notEqual(digest, legacyBankPrivateComparisonDigest([row, second], "b".repeat(64)));
  assert.throws(() => legacyBankPrivateComparisonDigest([row, row], salt));
  assert(!digest.includes(row.name)); assert(!digest.includes(row.card_no));
});
test("未绑定来源不能取得私有行或触发连接", async () => {
  assert.throws(() => useBoundLegacyBankSource({}));
  assert.throws(() => useBoundLegacyBankSelection({}));
  await assert.rejects(captureBoundLegacyBankSource({}, () => ""), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
  await assert.rejects(captureBoundLegacyBankSelection("not-a-sealed-manifest", "a".repeat(64)), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
});
