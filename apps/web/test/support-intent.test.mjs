import assert from "node:assert/strict";
import { test } from "node:test";
import { supportSubjectRefFromUrl, clearSupportIntent, consumeSupportIntent, parseSupportIntent, readSupportIntent, saveSupportIntent, SUPPORT_INTENT_STORAGE_KEY } from "../src/lib/support-intent.ts";

function storage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("support intent survives login only for a short-lived same-site target", () => {
  const store = storage();
  saveSupportIntent({ type: "COMPLAINT", source: "/listing/listing_1?view=detail" }, store, 1_000);
  const intent = readSupportIntent(store, 1_001);
  assert.deepEqual(intent, { type: "COMPLAINT", source: "/listing/listing_1?view=detail", createdAt: 1_000 });
  assert.deepEqual(consumeSupportIntent(store, 1_002), intent);
  assert.equal(readSupportIntent(store, 1_002), null);
});

test("a complaint entry intent survives storage so the API can choose the correct welcome", () => {
  const store = storage();
  // Before the merge, complaint entries stored type=COMPLAINT; those intents must still
  // recover as ordinary support instead of being dropped or creating a second thread.
  store.setItem(SUPPORT_INTENT_STORAGE_KEY, JSON.stringify({ type: "COMPLAINT", source: "/help/rental-getting-started", createdAt: 1_000 }));
  assert.deepEqual(readSupportIntent(store, 1_001), { type: "COMPLAINT", source: "/help/rental-getting-started", createdAt: 1_000 });
  assert.deepEqual(parseSupportIntent({ type: "COMPLAINT", source: "/help", createdAt: 1_000 }, 1_001), { type: "COMPLAINT", source: "/help", createdAt: 1_000 });
});

test("support intent rejects external, malformed, future, and expired values", () => {
  assert.equal(parseSupportIntent({ type: "SERVICE", source: "https://evil.invalid", createdAt: 1_000 }, 1_000), null);
  assert.equal(parseSupportIntent({ type: "UNKNOWN", source: "/support", createdAt: 1_000 }, 1_000), null);
  assert.equal(parseSupportIntent({ type: "SERVICE", source: "/support", createdAt: 31_001 }, 1_000), null);
  assert.equal(parseSupportIntent({ type: "SERVICE", source: "/support", createdAt: 1_000 }, 601_001), null);
});

test("keeps a failed recovery intent and clears only the matching completed intent", () => {
  const store = storage();
  saveSupportIntent({ type: "SERVICE", source: "/support" }, store, 2_000);
  const intent = readSupportIntent(store, 2_001);
  assert.ok(intent);
  clearSupportIntent({ ...intent, createdAt: intent.createdAt + 1 }, store, 2_001);
  assert.ok(readSupportIntent(store, 2_001));
  clearSupportIntent(intent, store, 2_001);
  assert.equal(readSupportIntent(store, 2_001), null);
});

test("support entry carries the explicit order/account reference and ignores invalid context",()=>{
  assert.equal(supportSubjectRefFromUrl("https://example.test/account?view=rental-detail&orderId=order_1&accountId=ac_1"),"order:order_1");
  assert.equal(supportSubjectRefFromUrl("https://example.test/accounts/ac_1"),"account:ac_1");
  assert.equal(supportSubjectRefFromUrl("https://example.test/?listingId=listing_1"),"listing:listing_1");
  assert.equal(supportSubjectRefFromUrl("https://example.test/?orderId=bad%20id"),null);
  assert.equal(supportSubjectRefFromUrl("invalid"),null);
});
