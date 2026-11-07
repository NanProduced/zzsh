import type { INestApplication } from "@nestjs/common";
import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { readAdminGameScope, scopeAllowsGame } from "../auth/admin-scope";
import { assertAdminContextInTransaction, type AdminContext, type AuthSecurityNodeRequest, type AuthSecurityNodeResponse } from "../auth/auth-security";
import { assertActiveInTransaction } from "../auth/user-identity";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { verifySupplierRequest } from "./order-im-events";

export const READ_COPY_PATH = "/api/v1/im/read-events/copy";
type Options = { pool: Pool; appId: string; receiverReady: boolean };
type SettingsRow = { version: number; enabled: boolean; publicOrigin: string | null; updatedBy: string; operationId: string;
  updatedAt: Date | string; lastVerifiedAt: Date | string | null; lastEventAt: Date | string | null };
const columns = `version,enabled,public_origin AS "publicOrigin",updated_by AS "updatedBy",operation_id AS "operationId",
  updated_at AS "updatedAt",last_verified_at AS "lastVerifiedAt",last_event_at AS "lastEventAt"`;
const invalid = (message: string) => new SecurityApiError(400, "INVALID_ARGUMENT", message);
const iso = (value: Date | string | null | undefined) => value == null ? null : new Date(value).toISOString();

export function parseReadCopySettings(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Invalid read-copy settings");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !["version", "enabled", "publicOrigin", "operationId"].includes(k))
    || !Number.isSafeInteger(b.version) || (b.version as number) < 0 || typeof b.enabled !== "boolean"
    || typeof b.operationId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(b.operationId)) throw invalid("Invalid settings version or operation");
  let origin: string | null = null;
  if (b.publicOrigin !== null && b.publicOrigin !== "") {
    if (typeof b.publicOrigin !== "string" || b.publicOrigin.length > 512) throw invalid("请填写公网 HTTPS 域名。");
    let url: URL;
    try { url = new URL(b.publicOrigin); } catch { throw invalid("请填写公网 HTTPS 域名。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".")
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw invalid("仅支持公网 HTTPS 域名，不接受本地地址、路径或凭据。");
    origin = url.origin;
  }
  if (b.enabled && !origin) throw invalid("启用前请配置公网 HTTPS 域名。");
  return { version: b.version as number, enabled: b.enabled, publicOrigin: origin, operationId: b.operationId };
}

async function readSettings(db: PoolClient, appId: string) {
  return (await db.query<SettingsRow>(`SELECT ${columns} FROM zzsh_iam.im_read_copy_settings WHERE app_id=$1`, [appId])).rows[0];
}
async function lockSettings(db: PoolClient, appId: string) {
  const locked = (await db.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked`, ["im_read_copy:" + appId])).rows[0]?.locked;
  if (!locked) throw new SecurityApiError(503, "IM_UNAVAILABLE", "阅读同步设置正在处理，请稍后重试。");
}
function settingsView(row: SettingsRow | undefined, ready: boolean) {
  return { version: row?.version ?? 0, enabled: row?.enabled ?? false, publicOrigin: row?.publicOrigin ?? null,
    callbackPath: READ_COPY_PATH, callbackUrl: row?.publicOrigin ? row.publicOrigin + READ_COPY_PATH : null,
    receiverReady: ready, lastVerifiedAt: iso(row?.lastVerifiedAt), lastEventAt: iso(row?.lastEventAt), updatedAt: iso(row?.updatedAt),
    status: !ready ? "RECEIVER_UNAVAILABLE" as const : !row?.enabled ? "DISABLED" as const
      : !row.lastVerifiedAt && !row.lastEventAt ? "WAITING_FOR_CALLBACK" as const : "CALLBACK_OBSERVED" as const,
    serverNow: new Date().toISOString() };
}

export async function readCopySettings(options: Options, context: AdminContext, body: unknown, requestId: string) {
  const input = body === undefined ? undefined : parseReadCopySettings(body);
  return withTransaction(options.pool, async db => {
    await assertAdminContextInTransaction(db, context);
    const access = await loadEffectiveAdminAccess(db, context.userId);
    requirePermission(access, ADMIN_PERMISSION.imSupportManagementRead);
    if (input) requirePermission(access, ADMIN_PERMISSION.imSupportIntegrationConfigure);
    if (input) await lockSettings(db, options.appId);
    const current = await readSettings(db, options.appId);
    if (!input) return settingsView(current, options.receiverReady);
    if (input.enabled && !options.receiverReady) throw new SecurityApiError(409, "CONFLICT", "服务端尚未准备好消息抄送接收器。");
    if (current?.operationId === input.operationId) {
      if (current.updatedBy !== context.userId || current.enabled !== input.enabled || current.publicOrigin !== input.publicOrigin)
        throw new SecurityApiError(409, "CONFLICT", "Settings operation identity conflict");
      return settingsView(current, options.receiverReady);
    }
    if ((current?.version ?? 0) !== input.version) throw new SecurityApiError(409, "CONFLICT", "设置已被修改，请重新加载后保存。");
    const row = (await db.query<SettingsRow>(`INSERT INTO zzsh_iam.im_read_copy_settings(app_id,version,enabled,public_origin,updated_by,operation_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(app_id) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,
      public_origin=EXCLUDED.public_origin,updated_by=EXCLUDED.updated_by,operation_id=EXCLUDED.operation_id,updated_at=clock_timestamp(),
      last_verified_at=CASE WHEN im_read_copy_settings.public_origin IS DISTINCT FROM EXCLUDED.public_origin
        OR im_read_copy_settings.enabled IS DISTINCT FROM EXCLUDED.enabled THEN NULL ELSE im_read_copy_settings.last_verified_at END,
      last_event_at=CASE WHEN im_read_copy_settings.public_origin IS DISTINCT FROM EXCLUDED.public_origin
        OR im_read_copy_settings.enabled IS DISTINCT FROM EXCLUDED.enabled THEN NULL ELSE im_read_copy_settings.last_event_at END
      RETURNING ${columns}`, [options.appId, input.version + 1, input.enabled, input.publicOrigin, context.userId, input.operationId])).rows[0]!;
    await recordAudit(db, { actorType: "admin", actorId: context.userId, sessionId: context.sessionId,
      action: "im.read_copy.settings.updated", objectType: "im_read_copy_settings", objectId: options.appId, outcome: "SUCCESS", requestId,
      details: { version: row.version, enabled: input.enabled, publicOrigin: input.publicOrigin, operationId: input.operationId } });
    return settingsView(row, options.receiverReady);
  });
}

export type ReadCopyEvent = { accountId: string; teamId: string; readMessageTime: number };
export function parseReadCopyEvent(value: unknown, nowMs: number): ReadCopyEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid read-copy event");
  const b = value as Record<string, unknown>;
  if ((b.eventType !== 85 && b.eventType !== "85") || (b.msgType !== 1 && b.msgType !== "1")
    || typeof b.accid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$/.test(b.accid)
    || typeof b.ackTeamId !== "string" || !/^[1-9][0-9]{0,18}$/.test(b.ackTeamId)) throw invalid("Only a Team read-copy event is supported");
  const time = typeof b.ackMsgTime === "string" && /^[1-9][0-9]{0,14}$/.test(b.ackMsgTime) ? Number(b.ackMsgTime) : b.ackMsgTime;
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0 || time > nowMs) throw invalid("Invalid read-message time");
  return { accountId: b.accid, teamId: b.ackTeamId, readMessageTime: time };
}

/** Advance read pointers with the supplier's message position, never with callback arrival time. */
export async function applyReadCopy(db: PoolClient, appId: string, event: ReadCopyEvent): Promise<"APPLIED" | "UNCHANGED" | "IGNORED"> {
  const mapping = (await db.query<{ id: string; realm: string; identity_kind: string; platform_subject_id: string }>(
    `SELECT id,realm,identity_kind,platform_subject_id FROM zzsh_iam.im_identity_mapping
      WHERE provider='yunxin' AND app_id=$1 AND account_id=$2 AND status='READY'`, [appId, event.accountId])).rows[0];
  if (!mapping || !(mapping.realm === "user" && mapping.identity_kind === "USER" || mapping.realm === "admin" && mapping.identity_kind === "ADMIN")) return "IGNORED";
  let adminAccess;
  if (mapping.realm === "user") {
    try { await assertActiveInTransaction(db, mapping.platform_subject_id, "READ"); }
    catch (error) { if (error instanceof SecurityApiError && error.status === 401) return "IGNORED"; throw error; }
  } else {
    adminAccess = await loadEffectiveAdminAccess(db, mapping.platform_subject_id);
    if (!hasPermission(adminAccess, ADMIN_PERMISSION.imSupportRead) || !hasPermission(adminAccess, ADMIN_PERMISSION.imSupportAccept) || adminAccess?.passwordChangeRequired) return "IGNORED";
    const admin = (await db.query<{ suspended: boolean }>(`SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1`, [mapping.platform_subject_id])).rows[0];
    if (!admin || admin.suspended) return "IGNORED";
  }
  const thread = (await db.query<{ id: string; user_id: string; user_account_id: string; created_at: Date; round_id: string | null }>(
    `SELECT t.id,t.user_id,t.user_account_id,t.created_at,c.id AS round_id FROM zzsh_iam.im_support_thread t
      LEFT JOIN zzsh_iam.im_consultation c ON c.thread_id=t.id AND c.app_id=t.app_id AND c.state='ACTIVE'
        AND c.assigned_admin_id=$3 AND c.peer_account_id=$4 AND c.created_at<=to_timestamp($5::double precision/1000)
      WHERE t.app_id=$1 AND t.message_scope_id=$2 AND t.message_scope_state='READY'`,
    [appId, event.teamId, mapping.platform_subject_id, event.accountId, event.readMessageTime])).rows[0];
  let scopeKind: "SUPPORT" | "ORDER", scopeId: string;
  if (thread) {
    if (new Date(thread.created_at).getTime() > event.readMessageTime
      || (mapping.realm === "user" ? thread.user_id !== mapping.platform_subject_id || thread.user_account_id !== event.accountId : !thread.round_id)) return "IGNORED";
    scopeKind = "SUPPORT"; scopeId = thread.id;
  } else {
    const order = (await db.query<{ order_id: string; game_id: string; party: string }>(
      `SELECT g.order_id,COALESCE(o.game_id,l.game_id) AS game_id,mm.party FROM zzsh_order.im_order_group g
        LEFT JOIN zzsh_order.rental_order o ON o.id=g.order_id AND g.legacy_order_id IS NULL
        LEFT JOIN zzsh_order.legacy_order_read_snapshot l ON l.id=g.legacy_order_id
        JOIN zzsh_order.im_order_member mm ON mm.order_id=g.order_id AND mm.app_id=g.app_id AND mm.identity_id=$3 AND mm.state='JOINED'
        WHERE g.app_id=$1 AND g.team_id=$2 AND g.team_state='READY' AND mm.joined_at<=to_timestamp($4::double precision/1000)
          AND (($5='admin' AND mm.party='STAFF') OR ($5='user' AND
            ((mm.party='BUYER' AND COALESCE(o.renter_user_id,l.renter_user_id)=$6) OR (mm.party='OWNER' AND COALESCE(o.owner_user_id,l.owner_user_id)=$6))))`,
      [appId, event.teamId, mapping.id, event.readMessageTime, mapping.realm, mapping.platform_subject_id])).rows[0];
    if (!order) return "IGNORED";
    if (mapping.realm === "admin" && !scopeAllowsGame(await readAdminGameScope(db, mapping.platform_subject_id), adminAccess!.isBoss, order.game_id)) return "IGNORED";
    scopeKind = "ORDER"; scopeId = order.order_id;
  }
  const changed = await db.query(`INSERT INTO zzsh_iam.im_read_copy_position(app_id,team_id,account_id,scope_kind,scope_id,read_message_time)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(app_id,team_id,account_id) DO UPDATE
      SET read_message_time=EXCLUDED.read_message_time,received_at=clock_timestamp()
      WHERE im_read_copy_position.scope_kind=EXCLUDED.scope_kind AND im_read_copy_position.scope_id=EXCLUDED.scope_id
        AND im_read_copy_position.read_message_time<EXCLUDED.read_message_time RETURNING read_message_time`,
    [appId, event.teamId, event.accountId, scopeKind, scopeId, event.readMessageTime]);
  if (!changed.rowCount) return "UNCHANGED";
  if (scopeKind === "SUPPORT" && mapping.realm === "user") await db.query(`UPDATE zzsh_iam.im_support_thread
    SET user_read_at=GREATEST(user_read_at,to_timestamp($3::double precision/1000))
    WHERE app_id=$1 AND id=$2 AND user_id=$4 AND user_account_id=$5 AND message_scope_state='READY' AND message_scope_id=$6`,
    [appId, scopeId, event.readMessageTime, mapping.platform_subject_id, event.accountId, event.teamId]);
  // Clear only when the supplier position covers the latest known message; a late copy must not erase new unread work.
  if (scopeKind === "SUPPORT") await db.query(`UPDATE zzsh_iam.im_consultation SET
    admin_read_at=CASE WHEN $4='admin' THEN GREATEST(admin_read_at,to_timestamp($3::double precision/1000)) ELSE admin_read_at END,
    user_unread_count=CASE WHEN $4='user' AND last_message_at<=to_timestamp($3::double precision/1000) THEN 0 ELSE user_unread_count END,
    admin_unread_count=CASE WHEN $4='admin' AND last_message_at<=to_timestamp($3::double precision/1000) THEN 0 ELSE admin_unread_count END
    WHERE app_id=$1 AND thread_id=$2
      AND EXISTS(SELECT 1 FROM zzsh_iam.im_support_thread t WHERE t.app_id=$1 AND t.id=$2 AND t.message_scope_id=$8 AND t.message_scope_state='READY')
      AND (($4='user' AND user_id=$5) OR ($4='admin' AND id=$6 AND state='ACTIVE' AND assigned_admin_id=$5 AND peer_account_id=$7))`,
    [appId, scopeId, event.readMessageTime, mapping.realm, mapping.platform_subject_id, thread?.round_id ?? null, event.accountId, event.teamId]);
  else await db.query(`UPDATE zzsh_order.im_order_unread u SET unread_count=0
    FROM zzsh_order.im_order_activity a WHERE u.order_id=$1 AND u.identity_id=$2 AND a.order_id=u.order_id
      AND a.app_id=$3 AND a.last_message_at<=to_timestamp($4::double precision/1000)
      AND EXISTS(SELECT 1 FROM zzsh_order.im_order_group g JOIN zzsh_order.im_order_member mm ON mm.order_id=g.order_id AND mm.app_id=g.app_id
        WHERE g.order_id=u.order_id AND g.app_id=$3 AND g.team_id=$5 AND g.team_state='READY' AND mm.identity_id=$2 AND mm.state='JOINED')`,
    [scopeId, mapping.id, appId, event.readMessageTime, event.teamId]);
  return "APPLIED";
}

type ReceiverOptions = { pool: Pool; appId: string; appSecret: string; now?: () => number };
export async function handleReadCopy(request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse, options: ReceiverOptions): Promise<void> {
  const send = (status: number) => { response.status(status).setHeader("Cache-Control", "no-store").json({ ok: status === 200 }); };
  const path = request.originalUrl ?? request.url ?? "";
  if (request.method?.toUpperCase() !== "POST" || path !== READ_COPY_PATH) { send(404); return; }
  const raw = (request as { rawBody?: unknown }).rawBody;
  if (!Buffer.isBuffer(raw)) { send(503); return; }
  const now = (options.now ?? Date.now)();
  const verified = verifySupplierRequest({ rawBody: raw, headers: request.headers, appKey: options.appId, appSecret: options.appSecret, nowMs: now, freshnessMs: 300_000 });
  if (!verified.ok || verified.stale) { send(403); return; }
  let body: unknown;
  try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { send(400); return; }
  const probe = body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
  let event: ReadCopyEvent | undefined;
  try { if (!probe) event = parseReadCopyEvent(body, now); } catch { send(400); return; }
  try {
    await withTransaction(options.pool, async db => {
      await lockSettings(db, options.appId);
      const settings = await readSettings(db, options.appId);
      if (!settings?.enabled || !settings.publicOrigin) throw new Error("read-copy disabled");
      if (event) await applyReadCopy(db, options.appId, event);
      await db.query(`UPDATE zzsh_iam.im_read_copy_settings SET ${probe ? "last_verified_at" : "last_event_at"}=clock_timestamp() WHERE app_id=$1`, [options.appId]);
    });
    send(200);
  } catch { send(503); }
}

export function mountReadCopyHandler(app: INestApplication, options: ReceiverOptions): void {
  const server = app.getHttpAdapter().getInstance() as { use(path: string, handler: (request: AuthSecurityNodeRequest, response: AuthSecurityNodeResponse) => Promise<void>): void };
  server.use(READ_COPY_PATH, (request, response) => handleReadCopy(request, response, options));
}
