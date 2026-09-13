import type { SupplyGame } from "./supply-types.ts";

export const DELTA_GAME_CODE = "delta";
export function selectDeltaGame(games: SupplyGame[]): SupplyGame | null {
  return games.find((game) => game.code === DELTA_GAME_CODE) ?? null;
}
