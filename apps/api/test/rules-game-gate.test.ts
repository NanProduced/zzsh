import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRulesGameSupported } from "../src/supply/game-services";

const clientFor = (code: string | null) => ({ query: async (sql: string, params: unknown[]) => { assert.match(sql, /FROM "zzsh_supply"\."game"/); assert.deepEqual(params, ["game-1"]); return { rows: code === null ? [] : [{ code }] }; } }) as never;

test("delta-only rules writes reject a non-delta game at the common write entry", async () => {
  await assert.rejects(() => assertRulesGameSupported(clientFor("other"), "game-1"), (error: { status?: number; code?: string }) => error.status === 409 && error.code === "UNSUPPORTED_GAME_SERVICE");
  await assert.rejects(() => assertRulesGameSupported(clientFor(null), "game-1"), (error: { status?: number }) => error.status === 404);
  await assertRulesGameSupported(clientFor("delta"), "game-1");
});
