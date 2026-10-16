import { invalid } from "./supply-util";

/**
 * 旧平台收藏 → zzsh_supply.favorite 的映射规划（里程碑 D7，web/account 4 叶支撑）。
 *
 * 来源：la_goods_collect（LM-F-05「我的收藏」）——本人收藏查询过滤 GC.user_id=me、
 * GC.status=1、t.is_delete=0，关联 la_rental_accounts/la_sg_game；另有文章收藏
 * la_article collectList，属另一旧对象，新平台无收藏目标。
 * 新模型 zzsh_supply.favorite，PK(user_id, account_id)（0022 迁移）。
 *
 * 状态：2026-09 恢复副本 0 行（合法空来源）；归档提案未定
 * （ARCHIVE_PROPOSED_PENDING_REVIEW）；本模块只做纯函数映射规划，不连库、不挂路由，
 * 真实导入 NOT_RUN。身份映射（旧 user id → 新主体）属 E 域，供给快照映射属 T 域，
 * 本模块只注入 reader 接口，不自行实现。
 *
 * 语义对齐：账号存在但不可公开时仍迁入为本人可见收藏（RETAINED_NOT_PUBLIC），
 * 与 favorites.ts 读路径对下架供给返回 UNAVAILABLE 且保留收藏的行为一致。
 */

export type LegacyCollectSourceType = "ACCOUNT" | "ARTICLE";

/** 旧收藏冻结行（la_goods_collect 或 la_article collectList 的一行）。 */
export type LegacyCollectRow = {
  /** 来源行稳定标识，用于证据与审计（如 "la_goods_collect:123"）。 */
  sourceRowId: string;
  /** ACCOUNT=la_goods_collect；ARTICLE=la_article collectList。 */
  sourceType: LegacyCollectSourceType;
  /** 旧数值用户 ID（GC.user_id）。 */
  userId: number | string;
  /** 旧目标 ID：ACCOUNT 行为 la_rental_accounts.id；ARTICLE 行为旧文章 ID（仅证据保留）。 */
  accountId: number | string;
  /** 收藏状态，1 为有效收藏（LM-F-05）。 */
  status: number;
  /** 可选来源时间证据（UTC ISO-8601）。 */
  collectedAt?: string | null;
};

/** E 域身份映射 reader（旧 user id → 新主体）；T 域供给快照 reader（旧账号 id → 新供给）。 */
export type LegacyFavoriteMappingContext = {
  resolveUser: (legacyUserId: string) => { userId: string } | null;
  resolveAccount: (legacyAccountId: string) => { accountId: string; publiclyVisible: boolean } | null;
};

export type LegacyFavoriteSkipReason =
  | "SOURCE_USER_MISSING"
  | "TARGET_ACCOUNT_MISSING"
  | "UNMAPPED_ARTICLE"
  | "DUPLICATE"
  | "INACTIVE_SOURCE";

export type LegacyFavoriteOutcome = "MAPPED" | "TARGET_NOT_VISIBLE" | LegacyFavoriteSkipReason;

export type LegacyFavoriteMappedVisibility = "PUBLIC" | "RETAINED_NOT_PUBLIC";

/** 单条映射分类结果：MAPPED/TARGET_NOT_VISIBLE 为允许迁入，其余为跳过类。 */
export type LegacyFavoriteMappingResult =
  | {
      outcome: "MAPPED" | "TARGET_NOT_VISIBLE";
      sourceRowId: string;
      sourceType: "ACCOUNT";
      userId: string;
      accountId: string;
      visibility: LegacyFavoriteMappedVisibility;
      skipReason: null;
    }
  | {
      outcome: LegacyFavoriteSkipReason;
      sourceRowId: string;
      sourceType: LegacyCollectSourceType;
      userId: null;
      accountId: null;
      visibility: null;
      skipReason: LegacyFavoriteSkipReason;
    };

export type LegacyFavoriteMappedEntry = {
  userId: string;
  accountId: string;
  sourceRowId: string;
  sourceType: "ACCOUNT";
  visibility: LegacyFavoriteMappedVisibility;
};

export type LegacyFavoriteSkippedEntry = {
  sourceRowId: string;
  sourceType: LegacyCollectSourceType;
  reason: LegacyFavoriteSkipReason;
  /** 保留旧行证据，供验收核对与后续追踪，不静默丢弃。 */
  legacyUserId: string;
  legacyTargetId: string;
};

/** 来源证据完整性冲突：同一 sourceRowId 出现多次，无法赋予两个结果。 */
export type LegacyFavoriteConflict = {
  sourceRowId: string;
  reason: "DUPLICATE_SOURCE_ROW_ID";
  legacyUserId: string;
  legacyTargetId: string;
};

/** 覆盖统计：total === mapped + skipped + conflicts（行数守恒，逐条归类）。 */
export type LegacyFavoriteCoverageReport = {
  total: number;
  mapped: number;
  skipped: number;
  conflicts: number;
  skippedByReason: Record<LegacyFavoriteSkipReason, number>;
  mappedVisibility: Record<LegacyFavoriteMappedVisibility, number>;
};

export type LegacyFavoriteImportPlan = {
  mapped: LegacyFavoriteMappedEntry[];
  skipped: LegacyFavoriteSkippedEntry[];
  conflicts: LegacyFavoriteConflict[];
  coverageReport: LegacyFavoriteCoverageReport;
};

const SOURCE_ROW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGACY_NUMERIC_ID_PATTERN = /^\d{1,20}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const PAIR_KEY_SEPARATOR = "\u0000";

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLegacyNumericId(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(`Legacy collect ${field} is invalid`);
    return String(value);
  }
  if (typeof value === "string" && LEGACY_NUMERIC_ID_PATTERN.test(value)) return value;
  throw invalid(`Legacy collect ${field} is invalid`);
}

function normalizeLegacyCollectRow(row: unknown): LegacyCollectRow & { userId: string; accountId: string } {
  if (!recordValue(row)) throw invalid("Legacy collect row is invalid");
  if (typeof row.sourceRowId !== "string" || !SOURCE_ROW_ID_PATTERN.test(row.sourceRowId))
    throw invalid("Legacy collect source row id is invalid");
  if (row.sourceType !== "ACCOUNT" && row.sourceType !== "ARTICLE")
    throw invalid("Legacy collect source type is invalid");
  if (typeof row.status !== "number" || !Number.isSafeInteger(row.status))
    throw invalid("Legacy collect status is invalid");
  const collectedAt = row.collectedAt;
  if (collectedAt !== undefined && collectedAt !== null && (typeof collectedAt !== "string" || !TIMESTAMP_PATTERN.test(collectedAt)))
    throw invalid("Legacy collect collected-at is invalid");
  return {
    sourceRowId: row.sourceRowId,
    sourceType: row.sourceType,
    userId: normalizeLegacyNumericId(row.userId, "user id"),
    accountId: normalizeLegacyNumericId(row.accountId, "target id"),
    status: row.status,
    ...(collectedAt !== undefined ? { collectedAt } : {}),
  };
}

function guardResolvedUser(value: unknown): { userId: string } {
  if (!recordValue(value) || typeof value.userId !== "string" || !TARGET_ID_PATTERN.test(value.userId))
    throw invalid("Legacy favorite user resolver contract violated");
  return { userId: value.userId };
}

function guardResolvedAccount(value: unknown): { accountId: string; publiclyVisible: boolean } {
  if (
    !recordValue(value) ||
    typeof value.accountId !== "string" ||
    !TARGET_ID_PATTERN.test(value.accountId) ||
    typeof value.publiclyVisible !== "boolean"
  )
    throw invalid("Legacy favorite account resolver contract violated");
  return { accountId: value.accountId, publiclyVisible: value.publiclyVisible };
}

function skippedResult(
  outcome: LegacyFavoriteSkipReason,
  sourceRowId: string,
  sourceType: LegacyCollectSourceType,
): LegacyFavoriteMappingResult {
  return { outcome, sourceRowId, sourceType, userId: null, accountId: null, visibility: null, skipReason: outcome };
}

/**
 * 分类一条旧收藏行。seenKeys（可选）为已接受的 (userId, accountId) 键集合，
 * 命中即归类 DUPLICATE；planLegacyFavoriteImport 维护该集合。
 */
export function mapLegacyFavorite(
  row: LegacyCollectRow,
  ctx: LegacyFavoriteMappingContext,
  seenKeys?: ReadonlySet<string>,
): LegacyFavoriteMappingResult {
  const normalized = normalizeLegacyCollectRow(row);
  if (normalized.sourceType === "ARTICLE")
    return skippedResult("UNMAPPED_ARTICLE", normalized.sourceRowId, "ARTICLE");
  if (normalized.status !== 1)
    return skippedResult("INACTIVE_SOURCE", normalized.sourceRowId, "ACCOUNT");
  const user = ctx.resolveUser(normalized.userId);
  if (user === null) return skippedResult("SOURCE_USER_MISSING", normalized.sourceRowId, "ACCOUNT");
  const resolvedUser = guardResolvedUser(user);
  const account = ctx.resolveAccount(normalized.accountId);
  if (account === null) return skippedResult("TARGET_ACCOUNT_MISSING", normalized.sourceRowId, "ACCOUNT");
  const resolvedAccount = guardResolvedAccount(account);
  const pairKey = `${resolvedUser.userId}${PAIR_KEY_SEPARATOR}${resolvedAccount.accountId}`;
  if (seenKeys?.has(pairKey)) return skippedResult("DUPLICATE", normalized.sourceRowId, "ACCOUNT");
  const visibility: LegacyFavoriteMappedVisibility = resolvedAccount.publiclyVisible ? "PUBLIC" : "RETAINED_NOT_PUBLIC";
  return {
    outcome: resolvedAccount.publiclyVisible ? "MAPPED" : "TARGET_NOT_VISIBLE",
    sourceRowId: normalized.sourceRowId,
    sourceType: "ACCOUNT",
    userId: resolvedUser.userId,
    accountId: resolvedAccount.accountId,
    visibility,
    skipReason: null,
  };
}

/**
 * 批量映射规划：逐条归类，行数守恒（mapped + skipped + conflicts === total）。
 * 重复判定基于解析后的 (userId, accountId)；同 sourceRowId 重复进入 conflicts。
 */
export function planLegacyFavoriteImport(
  rows: readonly LegacyCollectRow[],
  ctx: LegacyFavoriteMappingContext,
): LegacyFavoriteImportPlan {
  const mapped: LegacyFavoriteMappedEntry[] = [],
    skipped: LegacyFavoriteSkippedEntry[] = [],
    conflicts: LegacyFavoriteConflict[] = [],
    seenPairs = new Set<string>(),
    seenRowIds = new Set<string>(),
    skippedByReason: Record<LegacyFavoriteSkipReason, number> = {
      SOURCE_USER_MISSING: 0,
      TARGET_ACCOUNT_MISSING: 0,
      UNMAPPED_ARTICLE: 0,
      DUPLICATE: 0,
      INACTIVE_SOURCE: 0,
    },
    mappedVisibility: Record<LegacyFavoriteMappedVisibility, number> = { PUBLIC: 0, RETAINED_NOT_PUBLIC: 0 };
  for (const row of rows) {
    const normalized = normalizeLegacyCollectRow(row);
    if (seenRowIds.has(normalized.sourceRowId)) {
      conflicts.push({
        sourceRowId: normalized.sourceRowId,
        reason: "DUPLICATE_SOURCE_ROW_ID",
        legacyUserId: normalized.userId,
        legacyTargetId: normalized.accountId,
      });
      continue;
    }
    seenRowIds.add(normalized.sourceRowId);
    const result = mapLegacyFavorite(normalized, ctx, seenPairs);
    if (result.skipReason === null) {
      seenPairs.add(`${result.userId}${PAIR_KEY_SEPARATOR}${result.accountId}`);
      mapped.push({
        userId: result.userId,
        accountId: result.accountId,
        sourceRowId: result.sourceRowId,
        sourceType: "ACCOUNT",
        visibility: result.visibility,
      });
      mappedVisibility[result.visibility] += 1;
    } else {
      skipped.push({
        sourceRowId: result.sourceRowId,
        sourceType: result.sourceType,
        reason: result.skipReason,
        legacyUserId: normalized.userId,
        legacyTargetId: normalized.accountId,
      });
      skippedByReason[result.skipReason] += 1;
    }
  }
  return {
    mapped,
    skipped,
    conflicts,
    coverageReport: {
      total: rows.length,
      mapped: mapped.length,
      skipped: skipped.length,
      conflicts: conflicts.length,
      skippedByReason,
      mappedVisibility,
    },
  };
}
