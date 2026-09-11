import type { Pool } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess, type EffectiveAdminAccess } from "./admin-authorization";
import { SecurityApiError, withTransaction } from "./security-core";

export const WORKSPACE_LAYOUT_KIND = "admin.workspace.layout" as const;
export const WORKSPACE_LAYOUT_LOCK_PREFIX = "zzsh.workspace.layout:";
/**
 * 配置格式版本，与并发更新版本（version 字段）分开演进。
 * 1 = 历史 order + sm/md/lg 档位；2 = 稳定组件 ID + 网格坐标 x/y 与宽高 w/h。
 */
export const WORKSPACE_LAYOUT_FORMAT_VERSION = 2 as const;
export const WORKSPACE_TIME_RANGES = ["today", "7d", "30d"] as const;
/** 历史 v1 尺寸档位，仅用于读取/转换旧配置，不再接受为写入格式的一部分（见 parseWorkspaceLayoutBody 的兼容分支）。 */
export const WORKSPACE_WIDGET_SIZES = ["sm", "md", "lg"] as const;
export const WORKSPACE_GRID_COLUMNS = 12;
export const MAX_WORKSPACE_WIDGETS = 12;
export const MAX_WIDGET_GRID_Y = 48;
export const MAX_WIDGET_GRID_H = 12;
const MAX_WIDGETS_BYTES = 8192;

export type WorkspaceTimeRange = (typeof WORKSPACE_TIME_RANGES)[number];
export type WorkspaceWidgetSize = (typeof WORKSPACE_WIDGET_SIZES)[number];

export type WorkspaceWidgetPlacement = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  timeRange?: WorkspaceTimeRange;
};

export type WorkspaceLayoutPayload = {
  layoutKind: typeof WORKSPACE_LAYOUT_KIND;
  /** 配置格式版本：当前恒为 2；version 字段仍是并发更新版本。 */
  layoutVersion: number;
  version: number;
  widgets: WorkspaceWidgetPlacement[];
  filteredWidgetIds: string[];
  defaults: WorkspaceWidgetPlacement[];
};

type LegacyWorkspaceWidgetPlacement = {
  id: string;
  size: WorkspaceWidgetSize;
  order: number;
  timeRange?: WorkspaceTimeRange;
};

export const WORKSPACE_WIDGET_CATALOG = [
  { id: "shortcuts", title: "快捷入口", permission: null, minW: 4, minH: 3, defW: 6, defH: 4, legacySizes: ["md", "lg"] as const },
  { id: "account-security", title: "账号安全状态", permission: null, minW: 4, minH: 4, defW: 6, defH: 4, legacySizes: ["sm", "md"] as const },
  { id: "permission-guide", title: "权限说明", permission: null, minW: 4, minH: 3, defW: 6, defH: 3, legacySizes: ["sm", "md", "lg"] as const },
  { id: "pending-approvals", title: "待处理审批", permission: ADMIN_PERMISSION.approvalRequestRead, minW: 5, minH: 5, defW: 6, defH: 6, legacySizes: ["md", "lg"] as const },
  { id: "admin-directory", title: "管理员目录", permission: ADMIN_PERMISSION.accountRead, minW: 5, minH: 5, defW: 6, defH: 6, legacySizes: ["md", "lg"] as const },
  { id: "user-restore", title: "用户账号恢复", permission: ADMIN_PERMISSION.userAccountRestore, minW: 4, minH: 3, defW: 6, defH: 3, legacySizes: ["sm", "md"] as const },
] as const;

const WIDGET_BY_ID = new Map<string, (typeof WORKSPACE_WIDGET_CATALOG)[number]>(WORKSPACE_WIDGET_CATALOG.map((item) => [item.id, item]));

/** 历史尺寸档位到网格列宽的确定性映射。 */
const LEGACY_SIZE_WIDTH: Record<WorkspaceWidgetSize, number> = { sm: 4, md: 5, lg: 6 };

function invalid(message: string): never {
  throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message);
}

function isTimeRange(value: unknown): value is WorkspaceTimeRange {
  return typeof value === "string" && (WORKSPACE_TIME_RANGES as readonly string[]).includes(value);
}

function isSize(value: unknown): value is WorkspaceWidgetSize {
  return typeof value === "string" && (WORKSPACE_WIDGET_SIZES as readonly string[]).includes(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function widgetAllowed(access: EffectiveAdminAccess, widgetId: string): boolean {
  const widget = WIDGET_BY_ID.get(widgetId);
  if (!widget) return false;
  if (widget.id === "pending-approvals") {
    return hasPermission(access, ADMIN_PERMISSION.approvalRequestRead) || hasPermission(access, ADMIN_PERMISSION.approvalRequestApprove);
  }
  if (!widget.permission) return true;
  return hasPermission(access, widget.permission);
}

/**
 * 把历史 order+size 配置按固定规则落到网格：按 order 升序从左到右排，放不下的换行，
 * 宽度由尺寸档位映射，高度取组件默认高度。同一输入永远得到同一输出。
 */
export function legacyWidgetsToGrid(widgets: LegacyWorkspaceWidgetPlacement[]): WorkspaceWidgetPlacement[] {
  const sorted = [...widgets].sort((a, b) => a.order - b.order);
  const placed: WorkspaceWidgetPlacement[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const item of sorted) {
    const catalog = WIDGET_BY_ID.get(item.id);
    if (!catalog) continue;
    const w = Math.max(catalog.minW, Math.min(LEGACY_SIZE_WIDTH[item.size] ?? catalog.defW, WORKSPACE_GRID_COLUMNS));
    const h = Math.max(catalog.minH, catalog.defH);
    if (cursorX + w > WORKSPACE_GRID_COLUMNS) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    placed.push({
      id: item.id,
      x: cursorX,
      y: cursorY,
      w,
      h,
      ...(item.timeRange && isTimeRange(item.timeRange) ? { timeRange: item.timeRange } : {}),
    });
    cursorX += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return placed;
}

export function defaultWorkspaceWidgets(access: EffectiveAdminAccess): WorkspaceWidgetPlacement[] {
  const preferred = access.isBoss
    ? ["shortcuts", "pending-approvals", "admin-directory", "account-security"]
    : ["shortcuts", "pending-approvals", "user-restore", "admin-directory", "account-security", "permission-guide"];
  const unique = [...new Set(preferred)].filter((id) => widgetAllowed(access, id));
  if (!unique.includes("account-security")) unique.push("account-security");
  if (!unique.includes("shortcuts")) unique.unshift("shortcuts");
  if (unique.length === 2 && !unique.includes("permission-guide") && widgetAllowed(access, "permission-guide")) {
    unique.push("permission-guide");
  }
  return packDefaultWidgets(unique);
}

/** 默认布局按半行（6 列）成对排列，利用 12 列而不拉伸用户已保存的组件。 */
function packDefaultWidgets(ids: string[]): WorkspaceWidgetPlacement[] {
  const placed: WorkspaceWidgetPlacement[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const id of ids) {
    const catalog = WIDGET_BY_ID.get(id);
    if (!catalog) continue;
    const w = Math.max(catalog.minW, Math.min(catalog.defW, WORKSPACE_GRID_COLUMNS));
    const h = Math.max(catalog.minH, catalog.defH);
    if (x > 0 && x + w > WORKSPACE_GRID_COLUMNS) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    placed.push({ id, x, y, w, h });
    x += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return placed;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 读取路径的宽松规整：丢弃未知/无权/重复组件，坐标尺寸钳制到合法范围，按 y/x 排序。 */
export function sanitizeWorkspaceWidgets(
  widgets: WorkspaceWidgetPlacement[],
  access: EffectiveAdminAccess,
): { widgets: WorkspaceWidgetPlacement[]; filteredWidgetIds: string[] } {
  const seen = new Set<string>();
  const kept: WorkspaceWidgetPlacement[] = [];
  const filteredWidgetIds: string[] = [];
  for (const widget of [...widgets].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (seen.has(widget.id) || !WIDGET_BY_ID.has(widget.id)) {
      filteredWidgetIds.push(widget.id);
      continue;
    }
    if (!widgetAllowed(access, widget.id)) {
      filteredWidgetIds.push(widget.id);
      continue;
    }
    const catalog = WIDGET_BY_ID.get(widget.id)!;
    const w = clampInt(widget.w, catalog.minW, WORKSPACE_GRID_COLUMNS);
    const h = clampInt(widget.h, catalog.minH, MAX_WIDGET_GRID_H);
    const x = clampInt(widget.x, 0, WORKSPACE_GRID_COLUMNS - w);
    const y = clampInt(widget.y, 0, MAX_WIDGET_GRID_Y);
    seen.add(widget.id);
    kept.push({
      id: widget.id,
      x,
      y,
      w,
      h,
      ...(widget.timeRange && isTimeRange(widget.timeRange) ? { timeRange: widget.timeRange } : {}),
    });
  }
  return { widgets: kept, filteredWidgetIds: [...new Set(filteredWidgetIds)] };
}

function parseTimeRangeField(record: Record<string, unknown>): WorkspaceTimeRange | undefined {
  if (record.timeRange === undefined) return undefined;
  if (!isTimeRange(record.timeRange)) invalid("Widget time range is invalid");
  return record.timeRange;
}

function parseGridPlacement(record: Record<string, unknown>): WorkspaceWidgetPlacement {
  const allowed = new Set(["id", "x", "y", "w", "h", "timeRange"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid("Widget placement contains unknown fields");
  }
  if (typeof record.id !== "string" || !WIDGET_BY_ID.has(record.id)) invalid("Unknown workspace widget");
  const catalog = WIDGET_BY_ID.get(record.id)!;
  if (!isInt(record.x) || record.x < 0 || record.x >= WORKSPACE_GRID_COLUMNS) invalid("Widget x is invalid");
  if (!isInt(record.y) || record.y < 0 || record.y > MAX_WIDGET_GRID_Y) invalid("Widget y is invalid");
  if (!isInt(record.w) || record.w < catalog.minW || record.w > WORKSPACE_GRID_COLUMNS) invalid("Widget width is invalid");
  if (!isInt(record.h) || record.h < catalog.minH || record.h > MAX_WIDGET_GRID_H) invalid("Widget height is invalid");
  if (record.x + record.w > WORKSPACE_GRID_COLUMNS) invalid("Widget exceeds grid width");
  const timeRange = parseTimeRangeField(record);
  return { id: record.id, x: record.x, y: record.y, w: record.w, h: record.h, ...(timeRange ? { timeRange } : {}) };
}

function parseLegacyPlacement(record: Record<string, unknown>, index: number): LegacyWorkspaceWidgetPlacement {
  const allowed = new Set(["id", "size", "order", "timeRange"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid("Widget placement contains unknown fields");
  }
  if (typeof record.id !== "string" || !WIDGET_BY_ID.has(record.id)) invalid("Unknown workspace widget");
  if (!isSize(record.size)) invalid("Widget size is invalid");
  if (!isInt(record.order) || record.order < 0 || record.order > MAX_WORKSPACE_WIDGETS) invalid("Widget order is invalid");
  const catalog = WIDGET_BY_ID.get(record.id)!;
  if (!(catalog.legacySizes as readonly string[]).includes(record.size)) invalid("Widget size is not allowed");
  const timeRange = parseTimeRangeField(record);
  return { id: record.id, size: record.size, order: typeof record.order === "number" ? record.order : index, ...(timeRange ? { timeRange } : {}) };
}

function looksLegacy(record: Record<string, unknown>): boolean {
  return record.size !== undefined || record.order !== undefined;
}

export function parseWorkspaceLayoutBody(body: unknown): { version: number; widgets: WorkspaceWidgetPlacement[]; restoreDefault?: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Request body is invalid");
  const record = body as Record<string, unknown>;
  const allowed = new Set(["layoutKind", "layoutVersion", "version", "widgets", "restoreDefault"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid("Request contains unknown fields");
  }
  if (record.layoutKind !== undefined && record.layoutKind !== WORKSPACE_LAYOUT_KIND) invalid("layoutKind is invalid");
  if (record.layoutVersion !== undefined && record.layoutVersion !== 1 && record.layoutVersion !== WORKSPACE_LAYOUT_FORMAT_VERSION) {
    invalid("layoutVersion is invalid");
  }
  if (!Number.isInteger(record.version) || Number(record.version) < 0) invalid("version is invalid");
  if (record.restoreDefault === true) {
    return { version: Number(record.version), widgets: [], restoreDefault: true };
  }
  if (!Array.isArray(record.widgets)) invalid("widgets must be an array");
  if (record.widgets.length > MAX_WORKSPACE_WIDGETS) invalid("Too many widgets");
  const encoded = JSON.stringify(record.widgets);
  if (encoded.length > MAX_WIDGETS_BYTES) invalid("Widget layout is too large");
  const records = record.widgets.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("Widget placement is invalid");
    return item as Record<string, unknown>;
  });
  if (record.layoutVersion === WORKSPACE_LAYOUT_FORMAT_VERSION && records.some(looksLegacy)) invalid("Widget placement is invalid");
  if (record.layoutVersion === 1 && records.some((item) => !looksLegacy(item))) invalid("Widget placement is invalid");
  const legacy = records.some(looksLegacy);
  if (legacy && !records.every(looksLegacy)) invalid("Widget placements mix layout formats");
  const widgets = legacy
    ? legacyWidgetsToGrid(records.map((item, index) => parseLegacyPlacement(item, index)))
    : records.map((item) => parseGridPlacement(item));
  const unique = new Set(widgets.map((item) => item.id));
  if (unique.size !== widgets.length) invalid("Duplicate widget id");
  return { version: Number(record.version), widgets };
}

async function requireAccess(pool: Pool, userId: string): Promise<EffectiveAdminAccess> {
  const access = await loadEffectiveAdminAccess(pool, userId);
  if (!access || access.status !== "ACTIVE") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  }
  return access;
}

function parseStoredWidgets(value: unknown): WorkspaceWidgetPlacement[] {
  if (!Array.isArray(value)) return [];
  const records = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const legacy = records.some(looksLegacy);
  if (legacy) {
    const parsed: LegacyWorkspaceWidgetPlacement[] = [];
    for (const [index, record] of records.entries()) {
      try {
        parsed.push(parseLegacyPlacement(record, index));
      } catch {
        // 单条损坏的旧数据不阻断整个布局读取。
      }
    }
    return legacyWidgetsToGrid(parsed);
  }
  const parsed: WorkspaceWidgetPlacement[] = [];
  for (const record of records) {
    try {
      parsed.push(parseGridPlacement(record));
    } catch {
      // 单条损坏的数据不阻断整个布局读取。
    }
  }
  return parsed;
}

export async function getWorkspaceLayout(pool: Pool, userId: string): Promise<WorkspaceLayoutPayload> {
  const access = await requireAccess(pool, userId);
  const defaults = defaultWorkspaceWidgets(access);
  const row = await pool.query<{ version: number; widgets: unknown }>(
    `SELECT "version", "widgets" FROM "zzsh_iam"."admin_workspace_layout" WHERE "admin_user_id" = $1 AND "layout_kind" = $2`,
    [userId, WORKSPACE_LAYOUT_KIND],
  );
  if (!row.rows[0]) {
    return { layoutKind: WORKSPACE_LAYOUT_KIND, layoutVersion: WORKSPACE_LAYOUT_FORMAT_VERSION, version: 0, widgets: defaults, filteredWidgetIds: [], defaults };
  }
  const sanitized = sanitizeWorkspaceWidgets(parseStoredWidgets(row.rows[0].widgets), access);
  return {
    layoutKind: WORKSPACE_LAYOUT_KIND,
    layoutVersion: WORKSPACE_LAYOUT_FORMAT_VERSION,
    version: row.rows[0].version,
    widgets: sanitized.widgets.length > 0 ? sanitized.widgets : defaults,
    filteredWidgetIds: sanitized.filteredWidgetIds,
    defaults,
  };
}

export async function saveWorkspaceLayout(pool: Pool, userId: string, body: unknown): Promise<WorkspaceLayoutPayload> {
  const access = await requireAccess(pool, userId);
  const parsed = parseWorkspaceLayoutBody(body);
  const defaults = defaultWorkspaceWidgets(access);
  const nextWidgets = parsed.restoreDefault ? defaults : sanitizeWorkspaceWidgets(parsed.widgets, access).widgets;
  if (!parsed.restoreDefault) {
    for (const widget of parsed.widgets) {
      if (!widgetAllowed(access, widget.id)) {
        throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
      }
    }
  }
  const nextVersion = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${WORKSPACE_LAYOUT_LOCK_PREFIX}${userId}`]);
    const written = await client.query<{ version: number }>(
      `INSERT INTO "zzsh_iam"."admin_workspace_layout" ("admin_user_id", "layout_kind", "version", "widgets", "updated_at")
       SELECT $1, $2, $3, $4::jsonb, clock_timestamp()
       WHERE $3::integer = 1 OR EXISTS (
         SELECT 1 FROM "zzsh_iam"."admin_workspace_layout" WHERE "admin_user_id" = $1
       )
       ON CONFLICT ("admin_user_id") DO UPDATE
         SET "version" = EXCLUDED."version",
             "widgets" = EXCLUDED."widgets",
             "updated_at" = clock_timestamp()
       WHERE "zzsh_iam"."admin_workspace_layout"."version" = EXCLUDED."version" - 1
       RETURNING "version"`,
      [userId, WORKSPACE_LAYOUT_KIND, parsed.version + 1, JSON.stringify(nextWidgets)],
    );
    if (written.rowCount !== 1 || written.rows[0] === undefined) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Workspace layout version conflict");
    }
    return written.rows[0].version;
  });
  return {
    layoutKind: WORKSPACE_LAYOUT_KIND,
    layoutVersion: WORKSPACE_LAYOUT_FORMAT_VERSION,
    version: nextVersion,
    widgets: nextWidgets,
    filteredWidgetIds: [],
    defaults,
  };
}
