import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadJoinpayAccountRuntime, type JoinpayAccountRuntimeDocument } from "../src/finance/joinpay-account-runtime";
import { assertJoinpayAccountReadProfile, type JoinpayAccountOperation, type JoinpayAccountServerProfile } from "../src/finance/joinpay-account";
import type { AppConfig } from "../src/config/config";

// SYNTHETIC_ASSEMBLY_ONLY：虚构配置与内存钥，不是商户授权或官方签名向量。
const KEY = "runtime_fixture_key_only";
const context = { provider: "real" as const, authEnabled: true,
  database: { name: "account_runtime_fixture", user: "account_fixture_r", runtimeUser: "account_fixture_r" } as AppConfig["database"] };
function profile(operation: JoinpayAccountOperation): JoinpayAccountServerProfile {
  return { purpose: "MERCHANT_READ", resourceDatabase: context.database.name, resourceRuntimeUser: context.database.user,
    operation, profileId: "fixture_" + operation, merchantIdentityId: "fixture_merchant", userNo: "999900000000005", keyVersionRef: "fixture_key",
    reviewRef: "SYNTHETIC_REVIEW_NOT_OFFICIAL", reviewSha256: "a".repeat(64), permission: "REVIEWED_MERCHANT_BALANCE_READ", knownAnswer: "NOT_OBTAINED",
    rules: { dataEncoding: "OBJECT", statusCodeToken: "NUMBER", amountToken: "NUMBER", currencyToken: "NUMBER", numericSigning: "RAW_JSON_TOKEN",
      optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT", unknownFields: "REJECT", amount: { unit: "UNKNOWN" } } };
}
function document(refresh = false): JoinpayAccountRuntimeDocument {
  return { resource: { database: context.database.name, runtimeUser: context.database.user }, merchantIdentityId: "fixture_merchant", readAdminIds: ["fixture_admin"],
    ...(refresh ? { observation: { intervalSeconds: 300, profiles: [profile("AVAILABLE"), profile("COLLECTION")], keyVariables: { fixture_key: "JOINPAY_ACCOUNT_KEY_01" } } } : {}) };
}
const environment = (d = document()): NodeJS.ProcessEnv => ({ JOINPAY_ACCOUNTS_ENABLED: "true", JOINPAY_ACCOUNTS_CONFIG: JSON.stringify(d), JOINPAY_ACCOUNT_KEY_01: KEY });
const rejected = (f: () => unknown, code: string) => assert.throws(f, { name: "ConfigurationError", message: code });

test("默认及显式关闭只读开关，0配置/0钥/0连接", () => {
  for (const enabled of [undefined, "false"]) {
    const reads: string[] = [], env = new Proxy({ JOINPAY_ACCOUNTS_ENABLED: enabled }, { get(target, key) {
      reads.push(String(key)); if (key !== "JOINPAY_ACCOUNTS_ENABLED") throw Error("unexpected private access"); return Reflect.get(target, key);
    } });
    assert.equal(loadJoinpayAccountRuntime(context, env), undefined); assert.deepEqual(reads, ["JOINPAY_ACCOUNTS_ENABLED"]);
  }
});
test("非法开关及认证/runtime身份先于配置读取拒绝", () => {
  for (const value of ["", "TRUE", " true", "1", "false "]) rejected(() => loadJoinpayAccountRuntime(context, { JOINPAY_ACCOUNTS_ENABLED: value }), "JOINPAY_ACCOUNTS_ENABLED_INVALID");
  for (const c of [{ ...context, authEnabled: false }, { ...context, database: { ...context.database, user: "wrong_role" } }]) {
    const env = new Proxy({ JOINPAY_ACCOUNTS_ENABLED: "true" }, { get(target, key) {
      if (key !== "JOINPAY_ACCOUNTS_ENABLED") throw Error("config accessed before context validation"); return Reflect.get(target, key);
    } });
    rejected(() => loadJoinpayAccountRuntime(c, env), "JOINPAY_ACCOUNTS_RUNTIME_CONTEXT_INVALID");
  }
});
test("仅本地读取无需真实provider或商户钥；授权只给显式管理员和一个商户", () => {
  let keys = 0; const env = new Proxy(environment(), { get(target, key) { if (String(key).startsWith("JOINPAY_ACCOUNT_KEY_")) keys++; return Reflect.get(target, key); } });
  const a = loadJoinpayAccountRuntime({ ...context, provider: "fake" }, env)!;
  assert.equal(a.observation, undefined); assert.equal(keys, 0);
  assert.deepEqual([...a.read.merchantIdsByAdmin.get("fixture_admin")!], ["fixture_merchant"]);
  assert.equal(a.read.merchantIdsByAdmin.has("another_admin"), false);
  const d = document(); d.readAdminIds = []; assert.equal(loadJoinpayAccountRuntime(context, environment(d))!.read.merchantIdsByAdmin.size, 0);
});
test("配置错误不回显输入；资源错绑不开放读取", () => {
  for (const raw of ["private-config-broken", "x".repeat(262145), "null"]) rejected(() => loadJoinpayAccountRuntime(context,
    { JOINPAY_ACCOUNTS_ENABLED: "true", JOINPAY_ACCOUNTS_CONFIG: raw }), "JOINPAY_ACCOUNTS_CONFIG_UNAVAILABLE");
  for (const name of ["database", "runtimeUser"] as const) {
    const d = document(); d.resource[name] = "another_resource"; rejected(() => loadJoinpayAccountRuntime(context, environment(d)), "JOINPAY_ACCOUNTS_RESOURCE_MISMATCH");
  }
});
test("管理员重复/非法/超量与未知配置字段拒绝", () => {
  for (const mutate of [(d: any) => d.readAdminIds.push("fixture_admin"), (d: any) => d.readAdminIds.push(" "),
    (d: any) => d.readAdminIds = Array.from({ length: 257 }, (_, i) => "fixture_" + i), (d: any) => d.allAdmins = true,
    (d: any) => d.resource.unreviewed = true]) {
    const d = document(); mutate(d); rejected(() => loadJoinpayAccountRuntime(context, environment(d)), "JOINPAY_ACCOUNTS_CONFIG_UNAVAILABLE");
  }
});
test("只有主动刷新要求真实provider；不读取商户钥", () => {
  rejected(() => loadJoinpayAccountRuntime({ ...context, provider: "fake" }, environment(document(true))), "JOINPAY_ACCOUNTS_OBSERVATION_REQUIRES_REAL_PROVIDER");
});
test("只装显式操作，不补另一个账户；官方向量尚未取得不被伪造为通过", () => {
  const d = document(true); d.observation!.profiles = [profile("AVAILABLE")];
  const a = loadJoinpayAccountRuntime(context, environment(d))!;
  assert.equal(a.observation!.profiles.length, 1); assert.equal(assertJoinpayAccountReadProfile(a.observation!.profiles[0]!).operation, "AVAILABLE");
  assert.equal(d.observation!.profiles[0]!.knownAnswer, "NOT_OBTAINED");
});
test("重复操作、商户/库/角色/线上商户号错绑拒绝", () => {
  for (const mutate of [(d: JoinpayAccountRuntimeDocument) => d.observation!.profiles[1] = profile("AVAILABLE"),
    (d: any) => d.observation.profiles[1].merchantIdentityId = "another_merchant", (d: any) => d.observation.profiles[1].resourceDatabase = "other_db",
    (d: any) => d.observation.profiles[1].resourceRuntimeUser = "other_role", (d: any) => d.observation.profiles[1].userNo = "999900000000006"]) {
    const d = document(true); mutate(d); rejected(() => loadJoinpayAccountRuntime(context, environment(d)), "JOINPAY_ACCOUNTS_PROFILE_SCOPE_MISMATCH");
  }
});
test("合成用途、公共A2及伪造profile不取得余额刷新资格", () => {
  for (const mutate of [(d: any) => d.observation.profiles[0].purpose = "SYNTHETIC_PROTOCOL", (d: any) => d.observation.profiles[0].userNo = "888100000002340",
    (d: any) => d.observation.profiles[0].permission = "COLLECTION_ONLY"]) {
    const d = document(true); mutate(d); rejected(() => loadJoinpayAccountRuntime(context, environment(d)), "JOINPAY_ACCOUNTS_ASSEMBLY_REJECTED");
  }
});
test("轮询间隔、操作数及钥命名受限；无隐式余额权限或出网默认", () => {
  for (const value of [undefined, null, 0, 59, 86401, NaN, 60.1]) {
    const d = document(true); d.observation!.intervalSeconds = value as number;
    rejected(() => loadJoinpayAccountRuntime(context, environment(d)), "JOINPAY_ACCOUNTS_OBSERVATION_INVALID");
  }
  for (const value of ["DATABASE_PASSWORD", "JOINPAY_COLLECTION_KEY_01", "JOINPAY_ACCOUNT_KEY_"]) {
    const d = document(true); d.observation!.keyVariables.fixture_key = value;
    rejected(() => loadJoinpayAccountRuntime(context, environment(d)), "JOINPAY_ACCOUNTS_OBSERVATION_INVALID");
  }
  const d = document(true); d.observation!.keyVariables = {};
  rejected(() => loadJoinpayAccountRuntime(context, environment(d)), "JOINPAY_ACCOUNTS_KEY_REFERENCE_MISSING");
});
test("钥引用惰性读取并缓存，越界引用及私有异常不回显", async () => {
  let keys = 0; const env = new Proxy(environment(document(true)), { get(target, key) {
    if (String(key).startsWith("JOINPAY_ACCOUNT_KEY_")) keys++; return Reflect.get(target, key);
  } });
  const a = loadJoinpayAccountRuntime(context, env)!; assert.equal(keys, 0);
  const keyFor = a.observation!.dependencies.keyFor;
  assert.equal(await keyFor("fixture_key"), KEY); const count = keys; assert.equal(await keyFor("fixture_key"), KEY); assert.equal(keys, count);
  rejected(() => keyFor("other_key"), "JOINPAY_ACCOUNTS_KEY_REFERENCE_MISSING");
  const bad = environment(document(true)); bad.JOINPAY_ACCOUNT_KEY_01 = "private key not valid";
  rejected(() => loadJoinpayAccountRuntime(context, bad)!.observation!.dependencies.keyFor("fixture_key"), "JOINPAY_ACCOUNTS_KEY_UNAVAILABLE");
});
test("普通启动/认证装配/生命周期已接线；GET消费者保持原本地reader", () => {
  const main = readFileSync("src/main.ts", "utf8"), auth = readFileSync("src/auth/auth-runtime.ts", "utf8"), module = readFileSync("src/app.module.ts", "utf8"), app = readFileSync("src/app.ts", "utf8");
  assert.equal(main.split("const joinpayAccounts = loadJoinpayAccountRuntime(").length - 1, 1);
  assert(main.indexOf("const joinpayAccounts") < main.indexOf("const businessPool"));
  assert(main.includes("joinpayAccountRead: joinpayAccounts.read, joinpayAccountObservation: joinpayAccounts.observation"));
  assert(auth.includes("app.get(JoinpayAccountObservationLifecycle).start({ ...options.joinpayAccountObservation, pool: options.pool })"));
  assert(module.includes("JoinpayFundsRecoveryLifecycle, JoinpayAccountObservationLifecycle]"));
  assert(app.includes("joinpayAccountRead:options.auth.joinpayAccountRead"));
});
