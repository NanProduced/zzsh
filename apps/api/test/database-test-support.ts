import { strict as assert } from "node:assert";
import type { Pool, PoolClient } from "pg";
import { parseLegalAcceptanceRef } from "../src/legal/legal-documents";
import { MAINTENANCE_DATABASE, REGRESSION_RESOURCE_LOCK_KEY } from "../src/config/test-resource";

export function fixtureAgreementAcceptance(confirmation: { agreementAcceptance?: unknown } | null | undefined) {
  return parseLegalAcceptanceRef(confirmation?.agreementAcceptance, "fixtureAgreementAcceptance");
}

export const DATABASE_CLEANUP_TIMEOUT_MS = 2_000;

export type ReleasableClient = {
  release: (destroy?: boolean) => void;
};

export async function closeResource(
  authorized: boolean,
  client: ReleasableClient,
  cleanup: () => Promise<void>,
): Promise<void> {
  if (!authorized) {
    client.release(true);
    return;
  }
  try {
    await cleanup();
  } finally {
    client.release();
  }
}

export async function settlesWithin(
  pending: Promise<unknown> | undefined,
  timeoutMs = DATABASE_CLEANUP_TIMEOUT_MS,
): Promise<boolean> {
  if (!pending) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function finishDatabaseTest(
  primaryError: unknown,
  cleanup: () => Promise<void>,
  closeTestPool: () => Promise<void>,
  closeAdminPool: () => Promise<void>,
): Promise<void> {
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await closeTestPool();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await closeAdminPool();
  } catch (error) {
    cleanupError ??= error;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

// Explicit tables owned by the isolated business test target; never use CASCADE.
export const ISOLATED_BUSINESS_DATA_TRUNCATE = `TRUNCATE
      "zzsh_content"."document_acceptance",
      "zzsh_content"."legal_document_version",
      "zzsh_order"."settlement_ledger_entry",
      "zzsh_order"."settlement_posting",
      "zzsh_order"."settlement_intake",
      "zzsh_order"."settlement_decision",
      "zzsh_order"."settlement_version",
      "zzsh_order"."rental_opening_ack",
      "zzsh_order"."rental_opening",
      "zzsh_supply"."listing_filter_config",
      "zzsh_iam"."user_rental_membership",
      "zzsh_order"."im_order_event",
      "zzsh_order"."im_order_operation",
      "zzsh_order"."im_order_member",
      "zzsh_order"."im_order_group",
      "zzsh_order"."payment_confirmation",
      "zzsh_order"."rental_order",
      "zzsh_content"."content_version",
      "zzsh_content"."content_item",
      "zzsh_content"."carousel_item",
      "zzsh_supply"."favorite",
  "zzsh_supply"."legacy_listing_read_snapshot",
  "zzsh_order"."legacy_order_read_snapshot",
      "zzsh_supply"."skin_owner",
  "zzsh_supply"."legacy_supply_map",
      "zzsh_supply"."duplicate_hint",
      "zzsh_supply"."review_decision",
      "zzsh_supply"."account_guarantee_proof",
      "zzsh_supply"."listing_media",
      "zzsh_supply"."listing_entitlement",
      "zzsh_supply"."listing_skin",
      "zzsh_supply"."inventory_line",
      "zzsh_supply"."listing_publication",
      "zzsh_supply"."listing_version",
      "zzsh_supply"."gunsmith_code",
      "zzsh_supply"."firearm_alias",
      "zzsh_supply"."firearm",
      "zzsh_supply"."firearm_classification",
      "zzsh_supply"."game_service_operation",
      "zzsh_supply"."game",
      "zzsh_supply"."billable_item",
      "zzsh_supply"."skin_rarity",
      "zzsh_supply"."skin_category",
      "zzsh_supply"."skin",
      "zzsh_supply"."entitlement",
      "zzsh_supply"."rental_account",
      "zzsh_supply"."price_version",
      "zzsh_supply"."price_line",
      "zzsh_supply"."term_version",
      "zzsh_supply"."term_option",
      "zzsh_supply"."agreement_version",
      "zzsh_supply"."rule_release",
      "zzsh_supply"."rule_acceptance",
      "zzsh_supply"."media_upload_intent",
      "zzsh_supply"."media_asset",
      "zzsh_supply"."idempotency_record",
      "zzsh_supply"."admin_supply_scope",
      "zzsh_iam"."admin_workspace_layout",
      "zzsh_iam"."approval_execution",
      "zzsh_iam"."approval_decision",
      "zzsh_iam"."approval_request_candidate",
      "zzsh_iam"."approval_request",
      "zzsh_iam"."approval_template_candidate",
      "zzsh_iam"."approval_template",
      "zzsh_iam"."admin_user_permission",
      "zzsh_iam"."admin_user_role",
      "zzsh_iam"."admin_role_permission",
      "zzsh_iam"."admin_recovery_request",
      "zzsh_iam"."admin_recovery_notification_target",
      "zzsh_iam"."admin_security_notification_outbox",
      "zzsh_auth_admin"."twoFactor",
      "zzsh_auth_admin"."verification",
      "zzsh_auth_admin"."session",
      "zzsh_auth_admin"."account",
      "zzsh_auth_admin"."user",
      "zzsh_auth_user"."twoFactor",
      "zzsh_auth_user"."verification",
      "zzsh_auth_user"."session",
      "zzsh_auth_user"."account",
      "zzsh_auth_user"."user",
      "zzsh_iam"."user_identity_state",
      "zzsh_iam"."im_consultation_scope_operation",
      "zzsh_iam"."im_consultation_event",
      "zzsh_iam"."im_consultation",
      "zzsh_iam"."im_support_presence",
      "zzsh_iam"."im_identity_mapping",
      "zzsh_iam"."admin_security",
      "zzsh_iam"."audit_event"`;

export async function installedBusinessTruncate(pool: Pick<Pool, "query">): Promise<string> {
  const row = (await pool.query("SELECT to_regclass('zzsh_content.legal_document_version') AS version, to_regclass('zzsh_content.document_acceptance') AS acceptance")).rows[0];
  assert.ok(row && Object.hasOwn(row, "version") && Object.hasOwn(row, "acceptance"), "legal cleanup schema must be observed");
  assert.equal(Boolean(row.version), Boolean(row.acceptance), "legal cleanup schema is incomplete");
  return row.version ? ISOLATED_BUSINESS_DATA_TRUNCATE : ISOLATED_BUSINESS_DATA_TRUNCATE
    .replace('      "zzsh_content"."document_acceptance",\n', "")
    .replace('      "zzsh_content"."legal_document_version",\n', "");
}

// Covers prepare, create/role maintenance, migrations, the test and cleanup on one maintenance-database
// session: an advisory lock is scoped to its database, so a same-numbered lock taken inside the test
// database does not exclude another process. Session close releases it after cleanup.
export async function acquireSharedResourceLock(pool: Pool, label: string): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{ databaseName: string }>("SELECT current_database() AS \"databaseName\"");
    assert.equal(identity.rows[0]?.databaseName, MAINTENANCE_DATABASE, `${label} must take the shared resource lock on the maintenance database`);
    const acquired = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [REGRESSION_RESOURCE_LOCK_KEY])).rows[0]?.acquired;
    assert.equal(acquired, true, `${label}: the local test resource is already in use by another process`);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

// The installed chain installs BEFORE TRUNCATE guards (0062/0063/0080) that refuse unconditionally,
// so a shared target cannot be wiped in place and must not have its triggers disabled. Each suite
// therefore requires a database freshly reset by scripts/regression-reset.mjs for this run: the
// database-level nonce changes on every controlled reset.
export async function assertFreshRegressionRun(pool: Pick<Pool, "query">): Promise<void> {
  const expected = process.env.ZZSH_REGRESSION_RUN?.trim() ?? "";
  assert.match(expected, /^[a-z0-9_]{12,40}$/, "ZZSH_REGRESSION_RUN is required; start the suite through the regression runner");
  const row = (await pool.query("SELECT current_setting('zzsh.regression_run', true) AS run")).rows[0];
  assert.equal(row?.run, expected, "the regression database was not reset for this run");
}

export type TestDatabaseAdmission = {
  exists: boolean;
  owner: string | null | undefined;
  marker: string | null | undefined;
  allowConnections: boolean | undefined;
  isTemplate: boolean | undefined;
  databaseOid?: string | null;
  expectedOwner: string;
  expectedMarker: string | null;
  expectedOid?: string | null;
  databaseName: string;
  allowFlag: string;
  reuseOnly?: boolean;
  requireOidOnReuse?: boolean;
};

export function admitTestDatabase(input: TestDatabaseAdmission, env: Record<string, string | undefined> = process.env): "REUSE" | "CREATE" {
  if (input.exists) {
    assert.equal(input.owner, input.expectedOwner, "dedicated test database owner changed");
    assert.equal(input.marker, input.expectedMarker, "dedicated test database marker is missing or mismatched");
    assert.equal(input.allowConnections, true, "dedicated test database is not accepting connections");
    assert.equal(input.isTemplate, false, "dedicated test database must not be a template");
    if (input.expectedOid) assert.equal(input.databaseOid, input.expectedOid, `dedicated test database is not OID ${input.expectedOid}`);
    else if (input.requireOidOnReuse) assert.fail(`${input.databaseName} already exists; bind its registered OID with ZZSH_REGRESSION_DB_OID`);
    return "REUSE";
  }
  assert.ok(!input.reuseOnly, `${input.databaseName} is a registered historical exception and is reuse-only; it must not be created`);
  assert.equal(env[input.allowFlag], "1", `new test database ${input.databaseName} requires ${input.allowFlag}=1; reuse a registered resource set`);
  return "CREATE";
}
