import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { readLegacyAwareOrderOccupancy, mergeOrderOccupancy } from "../src/order/legacy-order-occupancy";

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
