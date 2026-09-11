import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ArrowUpRightIcon, CheckCheckIcon, GripVerticalIcon, MoreHorizontalIcon, PlusIcon, ShieldCheckIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { GridStack, useGridStack } from "gridstack/dist/react";
import type { GridStackWidget as ReactGridStackWidget } from "gridstack/dist/react";
import type { GridStack as GridStackInstance } from "gridstack";
import "gridstack/dist/gridstack.min.css";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSidebar } from "@/components/ui/sidebar";
import {
  adminRequest,
  friendlyError,
  formatDate,
  hasPermission,
  type AdminDirectoryEntry,
  type SessionSnapshot,
  type WorkspaceLayoutPayload,
  type WorkspaceTimeRange,
  type WorkspaceWidgetPlacement,
} from "../api";
import { StatusMessage } from "../components/ui-elements";

import { timeRangeLabel } from "./beijing-time";
import { listWasTruncated, previewItems } from "./truncated-list";
import { keepDraftOnConflict, reloadFromConflict, type LayoutEditorState } from "./layout-conflict";
import {
  WORKSPACE_GRID_COLUMNS,
  WORKSPACE_WIDGET_CATALOG,
  appendPlacement,
  clonePlacements,
  effectiveTimeRange,
  mergeGridReadback,
  movePlacement,
  normalizeDraft,
  placementsEqual,
  placementsFromGridReadback,
  resizePlacement,
  sanitizeServerWidgets,
  sortPlacementsForList,
  widgetCatalogEntry,
  widgetTimeBound,
  widgetVisible,
} from "./layout-catalog";

type ApprovalSummary = { requestId: string; summary: string; status: string; createdAt: string | null };

function ShortcutsWidget({ snapshot, onNavigate }: { snapshot: Extract<SessionSnapshot, { authenticated: true }>; onNavigate: (path: string) => void }) {
  const items = [
    { path: "/account", label: "账号安全", show: true },
    { path: "/admins", label: "管理员", show: hasPermission(snapshot, "admin.account.read") || snapshot.security.isBoss },
    { path: "/roles", label: "角色权限", show: hasPermission(snapshot, "admin.role.read") || hasPermission(snapshot, "admin.permission.read") },
    { path: "/approvals", label: "审批", show: ["approval.request.read", "approval.request.approve", "approval.template.read", "approval.audit.read"].some((code) => hasPermission(snapshot, code)) },
    { path: "/audit", label: "账号与权限审计", show: hasPermission(snapshot, "admin.audit.read") },
    { path: "/users/restore", label: "用户账号恢复", show: hasPermission(snapshot, "user.account.restore") },
  ].filter((item) => item.show);
  return (
    <div className="workbench-shortcuts">
      {items.map((item) => (
        <Button key={item.path} type="button" variant="ghost" onClick={() => onNavigate(item.path)}>{item.label}<ArrowUpRightIcon className="ml-auto size-4 text-muted-foreground" /></Button>
      ))}
    </div>
  );
}

function AccountSecurityWidget({ snapshot, onNavigate }: { snapshot: Extract<SessionSnapshot, { authenticated: true }>; onNavigate: (path: string) => void }) {
  return (
    <div className="space-y-4">
      {/* Adapted from PaceUI widget-5: compact status rows and one footer action. */}
      <div className="workbench-status-row"><ShieldCheckIcon /><span>双因素验证</span><Badge variant="secondary">{snapshot.user.twoFactorEnabled ? "已启用" : "待完成"}</Badge></div>
      <div className="workbench-status-row"><KeyRoundIcon /><span>会话 PIN</span><Badge variant="outline">{snapshot.session.pinConfigured ? "已配置" : "未配置"}</Badge></div>
      <p className="text-sm text-muted-foreground">会话到期 · {formatDate(snapshot.session.expiresAt)}</p>
      <Button variant="outline" size="sm" onClick={() => onNavigate("/account")}>管理账号安全<ArrowUpRightIcon /></Button>
    </div>
  );
}

function PermissionGuideWidget({ snapshot }: { snapshot: Extract<SessionSnapshot, { authenticated: true }> }) {
  if (snapshot.permissions.length === 0 && !snapshot.security.isBoss) {
    return <p className="text-sm text-muted-foreground">当前账号没有业务操作权限。仍可管理个人账号安全；需要处理业务时请联系获授权的管理员。</p>;
  }
  return (
    <div className="space-y-2 text-sm">
      <p>工作台展示你的可用入口和处理事项。需要其他权限时，请联系获授权的管理员。</p>
      <p className="text-muted-foreground text-xs">当前可见权限 {snapshot.permissions.length} 项{snapshot.security.isBoss ? "（同级 Boss 持有全部已登记操作权限）" : ""}。</p>
    </div>
  );
}

const APPROVAL_FETCH_LIMIT = 20;
const APPROVAL_DISPLAY_LIMIT = 8;

function ApprovalInboxWidget({
  snapshot,
  onNavigate,
  refreshNonce,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onNavigate: (path: string) => void;
  refreshNonce: number;
}) {
  const canApprove = hasPermission(snapshot, "approval.request.approve");
  const canRead = hasPermission(snapshot, "approval.request.read") || canApprove;
  const [items, setItems] = useState<ApprovalSummary[]>();
  const [error, setError] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) return;
    const path = canApprove
      ? `/security/approvals/requests/pending?limit=${APPROVAL_FETCH_LIMIT}`
      : `/security/approvals/requests/mine?limit=${APPROVAL_FETCH_LIMIT}`;
    const result = await adminRequest<{ requests?: ApprovalSummary[] }>(path);
    setItems(result.requests ?? []);
    setError(undefined);
    setLoadFailed(false);
  }, [canApprove, canRead]);

  useEffect(() => {
    void load().catch((failure) => {
      setError(friendlyError(failure));
      setLoadFailed(true);
    });
  }, [load, refreshNonce]);

  if (error) {
    return (
      <div className="space-y-2">
        <StatusMessage error={error} />
        {loadFailed ? <Button type="button" size="sm" variant="outline" onClick={() => void load().catch((failure) => setError(friendlyError(failure)))}>重试</Button> : null}
      </div>
    );
  }
  if (!items) return <p className="text-xs text-muted-foreground">正在读取申请…</p>;
  const visible = previewItems(items, APPROVAL_DISPLAY_LIMIT);
  const truncated = listWasTruncated(items.length, APPROVAL_FETCH_LIMIT) || items.length > APPROVAL_DISPLAY_LIMIT;
  if (visible.length === 0) {
    return (
      <div className="workbench-empty">
        <CheckCheckIcon className="size-7 text-muted-foreground" />
        <strong>{canApprove ? "暂无待处理申请" : "暂无已提交申请"}</strong>
        <p>可在审批列表查看申请记录与处理状态。</p>
        <Button type="button" variant="outline" size="sm" onClick={() => onNavigate("/approvals")}>查看审批<ArrowUpRightIcon /></Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-2 text-sm">
        {visible.map((item) => (
          <li key={item.requestId} className="workbench-approval-row">
            <button type="button" className="text-left hover:underline" onClick={() => onNavigate(`/approvals/${encodeURIComponent(item.requestId)}`)}>
              {item.summary}
            </button>
            <p className="text-sm text-muted-foreground"><Badge variant="secondary">{({ PENDING: "待审批", APPROVED: "已批准", REJECTED: "已拒绝", EXECUTED: "已执行", EXPIRED: "已过期", CANCELLED: "已取消", FAILED: "执行失败" } as Record<string, string>)[item.status] ?? "状态待确认"}</Badge> · {formatDate(item.createdAt)}</p>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {canApprove ? "显示最近待你审批的申请。" : "显示你最近提交的申请。"}
        {truncated ? " 这是摘要，不是按时间范围筛完的完整结果。" : ""}
        完整列表请打开审批。
      </p>
    </div>
  );
}

function AdminDirectoryWidget({
  onNavigate,
  refreshNonce,
}: {
  onNavigate: (path: string) => void;
  refreshNonce: number;
}) {
  const [items, setItems] = useState<AdminDirectoryEntry[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const result = await adminRequest<{ admins?: AdminDirectoryEntry[] }>("/security/admins");
    setItems((result.admins ?? []).slice(0, 8));
    setError(undefined);
  }, []);
  useEffect(() => {
    void load().catch((failure) => setError(friendlyError(failure)));
  }, [load, refreshNonce]);
  if (error) {
    return (
      <div className="space-y-2">
        <StatusMessage error={error} />
        <Button type="button" size="sm" variant="outline" onClick={() => void load().catch((failure) => setError(friendlyError(failure)))}>重试</Button>
      </div>
    );
  }
  if (!items) return <p className="text-xs text-muted-foreground">正在读取管理员目录…</p>;
  if (items.length === 0) return <p className="text-xs text-muted-foreground">没有可显示的管理员。</p>;
  return (
    <Table>
      <TableHeader><TableRow className="bg-muted/60"><TableHead>管理员</TableHead><TableHead className="text-right">状态</TableHead></TableRow></TableHeader>
      <TableBody>
      {items.map((item) => (
        <TableRow key={item.id}>
          <TableCell><button type="button" className="flex items-center gap-3 text-left hover:underline" onClick={() => onNavigate(`/admins/${encodeURIComponent(item.username)}`)}>
            <Avatar className="size-9"><AvatarFallback>{item.name.slice(0, 1)}</AvatarFallback></Avatar>
            <span className="flex flex-col"><span className="font-medium">{item.name}</span><span className="text-muted-foreground text-xs">{item.username}</span></span>
          </button></TableCell>
          <TableCell className="text-right"><Badge variant={item.status === "FROZEN" ? "destructive" : "secondary"}>{item.status === "ACTIVE" ? "正常" : item.status === "FROZEN" ? "冻结" : "待激活"}</Badge></TableCell>
        </TableRow>
      ))}
      </TableBody>
    </Table>
  );
}

function UserRestoreWidget({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">搜索停用账号并恢复为可用。不会恢复旧会话或验证凭据。</p>
      <Button type="button" size="sm" variant="outline" onClick={() => onNavigate("/users/restore")}>打开账号恢复</Button>
    </div>
  );
}

function WidgetBody({
  id,
  snapshot,
  onNavigate,
  refreshNonce,
}: {
  id: string;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onNavigate: (path: string) => void;
  refreshNonce: number;
}) {
  if (id === "shortcuts") return <ShortcutsWidget snapshot={snapshot} onNavigate={onNavigate} />;
  if (id === "account-security") return <AccountSecurityWidget snapshot={snapshot} onNavigate={onNavigate} />;
  if (id === "permission-guide") return <PermissionGuideWidget snapshot={snapshot} />;
  if (id === "pending-approvals") return <ApprovalInboxWidget snapshot={snapshot} onNavigate={onNavigate} refreshNonce={refreshNonce} />;
  if (id === "admin-directory") return <AdminDirectoryWidget onNavigate={onNavigate} refreshNonce={refreshNonce} />;
  if (id === "user-restore") return <UserRestoreWidget onNavigate={onNavigate} />;
  return <p className="text-xs text-muted-foreground">未知组件已被过滤。</p>;
}

function approvalInboxTitle(snapshot: Extract<SessionSnapshot, { authenticated: true }>): string {
  return hasPermission(snapshot, "approval.request.approve") ? "待我审批" : "我提交的申请";
}

type WorkbenchCardsContextValue = {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  widgets: WorkspaceWidgetPlacement[];
  editing: boolean;
  /** 窄屏降级只读展示，不提供编辑菜单（拖动/缩放与菜单调整只在桌面网格内可用）。 */
  interactiveEdit: boolean;
  pageTime: WorkspaceTimeRange;
  refreshNonce: number;
  onNavigate: (path: string) => void;
  onMoveWidget: (id: string, dx: number, dy: number) => void;
  onResizeWidget: (id: string, dw: number, dh: number) => void;
  onRemoveWidget: (id: string) => void;
  onWidgetTimeRange: (id: string, range: WorkspaceTimeRange | undefined) => void;
  announce: (text: string) => void;
};

const WorkbenchCardsContext = createContext<WorkbenchCardsContextValue | null>(null);

function useWorkbenchCards(): WorkbenchCardsContextValue {
  const ctx = useContext(WorkbenchCardsContext);
  if (!ctx) throw new Error("workbench card rendered outside of its context");
  return ctx;
}

function WidgetCardFrame({ widget }: { widget: WorkspaceWidgetPlacement }) {
  const ctx = useWorkbenchCards();
  const { snapshot, editing, interactiveEdit, pageTime, refreshNonce, onNavigate } = ctx;
  const catalog = widgetCatalogEntry(widget.id);
  const timeBound = widgetTimeBound(widget.id);
  const time = effectiveTimeRange(widget, pageTime);
  const title = widget.id === "pending-approvals" ? approvalInboxTitle(snapshot) : (catalog?.title ?? widget.id);
  const menu = (label: string, action: () => void, disabled = false, icon?: ReactNode) => (
    <DropdownMenuItem key={label} disabled={disabled} onClick={action}>{icon}{label}</DropdownMenuItem>
  );
  return (
    <Card className="workbench-card" data-widget={widget.id}>
      <CardHeader className="workbench-card-heading">
        <div className="workbench-drag-handle min-w-0">
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {catalog?.description}
            {timeBound ? ` · ${widget.timeRange ? timeRangeLabel(time) : `跟随全局 · ${timeRangeLabel(pageTime)}`}` : null}
          </CardDescription>
        </div>
        <div className="workbench-card-actions">
          {/* 拖拽手柄始终挂载：GridStack 在内容首次渲染后扫描并绑定手柄，切换编辑态只翻转 disableDrag，不重扫 DOM。 */}
          <span className="workbench-drag-handle workbench-grip" aria-hidden="true"><GripVerticalIcon className="size-4" /></span>
          {editing ? <>
            {interactiveEdit ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label={`调整 ${title}`}><MoreHorizontalIcon /></Button>} />
                <DropdownMenuContent align="end" className="w-44">
                  {menu("左移", () => { ctx.onMoveWidget(widget.id, -1, 0); ctx.announce(`${title}已左移`); }, widget.x === 0, <ArrowLeftIcon />)}
                  {menu("右移", () => { ctx.onMoveWidget(widget.id, 1, 0); ctx.announce(`${title}已右移`); }, widget.x + widget.w >= WORKSPACE_GRID_COLUMNS, <ArrowRightIcon />)}
                  {menu("上移", () => { ctx.onMoveWidget(widget.id, 0, -1); ctx.announce(`${title}已上移`); }, widget.y === 0, <ArrowUpIcon />)}
                  {menu("下移", () => { ctx.onMoveWidget(widget.id, 0, 1); ctx.announce(`${title}已下移`); }, false, <ArrowDownIcon />)}
                  <DropdownMenuSeparator />
                  {menu("加宽", () => { ctx.onResizeWidget(widget.id, 1, 0); ctx.announce(`${title}已加宽`); }, widget.x + widget.w >= WORKSPACE_GRID_COLUMNS && widget.w >= WORKSPACE_GRID_COLUMNS - widget.x)}
                  {menu("减宽", () => { ctx.onResizeWidget(widget.id, -1, 0); ctx.announce(`${title}已减宽`); }, widget.w <= (catalog?.minW ?? 1))}
                  {menu("加高", () => { ctx.onResizeWidget(widget.id, 0, 1); ctx.announce(`${title}已加高`); })}
                  {menu("减低", () => { ctx.onResizeWidget(widget.id, 0, -1); ctx.announce(`${title}已减低`); }, widget.h <= (catalog?.minH ?? 1))}
                  {timeBound ? <>
                    <DropdownMenuSeparator />
                    {(["inherit", "today", "7d", "30d"] as const).map((range) => (
                      <DropdownMenuItem key={range} onClick={() => ctx.onWidgetTimeRange(widget.id, range === "inherit" ? undefined : range)}>
                        {range === "inherit" ? "跟随全局时间" : timeRangeLabel(range)}{range === "inherit" && !widget.timeRange ? " · 当前" : range === widget.timeRange ? " · 当前" : ""}
                      </DropdownMenuItem>
                    ))}
                  </> : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => { ctx.onRemoveWidget(widget.id); ctx.announce(`已移除${title}`); }}><XIcon />移除组件</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </> : (widget.id === "admin-directory" || widget.id === "pending-approvals") ? <Button variant="ghost" size="icon-sm" aria-label={`查看${title}`} onClick={() => onNavigate(widget.id === "admin-directory" ? "/admins" : "/approvals")}><ArrowUpRightIcon /></Button> : null}
        </div>
      </CardHeader>
      <CardContent className="workbench-card-body space-y-3">
        <WidgetBody id={widget.id} snapshot={snapshot} onNavigate={onNavigate} refreshNonce={refreshNonce} />
      </CardContent>
    </Card>
  );
}

/** GridStack component 模式入口：props 只带稳定组件 ID，业务数据全部走 React context，避免 GS 序列化携带业务状态。 */
function GridWidgetCard(props: Record<string, unknown>) {
  const ctx = useContext(WorkbenchCardsContext);
  const id = String(props.widgetId ?? "");
  const widget = ctx?.widgets.find((item) => item.id === id);
  if (!ctx || !widget) return null;
  return <WidgetCardFrame widget={widget} />;
}

const GRID_COMPONENTS = { card: GridWidgetCard };

const GRID_CELL_HEIGHT = 72;

/**
 * 把目标草稿同步到网格：只增删/更新有差异的项，位置与碰撞由 GridStack 引擎负责。
 * 返回网格收敛后的实际布局（碰撞让位可能与目标不同）。
 */
function applyPlacementsToGrid(grid: GridStackInstance, target: WorkspaceWidgetPlacement[]): void {
  const nodes = [...(grid.engine?.nodes ?? [])];
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const keep = new Set(target.map((widget) => widget.id));
  for (const node of nodes) {
    if (node.el && !keep.has(String(node.id))) grid.removeWidget(node.el);
  }
  for (const widget of target) {
    const catalog = widgetCatalogEntry(widget.id);
    if (!catalog) continue;
    const node = byId.get(widget.id);
    if (!node?.el) {
      const addition: ReactGridStackWidget = {
        id: widget.id,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        minW: catalog.minW,
        minH: catalog.minH,
        maxW: WORKSPACE_GRID_COLUMNS,
        component: "card",
        props: { widgetId: widget.id },
      };
      grid.addWidget(addition);
    } else if (node.x !== widget.x || node.y !== widget.y || node.w !== widget.w || node.h !== widget.h) {
      grid.update(node.el, { x: widget.x, y: widget.y, w: widget.w, h: widget.h });
    }
  }
}

/**
 * GridStack 与 React 草稿之间的桥：目标变化时做最小化同步并读回引擎实际结果；
 * 拖动/缩放结束时把网格状态写回草稿。组件内容经官方 React 包装器的 portal 渲染，移动不丢状态。
 */
function GridBridge({
  target,
  applyingRef,
  gridRef,
  onPositionsSettled,
}: {
  target: WorkspaceWidgetPlacement[];
  applyingRef: { current: boolean };
  gridRef: { current: GridStackInstance | null };
  onPositionsSettled: (next: WorkspaceWidgetPlacement[]) => void;
}) {
  const { grid } = useGridStack();
  useEffect(() => {
    if (!grid) return;
    gridRef.current = grid;
    grid.float(true);
  }, [grid, gridRef]);
  useEffect(() => {
    if (!grid) return;
    applyingRef.current = true;
    try {
      applyPlacementsToGrid(grid, target);
      const settled = mergeGridReadback(target, placementsFromGridReadback(grid.engine?.nodes ?? [], target));
      if (!placementsEqual(settled, target)) onPositionsSettled(settled);
    } finally {
      applyingRef.current = false;
    }
  }, [grid, target, applyingRef, onPositionsSettled]);
  return null;
}

function WorkbenchGrid({
  placements,
  editing,
  onPositionsChange,
  announce,
}: {
  placements: WorkspaceWidgetPlacement[];
  editing: boolean;
  onPositionsChange: (next: WorkspaceWidgetPlacement[]) => void;
  announce: (text: string) => void;
}) {
  const applyingRef = useRef(false);
  const gridRef = useRef<GridStackInstance | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const targetRef = useRef(placements);
  targetRef.current = placements;
  const { state: sidebarState } = useSidebar();

  // options 不携带 children：初始装载与后续增删都经 GridBridge 显式同步，
  // 避免 updateOptions 整表 reload 造成组件状态丢失；编辑开关只切换拖拽/缩放使能。
  // float:true 保留键盘下移产生的空隙，避免压紧把操作抵消。
  const options = useMemo(() => ({
    column: WORKSPACE_GRID_COLUMNS,
    cellHeight: GRID_CELL_HEIGHT,
    margin: 10,
    float: true,
    disableDrag: !editing,
    disableResize: !editing,
    // 常开：查看态由 ui-resizable-disabled 隐藏手柄，避免依赖 updateOptions 热更新该选项。
    alwaysShowResizeHandle: true,
    draggable: { handle: ".workbench-drag-handle" },
    resizable: { handles: "se" },
  }), [editing]);

  const remeasureGrid = useCallback(() => {
    gridRef.current?.onResize();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => remeasureGrid());
    observer.observe(host);
    return () => observer.disconnect();
  }, [remeasureGrid]);

  useEffect(() => {
    const id = window.setTimeout(remeasureGrid, 220);
    return () => window.clearTimeout(id);
  }, [remeasureGrid, sidebarState]);

  const readbackFromGrid = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || applyingRef.current || !editingRef.current) return;
    const next = mergeGridReadback(targetRef.current, placementsFromGridReadback(grid.engine?.nodes ?? [], targetRef.current));
    if (!placementsEqual(next, targetRef.current)) onPositionsChange(next);
  }, [onPositionsChange]);

  const handleDragStop = useCallback(() => {
    readbackFromGrid();
    announce("位置已调整，保存后生效。");
  }, [announce, readbackFromGrid]);

  const handleResizeStop = useCallback(() => {
    readbackFromGrid();
    announce("尺寸已调整，保存后生效。");
  }, [announce, readbackFromGrid]);

  return (
    <div ref={hostRef} className="workbench-grid-host">
      <GridStack
        options={options}
        components={GRID_COMPONENTS}
        className={editing ? "workbench-grid workbench-grid-editing" : "workbench-grid"}
        onChange={readbackFromGrid}
        onDragStop={handleDragStop}
        onResizeStop={handleResizeStop}
      >
        <GridBridge target={placements} applyingRef={applyingRef} gridRef={gridRef} onPositionsSettled={onPositionsChange} />
      </GridStack>
    </div>
  );
}

function useNarrowWorkbench(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function WorkbenchPage({
  snapshot,
  onNavigate,
  onDirtyChange,
  refreshNonce,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  onNavigate: (path: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  refreshNonce: number;
}) {
  const [layout, setLayout] = useState<WorkspaceLayoutPayload>();
  const [draft, setDraft] = useState<WorkspaceWidgetPlacement[]>();
  const [editing, setEditing] = useState(false);
  const [pageTime, setPageTime] = useState<WorkspaceTimeRange>("today");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState<WorkspaceLayoutPayload>();
  const [announcement, setAnnouncement] = useState("");
  const narrow = useNarrowWorkbench();
  const editingRef = useRef(false);
  editingRef.current = editing;

  const fetchLayout = useCallback(async () => {
    return adminRequest<WorkspaceLayoutPayload>("/workspace/layout");
  }, []);

  const applyFetched = useCallback((next: WorkspaceLayoutPayload, replaceDraft: boolean) => {
    const safe = { ...next, widgets: sanitizeServerWidgets(next.widgets), defaults: sanitizeServerWidgets(next.defaults) };
    setLayout(safe);
    if (replaceDraft) {
      setDraft(clonePlacements(safe.widgets));
      setConflict(undefined);
    }
  }, []);

  const load = useCallback(async (replaceDraft = true) => {
    const next = await fetchLayout();
    applyFetched(next, replaceDraft);
    return next;
  }, [applyFetched, fetchLayout]);

  useEffect(() => {
    void load(!editingRef.current).catch((failure) => setError(friendlyError(failure)));
  }, [load, refreshNonce]);

  const saved = layout?.widgets ?? [];
  const widgets = editing ? (draft ?? saved) : saved;
  const addable = useMemo(
    () => WORKSPACE_WIDGET_CATALOG.filter((item) => widgetVisible(item.id, snapshot.permissions) && !widgets.some((widget) => widget.id === item.id)),
    [snapshot.permissions, widgets],
  );
  const hasTimeBound = widgets.some((widget) => widgetTimeBound(widget.id));
  const canApprove = hasPermission(snapshot, "approval.request.approve");

  useEffect(() => {
    const dirty = editing && !placementsEqual(normalizeDraft(draft ?? saved), normalizeDraft(saved));
    onDirtyChange?.(dirty);
  }, [draft, editing, onDirtyChange, saved]);

  const editorState = (): LayoutEditorState | undefined => {
    if (!layout) return undefined;
    return { layout, draft: draft ?? layout.widgets, editing, conflict };
  };

  const save = async (restoreDefault = false) => {
    if (!layout) return;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      const version = conflict?.version ?? layout.version;
      const next = await adminRequest<WorkspaceLayoutPayload>(
        "/workspace/layout",
        restoreDefault
          ? { layoutKind: "admin.workspace.layout", layoutVersion: 2, version, restoreDefault: true }
          : { layoutKind: "admin.workspace.layout", layoutVersion: 2, version, widgets: normalizeDraft(draft ?? widgets) },
        "PUT",
      );
      applyFetched(next, true);
      setEditing(false);
      setMessage(restoreDefault ? "已恢复默认工作台。" : "工作台布局已保存，其他设备将读取同一配置。");
    } catch (failure) {
      const status = failure && typeof failure === "object" && "status" in failure ? Number(failure.status) : 0;
      if (status === 409) {
        try {
          const remote = await fetchLayout();
          const current = editorState();
          if (current) {
            const kept = keepDraftOnConflict(current, remote);
            setConflict(kept.conflict);
          } else {
            setConflict(remote);
          }
          setError("其他设备已保存更新的布局。当前草稿仍保留，请选择重新加载或用当前草稿覆盖。");
        } catch {
          setError(friendlyError(failure));
        }
      } else {
        setError(friendlyError(failure));
      }
    } finally {
      setLoading(false);
    }
  };

  const cancel = () => {
    setDraft(clonePlacements(saved));
    setEditing(false);
    setConflict(undefined);
    setError(undefined);
    setMessage("已取消，恢复为已保存布局。");
  };

  const reloadConflict = () => {
    const current = editorState();
    if (!current?.conflict) return;
    const next = reloadFromConflict(current);
    setLayout(next.layout);
    setDraft(next.draft);
    setEditing(false);
    setConflict(undefined);
    setError(undefined);
    setMessage("已加载其他设备保存的布局，本地草稿已丢弃。");
  };

  const announce = useCallback((text: string) => setAnnouncement(text), []);
  const handlePositionsChange = useCallback((next: WorkspaceWidgetPlacement[]) => {
    setDraft(normalizeDraft(next));
  }, []);
  const handleMoveWidget = useCallback((id: string, dx: number, dy: number) => {
    setDraft((current) => movePlacement(current ?? [], id, dx, dy));
  }, []);
  const handleResizeWidget = useCallback((id: string, dw: number, dh: number) => {
    setDraft((current) => resizePlacement(current ?? [], id, dw, dh));
  }, []);
  const handleRemoveWidget = useCallback((id: string) => {
    setDraft((current) => (current ?? []).filter((widget) => widget.id !== id));
  }, []);
  const handleWidgetTimeRange = useCallback((id: string, range: WorkspaceTimeRange | undefined) => {
    setDraft((current) => (current ?? []).map((widget) => {
      if (widget.id !== id) return widget;
      const next = { ...widget };
      if (range) next.timeRange = range;
      else delete next.timeRange;
      return next;
    }));
  }, []);

  const cardsContext = useMemo<WorkbenchCardsContextValue>(() => ({
    snapshot,
    widgets,
    editing,
    interactiveEdit: editing && !narrow,
    pageTime,
    refreshNonce,
    onNavigate,
    onMoveWidget: handleMoveWidget,
    onResizeWidget: handleResizeWidget,
    onRemoveWidget: handleRemoveWidget,
    onWidgetTimeRange: handleWidgetTimeRange,
    announce,
  }), [snapshot, widgets, editing, narrow, pageTime, refreshNonce, onNavigate, handleMoveWidget, handleResizeWidget, handleRemoveWidget, handleWidgetTimeRange, announce]);

  if (!layout) {
    return (
      <div className="space-y-3">
        <StatusMessage error={error} />
        {error ? <Button type="button" size="sm" variant="outline" onClick={() => void load(true).catch((failure) => setError(friendlyError(failure)))}>重试</Button> : <p className="text-sm text-muted-foreground">正在读取个人工作台…</p>}
      </div>
    );
  }

  return (
    <div className="workbench-page space-y-5">
      <div className="workbench-heading flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">工作台</h2>
          <p className="text-muted-foreground text-sm mt-2">处理审批、管理团队与账号安全。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasTimeBound ? (
            <select value={pageTime} onChange={(event) => setPageTime(event.target.value as WorkspaceTimeRange)} className="h-8 rounded-md border px-2 text-xs" aria-label="工作台时间范围">
              <option value="today">今天（北京时间）</option>
              <option value="7d">近 7 天</option>
              <option value="30d">近 30 天</option>
            </select>
          ) : null}
          {editing ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={cancel}>取消</Button>
              <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => {
                if (window.confirm("恢复默认会替换当前个人配置。确定继续？")) void save(true);
              }}>恢复默认</Button>
              <Button type="button" size="sm" disabled={loading} onClick={() => void save(false)}>保存</Button>
            </>
          ) : narrow ? null : (
            <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(clonePlacements(saved)); setEditing(true); setMessage(undefined); }}>编辑工作台</Button>
          )}
        </div>
      </div>
      <StatusMessage error={error} success={message} />
      <span className="sr-only" role="status">{announcement}</span>
      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p className="text-amber-600">其他设备版本 {conflict.version}。草稿未覆盖。</p>
          <Button type="button" size="sm" variant="outline" onClick={reloadConflict}>重新加载远端布局</Button>
          <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void save(false)}>用当前草稿覆盖</Button>
        </div>
      ) : null}
      {layout.filteredWidgetIds.length > 0 ? <p className="text-xs text-muted-foreground">已隐藏无权限或失效组件。</p> : null}
      {editing && narrow ? <p className="text-xs text-muted-foreground">窗口过窄，拖动与缩放仅在桌面宽度下可用；可先保存或取消。</p> : null}

      <WorkbenchCardsContext.Provider value={cardsContext}>
        {widgets.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>工作台还没有组件</CardTitle>
              <CardDescription>添加可用组件，或恢复默认布局。</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button type="button" size="sm" onClick={() => setEditing(true)}>添加组件</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void save(true)}>恢复默认</Button>
            </CardContent>
          </Card>
        ) : narrow ? (
          <div className="workbench-list">
            {sortPlacementsForList(widgets).map((widget) => <WidgetCardFrame key={widget.id} widget={widget} />)}
          </div>
        ) : (
          <WorkbenchGrid placements={widgets} editing={editing} onPositionsChange={handlePositionsChange} announce={announce} />
        )}

        {editing && addable.length > 0 ? (
          <Card className="workbench-add">
            <CardHeader>
              <CardTitle>添加组件</CardTitle>
              <CardDescription>只列出当前权限下可用的组件。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {addable.map((item) => (
                <Button key={item.id} type="button" size="sm" variant="outline" onClick={() => setDraft((current) => [...(current ?? widgets), appendPlacement(current ?? widgets, item.id)])}>
                  <PlusIcon className="size-3.5" />
                  {item.id === "pending-approvals" ? (canApprove ? "待我审批" : "我提交的申请") : item.title}
                </Button>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </WorkbenchCardsContext.Provider>
    </div>
  );
}
