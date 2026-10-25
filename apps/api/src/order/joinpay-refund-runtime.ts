import { ConfigurationError, readSecret, type AppConfig } from "../config/config";
import type { AuthRuntimeOptions } from "../auth/auth-runtime";
import {
  bindRefundProfile, createFormalRefundAdmission, readFormalRefundAdmission, describeRefundProfile,
  assertFormalRefundProfile, assertRefundStart, assertRefundBinding,
  type RefundServerProfile, type RefundOperation, type BoundRefundProfile,
} from "./joinpay-refund-profile";

type Assembly = NonNullable<AuthRuntimeOptions["joinpayRefund"]>;
export type JoinpayRefundRuntimeDocument = {
  admission: Omit<Parameters<typeof createFormalRefundAdmission>[0], "profiles">;
  profiles: RefundServerProfile[];
  submitProfileId?: string;
  queryProfileId: string;
  notifyProfilesByInitialKey: Record<string, string>;
  keyVariables: Record<string, string>;
  newRefundsEnabled: boolean;
  recovery?: NonNullable<Assembly["recovery"]>;
};
type Context = Pick<AppConfig, "provider" | "database"> & { authEnabled: boolean };
const reject = (code: string): never => { throw new ConfigurationError(code); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const index = (op: RefundOperation, profileId: string) => JSON.stringify([op, profileId]);

/** 导入/默认关闭不取配置或钥；普通main只在明确正式装配后注册通知及可选恢复。 */
export function loadJoinpayRefundRuntime(context: Context, env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd()): Assembly | undefined {
  const enabled = env.JOINPAY_REFUND_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") return reject("JOINPAY_REFUND_ENABLED_INVALID");
  if (enabled === "false") return undefined;
  if (!context.authEnabled || context.provider !== "real" || context.database.user !== context.database.runtimeUser) {
    return reject("JOINPAY_REFUND_RUNTIME_CONTEXT_INVALID");
  }
  let document: JoinpayRefundRuntimeDocument;
  try {
    const raw = readSecret(env, "JOINPAY_REFUND_CONFIG", "JOINPAY_REFUND_CONFIG_FILE", workingDirectory);
    if (Buffer.byteLength(raw, "utf8") > 262144) return reject("JOINPAY_REFUND_CONFIG_TOO_LARGE");
    const d: unknown = JSON.parse(raw);
    if (!object(d) || Object.keys(d).some(k => !["admission", "profiles", "submitProfileId", "queryProfileId",
      "notifyProfilesByInitialKey", "keyVariables", "newRefundsEnabled", "recovery"].includes(k))
      || !object(d.admission) || !Array.isArray(d.profiles) || d.profiles.length < 1 || d.profiles.length > 32
      || !id(d.queryProfileId) || d.submitProfileId !== undefined && !id(d.submitProfileId)
      || !object(d.notifyProfilesByInitialKey) || !object(d.keyVariables) || typeof d.newRefundsEnabled !== "boolean"
      || d.newRefundsEnabled && (!id(d.submitProfileId) || d.recovery === undefined)) return reject("JOINPAY_REFUND_CONFIG_INVALID");
    document = d as JoinpayRefundRuntimeDocument;
  } catch { return reject("JOINPAY_REFUND_CONFIG_UNAVAILABLE"); }
  const recovery = document.recovery;
  if (recovery !== undefined && (!object(recovery) || Object.keys(recovery).some(k => !["workerId", "batchLimit", "minimumIntervalSeconds"].includes(k))
    || !id(recovery.workerId) || !Number.isSafeInteger(recovery.batchLimit) || recovery.batchLimit < 1 || recovery.batchLimit > 10
    || !Number.isSafeInteger(recovery.minimumIntervalSeconds) || recovery.minimumIntervalSeconds < 30 || recovery.minimumIntervalSeconds > 86400)) {
    return reject("JOINPAY_REFUND_RECOVERY_INVALID");
  }
  if (Object.keys(document.keyVariables).length > 32 || Object.entries(document.keyVariables).some(([ref, variable]) => !id(ref)
    || typeof variable !== "string" || !/^JOINPAY_REFUND_KEY_[A-Z0-9_]{1,64}$/.test(variable))) return reject("JOINPAY_REFUND_KEY_REFERENCE_INVALID");
  if (Object.keys(document.notifyProfilesByInitialKey).length < 1 || Object.keys(document.notifyProfilesByInitialKey).length > 32
    || Object.entries(document.notifyProfilesByInitialKey).some(([ref, profile]) => !id(ref) || !id(profile))) return reject("JOINPAY_REFUND_NOTIFY_SELECTION_INVALID");
  try {
    const profiles = new Map<string, BoundRefundProfile>();
    for (const input of document.profiles) {
      const profile = bindRefundProfile(input), p = describeRefundProfile(profile), key = index(p.operation, p.profileId);
      if (profiles.has(key)) return reject("JOINPAY_REFUND_DUPLICATE_PROFILE");
      if (p.database !== context.database.name || p.runtimeUser !== context.database.user) return reject("JOINPAY_REFUND_RESOURCE_MISMATCH");
      if (!Object.hasOwn(document.keyVariables, p.keyVersionRef)) return reject("JOINPAY_REFUND_KEY_REFERENCE_MISSING");
      profiles.set(key, profile);
    }
    const admission = createFormalRefundAdmission({ ...document.admission, profiles: [...profiles.values()] });
    readFormalRefundAdmission(admission);
    const selected = (operation: RefundOperation, profileId: string) => {
      const profile = profiles.get(index(operation, profileId));
      if (!profile) return reject("JOINPAY_REFUND_PROFILE_UNAVAILABLE");
      assertFormalRefundProfile(admission, profile, operation); return profile;
    };
    const query = selected("QUERY", document.queryProfileId);
    for (const profileId of Object.values(document.notifyProfilesByInitialKey)) selected("NOTIFY", profileId);
    for (const input of document.profiles) if (input.operation === "SUBMIT"
      && !Object.hasOwn(document.notifyProfilesByInitialKey, input.keyVersionRef)) return reject("JOINPAY_REFUND_NOTIFY_SELECTION_MISSING");
    const initialProfile = document.newRefundsEnabled ? selected("SUBMIT", document.submitProfileId!) : undefined;
    if (initialProfile) assertRefundStart(admission);
    const profileFor: Assembly["profileFor"] = (operation, original, pinned) => {
      const profile = pinned ? selected(operation, pinned.profileId) : operation === "SUBMIT"
        ? selected(operation, original.profileId) : operation === "QUERY" ? query
          : selected(operation, document.notifyProfilesByInitialKey[original.keyVersionRef] ?? "");
      const p = describeRefundProfile(profile, operation);
      if (pinned && (p.profileSha256 !== pinned.profileSha256 || p.keyVersionRef !== pinned.keyVersionRef)) return reject("JOINPAY_REFUND_PINNED_PROFILE_MISMATCH");
      assertRefundBinding(profile, operation, original); return profile;
    };
    // 每个领域独立版本缓存，避免相同引用名跨收款/退款混用密钥。
    const keys = new Map<string, string>();
    const keyFor = (reference: string): string => {
      if (!Object.hasOwn(document.keyVariables, reference)) return reject("JOINPAY_REFUND_KEY_REFERENCE_MISSING");
      if (!keys.has(reference)) {
        const variable = document.keyVariables[reference]!;
        try {
          const key = readSecret(env, variable, `${variable}_FILE`, workingDirectory);
          if (key.length > 4096 || /[\u0000-\u0020\u007f]/.test(key)) return reject("JOINPAY_REFUND_KEY_UNAVAILABLE");
          keys.set(reference, key);
        } catch { return reject("JOINPAY_REFUND_KEY_UNAVAILABLE"); }
      }
      return keys.get(reference)!;
    };
    return { admission, profileFor, keyFor, ...(initialProfile ? { initialProfile } : {}),
      ...(recovery ? { recovery: Object.freeze({ ...recovery }) } : {}) };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return reject("JOINPAY_REFUND_ASSEMBLY_REJECTED");
  }
}
