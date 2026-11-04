import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { applyOrderUserFacts, frozenResourceLines, LEGACY_ORDER_FACTS_SQL, NATIVE_ORDER_FACTS_SQL, projectEntitlements, readOrderUserFacts } from "../src/order/frozen-listing-read";
import { convertLegacyDisplayFields, legacyDisplayDigest } from "../src/supply/legacy-display-snapshot";

const nativeRow = { orderId: "o1", accountDisplayNo: "AC0000000001", versionId: "v1", attributes: { login_method_code: "login_qq_qr", rentalPricing: { rentalMode: "ordinary" } },
  presentationItems: [{ id: "i1", code: "df_billable_haff", name: "哈夫币", unit: "HAFF_BASE" }], presentationEntitlements: [{ id: "e1", name: "冻结名" }],
  termSeconds: "86400", disclosures: [{ entitlementId: "e1", expiresAt: "2026-11-01T00:00:00.000000Z", fullTermGuaranteed: true }, { entitlementId: "e2", expiresAt: null, fullTermGuaranteed: false }],
  resources: [{ itemId: "i1", code: "x", quantity: "100", unit: "X" }] };

test("B2 frozen SQL is party-scoped and content-hash bound; legacy uses current public version", () => {
  assert.match(NATIVE_ORDER_FACTS_SQL, /o\.owner_user_id=\$2 OR o\.renter_user_id=\$2/);
  assert.match(NATIVE_ORDER_FACTS_SQL, /v\.content_hash=o\.content_hash/);
  assert.match(LEGACY_ORDER_FACTS_SQL, /s\.owner_user_id=\$2 OR s\.renter_user_id=\$2/);
  assert.match(LEGACY_ORDER_FACTS_SQL, /listing_publication/);
  for (const sql of [NATIVE_ORDER_FACTS_SQL, LEGACY_ORDER_FACTS_SQL]) assert.doesNotMatch(sql, /旧平台|历史订单/);
});

test("B2 frozen resource names prefer presentation snapshot; duplicates fall back", () => {
  const lines = frozenResourceLines([{ id: "i1", code: "c", name: "N", unit: "U" }, { id: "i2", name: "a" }, { id: "i2", name: "b" }],
    [{ itemId: "i1", code: "x", quantity: "1", unit: "X" }, { itemId: "i2", code: "y", quantity: null, unit: "Y" }]);
  assert.deepEqual(lines, [{ itemId: "i1", code: "c", name: "N", quantity: "1", unit: "U" }, { itemId: "i2", code: "y", name: null, quantity: null, unit: "Y" }]);
});

test("B2 entitlements: frozen name, then catalog, else UNKNOWN; non-array ⇒ null", () => {
  const ents = projectEntitlements(nativeRow.disclosures, nativeRow.presentationEntitlements, new Map([["e2", { name: "目录名", expiryKind: "TIMED" as const }]]))!;
  assert.deepEqual(ents.map(e => [e.name, e.nameSource, e.expiryKind, e.fullTermGuaranteed]), [["冻结名", "ORDER_VERSION", null, true], ["目录名", "CURRENT_CATALOG", "TIMED", false]]);
  assert.equal(projectEntitlements(undefined, null, new Map()), null);
});

test("B2 page read: one query per origin + one catalog query; legacy hides versionId from renter", async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => { calls.push(sql);
    if (sql.includes("user-order-frozen-listing")) return { rows: [nativeRow] };
    if (sql.includes("user-legacy-order-current-listing")) return { rows: [{ ...nativeRow, orderId: "L1", presentationEntitlements: null, disclosures: null, termSeconds: null }] };
    return { rows: [{ id: "e2", name: "目录名", expiryKind: "TIMED" }] }; } } as unknown as PoolClient;
  const facts = await readOrderUserFacts(client, "renter", [
    { origin: "NATIVE", orderId: "o1", accountId: "a" }, { origin: "LEGACY", orderId: "L1", accountId: "a", ownerUserId: "owner" },
    { origin: "LEGACY", orderId: "L2", accountId: null }, { origin: "NATIVE", orderId: "gone", accountId: "a" }]);
  assert.equal(calls.length, 3);
  const n = facts.get("NATIVE:o1")!;
  assert.equal(n.accountDisplayNo, "AC0000000001"); assert.equal(n.listingFacts!.source, "ORDER_VERSION"); assert.equal(n.listingFacts!.versionId, "v1");
  assert.equal(n.listingFacts!.attributeDisplay.loginMethod !== undefined, true); assert.equal(n.listingFacts!.resourceLines[0]!.name, "哈夫币");
  assert.equal(n.entitlements!.length, 2);
  const l = facts.get("LEGACY:L1")!;
  assert.equal(l.listingFacts!.source, "ACCOUNT_CURRENT"); assert.equal(l.listingFacts!.versionId, null); assert.equal(l.entitlements, null); assert.equal(l.entitlementsUnknownReason, "NOT_FROZEN");
  assert.equal(facts.get("LEGACY:L2")!.listingFactsUnknownReason, "ACCOUNT_UNLINKED");
  assert.equal(facts.get("NATIVE:gone")!.listingFacts, null);
  assert.doesNotMatch(JSON.stringify([...facts.values()]), /旧平台|历史订单/);
});

for (const [orderId, termDays, haff, ammo] of [["closed-order32", "13", "130", "113"], ["inflight-order3013", "5", "144", "10"]]) test(`current imported account is bound for ${orderId} without replacing the original order`, async () => {
  const accountId = `account-${orderId}`, versionId = `observation-${orderId}`, sourceUpdatedAt = "2026-11-03T00:00:00.000Z";
  const snapshot = convertLegacyDisplayFields({ haff, awm_bullet_num: ammo, level6_bullet_num: "0", level6_helmet_num: "1", level6_armor_num: "1", barrett_bullet_num: "0", coffee_num: "3", top_insure_card_num: "0", login_way: "1", insure_lv: "2", grading_lv: "5", login_password: "PRIVATE_LOGIN" });
  const binding = { observationVersionId: versionId, baseSourceDigest: "b".repeat(64), extractSha256: "a".repeat(64), sourceUpdatedAt, evidenceRef: `legacy-display-v1:${"a".repeat(64)}:1`, snapshot };
  const historicalRow = { account_id: accountId, observation_version_id: versionId, source_status: 5, legacy_id: "1", owner_user_id: "owner", source_digest: binding.baseSourceDigest, base_updated_at: new Date(sourceUpdatedAt), snapshot: { schema: "legacy-listing-read-v1", resourceNo: null, haffRentYuan: "406.00", goodsYuan: "392.50", depositYuan: "200.00", termDays, dailyHaffBase: "10000000" }, display_account_id: accountId, display_version_id: versionId, base_source_digest: binding.baseSourceDigest, extract_sha256: binding.extractSha256, display_updated_at: new Date(sourceUpdatedAt), display_evidence_ref: binding.evidenceRef, display_snapshot: snapshot, display_digest: legacyDisplayDigest(accountId, binding) };
  let rows = [{ ...nativeRow, orderId: orderId!, accountId, currentVersionId: versionId, currentOrigin: "LEGACY_OBSERVATION", versionId: null, attributes: {}, resources: [], disclosures: null, presentationEntitlements: null, termSeconds: null }] as any[];
  let historicalReads = 0;
  const client = { query: async (sql: string) => {
    if (sql.includes("user-legacy-order-current-listing")) return { rows };
    if (sql.includes("source_status::int")) { historicalReads++; return { rows: [historicalRow] }; }
    return { rows: [] };
  } } as unknown as PoolClient;
  const inputs = [{ origin: "LEGACY" as const, orderId: orderId!, accountId, ownerUserId: "owner" }];
  const result = (await readOrderUserFacts(client, "renter", inputs)).get(`LEGACY:${orderId}`)!;
  assert.equal(result.listingFacts?.source, "LEGACY_ACCOUNT_SNAPSHOT"); assert.equal(result.listingFacts?.versionId, null, "renter does not acquire management version IDs");
  assert.equal(result.listingFacts?.sourceUpdatedAt, sourceUpdatedAt);
  assert.equal(result.listingFacts?.resourceLines.length, 8); assert.equal(result.listingFacts?.resourceLines[0]?.quantity, (BigInt(haff!) * 1000000n).toString());
  assert.equal(result.listingFacts?.resourceLines.find(item => item.code === "awm_round")?.quantity, ammo);
  assert.equal(result.listingFacts?.termSeconds, (BigInt(termDays!) * 86400n).toString()); assert.equal(result.listingFacts?.attributeDisplay.loginMethod, "QQ账密");
  assert.equal(result.entitlements, null); assert.equal(JSON.stringify(result).includes("PRIVATE_LOGIN"), false);
  const original = { orderFacts: { termSeconds: "86400", resources: [{ code: "old-order-resource", quantity: "99", unit: null }] }, amounts: { totalDue: "685.00" } };
  const order = structuredClone(original); applyOrderUserFacts(order, result);
  assert.deepEqual(order.orderFacts, original.orderFacts); assert.deepEqual(order.amounts, original.amounts);
  rows = [{ ...rows[0], currentOrigin: "NATIVE", versionId: "native-public", attributes: {}, resources: [] }]; historicalReads = 0;
  const native = (await readOrderUserFacts(client, "renter", inputs)).get(`LEGACY:${orderId}`)!;
  assert.equal(native.listingFacts?.source, "ACCOUNT_CURRENT"); assert.deepEqual(native.listingFacts?.resourceLines, []); assert.equal(historicalReads, 0, "native missing values never borrow old stock");
  rows = [{ ...rows[0], versionId: null }];
  assert.equal((await readOrderUserFacts(client, "renter", inputs)).get(`LEGACY:${orderId}`)?.listingFacts, null);
  rows = [];
  assert.equal((await readOrderUserFacts(client, "stranger", inputs)).get(`LEGACY:${orderId}`)?.listingFacts, null);
  assert.equal(historicalReads, 0, "no party-scoped row grants no historical read");
});
