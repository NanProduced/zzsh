import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import { listMyOrders, type OrderRow } from "../src/order/order";

const money = (amount: string) => ({ currency: "CNY" as const, unit: "yuan" as const, amount, scale: 2 as const });
const unitMoney = (amount: string) => ({ currency: "CNY" as const, unit: "yuan" as const, amount, scale: 8 as const });
const row = (id: string, itemId: string): OrderRow => ({
  id,
  displayNo: id,
  accountId: "account_1",
  versionId: "version_1",
  ownerUserId: "owner_1",
  renterUserId: "renter_1",
  gameId: "delta",
  releaseId: "release_1",
  contentHash: "hash",
  termOptionCode: "term_1",
  status: "COMPLETED",
  rentalAmountCents: "100",
  depositAmountCents: "0",
  currency: "CNY",
  termSeconds: "86400",
  quoteSnapshot: {
    schemaVersion: 1,
    currency: "CNY",
    priceVersionId: "price_1",
    ruleReleaseId: "release_1",
    mode: "SPREAD",
    lines: [{ itemId, quantity: "1", unit: "PIECE", unitQuantity: "1", pricingKind: "FIXED_UNIT", buyerUnitAmount: unitMoney("1.00000000"), ownerUnitAmount: unitMoney("0.80000000"), buyerAmount: money("1.00"), ownerAmount: money("0.80"), platformAmount: money("0.20") }],
    resourceTotal: money("1.00"),
    ownerTotal: money("0.80"),
    platformFullProfit: money("0.20"),
    tenantDeposit: null,
    publisherBailRequirement: null,
    termSeconds: "86400",
    expiryDisclosures: [],
    unitAmountsInformational: false,
    roundingPolicy: "HALF_UP_CENT",
    pricingInputs: {
      haffRatioSchema: null,
      conditions: null,
      denominators: null,
      spreadDelta: null,
      commissionRate: null,
      exactRatios: [],
      roundingPolicy: "HALF_UP_CENT",
      depositPolicy: "CONFIGURED",
      reasonCodes: [],
    },
  },
  title: "测试账号",
  holdUntil: "2026-10-27T00:00:00.000000Z",
  paidAt: "2026-10-26T00:00:00.000000Z",
  dispatchState: null,
  dispatchWaitReason: null,
  assignedAt: null,
  teamState: null,
  firstResponseAt: null,
  remindDueAt: null,
  addRound: 0,
  escalationState: "NOT_STARTED",
  cancelReason: null,
  cancelledAt: null,
  createdAt: "2026-10-26T00:00:00.000000Z",
  revision: "1",
  expiredAwaitingCancel: false,
  ownerName: "号主",
  renterName: "租客",
});

test("listMyOrders hydrates frozen line names in one catalog read", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("zzsh_order.rental_order")) return { rows: [row("order_1", "awm"), row("order_2", "coffee")] };
      if (sql.includes("zzsh_supply.billable_item")) return { rows: [{ id: "awm", name: "AWM子弹" }, { id: "coffee", name: "咖啡豆" }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;

  const page = await listMyOrders(client, "renter_1", { party: "renter", limit: 20 }) as { items: Array<{ quote: { lines: Array<{ itemId: string; name?: string }> } }> };
  assert.equal(calls.filter((call) => call.sql.includes("billable_item")).length, 1, "one catalog read for the whole page");
  assert.deepEqual(calls.find((call) => call.sql.includes("billable_item"))!.values, [["awm", "coffee"]]);
  assert.deepEqual(page.items.map((item) => item.quote.lines[0]!.name), ["AWM子弹", "咖啡豆"]);
  assert.equal(page.items[0]!.quote.lines[0]!.itemId, "awm");
});
