import type { AdminPermissionCatalogEntry } from "../api";

/** Baseline business reads are shown as system defaults, not role checkboxes. */
export const BASELINE_ADMIN_PERMISSION_CODES = new Set(["order.read"]);

export type AdminPermissionGroup = {
  id: string;
  label: string;
  description: string;
  codes: string[];
  sections: AdminPermissionSection[];
};

export type AdminPermissionSection = {
  id: string;
  /** 业务对象名。同对象只有一项能力时为 ""，调用方按扁平行渲染，不硬凑标题。 */
  label: string;
  codes: string[];
};

/** 能力所属的管理对象 = code 去掉最后一段（`admin.account.freeze` → `admin.account`）。 */
export function permissionSectionId(code: string): string {
  return code.split(".").slice(0, -1).join(".") || code;
}

/** 只给"同对象多项能力"的对象命名；未登记的对象退化为无标题扁平行，不丢能力。 */
const SECTION_LABELS: Record<string, string> = {
  "admin.account": "管理员",
  "admin.role": "角色",
  "admin.permission": "权限授予",
  "im.support": "客服咨询",
  "supply.rules": "规则与价目",
  "supply.review": "供给与媒体审核",
  "supply.guarantee": "账号保证金",
  content: "游戏内容",
  "content.platform": "平台内容",
  credit: "用户信用",
  "credit.guarantee": "号主保证金",
  "approval.template": "审批模板",
  "approval.request": "审批申请",
  "personal.distribution.policy": "分销政策",
};

const GROUPS: Array<{ id: string; label: string; description: string; match: (code: string) => boolean }> = [
  { id: "security", label: "平台安全", description: "管理员、角色、权限和审计治理。", match: (code) => code.startsWith("admin.") },
  { id: "orders", label: "订单与用户", description: "订单服务、用户定位和基础业务读取。", match: (code) => code.startsWith("order.") || code.startsWith("user.") },
  { id: "support", label: "客服履约", description: "咨询接待、订单群和人工履约。", match: (code) => code.startsWith("im.") },
  { id: "supply", label: "供给与账号", description: "账号、目录、审核、规则和供给处置。", match: (code) => code.startsWith("supply.") },
  { id: "content", label: "运营内容", description: "平台内容、游戏内容和发布。", match: (code) => code.startsWith("content.") },
  { id: "finance", label: "资金与财务", description: "财务汇总、单据和账务读取。", match: (code) => code.startsWith("finance.") },
  { id: "risk", label: "风控与审批", description: "信用、保证金、审批模板和审批处理。", match: (code) => code.startsWith("credit.") || code.startsWith("approval.") },
  { id: "distribution", label: "分配策略", description: "订单与个人分配策略。", match: (code) => code.startsWith("personal.") },
];

export function isBaselineAdminPermission(code: string): boolean {
  return BASELINE_ADMIN_PERMISSION_CODES.has(code);
}

export function permissionGroupId(code: string): string {
  return GROUPS.find((group) => group.match(code))?.id ?? "other";
}

export function permissionLabel(permission: AdminPermissionCatalogEntry): string {
  return permission.name || "未命名权限";
}

/** 展示顺序：查看 → 新建/编辑 → 配置/授予 → 处置/执行。只影响排列，不参与任何授权判断。 */
const ACTION_RANK: Record<string, number> = {
  read: 0, view: 0, lookup: 0,
  create: 1,
  update: 2, edit: 2,
  configure: 3, manage: 3,
  review: 4,
  grant: 5, assign: 5, accept: 5, transfer: 5, presence: 5, restore: 5, verify: 5, add_approver: 5,
  decide: 6, approve: 6, execute: 6, publish: 6, activate: 6, restrict: 6, revoke: 6, freeze: 6, unfreeze: 6, write: 6,
};

function actionRank(code: string): number {
  return ACTION_RANK[code.split(".").pop() ?? ""] ?? 4;
}

function toSections(codes: string[]): AdminPermissionSection[] {
  const buckets = new Map<string, string[]>();
  for (const code of codes) {
    const id = permissionSectionId(code);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(code);
    else buckets.set(id, [code]);
  }
  return [...buckets].map(([id, bucket]) => ({
    id,
    label: bucket.length > 1 ? SECTION_LABELS[id] ?? "" : "",
    codes: bucket.slice().sort((a, b) => actionRank(a) - actionRank(b) || a.localeCompare(b)),
  }));
}

export function groupAdminPermissions(permissions: AdminPermissionCatalogEntry[]): AdminPermissionGroup[] {
  const groups = GROUPS.map(({ match: _match, ...group }) => ({ ...group, codes: [] as string[] }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const other = { id: "other", label: "其他权限", description: "尚未归入标准业务域的权限。", codes: [] as string[] };
  for (const permission of permissions) {
    if (isBaselineAdminPermission(permission.code)) continue;
    const target = byId.get(permissionGroupId(permission.code)) ?? other;
    target.codes.push(permission.code);
  }
  return [...groups, other]
    .filter((group) => group.codes.length > 0)
    .map((group) => ({ ...group, sections: toSections(group.codes) }));
}

export function permissionByCode(permissions: AdminPermissionCatalogEntry[]): Map<string, AdminPermissionCatalogEntry> {
  return new Map(permissions.map((permission) => [permission.code, permission]));
}

/** 服务端每项能力都带中文说明；缺省时返回空串，由调用方决定不渲染副行。 */
export function permissionDescription(permission: AdminPermissionCatalogEntry): string {
  return permission.description?.trim() ?? "";
}

export type AdminPermissionGroupCount = { id: string; label: string; count: number };

/** 按业务域计数，替代"前 5 项 + 等"。基础能力不计入；目录里没有的 code 单列，不静默丢弃。 */
export function countPermissionsByGroup(codes: string[], permissions: AdminPermissionCatalogEntry[]): AdminPermissionGroupCount[] {
  const known = new Set(permissions.map((permission) => permission.code));
  const labelById = new Map(groupAdminPermissions(permissions).map((group) => [group.id, group.label]));
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const code of codes) {
    if (isBaselineAdminPermission(code)) continue;
    if (!known.has(code)) {
      unknown += 1;
      continue;
    }
    const id = permissionGroupId(code);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const result = [...counts].map(([id, count]) => ({ id, label: labelById.get(id) ?? "其他权限", count }));
  if (unknown > 0) result.push({ id: "unknown", label: "未归类权限", count: unknown });
  return result;
}

export function diffPermissionCodes(baseline: string[], next: string[]): { added: string[]; removed: string[] } {
  const before = new Set(baseline);
  const after = new Set(next);
  return { added: next.filter((code) => !before.has(code)), removed: baseline.filter((code) => !after.has(code)) };
}

export function summarizePermissionCodes(codes: string[], permissions: AdminPermissionCatalogEntry[]): string {
  const catalog = permissionByCode(permissions);
  const baseline = codes.some(isBaselineAdminPermission) ? "订单核心读取（系统默认）" : "";
  const configurableCodes = codes.filter((code) => !isBaselineAdminPermission(code));
  const labels = configurableCodes
    .map((code) => catalog.get(code)?.name)
    .filter((label): label is string => Boolean(label))
    .slice(0, 5);
  const unnamed = configurableCodes.filter((code) => !catalog.has(code)).length;
  if (unnamed > 0) labels.push(`${unnamed} 项其他权限`);
  const suffix = configurableCodes.length > 5 ? "等" : "";
  return [baseline, ...labels].filter(Boolean).join("、") + suffix;
}
