import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/config/config";
import { loadUserProviderRuntime } from "../src/auth/user-provider-runtime";
import { loadAuthRuntimeConfig, resolvePhoneLoginSmsScene } from "../src/auth/auth-runtime";
import { securitySmsScene } from "../src/auth/user-security";
import type { PoolClient } from "pg";

const auth = { AUTH_USER_SECRET: "u".repeat(32), AUTH_ADMIN_SECRET: "a".repeat(32) };
const sms = { USER_SMS_PROVIDER: "aliyun", USER_SMS_ACCESS_KEY_ID: "offline-test-id", USER_SMS_ACCESS_KEY_SECRET: "s".repeat(40), USER_SMS_SIGN_NAME: "测试签名", USER_SMS_TEMPLATE_CODE: "SMS_OFFLINE" };
const identity = { USER_REAL_NAME_PROVIDER: "aliyun-id2meta", USER_REAL_NAME_ACCESS_KEY_ID: "offline-test-id", USER_REAL_NAME_ACCESS_KEY_SECRET: "r".repeat(40), USER_IDENTITY_SUBJECT_HMAC_KEY: "i".repeat(64) };

test("user channels are default closed and never inherit media credentials", () => {
  assert.deepEqual(loadUserProviderRuntime({ ALIBABA_CLOUD_ACCESS_KEY_ID: "media-test-id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "m".repeat(40) }), {});
  assert.throws(() => loadUserProviderRuntime({ USER_SMS_PROVIDER: "aliyun", ALIBABA_CLOUD_ACCESS_KEY_ID: "media-test-id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "m".repeat(40) }), ConfigurationError);
});

test("explicit SMS construction performs no send and cannot combine with a fixed mock", () => {
  assert.equal(typeof loadUserProviderRuntime(sms).userSmsSender, "function");
  const configured=loadUserProviderRuntime({...sms,USER_SMS_TEMPLATE_LOGIN:"SMS_LOGIN",USER_SMS_TEMPLATE_CHANGE_MOBILE:"SMS_CHANGE",USER_SMS_TEMPLATE_FORGOT_PASSWORD:"SMS_FORGOT",USER_SMS_TEMPLATE_OWNER_ORDER_PAID:"SMS_OWNER"});
  assert.equal(configured.userSmsConfiguration?.scenes.LOGIN.source,"SCENE");
  assert.equal(configured.userSmsConfiguration?.scenes.REGISTER.source,"SHARED");
  assert.equal(configured.userSmsConfiguration?.scenes.OWNER_ORDER_PAID.templateCode,"SMS_OWNER");
  assert.equal(configured.userSmsConfiguration?.scenes.CHANGE_MOBILE.templateCode,"SMS_CHANGE");
  assert.equal(configured.userSmsConfiguration?.scenes.FORGOT_PASSWORD.templateCode,"SMS_FORGOT");
  assert.throws(() => loadUserProviderRuntime({ ...sms, AUTH_LOCAL_SMS_MOCK: "true" }), /exclusive/);
  assert.throws(() => loadUserProviderRuntime({ ...sms, USER_SMS_TEMPLATE_CODE: "invalid" }), /OTP template/);
  assert.throws(() => loadUserProviderRuntime({ ...sms, USER_SMS_TEMPLATE_LOGIN: "invalid" }), /Invalid SMS template/);
});

test("marketplace identity uses an independently configured AppCode", () => {
  const market={USER_REAL_NAME_PROVIDER:"aliyun-market-id2",USER_REAL_NAME_APPCODE:"synthetic_appcode_123456789"};
  assert.equal(loadUserProviderRuntime(market).realNameProvider?.provider,"aliyun-market-id2");
  assert.throws(()=>loadUserProviderRuntime({...market,USER_REAL_NAME_APPCODE:""}),ConfigurationError);
  assert.throws(()=>loadUserProviderRuntime({...identity,USER_REAL_NAME_PROVIDER:"aliyun-market-id2"}),ConfigurationError);
});

test("SMS login and security scenes come from server-side account state",async()=>{
  for(const [registered,conflict,expected] of [[true,false,"LOGIN"],[false,true,"LOGIN"],[false,false,"REGISTER"]] as const){
    const client={query:async(sql:string)=>({rows:[sql.includes('AS registered')?{registered}:{blocked:conflict}]})} as unknown as PoolClient;
    assert.equal(await resolvePhoneLoginSmsScene(client,"+8613800138000"),expected);
  }
  const unavailable={query:async()=>({rows:[]})} as unknown as PoolClient;
  await assert.rejects(resolvePhoneLoginSmsScene(unavailable,"+8613800138000"));
  assert.equal(securitySmsScene("phone","target",true),"CHANGE_MOBILE");
  assert.equal(securitySmsScene("phone","target",false),"BIND");
  assert.equal(securitySmsScene("recovery","current",true),"FORGOT_PASSWORD");
  for(const purpose of ["phone","password","email"] as const)assert.equal(securitySmsScene(purpose,"current",true),"IDENTITY");
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
