import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";
import { SecurityApiError, recordAudit } from "../auth/security-core";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { assertBusinessRuntimeIdentity } from "../database/business";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";
import { matchesLegacyBankSource, prepareLegacyBankBinding, validLegacyBankDetails, type LegacyBankSource, type WithdrawalBankBindingOptions } from "./withdrawal-bank-binding";

type BankRow = Readonly<{ user_id: string; name: string | null; card_no: string | null; create_time: string; update_time: string }>;
type Source = Readonly<{ sourceReceiptSha256: string; sourceDumpSha256: string; sourceCutoff: string }>;
export type LocalBankTarget = Readonly<{ round: 6; host: "127.0.0.1"; port: 55432; database: string; databaseOid: number;
  marker: string; nonce: string; owner: string; ownerOid: number; runtimeUser: string; runtimeRoleOid: number }>;
export type LocalBankOperator = Readonly<{ userId: string; sessionId: string }>;
type Row = Readonly<{ source: LegacyBankSource; name: string; cardNo: string }>;
export type LegacyBankImportPlan = Readonly<{ kind: "CONTROLLED_LEGACY_BANK_IMPORT_PLAN" }>;
type Counts = { source: number; ready: number; invalid: number; duplicate: number; userSourceMissing: number };
type Plan = { target: LocalBankTarget; operator: LocalBankOperator; source: Source; rows: Map<string, Row>; counts: Counts };
const plans = new WeakMap<LegacyBankImportPlan, Plan>();
const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,23}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,11}$/.test(value);

/** The complete source is classified before any write; private rows exist only inside this process. */
export function prepareLegacyBankImport(rows: readonly BankRow[], userSourceDigests: ReadonlyMap<string, string>, source: Source,
  target: LocalBankTarget, operator: LocalBankOperator): LegacyBankImportPlan {
  if (!Array.isArray(rows) || !(userSourceDigests instanceof Map) || !source || !hash(source.sourceReceiptSha256) || !hash(source.sourceDumpSha256)
    || typeof source.sourceCutoff !== "string" || !Number.isFinite(Date.parse(source.sourceCutoff))
    || !target || target.round !== 6 || target.host !== "127.0.0.1" || ![55432,55433].includes(target.port) || process.env.NODE_ENV === "production"
    || !/^zzsh_test_[a-z0-9_]{1,48}$/.test(target.database) || !/^zzsh_[a-z0-9_]{1,55}$/.test(target.runtimeUser)
    || !/^zzsh:[a-z0-9-]+:v1$/.test(target.marker) || !/^[a-f0-9]{24}$/.test(target.nonce)
    || !/^zzsh(?:_[a-z0-9_]+)?$/.test(target.owner) || target.owner === target.runtimeUser
    || ![target.databaseOid, target.ownerOid, target.runtimeRoleOid].every(v => Number.isSafeInteger(v) && v > 0 && v <= 4294967295)
    || [3058841, 3179610, 3287891].includes(target.databaseOid) || !operator
    || ![operator.userId, operator.sessionId].every(v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))) throw unavailable("LEGACY_BANK_PLAN_INVALID");
  const userCounts = new Map<string, number>();
  for (const row of rows) {
    if (row && id(row.user_id)) userCounts.set(row.user_id, (userCounts.get(row.user_id) ?? 0) + 1);
  }
  const selected = new Map<string, Row>(), counts: Counts = { source: rows.length, ready: 0, invalid: 0, duplicate: 0, userSourceMissing: 0 };
  for (const row of rows) {
    if (!row || !id(row.user_id) || !validLegacyBankDetails(row.name, row.card_no) || !timestamp(row.create_time) || !timestamp(row.update_time)
      || Number(row.create_time) > Number(row.update_time) || Number(row.update_time) * 1000 > Date.parse(source.sourceCutoff)) { counts.invalid++; continue; }
    if (userCounts.get(row.user_id) !== 1) { counts.duplicate++; continue; }
    const userSourceDigest = userSourceDigests.get(row.user_id);
    if (!hash(userSourceDigest)) { counts.userSourceMissing++; continue; }
    selected.set(row.user_id, Object.freeze({ name: row.name!, cardNo: row.card_no!, source: Object.freeze({
      sourceReceiptSha256: source.sourceReceiptSha256, sourceDumpSha256: source.sourceDumpSha256,
      sourceCutoff: new Date(source.sourceCutoff).toISOString(), legacyUserId: row.user_id, userSourceDigest,
      sourceCreateTime: row.create_time, sourceUpdateTime: row.update_time }) }));
    counts.ready++;
  }
  const token = Object.freeze({ kind: "CONTROLLED_LEGACY_BANK_IMPORT_PLAN" as const });
  plans.set(token, { target: Object.freeze({ ...target }), operator: Object.freeze({ userId: operator.userId, sessionId: operator.sessionId }), source: Object.freeze({ sourceReceiptSha256: source.sourceReceiptSha256,
    sourceDumpSha256: source.sourceDumpSha256, sourceCutoff: new Date(source.sourceCutoff).toISOString() }), rows: selected, counts: Object.freeze(counts) });
  return token;
}

export function legacyBankImportCounts(plan: LegacyBankImportPlan): Readonly<Counts> {
  const value = plans.get(plan); if (!value) throw unavailable("LEGACY_BANK_PLAN_UNAVAILABLE");
  return value.counts;
}
export function legacyBankImportBinding(plan: LegacyBankImportPlan) {
  const value = plans.get(plan); if (!value) throw unavailable("LEGACY_BANK_PLAN_UNAVAILABLE");
  return { target: value.target, source: value.source };
}

/** Keyed commitment binds private plan values without persisting them in the review record. */
export function legacyBankImportCommitment(plan: LegacyBankImportPlan, o: WithdrawalBankBindingOptions): string {
  const value = plans.get(plan), version = o.protection?.currentKeyVersion;
  if (!value || o.database !== value.target.database || o.runtimeUser !== value.target.runtimeUser || typeof version !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(version) || !o.protection) throw unavailable("LEGACY_BANK_PLAN_UNAVAILABLE");
  let secret: Buffer | undefined, derived: Buffer | undefined;
  try {
    const material = o.protection.keyFor(version); if (!(material instanceof Uint8Array) || material.byteLength !== 32) throw Error();
    secret = Buffer.from(material); derived = createHmac("sha256", secret).update("legacy-bank-import.plan.key.v1").digest();
    const hmac = createHmac("sha256", derived).update(JSON.stringify(["legacy-bank-import.plan.v1", value.target, value.operator, value.source, version]));
    for (const [id, row] of [...value.rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      hmac.update(JSON.stringify([id, row.source.userSourceDigest, row.source.sourceCreateTime, row.source.sourceUpdateTime, row.name, row.cardNo]));
    }
    return hmac.digest("hex");
  } catch { throw unavailable("LEGACY_BANK_PLAN_KEY_UNAVAILABLE"); } finally { secret?.fill(0); derived?.fill(0); }
}

/** The same target epoch and source row always use the same opaque recovery key. */
export function legacyBankImportRequestId(plan: LegacyBankImportPlan, legacyUserId: string, o: WithdrawalBankBindingOptions): string {
  const value = plans.get(plan), row = value?.rows.get(legacyUserId), version = o.protection?.currentKeyVersion;
  if (!value || !row || !o.protection || typeof version !== "string" || o.database !== value.target.database || o.runtimeUser !== value.target.runtimeUser)
    throw unavailable("LEGACY_BANK_PLAN_UNAVAILABLE");
  let secret: Buffer | undefined, derived: Buffer | undefined;
  try {
    const material = o.protection.keyFor(version); if (!(material instanceof Uint8Array) || material.byteLength !== 32) throw Error();
    secret = Buffer.from(material); derived = createHmac("sha256", secret).update("legacy-bank-import.recovery.key.v1").digest();
    return "bank-import_" + createHmac("sha256", derived).update(JSON.stringify(["legacy-bank-import.recovery.v1", value.target.databaseOid,
      value.target.nonce, value.source.sourceReceiptSha256, value.source.sourceDumpSha256, legacyUserId])).digest("hex").slice(0, 32);
  } catch { throw unavailable("LEGACY_BANK_PLAN_KEY_UNAVAILABLE"); } finally { secret?.fill(0); derived?.fill(0); }
}

/** No plan serialization or source values leave this iterator; caller must not log its keys. */
export function legacyBankImportSubjects(plan: LegacyBankImportPlan): Iterable<string> {
  const value = plans.get(plan); if (!value) throw unavailable("LEGACY_BANK_PLAN_UNAVAILABLE");
  return value.rows.keys();
}

export function releaseLegacyBankImportPlan(plan: LegacyBankImportPlan): void { plans.delete(plan); }

async function assertResource(c: PoolClient, plan: Plan, o: WithdrawalBankBindingOptions): Promise<void> {
  const connection = (c as PoolClient & { connectionParameters?: { host?: string; port?: number; database?: string; user?: string } }).connectionParameters;
  if (c.getTransactionStatus() !== "T" || !connection || connection.host !== "127.0.0.1" || Number(connection.port) !== 55432
    || connection.database !== plan.target.database || connection.user !== plan.target.runtimeUser
    || o.database !== plan.target.database || o.runtimeUser !== plan.target.runtimeUser || process.env.NODE_ENV === "production") throw unavailable("LEGACY_BANK_RESOURCE_MISMATCH");
  const row = (await c.query(`SELECT d.oid::text AS oid,current_database() AS name,current_user AS role,r.oid::text AS role_oid,
    pg_get_userbyid(d.datdba) AS owner,d.datdba::text AS owner_oid,shobj_description(d.oid,'pg_database') AS marker,
    current_setting('zzsh.regression_run',true) AS nonce,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
    to_regclass('zzsh_order.withdrawal_bank_binding') IS NOT NULL AS ready
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  const t = plan.target;
  if (!row || Number(row.oid) !== t.databaseOid || row.name !== t.database || row.role !== t.runtimeUser || Number(row.role_oid) !== t.runtimeRoleOid
    || row.owner !== t.owner || Number(row.owner_oid) !== t.ownerOid || row.marker !== t.marker || row.nonce !== t.nonce || row.ready !== true
    || row.rolsuper !== false || row.rolcreatedb !== false || row.rolcreaterole !== false || row.rolbypassrls !== false) throw unavailable("LEGACY_BANK_RESOURCE_MISMATCH");
  await assertBusinessRuntimeIdentity(c, { database: { name: t.database, user: t.runtimeUser, runtimeUser: t.runtimeUser } });
}

/** Must be called inside a transaction; existing bindings and uncertain identities never get overwritten. */
type ImportStatus = "IMPORTED" | "TARGET_NOT_MATCHED" | "TARGET_NOT_AVAILABLE" | "BINDING_CONFLICT";
export async function importLegacyBankBinding(c: PoolClient, token: LegacyBankImportPlan, legacyUserId: string,
  o: WithdrawalBankBindingOptions, requestId: string): Promise<{ status: ImportStatus; encryptMs: number; encryptStartedAt?: string; encryptFinishedAt?: string }> {
  const plan = plans.get(token), source = plan?.rows.get(legacyUserId);
  if (!plan || !source || requestId !== legacyBankImportRequestId(token, legacyUserId, o)) throw unavailable("LEGACY_BANK_PLAN_UNAVAILABLE");
  await assertResource(c, plan, o);
  await assertAdminCommandAuthorizedInTransaction(c, plan.operator);
  const access = await loadEffectiveAdminAccess(c, plan.operator.userId); requirePermission(access, ADMIN_PERMISSION.financeRead);
  if (!access?.isBoss || access.status !== "ACTIVE" || access.passwordChangeRequired) throw unavailable("LEGACY_BANK_OPERATOR_UNAVAILABLE");
  const userId = legacyOwnerUserId("legacy_mysql_restore", "la_user", legacyUserId);
  const target = (await c.query<{ status: string; matched: string; total: string }>(`SELECT s.account_status AS status,
    (SELECT count(*)::text FROM zzsh_iam.audit_event a WHERE a.object_id=u.id AND a.object_type='user'
      AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS' AND a.details->>'sourceSystem'='legacy_mysql_restore'
      AND a.details->>'sourceEntity'='la_user' AND a.details->>'legacyId'=$2 AND a.details->>'sourceDigest'=$3) AS matched,
    (SELECT count(*)::text FROM zzsh_iam.audit_event a WHERE a.object_id=u.id AND a.object_type='user'
      AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS') AS total
    FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,s`,
  [userId, legacyUserId, source.source.userSourceDigest])).rows[0];
  if (!target || target.matched !== "1" || target.total !== "1") return { status: "TARGET_NOT_MATCHED", encryptMs: 0 };
  if (target.status !== "ACTIVE" && target.status !== "FROZEN") return { status: "TARGET_NOT_AVAILABLE", encryptMs: 0 };
  if ((await c.query("SELECT 1 FROM zzsh_order.withdrawal_bank_binding WHERE user_id=$1", [userId])).rowCount) return { status: "BINDING_CONFLICT", encryptMs: 0 };
  const bindingId = `bank_${randomUUID().replaceAll("-", "")}`, encryptStartedAt = new Date().toISOString(), started = performance.now();
  const prepared = prepareLegacyBankBinding({ name: source.name, cardNo: source.cardNo }, source.source, o, userId, bindingId), encryptMs = performance.now() - started,
    encryptFinishedAt = new Date().toISOString();
  const inserted = await c.query(`INSERT INTO zzsh_order.withdrawal_bank_binding(id,user_id,revision,sealed_details,card_mask,holder_mask)
    VALUES($1,$2,1,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
  [bindingId, userId, prepared.sealedDetails, prepared.cardMask, prepared.holderMask]);
  if (inserted.rowCount !== 1 || inserted.rows[0]?.id !== bindingId) return { status: "BINDING_CONFLICT", encryptMs, encryptStartedAt, encryptFinishedAt };
  await recordAudit(c, { actorType: "admin", actorId: plan.operator.userId, sessionId: plan.operator.sessionId, requestId,
    action: "withdrawal.bank_binding.legacy_imported", objectType: "withdrawal_bank_binding", objectId: bindingId,
    outcome: "SUCCESS", details: prepared.proof });
  return { status: "IMPORTED", encryptMs, encryptStartedAt, encryptFinishedAt };
}

/** Read back the original values and source proof through a separate read-only transaction. */
export async function readbackLegacyBankBinding(c: PoolClient, token: LegacyBankImportPlan, legacyUserId: string,
  o: WithdrawalBankBindingOptions): Promise<boolean> {
  const plan = plans.get(token), source = plan?.rows.get(legacyUserId);
  if (!plan || !source) throw unavailable("LEGACY_BANK_PLAN_UNAVAILABLE");
  await assertResource(c, plan, o);
  if ((await c.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0]?.mode !== "on") throw unavailable("LEGACY_BANK_READBACK_REQUIRES_READ_ONLY");
  const userId = legacyOwnerUserId("legacy_mysql_restore", "la_user", legacyUserId);
  if (!await matchesLegacyBankSource(c, userId, source.source, { name: source.name, cardNo: source.cardNo }, o)) return false;
  return (await c.query(`SELECT 1 FROM zzsh_iam.audit_event a JOIN zzsh_order.withdrawal_bank_binding b ON b.id=a.object_id
    WHERE b.user_id=$2 AND a.object_type='withdrawal_bank_binding' AND a.action='withdrawal.bank_binding.legacy_imported'
      AND a.outcome='SUCCESS' AND a.details->>'revision'=b.revision::text AND a.request_id=$1`,
  [legacyBankImportRequestId(token, legacyUserId, o), userId])).rowCount === 1;
}
