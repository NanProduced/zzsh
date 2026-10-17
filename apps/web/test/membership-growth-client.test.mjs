import assert from "node:assert/strict";
import { test } from "node:test";

const { readMyMembershipGrowth } = await import("../src/lib/membership-growth-client.ts");

const known = {
  subjectId: "user_1",
  growth: {
    schema: "membership-growth-v1", knowledge: "KNOWN", sourceState: "COMPLETE", benefitsState: "CONFIGURED", asOfUtc: "2026-10-09T00:00:00.000Z", windowStartUtc: "2026-07-11T00:00:00.000Z",
    rollingPoints: "12000", lifetimePoints: "50000", normalTier: "GOLD", effectiveTier: "GOLD", blackGold: "QUALIFIED", grace: { state: "NONE", fromTier: null, until: null, gapPoints: null }, nextExpiryAtUtc: null, nextTier: { tier: "PLATINUM", threshold: "20000", remaining: "8000" },
    benefits: [{ label: "租客押金", value: "免租客押金" }], comparison: [{ tier: "金卡会员", deposit: "免租客押金", pricing: "完整方案可比价" }], contributions: [{ label: "租赁结算消费", effectiveAt: "2026-10-01T00:00:00.000Z", amountCents: "12000", exitsAt: "2026-12-30T00:00:00.000Z", kind: "CONSUMPTION" }], pendingCount: 0, pending: [], excluded: [],
  },
  entitlements: [{ id: "e1", kind: "FRIEND", label: "挚友礼遇", scopeKey: "game:delta", startsAtUtc: "2026-10-01T00:00:00.000Z", endsAtUtc: "2026-10-20T00:00:00.000Z", status: "ACTIVE", depositWaived: false }],
};

test("membership growth client keeps known and unknown source states distinct", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(known), { status: 200 });
    const ready = await readMyMembershipGrowth();
    assert.equal(ready.status, "ready");
    if (ready.status === "ready") {
      assert.equal(ready.data.tier, "GOLD");
      assert.equal(ready.data.entitlements[0].label, "挚友礼遇");
      assert.equal(ready.data.contributions[0].amountCents, "12000");
    }

    globalThis.fetch = async () => new Response(JSON.stringify({ growth: { schema: "membership-growth-v1", knowledge: "UNKNOWN" }, entitlements: [] }), { status: 200 });
    const unknown = await readMyMembershipGrowth();
    assert.deepEqual(unknown, { status: "unknown", message: "消费来源尚未完成核验，暂不展示成长积分", entitlements: [] });

    globalThis.fetch = async () => new Response(JSON.stringify({ growth: { schema: "membership-growth-v1", knowledge: "UNKNOWN" }, entitlements: known.entitlements }), { status: 200 });
    const unknownWithEntitlements = await readMyMembershipGrowth();
    assert.equal(unknownWithEntitlements.status, "unknown");
    assert.equal(unknownWithEntitlements.entitlements[0].label, "挚友礼遇");
    assert.equal(unknownWithEntitlements.entitlements[0].state, "ACTIVE");
  } finally {
    globalThis.fetch = original;
  }
});

test("a missing formal read endpoint is a read error rather than source UNKNOWN", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(() => readMyMembershipGrowth(), error => error.status === 404);
  } finally {
    globalThis.fetch = original;
  }
});

test("missing or malformed contract arrays fail closed instead of reading as empty", async () => {
  const original = globalThis.fetch;
  try {
    const { entitlements, ...withoutEntitlements } = known;
    globalThis.fetch = async () => new Response(JSON.stringify(withoutEntitlements), { status: 200 });
    await assert.rejects(() => readMyMembershipGrowth(), /entitlements/);

    globalThis.fetch = async () => new Response(JSON.stringify({
      ...known,
      growth: { ...known.growth, contributions: [{ label: "租赁结算消费" }] },
    }), { status: 200 });
    await assert.rejects(() => readMyMembershipGrowth(), /contributions/);

    globalThis.fetch = async () => new Response(JSON.stringify(known), { status: 200 });
    const ready = await readMyMembershipGrowth();
    assert.equal(ready.status, "ready");
  } finally {
    globalThis.fetch = original;
  }
});

test("entitlement identity, timing and unknown kinds survive client mapping", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      ...known,
      entitlements: [
        { id: "e9", kind: "MYTHIC", label: "未知礼遇", scopeKey: "game:x", startsAtUtc: "2027-01-01T00:00:00.000Z", endsAtUtc: "2027-06-01T00:00:00.000Z", status: "WEIRD", depositWaived: false },
        { id: "e1", kind: "FRIEND", label: "挚友礼遇", scopeKey: "game:delta", startsAtUtc: "2026-10-01T00:00:00.000Z", endsAtUtc: "2026-10-20T00:00:00.000Z", status: "ACTIVE", depositWaived: false },
      ],
    }), { status: 200 });
    const ready = await readMyMembershipGrowth();
    assert.equal(ready.status, "ready");
    if (ready.status === "ready") {
      assert.equal(ready.data.entitlements[0].id, "e9");
      assert.equal(ready.data.entitlements[0].kind, "UNKNOWN");
      assert.equal(ready.data.entitlements[0].state, "UNKNOWN");
      assert.equal(ready.data.entitlements[0].startsAt, "2027-01-01T00:00:00.000Z");
      assert.equal(ready.data.entitlements[1].state, "ACTIVE");
      assert.equal(ready.data.benefitsState, "CONFIGURED");
      assert.equal(ready.data.windowStart, "2026-07-11T00:00:00.000Z");
    }
  } finally {
    globalThis.fetch = original;
  }
});
