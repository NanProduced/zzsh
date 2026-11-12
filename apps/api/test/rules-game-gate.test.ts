import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRulesGameSupported } from "../src/supply/game-services";
import { assertSettlementResourcePrices } from "../src/supply/rules";
import { scheduleFixedFeePrice } from "../src/supply/pricing-policy-schedule";
import { compatRule } from "./pricing-compat-fixture";

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

test('scheduling a fixed-fee price rejects an enabled item without a price', async () => {
  const {compatibility,...base}=compatRule();
  let inserts=0;
  const client={query:async(sql:string)=>{
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.includes('clock_timestamp()'))return {rows:[{at:'2026-01-01T00:00:00.000000Z'}]};
    if(sql.includes('FROM zzsh_supply.game WHERE'))return {rows:[{id:'game-1'}]};
    if(sql.includes('FROM zzsh_supply.price_version WHERE'))return {rows:[{id:'price-1',mode:'PERCENT',status:'SEALED',rates:{ordinary:'0.10',custom:'0.10',fast:'0.10'},haffRule:{...base,schema:'haff-ratio-v3',fixedModes:compatibility!.modes}}]};
    if(sql.includes('MAX(generation)'))return {rows:[{generation:'1'}]};
    if(sql.includes('FROM zzsh_supply.billable_item'))return {rows:[{name:'额外物资',unit:'PIECE',pricingKind:null,unitQuantity:null,buyerUnitAmount:null,ownerUnitAmount:null}]};
    if(sql.includes('INSERT INTO'))inserts++;
    throw new Error('unexpected pricing query');
  }} as never;
  await assert.rejects(scheduleFixedFeePrice(client,{userId:'boss-1',isBoss:true},{gameId:'game-1',priceVersionId:'price-1',expectedGeneration:'1',effectiveAt:'2099-01-01T00:00:00.000Z'}),/额外物资/);
  assert.equal(inserts,0);
});
