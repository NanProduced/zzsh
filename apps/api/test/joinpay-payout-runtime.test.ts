import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AppConfig } from "../src/config/config";
import type { INestApplication } from "@nestjs/common";
import { loadJoinpayPayoutRuntime, type JoinpayPayoutRuntimeDocument } from "../src/finance/joinpay-payout-runtime";
import { bindPayoutProfile, describePayoutProfile, readPayoutScope, type PayoutBinding } from "../src/finance/joinpay-payout-profile";
import { mountChannelWithdrawalRoutes } from "../src/finance/controlled-withdrawal-routes";
import * as identity from "../src/auth/user-identity";
import { profile, policy, verified, bound } from "./fixtures/joinpay-withdrawal-bank-source-model";
import { actor, input, fixture } from "./fixtures/withdrawal-bank-binding-model";

// SYNTHETIC_RUNTIME_COMPONENT：内存配置/身份/钥，不是实际商户开通、身份验证或资金执行。
const context = { provider: "real" as const, authEnabled: true, database: { name: "unit_bank_database", user: "unit_bank_r", runtimeUser: "unit_bank_r" } as AppConfig["database"] };
function document(enabled = false): JoinpayPayoutRuntimeDocument {
  return { scope: { reference: "unit_runtime_scope", reviewSha256: "2".repeat(64), database: context.database.name, runtimeUser: context.database.user, merchantIdentityId: "unit_merchant", userNo: "999900000000005" },
    profiles: enabled ? [profile("SUBMIT"), profile("QUERY"), profile("NOTIFY")] : [profile("QUERY"), profile("NOTIFY")], newRequestsEnabled: enabled,
    ...(enabled ? { submitProfileId: "unit_SUBMIT", userWithdrawal: { policy: policy(), identityProvider: "unit_identity_provider", targetEncoding: "LEGACY_CODE_PASSTHROUGH" as const, destinationAuthorization: "AUTHENTICATED_USER_DECLARATION" as const } } : {}),
    queryProfileId: "unit_QUERY", notifyProfilesByInitialKey: { unit_merchant_key: "unit_NOTIFY" }, keyVariables: { unit_merchant_key: "JOINPAY_PAYOUT_KEY_01" },
    recovery: { workerId: "unit_payout_worker", batchLimit: 2, minimumIntervalSeconds: 600 } };
}
const environment = (d = document()): NodeJS.ProcessEnv => ({ JOINPAY_PAYOUT_ENABLED: "true", JOINPAY_PAYOUT_CONFIG: JSON.stringify(d), JOINPAY_PAYOUT_KEY_01: "SYNTHETIC_PAYOUT_KEY_ONLY" });
const rejected = (f: () => unknown, message: string) => assert.throws(f, { name: "ConfigurationError", message });
function original(d = document(true)): PayoutBinding {
  const raw = d.profiles.find(p => p.operation === "SUBMIT") ?? profile("SUBMIT"), p = describePayoutProfile(bindPayoutProfile(raw)), { binding: _binding, ...rules } = raw.targetRules;
  return { intentId: "unit_original_intent", userId: actor.userId, merchantIdentityId: raw.merchantIdentityId, userNo: raw.userNo, merchantOrderNo: "UNITWITHDRAW20261025", receiverAccountNoEnc: input.cardNo,
    receiverNameEnc: input.name, netCents: "9900", grossCents: "10000", feeCents: "100", currency: "CNY", targetFingerprint: "3".repeat(64), receiverAccountType: "201",
    initialProfileId: p.profileId, initialProfileSha256: p.profileSha256, initialKeyVersionRef: p.keyVersionRef, ...rules };
}
test("默认关闭只读开关；错误上下文和开关先于配置/钥拒绝", () => {
  const env = new Proxy({}, { get(_o, key) { if (key !== "JOINPAY_PAYOUT_ENABLED") throw Error("unexpected private access"); return undefined; } });
  assert.equal(loadJoinpayPayoutRuntime(context, undefined, env), undefined);
  for (const value of ["", "TRUE", "1", " true"]) rejected(() => loadJoinpayPayoutRuntime(context, undefined, { JOINPAY_PAYOUT_ENABLED: value }), "JOINPAY_PAYOUT_ENABLED_INVALID");
  for (const c of [{ ...context, authEnabled: false }, { ...context, provider: "fake" as const }, { ...context, database: { ...context.database, user: "other_role" } }])
    rejected(() => loadJoinpayPayoutRuntime(c, undefined, { JOINPAY_PAYOUT_ENABLED: "true" }), "JOINPAY_PAYOUT_CONTEXT_INVALID");
});
test("仅查询/通知不需要当前用户绑卡、SUBMIT或实名资料，也不读取钥", () => {
  let keys = 0; const env = new Proxy(environment(), { get(target, key) { if (String(key).startsWith("JOINPAY_PAYOUT_KEY_")) keys++; return Reflect.get(target, key); } });
  const a = loadJoinpayPayoutRuntime(context, undefined, env)!; assert.equal(a.routes.scope, a.execution!.scope); assert.equal(a.routes.loadAdmission, undefined); assert.equal(a.routes.initialProfile, undefined);
  assert.equal(a.notifications, true); assert.equal(keys, 0); assert.equal(readPayoutScope(a.routes.scope).acceptedProfiles.some(p => p.operation === "SUBMIT"), false);
  assert.equal(describePayoutProfile(a.execution!.profileFor("QUERY", original())).operation, "QUERY");
  rejected(() => a.execution!.profileFor("SUBMIT", original()), "JOINPAY_PAYOUT_PROFILE_UNAVAILABLE");
});
test("关闭新出款时，即使配置保留SUBMIT也不把它装进当前scope", () => {
  const d = document(true); d.newRequestsEnabled = false; const a = loadJoinpayPayoutRuntime(context, undefined, environment(d))!;
  assert.equal(readPayoutScope(a.routes.scope).acceptedProfiles.length, 2); assert.equal(a.routes.loadAdmission, undefined);
  assert.throws(() => a.execution!.profileFor("SUBMIT", original(d)));
});
test("新提现显式要求持久绑卡来源、业务政策、调度及三个操作，不能由配置生成个人目标", () => {
  const f = fixture(); rejected(() => loadJoinpayPayoutRuntime(context, undefined, environment(document(true))), "JOINPAY_PAYOUT_USER_SOURCE_UNAVAILABLE");
  for (const mutate of [(d: any) => delete d.recovery, (d: any) => delete d.userWithdrawal, (d: any) => delete d.submitProfileId]) {
    const d = document(true); mutate(d); rejected(() => loadJoinpayPayoutRuntime(context, f.options, environment(d)), "JOINPAY_PAYOUT_USER_SOURCE_UNAVAILABLE");
  }
  for (const mutate of [(d: any) => d.admissions = [{ userId: actor.userId }], (d: any) => d.scope.targets = [input]]) {
    const d = document(true); mutate(d); rejected(() => loadJoinpayPayoutRuntime(context, f.options, environment(d)), "JOINPAY_PAYOUT_CONFIG_UNAVAILABLE");
  }
});
test("所有操作可以共用profileId；新资格仍来自DB而非JSON字符串", async () => {
  const { f } = await bound(), d = document(true); d.profiles = d.profiles.map(p => ({ ...p, profileId: "unit_shared_id" }));
  d.submitProfileId = d.queryProfileId = "unit_shared_id"; d.notifyProfilesByInitialKey.unit_merchant_key = "unit_shared_id";
  const a = loadJoinpayPayoutRuntime(context, f.options, environment(d))!;
  assert.equal(readPayoutScope(a.routes.scope).acceptedProfiles.length, 3);
  const c: any = await a.routes.readContext!(f.client, actor); assert.equal(c.canQuote, false); assert.equal(c.bankBinding.binding.ownershipVerification, "NOT_VERIFIED");
});
test("原号按操作/初始key/精确pin选单一profile，钥轮换不试多钥", () => {
  const d = document(true), old = original(d); d.profiles.push({ ...profile("QUERY"), profileId: "unit_query_next", keyVersionRef: "unit_key_next" });
  d.keyVariables.unit_key_next = "JOINPAY_PAYOUT_KEY_02"; d.queryProfileId = "unit_query_next";
  const a = loadJoinpayPayoutRuntime(context, fixture().options, environment(d))!, source = a.execution!;
  assert.equal(describePayoutProfile(source.profileFor("QUERY", old)).keyVersionRef, "unit_key_next");
  assert.equal(describePayoutProfile(source.profileFor("NOTIFY", old)).profileId, "unit_NOTIFY");
  const previous = describePayoutProfile(bindPayoutProfile(profile("QUERY")));
  assert.equal(describePayoutProfile(source.profileFor("QUERY", old, { profileId: previous.profileId, profileSha256: previous.profileSha256, keyVersionRef: previous.keyVersionRef })).profileSha256, previous.profileSha256);
  rejected(() => source.profileFor("QUERY", old, { profileId: previous.profileId, profileSha256: "f".repeat(64), keyVersionRef: previous.keyVersionRef }), "JOINPAY_PAYOUT_PINNED_PROFILE_MISMATCH");
});
test("错商户、原目标规则、缺通知选择或重复profile拒绝", () => {
  const a = loadJoinpayPayoutRuntime(context, undefined, environment())!;
  rejected(() => a.execution!.profileFor("QUERY", { ...original(), userNo: "999900000000006" }), "JOINPAY_PAYOUT_ORIGINAL_MERCHANT_MISMATCH");
  rejected(() => a.execution!.profileFor("QUERY", { ...original(), targetEchoRuleSha256: "f".repeat(64) }), "JOINPAY_PAYOUT_ORIGINAL_TARGET_RULE_MISMATCH");
  for (const mutate of [(d: any) => d.notifyProfilesByInitialKey = {}, (d: any) => d.profiles.push(d.profiles[0])]) {
    const d = document(); mutate(d); assert.throws(() => loadJoinpayPayoutRuntime(context, undefined, environment(d)));
  }
});
test("商户钥精确惰性读取/缓存，不能把本地资料保护钥引用当商户钥", () => {
  let reads = 0; const env = new Proxy(environment(), { get(target, key) { if (String(key).startsWith("JOINPAY_PAYOUT_KEY_")) reads++; return Reflect.get(target, key); } });
  const a = loadJoinpayPayoutRuntime(context, undefined, env)!; assert.equal(reads, 0); assert.equal(a.execution!.keyFor("unit_merchant_key"), "SYNTHETIC_PAYOUT_KEY_ONLY"); const count = reads;
  a.execution!.keyFor("unit_merchant_key"); assert.equal(reads, count); rejected(() => a.execution!.keyFor("unknown"), "JOINPAY_PAYOUT_KEY_REFERENCE_MISSING");
  const d = document(); d.keyVariables.unit_merchant_key = "WITHDRAWAL_BANK_KEY_01"; rejected(() => loadJoinpayPayoutRuntime(context, undefined, environment(d)), "JOINPAY_PAYOUT_CONFIG_UNAVAILABLE");
});
test("公共A2、合成用途、资源漂移和非法政策都不取得正式代付装配", () => {
  for (const mutate of [(d: any) => d.scope.userNo = "888100000002340", (d: any) => d.profiles[0].purpose = "SYNTHETIC_PROTOCOL"]) {
    const d = document(); mutate(d); rejected(() => loadJoinpayPayoutRuntime(context, undefined, environment(d)), "JOINPAY_PAYOUT_ASSEMBLY_REJECTED");
  }
  const d = document(); d.scope.database = "other_db"; rejected(() => loadJoinpayPayoutRuntime(context, undefined, environment(d)), "JOINPAY_PAYOUT_RESOURCE_MISMATCH");
  for (const interval of [0, 29, 86401]) { const v = document(); v.recovery!.minimumIntervalSeconds = interval; rejected(() => loadJoinpayPayoutRuntime(context, undefined, environment(v)), "JOINPAY_PAYOUT_RECOVERY_INVALID"); }
});
test("options端点实际调用本人只读来源；现有路由不以GET触发外部出款", async t => {
  const { f } = await bound(), a = loadJoinpayPayoutRuntime(context, f.options, environment(document(true)))!, handlers = new Map<string, (...args: any[]) => Promise<void>>();
  t.mock.method(identity, "readUserContext", async () => actor);
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ use: (p: string, h: any) => handlers.set(p, h) }) }) } as unknown as INestApplication;
  mountChannelWithdrawalRoutes(app, { pool: f.pool, apiOrigin: "https://api.invalid", userOrigin: "https://user.invalid", adminOrigin: "https://admin.invalid", joinpayWithdrawal: a.routes } as any);
  const keys = f.keys(); const reply: any = { status(n: number) { this.code = n; return this; }, setHeader() { return this; }, json(body: unknown) { this.body = body; } };
  await handlers.get("/api/v1/users/me/channel-withdrawals")!({ method: "GET", originalUrl: "/api/v1/users/me/channel-withdrawals/options", headers: { origin: "https://user.invalid" } }, reply);
  assert.equal(reply.code, 200); assert.equal(reply.body.contractVersion, "withdrawal-request-context.v1"); assert.equal(reply.body.canQuote, false); assert.equal(f.keys(), keys);
  assert(!JSON.stringify(reply.body).includes(input.cardNo));
});
test("普通main真正装配；readContext与既有出款ready门禁一起保留", () => {
  const main = readFileSync("src/main.ts", "utf8"), auth = readFileSync("src/auth/auth-runtime.ts", "utf8");
  assert(main.includes("const joinpayWithdrawal = loadJoinpayPayoutRuntime(")); assert(main.indexOf("const joinpayWithdrawal") < main.indexOf("const businessPool"));
  assert(main.includes("...(joinpayWithdrawal ? { joinpayWithdrawal } : {})")); assert(auth.includes("payoutReady?{readContext:payout.routes.readContext,initialProfile:"));
});
