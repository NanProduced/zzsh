import type { PoolClient } from "pg";
import { ConfigurationError, type AppConfig } from "../config/config";
import { SecurityApiError } from "../auth/security-core";
import { assertBusinessRuntimeIdentity } from "../database/business";
import { readReleaseEarlySettlementReference } from "../legal/legal-documents";
import { fixedFeeTradeSchemaReady } from "./fixed-fee-settlement-schema";
import { assertEcsTestDemoResource, readEcsTestDemoRegistration, type DemoFinanceResource } from "./ecs-test-demo-resource";
import { readDistributionPolicyRowInTransaction } from "./distribution-policy-store";

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

export type FixedFeeTestListingAdmission = Readonly<{ kind: "FIXED_FEE_TEST_LISTING" }>;
type ListingBinding = Readonly<{ ownerUserId: string; renterUserId: string; accountId: string; listingVersionId: string; listingHash: string }>;
const listingAdmissions = new WeakMap<FixedFeeTestListingAdmission, ListingBinding>();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// shortcut: synthetic admission is removed once fixed-fee publication is generally enabled.
export function createFixedFeeTestListingAdmission(config: AppConfig, binding: ListingBinding): FixedFeeTestListingAdmission {
  if (!binding || ![binding.ownerUserId, binding.renterUserId, binding.accountId, binding.listingVersionId].every(value => typeof value === "string" && ID.test(value))
    || binding.ownerUserId === binding.renterUserId || !/^[a-f0-9]{64}$/.test(binding.listingHash))
    throw new ConfigurationError("Exact synthetic listing and parties required");
  assertFixedFeeTestConfiguration(config, [binding.accountId]);
  const admission = Object.freeze({ kind: "FIXED_FEE_TEST_LISTING" as const });
  listingAdmissions.set(admission, Object.freeze({ ...binding }));
  return admission;
}

export async function assertFixedFeeTestListingAdmission(client: PoolClient, admission: FixedFeeTestListingAdmission,
  input: { role: "OWNER" | "RENTER"; actorId: string; ownerUserId: string; accountId: string; listingVersionId: string; listingHash: string | null }): Promise<void> {
  const binding = admission && listingAdmissions.get(admission);
  if (!binding || !["OWNER", "RENTER"].includes(input.role) || input.ownerUserId !== binding.ownerUserId || input.accountId !== binding.accountId
    || input.listingVersionId !== binding.listingVersionId || input.listingHash !== binding.listingHash
    || input.actorId !== (input.role === "OWNER" ? binding.ownerUserId : binding.renterUserId))
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Fixed-fee test listing not admitted");
  await assertFixedFeeTestResource(client);
  if (!await fixedFeeTradeSchemaReady(client))
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Fixed-fee test trade guards unavailable");
}

/** Exact native creations within the current demo enrollment; user migration does not affect eligibility. */
export async function readFixedFeeDemoAccounts(client: PoolClient, demo: DemoFinanceResource, accountIds: readonly string[], purpose: "READ" | "WRITE"): Promise<Set<string>> {
  if (!accountIds.length) return new Set();
  const registration = await assertEcsTestDemoResource(client, demo, purpose === "READ" ? "READ_ORIGINAL" : "WRITE");
  if (!registration.active) return new Set();
  if (!await fixedFeeTradeSchemaReady(client))
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Fixed-fee demo trade guards unavailable");
  if ((await readDistributionPolicyRowInTransaction(client, false, "NATIVE")).knowledge !== "KNOWN")
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Fixed-fee demo distribution policy unavailable");
  const result = await client.query<{ id: string; game_id: string; rule_release_id: string }>(`SELECT a.id,a.game_id,v.rule_release_id
    FROM zzsh_supply.rental_account a
    JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id
      AND v.origin='NATIVE' AND v.schema_version=4 AND v.rule_release_id IS NOT NULL
    JOIN zzsh_order.ecs_test_demo_finance_registration r ON r.reference=$2 AND r.active AND a.created_at>=r.registered_at
    JOIN zzsh_iam.audit_event e ON e.object_id=a.id AND e.object_type='rental_account'
      AND e.actor_type='user' AND e.actor_id=a.owner_user_id AND e.action='supply.account.created'
      AND e.outcome='SUCCESS' AND e.occurred_at>=r.registered_at AND e.details->>'gameId'=a.game_id
    WHERE a.id=ANY($1::text[]) AND a.lifecycle='ACTIVE' AND a.legacy_hold='NONE'
      AND NOT EXISTS(SELECT 1 FROM zzsh_supply.legacy_supply_map m WHERE m.account_id=a.id)
      AND NOT EXISTS(
        SELECT 1 FROM zzsh_order.owner_guarantee_requirement q
        JOIN zzsh_order.owner_guarantee_payment p ON p.requirement_id=q.id AND p.owner_user_id=q.owner_user_id
        WHERE q.account_id=a.id AND p.status='CONFIRMED'
          AND (p.created_at<r.registered_at OR p.original_receipt->>'source' IS DISTINCT FROM 'ECS_DEMO_GUARANTEE'
            OR p.original_receipt->>'registrationDigest' IS DISTINCT FROM $3)
      )
      AND ((v.review_state='DRAFT' AND $4='WRITE' AND NOT EXISTS(
        SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=a.id
      )) OR (v.review_state='PUBLISHED' AND EXISTS(
        SELECT 1 FROM zzsh_supply.listing_publication p
        WHERE p.account_id=a.id AND p.version_id=v.id AND p.owner_user_id=a.owner_user_id AND p.game_id=a.game_id
          AND p.rule_release_id=v.rule_release_id AND p.content_hash=v.content_hash
          AND p.source='OWNER_DIRECT' AND p.published_at>=r.registered_at
      )))
    GROUP BY a.id,v.rule_release_id HAVING count(e.id)=1`, [accountIds, registration.reference, readEcsTestDemoRegistration(demo).digest, purpose]);
  const releaseIds = new Set<string>();
  for (const { game_id, rule_release_id } of result.rows) {
    if (releaseIds.has(rule_release_id)) continue;
    await readReleaseEarlySettlementReference(client, game_id, rule_release_id);
    releaseIds.add(rule_release_id);
  }
  return new Set(result.rows.map(row => row.id));
}
