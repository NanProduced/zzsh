import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { forbidden } from "../supply/supply-util";

type MigrationTarget = Readonly<{ systemIdentifier: string; databaseOid: string; marker: string; nonce: string; roleOid: string }>;
type UserSource = Readonly<{ sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string; evidenceDigest: string }>;
export type AccountSource = Readonly<{ operation: "CREATE" | "OBSERVATION" | "SNAPSHOT"; accountId: string;
  sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string; payloadDigest: string }>;

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

type SystemMigrationActor = SystemUserMigrationActor | SystemAccountMigrationActor;
const activeBatches = new WeakMap<PoolClient, { actor: SystemMigrationActor; transactionId: string | null;
  fence: SystemMigrationActor["assertMigrationFence"]; source: SystemMigrationActor["assertSourceEvidence"]; binding: string }>();

function expectedActorId(actor: SystemMigrationActor): string {
  if (actor.kind === "SYSTEM_USER_MIGRATION") return systemUserMigrationId(actor.sourceDatasetSha256, actor.target);
  if (actor.kind === "SYSTEM_ACCOUNT_MIGRATION") return systemAccountMigrationId(actor.sourceDatasetSha256, actor.target);
  throw forbidden("Legacy system migration kind is invalid");
}
function actorBinding(actor: SystemMigrationActor): string {
  return JSON.stringify([actor.kind,actor.id,actor.requestId,actor.sourceDatasetSha256,actor.target.systemIdentifier,
    actor.target.databaseOid,actor.target.marker,actor.target.nonce,actor.target.roleOid]);
}

async function verifyBatch(client: PoolClient, actor: SystemMigrationActor): Promise<string> {
  if (client.getTransactionStatus() !== "T" || actor.id !== expectedActorId(actor)
      || typeof actor.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actor.requestId)
      || typeof actor.assertMigrationFence !== "function" || typeof actor.assertSourceEvidence !== "function") {
    throw forbidden("Legacy system migration source is invalid");
  }
  await actor.assertMigrationFence(client);
  const row = (await client.query<{ authorized: boolean; transactionId: string }>(`SELECT pg_current_xact_id()::text AS "transactionId", COALESCE(
    current_user=session_user AND r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls
    AND r.oid::text=$1 AND d.oid::text=$2 AND shobj_description(d.oid,'pg_database')=$3
    AND current_setting('zzsh.regression_run',true)=$4 AND (SELECT system_identifier::text FROM pg_control_system())=$5
    AND r.oid=a.relowner AND r.oid=u.relowner AND current_setting('session_replication_role')='origin'
    AND EXISTS (SELECT 1 FROM pg_attribute c WHERE c.attrelid=a.oid AND c.attname='legacy_user_migration_manifest_sha256' AND NOT c.attisdropped)
    AND NOT EXISTS (SELECT 1 FROM (VALUES
      ('legacy_system_user_audit_insert',7,'(new.legacy_user_migration_manifest_sha256 IS NOT NULL)'),
      ('legacy_system_user_audit_update',19,'((old.legacy_user_migration_manifest_sha256 IS NOT NULL) OR (new.legacy_user_migration_manifest_sha256 IS NOT NULL))'),
      ('legacy_system_user_audit_delete',11,'(old.legacy_user_migration_manifest_sha256 IS NOT NULL)')
    ) required(name,kind,qualification)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=a.oid AND t.tgname=required.name AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
          AND t.tgtype=required.kind::smallint
          AND substring(pg_get_triggerdef(t.oid) FROM ' WHEN \\((.*)\\) EXECUTE FUNCTION ') IS NOT DISTINCT FROM required.qualification
          AND p.oid=to_regprocedure('zzsh_iam.guard_legacy_system_user_audit()') AND p.proowner=a.relowner AND NOT p.prosecdef
          AND position('current_user<>session_user' IN p.prosrc)>0 AND position('legacy-user-migration:' IN p.prosrc)>0))
    ,false) AS authorized
    FROM pg_roles r JOIN pg_class a ON a.oid=to_regclass('zzsh_iam.audit_event')
      JOIN pg_class u ON u.oid=to_regclass('zzsh_auth_user."user"')
      JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`,
    [actor.target.roleOid, actor.target.databaseOid, actor.target.marker, actor.target.nonce, actor.target.systemIdentifier])).rows[0];
  if (row?.authorized !== true) throw forbidden("Legacy system migration requires the protected migration role");
  if (actor.kind === "SYSTEM_ACCOUNT_MIGRATION") {
    const accountGuard = (await client.query<{ authorized: boolean }>(`SELECT COALESCE(
      (SELECT count(*)=4 FROM pg_class c WHERE c.oid IN (to_regclass('zzsh_supply.rental_account'),
        to_regclass('zzsh_supply.listing_version'),to_regclass('zzsh_supply.legacy_supply_map'),
        to_regclass('zzsh_supply.legacy_listing_read_snapshot')) AND c.relowner=r.oid)
      AND EXISTS (SELECT 1 FROM pg_attribute c WHERE c.attrelid=a.oid AND c.attname='legacy_account_migration_manifest_sha256' AND NOT c.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=s.oid AND c.conname='legacy_snapshot_migration_source' AND c.convalidated
        AND position('created_by_migration_id' IN pg_get_constraintdef(c.oid))>0)
      AND NOT EXISTS (SELECT 1 FROM (VALUES
        (a.oid,'legacy_system_account_audit_insert',7,'zzsh_iam.guard_legacy_system_account_audit()','(new.legacy_account_migration_manifest_sha256 IS NOT NULL)'),
        (a.oid,'legacy_system_account_audit_update',19,'zzsh_iam.guard_legacy_system_account_audit()','((old.legacy_account_migration_manifest_sha256 IS NOT NULL) OR (new.legacy_account_migration_manifest_sha256 IS NOT NULL))'),
        (a.oid,'legacy_system_account_audit_delete',11,'zzsh_iam.guard_legacy_system_account_audit()','(old.legacy_account_migration_manifest_sha256 IS NOT NULL)'),
        (s.oid,'legacy_system_snapshot_insert',7,'zzsh_supply.guard_legacy_system_snapshot()','(new.created_by_migration_id IS NOT NULL)'),
        (s.oid,'legacy_system_snapshot_audit',5,'zzsh_supply.guard_legacy_system_snapshot_audit()','(new.created_by_migration_id IS NOT NULL)'),
        (s.oid,'legacy_read_snapshot_insert',7,'zzsh_supply.guard_legacy_read_snapshot()',NULL),
        (s.oid,'legacy_read_snapshot_immutable',27,'zzsh_supply.guard_release_immutable()',NULL),
        (to_regclass('zzsh_supply.legacy_supply_map'),'legacy_map_immutable',27,'zzsh_supply.guard_release_immutable()',NULL)
      ) required(relation,name,kind,fn,qualification) WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=required.relation
          AND t.tgname=required.name AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
          AND t.tgtype=required.kind::smallint AND p.oid=to_regprocedure(required.fn) AND p.proowner=r.oid AND NOT p.prosecdef
          AND substring(pg_get_triggerdef(t.oid) FROM ' WHEN \\((.*)\\) EXECUTE FUNCTION ') IS NOT DISTINCT FROM required.qualification
          AND (required.fn<>'zzsh_iam.guard_legacy_system_account_audit()' OR
            (position('current_user<>session_user' IN p.prosrc)>0 AND position('legacy-account-migration:' IN p.prosrc)>0))
          AND (required.fn<>'zzsh_supply.guard_legacy_system_snapshot()' OR position('current_user<>session_user' IN p.prosrc)>0)
          AND (required.fn<>'zzsh_supply.guard_legacy_system_snapshot_audit()' OR position('legacy_account_migration_manifest_sha256' IN p.prosrc)>0)
          AND (required.name<>'legacy_system_snapshot_audit' OR (t.tgdeferrable AND t.tginitdeferred))))
      ,false) AS authorized FROM pg_roles r JOIN pg_class a ON a.oid=to_regclass('zzsh_iam.audit_event')
      JOIN pg_class s ON s.oid=to_regclass('zzsh_supply.legacy_listing_read_snapshot') WHERE r.rolname=current_user`)).rows[0];
    if (accountGuard?.authorized !== true) throw forbidden("Legacy system account migration requires protected source guards");
  }
  return row.transactionId;
}

/** The caller owns the transaction and must not commit inside the batch callback. */
async function withSystemMigrationBatch<T>(client: PoolClient, actor: SystemMigrationActor, work: () => Promise<T>): Promise<T> {
  if (activeBatches.has(client)) throw forbidden("Legacy system migration batch is already active");
  const context = { actor, transactionId: null as string | null, fence: actor.assertMigrationFence, source: actor.assertSourceEvidence, binding: actorBinding(actor) };
  activeBatches.set(client, context);
  try {
    const transactionId = await verifyBatch(client, actor);
    if (actorBinding(actor) !== context.binding) throw forbidden("Legacy system migration batch changed");
    context.transactionId = transactionId;
    const result = await work();
    const batch = activeBatches.get(client);
    if (!batch || batch.actor !== actor || batch.fence !== actor.assertMigrationFence || batch.source !== actor.assertSourceEvidence || batch.binding !== actorBinding(actor))
      throw forbidden("Legacy system migration batch changed");
    if (await verifyBatch(client, actor) !== transactionId) throw forbidden("Legacy system migration transaction changed");
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

async function authorizeSystemMigration(client: PoolClient, actor: SystemMigrationActor, validateSource: () => Promise<void>): Promise<void> {
  const batch = activeBatches.get(client);
  if (!batch || batch.transactionId === null || batch.actor !== actor || batch.fence !== actor.assertMigrationFence || batch.source !== actor.assertSourceEvidence || batch.binding !== actorBinding(actor)
      || actor.id !== expectedActorId(actor) || client.getTransactionStatus() !== "T") {
    throw forbidden("Legacy system migration batch is unavailable");
  }
  await validateSource();
  if (batch.binding !== actorBinding(actor) || batch.fence !== actor.assertMigrationFence || batch.source !== actor.assertSourceEvidence)
    throw forbidden("Legacy system migration batch changed");
  const row = (await client.query<{ transactionId: string; nonce: string; direct: boolean }>(`SELECT pg_current_xact_id()::text AS "transactionId",
    current_setting('zzsh.regression_run',true) AS nonce,current_user=session_user AS direct`)).rows[0];
  if (row?.transactionId !== batch.transactionId || row.nonce !== actor.target.nonce || row.direct !== true) {
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
  if (!['CREATE','OBSERVATION','SNAPSHOT'].includes(source.operation) || source.sourceSystem !== "legacy_mysql_restore" || source.sourceEntity !== "la_rental_accounts"
      || !/^[1-9][0-9]{0,23}$/.test(source.legacyId) || source.accountId !== expectedAccountId
      || !/^[a-f0-9]{64}$/.test(source.sourceDigest) || !/^[a-f0-9]{64}$/.test(source.payloadDigest))
    throw forbidden("Legacy system account source is invalid");
  return authorizeSystemMigration(client, actor, () => actor.assertSourceEvidence(source));
}
