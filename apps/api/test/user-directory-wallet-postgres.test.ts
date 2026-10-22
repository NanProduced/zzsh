import assert from "node:assert/strict";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

import { readUserDirectoryWalletSummaries } from "../src/auth/user-directory-wallet";

/**
 * 目录可用余额的真实 PG 独立算例。
 * 期望值由原始账务行在测试内独立算出，不调用被测的 aggregate；
 * 写入只发生在回滚事务里，共享数据与管理员权限都不改。
 */
const database = process.env.ADM_USER_LIST_DATABASE ?? "zzsh_test_order_user_maint_r_21";
const runtimeUser = process.env.ADM_USER_LIST_USER ?? "adm_user_list_r01_r";
const password = process.env.ADM_USER_LIST_PASSWORD?.trim();
const pool = password ? new Pool({ host: "127.0.0.1", port: 55432, user: runtimeUser, password, database, application_name: "adm-user-list-r01-pg" }) : null;

const AVAILABLE = ["OWNER_AVAILABLE", "WALLET_AVAILABLE"];

async function expectedAvailable(client: PoolClient, userId: string): Promise<string> {
  const rows = (await client.query<{ debit: string; credit: string; accountCode: string }>(
    `SELECT debit_cents::text AS debit, credit_cents::text AS credit, account_code AS "accountCode"
       FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id = $1`, [userId],
  )).rows;
  let total = 0n;
  for (const row of rows) {
    if (!AVAILABLE.includes(row.accountCode)) continue;
    total += BigInt(row.credit) - BigInt(row.debit);
  }
  return total.toString();
}

test("the directory wallet summary matches the admitted ledger rows", { skip: !password ? "runtime-role credential not supplied; no superuser fallback" : false }, async () => {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const meta = (await client.query(
      "SELECT current_database() AS name, current_user AS role, (SELECT oid FROM pg_database WHERE datname=current_database())::text AS oid, (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) AS marker",
    )).rows[0];
    assert.equal(meta?.name, database);
    assert.equal(meta?.role, runtimeUser);
    assert.equal(meta?.marker, "zzsh:order-reservation-test:v1");

    await client.query("BEGIN");
    try {
      const covered = (await client.query<{ userId: string }>(
        `SELECT c.user_id AS "userId" FROM zzsh_order.wallet_coverage c
          WHERE EXISTS (SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.counterparty_user_id = c.user_id)
          LIMIT 1`,
      )).rows[0];
      assert.ok(covered, "an admitted coverage with ledger rows is required");
      const coveredExpected = await expectedAvailable(client, covered.userId);
      const coveredSummary = (await readUserDirectoryWalletSummaries(client, { walletRead: true }, [covered.userId])).get(covered.userId);
      assert.equal(coveredSummary?.state, "ready");
      assert.equal(coveredSummary?.state === "ready" ? coveredSummary.amountCents : null, coveredExpected, "the summary equals the independently summed ledger rows");
      assert.equal(coveredSummary?.state === "ready" ? coveredSummary.currency : null, "CNY");

      const empty = (await client.query<{ userId: string }>(
        `SELECT c.user_id AS "userId" FROM zzsh_order.wallet_coverage c
          WHERE NOT EXISTS (SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.counterparty_user_id = c.user_id)
          LIMIT 1`,
      )).rows[0];
      if (empty) {
        const emptySummary = (await readUserDirectoryWalletSummaries(client, { walletRead: true }, [empty.userId])).get(empty.userId);
        assert.equal(emptySummary?.state, "ready", "an admitted coverage without ledger rows is a real zero");
        assert.equal(emptySummary?.state === "ready" ? emptySummary.amountCents : null, "0");
      }

      const unadmitted = (await client.query<{ userId: string }>(
        `SELECT u.id AS "userId" FROM zzsh_auth_user."user" u
          WHERE NOT EXISTS (SELECT 1 FROM zzsh_order.wallet_coverage c WHERE c.user_id = u.id) LIMIT 1`,
      )).rows[0];
      assert.ok(unadmitted, "a user without admitted coverage is required");
      const unadmittedSummary = (await readUserDirectoryWalletSummaries(client, { walletRead: true }, [unadmitted.userId])).get(unadmitted.userId);
      assert.equal(unadmittedSummary?.state, "unknown", "an unadmitted coverage is unknown, never a zero");
      assert.equal(unadmittedSummary?.state === "unknown" ? unadmittedSummary.reason : null, "SOURCE_COVERAGE_NOT_ADMITTED");

      const deniedSummary = (await readUserDirectoryWalletSummaries(client, { walletRead: false }, [covered.userId])).get(covered.userId);
      assert.equal(deniedSummary?.state, "denied", "without the capability no amount is returned at all");

      // 提现预留不计入可用余额：真实数据里带 WALLET_RESERVED 的用户，可用余额只算可用科目。
      const reserved = (await client.query<{ userId: string }>(
        `SELECT l.counterparty_user_id AS "userId" FROM zzsh_order.settlement_ledger_entry l
          WHERE l.account_code = 'WALLET_RESERVED' LIMIT 1`,
      )).rows[0];
      assert.ok(reserved, "a reserved amount is required to prove the exclusion");
      const reservedExpected = await expectedAvailable(client, reserved.userId);
      const reservedSummary = (await readUserDirectoryWalletSummaries(client, { walletRead: true }, [reserved.userId])).get(reserved.userId);
      assert.equal(reservedSummary?.state, "ready");
      assert.equal(reservedSummary?.state === "ready" ? reservedSummary.amountCents : null, reservedExpected, "the reserved bucket is excluded from the available amount");
      const reservedRows = (await client.query<{ accountCode: string; net: string }>(
        `SELECT account_code AS "accountCode", (credit_cents-debit_cents)::text AS net FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id = $1`,
        [reserved.userId],
      )).rows;
      const reservedNet = reservedRows.filter((row) => row.accountCode === "WALLET_RESERVED").reduce((total, row) => total + BigInt(row.net), 0n);
      assert.notEqual(reservedExpected, reservedNet.toString(), "a reserved amount is never reported as the available balance");
    } finally {
      await client.query("ROLLBACK");
    }
    const afterRollback = (await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM zzsh_order.settlement_ledger_entry WHERE id LIKE 'ledger_r01_%'",
    )).rows[0];
    assert.equal(afterRollback?.count, "0", "the transaction rolled back; the shared ledger is untouched");
  } finally {
    client.release();
    await pool.end();
  }
});
