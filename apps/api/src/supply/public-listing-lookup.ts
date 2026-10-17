import type { PoolClient } from "pg";
import type { LegacyPublicAdmission } from "../legacy-load/legacy-public-admission";
import { accountNumberCandidates, parseAccountNumber } from "./account-number";
import { readPublicListing, readPublishingAccount, type SupplyGateReader } from "./publishing";
import { conflict, invalid, notFound } from "./supply-util";
import { GAME_SERVICE, requirePublicGameService } from "./game-services";

export function parseNumberLookupQuery(query: URLSearchParams) {
  for (const key of query.keys()) if (!["number", "gameId"].includes(key) || query.getAll(key).length !== 1)
    throw invalid("编号查询参数无效", key);
  const gameId = query.get("gameId");
  if (gameId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId)) throw invalid("游戏标识无效", "gameId");
  return { number: parseAccountNumber(query.get("number")), gameId };
}

export async function lookupPublicListing(client: PoolClient, query: { number: string; gameId: string | null }, gate: SupplyGateReader, admission?: LegacyPublicAdmission) {
  if (query.gameId) await requirePublicGameService(client, query.gameId, GAME_SERVICE.ACCOUNT_RENTAL);
  const candidates = await accountNumberCandidates(client, query.number, query.gameId);
  // Public visibility can change; it must not silently resolve an ambiguous old
  // number to whichever target happens to be visible at the time of this read.
  if (candidates.length > 1) throw conflict("账号编号暂无法唯一核定");
  const accountId = candidates[0];
  if (!accountId) throw notFound();
  return readPublicListing(client, await readPublishingAccount(client, accountId), gate, admission);
}
