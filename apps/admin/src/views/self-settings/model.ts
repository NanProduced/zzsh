/**
 * ADM-SELF-SETTINGS-UI-1 · 本人设置三页的局部模型与合同校验。
 *
 * 合同来源：`tmp/admin-ops-ux-20261010/ADM-SELF-SETTINGS-BACKEND-1/api-contract.md`
 * A v1.1 / B v2.0 / C v1.1 已经 Master 源码复审；共享接线与真实安全写仍未验收。
 * 本节字段名、枚举与长度规则逐项对齐该合同与 `apps/api/src/auth/admin-self-settings.ts`。
 *
 * 不变式：
 * 1. 必填字段缺失、类型错误或长度越界 → ContractViolation，绝不退化成空列表、false 或 0。
 * 2. 合同声明可空的字段 → null，界面显示「未提供 / 未知」，不推断、不补零。
 * 3. 未知不等于「没有」：只有一个当前会话 ≠ 列表为空；nextCursor 非 null ≠ 已到底。
 */

import { AdminApiError } from "../../api.ts";
import { BEIJING_TIME_ZONE } from "../../workspace/beijing-time.ts";

/** 响应不符合合同。调用方必须显示为读取/合同失败，不能当作成功、空数据或无权限。 */
export class ContractViolation extends Error {
  constructor(readonly detail: string) {
    super(`服务端返回内容不符合本人设置合同：${detail}`);
    this.name = "ContractViolation";
  }
}

export const UNKNOWN_TEXT = "未知";
export const NOT_PROVIDED_TEXT = "未提供";
/** 合同 §1.2：显示名称按 Unicode 码点计，上限 120。 */
export const DISPLAY_NAME_MAX_CODE_POINTS = 120;
/** 合同 §3.1：limit 1..50，默认 20。 */
export const ACTIVITY_DEFAULT_LIMIT = 20;
export const ACTIVITY_MAX_LIMIT = 50;
const MAX_PAGE_ROWS = 100;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation(`${field} 不是对象`);
  }
  return value as Record<string, unknown>;
}

/** 必填字符串：缺失或类型错误即合同异常。 */
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ContractViolation(`${field} 缺失或不是非空字符串`);
  }
  if (value.length > max) {
    throw new ContractViolation(`${field} 超出合同长度上限 ${max}`);
  }
  return value.trim();
}

/** 合同声明必填、但值本身可为 null 的字符串（如 zzNumber、reason）。 */
function nullableText(value: unknown, field: string, max: number): string | null {
  if (value === undefined) throw new ContractViolation(`${field} 缺失`);
  if (value === null) return null;
  return optionalText(value, field, max);
}

/** 可选字符串：undefined/null/空串归一为 null（界面显示未提供）；类型错误或超长是合同异常。 */
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ContractViolation(`${field} 不是字符串`);
  }
  if (value.length > max) {
    throw new ContractViolation(`${field} 超出合同长度上限 ${max}`);
  }
  return value.trim() || null;
}

/** ISO 时间点：合同声明可空的字段用本函数，null → 未提供。 */
function nullableTimestamp(value: unknown, field: string): string | null {
  const raw = nullableText(value, field, 64);
  if (raw === null) return null;
  if (!Number.isFinite(Date.parse(raw))) {
    throw new ContractViolation(`${field} 不是可解析的时间值`);
  }
  return raw;
}

function requiredTimestamp(value: unknown, field: string): string {
  const parsed = nullableTimestamp(value, field);
  if (parsed === null) throw new ContractViolation(`${field} 缺失`);
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractViolation(`${field} 缺失或不是布尔值`);
  }
  return value;
}

function requiredArray(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractViolation(`${field} 缺失或不是数组`);
  }
  if (value.length > max) {
    throw new ContractViolation(`${field} 条数 ${value.length} 超过单页上限 ${max}`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  return requiredArray(value, field, 200).map((item, index) => requiredText(item, `${field}[${index}]`, 256));
}

/** 北京时间展示；时区由页面在分组或列表说明里声明一次，不逐行重复。 */
export function beijingDateTime(value: string | null): string {
  if (value === null) return NOT_PROVIDED_TEXT;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return UNKNOWN_TEXT;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// ---------------------------------------------------------------------------
// A. 本人资料（合同 §1）
// ---------------------------------------------------------------------------

export type ProfileFacts = {
  /** 内部关系 ID，仅用于状态绑定；绝不显示成 ZZ 编号。 */
  adminUserId: string;
  /** ZZ 编号：displayUsername 或 UPPER(username)；历史异常数据可为 null → 未提供。 */
  zzNumber: string | null;
  displayName: string;
  avatarUrl: string | null;
  /** 行最后变更时间；可能来自其他修改，不能证明某次未知请求已经执行。 */
  updatedAt: string;
};

export function parseProfilePayload(payload: unknown): ProfileFacts {
  const body = record(payload, "个人资料响应");
  return {
    adminUserId: requiredText(body.adminUserId, "adminUserId", 200),
    zzNumber: nullableText(body.zzNumber, "zzNumber", 64),
    displayName: requiredText(body.displayName, "displayName", 512),
    avatarUrl: nullableText(body.avatarUrl, "avatarUrl", 2048),
    updatedAt: requiredTimestamp(body.updatedAt, "updatedAt"),
  };
}

/** 更新成功信封：`{ status: true, profile }`。status 不为 true 或缺 profile 都不是成功。 */
export function parseProfileUpdatePayload(payload: unknown): ProfileFacts {
  const body = record(payload, "资料更新响应");
  if (body.status !== true) throw new ContractViolation("status 不是 true");
  return parseProfilePayload(record(body.profile, "profile"));
}

/**
 * 显示名称校验，与服务端 parseDisplayNameUpdate 同规则（服务端仍是权威）：
 * 非空、无控制字符、去首尾空白后不超过 120 个 Unicode 码点。
 */
export function displayNameIssue(draft: string): string | null {
  const trimmed = draft.trim();
  if (!trimmed) return "显示名称不能为空。";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(draft)) return "显示名称不能包含控制字符。";
  const codePoints = [...trimmed].length;
  if (codePoints > DISPLAY_NAME_MAX_CODE_POINTS) {
    return `显示名称最多 ${DISPLAY_NAME_MAX_CODE_POINTS} 个字符，当前 ${codePoints} 个。`;
  }
  return null;
}

/** 原值/草稿分离：只有真正改动过才允许发起写请求。 */
export function profileDraftChanged(draft: string, facts: Pick<ProfileFacts, "displayName"> | null): boolean {
  if (!facts) return false;
  return draft.trim() !== facts.displayName.trim();
}

export type ReadBackConclusion = {
  kind: "mismatched" | "indistinguishable";
  text: string;
};

/**
 * 响应丢失后读回的结论（合同 §1.2）：同名提交本就无副作用，因此
 * 名称或 updatedAt 的当前值都不能证明某次未知请求是否执行。
 */
export function readBackProfile(
  read: Pick<ProfileFacts, "displayName" | "updatedAt">,
  submitted: { displayName: string; updatedAtBefore: string | null },
): ReadBackConclusion {
  if (read.displayName.trim() !== submitted.displayName.trim()) {
    return { kind: "mismatched", text: "当前读到的显示名称与提交值不一致；这只描述当前事实，不能证明原请求未执行。请根据当前资料决定是否重新编辑。" };
  }
  return {
    kind: "indistinguishable",
    text: "当前显示名称已是提交值；无论更新时间是否变化，都无法据此确认原请求是否执行。",
  };
}

// ---------------------------------------------------------------------------
// B. 设备与会话（合同 §2）
// ---------------------------------------------------------------------------

export type SessionRow = {
  /** 非凭据会话标识（opaque），用于注销；不是 token。 */
  id: string;
  /** 服务端判定；客户端不得用本地会话 ID 推断「当前」。 */
  current: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  /** 原始 UA 截断字符串；合同不提供设备型号、系统版本、位置或最近活跃。 */
  userAgent: string | null;
  /** 该会话的 PIN 锁态，只表示「已锁屏」，不代表已失效。 */
  locked: boolean;
};

export type SessionsFacts = {
  rows: SessionRow[];
  /** 服务端标记的当前会话引用；为 null 时界面不得宣称「当前会话」。 */
  currentSessionId: string | null;
};

export function parseSessionsPayload(payload: unknown): SessionsFacts {
  const body = record(payload, "会话列表响应");
  const items = requiredArray(body.sessions, "sessions", MAX_PAGE_ROWS);
  const rows = items.map((item, index): SessionRow => {
    const row = record(item, `sessions[${index}]`);
    return {
      id: requiredText(row.id, `sessions[${index}].id`, 128),
      current: requiredBoolean(row.isCurrent, `sessions[${index}].isCurrent`),
      createdAt: nullableTimestamp(row.createdAt, `sessions[${index}].createdAt`),
      expiresAt: nullableTimestamp(row.expiresAt, `sessions[${index}].expiresAt`),
      userAgent: nullableText(row.userAgent, `sessions[${index}].userAgent`, 512),
      locked: requiredBoolean(row.locked, `sessions[${index}].locked`),
    };
  });
  const marked = rows.filter((row) => row.current);
  if (marked.length > 1) {
    throw new ContractViolation(`isCurrent 为 true 的会话有 ${marked.length} 条，当前会话必须唯一`);
  }
  return { rows, currentSessionId: marked[0]?.id ?? null };
}

/** 撤销成功信封：`{ status: true, revokedSessionCount: N }`。N 必须是合法非负整数。 */
export function parseRevokePayload(payload: unknown): { revokedSessionCount: number } {
  const body = record(payload, "会话撤销响应");
  if (body.status !== true) throw new ContractViolation("status 不是 true");
  const count = body.revokedSessionCount;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_PAGE_ROWS) {
    throw new ContractViolation("revokedSessionCount 不是合法计数");
  }
  return { revokedSessionCount: count };
}

/** 行级注销资格：只有服务端确认「不是当前会话」的行才能作为注销对象。 */
export function canRevokeRow(row: SessionRow): boolean {
  return !row.current;
}

/**
 * 「退出其他设备」的目标集合规模，按当前读到的事实计算。
 * 为 0 时界面表达「没有其他会话」，且不得提供该动作。
 */
export function otherSessionCount(rows: readonly SessionRow[]): number {
  return rows.filter((row) => !row.current).length;
}

/** 批量撤销完成结论只覆盖本次确认的固定集合，不承诺设备未来状态。 */
export function revokeDoneNotice(scope: "single" | "others", revokedSessionCount: number): string {
  return scope === "single"
    ? "已确认注销该会话。当前列表需另行读取确认。"
    : `已确认注销本次选择的 ${revokedSessionCount} 个有效会话；此后新登录的会话不在该结论范围内。`;
}

/**
 * 未知结果读回后的结论（合同 §2.2）：目标 id 已不在本人有效会话列表 = 撤销、过期或本就无效，
 * 安全目标当前已达成；仍在列表只证明当前有效，不证明在途原命令最终未执行。
 */
export function reconcileRevokedTarget(rows: readonly SessionRow[], targetId: string): { gone: boolean; text: string } {
  return rows.some((row) => row.id === targetId)
    ? { gone: false, text: "重新读取后该会话仍在本人有效列表中；这只描述当前事实，原请求结果仍无法确认。" }
    : { gone: true, text: "重新读取后该会话已不在本人有效会话列表中（已撤销、已过期或本就无效）；这不等于确认收到过原请求的成功响应。" };
}

// ---------------------------------------------------------------------------
// C. 本人安全活动（合同 §3）
// ---------------------------------------------------------------------------

export type ActivityActorKind = "self" | "other" | "system";

export type ActivityEvent = {
  eventId: string;
  occurredAt: string;
  action: string;
  category: string;
  outcome: "SUCCESS" | "FAILURE";
  reason: string | null;
  actorKind: ActivityActorKind;
  /** 他人操作时对方 ZZ 编号；合同不返回姓名、邮箱或内部 ID。 */
  actorRef: string | null;
  /** 服务端已按动作白名单投影；这里只做类型收敛，绝不显示未知键。 */
  details: Record<string, string | number | boolean>;
  requestId: string | null;
};

export type ActivityCoverage = {
  scope: string;
  recordedActions: string[];
  /** 必须如实披露的覆盖缺口，如 sign_in / sign_out 没有审计写入。 */
  notRecorded: string[];
};

export type ActivityPage = {
  events: ActivityEvent[];
  /** null = 服务端确认已到末页；缺失由 parse 抛合同异常，不能当作已到底。 */
  nextCursor: string | null;
  coverage: ActivityCoverage;
};

/** 动作中文名取自合同 §3.1 白名单与后端 SELF_ACTIVITY_* 常量；未收录的码返回 null。 */
export const ACTIVITY_ACTION_LABELS: Record<string, string> = {
  "admin.password.changed": "登录密码已修改",
  "admin.password.change": "修改登录密码",
  "admin.pin.set": "设置会话 PIN",
  "admin.pin.change": "更改会话 PIN",
  "admin.pin.locked": "会话因 PIN 错误次数被锁定",
  "admin.pin.unlock": "会话解锁",
  "admin.backup_codes.generated": "备用恢复码已生成",
  "admin.backup_codes.generate": "生成备用恢复码",
  "admin.self.sessions.revoked": "本人会话被注销",
  "admin.enrollment.activated": "身份验证器绑定完成",
  "admin.recovery.requested": "账号恢复申请已发起",
  "admin.recovery.completed": "账号恢复已完成",
  "admin.recovery.issued": "账号恢复已发放",
  "admin.recovery.disaster.issued": "灾备恢复已发放",
  "admin.frozen": "账号被冻结",
  "admin.unfrozen": "账号被解冻",
  "admin.session.force_logged_out": "被强制下线",
  "admin.account.updated": "账号资料被调整",
  "admin.permission.assigned": "个人权限被调整",
  "admin.game_scope.assigned": "游戏范围被调整",
  "admin.account.created": "账号被创建",
  "admin.bootstrap.created": "初始化账号被创建",
};

export const ACTIVITY_OUTCOME_LABELS: Record<string, string> = {
  SUCCESS: "成功",
  FAILURE: "失败",
};

const ACTOR_KINDS: readonly string[] = ["self", "other", "system"];

/** details 允许出现的键（合同 §3.1）；未知键一律不显示，也不当作权威枚数或操作依据。 */
const ACTIVITY_DETAIL_LABELS: Record<string, string> = {
  revokedSessionCount: "注销会话数",
  revokedSessions: "注销会话",
  generation: "生成批次",
  codeCount: "生成枚数",
  pinFailures: "PIN 失败计次",
  locked: "锁态",
  scope: "作用范围",
};

export function activityActionLabel(action: string): string | null {
  return ACTIVITY_ACTION_LABELS[action] ?? null;
}

export function activityOutcomeLabel(outcome: string): string | null {
  return ACTIVITY_OUTCOME_LABELS[outcome] ?? null;
}

/** 发起方措辞：他人执行的不写成「你操作了」；系统维护如实标注。 */
export function activityActorPhrase(kind: ActivityActorKind, ref: string | null): string {
  if (kind === "self") return "本人发起";
  if (kind === "system") return "系统或离线维护执行";
  return ref ? `由 ${ref} 对本人账号执行` : "由其他管理员对本人账号执行";
}

/** 把已投影的 details 渲染成「标签：值」短句；值只允许字符串、数字和布尔。 */
export function activityDetailPhrases(details: ActivityEvent["details"]): string[] {
  return Object.entries(details).flatMap(([key, value]) => {
    const label = ACTIVITY_DETAIL_LABELS[key];
    if (!label) return [];
    const shown = typeof value === "boolean" ? (value ? "是" : "否") : String(value);
    return [`${label}：${shown}`];
  });
}

/** 合同披露：登录/退出没有审计写入，界面必须说明而不是留白。 */
export const ACTIVITY_NOT_RECORDED_TEXT: Record<string, string> = {
  sign_in: "登录",
  sign_out: "退出登录",
};

export function parseActivityPayload(payload: unknown): ActivityPage {
  const body = record(payload, "安全活动响应");
  if (!("nextCursor" in body)) {
    throw new ContractViolation("缺少 nextCursor，无法判断分页是否结束");
  }
  const cursor = body.nextCursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw new ContractViolation("nextCursor 不是字符串或 null");
  }
  const coverageBody = record(body.coverage, "coverage");
  const coverage: ActivityCoverage = {
    scope: requiredText(coverageBody.scope, "coverage.scope", 128),
    recordedActions: stringArray(coverageBody.recordedActions, "coverage.recordedActions"),
    notRecorded: stringArray(coverageBody.notRecorded, "coverage.notRecorded"),
  };
  const items = requiredArray(body.events, "events", MAX_PAGE_ROWS);
  const events = items.map((item, index): ActivityEvent => {
    const row = record(item, `events[${index}]`);
    const actor = record(row.actor, `events[${index}].actor`);
    const kind = requiredText(actor.kind, `events[${index}].actor.kind`, 32);
    if (!ACTOR_KINDS.includes(kind)) {
      throw new ContractViolation(`events[${index}].actor.kind 不是 self/other/system：${kind}`);
    }
    const outcome = requiredText(row.outcome, `events[${index}].outcome`, 32);
    if (outcome !== "SUCCESS" && outcome !== "FAILURE") {
      throw new ContractViolation(`events[${index}].outcome 不是 SUCCESS/FAILURE：${outcome}`);
    }
    const detailsSource = record(row.details, `events[${index}].details`);
    const details: ActivityEvent["details"] = {};
    for (const [key, value] of Object.entries(detailsSource)) {
      if (!Object.hasOwn(ACTIVITY_DETAIL_LABELS, key)) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") details[key] = value;
    }
    return {
      eventId: requiredText(row.eventId, `events[${index}].eventId`, 200),
      occurredAt: requiredTimestamp(row.occurredAt, `events[${index}].occurredAt`),
      action: requiredText(row.action, `events[${index}].action`, 128),
      category: requiredText(row.category, `events[${index}].category`, 32),
      outcome,
      reason: nullableText(row.reason, `events[${index}].reason`, 256),
      actorKind: kind as ActivityActorKind,
      actorRef: nullableText(actor.ref, `events[${index}].actor.ref`, 64),
      details,
      requestId: nullableText(row.requestId, `events[${index}].requestId`, 128),
    };
  });
  return { events, nextCursor: cursor, coverage };
}

/** 游标栈：只保留本次查询链路内的游标，切查询即归零，避免旧游标串到新条件里。 */
export type CursorPage = { cursors: (string | null)[]; index: number; nextCursor: string | null };

export function emptyCursorPage(): CursorPage {
  return { cursors: [null], index: 0, nextCursor: null };
}

export function cursorAt(page: CursorPage): string | null {
  return page.cursors[page.index] ?? null;
}

/** 前进到下一页；没有服务端确认的 nextCursor 时返回原状态（不猜测下一页游标）。 */
export function advanceCursorPage(page: CursorPage): CursorPage {
  if (!page.nextCursor) return page;
  if (page.index + 1 < page.cursors.length) return { ...page, index: page.index + 1 };
  return {
    cursors: [...page.cursors.slice(0, page.index + 1), page.nextCursor],
    index: page.index + 1,
    nextCursor: page.nextCursor,
  };
}

export function goBackCursorPage(page: CursorPage): CursorPage {
  return page.index === 0 ? page : { ...page, index: page.index - 1 };
}

/** 只有当前页确实没有下一页时才允许显示「已读到底」。 */
export function atEndOfFeed(page: CursorPage): boolean {
  return page.nextCursor === null;
}

export type ActivityFilterValues = { action: string };

/** 草稿与已提交查询共用同一序列化，保证「同查询」判定不受空白影响。 */
export function activityQueryKey(values: ActivityFilterValues): string {
  return JSON.stringify([values.action.trim()]);
}

export function hasActiveActivityFilters(values: ActivityFilterValues): boolean {
  return Boolean(values.action.trim());
}

export function activityFilterLabel(action: string): string {
  return activityActionLabel(action) ?? action;
}

// ---------------------------------------------------------------------------
// 三页共用的失败分类
// ---------------------------------------------------------------------------

export type ReadFailure = {
  kind: "network" | "unauthorized" | "forbidden" | "locked" | "notFound" | "conflict" | "contract" | "server" | "other";
  message: string;
  requestId?: string;
};

/**
 * 读取/写入失败的统一分类。合同异常、403、404 与 409 必须各自分开：
 * 前者保留重试、403 清空数据、404 在撤销语义里等于「目标已不在」、409 是当前会话保护。
 * 401/423 已由全站 ADMIN_AUTH_FAILURE_EVENT 协调，本包不重复实现全局处理。
 * 合同 §0.3 的 error.reason 目前未由 AdminApiError 暴露（见 contract-map 的 Master hunk 依赖），
 * 因此这里只按 status 分类，不匹配英文 message。
 */
export function classifyReadFailure(error: unknown, fallbackMessage = "读取未完成"): ReadFailure {
  if (error instanceof ContractViolation) {
    return { kind: "contract", message: error.message };
  }
  if (error instanceof AdminApiError) {
    if (error.status === 0 || error.code === "NETWORK_ERROR") {
      return { kind: "network", message: "网络连接失败，请检查连接后重试。" };
    }
    if (error.status === 401) return { kind: "unauthorized", message: "会话已失效或账号当前不可用，请重新登录后继续。", requestId: error.requestId };
    if (error.status === 403) return { kind: "forbidden", message: "当前身份没有读取本人安全信息的权限，或账号尚未完成验证器绑定。", requestId: error.requestId };
    if (error.status === 423) return { kind: "locked", message: "本次会话已锁定，请先解锁后继续。" };
    if (error.status === 404) return { kind: "notFound", message: "请求的资源不存在或当前不可用，请重新读取核对。", requestId: error.requestId };
    if (error.status === 409) return { kind: "conflict", message: "该对象是当前登录会话，受保护；退出本次登录请使用登出流程。", requestId: error.requestId };
    if (error.status >= 500) {
      return { kind: "server", message: "服务暂时无法完成请求，请稍后重试。", requestId: error.requestId };
    }
    return { kind: "other", message: `${fallbackMessage}（${error.code}）`, requestId: error.requestId };
  }
  return { kind: "other", message: error instanceof Error && error.message ? error.message : fallbackMessage };
}
