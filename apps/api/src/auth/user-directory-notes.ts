import type { PoolClient } from "pg";

import { validateIdempotencyKey } from "../contracts/api-v1";
import { conflict, ensureOnlyFields, fingerprintRequest, forbidden, invalid, newSupplyId, notFound, sha256Hex, withIdempotency } from "../supply/supply-util";
import { requirePermission, hasPermission, type EffectiveAdminAccess } from "./admin-authorization";
import { recordAudit } from "./security-core";

export const USER_NOTE_CREATE_OPERATION = "user.note.create";
export const USER_NOTE_DELETE_OPERATION = "user.note.delete";
export type UserNoteActor = { adminId: string; sessionId: string; requestId: string };
export type UserNotePage = { limit: number; cursor?: string };
type NoteRow = { id: string; text: string; authorId: string; authorName: string | null; createdAt: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function parseUserNoteBody(body: unknown): { text: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Note body is invalid");
  const fields = body as Record<string, unknown>;
  ensureOnlyFields(fields, ["text"]);
  if (typeof fields.text !== "string") throw invalid("Note text is required", "text");
  const text = fields.text.trim();
  const length = Array.from(text).length;
  if (length < 2 || length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw invalid("Note text must contain 2 to 1000 characters", "text");
  return { text };
}

export function parseUserNotePage(query: URLSearchParams): UserNotePage {
  if (query.getAll("limit").length > 1 || query.getAll("cursor").length > 1) throw invalid("Note pagination is repeated");
  const raw = query.get("limit");
  if (raw !== null && (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100)) throw invalid("Note limit is invalid", "limit");
  return { limit: raw === null ? 20 : Number(raw), ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {}) };
}

function assertIds(actor: UserNoteActor, userId: string, noteId?: string): void {
  if (!ID.test(userId) || !ID.test(actor.adminId) || !actor.sessionId || !actor.requestId || (noteId !== undefined && !ID.test(noteId))) throw invalid("Note subject is invalid");
}

async function requireUser(client: PoolClient, userId: string, lock = false): Promise<void> {
  if (!(await client.query(`SELECT 1 FROM zzsh_auth_user."user" WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [userId])).rowCount) throw notFound();
}

function noteCursor(cursor: string | undefined, key: string): { time: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; f?: unknown; t?: unknown; i?: unknown };
    if (parsed.v !== 1 || parsed.f !== key || typeof parsed.t !== "string" || !CURSOR_TIME.test(parsed.t)
      || !Number.isFinite(Date.parse(parsed.t)) || new Date(parsed.t).toISOString().slice(0, 19) !== parsed.t.slice(0, 19)
      || typeof parsed.i !== "string" || !ID.test(parsed.i)) throw new Error();
    return { time: parsed.t, id: parsed.i };
  } catch { throw conflict("Note cursor is invalid; reload the first page"); }
}

export async function listUserNotes(client: PoolClient, actor: UserNoteActor, access: EffectiveAdminAccess, userId: string, page: UserNotePage) {
  assertIds(actor, userId);
  requirePermission(access, "user.directory.read");
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) throw invalid("Note limit is invalid", "limit");
  const key = sha256Hex(JSON.stringify(["user-notes:v1", actor.adminId, userId, page.limit]));
  const cursor = noteCursor(page.cursor, key);
  await requireUser(client, userId);
  const rows = (await client.query<NoteRow>(
    `SELECT n.id, n.body AS text, n.author_admin_id AS "authorId", a.name AS "authorName",
            to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
       FROM zzsh_iam.user_note n LEFT JOIN zzsh_auth_admin."user" a ON a.id=n.author_admin_id
      WHERE n.user_id=$1 AND n.deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR n.created_at<$2::timestamptz OR (n.created_at=$2::timestamptz AND n.id COLLATE "C"<$3))
      ORDER BY n.created_at DESC, n.id COLLATE "C" DESC LIMIT $4`,
    [userId, cursor?.time ?? null, cursor?.id ?? null, page.limit + 1],
  )).rows;
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: items.map(row => ({ id: row.id, text: row.text, author: { id: row.authorId, displayName: row.authorName || "已删除管理员" }, createdAt: row.createdAt,
      canDelete: hasPermission(access, "user.note.manage") || row.authorId === actor.adminId && hasPermission(access, "user.note.write") })),
    nextCursor: rows.length > page.limit && last ? Buffer.from(JSON.stringify({ v: 1, f: key, t: last.createdAt, i: last.id })).toString("base64url") : null,
    capabilities: { canCreate: hasPermission(access, "user.note.write"), canManage: hasPermission(access, "user.note.manage") },
  };
}

/** Caller supplies a write transaction and revalidates the current admin session in that transaction. */
export async function createUserNote(client: PoolClient, actor: UserNoteActor, access: EffectiveAdminAccess, input: { userId: string; text: string }, idempotencyKey: string) {
  assertIds(actor, input.userId);
  const key = validateIdempotencyKey(idempotencyKey);
  const { text } = parseUserNoteBody({ text: input.text });
  return withIdempotency(client, { realm: "admin", principalId: actor.adminId, operation: USER_NOTE_CREATE_OPERATION, resourceId: input.userId }, key,
    fingerprintRequest(USER_NOTE_CREATE_OPERATION, input.userId, { text }),
    async () => {
      requirePermission(access, "user.directory.read");
      requirePermission(access, "user.note.write");
      await requireUser(client, input.userId, true);
    }, async () => {
      const noteId = newSupplyId("unote");
      await client.query(`INSERT INTO zzsh_iam.user_note(id,user_id,body,author_admin_id) VALUES($1,$2,$3,$4)`, [noteId, input.userId, text, actor.adminId]);
      await recordAudit(client, { actorType: "admin", actorId: actor.adminId, sessionId: actor.sessionId, requestId: actor.requestId,
        action: USER_NOTE_CREATE_OPERATION, objectType: "user", objectId: input.userId, outcome: "SUCCESS", details: { noteId, authorAdminId: actor.adminId } });
      return { status: 201, body: { userId: input.userId, noteId, created: true } };
    });
}

/** Author checks also run on an idempotent replay; receipts never contain the note body. */
export async function deleteUserNote(client: PoolClient, actor: UserNoteActor, access: EffectiveAdminAccess, input: { userId: string; noteId: string }, idempotencyKey: string) {
  assertIds(actor, input.userId, input.noteId);
  const key = validateIdempotencyKey(idempotencyKey);
  let deletedAt: string | null = null;
  return withIdempotency(client, { realm: "admin", principalId: actor.adminId, operation: USER_NOTE_DELETE_OPERATION, resourceId: input.userId }, key,
    fingerprintRequest(USER_NOTE_DELETE_OPERATION, input.userId, { noteId: input.noteId }),
    async () => {
      requirePermission(access, "user.directory.read");
      if (!hasPermission(access, "user.note.write") && !hasPermission(access, "user.note.manage")) throw forbidden();
      await requireUser(client, input.userId, true);
      const note = (await client.query<{ authorId: string; deletedAt: string | null }>(
        `SELECT author_admin_id AS "authorId", deleted_at AS "deletedAt" FROM zzsh_iam.user_note WHERE id=$1 AND user_id=$2 FOR UPDATE`, [input.noteId, input.userId],
      )).rows[0];
      if (!note) throw notFound();
      if (note.authorId !== actor.adminId && !hasPermission(access, "user.note.manage")) throw forbidden("Only the author or a note manager can delete this note");
      deletedAt = note.deletedAt;
    }, async () => {
      if (deletedAt !== null) throw notFound();
      await client.query(`UPDATE zzsh_iam.user_note SET deleted_at=clock_timestamp(),deleted_by=$3 WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [input.noteId, input.userId, actor.adminId]);
      await recordAudit(client, { actorType: "admin", actorId: actor.adminId, sessionId: actor.sessionId, requestId: actor.requestId,
        action: USER_NOTE_DELETE_OPERATION, objectType: "user", objectId: input.userId, outcome: "SUCCESS", details: { noteId: input.noteId } });
      return { status: 200, body: { userId: input.userId, noteId: input.noteId, deleted: true } };
    });
}
