import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "../auth/security-core";
import { conflict, notFound } from "./supply-util";

export const GAME_SERVICE = {
  ACCOUNT_RENTAL: "ACCOUNT_RENTAL",
  GUNSMITH: "GUNSMITH",
} as const;

export type GameServiceCode = (typeof GAME_SERVICE)[keyof typeof GAME_SERVICE];

const CODE_SUPPORTED: Record<string, readonly GameServiceCode[]> = {
  delta: [GAME_SERVICE.ACCOUNT_RENTAL, GAME_SERVICE.GUNSMITH],
};

export type GameServiceState = {
  id: string;
  gameId: string;
  gameCode: string;
  gameEnabled: boolean;
  serviceCode: GameServiceCode;
  enabled: boolean;
  revision: string;
  supported: boolean;
};

export function isGameServiceCode(value: unknown): value is GameServiceCode {
  return value === GAME_SERVICE.ACCOUNT_RENTAL || value === GAME_SERVICE.GUNSMITH;
}

export function isSupportedGameService(gameCode: string, serviceCode: GameServiceCode): boolean {
  return CODE_SUPPORTED[gameCode]?.includes(serviceCode) ?? false;
}

export function unsupportedGameService(): SecurityApiError {
  return new SecurityApiError(409, API_V1_ERROR_CODES.UNSUPPORTED_GAME_SERVICE, "该游戏尚未完成此业务适配");
}

export async function ensureGameServiceRows(client: PoolClient, gameId: string): Promise<void> {
  await client.query(
    `INSERT INTO "zzsh_supply"."game_service_operation" ("id", "game_id", "service_code", "enabled")
     SELECT $1 || ':service:' || value, $1, value,
            (g."code" = 'delta' AND value = 'ACCOUNT_RENTAL' AND g."enabled")
       FROM "zzsh_supply"."game" g
       CROSS JOIN unnest(ARRAY['ACCOUNT_RENTAL', 'GUNSMITH']::text[]) AS value
      WHERE g."id" = $1
     ON CONFLICT ("game_id", "service_code") DO NOTHING`,
    [gameId],
  );
}

export async function readGameService(
  client: Pool | PoolClient,
  gameId: string,
  serviceCode: GameServiceCode,
): Promise<GameServiceState> {
  const row = (
    await client.query<{
      id: string;
      gameId: string;
      gameCode: string;
      gameEnabled: boolean;
      serviceCode: GameServiceCode;
      enabled: boolean;
      revision: string;
    }>(
      `SELECT g."id" AS "gameId", g."code" AS "gameCode", g."enabled" AS "gameEnabled",
              s."id", s."service_code" AS "serviceCode", s."enabled", s."revision"::text AS "revision"
         FROM "zzsh_supply"."game" g
         LEFT JOIN "zzsh_supply"."game_service_operation" s
           ON s."game_id" = g."id" AND s."service_code" = $2
        WHERE g."id" = $1`,
      [gameId, serviceCode],
    )
  ).rows[0];
  if (!row) throw notFound();
  if (!row.id) throw notFound();
  return { ...row, supported: isSupportedGameService(row.gameCode, serviceCode) };
}

export async function requirePublicGameService(
  client: Pool | PoolClient,
  gameId: string,
  serviceCode: GameServiceCode,
): Promise<GameServiceState> {
  const state = await readGameService(client, gameId, serviceCode);
  if (!state.supported || !state.gameEnabled || !state.enabled) throw notFound();
  return state;
}

export async function requireWritableGameService(
  client: Pool | PoolClient,
  gameId: string,
  serviceCode: GameServiceCode,
): Promise<GameServiceState> {
  const state = await readGameService(client, gameId, serviceCode);
  if (!state.supported) throw unsupportedGameService();
  if (!state.gameEnabled || !state.enabled) throw conflict("该业务组合当前未启用");
  return state;
}

export async function requireSupportedGameService(
  client: Pool | PoolClient,
  gameId: string,
  serviceCode: GameServiceCode,
): Promise<GameServiceState> {
  const state = await readGameService(client, gameId, serviceCode);
  if (!state.supported) throw unsupportedGameService();
  return state;
}
