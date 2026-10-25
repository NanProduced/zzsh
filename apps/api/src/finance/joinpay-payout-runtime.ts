import { ConfigurationError, readSecret, type AppConfig } from "../config/config";
import type { AuthRuntimeOptions } from "../auth/auth-runtime";
import { assertPayoutProfile, bindPayoutProfile, createPayoutScope, describePayoutProfile, type PayoutProfileInput, type PayoutProfileOperation } from "./joinpay-payout-profile";
import { createBankBoundWithdrawalOptions, type WithdrawalBankPolicy } from "./joinpay-withdrawal-bank-source";
import type { WithdrawalBankBindingOptions } from "./withdrawal-bank-binding";

type Assembly = NonNullable<AuthRuntimeOptions["joinpayWithdrawal"]>;
type Context = Pick<AppConfig, "provider" | "database"> & { authEnabled: boolean };
export type JoinpayPayoutRuntimeDocument = { scope: Omit<Parameters<typeof createPayoutScope>[0], "profiles">;
  profiles: PayoutProfileInput[]; newRequestsEnabled: boolean; submitProfileId?: string; queryProfileId: string;
  notifyProfilesByInitialKey: Record<string, string>; keyVariables: Record<string, string>; recovery?: Assembly["recovery"];
  userWithdrawal?: { policy: WithdrawalBankPolicy; identityProvider: string; targetEncoding: "LEGACY_CODE_PASSTHROUGH"; destinationAuthorization: "AUTHENTICATED_USER_DECLARATION" } };
const fail = (code: string): never => { throw new ConfigurationError(code); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);

/** 只装配明确的商户profile和数据库绑卡来源；不会从配置生成每用户银行卡或实名资格。 */
export function loadJoinpayPayoutRuntime(context: Context, bankBinding?: WithdrawalBankBindingOptions,
  env: NodeJS.ProcessEnv = process.env, workingDirectory = process.cwd()): Assembly | undefined {
  const enabled = env.JOINPAY_PAYOUT_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") return fail("JOINPAY_PAYOUT_ENABLED_INVALID");
  if (enabled === "false") return undefined;
  if (!context.authEnabled || context.provider !== "real" || context.database.user !== context.database.runtimeUser) return fail("JOINPAY_PAYOUT_CONTEXT_INVALID");
  let d: JoinpayPayoutRuntimeDocument;
  try {
    const raw = readSecret(env, "JOINPAY_PAYOUT_CONFIG", "JOINPAY_PAYOUT_CONFIG_FILE", workingDirectory); if (Buffer.byteLength(raw) > 262144) throw Error();
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || Object.keys(parsed).some(k => !["scope", "profiles", "newRequestsEnabled", "submitProfileId", "queryProfileId", "notifyProfilesByInitialKey", "keyVariables", "recovery", "userWithdrawal"].includes(k))
      || !object(parsed.scope) || Object.keys(parsed.scope).some(k => !["reference", "reviewSha256", "database", "runtimeUser", "merchantIdentityId", "userNo", "tradeMerchantNo", "historicalScopes"].includes(k))
      || !Array.isArray(parsed.profiles) || parsed.profiles.length < 1 || parsed.profiles.length > 32
      || typeof parsed.newRequestsEnabled !== "boolean" || !id(parsed.queryProfileId) || parsed.submitProfileId !== undefined && !id(parsed.submitProfileId)
      || !object(parsed.notifyProfilesByInitialKey) || Object.keys(parsed.notifyProfilesByInitialKey).length < 1 || Object.keys(parsed.notifyProfilesByInitialKey).length > 32
      || Object.entries(parsed.notifyProfilesByInitialKey).some(([ref, value]) => !id(ref) || !id(value)) || !object(parsed.keyVariables)
      || Object.keys(parsed.keyVariables).length > 32 || Object.entries(parsed.keyVariables).some(([ref, value]) => !id(ref) || typeof value !== "string" || !/^JOINPAY_PAYOUT_KEY_[A-Z0-9_]{1,64}$/.test(value))) throw Error();
    d = parsed as JoinpayPayoutRuntimeDocument;
  } catch { return fail("JOINPAY_PAYOUT_CONFIG_UNAVAILABLE"); }
  if (d.scope.database !== context.database.name || d.scope.runtimeUser !== context.database.user) return fail("JOINPAY_PAYOUT_RESOURCE_MISMATCH");
  const r = d.recovery;
  if (r !== undefined && (!object(r) || Object.keys(r).some(k => !["workerId", "batchLimit", "minimumIntervalSeconds"].includes(k)) || !id(r.workerId)
    || !Number.isSafeInteger(r.batchLimit) || r.batchLimit < 1 || r.batchLimit > 10 || !Number.isSafeInteger(r.minimumIntervalSeconds) || r.minimumIntervalSeconds < 30 || r.minimumIntervalSeconds > 86400)) return fail("JOINPAY_PAYOUT_RECOVERY_INVALID");
  try {
    const profiles = new Map(d.profiles.map(p => [`${p.operation}:${p.profileId}`, bindPayoutProfile(p)]));
    if (profiles.size !== d.profiles.length) return fail("JOINPAY_PAYOUT_DUPLICATE_PROFILE");
    const admitted = [...profiles.values()].filter(p => d.newRequestsEnabled || describePayoutProfile(p).operation !== "SUBMIT");
    const scope = createPayoutScope({ ...d.scope, profiles: admitted });
    const selected = (operation: PayoutProfileOperation, profileId: string) => {
      const p = profiles.get(`${operation}:${profileId}`); if (!p) return fail("JOINPAY_PAYOUT_PROFILE_UNAVAILABLE");
      assertPayoutProfile(scope, p, operation); return p;
    };
    const query = selected("QUERY", d.queryProfileId);
    for (const value of Object.values(d.notifyProfilesByInitialKey)) selected("NOTIFY", value);
    for (const p of admitted) if (!Object.hasOwn(d.keyVariables, describePayoutProfile(p).keyVersionRef)) return fail("JOINPAY_PAYOUT_KEY_REFERENCE_MISSING");
    let routes: Assembly["routes"] = { scope };
    if (d.newRequestsEnabled) {
      if (!bankBinding?.protection || !id(d.submitProfileId) || !r || !d.userWithdrawal || !object(d.userWithdrawal)
        || !id(d.userWithdrawal.identityProvider) || Object.keys(d.userWithdrawal).some(k => !["policy", "identityProvider", "targetEncoding", "destinationAuthorization"].includes(k))) return fail("JOINPAY_PAYOUT_USER_SOURCE_UNAVAILABLE");
      routes = createBankBoundWithdrawalOptions({ scope, profile: selected("SUBMIT", d.submitProfileId), bankBinding, ...d.userWithdrawal });
    }
    const profileFor: NonNullable<Assembly["execution"]>["profileFor"] = (operation, original, pinned) => {
      const profile = pinned ? selected(operation, pinned.profileId) : operation === "SUBMIT" ? selected(operation, original.initialProfileId)
        : operation === "QUERY" ? query : selected(operation, d.notifyProfilesByInitialKey[original.initialKeyVersionRef] ?? "");
      const view = describePayoutProfile(profile, operation);
      if (pinned && (view.profileSha256 !== pinned.profileSha256 || view.keyVersionRef !== pinned.keyVersionRef)) return fail("JOINPAY_PAYOUT_PINNED_PROFILE_MISMATCH");
      if (view.merchantIdentityId !== original.merchantIdentityId || view.userNo !== original.userNo || view.tradeMerchantNo !== original.tradeMerchantNo || original.currency !== "CNY") return fail("JOINPAY_PAYOUT_ORIGINAL_MERCHANT_MISMATCH");
      for (const k of ["encodingRuleRef", "encodingRuleSha256", "encodingImplementationRef", "encodingImplementationSha256", "targetEchoRuleRef", "targetEchoRuleSha256"] as const)
        if (view.targetRules[k] !== original[k]) return fail("JOINPAY_PAYOUT_ORIGINAL_TARGET_RULE_MISMATCH");
      return profile;
    };
    const keys = new Map<string, string>(), keyFor = (reference: string) => {
      if (!Object.hasOwn(d.keyVariables, reference)) return fail("JOINPAY_PAYOUT_KEY_REFERENCE_MISSING");
      if (!keys.has(reference)) {
        try { const variable = d.keyVariables[reference]!, value = readSecret(env, variable, `${variable}_FILE`, workingDirectory);
          if (value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) throw Error(); keys.set(reference, value);
        } catch { return fail("JOINPAY_PAYOUT_KEY_UNAVAILABLE"); }
      }
      return keys.get(reference)!;
    };
    return { routes, execution: { ...routes, scope, profileFor, keyFor }, notifications: true, ...(r ? { recovery: Object.freeze({ ...r }) } : {}) };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return fail("JOINPAY_PAYOUT_ASSEMBLY_REJECTED");
  }
}
