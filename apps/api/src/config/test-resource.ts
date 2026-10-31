// The single rebuildable regression resource group plus the explicitly registered historical
// exceptions. One database, one marker, one role pair, one advisory lock taken on the maintenance
// database: a resource-set name can no longer fan out into a private clone, an existing regression
// database must be bound to its recorded OID, and a named exception can only be reused - never
// created - with its own registered identity.
import { strict as assert } from "node:assert";

export const REGRESSION_DATABASE = "zzsh_test_regression";
export const REGRESSION_MARKER = "zzsh:regression-test:v1";
export const REGRESSION_MIGRATION_USER = "zzsh_regression_migration";
export const REGRESSION_RUNTIME_USER = "zzsh_regression_runtime";
export const REGRESSION_ROLE_PREFIX = "zzsh_regression_";
export const REGRESSION_ALLOW_NEW_RESOURCE = "REGRESSION_TEST_ALLOW_NEW_RESOURCE";

// Session advisory lock taken on the maintenance database, shared by every compiled PostgreSQL suite
// and the wipe entry, held from before any create/role change until all cleanup and connections end.
export const REGRESSION_RESOURCE_LOCK_KEY = "806006";
export const MAINTENANCE_DATABASE = "postgres";

const PROTECTED_TARGETS: Record<string, string> = {
  zzsh_dev: "the daily development database",
  zzsh_dev_daily: "the accepted daily integration database",
  postgres: "the maintenance database",
  zzsh_test_order_milestone_real_1: "the live integration database held by the IM line",
  zzsh_test_order_im_paid_1: "the IM PAID sample clone",
  zzsh_test_im_sync_review_20261029: "the IM sync review resource",
  zzsh_test_order_milestone_rehearsal_1: "unique historical duty and continuation facts",
  zzsh_test_order_payfin_mig3_clean: "the Root verification resource with C2 still open",
  zzsh_test_order_ui_legacy_rehearsal: "the legacy rehearsal resource",
  zzsh_test_order_perf_dir_ab2: "the performance REVIEW resource",
  zzsh_test_order_user_maint_perf_20: "the user maintenance performance resource",
  zzsh_test_order_user_maint_r_21: "the user maintenance R21 resource",
  zzsh_fnd003_test: "an UNKNOWN evidence resource",
  zzsh_test_better_auth: "an UNKNOWN evidence resource",
  zzsh_test_m2_qa_0910185919827: "an UNKNOWN evidence resource",
};

export function assertNotProtectedTarget(databaseName: string): void {
  const reason = PROTECTED_TARGETS[databaseName];
  assert.ok(reason === undefined, `${databaseName} is ${reason ?? ""}; test suites must never target it`);
}

export type RegisteredException = {
  oid: string;
  marker: string;
  migrationUser: string;
  runtimeUser: string;
};

// Retired resource sets fail before connection or role changes. Historical proofs stay in their
// recovery archive; ordinary database tests use only the shared regression resource.
export const REGISTERED_HISTORICAL_EXCEPTIONS: Record<string, RegisteredException> = {};

export function registeredException(databaseName: string): RegisteredException {
  assertNotProtectedTarget(databaseName);
  const entry = Object.hasOwn(REGISTERED_HISTORICAL_EXCEPTIONS, databaseName) ? REGISTERED_HISTORICAL_EXCEPTIONS[databaseName]! : undefined;
  assert.ok(entry, `${databaseName} is not a registered test resource; retired resource sets must not be recreated; use the shared regression runner`);
  return entry;
}

// The OID is the only fact a suite cannot know before the database is created, so it is bound through
// the environment. Creation may run without it; every later reuse of an existing database must carry it.
export function regressionOidBinding(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.ZZSH_REGRESSION_DB_OID?.trim();
  if (value === undefined || value === "") return null;
  assert.ok(/^[0-9]+$/.test(value), "ZZSH_REGRESSION_DB_OID must be a numeric OID");
  return value;
}
