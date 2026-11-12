import type { PoolClient } from "pg";
import type { LegacyPublicAdmission, LegacyPublicAdmissionDetailIndex } from "../legacy-load/legacy-public-admission";
import { accountNumberCandidates, parsePublicAccountNumber } from "./account-number";
import { readPublicListingSnapshot, readPublishingAccount, type SupplyGateReader } from "./publishing";
import { projectPublicListingImages } from "./legacy-path-projection";
import type { AccountImageCdn } from "./account-image-cdn";
import { conflict, invalid, notFound } from "./supply-util";
import { GAME_SERVICE, requirePublicGameService } from "./game-services";

export function parseNumberLookupQuery(query: URLSearchParams) {
  for (const key of query.keys()) if (!["number", "gameId"].includes(key) || query.getAll(key).length !== 1)
    throw invalid("编号查询参数无效", key);
  const gameId = query.get("gameId");
  if (gameId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId)) throw invalid("游戏标识无效", "gameId");
  return { number: parsePublicAccountNumber(query.get("number")), gameId };
}

export async function lookupPublicListing(client: PoolClient, query: { number: string; gameId: string | null }, gate: SupplyGateReader, admission?: LegacyPublicAdmission, detailIndex?: LegacyPublicAdmissionDetailIndex, cdn?: AccountImageCdn) {
  if (query.gameId) await requirePublicGameService(client, query.gameId, GAME_SERVICE.ACCOUNT_RENTAL);
  const candidates = await accountNumberCandidates(client, query.number, query.gameId, false);
  // Visibility must not silently resolve an ambiguous canonical number to
  // whichever target happens to be visible at the time of this read.
  if (candidates.length > 1) throw conflict("账号编号暂无法唯一核定");
  const accountId = candidates[0];
  if (!accountId) throw notFound();
  const listing = await readPublicListingSnapshot(client, await readPublishingAccount(client, accountId), gate, admission, false, "DETAIL", detailIndex);
  return (await projectPublicListingImages(client, [listing], cdn))[0]!;
}
