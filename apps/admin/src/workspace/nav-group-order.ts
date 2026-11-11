import {
  NAV_FIXED_FIRST_GROUP_ID,
  NAV_FIXED_LAST_GROUP_ID,
  NAV_GROUP_DEFAULT_ORDER,
  type WorkspaceMenuItem,
} from "./nav-config.ts";

/**
 * 侧栏分组顺序：纯规则 + 浏览器本地存储，不依赖网络、权限接口或后端迁移。
 * 菜单仍是扁平数组；这里按「分组标题 + 跟随的页面」切片再拼回，因此
 * workspaceMenuItems 的权限过滤、页面搜索和审批角标都不需要改动。
 */

export type NavGroup = {
  id: string;
  label: string;
  /** 含标题项本身，顺序与菜单一致。 */
  items: WorkspaceMenuItem[];
};

const STORAGE_PREFIX = "zzsh.admin.navGroupOrder.v1:";
/** 同一标签页内，侧栏编辑态与设置页面板互相同步。 */
export const NAV_GROUP_ORDER_EVENT = "zzsh:admin-nav-group-order-changed";

export function splitNavGroups(items: readonly WorkspaceMenuItem[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of items) {
    if (item.isTitle) {
      groups.push({ id: item.groupId ?? item.label, label: item.label, items: [item] });
    } else if (groups.length > 0) {
      groups[groups.length - 1]!.items.push(item);
    } else {
      // 首个菜单项按约定一定是分组标题；保底自成一组，绝不丢入口。
      groups.push({ id: "__ungrouped__", label: "", items: [item] });
    }
  }
  return groups;
}

/**
 * 用「默认槽位」合并已保存顺序：
 * - 已保存且当前可见的分组，按保存顺序依次占据原本属于「已保存分组」的槽位；
 * - 保存后新增、或当时无权限没保存过的分组，留在自己的默认槽位附近；
 * - 当前无权限而隐藏的分组只从可见列表里消失，ID 仍留在已保存顺序中，恢复权限后回到原位；
 * - 不认识的 ID 直接忽略；保存数据损坏时按默认顺序显示。
 */
export function orderNavGroups(
  items: readonly WorkspaceMenuItem[],
  savedOrder: readonly string[] | null,
): WorkspaceMenuItem[] {
  const groups = splitNavGroups(items);
  if (groups.length < 3 || !savedOrder || savedOrder.length === 0) return [...items];

  const firstIndex = groups.findIndex((group) => group.id === NAV_FIXED_FIRST_GROUP_ID);
  const lastIndex = groups.findIndex((group) => group.id === NAV_FIXED_LAST_GROUP_ID);
  const leadingCount = firstIndex >= 0 ? firstIndex + 1 : 0;
  const trailingCount = lastIndex > firstIndex ? groups.length - lastIndex : 0;
  const leading = groups.slice(0, leadingCount);
  const trailing = trailingCount > 0 ? groups.slice(groups.length - trailingCount) : [];
  const middle = groups.slice(leadingCount, groups.length - trailingCount);
  if (middle.length < 2) return [...items];

  const byId = new Map(middle.map((group) => [group.id, group]));
  const defaultIndex = new Map(middle.map((group, index) => [group.id, index]));
  const seen = new Set<string>();
  const savedVisible: string[] = [];
  for (const id of savedOrder) {
    if (typeof id !== "string" || !byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    savedVisible.push(id);
  }
  if (!savedVisible.length) return [...items];

  // 已保存的分组严格按保存顺序排列；之后上线、或当时未登记的新分组，
  // 按默认顺序锚定到「默认位置在它之前且当前可见」的最后一个分组之后。
  // 用户把某组提到最前时，默认索引不再递增，锚定邻居比按索引找插入点更稳定。
  const orderedIds = [...savedVisible];
  const placed = new Set(orderedIds);
  for (const group of middle) {
    if (seen.has(group.id)) continue;
    const at = defaultIndex.get(group.id)!;
    let insertAt = 0;
    for (let index = at - 1; index >= 0; index -= 1) {
      const candidate = middle[index]!.id;
      if (placed.has(candidate)) { insertAt = orderedIds.indexOf(candidate) + 1; break; }
    }
    orderedIds.splice(insertAt, 0, group.id);
    placed.add(group.id);
  }
  const reordered = orderedIds.map((id) => byId.get(id)!);
  return [...leading, ...reordered, ...trailing].flatMap((group) => group.items);
}

/** 允许出现在已保存顺序里的 ID；未知 ID 被丢弃，缺失的分组留给默认槽位。 */
export function sanitizeNavGroupOrder(value: readonly string[] | null): string[] {
  if (!value) return [...NAV_GROUP_DEFAULT_ORDER];
  const known = new Set<string>(NAV_GROUP_DEFAULT_ORDER);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 在完整顺序里，把某个分组与相邻的「当前可见」分组交换；隐藏分组不参与点击。 */
export function moveVisibleNavGroup(
  fullOrder: readonly string[],
  visibleIds: readonly string[],
  id: string,
  delta: -1 | 1,
): string[] {
  const visibleIndex = visibleIds.indexOf(id);
  const neighbour = visibleIndex >= 0 ? visibleIds[visibleIndex + delta] : undefined;
  if (neighbour === undefined) return [...fullOrder];
  const next = [...fullOrder];
  const from = next.indexOf(id);
  const to = next.indexOf(neighbour);
  if (from < 0 || to < 0) return [...fullOrder];
  next[from] = neighbour;
  next[to] = id;
  return next;
}

export function movableNavGroupIds(items: readonly WorkspaceMenuItem[]): string[] {
  const all = splitNavGroups(items).map((group) => group.id);
  const first = all.indexOf(NAV_FIXED_FIRST_GROUP_ID);
  const last = all.indexOf(NAV_FIXED_LAST_GROUP_ID);
  return all.slice(first + 1, last < 0 ? all.length : last);
}

function keyFor(adminUserId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(adminUserId)}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 返回完整顺序（含当前无权限的分组 ID）；读到损坏内容时按默认顺序，不抛错。 */
export function readNavGroupOrder(adminUserId: string): string[] {
  if (!adminUserId) return [...NAV_GROUP_DEFAULT_ORDER];
  const store = storage();
  if (!store) return [...NAV_GROUP_DEFAULT_ORDER];
  try {
    const raw = store.getItem(keyFor(adminUserId));
    if (raw === null) return [...NAV_GROUP_DEFAULT_ORDER];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 128 || !parsed.every((id) => typeof id === "string" && id.length <= 64)) {
      return [...NAV_GROUP_DEFAULT_ORDER];
    }
    return sanitizeNavGroupOrder(parsed as string[]);
  } catch {
    return [...NAV_GROUP_DEFAULT_ORDER];
  }
}

export function writeNavGroupOrder(adminUserId: string, order: readonly string[]): boolean {
  if (!adminUserId) return false;
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(keyFor(adminUserId), JSON.stringify(sanitizeNavGroupOrder(order)));
    return true;
  } catch {
    return false;
  }
}

export function clearNavGroupOrder(adminUserId: string): void {
  if (!adminUserId) return;
  try {
    storage()?.removeItem(keyFor(adminUserId));
  } catch {
    // 存储不可用时保持当前显示；下次读取会按默认顺序处理。
  }
}

export function notifyNavGroupOrderChanged(): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(NAV_GROUP_ORDER_EVENT));
  } catch {
    // 事件只是同页同步，不影响已写入的顺序。
  }
}
