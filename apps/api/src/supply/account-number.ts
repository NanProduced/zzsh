import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { conflict, invalid, notFound } from "./supply-util";

/** Internal aliases stay exact text, including legacy leading zeroes. */
export function parseAccountNumber(value: unknown): string {
  if (typeof value !== "string") throw invalid("账号编号格式无效", "number");
  const number = value.trim();
  if (!number || number.length > 128 || /[\u0000-\u001f\u007f]/.test(number))
    throw invalid("账号编号格式无效", "number");
  return number;
}

// SQL uses this lexical guard; ZZ dates/counters are additionally checked at the write boundary.
export const PUBLIC_ACCOUNT_NUMBER_PATTERN = "^(AC[0-9]{10,}|ZZ[0-9]{14})$";

function datedAccountNumber(value: unknown): string | null {
  if (typeof value !== "string" || !/^ZZ[0-9]{14}$/.test(value)) return null;
  const year = value.slice(2, 6), month = value.slice(6, 8), day = value.slice(8, 10);
  if (year === "0000" || month < "01" || month > "12" || day < "01" || value.slice(10) === "000000") return null;
  const y = BigInt(year), leap = y % 4n === 0n && (y % 100n !== 0n || y % 400n === 0n);
  const lastDay = month === "02" ? leap ? "29" : "28" : ["04", "06", "09", "11"].includes(month) ? "30" : "31";
  return day <= lastDay ? value : null;
}

/** Existing AC canonical numbers remain readable; new assignments are dated ZZ only. */
export function publicAccountNumber(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128 && /^AC[0-9]{10,}$/.test(value) ? value : datedAccountNumber(value);
}
export function parsePublicAccountNumber(value: unknown): string {
  const number = publicAccountNumber(parseAccountNumber(value));
  if (!number) throw invalid("请输入新平台账号编号", "number");
  return number;
}

// The immutable snapshot/map is already the durable old-number alias. Do not
// duplicate it in a mutable alias table or accept a caller-declared old number.
const LEGACY_NUMBER_JOIN = `LEFT JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=a.id
 LEFT JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id AND m.version_id=h.observation_version_id
  AND m.source_system=h.source_system AND m.source_entity=h.source_entity AND m.legacy_id=h.legacy_id AND m.source_digest=h.source_digest`;

type NumberRow = { id: string; display_no: string | null; legacyNumber: string | null; sourceMapped: boolean };
async function numberHasOtherTarget(client: PoolClient, number: string, accountId: string): Promise<boolean> {
  return Boolean((await client.query(
    `SELECT 1 FROM zzsh_supply.rental_account a WHERE a.id<>$2 AND a.display_no=$1 LIMIT 1`, [number, accountId],
  )).rowCount);
}

/** Caller owns the existing user/game/account transaction; this never opens one. */
export async function assignAccountNumber(client: PoolClient, accountId: string): Promise<string> {
  const account = (await client.query<{ id: string; display_no: string | null }>(
    `SELECT id,display_no FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`, [accountId],
  )).rows[0];
  if (!account) throw notFound();
  if (account.display_no !== null) {
    if (publicAccountNumber(account.display_no) !== account.display_no) throw conflict("账号编号来源待核定");
    return account.display_no;
  }
  const ready = (await client.query<{ ready: boolean }>(
    `SELECT to_regprocedure('zzsh_supply.next_dated_account_display_no()') IS NOT NULL
       AND to_regclass('zzsh_supply.account_display_no_counter') IS NOT NULL AS ready`,
  )).rows[0]?.ready;
  if (!ready) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "账号编号能力尚未装配");
  let number: string | undefined;
  try {
    number = (await client.query<{ number: string }>(`SELECT zzsh_supply.next_dated_account_display_no() AS number`)).rows[0]?.number;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "54000" && (error as Error).message === "ACCOUNT_NUMBER_DAY_EXHAUSTED")
      throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "今日账号编号暂不可分配");
    throw error;
  }
  if (!number || datedAccountNumber(number) !== number) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "账号编号暂不可分配");
  if (await numberHasOtherTarget(client, number, accountId)) throw conflict("账号编号暂无法唯一核定");
  try {
    const changed = await client.query(`UPDATE zzsh_supply.rental_account SET display_no=$2 WHERE id=$1 AND display_no IS NULL`, [accountId, number]);
    if (changed.rowCount !== 1) throw conflict("账号编号来源待核定");
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw conflict("账号编号暂无法唯一核定");
    throw error;
  }
  return number;
}

/** Internal callers may resolve old aliases; public lookup explicitly disables them. Neither grants visibility. */
export async function accountNumberCandidates(client: PoolClient, number: string, gameId: string | null, includeLegacyAlias = true): Promise<string[]> {
  const rows = (await client.query<{ id: string }>(
    `SELECT DISTINCT a.id FROM zzsh_supply.rental_account a ${includeLegacyAlias ? LEGACY_NUMBER_JOIN : ""}
     WHERE ($2::text IS NULL OR a.game_id=$2) AND (a.display_no=$1${includeLegacyAlias ? " OR (m.account_id IS NOT NULL AND h.snapshot->>'resourceNo'=$1)" : ""})
     ORDER BY a.id LIMIT 51`, [includeLegacyAlias ? parseAccountNumber(number) : parsePublicAccountNumber(number), gameId],
  )).rows;
  if (rows.length > 50) throw conflict("账号编号暂无法唯一核定");
  return rows.map(row => row.id);
}

/** Native preparation only; legacy allocation additionally needs the reviewed public-admission batch. */
export async function prepareAccountNumberBackfill(client: PoolClient, afterId: string | null = null, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid("批次大小无效");
  const rows = (await client.query<NumberRow>(
    `SELECT a.id,a.display_no,CASE WHEN m.account_id IS NOT NULL THEN h.snapshot->>'resourceNo' END AS "legacyNumber",
     EXISTS(SELECT 1 FROM zzsh_supply.legacy_supply_map x WHERE x.account_id=a.id) AS "sourceMapped"
     FROM zzsh_supply.rental_account a ${LEGACY_NUMBER_JOIN}
     WHERE ($1::text IS NULL OR a.id>$1) AND EXISTS(SELECT 1 FROM zzsh_supply.listing_version v WHERE v.account_id=a.id AND v.origin='NATIVE')
     ORDER BY a.id LIMIT $2`, [afterId, limit],
  )).rows;
  const items = [];
  for (const row of rows) {
    const proposed = publicAccountNumber(row.display_no);
    const duplicate = proposed === null ? false : await numberHasOtherTarget(client, proposed, row.id);
    items.push({ accountId: row.id, existingNumber: row.display_no, legacyNumber: row.legacyNumber,
      action: row.display_no !== null && !proposed ? "REVIEW_CANONICAL" : duplicate ? "REVIEW_CONFLICT" : proposed ? "KEEP_EXISTING" : row.sourceMapped ? "PUBLIC_ADMISSION_REQUIRED" : "ALLOCATE_NATIVE",
      writeAllowed: false as const });
  }
  return { items, nextAfterId: rows.length === limit ? rows.at(-1)!.id : null, writeAllowed: false as const };
}
