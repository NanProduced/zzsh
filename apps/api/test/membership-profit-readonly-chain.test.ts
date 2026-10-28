import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { readMembershipProfitSimulation, canSimulateMembershipProfit } from "../src/auth/membership-profit-simulation";
import { compatRule } from "./pricing-compat-fixture";

// 完整只读调用链（离线）：复刻 membership-growth-routes 的 SET TRANSACTION READ ONLY → readMembershipProfitSimulation → quotePreview。
// 客户端守卫按 PG 只读事务语义拒绝行锁读与写语句（SQLSTATE 25006）；这不是真实 PG 实测。
const READ_ONLY_VIOLATION = /\bFOR\s+(SHARE|UPDATE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b|^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i;

function readOnlyClient(opts: { drift?: "price" | "term"; scope?: string[] | "ALL"; priceStatus?: string } = {}) {
  const haff = compatRule("57") as any;
  let readOnly = false, priceHead = "4", termHead = "2";
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (/^SET TRANSACTION READ ONLY$/.test(sql.trim())) { readOnly = true; return { rows: [] }; }
      if (readOnly && READ_ONLY_VIOLATION.test(sql)) throw Object.assign(new Error("cannot execute " + sql.slice(0, 40) + " in a read-only transaction"), { code: "25006" });
      if (sql.includes("FROM zzsh_supply.rule_release r")) return { rows: [{ releaseId: "release_sealed", gameId: "game_synthetic", termVersionId: "term_synthetic", priceVersionId: "price_synthetic", status: "SEALED", mode: "SPREAD", haffRule: haff }] };
      if (sql.includes("FROM zzsh_supply.price_line l")) return { rows: [{ itemId: "haff", unit: "HAFF_BASE", name: "哈夫币", pricingKind: "HAFF_RATIO", unitQuantity: null }] };
      if (sql.includes('"zzsh_iam"."admin_security"')) return { rows: opts.scope === undefined ? [] : [{ mode: opts.scope === "ALL" ? "ALL_GAMES" : "SELECTED_GAMES", gameIds: opts.scope === "ALL" ? [] : opts.scope }] };
      if (sql.includes('FROM "zzsh_supply"."price_version"')) return { rows: [{ id: "price_synthetic", gameId: "game_synthetic", mode: "SPREAD", status: opts.priceStatus ?? "SEALED", commissionRate: null, haffRule: haff, roundingPolicy: "HALF_UP_CENT_V1", revision: priceHead }] };
      if (sql.includes('FROM "zzsh_supply"."term_version"')) return { rows: [{ id: "term_synthetic", gameId: "game_synthetic", status: "SEALED", revision: termHead }] };
      if (sql.includes('FROM "zzsh_supply"."term_option"')) return { rows: [{ code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }] };
      if (sql.includes('FROM "zzsh_supply"."price_line"')) {
        if (opts.drift === "price") priceHead = "5";
        if (opts.drift === "term") termHead = "3";
        return { rows: [{ itemId: "haff", code: "df_billable_haff", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null }] };
      }
      throw new Error("Unexpected synthetic query: " + sql);
    },
  } as unknown as PoolClient;
  return { client, queries };
}

const body = () => ({ ruleReleaseId: "release_sealed", payableRatios: ["0.9", "1"], quoteInput: { priceVersionId: "price_synthetic", termVersionId: "term_synthetic", conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: { rentalMode: "ordinary" } }, inventory: [{ itemId: "haff", quantity: "100000000" }] } });
const boss = { adminId: "synthetic_boss", access: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false, permissions: new Set<string>() } } as any;
const staff = { adminId: "synthetic_staff", access: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(["supply.quote.internal.read", "membership.policy.draft"]) } } as any;

async function run(viewer: any, opts: Parameters<typeof readOnlyClient>[0] = {}) {
  const h = readOnlyClient(opts);
  await h.client.query("SET TRANSACTION READ ONLY");
  return { result: () => readMembershipProfitSimulation(h.client, viewer, body() as any), queries: h.queries };
}

test("只读守卫自检：READ ONLY 下行锁读被拒绝 25006（反例对照）", async () => {
  const h = readOnlyClient();
  await h.client.query("SET TRANSACTION READ ONLY");
  await assert.rejects(h.client.query('SELECT 1 FROM "zzsh_supply"."price_version" WHERE "id" = $1 FOR SHARE'), (e: any) => e.code === "25006");
});

test("完整只读调用链：利润模拟→quotePreview 在 READ ONLY 下成功且零行锁/写语句", async () => {
  const r = await run(boss);
  const out: any = await r.result();
  assert.equal(out.baseQuotable, true, JSON.stringify(out).slice(0, 300));
  assert.equal(out.basis.ruleReleaseId, "release_sealed");
  assert.ok(r.queries.every((q) => !READ_ONLY_VIOLATION.test(q)));
});

test("只读调用链：稳定 SEALED 读取两次结果一致", async () => {
  const a: any = await (await run(boss)).result();
  const b: any = await (await run(boss)).result();
  assert.deepEqual(a, b);
});

test("只读调用链：价格/条款修订中途漂移 → 409 拒绝（不在只读路径丢失一致性保护）", async () => {
  for (const drift of ["price", "term"] as const) await assert.rejects((await run(boss, { drift })).result(), (e: any) => { assert.match(String(e?.message), /Version changed/); return true; }, drift);
});

test("只读调用链权限：有域非 Boss 成功；无游戏域 → 拒绝；缺权限组合 → 路由门禁拒绝", async () => {
  const ok: any = await (await run(staff, { scope: ["game_synthetic"] })).result();
  assert.equal(ok.baseQuotable, true);
  await assert.rejects((await run(staff, { scope: ["game_other"] })).result());
  await assert.rejects((await run(staff, {})).result());
  assert.equal(canSimulateMembershipProfit(staff.access), true);
  assert.equal(canSimulateMembershipProfit({ ...staff.access, permissions: new Set(["membership.policy.draft"]) }), false);
  assert.equal(canSimulateMembershipProfit({ ...staff.access, permissions: new Set(["supply.quote.internal.read"]) }), false);
});

test("只读调用链：价格版本非 SEALED → 拒绝（政策必须绑定同一封存发布）", async () => {
  // rule_release 守卫读取的是 JOIN 后的 p.status；此处让 quotePreview 父行显示 DRAFT 只影响 quotePreview，故改测 sealed 守卫本身。
  const h = readOnlyClient();
  const orig = h.client.query.bind(h.client);
  (h.client as any).query = async (sql: string, v?: unknown[]) => sql.includes("FROM zzsh_supply.rule_release r") ? { rows: [{ releaseId: "release_sealed", gameId: "game_synthetic", termVersionId: "term_synthetic", priceVersionId: "price_synthetic", status: "DRAFT", mode: "SPREAD", haffRule: compatRule("57") }] } : orig(sql, v as any);
  await h.client.query("SET TRANSACTION READ ONLY");
  await assert.rejects(readMembershipProfitSimulation(h.client, boss, body() as any));
});
