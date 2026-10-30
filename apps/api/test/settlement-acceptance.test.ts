import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

import { requiresEarlySettlementAcceptance } from "../src/order/settlement-record";
import { newEarlySettlementDisclosure, readEarlySettlementDisclosure } from "../src/legal/legal-documents";
import { handleSettlementUserRoute } from "../src/order/settlement-routes";

test("only orders that froze the new disclosure require early-settlement acceptance", () => {
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "ORDER_CONFIRMATION", agreementAcceptanceSchema: 1, earlySettlementDisclosure: newEarlySettlementDisclosure() } }), true);
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "ORDER_CONFIRMATION" } }), false);
  assert.equal(requiresEarlySettlementAcceptance({ quote: {} }), false);
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "LEGACY" } }), false);
});

test("frozen disclosure retains its exact text and refuses a changed digest", () => {
  const doc = newEarlySettlementDisclosure();
  const quote = { agreementAcceptanceSchema: 1, earlySettlementDisclosure: doc };
  assert.deepEqual(readEarlySettlementDisclosure(quote), doc);
  assert.throws(() => readEarlySettlementDisclosure({ ...quote, earlySettlementDisclosure: { ...doc, body: "changed" } }));
  assert.throws(() => readEarlySettlementDisclosure({ agreementAcceptanceSchema: 1 }));
});

test("real settlement routes bind explicit consent into idempotency while preserving old omitted bodies", async () => {
  const require = createRequire(__filename);
  const routes = require("../src/supply/supply-routes");
  const identity = require("../src/auth/user-identity");
  const record = require("../src/order/settlement-record");
  const original = { origin: routes.requireOrigin, write: routes.runIdempotentWrite, user: identity.readUserContext, open: record.settlementSurfaceOpen };
  let fingerprint: Record<string, unknown> | undefined;
  routes.requireOrigin = () => true;
  routes.runIdempotentWrite = async (...args: unknown[]) => { fingerprint = args[6] as Record<string, unknown>; };
  identity.readUserContext = async () => ({ userId: "user_1", sessionId: "session_1" });
  record.settlementSurfaceOpen = () => true;
  try {
    for (const suffix of ["/settlements", "/settlements/version_1/decision"]) {
      for (const accepted of [undefined, false, true]) {
        const base = suffix.endsWith("decision") ? { action: "CONFIRM", versionHash: "a".repeat(64) }
          : { lines: [{ itemId: "item_1", remainingQuantity: "0" }], acceptedHash: "a".repeat(64) };
        const body = { ...base, ...(accepted === undefined ? {} : { termsAccepted: accepted }) };
        fingerprint = undefined;
        await handleSettlementUserRoute({ method: "POST", url: `/api/v1/orders/order_1${suffix}`, headers: {}, body } as never,
          { setHeader() {} } as never, { pool: {}, settlementRecordingEnabled: true } as never);
        const sent = fingerprint as Record<string, unknown> | undefined;
        assert.ok(sent);
        assert.equal(Object.hasOwn(sent, "termsAccepted"), accepted !== undefined);
        if (accepted !== undefined) assert.equal(sent.termsAccepted, accepted);
      }
    }
  } finally {
    routes.requireOrigin = original.origin; routes.runIdempotentWrite = original.write;
    identity.readUserContext = original.user; record.settlementSurfaceOpen = original.open;
  }
});
