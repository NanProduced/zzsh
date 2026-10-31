import type { PoolClient } from "pg";

/** 注销前置欠款/在途检查的单项分类；每一项都有独立的拒绝码。 */
export type UserObligationKind = "LISTING" | "ORDER" | "WALLET_BALANCE" | "WITHDRAWAL" | "DEPOSIT" | "COMMISSION";
export type UserObligationFinding = { status: "PENDING" | "UNKNOWN"; obligation: UserObligationKind; reason?: string };

const LEGACY_PROVIDER = "legacy_mysql_restore";
const LEGACY_MIGRATION_ACTION = "user.legacy_owner.migrated";
const REQUIRED_RELATIONS = {
  LISTING: ["zzsh_supply.rental_account", "zzsh_supply.listing_version"],
  ORDER: ["zzsh_order.rental_order"],
  WALLET_BALANCE: ["zzsh_order.wallet_coverage", "zzsh_order.settlement_ledger_entry", "zzsh_iam.user_identity_state", "zzsh_iam.audit_event"],
  WITHDRAWAL: ["zzsh_order.withdrawal_intent", "zzsh_order.joinpay_withdrawal_intent"],
  DEPOSIT: ["zzsh_order.owner_guarantee_requirement", "zzsh_order.owner_guarantee_payment", "zzsh_order.owner_guarantee_refund", "zzsh_order.legacy_owner_guarantee_observation"],
  COMMISSION: ["zzsh_order.rental_referral_earning"],
} as const satisfies Record<UserObligationKind, readonly string[]>;

async function installed(client: PoolClient, relations: readonly string[]): Promise<boolean> {
  const row = (await client.query("SELECT bool_and(to_regclass(r) IS NOT NULL) AS ok FROM unnest($1::text[]) AS r", [relations])).rows[0];
  return row?.ok === true;
}
async function exists(client: PoolClient, sql: string, userId: string): Promise<boolean> {
  return Boolean((await client.query(sql, [userId])).rowCount);
}
const CENTS = /^-?(0|[1-9]\d{0,30})$/;

/** 返回 null 表示该项已确认无欠款/在途；任何无法确认的情况都返回 UNKNOWN（fail closed）。 */
const CHECKS: Record<UserObligationKind, (client: PoolClient, userId: string) => Promise<UserObligationFinding | null>> = {
  async LISTING(client, userId) {
    return (await exists(client, "SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id WHERE a.owner_user_id=$1 AND v.review_state IN ('SUBMITTED','APPROVED','PUBLISHED') LIMIT 1", userId))
      ? { status: "PENDING", obligation: "LISTING" } : null;
  },
  async ORDER(client, userId) {
    return (await exists(client, "SELECT 1 FROM zzsh_order.rental_order WHERE status IN ('PENDING_PAYMENT','PAID') AND (renter_user_id=$1 OR owner_user_id=$1) LIMIT 1", userId))
      ? { status: "PENDING", obligation: "ORDER" } : null;
  },
  async WALLET_BALANCE(client, userId) {
    const subject = (await client.query(
      `SELECT s.provider,
              EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage c WHERE c.user_id=$1) AS covered,
              EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=$1 AND a.action=$2 AND a.outcome='SUCCESS') AS migrated
         FROM zzsh_iam.user_identity_state s WHERE s.user_id=$1`, [userId, LEGACY_MIGRATION_ACTION])).rows[0];
    if (!subject) return { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: "IDENTITY_STATE_MISSING" };
    // provider also stores the real-name provider after verification, so only the explicit
    // legacy marker identifies an old-platform subject; no migration fact means native.
    const native = typeof subject.provider === "string" && subject.provider.length > 0 && subject.provider !== LEGACY_PROVIDER && subject.migrated === false;
    // 旧系统迁移用户在期初余额准入（wallet_coverage）之前，没有可信余额来源：拒绝。
    if (subject.covered !== true && !native) {
      return { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: subject.provider === LEGACY_PROVIDER || subject.migrated ? "LEGACY_OPENING_NOT_ADMITTED" : "SOURCE_UNKNOWN" };
    }
    const totals = (await client.query(
      `SELECT COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE')),0)::text AS available,
              COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_RESERVED'),0)::text AS reserved,
              COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_PENDING_EARNINGS'),0)::text AS pending,
              COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='RENTER_REFUND_PAYABLE'),0)::text AS refund
         FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1`, [userId])).rows[0];
    const values = [totals?.available, totals?.reserved, totals?.pending, totals?.refund];
    if (!values.every((value) => typeof value === "string" && CENTS.test(value))) return { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: "LEDGER_UNREADABLE" };
    if (values.some((value) => BigInt(value) < 0n)) return { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: "LEDGER_NEGATIVE" };
    return values.some((value) => BigInt(value) !== 0n) ? { status: "PENDING", obligation: "WALLET_BALANCE" } : null;
  },
  async WITHDRAWAL(client, userId) {
    return (await exists(client,
      `SELECT 1 FROM zzsh_order.withdrawal_intent WHERE user_id=$1 AND state NOT IN ('SUCCEEDED','FAILED')
       UNION ALL SELECT 1 FROM zzsh_order.joinpay_withdrawal_intent WHERE user_id=$1 AND state NOT IN ('SUCCEEDED','FAILED') LIMIT 1`, userId))
      ? { status: "PENDING", obligation: "WITHDRAWAL" } : null;
  },
  async DEPOSIT(client, userId) {
    if (await exists(client,
      `SELECT 1 FROM zzsh_order.owner_guarantee_requirement WHERE owner_user_id=$1 AND status IN ('COVERED','REFUND_REQUESTED','REFUND_PROCESSING','RESTRICTED')
       UNION ALL SELECT 1 FROM zzsh_order.owner_guarantee_payment WHERE owner_user_id=$1 AND status IN ('REQUESTED','ACCEPTED','PROCESSING','UNKNOWN')
       UNION ALL SELECT 1 FROM zzsh_order.owner_guarantee_refund WHERE owner_user_id=$1 AND status IN ('REQUESTED','PROCESSING','UNKNOWN') LIMIT 1`, userId)) {
      return { status: "PENDING", obligation: "DEPOSIT" };
    }
    // 旧系统保证金只有观测记录、没有可判定的退还状态：存在即无法确认。
    return (await exists(client, "SELECT 1 FROM zzsh_order.legacy_owner_guarantee_observation WHERE user_id=$1 LIMIT 1", userId))
      ? { status: "UNKNOWN", obligation: "DEPOSIT", reason: "LEGACY_GUARANTEE_UNRESOLVED" } : null;
  },
  async COMMISSION(client, userId) {
    return (await exists(client, "SELECT 1 FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=$1 AND state IN ('PENDING','RECOVERY_REQUIRED') LIMIT 1", userId))
      ? { status: "PENDING", obligation: "COMMISSION" } : null;
  },
};
export const USER_OBLIGATION_ORDER = Object.keys(CHECKS) as UserObligationKind[];

/** 生产注销检查：在注销事务内只读执行。缺表、查询异常、来源不明一律 UNKNOWN（拒绝注销）。 */
export async function readUserObligations(userId: string, client: PoolClient): Promise<"NONE" | UserObligationFinding> {
  for (const obligation of USER_OBLIGATION_ORDER) {
    try {
      if (!(await installed(client, REQUIRED_RELATIONS[obligation]))) return { status: "UNKNOWN", obligation, reason: "SOURCE_NOT_INSTALLED" };
      const finding = await CHECKS[obligation](client, userId);
      if (finding) return finding;
    } catch {
      return { status: "UNKNOWN", obligation, reason: "SOURCE_UNREADABLE" };
    }
  }
  return "NONE";
}
