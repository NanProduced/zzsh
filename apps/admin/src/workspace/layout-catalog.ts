import type { WorkspaceTimeRange, WorkspaceWidgetPlacement } from "../api";

export const WORKSPACE_GRID_COLUMNS = 12;
export const WORKSPACE_MAX_WIDGET_H = 12;
export const WORKSPACE_MAX_WIDGET_Y = 48;

/**
 * 组件网格规格与服务端 apps/api/src/auth/admin-workspace-layout.ts 的 WORKSPACE_WIDGET_CATALOG
 * 保持一致：minW/minH 是服务端写入校验的下限，defW/defH 是新增组件的默认尺寸。
 */
export const WORKSPACE_WIDGET_CATALOG = [
  { id: "shortcuts", title: "快捷入口", description: "打开当前权限内的管理入口。", permission: null as string | null, timeBound: false, minW: 4, minH: 3, defW: 6, defH: 4 },
  { id: "account-security", title: "账号安全状态", description: "当前会话、双因素验证与 PIN。", permission: null, timeBound: false, minW: 4, minH: 4, defW: 6, defH: 4 },
  { id: "permission-guide", title: "权限说明", description: "说明当前可见范围，不展示无权数据。", permission: null, timeBound: false, minW: 4, minH: 3, defW: 6, defH: 3 },
  { id: "pending-approvals", title: "审批事项", description: "当前账号可见的最近申请摘要。", permission: "approval.request.read", timeBound: false, minW: 5, minH: 5, defW: 6, defH: 6 },
  { id: "admin-directory", title: "管理员目录", description: "当前可见的管理员账号。", permission: "admin.account.read", timeBound: false, minW: 5, minH: 5, defW: 6, defH: 6 },
  { id: "user-restore", title: "用户账号恢复", description: "搜索并恢复停用用户账号。", permission: "user.account.restore", timeBound: false, minW: 4, minH: 3, defW: 6, defH: 3 },
] as const;

export type WorkspaceWidgetId = (typeof WORKSPACE_WIDGET_CATALOG)[number]["id"];

export function widgetCatalogEntry(id: string) {
  return WORKSPACE_WIDGET_CATALOG.find((item) => item.id === id);
}

export function widgetVisible(id: string, permissions: string[]): boolean {
  const entry = widgetCatalogEntry(id);
  if (!entry) return false;
  if (entry.id === "pending-approvals") {
    return permissions.includes("approval.request.read") || permissions.includes("approval.request.approve");
  }
  return !entry.permission || permissions.includes(entry.permission);
}

export function clonePlacements(widgets: WorkspaceWidgetPlacement[]): WorkspaceWidgetPlacement[] {
  return widgets.map((widget) => ({ ...widget }));
}

export function widgetTimeBound(id: string): boolean {
  return Boolean(widgetCatalogEntry(id)?.timeBound);
}

export function placementsEqual(left: WorkspaceWidgetPlacement[], right: WorkspaceWidgetPlacement[]): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((item) => [item.id, item]));
  return left.every((item) => {
    const other = rightById.get(item.id);
    return other
      && item.x === other.x && item.y === other.y && item.w === other.w && item.h === other.h
      && item.timeRange === other.timeRange;
  });
}

export function normalizeDraft(widgets: WorkspaceWidgetPlacement[]): WorkspaceWidgetPlacement[] {
  return sortPlacementsForList(widgets).map((widget) => ({
    id: widget.id,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
    ...(widget.timeRange ? { timeRange: widget.timeRange as WorkspaceTimeRange } : {}),
  }));
}

/**
 * 把 GridStack 引擎节点读回草稿：只保留目录内组件，时间配置沿用草稿。
 * 读回发生在拖动/缩放或碰撞让位之后，坐标以网格实际状态为准。
 * 注意 GS save() 会压缩等于 minW/minH 的 w/h 字段，缺失时按目录最小尺寸还原。
 */
export function placementsFromGridReadback(
  readback: ReadonlyArray<{ id?: string | number; x?: number; y?: number; w?: number; h?: number; minW?: number; minH?: number }>,
  previous: WorkspaceWidgetPlacement[],
): WorkspaceWidgetPlacement[] {
  const timeRangeById = new Map(previous.map((widget) => [widget.id, widget.timeRange]));
  const result: WorkspaceWidgetPlacement[] = [];
  for (const item of readback) {
    if (item.id === undefined) continue;
    const id = String(item.id);
    const catalog = widgetCatalogEntry(id);
    if (!catalog) continue;
    const { x, y } = item;
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    const w = Number.isInteger(item.w) ? item.w! : (item.minW ?? catalog.minW);
    const h = Number.isInteger(item.h) ? item.h! : (item.minH ?? catalog.minH);
    const timeRange = timeRangeById.get(id);
    result.push({ id, x: x!, y: y!, w, h, ...(timeRange ? { timeRange } : {}) });
  }
  return normalizeDraft(result);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 键盘/菜单替代操作：移动一格，越界钳制。 */
export function movePlacement(widgets: WorkspaceWidgetPlacement[], id: string, dx: number, dy: number): WorkspaceWidgetPlacement[] {
  return widgets.map((widget) => widget.id === id
    ? { ...widget, x: clamp(widget.x + dx, 0, WORKSPACE_GRID_COLUMNS - widget.w), y: clamp(widget.y + dy, 0, WORKSPACE_MAX_WIDGET_Y) }
    : widget);
}

function placementsOverlap(left: WorkspaceWidgetPlacement, right: WorkspaceWidgetPlacement): boolean {
  return left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y;
}

/**
 * 合并网格读回：float:false 的压紧会把“下移”产生的空隙收回。
 * 若目标位置没有和其他组件重叠，保留用户给出的坐标，不把压紧结果写回草稿。
 */
export function mergeGridReadback(
  target: WorkspaceWidgetPlacement[],
  settled: WorkspaceWidgetPlacement[],
): WorkspaceWidgetPlacement[] {
  const settledById = new Map(settled.map((item) => [item.id, item]));
  const merged: WorkspaceWidgetPlacement[] = [];
  for (const widget of target) {
    const next = settledById.get(widget.id);
    if (!next) continue;
    const compactedUp = next.x === widget.x && next.w === widget.w && next.h === widget.h && next.y < widget.y;
    if (compactedUp && !target.some((other) => other.id !== widget.id && placementsOverlap(widget, other))) {
      merged.push(widget);
      continue;
    }
    merged.push(next);
  }
  for (const item of settled) {
    if (!merged.some((widget) => widget.id === item.id)) merged.push(item);
  }
  return normalizeDraft(merged);
}

/** 键盘/菜单替代操作：宽高增减一档，受组件最小尺寸与网格边界约束。 */
export function resizePlacement(widgets: WorkspaceWidgetPlacement[], id: string, dw: number, dh: number): WorkspaceWidgetPlacement[] {
  const catalog = widgetCatalogEntry(id);
  if (!catalog) return widgets;
  return widgets.map((widget) => widget.id === id
    ? {
        ...widget,
        w: clamp(widget.w + dw, catalog.minW, WORKSPACE_GRID_COLUMNS - widget.x),
        h: clamp(widget.h + dh, catalog.minH, WORKSPACE_MAX_WIDGET_H),
      }
    : widget);
}

/** 窄屏降级与稳定展示顺序：按行优先（y 再 x）排序。 */
export function sortPlacementsForList(widgets: WorkspaceWidgetPlacement[]): WorkspaceWidgetPlacement[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** v2 网格坐标的防御校验：旧格式或损坏条目不进入网格渲染。 */
export function isGridPlacement(value: unknown): value is WorkspaceWidgetPlacement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && Number.isInteger(record.x) && Number.isInteger(record.y)
    && Number.isInteger(record.w) && Number.isInteger(record.h)
    && (record.w as number) > 0 && (record.h as number) > 0;
}

export function sanitizeServerWidgets(widgets: unknown): WorkspaceWidgetPlacement[] {
  return Array.isArray(widgets) ? widgets.filter(isGridPlacement) : [];
}

/** 新组件追加到当前布局底部的确定位置。 */
export function appendPlacement(widgets: WorkspaceWidgetPlacement[], id: string): WorkspaceWidgetPlacement {
  const catalog = widgetCatalogEntry(id);
  const bottom = widgets.reduce((max, widget) => Math.max(max, widget.y + widget.h), 0);
  return {
    id,
    x: 0,
    y: bottom,
    w: catalog?.defW ?? 6,
    h: catalog?.defH ?? 4,
  };
}

export function effectiveTimeRange(
  widget: WorkspaceWidgetPlacement,
  pageTime: WorkspaceTimeRange,
): WorkspaceTimeRange {
  return widget.timeRange ?? pageTime;
}
