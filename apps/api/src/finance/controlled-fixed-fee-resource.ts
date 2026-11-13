import type { PoolClient } from "pg";
import { ConfigurationError, type AppConfig } from "../config/config";
import { SecurityApiError } from "../auth/security-core";
import { assertBusinessRuntimeIdentity } from "../database/business";

export const fixedFeeTestResource = Object.freeze({
  name: "zzsh_test_supply_fixed_fee",
  role: "zzsh_m3b_fixed_fee_r",
  marker: "zzsh:synthetic:fixed-fee:v1",
  oid: 3513966,
  roleOid: 3513965,
  merchantScopeId: "fixed-fee-isolated",
});

export function assertFixedFeeTestConfiguration(config: AppConfig, orderIds: readonly string[]): void {
  const { database } = config;
  if (process.env.NODE_ENV === "production" || config.profile !== "test" || config.provider !== "fake" || !config.testOperationsEnabled
    || database.target !== "local-compose" || database.targetProfile !== "test" || database.host !== "127.0.0.1" || database.port !== 55432
    || database.name !== fixedFeeTestResource.name || database.user !== fixedFeeTestResource.role || database.runtimeUser !== fixedFeeTestResource.role
    || !Array.isArray(orderIds) || !orderIds.length || orderIds.length > 10 || new Set(orderIds).size !== orderIds.length
    || orderIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
    throw new ConfigurationError("Exact fixed-fee test resource and order allowlist required");
  }
}

export async function assertFixedFeeTestResource(client: PoolClient): Promise<void> {
  const resource = fixedFeeTestResource;
  const denied = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Fixed-fee test resource not admitted");
  if (process.env.NODE_ENV === "production") throw denied();
  const row = (await client.query(
    "SELECT d.oid::int AS oid,d.datname AS name,r.oid::int AS role_oid,r.rolname AS role," +
    " shobj_description(d.oid,'pg_database') AS marker,shobj_description(r.oid,'pg_authid') AS role_marker" +
    " FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()",
  )).rows[0];
  if (!row || row.name !== resource.name || row.role !== resource.role || row.oid !== resource.oid || row.role_oid !== resource.roleOid
    || row.marker !== resource.marker || row.role_marker !== resource.marker + ":" + resource.name + ":runtime") throw denied();
  await assertBusinessRuntimeIdentity(client, { database: { name: resource.name, user: resource.role, runtimeUser: resource.role } });
}
