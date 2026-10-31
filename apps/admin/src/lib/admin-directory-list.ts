import type { AdminActionEligibility, AdminDirectoryEntry, AdminRoleSummary } from "../api";

/**
 * 管理员目录列表的呈现层：筛选、排序和摘要文案。
 *
 * 单独成模块的原因不是"以后要用"，而是这三件事都有明确的对错题
 * （未知不能写成 0、排序必须覆盖整个匹配结果而不是当前页），
 * 放在组件里就只能靠浏览器点出来。
 */

export type AdminSortKey = "name" | "status" | "access" | "scope" | "security";
export type SortDirection = "asc" | "desc";

export const ADMIN_SORT_LABELS: Record<AdminSortKey, string> = {
  name: "管理员",
  status: "账号状态",
  access: "访问配置",
  scope: "业务范围",
  security: "登录与安全",
};

/** 业务顺序按"需要处理 → 已阻断 → 正常"，不是字典序；未登记的枚举排最后。 */
const STATUS_ORDER: Record<string, number> = { PENDING_ENROLLMENT: 0, FROZEN: 1, ACTIVE: 2 };

export type AdminListFilters = { q: string; status: string; role: string; scope: string };
export const EMPTY_FILTERS: AdminListFilters = { q: "", status: "", role: "", scope: "" };

export function hasActiveFilters(filters: AdminListFilters): boolean {
  return Boolean(filters.q.trim() || filters.status || filters.role || filters.scope);
}

const SORT_KEYS: readonly AdminSortKey[] = ["name", "status", "access", "scope", "security"];
const SCOPE_FILTERS = new Set(["", "ALL_GAMES", "SELECTED_GAMES", "NO_SCOPE", "UNKNOWN"]);
const STATUS_FILTERS = new Set(["", "PENDING_ENROLLMENT", "FROZEN", "ACTIVE"]);

export type AdminListQuery = { filters: AdminListFilters; sort: { key: AdminSortKey; direction: SortDirection }; page: number };

/**
 * URL 查询参数是外部输入：排序键走白名单、缺省显式回到 `name/asc`、页码必须是有限正整数。
 * 初始化与之后的每次 query 同步都走这里，避免两处各写一套校验后漂移。
 */
export function parseListQuery(query: Record<string, string> | undefined): AdminListQuery {
  const rawPage = Number(query?.page);
  return {
    filters: {
      q: (query?.q ?? "").slice(0, 128),
      status: STATUS_FILTERS.has(query?.status ?? "") ? (query?.status ?? "") : "",
      role: (query?.role ?? "").slice(0, 128),
      scope: SCOPE_FILTERS.has(query?.scope ?? "") ? (query?.scope ?? "") : "",
    },
    sort: (() => {
      const rawSort = (query?.sort ?? "") as AdminSortKey;
      // 孤立的 dir 不算排序意图：键无效时整体回到默认 name/asc。
      if (!SORT_KEYS.includes(rawSort)) return { key: "name" as AdminSortKey, direction: "asc" as SortDirection };
      return { key: rawSort, direction: query?.dir === "desc" ? ("desc" as SortDirection) : ("asc" as SortDirection) };
    })(),
    page: Number.isFinite(rawPage) && Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1,
  };
}

/** 页码要收敛到实际存在的页：结果被筛小、数据变少或手改 URL 都不该显示空表。 */
export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page) || !Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, Math.max(1, pageCount));
}

function text(value: string | null | undefined): string {
  return (value ?? "").toString().trim().toLowerCase();
}

/** 业务范围四态：全部 / 指定 N 个 / 明确无范围 / 未提供。缺字段不能塌成"无范围"或 0。 */
export function scopeSummaryOf(entry: AdminDirectoryEntry): { label: string; known: boolean; filterValue: string } {
  const summary = entry.scopeSummary;
  if (!summary) return { label: "未提供", known: false, filterValue: "UNKNOWN" };
  if (summary.mode === "ALL_GAMES") return { label: "全部游戏", known: true, filterValue: "ALL_GAMES" };
  if (typeof summary.gameCount !== "number") return { label: "指定游戏 · 数量未提供", known: false, filterValue: "SELECTED_GAMES" };
  if (summary.gameCount === 0) return { label: "无业务范围", known: true, filterValue: "NO_SCOPE" };
  return { label: `指定 ${summary.gameCount} 个游戏`, known: true, filterValue: "SELECTED_GAMES" };
}

/** 访问配置：角色 + 个人例外。没有角色不等于没有权限，个人例外可能独立授予能力。 */
export function accessSummaryOf(entry: AdminDirectoryEntry): { roles: string; exception: string; disabledCount: number; rolesKnown: boolean; exceptionKnown: boolean } {
  const roles = entry.roles;
  const granted = roles ?? [];
  const disabled = granted.filter((role: AdminRoleSummary) => role.status !== undefined && role.status !== "ACTIVE");
  const grants = entry.personalGrantSummary;
  return {
    roles: roles === undefined ? "无权查看" : granted.length === 0 ? "未分配角色" : granted.map((role) => role.name).join("、"),
    exception: grants === undefined ? "例外未提供" : grants.allows + grants.denies === 0 ? "无个人例外" : `允许 ${grants.allows} · 禁止 ${grants.denies}`,
    disabledCount: disabled.length,
    rolesKnown: roles !== undefined,
    exceptionKnown: grants !== undefined,
  };
}

export type SecuritySummaryView = {
  headline: string;
  /** 第二行的语义部分；为空时只显示时间行。 */
  detail: string;
  /** 需要展示的时间前缀，如"完整登录"；无时间时为 null。 */
  timeLabel: string | null;
  time: string | null;
};

/** 登录与安全：只说服务端确实给出的事实，待激活期限和需改密优先于"最近完整登录"。 */
export function securitySummaryOf(entry: AdminDirectoryEntry): SecuritySummaryView {
  const summary = entry.securitySummary;
  const login = { timeLabel: "完整登录", time: entry.lastFullAuthenticatedAt ?? null };
  if (!summary) return { headline: "未提供", detail: "", ...login };
  if (entry.status === "PENDING_ENROLLMENT") {
    return { headline: "待激活", detail: "", timeLabel: "引导有效期至", time: summary.bootstrapExpiresAt };
  }
  if (summary.passwordChangeRequired) return { headline: "需修改密码", detail: "下次登录前必须改密", timeLabel: null, time: null };
  const twoFactor = summary.twoFactorEnabled === true ? "双因素已启用" : summary.twoFactorEnabled === false ? "双因素未启用" : "双因素状态未提供";
  return { headline: twoFactor, detail: "", ...login };
}

export function eligibilityOf(entry: AdminDirectoryEntry, action: AdminActionEligibility["action"]): AdminActionEligibility | undefined {
  return entry.actions?.find((candidate) => candidate.action === action);
}

const ADMIN_ACTION_LABELS: Record<AdminActionEligibility["action"], string> = {
  update: "修改显示名称",
  assign: "调整角色与个人权限",
  scope: "调整业务范围",
  freeze: "冻结账号",
  unfreeze: "解除冻结",
  "force-logout": "撤销全部会话",
  "reset-password": "重置密码",
  "reset-2fa": "重置 2FA",
};

/** 服务端预检原因码的中文说明；未登记的原因原样带出，不塌缩成通用措辞。 */
export const ADMIN_REASON_LABELS: Record<AdminActionEligibility["reasonCode"], string> = {
  OK: "可执行",
  ACTOR_INACTIVE: "当前账号不可发起该操作",
  PERMISSION_REQUIRED: "没有该操作的权限",
  BOSS_ACTOR_REQUIRED: "仅限 Boss 执行",
  BOSS_TARGET_NOT_CONFIGURABLE: "Boss 账号不支持此操作",
  SELF_TARGET: "不能对自身执行该操作",
  ALREADY_FROZEN: "该账号已冻结",
  NOT_FROZEN: "该账号未处于冻结状态",
  TARGET_FROZEN: "该账号已冻结，请先解冻",
};

export type DirectoryActionPlan = { action: AdminActionEligibility["action"]; label: string; blockedReason: string | null };

export function directoryActionBlockedReason(entry: AdminDirectoryEntry | undefined, action: AdminActionEligibility["action"]): string | null {
  const eligibility = entry && eligibilityOf(entry, action);
  if (!eligibility) return "操作资格未提供";
  return eligibility.allowed === true ? null : ADMIN_REASON_LABELS[eligibility.reasonCode] ?? `当前不可执行（${eligibility.reasonCode}）`;
}

/**
 * 行菜单要列出哪些任务、哪些可用、不可用时说明原因。
 *
 * 缺失预检（旧运行版本不返回 `actions`、返回空数组、或缺这一项）按未知处理并禁用：
 * 未知不能包装成可操作入口。明确 allowed 才放开。写接口仍在自身事务内重新授权，
 * 这份预检不是授权凭证。
 */
export function planDirectoryActions(entry: AdminDirectoryEntry): DirectoryActionPlan[] {
  const order: AdminActionEligibility["action"][] = entry.status === "FROZEN"
    ? ["update", "assign", "scope", "unfreeze", "force-logout"]
    : ["update", "assign", "scope", "freeze", "force-logout"];
  return order.map((action) => ({ action, label: ADMIN_ACTION_LABELS[action] ?? action, blockedReason: directoryActionBlockedReason(entry, action) }));
}

/** 一个可比较的排序级：`known=false` 的行与方向无关地留在末尾。 */
type SortLevel = { known: boolean; value: number | string };

const known = (value: number | string): SortLevel => ({ known: true, value });
const unknownLevel: SortLevel = { known: false, value: 0 };

/**
 * 登录与安全列的两级排序键。
 * 第一级是页面真正呈现的安全等级；双因素为 null（且非待激活/需改密）时页面写的是
 * "双因素状态未提供"，这一级就是未知。第二级是完整认证时间，保留毫秒；缺时间在该级末尾。
 */
function securityLevels(entry: AdminDirectoryEntry): SortLevel[] {
  const summary = entry.securitySummary;
  if (!summary) return [unknownLevel, unknownLevel];
  const grade =
    entry.status === "PENDING_ENROLLMENT" ? 0
    : summary.passwordChangeRequired ? 1
    : summary.twoFactorEnabled === false ? 2
    : summary.twoFactorEnabled === true ? 3
    : null;
  const parsed = entry.lastFullAuthenticatedAt ? Date.parse(entry.lastFullAuthenticatedAt) : Number.NaN;
  return [
    grade === null ? unknownLevel : known(grade),
    Number.isFinite(parsed) ? known(parsed) : unknownLevel,
  ];
}

function sortLevels(entry: AdminDirectoryEntry, key: AdminSortKey): SortLevel[] {
  if (key === "name") return [known(text(entry.name) || text(entry.username))];
  if (key === "status") {
    const rank = STATUS_ORDER[entry.status];
    return [rank === undefined ? unknownLevel : known(rank)];
  }
  if (key === "access") {
    const access = accessSummaryOf(entry);
    if (!access.rolesKnown && !access.exceptionKnown) return [unknownLevel];
    return [known(`${access.roles}|${access.exception}`)];
  }
  if (key === "scope") {
    const summary = entry.scopeSummary;
    if (!summary) return [unknownLevel];
    if (summary.mode === "ALL_GAMES") return [known(-1)];
    return typeof summary.gameCount === "number" ? [known(summary.gameCount)] : [unknownLevel];
  }
  return securityLevels(entry);
}

export function filterAdminEntries(entries: AdminDirectoryEntry[], filters: AdminListFilters): AdminDirectoryEntry[] {
  const needle = text(filters.q);
  return entries.filter((entry) => {
    if (needle && !text(entry.name).includes(needle) && !text(entry.username).includes(needle)) return false;
    if (filters.status && entry.status !== filters.status) return false;
    if (filters.role && !(entry.roles ?? []).some((role) => role.id === filters.role || role.code === filters.role)) return false;
    if (filters.scope && scopeSummaryOf(entry).filterValue !== filters.scope) return false;
    return true;
  });
}

/**
 * 排序作用于**完整匹配结果**，调用方必须在分页之前用它。
 * 只排当前页会让"按状态排序"变成假象：第一页永远只看到本页最靠前的那几个。
 */
export function sortAdminEntries(entries: AdminDirectoryEntry[], key: AdminSortKey, direction: SortDirection): AdminDirectoryEntry[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...entries].sort((left, right) => {
    const leftLevels = sortLevels(left, key);
    const rightLevels = sortLevels(right, key);
    for (let index = 0; index < Math.max(leftLevels.length, rightLevels.length); index += 1) {
      const a = leftLevels[index] ?? unknownLevel;
      const b = rightLevels[index] ?? unknownLevel;
      // 未知与方向无关地留在末尾：反向排序不得让"读不到"冒充"最优先"。
      if (a.known !== b.known) return a.known ? -1 : 1;
      if (!a.known) continue;
      if (typeof a.value === "number" && typeof b.value === "number") {
        if (a.value !== b.value) return (a.value - b.value) * factor;
      } else {
        const as = String(a.value);
        const bs = String(b.value);
        if (as !== bs) return as.localeCompare(bs, "zh-Hans-CN") * factor;
      }
    }
    // 所有级都相同（含双方未知）时按登录账号稳定收敛，避免每次刷新换序。
    return text(left.username).localeCompare(text(right.username));
  });
}
