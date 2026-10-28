import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { quotePreview } from "../src/supply/rules";
import { compatRule } from "./pricing-compat-fixture";

// 合成语句交错（非真实 PG 并发）：父版本修订在多表读取中途变化时必须拒绝，不得以旧修订回执新行。
function harness(opts: { drift?: "price" | "term"; expectedRevision?: string | undefined }) {
  const haff = compatRule("57") as any;
  delete haff.compatibility.modes.fast.max;
  let priceHead = "4";
  let termHead = "2";
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM "zzsh_supply"."price_version"')) return { rows: [{ id: "price_synthetic", gameId: "game_synthetic", mode: "SPREAD", status: "DRAFT", commissionRate: null, haffRule: haff, roundingPolicy: "HALF_UP_CENT_V1", revision: priceHead }] };
      if (sql.includes('FROM "zzsh_supply"."term_version"')) return { rows: [{ id: "term_synthetic", gameId: "game_synthetic", status: "SEALED", revision: termHead }] };
      if (sql.includes('FROM "zzsh_supply"."term_option"')) return { rows: [{ code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }] };
      if (sql.includes('FROM "zzsh_supply"."price_line"')) {
        if (opts.drift === "price") priceHead = "5";
        if (opts.drift === "term") termHead = "3";
        return { rows: [
          { itemId: "haff", code: "df_billable_haff", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null },
          { itemId: "coffee", code: "df_billable_coffee", unit: "PIECE", pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: opts.drift ? "20" : "10", ownerUnitAmount: "5" },
        ] };
      }
      throw new Error("Unexpected synthetic query: " + sql);
    },
  } as unknown as PoolClient;
  const body: Record<string, unknown> = { priceVersionId: "price_synthetic", termVersionId: "term_synthetic", conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: { rentalMode: "fast", ownerRatioB: "63" } }, inventory: [{ itemId: "haff", quantity: "100000000" }, { itemId: "coffee", quantity: "1" }] };
  if (opts.expectedRevision !== undefined) body.expectedRevision = opts.expectedRevision;
  return { run: () => quotePreview(client, "synthetic_boss", true, body as any), queries };
}

test("quotePreview 不发出行锁/写语句（只读事务兼容），以读后修订复核代替", async () => {
  const h = harness({ expectedRevision: "4" });
  await h.run();
  assert.ok(h.queries.every((q) => !/\bFOR\s+(SHARE|UPDATE|NO\s+KEY|KEY\s+SHARE)\b|^\s*(INSERT|UPDATE|DELETE)\b/i.test(q)));
  assert.equal(h.queries.filter((q) => /SELECT "revision"::text AS "revision" FROM "zzsh_supply"\."(price|term)_version"/.test(q)).length, 2);
});

test("quotePreview 价格版本中途漂移 → 409，不以旧修订回执新行", async () => {
  await assert.rejects(harness({ drift: "price", expectedRevision: "4" }).run(), (e: any) => e?.statusCode === 409 || e?.status === 409 || /Version changed/.test(String(e?.message)));
});

test("quotePreview 条款版本中途漂移 → 409", async () => {
  await assert.rejects(harness({ drift: "term", expectedRevision: "4" }).run(), (e: any) => /Version changed/.test(String(e?.message)) || e?.statusCode === 409);
});

test("quotePreview 稳定读取正例：binding 修订与行同一版本", async () => {
  const r: any = await harness({ expectedRevision: "4" }).run();
  assert.equal(r.quotable, true);
  assert.equal(r.binding.priceVersionRevision, "4");
  assert.equal(r.quote.lines.find((x: any) => x.itemId === "coffee").buyerAmount.amount, "10.00");
});

test("quotePreview 无 expectedRevision 调用方（会员利润模拟）兼容；漂移仍拒绝", async () => {
  const r: any = await harness({}).run();
  assert.equal(r.quotable, true);
  await assert.rejects(harness({ drift: "price" }).run());
});
