import assert from "node:assert/strict";
import { test } from "node:test";

import { requiresEarlySettlementAcceptance } from "../src/order/settlement-record";

test("only v2 personal-confirmation orders require the new early-settlement acceptance", () => {
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "ORDER_CONFIRMATION" } }), true);
  assert.equal(requiresEarlySettlementAcceptance({ quote: {} }), false);
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "LEGACY" } }), false);
});
