import type { PoolClient } from "pg";

import { exactCents } from "../finance/finance-money";

/**
 * 目录用的可用余额摘要。只读，不触碰任何资金 writer。
 * 口径与单用户账务读取一致：可用 bucket 的精确整数分；提现预留、待结算收益、应退、
 * 押金与保证金都不计入；账务覆盖未接纳或原���不一致时是未知，不是 0。
 */
export type DirectoryWalletSummary =
  | { state: "ready"; amountCents: string; currency: "CNY"; asOfUtc: string }
  | { state: "unknown"; reason: "SOURCE_COVERAGE_NOT_ADMITTED" | "NATIVE_ORIGIN_INCONSISTENT" | "LEDGER_REQUIRES_RECONCILIATION" | "LEDGER_UNREADABLE" }
  | { state: "denied"; permission: "user.wallet.read" };

export const DIRECTORY_WALLET_PERMISSION = "user.wallet.read";

/** 可用 bucket 与单用户账务读取完全一致，不新增或合并其他科目。 */
export const DIRECTORY_WALLET_AVAILABLE_CODES = "('OWNER_AVAILABLE','WALLET_AVAILABLE')";

/**
 * 候选集侧的可用余额聚合（排序／过滤用）。覆盖未接纳或原账口径不一致的用户没有余额事实，
 * 排序键为 NULL，排在最后且不补 0。
 */
export const DIRECTORY_WALLET_SORT_JOINS = `
  LEFT JOIN (
    SELECT counterparty_user_id AS user_id,
      sum(credit_cents-debit_cents) FILTER (WHERE account_code IN ${DIRECTORY_WALLET_AVAILABLE_CODES})::text AS available_cents
    FROM zzsh_order.settlement_ledger_entry
    GROUP BY counterparty_user_id
  ) wallet_ledger ON wallet_ledger.user_id = u.id
  LEFT JOIN zzsh_order.wallet_coverage wallet_coverage ON wallet_coverage.user_id = u.id
  LEFT JOIN zzsh_order.finance_opening_basis wallet_basis
    ON wallet_basis.id = wallet_coverage.basis_id AND wallet_basis.user_id = wallet_coverage.user_id`;

/** 排序键：只有账务覆盖已接纳且原账口径一致的用户才有可用余额事实。 */
export const DIRECTORY_WALLET_SORT_KEY = `CASE WHEN wallet_coverage.user_id IS NOT NULL
      AND (wallet_coverage.origin <> 'NATIVE_GENESIS'
        OR (wallet_basis.source_kind = 'NATIVE_GENESIS' AND wallet_basis.available_cents = '0' AND wallet_basis.covered_count = 0))
      AND COALESCE(wallet_ledger.available_cents, '0')::numeric >= 0
    THEN COALESCE(wallet_ledger.available_cents, '0')::numeric
    ELSE NULL END`;

type CoverageRow = {
  userId: string;
  origin: string;
  sourceKind: string | null;
  openingAmount: string | null;
  coveredCount: number | null;
};
type LedgerRow = { userId: string; availableCents: string | null };

/**
 * 批量读取目录页用户的可用余额。调用方给出已授权页内的用户 ID；
 * 没有钱包读权限时全部是 denied，不返回任何金额。
 */
export async function readUserDirectoryWalletSummaries(
  client: PoolClient,
  viewer: { walletRead: boolean },
  userIds: readonly string[],
  asOfUtc = new Date().toISOString(),
): Promise<Map<string, DirectoryWalletSummary>> {
  const ids = [...new Set(userIds)];
  const summaries = new Map<string, DirectoryWalletSummary>();
  for (const id of ids) summaries.set(id, { state: "denied", permission: DIRECTORY_WALLET_PERMISSION });
  if (ids.length === 0) return summaries;
  if (!viewer.walletRead) return summaries;

  const coverage = new Map<string, CoverageRow>((await client.query<CoverageRow>(
    `SELECT c.user_id AS "userId", c.origin, b.source_kind AS "sourceKind",
       b.available_cents::text AS "openingAmount", b.covered_count AS "coveredCount"
       FROM zzsh_order.wallet_coverage c
       JOIN zzsh_order.finance_opening_basis b ON b.id=c.basis_id AND b.user_id=c.user_id
      WHERE c.user_id = ANY($1::text[])`, [ids],
  )).rows.map((row) => [row.userId, row]));
  const ledger = new Map<string, LedgerRow>((await client.query<LedgerRow>(
    `SELECT counterparty_user_id AS "userId",
       sum(credit_cents-debit_cents) FILTER (WHERE account_code IN ${DIRECTORY_WALLET_AVAILABLE_CODES})::text AS "availableCents"
     FROM zzsh_order.settlement_ledger_entry
     WHERE counterparty_user_id = ANY($1::text[])
     GROUP BY counterparty_user_id`, [ids],
  )).rows.map((row) => [row.userId, row]));

  for (const id of ids) {
    const admitted = coverage.get(id);
    if (!admitted) { summaries.set(id, { state: "unknown", reason: "SOURCE_COVERAGE_NOT_ADMITTED" }); continue; }
    if (admitted.origin === "NATIVE_GENESIS" && (admitted.sourceKind !== "NATIVE_GENESIS" || admitted.openingAmount !== "0" || admitted.coveredCount !== 0)) {
      summaries.set(id, { state: "unknown", reason: "NATIVE_ORIGIN_INCONSISTENT" });
      continue;
    }
    const raw = ledger.get(id)?.availableCents ?? "0";
    let amountCents: string;
    try { amountCents = exactCents(raw); }
    catch { summaries.set(id, { state: "unknown", reason: "LEDGER_UNREADABLE" }); continue; }
    if (BigInt(amountCents) < 0n) { summaries.set(id, { state: "unknown", reason: "LEDGER_REQUIRES_RECONCILIATION" }); continue; }
    summaries.set(id, { state: "ready", amountCents, currency: "CNY", asOfUtc });
  }
  return summaries;
}
