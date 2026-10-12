import type { AdminGameScopeMode, AdminRoleSummary } from "../api";

/** 页面内的范围选择：三态互斥，避免"无范围"被旧的已勾选游戏静默覆盖。 */
export type ScopeChoice = "ALL_GAMES" | "SELECTED_GAMES" | "NO_SCOPE";

/**
 * 构造范围保存请求体。
 * 恢复历史集合是独立动作：省略 gameIds 才会命中服务端的"重新启用上次集合"语义，
 * 而"明确无业务范围"必须显式提交空数组。两者不能混用同一个分支。
 */
export function buildScopePayload(
  username: string,
  choice: ScopeChoice,
  gameIds: string[],
): { username: string; mode: AdminGameScopeMode; gameIds?: string[] } {
  if (choice === "ALL_GAMES") return { username, mode: "ALL_GAMES", gameIds: [] };
  if (choice === "NO_SCOPE") return { username, mode: "SELECTED_GAMES", gameIds: [] };
  return { username, mode: "SELECTED_GAMES", gameIds };
}

/** "恢复此前指定的范围"：只切模式，不带 gameIds，由服务端恢复历史集合。 */
export function buildRestoreScopePayload(username: string): { username: string; mode: AdminGameScopeMode } {
  return { username, mode: "SELECTED_GAMES" };
}

/** 选了指定游戏但一个都没勾时必须拦住保存，不静默提交旧集合或空集合；scope 未知时禁止修改。 */
export function scopeChoiceError(choice: ScopeChoice | null, gameIds: string[]): string | null {
  if (choice === null) return "服务端未提供该账号的业务范围，暂时不能修改或恢复。";
  if (choice === "SELECTED_GAMES" && gameIds.length === 0) {
    return "请至少勾选一个游戏，或改选“无业务范围”。";
  }
  return null;
}

/** 从服务端返回的 scope 推导页面选择。省略/未知返回 null，不能当作已确认的全部游戏。 */
export function scopeChoiceOf(mode: AdminGameScopeMode | undefined, gameIds: string[] | undefined): ScopeChoice | null {
  if (mode === "SELECTED_GAMES") return (gameIds?.length ?? 0) > 0 ? "SELECTED_GAMES" : "NO_SCOPE";
  if (mode === "ALL_GAMES") return "ALL_GAMES";
  return null;
}

/**
 * selected + 空集合是"无业务范围"，不是"暂无数据"；scope 缺失是"未提供"，不是"全部游戏"。
 * 游戏名只解析出一部分时同时报出未解析数量，避免少报范围。
 */
export function scopeLabel(
  mode: AdminGameScopeMode | undefined,
  gameIds: string[] | undefined,
  names: string[],
): string {
  const choice = scopeChoiceOf(mode, gameIds);
  if (choice === null) return "未提供";
  if (choice === "ALL_GAMES") return "全部游戏";
  if (choice === "NO_SCOPE") return "无业务范围";
  const total = gameIds?.length ?? 0;
  const unresolved = total - names.length;
  const listed = names.join("、");
  return unresolved > 0 ? `${listed} 等 ${total} 个指定游戏（${unresolved} 个名称未解析）` : listed;
}

/**
 * 已分配但已停用的角色。服务端 readGrants 不过滤状态，界面此前只渲染 ACTIVE 角色，
 * 导致这些角色看不见却又留在提交载荷里，保存必然 409。必须显式呈现并可取消勾选。
 */
export function assignedDisabledRoles(
  assigned: AdminRoleSummary[] | undefined,
  activeRoleIds: Set<string>,
): Array<AdminRoleSummary & { id: string }> {
  return (assigned ?? []).filter(
    (role): role is AdminRoleSummary & { id: string } =>
      !!role.id && !activeRoleIds.has(role.id) && role.status !== undefined && role.status !== "ACTIVE",
  );
}
