import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mapLegacyFavorite,
  planLegacyFavoriteImport,
  type LegacyCollectRow,
  type LegacyFavoriteMappingContext,
} from "../src/supply/legacy-favorites-mapping";

const row = (patch: Partial<LegacyCollectRow> = {}): LegacyCollectRow => ({
  sourceRowId: "la_goods_collect:1",
  sourceType: "ACCOUNT",
  userId: 11,
  accountId: 33,
  status: 1,
  ...patch,
});

function ctx(
  users: Record<string, string>,
  accounts: Record<string, { accountId: string; publiclyVisible: boolean }>,
  counters?: { users: number; accounts: number },
): LegacyFavoriteMappingContext {
  return {
    resolveUser: (legacyUserId) => {
      if (counters) counters.users += 1;
      return legacyUserId in users ? { userId: users[legacyUserId]! } : null;
    },
    resolveAccount: (legacyAccountId) => {
      if (counters) counters.accounts += 1;
      return accounts[legacyAccountId] ?? null;
    },
  };
}

const standard = ctx(
  { "11": "user_new_11" },
  { "33": { accountId: "acct_new_33", publiclyVisible: true } },
);

const isBadRequest = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && (error as { status?: number }).status === 400);

test("正常映射：双方解析成功并标记公开可见", () => {
  const result = mapLegacyFavorite(row(), standard);
  assert.equal(result.outcome, "MAPPED");
  assert.equal(result.userId, "user_new_11");
  assert.equal(result.accountId, "acct_new_33");
  assert.equal(result.visibility, "PUBLIC");
  assert.equal(result.skipReason, null);
  const plan = planLegacyFavoriteImport([row()], standard);
  assert.deepEqual(plan.mapped, [
    { userId: "user_new_11", accountId: "acct_new_33", sourceRowId: "la_goods_collect:1", sourceType: "ACCOUNT", visibility: "PUBLIC" },
  ]);
  assert.deepEqual(plan.coverageReport, {
    total: 1,
    mapped: 1,
    skipped: 0,
    conflicts: 0,
    skippedByReason: { SOURCE_USER_MISSING: 0, TARGET_ACCOUNT_MISSING: 0, UNMAPPED_ARTICLE: 0, DUPLICATE: 0, INACTIVE_SOURCE: 0 },
    mappedVisibility: { PUBLIC: 1, RETAINED_NOT_PUBLIC: 0 },
  });
});

test("旧用户无映射归类 SOURCE_USER_MISSING", () => {
  const noUser = ctx({}, { "33": { accountId: "acct_new_33", publiclyVisible: true } });
  const result = mapLegacyFavorite(row(), noUser);
  assert.equal(result.outcome, "SOURCE_USER_MISSING");
  assert.equal(result.userId, null);
  const plan = planLegacyFavoriteImport([row()], noUser);
  assert.equal(plan.mapped.length, 0);
  assert.deepEqual(
    plan.skipped.map((entry) => [entry.sourceRowId, entry.reason, entry.legacyUserId, entry.legacyTargetId]),
    [["la_goods_collect:1", "SOURCE_USER_MISSING", "11", "33"]],
  );
  assert.equal(plan.coverageReport.skippedByReason.SOURCE_USER_MISSING, 1);
});

test("旧账号无映射归类 TARGET_ACCOUNT_MISSING", () => {
  const noAccount = ctx({ "11": "user_new_11" }, {});
  const result = mapLegacyFavorite(row(), noAccount);
  assert.equal(result.outcome, "TARGET_ACCOUNT_MISSING");
  const plan = planLegacyFavoriteImport([row({ sourceRowId: "la_goods_collect:2" })], noAccount);
  assert.deepEqual(plan.skipped.map((entry) => entry.reason), ["TARGET_ACCOUNT_MISSING"]);
  assert.equal(plan.coverageReport.mapped, 0);
});

test("账号不可公开仍迁入为本人可见收藏（TARGET_NOT_VISIBLE，下架保留语义）", () => {
  const hidden = ctx({ "11": "user_new_11" }, { "33": { accountId: "acct_new_33", publiclyVisible: false } });
  const result = mapLegacyFavorite(row(), hidden);
  assert.equal(result.outcome, "TARGET_NOT_VISIBLE");
  assert.equal(result.visibility, "RETAINED_NOT_PUBLIC");
  assert.equal(result.skipReason, null);
  const plan = planLegacyFavoriteImport([row()], hidden);
  assert.equal(plan.mapped.length, 1);
  assert.equal(plan.mapped[0]!.visibility, "RETAINED_NOT_PUBLIC");
  assert.equal(plan.coverageReport.mappedVisibility.RETAINED_NOT_PUBLIC, 1);
  assert.equal(plan.coverageReport.skipped, 0);
});

test("status≠1 跳过为 INACTIVE_SOURCE 且先于主体解析", () => {
  for (const status of [0, 2]) {
    const result = mapLegacyFavorite(row({ status }), standard);
    assert.equal(result.outcome, "INACTIVE_SOURCE");
    assert.equal(result.skipReason, "INACTIVE_SOURCE");
  }
  const counters = { users: 0, accounts: 0 };
  const counting = ctx({ "11": "user_new_11" }, { "33": { accountId: "acct_new_33", publiclyVisible: true } }, counters);
  planLegacyFavoriteImport([row({ status: 0, sourceRowId: "la_goods_collect:9" })], counting);
  assert.equal(counters.users, 0);
  assert.equal(counters.accounts, 0);
});

test("同 user+account 重复行幂等归类 DUPLICATE 且只迁入一次", () => {
  const first = row({ sourceRowId: "la_goods_collect:1" });
  const second = row({ sourceRowId: "la_goods_collect:2", collectedAt: "2026-01-01T00:00:00Z" });
  const plan = planLegacyFavoriteImport([first, second], standard);
  assert.equal(plan.mapped.length, 1);
  assert.equal(plan.mapped[0]!.sourceRowId, "la_goods_collect:1");
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]!.reason, "DUPLICATE");
  assert.equal(plan.skipped[0]!.sourceRowId, "la_goods_collect:2");
  assert.equal(plan.coverageReport.skippedByReason.DUPLICATE, 1);
  const seen = new Set<string>([`${plan.mapped[0]!.userId}${String.fromCharCode(0)}${plan.mapped[0]!.accountId}`]);
  const duplicate = mapLegacyFavorite(second, standard, seen);
  assert.equal(duplicate.outcome, "DUPLICATE");
  assert.equal(duplicate.userId, null);
});

test("文章收藏归类 UNMAPPED_ARTICLE 并保留来源证据、不触达 E/T reader", () => {
  const article = row({ sourceRowId: "la_article:7", sourceType: "ARTICLE", accountId: 77 });
  const counters = { users: 0, accounts: 0 };
  const counting = ctx({ "11": "user_new_11" }, { "33": { accountId: "acct_new_33", publiclyVisible: true } }, counters);
  const result = mapLegacyFavorite(article, counting);
  assert.equal(result.outcome, "UNMAPPED_ARTICLE");
  assert.equal(result.skipReason, "UNMAPPED_ARTICLE");
  assert.equal(counters.users, 0);
  assert.equal(counters.accounts, 0);
  const plan = planLegacyFavoriteImport([article], counting);
  assert.deepEqual(
    plan.skipped.map((entry) => [entry.sourceRowId, entry.sourceType, entry.reason, entry.legacyUserId, entry.legacyTargetId]),
    [["la_article:7", "ARTICLE", "UNMAPPED_ARTICLE", "11", "77"]],
  );
});

test("空输入是合法空集（0 行恢复副本语义）", () => {
  const plan = planLegacyFavoriteImport([], standard);
  assert.deepEqual(plan.mapped, []);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.coverageReport, {
    total: 0,
    mapped: 0,
    skipped: 0,
    conflicts: 0,
    skippedByReason: { SOURCE_USER_MISSING: 0, TARGET_ACCOUNT_MISSING: 0, UNMAPPED_ARTICLE: 0, DUPLICATE: 0, INACTIVE_SOURCE: 0 },
    mappedVisibility: { PUBLIC: 0, RETAINED_NOT_PUBLIC: 0 },
  });
});

test("行数守恒：混合批次逐条归类且差集可核对", () => {
  const rows = [
    row({ sourceRowId: "la_goods_collect:1" }),
    row({ sourceRowId: "la_goods_collect:2", userId: 99 }),
    row({ sourceRowId: "la_goods_collect:3", accountId: 55 }),
    row({ sourceRowId: "la_goods_collect:4", accountId: 33, userId: 12 }),
    row({ sourceRowId: "la_goods_collect:5", status: 0 }),
    row({ sourceRowId: "la_goods_collect:6" }),
    row({ sourceRowId: "la_article:8", sourceType: "ARTICLE", accountId: 88 }),
    row({ sourceRowId: "la_goods_collect:9", accountId: 44, userId: 12 }),
  ];
  const hidden = ctx(
    { "11": "user_new_11", "12": "user_new_12" },
    { "33": { accountId: "acct_new_33", publiclyVisible: true }, "44": { accountId: "acct_new_44", publiclyVisible: false } },
  );
  const plan = planLegacyFavoriteImport(rows, hidden);
  const { coverageReport } = plan;
  assert.equal(coverageReport.total, rows.length);
  assert.equal(coverageReport.mapped + coverageReport.skipped + coverageReport.conflicts, coverageReport.total);
  assert.equal(plan.mapped.length + plan.skipped.length + plan.conflicts.length, rows.length);
  const reasonSum = Object.values(coverageReport.skippedByReason).reduce((sum, count) => sum + count, 0);
  assert.equal(reasonSum, coverageReport.skipped);
  const visibilitySum = Object.values(coverageReport.mappedVisibility).reduce((sum, count) => sum + count, 0);
  assert.equal(visibilitySum, coverageReport.mapped);
  assert.equal(coverageReport.mapped, 3);
  assert.deepEqual(plan.skipped.map((entry) => entry.reason).sort(), [
    "DUPLICATE",
    "INACTIVE_SOURCE",
    "SOURCE_USER_MISSING",
    "TARGET_ACCOUNT_MISSING",
    "UNMAPPED_ARTICLE",
  ]);
});

test("同 sourceRowId 冲突进入 conflicts 且不重复归类", () => {
  const plan = planLegacyFavoriteImport([row(), row({ accountId: 44 })], standard);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(
    plan.conflicts.map((entry) => [entry.sourceRowId, entry.reason, entry.legacyUserId, entry.legacyTargetId]),
    [["la_goods_collect:1", "DUPLICATE_SOURCE_ROW_ID", "11", "44"]],
  );
  assert.equal(plan.coverageReport.total, 2);
  assert.equal(plan.coverageReport.mapped + plan.coverageReport.skipped + plan.coverageReport.conflicts, 2);
  assert.equal(plan.coverageReport.mapped, 1);
});

test("行形状非法与 reader 违约被拒绝（400）", () => {
  assert.throws(() => mapLegacyFavorite(row({ userId: -1 }), standard), isBadRequest);
  assert.throws(() => mapLegacyFavorite(row({ userId: "abc" }), standard), isBadRequest);
  assert.throws(() => mapLegacyFavorite(row({ userId: 1.5 }), standard), isBadRequest);
  assert.throws(() => mapLegacyFavorite(row({ status: "1" as unknown as number }), standard), isBadRequest);
  assert.throws(() => mapLegacyFavorite(row({ status: 1.5 }), standard), isBadRequest);
  assert.throws(() => mapLegacyFavorite(row({ sourceType: "GOODS" as unknown as "ACCOUNT" }), standard), isBadRequest);
  assert.throws(() => mapLegacyFavorite(row({ sourceRowId: "no spaces!" }), standard), isBadRequest);
  assert.throws(() => mapLegacyFavorite(row({ collectedAt: "2026-01-01" }), standard), isBadRequest);
  assert.throws(() => planLegacyFavoriteImport([row({ accountId: null as unknown as number })], standard), isBadRequest);
  const badUserReader: LegacyFavoriteMappingContext = {
    resolveUser: () => ({ userId: "" }) as { userId: string },
    resolveAccount: () => null,
  };
  assert.throws(() => mapLegacyFavorite(row(), badUserReader), isBadRequest);
  const badAccountReader: LegacyFavoriteMappingContext = {
    resolveUser: () => ({ userId: "user_new_11" }),
    resolveAccount: () => ({ accountId: "acct_new_33" }) as { accountId: string; publiclyVisible: boolean },
  };
  assert.throws(() => mapLegacyFavorite(row(), badAccountReader), isBadRequest);
});
