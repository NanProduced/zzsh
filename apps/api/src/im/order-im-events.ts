import type { INestApplication } from "@nestjs/common";
import { Injectable, Logger, type BeforeApplicationShutdown } from "@nestjs/common";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import type { AuthSecurityNodeRequest, AuthSecurityNodeResponse } from "../auth/auth-security";
import { SecurityApiError, recordAudit, withTransaction } from "../auth/security-core";
import { assertActiveInTransaction } from "../auth/user-identity";
import { requireSupportAccess, type SupportType } from "./consultation";
import type { YunxinServerApi, YunxinTeamMessageFact } from "./yunxin-provider";

/**
 * OIM-4B supplier event ingress: signed copy and pre-send callbacks, minimal
 * approval/delivery facts and the first-response reducer. No scheduler, no
 * reminder/ADD execution and no general message bus live here.
 */
export type OrderImEventOptions = {
  pool: Pool;
  /** Yunxin AppKey: the App binding for both callbacks. */
  appId: string;
  appSecret: string;
  /** Request-header freshness window; engineering default, not a provider guarantee. */
  freshnessMs?: number;
  /** How long an approved pre-send decision may be linked to a later delivery (signed message times). */
  approvalLinkMs?: number;
  now?: () => number;
  /** Supplier clock skew allowance before a fact is quarantined. */
  futureSkewMs?: number;
};

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1_000;
const DEFAULT_APPROVAL_LINK_MS = 10 * 60 * 1_000;
const DEFAULT_FUTURE_SKEW_MS = 2 * 60 * 1_000;
const COPY_PATH = "/api/v1/im/order-events/copy";
const PRE_SEND_PATH = "/api/v1/im/order-events/pre-send";
const TEAM_ID = /^[0-9]{1,19}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,128}$/;
const MESSAGE_ID = /^[0-9]{1,19}$/;
/** Official callbacks report REST/robot sends as client type 32; they are never human replies. */
const ROBOT_CLIENT_TYPE = "32";
type NodeRequest = AuthSecurityNodeRequest;
type NodeResponse = AuthSecurityNodeResponse;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function rawBodyOf(request: NodeRequest): Buffer | null {
  const raw = (request as { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  return null;
}
function safeEqualHex(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string" || left.length === 0 || left.length !== right.length) return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(response: NodeResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.status(status).setHeader("Cache-Control", "no-store").json(body);
}

/** Normalize an official numeric/string client source; illegal shapes stay unknown instead of silently human. */
export function normalizeClientSource(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && value.length > 0 && value.length <= 32 && /^[\x21-\x7e]+$/.test(value)) return value;
  return null;
}

/** Only a recognized non-REST client source may count as a human reply; unknown/absent fails closed. */
export function isHumanClientSource(fromClientType: string | null): boolean {
  return fromClientType !== null && fromClientType.trim() !== ROBOT_CLIENT_TYPE;
}

/** First-response tracking activates only for the App whose event ingress is mounted. */
export function orderImEventsActivateApp(orderImEvents: { appKey: string } | undefined, yunxinAppId: string | undefined): boolean {
  return Boolean(orderImEvents && yunxinAppId && orderImEvents.appKey === yunxinAppId);
}

export type SupplierSignatureFailure =
  | "missing-headers"
  | "app-mismatch"
  | "body-md5-mismatch"
  | "checksum-mismatch"
  | "malformed-curtime";

/** Signature validity and request freshness are separate: a trusted stale request is deduped or quarantined, never 403. */
export type SupplierSignatureResult = { ok: true; curTime: number; stale: boolean } | { ok: false; reason: SupplierSignatureFailure };

/** MD5 of the raw body plus CheckSum = sha1(AppSecret + MD5 + CurTime); both compared in constant time. */
export function verifySupplierRequest(input: {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  appKey: string;
  appSecret: string;
  nowMs: number;
  freshnessMs: number;
}): SupplierSignatureResult {
  const appKey = headerValue(input.headers["appkey"]);
  const curTimeRaw = headerValue(input.headers["curtime"]);
  const md5Header = headerValue(input.headers["md5"]);
  const checksumHeader = headerValue(input.headers["checksum"]);
  if (!appKey || !curTimeRaw || !md5Header || !checksumHeader) return { ok: false, reason: "missing-headers" };
  if (appKey !== input.appKey) return { ok: false, reason: "app-mismatch" };
  if (!/^\d{1,15}$/.test(curTimeRaw)) return { ok: false, reason: "malformed-curtime" };
  const curTime = Number(curTimeRaw);
  const md5 = createHash("md5").update(input.rawBody).digest("hex");
  if (!safeEqualHex(md5Header.toLowerCase(), md5)) return { ok: false, reason: "body-md5-mismatch" };
  const checksum = createHash("sha1").update(`${input.appSecret}${md5}${curTimeRaw}`).digest("hex");
  if (!safeEqualHex(checksumHeader.toLowerCase(), checksum)) return { ok: false, reason: "checksum-mismatch" };
  return { ok: true, curTime, stale: Math.abs(input.nowMs - curTime) > input.freshnessMs };
}

function numberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}
function idFromUnknown(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && MESSAGE_ID.test(value)) return value;
  return null;
}
function textFromUnknown(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

export type SupplierMessageEvent = {
  eventType: 1 | 2;
  teamId: string;
  fromAccount: string;
  msgType: string;
  messageServerId: string | null;
  messageClientId: string | null;
  occurredAt: Date;
  occurredMs: number;
  fromClientType: string | null;
  resend: boolean;
};

export type SupplierEventParse = { ok: true; event: SupplierMessageEvent } | { ok: false; reason: string };

export function parseSupplierMessageEvent(body: unknown, expected: 1 | 2): SupplierEventParse {
  if (!isRecord(body)) return { ok: false, reason: "body-not-object" };
  const eventType = numberish(body.eventType);
  if (eventType !== expected) return { ok: false, reason: "event-type-mismatch" };
  if (expected === 1 && body.convType !== "TEAM") return { ok: false, reason: "conv-type-mismatch" };
  const teamId = textFromUnknown(body.to, TEAM_ID);
  const fromAccount = textFromUnknown(body.fromAccount, ACCOUNT_ID);
  const msgType = textFromUnknown(body.msgType, /^[A-Z_]{2,20}$/);
  const occurredMs = numberish(body.msgTimestamp);
  if (!teamId || !fromAccount || !msgType || occurredMs === null) return { ok: false, reason: "missing-field" };
  const occurredAt = new Date(occurredMs);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() < Date.UTC(2000, 0, 1)) return { ok: false, reason: "invalid-timestamp" };
  const messageServerId = idFromUnknown(body.msgidServer);
  const rawClientId = body.msgidClient;
  const messageClientId = typeof rawClientId === "string" && CLIENT_ID.test(rawClientId) ? rawClientId : null;
  return {
    ok: true,
    event: {
      eventType: expected, teamId, fromAccount, msgType, messageServerId, messageClientId, occurredAt, occurredMs,
      fromClientType: normalizeClientSource(body.fromClientType),
      resend: body.resendFlag === "1" || body.resendFlag === 1,
    },
  };
}

type OrderScope = {
  orderId: string;
  appId: string;
  teamId: string;
  teamState: string;
  teamReadyAt: Date | null;
  firstResponseState: string;
  firstResponseAt: Date | null;
  orderStatus: string;
  renterUserId: string;
  ownerUserId: string;
  gameId: string;
};

const ORDER_SCOPE_SELECT = `SELECT g.order_id, g.app_id, g.team_id, g.team_state, g.team_ready_at, g.first_response_state, g.first_response_at,
    o.status AS order_status, o.renter_user_id, o.owner_user_id, o.game_id
  FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id = g.order_id`;

async function loadOrderScope(db: PoolClient, appId: string, teamId: string, lock: boolean): Promise<OrderScope | null> {
  const row = (await db.query(`${ORDER_SCOPE_SELECT} WHERE g.app_id=$1 AND g.team_id=$2${lock ? " FOR UPDATE OF g" : ""}`, [appId, teamId])).rows[0];
  if (!row) return null;
  return {
    orderId: row.order_id, appId: row.app_id, teamId: row.team_id, teamState: row.team_state,
    teamReadyAt: row.team_ready_at ?? null, firstResponseState: row.first_response_state, firstResponseAt: row.first_response_at ?? null,
    orderStatus: row.order_status, renterUserId: row.renter_user_id, ownerUserId: row.owner_user_id, gameId: row.game_id,
  };
}

async function loadMapping(db: PoolClient, appId: string, accountId: string) {
  return (await db.query(`SELECT id, realm, identity_kind, platform_subject_id, status FROM zzsh_iam.im_identity_mapping
    WHERE app_id=$1 AND account_id=$2 ORDER BY (status='READY') DESC, updated_at DESC LIMIT 1`, [appId, accountId])).rows[0] ?? null;
}

function occurredConflict(scope: OrderScope, occurred: Date, joinedAt: Date | null, nowMs: number, futureSkewMs: number): string | null {
  if (occurred.getTime() > nowMs + futureSkewMs) return "FUTURE_TIMESTAMP";
  if (scope.teamReadyAt && occurred.getTime() < scope.teamReadyAt.getTime()) return "BEFORE_TEAM_READY";
  if (joinedAt && occurred.getTime() < joinedAt.getTime()) return "BEFORE_MEMBER_JOIN";
  return null;
}

/** Minimal re-checkable authorization evidence stored with an approval; never a body or secret. */
export type ApprovalBasis = {
  basisVersion: 1;
  platformSubjectId: string;
  party: "STAFF";
  memberState: "JOINED";
  memberJoinedAt: string;
  permissions: string[];
  scope: string;
  adminStatus: "ACTIVE";
};

export function buildStaffApprovalBasis(input: { platformSubjectId: string; memberJoinedAt: Date; scope: string }): ApprovalBasis {
  return {
    basisVersion: 1,
    platformSubjectId: input.platformSubjectId,
    party: "STAFF",
    memberState: "JOINED",
    memberJoinedAt: input.memberJoinedAt.toISOString(),
    permissions: [ADMIN_PERMISSION.imSupportRead, ADMIN_PERMISSION.imSupportAccept],
    scope: input.scope,
    adminStatus: "ACTIVE",
  };
}

function basisOfMetadata(metadata: unknown): ApprovalBasis | null {
  if (!isRecord(metadata) || !isRecord(metadata.basis)) return null;
  const basis = metadata.basis;
  if (basis.basisVersion !== 1 || basis.party !== "STAFF" || basis.memberState !== "JOINED" || basis.adminStatus !== "ACTIVE") return null;
  if (typeof basis.platformSubjectId !== "string" || basis.platformSubjectId.length === 0) return null;
  if (typeof basis.memberJoinedAt !== "string" || Number.isNaN(Date.parse(basis.memberJoinedAt))) return null;
  if (typeof basis.scope !== "string" || basis.scope.length === 0) return null;
  if (!Array.isArray(basis.permissions) || !basis.permissions.every((permission) => typeof permission === "string")) return null;
  return basis as ApprovalBasis;
}

type ApprovalFact = { type: string; status: string; messageType: string | null; occurredAt: Date; metadata: unknown };

async function readApprovalFacts(db: PoolClient, appId: string, teamId: string, senderAccountId: string, messageClientId: string): Promise<ApprovalFact[]> {
  return (await db.query(`SELECT type, status, message_type, occurred_at, metadata FROM zzsh_order.im_order_event
    WHERE app_id=$1 AND team_id=$2 AND sender_account_id=$3 AND message_client_id=$4 AND type IN ('send_approved','verify_required')
    ORDER BY recorded_at, id`, [appId, teamId, senderAccountId, messageClientId])).rows.map((row) => ({
    type: row.type, status: row.status, messageType: row.message_type ?? null,
    occurredAt: new Date(row.occurred_at), metadata: row.metadata,
  }));
}

function conflictingApproval(facts: ApprovalFact[]): boolean {
  const approvals = facts.filter((fact) => fact.type === "send_approved");
  if (facts.some((fact) => fact.type === "verify_required")) return true;
  return new Set(approvals.map((fact) => `${fact.status}|${fact.messageType}|${fact.occurredAt.getTime()}`)).size > 1;
}

type DeliverySubject = {
  msgType: string;
  occurredAt: Date;
  messageClientId: string | null;
  senderAccountId: string;
  platformSubjectId: string | null;
  memberJoinedAt: Date | null;
  /** Normalized supplier client source; unknown or REST never counts as a human reply. */
  source: string | null;
};

type DeliveryDecision = { status: "WAITING_AUTH" | "VERIFIED" | "REJECTED" | "VERIFY_REQUIRED"; reason: string | null };

/**
 * The single delivery decision: source eligibility, occurrence bounds, approval status/type/time
 * relation, authorization basis and conflicting facts. Used by the copy handler, pending
 * resolution and recovery alike, so a stored fact cannot bypass a fresh one's rules.
 */
async function decideDelivery(db: PoolClient, options: OrderImEventOptions, scope: OrderScope, delivery: DeliverySubject): Promise<DeliveryDecision> {
  if (!isHumanClientSource(delivery.source)) return { status: "VERIFY_REQUIRED", reason: "SOURCE_NOT_HUMAN" };
  const now = (await db.query(`SELECT clock_timestamp() AS now`)).rows[0].now as Date;
  const conflict = occurredConflict(scope, delivery.occurredAt, delivery.memberJoinedAt, now.getTime(), options.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS);
  if (conflict) return { status: "VERIFY_REQUIRED", reason: conflict };
  if (!delivery.messageClientId) return { status: "WAITING_AUTH", reason: "MISSING_CLIENT_ID" };
  const facts = await readApprovalFacts(db, scope.appId, scope.teamId, delivery.senderAccountId, delivery.messageClientId);
  if (conflictingApproval(facts)) return { status: "VERIFY_REQUIRED", reason: "APPROVAL_CONFLICT" };
  const approvals = facts.filter((fact) => fact.type === "send_approved");
  if (approvals.length === 0) return { status: "WAITING_AUTH", reason: "APPROVAL_PENDING" };
  const approval = approvals[0]!;
  if (approval.status === "REJECTED") return { status: "REJECTED", reason: "SEND_REJECTED" };
  if (approval.messageType !== delivery.msgType) return { status: "VERIFY_REQUIRED", reason: "APPROVAL_MESSAGE_MISMATCH" };
  const linkMs = options.approvalLinkMs ?? DEFAULT_APPROVAL_LINK_MS;
  if (Math.abs(approval.occurredAt.getTime() - delivery.occurredAt.getTime()) > linkMs) {
    return { status: "VERIFY_REQUIRED", reason: "APPROVAL_TIME_MISMATCH" };
  }
  const basis = basisOfMetadata(approval.metadata);
  if (!basis) return { status: "VERIFY_REQUIRED", reason: "APPROVAL_BASIS_MISSING" };
  if (basis.platformSubjectId !== delivery.platformSubjectId
    || !basis.permissions.includes(ADMIN_PERMISSION.imSupportRead) || !basis.permissions.includes(ADMIN_PERMISSION.imSupportAccept)
    || Date.parse(basis.memberJoinedAt) > delivery.occurredAt.getTime()) {
    return { status: "VERIFY_REQUIRED", reason: "APPROVAL_BASIS_INVALID" };
  }
  return { status: "VERIFIED", reason: null };
}

async function insertEvent(db: PoolClient, input: {
  orderId: string; appId: string; teamId: string; eventKey: string; type: string; status: string; actor: string | null;
  messageClientId: string | null; messageServerId: string | null; senderAccountId: string; messageType: string | null;
  occurredAt: Date; rawBodySha256: string; metadata: JsonRecord;
}): Promise<string | null> {
  const id = `im_order_evt_${randomUUID().replaceAll("-", "")}`;
  const result = await db.query(`INSERT INTO zzsh_order.im_order_event
    (id,order_id,app_id,team_id,event_key,type,status,actor,message_client_id,message_server_id,sender_account_id,message_type,occurred_at,raw_body_sha256,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
    ON CONFLICT DO NOTHING`, [
    id, input.orderId, input.appId, input.teamId, input.eventKey, input.type, input.status, input.actor,
    input.messageClientId, input.messageServerId, input.senderAccountId, input.messageType, input.occurredAt, input.rawBodySha256, JSON.stringify(input.metadata),
  ]);
  return result.rowCount === 1 ? id : null;
}

async function quarantineGroupState(db: PoolClient, scope: OrderScope, actor: string): Promise<boolean> {
  const changed = await db.query(`UPDATE zzsh_order.im_order_group SET first_response_state='VERIFY_REQUIRED', version=version+1
    WHERE order_id=$1 AND app_id=$2 AND first_response_state='RUNNING'`, [scope.orderId, scope.appId]);
  return changed.rowCount === 1;
}

async function auditVerifyRequired(db: PoolClient, scope: OrderScope, reason: string, actor: string, groupStateChanged: boolean): Promise<void> {
  await recordAudit(db, { actorType: "system", actorId: actor, action: "im.order.first_response.verify_required",
    objectType: "rental_order", objectId: scope.orderId, outcome: "FAILURE", requestId: `im_event_${scope.orderId}`, reason,
    details: { appId: scope.appId, teamId: scope.teamId, groupStateChanged } });
}

async function insertVerifyEvent(db: PoolClient, scope: OrderScope, event: SupplierMessageEvent, reason: string, rawBodySha256: string): Promise<string | null> {
  // The marker records any conflicting event, so a non-reply type is stored as unknown rather
  // than rejected by the message_type whitelist.
  const messageType = event.msgType === "TEXT" || event.msgType === "PICTURE" ? event.msgType : null;
  return insertEvent(db, {
    orderId: scope.orderId, appId: scope.appId, teamId: scope.teamId,
    eventKey: `verify_required:${scope.teamId}:${event.messageServerId ?? event.messageClientId ?? reason}`,
    type: "verify_required", status: "VERIFY_REQUIRED", actor: event.fromAccount,
    messageClientId: event.messageClientId, messageServerId: event.messageServerId, senderAccountId: event.fromAccount,
    messageType, occurredAt: event.occurredAt, rawBodySha256, metadata: { reason },
  });
}

/**
 * Conflicting key facts block automatic confirmation. Repeated identical conflicts reuse the
 * existing marker row, so neither evidence nor audit grows without a new distinct fact.
 */
async function recordConflictEvidence(db: PoolClient, scope: OrderScope, event: SupplierMessageEvent, reason: string, rawBodySha256: string): Promise<boolean> {
  const marker = await insertVerifyEvent(db, scope, event, reason, rawBodySha256);
  if (!marker) return false;
  const changed = await quarantineGroupState(db, scope, event.fromAccount);
  await auditVerifyRequired(db, scope, reason, event.fromAccount, changed);
  return true;
}

type ExistingDelivery = {
  id: string; status: string; sender_account_id: string; occurred_at: string;
  message_client_id: string | null; message_type: string | null; metadata: unknown;
};

/** A duplicate delivery must match the original trusted key fields; resend flags and wrappers are not key fields. */
function conflictingDelivery(existing: ExistingDelivery, event: SupplierMessageEvent): boolean {
  const existingSource = isRecord(existing.metadata) && typeof existing.metadata.source === "string" ? existing.metadata.source : null;
  return existing.sender_account_id !== event.fromAccount
    || new Date(existing.occurred_at).getTime() !== event.occurredAt.getTime()
    || (existing.message_client_id ?? null) !== (event.messageClientId ?? null)
    || (existing.message_type ?? null) !== event.msgType
    || existingSource !== (event.fromClientType ?? null);
}

/** Earliest verified human event wins; a later earlier fact may only move the pointer earlier. */
async function applyFirstResponse(db: PoolClient, scope: OrderScope, delivery: {
  messageServerId: string; messageClientId: string | null; senderAccountId: string; occurredAt: Date; rawBodySha256: string;
}): Promise<"CONFIRMED" | "ADVANCED" | "IGNORED"> {
  const current = (await db.query(`SELECT first_response_state, first_response_at FROM zzsh_order.im_order_group
    WHERE order_id=$1 AND app_id=$2 FOR UPDATE`, [scope.orderId, scope.appId])).rows[0];
  if (!current) return "IGNORED";
  if (current.first_response_state === "STOPPED" && current.first_response_at && delivery.occurredAt.getTime() >= new Date(current.first_response_at).getTime()) return "IGNORED";
  const advanced = current.first_response_state === "STOPPED";
  const eventId = await insertEvent(db, {
    orderId: scope.orderId, appId: scope.appId, teamId: scope.teamId,
    eventKey: `first_response:${scope.teamId}:${delivery.messageServerId}`, type: "first_response", status: "VERIFIED",
    actor: delivery.senderAccountId, messageClientId: delivery.messageClientId, messageServerId: delivery.messageServerId,
    senderAccountId: delivery.senderAccountId, messageType: null, occurredAt: delivery.occurredAt, rawBodySha256: delivery.rawBodySha256,
    metadata: advanced ? { previousAt: current.first_response_at } : {},
  });
  if (!eventId) return "IGNORED";
  await db.query(`UPDATE zzsh_order.im_order_group SET first_response_event_id=$3, first_response_at=$4, first_response_state='STOPPED', version=version+1
    WHERE order_id=$1 AND app_id=$2`, [scope.orderId, scope.appId, eventId, delivery.occurredAt]);
  await recordAudit(db, { actorType: "admin", actorId: delivery.senderAccountId,
    action: advanced ? "im.order.first_response.advanced" : "im.order.first_response.confirmed",
    objectType: "rental_order", objectId: scope.orderId, outcome: "SUCCESS", requestId: `im_event_${scope.orderId}`,
    details: { appId: scope.appId, teamId: scope.teamId, messageServerId: delivery.messageServerId, occurredAt: delivery.occurredAt.toISOString() } });
  return advanced ? "ADVANCED" : "CONFIRMED";
}

async function handleCopyDelivery(options: OrderImEventOptions, event: SupplierMessageEvent, rawBodySha256: string, staleRequest: boolean): Promise<"ignored" | "stored" | "duplicate"> {
  const messageServerId = event.messageServerId;
  if (!messageServerId) return "ignored";
  return withTransaction(options.pool, async (db) => {
    const scope = await loadOrderScope(db, options.appId, event.teamId, true);
    if (!scope || scope.teamState !== "READY" || scope.firstResponseState === "NOT_STARTED") return "ignored";
    // A stable delivery key already exists: its trusted key fields are compared before any
    // "not countable" rule, so a second event that is non-human, non-reply or from another
    // sender cannot bypass the conflict check and leave the original pending fact open.
    const existing = (await db.query(`SELECT id, status, sender_account_id, occurred_at::text, message_client_id, message_type, metadata
      FROM zzsh_order.im_order_event WHERE type='message_delivered' AND app_id=$1 AND team_id=$2 AND message_server_id=$3`,
    [scope.appId, scope.teamId, messageServerId])).rows[0] as ExistingDelivery | undefined;
    if (existing) {
      if (conflictingDelivery(existing, event)) {
        // The pending fact itself is quarantined, so no later approval or recovery can auto-confirm it.
        if (existing.status === "WAITING_AUTH") {
          await db.query(`UPDATE zzsh_order.im_order_event SET status='VERIFY_REQUIRED' WHERE id=$1 AND status='WAITING_AUTH'`, [existing.id]);
        }
        await recordConflictEvidence(db, scope, event, "DELIVERY_FIELD_CONFLICT", rawBodySha256);
      }
      return "duplicate";
    }
    // Only a countable human reply opens a new delivery fact; every other source stays ignored.
    if (event.msgType !== "TEXT" && event.msgType !== "PICTURE") return "ignored";
    if (!isHumanClientSource(event.fromClientType)) return "ignored";
    // A known App identity is enough to keep a trusted delivery: the decision below judges it by
    // the approval basis and member timeline instead of the current mapping status.
    const mapping = await loadMapping(db, options.appId, event.fromAccount);
    if (!mapping || mapping.identity_kind !== "ADMIN") return "ignored";
    const member = (await db.query(`SELECT state, joined_at FROM zzsh_order.im_order_member
      WHERE order_id=$1 AND identity_id=$2`, [scope.orderId, mapping.id])).rows[0];
    if (!member || member.state !== "JOINED") return "ignored";
    // A trusted but stale request is restricted verification, never a silent first response.
    const decision: DeliveryDecision = staleRequest
      ? { status: "VERIFY_REQUIRED", reason: "STALE_REQUEST" }
      : await decideDelivery(db, options, scope, {
        msgType: event.msgType, occurredAt: event.occurredAt, messageClientId: event.messageClientId,
        senderAccountId: event.fromAccount, platformSubjectId: mapping.platform_subject_id, memberJoinedAt: member.joined_at ?? null,
        source: event.fromClientType,
      });
    const inserted = await insertEvent(db, {
      orderId: scope.orderId, appId: scope.appId, teamId: scope.teamId,
      eventKey: `message_delivered:${scope.teamId}:${messageServerId}`, type: "message_delivered", status: decision.status,
      actor: event.fromAccount, messageClientId: event.messageClientId, messageServerId: messageServerId,
      senderAccountId: event.fromAccount, messageType: event.msgType, occurredAt: event.occurredAt, rawBodySha256,
      metadata: { ...(decision.reason ? { reason: decision.reason } : {}), source: event.fromClientType },
    });
    if (!inserted) return "duplicate";
    if (decision.status === "VERIFY_REQUIRED") {
      // The delivery row itself is the quarantined fact; only the group state changes.
      const changed = await quarantineGroupState(db, scope, event.fromAccount);
      if (changed) await auditVerifyRequired(db, scope, decision.reason ?? "DELIVERY_VERIFY_REQUIRED", event.fromAccount, changed);
      return "stored";
    }
    if (decision.status === "VERIFIED") {
      await applyFirstResponse(db, scope, {
        messageServerId, messageClientId: event.messageClientId,
        senderAccountId: event.fromAccount, occurredAt: event.occurredAt, rawBodySha256,
      });
    }
    return "stored";
  });
}

async function handleCopy(request: NodeRequest, response: NodeResponse, options: OrderImEventOptions): Promise<void> {
  const rawBody = rawBodyOf(request);
  if (!rawBody) { send(response, 503, { error: "callback body unavailable" }); return; }
  const verified = verifySupplierRequest({
    rawBody, headers: request.headers, appKey: options.appId, appSecret: options.appSecret,
    nowMs: (options.now ?? Date.now)(), freshnessMs: options.freshnessMs ?? DEFAULT_FRESHNESS_MS,
  });
  if (!verified.ok) { send(response, 403, { error: "callback signature rejected" }); return; }
  let parsed: JsonRecord;
  try { parsed = JSON.parse(rawBody.toString("utf8")) as JsonRecord; } catch { send(response, 400, { error: "callback body invalid" }); return; }
  const event = parseSupplierMessageEvent(parsed, 1);
  if (!event.ok) { send(response, 400, { error: "callback event invalid" }); return; }
  const rawBodySha256 = createHash("sha256").update(rawBody).digest("hex");
  try {
    await handleCopyDelivery(options, event.event, rawBodySha256, verified.stale);
    send(response, 200, { ok: true });
  } catch {
    // Copy ACKs treat 200 and 500 as success; a persistence failure must not be acknowledged.
    send(response, 503, { error: "callback persistence unavailable" });
  }
}

type ScopeDecision = { allow: boolean; reason: string; orderId: string | null; staffCandidate?: boolean; basis?: ApprovalBasis };

async function decideOrderPreSend(db: PoolClient, options: OrderImEventOptions, scope: OrderScope, event: SupplierMessageEvent): Promise<ScopeDecision> {
  if (event.msgType !== "TEXT" && event.msgType !== "PICTURE") return { allow: false, reason: "UNSUPPORTED_MESSAGE_TYPE", orderId: scope.orderId };
  const mapping = await loadMapping(db, options.appId, event.fromAccount);
  if (!mapping || mapping.status !== "READY") return { allow: false, reason: "UNKNOWN_SENDER", orderId: scope.orderId };
  const member = (await db.query(`SELECT party, state, joined_at FROM zzsh_order.im_order_member WHERE order_id=$1 AND identity_id=$2`, [scope.orderId, mapping.id])).rows[0];
  if (!member || member.state !== "JOINED") return { allow: false, reason: "NOT_A_MEMBER", orderId: scope.orderId };
  if (mapping.identity_kind === "USER") {
    const isParty = (member.party === "BUYER" && mapping.platform_subject_id === scope.renterUserId)
      || (member.party === "OWNER" && mapping.platform_subject_id === scope.ownerUserId);
    if (!isParty) return { allow: false, reason: "PARTY_MISMATCH", orderId: scope.orderId };
    try {
      await assertActiveInTransaction(db, mapping.platform_subject_id);
    } catch (error) {
      if (error instanceof SecurityApiError) return { allow: false, reason: "USER_UNAVAILABLE", orderId: scope.orderId };
      throw error;
    }
    return { allow: true, reason: "ORDER_PARTY", orderId: scope.orderId };
  }
  if (mapping.identity_kind !== "ADMIN" || member.party !== "STAFF") return { allow: false, reason: "NOT_A_STAFF_MEMBER", orderId: scope.orderId };
  const staffCandidate = true;
  const admin = (await db.query(`SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1`, [mapping.platform_subject_id])).rows[0];
  if (!admin || admin.suspended) return { allow: false, reason: "ADMIN_UNAVAILABLE", orderId: scope.orderId, staffCandidate };
  const access = await loadEffectiveAdminAccess(db, mapping.platform_subject_id);
  if (!access || access.status !== "ACTIVE" || !hasPermission(access, ADMIN_PERMISSION.imSupportRead) || !hasPermission(access, ADMIN_PERMISSION.imSupportAccept)) {
    return { allow: false, reason: "PERMISSION_REQUIRED", orderId: scope.orderId, staffCandidate };
  }
  let scopeRef: string | null = "BOSS";
  if (!access.isBoss) {
    const scoped = (await db.query(`SELECT 1 FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 AND game_id=$2`, [mapping.platform_subject_id, scope.gameId])).rowCount;
    if (!scoped) return { allow: false, reason: "SCOPE_REQUIRED", orderId: scope.orderId, staffCandidate };
    scopeRef = scope.gameId;
  }
  if (!member.joined_at) return { allow: false, reason: "MEMBER_NOT_JOINED", orderId: scope.orderId, staffCandidate };
  // Availability/connection gate new dispatch only; an already JOINED staff member may still reply.
  return {
    allow: true, reason: "JOINED_STAFF", orderId: scope.orderId, staffCandidate,
    basis: buildStaffApprovalBasis({ platformSubjectId: mapping.platform_subject_id, memberJoinedAt: new Date(member.joined_at), scope: scopeRef }),
  };
}

async function decideConsultationPreSend(db: PoolClient, options: OrderImEventOptions, event: SupplierMessageEvent): Promise<ScopeDecision> {
  const consultation = (await db.query(`SELECT id, kind, state, message_scope_state, assigned_admin_id, user_id FROM zzsh_iam.im_consultation
    WHERE app_id=$1 AND message_scope_id=$2`, [options.appId, event.teamId])).rows[0];
  if (!consultation || consultation.state !== "ACTIVE" || consultation.message_scope_state !== "READY") {
    return { allow: false, reason: "UNKNOWN_SCOPE", orderId: null };
  }
  const mapping = await loadMapping(db, options.appId, event.fromAccount);
  if (!mapping || mapping.status !== "READY") return { allow: false, reason: "UNKNOWN_SENDER", orderId: null };
  if (mapping.identity_kind === "USER") {
    if (mapping.platform_subject_id !== consultation.user_id) return { allow: false, reason: "PARTY_MISMATCH", orderId: null };
    try {
      await assertActiveInTransaction(db, consultation.user_id);
    } catch (error) {
      if (error instanceof SecurityApiError) return { allow: false, reason: "USER_UNAVAILABLE", orderId: null };
      throw error;
    }
    return { allow: true, reason: "CONSULTATION_USER", orderId: null };
  }
  if (mapping.identity_kind === "ADMIN" && mapping.platform_subject_id === consultation.assigned_admin_id) {
    const admin = (await db.query(`SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1`, [mapping.platform_subject_id])).rows[0];
    if (!admin || admin.suspended) return { allow: false, reason: "ADMIN_UNAVAILABLE", orderId: null };
    const access = await loadEffectiveAdminAccess(db, mapping.platform_subject_id);
    try { requireSupportAccess(access, consultation.kind as SupportType); }
    catch { return { allow: false, reason: "PERMISSION_REQUIRED", orderId: null }; }
    return { allow: true, reason: "ASSIGNED_ADMIN", orderId: null };
  }
  return { allow: false, reason: "NOT_ASSIGNED", orderId: null };
}

async function persistApproval(db: PoolClient, options: OrderImEventOptions, scope: OrderScope, event: SupplierMessageEvent,
  decision: ScopeDecision, rawBodySha256: string): Promise<void> {
  if (!event.messageClientId || !decision.staffCandidate) return;
  const status = decision.allow ? "VERIFIED" : "REJECTED";
  const inserted = await insertEvent(db, {
    orderId: scope.orderId, appId: scope.appId, teamId: scope.teamId,
    eventKey: `send_approved:${scope.teamId}:${event.fromAccount}:${event.messageClientId}`, type: "send_approved", status,
    actor: event.fromAccount, messageClientId: event.messageClientId, messageServerId: null, senderAccountId: event.fromAccount,
    messageType: event.msgType, occurredAt: event.occurredAt, rawBodySha256,
    metadata: { reason: decision.reason, fromClientType: event.fromClientType, ...(decision.basis ? { basis: decision.basis } : {}) },
  });
  if (!inserted) {
    const existing = (await db.query(`SELECT status, message_type, occurred_at::text FROM zzsh_order.im_order_event
      WHERE type='send_approved' AND app_id=$1 AND team_id=$2 AND sender_account_id=$3 AND message_client_id=$4`,
    [scope.appId, scope.teamId, event.fromAccount, event.messageClientId])).rows[0];
    if (existing && (existing.status !== status || existing.message_type !== event.msgType
      || new Date(existing.occurred_at).getTime() !== event.occurredAt.getTime())) {
      await recordConflictEvidence(db, scope, event, "APPROVAL_FIELD_CONFLICT", rawBodySha256);
    }
    return;
  }
  await resolvePendingDeliveries(db, options, scope, event.fromAccount, event.messageClientId);
}

/** Pending deliveries converge through the same decision that a fresh copy would take. */
async function resolvePendingDeliveries(db: PoolClient, options: OrderImEventOptions, scope: OrderScope,
  senderAccountId: string, messageClientId: string): Promise<number> {
  const pending = (await db.query(`SELECT id, message_server_id, message_client_id, message_type, sender_account_id, occurred_at, raw_body_sha256, metadata
    FROM zzsh_order.im_order_event
    WHERE type='message_delivered' AND status='WAITING_AUTH' AND app_id=$1 AND team_id=$2 AND sender_account_id=$3 AND message_client_id=$4
    FOR UPDATE`, [scope.appId, scope.teamId, senderAccountId, messageClientId])).rows;
  let resolved = 0;
  for (const row of pending) {
    const mapping = await loadMapping(db, scope.appId, row.sender_account_id);
    const member = mapping ? (await db.query(`SELECT state, joined_at FROM zzsh_order.im_order_member WHERE order_id=$1 AND identity_id=$2`, [scope.orderId, mapping.id])).rows[0] : null;
    const decision = await decideDelivery(db, options, scope, {
      msgType: row.message_type, occurredAt: new Date(row.occurred_at), messageClientId: row.message_client_id,
      senderAccountId: row.sender_account_id, platformSubjectId: mapping?.platform_subject_id ?? null, memberJoinedAt: member?.joined_at ?? null,
      source: deliverySourceOf(row.metadata),
    });
    if (decision.status === "WAITING_AUTH") continue;
    await db.query(`UPDATE zzsh_order.im_order_event SET status=$2 WHERE id=$1 AND status='WAITING_AUTH'`, [row.id, decision.status]);
    if (decision.status === "VERIFIED") {
      await applyFirstResponse(db, scope, {
        messageServerId: row.message_server_id, messageClientId: row.message_client_id, senderAccountId: row.sender_account_id,
        occurredAt: new Date(row.occurred_at), rawBodySha256: row.raw_body_sha256,
      });
    } else if (decision.status === "VERIFY_REQUIRED") {
      const changed = await quarantineGroupState(db, scope, row.sender_account_id);
      if (changed) await auditVerifyRequired(db, scope, decision.reason ?? "DELIVERY_VERIFY_REQUIRED", row.sender_account_id, changed);
    }
    resolved += 1;
  }
  return resolved;
}

function deliverySourceOf(metadata: unknown): string | null {
  return isRecord(metadata) && typeof metadata.source === "string" ? metadata.source : null;
}

/**
 * Qualification locks (the user subject) come before the order group, matching the existing
 * user→group order used by dispatch and team paths. Returns false when the subject is unavailable.
 */
async function lockQualificationSubject(db: PoolClient, appId: string, fromAccount: string): Promise<boolean> {
  const mapping = await loadMapping(db, appId, fromAccount);
  if (!mapping || mapping.status !== "READY" || mapping.identity_kind !== "USER") return true;
  try {
    await assertActiveInTransaction(db, mapping.platform_subject_id);
    return true;
  } catch (error) {
    if (error instanceof SecurityApiError) return false;
    throw error;
  }
}

async function handlePreSendDecision(options: OrderImEventOptions, event: SupplierMessageEvent, rawBodySha256: string, staleRequest: boolean): Promise<ScopeDecision> {
  return withTransaction(options.pool, async (db) => {
    // Locate without locks first: a stale request is denied before any qualification/group lock.
    const located = await loadOrderScope(db, options.appId, event.teamId, false);
    if (located) {
      if (located.teamState !== "READY") return { allow: false, reason: "UNKNOWN_SCOPE", orderId: located.orderId };
      // A pre-send decides whether this send may happen now: an expired signature never replays
      // an old allow, and it never creates a new linkable approval.
      if (staleRequest) return { allow: false, reason: "STALE_REQUEST", orderId: located.orderId };
      if (!(await lockQualificationSubject(db, options.appId, event.fromAccount))) {
        return { allow: false, reason: "USER_UNAVAILABLE", orderId: located.orderId };
      }
      const scope = await loadOrderScope(db, options.appId, event.teamId, true);
      if (!scope || scope.teamState !== "READY") return { allow: false, reason: "UNKNOWN_SCOPE", orderId: located.orderId };
      // NOT_STARTED only disables first-response tracking; existing chat contracts still apply.
      const decision = await decideOrderPreSend(db, options, scope, event);
      if (scope.firstResponseState !== "NOT_STARTED") await persistApproval(db, options, scope, event, decision, rawBodySha256);
      if (!decision.allow) {
        await recordAudit(db, { actorType: "system", actorId: event.fromAccount, action: "im.order.send.rejected",
          objectType: "rental_order", objectId: scope.orderId, outcome: "FAILURE", requestId: `im_event_${scope.orderId}`,
          reason: decision.reason, details: { appId: options.appId, teamId: event.teamId } });
      }
      return decision;
    }
    if (staleRequest) return { allow: false, reason: "STALE_REQUEST", orderId: null };
    const decision = await decideConsultationPreSend(db, options, event);
    if (!decision.allow) {
      await recordAudit(db, { actorType: "system", actorId: event.fromAccount, action: "im.consultation.send.rejected",
        objectType: "im_consultation", outcome: "FAILURE", requestId: `im_event_${event.teamId}`, reason: decision.reason,
        details: { appId: options.appId, teamId: event.teamId } });
    }
    return decision;
  });
}

async function handlePreSend(request: NodeRequest, response: NodeResponse, options: OrderImEventOptions): Promise<void> {
  const deny = (reason: string) => send(response, 200, { errCode: 1, responseCode: 20001, callbackExt: reason.slice(0, 64) });
  const rawBody = rawBodyOf(request);
  if (!rawBody) { send(response, 400, { error: "callback body unavailable" }); return; }
  const verified = verifySupplierRequest({
    rawBody, headers: request.headers, appKey: options.appId, appSecret: options.appSecret,
    nowMs: (options.now ?? Date.now)(), freshnessMs: options.freshnessMs ?? DEFAULT_FRESHNESS_MS,
  });
  // Never answer responseCode=200: an invalid request must not look delivered to the client.
  if (!verified.ok) { deny(`SIGNATURE_${verified.reason}`); return; }
  let parsed: JsonRecord;
  try { parsed = JSON.parse(rawBody.toString("utf8")) as JsonRecord; } catch { send(response, 400, { error: "callback body invalid" }); return; }
  const event = parseSupplierMessageEvent(parsed, 2);
  if (!event.ok) { deny(`EVENT_${event.reason}`); return; }
  const rawBodySha256 = createHash("sha256").update(rawBody).digest("hex");
  try {
    const decision = await handlePreSendDecision(options, event.event, rawBodySha256, verified.stale);
    if (decision.allow) send(response, 200, { errCode: 0 });
    else deny(decision.reason);
  } catch {
    deny("PERSISTENCE_UNAVAILABLE");
  }
}

export type FirstResponseRecoveryCursor = { recordedAt: string; id: string };

export type FirstResponseRecoverySummary = {
  scanned: number;
  resolved: number;
  deferred: number;
  failed: number;
  failures: Record<string, number>;
  /** Continue after this key on the next sweep; null means the tail window completed and the next run may wrap. */
  nextCursor: FirstResponseRecoveryCursor | null;
};

export type FirstResponseRecoveryBounds = {
  limit?: number;
  maxTotal?: number;
  cursor?: FirstResponseRecoveryCursor | null;
  onFailure?: (failure: { reason: string; orderId: string }) => void;
};

function recoveryFailureClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "55P03") return "LOCK_BUSY";
  if (code === "40P01") return "DEADLOCK";
  if (code === "40001") return "EVIDENCE_GUARD";
  if (code === "42501") return "PRIVILEGE";
  if (["23503", "23505", "23514"].includes(String(code))) return "OBJECT_CONSTRAINT";
  if (error instanceof SecurityApiError) return "AUTHORIZATION";
  return "UNKNOWN";
}

/**
 * Bounded, keyset-paginated recovery for WAITING_AUTH deliveries: facts are re-read inside
 * the row lock and every row is decided by the same function the copy handler uses. A
 * failing or busy head cannot starve later facts, the returned cursor advances across
 * sweeps instead of rescanning a permanent prefix, and the scanned count never exceeds
 * the remaining budget.
 */
export async function recoverOrderFirstResponse(options: OrderImEventOptions, bounds: FirstResponseRecoveryBounds = {}): Promise<FirstResponseRecoverySummary> {
  const limit = Math.min(Math.max(bounds.limit ?? 20, 1), 100);
  const maxTotal = Math.min(Math.max(bounds.maxTotal ?? 200, 1), 1000);
  const summary: FirstResponseRecoverySummary = { scanned: 0, resolved: 0, deferred: 0, failed: 0, failures: {}, nextCursor: null };
  type RecoveryRow = {
    id: string; order_id: string; team_id: string; message_server_id: string; message_client_id: string | null;
    message_type: string; sender_account_id: string; occurred_at: Date; raw_body_sha256: string; metadata: unknown; recorded_at: string;
  };
  let cursor: FirstResponseRecoveryCursor | null = bounds.cursor ?? null;
  let completedTail = false;
  while (summary.scanned < maxTotal) {
    const pageSize = Math.min(limit, maxTotal - summary.scanned);
    const batch: RecoveryRow[] = (await options.pool.query(`SELECT id, order_id, team_id, message_server_id, message_client_id, message_type,
        sender_account_id, occurred_at, raw_body_sha256, metadata, recorded_at::text
      FROM zzsh_order.im_order_event
      WHERE type='message_delivered' AND status='WAITING_AUTH' AND app_id=$1
        AND ($3::text IS NULL OR (recorded_at, id) > ($3::timestamptz, $4::text))
      ORDER BY recorded_at, id LIMIT $2`, [options.appId, pageSize, cursor?.recordedAt ?? null, cursor?.id ?? null])).rows;
    if (batch.length === 0) {
      completedTail = true;
      break;
    }
    for (const row of batch) {
      summary.scanned += 1;
      cursor = { recordedAt: row.recorded_at, id: row.id };
      try {
        const outcome = await withTransaction(options.pool, async (db) => {
          const scope = await loadOrderScope(db, options.appId, row.team_id, true);
          if (!scope || scope.teamState !== "READY" || scope.firstResponseState === "NOT_STARTED") return "deferred";
          const mapping = await loadMapping(db, options.appId, row.sender_account_id);
          const member = mapping ? (await db.query(`SELECT state, joined_at FROM zzsh_order.im_order_member WHERE order_id=$1 AND identity_id=$2`, [scope.orderId, mapping.id])).rows[0] : null;
          const decision = await decideDelivery(db, options, scope, {
            msgType: row.message_type, occurredAt: new Date(row.occurred_at), messageClientId: row.message_client_id,
            senderAccountId: row.sender_account_id, platformSubjectId: mapping?.platform_subject_id ?? null, memberJoinedAt: member?.joined_at ?? null,
            source: deliverySourceOf(row.metadata),
          });
          if (decision.status === "WAITING_AUTH") return "deferred";
          await db.query(`UPDATE zzsh_order.im_order_event SET status=$2 WHERE id=$1 AND status='WAITING_AUTH'`, [row.id, decision.status]);
          if (decision.status === "VERIFIED") {
            await applyFirstResponse(db, scope, {
              messageServerId: row.message_server_id, messageClientId: row.message_client_id, senderAccountId: row.sender_account_id,
              occurredAt: new Date(row.occurred_at), rawBodySha256: row.raw_body_sha256,
            });
          } else if (decision.status === "VERIFY_REQUIRED") {
            const changed = await quarantineGroupState(db, scope, row.sender_account_id);
            if (changed) await auditVerifyRequired(db, scope, decision.reason ?? "DELIVERY_VERIFY_REQUIRED", row.sender_account_id, changed);
          }
          return "resolved";
        });
        if (outcome === "resolved") summary.resolved += 1;
        else summary.deferred += 1;
      } catch (error) {
        const reason = recoveryFailureClass(error);
        summary.failed += 1;
        summary.failures[reason] = (summary.failures[reason] ?? 0) + 1;
        bounds.onFailure?.({ reason, orderId: row.order_id });
      }
    }
    if (batch.length < pageSize) {
      completedTail = true;
      break;
    }
  }
  summary.nextCursor = completedTail ? null : cursor;
  return summary;
}

@Injectable()
export class OrderImEventRecoveryLifecycle implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OrderImEventRecoveryLifecycle.name);
  private options?: OrderImEventOptions;
  private bounds: Pick<FirstResponseRecoveryBounds, "limit" | "maxTotal"> = {};
  private cursor?: FirstResponseRecoveryCursor;
  private timer?: NodeJS.Timeout;
  private flight?: Promise<void>;

  start(options: OrderImEventOptions, intervalMs = 30_000, bounds: Pick<FirstResponseRecoveryBounds, "limit" | "maxTotal"> = {}): void {
    if (this.options) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error("recovery interval must be an integer of at least 1000ms");
    this.options = options;
    this.bounds = bounds;
    this.timer = setInterval(() => this.wake(), intervalMs);
    this.timer.unref?.();
    this.wake();
  }

  wake(): void {
    const options = this.options;
    if (!options || this.flight) return;
    // The cursor advances across sweeps so a permanent pending prefix is not rescanned every
    // wake; a completed tail window wraps back to the start on the next run.
    const work = recoverOrderFirstResponse(options, {
      ...this.bounds,
      cursor: this.cursor ?? null,
      onFailure: (failure) => this.logger.error(JSON.stringify({ event: "im.order.first_response.recovery_failed", ...failure })),
    }).then((summary) => {
      this.cursor = summary.nextCursor ?? undefined;
      if (summary.failed) this.logger.error(JSON.stringify({ event: "im.order.first_response.recovery_partial", ...summary }));
    }).catch((error: unknown) => {
      this.logger.error(JSON.stringify({ event: "im.order.first_response.recovery_aborted", reason: recoveryFailureClass(error) }));
    });
    const clear = () => { if (this.flight === settled) this.flight = undefined; };
    const settled = work.then(clear, clear);
    this.flight = settled;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.options = undefined;
    if (this.timer) clearInterval(this.timer);
    await this.flight;
  }
}

/** Narrow verification adapter: server-derived App/Team/SYSTEM operator and one explicit message ID. */
export async function readOrderTeamMessageFact(pool: Pool, provider: YunxinServerApi, input: {
  appId: string; orderId: string; messageServerId: string; messageTime?: number;
}): Promise<YunxinTeamMessageFact | null> {
  const row = (await pool.query(`SELECT g.team_id, m.account_id, m.status FROM zzsh_order.im_order_group g
    JOIN zzsh_iam.im_identity_mapping m ON m.app_id=g.app_id AND m.realm='system' AND m.identity_kind='SYSTEM' AND m.platform_subject_id='support-manager'
    WHERE g.app_id=$1 AND g.order_id=$2 AND g.team_state='READY'`, [input.appId, input.orderId])).rows[0];
  if (!row || row.status !== "READY") return null;
  return provider.readTeamMessage({ teamId: row.team_id, operatorAccountId: row.account_id, messageServerId: input.messageServerId, messageTime: input.messageTime });
}

export function mountOrderImEventHandlers(app: INestApplication, options: OrderImEventOptions): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    use: (path: string, middleware: (request: NodeRequest, response: NodeResponse) => Promise<void>) => void;
  };
  expressApp.use(COPY_PATH, (request, response) => handleCopy(request, response, options));
  expressApp.use(PRE_SEND_PATH, (request, response) => handlePreSend(request, response, options));
}
