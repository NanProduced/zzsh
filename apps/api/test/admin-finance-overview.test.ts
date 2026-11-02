import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { parseFinanceOverviewRange, readAdminFinanceOverview } from "../src/finance/admin-finance-overview";

test("finance overview accepts only its explicit bounded range", () => {
  assert.equal(parseFinanceOverviewRange(new URLSearchParams()), "7d");
  for (const range of ["today", "7d", "30d"]) assert.equal(parseFinanceOverviewRange(new URLSearchParams({ range })), range);
  for (const query of ["range=all", "range=today&range=7d", "scope=ALL"]) assert.throws(() => parseFinanceOverviewRange(new URLSearchParams(query)));
});
function fixture(broken = false) {
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql); let rows: object[];
    if (sql.includes(" AS as_of")) rows = [{ as_of: "2026-11-02T04:00:00.000000Z", starts_at: "2026-10-26T16:00:00.000000Z" }];
    else if (sql.includes("original accepted payments")) rows = [{ count: "6", amount: "1379935", controlled: "1379935", channel: "0" }];
    else if (sql.includes("period settlement allocation")) rows = [{ count: "3", captured: broken ? "266403" : "266402", owner: "18000", refund: "206284", platform: "42118" }];
    else if (sql.includes("current paid unallocated")) rows = [{ count: "3", amount: "1113533" }];
    else if (sql.includes("current paid preview")) rows = [{ id: "o_fixture", number: "ZZ-TEST", amount: "368686", paid_at: "2026-10-30T00:00:00.000000Z" }];
    else if(sql.includes("current review payments"))rows=[{count:'1',amount:'900',unknown_count:'0'}];
    else if(sql.includes("current review preview"))rows=[{id:'review_fixture',order_id:'cancelled',number:'ZZ-CANCELLED',amount:'900',currency:'CNY',source:'CONTROLLED',reason_code:'LATE_PAYMENT',confirmed_at:'2026-10-31T00:00:00.000000Z'}];
    else if(sql.includes("recent verified allocations"))rows=[{id:'o_posted',number:'ZZ-POSTED',owner_user_id:'owner_zero',renter_user_id:'renter',owner_name:'13800138000',renter_name:'租客',captured:'234586',owner:'0',refund:'196284',platform:'38302',posted_at:'2026-10-30T01:00:00.000000Z'}];
    else if (sql.includes("current ledger balances")) rows = [{ bucket: "AVAILABLE", balance: "6034210" }, { bucket: "REFUND_PAYABLE", balance: "206284" }, { bucket: "PLATFORM", balance: "42122" }, { bucket: "CLEARING", balance: "-6282616" }];
    else if (sql.includes("registered subject coverage")) rows = [{ registered: "629", subjects: "155182" }];
    else if(sql.includes("queues effective schema and ACL"))rows=[{refunds:false,withdrawals:false}];
    else throw new Error("Unexpected overview query");
    return { rows };
  } } as unknown as PoolClient;
  return { client, statements };
}
test("original receipts, posting allocation and current balances are different facts and clocks", async () => {
  const f = fixture(), result = await readAdminFinanceOverview(f.client, "7d", true, false);
  assert.equal(result.confirmedPayments.amountCents, "1379935");
  assert.equal(result.settlements.capturedCents, "266402");
  assert.equal(result.confirmedPayments.timeBasis, "paid_at"); assert.equal(result.settlements.timeBasis, "posted_at");
  assert.equal(result.pendingSettlement.amountCents, "1113533");
  assert.equal(result.ledgerBalances.find(row => row.bucket === "CLEARING")?.balanceCents, "-6282616");
  assert.equal(result.coverage.globalProof, "UNPROVEN");
  assert.equal(result.costs.netContributionCents, null); assert.equal(result.channels.state, "NOT_CONFIGURED");
  assert.equal(result.queues.refunds.amountCents, null); assert.equal(result.queues.refunds.count, null);
  assert.ok(f.statements.every(sql => !/\b(?:INSERT|UPDATE|DELETE|COMMIT|TRUNCATE)\b/.test(sql)));
});
test("pending preview does not manufacture a document read capability", async () => {
  const result = await readAdminFinanceOverview(fixture().client, "today", false, true);
  assert.equal(result.pendingSettlement.items[0]?.documentRef, null);
  assert.equal(result.channels.state, "CONFIGURED_NOT_OBSERVED");
  assert.equal(result.confirmedPayments.channelAmountCents, "0");
});
test("a broken posting allocation is unavailable, never rounded or replaced by zero", async () => {
  await assert.rejects(readAdminFinanceOverview(fixture(true).client, "30d", true, false), (error: unknown) => (error as { status?: number }).status === 503);
});

test('review payments remain unapplied and recent allocations keep zero-net parties and masked names',async()=>{
 const result=await readAdminFinanceOverview(fixture().client,'7d',true,false);
 assert.equal(result.reviewPayments.count,'1');assert.equal(result.reviewPayments.amountCents,'900');
 assert.equal(result.reviewPayments.currentOutstandingOnly,false);assert.equal(result.reviewPayments.sourceScope,'ORIGINAL_REVIEW_RECORDS');
 assert.ok(result.reviewPayments.reasonCodes.includes('CURRENT_RESPONSIBILITY_IN_REFUND_QUEUE'));
 assert.equal(result.reviewPayments.items[0]?.reasonCode,'LATE_PAYMENT');assert.equal(result.reviewPayments.items[0]?.documentRef,'ORDER:cancelled');
 assert.equal(result.confirmedPayments.amountCents,'1379935','review receipt is not added to APPLIED');
 assert.equal(result.recentSettlements[0]?.ownerNetCents,'0');assert.equal(result.recentSettlements[0]?.owner.name,'138****8000');
 assert.equal(result.recentSettlements[0]?.documentRef,'ORDER:o_posted');
 const restricted=await readAdminFinanceOverview(fixture().client,'7d',false,false);
 assert.equal(restricted.reviewPayments.items[0]?.documentRef,null);assert.equal(restricted.recentSettlements[0]?.documentRef,null);
});

test('overview invokes the real obligation reader in the same snapshot and preserves source knowledge',async()=>{
 const f=fixture(),query=f.client.query.bind(f.client);let queueAsOf:unknown;
 f.client.query=(async(sql:string,values:unknown[])=>{
  if(sql.includes('queues effective schema and ACL'))return{rows:[{refunds:true,withdrawals:false}]};
  if(sql.includes('refund responsibilities')){
   queueAsOf=values[0];return{rows:[{count:'1',amount:'900',unknown_count:'0',overdue_count:'1',overdue_amount:'900',unknown_due_count:'0',
    items:[{id:'POSTING:p',number:'ZZ-POSTED',source:'POSTING',status:'NO_INTENT',amountCents:'900',recordedAmountCents:'900',dueAt:'2026-11-01T00:00:00.000000Z',overdue:true,documentRef:'ORDER:o_posted',reasonCodes:['NO_LOCAL_INTENT_DOES_NOT_PROVE_NO_BANK_REFUND']}],
    sources:[{source:'POSTING',count:'1',unknownCount:'0',amountCents:'900'}]}]};
  }
  return query(sql,values);
 }) as typeof f.client.query;
 const result=await readAdminFinanceOverview(f.client,'7d',true,false);
 assert.equal(queueAsOf,result.asOf);assert.equal(result.queues.refunds.amountCents,'900');assert.equal(result.queues.refunds.overdueCount,'1');
 assert.equal(result.queues.refunds.bankArrival,'UNKNOWN');assert.equal(result.queues.withdrawals.knowledge,'UNAVAILABLE');
 assert.equal(result.queues.withdrawals.amountCents,null);
});

test('inconsistent receipt source totals cannot silently look like a complete period',async()=>{
 const f=fixture(),query=f.client.query.bind(f.client);
 f.client.query=(async(sql:string,values:unknown[])=>sql.includes('original accepted payments')?{rows:[{count:'6',amount:'100',controlled:'99',channel:'0'}]}:query(sql,values)) as typeof f.client.query;
 await assert.rejects(readAdminFinanceOverview(f.client,'7d',true,false),(error:unknown)=>(error as {status?:number}).status===503);
});
