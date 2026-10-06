import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(testDirectory, "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const { Window } = requireFromTree("happy-dom");
const window = new Window({ url: "http://127.0.0.1/accounts" });
globalThis.window = window;
const intents = requireFromTree(path.join(tree, "apps/web/src/lib/order-intents.ts"));

test("an intent is persisted per user, action and resource and reloads exactly", () => {
  const saved = intents.saveIntent({ userId: "user_A", kind: "order.create.v2", resourceId: "account_1", key: "key_1", body: {}, token: "token_1", context: { payable: "470.00" } });
  assert.equal(saved.persisted, true);
  const loaded = intents.loadIntent("user_A", "order.create.v2", "account_1");
  assert.equal(loaded.key, "key_1");
  assert.equal(loaded.token, "token_1");
  assert.equal(loaded.context.payable, "470.00");
  assert.equal(loaded.version, 1);
});

test("another identity can never load or reuse the intent", () => {
  intents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_1", key: "key_2", body: {} });
  assert.equal(intents.loadIntent("user_B", "order.payment", "order_1"), null);
  assert.notEqual(intents.loadIntent("user_A", "order.payment", "order_1"), null);
});

test("saving again preserves the original key and creation time", async () => {
  const first = intents.saveIntent({ userId: "user_A", kind: "order.cancel", resourceId: "order_2", key: "key_3", body: {} }).intent;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = intents.saveIntent({ userId: "user_A", kind: "order.cancel", resourceId: "order_2", key: "key_3", body: {} }).intent;
  assert.equal(second.key, "key_3");
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
});

test("receipts are frozen on the intent and a different resource is a different slot", () => {
  intents.saveIntent({ userId: "user_A", kind: "settlement.submit", resourceId: "order_3", key: "key_4", body: { lines: [] } });
  intents.recordIntentReceipt("user_A", "settlement.submit", "order_3", { status: 200, body: { ok: true } });
  assert.deepEqual(intents.loadIntent("user_A", "settlement.submit", "order_3").receipt, { status: 200, body: { ok: true } });
  assert.equal(intents.loadIntent("user_A", "settlement.submit", "order_4"), null);
  intents.clearIntent("user_A", "settlement.submit", "order_3");
  assert.equal(intents.loadIntent("user_A", "settlement.submit", "order_3"), null);
});

test("age never deletes an unresolved intent; it only disables automatic replay", () => {
  intents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_5", key: "key_5", body: { frozen: true } });
  const storageKey = "zzsh.order-intent.v1:user_A:order.payment:order_5";
  const stored = JSON.parse(window.sessionStorage.getItem(storageKey));
  stored.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
  const loaded = intents.loadIntent("user_A", "order.payment", "order_5");
  assert.ok(loaded, "the unresolved responsibility must remain loadable");
  assert.equal(loaded.key, "key_5");
  assert.deepEqual(loaded.body, { frozen: true });
  assert.equal(intents.isIntentStale(loaded), true);
  assert.equal(intents.isIntentStale(intents.loadIntent("user_A", "order.cancel", "order_2")), false);
});

test("storage failure is reported instead of pretending the intent is recoverable", () => {
  const realWindow = globalThis.window;
  globalThis.window = { sessionStorage: { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} } };
  try {
    const saved = intents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_6", key: "key_6", body: {} });
    assert.equal(saved.persisted, false);
    assert.equal(intents.loadIntent("user_A", "order.payment", "order_6"), null);
  } finally {
    globalThis.window = realWindow;
  }
});
