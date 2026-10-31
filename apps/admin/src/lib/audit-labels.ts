/** 审计事件的中文展示：动作、对象、详情字段与北京时间。未知动作按代码分段人性化兜底。 */

export const ACCOUNT_AUDIT_ACTIONS = [
  "admin.account.created", "admin.account.updated", "admin.permission.assigned", "admin.game_scope.assigned",
  "admin.role.created", "admin.role.updated", "admin.frozen", "admin.unfrozen", "admin.session.force_logged_out",
  "user.account.restored", "user.account.frozen", "user.account.unfrozen", "admin.bootstrap.created",
  "admin.enrollment.activated", "admin.password.change", "admin.password.changed", "admin.backup_codes.generated",
  "admin.login_two_factor.changed", "admin.security.insert", "admin.security.update", "admin.auth.failure",
  "admin.auth.lockout", "admin.pin.set", "admin.pin.change", "admin.pin.locked", "admin.pin.unlock",
  "admin.recovery.requested", "admin.recovery.issued", "admin.recovery.completed", "admin.recovery.disaster.issued",
  "user.identity.sensitive.read",
] as const;

const ACTION_LABELS: Record<string, string> = {
  "admin.account.created": "创建管理员",
  "admin.account.updated": "修改管理员资料",
  "admin.permission.assigned": "调整个人权限",
  "admin.game_scope.assigned": "调整游戏范围",
  "admin.role.created": "创建角色",
  "admin.role.updated": "修改角色",
  "admin.frozen": "冻结管理员",
  "admin.unfrozen": "解除管理员冻结",
  "admin.session.force_logged_out": "撤销登录会话",
  "user.account.restored": "恢复用户账号（已退役）",
  "user.account.frozen": "冻结用户",
  "user.account.unfrozen": "解冻用户",
  "admin.bootstrap.created": "初始化 Boss 账号",
  "admin.enrollment.activated": "完成账号启用",
  "admin.password.change": "发起修改密码",
  "admin.password.changed": "修改密码",
  "admin.backup_codes.generated": "生成备用恢复码",
  "admin.login_two_factor.changed": "切换登录二次验证",
  "admin.security.insert": "建立账号安全档案",
  "admin.security.update": "更新账号安全状态",
  "admin.auth.failure": "登录验证失败",
  "admin.auth.lockout": "登录锁定",
  "admin.pin.set": "设置操作 PIN",
  "admin.pin.change": "修改操作 PIN",
  "admin.pin.locked": "操作 PIN 锁定",
  "admin.pin.unlock": "解除 PIN 锁定",
  "admin.recovery.requested": "申请账号恢复",
  "admin.recovery.issued": "签发恢复凭证",
  "admin.recovery.completed": "完成账号恢复",
  "admin.recovery.disaster.issued": "签发灾备恢复凭证",
  "user.identity.sensitive.read": "查看用户敏感身份信息",
  "approval.request.created": "提交审批申请",
  "approval.request.approved": "批准审批申请",
  "approval.request.rejected": "驳回审批申请",
  "approval.request.executed": "执行已批准申请",
  "approval.request.withdrawn": "撤回审批申请",
  "approval.template.created": "创建审批模板",
  "approval.template.updated": "修改审批模板",
  "approval.approver.appended": "追加审批人",
};

const SEGMENT_LABELS: Record<string, string> = {
  admin: "管理员", user: "用户", approval: "审批", order: "订单", membership: "会员", distribution: "分销",
  account: "账号", role: "角色", permission: "权限", session: "会话", security: "安全", auth: "认证",
  password: "密码", pin: "PIN", recovery: "恢复", request: "申请", template: "模板", policy: "策略",
  entitlement: "权益", benefit: "福利", settlement: "结算", identity: "身份", content: "内容", game: "游戏",
  created: "创建", updated: "更新", deleted: "删除", changed: "变更", frozen: "冻结", unfrozen: "解冻",
  approved: "批准", rejected: "驳回", executed: "执行", withdrawn: "撤回", published: "发布", publish: "发布",
  grant: "授予", granted: "授予", revoke: "撤销", revoked: "撤销", replace: "替换", adjust: "调整", adjusted: "调整",
  read: "读取", failure: "失败", lockout: "锁定", issued: "签发", completed: "完成", requested: "申请",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanizeAction(action);
}

export function isKnownAction(action: string): boolean {
  return action in ACTION_LABELS;
}

export function humanizeAction(action: string): string {
  const parts = action.split(/[._]/).filter(Boolean);
  if (parts.length === 0) return "未知操作";
  const translated = parts.map((part) => SEGMENT_LABELS[part]);
  if (translated.every(Boolean)) return translated.join("");
  return `其他操作（${parts.map((part) => SEGMENT_LABELS[part] ?? part).join(" · ")}）`;
}

export const DOMAIN_LABELS: Record<string, string> = {
  admin: "管理员与安全", user: "用户", approval: "审批", order: "订单", membership: "会员",
  distribution: "分销", content: "内容", game: "游戏", system: "系统",
};

export function domainOf(action: string): string {
  return action.split(".", 1)[0] ?? "";
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  admin_user: "管理员账号",
  auth_user: "管理员账号",
  "zzsh_auth_admin.account": "管理员账号",
  admin_security: "账号安全状态",
  "zzsh_iam.admin_security": "账号安全状态",
  admin_role: "管理员角色",
  admin_session: "登录会话",
  admin_auth_subject: "登录主体",
  admin_recovery_request: "账号恢复申请",
  user_account: "用户账号",
  user: "用户",
  approval_request: "审批申请",
  approval_template: "审批模板",
};

export function objectTypeLabel(objectType: string): string {
  return OBJECT_TYPE_LABELS[objectType] ?? objectType.replace(/[._]/g, " ");
}

export const ACCOUNT_OBJECT_TYPES = [
  "admin_user", "admin_security", "admin_role", "admin_session", "admin_auth_subject", "admin_recovery_request", "user_account", "user",
] as const;

const DETAIL_KEY_LABELS: Record<string, string> = {
  username: "账号", displayUsername: "显示账号", name: "姓名", email: "邮箱", status: "状态",
  previousStatus: "原状态", nextStatus: "新状态", roleId: "角色编号", roleName: "角色名称", roles: "角色",
  permissions: "权限", added: "新增", removed: "移除", gameIds: "游戏范围", games: "游戏范围",
  sessionId: "会话", reason: "原因", enabled: "已启用", loginTwoFactor: "登录二次验证", attempts: "尝试次数",
  failedAttempts: "失败次数", lockedUntil: "锁定至", expiresAt: "过期时间", requestId: "请求编号",
  operation: "业务类型", operationCode: "业务类型", decision: "决定", approverUsername: "审批人", amount: "金额",
  userId: "用户编号", targetUserId: "对象编号", ip: "IP", userAgent: "客户端", count: "数量", source: "来源",
};

export function detailKeyLabel(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? key;
}

export type DetailRow = { key: string; label: string; value: string };

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "（空）" : value.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item))).join("、");
  return JSON.stringify(value);
}

/** 把已由服务端裁剪的 details 展开为中文键值列表（最多两层，深层以 JSON 文本展示）。 */
export function detailRows(details: unknown): DetailRow[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const rows: DetailRow[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [child, childValue] of Object.entries(value as Record<string, unknown>)) {
        rows.push({ key: `${key}.${child}`, label: `${detailKeyLabel(key)} · ${detailKeyLabel(child)}`, value: formatDetailValue(childValue) });
      }
      continue;
    }
    rows.push({ key, label: detailKeyLabel(key), value: formatDetailValue(value) });
  }
  return rows;
}

const BEIJING = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

export function formatBeijing(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : BEIJING.format(date);
}

/** datetime-local（按北京时间理解）→ ISO。 */
export function beijingLocalToIso(value: string): string {
  if (!value) return "";
  const date = new Date(`${value.length === 16 ? `${value}:00` : value}+08:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function isoToBeijingLocal(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16);
}
