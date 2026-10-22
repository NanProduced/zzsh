import assert from "node:assert/strict";
import { test } from "node:test";

const { readMyMembershipGrowth } = await import("../src/lib/membership-growth-client.ts");
const { readMyMembershipGrowthConsumption } = await import("../src/lib/membership-growth-client.ts");

const known = {
  subjectId: "user_1",
  growth: {
    schema: "membership-growth-v1", knowledge: "KNOWN", sourceState: "COMPLETE", benefitsState: "CONFIGURED", asOfUtc: "2026-10-09T00:00:00.000Z", windowStartUtc: "2026-07-11T00:00:00.000Z",
    rollingPoints: "12000", lifetimePoints: "50000", normalTier: "GOLD", effectiveTier: "GOLD", blackGold: "QUALIFIED", grace: { state: "NONE", fromTier: null, until: null, gapPoints: null }, nextExpiryAtUtc: null, nextTier: { tier: "PLATINUM", threshold: "20000", remaining: "8000" },
    benefits: [{ label: "租客押金", value: "免租客押金" }], comparison: [{ tier: "金卡会员", deposit: "免租客押金", pricing: "完整方案可比价" }], contributions: [{ label: "租赁结算消费", effectiveAt: "2026-10-01T00:00:00.000Z", amountCents: "12000", exitsAt: "2026-12-30T00:00:00.000Z", kind: "CONSUMPTION" }], pendingCount: 0, pending: [], excluded: [],
  },
  entitlements: [{ id: "e1", kind: "FRIEND", label: "挚友礼遇", scopeKey: "game:delta", startsAtUtc: "2026-10-01T00:00:00.000Z", endsAtUtc: "2026-10-20T00:00:00.000Z", status: "ACTIVE", depositWaived: false }],
};

function consumptionPage(patch = {}) {
  return { contractVersion: "membership-growth.consumption.v1", subjectId: "user_1", scope: "LIFETIME", asOfUtc: "2026-10-18T00:00:00.123456Z", windowStartUtc: "2026-07-20T00:00:00.123456Z", snapshotVersion: "a".repeat(64), knowledge: "KNOWN", sourceState: "COMPLETE", amountCents: "98", points: "1", total: 2, nextCursor: null, sourceSummary: { contributionCount: 2, pendingCount: 0, excludedCount: 0 }, items: [0, 1].map((n) => ({ id: "growth_source_" + String(n).repeat(48), label: "租赁结算消费", amountCents: "49", effectiveAt: "2026-05-10T00:00:00Z", recordedAt: "2026-05-10T00:00:00Z", expiresAt: "2026-08-08T00:00:00Z", withinWindow: false, corrected: false, revision: 0 })), ...patch };
}

test("consumption client preserves aggregate rounding and explicit cumulative scope", async () => {
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "/api/account/membership-growth/consumption?scope=LIFETIME&limit=20");
      assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store");
      return new Response(JSON.stringify(consumptionPage()), { status: 200 });
    };
    const page = await readMyMembershipGrowthConsumption("user_1", "LIFETIME");
    assert.equal(page.points, "1"); assert.deepEqual(page.items.map((r) => r.amountCents), ["49", "49"]);
    assert.equal(page.asOf, "2026-10-18T00:00:00.123456Z"); assert.equal(page.items[0].withinWindow, false);
  } finally { globalThis.fetch = old; }
});

test("consumption client keeps unknown source totals null and known zero separate", async () => {
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(consumptionPage({ knowledge: "UNKNOWN", sourceState: "BACKFILL_PENDING", total: null, points: null, amountCents: null, items: [] })), { status: 200 });
    const unknown = await readMyMembershipGrowthConsumption("user_1", "LIFETIME");
    assert.deepEqual([unknown.knowledge, unknown.total, unknown.points], ["UNKNOWN", null, null]);
    globalThis.fetch = async () => new Response(JSON.stringify(consumptionPage({ scope: "ROLLING", total: 0, points: "0", amountCents: "0", items: [] })), { status: 200 });
    const empty = await readMyMembershipGrowthConsumption("user_1", "ROLLING");
    assert.deepEqual([empty.knowledge, empty.total, empty.points], ["KNOWN", 0, "0"]);
  } finally { globalThis.fetch = old; }
});

test("consumption client rejects identity crossover, wrong scopes and dishonest completeness", async () => {
  const old = globalThis.fetch;
  try {
    for (const patch of [{ subjectId: "other-user" }, { scope: "ROLLING" }, { items: null }, { total: 1 }, { knowledge: "UNKNOWN" }, { total: 3 }, { items: [consumptionPage().items[0], consumptionPage().items[0]] }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(consumptionPage(patch)), { status: 200 });
      await assert.rejects(() => readMyMembershipGrowthConsumption("user_1", "LIFETIME"), (e) => e.status === 401 || e.code === "MEMBERSHIP_CONTRACT_REQUIRED");
    }
  } finally { globalThis.fetch = old; }
});

test("consumption pagination passes cursor unchanged and abort prevents late body consumption", async () => {
  const old = globalThis.fetch, abort = new AbortController();
  try {
    globalThis.fetch = async (url) => { assert.equal(new URL(String(url), "http://test").searchParams.get("cursor"), "opaque_cursor"); abort.abort(); return new Response(JSON.stringify(consumptionPage()), { status: 200 }); };
    await assert.rejects(() => readMyMembershipGrowthConsumption("user_1", "LIFETIME", "opaque_cursor", abort.signal), (e) => e.name === "AbortError");
  } finally { globalThis.fetch = old; }
});

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

test("entitlement pricing summary only consumes public exact discount facts", async () => {
  const original = globalThis.fetch;
  try {
    const pricingSummary = { knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: "custom", payableRatio: "0.85000000", costBasisRef: "PRIVATE_COST_REFERENCE", approvalPayload: { secret: "PRIVATE_APPROVAL" } };
    globalThis.fetch = async () => new Response(JSON.stringify({ ...known, entitlements: [{ ...known.entitlements[0], pricingSummary, pricingPayload: { cost: "PRIVATE_COST" } }] }), { status: 200 });
    const state = await readMyMembershipGrowth();
    assert.equal(state.status, "ready");
    assert.deepEqual(state.data.entitlements[0].pricingSummary, { knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: "custom", payableRatio: "0.85000000" });
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_|costBasisRef|pricingPayload|approvalPayload/);
    assert.equal(state.data.entitlements[0].depositWaived, false);
    assert.equal(state.data.entitlements[0].endsAt, known.entitlements[0].endsAtUtc);
  } finally { globalThis.fetch = original; }
});

test("missing, legacy and invalid discount projections stay explicit without changing growth knowledge", async () => {
  const original = globalThis.fetch;
  try {
    for (const pricingSummary of [undefined, null, { knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: "future", payableRatio: "0.85" }, ...["0", "-0.5", "1.01", "1.000000001", "0.123456789", "NaN", 0.85].map(payableRatio => ({ knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: "ordinary", payableRatio }))]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...known, entitlements: [{ ...known.entitlements[0], pricingSummary }] }), { status: 200 });
      const state = await readMyMembershipGrowth();
      assert.equal(state.status, "ready");
      assert.equal(state.data.tier, "GOLD");
      assert.deepEqual(state.data.entitlements[0].pricingSummary, { knowledge: "UNKNOWN", kind: "UNKNOWN" });
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ ...known, entitlements: [{ ...known.entitlements[0], pricingSummary: { knowledge: "LEGACY", kind: "LEGACY", costBasisRef: "PRIVATE_LEGACY" } }] }), { status: 200 });
    const legacy = await readMyMembershipGrowth();
    assert.deepEqual(legacy.data.entitlements[0].pricingSummary, { knowledge: "LEGACY", kind: "LEGACY" });
    assert.doesNotMatch(JSON.stringify(legacy), /PRIVATE_LEGACY|costBasisRef/);
  } finally { globalThis.fetch = original; }
});

test("known discount survives independent unknown growth and preserves eight-decimal text", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ growth: { schema: "membership-growth-v1", knowledge: "UNKNOWN" }, entitlements: [{ ...known.entitlements[0], pricingSummary: { knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: "fast", payableRatio: "0.12345678" } }] }), { status: 200 });
    const state = await readMyMembershipGrowth();
    assert.equal(state.status, "unknown");
    assert.deepEqual(state.entitlements[0].pricingSummary, { knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: "fast", payableRatio: "0.12345678" });
  } finally { globalThis.fetch = original; }
});

test("entitlement game facts map bounded public strings while older DTOs remain usable", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ...known, entitlements: [{ ...known.entitlements[0], scopeKey: "game:game-live", gameId: "game-live", gameName: "三角洲行动" }] }), { status: 200 });
    const state = await readMyMembershipGrowth();
    assert.equal(state.status, "ready");
    assert.equal(state.data.entitlements[0].gameId, "game-live");
    assert.equal(state.data.entitlements[0].gameName, "三角洲行动");
    for (const fields of [{}, { gameId: null, gameName: null }, { gameId: " ", gameName: " " }, { gameId: 42, gameName: {} }, { gameId: "x".repeat(129), gameName: "字".repeat(201) }]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...known, entitlements: [{ ...known.entitlements[0], ...fields }] }), { status: 200 });
      const legacy = await readMyMembershipGrowth();
      assert.equal(legacy.status, "ready");
      assert.deepEqual([legacy.data.entitlements[0].gameId, legacy.data.entitlements[0].gameName], [null, null]);
      assert.equal(legacy.data.entitlements[0].scope, known.entitlements[0].scopeKey);
    }
  } finally { globalThis.fetch = original; }
});
