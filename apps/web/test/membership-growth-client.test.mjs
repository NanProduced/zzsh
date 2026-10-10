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

    globalThis.fetch = async () => new Response(JSON.stringify({ growth: { schema: "membership-growth-v1", knowledge: "UNKNOWN" } }), { status: 200 });
    const unknown = await readMyMembershipGrowth();
    assert.deepEqual(unknown, { status: "unknown", message: "消费来源尚未完成核验，暂不展示成长积分" });
  } finally {
    globalThis.fetch = original;
  }
});

test("feature-off API stays a visible unknown state", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.deepEqual(await readMyMembershipGrowth(), { status: "unknown", message: "成长服务尚未接线" });
  } finally {
    globalThis.fetch = original;
  }
});
