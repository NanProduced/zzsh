import type { PoolClient } from "pg";

import { assertPlatformMediaBinding } from "./catalog";
import {
  assertGameScope,
  assertGameExists,
  bumpCatalogRevision,
  conflict,
  invalid,
  newSupplyId,
  notFound,
  optionalBoolean,
  optionalInteger,
  optionalNullableString,
  optionalString,
  optionalTrimmedString,
  parseExpectedRevision,
  requiredString,
} from "./supply-util";
import {
  GAME_SERVICE,
  readGameService,
  requirePublicGameService,
  requireSupportedGameService,
  unsupportedGameService,
} from "./game-services";

const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;
const SOURCE_NAMESPACE_PATTERN = /^[a-z][a-z0-9_-]{1,31}:[a-z][a-z0-9_.-]{1,63}$/;
const MODES = new Set(["HAZARD", "BATTLEFIELD", "GENERAL"]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export type GunsmithMode = "HAZARD" | "BATTLEFIELD" | "GENERAL";
export type GunsmithStatus = "ACTIVE" | "WITHDRAWN";

export type GunsmithClassification = {
  id: string;
  gameId: string;
  code: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
  revision: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};

export type FirearmRecord = {
  id: string;
  gameId: string;
  code: string;
  name: string;
  classificationId: string | null;
  classificationCode?: string | null;
  classificationName?: string | null;
  enabled: boolean;
  sortOrder: number;
  mediaId: string | null;
  codeCount?: number;
  revision: string;
  updatedAt: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};

export type FirearmAlias = {
  id: string;
  gameId: string;
  firearmId: string;
  locale: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
  revision: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};

export type GunsmithCodeRecord = {
  id: string;
  gameId: string;
  firearmId: string;
  code: string;
  note: string;
  modeCode: GunsmithMode | null;
  status: GunsmithStatus;
  lastReviewedAt: string | null;
  revision: string;
  updatedAt: string;
  sourceNamespace: string | null;
  sourceToken: string | null;
  sourceNote: string | null;
};

export type PublicFirearmRecord = Pick<FirearmRecord, "id" | "gameId" | "code" | "name" | "classificationId" | "classificationCode" | "classificationName" | "enabled" | "sortOrder" | "mediaId" | "codeCount" | "updatedAt">;

function stableCode(body: Record<string, unknown>, field = "code"): string {
  const value = requiredString(body, field, 64);
  if (!CODE_PATTERN.test(value)) throw invalid("Stable code is invalid", field);
  return value;
}

function readNote(body: Record<string, unknown>, field = "note"): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 500) throw invalid("Note is invalid", field);
  return value.trim();
}

function readMode(body: Record<string, unknown>, field = "modeCode"): GunsmithMode | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !MODES.has(value)) throw invalid("Mode is invalid", field);
  return value as GunsmithMode;
}

function readTimestamp(body: Record<string, unknown>, field: string): Date | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !RFC3339.test(value)) throw invalid("Timestamp is invalid", field);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw invalid("Timestamp is invalid", field);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw invalid("Timestamp is invalid", field);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHours = parts[7] === "Z" ? 0 : Number(parts[7]!.slice(1, 3));
  const offsetMinutes = parts[7] === "Z" ? 0 : Number(parts[7]!.slice(4));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) throw invalid("Timestamp is invalid", field);
  return new Date(parsed);
}

function readSource(body: Record<string, unknown>): { namespace: string | null; token: string | null; note: string | null } {
  const namespace = optionalTrimmedString(body, "sourceNamespace", 64) ?? null;
  const token = optionalTrimmedString(body, "sourceToken", 200) ?? null;
  if ((namespace === null) !== (token === null)) throw invalid("Source namespace and token must be provided together");
  if (namespace !== null && !SOURCE_NAMESPACE_PATTERN.test(namespace)) throw invalid("Source namespace must identify its source system and entity", "sourceNamespace");
  return { namespace, token, note: optionalTrimmedString(body, "sourceNote", 500) ?? null };
}

function publicText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function searchText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > 120) throw invalid("Search query is invalid");
  return text;
}

function cursorTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) || Number.isNaN(Date.parse(value))) throw invalid("Cursor is invalid");
  const date = new Date(value);
  if (date.toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalid("Cursor is invalid");
  return value;
}

function parseCursor(value: string | undefined, expected: Record<string, unknown>): { sortOrder?: number; updatedAt: string; id: string } | undefined {
  if (!value) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid("Cursor is invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalid("Cursor is invalid");
  const record = decoded as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if ((record[key] ?? null) !== (expectedValue ?? null)) throw conflict("Cursor does not match the current filters; refresh and retry");
  }
  if (record.v !== 1 || typeof record.id !== "string") throw invalid("Cursor is invalid");
  const sortOrder = record.sortOrder;
  if (sortOrder !== undefined && (typeof sortOrder !== "number" || !Number.isInteger(sortOrder) || sortOrder < -100000 || sortOrder > 100000)) throw invalid("Cursor is invalid");
  return { ...(sortOrder === undefined ? {} : { sortOrder }), updatedAt: cursorTime(record.updatedAt), id: record.id };
}

function nextCursor(expected: Record<string, unknown>, last: { sortOrder?: number; updatedAt: string; id: string } | undefined, hasMore: boolean): string | null {
  if (!hasMore || !last) return null;
  return Buffer.from(JSON.stringify({ v: 1, ...expected, ...(last.sortOrder === undefined ? {} : { sortOrder: last.sortOrder }), updatedAt: last.updatedAt, id: last.id })).toString("base64url");
}

async function readFirearmGame(client: PoolClient, firearmId: string): Promise<{ id: string; gameId: string; enabled: boolean }> {
  const row = (await client.query<{ id: string; gameId: string; enabled: boolean }>(
    `SELECT "id", "game_id" AS "gameId", "enabled" FROM "zzsh_supply"."firearm" WHERE "id" = $1`,
    [firearmId],
  )).rows[0];
  if (!row) throw notFound();
  return row;
}

async function assertClassification(client: PoolClient, gameId: string, classificationId: string | null | undefined): Promise<void> {
  if (classificationId === undefined || classificationId === null) return;
  if (!(await client.query(`SELECT 1 FROM "zzsh_supply"."firearm_classification" WHERE "id" = $1 AND "game_id" = $2`, [classificationId, gameId])).rowCount)
    throw invalid("Classification does not belong to this game", "classificationId");
}

type SourceTable = "firearm_classification" | "firearm" | "firearm_alias";

async function assertSourceAvailable(client: PoolClient, table: SourceTable, gameId: string, source: { namespace: string | null; token: string | null }): Promise<void> {
  if (source.namespace === null || source.token === null) return;
  const row = (await client.query<{ id: string }>(
    `SELECT "id" FROM "zzsh_supply"."${table}" WHERE "game_id"=$1 AND "source_namespace"=$2 AND "source_token"=$3 LIMIT 1`,
    [gameId, source.namespace, source.token],
  )).rows[0];
  if (row) throw conflict("This source mapping already exists; use its existing stable ID");
}

function isSourceUniqueViolation(error: unknown, table: SourceTable): boolean {
  return (error as { code?: string; constraint?: string }).code === "23505"
    && (error as { constraint?: string }).constraint === `${table}_source_unique`;
}

async function assertFirearmScope(client: PoolClient, adminUserId: string, isBoss: boolean, firearmId: string): Promise<{ id: string; gameId: string; enabled: boolean }> {
  const firearm = await readFirearmGame(client, firearmId);
  await assertGameScope(client, adminUserId, isBoss, firearm.gameId);
  return firearm;
}

export async function listPublicFirearms(
  client: PoolClient,
  gameId: string,
  options: { q?: string | null; classificationId?: string | null; limit: number; cursor?: string },
): Promise<{ items: PublicFirearmRecord[]; classifications: Array<{ id: string; code: string; name: string; sortOrder: number }>; nextCursor: string | null; limit: number }> {
  await requirePublicGameService(client, gameId, GAME_SERVICE.GUNSMITH);
  const q = searchText(options.q);
  const classificationId = publicText(options.classificationId);
  const filter = { gameId, q, classificationId, limit: options.limit };
  const cursor = parseCursor(options.cursor, filter);
  const parameters: unknown[] = [gameId, q === null ? null : `%${escapeLike(q)}%`, classificationId];
  const conditions = [
    `f."game_id" = $1 AND f."enabled" = true`,
    `EXISTS (SELECT 1 FROM "zzsh_supply"."gunsmith_code" active_code WHERE active_code."game_id" = f."game_id" AND active_code."firearm_id" = f."id" AND active_code."status" = 'ACTIVE')`,
    `($2::text IS NULL OR f."name" ILIKE $2 ESCAPE '\\' OR EXISTS (SELECT 1 FROM "zzsh_supply"."firearm_alias" fa WHERE fa."game_id" = f."game_id" AND fa."firearm_id" = f."id" AND fa."enabled" AND fa."name" ILIKE $2 ESCAPE '\\') OR EXISTS (SELECT 1 FROM "zzsh_supply"."gunsmith_code" gc WHERE gc."game_id" = f."game_id" AND gc."firearm_id" = f."id" AND gc."status" = 'ACTIVE' AND gc."note" ILIKE $2 ESCAPE '\\'))`,
    `($3::text IS NULL OR f."classification_id" = $3 AND EXISTS (SELECT 1 FROM "zzsh_supply"."firearm_classification" fc WHERE fc."id" = $3 AND fc."game_id" = $1 AND fc."enabled"))`,
  ];
  if (cursor) {
    if (cursor.sortOrder === undefined) throw invalid("Cursor is invalid");
    const sortParam = parameters.length + 1;
    const timeParam = sortParam + 1;
    const idParam = sortParam + 2;
    parameters.push(cursor.sortOrder, cursor.updatedAt, cursor.id);
    conditions.push(`(f."sort_order" > $${sortParam}::integer OR (f."sort_order" = $${sortParam}::integer AND (f."updated_at" < $${timeParam}::timestamptz OR (f."updated_at" = $${timeParam}::timestamptz AND f."id" < $${idParam}))))`);
  }
  parameters.push(options.limit + 1);
  const rows = (await client.query<PublicFirearmRecord>(
    `SELECT f."id", f."game_id" AS "gameId", f."code", f."name", f."classification_id" AS "classificationId",
            CASE WHEN fc."enabled" THEN fc."code" ELSE NULL END AS "classificationCode",
            CASE WHEN fc."enabled" THEN fc."name" ELSE NULL END AS "classificationName",
            f."enabled", f."sort_order" AS "sortOrder",
            CASE WHEN EXISTS (SELECT 1 FROM "zzsh_supply"."media_asset" ma WHERE ma."id" = f."media_id" AND ma."game_id" = f."game_id" AND ma."purpose" = 'FIREARM_MEDIA' AND ma."ownership_kind" = 'PLATFORM_CATALOG' AND ma."review_state" = 'APPROVED' AND ma."access_class" = 'PUBLIC_DISPLAY' AND ma."public_storage_key" IS NOT NULL) THEN f."media_id" ELSE NULL END AS "mediaId",
            (SELECT count(*)::int FROM "zzsh_supply"."gunsmith_code" count_code WHERE count_code."game_id" = f."game_id" AND count_code."firearm_id" = f."id" AND count_code."status" = 'ACTIVE') AS "codeCount",
            to_char(f."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
       FROM "zzsh_supply"."firearm" f
       LEFT JOIN "zzsh_supply"."firearm_classification" fc ON fc."game_id" = f."game_id" AND fc."id" = f."classification_id"
      WHERE ${conditions.join(" AND ")}
      ORDER BY f."sort_order" ASC, f."updated_at" DESC, f."id" DESC
      LIMIT $${parameters.length}`,
    parameters,
  )).rows;
  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  const classifications = (await client.query(`SELECT "id", "code", "name", "sort_order" AS "sortOrder" FROM "zzsh_supply"."firearm_classification" WHERE "game_id"=$1 AND "enabled" ORDER BY "sort_order", "code", "id"`, [gameId])).rows;
  return { items, classifications, nextCursor: nextCursor(filter, items.at(-1), hasMore), limit: options.limit };
}

export async function listPublicFirearmCodes(
  client: PoolClient,
  firearmId: string,
  options: { mode?: GunsmithMode | null; limit: number; cursor?: string },
): Promise<{ firearm: PublicFirearmRecord; items: Array<Pick<GunsmithCodeRecord, "id" | "firearmId" | "code" | "note" | "modeCode" | "updatedAt">>; nextCursor: string | null; limit: number }> {
  const firearm = await readFirearmGame(client, firearmId);
  if (!firearm.enabled) throw notFound();
  await requirePublicGameService(client, firearm.gameId, GAME_SERVICE.GUNSMITH);
  const firearmRow = (await client.query<PublicFirearmRecord>(
    `SELECT f."id", f."game_id" AS "gameId", f."code", f."name", f."classification_id" AS "classificationId",
            CASE WHEN fc."enabled" THEN fc."code" ELSE NULL END AS "classificationCode", CASE WHEN fc."enabled" THEN fc."name" ELSE NULL END AS "classificationName", f."enabled", f."sort_order" AS "sortOrder",
            CASE WHEN EXISTS (SELECT 1 FROM "zzsh_supply"."media_asset" ma WHERE ma."id" = f."media_id" AND ma."game_id" = f."game_id" AND ma."purpose" = 'FIREARM_MEDIA' AND ma."ownership_kind" = 'PLATFORM_CATALOG' AND ma."review_state" = 'APPROVED' AND ma."access_class" = 'PUBLIC_DISPLAY' AND ma."public_storage_key" IS NOT NULL) THEN f."media_id" ELSE NULL END AS "mediaId",
            (SELECT count(*)::int FROM "zzsh_supply"."gunsmith_code" gc WHERE gc."game_id" = f."game_id" AND gc."firearm_id" = f."id" AND gc."status" = 'ACTIVE') AS "codeCount",
            to_char(f."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' AS "updatedAt"
       FROM "zzsh_supply"."firearm" f LEFT JOIN "zzsh_supply"."firearm_classification" fc ON fc."game_id" = f."game_id" AND fc."id" = f."classification_id"
      WHERE f."id" = $1`,
    [firearmId],
  )).rows[0];
  if (!firearmRow) throw notFound();
  const mode = options.mode ?? null;
  const filter = { firearmId, mode, limit: options.limit };
  const cursor = parseCursor(options.cursor, filter);
  const parameters: unknown[] = [firearmId, mode];
  const conditions = [`gc."firearm_id" = $1 AND gc."status" = 'ACTIVE'`, `($2::text IS NULL OR gc."mode_code" = $2)`];
  if (cursor) {
    const timeParam = parameters.length + 1;
    const idParam = timeParam + 1;
    parameters.push(cursor.updatedAt, cursor.id);
    conditions.push(`(gc."updated_at", gc."id") < ($${timeParam}::timestamptz, $${idParam})`);
  }
  parameters.push(options.limit + 1);
  const rows = (await client.query<Pick<GunsmithCodeRecord, "id" | "firearmId" | "code" | "note" | "modeCode" | "updatedAt">>(
    `SELECT gc."id", gc."firearm_id" AS "firearmId", gc."code", gc."note", gc."mode_code" AS "modeCode",
            to_char(gc."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' AS "updatedAt"
       FROM "zzsh_supply"."gunsmith_code" gc WHERE ${conditions.join(" AND ")}
      ORDER BY gc."updated_at" DESC, gc."id" DESC LIMIT $${parameters.length}`,
    parameters,
  )).rows;
  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  return { firearm: firearmRow, items, nextCursor: nextCursor(filter, items.at(-1), hasMore), limit: options.limit };
}

export async function listAdminFirearms(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string): Promise<{
  classifications: GunsmithClassification[];
  firearms: FirearmRecord[];
  aliases: FirearmAlias[];
  codes: GunsmithCodeRecord[];
}> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const [classifications, firearms, aliases, codes] = await Promise.all([
    client.query<GunsmithClassification>(`SELECT "id", "game_id" AS "gameId", "code", "name", "enabled", "sort_order" AS "sortOrder", "revision"::text AS "revision", "source_namespace" AS "sourceNamespace", "source_token" AS "sourceToken", "source_note" AS "sourceNote" FROM "zzsh_supply"."firearm_classification" WHERE "game_id" = $1 ORDER BY "sort_order", "code", "id"`, [gameId]),
    client.query<FirearmRecord>(`SELECT f."id", f."game_id" AS "gameId", f."code", f."name", f."classification_id" AS "classificationId", fc."code" AS "classificationCode", fc."name" AS "classificationName", f."enabled", f."sort_order" AS "sortOrder", f."media_id" AS "mediaId", (SELECT count(*)::int FROM "zzsh_supply"."gunsmith_code" gc_count WHERE gc_count."firearm_id" = f."id") AS "codeCount", f."revision"::text AS "revision", to_char(f."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"') AS "updatedAt", f."source_namespace" AS "sourceNamespace", f."source_token" AS "sourceToken", f."source_note" AS "sourceNote" FROM "zzsh_supply"."firearm" f LEFT JOIN "zzsh_supply"."firearm_classification" fc ON fc."game_id" = f."game_id" AND fc."id" = f."classification_id" WHERE f."game_id" = $1 ORDER BY f."sort_order", f."name", f."id"`, [gameId]),
    client.query<FirearmAlias>(`SELECT "id", "game_id" AS "gameId", "firearm_id" AS "firearmId", "locale", "name", "enabled", "sort_order" AS "sortOrder", "revision"::text AS "revision", "source_namespace" AS "sourceNamespace", "source_token" AS "sourceToken", "source_note" AS "sourceNote" FROM "zzsh_supply"."firearm_alias" WHERE "game_id" = $1 ORDER BY "firearm_id", "sort_order", "name", "id"`, [gameId]),
    client.query<GunsmithCodeRecord>(`SELECT "id", "game_id" AS "gameId", "firearm_id" AS "firearmId", "code", "note", "mode_code" AS "modeCode", "status", CASE WHEN "last_reviewed_at" IS NULL THEN NULL ELSE to_char("last_reviewed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' END AS "lastReviewedAt", "revision"::text AS "revision", to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' AS "updatedAt", "source_namespace" AS "sourceNamespace", "source_token" AS "sourceToken", "source_note" AS "sourceNote" FROM "zzsh_supply"."gunsmith_code" WHERE "game_id" = $1 ORDER BY "firearm_id", "updated_at" DESC, "id" DESC`, [gameId]),
  ]);
  return { classifications: classifications.rows, firearms: firearms.rows, aliases: aliases.rows, codes: codes.rows };
}

export async function createClassification(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string, body: Record<string, unknown>): Promise<GunsmithClassification> {
  await assertGameExists(client, gameId);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  await requireSupportedGameService(client, gameId, GAME_SERVICE.GUNSMITH);
  const code = stableCode(body);
  const source = readSource(body);
  await assertSourceAvailable(client, "firearm_classification", gameId, source);
  const id = newSupplyId("firearm_class");
  let row: GunsmithClassification;
  try {
    row = (await client.query<GunsmithClassification>(
      `INSERT INTO "zzsh_supply"."firearm_classification" ("id", "game_id", "code", "name", "enabled", "sort_order", "source_namespace", "source_token", "source_note", "created_by_admin_id", "updated_by_admin_id")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING "id", "game_id" AS "gameId", "code", "name", "enabled", "sort_order" AS "sortOrder", "revision"::text AS "revision", "source_namespace" AS "sourceNamespace", "source_token" AS "sourceToken", "source_note" AS "sourceNote"`,
      [id, gameId, code, requiredString(body, "name", 120), optionalBoolean(body, "enabled") ?? true, optionalInteger(body, "sortOrder", -100000, 100000) ?? 0, source.namespace, source.token, source.note, adminUserId],
    )).rows[0]!;
  } catch (error) {
    if (isSourceUniqueViolation(error, "firearm_classification")) throw conflict("This source mapping already exists; use its existing stable ID");
    throw error;
  }
  await bumpCatalogRevision(client, gameId);
  return row;
}

export async function updateClassification(client: PoolClient, adminUserId: string, isBoss: boolean, id: string, body: Record<string, unknown>): Promise<GunsmithClassification> {
  const current = (await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."firearm_classification" WHERE "id" = $1`, [id])).rows[0];
  if (!current) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, current.gameId);
  const name = optionalString(body, "name", 120);
  const enabled = optionalBoolean(body, "enabled");
  const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
  if (name === undefined && enabled === undefined && sortOrder === undefined) throw invalid();
  const service = await readGameService(client, current.gameId, GAME_SERVICE.GUNSMITH);
  if (!service.supported && (enabled !== false || name !== undefined || sortOrder !== undefined)) throw unsupportedGameService();
  const revision = parseExpectedRevision(body);
  const result = await client.query(`UPDATE "zzsh_supply"."firearm_classification" SET "name"=COALESCE($1,"name"),"enabled"=COALESCE($2,"enabled"),"sort_order"=COALESCE($3,"sort_order"),"updated_by_admin_id"=$4,"revision"="revision"+1,"updated_at"=clock_timestamp() WHERE "id"=$5 AND "revision"::text=$6`, [name ?? null, enabled ?? null, sortOrder ?? null, adminUserId, id, revision]);
  if (result.rowCount !== 1) throw conflict("Classification changed; refresh and retry");
  await bumpCatalogRevision(client, current.gameId);
  return (await listAdminFirearms(client, adminUserId, isBoss, current.gameId)).classifications.find((item) => item.id === id)!;
}

export async function createFirearm(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string, body: Record<string, unknown>): Promise<FirearmRecord> {
  await assertGameExists(client, gameId);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  await requireSupportedGameService(client, gameId, GAME_SERVICE.GUNSMITH);
  const code = stableCode(body);
  const classificationId = optionalNullableString(body, "classificationId", 128);
  await assertClassification(client, gameId, classificationId);
  const mediaId = optionalNullableString(body, "mediaId", 128);
  if (mediaId) await assertPlatformMediaBinding(client, gameId, mediaId, "FIREARM_MEDIA");
  const source = readSource(body);
  await assertSourceAvailable(client, "firearm", gameId, source);
  const id = newSupplyId("firearm");
  try {
    await client.query(
      `INSERT INTO "zzsh_supply"."firearm" ("id","game_id","code","name","classification_id","enabled","sort_order","media_id","source_namespace","source_token","source_note","created_by_admin_id","updated_by_admin_id") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [id, gameId, code, requiredString(body, "name", 120), classificationId ?? null, optionalBoolean(body, "enabled") ?? true, optionalInteger(body, "sortOrder", -100000, 100000) ?? 0, mediaId ?? null, source.namespace, source.token, source.note, adminUserId],
    );
  } catch (error) {
    if (isSourceUniqueViolation(error, "firearm")) throw conflict("This source mapping already exists; use its existing stable ID");
    throw error;
  }
  await bumpCatalogRevision(client, gameId);
  return (await listAdminFirearms(client, adminUserId, isBoss, gameId)).firearms.find((item) => item.id === id)!;
}

export async function updateFirearm(client: PoolClient, adminUserId: string, isBoss: boolean, id: string, body: Record<string, unknown>): Promise<FirearmRecord> {
  const current = await assertFirearmScope(client, adminUserId, isBoss, id);
  const name = optionalString(body, "name", 120);
  const classificationId = optionalNullableString(body, "classificationId", 128);
  const enabled = optionalBoolean(body, "enabled");
  const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
  const mediaId = optionalNullableString(body, "mediaId", 128);
  if ([name, classificationId, enabled, sortOrder, mediaId].every((value) => value === undefined)) throw invalid();
  const service = await readGameService(client, current.gameId, GAME_SERVICE.GUNSMITH);
  if (!service.supported && (enabled !== false || name !== undefined || classificationId !== undefined || sortOrder !== undefined || mediaId !== undefined)) throw unsupportedGameService();
  await assertClassification(client, current.gameId, classificationId);
  if (mediaId) await assertPlatformMediaBinding(client, current.gameId, mediaId, "FIREARM_MEDIA");
  const revision = parseExpectedRevision(body);
  const result = await client.query(
    `UPDATE "zzsh_supply"."firearm" SET "name"=COALESCE($1,"name"),"classification_id"=CASE WHEN $2::boolean THEN $3::text ELSE "classification_id" END,"enabled"=COALESCE($4,"enabled"),"sort_order"=COALESCE($5,"sort_order"),"media_id"=CASE WHEN $6::boolean THEN $7::text ELSE "media_id" END,"updated_by_admin_id"=$8,"revision"="revision"+1,"updated_at"=clock_timestamp() WHERE "id"=$9 AND "revision"::text=$10`,
    [name ?? null, classificationId !== undefined, classificationId ?? null, enabled ?? null, sortOrder ?? null, mediaId !== undefined, mediaId ?? null, adminUserId, id, revision],
  );
  if (result.rowCount !== 1) throw conflict("Firearm changed; refresh and retry");
  await bumpCatalogRevision(client, current.gameId);
  return (await listAdminFirearms(client, adminUserId, isBoss, current.gameId)).firearms.find((item) => item.id === id)!;
}

export async function createAlias(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string, firearmId: string, body: Record<string, unknown>): Promise<FirearmAlias> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  await requireSupportedGameService(client, gameId, GAME_SERVICE.GUNSMITH);
  const firearm = await readFirearmGame(client, firearmId);
  if (firearm.gameId !== gameId) throw invalid("Firearm does not belong to this game", "firearmId");
  const source = readSource(body);
  await assertSourceAvailable(client, "firearm_alias", gameId, source);
  const id = newSupplyId("firearm_alias");
  let row: FirearmAlias;
  try {
    row = (await client.query<FirearmAlias>(
      `INSERT INTO "zzsh_supply"."firearm_alias" ("id","game_id","firearm_id","locale","name","enabled","sort_order","source_namespace","source_token","source_note","created_by_admin_id","updated_by_admin_id") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING "id","game_id" AS "gameId","firearm_id" AS "firearmId","locale","name","enabled","sort_order" AS "sortOrder","revision"::text AS "revision","source_namespace" AS "sourceNamespace","source_token" AS "sourceToken","source_note" AS "sourceNote"`,
      [id, gameId, firearmId, optionalString(body, "locale", 32) ?? "zh-CN", requiredString(body, "name", 120), optionalBoolean(body, "enabled") ?? true, optionalInteger(body, "sortOrder", -100000, 100000) ?? 0, source.namespace, source.token, source.note, adminUserId],
    )).rows[0]!;
  } catch (error) {
    if (isSourceUniqueViolation(error, "firearm_alias")) throw conflict("This source mapping already exists; use its existing stable ID");
    throw error;
  }
  await client.query(`UPDATE "zzsh_supply"."firearm" SET "updated_at"=clock_timestamp() WHERE "id"=$1`, [firearmId]);
  await bumpCatalogRevision(client, gameId);
  return row;
}

export async function updateAlias(client: PoolClient, adminUserId: string, isBoss: boolean, id: string, body: Record<string, unknown>): Promise<FirearmAlias> {
  const current = (await client.query<{ gameId: string; firearmId: string }>(`SELECT "game_id" AS "gameId", "firearm_id" AS "firearmId" FROM "zzsh_supply"."firearm_alias" WHERE "id"=$1`, [id])).rows[0];
  if (!current) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, current.gameId);
  const name = optionalString(body, "name", 120);
  const enabled = optionalBoolean(body, "enabled");
  const sortOrder = optionalInteger(body, "sortOrder", -100000, 100000);
  if (name === undefined && enabled === undefined && sortOrder === undefined) throw invalid();
  const service = await readGameService(client, current.gameId, GAME_SERVICE.GUNSMITH);
  if (!service.supported && (enabled !== false || name !== undefined || sortOrder !== undefined)) throw unsupportedGameService();
  const revision = parseExpectedRevision(body);
  const result = await client.query(`UPDATE "zzsh_supply"."firearm_alias" SET "name"=COALESCE($1,"name"),"enabled"=COALESCE($2,"enabled"),"sort_order"=COALESCE($3,"sort_order"),"updated_by_admin_id"=$4,"revision"="revision"+1,"updated_at"=clock_timestamp() WHERE "id"=$5 AND "revision"::text=$6`, [name ?? null, enabled ?? null, sortOrder ?? null, adminUserId, id, revision]);
  if (result.rowCount !== 1) throw conflict("Alias changed; refresh and retry");
  await client.query(`UPDATE "zzsh_supply"."firearm" SET "updated_at"=clock_timestamp() WHERE "id"=$1`, [current.firearmId]);
  await bumpCatalogRevision(client, current.gameId);
  return (await listAdminFirearms(client, adminUserId, isBoss, current.gameId)).aliases.find((item) => item.id === id)!;
}

export async function createGunsmithCode(client: PoolClient, adminUserId: string, isBoss: boolean, body: Record<string, unknown>): Promise<GunsmithCodeRecord> {
  const gameId = requiredString(body, "gameId", 128);
  const firearmId = requiredString(body, "firearmId", 128);
  await assertGameScope(client, adminUserId, isBoss, gameId);
  await requireSupportedGameService(client, gameId, GAME_SERVICE.GUNSMITH);
  const firearm = await readFirearmGame(client, firearmId);
  if (firearm.gameId !== gameId) throw invalid("Firearm does not belong to this game", "firearmId");
  const code = readOpaqueCode(body.code, "code");
  const duplicate = await client.query(`SELECT 1 FROM "zzsh_supply"."gunsmith_code" WHERE "game_id" = $1 AND "code" = $2`, [gameId, code]);
  if (duplicate.rowCount) throw conflict("This code is already bound in this game");
  const source = readSource(body);
  const id = newSupplyId("gunsmith");
  const lastReviewedAt = readTimestamp(body, "lastReviewedAt");
  const row = (await client.query<GunsmithCodeRecord>(
    `INSERT INTO "zzsh_supply"."gunsmith_code" ("id","game_id","firearm_id","code","note","mode_code","last_reviewed_at","source_namespace","source_token","source_note","created_by_admin_id","updated_by_admin_id") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING "id","game_id" AS "gameId","firearm_id" AS "firearmId","code","note","mode_code" AS "modeCode","status",CASE WHEN "last_reviewed_at" IS NULL THEN NULL ELSE to_char("last_reviewed_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' END AS "lastReviewedAt","revision"::text AS "revision",to_char("updated_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' AS "updatedAt","source_namespace" AS "sourceNamespace","source_token" AS "sourceToken","source_note" AS "sourceNote"`,
    [id, gameId, firearmId, code, readNote(body) ?? "", readMode(body) ?? null, lastReviewedAt ?? null, source.namespace, source.token, source.note, adminUserId],
  )).rows[0]!;
  return row;
}

function readOpaqueCode(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 4 || value.length > 1024 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw invalid("Code must be opaque text without control characters", field);
  return value;
}

export async function updateGunsmithCode(client: PoolClient, adminUserId: string, isBoss: boolean, id: string, body: Record<string, unknown>): Promise<GunsmithCodeRecord> {
  const current = (await client.query<{ gameId: string; status: GunsmithStatus }>(`SELECT "game_id" AS "gameId", "status" FROM "zzsh_supply"."gunsmith_code" WHERE "id"=$1`, [id])).rows[0];
  if (!current) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, current.gameId);
  await requireSupportedGameService(client, current.gameId, GAME_SERVICE.GUNSMITH);
  const code = body.code === undefined ? undefined : readOpaqueCode(body.code, "code");
  if (code !== undefined) {
    const duplicate = await client.query(`SELECT 1 FROM "zzsh_supply"."gunsmith_code" WHERE "game_id" = $1 AND "code" = $2 AND "id" <> $3`, [current.gameId, code, id]);
    if (duplicate.rowCount) throw conflict("This code is already bound in this game");
  }
  const note = readNote(body);
  const mode = readMode(body);
  const lastReviewedAt = readTimestamp(body, "lastReviewedAt");
  if ([code, note, mode, lastReviewedAt].every((value) => value === undefined)) throw invalid();
  const revision = parseExpectedRevision(body);
  const result = await client.query(`UPDATE "zzsh_supply"."gunsmith_code" SET "code"=COALESCE($1,"code"),"note"=COALESCE($2,"note"),"mode_code"=CASE WHEN $3::boolean THEN $4::text ELSE "mode_code" END,"last_reviewed_at"=CASE WHEN $5::boolean THEN $6::timestamptz ELSE "last_reviewed_at" END,"updated_by_admin_id"=$7,"revision"="revision"+1,"updated_at"=clock_timestamp() WHERE "id"=$8 AND "revision"::text=$9`, [code ?? null, note ?? null, mode !== undefined, mode ?? null, lastReviewedAt !== undefined, lastReviewedAt ?? null, adminUserId, id, revision]);
  if (result.rowCount !== 1) throw conflict("Gunsmith code changed; refresh and retry");
  return (await client.query<GunsmithCodeRecord>(`SELECT "id","game_id" AS "gameId","firearm_id" AS "firearmId","code","note","mode_code" AS "modeCode","status",CASE WHEN "last_reviewed_at" IS NULL THEN NULL ELSE to_char("last_reviewed_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' END AS "lastReviewedAt","revision"::text AS "revision",to_char("updated_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' AS "updatedAt","source_namespace" AS "sourceNamespace","source_token" AS "sourceToken","source_note" AS "sourceNote" FROM "zzsh_supply"."gunsmith_code" WHERE "id"=$1`, [id])).rows[0]!;
}

export async function setGunsmithCodeStatus(client: PoolClient, adminUserId: string, isBoss: boolean, id: string, status: GunsmithStatus, body: Record<string, unknown>): Promise<GunsmithCodeRecord> {
  const current = (await client.query<{ gameId: string }>(`SELECT "game_id" AS "gameId" FROM "zzsh_supply"."gunsmith_code" WHERE "id"=$1`, [id])).rows[0];
  if (!current) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, current.gameId);
  if (status === "ACTIVE") await requireSupportedGameService(client, current.gameId, GAME_SERVICE.GUNSMITH);
  const revision = parseExpectedRevision(body);
  const result = await client.query(`UPDATE "zzsh_supply"."gunsmith_code" SET "status"=$1,"updated_by_admin_id"=$2,"revision"="revision"+1,"updated_at"=clock_timestamp() WHERE "id"=$3 AND "revision"::text=$4`, [status, adminUserId, id, revision]);
  if (result.rowCount !== 1) throw conflict("Gunsmith code changed; refresh and retry");
  return (await client.query<GunsmithCodeRecord>(`SELECT "id","game_id" AS "gameId","firearm_id" AS "firearmId","code","note","mode_code" AS "modeCode","status",CASE WHEN "last_reviewed_at" IS NULL THEN NULL ELSE to_char("last_reviewed_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' END AS "lastReviewedAt","revision"::text AS "revision",to_char("updated_at" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"') || 'Z' AS "updatedAt","source_namespace" AS "sourceNamespace","source_token" AS "sourceToken","source_note" AS "sourceNote" FROM "zzsh_supply"."gunsmith_code" WHERE "id"=$1`, [id])).rows[0]!;
}

export function parsePublicMode(value: string | null): GunsmithMode | null {
  if (value === null || value === "") return null;
  if (!MODES.has(value)) throw invalid("Mode is invalid");
  return value as GunsmithMode;
}

export function parsePublicLimit(value: string | null): number {
  const limit = value === null ? 20 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("Limit is invalid");
  return limit;
}
