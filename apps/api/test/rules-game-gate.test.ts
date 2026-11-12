import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRulesGameSupported } from "../src/supply/game-services";
import { assertSettlementResourcePrices } from "../src/supply/rules";
import { initializeFixedFeePricing, readPricingSchedules, scheduleFixedFeePrice, schedulePricingMode, scheduleSpreadPrice } from "../src/supply/pricing-policy-schedule";
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
  let inserts=0,hasHaff=true;
  const client={query:async(sql:string)=>{
    if(sql.includes('pricing_schedule_available'))return {rows:[{ready:true}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.includes('clock_timestamp()'))return {rows:[{at:'2026-01-01T00:00:00.000000Z'}]};
    if(sql.includes('FROM zzsh_supply.game WHERE'))return {rows:[{id:'game-1'}]};
    if(sql.includes('FROM zzsh_supply.price_version WHERE'))return {rows:[{id:'price-1',mode:'PERCENT',status:'SEALED',roundingPolicy:'HALF_UP_CENT_V1',rates:{ordinary:'0.10',custom:'0.10',fast:'0.10'},haffRule:{...base,schema:'haff-ratio-v3',fixedModes:compatibility!.modes}}]};
    if(sql.includes('MAX(generation)'))return {rows:[{generation:'1'}]};
    if(sql.includes('FROM zzsh_supply.billable_item'))return {rows:[...(hasHaff?[{name:'哈夫币',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',unitQuantity:null,buyerUnitAmount:null,ownerUnitAmount:null}]:[]),
      {name:'额外物资',unit:'PIECE',pricingKind:null,unitQuantity:null,buyerUnitAmount:null,ownerUnitAmount:null}]};
    if(sql.includes('INSERT INTO'))inserts++;
    throw new Error('unexpected pricing query');
  }} as never;
  await assert.rejects(scheduleFixedFeePrice(client,{userId:'boss-1',isBoss:true},{gameId:'game-1',priceVersionId:'price-1',expectedGeneration:'1',effectiveAt:'2099-01-01T00:00:00.000Z'}),/额外物资/);
  hasHaff=false;
  await assert.rejects(scheduleFixedFeePrice(client,{userId:'boss-1',isBoss:true},{gameId:'game-1',priceVersionId:'price-1',expectedGeneration:'1',effectiveAt:'2099-01-01T00:00:00.000Z'}),/哈夫币/);
  assert.equal(inserts,0);
});

test('first-install pricing never overwrites existing schedules or uses runtime authority', async () => {
  const initialAt='2026-01-01T00:00:00.000000Z',input={gameId:'game-1',priceVersionId:'price-1',effectiveAt:initialAt,requestId:'init-1'};
  const statements:string[]=[];
  let owner=true;
  const client={query:async(sql:string)=>{
    statements.push(sql);
    if(sql.includes('FROM pg_class'))return {rows:[{owner}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.includes('FROM zzsh_supply.game WHERE'))return {rows:[{code:'delta',enabled:true,releaseId:'release-1',now:'2026-11-12T00:00:00.000000Z'}]};
    if(sql.includes('FROM zzsh_supply.pricing_policy_schedule'))return {rows:[
      {id:'price-initial',pricingModel:'FIXED_FEE',priceVersionId:'price-1',generation:'1',effectiveAt:initialAt,source:'SYSTEM_INITIAL'},
      {id:'price-later',pricingModel:'FIXED_FEE',priceVersionId:'price-2',generation:'2',effectiveAt:'2026-02-01T00:00:00.000000Z',source:'ADMIN'}]};
    if(sql.includes('FROM zzsh_supply.pricing_mode_schedule'))return {rows:[{id:'mode-initial',pricingModel:'FIXED_FEE',generation:'1',effectiveAt:initialAt,source:'SYSTEM_INITIAL'}]};
    throw new Error('unexpected initial pricing query');
  }} as never;
  assert.deepEqual(await initializeFixedFeePricing(client,input),{status:'ALREADY_INITIALIZED',priceScheduleId:'price-initial',modeScheduleId:'mode-initial'});
  await assert.rejects(initializeFixedFeePricing(client,{...input,priceVersionId:'changed'}),/未覆盖/);
  assert(!statements.some(sql=>/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql.replace(/FOR UPDATE/g,''))));
  owner=false;await assert.rejects(initializeFixedFeePricing(client,input),(error:{status?:number})=>error.status===403);
});

test('uninstalled or incomplete pricing schedule schema is visible without guessing a default',async()=>{
  const client=(prices:boolean,modes:boolean)=>({query:async()=>({rows:[{prices,modes,rates:prices&&modes,asOf:'2026-11-12T00:00:00.000000Z'}]})}) as never;
  assert.deepEqual(await readPricingSchedules(client(false,false),'game-1'),{available:false,reason:'NOT_INSTALLED',asOf:'2026-11-12T00:00:00.000000Z'});
  assert.deepEqual(await readPricingSchedules(client(true,false),'game-1'),{available:false,reason:'INCOMPLETE',asOf:'2026-11-12T00:00:00.000000Z'});
});

test('scheduled spread cannot be enabled before its whole order contract is ready',async()=>{
  let writes=0;
  const client={query:async(sql:string)=>{
    if(sql.includes('pricing_schedule_available'))return {rows:[{ready:true}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
    if(sql.includes('clock_timestamp()'))return {rows:[{at:'2026-01-01T00:00:00.000000Z'}]};
    if(sql.includes('SELECT id FROM zzsh_supply.game'))return {rows:[{id:'game-1'}]};
    if(sql.includes('MAX(generation)'))return {rows:[{generation:'1'}]};
    if(sql.includes('SELECT s.id,s.price_version_id'))return {rows:[{id:'spread-policy',priceVersionId:'spread-price'}]};
    if(sql.includes('FROM zzsh_supply.billable_item'))return {rows:[{name:'哈夫币',unit:'HAFF_BASE',pricingKind:'HAFF_RATIO',unitQuantity:null,buyerUnitAmount:null,ownerUnitAmount:null}]};
    if(sql.includes('FROM zzsh_supply.pricing_policy_schedule s'))return {rows:[{id:'spread-policy',generation:'2',effectiveAt:'2026-01-02T00:00:00.000000Z',priceVersionId:'spread-price',mode:'SPREAD',status:'SEALED',roundingPolicy:'HALF_UP_CENT_V1',rates:null,haffRule:compatRule()}]};
    if(sql.includes('SELECT p.id,p.haff_rule'))return {rows:[{id:'spread-price',haffRule:compatRule()}]};
    if(sql.includes('INSERT INTO')){writes++;return {rows:[]};}
    throw new Error('unexpected pricing query');
  }} as never;
  const actor={userId:'boss-1',isBoss:true},input={gameId:'game-1',expectedGeneration:'1',effectiveAt:'2099-01-01T00:00:00.000Z'};
  await assert.rejects(schedulePricingMode(client,actor,{...input,pricingModel:'SPREAD'}),(error:{status?:number})=>error.status===503);
  await assert.rejects(scheduleSpreadPrice(client,actor,{...input,priceVersionId:'spread-price'}),(error:{status?:number})=>error.status===503);
  await assert.rejects(scheduleSpreadPrice(client,{...actor,isBoss:false},{...input,priceVersionId:'spread-price'}),(error:{status?:number})=>error.status===403);
  assert.equal(writes,0);
});
