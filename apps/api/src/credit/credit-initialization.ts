import type { PoolClient } from "pg";

import { recordAudit } from "../auth/security-core";
import { invalid } from "../supply/supply-util";
import { ensureCreditAccount } from "./credit-guarantee";

/**
 * Controlled credit initialization batch (E package).
 *
 * The decided rule (docs/architecture/credit-guarantee.md) is that every user has a 100-point INITIALIZED
 * credit state created by migration 0067 or by registration while CREDIT_GUARANTEE_ENABLED=true. Users that
 * exist without a state (created while the module was disabled, or migrated afterwards) stay NOT_INITIALIZED on
 * every GET. This module is the only formal path to close that gap: an explicit, audited, idempotent batch that
 * reuses ensureCreditAccount (ON CONFLICT DO NOTHING + INITIALIZED event). Reads never call it.
 */

export const CREDIT_INITIALIZATION_MAX_BATCH = 500;
const BATCH_KEY = /^credit-init:[A-Za-z0-9._-]{8,96}$/;

export type CreditInitializationPlan = { candidates: string[]; nextAfter: string | null };
export type CreditInitializationResult = {
  batchKey: string;
  dryRun: boolean;
  requested: number;
  applied: string[];
  alreadyInitialized: string[];
};

export async function planCreditInitialization(client: PoolClient, input: { afterUserId?: string | null; limit: number }): Promise<CreditInitializationPlan> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > CREDIT_INITIALIZATION_MAX_BATCH) throw invalid(`limit must be 1..${CREDIT_INITIALIZATION_MAX_BATCH}`);
  const rows = (await client.query<{ id: string }>(
    `SELECT u.id FROM zzsh_auth_user."user" u
       LEFT JOIN zzsh_credit.user_credit_state s ON s.user_id=u.id
      WHERE s.user_id IS NULL AND ($1::text IS NULL OR u.id > $1)
      ORDER BY u.id LIMIT $2`,
    [input.afterUserId ?? null, input.limit],
  )).rows;
  const candidates = rows.map((row) => row.id);
  return { candidates, nextAfter: candidates.length === input.limit ? candidates[candidates.length - 1]! : null };
}

/**
 * Applies one batch inside the caller's transaction. dryRun only re-checks candidates (no writes, no audit).
 * A user that gained a state concurrently is reported as alreadyInitialized, never re-scored.
 */
export async function applyCreditInitializationBatch(client: PoolClient, input: { batchKey: string; userIds: readonly string[]; actorId: string; requestId: string; reason: string; dryRun: boolean }): Promise<CreditInitializationResult> {
  if (!BATCH_KEY.test(input.batchKey)) throw invalid("batchKey must match credit-init:<8-96 safe chars>");
  if (input.userIds.length < 1 || input.userIds.length > CREDIT_INITIALIZATION_MAX_BATCH) throw invalid(`userIds must contain 1..${CREDIT_INITIALIZATION_MAX_BATCH} entries`);
  if (new Set(input.userIds).size !== input.userIds.length) throw invalid("userIds must be unique");
  if (!input.actorId.trim() || !input.reason.trim()) throw invalid("actorId and reason are required");
  const existing = new Set((await client.query<{ userId: string }>(
    `SELECT user_id AS "userId" FROM zzsh_credit.user_credit_state WHERE user_id = ANY($1::text[])`,
    [input.userIds],
  )).rows.map((row) => row.userId));
  const alreadyInitialized = input.userIds.filter((id) => existing.has(id));
  const pending = input.userIds.filter((id) => !existing.has(id));
  if (input.dryRun) return { batchKey: input.batchKey, dryRun: true, requested: input.userIds.length, applied: pending, alreadyInitialized };
  const applied: string[] = [];
  for (const userId of pending) {
    const before = (await client.query(`SELECT 1 FROM zzsh_credit.user_credit_state WHERE user_id=$1`, [userId])).rowCount;
    await ensureCreditAccount(client, userId);
    if (before) alreadyInitialized.push(userId); else applied.push(userId);
  }
  await recordAudit(client, {
    actorType: "system",
    actorId: input.actorId,
    action: "credit.initialization.batch",
    objectType: "credit_initialization_batch",
    objectId: input.batchKey,
    outcome: "SUCCESS",
    requestId: input.requestId,
    reason: input.reason,
    details: { requested: input.userIds.length, applied: applied.length, alreadyInitialized: alreadyInitialized.length },
  });
  return { batchKey: input.batchKey, dryRun: false, requested: input.userIds.length, applied, alreadyInitialized };
}
