import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import type { UserObligationReader } from "../auth/user-identity";
import { canonicalize } from "../supply/content-hash";
import { parseNonNegativeDecimal } from "../supply/decimal";
import { validateFundingPolicy, type FundingPolicy } from "../supply/funding-policy";
import { conflict, invalid, notFound } from "../supply/supply-util";

export const CREDIT_INITIAL_SCORE = 100;
export const CREDIT_BREACH_DELTA = -10;
export const CREDIT_RECOVERY_DELTA = 10;
export const CREDIT_GUARANTEE_THRESHOLD = 80;
export const CREDIT_RECOVERY_DAYS = 7;
export const CREDIT_GUARANTEE_CAP_CENTS = 10_000n;

function guaranteeReference(input: {
  accountId: string;
  ownerUserId: string;
  gameId: string;
  versionId: string | null;
  priceVersionId: string;
  releaseId: string;
  creditRevision: string | null;
  coverageRevision: string | null;
  state: GuaranteeState;
  requiredCents: string;
}): string {
  return `credit-guarantee-v1:${createHash("sha256").update(canonicalize(input)).digest("hex")}`;
}

export type CreditEventType = "INITIALIZED" | "BREACH_CONFIRMED" | "BREACH_REVERSED" | "RECOVERY_APPROVED";
export type CreditSubjectRole = "OWNER" | "RENTER";
export type GuaranteeState = "NOT_REQUIRED" | "REQUIRED" | "PAYMENT_PENDING" | "SATISFIED" | "REFUND_REQUESTED" | "REFUND_PROCESSING" | "REFUNDED" | "FAILED" | "UNKNOWN";

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

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TEXT = /^.{2,500}$/su;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function reason(value: unknown, label: string): string {
  if (typeof value !== "string" || !TEXT.test(value) || value.trim().length < 2) throw invalid(`${label} is invalid`);
  return value.trim();
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

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
    reversalOfId: row.reversalOfId,
    reversed: row.reversed,
    createdAt: row.createdAt,
  };
}

async function userExists(client: PoolClient, userId: string): Promise<void> {
  if (!(await client.query(`SELECT 1 FROM zzsh_auth_user."user" WHERE id=$1`, [userId])).rowCount) throw notFound();
}

export async function ensureCreditAccount(client: PoolClient, userId: string): Promise<CreditStateRow> {
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
            e.internal_basis AS "internalBasis",e.actor_admin_id AS "actorAdminId",e.reversal_of_id AS "reversalOfId",
            e.payload_hash AS "payloadHash",e.created_at::text AS "createdAt",
            EXISTS(SELECT 1 FROM zzsh_credit.credit_event r WHERE r.reversal_of_id=e.id) AS reversed
       FROM zzsh_credit.credit_event e WHERE e.user_id=$1
         AND ($2::boolean IS NULL OR e.source_type NOT IN ('ACCOUNT','ORDER') OR $2::boolean OR
           (e.source_type='ACCOUNT' AND EXISTS (SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.admin_supply_scope s ON s.game_id=a.game_id WHERE a.id=e.source_id AND s.admin_user_id=$3)) OR
           (e.source_type='ORDER' AND EXISTS (SELECT 1 FROM zzsh_order.rental_order o JOIN zzsh_supply.admin_supply_scope s ON s.game_id=o.game_id WHERE o.id=e.source_id AND s.admin_user_id=$3)))
       ORDER BY e.created_at DESC,e.id DESC`,
    [userId, scope ? scope.isBoss : null, scope?.adminId ?? null],
  )).rows;
  return { userId: state.userId, score: state.score, revision: state.revision, initializedAt: state.initializedAt, events: events.map(rowEvent) };
}

async function lockCreditAccount(client: PoolClient, userId: string): Promise<CreditStateRow> {
  const state = await ensureCreditAccount(client, userId);
  await client.query(`SELECT set_config('zzsh.credit_mutation','1',true)`);
  const row = (await client.query<CreditStateRow>(
    `SELECT user_id AS "userId",score,revision::text,initialized_at AS "initializedAt"
       FROM zzsh_credit.user_credit_state WHERE user_id=$1 FOR UPDATE`,
    [userId],
  )).rows[0];
  if (!row) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Credit state is unavailable");
  return row ?? state;
}

function clippedScore(score: number, delta: number): { score: number; applied: number } {
  const next = Math.max(0, Math.min(100, score + delta));
  return { score: next, applied: next - score };
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
  // Every credit mutation acquires the subject state before any source/event
  // row.  This is the single lock order shared with reversal and recovery.
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
  const recentBreach = (await client.query(`SELECT 1 FROM zzsh_credit.credit_event e WHERE e.user_id=$1 AND e.event_type='BREACH_CONFIRMED' AND e.created_at>clock_timestamp()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM zzsh_credit.credit_event r WHERE r.reversal_of_id=e.id) LIMIT 1`, [userId])).rowCount;
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

export function requiredGuaranteeCents(standardRentalAndResourceCents: string | bigint): string {
  const base = typeof standardRentalAndResourceCents === "bigint" ? standardRentalAndResourceCents : BigInt(standardRentalAndResourceCents);
  if (base < 0n) throw invalid("Standard rental amount cannot be negative");
  const numerator = base * 5n;
  const rounded = numerator / 100n + (numerator % 100n >= 50n ? 1n : 0n);
  return (rounded > CREDIT_GUARANTEE_CAP_CENTS ? CREDIT_GUARANTEE_CAP_CENTS : rounded).toString();
}

function quoteResourceCents(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const quote = (payload as Record<string, unknown>).quoteValues;
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return null;
  const pricingInputs = (quote as Record<string, unknown>).pricingInputs;
  if (pricingInputs && typeof pricingInputs === "object" && !Array.isArray(pricingInputs)) {
    const compatibility = (pricingInputs as Record<string, unknown>).compatibility;
    if (compatibility && typeof compatibility === "object" && !Array.isArray(compatibility) && (compatibility as Record<string, unknown>).customerTier !== "STANDARD") return null;
  }
  const amount = (quote as Record<string, unknown>).resourceTotal;
  if (!amount || typeof amount !== "object" || Array.isArray(amount)) return null;
  const item = amount as Record<string, unknown>;
  if (item.currency !== "CNY" || item.unit !== "yuan" || item.scale !== 2 || typeof item.amount !== "string") return null;
  try {
    const parsed = parseNonNegativeDecimal(item.amount, 2, "resourceTotal");
    return (parsed.value * 10n ** BigInt(2 - parsed.scale)).toString();
  } catch {
    return null;
  }
}

type GuaranteeContextRow = { accountId: string; ownerUserId: string; gameId: string; currentVersionId: string | null; versionId: string | null; priceVersionId: string; releaseId: string; policy: unknown; policyStatus: string; payload: unknown; priceStatus: string };
type GuaranteeBindingRow = {
  requirementId: string;
  requirementStatus: string;
  bindingBaseCents: string;
  bindingRequiredCents: string;
  paymentId: string | null;
  paymentState: string | null;
  paymentProviderState: string | null;
  paymentAmountCents: string | null;
  paymentObservedAmountCents: string | null;
  paymentFinanceEventId: string | null;
  paymentLedgerEntryRef: string | null;
  confirmedCents: string;
  unrecognizedPayment: boolean;
  refundId: string | null;
  refundState: string | null;
  refundProviderState: string | null;
  refundAmountCents: string | null;
  refundPolicyState: string | null;
  refundFinanceEventId: string | null;
  refundLedgerEntryRef: string | null;
  succeededRefundCents: string;
  activeRefund: boolean;
  updatedAt: string;
};
export type GuaranteeContext = {
  accountId: string;
  ownerUserId: string;
  gameId: string;
  requirementId?: string;
  versionId: string | null;
  priceVersionId: string;
  releaseId: string;
  policy: FundingPolicy;
  baseCents: string | null;
  requiredCents: string;
  score: number | null;
  creditRevision: string | null;
  coverageRevision: string | null;
  state: GuaranteeState;
  reference: string | null;
  reasonCode?: string;
  paymentId?: string | null;
  paymentState?: string | null;
  paymentProviderState?: string | null;
  paymentAmountCents?: string | null;
  paymentObservedAmountCents?: string | null;
  paymentFinanceEventId?: string | null;
  paymentLedgerEntryRef?: string | null;
  refundId?: string | null;
  refundState?: string | null;
  refundProviderState?: string | null;
  refundAmountCents?: string | null;
  refundPolicyState?: string | null;
  refundFinanceEventId?: string | null;
  refundLedgerEntryRef?: string | null;
};

export async function readGuaranteeContext(client: PoolClient, accountId: string, ownerUserId: string, versionId?: string): Promise<GuaranteeContext | null> {
  const row = (await client.query<GuaranteeContextRow>(
    `SELECT a.id AS "accountId",a.owner_user_id AS "ownerUserId",a.game_id AS "gameId",a.current_version_id AS "currentVersionId",
            v.id AS "versionId",p.id AS "priceVersionId",r.id AS "releaseId",p.funding_policy AS policy,p.status AS "priceStatus",
            r.id AS "releaseId",v.payload,p.status AS "policyStatus"
       FROM zzsh_supply.rental_account a
       JOIN zzsh_supply.game g ON g.id=a.game_id AND g.current_release_id IS NOT NULL
       JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id AND r.game_id=a.game_id
       JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
       LEFT JOIN zzsh_supply.listing_version v ON v.id=COALESCE($3,a.current_version_id) AND v.account_id=a.id AND v.rule_release_id=r.id
      WHERE a.id=$1 AND a.owner_user_id=$2`,
    [accountId, ownerUserId, versionId ?? null],
  )).rows[0];
  if (!row || row.policyStatus !== "SEALED" || row.policy === null) return null;
  const policy = validateFundingPolicy(row.policy);
  const credit = (await client.query<{ score: number; revision: string }>(`SELECT score,revision::text FROM zzsh_credit.user_credit_state WHERE user_id=$1`, [ownerUserId])).rows[0];
  if (!credit) return { accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents: null, requiredCents: "0", score: null, creditRevision: null, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "CREDIT_UNINITIALIZED" };
  const baseCents = quoteResourceCents(row.payload);
  if (baseCents === null) return { accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents: null, requiredCents: "0", score: credit.score, creditRevision: credit.revision, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "STANDARD_QUOTE_UNAVAILABLE" };
  const requiredCents = requiredGuaranteeCents(baseCents);
  if (requiredCents === "0") return { accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents, score: credit.score, creditRevision: credit.revision, coverageRevision: null, state: "UNKNOWN", reference: null, reasonCode: "ZERO_AMOUNT_PROVIDER_UNSUPPORTED" };
  const binding = (await client.query<GuaranteeBindingRow>(
    `WITH payment_totals AS (
       SELECT requirement_id,
              COALESCE(sum(CASE WHEN status='CONFIRMED' THEN COALESCE(observed_amount_cents,amount_cents) ELSE 0 END),0)::text AS "confirmedCents",
              COALESCE(bool_or(status='CONFIRMED' AND (provider_request_state<>'CONFIRMED' OR finance_event_id IS NULL OR ledger_entry_ref IS NULL)),false) AS "unrecognizedPayment"
         FROM zzsh_order.owner_guarantee_payment GROUP BY requirement_id
     ), refund_totals AS (
       SELECT requirement_id,
              COALESCE(sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END),0)::text AS "succeededRefundCents",
              COALESCE(bool_or(status IN ('REQUESTED','PROCESSING','UNKNOWN')),false) AS "activeRefund"
         FROM zzsh_order.owner_guarantee_refund GROUP BY requirement_id
     )
     SELECT r.id AS "requirementId",r.status AS "requirementStatus",r.base_cents::text AS "bindingBaseCents",r.required_cents::text AS "bindingRequiredCents",
            p.id AS "paymentId",p.status AS "paymentState",p.provider_request_state AS "paymentProviderState",p.amount_cents::text AS "paymentAmountCents",p.observed_amount_cents::text AS "paymentObservedAmountCents",p.finance_event_id AS "paymentFinanceEventId",p.ledger_entry_ref AS "paymentLedgerEntryRef",
            COALESCE(pt."confirmedCents",'0') AS "confirmedCents",COALESCE(pt."unrecognizedPayment",false) AS "unrecognizedPayment",
            f.id AS "refundId",f.status AS "refundState",f.provider_request_state AS "refundProviderState",f.amount_cents::text AS "refundAmountCents",f.release_policy_state AS "refundPolicyState",f.finance_event_id AS "refundFinanceEventId",f.ledger_entry_ref AS "refundLedgerEntryRef",
            COALESCE(rt."succeededRefundCents",'0') AS "succeededRefundCents",COALESCE(rt."activeRefund",false) AS "activeRefund",r.updated_at::text AS "updatedAt"
       FROM zzsh_order.owner_guarantee_requirement r
       LEFT JOIN LATERAL (SELECT * FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
       LEFT JOIN LATERAL (SELECT * FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) f ON true
       LEFT JOIN payment_totals pt ON pt.requirement_id=r.id
       LEFT JOIN refund_totals rt ON rt.requirement_id=r.id
      WHERE r.account_id=$1 AND r.owner_user_id=$2 AND r.price_version_id=$3 AND r.listing_version_id IS NOT DISTINCT FROM $4
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
    [accountId, ownerUserId, row.priceVersionId, row.versionId],
  )).rows[0];
  if (!binding) {
    if (credit.score >= CREDIT_GUARANTEE_THRESHOLD) return { accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0", score: credit.score, creditRevision: credit.revision, coverageRevision: null, state: "NOT_REQUIRED", reference: guaranteeReference({ accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, creditRevision: credit.revision, coverageRevision: null, state: "NOT_REQUIRED", requiredCents: "0" }) };
    return { accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents, score: credit.score, creditRevision: credit.revision, coverageRevision: null, state: "REQUIRED", reference: null };
  }
  const boundRequiredCents = binding.bindingRequiredCents ?? requiredCents;
  const confirmedCents = binding.confirmedCents ?? (binding.paymentState === "CONFIRMED" ? (binding.paymentAmountCents ?? boundRequiredCents) : "0");
  const unrecognizedPayment = binding.unrecognizedPayment ?? false;
  const succeededRefundCents = binding.succeededRefundCents ?? (binding.refundState === "SUCCEEDED" ? (binding.refundAmountCents ?? boundRequiredCents) : "0");
  const activeRefund = binding.activeRefund ?? ["REQUESTED", "PROCESSING", "UNKNOWN"].includes(binding.refundState ?? "");
  let state: GuaranteeState = "REQUIRED";
  let reasonCode: string | undefined;
  if (activeRefund) {
    state = binding.refundState === "REQUESTED" ? "REFUND_REQUESTED" : binding.refundState === "PROCESSING" ? "REFUND_PROCESSING" : "UNKNOWN";
  } else if (BigInt(succeededRefundCents) > 0n) {
    state = "REFUNDED";
  } else if (["REQUESTED", "ACCEPTED", "PROCESSING", "UNKNOWN"].includes(binding.paymentState ?? "")) {
    state = "PAYMENT_PENDING";
  } else if (unrecognizedPayment) {
    state = "UNKNOWN";
    reasonCode = "PAYMENT_LEDGER_UNRECONCILED";
  } else if (BigInt(confirmedCents) < BigInt(boundRequiredCents)) {
    state = "REQUIRED";
    reasonCode = "PAYMENT_UNDERPAID";
  } else {
    state = "SATISFIED";
  }
  if (credit.score >= CREDIT_GUARANTEE_THRESHOLD && state === "REQUIRED" && BigInt(confirmedCents) === 0n && (!binding.paymentId || binding.paymentState === "FAILED")) {
    state = "NOT_REQUIRED";
    return { accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: "0", score: credit.score, creditRevision: credit.revision, coverageRevision: null, state, reference: guaranteeReference({ accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, creditRevision: credit.revision, coverageRevision: null, state, requiredCents: "0" }) };
  }
  const reference = guaranteeReference({ accountId, ownerUserId, gameId: row.gameId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, creditRevision: credit.revision, coverageRevision: binding.updatedAt, state, requiredCents: boundRequiredCents });
  return {
    accountId, ownerUserId, gameId: row.gameId, requirementId: binding.requirementId, versionId: row.versionId, priceVersionId: row.priceVersionId, releaseId: row.releaseId, policy, baseCents, requiredCents: boundRequiredCents,
    score: credit.score, creditRevision: credit.revision, coverageRevision: binding.updatedAt, state, reasonCode, reference,
    paymentId: binding.paymentId, paymentState: binding.paymentState, paymentProviderState: binding.paymentProviderState, paymentAmountCents: binding.paymentAmountCents,
    paymentObservedAmountCents: binding.paymentObservedAmountCents, paymentFinanceEventId: binding.paymentFinanceEventId, paymentLedgerEntryRef: binding.paymentLedgerEntryRef,
    refundId: binding.refundId, refundState: binding.refundState, refundProviderState: binding.refundProviderState, refundAmountCents: binding.refundAmountCents,
    refundPolicyState: binding.refundPolicyState, refundFinanceEventId: binding.refundFinanceEventId, refundLedgerEntryRef: binding.refundLedgerEntryRef,
  };
}

/**
 * Gate-only read: serialize an enabled publication/confirmation/order check
 * against credit mutations and guarantee release updates. Display/payment
 * readers stay non-locking; runtime still receives no UPDATE privilege.
 */
export async function readGuaranteeContextForGate(client: PoolClient, accountId: string, ownerUserId: string, versionId?: string): Promise<GuaranteeContext | null> {
  await client.query(`SELECT user_id FROM zzsh_credit.user_credit_state WHERE user_id=$1 FOR SHARE`, [ownerUserId]);
  let context = await readGuaranteeContext(client, accountId, ownerUserId, versionId);
  if (context?.requirementId) {
    await client.query(`SELECT id FROM zzsh_order.owner_guarantee_requirement WHERE id=$1 FOR SHARE`, [context.requirementId]);
    context = await readGuaranteeContext(client, accountId, ownerUserId, versionId);
  }
  return context;
}

type GuaranteeTransactionActor = { userId: string; isBoss: boolean };

type GuaranteePaymentHistoryRow = {
  id: string;
  requirementId: string;
  merchantOrderNo: string;
  amountCents: string;
  observedAmountCents: string | null;
  status: string;
  providerRequestState: string;
  providerTransactionId: string | null;
  financeEventId: string | null;
  ledgerEntryRef: string | null;
  createdAt: string;
};

type GuaranteeRefundHistoryRow = {
  id: string;
  requirementId: string;
  paymentId: string;
  amountCents: string;
  status: string;
  providerRequestState: string;
  providerRefundId: string | null;
  releasePolicyState: string;
  financeEventId: string | null;
  ledgerEntryRef: string | null;
  createdAt: string;
};

export async function readGuaranteeTransactions(client: PoolClient, userId: string, actor?: GuaranteeTransactionActor) {
  const scoped = actor ? `AND ($2::boolean OR EXISTS (SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$3 AND s.game_id=a.game_id))` : "";
  const requirementParams = actor ? [userId, actor.isBoss, actor.userId] : [userId];
  const requirements = (await client.query(`SELECT r.id AS "requirementId",r.account_id AS "accountId",r.listing_version_id AS "listingVersionId",r.price_version_id AS "priceVersionId",r.base_cents::text AS "baseCents",r.required_cents::text AS "requiredCents",r.score_snapshot AS "scoreSnapshot",r.status AS "requirementStatus",r.created_at::text AS "requirementCreatedAt"
    FROM zzsh_order.owner_guarantee_requirement r
    JOIN zzsh_supply.rental_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 ${scoped} ORDER BY r.created_at DESC,r.id DESC`, requirementParams)).rows as Array<Record<string, unknown> & { requirementId: string }>;
  if (!requirements.length) return [];
  const requirementIds = requirements.map((row) => row.requirementId);
  const payments = (await client.query<GuaranteePaymentHistoryRow>(`SELECT id,requirement_id AS "requirementId",merchant_order_no AS "merchantOrderNo",amount_cents::text AS "amountCents",observed_amount_cents::text AS "observedAmountCents",status,provider_request_state AS "providerRequestState",provider_transaction_id AS "providerTransactionId",finance_event_id AS "financeEventId",ledger_entry_ref AS "ledgerEntryRef",created_at::text AS "createdAt"
    FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=ANY($1::text[]) ORDER BY requirement_id,created_at,id`, [requirementIds])).rows;
  const refunds = (await client.query<GuaranteeRefundHistoryRow>(`SELECT id,requirement_id AS "requirementId",payment_id AS "paymentId",amount_cents::text AS "amountCents",status,provider_request_state AS "providerRequestState",provider_refund_id AS "providerRefundId",release_policy_state AS "releasePolicyState",finance_event_id AS "financeEventId",ledger_entry_ref AS "ledgerEntryRef",created_at::text AS "createdAt"
    FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=ANY($1::text[]) ORDER BY requirement_id,created_at,id`, [requirementIds])).rows;
  const paymentsByRequirement = new Map<string, GuaranteePaymentHistoryRow[]>();
  const refundsByRequirement = new Map<string, GuaranteeRefundHistoryRow[]>();
  for (const payment of payments) (paymentsByRequirement.get(payment.requirementId) ?? (paymentsByRequirement.set(payment.requirementId, []), paymentsByRequirement.get(payment.requirementId)!)).push(payment);
  for (const refund of refunds) (refundsByRequirement.get(refund.requirementId) ?? (refundsByRequirement.set(refund.requirementId, []), refundsByRequirement.get(refund.requirementId)!)).push(refund);
  return requirements.map((requirement) => {
    const paymentHistory = paymentsByRequirement.get(requirement.requirementId) ?? [];
    const refundHistory = refundsByRequirement.get(requirement.requirementId) ?? [];
    const payment = paymentHistory[paymentHistory.length - 1] ?? null;
    const refund = refundHistory[refundHistory.length - 1] ?? null;
    return {
      ...requirement,
      paymentId: payment?.id ?? null,
      merchantOrderNo: payment?.merchantOrderNo ?? null,
      paymentAmountCents: payment?.amountCents ?? null,
      paymentObservedAmountCents: payment?.observedAmountCents ?? null,
      paymentStatus: payment?.status ?? null,
      paymentProviderState: payment?.providerRequestState ?? null,
      providerTransactionId: payment?.providerTransactionId ?? null,
      paymentFinanceEventId: payment?.financeEventId ?? null,
      paymentLedgerEntryRef: payment?.ledgerEntryRef ?? null,
      paymentCreatedAt: payment?.createdAt ?? null,
      refundId: refund?.id ?? null,
      refundPaymentId: refund?.paymentId ?? null,
      refundAmountCents: refund?.amountCents ?? null,
      refundStatus: refund?.status ?? null,
      refundProviderState: refund?.providerRequestState ?? null,
      providerRefundId: refund?.providerRefundId ?? null,
      refundPolicyState: refund?.releasePolicyState ?? null,
      refundFinanceEventId: refund?.financeEventId ?? null,
      refundLedgerEntryRef: refund?.ledgerEntryRef ?? null,
      refundCreatedAt: refund?.createdAt ?? null,
      paymentHistory,
      refundHistory,
    };
  });
}

export async function createGuaranteePaymentIntent(client: PoolClient, input: { context: GuaranteeContext | null; accountId?: string; userId: string; requestKey: string; requestFingerprint: string }): Promise<Record<string, unknown>> {
  if (input.context && input.context.ownerUserId !== input.userId) throw notFound();
  if (!ID.test(input.requestKey) || !/^[0-9a-f]{64}$/.test(input.requestFingerprint)) throw invalid("Guarantee payment idempotency data is invalid");
  const accountId = input.accountId ?? input.context?.accountId;
  if (!accountId || !ID.test(accountId)) throw invalid("Guarantee account is invalid");
  const account = (await client.query(`SELECT 1 FROM zzsh_supply.rental_account WHERE id=$1 AND owner_user_id=$2`, [accountId, input.userId])).rows[0];
  if (!account) throw notFound();
  const existingIntents = (await client.query(`SELECT p.id,p.request_fingerprint AS "requestFingerprint",p.status,p.provider_request_state AS "providerRequestState",p.merchant_order_no AS "merchantOrderNo",p.amount_cents::text AS "amountCents",p.provider_transaction_id AS "providerTransactionId",p.finance_event_id AS "financeEventId",p.ledger_entry_ref AS "ledgerEntryRef",p.requirement_id AS "requirementId",p.owner_user_id AS "ownerUserId",r.account_id AS "accountId"
    FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.owner_guarantee_requirement r ON r.id=p.requirement_id
    WHERE p.request_key=$1 ORDER BY p.created_at,p.id FOR UPDATE OF p,r`, [input.requestKey])).rows;
  if (existingIntents.some((row) => row.ownerUserId !== input.userId || row.accountId !== accountId)) throw conflict("Payment request key is already bound to a different subject or account");
  const existing = existingIntents.find((row) => row.ownerUserId === input.userId && row.accountId === accountId);
  if (existing) {
    if (existingIntents.some((row) => row.requestFingerprint !== input.requestFingerprint)) throw conflict("Payment request key is already bound to different evidence");
    return { paymentId: existing.id, requirementId: existing.requirementId, status: existing.status, providerRequestState: existing.providerRequestState, merchantOrderNo: existing.merchantOrderNo, amountCents: existing.amountCents, providerTransactionId: existing.providerTransactionId, financeEventId: existing.financeEventId, ledgerEntryRef: existing.ledgerEntryRef, duplicate: true, provider: "HUIJU", providerAction: "NOT_AUTHORIZED" };
  }
  const current = await readGuaranteeContext(client, accountId, input.userId, input.context?.versionId ?? undefined);
  if (!current) {
    if (!input.context) throw notFound();
    throw conflict("Guarantee context changed; refresh the current account version");
  }
  if (!input.context) input = { ...input, context: current };
  const context = input.context;
  if (!current
    || !context
    || current.accountId !== context.accountId
    || current.ownerUserId !== context.ownerUserId
    || current.versionId !== context.versionId
    || current.priceVersionId !== context.priceVersionId
    || current.releaseId !== context.releaseId
    || current.baseCents !== context.baseCents
    || current.requiredCents !== context.requiredCents
    || current.score !== context.score
    || current.creditRevision !== context.creditRevision
    || current.state !== context.state) {
    throw conflict("Guarantee context changed; refresh the current account version");
  }
  if (context.state !== "REQUIRED" && context.state !== "FAILED") throw conflict("Guarantee payment is not currently required");
  const binding = (await client.query<{ id: string; baseCents: string; requiredCents: string; policyVersion: string; gameId: string; ruleReleaseId: string }>(
    `SELECT id,base_cents::text AS "baseCents",required_cents::text AS "requiredCents",policy_version AS "policyVersion",game_id AS "gameId",rule_release_id AS "ruleReleaseId"
       FROM zzsh_order.owner_guarantee_requirement
      WHERE owner_user_id=$1 AND account_id=$2 AND price_version_id=$3 AND listing_version_id IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [input.userId, accountId, context.priceVersionId, context.versionId],
  )).rows[0];
  let requirement = binding;
  if (!requirement) {
    const requirementId = `guarantee_req_${randomUUID().replaceAll("-", "")}`;
    await client.query(
      `INSERT INTO zzsh_order.owner_guarantee_requirement(id,owner_user_id,account_id,game_id,listing_version_id,price_version_id,rule_release_id,policy_version,base_cents,required_cents,score_snapshot,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN')
       ON CONFLICT (owner_user_id,account_id,price_version_id,(COALESCE(listing_version_id,''))) DO NOTHING`,
      [requirementId, input.userId, accountId, context.gameId, context.versionId, context.priceVersionId, context.releaseId, context.policy.policyVersion, context.baseCents, context.requiredCents, context.score],
    );
    requirement = (await client.query<{ id: string; baseCents: string; requiredCents: string; policyVersion: string; gameId: string; ruleReleaseId: string }>(
      `SELECT id,base_cents::text AS "baseCents",required_cents::text AS "requiredCents",policy_version AS "policyVersion",game_id AS "gameId",rule_release_id AS "ruleReleaseId"
         FROM zzsh_order.owner_guarantee_requirement
        WHERE owner_user_id=$1 AND account_id=$2 AND price_version_id=$3 AND listing_version_id IS NOT DISTINCT FROM $4
        FOR UPDATE`,
    [input.userId, accountId, context.priceVersionId, context.versionId],
    )).rows[0];
  }
  if (!requirement || requirement.baseCents !== (context.baseCents ?? "") || requirement.requiredCents !== context.requiredCents || requirement.policyVersion !== context.policy.policyVersion || requirement.gameId !== context.gameId || requirement.ruleReleaseId !== context.releaseId) {
    throw conflict("Guarantee basis changed; refresh the current account version");
  }
  const paymentId = `guarantee_pay_${randomUUID().replaceAll("-", "")}`;
  const merchantOrderNo = `ZG${Date.now().toString(36).toUpperCase()}${paymentId.slice(-8).toUpperCase()}`;
  await client.query(`INSERT INTO zzsh_order.owner_guarantee_payment(id,requirement_id,owner_user_id,request_key,request_fingerprint,merchant_order_no,amount_cents,status,provider,provider_request_state) VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED','HUIJU','NOT_AUTHORIZED')`, [paymentId, requirement.id, input.userId, input.requestKey, input.requestFingerprint, merchantOrderNo, context.requiredCents]);
  return { paymentId, requirementId: requirement.id, status: "REQUESTED", merchantOrderNo, amountCents: context.requiredCents, provider: "HUIJU", providerAction: "NOT_AUTHORIZED", duplicate: false };
}

export async function requestGuaranteeRefund(client: PoolClient, input: { userId: string; requirementId: string; requestKey: string; requestFingerprint: string; obligationReader: UserObligationReader }): Promise<Record<string, unknown>> {
  if (!ID.test(input.userId) || !ID.test(input.requestKey) || !/^[0-9a-f]{64}$/.test(input.requestFingerprint)) throw invalid("Guarantee refund idempotency data is invalid");
  const requirementId = id(input.requirementId, "requirementId");
  const requirement = (await client.query<{ id: string; ownerUserId: string; requiredCents: string; status: string }>(`SELECT id,owner_user_id AS "ownerUserId",required_cents::text AS "requiredCents",status FROM zzsh_order.owner_guarantee_requirement WHERE id=$1 FOR UPDATE`, [requirementId])).rows[0];
  if (!requirement || requirement.ownerUserId !== input.userId) throw notFound();
  const existing = (await client.query(`SELECT id,request_fingerprint AS "requestFingerprint",status,amount_cents::text AS "amountCents",payment_id AS "paymentId",release_policy_state AS "releasePolicyState" FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=$1 AND request_key=$2`, [requirementId, input.requestKey])).rows[0];
  if (existing) {
    if (existing.requestFingerprint !== input.requestFingerprint) throw conflict("Refund request key is already bound to different evidence");
    return { refundId: existing.id, requirementId, paymentId: existing.paymentId, amountCents: existing.amountCents, status: existing.status, releasePolicyState: existing.releasePolicyState, duplicate: true, provider: "HUIJU", providerAction: "NOT_AUTHORIZED" };
  }
  const activeRefund = (await client.query(`SELECT id FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=$1 AND status IN ('REQUESTED','PROCESSING','UNKNOWN','SUCCEEDED') LIMIT 1`, [requirementId])).rowCount;
  if (activeRefund) throw conflict("A guarantee refund is already pending or completed");
  const payments = (await client.query<{ id: string; amountCents: string; observedAmountCents: string | null }>(
    `SELECT id,amount_cents::text AS "amountCents",observed_amount_cents::text AS "observedAmountCents"
       FROM zzsh_order.owner_guarantee_payment
      WHERE requirement_id=$1 AND status='CONFIRMED' AND provider_request_state='CONFIRMED' AND finance_event_id IS NOT NULL AND ledger_entry_ref IS NOT NULL
      ORDER BY created_at DESC FOR UPDATE`,
    [requirementId],
  )).rows;
  if (payments.length !== 1 || BigInt(payments[0]!.observedAmountCents ?? payments[0]!.amountCents) < BigInt(requirement.requiredCents)) throw conflict("Guarantee funds are not fully covered or reconciled");
  const obligation = await input.obligationReader(input.userId, client);
  if (obligation !== "NONE") throw conflict(obligation === "UNKNOWN" ? "Guarantee refund responsibility is unknown" : "Unprocessed responsibility prevents guarantee release");
  const refundId = `guarantee_refund_${randomUUID().replaceAll("-", "")}`;
  const amountCents = payments[0]!.observedAmountCents ?? payments[0]!.amountCents;
  await client.query(`INSERT INTO zzsh_order.owner_guarantee_refund(id,requirement_id,payment_id,owner_user_id,request_key,request_fingerprint,amount_cents,status,provider,provider_request_state,release_policy_state) VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED','HUIJU','NOT_AUTHORIZED','OWNER_DECISION_REQUIRED')`, [refundId, requirementId, payments[0]!.id, input.userId, input.requestKey, input.requestFingerprint, amountCents]);
  await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='REFUND_REQUESTED',updated_at=clock_timestamp() WHERE id=$1`, [requirementId]);
  return { refundId, requirementId, paymentId: payments[0]!.id, amountCents, status: "REQUESTED", releasePolicyState: "OWNER_DECISION_REQUIRED", provider: "HUIJU", providerAction: "NOT_AUTHORIZED", duplicate: false };
}

type GuaranteeLedgerKind = "GUARANTEE_CAPTURE" | "GUARANTEE_REFUND";

async function appendGuaranteeLedger(client: PoolClient, input: { kind: GuaranteeLedgerKind; sourceId: string; requirementId: string; ownerUserId: string; amountCents: string; sourceDigest: string }): Promise<{ financeEventId: string; ledgerEntryRef: string; rootId: string }> {
  if (!/^[1-9]\d{0,23}$/.test(input.amountCents) || !/^[0-9a-f]{64}$/.test(input.sourceDigest)) throw invalid("Guarantee ledger evidence is invalid");
  const rootId = `guarantee_root_${input.sourceId}`;
  const eventId = `guarantee_event_${input.sourceId}_${input.kind === "GUARANTEE_CAPTURE" ? "capture" : "refund"}`;
  const lineOneId = `guarantee_line_${input.sourceId}_${input.kind === "GUARANTEE_CAPTURE" ? "capture" : "refund"}_1`;
  const lineTwoId = `guarantee_line_${input.sourceId}_${input.kind === "GUARANTEE_CAPTURE" ? "capture" : "refund"}_2`;
  const details = { guaranteeId: input.sourceId, requirementId: input.requirementId, economicRootId: rootId, sourceDigest: input.sourceDigest };
  await client.query(
    `INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
     VALUES($1,NULL,'NATIVE_GUARANTEE','NATIVE','zzsh-credit-guarantee',$2,$3,$4,'OWNER','credit-guarantee-v1',$5)
     ON CONFLICT(id) DO NOTHING`,
    [rootId, input.kind === "GUARANTEE_CAPTURE" ? "owner_guarantee_payment" : "owner_guarantee_refund", input.sourceId, input.ownerUserId, input.sourceDigest],
  );
  const root = (await client.query<{ sourceEntity: string; sourceId: string; subjectUserId: string; sourceDigest: string }>(`SELECT source_entity AS "sourceEntity",source_id AS "sourceId",subject_user_id AS "subjectUserId",source_digest AS "sourceDigest" FROM zzsh_order.finance_economic_root WHERE id=$1`, [rootId])).rows[0];
  if (!root || root.sourceId !== input.sourceId || root.subjectUserId !== input.ownerUserId || root.sourceDigest !== input.sourceDigest || root.sourceEntity !== (input.kind === "GUARANTEE_CAPTURE" ? "owner_guarantee_payment" : "owner_guarantee_refund")) throw conflict("Guarantee economic root differs from the original receipt");
  await client.query(
    `INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
     VALUES($1,$2,$3,$4,0) ON CONFLICT(economic_root_id,kind) DO NOTHING`,
    [eventId, rootId, input.kind, input.ownerUserId],
  );
  const event = (await client.query<{ kind: string; subjectUserId: string; economicRootId: string }>(`SELECT kind,subject_user_id AS "subjectUserId",economic_root_id AS "economicRootId" FROM zzsh_order.finance_event WHERE id=$1`, [eventId])).rows[0];
  if (!event || event.kind !== input.kind || event.subjectUserId !== input.ownerUserId || event.economicRootId !== rootId) throw conflict("Guarantee finance event differs from the original receipt");
  const heldDebit = input.kind === "GUARANTEE_REFUND" ? input.amountCents : "0";
  const heldCredit = input.kind === "GUARANTEE_CAPTURE" ? input.amountCents : "0";
  const cashDebit = input.kind === "GUARANTEE_CAPTURE" ? input.amountCents : "0";
  const cashCredit = input.kind === "GUARANTEE_REFUND" ? input.amountCents : "0";
  const existing = (await client.query<{ id: string; lineNo: number; accountCode: string; debitCents: string; creditCents: string; counterpartyUserId: string | null; details: unknown }>(`SELECT id,line_no AS "lineNo",account_code AS "accountCode",debit_cents::text AS "debitCents",credit_cents::text AS "creditCents",counterparty_user_id AS "counterpartyUserId",details FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no`, [eventId])).rows;
  if (existing.length === 0) {
    await client.query(
      `INSERT INTO zzsh_order.settlement_ledger_entry(id,posting_id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
       VALUES($1,NULL,$2,1,'GUARANTEE_CASH',$3,$4,NULL,NULL,$5::jsonb),($6,NULL,$2,2,'GUARANTEE_HELD',$7,$8,$9,NULL,$5::jsonb)`,
      [lineOneId, eventId, cashDebit, cashCredit, JSON.stringify(details), lineTwoId, heldDebit, heldCredit, input.ownerUserId],
    );
  } else {
    if (existing.length !== 2) throw conflict("Guarantee ledger batch is incomplete");
    const expected = [
      { id: lineOneId, lineNo: 1, accountCode: "GUARANTEE_CASH", debitCents: cashDebit, creditCents: cashCredit, counterpartyUserId: null },
      { id: lineTwoId, lineNo: 2, accountCode: "GUARANTEE_HELD", debitCents: heldDebit, creditCents: heldCredit, counterpartyUserId: input.ownerUserId },
    ];
    for (const target of expected) {
      const row = existing.find((entry) => entry.lineNo === target.lineNo);
      if (!row || row.id !== target.id || row.accountCode !== target.accountCode || row.debitCents !== target.debitCents || row.creditCents !== target.creditCents || row.counterpartyUserId !== target.counterpartyUserId || canonicalize(row.details) !== canonicalize(details)) throw conflict("Existing guarantee ledger lines differ from the original receipt");
    }
  }
  return { financeEventId: eventId, ledgerEntryRef: lineOneId, rootId };
}

function resultReceipt(input: unknown): { value: Record<string, unknown>; digest: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Provider receipt is required");
  const value = input as Record<string, unknown>;
  return { value, digest: hash(value) };
}

async function recordGuaranteeObservation(client: PoolClient, input: { paymentId?: string; refundId?: string; state: string; amountCents: string | null; providerReference: string | null; receipt: Record<string, unknown>; digest: string }): Promise<boolean> {
  const id = `guarantee_recon_${(input.paymentId ?? input.refundId)!}_${input.digest.slice(0, 24)}`;
  const inserted = await client.query(
    `INSERT INTO zzsh_order.owner_guarantee_reconciliation(id,payment_id,refund_id,observed_state,observed_amount_cents,provider_reference,canonical_payload,payload_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING`,
    [id, input.paymentId ?? null, input.refundId ?? null, input.state, input.amountCents, input.providerReference, JSON.stringify(input.receipt), input.digest],
  );
  return inserted.rowCount === 1;
}

export type GuaranteePaymentOutcome = "ACCEPTED" | "PROCESSING" | "CONFIRMED" | "FAILED" | "UNKNOWN";
export async function recordGuaranteePaymentResult(client: PoolClient, input: { paymentId: string; outcome: GuaranteePaymentOutcome; receivedAmountCents?: string; providerTransactionId?: string; receipt: unknown }): Promise<Record<string, unknown>> {
  const paymentId = id(input.paymentId, "paymentId");
  if (!["ACCEPTED", "PROCESSING", "CONFIRMED", "FAILED", "UNKNOWN"].includes(input.outcome)) throw invalid("Payment outcome is invalid");
  const receipt = resultReceipt(input.receipt);
  const row = (await client.query<{ id: string; requirementId: string; ownerUserId: string; expectedAmountCents: string; requiredAmountCents: string; status: string; sourceDigest: string | null; providerTransactionId: string | null; observedAmountCents: string | null; financeEventId: string | null; ledgerEntryRef: string | null }>(
    `SELECT p.id,p.requirement_id AS "requirementId",p.owner_user_id AS "ownerUserId",p.amount_cents::text AS "expectedAmountCents",r.required_cents::text AS "requiredAmountCents",p.status,p.source_digest AS "sourceDigest",p.provider_transaction_id AS "providerTransactionId",p.observed_amount_cents::text AS "observedAmountCents",p.finance_event_id AS "financeEventId",p.ledger_entry_ref AS "ledgerEntryRef"
       FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.owner_guarantee_requirement r ON r.id=p.requirement_id WHERE p.id=$1 FOR UPDATE`, [paymentId],
  )).rows[0];
  if (!row) throw notFound();
  const observedAmount = input.receivedAmountCents ?? null;
  if (observedAmount !== null && !/^(0|[1-9]\d{0,23})$/.test(observedAmount)) throw invalid("Received payment amount is invalid");
  if (input.outcome === "CONFIRMED" && (!input.providerTransactionId || !ID.test(input.providerTransactionId) || observedAmount === null || BigInt(observedAmount) <= 0n || BigInt(observedAmount) > BigInt(row.expectedAmountCents))) throw invalid("Confirmed payment receipt is invalid");
  const observationReceipt = { ...receipt.value, outcome: input.outcome, amountCents: observedAmount, providerTransactionId: input.providerTransactionId ?? null };
  const observationDigest = hash(observationReceipt);
  if (row.status === "CONFIRMED" && (input.outcome !== "CONFIRMED" || row.providerTransactionId !== input.providerTransactionId || row.observedAmountCents !== observedAmount || row.sourceDigest !== observationDigest)) throw conflict("Confirmed payment receipt differs from the original transaction");
  const observationInserted = await recordGuaranteeObservation(client, { paymentId, state: input.outcome, amountCents: observedAmount, providerReference: input.providerTransactionId ?? null, receipt: observationReceipt, digest: observationDigest });
  if (!observationInserted && (input.outcome !== "CONFIRMED" || row.financeEventId || row.ledgerEntryRef)) return { paymentId, status: row.status, duplicate: true, providerAction: "LOCAL_CONTROLLED" };
  if (row.status === "CONFIRMED" && input.outcome !== "CONFIRMED") throw conflict("Confirmed payment cannot move backwards");
  const providerState = input.outcome === "CONFIRMED" ? "CONFIRMED" : input.outcome === "UNKNOWN" ? "UNKNOWN" : input.outcome === "FAILED" ? "FAILED" : "SUBMITTED";
  await client.query(
    `UPDATE zzsh_order.owner_guarantee_payment SET status=$2,provider_request_state=$3,provider_transaction_id=COALESCE($4,provider_transaction_id),observed_amount_cents=COALESCE($5,observed_amount_cents),original_receipt=$6::jsonb,source_digest=CASE WHEN $2='CONFIRMED' THEN $7 ELSE source_digest END,updated_at=clock_timestamp() WHERE id=$1`,
    [paymentId, input.outcome, providerState, input.providerTransactionId ?? null, observedAmount, JSON.stringify(observationReceipt), observationDigest],
  );
  let ledger: { financeEventId: string; ledgerEntryRef: string; rootId: string } | null = null;
  if (input.outcome === "CONFIRMED") {
    ledger = await appendGuaranteeLedger(client, { kind: "GUARANTEE_CAPTURE", sourceId: paymentId, requirementId: row.requirementId, ownerUserId: row.ownerUserId, amountCents: observedAmount!, sourceDigest: observationDigest });
    await client.query(`UPDATE zzsh_order.owner_guarantee_payment SET finance_event_id=$2,ledger_entry_ref=$3,source_digest=$4,updated_at=clock_timestamp() WHERE id=$1`, [paymentId, ledger.financeEventId, ledger.ledgerEntryRef, observationDigest]);
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status=CASE WHEN $2::numeric >= required_cents THEN 'COVERED' ELSE 'OPEN' END,updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId, observedAmount]);
  }
  return { paymentId, requirementId: row.requirementId, status: input.outcome, providerTransactionId: input.providerTransactionId ?? null, observedAmountCents: observedAmount, financeEventId: ledger?.financeEventId ?? null, ledgerEntryRef: ledger?.ledgerEntryRef ?? null, duplicate: false, providerAction: "LOCAL_CONTROLLED" };
}

export type GuaranteeRefundOutcome = "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
export async function recordGuaranteeRefundResult(client: PoolClient, input: { refundId: string; outcome: GuaranteeRefundOutcome; providerRefundId?: string; refundedAmountCents?: string; receipt: unknown }): Promise<Record<string, unknown>> {
  const refundId = id(input.refundId, "refundId");
  if (!["PROCESSING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(input.outcome)) throw invalid("Refund outcome is invalid");
  const receipt = resultReceipt(input.receipt);
  const row = (await client.query<{ id: string; requirementId: string; ownerUserId: string; amountCents: string; status: string; releasePolicyState: string; sourceDigest: string | null; providerRefundId: string | null; financeEventId: string | null; ledgerEntryRef: string | null }>(
    `SELECT f.id,f.requirement_id AS "requirementId",f.owner_user_id AS "ownerUserId",f.amount_cents::text AS "amountCents",f.status,f.release_policy_state AS "releasePolicyState",f.source_digest AS "sourceDigest",f.provider_refund_id AS "providerRefundId",f.finance_event_id AS "financeEventId",f.ledger_entry_ref AS "ledgerEntryRef"
       FROM zzsh_order.owner_guarantee_refund f WHERE f.id=$1 FOR UPDATE`, [refundId],
  )).rows[0];
  if (!row) throw notFound();
  const amount = input.refundedAmountCents ?? null;
  if (input.outcome === "SUCCEEDED" && (!input.providerRefundId || !ID.test(input.providerRefundId) || amount !== row.amountCents)) throw invalid("Successful refund receipt is invalid");
  const observationReceipt = { ...receipt.value, outcome: input.outcome, amountCents: amount, providerRefundId: input.providerRefundId ?? null };
  const observationDigest = hash(observationReceipt);
  if (row.status === "SUCCEEDED" && (input.outcome !== "SUCCEEDED" || row.providerRefundId !== input.providerRefundId || row.sourceDigest !== observationDigest)) throw conflict("Successful refund receipt differs from the original transaction");
  const observationInserted = await recordGuaranteeObservation(client, { refundId, state: input.outcome, amountCents: amount, providerReference: input.providerRefundId ?? null, receipt: observationReceipt, digest: observationDigest });
  if (!observationInserted && (input.outcome !== "SUCCEEDED" || row.financeEventId || row.ledgerEntryRef)) return { refundId, status: row.status, duplicate: true, providerAction: "LOCAL_CONTROLLED" };
  if (row.status === "SUCCEEDED" && input.outcome !== "SUCCEEDED") throw conflict("Successful refund cannot move backwards");
  if (input.outcome === "SUCCEEDED" && row.releasePolicyState !== "APPROVED") throw conflict("Guarantee release policy is not approved");
  const providerState = input.outcome === "SUCCEEDED" ? "SUCCEEDED" : input.outcome === "UNKNOWN" ? "UNKNOWN" : input.outcome === "FAILED" ? "FAILED" : "SUBMITTED";
  await client.query(`UPDATE zzsh_order.owner_guarantee_refund SET status=$2,provider_request_state=$3,provider_refund_id=COALESCE($4,provider_refund_id),original_receipt=$5::jsonb,source_digest=CASE WHEN $2='SUCCEEDED' THEN $6 ELSE source_digest END,updated_at=clock_timestamp() WHERE id=$1`, [refundId, input.outcome, providerState, input.providerRefundId ?? null, JSON.stringify(observationReceipt), observationDigest]);
  let ledger: { financeEventId: string; ledgerEntryRef: string; rootId: string } | null = null;
  if (input.outcome === "SUCCEEDED") {
    ledger = await appendGuaranteeLedger(client, { kind: "GUARANTEE_REFUND", sourceId: refundId, requirementId: row.requirementId, ownerUserId: row.ownerUserId, amountCents: amount!, sourceDigest: observationDigest });
    await client.query(`UPDATE zzsh_order.owner_guarantee_refund SET finance_event_id=$2,ledger_entry_ref=$3,source_digest=$4,updated_at=clock_timestamp() WHERE id=$1`, [refundId, ledger.financeEventId, ledger.ledgerEntryRef, observationDigest]);
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='REFUNDED',updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId]);
  } else if (input.outcome === "FAILED") {
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='COVERED',updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId]);
  } else {
    await client.query(`UPDATE zzsh_order.owner_guarantee_requirement SET status='REFUND_PROCESSING',updated_at=clock_timestamp() WHERE id=$1`, [row.requirementId]);
  }
  return { refundId, requirementId: row.requirementId, status: input.outcome, providerRefundId: input.providerRefundId ?? null, financeEventId: ledger?.financeEventId ?? null, ledgerEntryRef: ledger?.ledgerEntryRef ?? null, duplicate: false, providerAction: "LOCAL_CONTROLLED" };
}

export async function decideGuaranteeRefund(client: PoolClient, input: { refundId: string; actorAdminId: string; decision: "APPROVE" | "REJECT"; reason: string }): Promise<Record<string, unknown>> {
  const refundId = id(input.refundId, "refundId");
  if (!ID.test(input.actorAdminId) || !["APPROVE", "REJECT"].includes(input.decision)) throw invalid("Guarantee release decision is invalid");
  const decisionReason = reason(input.reason, "reason");
  const row = (await client.query<{ status: string; releasePolicyState: string; decisionFingerprint: string | null }>(`SELECT status,release_policy_state AS "releasePolicyState",release_decision_fingerprint AS "decisionFingerprint" FROM zzsh_order.owner_guarantee_refund WHERE id=$1 FOR UPDATE`, [refundId])).rows[0];
  if (!row) throw notFound();
  const fingerprint = hash([input.decision, decisionReason]);
  if (row.releasePolicyState !== "OWNER_DECISION_REQUIRED") {
    if (row.decisionFingerprint !== fingerprint) throw conflict("Guarantee release decision already differs");
    return { refundId, releasePolicyState: row.releasePolicyState, duplicate: true };
  }
  await client.query(`UPDATE zzsh_order.owner_guarantee_refund SET release_policy_state=$2,release_decision_reason=$3,release_decision_fingerprint=$4,release_decided_by=$5,release_decided_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [refundId, input.decision === "APPROVE" ? "APPROVED" : "REJECTED", decisionReason, fingerprint, input.actorAdminId]);
  return { refundId, releasePolicyState: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", duplicate: false };
}

