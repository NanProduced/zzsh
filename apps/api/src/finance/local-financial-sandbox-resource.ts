import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ConfigurationError, type AppConfig } from "../config/config";
import { SecurityApiError } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { conflict, notFound } from "../supply/supply-util";
import { assertBusinessRuntimeIdentity } from "../database/business";

export type LocalFinancialSandbox = Readonly<{ kind: "REGISTERED_LOCAL_FINANCIAL_SANDBOX" }>;
export type DailyRestoreProof = Readonly<{ kind: "VERIFIED_DAILY_RESTORE" }>;
export type SandboxOrigins = Readonly<{ apiOrigin: string; userOrigin: string; adminOrigin: string; secureCookies: boolean }>;
export type SandboxResourceReceipt = Readonly<{
  database: string; resourceOid: number; marker: string;
  owner: string; ownerOid: number; runtimeRole: string; runtimeRoleOid: number; migrationRole: string; migrationRoleOid: number;
}>;
type Restore = Readonly<{ sourceDatabase: string; sourceOid: number; sourceMarker: string; receiptSha256: string; equivalentSha256: string; targetDatabase: string; targetOid: number; targetMarker: string }>;
type Registration = Readonly<{
  kind: "LOCAL_FINANCIAL_SANDBOX_REGISTRATION_V1"; reference: string; approvedByAdminId: string;
  resource: SandboxResourceReceipt; origins: SandboxOrigins; adoption: Restore;
}>;
type Proof = Readonly<{ registration: Registration; canonical: string; digest: string }>;
const restores = new WeakMap<DailyRestoreProof, Restore>(), proofs = new WeakMap<LocalFinancialSandbox, Proof>();
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, DB_ID = /^[a-z][a-z0-9_]{0,62}$/;
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "LOCAL_FINANCIAL_SANDBOX_NOT_ADMITTED");
const oid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 4294967295;

/** Root supplies pinned receipt bytes. This verifies restoration evidence; it grants no money authority. */
export function verifyDailyRestoreProof(bytes: Uint8Array, expectedSha256: string): DailyRestoreProof {
  if (typeof expectedSha256 !== "string" || !HASH.test(expectedSha256) || sha(bytes) !== expectedSha256) throw new ConfigurationError("Pinned daily restoration receipt required");
  let doc: Record<string, any>;
  try { doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ConfigurationError("Daily restoration receipt is invalid"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.phase !== "finalize-restored-target" || doc.status !== "MAPPED_DAILY_EQUIVALENT_PENDING_ROOT_APP_ADOPTION"
    || doc.source?.name !== "zzsh_test_regression" || String(doc.source?.oid) !== "2220718" || doc.source?.marker !== "zzsh:regression-test:v1"
    || doc.target?.name !== "zzsh_dev_daily" || !oid(Number(doc.target?.oid)) || doc.target?.marker !== "zzsh:local-daily:v1"
    || doc.sourceWrites !== 0 || doc.globalRoleChanges !== 0 || doc.cleanup?.allAcknowledged !== true || doc.maintenanceClosed !== true
    || doc.comparison?.equal !== true || !HASH.test(doc.comparison?.expectedSha256 ?? "")
    || doc.comparison.expectedSha256 !== doc.comparison.actualSha256) throw new ConfigurationError("Exact successful daily restoration proof required");
  const value = Object.freeze({ kind: "VERIFIED_DAILY_RESTORE" as const });
  restores.set(value, Object.freeze({ sourceDatabase: doc.source.name, sourceOid: Number(doc.source.oid), sourceMarker: doc.source.marker, receiptSha256: expectedSha256,
    equivalentSha256: doc.comparison.expectedSha256, targetDatabase: doc.target.name, targetOid: Number(doc.target.oid), targetMarker: doc.target.marker }));
  return value;
}

/** Explicit dev/fake composition only. SQL owner registration must match before any operation is admitted. */
export function createLocalFinancialSandbox(input: {
  config: AppConfig; resource: SandboxResourceReceipt; origins: SandboxOrigins; restoreProof: DailyRestoreProof;
  reference: string; approvedByAdminId: string;
}): LocalFinancialSandbox {
  const { config } = input, adoption = restores.get(input.restoreProof);
  // Deliberately copy known public metadata only. A receipt object accidentally spread from local
  // credentials must never persist extra password/connection fields in the canonical registration.
  const resource: SandboxResourceReceipt = Object.freeze({ database: input.resource.database, resourceOid: input.resource.resourceOid,
    marker: input.resource.marker, owner: input.resource.owner, ownerOid: input.resource.ownerOid,
    runtimeRole: input.resource.runtimeRole, runtimeRoleOid: input.resource.runtimeRoleOid,
    migrationRole: input.resource.migrationRole, migrationRoleOid: input.resource.migrationRoleOid });
  const origins: SandboxOrigins = Object.freeze({ apiOrigin: input.origins.apiOrigin, userOrigin: input.origins.userOrigin,
    adminOrigin: input.origins.adminOrigin, secureCookies: input.origins.secureCookies });
  const local = (value: string) => { try { const url = new URL(value); return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port) && url.origin === value; } catch { return false; } };
  if (!adoption || config.profile !== "dev" || config.provider !== "fake" || process.env.NODE_ENV === "production"
    || config.host !== "127.0.0.1" || config.database.target !== "local-compose" || config.database.targetProfile !== "dev"
    || config.database.host !== "127.0.0.1" || ![55432,55433].includes(config.database.port) || resource.database !== "zzsh_dev_daily"
    || resource.database !== config.database.name || resource.runtimeRole !== config.database.user || resource.runtimeRole !== config.database.runtimeUser
    || resource.database !== adoption.targetDatabase || resource.resourceOid !== adoption.targetOid || resource.marker !== adoption.targetMarker
    || ![resource.owner, resource.runtimeRole, resource.migrationRole].every(value => typeof value === "string" && DB_ID.test(value))
    || ![resource.resourceOid, resource.ownerOid, resource.runtimeRoleOid, resource.migrationRoleOid].every(oid)
    || resource.runtimeRole === resource.owner || resource.runtimeRole === resource.migrationRole
    || resource.runtimeRoleOid === resource.ownerOid || resource.runtimeRoleOid === resource.migrationRoleOid
    || (resource.owner === resource.migrationRole) !== (resource.ownerOid === resource.migrationRoleOid)
    || typeof input.reference !== "string" || typeof input.approvedByAdminId !== "string" || !ID.test(input.reference) || !ID.test(input.approvedByAdminId) || origins.secureCookies !== false
    || ![origins.apiOrigin, origins.userOrigin, origins.adminOrigin].every(local)
    || new Set([origins.apiOrigin, origins.userOrigin, origins.adminOrigin]).size !== 3
    || origins.apiOrigin !== `http://127.0.0.1:${config.port}`) throw new ConfigurationError("Exact registered local daily dev/fake sandbox required");
  const registration: Registration = Object.freeze({ kind: "LOCAL_FINANCIAL_SANDBOX_REGISTRATION_V1", reference: input.reference,
    approvedByAdminId: input.approvedByAdminId, resource, origins, adoption });
  const canonical = canonicalize(registration), value = Object.freeze({ kind: "REGISTERED_LOCAL_FINANCIAL_SANDBOX" as const });
  proofs.set(value, Object.freeze({ registration, canonical, digest: sha(canonical) })); return value;
}

export function localFinancialSandboxRegistration(scope: LocalFinancialSandbox): Proof {
  const proof = proofs.get(scope); if (!proof || process.env.NODE_ENV === "production") throw unavailable(); return proof;
}

export function assertLocalFinancialSandboxAssembly(scope: LocalFinancialSandbox, origins: SandboxOrigins): void {
  const expected = localFinancialSandboxRegistration(scope).registration.origins;
  if (origins.secureCookies !== false || ["apiOrigin", "userOrigin", "adminOrigin"].some(key => origins[key as keyof SandboxOrigins] !== expected[key as keyof SandboxOrigins])) throw new ConfigurationError("Local sandbox origins differ");
}

/** Every write/recovery shares the caller's transaction and exact runtime; no credential or global GUC fallback. */
export async function assertLocalFinancialSandboxResource(client: PoolClient, scope: LocalFinancialSandbox, mode: "WRITE" | "READ_ORIGINAL" = "WRITE") {
  if (!["WRITE", "READ_ORIGINAL"].includes(mode)) throw unavailable();
  const proof = localFinancialSandboxRegistration(scope), expected = proof.registration.resource;
  const ready = (await client.query("SELECT to_regclass('zzsh_order.local_financial_sandbox_registration') IS NOT NULL AS ready")).rows[0];
  if (ready?.ready !== true) throw unavailable();
  // Transaction-local only. Bound role/registration lock waits too, before any capability is admitted.
  await client.query("SELECT set_config('max_parallel_workers_per_gather','0',true),set_config('statement_timeout','3000ms',true),set_config('lock_timeout','500ms',true)");
  const row = (await client.query(`SELECT d.oid::text AS resource_oid,current_database() AS database,current_user AS role,
    shobj_description(d.oid,'pg_database') AS marker,pg_get_userbyid(d.datdba) AS owner,d.datdba::text AS owner_oid,
    r.oid::text AS runtime_role_oid,r.rolsuper,r.rolbypassrls,m.oid::text AS migration_role_oid,
    m.rolsuper AS migration_super,m.rolbypassrls AS migration_bypass,
    EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS runtime_has_membership,
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid AND n.nspname IN
      ('zzsh_business_meta','zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit')) AS runtime_owns_business_routine,
    s.canonical_registration,s.registration_digest,s.active${mode === "WRITE" ? ",pg_current_xact_id()::text AS sandbox_xid" : ""}
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user LEFT JOIN pg_roles m ON m.rolname=$2
    LEFT JOIN zzsh_order.local_financial_sandbox_registration s ON s.reference=$1 WHERE d.datname=current_database()`,
  [proof.registration.reference, expected.migrationRole])).rows[0];
  if (!row || Number(row.resource_oid) !== expected.resourceOid || row.database !== expected.database || row.role !== expected.runtimeRole
    || row.marker !== expected.marker || row.owner !== expected.owner || Number(row.owner_oid) !== expected.ownerOid
    || Number(row.runtime_role_oid) !== expected.runtimeRoleOid || Number(row.migration_role_oid) !== expected.migrationRoleOid
    || row.rolsuper !== false || row.rolbypassrls !== false || row.runtime_has_membership !== false || row.runtime_owns_business_routine !== false
    || row.migration_super !== false || row.migration_bypass !== false || row.canonical_registration !== proof.canonical
    || row.registration_digest !== proof.digest || typeof row.active !== "boolean" || (mode === "WRITE" && row.active !== true)) throw unavailable();
  try { await assertBusinessRuntimeIdentity(client, { database: { name: expected.database, user: expected.runtimeRole, runtimeUser: expected.runtimeRole } }); }
  catch (error) { throw Object.assign(unavailable(), { cause: error }); }
  if (mode === "WRITE") {
    const locked = (await client.query(`SELECT canonical_registration,registration_digest,active,pg_current_xact_id()::text AS sandbox_xid
      FROM zzsh_order.local_financial_sandbox_registration WHERE reference=$1 FOR SHARE`, [proof.registration.reference])).rows[0];
    if (!locked || locked.active !== true || locked.canonical_registration !== proof.canonical || locked.registration_digest !== proof.digest
      || typeof row.sandbox_xid !== "string" || !/^[1-9][0-9]*$/.test(row.sandbox_xid) || locked.sandbox_xid !== row.sandbox_xid) throw unavailable();
  }
  return Object.freeze({ ...proof.registration, active: row.active });
}

/** Restored provenance may be read, never relabelled as a new payment/withdrawal or a current write admission. */
export function assertSandboxOriginalResource(scope: LocalFinancialSandbox, originalResourceOid: unknown): void {
  const proof = localFinancialSandboxRegistration(scope);
  if (originalResourceOid !== proof.registration.adoption.sourceOid && originalResourceOid !== String(proof.registration.adoption.sourceOid)) throw unavailable();
}

/** Future original orders are admitted from creation audit after registration. Caller already owns
 * this order's lock in a short request/ISSUE transaction; never invoke before a later graph lock. */
export async function ensureLocalSandboxOrderAdmission(client: PoolClient, scope: LocalFinancialSandbox, orderId: string) {
  const proof = localFinancialSandboxRegistration(scope), { resource, approvedByAdminId } = await assertLocalFinancialSandboxResource(client, scope);
  if (!ID.test(orderId)) throw notFound();
  const old = (await client.query("SELECT id,mode,resource_oid,resource_name,resource_marker,approval_digest FROM zzsh_order.distribution_order_admission WHERE order_id=$1", [orderId])).rows[0];
  const exact = (row: Record<string, any> | undefined) => row?.mode === "LOCAL_CONTROLLED" && Number(row.resource_oid) === resource.resourceOid
    && row.resource_name === resource.database && row.resource_marker === resource.marker && row.approval_digest === proof.digest;
  if (old) { if (!exact(old)) throw conflict("Original order admission belongs to another provenance"); return old.id as string; }
  const origins = (await client.query(`SELECT a.id FROM zzsh_iam.audit_event a JOIN zzsh_order.rental_order o ON o.id=a.object_id
    JOIN zzsh_order.local_financial_sandbox_registration s ON s.reference=$2
    WHERE o.id=$1 AND o.status='PENDING_PAYMENT' AND o.paid_confirmation_id IS NULL AND o.created_at>=s.registered_at
      AND a.action='order.reservation.created' AND a.object_type='rental_order' AND a.actor_type='user'
      AND a.actor_id=o.renter_user_id AND a.outcome='SUCCESS' AND a.occurred_at>=s.registered_at ORDER BY a.id LIMIT 2`,
  [orderId, proof.registration.reference])).rows;
  if (origins.length !== 1) throw unavailable();
  const id = "sandbox_order_" + sha(proof.digest + ":" + orderId).slice(0, 40);
  await client.query(`INSERT INTO zzsh_order.distribution_order_admission(id,order_id,mode,resource_oid,resource_name,resource_marker,
    approval_digest,native_creation_audit_id,revision,active,admitted_at,expires_at,created_by_admin_id,reason)
    VALUES($1,$2,'LOCAL_CONTROLLED',$3,$4,$5,$6,$7,1,true,clock_timestamp(),'infinity'::timestamptz,$8,'Registered local financial sandbox original order')
    ON CONFLICT(order_id) DO NOTHING`, [id, orderId, resource.resourceOid, resource.database, resource.marker, proof.digest, origins[0].id, approvedByAdminId]);
  const actual = (await client.query("SELECT id,mode,resource_oid,resource_name,resource_marker,approval_digest FROM zzsh_order.distribution_order_admission WHERE order_id=$1", [orderId])).rows[0];
  if (!exact(actual)) throw conflict("Concurrent order admission has different provenance"); return actual.id as string;
}

export async function assertLocalSandboxOrderAdmission(client: PoolClient, scope: LocalFinancialSandbox, orderId: string) {
  const proof = localFinancialSandboxRegistration(scope), { resource } = await assertLocalFinancialSandboxResource(client, scope);
  const row = (await client.query(`SELECT id FROM zzsh_order.distribution_order_admission WHERE order_id=$1 AND mode='LOCAL_CONTROLLED'
    AND resource_oid=$2 AND resource_name=$3 AND resource_marker=$4 AND approval_digest=$5 AND active
    AND admitted_at<=clock_timestamp() AND expires_at>clock_timestamp()`,
  [orderId, resource.resourceOid, resource.database, resource.marker, proof.digest])).rows[0];
  if (!row) throw unavailable();
  return row.id as string;
}
