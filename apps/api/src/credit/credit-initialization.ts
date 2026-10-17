import type { Pool, PoolClient } from "pg";

import { SecurityApiError, recordAudit } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { canonicalize } from "../supply/content-hash";
import { requireAdminAccess } from "../supply/supply-routes";
import { invalid, sha256Hex, withIdempotency } from "../supply/supply-util";
import { initializeCreditStateIfMissing } from "./credit-guarantee";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";
import { assertAdminContextInTransaction } from "../auth/auth-security";

/**
 * Controlled credit initialization (E package, decided rule).
 *
 * docs/architecture/credit-guarantee.md:9 and migration 0067 define a 100-point INITIALIZED state for every user.
 * Users created while the module was off still read NOT_INITIALIZED; GET never initializes. This is the only
 * formal path: a maintenance runner that is
 *  - RUNNER_DRAFT; authorized for the current execution: ACTIVE Boss, approved operator session, DB clock inside the
 *    approved window and live database equal to the approved resource, re-checked in the transaction and on replay,
 *  - idempotent on (actor, operation, key) bound to the exact body fingerprint (object set, category, policy,
 *    intent digest, reason; never the per-window approval) via the existing supply idempotency record; same key + same body replays the original
 *    receipt, same key + different body is 409,
 *  - exact under concurrency: "applied" comes from this call's own INSERT ... RETURNING, users are processed in
 *    sorted order, and existing scores/events are never touched,
 *  - atomic: locked category recheck, inserts, receipt and audit share one transaction. A failure before COMMIT is
 *    NOT_COMMITTED; a failure of COMMIT itself is COMMIT_UNKNOWN and is recovered only by a read-only receipt read.
 * It never unfreezes, restores or re-scores anyone and is not mounted on any HTTP route.
 */

export const CREDIT_INITIALIZATION_OPERATION = "credit.initialization.batch";
export const CREDIT_INITIALIZATION_POLICY = "credit-policy-v1:user-initial-score-100";
export const CREDIT_INITIALIZATION_MAX_BATCH = 500;
const BATCH_KEY = /^credit-init:[A-Za-z0-9._-]{8,96}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type CreditInitializationCategory = "ACTIVE" | "RESTRICTED" | "CANCELLED" | "DEACTIVATED" | "UNKNOWN";
export type CreditInitializationCandidate = { userId: string; category: CreditInitializationCategory };
export type CreditInitializationPlan = { candidates: CreditInitializationCandidate[]; byCategory: Record<CreditInitializationCategory, number>; nextAfter: string | null };

/** Read-only planning: users without a credit state, classified by current account state (never changed here). */
export async function planCreditInitialization(client: PoolClient, input: { afterUserId?: string | null; limit: number }): Promise<CreditInitializationPlan> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > CREDIT_INITIALIZATION_MAX_BATCH) throw invalid(`limit must be 1..${CREDIT_INITIALIZATION_MAX_BATCH}`);
  const rows = (await client.query<{ id: string; category: CreditInitializationCategory }>(
    `SELECT u.id,
            CASE WHEN s.user_id IS NULL THEN 'UNKNOWN'
                 WHEN s.account_status='CANCELLED' THEN 'CANCELLED'
                 WHEN s.account_status='DEACTIVATED' THEN 'DEACTIVATED'
                 WHEN u.suspended THEN 'RESTRICTED'
                 WHEN s.account_status='ACTIVE' THEN 'ACTIVE' ELSE 'UNKNOWN' END AS category
       FROM zzsh_auth_user."user" u
       LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
       LEFT JOIN zzsh_credit.user_credit_state c ON c.user_id=u.id
      WHERE c.user_id IS NULL AND ($1::text IS NULL OR u.id > $1)
      ORDER BY u.id LIMIT $2`,
    [input.afterUserId ?? null, input.limit],
  )).rows;
  const byCategory: Record<CreditInitializationCategory, number> = { ACTIVE: 0, RESTRICTED: 0, CANCELLED: 0, DEACTIVATED: 0, UNKNOWN: 0 };
  for (const row of rows) byCategory[row.category] += 1;
  return { candidates: rows.map((row) => ({ userId: row.id, category: row.category })), byCategory, nextAfter: rows.length === input.limit ? rows[rows.length - 1]!.id : null };
}

/**
 * Stable business intent. Only these fields enter the idempotency fingerprint, so a recovery in a newly
 * approved window (new approvalRef/attempt/window) still presents the original key and body.
 */
export type CreditInitializationIntent = {
  batchKey: string;
  userIds: readonly string[];
  /** The category the leader approved for this window. The first window is ACTIVE only. */
  approvedCategory: "ACTIVE";
  reason: string;
  /** sha256 of the signed business package bytes (object list, category, reason). */
  intentDigest: string;
};

/** Actual resource the approval names; every field is compared with the live connection inside the transaction. */
export type CreditInitializationTestMetadataResource = { databaseName: string; databaseOid: string; owner: string; runtimeRole: string; markerKey: string; markerTarget: string; markerVersion: number };
export type CreditInitializationCommentResource = { databaseName: string; databaseOid: string; owner: string; runtimeRole: string; bindingKind: "DATABASE_COMMENT"; databaseComment: string };
export type CreditInitializationResource = CreditInitializationTestMetadataResource | CreditInitializationCommentResource;

/** The v1 test-table authority and explicitly approved v2 COMMENT authority never fall back to each other. */
export function isCreditInitializationResource(value: unknown): value is CreditInitializationResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string" && Boolean(v.trim()) && !/[\x00-\x1f\x7f]/.test(v);
  const common = ["databaseName", "databaseOid", "owner", "runtimeRole"];
  if (!common.every(k => text(r[k])) || !/^[1-9]\d{0,9}$/.test(r.databaseOid as string) || BigInt(r.databaseOid as string) > 4294967295n) return false;
  const exact = (keys: string[]) => Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k));
  if ("bindingKind" in r) return exact([...common, "bindingKind", "databaseComment"]) && r.bindingKind === "DATABASE_COMMENT" && text(r.databaseComment);
  return exact([...common, "markerKey", "markerTarget", "markerVersion"]) && text(r.markerKey) && text(r.markerTarget) && Number.isSafeInteger(r.markerVersion) && (r.markerVersion as number) >= 1;
}

/** Per-window execution approval. Kept out of the fingerprint. */
export type CreditInitializationExecution = {
  actorAdminId: string;
  actorSessionId: string;
  approvalRef: string;
  attempt: number;
  approvalDigest: string;
  windowStartUtc: string;
  windowEndUtc: string;
  resource: CreditInitializationResource;
};

export type CreditInitializationInput = CreditInitializationIntent & { execution: CreditInitializationExecution; requestId: string };

export type CreditInitializationReceipt = {
  batchKey: string;
  operation: typeof CREDIT_INITIALIZATION_OPERATION;
  policy: typeof CREDIT_INITIALIZATION_POLICY;
  approvedCategory: "ACTIVE";
  fingerprint: string;
  requested: number;
  applied: string[];
  alreadyInitialized: string[];
  /** The execution that produced this receipt (first commit); replays return it unchanged. */
  execution: { approvalRef: string; attempt: number };
};

const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;

function validated(input: CreditInitializationInput): string[] {
  if (!BATCH_KEY.test(input.batchKey)) throw invalid("batchKey must match credit-init:<8-96 safe chars>");
  if (input.userIds.length < 1 || input.userIds.length > CREDIT_INITIALIZATION_MAX_BATCH) throw invalid(`userIds must contain 1..${CREDIT_INITIALIZATION_MAX_BATCH} entries`);
  if (new Set(input.userIds).size !== input.userIds.length) throw invalid("userIds must be unique");
  if (input.approvedCategory !== "ACTIVE") throw invalid("approvedCategory must be ACTIVE for this window");
  if (!DIGEST.test(input.intentDigest)) throw invalid("intentDigest must be a sha256 hex digest");
  if (!input.reason?.trim()) throw invalid("reason is required");
  const e = input.execution;
  if (!e || !e.actorAdminId?.trim() || !e.actorSessionId?.trim() || !REF.test(e.approvalRef ?? "") || !Number.isInteger(e.attempt) || e.attempt < 1 || !DIGEST.test(e.approvalDigest ?? "")) throw invalid("execution approval (actor, session, approvalRef, attempt, approvalDigest) is required");
  if (!UTC.test(e.windowStartUtc ?? "") || !UTC.test(e.windowEndUtc ?? "") || Date.parse(e.windowEndUtc) <= Date.parse(e.windowStartUtc)) throw invalid("execution window must be a valid UTC interval");
  if (!isCreditInitializationResource(e.resource)) throw invalid("execution resource binding is incomplete");
  return [...input.userIds].sort();
}

/** Business fingerprint only: operation, policy, category, object set, intent digest and reason. */
export function creditInitializationFingerprint(input: CreditInitializationInput): string {
  const userIds = validated(input);
  return sha256Hex(canonicalize({ operation: CREDIT_INITIALIZATION_OPERATION, policy: CREDIT_INITIALIZATION_POLICY, mode: "APPLY", approvedCategory: input.approvedCategory, userIds, intentDigest: input.intentDigest, reason: input.reason }));
}

function forbidden(message: string): SecurityApiError { return new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, message); }

/**
 * E-R3-04: the maintenance permit is checked against the database's actual current time (clock_timestamp(), not the
 * transaction-start now()), so time spent waiting for locks or running a long batch counts against the window.
 * Called after authorization locks, after the category locks and immediately before COMMIT.
 */
export async function assertCreditInitializationWindowOpen(client: PoolClient, execution: CreditInitializationExecution): Promise<void> {
  const clock = (await client.query<{ dbNow: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dbNow" /* credit-init-window */`)).rows[0];
  const now = clock ? Date.parse(clock.dbNow) : Number.NaN;
  if (!Number.isFinite(now) || now < Date.parse(execution.windowStartUtc) || now >= Date.parse(execution.windowEndUtc)) throw forbidden("Credit initialization execution window is not open");
}

/**
 * Current-execution authorization: ACTIVE Boss (no new permission), the approved operator session still valid, the
 * DB clock inside the approved window, and the live database equal to the approved resource.
 * E-R3-03: "WRITE" (APPLY) keeps the locking command guard; "READ" (PREVIEW / RECOVER_READ, run in READ ONLY
 * transactions where SELECT FOR UPDATE is not allowed) uses the existing non-locking admin context guard, which checks
 * the same ACTIVE / FROZEN / suspended / session expiry (clock_timestamp) / TOTP / locked conditions.
 */
export async function authorizeCreditInitializationExecution(client: PoolClient, execution: CreditInitializationExecution, mode: "WRITE" | "READ" = "WRITE"): Promise<void> {
  const r = execution.resource;
  if (!isCreditInitializationResource(r)) throw invalid("execution resource binding is incomplete");
  const access = await requireAdminAccess(client, execution.actorAdminId);
  if (!access.isBoss) throw forbidden("Credit initialization requires an active Boss operator");
  if (mode === "WRITE") await assertAdminCommandAuthorizedInTransaction(client, { userId: execution.actorAdminId, sessionId: execution.actorSessionId });
  else await assertAdminContextInTransaction(client, { userId: execution.actorAdminId, sessionId: execution.actorSessionId });
  await assertCreditInitializationWindowOpen(client, execution);
  const commentBinding = "bindingKind" in r;
  const live = (await client.query<{ databaseName: string; databaseOid: string; owner: string; runtimeRole: string; databaseComment?: string | null; markerTarget?: string | null; markerVersion?: number | null }>(
    commentBinding
      ? `SELECT current_database() AS "databaseName", d.oid::text AS "databaseOid", pg_get_userbyid(d.datdba) AS owner, current_user AS "runtimeRole",
            shobj_description(d.oid, 'pg_database') AS "databaseComment" /* credit-init-resource-comment */
       FROM pg_database d WHERE d.datname = current_database()`
      : `SELECT current_database() AS "databaseName", d.oid::text AS "databaseOid", pg_get_userbyid(d.datdba) AS owner, current_user AS "runtimeRole",
            m.target AS "markerTarget", m.marker_version AS "markerVersion" /* credit-init-resource */
       FROM pg_database d LEFT JOIN "zzsh_meta"."database_marker" m ON m.marker_key = $1
      WHERE d.datname = current_database()`, commentBinding ? [] : [r.markerKey])).rows[0];
  if (!live || live.databaseName !== r.databaseName || live.databaseOid !== r.databaseOid || live.owner !== r.owner || live.runtimeRole !== r.runtimeRole
    || (commentBinding ? live.databaseComment !== r.databaseComment : live.markerTarget !== r.markerTarget || live.markerVersion !== r.markerVersion)) throw forbidden("Connected database does not match the approved resource");
}

type CategoryRow = { id: string; category: CreditInitializationCategory };
async function currentCategories(client: PoolClient, userIds: string[], lock: boolean): Promise<CategoryRow[]> {
  if (lock) await client.query(`SELECT user_id FROM zzsh_iam.user_identity_state WHERE user_id = ANY($1::text[]) ORDER BY user_id FOR SHARE`, [userIds]);
  return (await client.query<CategoryRow>(
    `SELECT u.id,
            CASE WHEN s.user_id IS NULL THEN 'UNKNOWN'
                 WHEN s.account_status='CANCELLED' THEN 'CANCELLED'
                 WHEN s.account_status='DEACTIVATED' THEN 'DEACTIVATED'
                 WHEN u.suspended THEN 'RESTRICTED'
                 WHEN s.account_status='ACTIVE' THEN 'ACTIVE' ELSE 'UNKNOWN' END AS category
       FROM zzsh_auth_user."user" u
       LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
      WHERE u.id = ANY($1::text[]) /* credit-init-category */
      ORDER BY u.id${lock ? " FOR SHARE OF u" : ""}`, [userIds])).rows;
}

function categoryMismatch(userIds: string[], rows: CategoryRow[], approved: CreditInitializationCategory): { userId: string; category: CreditInitializationCategory | "MISSING" }[] {
  const byId = new Map(rows.map((row) => [row.id, row.category]));
  return userIds.map((userId) => ({ userId, category: byId.get(userId) ?? "MISSING" as const })).filter((row) => row.category !== approved);
}

/** Dry run: current execution authorization + unlocked category recheck; no writes, no receipt, no audit. */
export async function previewCreditInitialization(client: PoolClient, input: CreditInitializationInput): Promise<{ fingerprint: string; wouldApply: string[]; alreadyInitialized: string[]; outsideApprovedCategory: { userId: string; category: string }[] }> {
  const userIds = validated(input);
  await authorizeCreditInitializationExecution(client, input.execution, "READ");
  const outside = categoryMismatch(userIds, await currentCategories(client, userIds, false), input.approvedCategory);
  const existing = new Set((await client.query<{ userId: string }>(`SELECT user_id AS "userId" FROM zzsh_credit.user_credit_state WHERE user_id = ANY($1::text[])`, [userIds])).rows.map((row) => row.userId));
  return { fingerprint: creditInitializationFingerprint(input), wouldApply: userIds.filter((id) => !existing.has(id)), alreadyInitialized: userIds.filter((id) => existing.has(id)), outsideApprovedCategory: outside };
}

/**
 * Apply inside the caller's transaction. Fresh apply locks and rechecks the approved object set and category
 * (any drift rejects the whole batch); a successful original receipt replays after current execution
 * authorization and the original fingerprint only, without re-running business preconditions.
 */
export async function applyCreditInitializationBatch(client: PoolClient, input: CreditInitializationInput): Promise<{ replayed: boolean; receipt: CreditInitializationReceipt }> {
  const userIds = validated(input);
  const fingerprint = creditInitializationFingerprint(input);
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: input.execution.actorAdminId, operation: CREDIT_INITIALIZATION_OPERATION },
    input.batchKey,
    fingerprint,
    async () => { await authorizeCreditInitializationExecution(client, input.execution); },
    async () => {
      const outside = categoryMismatch(userIds, await currentCategories(client, userIds, true), input.approvedCategory);
      if (outside.length) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, `Approved object set changed: ${outside.length} user(s) are no longer ${input.approvedCategory}`);
      await assertCreditInitializationWindowOpen(client, input.execution); // after the object locks, before any write
      const applied: string[] = [];
      const alreadyInitialized: string[] = [];
      for (const userId of userIds) {
        if (await initializeCreditStateIfMissing(client, userId)) applied.push(userId); else alreadyInitialized.push(userId);
      }
      const receipt: CreditInitializationReceipt = { batchKey: input.batchKey, operation: CREDIT_INITIALIZATION_OPERATION, policy: CREDIT_INITIALIZATION_POLICY, approvedCategory: input.approvedCategory, fingerprint, requested: userIds.length, applied, alreadyInitialized, execution: { approvalRef: input.execution.approvalRef, attempt: input.execution.attempt } };
      await recordAudit(client, {
        actorType: "admin",
        actorId: input.execution.actorAdminId,
        action: CREDIT_INITIALIZATION_OPERATION,
        objectType: "credit_initialization_batch",
        objectId: input.batchKey,
        outcome: "SUCCESS",
        requestId: input.requestId,
        reason: input.reason,
        details: { fingerprint, intentDigest: input.intentDigest, approvedCategory: input.approvedCategory, approvalRef: input.execution.approvalRef, attempt: input.execution.attempt, approvalDigest: input.execution.approvalDigest, databaseName: input.execution.resource.databaseName, requested: userIds.length, applied: applied.length, alreadyInitialized: alreadyInitialized.length },
      });
      return { status: 200, body: receipt };
    },
  );
  return { replayed: result.replayed, receipt: result.body as CreditInitializationReceipt };
}

/** Read-only recovery: current execution authorization, then the original receipt by (actor, key); never writes. */
export async function readCreditInitializationReceipt(client: PoolClient, input: CreditInitializationInput): Promise<{ state: "FOUND"; receipt: CreditInitializationReceipt } | { state: "NOT_FOUND" } | { state: "FINGERPRINT_MISMATCH" }> {
  validated(input);
  const fingerprint = creditInitializationFingerprint(input);
  await authorizeCreditInitializationExecution(client, input.execution, "READ");
  const scopeKey = JSON.stringify(["admin", input.execution.actorAdminId, CREDIT_INITIALIZATION_OPERATION, null]);
  const row = (await client.query<{ requestFingerprint: string; responseBody: unknown }>(`SELECT "request_fingerprint" AS "requestFingerprint", "response_body" AS "responseBody" FROM "zzsh_supply"."idempotency_record" WHERE "scope_key" = $1 AND "key" = $2 /* credit-init-recover */`, [scopeKey, input.batchKey])).rows[0];
  if (!row) return { state: "NOT_FOUND" };
  if (row.requestFingerprint !== fingerprint) return { state: "FINGERPRINT_MISMATCH" };
  return { state: "FOUND", receipt: row.responseBody as CreditInitializationReceipt };
}

export type CreditInitializationPreserved = { actorAdminId: string; batchKey: string; fingerprint: string; intentDigest: string; approvalRef: string; attempt: number };

/** NOT_COMMITTED: COMMIT was never sent, so nothing of this attempt can be durable. COMMIT_UNKNOWN: COMMIT was sent and its outcome is not known. */
export class CreditInitializationOutcomeError extends Error {
  constructor(readonly outcome: "NOT_COMMITTED" | "COMMIT_UNKNOWN", readonly preserved: CreditInitializationPreserved, readonly rollbackAcknowledged: boolean, readonly cause: unknown) {
    super(outcome === "NOT_COMMITTED" ? "Credit initialization was not committed (COMMIT was never sent)" : "Credit initialization COMMIT outcome is UNKNOWN; recover by reading the original receipt in a newly approved window");
    this.name = "CreditInitializationOutcomeError";
  }
}

function preservedOf(input: CreditInitializationInput): CreditInitializationPreserved {
  return { actorAdminId: input.execution.actorAdminId, batchKey: input.batchKey, fingerprint: creditInitializationFingerprint(input), intentDigest: input.intentDigest, approvalRef: input.execution.approvalRef, attempt: input.execution.attempt };
}

/**
 * Maintenance runner entry: one transaction per batch. Distinguishes "never committed" from "COMMIT sent, outcome
 * unknown". After a COMMIT failure no ROLLBACK is sent and the connection is discarded; a later ROLLBACK ACK would
 * not prove anything about an already committed transaction.
 */
export async function runCreditInitializationBatch(pool: Pool, input: CreditInitializationInput): Promise<{ replayed: boolean; receipt: CreditInitializationReceipt }> {
  const preserved = preservedOf(input);
  const client = await pool.connect();
  let commitSent = false;
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await applyCreditInitializationBatch(client, input);
    await assertCreditInitializationWindowOpen(client, input.execution); // expired permit: never send COMMIT
    commitSent = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (commitSent) { broken = true; throw new CreditInitializationOutcomeError("COMMIT_UNKNOWN", preserved, false, error); }
    let rolledBack = false;
    try { await client.query("ROLLBACK"); rolledBack = true; } catch { broken = true; }
    throw new CreditInitializationOutcomeError("NOT_COMMITTED", preserved, rolledBack, error);
  } finally {
    client.release(broken ? true : undefined);
  }
}

/** Read-only transaction for preview and receipt recovery. */
export async function withReadOnlyTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await callback(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* read-only: nothing durable either way */ }
    throw error;
  } finally {
    client.release();
  }
}
