import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { ADMIN_USER_CONSUMPTION_SQL, readAdminUserConsumption } from "../src/finance/admin-user-consumption-read";

const viewer = { adminId:"operator",isBoss:false,subjectFinancialRead:true };
const now = "2026-10-22T10:00:00.000000Z";
const known = (extra:Record<string,unknown> = {}) => ({
  orderId:"order-one",displayNo:"ZZ001",gameId:"game-one",postingId:"posting-one",settlementVersionId:"version-one",
  versionHash:"a".repeat(64),postedAt:now,documentRef:"ORDER:order-one",knowledge:"KNOWN",reasonCodes:[],
  haffRentCents:"10001",itemConsumptionCents:"20002",earlyMakeupCents:"30003",renterFeeCents:"40004",amountCents:"100010",...extra,
});
const summary = (extra:Record<string,unknown> = {}) => ({total:"1",unknown_count:"0",known_amount:"100010",haff:"10001",items:"20002",makeup:"30003",renter_fee:"40004",...extra});
function client(bundle:Record<string,unknown>, seen:{sql:string;args:unknown[]}[] = []) {
  return {query:async(sql:string,args:unknown[])=>{seen.push({sql,args});return {rows:[bundle]};}} as unknown as PoolClient;
}

test("same scoped SQL calculates totals before paging and does not join or sum multiple ledger lines",async()=>{
  const seen:{sql:string;args:unknown[]}[]=[];
  const result=await readAdminUserConsumption(client({asOfUtc:now,summary:summary(),items:[known()]},seen),viewer,"user-one");
  assert.equal(result.amountCents,"100010");assert.equal(result.knownAmountCents,"100010");
  assert.equal(result.items[0]!.amountCents,"100010");assert.equal(result.components.renterFeeCents,"40004");
  assert.equal(result.legacyHistory.amountCents,null);assert.equal(result.legacyHistory.knowledge,"UNKNOWN");
  assert.equal(result.scope,"CURRENT_POSTED_NATIVE_SETTLEMENTS");
  assert.deepEqual(seen[0]!.args,["user-one","operator",false,20,0]);
  const sql=seen[0]!.sql;
  assert.equal(seen.length,1);assert(sql.indexOf("totals AS")<sql.indexOf("page AS"));
  assert(sql.includes("o.renter_user_id=$1"));assert(sql.includes('"zzsh_supply"."admin_supply_scope"'));
  assert(sql.includes("v.superseded_at"));assert(sql.includes("a.superseded_at IS NOT NULL"));
  assert(sql.includes("MANUAL_RENTER_ADJUSTMENT_UNALLOCATED"));
  assert(sql.includes("CASE WHEN c.fee_payer='RENTER' THEN c.fee ELSE 0 END"));
  assert(!sql.includes("settlement_ledger_entry"));assert(!/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql));
});

test("large cents remain exact across all four components and total",async()=>{
  const large="999999999999999999999990";
  const result=await readAdminUserConsumption(client({asOfUtc:now,summary:summary({known_amount:large,haff:large,items:"0",makeup:"0",renter_fee:"0"}),
    items:[known({amountCents:large,haffRentCents:large,itemConsumptionCents:"0",earlyMakeupCents:"0",renterFeeCents:"0"})]}),viewer,"user-one");
  assert.equal(result.amountCents,large);assert.equal(result.items[0]!.amountCents,large);
});

test("the aggregate may exceed the source numeric precision without truncation",async()=>{
  const itemAmount="999999999999999999999999",total=(BigInt(itemAmount)*2n).toString();
  const item=known({amountCents:itemAmount,haffRentCents:itemAmount,itemConsumptionCents:"0",earlyMakeupCents:"0",renterFeeCents:"0"});
  const result=await readAdminUserConsumption(client({asOfUtc:now,summary:summary({total:"2",known_amount:total,haff:total,items:"0",makeup:"0",renter_fee:"0"}),items:[item,{...item,orderId:"order-two",postingId:"posting-two"}]}),viewer,"user-one");
  assert.equal(result.amountCents,total);
});

test("unallocated manual change keeps total and components unknown instead of using captured minus refund",async()=>{
  const item=known({knowledge:"UNKNOWN",amountCents:null,haffRentCents:null,itemConsumptionCents:null,earlyMakeupCents:null,renterFeeCents:null,
    reasonCodes:["MANUAL_RENTER_ADJUSTMENT_UNALLOCATED"]});
  const result=await readAdminUserConsumption(client({asOfUtc:now,summary:summary({total:"2",unknown_count:"1"}),items:[known(),item]}),viewer,"user-one");
  assert.equal(result.knowledge,"UNKNOWN");assert.equal(result.amountCents,null);assert.equal(result.knownAmountCents,"100010");
  assert.deepEqual(result.components,{haffRentCents:null,itemConsumptionCents:null,earlyMakeupCents:null,renterFeeCents:null});
  assert.equal(result.unknownCount,1);assert.equal(result.items[1]!.amountCents,null);
});

test("empty native posting collection is a known zero only within its explicit scope",async()=>{
  const result=await readAdminUserConsumption(client({asOfUtc:now,summary:summary({total:"0",known_amount:"0",haff:"0",items:"0",makeup:"0",renter_fee:"0"}),items:[]}),viewer,"user-one");
  assert.equal(result.amountCents,"0");assert.equal(result.total,0);assert.equal(result.legacyHistory.amountCents,null);
});

test("page two contains only its requested rows while summary remains the whole scoped collection",async()=>{
  const seen:{sql:string;args:unknown[]}[]=[];
  const result=await readAdminUserConsumption(client({asOfUtc:now,summary:summary({total:"21",known_amount:"2100210",haff:"210021",items:"420042",makeup:"630063",renter_fee:"840084"}),items:[known()]},seen),viewer,"user-one",{page:2,pageSize:20});
  assert.equal(result.total,21);assert.equal(result.items.length,1);assert.equal(result.amountCents,"2100210");
  assert.deepEqual(seen[0]!.args,["user-one","operator",false,20,20]);
});

test("permission, empty business scope and query validation reject before any SQL",async()=>{
  const seen:{sql:string;args:unknown[]}[]=[],c=client({},seen);
  await assert.rejects(readAdminUserConsumption(c,{...viewer,subjectFinancialRead:false},"user-one"),(e:any)=>e.status===403);
  await assert.rejects(readAdminUserConsumption(c,{...viewer,businessScopeUsable:false},"user-one"),(e:any)=>e.status===403&&e.code==="NO_GAME_SCOPE");
  for(const query of [{page:0},{page:1.1},{pageSize:101},{pageSize:0},{page:Number.MAX_SAFE_INTEGER,pageSize:100}])
    await assert.rejects(readAdminUserConsumption(c,viewer,"user-one",query),(e:any)=>e.status===400);
  await assert.rejects(readAdminUserConsumption(c,viewer,"bad/user"),(e:any)=>e.status===400);
  assert.equal(seen.length,0);
});

test("non-integer, inconsistent or incomplete evidence fails closed",async()=>{
  for(const bundle of [
    {asOfUtc:now,summary:summary({known_amount:"1000.10"}),items:[known()]},
    {asOfUtc:now,summary:summary({haff:"1"}),items:[known()]},
    {asOfUtc:now,summary:summary(),items:[known({amountCents:"1"})]},
    {asOfUtc:now,summary:summary(),items:[known({knowledge:"UNKNOWN",reasonCodes:["CONSUMPTION_COMPONENTS_INVALID"]})]},
    {asOfUtc:now,summary:summary(),items:[]},
    {asOfUtc:now,summary:summary({unknown_count:"2"}),items:[known()]},
  ]) await assert.rejects(readAdminUserConsumption(client(bundle),viewer,"user-one"),(e:any)=>e.status===503);
});

test("SQL guards all four snapshot components, current posting identity and actual local acceptance",()=>{
  for(const field of ["haffConsumedBuyer","itemConsumedBuyer","earlyMakeup","feeAmount","renterCharge"])
    assert(ADMIN_USER_CONSUMPTION_SQL.includes(`jsonb_typeof(s.input_snapshot #> '{amounts,${field}}')='string'`));
  for(const guard of ["a.disposition IS DISTINCT FROM 'APPLIED'","a.status IS DISTINCT FROM 'COMPLETED'",
    "a.snapshot_hash IS DISTINCT FROM a.version_hash","a.payment_order_id IS DISTINCT FROM a.order_id",
    "a.fee IS DISTINCT FROM a.compensation_fee_cents","TENANT_VOLUNTARY_EARLY"])
    assert(ADMIN_USER_CONSUMPTION_SQL.includes(guard));
});
