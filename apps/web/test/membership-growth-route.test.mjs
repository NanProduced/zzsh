import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ZZSH_API_ORIGIN = "http://127.0.0.1:4232";
process.env.ZZSH_WEB_ORIGIN = "http://127.0.0.1:4230";

const { GET } = await import("../src/app/api/account/membership-growth/route.ts");

test("membership growth BFF enriches placeholder benefits and comparison with accurate tier values", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const upstreamPayload = {
      subjectId: "user_test_123",
      growth: {
        schema: "membership-growth-v1",
        knowledge: "KNOWN",
        benefitsState: "CONFIGURED",
        effectiveTier: "SILVER",
        normalTier: "SILVER",
        rollingPoints: "5772",
        lifetimePoints: "5772",
        asOfUtc: "2026-11-12T12:00:00.000Z",
        windowStartUtc: "2026-08-14T12:00:00.000Z",
        nextTier: { tier: "GOLD", threshold: "10000", remaining: "4228" },
        grace: { state: "NONE", fromTier: null, until: null, gapPoints: null },
        nextExpiryAtUtc: null,
        benefits: [
          { label: "租客押金", value: "租客押金按账号条件缴纳" },
          { label: "租赁价格", value: "按完整报价择优" },
        ],
        comparison: [
          { tier: "普通会员", deposit: "租客押金按账号条件缴纳", pricing: "价格方案未就绪" },
          { tier: "银卡会员", deposit: "租客押金按账号条件缴纳", pricing: "完整方案可比价" },
          { tier: "金卡会员", deposit: "租客押金按账号条件缴纳", pricing: "完整方案可比价" },
          { tier: "铂金会员", deposit: "免租客押金", pricing: "完整方案可比价" },
          { tier: "钻石会员", deposit: "免租客押金", pricing: "完整方案可比价" },
          { tier: "黑金会员", deposit: "免租客押金", pricing: "完整方案可比价" },
        ],
        contributions: [],
        pendingCount: 0,
      },
      entitlements: [],
    };

    globalThis.fetch = async () => new Response(JSON.stringify(upstreamPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const request = new Request("http://127.0.0.1:4230/api/account/membership-growth", {
      method: "GET",
      headers: { cookie: "zzsh_user.session_token=valid_token" },
    });

    const res = await GET(request);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Verify current tier benefits for SILVER
    const benefits = body.growth.benefits;
    assert.equal(benefits.length, 2);
    const depositBenefit = benefits.find((b) => b.label === "租客押金");
    const pricingBenefit = benefits.find((b) => b.label === "租赁优惠");
    assert.ok(depositBenefit);
    assert.equal(depositBenefit.value, "租客押金最高减免 200 元");
    assert.ok(pricingBenefit);
    assert.equal(pricingBenefit.value, "账号租金 9.8 折");

    // Verify comparison for all tiers
    const comparison = body.growth.comparison;
    assert.equal(comparison.length, 6);

    const normal = comparison.find((c) => c.tier === "普通会员");
    assert.equal(normal.pricing, "原价无折扣");
    assert.equal(normal.deposit, "租客押金按账号条件缴纳");

    const silver = comparison.find((c) => c.tier === "银卡会员");
    assert.equal(silver.pricing, "账号租金 9.8 折");
    assert.equal(silver.deposit, "租客押金最高减免 200 元");

    const gold = comparison.find((c) => c.tier === "金卡会员");
    assert.equal(gold.pricing, "账号租金 9.5 折");
    assert.equal(gold.deposit, "免租客押金");

    const platinum = comparison.find((c) => c.tier === "铂金会员");
    assert.equal(platinum.pricing, "账号租金 9.2 折");
    assert.equal(platinum.deposit, "免租客押金");

    const diamond = comparison.find((c) => c.tier === "钻石会员");
    assert.equal(diamond.pricing, "账号租金 8.8 折");
    assert.equal(diamond.deposit, "免租客押金");

    const blackGold = comparison.find((c) => c.tier === "黑金会员");
    assert.equal(blackGold.pricing, "账号租金 8.5 折");
    assert.equal(blackGold.deposit, "免租客押金");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("membership growth BFF passes through unconfigured or unknown state untouched", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const unconfiguredPayload = {
      growth: {
        schema: "membership-growth-v1",
        knowledge: "KNOWN",
        benefitsState: "NOT_CONFIGURED",
        effectiveTier: "SILVER",
        benefits: [{ label: "成长权益", value: "尚未发布" }],
        comparison: [],
      },
    };

    globalThis.fetch = async () => new Response(JSON.stringify(unconfiguredPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const request = new Request("http://127.0.0.1:4230/api/account/membership-growth", {
      method: "GET",
      headers: { cookie: "zzsh_user.session_token=valid_token" },
    });

    const res = await GET(request);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.growth.benefitsState, "NOT_CONFIGURED");
    assert.equal(body.growth.benefits[0].value, "尚未发布");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
