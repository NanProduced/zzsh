import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { loadOrderSweepRuntime } from "../src/order/order-sweep.module";

const pool = {} as Pool;
test("standard business startup composes bounded expired-hold cleanup", () => {
  assert.deepEqual(loadOrderSweepRuntime(pool, {}), { pool, intervalMs: 5000, batchLimit: 25, scanLimit: 100, lockTimeoutMs: 250 });
});
test("health-only and explicit read-only previews do not start a sweeper", () => {
  assert.equal(loadOrderSweepRuntime(undefined, {}), undefined);
  assert.equal(loadOrderSweepRuntime(pool, { ORDER_SWEEP_ENABLED: "false" }), undefined);
  assert.equal(loadOrderSweepRuntime(undefined, { ORDER_SWEEP_ENABLED: "false" }), undefined);
});
test("explicit cleanup requires the authenticated business pool and rejects malformed flags", () => {
  assert.throws(() => loadOrderSweepRuntime(undefined, { ORDER_SWEEP_ENABLED: "true" }), /business database/);
  for (const value of ["", "yes", "1", "TRUE"]) assert.throws(() => loadOrderSweepRuntime(pool, { ORDER_SWEEP_ENABLED: value }), /true or false/);
  assert.equal(loadOrderSweepRuntime(pool, { ORDER_SWEEP_ENABLED: " true " })?.pool, pool);
});
