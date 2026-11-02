import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/config/config";
import { loadUserProviderRuntime } from "../src/auth/user-provider-runtime";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";

const auth = { AUTH_USER_SECRET: "u".repeat(32), AUTH_ADMIN_SECRET: "a".repeat(32) };
const sms = { USER_SMS_PROVIDER: "aliyun", USER_SMS_ACCESS_KEY_ID: "offline-test-id", USER_SMS_ACCESS_KEY_SECRET: "s".repeat(40), USER_SMS_SIGN_NAME: "测试签名", USER_SMS_TEMPLATE_CODE: "SMS_OFFLINE" };
const identity = { USER_REAL_NAME_PROVIDER: "aliyun-id2meta", USER_REAL_NAME_ACCESS_KEY_ID: "offline-test-id", USER_REAL_NAME_ACCESS_KEY_SECRET: "r".repeat(40), USER_IDENTITY_SUBJECT_HMAC_KEY: "i".repeat(64) };

test("user channels are default closed and never inherit media credentials", () => {
  assert.deepEqual(loadUserProviderRuntime({ ALIBABA_CLOUD_ACCESS_KEY_ID: "media-test-id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "m".repeat(40) }), {});
  assert.throws(() => loadUserProviderRuntime({ USER_SMS_PROVIDER: "aliyun", ALIBABA_CLOUD_ACCESS_KEY_ID: "media-test-id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "m".repeat(40) }), ConfigurationError);
});

test("explicit SMS construction performs no send and cannot combine with a fixed mock", () => {
  assert.equal(typeof loadUserProviderRuntime(sms).userSmsSender, "function");
  assert.throws(() => loadUserProviderRuntime({ ...sms, AUTH_LOCAL_SMS_MOCK: "true" }), /exclusive/);
  assert.throws(() => loadUserProviderRuntime({ ...sms, USER_SMS_TEMPLATE_CODE: "invalid" }), /OTP template/);
});

test("unknown provider modes are rejected rather than silently falling back", () => {
  assert.throws(() => loadUserProviderRuntime({ USER_SMS_PROVIDER: "auto" }), /USER_SMS_PROVIDER/);
  assert.throws(() => loadUserProviderRuntime({ USER_REAL_NAME_PROVIDER: "fake-success" }), /USER_REAL_NAME_PROVIDER/);
});

test("real identity needs an independent subject key and explicit cost policy before activation", () => {
  assert.throws(() => loadAuthRuntimeConfig({ ...auth, ...identity }), /USER_REAL_NAME_DAILY_LIMIT/);
  assert.throws(() => loadAuthRuntimeConfig({ ...auth, ...identity, USER_REAL_NAME_DAILY_LIMIT: "5" }), /USER_REAL_NAME_MIN_INTERVAL_SECONDS/);
  for (const limit of ["0", "-1", "1.5", "NaN", "101"]) assert.throws(() => loadAuthRuntimeConfig({ ...auth, ...identity, USER_REAL_NAME_DAILY_LIMIT: limit, USER_REAL_NAME_MIN_INTERVAL_SECONDS: "60" }), ConfigurationError);
  const config = loadAuthRuntimeConfig({ ...auth, ...identity, USER_REAL_NAME_DAILY_LIMIT: "5", USER_REAL_NAME_MIN_INTERVAL_SECONDS: "60" });
  assert.equal(config.realNameProvider?.provider, "aliyun-id2meta");
  assert.deepEqual(config.userRealNamePolicy, { dailyLimit: 5, minIntervalSeconds: 60 });
  assert.equal(config.userIdentitySubjectKey?.length, 32);
});
