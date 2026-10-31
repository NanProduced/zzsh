import { ConfigurationError, readSecret, type AppConfig } from "../config/config";
import type { AuthRuntimeOptions } from "../auth/auth-runtime";
import { allowedQrUrl } from "./channel-payment-formal-read";
import { validateJoinpayUniPayInput } from "./joinpay-protocol";
import {
  assertCollectionRequestBinding, assertFormalCollectionProfile, assertFormalCollectionStart, bindFormalJoinpayCollectionAdmission,
  bindJoinpayCollectionProfile, describeCollectionProfile, type CollectionPersistedBinding,
  type CollectionProfileOperation, type CollectionServerProfile,
} from "./joinpay-collection-profile";

type Assembly = NonNullable<AuthRuntimeOptions["joinpayCollection"]>;
type Admission = Omit<Parameters<typeof bindFormalJoinpayCollectionAdmission>[0], "profiles">;
export type JoinpayCollectionRuntimeDocument = {
  admission: Admission;
  profiles: CollectionServerProfile[];
  submitProfileId?: string;
  queryProfileId: string;
  notifyProfilesByInitialKey: Record<string, string>;
  keyVariables: Record<string, string>;
  productName?: string;
  qrHostAllowlist: string[];
  newRequestsEnabled: boolean;
  recovery?: NonNullable<Assembly["recovery"]>;
};
type Context = Pick<AppConfig, "provider" | "database"> & { authEnabled: boolean };
const fail = (code: string): never => { throw new ConfigurationError(code); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** 仅显式开启时读取配置；导入及默认关闭不会读取支付配置、密钥或启动后台任务。 */
export function loadJoinpayCollectionRuntime(context: Context, env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd()): Assembly | undefined {
  const enabled = env.JOINPAY_COLLECTION_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") return fail("JOINPAY_COLLECTION_ENABLED_INVALID");
  if (enabled === "false") return undefined;
  if (!context.authEnabled || context.provider !== "real" || context.database.user !== context.database.runtimeUser) {
    return fail("JOINPAY_COLLECTION_RUNTIME_CONTEXT_INVALID");
  }
  let document: JoinpayCollectionRuntimeDocument;
  try {
    const raw = readSecret(env, "JOINPAY_COLLECTION_CONFIG", "JOINPAY_COLLECTION_CONFIG_FILE", workingDirectory);
    if (Buffer.byteLength(raw, "utf8") > 262144) return fail("JOINPAY_COLLECTION_CONFIG_TOO_LARGE");
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || Object.keys(parsed).some(k => !["admission", "profiles", "submitProfileId", "queryProfileId",
      "notifyProfilesByInitialKey", "keyVariables", "productName", "qrHostAllowlist", "newRequestsEnabled", "recovery"].includes(k))
      || !Array.isArray(parsed.profiles) || parsed.profiles.length < 1 || parsed.profiles.length > 32
      || !object(parsed.admission) || !object(parsed.notifyProfilesByInitialKey) || !object(parsed.keyVariables)
      || parsed.submitProfileId !== undefined && !id(parsed.submitProfileId) || !id(parsed.queryProfileId) || typeof parsed.newRequestsEnabled !== "boolean"
      || parsed.productName !== undefined && typeof parsed.productName !== "string"
      || parsed.newRequestsEnabled && (!id(parsed.submitProfileId) || typeof parsed.productName !== "string") || !Array.isArray(parsed.qrHostAllowlist)
      || parsed.qrHostAllowlist.length > 32 || new Set(parsed.qrHostAllowlist).size !== parsed.qrHostAllowlist.length
      || parsed.qrHostAllowlist.some(host => typeof host !== "string" || allowedQrUrl(`https://${host}/`, [host]) === null)
      || parsed.newRequestsEnabled && parsed.qrHostAllowlist.length === 0) return fail("JOINPAY_COLLECTION_CONFIG_INVALID");
    document = parsed as JoinpayCollectionRuntimeDocument;
  } catch { return fail("JOINPAY_COLLECTION_CONFIG_UNAVAILABLE"); }
  if (document.admission.database !== context.database.name || document.admission.runtimeUser !== context.database.user) {
    return fail("JOINPAY_COLLECTION_RESOURCE_MISMATCH");
  }
  const recovery = document.recovery;
  if (recovery !== undefined && (!object(recovery) || Object.keys(recovery).some(k => !["workerId", "batchLimit", "minimumIntervalSeconds"].includes(k))
    || !id(recovery.workerId) || !Number.isSafeInteger(recovery.batchLimit) || recovery.batchLimit < 1 || recovery.batchLimit > 10
    || !Number.isSafeInteger(recovery.minimumIntervalSeconds) || recovery.minimumIntervalSeconds < 30 || recovery.minimumIntervalSeconds > 86400)) {
    return fail("JOINPAY_COLLECTION_RECOVERY_INVALID");
  }
  if (Object.keys(document.keyVariables).length > 96 || Object.entries(document.keyVariables).some(([ref, variable]) => !id(ref)
    || typeof variable !== "string" || !/^JOINPAY_COLLECTION_KEY_[A-Z0-9_]{1,64}$/.test(variable))) return fail("JOINPAY_COLLECTION_KEY_REFERENCE_INVALID");
  if (Object.keys(document.notifyProfilesByInitialKey).length > 32 || Object.entries(document.notifyProfilesByInitialKey)
    .some(([ref, profile]) => !id(ref) || !id(profile))) return fail("JOINPAY_COLLECTION_NOTIFY_SELECTION_INVALID");
  try {
    const profiles = new Map(document.profiles.map(p => [p.profileId, bindJoinpayCollectionProfile(p)]));
    if (profiles.size !== document.profiles.length) return fail("JOINPAY_COLLECTION_DUPLICATE_PROFILE");
    const admission = bindFormalJoinpayCollectionAdmission({ ...document.admission, profiles: [...profiles.values()] });
    const selected = (operation: CollectionProfileOperation, profileId: string) => {
      const profile = profiles.get(profileId);
      if (!profile) return fail("JOINPAY_COLLECTION_PROFILE_UNAVAILABLE");
      describeCollectionProfile(profile, operation);
      return profile;
    };
    const query = selected("QUERY", document.queryProfileId);
    const submit = document.newRequestsEnabled ? selected("SUBMIT", document.submitProfileId!) : undefined;
    const descriptors = new Map(document.profiles.map(p => [p.profileId, p]));
    const submitDescriptor = document.newRequestsEnabled ? descriptors.get(document.submitProfileId!)! : undefined;
    if (document.newRequestsEnabled) {
      assertFormalCollectionStart(admission);
      validateJoinpayUniPayInput({ merchantNo: submitDescriptor!.wireMerchantNo, orderNo: "CONFIGURATION_CHECK", amountCents: "1",
        currency: "CNY", productName: document.productName!, notifyUrl: submitDescriptor!.notifyUrl,
        frpCode: "ALIPAY_NATIVE", tradeMerchantNo: submitDescriptor!.tradeMerchantNo });
    }
    if (!Object.keys(document.notifyProfilesByInitialKey).length) return fail("JOINPAY_COLLECTION_NOTIFY_SELECTION_MISSING");
    // 原请求可使用已退役的下单钥版本；通知选择仍只来自显式映射，不要求保留SUBMIT能力。
    for (const profileId of Object.values(document.notifyProfilesByInitialKey)) selected("NOTIFY", profileId);
    for (const p of document.profiles) for (const [operation, definition] of Object.entries(p.operations)) {
      if (!definition || !Object.hasOwn(document.keyVariables, definition.keyVersionRef)) return fail("JOINPAY_COLLECTION_KEY_REFERENCE_MISSING");
      if (operation === "SUBMIT" && !Object.hasOwn(document.notifyProfilesByInitialKey, definition.keyVersionRef)) {
        return fail("JOINPAY_COLLECTION_NOTIFY_SELECTION_MISSING");
      }
    }
    // 每个通知只选一份显式配置，绝不轮试新旧钥；历史证据按持久化profile三元组恢复。
    const profileFor: NonNullable<Assembly["notifications"]>["profileFor"] = (operation, original, pinned) => {
      const profile = pinned ? selected(operation, pinned.profileId) : operation === "SUBMIT"
        ? selected(operation, original.profileId) : operation === "QUERY" ? query
          : selected(operation, document.notifyProfilesByInitialKey[original.keyVersionRef] ?? "");
      const snapshot = describeCollectionProfile(profile, operation);
      if (pinned && (snapshot.profileSha256 !== pinned.profileSha256 || snapshot.keyVersionRef !== pinned.keyVersionRef)) {
        return fail("JOINPAY_COLLECTION_PINNED_PROFILE_MISMATCH");
      }
      assertFormalCollectionProfile(admission, profile, operation);
      if (snapshot.merchantIdentityId !== original.merchantIdentityId || snapshot.wireMerchantNo !== original.wireMerchantNo) {
        return fail("JOINPAY_COLLECTION_ORIGINAL_MERCHANT_MISMATCH");
      }
      if (operation !== "NOTIFY") assertCollectionRequestBinding(profile, operation, original);
      return profile;
    };
    const keys = new Map<string, string>();
    const keyFor = (reference: string): string => {
      if (!Object.hasOwn(document.keyVariables, reference)) return fail("JOINPAY_COLLECTION_KEY_REFERENCE_MISSING");
      if (!keys.has(reference)) {
        const variable = document.keyVariables[reference]!;
        try {
          const key = readSecret(env, variable, `${variable}_FILE`, workingDirectory);
          if (key.length > 4096 || /[\u0000-\u0020\u007f]/.test(key)) return fail("JOINPAY_COLLECTION_KEY_UNAVAILABLE");
          keys.set(reference, key);
        } catch { return fail("JOINPAY_COLLECTION_KEY_UNAVAILABLE"); }
      }
      return keys.get(reference)!;
    };
    const source = { admission, profileFor, keyFor };
    return {
      admission,
      routes: {
        ...(document.newRequestsEnabled ? { initial: { admission, profile: submit!,
          wire: { tradeMerchantNo: submitDescriptor!.tradeMerchantNo, productName: document.productName!, notifyUrl: submitDescriptor!.notifyUrl } } } : {}),
        execution: { formal: source, profileFor, keyFor },
        read: { formalAdmission: admission, qrHostAllowlist: Object.freeze([...document.qrHostAllowlist]) },
      },
      notifications: source,
      ...(recovery ? { recovery: Object.freeze({ ...recovery }) } : {}),
    };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return fail("JOINPAY_COLLECTION_ASSEMBLY_REJECTED");
  }
}
