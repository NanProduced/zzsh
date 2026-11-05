import { test } from "node:test";
import assert from "node:assert/strict";
import { approveLocalNativePolicy, guardedApprovalPool } from "./local-distribution-policy-runtime.mjs";

test("expired or changed build prevents the actual approval COMMIT", async () => {
  const statements = [], rawQuery = async sql => { statements.push(sql); return {}; }, rawRelease = () => {};
  const client = { query: rawQuery, release: rawRelease }, pool = { connect: async () => client, query: async () => ({}) };
  const guarded = guardedApprovalPool(pool, () => { throw Error("window expired"); });
  const c = await guarded.connect(); await c.query("BEGIN");
  assert.throws(() => c.query("COMMIT"), /window expired/); await c.query("ROLLBACK"); c.release();
  assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]); assert.equal(c.query, rawQuery); assert.equal(c.release, rawRelease);
});

test("busy regression maintenance lock stops before opening a policy database pool", async () => {
  let closed = false, saved = false;
  class FakeClient { async connect() {} async query() { return { rows: [{ ok: false }] }; } async end() { closed = true; } }
  const params = { Client: FakeClient, credentials: { migration: { name: "migration", password: "fixture" } }, base: {}, summary: {}, save: () => { saved = true; } };
  await assert.rejects(approveLocalNativePolicy(params), /DISTRIBUTION_MAINTENANCE_LOCK_BUSY/);
  assert(closed && saved && params.summary.lockClientClosed); assert.equal(params.summary.policyId, undefined);
});
