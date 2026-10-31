import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";

import { readUserObligations, USER_OBLIGATION_ORDER } from "../src/auth/user-obligation-reader";

type Hit = Partial<Record<"listing" | "order" | "withdrawal" | "deposit" | "legacyDeposit" | "commission", boolean>>;
type Fixture = {
  installed?: boolean | ((relations: string[]) => boolean);
  subject?: { provider: string; covered: boolean; migrated: boolean } | null;
  totals?: Record<string, string>;
  hits?: Hit;
  throwOn?: RegExp;
};
const ZERO = { available: "0", reserved: "0", pending: "0", refund: "0" };

function client(f: Fixture) {
  const seen: string[] = [];
  const rows = (ok: boolean) => ({ rows: ok ? [{ "?column?": 1 }] : [], rowCount: ok ? 1 : 0 });
  const fake = {
    async query(sql: string, params: unknown[]) {
      seen.push(sql);
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/i, "obligation reads must stay read-only");
      if (f.throwOn?.test(sql)) throw new Error("relation unreadable");
      if (sql.includes("to_regclass")) {
        const ok = typeof f.installed === "function" ? f.installed(params[0] as string[]) : f.installed ?? true;
        return { rows: [{ ok }], rowCount: 1 };
      }
      if (sql.includes("listing_version")) return rows(Boolean(f.hits?.listing));
      if (sql.includes("rental_order")) return rows(Boolean(f.hits?.order));
      if (sql.includes("user_identity_state")) {
        const subject = f.subject === undefined ? { provider: "none", covered: false, migrated: false } : f.subject;
        return { rows: subject ? [subject] : [], rowCount: subject ? 1 : 0 };
      }
      if (sql.includes("settlement_ledger_entry")) return { rows: [f.totals ?? ZERO], rowCount: 1 };
      if (sql.includes("withdrawal_intent")) return rows(Boolean(f.hits?.withdrawal));
      if (sql.includes("legacy_owner_guarantee_observation")) return rows(Boolean(f.hits?.legacyDeposit));
      if (sql.includes("owner_guarantee_requirement")) return rows(Boolean(f.hits?.deposit));
      if (sql.includes("rental_referral_earning")) return rows(Boolean(f.hits?.commission));
      throw new Error(`unexpected query ${sql}`);
    },
  };
  return { client: fake as unknown as PoolClient, seen };
}

test("native user with no obligations can cancel", async () => {
  const { client: c, seen } = client({});
  assert.equal(await readUserObligations("user_a", c), "NONE");
  assert.ok(seen.some((sql) => sql.includes("rental_referral_earning")), "all six sources were read");
  assert.deepEqual(USER_OBLIGATION_ORDER, ["LISTING", "ORDER", "WALLET_BALANCE", "WITHDRAWAL", "DEPOSIT", "COMMISSION"]);
});

test("each pending obligation is reported with its own kind", async () => {
  const cases = [
    [{ hits: { listing: true } }, "LISTING"],
    [{ hits: { order: true } }, "ORDER"],
    [{ totals: { ...ZERO, available: "1" } }, "WALLET_BALANCE"],
    [{ totals: { ...ZERO, reserved: "500" } }, "WALLET_BALANCE"],
    [{ totals: { ...ZERO, pending: "3" } }, "WALLET_BALANCE"],
    [{ totals: { ...ZERO, refund: "7" } }, "WALLET_BALANCE"],
    [{ hits: { withdrawal: true } }, "WITHDRAWAL"],
    [{ hits: { deposit: true } }, "DEPOSIT"],
    [{ hits: { commission: true } }, "COMMISSION"],
  ] as const;
  for (const [fixture, obligation] of cases) {
    assert.deepEqual(await readUserObligations("user_a", client(fixture as Fixture).client), { status: "PENDING", obligation });
  }
});

test("unknown or unreadable sources fail closed", async () => {
  assert.deepEqual(await readUserObligations("u", client({ installed: false }).client), { status: "UNKNOWN", obligation: "LISTING", reason: "SOURCE_NOT_INSTALLED" });
  assert.deepEqual(
    await readUserObligations("u", client({ installed: (r) => !r.includes("zzsh_order.joinpay_withdrawal_intent") }).client),
    { status: "UNKNOWN", obligation: "WITHDRAWAL", reason: "SOURCE_NOT_INSTALLED" },
  );
  assert.deepEqual(await readUserObligations("u", client({ throwOn: /owner_guarantee_requirement/ }).client), { status: "UNKNOWN", obligation: "DEPOSIT", reason: "SOURCE_UNREADABLE" });
  assert.deepEqual(await readUserObligations("u", client({ throwOn: /rental_referral_earning/ }).client), { status: "UNKNOWN", obligation: "COMMISSION", reason: "SOURCE_UNREADABLE" });
  assert.deepEqual(await readUserObligations("u", client({ subject: null }).client), { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: "IDENTITY_STATE_MISSING" });
  assert.deepEqual(await readUserObligations("u", client({ totals: { ...ZERO, available: "-1" } }).client), { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: "LEDGER_NEGATIVE" });
  assert.deepEqual(await readUserObligations("u", client({ totals: { ...ZERO, pending: "x" } }).client), { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: "LEDGER_UNREADABLE" });
  assert.deepEqual(await readUserObligations("u", client({ hits: { legacyDeposit: true } }).client), { status: "UNKNOWN", obligation: "DEPOSIT", reason: "LEGACY_GUARANTEE_UNRESOLVED" });
});

test("legacy users without admitted opening balance are refused; covered legacy users use the ledger", async () => {
  const legacy = { provider: "legacy_mysql_restore", covered: false, migrated: true };
  assert.deepEqual(await readUserObligations("u", client({ subject: legacy }).client), { status: "UNKNOWN", obligation: "WALLET_BALANCE", reason: "LEGACY_OPENING_NOT_ADMITTED" });
  // provider also stores the real-name provider after verification; only the explicit legacy
  // marker plus a migration fact identify an old-platform subject without admitted coverage.
  assert.equal(await readUserObligations("u", client({ subject: { provider: "other", covered: false, migrated: false } }).client), "NONE");
  assert.equal(await readUserObligations("u", client({ subject: { ...legacy, covered: true } }).client), "NONE");
  assert.deepEqual(await readUserObligations("u", client({ subject: { ...legacy, covered: true }, totals: { ...ZERO, available: "100" } }).client), { status: "PENDING", obligation: "WALLET_BALANCE" });
});
