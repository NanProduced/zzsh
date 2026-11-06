import type { PoolClient } from "pg";
import { ConfigurationError, type AppConfig } from "../config/config";
import { REGRESSION_DATABASE, REGRESSION_MARKER, REGRESSION_RUNTIME_USER } from "../config/test-resource";
import { assertBusinessRuntimeIdentity } from "../database/business";
import { SecurityApiError } from "../auth/security-core";

export type ControlledRegressionBinding = Readonly<{ resourceOid: number; nonce: string; runtimeRoleOid: number }>;
export type ControlledRegressionResource = Readonly<{ kind: "CONTROLLED_REGRESSION_RESOURCE" }>;
type Purpose = "CHANNEL_REQUEST" | "WITHDRAWAL" | "DISTRIBUTION";
const proofs = new WeakMap<object, ControlledRegressionBinding & { purpose: Purpose }>();

/** Shared by the three explicit local money-test factories; this is not a production admission. */
export function createControlledRegressionResource(config: AppConfig, binding: ControlledRegressionBinding, purpose: Purpose): ControlledRegressionResource {
  if (config.profile !== "test" || config.provider !== "fake" || !config.testOperationsEnabled || process.env.NODE_ENV === "production"
    || config.database.target !== "local-compose" || config.database.targetProfile !== "test" || config.database.host !== "127.0.0.1" || ![55432,55433].includes(config.database.port)
    || config.database.name !== REGRESSION_DATABASE || config.database.user !== REGRESSION_RUNTIME_USER || config.database.runtimeUser !== REGRESSION_RUNTIME_USER
    || !Number.isSafeInteger(binding.resourceOid) || binding.resourceOid <= 0 || !Number.isSafeInteger(binding.runtimeRoleOid) || binding.runtimeRoleOid <= 0
    || !/^[a-f0-9]{24}$/.test(binding.nonce)) throw new ConfigurationError("Exact controlled regression test/fake runtime required");
  const token = Object.freeze({ kind: "CONTROLLED_REGRESSION_RESOURCE" as const });
  proofs.set(token, Object.freeze({ resourceOid: binding.resourceOid, nonce: binding.nonce, runtimeRoleOid: binding.runtimeRoleOid, purpose }));
  return token;
}

export async function assertControlledRegressionResource(client: PoolClient, token: ControlledRegressionResource, purpose: Purpose): Promise<void> {
  const expected = proofs.get(token);
  const denied = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "CONTROLLED_REGRESSION_RESOURCE_NOT_ADMITTED");
  if (!expected || expected.purpose !== purpose || process.env.NODE_ENV === "production") throw denied();
  const row = (await client.query(`SELECT d.oid::int AS oid,current_database() AS name,current_user AS role,
    (SELECT oid::int FROM pg_roles WHERE rolname=current_user) AS role_oid,
    current_setting('zzsh.regression_run',true) AS nonce,shobj_description(d.oid,'pg_database') AS marker
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  if (!row || Number(row.oid) !== expected.resourceOid || row.name !== REGRESSION_DATABASE || row.role !== REGRESSION_RUNTIME_USER
    || Number(row.role_oid) !== expected.runtimeRoleOid || row.nonce !== expected.nonce || row.marker !== REGRESSION_MARKER) throw denied();
  await assertBusinessRuntimeIdentity(client, { database: { name: REGRESSION_DATABASE, user: REGRESSION_RUNTIME_USER, runtimeUser: REGRESSION_RUNTIME_USER } });
}
