import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { readAccountOccupancyFacts, readLegacyAwareOrderOccupancy, mergeOrderOccupancy } from "../src/order/legacy-order-occupancy";
import { composeSupplyGateWithOrderOccupancy } from "../src/order/order";

test("occupancy precedence and actual shared query include isolated liability and terminal head", async () => {
  assert.equal(mergeOrderOccupancy("FREE", "UNKNOWN", "OCCUPIED"), "OCCUPIED");
  assert.equal(mergeOrderOccupancy("FREE", "UNKNOWN"), "UNKNOWN");
  for (const state of ["FREE", "OCCUPIED", "UNKNOWN"] as const) {
    const client = { query: async (sql: string, params: unknown[]) => {
      assert(sql.includes("legacy_inflight_register")); assert(sql.includes("ISOLATED_PARTY"));
      assert(sql.includes("h.superseded_at IS NULL")); assert(sql.includes("h.stage<>4"));
      assert.deepEqual(params, ["fixture_account"]);
      return { rows: [{ state }] };
    } } as unknown as PoolClient;
    assert.equal(await readLegacyAwareOrderOccupancy(client, "fixture_account"), state);
  }
});
test("schema/DB failure and malformed query results cannot fall back FREE", async () => {
  const failure = Object.assign(new Error("missing relation"), { code: "42P01" });
  await assert.rejects(readLegacyAwareOrderOccupancy({ query: async () => { throw failure; } } as unknown as PoolClient, "fixture"), error => error === failure);
  await assert.rejects(readLegacyAwareOrderOccupancy({ query: async () => ({ rows: [] }) } as unknown as PoolClient, "fixture"), /OCCUPANCY_UNKNOWN/);
});
test("public occupancy labels only use authoritative native states and never carry a stale funding-reader label", async () => {
  for (const kind of ["PENDING_PAYMENT", "RENTED"] as const) {
    const client = { query: async () => ({ rows: [{ state: "OCCUPIED", kind }] }) } as unknown as PoolClient;
    assert.deepEqual(await readAccountOccupancyFacts(client, "fixture"), { state: "OCCUPIED", kind });
  }
  const unknownKind = { query: async () => ({ rows: [{ state: "OCCUPIED", kind: "UNRECOGNIZED" }] }) } as unknown as PoolClient;
  assert.deepEqual(await readAccountOccupancyFacts(unknownKind, "fixture"), { state: "OCCUPIED", kind: "OCCUPIED" });
  const free = { query: async () => ({ rows: [{ state: "FREE", kind: null }] }) } as unknown as PoolClient;
  const gate = composeSupplyGateWithOrderOccupancy(async () => ({ publisherBail: "NOT_REQUIRED", reference: "fixture", occupancy: "OCCUPIED", occupancyKind: "RENTED" }));
  assert.deepEqual(await gate(free, { id: "fixture" } as never), { publisherBail: "NOT_REQUIRED", reference: "fixture", occupancy: "FREE" });
});

test("completed native rental remains terminal even when it no longer occupies; cancelled attempts are not terminal", async () => {
  let calls = 0;
  const client = { query: async (sql: string, values: unknown[]) => {
    calls++; assert.match(sql, /status='COMPLETED'/); assert.deepEqual(values, ['supply-once']);
    return { rows: [{ state: 'FREE', kind: null, rentalCompleted: true }] };
  } } as unknown as PoolClient;
  const gate = composeSupplyGateWithOrderOccupancy(async () => ({ publisherBail:'NOT_REQUIRED',occupancy:'FREE',reference:'proof' }));
  assert.equal((await gate(client, {id:'supply-once'} as never)).rentalCompleted, true);
  assert.equal(calls, 1, 'terminal and occupancy facts share the existing query');
  const cancelled = { query: async () => ({ rows: [{ state:'FREE',kind:null,rentalCompleted:false }] }) } as unknown as PoolClient;
  const stale = composeSupplyGateWithOrderOccupancy(async () => ({publisherBail:'NOT_REQUIRED',occupancy:'FREE',reference:'proof',rentalCompleted:true}));
  assert.equal((await stale(cancelled,{id:'supply-once'} as never)).rentalCompleted, undefined, 'only fresh order facts establish terminal rental');
});
