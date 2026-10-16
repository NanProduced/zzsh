import type { Pool, PoolClient } from "pg";

import { SecurityApiError, recordAudit, withTransaction } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { canonicalize } from "../supply/content-hash";
import { requireAdminAccess } from "../supply/supply-routes";
import { invalid, sha256Hex, withIdempotency } from "../supply/supply-util";
import { initializeCreditStateIfMissing } from "./credit-guarantee";

/**
 * Controlled credit initialization (E package, decided rule).
 *
 * docs/architecture/credit-guarantee.md:9 and migration 0067 define a 100-point INITIALIZED state for every user.
 * Users created while the module was off still read NOT_INITIALIZED; GET never initializes. This is the only
 * formal path: a maintenance runner that is
 *  - authorized now (ACTIVE Boss admin re-checked inside the transaction, also on replay),
 *  - idempotent on (actor, operation, key) bound to the exact body fingerprint (object set, policy, resource,
 *    input digest, mode) via the existing supply idempotency record; same key + same body replays the original
 *    receipt, same key + different body is 409,
 *  - exact under concurrency: "applied" comes from this call's own INSERT ... RETURNING, users are processed in
 *    sorted order, and existing scores/events are never touched,
 *  - atomic: plan check, inserts, receipt and the audit row share one transaction; any failure rolls back all.
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

export type CreditInitializationInput = {
  actorAdminId: string;
  batchKey: string;
  userIds: readonly string[];
  /** sha256 of the signed execution package (object list export, cutoff, resource registration). */
  inputDigest: string;
  /** Registered isolated resource / window id the leader approved. */
  resourceRef: string;
  reason: string;
  requestId: string;
};

export type CreditInitializationReceipt = {
  batchKey: string;
  operation: typeof CREDIT_INITIALIZATION_OPERATION;
  policy: typeof CREDIT_INITIALIZATION_POLICY;
  fingerprint: string;
  requested: number;
  applied: string[];
  alreadyInitialized: string[];
};

function validated(input: CreditInitializationInput): string[] {
  if (!BATCH_KEY.test(input.batchKey)) throw invalid("batchKey must match credit-init:<8-96 safe chars>");
  if (input.userIds.length < 1 || input.userIds.length > CREDIT_INITIALIZATION_MAX_BATCH) throw invalid(`userIds must contain 1..${CREDIT_INITIALIZATION_MAX_BATCH} entries`);
  if (new Set(input.userIds).size !== input.userIds.length) throw invalid("userIds must be unique");
  if (!DIGEST.test(input.inputDigest)) throw invalid("inputDigest must be a sha256 hex digest");
  if (!input.actorAdminId.trim() || !input.resourceRef.trim() || !input.reason.trim()) throw invalid("actorAdminId, resourceRef and reason are required");
  return [...input.userIds].sort();
}

export function creditInitializationFingerprint(input: CreditInitializationInput): string {
  const userIds = validated(input);
  return sha256Hex(canonicalize({ operation: CREDIT_INITIALIZATION_OPERATION, policy: CREDIT_INITIALIZATION_POLICY, mode: "APPLY", userIds, inputDigest: input.inputDigest, resourceRef: input.resourceRef, reason: input.reason }));
}

async function authorizeNow(client: PoolClient, actorAdminId: string): Promise<void> {
  const access = await requireAdminAccess(client, actorAdminId);
  if (!access.isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Credit initialization requires an active Boss operator");
}

/** Dry run: authorization + exact recheck of the object set; no writes, no receipt, no audit. */
export async function previewCreditInitialization(client: PoolClient, input: CreditInitializationInput): Promise<{ fingerprint: string; wouldApply: string[]; alreadyInitialized: string[] }> {
  const userIds = validated(input);
  await authorizeNow(client, input.actorAdminId);
  const existing = new Set((await client.query<{ userId: string }>(`SELECT user_id AS "userId" FROM zzsh_credit.user_credit_state WHERE user_id = ANY($1::text[])`, [userIds])).rows.map((row) => row.userId));
  return { fingerprint: creditInitializationFingerprint(input), wouldApply: userIds.filter((id) => !existing.has(id)), alreadyInitialized: userIds.filter((id) => existing.has(id)) };
}

/** Apply inside the caller's transaction. Throws (caller must roll back) on any failure, including audit. */
export async function applyCreditInitializationBatch(client: PoolClient, input: CreditInitializationInput): Promise<{ replayed: boolean; receipt: CreditInitializationReceipt }> {
  const userIds = validated(input);
  const fingerprint = creditInitializationFingerprint(input);
  const result = await withIdempotency(
    client,
    { realm: "admin", principalId: input.actorAdminId, operation: CREDIT_INITIALIZATION_OPERATION },
    input.batchKey,
    fingerprint,
    async () => { await authorizeNow(client, input.actorAdminId); },
    async () => {
      const applied: string[] = [];
      const alreadyInitialized: string[] = [];
      for (const userId of userIds) {
        if (await initializeCreditStateIfMissing(client, userId)) applied.push(userId); else alreadyInitialized.push(userId);
      }
      const receipt: CreditInitializationReceipt = { batchKey: input.batchKey, operation: CREDIT_INITIALIZATION_OPERATION, policy: CREDIT_INITIALIZATION_POLICY, fingerprint, requested: userIds.length, applied, alreadyInitialized };
      await recordAudit(client, {
        actorType: "admin",
        actorId: input.actorAdminId,
        action: CREDIT_INITIALIZATION_OPERATION,
        objectType: "credit_initialization_batch",
        objectId: input.batchKey,
        outcome: "SUCCESS",
        requestId: input.requestId,
        reason: input.reason,
        details: { fingerprint, inputDigest: input.inputDigest, resourceRef: input.resourceRef, requested: userIds.length, applied: applied.length, alreadyInitialized: alreadyInitialized.length },
      });
      return { status: 200, body: receipt };
    },
  );
  return { replayed: result.replayed, receipt: result.body as CreditInitializationReceipt };
}

/** Maintenance runner entry: one transaction per batch; rollback on any error. */
export function runCreditInitializationBatch(pool: Pool, input: CreditInitializationInput) {
  return withTransaction(pool, (client) => applyCreditInitializationBatch(client, input));
}
