import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { decodeOwnerAccountCursor, encodeOwnerAccountCursor, listOwnerAccounts, parseOwnerAccountQuery, projectOwnerAccount, OWNER_ACCOUNT_LIST_SQL, RENTAL_STATE_SQL } from "../src/supply/owner-account-list";

const key = { keyId: "k1", secret: "x".repeat(40) };
const haffItem = { id: "it-haff", code: "df_billable_haff", name: "哈夫币", unit: "HAFF_BASE" };
const base = {
  id: "acc-1", display_no: "AC0000000001", game_id: "g", revision: "3", owner_paused: false, staff_restricted: false,
  version_id: "v1", title: "t", review_state: "PUBLISHED", sequence: "2", owner_name: "o", game_name: "三角洲",
  payload: { schemaVersion: 2, declaration: { attributes: { safe_box_code: "unknown_code", grading_code: "zz", character_level: 30, vit_level: 5, bear_level: 6, rentalPricing: { rentalMode: "fast" } }, inventory: [{ itemId: "it-haff", quantity: "50000000" }] }, quoteValues: { ownerTotal: { currency: "CNY", unit: "yuan", amount: "88.00", scale: 2 } } },
  presentation_items: [haffItem], rule_current: true,
  ao_id: null, ao_display_no: null, ao_status: null, ao_renter_name: null, ao_term_seconds: null, ao_started_at: null, ao_deadline_at: null, ao_owner_amount: null,
  rental_state: "LISTED",
};

test("B1 query parsing validates rentalState and cursor/after exclusivity", () => {
  assert.deepEqual(parseOwnerAccountQuery(new URLSearchParams()), { limit: 20, after: "", cursor: null, rentalState: null });
  assert.equal(parseOwnerAccountQuery(new URLSearchParams("rentalState=RENTED")).rentalState, "RENTED");
  for (const q of ["rentalState=X", "rentalState=RENTED&rentalState=LISTED", "limit=0", "limit=101", "cursor=a&after=b"])
    assert.throws(() => parseOwnerAccountQuery(new URLSearchParams(q)), Error, q);
});

test("B1 rentalState precedence lives in SQL and filters server-side", () => {
  const order = ["'RENTED'", "'RESTRICTED'", "'PAUSED'", "'UNKNOWN'", "'REVIEWING'", "'REJECTED'", "'DRAFT'"].map(s => RENTAL_STATE_SQL.indexOf(s));
  for (let i = 1; i < order.length; i++) assert.ok(order[i]! > order[i - 1]!, "precedence");
  assert.match(OWNER_ACCOUNT_LIST_SQL, /t\.rental_state=\$3/);
  assert.match(OWNER_ACCOUNT_LIST_SQL, /a\.owner_user_id=\$1/);
  assert.match(OWNER_ACCOUNT_LIST_SQL, /o\.owner_user_id=a\.owner_user_id/);
  assert.match(OWNER_ACCOUNT_LIST_SQL, /l\.owner_user_id=\$1 AND l\.owner_user_id=a\.owner_user_id/);
  assert.match(OWNER_ACCOUNT_LIST_SQL, /count\(\*\)=1 AND bool_and\(bound\)/);
  assert.match(OWNER_ACCOUNT_LIST_SQL, /LEFT JOIN LATERAL/);
  // AT TIME ZONE must bind to the timestamp sum, not the interval inside make_interval.
  assert.match(OWNER_ACCOUNT_LIST_SQL, /LEFT JOIN zzsh_order\.rental_opening opening ON opening\.order_id=ao\.id AND opening\.status='CONFIRMED'/);
  assert.match(OWNER_ACCOUNT_LIST_SQL, /opening\.confirmed_at AT TIME ZONE 'UTC'/);
  assert.match(OWNER_ACCOUNT_LIST_SQL, /\(opening\.confirmed_at \+ make_interval\(secs => ao\.term_seconds\)\) AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(OWNER_ACCOUNT_LIST_SQL, /ao\.paid_at/);
});

test("B1 projection: titleFacts, available, blockers; unquoted owner total is null not 0", () => {
  const listed = projectOwnerAccount({ ...base } as any) as any;
  assert.equal(listed.available, true); assert.deepEqual(listed.blockers, []);
  assert.equal(listed.accountDisplay.displayNo, "AC0000000001");
  assert.equal(listed.accountDisplay.titleFacts.haffBase, "50000000");
  assert.equal(listed.accountDisplay.titleFacts.level, 30);
  assert.equal(listed.accountDisplay.titleFacts.rentalMode, "fast");
  assert.equal(listed.accountDisplay.titleFacts.ownerQuoteTotal.amount, "88.00");
  assert.equal(listed.activeOrder, null); assert.equal("payload" in listed, false); assert.equal("ao_id" in listed, false);
  const unquoted = projectOwnerAccount({ ...base, payload: { ...base.payload, quoteValues: undefined }, rule_current: false } as any) as any;
  assert.equal(unquoted.accountDisplay.titleFacts.ownerQuoteTotal, null);
  assert.equal(unquoted.accountDisplay.unknownReason, "NOT_QUOTED");
  assert.equal(unquoted.available, false); assert.deepEqual(unquoted.blockers, ["RULE_CHANGED"]);
  const noVersion = projectOwnerAccount({ ...base, version_id: null, payload: null, rental_state: "UNKNOWN" } as any) as any;
  assert.equal(noVersion.accountDisplay.titleFacts, null); assert.equal(noVersion.accountDisplay.unknownReason, "VERSION_MISSING");
  assert.deepEqual(noVersion.blockers, ["STATE_UNKNOWN"]);
  const rented = projectOwnerAccount({ ...base, rental_state: "RENTED", ao_id: "o1", ao_display_no: "R1", ao_status: "PAID", ao_renter_name: "r", ao_term_seconds: "86400", ao_started_at: "2026-10-28T00:00:00.000000Z", ao_deadline_at: "2026-10-29T00:00:00.000000Z", ao_owner_amount: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 } } as any) as any;
  assert.equal(rented.activeOrder.id, "o1"); assert.equal(rented.activeOrder.ownerAmount.amount, "10.00");
  assert.equal(rented.activeOrder.startedAt, "2026-10-28T00:00:00.000000Z");
  assert.equal(rented.activeOrder.rentalDeadlineAt, "2026-10-29T00:00:00.000000Z");
  assert.equal(rented.available, false); assert.deepEqual(rented.blockers, ["RENTED"]);
  const notStarted = projectOwnerAccount({ ...base, rental_state: "RENTED", ao_id: "o2", ao_display_no: "R2", ao_status: "PAID", ao_term_seconds: "14515200", ao_owner_amount: rented.activeOrder.ownerAmount } as any) as any;
  assert.equal(notStarted.rentalState, "RENTED"); assert.equal(notStarted.available, false);
  assert.deepEqual(notStarted.blockers, ["RENTED"]);
  assert.equal(notStarted.activeOrder.termSeconds, "14515200");
  assert.equal(notStarted.activeOrder.startedAt, null); assert.equal(notStarted.activeOrder.rentalDeadlineAt, null);
  assert.deepEqual(notStarted.activeOrder.ownerAmount, rented.activeOrder.ownerAmount);
  const occupied=projectOwnerAccount({...base,rental_state:"RENTED",ao_id:"legacy-order",ao_display_no:"ORIGINAL-SN",ao_origin:"LEGACY",ao_status:"PAID",ao_legacy_deadline:"1793491200"} as any);
  assert.equal(occupied.activeOrder?.displayNo,"ORIGINAL-SN");assert.equal(occupied.activeOrder?.origin,"LEGACY");
  assert.equal(occupied.activeOrder?.rentalDeadlineAt,"2026-11-01T00:00:00.000Z");assert.equal(occupied.activeOrder?.renterName,null);
  assert.equal(projectOwnerAccount({...base,legacy_market:true} as any).available,false);
});

test("B1 signed cursor binds owner and filter; LIMIT n+1 without N+1 queries", async () => {
  const token = encodeOwnerAccountCursor("acc-2", "u1", "LISTED", key);
  assert.equal(decodeOwnerAccountCursor(token, "u1", "LISTED", key), "acc-2");
  assert.throws(() => decodeOwnerAccountCursor(token, "u2", "LISTED", key), (e: any) => e.status === 409);
  assert.throws(() => decodeOwnerAccountCursor(token, "u1", null, key), (e: any) => e.status === 409);
  assert.throws(() => decodeOwnerAccountCursor(token.slice(0, -2) + "AA", "u1", "LISTED", key), (e: any) => e.status === 400);
  assert.throws(() => decodeOwnerAccountCursor(token, "u1", "LISTED", undefined), (e: any) => e.status === 503);
  let calls = 0, params: unknown[] = [];
  const client = { query: async (sql: string, p: unknown[]) => { calls++; if(sql.includes('to_regclass'))return {rows:[{ready:false}]}; if(sql.includes('legacy-market-account-ids'))return {rows:[]};
    assert.doesNotMatch(sql,/legacy_continuation_version|legacy_inflight_register/);assert.match(sql,/l\.source_order_status IN\(3,8,9\)/);
    params = p; return { rows: [{ ...base, id: "a1" }, { ...base, id: "a2" }, { ...base, id: "a3" }] }; } } as unknown as PoolClient;
  const r = await listOwnerAccounts(client, "u1", { limit: 2, after: "", cursor: token, rentalState: "LISTED" }, key);
  assert.equal(calls, 3); assert.deepEqual(params, ["u1", "acc-2", "LISTED", 3, []]);
  assert.equal(r.page.length, 2); assert.equal(r.hasMore, true); assert.equal(r.last, "a2");
  assert.equal(decodeOwnerAccountCursor(r.nextPageCursor!, "u1", "LISTED", key), "a2");
  const noKey = await listOwnerAccounts(client, "u1", { limit: 2, after: "", cursor: null, rentalState: null }, undefined);
  assert.equal(noKey.nextPageCursor, null); assert.equal(noKey.last, "a2");
});
