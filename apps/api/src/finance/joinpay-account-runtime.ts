import { ConfigurationError, readSecret, type AppConfig } from "../config/config";
import type { JoinpayAccountReadAccess } from "./channel-finance-read";
import { assertJoinpayAccountReadProfile, bindJoinpayAccountProfile, type JoinpayAccountServerProfile } from "./joinpay-account";
import type { JoinpayAccountObservationOptions } from "./joinpay-account-observer";

export type JoinpayAccountRuntimeDocument = {
  resource: { database: string; runtimeUser: string };
  merchantIdentityId: string;
  readAdminIds: string[];
  observation?: { intervalSeconds: number; profiles: JoinpayAccountServerProfile[]; keyVariables: Record<string, string> };
};
type Context = Pick<AppConfig, "provider" | "database"> & { authEnabled: boolean };
type Assembly = { read: JoinpayAccountReadAccess; observation?: Omit<JoinpayAccountObservationOptions, "pool"> };
const fail = (code: string): never => { throw new ConfigurationError(code); };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);

/** 本地读取与主动刷新分开；默认关闭，旧快照读取不要求保留商户密钥。 */
export function loadJoinpayAccountRuntime(context: Context, env: NodeJS.ProcessEnv = process.env, workingDirectory = process.cwd()): Assembly | undefined {
  const enabled = env.JOINPAY_ACCOUNTS_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") return fail("JOINPAY_ACCOUNTS_ENABLED_INVALID");
  if (enabled === "false") return undefined;
  if (!context.authEnabled || context.database.user !== context.database.runtimeUser) return fail("JOINPAY_ACCOUNTS_RUNTIME_CONTEXT_INVALID");
  let d: JoinpayAccountRuntimeDocument;
  try {
    const raw = readSecret(env, "JOINPAY_ACCOUNTS_CONFIG", "JOINPAY_ACCOUNTS_CONFIG_FILE", workingDirectory);
    if (Buffer.byteLength(raw, "utf8") > 262144) return fail("JOINPAY_ACCOUNTS_CONFIG_INVALID");
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || Object.keys(parsed).some(k => !["resource", "merchantIdentityId", "readAdminIds", "observation"].includes(k))
      || !object(parsed.resource) || Object.keys(parsed.resource).some(k => !["database", "runtimeUser"].includes(k))
      || !id(parsed.merchantIdentityId) || !Array.isArray(parsed.readAdminIds) || parsed.readAdminIds.length > 256
      || parsed.readAdminIds.some(v => !id(v)) || new Set(parsed.readAdminIds).size !== parsed.readAdminIds.length) return fail("JOINPAY_ACCOUNTS_CONFIG_INVALID");
    d = parsed as JoinpayAccountRuntimeDocument;
  } catch { return fail("JOINPAY_ACCOUNTS_CONFIG_UNAVAILABLE"); }
  if (d.resource.database !== context.database.name || d.resource.runtimeUser !== context.database.user) return fail("JOINPAY_ACCOUNTS_RESOURCE_MISMATCH");
  const read: JoinpayAccountReadAccess = { database: d.resource.database, runtimeUser: d.resource.runtimeUser,
    merchantIdsByAdmin: new Map(d.readAdminIds.map(adminId => [adminId, new Set([d.merchantIdentityId])])) };
  const o = d.observation;
  if (o === undefined) return { read };
  if (context.provider !== "real") return fail("JOINPAY_ACCOUNTS_OBSERVATION_REQUIRES_REAL_PROVIDER");
  if (!object(o) || Object.keys(o).some(k => !["intervalSeconds", "profiles", "keyVariables"].includes(k))
    || !Number.isSafeInteger(o.intervalSeconds) || o.intervalSeconds < 60 || o.intervalSeconds > 86400
    || !Array.isArray(o.profiles) || o.profiles.length < 1 || o.profiles.length > 2 || !object(o.keyVariables)
    || Object.keys(o.keyVariables).length > 2 || Object.entries(o.keyVariables).some(([ref, variable]) => !id(ref)
      || typeof variable !== "string" || !/^JOINPAY_ACCOUNT_KEY_[A-Z0-9_]{1,64}$/.test(variable))) return fail("JOINPAY_ACCOUNTS_OBSERVATION_INVALID");
  try {
    const profiles = o.profiles.map(bindJoinpayAccountProfile), descriptions = profiles.map(assertJoinpayAccountReadProfile);
    if (new Set(descriptions.map(p => p.operation)).size !== descriptions.length || descriptions.some(p =>
      p.resourceDatabase !== d.resource.database || p.resourceRuntimeUser !== d.resource.runtimeUser
      || p.merchantIdentityId !== d.merchantIdentityId || p.userNo !== descriptions[0]!.userNo)) return fail("JOINPAY_ACCOUNTS_PROFILE_SCOPE_MISMATCH");
    for (const p of descriptions) if (!Object.hasOwn(o.keyVariables, p.keyVersionRef)) return fail("JOINPAY_ACCOUNTS_KEY_REFERENCE_MISSING");
    const keys = new Map<string, string>();
    const keyFor = (ref: string) => {
      if (!Object.hasOwn(o.keyVariables, ref)) return fail("JOINPAY_ACCOUNTS_KEY_REFERENCE_MISSING");
      if (!keys.has(ref)) {
        const variable = o.keyVariables[ref]!;
        try {
          const key = readSecret(env, variable, `${variable}_FILE`, workingDirectory);
          if (key.length > 4096 || /[\u0000-\u0020\u007f]/.test(key)) return fail("JOINPAY_ACCOUNTS_KEY_UNAVAILABLE");
          keys.set(ref, key);
        } catch { return fail("JOINPAY_ACCOUNTS_KEY_UNAVAILABLE"); }
      }
      return keys.get(ref)!;
    };
    return { read, observation: { profiles: Object.freeze(profiles), intervalSeconds: o.intervalSeconds, dependencies: { keyFor } } };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return fail("JOINPAY_ACCOUNTS_ASSEMBLY_REJECTED");
  }
}
