import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import { listAdminOrders } from "../src/order/order";
import { sha256Hex } from "../src/supply/supply-util";

test("admin order query binds the five exact filters without changing projection", async () => {
  let sql = "";
  let parameters: unknown[] = [];
  const client = {
    query: async (statement: string, values: unknown[]) => {
      sql = statement;
      parameters = values;
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const result = await listAdminOrders(client, { adminId: "admin-1", isBoss: false, internalQuote: false }, {
    status: "PAID",
    displayNo: "ZZ20260930-000001",
    renterUserId: "user-renter-1",
    ownerUserId: "user-owner-1",
    createdFrom: "2026-09-01T00:00:00.000Z",
    createdTo: "2026-10-01T00:00:00.000Z",
    limit: 20,
  });

  assert.deepEqual(result, { items: [], nextCursor: null, limit: 20 });
  assert.match(sql, /o\.display_no = \$6/);
  assert.match(sql, /o\.renter_user_id = \$7/);
  assert.match(sql, /o\.owner_user_id = \$8/);
  assert.match(sql, /o\.created_at >= \$9/);
  assert.match(sql, /o\.created_at < \$10/);
  assert.deepEqual(parameters, [
    false,
    "admin-1",
    "PAID",
    null,
    null,
    "ZZ20260930-000001",
    "user-renter-1",
    "user-owner-1",
    "2026-09-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
    null,
    null,
    21,
  ]);
});

test("admin order cursor is rejected when any new filter changes", async () => {
  const oldFilterKey = sha256Hex(JSON.stringify({
    scope: "admin-orders",
    principal: "admin-1",
    status: null,
    accountId: null,
    gameId: null,
    displayNo: null,
    renterUserId: null,
    ownerUserId: null,
    createdFrom: null,
    createdTo: null,
    limit: 20,
  }));
  const cursor = Buffer.from(JSON.stringify({ f: oldFilterKey, c: "2026-09-30T00:00:00.000000Z", i: "order-1" })).toString("base64url");
  const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  const admin = { adminId: "admin-1", isBoss: false, internalQuote: false };
  const changes: Array<Record<string, string>> = [
    { displayNo: "ZZ20260930-000001" },
    { renterUserId: "user-renter-1" },
    { ownerUserId: "user-owner-1" },
    { createdFrom: "2026-09-01T00:00:00.000Z" },
    { createdTo: "2026-10-01T00:00:00.000Z" },
  ];

  for (const change of changes) {
    await assert.rejects(
      () => listAdminOrders(client, admin, { ...change, limit: 20, cursor }),
      (failure: unknown) => (failure as { status?: number; code?: string }).status === 409 && (failure as { code?: string }).code === "CONFLICT",
    );
  }
});
