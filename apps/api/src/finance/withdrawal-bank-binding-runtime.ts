import { ConfigurationError, readSecret, type AppConfig } from "../config/config";
import type { WithdrawalBankBindingOptions } from "./withdrawal-bank-binding";

type Context = Pick<AppConfig, "database"> & { authEnabled: boolean };
export type BankBindingRuntimeDocument = { database: string; runtimeUser: string; writeEnabled: boolean; currentKeyVersion?: string; keyVariables?: Record<string, string> };
const fail = (code: string): never => { throw new ConfigurationError(code); };
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
/** 资料存储开关独立于资金能力；只读模式无需保留银行卡保护钥。 */
export function loadWithdrawalBankBindingRuntime(context: Context, env: NodeJS.ProcessEnv = process.env, workingDirectory = process.cwd()): WithdrawalBankBindingOptions | undefined {
  const enabled = env.WITHDRAWAL_BANK_BINDING_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") return fail("BANK_BINDING_ENABLED_INVALID");
  if (enabled === "false") return undefined;
  if (!context.authEnabled || context.database.user !== context.database.runtimeUser) return fail("BANK_BINDING_CONTEXT_INVALID");
  let d: BankBindingRuntimeDocument;
  try {
    const raw = readSecret(env, "WITHDRAWAL_BANK_BINDING_CONFIG", "WITHDRAWAL_BANK_BINDING_CONFIG_FILE", workingDirectory);
    if (Buffer.byteLength(raw) > 65536) throw Error(); const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).some(k => !["database", "runtimeUser", "writeEnabled", "currentKeyVersion", "keyVariables"].includes(k))) throw Error();
    d = parsed as BankBindingRuntimeDocument;
    if (typeof d.writeEnabled !== "boolean") throw Error();
  } catch { return fail("BANK_BINDING_CONFIG_UNAVAILABLE"); }
  if (d.database !== context.database.name || d.runtimeUser !== context.database.user) return fail("BANK_BINDING_RESOURCE_MISMATCH");
  if (!d.writeEnabled) return { database: d.database, runtimeUser: d.runtimeUser };
  if (!id(d.currentKeyVersion) || !d.keyVariables || typeof d.keyVariables !== "object" || Array.isArray(d.keyVariables)
    || Object.keys(d.keyVariables).length > 16 || !Object.hasOwn(d.keyVariables, d.currentKeyVersion)
    || Object.entries(d.keyVariables).some(([version, variable]) => !id(version) || typeof variable !== "string" || !/^WITHDRAWAL_BANK_KEY_[A-Z0-9_]{1,64}$/.test(variable))) return fail("BANK_BINDING_KEY_REFERENCES_INVALID");
  const references = d.keyVariables, cache = new Map<string, Uint8Array>();
  return { database: d.database, runtimeUser: d.runtimeUser, protection: { currentKeyVersion: d.currentKeyVersion, keyFor: version => {
    if (!Object.hasOwn(references, version)) return fail("BANK_BINDING_KEY_REFERENCE_MISSING");
    if (!cache.has(version)) {
      try {
        const variable = references[version]!, raw = readSecret(env, variable, `${variable}_FILE`, workingDirectory);
        if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw Error(); const bytes = Buffer.from(raw, "base64url");
        if (bytes.byteLength !== 32 || bytes.toString("base64url") !== raw) throw Error(); cache.set(version, bytes);
      } catch { return fail("BANK_BINDING_KEY_UNAVAILABLE"); }
    }
    return new Uint8Array(cache.get(version)!);
  } } };
}
