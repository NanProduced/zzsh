import assert from "node:assert/strict";
import test from "node:test";
import { quoteListing } from "../src/supply/publishing";
import { projectDeltaQuote } from "../src/supply/delta-rental";
import { computeContentHash } from "../src/supply/content-hash";
import { compatRule } from "./pricing-compat-fixture";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

// Synthetic SQL responses; the real quote, policy validator and snapshot writer execute.
function fixture(amount: string | null = "10000", mode: "NOT_REQUIRED" | "FIXED_CENTS" = "FIXED_CENTS") {
  const account: any = { id: "account", game_id: "game", owner_user_id: "owner", revision: "1", current_version_id: "draft", lifecycle: "ACTIVE" };
  const attributes: Record<string, unknown> = { safe_box_code: "box-a", vit_level: 6, bear_level: 6, dive_level: 0, grading_code: "4", grading_division: 3, login_method_code: "login_qq_qr", next_season_pass: false, demulan_unlocked: false, service_window_start_minute: 540, service_window_end_minute: 1380, service_window_cross_midnight: false, service_window_timezone: "Asia/Shanghai", rentalPricing: { rentalMode: "ordinary" } };
  if (amount !== null) attributes.owner_deposit_declaration = { schema: "owner-deposit-declaration-v1", amountCents: amount, declarationVersion: "fixture-v1" };
  const version: any = { id: "draft", account_id: account.id, origin: "NATIVE", review_state: "DRAFT", title: "合成测试", description: null, attributes, term_option_code: "daily-10m", pricing_option_code: "" };
  const policy = fundingPolicyFixture(mode);
  const controls = { policy: policy as unknown, policyFailure: false };
  const snapshots: any[] = [], writes: string[] = [];
  let policyReads = 0;
  const client: any = { query: async (sql: string, args: any[] = []) => {
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.startsWith("SELECT 1 FROM zzsh_order.rental_order")) return result([]);
    if (sql.includes('"game_service_operation"')) return result([{ id: "service", gameCode: "delta", gameEnabled: true, enabled: true }]);
    if (sql.startsWith("SELECT * FROM zzsh_supply.listing_version")) return result([version]);
    if (sql.startsWith('SELECT item_id AS "itemId"')) return result([{ itemId: "haff", quantity: "100000000" }]);
    if (sql.startsWith("SELECT skin_id FROM") || sql.startsWith("SELECT entitlement_id AS") || sql.startsWith("SELECT m.asset_id AS") || sql.startsWith("SELECT 1 FROM zzsh_supply.billable_item")) return result([]);
    if (sql.startsWith("SELECT r.*,g.catalog_revision")) return result([{ id: "release", catalogRevision: "1", price_version_id: "price", term_version_id: "term", agreement_version_id: "agreement", digest: "a".repeat(64), mode: "SPREAD", commission_rate: null, haff_rule: compatRule(), rounding_policy: "HALF_UP_CENT_V1" }]);
    if (sql.startsWith("SELECT code,daily_consumption")) return result([{ code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }]);
    if (sql.startsWith("SELECT l.item_id AS")) return result([{ itemId: "haff", code: "HAFF", name: "哈夫币", quantity: "100000000", unit: "HAFF_BASE", enabled: true, pricingKind: "HAFF_RATIO", unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null }]);
    if (sql.startsWith("SELECT e.id AS") || sql.startsWith("WITH RECURSIVE visible")) return result([]);
    if (sql.includes("p.funding_policy AS policy")) { policyReads++; assert.equal(args[0], "release"); if (controls.policyFailure) throw Error("POLICY_READ_FAILED"); return result([{ policy: controls.policy }]); }
    if (sql.startsWith("UPDATE zzsh_supply.listing_version SET payload=")) { assert.equal(args[0], "draft"); snapshots.push(structuredClone({ payload: args[1], hash: args[2] })); writes.push(sql); return result([]); }
    if (sql.startsWith("UPDATE zzsh_supply.rental_account SET revision=")) { writes.push(sql); return result([{ revision: String(Number(account.revision) + 1) }]); }
    throw Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  } };
  return { account, version, attributes, controls, client, snapshots, writes, policyReads: () => policyReads };
}

test("listing quote freezes tenant deposit separately from publisher guarantee and requotes only the draft", async () => {
  const f = fixture();
  await quoteListing(f.client, f.account, "1");
  const first = f.snapshots[0], before = JSON.stringify(first);
  assert.equal(first.payload.quoteValues.tenantDeposit.amount, "100.00");
  assert.equal(first.payload.quoteValues.publisherBailRequirement.amount, "30.00");
  const renter = projectDeltaQuote(first.payload.quoteValues, "public")!;
  assert.equal(renter.tenantPayableTotal?.amount, "356.41");
  assert.equal(first.hash, computeContentHash(first.payload));
  (f.attributes.owner_deposit_declaration as any).amountCents = "20000";
  await quoteListing(f.client, f.account, "2");
  assert.equal(f.snapshots[1].payload.quoteValues.tenantDeposit.amount, "200.00");
  assert.notEqual(f.snapshots[1].hash, first.hash);
  assert.equal(JSON.stringify(first), before, "previous frozen bytes remain unchanged");
});

test("listing quote preserves explicit zero and distinguishes missing declaration or policy", async () => {
  const zero = fixture("10000", "NOT_REQUIRED"); await quoteListing(zero.client, zero.account, "1");
  assert.equal(zero.snapshots[0].payload.quoteValues.tenantDeposit.amount, "100.00");
  assert.equal(zero.snapshots[0].payload.quoteValues.publisherBailRequirement.amount, "0.00");
  for (const kind of ["declaration", "policy"] as const) {
    const f = fixture(kind === "declaration" ? null : "10000"); if (kind === "policy") f.controls.policy = null;
    await quoteListing(f.client, f.account, "1");
    assert.equal(f.snapshots[0].payload.quoteValues.tenantDeposit, null);
    assert.equal(f.snapshots[0].payload.quoteValues.publisherBailRequirement, null);
    assert.equal(f.policyReads(), kind === "declaration" ? 0 : 1);
  }
});

test("invalid declaration, unavailable policy and published versions cannot write a quote", async () => {
  for (const kind of ["invalid", "unavailable", "published"] as const) {
    const f = fixture(kind === "invalid" ? "-1" : "10000");
    if (kind === "unavailable") f.controls.policyFailure = true;
    if (kind === "published") f.version.review_state = "PUBLISHED";
    await assert.rejects(quoteListing(f.client, f.account, "1"));
    assert.deepEqual(f.writes, []);
  }
});
