import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "./security-core";

/**
 * Account-level game scope contract (ADM-SCOPE-1).
 *
 * Roles decide what an administrator may do; the account-level game scope
 * decides which games/business ranges they may see. Boss always sees all
 * games. ALL_GAMES follows future games automatically; SELECTED_GAMES is the
 * explicit assigned set. The mode lives on the existing account row
 * (`zzsh_iam.admin_security.game_scope_mode`) and the selected games reuse the
 * existing `zzsh_supply.admin_supply_scope` table.
 */
export const ADMIN_GAME_SCOPE_MODE = {
  ALL_GAMES: "ALL_GAMES",
  SELECTED_GAMES: "SELECTED_GAMES",
} as const;
export type AdminGameScopeMode = (typeof ADMIN_GAME_SCOPE_MODE)[keyof typeof ADMIN_GAME_SCOPE_MODE];

export type AdminGameScope = { mode: AdminGameScopeMode; gameIds: string[] };

const GAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SELECTED_GAMES = 200;

type ScopeExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function isAllGamesScope(scope: AdminGameScope): boolean {
  return scope.mode === ADMIN_GAME_SCOPE_MODE.ALL_GAMES;
}

export function scopeAllowsGame(scope: AdminGameScope, isBoss: boolean, gameId: string): boolean {
  if (isBoss || isAllGamesScope(scope)) return true;
  return scope.gameIds.includes(gameId);
}

/** SELECTED_GAMES with no games is an explicit "no business scope" state. */
export function scopeIsEmpty(scope: AdminGameScope, isBoss: boolean): boolean {
  return !isBoss && scope.mode === ADMIN_GAME_SCOPE_MODE.SELECTED_GAMES && scope.gameIds.length === 0;
}

export function noGameScopeError(): SecurityApiError {
  return new SecurityApiError(403, API_V1_ERROR_CODES.NO_GAME_SCOPE, "No game scope is assigned to this administrator");
}

/** Distinguishable "no business scope" instead of an empty business list. */
export function assertGameScopeUsable(scope: AdminGameScope, isBoss: boolean): void {
  if (scopeIsEmpty(scope, isBoss)) throw noGameScopeError();
}

/** Stable signature fragment for cursor/authorization bindings; a mode change invalidates old cursors. */
export function gameScopeSignature(scope: AdminGameScope): string[] {
  return isAllGamesScope(scope) ? ["*"] : [...scope.gameIds];
}

/**
 * Single SQL scope judgment used by every domain. `gameColumn` is the game id
 * expression of the business row; `adminParam`/`bossParam` are existing
 * parameter placeholders (boss may be the literal `false`).
 */
export function gameScopeSql(gameColumn: string, adminParam: string, bossParam: string): string {
  return `(${bossParam}::boolean OR EXISTS (SELECT 1 FROM "zzsh_iam"."admin_security" scfg WHERE scfg."admin_user_id" = ${adminParam} AND scfg."game_scope_mode" = 'ALL_GAMES') OR EXISTS (SELECT 1 FROM "zzsh_supply"."admin_supply_scope" sgame WHERE sgame."admin_user_id" = ${adminParam} AND sgame."game_id" = ${gameColumn}))`;
}

export async function readAdminGameScope(executor: ScopeExecutor, adminUserId: string): Promise<AdminGameScope> {
  const row = (
    await executor.query<{ mode: string; gameIds: string[] | null }>(
      `SELECT s."game_scope_mode" AS "mode",
              COALESCE(array_agg(sc."game_id" ORDER BY sc."game_id") FILTER (WHERE sc."game_id" IS NOT NULL), '{}') AS "gameIds"
         FROM "zzsh_iam"."admin_security" s
         LEFT JOIN "zzsh_supply"."admin_supply_scope" sc ON sc."admin_user_id" = s."admin_user_id"
        WHERE s."admin_user_id" = $1
        GROUP BY s."admin_user_id"`,
      [adminUserId],
    )
  ).rows[0];
  const mode = row?.mode === ADMIN_GAME_SCOPE_MODE.ALL_GAMES ? ADMIN_GAME_SCOPE_MODE.ALL_GAMES : ADMIN_GAME_SCOPE_MODE.SELECTED_GAMES;
  return { mode, gameIds: row?.gameIds ?? [] };
}

function scopeInputError(path: string): SecurityApiError {
  return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid", [{ path, code: "INVALID_FIELD" }]);
}

/**
 * Parsed scope change. `replaceSelected` distinguishes an explicit selected
 * set (`gameIds` present, full replace) from "keep the stored selected set"
 * (`gameIds` omitted) and from ALL_GAMES (never touches stored rows).
 */
export type AdminGameScopeChange = AdminGameScope & { replaceSelected: boolean };

export function parseAdminGameScopeInput(body: Record<string, unknown>): AdminGameScopeChange {
  const mode = body.mode;
  if (mode !== ADMIN_GAME_SCOPE_MODE.ALL_GAMES && mode !== ADMIN_GAME_SCOPE_MODE.SELECTED_GAMES) throw scopeInputError("mode");
  const provided = body.gameIds !== undefined;
  const raw = provided ? body.gameIds : [];
  if (!Array.isArray(raw) || raw.length > MAX_SELECTED_GAMES) throw scopeInputError("gameIds");
  for (const value of raw) {
    if (typeof value !== "string" || !GAME_ID_PATTERN.test(value)) throw scopeInputError("gameIds");
  }
  const gameIds = [...new Set(raw as string[])];
  if (gameIds.length !== raw.length) throw scopeInputError("gameIds");
  if (mode === ADMIN_GAME_SCOPE_MODE.ALL_GAMES) {
    if (gameIds.length > 0) throw scopeInputError("gameIds");
    return { mode, gameIds: [], replaceSelected: false };
  }
  return { mode, gameIds, replaceSelected: provided };
}

/** Resulting scope of a change: reactivating selected keeps the stored set; ALL_GAMES keeps rows internally. */
export function effectiveGameScopeChange(before: AdminGameScope, change: AdminGameScopeChange): AdminGameScope {
  return { mode: change.mode, gameIds: change.replaceSelected ? [...change.gameIds] : [...before.gameIds] };
}

/** Public projection: ALL_GAMES always reports an empty list; the stored set stays internal. */
export function publicGameScope(scope: AdminGameScope): AdminGameScope {
  return scope.mode === ADMIN_GAME_SCOPE_MODE.ALL_GAMES ? { mode: scope.mode, gameIds: [] } : { mode: scope.mode, gameIds: [...scope.gameIds] };
}

/**
 * Persists a scope change on the account row. ALL_GAMES only updates the mode;
 * the historical selected rows stay for a later switch back. SELECTED_GAMES
 * with an explicit set replaces the rows in full.
 */
export async function writeAdminGameScope(
  client: PoolClient,
  adminUserId: string,
  change: AdminGameScopeChange,
  grantedByAdminId: string,
): Promise<void> {
  await client.query(
    `UPDATE "zzsh_iam"."admin_security" SET "game_scope_mode" = $2, "updated_at" = clock_timestamp() WHERE "admin_user_id" = $1`,
    [adminUserId, change.mode],
  );
  if (!change.replaceSelected) return;
  await client.query(`DELETE FROM "zzsh_supply"."admin_supply_scope" WHERE "admin_user_id" = $1`, [adminUserId]);
  for (const gameId of change.gameIds) {
    await client.query(
      `INSERT INTO "zzsh_supply"."admin_supply_scope" ("admin_user_id", "game_id", "granted_by_admin_id") VALUES ($1, $2, $3)`,
      [adminUserId, gameId, grantedByAdminId],
    );
  }
}

/** Mirrors permission delegation: a non-Boss actor cannot widen another account beyond their own scope. */
export function assertGameScopeDelegable(actorScope: AdminGameScope, actorIsBoss: boolean, next: AdminGameScope): void {
  if (actorIsBoss) return;
  if (next.mode === ADMIN_GAME_SCOPE_MODE.ALL_GAMES) {
    if (!isAllGamesScope(actorScope)) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Cannot assign a broader game scope");
    return;
  }
  if (isAllGamesScope(actorScope)) return;
  const allowed = new Set(actorScope.gameIds);
  for (const gameId of next.gameIds) {
    if (!allowed.has(gameId)) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Cannot assign a broader game scope");
  }
}
