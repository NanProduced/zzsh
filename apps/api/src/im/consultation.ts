import { createImScopeLease, onLeaseConnection, lockTeamBinding, type ScopeLease } from "./scope-lease";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Injectable, Logger, type BeforeApplicationShutdown } from "@nestjs/common";

import {
  ADMIN_PERMISSION,
  hasPermission,
  loadEffectiveAdminAccess,
  type EffectiveAdminAccess,
} from "../auth/admin-authorization";
import { assertAdminContextInTransaction, type AdminContext } from "../auth/auth-security";
import { recordAudit, SecurityApiError, setAuditContext, withTransaction } from "../auth/security-core";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  normalizeImIdentityKey,
  type ImIdentityProvisionInput,
  type ImIdentityProvisioner,
  type ImIdentityKey,
  type ImProvisionResult,
} from "./identity-lifecycle";
import {
  YunxinApiError,
  YunxinTransportError,
  supportMarkerMatches,
  type YunxinSupportScopeApi,
  type YunxinSupportTeamExistenceLookup,
  type YunxinSupportTeamLookup,
  type YunxinSupportTeamState,
} from "./yunxin-provider";
import type { ImMessageTransport } from "./im-contract";
import { lockDispatchGate, lockSupportMutation, readEligibleSupport, reserveSupportCandidate, type LockedSupportRoster } from "./support-dispatch";
import { assignWaitingOrders } from "./order-dispatch";

export type SupportType = "SERVICE" | "COMPLAINT";
export type ConsultationState = "WAITING" | "ACTIVE" | "CLOSED";
export type SupportAvailability = "OFF_DUTY" | "AVAILABLE" | "PAUSED";
export type SupportConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "KICKED" | "AUTH_FAILED";

export type ConsultationRouteOptions = {
  pool: Pool;
  appId: string;
  wakeDispatch?: () => void;
  provider?: YunxinSupportScopeApi;
  messageTransport?: ImMessageTransport;
  supportManager?: {
    key: ImIdentityKey;
    provisioner: Pick<ImIdentityProvisioner, "ensure">;
  };
  /** Test-only barrier; runtime assembly never wires arbitrary callbacks. */
  testPresenceBarrier?: (context: AdminContext) => Promise<void>;
};

export const SUPPORT_MANAGER_SUBJECT_ID = "support-manager";

export function supportManagerIdentityKey(appId: string): ImIdentityKey {
  return { provider: "yunxin", appId, realm: "system", kind: "SYSTEM", platformSubjectId: SUPPORT_MANAGER_SUBJECT_ID };
}

export type SupportPresence = {
  adminUserId: string;
  availability: SupportAvailability;
  connectionState: SupportConnectionState;
  lastConnectedAt: string | null;
  activeLoad: number;
  version: number;
};

export type ConsultationView = {
  id: string;
  type: SupportType;
  state: ConsultationState;
  subjectRef: string | null;
  assignedAdmin: { id: string; name: string } | null;
  peerAccountId: string | null;
  conversationType: "TEAM";
  conversationId: string | null;
  messageScopeState: MessageScopeState;
  version: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  user?: { id: string; name: string; username: string | null };
};

export type MessageScopeState = "PENDING" | "PROVISIONING" | "READY" | "FAILED" | "TRANSFERRING" | "REVOKING" | "REVOKED";
export type MessageScopeOperationType = "CREATE" | "TRANSFER" | "CLOSE";
export type MessageScopeOperationState = "PENDING" | "RUNNING" | "UNKNOWN" | "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW";

type ScopeOperationRow = {
  id: string;
  appId: string;
  consultationId: string;
  operationType: MessageScopeOperationType;
  state: MessageScopeOperationState;
  scopeVersion: string | number;
  ownerAccountId: string;
  userAccountId: string;
  previousAdminId: string | null;
  targetAdminId: string | null;
  previousAdminAccountId: string | null;
  targetAdminAccountId: string | null;
  providerTeamId: string | null;
  attemptCount: string | number;
  leaseTokenHash: string | null;
  leaseUntil: Date | string | null;
  nextRetryAt: Date | string;
  lastFailureClass: string | null;
  lastFailureDetail: string | null;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$/;
const SUPPORT_TYPES = new Set<SupportType>(["SERVICE", "COMPLAINT"]);
const AVAILABILITY = new Set<SupportAvailability>(["OFF_DUTY", "AVAILABLE", "PAUSED"]);
const CONNECTION_STATES = new Set<SupportConnectionState>([
  "DISCONNECTED",
  "CONNECTING",
  "CONNECTED",
  "RECONNECTING",
  "KICKED",
  "AUTH_FAILED",
]);

type ConsultationRow = {
  id: string;
  userId: string;
  kind: SupportType;
  state: ConsultationState;
  userAccountId: string;
  peerAccountId: string | null;
  assignedAdminId: string | null;
  subjectRef: string | null;
  version: string | number;
  lastMessageAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  userName: string;
  userUsername: string | null;
  adminName: string | null;
  appId: string | null;
  messageScopeType: "TEAM";
  messageScopeId: string | null;
  messageScopeState: MessageScopeState;
  messageScopeVersion: string | number;
};

type PresenceRow = {
  adminUserId: string;
  availability: SupportAvailability;
  connectionState: SupportConnectionState;
  lastConnectedAt: Date | string | null;
  activeLoad: number;
  version: string | number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message = "Request validation failed"): SecurityApiError {
  return new SecurityApiError(400, "INVALID_ARGUMENT", message);
}

function conflict(message: string): SecurityApiError {
  return new SecurityApiError(409, "CONFLICT", message);
}

function unavailable(message = "IM service is temporarily unavailable"): SecurityApiError {
  return new SecurityApiError(503, "IM_UNAVAILABLE", message);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function numberValue(value: string | number): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("IM numeric value is invalid");
  return result;
}

export function parseLimit(value: string | null | undefined): number {
  if (value === undefined || value === null || value === "") return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}

export function parseSupportType(value: unknown): SupportType {
  if (typeof value !== "string" || !SUPPORT_TYPES.has(value as SupportType)) throw invalid("Support type is invalid");
  return value as SupportType;
}

function parseSubjectRef(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalid("Subject reference is invalid");
  return value;
}

export function parseConsultationBody(value: unknown): { type: SupportType; subjectRef: string | null } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  const allowed = new Set(["type", "subjectRef"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalid("Request body contains an unknown field");
  return { type: parseSupportType(value.type), subjectRef: parseSubjectRef(value.subjectRef) };
}

export function parsePresenceBody(value: unknown): { availability: SupportAvailability; connectionState: SupportConnectionState; version?: number } {
  if (!isRecord(value)) throw invalid("Request body is invalid");
  if (Object.keys(value).some((key) => key !== "availability" && key !== "connectionState" && key !== "version")) throw invalid("Request body contains an unknown field");
  if (typeof value.availability !== "string" || !AVAILABILITY.has(value.availability as SupportAvailability)) throw invalid("Availability is invalid");
  if (typeof value.connectionState !== "string" || !CONNECTION_STATES.has(value.connectionState as SupportConnectionState)) throw invalid("Connection state is invalid");
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || (value.version as number) < 0)) throw invalid("Presence version is invalid");
  return {
    availability: value.availability as SupportAvailability,
    connectionState: value.connectionState as SupportConnectionState,
    ...(value.version === undefined ? {} : { version: value.version as number }),
  };
}

function teamConversationId(accountId: string, teamId: string): string {
  if (!ACCOUNT_PATTERN.test(accountId) || !/^[0-9]{1,19}$/.test(teamId)) throw new Error("IM team conversation identity is invalid");
  return `${accountId}|2|${teamId}`;
}

function identityKey(appId: string, realm: "user" | "admin", kind: "USER" | "ADMIN", subjectId: string): ImIdentityKey {
  return { provider: "yunxin", appId, realm, kind, platformSubjectId: subjectId };
}

async function readyAccount(client: PoolClient, key: ImIdentityKey): Promise<string> {
  const row = (await client.query<{ accountId: string; identityMarker: string; status: string }>(
    `SELECT "account_id" AS "accountId", "identity_marker" AS "identityMarker", "status"
       FROM "zzsh_iam"."im_identity_mapping"
      WHERE "provider" = 'yunxin' AND "app_id" = $1 AND "realm" = $2
        AND "identity_kind" = $3 AND "platform_subject_id" = $4`,
    [key.appId, key.realm, key.kind, key.platformSubjectId],
  )).rows[0];
  const expectedAccountId = deriveYunxinAccountId(key);
  const expectedMarker = buildYunxinIdentityMarker(key);
  if (!row || row.status !== "READY" || row.accountId !== expectedAccountId || row.identityMarker !== expectedMarker) {
    throw unavailable("IM identity is not ready");
  }
  return row.accountId;
}

const CONSULTATION_SELECT = `
  SELECT c."id", c."user_id" AS "userId", c."kind", c."state",
         c."user_account_id" AS "userAccountId", c."peer_account_id" AS "peerAccountId", c."app_id" AS "appId",
         c."assigned_admin_id" AS "assignedAdminId", c."subject_ref" AS "subjectRef",
         c."message_scope_type" AS "messageScopeType", c."message_scope_id" AS "messageScopeId",
         c."message_scope_state" AS "messageScopeState", c."message_scope_version" AS "messageScopeVersion",
         c."version", c."last_message_at" AS "lastMessageAt", c."created_at" AS "createdAt",
         c."updated_at" AS "updatedAt", u."name" AS "userName", u."username" AS "userUsername",
         au."name" AS "adminName"
    FROM "zzsh_iam"."im_consultation" c
    JOIN "zzsh_auth_user"."user" u ON u."id" = c."user_id"
    LEFT JOIN "zzsh_auth_admin"."user" au ON au."id" = c."assigned_admin_id"`;

async function readConsultation(client: PoolClient, appId: string, id: string, lock = false): Promise<ConsultationRow> {
  const result = await client.query<ConsultationRow>(`${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."id" = $2${lock ? " FOR UPDATE OF c" : ""}`, [appId, id]);
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "Consultation not found");
  return row;
}

export function toView(row: ConsultationRow, viewerAccountId: string, includeUser = false, viewerAdminId?: string): ConsultationView {
  const canUseScope = row.state === "ACTIVE" && row.messageScopeState === "READY" && Boolean(row.messageScopeId)
    && (!includeUser || row.assignedAdminId === viewerAdminId);
  return {
    id: row.id,
    type: row.kind,
    state: row.state,
    subjectRef: row.subjectRef,
    assignedAdmin: row.assignedAdminId && row.adminName ? { id: row.assignedAdminId, name: row.adminName } : null,
    peerAccountId: includeUser ? row.userAccountId : row.peerAccountId,
    conversationType: "TEAM",
    conversationId: canUseScope ? teamConversationId(viewerAccountId, row.messageScopeId!) : null,
    messageScopeState: row.messageScopeState,
    version: numberValue(row.version),
    lastMessageAt: iso(row.lastMessageAt),
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    ...(includeUser ? { user: { id: row.userId, name: row.userName, username: row.userUsername } } : {}),
  };
}

async function writeEvent(
  client: PoolClient,
  input: {
    consultationId: string;
    eventType: "CREATED" | "ASSIGNED" | "CLAIMED" | "TRANSFERRED" | "CLOSED" | "REOPENED";
    actorType: "user" | "admin" | "system";
    actorId: string;
    fromAdminId?: string | null;
    toAdminId?: string | null;
    peerAccountId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "zzsh_iam"."im_consultation_event"
      ("id", "consultation_id", "event_type", "actor_type", "actor_id", "from_admin_id", "to_admin_id", "peer_account_id", "details")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      `im_event_${randomUUID().replaceAll("-", "")}`,
      input.consultationId,
      input.eventType,
      input.actorType,
      input.actorId,
      input.fromAdminId ?? null,
      input.toAdminId ?? null,
      input.peerAccountId ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
}

function requiredSupportPermission(type: SupportType): string[] {
  return type === "COMPLAINT"
    ? [ADMIN_PERMISSION.imSupportAccept, ADMIN_PERMISSION.imSupportComplaint]
    : [ADMIN_PERMISSION.imSupportAccept];
}

export function requireSupportAccess(access: EffectiveAdminAccess | null, type: SupportType, action: "accept" | "transfer" = "accept"): void {
  const required = action === "transfer"
    ? [...requiredSupportPermission(type), ADMIN_PERMISSION.imSupportTransfer]
    : requiredSupportPermission(type);
  if (!required.every((permission) => hasPermission(access, permission))) {
    throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
  }
}

type Candidate = {
  adminUserId: string;
  adminName: string;
  accountId: string;
};

async function reserveEligibleAdmin(client: PoolClient, appId: string, locked: LockedSupportRoster, type: SupportType, targetAdminId?: string, excludedIds: string[] = []): Promise<Candidate | null> {
  return reserveSupportCandidate(client, appId, type, await readEligibleSupport(client, appId, locked), targetAdminId, excludedIds);
}

async function complaintExclusions(client: PoolClient, appId: string, userId: string, kind: SupportType, subjectRef: string | null): Promise<string[]> {
  if (kind !== "COMPLAINT") return [];
  const result = await client.query<{ id: string }>(`SELECT assigned_admin_id AS id FROM zzsh_iam.im_consultation
    WHERE app_id=$1 AND user_id=$2 AND kind='SERVICE' AND assigned_admin_id IS NOT NULL AND (id=$3 OR state='ACTIVE')
    UNION SELECT g.assigned_admin_id FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id
    WHERE g.app_id=$1 AND o.id=$3 AND (o.renter_user_id=$2 OR o.owner_user_id=$2) AND g.assigned_admin_id IS NOT NULL`, [appId, userId, subjectRef]);
  return result.rows.map((r) => r.id);
}

async function storedComplaintExclusions(client: PoolClient, consultationId: string): Promise<string[]> {
  const row = (await client.query(`SELECT details FROM zzsh_iam.im_consultation_event WHERE consultation_id=$1 AND event_type='CREATED' ORDER BY created_at,id LIMIT 1`, [consultationId])).rows[0];
  const ids: unknown = row?.details?.excludedAdminIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && ID_PATTERN.test(id)) : [];
}
async function decrementPresence(client: PoolClient, appId: string, adminUserId: string | null): Promise<void> {
  if (!adminUserId) return;
  await client.query(
    `UPDATE "zzsh_iam"."im_support_presence"
        SET "active_load" = GREATEST("active_load" - 1, 0), "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "admin_user_id" = $2`,
    [appId, adminUserId],
  );
}

export async function listUserConsultations(
  options: ConsultationRouteOptions,
  context: UserContext,
  limit: number,
): Promise<{ consultations: ConsultationView[] }> {
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const accountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    const rows = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."user_id" = $2 ORDER BY c."updated_at" DESC, c."id" DESC LIMIT $3`,
      [options.appId, context.userId, limit],
    )).rows;
    return { consultations: rows.map((row) => toView(row, accountId)) };
  });
}

const SCOPE_OPERATION_SELECT = `
  SELECT "id", "app_id" AS "appId", "consultation_id" AS "consultationId", "operation_type" AS "operationType",
         "state", "scope_version" AS "scopeVersion", "owner_account_id" AS "ownerAccountId",
         "user_account_id" AS "userAccountId", "previous_admin_id" AS "previousAdminId",
         "target_admin_id" AS "targetAdminId", "previous_admin_account_id" AS "previousAdminAccountId",
         "target_admin_account_id" AS "targetAdminAccountId", "provider_team_id" AS "providerTeamId",
          "attempt_count" AS "attemptCount", "lease_token_hash" AS "leaseTokenHash", "lease_until" AS "leaseUntil",
         "next_retry_at" AS "nextRetryAt",
         "last_failure_class" AS "lastFailureClass", "last_failure_detail" AS "lastFailureDetail"
    FROM "zzsh_iam"."im_consultation_scope_operation"`;

const SCOPE_LEASE_MS = 30_000;
const SCOPE_RETRY_BASE_MS = 5_000;
const SCOPE_RETRY_CAP_MS = 5 * 60_000;
const SCOPE_AUTO_ATTEMPT_LIMIT = 8;

type ScopeOperationClaim = ScopeOperationRow & { leaseToken: string; attemptCount: number };
type ScopeFailureClass = "IDENTITY_PENDING" | "PROVIDER_UNKNOWN" | "PROVIDER_TRANSIENT" | "REMOTE_MISMATCH" | "DB_WRITEBACK_UNKNOWN" | "STALE_OPERATION" | "REQUIRES_MANUAL_REVIEW";

class ScopeOperationFailure extends Error {
  constructor(readonly failureClass: ScopeFailureClass, readonly detail: string, readonly manual = failureClass !== "IDENTITY_PENDING") {
    super(detail);
  }
}

type ScopeRecoveryFailureObserver = (failureClass: ScopeFailureClass | "RECOVERY_UNEXPECTED") => void;

function recoveryFailureClass(error: unknown): ScopeFailureClass | "RECOVERY_UNEXPECTED" {
  if (error instanceof ScopeOperationFailure) return error.failureClass;
  if (error instanceof YunxinApiError) return error.retryable ? "PROVIDER_UNKNOWN" : "REQUIRES_MANUAL_REVIEW";
  if (error instanceof YunxinTransportError) return "PROVIDER_UNKNOWN";
  return "RECOVERY_UNEXPECTED";
}

function reportRecoveryFailure(observer: ScopeRecoveryFailureObserver | undefined, error: unknown): void {
  if (!observer) return;
  try {
    observer(recoveryFailureClass(error));
  } catch {
    // Recovery observation must not take down the worker or hide the persisted state.
  }
}

function createScopeLease(options: ConsultationRouteOptions, claim: ScopeOperationClaim): ScopeLease {
  return createImScopeLease(options.pool, options.appId, async (db) => {
    const result = await db.query(`UPDATE zzsh_iam.im_consultation_scope_operation
      SET lease_until=clock_timestamp()+($3::bigint*interval '1 millisecond'),updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2 AND state='RUNNING' AND lease_token_hash=$4 AND lease_until>clock_timestamp() RETURNING id`,
      [options.appId,claim.id,SCOPE_LEASE_MS,scopeLeaseHash(claim.leaseToken)]);
    return result.rowCount===1;
  }, () => new ScopeOperationFailure("STALE_OPERATION", "scope lease is no longer valid", true));
}
function scopeOperationId(): string {
  return `im_scope_op_${randomBytes(16).toString("hex")}`;
}

function scopeLeaseHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function scopeOperationState(value: string): MessageScopeOperationState {
  if (value === "PENDING" || value === "RUNNING" || value === "UNKNOWN" || value === "SUCCEEDED" || value === "FAILED" || value === "NEEDS_REVIEW") return value;
  throw new Error("IM scope operation state is invalid");
}

function scopeOperationRow(row: ScopeOperationRow): ScopeOperationRow {
  return { ...row, operationType: row.operationType, state: scopeOperationState(row.state) };
}

async function readScopeOperation(client: PoolClient, appId: string, operationId: string, lock = false): Promise<ScopeOperationRow> {
  const result = await client.query<ScopeOperationRow>(`${SCOPE_OPERATION_SELECT} WHERE "app_id" = $1 AND "id" = $2${lock ? " FOR UPDATE" : ""}`, [appId, operationId]);
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, "NOT_FOUND", "IM scope operation not found");
  return scopeOperationRow(row);
}

function supportManagerAccount(options: ConsultationRouteOptions): { key: ImIdentityKey; accountId: string } {
  if (!options.supportManager) throw unavailable("IM support manager is not configured");
  const key = normalizeImIdentityKey(options.supportManager.key);
  if (key.appId !== options.appId || key.realm !== "system" || key.kind !== "SYSTEM" || key.platformSubjectId !== SUPPORT_MANAGER_SUBJECT_ID) {
    throw new Error("IM support manager identity is invalid");
  }
  return { key, accountId: deriveYunxinAccountId(key) };
}

async function ensureSupportManager(options: ConsultationRouteOptions): Promise<string | null> {
  const manager = supportManagerAccount(options);
  const input: ImIdentityProvisionInput = { key: manager.key, displayName: "洲洲商行客服管理身份" };
  const result: ImProvisionResult = await options.supportManager!.provisioner.ensure(input);
  if (result.mapping.accountId !== manager.accountId
    || result.mapping.key.appId !== manager.key.appId
    || result.mapping.key.realm !== manager.key.realm
    || result.mapping.key.kind !== manager.key.kind
    || result.mapping.key.platformSubjectId !== manager.key.platformSubjectId
    || result.mapping.identityMarker !== buildYunxinIdentityMarker(manager.key)) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "IM support manager identity mismatch", true);
  }
  if (result.outcome === "READY") return manager.accountId;
  if (result.outcome === "PENDING") return null;
  throw new ScopeOperationFailure("REMOTE_MISMATCH", "IM support manager is blocked", true);
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 8);
  return Math.min(SCOPE_RETRY_CAP_MS, SCOPE_RETRY_BASE_MS * 2 ** exponent);
}

function providerFailure(error: unknown): ScopeOperationFailure {
  if (error instanceof ScopeOperationFailure) return error;
  if (error instanceof YunxinApiError) {
    return new ScopeOperationFailure(error.retryable ? "PROVIDER_UNKNOWN" : "REQUIRES_MANUAL_REVIEW", `yunxin:${error.operation}`, true);
  }
  if (error instanceof YunxinTransportError) return new ScopeOperationFailure("PROVIDER_UNKNOWN", `yunxin:${error.operation}`, true);
  return new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "scope operation writeback is unknown", true);
}

function remoteActionMayStillBeInFlight(failureClass: string | null): boolean {
  // ponytail: without a provider idempotency/result fence, every non-identity failure stays fail-closed.
  return failureClass !== "IDENTITY_PENDING";
}

function exactMembers(team: YunxinSupportTeamState, required: string[]): boolean {
  if (team.memberAccountIds.length !== required.length) return false;
  const expected = new Set(required);
  return team.memberAccountIds.every((accountId) => expected.has(accountId));
}

function allowedMembers(team: YunxinSupportTeamState, allowed: string[]): boolean {
  const expected = new Set(allowed);
  return team.memberAccountIds.every((accountId) => expected.has(accountId));
}

async function beginMessageScopeProvision(options: ConsultationRouteOptions, consultationId: string): Promise<{ operationId: string } | null> {
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  const manager = supportManagerAccount(options);
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.state !== "ACTIVE") return null;
    if (row.messageScopeState === "READY" || row.messageScopeState === "REVOKED") return null;
    if (row.messageScopeState === "TRANSFERRING" || row.messageScopeState === "REVOKING") return null;
    if (row.messageScopeId || !row.assignedAdminId || !row.peerAccountId) return null;
    const previous = (await client.query<{ state: MessageScopeOperationState }>(
      `SELECT "state" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (previous && (previous.state === "PENDING" || previous.state === "RUNNING" || previous.state === "UNKNOWN" || previous.state === "NEEDS_REVIEW")) return null;
    let scopeVersion = numberValue(row.messageScopeVersion);
    if (row.messageScopeState === "PENDING" || row.messageScopeState === "FAILED") {
      const updated = await client.query<{ messageScopeVersion: string | number }>(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = 'PROVISIONING', "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE'
            AND "message_scope_state" IN ('PENDING', 'FAILED') AND "message_scope_id" IS NULL
          RETURNING "message_scope_version" AS "messageScopeVersion"`,
        [options.appId, consultationId],
      );
      if (updated.rowCount !== 1 || !updated.rows[0]) return null;
      scopeVersion = numberValue(updated.rows[0].messageScopeVersion);
    } else if (row.messageScopeState !== "PROVISIONING") {
      return null;
    }
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id", "target_admin_id", "target_admin_account_id")
       VALUES ($1,$2,$3,'CREATE',$4,$5,$6,$7,$8)`,
      [operationId, options.appId, consultationId, scopeVersion, manager.accountId, row.userAccountId, row.assignedAdminId, row.peerAccountId],
    );
    return { operationId };
  });
}

async function claimScopeOperation(options: ConsultationRouteOptions, operationId: string): Promise<ScopeOperationClaim | null> {
  const leaseToken = randomBytes(32).toString("base64url");
  const result = await options.pool.query<ScopeOperationRow>(
    `UPDATE "zzsh_iam"."im_consultation_scope_operation"
        SET "state" = 'RUNNING', "attempt_count" = "attempt_count" + 1,
            "lease_until" = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
            "lease_token_hash" = $4, "last_failure_class" = NULL,
            "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
      WHERE "app_id" = $1 AND "id" = $2
        AND (
          ("state" = 'PENDING' AND "next_retry_at" <= clock_timestamp())
          OR ("state" = 'UNKNOWN' AND "last_failure_class" = 'IDENTITY_PENDING'
              AND "next_retry_at" <= clock_timestamp())
        )
      RETURNING "id", "app_id" AS "appId", "consultation_id" AS "consultationId", "operation_type" AS "operationType",
                "state", "scope_version" AS "scopeVersion", "owner_account_id" AS "ownerAccountId",
                "user_account_id" AS "userAccountId", "previous_admin_id" AS "previousAdminId",
                "target_admin_id" AS "targetAdminId", "previous_admin_account_id" AS "previousAdminAccountId",
                "target_admin_account_id" AS "targetAdminAccountId", "provider_team_id" AS "providerTeamId",
                "attempt_count" AS "attemptCount", "lease_token_hash" AS "leaseTokenHash", "lease_until" AS "leaseUntil",
                "next_retry_at" AS "nextRetryAt",
                "last_failure_class" AS "lastFailureClass", "last_failure_detail" AS "lastFailureDetail"`,
    [options.appId, operationId, SCOPE_LEASE_MS, scopeLeaseHash(leaseToken)],
  );
  const row = result.rows[0];
  return row ? { ...scopeOperationRow(row), leaseToken, attemptCount: numberValue(row.attemptCount) } : null;
}

async function settleScopeOperationFailure(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  failure: ScopeOperationFailure,
): Promise<"RETRYING" | "NEEDS_REVIEW"> {
  const needsReview = failure.manual || remoteActionMayStillBeInFlight(failure.failureClass) || claim.attemptCount >= SCOPE_AUTO_ATTEMPT_LIMIT;
  const nextState: MessageScopeOperationState = needsReview ? "NEEDS_REVIEW" : "UNKNOWN";
  await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await readConsultation(client, options.appId, claim.consultationId, true);
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = $3, "next_retry_at" = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              "lease_until" = NULL, "lease_token_hash" = NULL,
              "last_failure_class" = $5, "last_failure_detail" = $6, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $7
            AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, nextState, needsReview ? 0 : retryDelayMs(claim.attemptCount), failure.failureClass, failure.detail.slice(0, 512), scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope lease changed before failure was recorded", true);
    if (needsReview) {
      const nextScopeState = "FAILED";
      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = $3, "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2
            AND "message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING')`,
        [options.appId, claim.consultationId, nextScopeState],
      );
    }
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: needsReview ? "im.scope.recovery.needs_review" : "im.scope.recovery.deferred",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "FAILURE",
      requestId: `im_scope_${claim.id}`,
      reason: failure.failureClass,
      details: { operationType: claim.operationType, attemptCount: claim.attemptCount },
    });
  });
  return needsReview ? "NEEDS_REVIEW" : "RETRYING";
}

async function quarantineUncertainScopeOperations(options: ConsultationRouteOptions, limit: number): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    const candidates = (await client.query<{
      id: string;
      consultationId: string;
      ownerAccountId: string;
      operationType: MessageScopeOperationType;
      state: "RUNNING" | "UNKNOWN";
      lastFailureClass: string | null;
    }>(
      `SELECT "id", "consultation_id" AS "consultationId", "owner_account_id" AS "ownerAccountId",
              "operation_type" AS "operationType", "state", "last_failure_class" AS "lastFailureClass"
         FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND (
          ("state" = 'RUNNING' AND "lease_until" <= clock_timestamp())
          OR ("state" = 'UNKNOWN' AND "last_failure_class" IS DISTINCT FROM 'IDENTITY_PENDING'
              AND COALESCE("last_failure_detail", '') NOT LIKE 'remote action may still be in flight;%')
        )
        ORDER BY "next_retry_at", "updated_at", "id"
        LIMIT $2`,
      [options.appId, limit],
    )).rows;

    for (const candidate of candidates) {
      await readConsultation(client, options.appId, candidate.consultationId, true);
      const detail = "remote action may still be in flight; local lease is not provider fencing";
      const updated = candidate.state === "RUNNING"
        ? await client.query(
          `UPDATE "zzsh_iam"."im_consultation_scope_operation"
              SET "state" = 'NEEDS_REVIEW', "next_retry_at" = clock_timestamp(),
                  "lease_until" = NULL, "lease_token_hash" = NULL,
                  "last_failure_class" = 'PROVIDER_UNKNOWN',
                  "last_failure_detail" = left($3 || COALESCE("last_failure_detail", ''), 512),
                  "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING'
              AND "lease_until" <= clock_timestamp()`,
          [options.appId, candidate.id, `${detail}; `],
        )
        : await client.query(
          `UPDATE "zzsh_iam"."im_consultation_scope_operation"
              SET "next_retry_at" = clock_timestamp(),
                  "last_failure_class" = COALESCE("last_failure_class", 'PROVIDER_UNKNOWN'),
                  "last_failure_detail" = left($3 || COALESCE("last_failure_detail", ''), 512),
                  "updated_at" = clock_timestamp()
            WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'UNKNOWN'
              AND "last_failure_class" IS DISTINCT FROM 'IDENTITY_PENDING'
              AND COALESCE("last_failure_detail", '') NOT LIKE 'remote action may still be in flight;%'`,
          [options.appId, candidate.id, `${detail}; `],
        );
      if (updated.rowCount !== 1) continue;

      await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_state" = 'FAILED', "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2
            AND "message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING')`,
        [options.appId, candidate.consultationId],
      );
      await recordAudit(client, {
        actorType: "system",
        actorId: candidate.ownerAccountId,
        action: "im.scope.recovery.quarantined",
        objectType: "im_consultation_scope_operation",
        objectId: candidate.id,
        outcome: "FAILURE",
        requestId: `im_scope_${candidate.id}`,
        reason: candidate.state === "RUNNING" ? "PROVIDER_UNKNOWN" : candidate.lastFailureClass ?? "PROVIDER_UNKNOWN",
        details: { operationType: candidate.operationType, previousState: candidate.state, remoteFence: "unavailable" },
      });
    }
  });
}

async function attachCreatedTeam(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string): Promise<boolean> {
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await lockTeamBinding(client, options.appId, teamId);
    if ((await client.query(`SELECT 1 FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2`, [options.appId,teamId])).rowCount) throw new ScopeOperationFailure("REMOTE_MISMATCH", "Team is already bound to an order", true);
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING" || operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) return false;
    const identityMatches = row.userAccountId === claim.userAccountId
      && row.assignedAdminId === claim.targetAdminId
      && row.peerAccountId === claim.targetAdminAccountId;
    if (row.state === "ACTIVE" && row.messageScopeState === "PROVISIONING"
      && (row.messageScopeId === null || row.messageScopeId === teamId) && identityMatches) {
      const updated = await client.query(
        `UPDATE "zzsh_iam"."im_consultation"
            SET "message_scope_id" = $3, "message_scope_state" = 'READY',
                "message_scope_version" = "message_scope_version" + 1,
                "version" = "version" + 1, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" = 'PROVISIONING'
            AND ("message_scope_id" IS NULL OR "message_scope_id" = $3)`,
        [options.appId, claim.consultationId, teamId],
      );
      if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "scope create writeback is unknown");
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
                "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before completion", true);
      await recordAudit(client, { actorType: "system", actorId: claim.ownerAccountId, action: "im.scope.ready", objectType: "im_consultation_scope_operation", objectId: claim.id, outcome: "SUCCESS", requestId: `im_scope_${claim.id}` });
      return true;
    }
    if (row.state === "ACTIVE" && row.messageScopeState === "READY" && row.messageScopeId === teamId) {
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
                "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before completion", true);
      return true;
    }
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'NEEDS_REVIEW', "next_retry_at" = clock_timestamp(),
              "lease_until" = NULL, "lease_token_hash" = NULL, "last_failure_class" = 'STALE_OPERATION',
              "last_failure_detail" = 'consultation changed before scope attach', "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    return false;
  });
}

async function rememberCreatedTeamCandidate(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string, connection: PoolClient): Promise<void> {
  await onLeaseConnection(connection, async (client) => {
    await lockDispatchGate(client, options.appId);
    await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING" || operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) {
      throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before team candidate was recorded", true);
    }
    if (operation.providerTeamId && operation.providerTeamId !== teamId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create returned multiple team IDs", true);
    }
    const recorded = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = COALESCE("provider_team_id", $3), "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING'
          AND "lease_token_hash" = $4 AND "lease_until" > clock_timestamp()` ,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (recorded.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "scope create lease changed before team candidate was recorded", true);
  });
}

async function readAndValidateTeam(options: ConsultationRouteOptions, teamId: string, ownerAccountId: string): Promise<YunxinSupportTeamState> {
  const team = await options.provider!.getSupportTeam(teamId);
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team state is not readable");
  if (team.ownerAccountId !== ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team owner is not the server manager", true);
  return team;
}

async function readTeamWithLease(options: ConsultationRouteOptions, lease: ScopeLease, teamId: string): Promise<YunxinSupportTeamState | null> {
  return lease.mutate(`team:${teamId}`, () => options.provider!.getSupportTeam(teamId));
}

async function findTeamWithLease(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  input: { appId: string; consultationId: string; ownerAccountId: string },
): Promise<YunxinSupportTeamLookup> {
  return lease.mutate(`consultation:${input.consultationId}`, () => options.provider!.findSupportTeam(input));
}

async function mutateTeamMember(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  teamId: string,
  ownerAccountId: string,
  action: () => Promise<void>,
): Promise<YunxinSupportTeamState> {
  return lease.mutate(`team:${teamId}`, async () => {
    await action();
    return readAndValidateTeam(options, teamId, ownerAccountId);
  });
}

async function convergeCreateTeam(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease, team: YunxinSupportTeamState, required: string[]): Promise<void> {
  if (!allowedMembers(team, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team contains an unauthorized member", true);
  let current = team;
  for (const accountId of required) {
    if (current.memberAccountIds.includes(accountId)) continue;
    current = await mutateTeamMember(options, lease, current.teamId, claim.ownerAccountId,
      () => options.provider!.addSupportTeamMember(current.teamId, claim.ownerAccountId, accountId));
  }
  if (!exactMembers(current, required)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "support team members do not match consultation", true);
  if (supportMarkerMatches(current.serverExtension,options.appId,claim.consultationId)!==true) throw new ScopeOperationFailure("REMOTE_MISMATCH", "consultation Team marker is not confirmed", true);
  if (!await attachCreatedTeam(options, claim, current.teamId)) throw new ScopeOperationFailure("STALE_OPERATION", "scope operation lost its consultation version", true);
}

async function reconcileCreate(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  const targetAdminAccountId = claim.targetAdminAccountId;
  if (!owner) throw new ScopeOperationFailure("IDENTITY_PENDING", "IM support manager identity is pending");
  if (owner !== claim.ownerAccountId || !targetAdminAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "scope create identity is inconsistent", true);
  const required = [owner, claim.userAccountId, targetAdminAccountId];
  let team: YunxinSupportTeamState | null = null;
  if (claim.providerTeamId) {
    team = await readTeamWithLease(options, lease, claim.providerTeamId);
    if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "recorded support team candidate is not readable");
  }
  await lease.assertValid();
  if (!team) {
    const lookup = await findTeamWithLease(options, lease, { appId: options.appId, consultationId: claim.consultationId, ownerAccountId: owner });
    if (lookup.status === "AMBIGUOUS") throw new ScopeOperationFailure("REQUIRES_MANUAL_REVIEW", "support team cannot be uniquely located", true);
    if (lookup.status === "FOUND") team = lookup.team;
  }
  if (!team) {
    team = await lease.mutate(`consultation:${claim.consultationId}`, async (connection) => {
      const created = await options.provider!.createSupportTeam({ appId: options.appId, consultationId: claim.consultationId, ownerAccountId: owner, memberAccountIds: [claim.userAccountId, targetAdminAccountId] });
      await rememberCreatedTeamCandidate(options, claim, created.teamId, connection);
      return readAndValidateTeam(options, created.teamId, owner);
    });
  }
  if (!team) throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team state is not readable");
  await convergeCreateTeam(options, claim, lease, team, required);
}

async function completeTransferRecovery(options: ConsultationRouteOptions, claim: ScopeOperationClaim, teamId: string): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId, claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before reconciliation", true);
    if (row.state === "ACTIVE" && row.messageScopeState === "READY" && row.messageScopeId === teamId && row.assignedAdminId === claim.targetAdminId && row.peerAccountId === claim.targetAdminAccountId) {
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
                "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before completion", true);
      return;
    }
    if (row.state !== "ACTIVE" || row.messageScopeState !== "TRANSFERRING" || row.messageScopeId !== teamId || row.assignedAdminId !== claim.previousAdminId || row.peerAccountId !== claim.previousAdminAccountId) {
      throw new ScopeOperationFailure("STALE_OPERATION", "transfer consultation version changed", true);
    }
    await decrementPresence(client, options.appId, claim.previousAdminId);
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "assigned_admin_id" = $3, "peer_account_id" = $4, "message_scope_state" = 'READY',
              "message_scope_version" = "message_scope_version" + 1, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" = 'TRANSFERRING'`,
      [options.appId, claim.consultationId, claim.targetAdminId, claim.targetAdminAccountId],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "transfer writeback is unknown");
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "provider_team_id" = $3, "state" = 'SUCCEEDED', "lease_until" = NULL,
              "lease_token_hash" = NULL, "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $4
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, teamId, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "transfer lease changed before completion", true);
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "TRANSFERRED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: claim.previousAdminId, toAdminId: claim.targetAdminId, peerAccountId: claim.targetAdminAccountId, details: { recovered: true } });
    await recordAudit(client, { actorType: "system", actorId: claim.ownerAccountId, action: "im.scope.transfer.recovered", objectType: "im_consultation_scope_operation", objectId: claim.id, outcome: "SUCCESS", requestId: `im_scope_${claim.id}` });
  });
}

async function reconcileTransfer(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner) throw new ScopeOperationFailure("IDENTITY_PENDING", "IM support manager identity is pending");
  if (owner !== claim.ownerAccountId || !claim.providerTeamId || !claim.previousAdminAccountId || !claim.targetAdminAccountId || !claim.previousAdminId || !claim.targetAdminId) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "transfer identity is inconsistent", true);
  }
  let team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation team is missing", true);
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation owner changed", true);
  const allowed = [owner, claim.userAccountId, claim.previousAdminAccountId, claim.targetAdminAccountId];
  if (!allowedMembers(team, allowed)) throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation has an unauthorized member", true);
  if (!team.memberAccountIds.includes(claim.targetAdminAccountId)) {
    team = await mutateTeamMember(options, lease, team.teamId, owner,
      () => options.provider!.addSupportTeamMember(team!.teamId, owner, claim.targetAdminAccountId!));
  }
  if (team.memberAccountIds.includes(claim.previousAdminAccountId)) {
    team = await mutateTeamMember(options, lease, team.teamId, owner,
      () => options.provider!.removeSupportTeamMember(team!.teamId, owner, claim.previousAdminAccountId!));
  }
  if (!exactMembers(team, [owner, claim.userAccountId, claim.targetAdminAccountId])) {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "transferred consultation members did not converge", true);
  }
  await completeTransferRecovery(options, claim, team.teamId);
}

async function completeCloseRecovery(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  teamId: string,
  expectedScopeState: "REVOKING" | "FAILED" = "REVOKING",
): Promise<void> {
  if (claim.appId !== options.appId || claim.operationType !== "CLOSE" || claim.providerTeamId !== teamId) {
    throw new ScopeOperationFailure("STALE_OPERATION", "close operation is not bound to this team", true);
  }
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [claim.previousAdminId, claim.targetAdminId].filter((id): id is string => Boolean(id)));
    const row = await readConsultation(client, options.appId, claim.consultationId, true);
    const operation = await readScopeOperation(client, options.appId, claim.id, true);
    if (operation.state !== "RUNNING") return;
    if (operation.leaseTokenHash !== scopeLeaseHash(claim.leaseToken)) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before reconciliation", true);
    if (row.state === "CLOSED" && row.messageScopeState === "REVOKED") {
      const settled = await client.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
                "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
            AND "lease_until" > clock_timestamp()`,
        [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
      );
      if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before completion", true);
      return;
    }
    const expectedScopeVersion = numberValue(claim.scopeVersion) + (expectedScopeState === "FAILED" ? 1 : 0);
    if (
      row.state !== "ACTIVE"
      || row.messageScopeState !== expectedScopeState
      || row.messageScopeId !== teamId
      || numberValue(row.messageScopeVersion) !== expectedScopeVersion
    ) {
      throw new ScopeOperationFailure("STALE_OPERATION", "close consultation version changed", true);
    }
    const updated = await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'CLOSED', "message_scope_state" = 'REVOKED',
              "message_scope_version" = "message_scope_version" + 1, "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "message_scope_state" = $3`,
      [options.appId, claim.consultationId, expectedScopeState],
    );
    if (updated.rowCount !== 1) throw new ScopeOperationFailure("DB_WRITEBACK_UNKNOWN", "close writeback is unknown");
    await decrementPresence(client, options.appId, row.assignedAdminId);
    await writeEvent(client, { consultationId: claim.consultationId, eventType: "CLOSED", actorType: "system", actorId: claim.ownerAccountId, fromAdminId: row.assignedAdminId, peerAccountId: row.peerAccountId, details: { recovered: true } });
    const settled = await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'SUCCEEDED', "lease_until" = NULL, "lease_token_hash" = NULL,
              "last_failure_class" = NULL, "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'RUNNING' AND "lease_token_hash" = $3
          AND "lease_until" > clock_timestamp()`,
      [options.appId, claim.id, scopeLeaseHash(claim.leaseToken)],
    );
    if (settled.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close lease changed before completion", true);
    await recordAudit(client, {
      actorType: "system",
      actorId: claim.ownerAccountId,
      action: expectedScopeState === "FAILED" ? "im.scope.close.reconciled" : "im.scope.close.recovered",
      objectType: "im_consultation_scope_operation",
      objectId: claim.id,
      outcome: "SUCCESS",
      requestId: `im_scope_${claim.id}`,
      ...(expectedScopeState === "FAILED" ? { details: { providerAbsenceConfirmed: true } } : {}),
    });
  });
}

async function readSupportTeamExistenceWithLease(
  options: ConsultationRouteOptions,
  lease: ScopeLease,
  claim: ScopeOperationClaim,
): Promise<YunxinSupportTeamExistenceLookup> {
  if (!claim.providerTeamId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close operation has no provider team", true);
  return lease.mutate(`team:${claim.providerTeamId}`, () => options.provider!.readSupportTeamExistence({
    appId: options.appId,
    consultationId: claim.consultationId,
    ownerAccountId: claim.ownerAccountId,
    teamId: claim.providerTeamId!,
  }));
}

async function reconcileClose(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  await lease.assertValid();
  const owner = await ensureSupportManager(options);
  await lease.assertValid();
  if (!owner) throw new ScopeOperationFailure("IDENTITY_PENDING", "IM support manager identity is pending");
  if (owner !== claim.ownerAccountId || !claim.providerTeamId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close identity is inconsistent", true);
  const team = await readTeamWithLease(options, lease, claim.providerTeamId);
  if (!team) {
    const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
    if (existence.status !== "ABSENT") {
      throw new ScopeOperationFailure(
        existence.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH",
        "support team absence could not be confirmed",
        true,
      );
    }
    await completeCloseRecovery(options, claim, claim.providerTeamId);
    return;
  }
  if (team.ownerAccountId !== owner) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close team owner changed", true);
  const afterDismiss = await lease.mutate(`team:${claim.providerTeamId}`, async () => {
    await options.provider!.dismissSupportTeam(claim.providerTeamId!, owner);
    return options.provider!.readSupportTeamExistence({
      appId: options.appId,
      consultationId: claim.consultationId,
      ownerAccountId: owner,
      teamId: claim.providerTeamId!,
    });
  });
  if (afterDismiss.status !== "ABSENT") {
    throw new ScopeOperationFailure(
      afterDismiss.status === "FOUND" ? "PROVIDER_UNKNOWN" : "REMOTE_MISMATCH",
      "support team still exists or has the wrong identity after dismiss",
      true,
    );
  }
  await completeCloseRecovery(options, claim, claim.providerTeamId);
}

async function reconcileCloseAfterKnownAbsence(options: ConsultationRouteOptions, claim: ScopeOperationClaim, lease: ScopeLease): Promise<void> {
  if (claim.operationType !== "CLOSE" || !claim.providerTeamId) {
    throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation operation is invalid", true);
  }
  const owner = supportManagerAccount(options).accountId;
  if (owner !== claim.ownerAccountId) throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation owner changed", true);
  const existence = await readSupportTeamExistenceWithLease(options, lease, claim);
  if (existence.status === "AMBIGUOUS") {
    throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation team identity is ambiguous", true);
  }
  if (existence.status === "FOUND") {
    throw new ScopeOperationFailure("PROVIDER_UNKNOWN", "support team still exists after close reconciliation", true);
  }
  await completeCloseRecovery(options, claim, claim.providerTeamId, "FAILED");
}

function activeLease(value: Date | string | null): boolean {
  if (value === null) return false;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp > Date.now();
}

async function claimCloseReconciliation(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  requestId: string,
): Promise<ScopeOperationClaim | "SUCCEEDED" | null> {
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportTransfer)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    requireSupportAccess(access, row.kind);
    const latest = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
         WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (!latest) return null;
    const detail = await readScopeOperation(client, options.appId, latest.id, true);
    if (detail.operationType !== "CLOSE") return null;
    if (detail.state === "SUCCEEDED") return "SUCCEEDED";
    if (detail.state !== "NEEDS_REVIEW") return null;
    if (row.state !== "ACTIVE") throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation consultation is no longer active", true);
    if (detail.leaseTokenHash !== null || activeLease(detail.leaseUntil)) {
      throw unavailable("IM close reconciliation lease is still active");
    }
    const closeReadEligibleFailure =
      (detail.lastFailureClass === "REQUIRES_MANUAL_REVIEW" && detail.lastFailureDetail === "yunxin:get-support-team")
      || (detail.lastFailureClass === "PROVIDER_UNKNOWN" && detail.lastFailureDetail === "yunxin:dismiss-support-team");
    if (numberValue(detail.attemptCount) !== 1 || !closeReadEligibleFailure) {
      throw unavailable("IM close reconciliation is not eligible for the single read");
    }
    if (
      !detail.providerTeamId
      || row.messageScopeId !== detail.providerTeamId
      || row.userAccountId !== detail.userAccountId
      || row.messageScopeState !== "FAILED"
      || numberValue(row.messageScopeVersion) !== numberValue(detail.scopeVersion) + 1
    ) {
      throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation binding or version changed", true);
    }
    if (supportManagerAccount(options).accountId !== detail.ownerAccountId) {
      throw new ScopeOperationFailure("REMOTE_MISMATCH", "close reconciliation manager changed", true);
    }
    const leaseToken = randomBytes(32).toString("base64url");
    const requeued = await client.query<{ id: string }>(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'PENDING', "next_retry_at" = clock_timestamp(), "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "operation_type" = 'CLOSE'
          AND "state" = 'NEEDS_REVIEW' AND "attempt_count" = 1
          AND "scope_version" = $3 AND "provider_team_id" = $4
          AND "lease_token_hash" IS NULL
          AND ("lease_until" IS NULL OR "lease_until" <= clock_timestamp())
        RETURNING "id"`,
      [options.appId, detail.id, detail.scopeVersion, detail.providerTeamId],
    );
    if (requeued.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation state changed", true);
    const claimed = await client.query<{ id: string }>(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'RUNNING', "attempt_count" = "attempt_count" + 1,
              "lease_until" = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
              "lease_token_hash" = $4, "last_failure_class" = NULL,
              "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "operation_type" = 'CLOSE'
          AND "state" = 'PENDING' AND "attempt_count" = 1
          AND "scope_version" = $5 AND "provider_team_id" = $6
          AND "lease_token_hash" IS NULL
          AND ("lease_until" IS NULL OR "lease_until" <= clock_timestamp())
        RETURNING "id"`,
      [options.appId, detail.id, SCOPE_LEASE_MS, scopeLeaseHash(leaseToken), detail.scopeVersion, detail.providerTeamId],
    );
    if (claimed.rowCount !== 1) throw new ScopeOperationFailure("STALE_OPERATION", "close reconciliation lease changed", true);
    const claimRow = await readScopeOperation(client, options.appId, detail.id, true);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.scope.close.reconciliation.started",
      objectType: "im_consultation_scope_operation",
      objectId: detail.id,
      outcome: "SUCCESS",
      requestId,
      details: {
        providerTeamId: detail.providerTeamId,
        priorAttemptCount: 1,
        expectedScopeVersion: numberValue(row.messageScopeVersion),
        readLimit: 1,
      },
    });
    return { ...claimRow, leaseToken, attemptCount: numberValue(claimRow.attemptCount) };
  });
}

type ScopeOperationExecutionMode = "NORMAL" | "CLOSE_ABSENCE";

async function executeScopeOperation(
  options: ConsultationRouteOptions,
  claim: ScopeOperationClaim,
  mode: ScopeOperationExecutionMode = "NORMAL",
): Promise<"SUCCEEDED" | "RETRYING" | "NEEDS_REVIEW"> {
  const lease = createScopeLease(options, claim);
  try {
    if (claim.operationType === "CREATE") await reconcileCreate(options, claim, lease);
    else if (claim.operationType === "TRANSFER") await reconcileTransfer(options, claim, lease);
    else if (mode === "CLOSE_ABSENCE") await reconcileCloseAfterKnownAbsence(options, claim, lease);
    else await reconcileClose(options, claim, lease);
    await lease.stop();
    return "SUCCEEDED";
  } catch (error) {
    await lease.stop();
    return settleScopeOperationFailure(options, claim, providerFailure(error));
  }
}

async function runScopeOperationNow(options: ConsultationRouteOptions, operationId: string): Promise<void> {
  const claim = await claimScopeOperation(options, operationId);
  if (!claim) return;
  const result = await executeScopeOperation(options, claim);
  if (result !== "SUCCEEDED") throw unavailable("IM message scope is being recovered");
}

export async function reconcileMessageScopes(options: ConsultationRouteOptions, limit = 10, onFailure?: ScopeRecoveryFailureObserver): Promise<number> {
  if (!options.provider || !options.supportManager) return 0;
  await quarantineUncertainScopeOperations(options, limit);
  const candidates = await options.pool.query<{ id: string }>(
    `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
      WHERE "app_id" = $1 AND (
        ("state" = 'PENDING' AND "next_retry_at" <= clock_timestamp())
        OR ("state" = 'UNKNOWN' AND "last_failure_class" = 'IDENTITY_PENDING'
            AND "next_retry_at" <= clock_timestamp())
      ) ORDER BY "next_retry_at", "updated_at", "id" LIMIT $2`,
    [options.appId, limit],
  );
  let claimedCount = 0;
  for (const candidate of candidates.rows) {
    try {
      const claim = await claimScopeOperation(options, candidate.id);
      if (!claim) continue;
      claimedCount += 1;
      await executeScopeOperation(options, claim);
    } catch (error) {
      reportRecoveryFailure(onFailure, error);
    }
  }
  return claimedCount;
}

export function startMessageScopeRecovery(options: ConsultationRouteOptions, intervalMs = 30_000, onFailure?: ScopeRecoveryFailureObserver): () => Promise<void> {
  if (!options.provider || !options.supportManager) return async () => undefined;
  let stopped = false;
  let inFlight: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    const current = reconcileMessageScopes(options, 10, onFailure).catch((error) => {
      reportRecoveryFailure(onFailure, error);
    });
    inFlight = current;
    void current.finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    const current = inFlight;
    if (current) await current;
  };
}

@Injectable()
export class MessageScopeRecoveryLifecycle implements BeforeApplicationShutdown {
  private readonly logger = new Logger(MessageScopeRecoveryLifecycle.name);
  private stopRecovery: (() => Promise<void>) | undefined;

  start(options: ConsultationRouteOptions, intervalMs = 30_000): void {
    if (this.stopRecovery) return;
    this.stopRecovery = startMessageScopeRecovery(options, intervalMs, (failureClass) => {
      this.logger.error(JSON.stringify({ event: "im.scope.recovery.failed", failureClass }));
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    const stop = this.stopRecovery;
    this.stopRecovery = undefined;
    if (stop) await stop();
  }
}

async function ensureMessageScope(options: ConsultationRouteOptions, consultationId: string): Promise<void> {
  const operation = await beginMessageScopeProvision(options, consultationId);
  if (!operation) return;
  await runScopeOperationNow(options, operation.operationId);
}

async function readUserConsultationView(options: ConsultationRouteOptions, context: UserContext, consultationId: string): Promise<{ consultation: ConsultationView }> {
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const accountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    return { consultation: toView(await readConsultation(client, options.appId, consultationId), accountId) };
  });
}

async function readAdminConsultationView(options: ConsultationRouteOptions, context: AdminContext, consultationId: string): Promise<{ consultation: ConsultationView }> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const accountId = await readyAccount(client, identityKey(options.appId, "admin", "ADMIN", context.userId));
    return { consultation: toView(await readConsultation(client, options.appId, consultationId), accountId, true, context.userId) };
  });
}

export type ImConversationAccess = { viewerAccountId: string; peerAccountId: string };

function teamIdFromConversationId(accountId: string, conversationId: string): string {
  const prefix = `${accountId}|2|`;
  const teamId = conversationId.startsWith(prefix) ? conversationId.slice(prefix.length) : "";
  if (!/^\d{1,19}$/.test(teamId) || teamConversationId(accountId, teamId) !== conversationId) {
    throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
  }
  return teamId;
}

export async function readUserMessageAccess(
  options: ConsultationRouteOptions,
  context: UserContext,
  conversationId: string,
): Promise<ImConversationAccess> {
  return withTransaction(options.pool, async (client) => {
    await assertUserContextInTransaction(client, context);
    const viewerAccountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    const teamId = teamIdFromConversationId(viewerAccountId, conversationId);
    const matching = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."user_id" = $2 AND c."message_scope_id" = $3`,
      [options.appId, context.userId, teamId],
    )).rows[0];
    if (!matching || matching.state !== "ACTIVE" || matching.messageScopeState !== "READY" || matching.userAccountId !== viewerAccountId || !matching.peerAccountId) {
      throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
    }
    return { viewerAccountId, peerAccountId: matching.peerAccountId };
  });
}

export async function readAdminMessageAccess(
  options: ConsultationRouteOptions,
  context: AdminContext,
  conversationId: string,
  requireSendPermission = false,
): Promise<ImConversationAccess> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const viewerAccountId = await readyAccount(client, identityKey(options.appId, "admin", "ADMIN", context.userId));
    const teamId = teamIdFromConversationId(viewerAccountId, conversationId);
    const matching = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."assigned_admin_id" = $2 AND c."message_scope_id" = $3`,
      [options.appId, context.userId, teamId],
    )).rows[0];
    if (!matching || matching.state !== "ACTIVE" || matching.messageScopeState !== "READY" || matching.peerAccountId !== viewerAccountId) {
      throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not authorized");
    }
    // History remains readable under the directory/read contract; every send
    // rechecks the current type-specific reception grant in this transaction.
    if (requireSendPermission) requireSupportAccess(await loadEffectiveAdminAccess(client, context.userId), matching.kind);
    return { viewerAccountId, peerAccountId: matching.userAccountId };
  });
}

export async function createOrResumeUserConsultation(
  options: ConsultationRouteOptions,
  context: UserContext,
  type: SupportType,
  subjectRef: string | null,
  requestId: string,
): Promise<{ consultation: ConsultationView }> {
  const result = await withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [context.userId]);
    await setAuditContext(client, "user", context.userId, context.sessionId, requestId);
    await assertUserContextInTransaction(client, context);
    const accountId = await readyAccount(client, identityKey(options.appId, "user", "USER", context.userId));
    const priority = await assignWaitingOrders(client, options.appId, await readEligibleSupport(client, options.appId, locked));
    const existing = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT} WHERE c."app_id" = $1 AND c."user_id" = $2 AND c."kind" = $3 AND c."state" <> 'CLOSED' FOR UPDATE OF c`,
      [options.appId, context.userId, type],
    )).rows[0];
    if (existing) return { id: existing.id, state: existing.state, consultation: toView(existing, accountId) };

    const excludedIds = await complaintExclusions(client, options.appId, context.userId, type, subjectRef);
    const candidate = priority.more ? null : await reserveEligibleAdmin(client, options.appId, locked, type, undefined, excludedIds);
    const id = `im_consult_${randomUUID().replaceAll("-", "")}`;
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation"
        ("id", "app_id", "user_id", "kind", "state", "user_account_id", "peer_account_id", "assigned_admin_id", "subject_ref")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, options.appId, context.userId, type, candidate ? "ACTIVE" : "WAITING", accountId, candidate?.accountId ?? null, candidate?.adminUserId ?? null, subjectRef],
    );
    await writeEvent(client, { consultationId: id, eventType: "CREATED", actorType: "user", actorId: context.userId, peerAccountId: candidate?.accountId ?? null, details: { type, excludedAdminIds: excludedIds } });
    if (candidate) {
      await writeEvent(client, { consultationId: id, eventType: "ASSIGNED", actorType: "system", actorId: context.userId, toAdminId: candidate.adminUserId, peerAccountId: candidate.accountId, details: { reason: "availability" } });
    }
    await recordAudit(client, {
      actorType: "user",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.consultation.created",
      objectType: "im_consultation",
      objectId: id,
      outcome: "SUCCESS",
      requestId,
      details: { type, assigned: Boolean(candidate) },
    });
    return { id, state: candidate ? "ACTIVE" as const : "WAITING" as const, consultation: toView(await readConsultation(client, options.appId, id), accountId) };
  });
  if (result.state === "ACTIVE") await ensureMessageScope(options, result.id);
  return readUserConsultationView(options, context, result.id);
}

export async function listAdminConsultations(
  options: ConsultationRouteOptions,
  context: AdminContext,
  _access: EffectiveAdminAccess,
  limit: number,
): Promise<{ consultations: ConsultationView[] }> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    const accountId = await readyAccount(client, identityKey(options.appId, "admin", "ADMIN", context.userId));
    const serviceQueue = hasPermission(access, ADMIN_PERMISSION.imSupportAccept);
    const complaintQueue = serviceQueue && hasPermission(access, ADMIN_PERMISSION.imSupportComplaint);
    const rows = (await client.query<ConsultationRow>(
      `${CONSULTATION_SELECT}
        WHERE c."app_id" = $1 AND c."state" <> 'CLOSED' AND (
          c."assigned_admin_id" = $2
          OR (c."assigned_admin_id" IS NULL AND c."kind" = 'SERVICE' AND $3::boolean)
          OR (c."assigned_admin_id" IS NULL AND c."kind" = 'COMPLAINT' AND $4::boolean)
        )
        ORDER BY CASE WHEN c."assigned_admin_id" = $2 THEN 0 ELSE 1 END, c."updated_at", c."id"
        LIMIT $5`,
      [options.appId, context.userId, serviceQueue, complaintQueue, limit],
    )).rows;
    return { consultations: rows.map((row) => toView(row, accountId, true, context.userId)) };
  });
}

export async function readOwnPresence(options: ConsultationRouteOptions, context: AdminContext): Promise<SupportPresence> {
  return withTransaction(options.pool, async (client) => {
    await assertAdminContextInTransaction(client, context);
    const row = (await client.query<PresenceRow>(
      `SELECT "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
              "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"
         FROM "zzsh_iam"."im_support_presence" WHERE "app_id" = $1 AND "admin_user_id" = $2`,
      [options.appId, context.userId],
    )).rows[0];
    return row ? presenceView(row) : defaultPresence(context.userId);
  });
}

function defaultPresence(adminUserId: string): SupportPresence {
  return { adminUserId, availability: "OFF_DUTY", connectionState: "DISCONNECTED", lastConnectedAt: null, activeLoad: 0, version: 0 };
}

function presenceView(row: PresenceRow): SupportPresence {
  return {
    adminUserId: row.adminUserId,
    availability: row.availability,
    connectionState: row.connectionState,
    lastConnectedAt: iso(row.lastConnectedAt),
    activeLoad: row.activeLoad,
    version: numberValue(row.version),
  };
}

export async function updateOwnPresence(
  options: ConsultationRouteOptions,
  context: AdminContext,
  input: { availability: SupportAvailability; connectionState: SupportConnectionState; version?: number },
  requestId: string,
): Promise<SupportPresence> {
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportPresence)) {
      throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    }
    const current = (await client.query<PresenceRow>(
      `SELECT "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
              "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"
         FROM "zzsh_iam"."im_support_presence"
        WHERE "app_id" = $1 AND "admin_user_id" = $2`,
      [options.appId, context.userId],
    )).rows[0];
    const currentVersion = current ? numberValue(current.version) : 0;
    if (current && (input.version === undefined || input.version !== currentVersion)) {
      throw conflict("Presence version is stale");
    }
    if (!current && input.version !== undefined && input.version !== 0) {
      throw conflict("Presence version is stale");
    }
    await options.testPresenceBarrier?.(context);
    let persisted: PresenceRow | undefined;
    if (!current) {
      const inserted = await client.query<PresenceRow>(
        `INSERT INTO "zzsh_iam"."im_support_presence"
          ("app_id", "admin_user_id", "availability", "connection_state", "last_connected_at")
         VALUES ($1,$2,$3,$4,CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END)
         ON CONFLICT ("app_id", "admin_user_id") DO NOTHING
         RETURNING "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
                   "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"`,
        [options.appId, context.userId, input.availability, input.connectionState],
      );
      persisted = inserted.rows[0];
    } else {
      const updated = await client.query<PresenceRow>(
        `UPDATE "zzsh_iam"."im_support_presence"
            SET "availability" = $3,
                "connection_state" = $4,
                "last_connected_at" = CASE WHEN $4 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END,
                "version" = "version" + 1,
                "updated_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "admin_user_id" = $2 AND "version" = $5
          RETURNING "admin_user_id" AS "adminUserId", "availability", "connection_state" AS "connectionState",
                    "last_connected_at" AS "lastConnectedAt", "active_load" AS "activeLoad", "version"`,
        [options.appId, context.userId, input.availability, input.connectionState, currentVersion],
      );
      persisted = updated.rows[0];
    }
    if (!persisted) throw conflict("Presence version is stale");
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.presence.updated",
      objectType: "im_support_presence",
      objectId: context.userId,
      outcome: "SUCCESS",
      requestId,
      details: { availability: input.availability, connectionState: input.connectionState, appId: options.appId },
    });
    return presenceView(persisted);
  });
  if (result.availability === "AVAILABLE" && result.connectionState === "CONNECTED") options.wakeDispatch?.();
  return result;
}

async function claimInTransaction(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string): Promise<string> {
  const result = await withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const currentAccess = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(currentAccess, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId);
    requireSupportAccess(currentAccess, row.kind);
    if (row.state === "ACTIVE" && row.assignedAdminId === context.userId) return row.id;
    if (row.state !== "WAITING" || row.assignedAdminId) throw conflict("Consultation is already assigned");
    const priority = await assignWaitingOrders(client, options.appId, await readEligibleSupport(client, options.appId, locked));
    if (priority.more) return null;
    await readConsultation(client, options.appId, consultationId, true);
    const candidate = await reserveEligibleAdmin(client, options.appId, locked, row.kind, context.userId, await storedComplaintExclusions(client, row.id));
    if (!candidate) throw unavailable("当前客服不可接待新咨询");
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'ACTIVE', "assigned_admin_id" = $2, "peer_account_id" = $3,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $4`,
      [options.appId, context.userId, candidate.accountId, row.id],
    );
    await writeEvent(client, { consultationId: row.id, eventType: "CLAIMED", actorType: "admin", actorId: context.userId, toAdminId: context.userId, peerAccountId: candidate.accountId });
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "im.consultation.claimed", objectType: "im_consultation", objectId: row.id, outcome: "SUCCESS", requestId });
    return row.id;
  });
  if (!result) throw unavailable("已付款订单正在优先分配，请稍后重试");
  return result;
}

type TransferPlan = {
  operationId: string;
};

async function beginTransfer(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, targetAdminId: string, requestId: string): Promise<TransferPlan> {
  const manager = supportManagerAccount(options);
  if (!options.provider) throw unavailable("IM message scope provider is not configured");
  const result = await withTransaction(options.pool, async (client) => {
    const locked = await lockSupportMutation(client, options.appId, [], [context.userId, targetAdminId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const currentAccess = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(currentAccess, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    if (!ID_PATTERN.test(targetAdminId)) throw invalid("Target administrator is invalid");
    const row = await readConsultation(client, options.appId, consultationId);
    requireSupportAccess(currentAccess, row.kind, "transfer");
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    if (targetAdminId === context.userId) throw invalid("Target administrator must be different");
    if (row.messageScopeState !== "READY" || !row.messageScopeId || !row.peerAccountId || !row.assignedAdminId) throw unavailable("IM message scope is not ready for transfer");
    const priority = await assignWaitingOrders(client, options.appId, await readEligibleSupport(client, options.appId, locked));
    if (priority.more) return null;
    await readConsultation(client, options.appId, consultationId, true);
    const activeOperation = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 AND "state" IN ('PENDING', 'RUNNING', 'UNKNOWN')
        LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (activeOperation) throw unavailable("IM message scope operation is being recovered");
    const targetAccess = await loadEffectiveAdminAccess(client, targetAdminId);
    if (!requiredSupportPermission(row.kind).every((permission) => hasPermission(targetAccess, permission))) throw new SecurityApiError(403, "FORBIDDEN", "Target administrator is not authorized");
    const target = await reserveEligibleAdmin(client, options.appId, locked, row.kind, targetAdminId, await storedComplaintExclusions(client, row.id));
    if (!target) throw unavailable("目标客服当前不可接待");
    const updated = await client.query<{ messageScopeVersion: string | number }>(
      `UPDATE "zzsh_iam"."im_consultation"
        SET "message_scope_state" = 'TRANSFERRING', "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" = 'READY'
        RETURNING "message_scope_version" AS "messageScopeVersion"`,
      [options.appId, row.id],
    );
    if (updated.rowCount !== 1 || !updated.rows[0]) throw conflict("Consultation changed during transfer");
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id",
         "previous_admin_id", "target_admin_id", "previous_admin_account_id", "target_admin_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'TRANSFER',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [operationId, options.appId, row.id, updated.rows[0].messageScopeVersion, manager.accountId, row.userAccountId,
        row.assignedAdminId, target.adminUserId, row.peerAccountId, target.accountId, row.messageScopeId],
    );
    return {
      operationId,
    };
  });
  if (!result) throw unavailable("已付款订单正在优先分配，请稍后重试");
  return result;
}

async function transferWithScope(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, targetAdminId: string, requestId: string): Promise<{ consultation: ConsultationView }> {
  const plan = await beginTransfer(options, context, consultationId, targetAdminId, requestId);
  await runScopeOperationNow(options, plan.operationId);
  return readAdminConsultationView(options, context, consultationId);
}

type ClosePlan = { operationId: string };

async function beginClose(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string): Promise<ClosePlan | null> {
  return withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    requireSupportAccess(access, row.kind);
    const latestOperation = (await client.query<{ state: MessageScopeOperationState }>(
      `SELECT "state" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (latestOperation && latestOperation.state !== "SUCCEEDED") throw unavailable("IM message scope operation is being recovered");
    if (!row.messageScopeId) {
      if (latestOperation || !["PENDING", "FAILED", "REVOKED"].includes(row.messageScopeState)) {
        throw unavailable("IM message scope requires recovery before close");
      }
      return null;
    }
    if (!options.provider) throw unavailable("IM message scope provider is not configured");
    if (row.messageScopeState !== "READY" && row.messageScopeState !== "FAILED") throw unavailable("IM message scope is not ready to close");
    const manager = supportManagerAccount(options);
    const updated = await client.query<{ messageScopeVersion: string | number }>(
      `UPDATE "zzsh_iam"."im_consultation"
        SET "message_scope_state" = 'REVOKING', "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "message_scope_state" IN ('READY', 'FAILED')
        RETURNING "message_scope_version" AS "messageScopeVersion"`,
      [options.appId, row.id],
    );
    if (updated.rowCount !== 1 || !updated.rows[0]) throw conflict("Consultation changed during close");
    const operationId = scopeOperationId();
    await client.query(
      `INSERT INTO "zzsh_iam"."im_consultation_scope_operation"
        ("id", "app_id", "consultation_id", "operation_type", "scope_version", "owner_account_id", "user_account_id", "provider_team_id")
       VALUES ($1,$2,$3,'CLOSE',$4,$5,$6,$7)`,
      [operationId, options.appId, row.id, updated.rows[0].messageScopeVersion, manager.accountId, row.userAccountId, row.messageScopeId],
    );
    return { operationId };
  });
}

async function completeLocalClose(options: ConsultationRouteOptions, context: AdminContext, consultationId: string, requestId: string): Promise<void> {
  await withTransaction(options.pool, async (client) => {
    await lockSupportMutation(client, options.appId, [], [context.userId]);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const row = await readConsultation(client, options.appId, consultationId, true);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    requireSupportAccess(access, row.kind);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw conflict("Consultation changed during close");
    if (row.messageScopeId) throw conflict("IM message scope requires remote close");
    // No Team ever existed: close the business object without claiming remote revocation.
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "state" = 'CLOSED',
              "version" = "version" + 1, "message_scope_version" = "message_scope_version" + 1,
              "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE' AND "assigned_admin_id" = $3`,
      [options.appId, consultationId, context.userId],
    );
    await decrementPresence(client, options.appId, context.userId);
    await writeEvent(client, { consultationId, eventType: "CLOSED", actorType: "admin", actorId: context.userId, fromAdminId: context.userId, peerAccountId: row.peerAccountId });
    await recordAudit(client, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId, action: "im.consultation.closed", objectType: "im_consultation", objectId: consultationId, outcome: "SUCCESS", requestId });
  });
}

export async function claimConsultation(options: ConsultationRouteOptions, context: AdminContext, id: string, requestId: string): Promise<{ consultation: ConsultationView }> {
  const consultationId = await claimInTransaction(options, context, id, requestId);
  await ensureMessageScope(options, consultationId);
  return readAdminConsultationView(options, context, consultationId);
}

export function transferConsultation(options: ConsultationRouteOptions, context: AdminContext, id: string, targetAdminId: string, requestId: string): Promise<{ consultation: ConsultationView }> {
  return transferWithScope(options, context, id, targetAdminId, requestId);
}

export async function closeConsultation(options: ConsultationRouteOptions, context: AdminContext, id: string, requestId: string): Promise<{ consultation: ConsultationView }> {
  const plan = await beginClose(options, context, id, requestId);
  if (plan) {
    await runScopeOperationNow(options, plan.operationId);
  } else {
    await completeLocalClose(options, context, id, requestId);
  }
  return readAdminConsultationView(options, context, id);
}

export async function retryMessageScopeOperation(
  options: ConsultationRouteOptions,
  context: AdminContext,
  consultationId: string,
  requestId: string,
): Promise<{ consultation: ConsultationView }> {
  const closeReconciliationClaim = await claimCloseReconciliation(options, context, consultationId, requestId);
  if (closeReconciliationClaim === "SUCCEEDED") return readAdminConsultationView(options, context, consultationId);
  if (closeReconciliationClaim) {
    const result = await executeScopeOperation(options, closeReconciliationClaim, "CLOSE_ABSENCE");
    if (result !== "SUCCEEDED") throw unavailable("IM close remains blocked until the remote team state is confirmed");
    return readAdminConsultationView(options, context, consultationId);
  }
  const operationId = await withTransaction(options.pool, async (client) => {
    await lockDispatchGate(client, options.appId);
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    await assertAdminContextInTransaction(client, context);
    const access = await loadEffectiveAdminAccess(client, context.userId);
    if (!hasPermission(access, ADMIN_PERMISSION.imSupportTransfer)) throw new SecurityApiError(403, "FORBIDDEN", "Permission required");
    const row = await readConsultation(client, options.appId, consultationId, true);
    if (row.state !== "ACTIVE" || row.assignedAdminId !== context.userId) throw new SecurityApiError(403, "FORBIDDEN", "Consultation is not assigned to the current administrator");
    const operation = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."im_consultation_scope_operation"
        WHERE "app_id" = $1 AND "consultation_id" = $2 ORDER BY "created_at" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
      [options.appId, consultationId],
    )).rows[0];
    if (!operation) throw new SecurityApiError(404, "NOT_FOUND", "IM scope operation not found");
    const detail = await readScopeOperation(client, options.appId, operation.id, true);
    if (detail.state === "SUCCEEDED") return detail.id;
    if (detail.state !== "FAILED" && detail.state !== "NEEDS_REVIEW") throw unavailable("IM message scope operation is still running");
    if (remoteActionMayStillBeInFlight(detail.lastFailureClass)) {
      throw unavailable("IM 远端结果未知或尚未完成对账，暂不能直接重试");
    }
    const nextScopeState = detail.operationType === "CREATE" ? "PROVISIONING" : detail.operationType === "TRANSFER" ? "TRANSFERRING" : "REVOKING";
    if (detail.operationType === "CREATE") {
      if (row.messageScopeId && detail.providerTeamId && row.messageScopeId !== detail.providerTeamId) throw conflict("IM scope team changed during recovery");
      if (!row.peerAccountId || row.peerAccountId !== detail.targetAdminAccountId) throw conflict("IM scope assignment changed during recovery");
    } else if (detail.operationType === "TRANSFER") {
      if (row.messageScopeId !== detail.providerTeamId || row.assignedAdminId !== detail.previousAdminId || row.peerAccountId !== detail.previousAdminAccountId) throw conflict("IM transfer assignment changed during recovery");
    } else if (row.messageScopeId !== detail.providerTeamId) {
      throw conflict("IM close team changed during recovery");
    }
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation"
          SET "message_scope_state" = $3, "message_scope_version" = "message_scope_version" + 1,
              "version" = "version" + 1, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" = 'ACTIVE'`,
      [options.appId, consultationId, nextScopeState],
    );
    await client.query(
      `UPDATE "zzsh_iam"."im_consultation_scope_operation"
          SET "state" = 'PENDING', "attempt_count" = 0, "next_retry_at" = clock_timestamp(),
              "lease_until" = NULL, "lease_token_hash" = NULL, "last_failure_class" = NULL,
              "last_failure_detail" = NULL, "updated_at" = clock_timestamp()
        WHERE "app_id" = $1 AND "id" = $2 AND "state" IN ('FAILED', 'NEEDS_REVIEW')`,
      [options.appId, detail.id],
    );
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "im.scope.recovery.retried",
      objectType: "im_consultation_scope_operation",
      objectId: detail.id,
      outcome: "SUCCESS",
      requestId,
      details: { operationType: detail.operationType },
    });
    return detail.id;
  });
  await runScopeOperationNow(options, operationId);
  return readAdminConsultationView(options, context, consultationId);
}
