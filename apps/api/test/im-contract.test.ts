import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateImRouting, parseImProductCard } from "../src/im/im-contract";

const ready = {
  platformAccountState: "ACTIVE" as const,
  identityActive: true,
  availability: "AVAILABLE" as const,
  connection: "CONNECTED" as const,
  lastConnectedAt: "2026-09-15T10:00:00.000Z",
  now: "2026-09-15T10:00:30.000Z",
  staleAfterMs: 60_000,
  activeLoad: 1,
  capacity: 3,
  hasServiceScope: true,
};

test("routing requires a fresh connected identity, availability, scope and capacity", () => {
  assert.deepEqual(evaluateImRouting(ready), { eligible: true, blockers: [] });
  assert.deepEqual(evaluateImRouting({ ...ready, connection: "RECONNECTING" }), {
    eligible: false,
    blockers: ["IM_CONNECTION_UNAVAILABLE"],
  });
  assert.deepEqual(evaluateImRouting({ ...ready, now: "2026-09-15T10:02:00.000Z" }).blockers, ["IM_CONNECTION_STALE"]);
  assert.deepEqual(evaluateImRouting({ ...ready, activeLoad: 3 }).blockers, ["CAPACITY_REACHED"]);
});

test("routing reports platform and business blockers independently", () => {
  const decision = evaluateImRouting({
    ...ready,
    platformAccountState: "FROZEN",
    identityActive: false,
    availability: "OFF_DUTY",
    hasServiceScope: false,
  });
  assert.deepEqual(decision.blockers, [
    "PLATFORM_ACCOUNT_UNAVAILABLE",
    "IM_IDENTITY_UNAVAILABLE",
    "NOT_ACCEPTING",
    "SERVICE_SCOPE_MISSING",
  ]);
});

test("product cards accept only the versioned safe envelope", () => {
  const card = parseImProductCard({
    schema: "zzsh.im-card",
    type: "PRODUCT",
    version: 1,
    objectId: "listing_abc",
    snapshot: {
      title: "三角洲行动资源账号",
      summary: "公开商品摘要",
      priceText: "按规则报价",
      statusText: "可咨询",
      mediaId: "media_abc",
    },
  });
  assert.equal(card?.objectId, "listing_abc");
  assert.equal(parseImProductCard({ ...card, version: 2 }), null);
  assert.equal(parseImProductCard({ ...card, snapshot: { ...card!.snapshot, html: "<script>" } }), null);
  assert.equal(parseImProductCard({ ...card, objectId: "../private" }), null);
});
