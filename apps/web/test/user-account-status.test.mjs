import { strict as assert } from "node:assert";
import { test } from "node:test";

const {
  accountStatusLabel,
  ageStatusLabel,
  cancellationFailureMessage,
  identityStatusLabel,
  protectedActionReason,
  providerAvailability,
} = await import("../src/app/user-account-status.ts");

test("identity fixtures expose adult, minor, rejection, and unavailable reasons", () => {
  const adult = { identityStatus: "VERIFIED", ageStatus: "ADULT", eligibleForProtectedTrade: true, provider: "fake" };
  const minor = { identityStatus: "VERIFIED", ageStatus: "MINOR", eligibleForProtectedTrade: false, provider: "fake" };
  const rejected = { identityStatus: "REJECTED", ageStatus: "UNKNOWN", eligibleForProtectedTrade: false, provider: "fake" };
  const unavailable = { identityStatus: "UNKNOWN", ageStatus: "UNKNOWN", eligibleForProtectedTrade: false, provider: "none" };

  assert.match(protectedActionReason(adult), /满足服务端身份与年龄门槛/);
  assert.match(protectedActionReason(minor), /年龄不满足/);
  assert.match(protectedActionReason(rejected), /实名校验未通过/);
  assert.match(protectedActionReason(unavailable), /实名服务暂时无法确认/);
  assert.match(providerAvailability(unavailable), /暂未接入/);
  assert.equal(identityStatusLabel(adult.identityStatus), "实名已验证");
  assert.equal(ageStatusLabel(adult.ageStatus), "已确认成年人");
});

test("cancellation feedback distinguishes pending obligations from unknown checks", () => {
  assert.match(cancellationFailureMessage(409, "CONFLICT"), /仍有未完成事项/);
  assert.match(cancellationFailureMessage(503, "INTERNAL_ERROR"), /无法确认未完成事项/);
  assert.equal(accountStatusLabel("CANCELLED"), "账号已注销");
});
