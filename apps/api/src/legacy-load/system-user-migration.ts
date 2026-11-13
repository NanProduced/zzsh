import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { forbidden } from "../supply/supply-util";

type MigrationTarget = Readonly<{ systemIdentifier: string; databaseOid: string; marker: string; nonce: string; roleOid: string }>;
type UserSource = Readonly<{ sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string; evidenceDigest: string }>;
export type AccountSource = Readonly<{ operation: "CREATE" | "OBSERVATION" | "SNAPSHOT" | "DISPLAY"; accountId: string;
  sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string; payloadDigest: string }>;
export type OrderSource = Readonly<{ orderId: string; legacyId: string; sourceDigest: string; bindingDigest: string }>;
export type FinanceMigrationSource = Readonly<{ inputsDigest: string; inputSha256: string; cutoff: string }>;
export type InvitationMigrationSource = Readonly<{ phase: 'IMPORT' | 'COUNTS'; key: string; sourceDigest: string; bodyDigest: string }>;

export function systemUserMigrationId(sourceDatasetSha256: string, target: MigrationTarget): string {
  if (typeof sourceDatasetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceDatasetSha256) || !target
      || !/^[0-9]{1,20}$/.test(target.systemIdentifier) || !/^[1-9][0-9]{0,9}$/.test(target.databaseOid)
      || !/^[a-z][a-z0-9:_-]{0,127}$/.test(target.marker) || !/^[a-f0-9]{24}$/.test(target.nonce)
      || !/^[1-9][0-9]{0,9}$/.test(target.roleOid)) throw forbidden("Legacy system migration target is invalid");
  const digest = createHash("sha256").update(JSON.stringify(["legacy-system-user-v1", sourceDatasetSha256,
    target.systemIdentifier, target.databaseOid, target.marker, target.nonce, target.roleOid])).digest("hex");
  return `legacy-user-migration:${digest}`;
}

/** The caller binds this capability to its existing target/source fence, not an admin session. */
export type SystemUserMigrationActor = Readonly<{
  kind: "SYSTEM_USER_MIGRATION";
  id: string;
  requestId: string;
  sourceDatasetSha256: string;
  target: MigrationTarget;
  assertMigrationFence: (client: PoolClient) => Promise<void>;
  assertSourceEvidence: (source: UserSource) => Promise<void>;
}>;

export type SystemAccountMigrationActor = Readonly<{
  kind: "SYSTEM_ACCOUNT_MIGRATION";
  id: string;
  requestId: string;
  sourceDatasetSha256: string;
  target: MigrationTarget;
  assertMigrationFence: (client: PoolClient) => Promise<void>;
  assertSourceEvidence: (source: AccountSource) => Promise<void>;
}>;

export function systemAccountMigrationId(sourceDatasetSha256: string, target: MigrationTarget): string {
  const userId = systemUserMigrationId(sourceDatasetSha256, target);
  return `legacy-account-migration:${createHash("sha256").update(userId).digest("hex")}`;
}

export type SystemOrderMigrationActor = Readonly<{
  kind: "SYSTEM_ORDER_MIGRATION";
  id: string;
  requestId: string;
  sourceDatasetSha256: string;
  target: MigrationTarget;
  assertMigrationFence: (client: PoolClient) => Promise<void>;
  assertSourceEvidence: (source: OrderSource) => Promise<void>;
}>;

export function systemOrderMigrationId(sourceDatasetSha256: string, target: MigrationTarget): string {
  const userId = systemUserMigrationId(sourceDatasetSha256, target);
  return `legacy-order-migration:${createHash("sha256").update(userId).digest("hex")}`;
}

export type SystemFinanceMigrationActor = Readonly<{
  kind: "SYSTEM_FINANCE_MIGRATION";
  id: string;
  requestId: string;
  sourceDatasetSha256: string;
  target: MigrationTarget;
  fenceEpochSha256: string;
  assertMigrationFence: (client: PoolClient) => Promise<void>;
  assertSourceEvidence: (source: FinanceMigrationSource) => Promise<void>;
}>;

export function systemFinanceMigrationId(sourceDatasetSha256: string, target: MigrationTarget): string {
  const userId = systemUserMigrationId(sourceDatasetSha256, target);
  return `legacy-finance-migration:${createHash("sha256").update(userId).digest("hex")}`;
}
export type SystemInvitationMigrationActor = Readonly<{
  kind: "SYSTEM_INVITATION_MIGRATION"; id: string; requestId: string; sourceDatasetSha256: string;
  target: MigrationTarget; fenceEpochSha256: string; assertMigrationFence: (client: PoolClient) => Promise<void>;
  assertSourceEvidence: (source: InvitationMigrationSource) => Promise<void>;
}>;
export function systemInvitationMigrationId(sourceDatasetSha256: string, target: MigrationTarget): string {
  const userId = systemUserMigrationId(sourceDatasetSha256, target);
  return `legacy-invitation-migration:${createHash("sha256").update(userId).digest("hex")}`;
}

type SystemMigrationActor = SystemUserMigrationActor | SystemAccountMigrationActor | SystemOrderMigrationActor | SystemFinanceMigrationActor | SystemInvitationMigrationActor;
const activeBatches = new WeakMap<PoolClient, { actor: SystemMigrationActor; transactionId: string | null;
  fence: SystemMigrationActor["assertMigrationFence"]; source: SystemMigrationActor["assertSourceEvidence"]; binding: string; readOnly: boolean }>();

function expectedActorId(actor: SystemMigrationActor): string {
  if (actor.kind === "SYSTEM_USER_MIGRATION") return systemUserMigrationId(actor.sourceDatasetSha256, actor.target);
  if (actor.kind === "SYSTEM_ACCOUNT_MIGRATION") return systemAccountMigrationId(actor.sourceDatasetSha256, actor.target);
  if (actor.kind === "SYSTEM_ORDER_MIGRATION") return systemOrderMigrationId(actor.sourceDatasetSha256, actor.target);
  if (actor.kind === "SYSTEM_FINANCE_MIGRATION") return systemFinanceMigrationId(actor.sourceDatasetSha256, actor.target);
  if (actor.kind === "SYSTEM_INVITATION_MIGRATION") return systemInvitationMigrationId(actor.sourceDatasetSha256, actor.target);
  throw forbidden("Legacy system migration kind is invalid");
}
function actorBinding(actor: SystemMigrationActor): string {
  return JSON.stringify([actor.kind,actor.id,actor.requestId,actor.sourceDatasetSha256,actor.target.systemIdentifier,
    actor.target.databaseOid,actor.target.marker,actor.target.nonce,actor.target.roleOid,
    actor.kind === "SYSTEM_FINANCE_MIGRATION" || actor.kind === "SYSTEM_INVITATION_MIGRATION" ? actor.fenceEpochSha256 : null]);
}

async function verifyBatch(client: PoolClient, actor: SystemMigrationActor, readOnly = false): Promise<string> {
  if (client.getTransactionStatus() !== "T" || actor.id !== expectedActorId(actor)
      || typeof actor.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actor.requestId)
      || typeof actor.assertMigrationFence !== "function" || typeof actor.assertSourceEvidence !== "function") {
    throw forbidden("Legacy system migration source is invalid");
  }
  await actor.assertMigrationFence(client);
  const transactionIdentity = readOnly ? `(SELECT virtualtransaction::text FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='virtualxid' AND granted LIMIT 1)` : `pg_current_xact_id()::text`;
  const row = (await client.query<{ authorized: boolean; transactionId: string }>(`SELECT ${transactionIdentity} AS "transactionId", COALESCE(
    current_user=session_user AND r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls
    ${readOnly ? "AND current_setting('transaction_read_only')='on' AND current_setting('transaction_isolation') IN ('repeatable read','serializable') AND pg_current_xact_id_if_assigned() IS NULL" : "AND current_setting('transaction_read_only')='off'"}
    AND r.oid::text=$1 AND d.oid::text=$2 AND shobj_description(d.oid,'pg_database')=$3
    AND current_setting('zzsh.regression_run',true)=$4 AND (SELECT system_identifier::text FROM pg_control_system())=$5
    AND r.oid=a.relowner AND r.oid=u.relowner AND current_setting('session_replication_role')='origin'
    AND EXISTS (SELECT 1 FROM pg_attribute c WHERE c.attrelid=a.oid AND c.attname='legacy_migration_manifest_sha256' AND NOT c.attisdropped)
    AND NOT EXISTS (SELECT 1 FROM (VALUES
      ('legacy_system_audit_insert',7,'(new.legacy_migration_manifest_sha256 IS NOT NULL)'),
      ('legacy_system_audit_update',19,'((old.legacy_migration_manifest_sha256 IS NOT NULL) OR (new.legacy_migration_manifest_sha256 IS NOT NULL))'),
      ('legacy_system_audit_delete',11,'(old.legacy_migration_manifest_sha256 IS NOT NULL)')
    ) required(name,kind,qualification)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=a.oid AND t.tgname=required.name AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
          AND t.tgtype=required.kind::smallint
          AND substring(pg_get_triggerdef(t.oid) FROM ' WHEN \\((.*)\\) EXECUTE FUNCTION ') IS NOT DISTINCT FROM required.qualification
          AND p.oid=to_regprocedure('zzsh_iam.guard_legacy_system_audit()') AND p.proowner=a.relowner AND NOT p.prosecdef
          AND position('current_user<>session_user' IN p.prosrc)>0 AND position('legacy-user-migration:' IN p.prosrc)>0
          AND position('legacy-account-migration:' IN p.prosrc)>0 AND position('legacy-order-migration:' IN p.prosrc)>0
          AND position('initialAvatar,presetId' IN p.prosrc)>0 AND position('zzsh_supply.profile_avatar' IN p.prosrc)>0
          AND position('/api/v1/profile/avatars/user/' IN p.prosrc)>0))
    ,false) AS authorized
    FROM pg_roles r JOIN pg_class a ON a.oid=to_regclass('zzsh_iam.audit_event')
      JOIN pg_class u ON u.oid=to_regclass('zzsh_auth_user."user"')
      JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`,
    [actor.target.roleOid, actor.target.databaseOid, actor.target.marker, actor.target.nonce, actor.target.systemIdentifier])).rows[0];
  if (row?.authorized !== true || typeof row.transactionId !== "string" || !row.transactionId) throw forbidden("Legacy system migration requires the protected migration role");
  if (actor.kind === "SYSTEM_ACCOUNT_MIGRATION" || actor.kind === "SYSTEM_ORDER_MIGRATION") {
    const accountGuard = (await client.query<{ authorized: boolean }>(`SELECT COALESCE(
      (SELECT count(*)=5 FROM pg_class c WHERE c.oid IN (to_regclass('zzsh_supply.rental_account'),
        to_regclass('zzsh_supply.listing_version'),to_regclass('zzsh_supply.legacy_supply_map'),
        to_regclass('zzsh_supply.legacy_listing_read_snapshot'),to_regclass('zzsh_supply.legacy_listing_display_snapshot')) AND c.relowner=r.oid)
      AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=s.oid AND c.conname='legacy_snapshot_migration_source' AND c.convalidated
        AND position('created_by_migration_id' IN pg_get_constraintdef(c.oid))>0)
      AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('zzsh_supply.legacy_listing_display_snapshot') AND c.conname='legacy_display_migration_source' AND c.convalidated
        AND position('created_by_migration_id' IN pg_get_constraintdef(c.oid))>0)
      AND NOT EXISTS (SELECT 1 FROM (VALUES
        (s.oid,'legacy_system_snapshot_insert',7,'zzsh_supply.guard_legacy_system_snapshot()','(new.created_by_migration_id IS NOT NULL)'),
        (s.oid,'legacy_system_snapshot_audit',5,'zzsh_supply.guard_legacy_system_snapshot_audit()','(new.created_by_migration_id IS NOT NULL)'),
        (s.oid,'legacy_read_snapshot_insert',7,'zzsh_supply.guard_legacy_read_snapshot()',NULL),
        (s.oid,'legacy_read_snapshot_immutable',27,'zzsh_supply.guard_release_immutable()',NULL),
        (to_regclass('zzsh_supply.legacy_listing_display_snapshot'),'legacy_system_display_insert',7,'zzsh_supply.guard_legacy_system_snapshot()','(new.created_by_migration_id IS NOT NULL)'),
        (to_regclass('zzsh_supply.legacy_listing_display_snapshot'),'legacy_system_display_audit',5,'zzsh_supply.guard_legacy_system_display_audit()','(new.created_by_migration_id IS NOT NULL)'),
        (to_regclass('zzsh_supply.legacy_listing_display_snapshot'),'legacy_display_insert',7,'zzsh_supply.guard_legacy_display_snapshot()',NULL),
        (to_regclass('zzsh_supply.legacy_listing_display_snapshot'),'legacy_display_immutable',27,'zzsh_supply.guard_release_immutable()',NULL),
        (to_regclass('zzsh_supply.legacy_supply_map'),'legacy_map_immutable',27,'zzsh_supply.guard_release_immutable()',NULL)
      ) required(relation,name,kind,fn,qualification) WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=required.relation
          AND t.tgname=required.name AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
          AND t.tgtype=required.kind::smallint AND p.oid=to_regprocedure(required.fn) AND p.proowner=r.oid AND NOT p.prosecdef
          AND substring(pg_get_triggerdef(t.oid) FROM ' WHEN \\((.*)\\) EXECUTE FUNCTION ') IS NOT DISTINCT FROM required.qualification
          AND (required.fn<>'zzsh_supply.guard_legacy_system_snapshot()' OR position('current_user<>session_user' IN p.prosrc)>0)
          AND (required.fn<>'zzsh_supply.guard_legacy_system_snapshot_audit()' OR position('legacy_migration_manifest_sha256' IN p.prosrc)>0)
          AND (required.fn<>'zzsh_supply.guard_legacy_system_display_audit()' OR position('legacy_migration_manifest_sha256' IN p.prosrc)>0)
          AND (required.name NOT IN ('legacy_system_snapshot_audit','legacy_system_display_audit') OR (t.tgdeferrable AND t.tginitdeferred))))
      ,false) AS authorized FROM pg_roles r JOIN pg_class s ON s.oid=to_regclass('zzsh_supply.legacy_listing_read_snapshot') WHERE r.rolname=current_user`)).rows[0];
    if (accountGuard?.authorized !== true) throw forbidden("Legacy system account migration requires protected source guards");
  }
  if (actor.kind === "SYSTEM_ORDER_MIGRATION") {
    const orderGuard = (await client.query<{authorized:boolean}>(`SELECT COALESCE(o.relowner=r.oid
      AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=o.oid AND c.conname='legacy_order_migration_source' AND c.convalidated
        AND position('created_by_migration_id' IN pg_get_constraintdef(c.oid))>0)
      AND NOT EXISTS (SELECT 1 FROM (VALUES
        (o.oid,'legacy_system_order_insert',7,'zzsh_order.guard_legacy_system_order()','(new.created_by_migration_id IS NOT NULL)'),
        (o.oid,'legacy_order_read_binding',7,'zzsh_order.guard_legacy_order_read_binding()',NULL),
        (o.oid,'legacy_order_read_immutable',27,'zzsh_supply.guard_release_immutable()',NULL),
        (o.oid,'legacy_order_read_audit',5,'zzsh_order.check_legacy_order_read_audit()',NULL)
      ) required(relation,name,kind,fn,qualification) WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=required.relation
          AND t.tgname=required.name AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=required.kind::smallint
          AND p.oid=to_regprocedure(required.fn) AND p.proowner=r.oid AND NOT p.prosecdef
          AND substring(pg_get_triggerdef(t.oid) FROM ' WHEN \\((.*)\\) EXECUTE FUNCTION ') IS NOT DISTINCT FROM required.qualification
          AND (required.fn<>'zzsh_order.guard_legacy_system_order()' OR position('current_user<>session_user' IN p.prosrc)>0)
          AND (required.fn<>'zzsh_order.check_legacy_order_read_audit()' OR
            (t.tgdeferrable AND t.tginitdeferred AND position('legacy_migration_manifest_sha256' IN p.prosrc)>0))))
      ,false) AS authorized FROM pg_roles r JOIN pg_class o ON o.oid=to_regclass('zzsh_order.legacy_order_read_snapshot') WHERE r.rolname=current_user`)).rows[0];
    if (orderGuard?.authorized !== true) throw forbidden("Legacy system order migration requires protected source guards");
  }
  if (actor.kind === "SYSTEM_FINANCE_MIGRATION") {
    if (!/^[a-f0-9]{64}$/.test(actor.fenceEpochSha256)) throw forbidden("Legacy system finance fence epoch is invalid");
    const financeGuard = (await client.query<{authorized:boolean}>(`SELECT COALESCE(
      (SELECT count(*)=3 FROM pg_class c WHERE c.oid IN (to_regclass('zzsh_order.personal_finance_observation_coverage'),
        to_regclass('zzsh_order.personal_finance_observation'),to_regclass('zzsh_supply.idempotency_record')) AND c.relowner=r.oid)
      AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('zzsh_iam.guard_legacy_system_audit()')
        AND position('legacy-finance-migration:' IN p.prosrc)>0 AND position('finance.history.empty_batch.imported' IN p.prosrc)>0
        AND position('finance.history.batch.imported' IN p.prosrc)>0)
      AND NOT EXISTS (SELECT 1 FROM (VALUES
        (c.oid,'history_coverage_guard',7,'zzsh_order.guard_finance_history_coverage()',false),
        (c.oid,'history_coverage_immutable',27,'zzsh_order.finance_immutable()',false),
        (c.oid,'history_coverage_read_revision',5,'zzsh_order.finance_history_coverage_read_revision()',true),
        (to_regclass('zzsh_order.personal_finance_observation'),'finance_observation_immutable',27,'zzsh_order.finance_immutable()',false),
        (to_regclass('zzsh_order.personal_finance_observation'),'a_history_subject_lock',7,'zzsh_order.lock_finance_history_subject()',false)
      ) required(relation,name,kind,fn,definer) WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=required.relation
          AND t.tgname=required.name AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=required.kind::smallint
          AND t.tgqual IS NULL AND p.oid=to_regprocedure(required.fn) AND p.proowner=r.oid AND p.prosecdef=required.definer
          AND (required.fn<>'zzsh_order.guard_finance_history_coverage()' OR
            (position('current_user<>owner_name' IN p.prosrc)>0 AND position('source_count' IN p.prosrc)>0))))
      ,false) AS authorized FROM pg_roles r JOIN pg_class c ON c.oid=to_regclass('zzsh_order.personal_finance_observation_coverage') WHERE r.rolname=current_user`)).rows[0];
    if (financeGuard?.authorized !== true) throw forbidden("Legacy system finance migration requires protected coverage guards");
  }
  if (actor.kind === "SYSTEM_INVITATION_MIGRATION") {
    if (!/^[a-f0-9]{64}$/.test(actor.fenceEpochSha256)) throw forbidden("Legacy invitation fence epoch is invalid");
    const invitationGuard = (await client.query<{authorized:boolean}>(`SELECT COALESCE(
      (SELECT count(*)=4 FROM pg_class c WHERE c.oid IN (to_regclass('zzsh_order.distribution_participant'),to_regclass('zzsh_order.distribution_invite_code'),
        to_regclass('zzsh_order.invitation_relation'),to_regclass('zzsh_supply.idempotency_record')) AND c.relowner=r.oid)
      AND zzsh_order.distribution_policy_contract_version()>=2
      AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('zzsh_iam.guard_legacy_system_audit()')
        AND position('legacy-invitation-migration:' IN p.prosrc)>0 AND position('distribution.legacy_facts.imported' IN p.prosrc)>0
        AND position('distribution.legacy_facts.counts_closed' IN p.prosrc)>0)
      AND NOT EXISTS (SELECT 1 FROM (VALUES
        (to_regclass('zzsh_order.distribution_participant'),'distribution_participant_guard',31,'zzsh_order.guard_distribution_participant()',false),
        (to_regclass('zzsh_order.distribution_participant'),'distribution_participant_knowledge_guard',21,'zzsh_order.check_distribution_relation_knowledge()',true),
        (to_regclass('zzsh_order.distribution_invite_code'),'distribution_code_lifecycle_guard',27,'zzsh_order.guard_distribution_code_lifecycle()',false),
        (to_regclass('zzsh_order.invitation_relation'),'invitation_relation_immutable',27,'zzsh_order.finance_immutable()',false),
        (to_regclass('zzsh_order.invitation_relation'),'invitation_relation_cycle_guard',7,'zzsh_order.guard_invitation_relation()',false),
        (to_regclass('zzsh_order.invitation_relation'),'invitation_relation_source_guard',7,'zzsh_order.guard_native_invitation_source()',false),
        (to_regclass('zzsh_order.invitation_relation'),'invitation_relation_knowledge_guard',5,'zzsh_order.check_distribution_relation_knowledge()',true)
      ) required(relation,name,kind,fn,deferred) WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=required.relation AND t.tgname=required.name
          AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=required.kind::smallint AND t.tgqual IS NULL
          AND p.oid=to_regprocedure(required.fn) AND p.proowner=r.oid AND NOT p.prosecdef
          AND (NOT required.deferred OR (t.tgdeferrable AND t.tginitdeferred))))
      ,false) AS authorized FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    if (invitationGuard?.authorized !== true) throw forbidden("Legacy system invitation migration requires protected graph guards");
  }
  return row.transactionId;
}

/** The caller owns the transaction and must not commit inside the batch callback. */
async function withSystemMigrationBatch<T>(client: PoolClient, actor: SystemMigrationActor, work: () => Promise<T>, readOnly = false): Promise<T> {
  if (activeBatches.has(client)) throw forbidden("Legacy system migration batch is already active");
  const context = { actor, transactionId: null as string | null, fence: actor.assertMigrationFence, source: actor.assertSourceEvidence, binding: actorBinding(actor), readOnly };
  activeBatches.set(client, context);
  try {
    const transactionId = await verifyBatch(client, actor, readOnly);
    if (actorBinding(actor) !== context.binding) throw forbidden("Legacy system migration batch changed");
    context.transactionId = transactionId;
    const result = await work();
    const batch = activeBatches.get(client);
    if (!batch || batch.actor !== actor || batch.fence !== actor.assertMigrationFence || batch.source !== actor.assertSourceEvidence || batch.binding !== actorBinding(actor))
      throw forbidden("Legacy system migration batch changed");
    if (await verifyBatch(client, actor, readOnly) !== transactionId) throw forbidden("Legacy system migration transaction changed");
    return result;
  } finally { if (activeBatches.get(client) === context) activeBatches.delete(client); }
}

export function withSystemUserMigrationBatch<T>(client: PoolClient, actor: SystemUserMigrationActor, work: () => Promise<T>): Promise<T> {
  if (actor.kind !== "SYSTEM_USER_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return withSystemMigrationBatch(client, actor, work);
}
export function withSystemAccountMigrationBatch<T>(client: PoolClient, actor: SystemAccountMigrationActor, work: () => Promise<T>): Promise<T> {
  if (actor.kind !== "SYSTEM_ACCOUNT_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return withSystemMigrationBatch(client, actor, work);
}
export function withSystemOrderMigrationBatch<T>(client: PoolClient, actor: SystemOrderMigrationActor, work: () => Promise<T>): Promise<T> {
  if (actor.kind !== "SYSTEM_ORDER_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return withSystemMigrationBatch(client, actor, work);
}
export function withSystemFinanceMigrationBatch<T>(client: PoolClient, actor: SystemFinanceMigrationActor, work: () => Promise<T>): Promise<T> {
  if (actor.kind !== "SYSTEM_FINANCE_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return withSystemMigrationBatch(client, actor, work);
}
export function withSystemFinanceRecoveryBatch<T>(client: PoolClient, actor: SystemFinanceMigrationActor, work: () => Promise<T>): Promise<T> {
  if (actor.kind !== "SYSTEM_FINANCE_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return withSystemMigrationBatch(client, actor, work, true);
}
export function withSystemInvitationMigrationBatch<T>(client: PoolClient, actor: SystemInvitationMigrationActor, work: () => Promise<T>): Promise<T> {
  if (actor.kind !== "SYSTEM_INVITATION_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return withSystemMigrationBatch(client, actor, work);
}
export function withSystemInvitationRecoveryBatch<T>(client: PoolClient, actor: SystemInvitationMigrationActor, work: () => Promise<T>): Promise<T> {
  if (actor.kind !== "SYSTEM_INVITATION_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return withSystemMigrationBatch(client, actor, work, true);
}

async function authorizeSystemMigration(client: PoolClient, actor: SystemMigrationActor, validateSource: () => Promise<void>, readOnly = false): Promise<void> {
  const batch = activeBatches.get(client);
  if (!batch || batch.transactionId === null || batch.actor !== actor || batch.fence !== actor.assertMigrationFence || batch.source !== actor.assertSourceEvidence || batch.binding !== actorBinding(actor)
      || batch.readOnly !== readOnly || actor.id !== expectedActorId(actor) || client.getTransactionStatus() !== "T") {
    throw forbidden("Legacy system migration batch is unavailable");
  }
  await validateSource();
  if (batch.binding !== actorBinding(actor) || batch.fence !== actor.assertMigrationFence || batch.source !== actor.assertSourceEvidence)
    throw forbidden("Legacy system migration batch changed");
  const transactionIdentity = readOnly ? `(SELECT virtualtransaction::text FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='virtualxid' AND granted LIMIT 1)` : `pg_current_xact_id()::text`;
  const row = (await client.query<{ transactionId: string; nonce: string; direct: boolean; mode: boolean }>(`SELECT ${transactionIdentity} AS "transactionId",
    current_setting('zzsh.regression_run',true) AS nonce,current_user=session_user AS direct,
    ${readOnly ? "current_setting('transaction_read_only')='on' AND current_setting('transaction_isolation') IN ('repeatable read','serializable') AND pg_current_xact_id_if_assigned() IS NULL" : "current_setting('transaction_read_only')='off'"} AS mode`)).rows[0];
  if (row?.transactionId !== batch.transactionId || row.nonce !== actor.target.nonce || row.direct !== true || row.mode !== true) {
    throw forbidden("Legacy system migration transaction changed");
  }
}
export function authorizeSystemUserMigration(client: PoolClient, actor: SystemUserMigrationActor, source: UserSource): Promise<void> {
  if (actor.kind !== "SYSTEM_USER_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  return authorizeSystemMigration(client, actor, () => actor.assertSourceEvidence(source));
}
export function authorizeSystemAccountMigration(client: PoolClient, actor: SystemAccountMigrationActor, source: AccountSource): Promise<void> {
  if (actor.kind !== "SYSTEM_ACCOUNT_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  const expectedAccountId = `account_${createHash("sha256").update(JSON.stringify(["legacy-account", source.sourceSystem, source.sourceEntity, source.legacyId])).digest("hex").slice(0,40)}`;
  if (!['CREATE','OBSERVATION','SNAPSHOT','DISPLAY'].includes(source.operation) || source.sourceSystem !== "legacy_mysql_restore" || source.sourceEntity !== "la_rental_accounts"
      || !/^[1-9][0-9]{0,23}$/.test(source.legacyId) || source.accountId !== expectedAccountId
      || !/^[a-f0-9]{64}$/.test(source.sourceDigest) || !/^[a-f0-9]{64}$/.test(source.payloadDigest))
    throw forbidden("Legacy system account source is invalid");
  return authorizeSystemMigration(client, actor, () => actor.assertSourceEvidence(source));
}
export function authorizeSystemOrderMigration(client: PoolClient, actor: SystemOrderMigrationActor, source: OrderSource): Promise<void> {
  if (actor.kind !== "SYSTEM_ORDER_MIGRATION") throw forbidden("Legacy system migration kind is invalid");
  const expectedOrderId = `legacy_order_${createHash("sha256").update(JSON.stringify(["legacy_mysql_restore", "la_order", source.legacyId])).digest("hex").slice(0,40)}`;
  if (!/^[1-9][0-9]{0,23}$/.test(source.legacyId) || source.orderId !== expectedOrderId
      || !/^[a-f0-9]{64}$/.test(source.sourceDigest) || !/^[a-f0-9]{64}$/.test(source.bindingDigest))
    throw forbidden("Legacy system order source is invalid");
  return authorizeSystemMigration(client, actor, () => actor.assertSourceEvidence(source));
}
export function authorizeSystemFinanceMigration(client: PoolClient, actor: SystemFinanceMigrationActor, source: FinanceMigrationSource, readOnly = false): Promise<void> {
  if (actor.kind !== "SYSTEM_FINANCE_MIGRATION" || !/^[a-f0-9]{64}$/.test(source.inputsDigest)
      || !/^[a-f0-9]{64}$/.test(source.inputSha256) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.cutoff)
      || !Number.isFinite(Date.parse(source.cutoff))) throw forbidden("Legacy system finance source is invalid");
  return authorizeSystemMigration(client, actor, () => actor.assertSourceEvidence(source),readOnly);
}
export function authorizeSystemInvitationMigration(client: PoolClient, actor: SystemInvitationMigrationActor, source: InvitationMigrationSource, readOnly = false): Promise<void> {
  if (actor.kind !== "SYSTEM_INVITATION_MIGRATION" || !['IMPORT','COUNTS'].includes(source.phase)
      || !/^legacy-invitation-facts-v2-[a-f0-9]{40}$/.test(source.key) || !/^[a-f0-9]{64}$/.test(source.sourceDigest)
      || !/^[a-f0-9]{64}$/.test(source.bodyDigest)) throw forbidden("Legacy system invitation source is invalid");
  return authorizeSystemMigration(client, actor, () => actor.assertSourceEvidence(source),readOnly);
}
