import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRulesGameSupported } from "../src/supply/game-services";
import { assertSettlementResourcePrices } from "../src/supply/rules";

const clientFor = (code: string | null) => ({ query: async (sql: string, params: unknown[]) => { assert.match(sql, /FROM "zzsh_supply"\."game"/); assert.deepEqual(params, ["game-1"]); return { rows: code === null ? [] : [{ code }] }; } }) as never;

test("delta-only rules writes reject a non-delta game at the common write entry", async () => {
  await assert.rejects(() => assertRulesGameSupported(clientFor("other"), "game-1"), (error: { status?: number; code?: string }) => error.status === 409 && error.code === "UNSUPPORTED_GAME_SERVICE");
  await assert.rejects(() => assertRulesGameSupported(clientFor(null), "game-1"), (error: { status?: number }) => error.status === 404);
  await assertRulesGameSupported(clientFor("delta"), "game-1");
});

test('rule activation checks every enabled settlement item, including items with no opening stock',()=>{
  const item={name:'额外物资',unit:'PIECE',pricingKind:'FIXED_UNIT',unitQuantity:'1',buyerUnitAmount:'10.00',ownerUnitAmount:'8.00'};
  assert.doesNotThrow(()=>assertSettlementResourcePrices('SPREAD',[item]));
  assert.doesNotThrow(()=>assertSettlementResourcePrices('PERCENT',[{...item,ownerUnitAmount:null}]));
  assert.throws(()=>assertSettlementResourcePrices('SPREAD',[{...item,ownerUnitAmount:null}]),/额外物资/);
  assert.throws(()=>assertSettlementResourcePrices('SPREAD',[{...item,ownerUnitAmount:'10.01'}]),/额外物资/);
  assert.throws(()=>assertSettlementResourcePrices('SPREAD',[{...item,pricingKind:null}]),/额外物资/);
  assert.throws(()=>assertSettlementResourcePrices('SPREAD',Array(64).fill(item)),/63/);
});
