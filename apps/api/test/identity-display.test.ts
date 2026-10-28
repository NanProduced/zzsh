import assert from "node:assert/strict";
import { test } from "node:test";
import { maskIdCard, maskRealName, readIdentityDisplay, type IdentityDisplayStore } from "../src/auth/identity-display";

// Synthetic values only.
test("identity-mask-v1 name and id rules", () => {
  assert.equal(maskRealName("甲"), "*");
  assert.equal(maskRealName("甲乙"), "甲*");
  assert.equal(maskRealName("甲乙丙"), "甲*丙");
  assert.equal(maskRealName("甲乙丙丁"), "甲**丁");
  assert.equal(maskIdCard("11010119900101123X"), "110101********123X");
  assert.equal(maskIdCard("ABCDEFGH"), "****EFGH");
});

test("display read: verified/recorded, not recorded, not verified, store unavailable, no value leak on error", async () => {
  const store = (row: { realName: string; idCardNo: string } | null, err?: object): IdentityDisplayStore => ({ read: async () => { if (err) throw err; return row; } });
  const ok = await readIdentityDisplay(store({ realName: "测试人", idCardNo: "000000200001010000" }), "u", "VERIFIED");
  assert.deepEqual(ok, { identityDisplay: { realNameMasked: "测*人", idCardMasked: "000000********0000", maskingVersion: "identity-mask-v1" }, identityDisplayReason: null });
  assert.ok(!JSON.stringify(ok).includes("20000101"));
  assert.equal((await readIdentityDisplay(store(null), "u", "VERIFIED")).identityDisplayReason, "NOT_RECORDED");
  let called = false;
  assert.equal((await readIdentityDisplay({ read: async () => { called = true; return null; } }, "u", "UNVERIFIED")).identityDisplayReason, "NOT_VERIFIED");
  assert.equal(called, false);
  assert.equal((await readIdentityDisplay(store(null, { code: "42P01" }), "u", "VERIFIED")).identityDisplayReason, "STORE_UNAVAILABLE");
  await assert.rejects(readIdentityDisplay(store(null, { code: "XX", message: "测试人 000000200001010000" }), "u", "VERIFIED"), (e: Error) => !e.message.includes("000000200001010000"));
});
