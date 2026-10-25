import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { AppConfig } from "../src/config/config";
import { loadWithdrawalBankBindingRuntime, type BankBindingRuntimeDocument } from "../src/finance/withdrawal-bank-binding-runtime";

// SYNTHETIC_CONFIG_ONLY：只用内存保护钥，不读私有文件、真实银行卡或JoinPay钥。
const context = { authEnabled: true, database: { name: "unit_bank_database", user: "unit_bank_r", runtimeUser: "unit_bank_r" } as AppConfig["database"] };
const document = (): BankBindingRuntimeDocument => ({ database: context.database.name, runtimeUser: context.database.user, writeEnabled: true,
  currentKeyVersion: "unit_storage_key", keyVariables: { unit_storage_key: "WITHDRAWAL_BANK_KEY_01" } });
const environment = (d = document()): NodeJS.ProcessEnv => ({ WITHDRAWAL_BANK_BINDING_ENABLED: "true", WITHDRAWAL_BANK_BINDING_CONFIG: JSON.stringify(d), WITHDRAWAL_BANK_KEY_01: Buffer.alloc(32, 17).toString("base64url") });
const rejected = (f: () => unknown, message: string) => assert.throws(f, { name: "ConfigurationError", message });
test("默认关闭不读配置/钥；非法开关和认证/runtime错误先拒绝", () => {
  const reads: string[] = [], env = new Proxy({}, { get(_target, p) { reads.push(String(p)); if (p !== "WITHDRAWAL_BANK_BINDING_ENABLED") throw Error(); return undefined; } });
  assert.equal(loadWithdrawalBankBindingRuntime(context, env), undefined); assert.deepEqual(reads, ["WITHDRAWAL_BANK_BINDING_ENABLED"]);
  for (const v of ["", "TRUE", " true", "1"]) rejected(() => loadWithdrawalBankBindingRuntime(context, { WITHDRAWAL_BANK_BINDING_ENABLED: v }), "BANK_BINDING_ENABLED_INVALID");
  for (const c of [{ ...context, authEnabled: false }, { ...context, database: { ...context.database, user: "unit_migration" } }])
    rejected(() => loadWithdrawalBankBindingRuntime(c, { WITHDRAWAL_BANK_BINDING_ENABLED: "true" }), "BANK_BINDING_CONTEXT_INVALID");
});
test("只读模式不需要任何保护钥；不自动开启提现能力", () => {
  const d = document(); d.writeEnabled = false; delete d.currentKeyVersion; delete d.keyVariables;
  assert.deepEqual(loadWithdrawalBankBindingRuntime(context, environment(d)), { database: d.database, runtimeUser: d.runtimeUser });
});
test("资源错绑、未知字段、过长或非法JSON不回显原文", () => {
  const d = document(); d.database = "other_database"; rejected(() => loadWithdrawalBankBindingRuntime(context, environment(d)), "BANK_BINDING_RESOURCE_MISMATCH");
  for (const raw of ["PRIVATE_BROKEN_DOCUMENT", "x".repeat(65537), JSON.stringify({ ...document(), userId: "forbidden_config_identity" })]) {
    rejected(() => loadWithdrawalBankBindingRuntime(context, { WITHDRAWAL_BANK_BINDING_ENABLED: "true", WITHDRAWAL_BANK_BINDING_CONFIG: raw }), "BANK_BINDING_CONFIG_UNAVAILABLE");
  }
});
test("保护钥惰性、按版本精确读取及缓存；返回副本不能损坏缓存", () => {
  let reads = 0; const env = new Proxy(environment(), { get(target, p) { if (String(p).startsWith("WITHDRAWAL_BANK_KEY_")) reads++; return Reflect.get(target, p); } });
  const p = loadWithdrawalBankBindingRuntime(context, env)!.protection!; assert.equal(reads, 0);
  const key = p.keyFor("unit_storage_key"), count = reads; assert.equal(key.byteLength, 32); key.fill(0);
  assert(p.keyFor("unit_storage_key").every(v => v === 17)); assert.equal(reads, count);
  rejected(() => p.keyFor("unknown_version"), "BANK_BINDING_KEY_REFERENCE_MISSING");
});
test("不能拿JoinPay商户钥或错误长度替代本地资料保护钥，私有错误固定脱敏", () => {
  const d = document(); d.keyVariables!.unit_storage_key = "JOINPAY_PAYOUT_KEY_01";
  rejected(() => loadWithdrawalBankBindingRuntime(context, environment(d)), "BANK_BINDING_KEY_REFERENCES_INVALID");
  for (const value of ["PRIVATE_KEY_BAD", Buffer.alloc(31).toString("base64url"), "a".repeat(43), " "]) {
    const env = environment(); env.WITHDRAWAL_BANK_KEY_01 = value;
    rejected(() => loadWithdrawalBankBindingRuntime(context, env)!.protection!.keyFor("unit_storage_key"), "BANK_BINDING_KEY_UNAVAILABLE");
  }
});
test("普通main与认证路由有实际配置调用；资料存储与支付开关独立", () => {
  const main = readFileSync("src/main.ts", "utf8"), auth = readFileSync("src/auth/auth-runtime.ts", "utf8");
  assert.equal(main.split("const withdrawalBankBinding = loadWithdrawalBankBindingRuntime(").length - 1, 1);
  assert(main.indexOf("const withdrawalBankBinding") < main.indexOf("const businessPool"));
  assert(main.includes("...(withdrawalBankBinding ? { withdrawalBankBinding } : {})"));
  assert(auth.includes("mountWithdrawalBankBinding(app, { ...securityOptions, withdrawalBankBinding: options.withdrawalBankBinding })"));
});
