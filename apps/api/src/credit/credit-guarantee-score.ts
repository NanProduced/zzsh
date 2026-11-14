import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { gameScopeSql } from "../auth/admin-scope";
import { SecurityApiError } from "../auth/security-core";
import type { UserObligationReader } from "../auth/user-identity";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { conflict, fingerprintRequest, invalid, notFound, withIdempotency } from "../supply/supply-util";
import { CREDIT_BREACH_DELTA, CREDIT_INITIAL_SCORE, CREDIT_RECOVERY_DELTA, hash, ID, id, reason } from "./credit-guarantee-internals";

export type CreditEventType = "INITIALIZED" | "BREACH_CONFIRMED" | "BREACH_REVERSED" | "RECOVERY_APPROVED" | "MANUAL_DEDUCTION" | "MANUAL_DEDUCTION_REVERSED";
export type CreditSubjectRole = "OWNER" | "RENTER";

export type CreditEvent = {
  id: string;
  userId: string;
  eventKey: string;
  eventType: CreditEventType;
  sourceType: string;
  sourceId: string;
  subjectRole: CreditSubjectRole | null;
  deltaScore: number;
  appliedDeltaScore: number;
  scoreBefore: number;
  scoreAfter: number;
  visibleReason: string;
  internalBasis?: string;
  actorAdminId?: string | null;
  actorAdminName?: string | null;
  reversalOfId?: string | null;
  reversed?: boolean;
  createdAt: string;
};

export type CreditSnapshot = {
  userId: string;
  score: number;
  revision: string;
  initializedAt: string;
  events: CreditEvent[];
};

type CreditStateRow = { userId: string; score: number; revision: string; initializedAt: string };
type CreditEventRow = CreditEvent & { payloadHash: string; reversed: boolean };

function rowEvent(row: CreditEventRow): CreditEvent {
  return {
    id: row.id,
    userId: row.userId,
    eventKey: row.eventKey,
    eventType: row.eventType,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    subjectRole: row.subjectRole,
    deltaScore: row.deltaScore,
    appliedDeltaScore: row.appliedDeltaScore,
    scoreBefore: row.scoreBefore,
    scoreAfter: row.scoreAfter,
    visibleReason: row.visibleReason,
    ...(row.internalBasis === undefined ? {} : { internalBasis: row.internalBasis }),
    actorAdminId: row.actorAdminId,
    ...(row.actorAdminName ? {actorAdminName:row.actorAdminName} : {}),
    reversalOfId: row.reversalOfId,
    reversed: row.reversed,
    createdAt: row.createdAt,
  };
}

async function userExists(client: PoolClient, userId: string): Promise<void> {
  if (!(await client.query(`SELECT 1 FROM zzsh_auth_user."user" WHERE id=$1`, [userId])).rowCount) throw notFound();
}

/**
 * Creates the decided initial state (100 + INITIALIZED event) only when absent. Returns the row this call
 * actually inserted, or null when another transaction/earlier run already created it; never re-scores.
 */
export async function initializeCreditStateIfMissing(client: PoolClient, userId: string): Promise<CreditStateRow | null> {
  id(userId, "userId");
  await userExists(client, userId);
  const inserted = (await client.query<CreditStateRow>(
    `INSERT INTO zzsh_credit.user_credit_state(user_id,score,revision)
     VALUES($1,100,1)
     ON CONFLICT(user_id) DO NOTHING
     RETURNING user_id AS "userId",score,revision::text,initialized_at AS "initializedAt"`,
    [userId],
  )).rows[0];
  if (inserted) {
    await client.query(
      `INSERT INTO zzsh_credit.credit_event
       (id,user_id,event_key,event_type,source_type,source_id,delta_score,applied_delta_score,score_before,score_after,visible_reason,internal_basis,actor_admin_id,payload_hash)
       VALUES($1,$2,$3,'INITIALIZED','SYSTEM',$2,0,0,100,100,$4,$5,NULL,$6)`,
      [
        `credit_evt_${randomUUID().replaceAll("-", "")}`,
        userId,
        `initial:${userId}`,
        "新制度建立初始信用分",
        "credit-policy-v1:user-initial-score-100",
        hash(["INITIALIZED", userId, CREDIT_INITIAL_SCORE]),
      ],
    );
    return inserted;
  }
  return null;
}

export async function ensureCreditAccount(client: PoolClient, userId: string): Promise<CreditStateRow> {
  const inserted = await initializeCreditStateIfMissing(client, userId);
  if (inserted) return inserted;
  const row = (await client.query<CreditStateRow>(
    `SELECT user_id AS "userId",score,revision::text,initialized_at AS "initializedAt"
       FROM zzsh_credit.user_credit_state WHERE user_id=$1 FOR UPDATE`,
    [userId],
  )).rows[0];
  if (!row) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Credit state is unavailable");
  return row;
}

export type CreditReadScope = { adminId: string; isBoss: boolean };
export async function readCreditSnapshot(client: PoolClient, userId: string, initialize = false, scope?: CreditReadScope): Promise<CreditSnapshot | null> {
  const state = initialize
    ? await ensureCreditAccount(client, userId)
    : (await client.query<CreditStateRow>(
      `SELECT user_id AS "userId",score,revision::text,initialized_at AS "initializedAt"
         FROM zzsh_credit.user_credit_state WHERE user_id=$1`,
      [userId],
    )).rows[0];
  if (!state) return null;
  const events = (await client.query<CreditEventRow>(
    `SELECT e.id,e.user_id AS "userId",e.event_key AS "eventKey",e.event_type AS "eventType",
            e.source_type AS "sourceType",e.source_id AS "sourceId",e.subject_role AS "subjectRole",
            e.delta_score AS "deltaScore",e.applied_delta_score AS "appliedDeltaScore",
            e.score_before AS "scoreBefore",e.score_after AS "scoreAfter",e.visible_reason AS "visibleReason",
            e.internal_basis AS "internalBasis",e.actor_admin_id AS "actorAdminId",CASE WHEN $2::boolean IS NOT NULL THEN actor.name END AS "actorAdminName",e.reversal_of_id AS "reversalOfId",
            e.payload_hash AS "payloadHash",e.created_at::text AS "createdAt",
            EXISTS(SELECT 1 FROM zzsh_credit.credit_event r WHERE r.reversal_of_id=e.id) AS reversed
       FROM zzsh_credit.credit_event e LEFT JOIN zzsh_auth_admin."user" actor ON actor.id=e.actor_admin_id WHERE e.user_id=$1
         AND ($2::boolean IS NULL OR e.source_type NOT IN ('ACCOUNT','ORDER') OR $2::boolean OR
           (e.source_type='ACCOUNT' AND EXISTS (SELECT 1 FROM zzsh_supply.rental_account a WHERE a.id=e.source_id AND ${gameScopeSql("a.game_id","$3","$2")})) OR
           (e.source_type='ORDER' AND EXISTS (SELECT 1 FROM zzsh_order.rental_order o WHERE o.id=e.source_id AND ${gameScopeSql("o.game_id","$3","$2")})))
       ORDER BY e.created_at DESC,e.id DESC`,
    [userId, scope ? scope.isBoss : null, scope?.adminId ?? null],
  )).rows;
  return { userId: state.userId, score: state.score, revision: state.revision, initializedAt: state.initializedAt, events: events.map(rowEvent) };
}

async function lockCreditAccount(client: PoolClient, userId: string, initialize = true): Promise<CreditStateRow> {
  // Credit events reference the user. Take that lock before the credit row, as publishing does.
  if (!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR KEY SHARE`, [userId])).rowCount) throw notFound();
  if (initialize) await ensureCreditAccount(client, userId);
  await client.query(`SELECT set_config('zzsh.credit_mutation','1',true)`);
  const row = (await client.query<CreditStateRow>(
    `SELECT user_id AS "userId",score,revision::text,initialized_at AS "initializedAt"
       FROM zzsh_credit.user_credit_state WHERE user_id=$1 FOR UPDATE`,
    [userId],
  )).rows[0];
  if (!row) {
    if (!initialize) throw conflict("该用户的信用分尚未初始化，暂不能进行信用操作");
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Credit state is unavailable");
  }
  return row;
}

function clippedScore(score: number, delta: number): { score: number; applied: number } {
  const next = Math.max(0, Math.min(100, score + delta));
  return { score: next, applied: next - score };
}

type ManualCreditInput = {
  userId: string;
  actorAdminId: string;
  expectedRevision: string;
  visibleReason: string;
} & ({ kind: "DEDUCT"; amount: number } | { kind: "REVERSE"; eventId: string });

export async function writeManualCreditAdjustment(client: PoolClient, input: ManualCreditInput, idempotencyKey: string) {
  const userId = id(input.userId, "userId");
  const actorAdminId = id(input.actorAdminId, "actorAdminId");
  const visibleReason = reason(input.visibleReason, "visibleReason");
  if (typeof input.expectedRevision !== "string" || !/^[1-9]\d{0,18}$/.test(input.expectedRevision) || BigInt(input.expectedRevision) > 9223372036854775807n) throw invalid("Credit revision is invalid");
  const key = validateIdempotencyKey(idempotencyKey);
  if (input.kind !== "DEDUCT" && input.kind !== "REVERSE") throw invalid("Credit action is invalid");
  if (input.kind === "DEDUCT" && (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > 100)) throw invalid("扣分数量须为 1 至 100 的整数");
  const eventId = input.kind === "REVERSE" ? id(input.eventId, "eventId") : null;
  const operation = input.kind === "DEDUCT" ? "credit.manual.deduct" : "credit.manual.reverse";
  const payload = { expectedRevision: input.expectedRevision, visibleReason, ...(input.kind === "DEDUCT" ? { amount: input.amount } : { eventId }) };
  return withIdempotency(client, { realm: "admin", principalId: actorAdminId, operation, resourceId: userId }, key,
    fingerprintRequest(operation, userId, payload), async () => undefined, async () => {
      // Replays resolve before CAS; a new command must never invent an initial score.
      const state = await lockCreditAccount(client, userId, false);
      if (state.revision !== input.expectedRevision) throw conflict("信用分已变化，请刷新后重试");
      let delta: number;
      if (input.kind === "DEDUCT") {
        if (input.amount > state.score) throw conflict("扣分数量不能超过当前信用分");
        delta = -input.amount;
      } else {
        const original = (await client.query<{ appliedDeltaScore: number; reversed: boolean }>(
          `SELECT e.applied_delta_score AS "appliedDeltaScore",
                  EXISTS(SELECT 1 FROM zzsh_credit.credit_event r WHERE r.reversal_of_id=e.id) AS reversed
             FROM zzsh_credit.credit_event e WHERE e.id=$1 AND e.user_id=$2
              AND e.event_type='MANUAL_DEDUCTION' AND e.source_type='USER_MANUAL' AND e.source_id=$2`,
          [eventId, userId],
        )).rows[0];
        if (!original) throw notFound();
        if (original.reversed) throw conflict("这笔扣分已更正，请刷新后查看");
        delta = -original.appliedDeltaScore;
      }
      const applied = clippedScore(state.score, delta);
      const eventType = input.kind === "DEDUCT" ? "MANUAL_DEDUCTION" : "MANUAL_DEDUCTION_REVERSED";
      const eventKey = input.kind === "DEDUCT" ? `manual:${hash([actorAdminId, key])}` : `manual-reverse:${eventId}`;
      const payloadHash = hash([eventKey, payload]);
      const event = (await client.query<CreditEventRow>(
        `INSERT INTO zzsh_credit.credit_event
          (id,user_id,event_key,event_type,source_type,source_id,subject_role,delta_score,applied_delta_score,score_before,score_after,visible_reason,internal_basis,actor_admin_id,reversal_of_id,payload_hash)
         VALUES($1,$2,$3,$4,'USER_MANUAL',$2,NULL,$5,$6,$7,$8,$9,'credit-policy-v1:user-manual',$10,$11,$12)
         RETURNING id,user_id AS "userId",event_key AS "eventKey",event_type AS "eventType",source_type AS "sourceType",source_id AS "sourceId",subject_role AS "subjectRole",delta_score AS "deltaScore",applied_delta_score AS "appliedDeltaScore",score_before AS "scoreBefore",score_after AS "scoreAfter",visible_reason AS "visibleReason",internal_basis AS "internalBasis",actor_admin_id AS "actorAdminId",reversal_of_id AS "reversalOfId",payload_hash AS "payloadHash",created_at::text AS "createdAt",false AS reversed`,
        [`credit_evt_${randomUUID().replaceAll("-", "")}`, userId, eventKey, eventType, delta, applied.applied, state.score, applied.score, visibleReason, actorAdminId, eventId, payloadHash],
      )).rows[0];
      if (!event) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Credit event was not recorded");
      await client.query(`UPDATE zzsh_credit.user_credit_state SET score=$2,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1`, [userId, applied.score]);
      return { status: 200, body: { event: rowEvent(event), duplicate: false } };
    });
}

async function assertBreachSubject(client: PoolClient, userId: string, sourceType: string, sourceId: string, role: CreditSubjectRole): Promise<void> {
  if (sourceType === "ORDER") {
    const row = (await client.query<{ ownerUserId: string; renterUserId: string }>(
      `SELECT owner_user_id AS "ownerUserId",renter_user_id AS "renterUserId" FROM zzsh_order.rental_order WHERE id=$1`,
      [sourceId],
    )).rows[0];
    if (!row || (role === "OWNER" ? row.ownerUserId : row.renterUserId) !== userId) throw notFound();
    return;
  }
  if (sourceType === "ACCOUNT") {
    const row = (await client.query<{ ownerUserId: string }>(`SELECT owner_user_id AS "ownerUserId" FROM zzsh_supply.rental_account WHERE id=$1`, [sourceId])).rows[0];
    if (!row || row.ownerUserId !== userId || role !== "OWNER") throw notFound();
    return;
  }
  throw invalid("Unsupported credit event source");
}

export async function confirmBreach(client: PoolClient, input: {
  userId: string;
  sourceType: string;
  sourceId: string;
  subjectRole: CreditSubjectRole;
  visibleReason: string;
  internalBasis: string;
  actorAdminId: string;
}): Promise<{ event: CreditEvent; duplicate: boolean }> {
  const userId = id(input.userId, "userId");
  const sourceType = id(input.sourceType, "sourceType");
  const sourceId = id(input.sourceId, "sourceId");
  const visibleReason = reason(input.visibleReason, "visibleReason");
  const internalBasis = reason(input.internalBasis, "internalBasis");
  if (!ID.test(input.actorAdminId) || !["OWNER", "RENTER"].includes(input.subjectRole)) throw invalid("Credit actor or role is invalid");
  // Reversal and recovery also lock the subject credit state before source events.
  const state = await lockCreditAccount(client, userId);
  await assertBreachSubject(client, userId, sourceType, sourceId, input.subjectRole);
  const eventKey = `breach:${sourceType}:${sourceId}:${userId}:${input.subjectRole}`;
  const payloadHash = hash([eventKey, visibleReason, internalBasis]);
  const existing = (await client.query<CreditEventRow>(
    `SELECT e.id,e.user_id AS "userId",e.event_key AS "eventKey",e.event_type AS "eventType",e.source_type AS "sourceType",e.source_id AS "sourceId",e.subject_role AS "subjectRole",e.delta_score AS "deltaScore",e.applied_delta_score AS "appliedDeltaScore",e.score_before AS "scoreBefore",e.score_after AS "scoreAfter",e.visible_reason AS "visibleReason",e.internal_basis AS "internalBasis",e.actor_admin_id AS "actorAdminId",e.reversal_of_id AS "reversalOfId",e.payload_hash AS "payloadHash",e.created_at::text AS "createdAt",EXISTS(SELECT 1 FROM zzsh_credit.credit_event r WHERE r.reversal_of_id=e.id) AS reversed
       FROM zzsh_credit.credit_event e WHERE e.user_id=$1 AND e.event_key=$2`,
    [userId, eventKey],
  )).rows[0];
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw conflict("The credit event key is already bound to different evidence");
    return { event: rowEvent(existing), duplicate: true };
  }
  const applied = clippedScore(state.score, CREDIT_BREACH_DELTA);
  const event = (await client.query<CreditEventRow>(
    `INSERT INTO zzsh_credit.credit_event
      (id,user_id,event_key,event_type,source_type,source_id,subject_role,delta_score,applied_delta_score,score_before,score_after,visible_reason,internal_basis,actor_admin_id,payload_hash)
     VALUES($1,$2,$3,'BREACH_CONFIRMED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id,user_id AS "userId",event_key AS "eventKey",event_type AS "eventType",source_type AS "sourceType",source_id AS "sourceId",subject_role AS "subjectRole",delta_score AS "deltaScore",applied_delta_score AS "appliedDeltaScore",score_before AS "scoreBefore",score_after AS "scoreAfter",visible_reason AS "visibleReason",internal_basis AS "internalBasis",actor_admin_id AS "actorAdminId",reversal_of_id AS "reversalOfId",payload_hash AS "payloadHash",created_at::text AS "createdAt",false AS reversed`,
    [`credit_evt_${randomUUID().replaceAll("-", "")}`, userId, eventKey, sourceType, sourceId, input.subjectRole, CREDIT_BREACH_DELTA, applied.applied, state.score, applied.score, visibleReason, internalBasis, input.actorAdminId, payloadHash],
  )).rows[0];
  await client.query(`UPDATE zzsh_credit.user_credit_state SET score=$2,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1`, [userId, applied.score]);
  if (!event) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Credit event was not recorded");
  return { event: rowEvent(event), duplicate: false };
}

export async function reverseBreach(client: PoolClient, input: { eventId: string; visibleReason: string; internalBasis: string; actorAdminId: string }): Promise<{ event: CreditEvent; duplicate: boolean }> {
  const eventId = id(input.eventId, "eventId");
  const visibleReason = reason(input.visibleReason, "visibleReason");
  const internalBasis = reason(input.internalBasis, "internalBasis");
  if (!ID.test(input.actorAdminId)) throw invalid("Credit actor is invalid");
  const hint = (await client.query<{ userId: string }>(`SELECT user_id AS "userId" FROM zzsh_credit.credit_event WHERE id=$1 AND event_type='BREACH_CONFIRMED'`, [eventId])).rows[0];
  if (!hint) throw notFound();
  const state = await lockCreditAccount(client, hint.userId);
  const original = (await client.query<CreditEventRow>(
    `SELECT e.id,e.user_id AS "userId",e.event_key AS "eventKey",e.event_type AS "eventType",e.source_type AS "sourceType",e.source_id AS "sourceId",e.subject_role AS "subjectRole",e.delta_score AS "deltaScore",e.applied_delta_score AS "appliedDeltaScore",e.score_before AS "scoreBefore",e.score_after AS "scoreAfter",e.visible_reason AS "visibleReason",e.internal_basis AS "internalBasis",e.actor_admin_id AS "actorAdminId",e.reversal_of_id AS "reversalOfId",e.payload_hash AS "payloadHash",e.created_at::text AS "createdAt",EXISTS(SELECT 1 FROM zzsh_credit.credit_event r WHERE r.reversal_of_id=e.id) AS reversed
       FROM zzsh_credit.credit_event e WHERE e.id=$1 AND e.user_id=$2 AND e.event_type='BREACH_CONFIRMED'`,
    [eventId, hint.userId],
  )).rows[0];
  if (!original) throw notFound();
  const eventKey = `reverse:${eventId}`;
  const payloadHash = hash([eventKey, visibleReason, internalBasis]);
  const existing = (await client.query<CreditEventRow>(
    `SELECT e.id,e.user_id AS "userId",e.event_key AS "eventKey",e.event_type AS "eventType",e.source_type AS "sourceType",e.source_id AS "sourceId",e.subject_role AS "subjectRole",e.delta_score AS "deltaScore",e.applied_delta_score AS "appliedDeltaScore",e.score_before AS "scoreBefore",e.score_after AS "scoreAfter",e.visible_reason AS "visibleReason",e.internal_basis AS "internalBasis",e.actor_admin_id AS "actorAdminId",e.reversal_of_id AS "reversalOfId",e.payload_hash AS "payloadHash",e.created_at::text AS "createdAt",true AS reversed
       FROM zzsh_credit.credit_event e WHERE e.reversal_of_id=$1`,
    [eventId],
  )).rows[0];
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw conflict("The credit reversal is already bound to different evidence");
    return { event: rowEvent(existing), duplicate: true };
  }
  // Reverse only the delta that actually lowered the score.  A breach at 0
  // has an applied delta of 0 and must not mint ten points later.
  const reversalDelta = -original.appliedDeltaScore;
  const applied = clippedScore(state.score, reversalDelta);
  const event = (await client.query<CreditEventRow>(
    `INSERT INTO zzsh_credit.credit_event
      (id,user_id,event_key,event_type,source_type,source_id,subject_role,delta_score,applied_delta_score,score_before,score_after,visible_reason,internal_basis,actor_admin_id,reversal_of_id,payload_hash)
     VALUES($1,$2,$3,'BREACH_REVERSED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id,user_id AS "userId",event_key AS "eventKey",event_type AS "eventType",source_type AS "sourceType",source_id AS "sourceId",subject_role AS "subjectRole",delta_score AS "deltaScore",applied_delta_score AS "appliedDeltaScore",score_before AS "scoreBefore",score_after AS "scoreAfter",visible_reason AS "visibleReason",internal_basis AS "internalBasis",actor_admin_id AS "actorAdminId",reversal_of_id AS "reversalOfId",payload_hash AS "payloadHash",created_at::text AS "createdAt",true AS reversed`,
    [`credit_evt_${randomUUID().replaceAll("-", "")}`, original.userId, eventKey, original.sourceType, original.sourceId, original.subjectRole, reversalDelta, applied.applied, state.score, applied.score, visibleReason, internalBasis, input.actorAdminId, eventId, payloadHash],
  )).rows[0];
  await client.query(`UPDATE zzsh_credit.user_credit_state SET score=$2,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1`, [original.userId, applied.score]);
  if (!event) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Credit reversal was not recorded");
  return { event: rowEvent(event), duplicate: false };
}

export type RecoveryEligibility = { eligible: boolean; score: number; completedOrders: string; obligation: "NONE" | "PENDING" | "UNKNOWN"; reasons: string[] };

export async function recoveryEligibility(client: PoolClient, userId: string, obligationReader: UserObligationReader, state?: CreditStateRow, excludeRequestId?: string): Promise<RecoveryEligibility> {
  const current = state ?? await lockCreditAccount(client, userId);
  const reasons: string[] = [];
  if (current.score >= 100) reasons.push("SCORE_ALREADY_MAX");
  const recentBreach = (await client.query(`SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=$1 AND e.event_type IN ('BREACH_CONFIRMED','MANUAL_DEDUCTION') AND e.created_at>clock_timestamp()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM zzsh_credit.credit_event r WHERE r.reversal_of_id=e.id) LIMIT 1`, [userId])).rowCount;
  if (recentBreach) reasons.push("RECENT_CONFIRMED_BREACH");
  const completed = (await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE status='COMPLETED' AND (owner_user_id=$1 OR renter_user_id=$1) AND updated_at>clock_timestamp()-interval '7 days'`, [userId])).rows[0]?.count ?? "0";
  if (completed === "0") reasons.push("NO_COMPLETED_ORDER");
  const obligation = await obligationReader(userId, client);
  if (obligation !== "NONE") reasons.push(obligation === "UNKNOWN" ? "OBLIGATION_UNKNOWN" : "UNPROCESSED_OBLIGATION");
  const recentRequest = (await client.query(`SELECT 1 FROM zzsh_credit.credit_recovery_request WHERE user_id=$1 AND created_at>clock_timestamp()-interval '7 days' AND ($2::text IS NULL OR id<>$2) LIMIT 1`, [userId, excludeRequestId ?? null])).rowCount;
  if (recentRequest) reasons.push("RECOVERY_RATE_LIMITED");
  return { eligible: reasons.length === 0, score: current.score, completedOrders: completed, obligation, reasons };
}

export async function requestRecovery(client: PoolClient, input: { userId: string; requestKey: string; requestFingerprint: string; reason: string; obligationReader: UserObligationReader }): Promise<Record<string, unknown>> {
  const userId = id(input.userId, "userId");
  const requestKey = id(input.requestKey, "requestKey");
  const requestReason = reason(input.reason, "reason");
  const existing = (await client.query(`SELECT id,request_fingerprint AS "requestFingerprint",status,created_at AS "createdAt" FROM zzsh_credit.credit_recovery_request WHERE user_id=$1 AND request_key=$2`, [userId, requestKey])).rows[0];
  if (existing) {
    if (existing.requestFingerprint !== input.requestFingerprint) throw conflict("Recovery request key is already bound to different evidence");
    return { requestId: existing.id, status: existing.status, createdAt: existing.createdAt, duplicate: true };
  }
  const state = await lockCreditAccount(client, userId);
  const replayAfterLock = (await client.query(`SELECT id,request_fingerprint AS "requestFingerprint",status,created_at AS "createdAt" FROM zzsh_credit.credit_recovery_request WHERE user_id=$1 AND request_key=$2`, [userId, requestKey])).rows[0];
  if (replayAfterLock) {
    if (replayAfterLock.requestFingerprint !== input.requestFingerprint) throw conflict("Recovery request key is already bound to different evidence");
    return { requestId: replayAfterLock.id, status: replayAfterLock.status, createdAt: replayAfterLock.createdAt, duplicate: true };
  }
  const eligibility = await recoveryEligibility(client, userId, input.obligationReader, state);
  if (!eligibility.eligible) throw conflict(`Credit recovery is not eligible: ${eligibility.reasons.join(",")}`);
  const idValue = `credit_recovery_${randomUUID().replaceAll("-", "")}`;
  const row = (await client.query(`INSERT INTO zzsh_credit.credit_recovery_request(id,user_id,request_key,request_fingerprint,reason,status,eligibility_snapshot,score_before,completed_orders) VALUES($1,$2,$3,$4,$5,'PENDING',$6::jsonb,$7,$8) ON CONFLICT(user_id,request_key) DO NOTHING RETURNING id,status,created_at AS "createdAt"`, [idValue, userId, requestKey, input.requestFingerprint, requestReason, JSON.stringify(eligibility), state.score, eligibility.completedOrders])).rows[0];
  if (!row) {
    const replay = (await client.query(`SELECT id,request_fingerprint AS "requestFingerprint",status,created_at AS "createdAt" FROM zzsh_credit.credit_recovery_request WHERE user_id=$1 AND request_key=$2`, [userId, requestKey])).rows[0];
    if (!replay || replay.requestFingerprint !== input.requestFingerprint) throw conflict("Recovery request key is already bound to different evidence");
    return { requestId: replay.id, status: replay.status, createdAt: replay.createdAt, duplicate: true };
  }
  return { requestId: row.id, status: row.status, createdAt: row.createdAt, eligibility, duplicate: false };
}

export async function decideRecovery(client: PoolClient, input: { requestId: string; actorAdminId: string; decision: "APPROVE" | "REJECT"; reason: string; obligationReader: UserObligationReader }): Promise<Record<string, unknown>> {
  const requestId = id(input.requestId, "requestId");
  const decisionReason = reason(input.reason, "reason");
  if (!ID.test(input.actorAdminId) || !["APPROVE", "REJECT"].includes(input.decision)) throw invalid("Recovery decision is invalid");
  const hint = (await client.query<{ userId: string }>(`SELECT user_id AS "userId" FROM zzsh_credit.credit_recovery_request WHERE id=$1`, [requestId])).rows[0];
  if (!hint) throw notFound();
  const state = await lockCreditAccount(client, hint.userId);
  const row = (await client.query<{ id: string; userId: string; status: string; scoreBefore: number; decision: string | null; decisionReason: string | null; decisionFingerprint: string | null }>(`SELECT id,user_id AS "userId",status,score_before AS "scoreBefore",decision,decision_reason AS "decisionReason",decision_fingerprint AS "decisionFingerprint" FROM zzsh_credit.credit_recovery_request WHERE id=$1 AND user_id=$2 FOR UPDATE`, [requestId, hint.userId])).rows[0];
  if (!row) throw notFound();
  const decisionFingerprint = hash([input.decision, decisionReason]);
  if (row.status !== "PENDING") {
    const storedFingerprint = row.decisionFingerprint ?? hash([row.decision ?? (row.status === "APPROVED" ? "APPROVE" : "REJECT"), row.decisionReason ?? ""]);
    if (storedFingerprint !== decisionFingerprint) throw conflict("Recovery request already has a different decision or reason");
    return { requestId, status: row.status, duplicate: true };
  }
  if (input.decision === "REJECT") {
    await client.query(`UPDATE zzsh_credit.credit_recovery_request SET status='REJECTED',decision='REJECT',decision_reason=$2,decision_fingerprint=$3,decided_by=$4,decided_at=clock_timestamp() WHERE id=$1`, [requestId, decisionReason, decisionFingerprint, input.actorAdminId]);
    return { requestId, status: "REJECTED", duplicate: false };
  }
  const eligibility = await recoveryEligibility(client, row.userId, input.obligationReader, state, requestId);
  if (!eligibility.eligible) throw conflict(`Credit recovery is no longer eligible: ${eligibility.reasons.join(",")}`);
  const applied = clippedScore(state.score, CREDIT_RECOVERY_DELTA);
  const eventKey = `recovery:${requestId}`;
  const payloadHash = hash([eventKey, decisionReason]);
  const event = (await client.query<CreditEventRow>(
    `INSERT INTO zzsh_credit.credit_event
      (id,user_id,event_key,event_type,source_type,source_id,delta_score,applied_delta_score,score_before,score_after,visible_reason,internal_basis,actor_admin_id,payload_hash)
     VALUES($1,$2,$3,'RECOVERY_APPROVED','RECOVERY_REQUEST',$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id,user_id AS "userId",event_key AS "eventKey",event_type AS "eventType",source_type AS "sourceType",source_id AS "sourceId",subject_role AS "subjectRole",delta_score AS "deltaScore",applied_delta_score AS "appliedDeltaScore",score_before AS "scoreBefore",score_after AS "scoreAfter",visible_reason AS "visibleReason",internal_basis AS "internalBasis",actor_admin_id AS "actorAdminId",reversal_of_id AS "reversalOfId",payload_hash AS "payloadHash",created_at::text AS "createdAt",false AS reversed`,
    [`credit_evt_${randomUUID().replaceAll("-", "")}`, row.userId, eventKey, requestId, CREDIT_RECOVERY_DELTA, applied.applied, state.score, applied.score, decisionReason, "credit-policy-v1:manual-recovery-7d", input.actorAdminId, payloadHash],
  )).rows[0];
  await client.query(`UPDATE zzsh_credit.user_credit_state SET score=$2,revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1`, [row.userId, applied.score]);
  await client.query(`UPDATE zzsh_credit.credit_recovery_request SET status='APPROVED',decision='APPROVE',decision_reason=$2,decision_fingerprint=$3,decided_by=$4,decided_at=clock_timestamp(),event_id=$5 WHERE id=$1`, [requestId, decisionReason, decisionFingerprint, input.actorAdminId, event!.id]);
  return { requestId, status: "APPROVED", event: rowEvent(event!), duplicate: false };
}
