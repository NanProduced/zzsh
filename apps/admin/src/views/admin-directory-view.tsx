import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button as UiButton } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Icons } from "../components/icons";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator } from "@/components/reui/timeline";
import { ArrowDown, ArrowUp, ArrowUpDown, CircleHelp, Eye, KeyRound, Lock, LogOut, MoreHorizontal, ShieldAlert, SquarePen, UserCog } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, PasswordInput, StatusMessage } from "../components/ui-elements";
import {
  AdminApiError,
  adminRequest,
  friendlyError,
  formatDate,
  hasPermission,
  type AdminDirectoryDetail,
  type AdminDirectoryEntry,
  type AdminPermissionCatalogEntry,
  type AdminRoleRecord,
  type CreatedAdministrator,
  type RestorableUserCandidate,
  type SessionSnapshot,
  type SupplyGame,
} from "../api";
import {
  countPermissionsByGroup,
  diffPermissionCodes,
  groupAdminPermissions,
  permissionByCode,
  permissionDescription,
  permissionLabel,
} from "../lib/admin-permissions";
import {
  assignedDisabledRoles,
  buildRestoreScopePayload,
  buildScopePayload,
  scopeChoiceError,
  scopeChoiceOf,
  scopeLabel,
  type ScopeChoice,
} from "../lib/admin-scope-form";
import { dropPending, pendingSubject, readPending, savePending, type PendingOperation } from "../lib/admin-pending-operations";
import {
  accessSummaryOf,
  ADMIN_SORT_LABELS,
  clampPage,
  EMPTY_FILTERS,
  filterAdminEntries,
  hasActiveFilters,
  parseListQuery,
  directoryActionBlockedReason,
  planDirectoryActions,
  scopeSummaryOf,
  securitySummaryOf,
  sortAdminEntries,
  type AdminSortKey,
  type AdminListFilters,
  type SortDirection,
} from "../lib/admin-directory-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AdminActionEligibility } from "../api";

const PAGE_SIZE = 20;

/**
 * 「结果未知」= 没有终态证据，既不是成功也不是明确拒绝。
 * status 0 / NETWORK_ERROR 是没收到响应；5xx 是响应可能已在服务端落写后才失败。
 * 只有 4xx 这类明确拒绝才能安全地纠错重试。与 user-directory 信用处置同一判据。
 */
function isUnknownResult(error: unknown): boolean {
  return error instanceof AdminApiError && (error.status === 0 || error.code === "NETWORK_ERROR" || error.status >= 500);
}

/** 本页面会产生的治理写。每种操作各自一条待确认记录，互不覆盖。 */
const PENDING_OPERATIONS = ["profile", "access", "scope", "create", "freeze", "unfreeze", "force-logout", "restore-scope"] as const;
type PendingOperationKey = (typeof PENDING_OPERATIONS)[number];
const PENDING_LABELS: Record<PendingOperationKey, string> = {
  profile: "显示名称",
  access: "角色与个人权限",
  scope: "业务范围",
  create: "新增管理员",
  freeze: "冻结账号",
  unfreeze: "解冻账号",
  "force-logout": "撤销全部会话",
  "restore-scope": "恢复此前指定的范围",
};
/** 记录来自存储，操作名不能假定仍受编译期枚举约束。 */
const pendingLabel = (operation: string) => PENDING_LABELS[operation as PendingOperationKey] ?? operation;
/** 创建还没有账号可绑定，所以按"新建意图"整体加锁：一次未确认的创建挡住所有再次创建。 */
const CREATE_TARGET = "*new-administrator*";

const ADMIN_STATUS_LABELS: Record<string, string> = { ACTIVE: "正常", FROZEN: "冻结", PENDING_ENROLLMENT: "待激活" };

// Base UI 的 Select.Value 关闭时靠 items 解析显示文案，缺了会把原始值 all 直接露出来。
const STATUS_FILTER_ITEMS = [
  { value: "all", label: "全部" },
  { value: "PENDING_ENROLLMENT", label: "待激活" },
  { value: "FROZEN", label: "冻结" },
  { value: "ACTIVE", label: "正常" },
];
const SCOPE_FILTER_ITEMS = [
  { value: "all", label: "全部" },
  { value: "ALL_GAMES", label: "全部游戏" },
  { value: "SELECTED_GAMES", label: "指定游戏" },
  { value: "NO_SCOPE", label: "无业务范围" },
  { value: "UNKNOWN", label: "未接入" },
];

/** 未登记的枚举原样带出，不塌缩成"待激活"。 */
function adminStatusLabel(status: string): string {
  return ADMIN_STATUS_LABELS[status] ?? `未知状态（${status}）`;
}

/** 必要的说明性文案统一收进问号 + Tooltip，正文只留事实。 */
function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" aria-label={label} className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />}
      >
        <CircleHelp size={13} aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}

/** 全页统一的"未提供"长相：虚线中性徽标 + Tooltip 说明来源，不冒充空值或 0。 */
function UnknownFact({ hint }: { hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="unknown">未接入</Badge>} />
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

function AdminStatusBadge({ status }: { status: string }) {
  const known = status in ADMIN_STATUS_LABELS;
  return (
    <Badge
      variant="outline"
      className={`border-transparent ${
        status === "ACTIVE"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : status === "FROZEN"
            ? "bg-rose-500/15 text-rose-700 dark:text-rose-400"
            : known
              ? "bg-amber-500/15 text-amber-800 dark:text-amber-400"
              : "bg-foreground/[0.08] text-muted-foreground"
      }`}
    >
      {adminStatusLabel(status)}
    </Badge>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{children}</span>;
}

function NotApplicable({ reason }: { reason: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-foreground/[0.04] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
      <Icons.Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
      {reason}
    </p>
  );
}

/** 只在服务端返回时显示，缺失即"暂未接入"，不在前端推断 2FA、密码或会话状态。 */
function SecurityFacts({ detail }: { detail: AdminDirectoryDetail }) {
  const security = detail.security;
  const sessions = detail.sessionSummary;
  const rows: Array<[string, string]> = [];
  if (security) {
    rows.push(["需要修改密码", security.passwordChangeRequired ? "是" : "否"]);
    rows.push([
      "双因素验证",
      security.twoFactorEnabled === true ? "已启用" : security.twoFactorEnabled === false ? "未启用" : "未提供",
    ]);
    if (security.status === "PENDING_ENROLLMENT") {
      rows.push(["激活引导有效期", security.bootstrapExpiresAt ? formatDate(security.bootstrapExpiresAt) : "未设置"]);
    }
    rows.push(["首次激活时间", security.firstActivatedAt ? formatDate(security.firstActivatedAt) : "尚未激活"]);
  }
  if (sessions) {
    rows.push(["未过期会话", `${sessions.activeCount} 个`]);
    rows.push(["其中锁定", `${sessions.lockedCount} 个`]);
    rows.push(["最近建立", sessions.lastSessionCreatedAt ? formatDate(sessions.lastSessionCreatedAt) : "无未过期会话"]);
  } else {
    rows.push(["未过期会话", "未接入"], ["其中锁定", "未接入"], ["最近建立", "未接入"]);
  }
  return (
    <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1.5">
          <dt className="text-xs font-medium text-foreground/70">{label}</dt>
          <dd className="text-xs tabular-nums text-foreground">{value === "未接入" ? <UnknownFact hint="当前运行版本未返回会话摘要，不代表没有会话。" /> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

type AuditEvent = { eventId: string; action: string; actor: { name: string }; occurredAt: string | null; outcome: string };
type AccountHistoryPage = { events: AuditEvent[]; scope: string };

function isAccountHistoryPage(value: unknown): value is AccountHistoryPage {
  const page = value as Partial<AccountHistoryPage> | null;
  return Boolean(page && typeof page.scope === "string" && page.scope.length > 0 && Array.isArray(page.events) && page.events.every((event) =>
    typeof event?.eventId === "string" && event.eventId.length > 0 &&
    typeof event.action === "string" && event.action.length > 0 &&
    typeof event.actor?.name === "string" &&
    (event.occurredAt === null || typeof event.occurredAt === "string") &&
    typeof event.outcome === "string",
  ));
}

/** 同一账号的直接目标事件分散在这两类对象上；服务端 objectType 是精确匹配，必须分别读取后合并。 */
const ACCOUNT_HISTORY_SOURCES = [
  { objectType: "admin_user", label: "账号资料与授权" },
  { objectType: "admin_security", label: "账号安全状态" },
] as const;

/** 详情页的三个独立写分区。 */
type WriteSection = "profile" | "access" | "scope";
const SECTION_LABELS: Record<WriteSection, string> = { profile: "基本资料", access: "角色与有效权限", scope: "业务范围" };

type SecurityAction = "freeze" | "unfreeze" | "force-logout" | "restore-scope";

const ACTION_COPY: Record<SecurityAction, { title: string; impact: string; confirm: string; danger: boolean; needsReason: boolean }> = {
  freeze: {
    title: "冻结该管理员",
    impact: "账号状态改为冻结，阻止后续登录与新请求；同时撤销该账号全部现有会话，并使其未完成的账号恢复请求过期。",
    confirm: "确认冻结",
    danger: true,
    needsReason: true,
  },
  unfreeze: {
    title: "解冻该管理员",
    impact: "解除冻结。若该账号已绑定双因素验证且曾完成激活，则恢复正常；否则进入待激活，需要本人重新完成改密与绑定。冻结时被撤销的会话不会复活。",
    confirm: "确认解冻",
    danger: false,
    needsReason: true,
  },
  "force-logout": {
    title: "撤销该管理员全部会话",
    impact: "撤销全部设备会话与未完成登录挑战。账号状态不变，下次登录仍需密码与双因素验证。这不替代冻结：账号仍可重新登录。",
    confirm: "确认撤销会话",
    danger: true,
    needsReason: true,
  },
  "restore-scope": {
    title: "恢复此前指定的游戏范围",
    impact: "重新启用该账号上次保存的指定游戏集合。若没有历史集合或历史集合为空，结果是“无业务范围”，该账号将不能读取任何游戏的业务数据。",
    confirm: "确认恢复范围",
    danger: false,
    // 该动作的请求体只含 username 与 mode，服务端不读原因、审计也不落原因字段，收集后丢弃属虚假必填。
    needsReason: false,
  },
};

function SecurityActionDialog({
  action,
  target,
  pending,
  blockedReason,
  markPending,
  clearPending,
  onClose,
  onDone,
}: {
  action: SecurityAction;
  target: AdminDirectoryDetail;
  /** P1-B：待确认记录属于（身份,会话,目标,操作），不属于这个弹窗。 */
  pending: PendingOperation | null;
  blockedReason: string | null;
  markPending: (operation: PendingOperationKey, target: string, path: string, kind: PendingOperation["kind"], requestId?: string) => boolean;
  clearPending: (operation: PendingOperationKey, target: string) => void;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const copy = ACTION_COPY[action];
  // 恢复范围只是切模式，不撤销访问，因此不要求再验证凭据。
  const needsReauth = action !== "restore-scope";
  const ready =
    (!needsReauth || (password.length >= 12 && totpCode.length === 6)) &&
    (!copy.needsReason || reason.trim().length >= 3);

  const submit = async () => {
    setError(undefined);
    const path =
      action === "freeze" ? "/security/freeze"
      : action === "unfreeze" ? "/security/unfreeze"
      : action === "force-logout" ? "/security/admins/force-logout"
      : "/security/admins/scope";
    if (pending || busy || blockedReason) return;
    if (!markPending(action, target.username, path, "UNKNOWN")) {
      setError("当前浏览器无法保存原操作记录，未提交任何写请求。请恢复站点存储后重试。");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> =
        action === "restore-scope"
          ? buildRestoreScopePayload(target.username)
          : { targetAdminId: target.id, password, totpCode, reason: reason.trim() };
      const result = await adminRequest<{ status?: string }>(path, body);
      clearPending(action, target.username);
      onDone(
        action === "freeze"
          ? "该账号已冻结，现有会话与未完成的恢复请求已一并处理。"
          : action === "unfreeze"
            ? result.status === "PENDING_ENROLLMENT"
              ? "该账号已解除冻结，但进入待激活：需要本人重新完成改密并绑定双因素验证后才能登录。"
              : "该账号已解冻并恢复正常登录能力。冻结期间被撤销的会话不会复活。"
            : action === "force-logout"
              ? "该账号的会话与未完成登录挑战已撤销。账号仍可重新登录。"
              : "业务范围已按上次集合尝试恢复。",
      );
    } catch (failure) {
      if (!isUnknownResult(failure)) {
        clearPending(action, target.username);
        setError(friendlyError(failure));
      }
      // 结果未知：记录保留，关闭重开也还是锁定状态。
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent className="flex h-[min(76vh,34rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            目标：{target.name}（{target.username}）。{copy.impact}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
          <StatusMessage error={error} />
          {blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}
          {pending ? (
            <p className="rounded-md bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:text-amber-300">
              该目标上这个操作的请求结果无法确认{pending.requestId ? `（请求编号 ${pending.requestId}）` : ""}，可能已经生效。
              当前接口没有原操作终态回执，因此这里不能再次提交；关闭重开也不会解除，只能按账号当前事实人工核对。
            </p>
          ) : null}
          {needsReauth ? (
            <>
              <label className="block">
                <FieldLabel>本人密码</FieldLabel>
                <PasswordInput
                  autoComplete="current-password"
                  disabled={Boolean(pending || blockedReason)}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none!"
                />
              </label>
              <label className="block">
                <FieldLabel>本人 6 位动态验证码</FieldLabel>
                <Input
                  inputMode="numeric"
                  maxLength={6}
                  disabled={Boolean(pending || blockedReason)}
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="focus-visible:outline-none!"
                />
              </label>
            </>
          ) : null}
          {copy.needsReason ? (
          <label className="block">
            <FieldLabel>原因（写入审计）</FieldLabel>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm focus-visible:outline-none! focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </label>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-6 py-3">
          <UiButton type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </UiButton>
          <Button type="button" size="sm" variant={copy.danger ? "danger" : "primary"} loading={busy} disabled={!ready || Boolean(pending || blockedReason)} onClick={() => void submit()}>
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PermissionPicker({
  label,
  permissions,
  selected,
  onToggle,
  disabled = false,
}: {
  label: string;
  permissions: AdminPermissionCatalogEntry[];
  selected: string[];
  onToggle: (code: string) => void;
  disabled?: boolean;
}) {
  const catalog = permissionByCode(permissions);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend>
      {groupAdminPermissions(permissions).map((group) => (
        <div key={group.id} className="rounded-lg border border-border/70">
          <p className="border-b border-border/50 bg-foreground/[0.04] px-3 py-1.5 text-xs font-semibold text-foreground">
            {group.label}
            <span className="ml-2 font-normal text-muted-foreground">{group.description}</span>
          </p>
          <div className="grid gap-x-4 px-3 py-2 sm:grid-cols-2">
            {group.codes.map((code) => {
              const permission = catalog.get(code);
              if (!permission) return null;
              const hint = permissionDescription(permission);
              return (
                <label key={code} className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-foreground/[0.05]">
                  <input type="checkbox" className="mt-0.5" disabled={disabled} checked={selected.includes(code)} onChange={() => onToggle(code)} />
                  <span className="min-w-0">
                    <strong className="block text-sm font-normal text-foreground">{permissionLabel(permission)}</strong>
                    {hint ? <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{hint}</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

export function UserRestorePanel() {
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<RestorableUserCandidate[]>([]);
  const [targetUserId, setTargetUserId] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);

  const find = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      const result = await adminRequest<{ users?: RestorableUserCandidate[] }>(`/security/users/restore-candidates?query=${encodeURIComponent(search.trim())}`);
      setCandidates(result.users ?? []);
      setTargetUserId("");
      if ((result.users ?? []).length === 0) setMessage("没有找到可恢复的停用账号。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const restore = async () => {
    if (!targetUserId) return;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      const result = await adminRequest<{ message?: string }>("/security/users/restore", { targetUserId, password, totpCode, reason });
      setPassword("");
      setTotpCode("");
      setReason("");
      setMessage(result.message ?? "用户账号已恢复；请让用户重新登录。");
      await find();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="section-panel">
      <div className="panel-heading">
        <div>
          <h3>恢复停用用户账号</h3>
          <p>仅支持 DEACTIVATED → ACTIVE。不会恢复旧会话或 OTP，不改变实名/年龄结果；CANCELLED 不可恢复。</p>
        </div>
        <Icons.Users size={20} className="text-muted-foreground" />
      </div>
      <form onSubmit={(event) => void find(event)} className="flex flex-col md:flex-row gap-2 max-w-2xl mt-4" noValidate>
        <label className="space-y-1 text-xs block">
          <span className="text-muted-foreground block">搜索用户账号或姓名</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="flex-1 h-9 px-3 rounded border border-border bg-surface-raised text-xs"
            placeholder="输入账号或姓名（至少 2 个字符）"
          />
        </label>
        <Button type="submit" size="sm" loading={loading} disabled={search.trim().length < 2}>查询停用账号</Button>
      </form>
      {candidates.length > 0 ? (
        <div className="space-y-3 max-w-2xl mt-4">
          <label className="space-y-1 text-xs block">
            <span className="text-muted-foreground">目标账号</span>
            <select value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs">
              <option value="">选择用户</option>
              {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.username} · 已停用</option>)}
            </select>
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <PasswordInput
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-9 px-3 rounded border border-border bg-surface-raised text-xs"
              placeholder="本人密码"
            />
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono"
              placeholder="本人 6 位 TOTP"
            />
          </div>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs" placeholder="恢复原因" />
          <Button type="button" size="sm" loading={loading} disabled={!targetUserId || password.length < 12 || totpCode.length !== 6 || reason.trim().length < 3} onClick={() => void restore()}>恢复用户账号</Button>
        </div>
      ) : null}
      <StatusMessage error={error} success={message} className="mt-4" />
    </section>
  );
}

export function AdminDirectoryView({
  snapshot,
  initialUsername,
  objectOnly = false,
  initialQuery,
  onOpenObject,
  onReturnToList,
  onDirtyChange,
  onQueryChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialUsername?: string;
  objectOnly?: boolean;
  initialQuery?: Record<string, string>;
  onOpenObject?: (username: string, title: string) => void;
  onReturnToList?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onQueryChange?: (query: Record<string, string>) => void;
  refreshNonce?: number;
}) {
  const canRead = hasPermission(snapshot, "admin.account.read");
  const canCreate = hasPermission(snapshot, "admin.account.create");
  const canUpdate = hasPermission(snapshot, "admin.account.update");
  const canGrant = hasPermission(snapshot, "admin.permission.grant");
  const canFreeze = hasPermission(snapshot, "admin.account.freeze");
  const canUnfreeze = hasPermission(snapshot, "admin.account.unfreeze");
  const canReadRoles = hasPermission(snapshot, "admin.role.read");
  const canReadPermissions = hasPermission(snapshot, "admin.permission.read");
  const canReadAudit = hasPermission(snapshot, "admin.audit.read");
  const isBossActor = snapshot.security.isBoss;

  const [admins, setAdmins] = useState<AdminDirectoryEntry[]>([]);
  const [roles, setRoles] = useState<AdminRoleRecord[]>([]);
  const [permissions, setPermissions] = useState<AdminPermissionCatalogEntry[]>([]);
  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gamesFailed, setGamesFailed] = useState(false);
  const [selectedUsername, setSelectedUsername] = useState<string | undefined>(initialUsername);
  const [detail, setDetail] = useState<AdminDirectoryDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [audit, setAudit] = useState<{
    status: "idle" | "loading" | "ready" | "partial" | "error";
    events: AuditEvent[];
    scope?: string;
    missing?: string[];
  }>({
    status: "idle",
    events: [],
  });
  const [name, setName] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [allowPermissions, setAllowPermissions] = useState<string[]>([]);
  const [denyPermissions, setDenyPermissions] = useState<string[]>([]);
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice | null>(null);
  const [scopeGameIds, setScopeGameIds] = useState<string[]>([]);
  // R4：读取代次。关闭、切换对象或读取合同变化时自增，使在途 GET 的响应作废；写请求不中止（中止会造成结果未知）。
  const readSeq = useRef(0);
  // P1-B：待确认记录存在 admin-pending-operations 里，跨弹窗关闭、页面卸载与工作区切页存活，
  // 并按（身份, 会话, 目标, 操作）分别保留。组件这里只留一个变更计数用于重新求值。
  const [pendingTick, setPendingTick] = useState(0);
  // R4：关闭时存在未保存草稿，改为给出显式放弃入口而非静默丢弃。
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createScopeSupported, setCreateScopeSupported] = useState(false);
  const [createScopeChoice, setCreateScopeChoice] = useState<ScopeChoice | null>(null);
  const [createScopeGameIds, setCreateScopeGameIds] = useState<string[]>([]);
  const [createRoleIds, setCreateRoleIds] = useState<string[]>([]);
  const [createAllow, setCreateAllow] = useState<string[]>([]);
  const [createDeny, setCreateDeny] = useState<string[]>([]);
  const [delivery, setDelivery] = useState<CreatedAdministrator>();
  // Q2：200 但没拿到凭据 —— 账号已存在但没有可交付的秘密，不能进入可抄录的交付态。
  const [createUndelivered, setCreateUndelivered] = useState<string>();
  const [securityAction, setSecurityAction] = useState<SecurityAction>();
  const [editSection, setEditSection] = useState<WriteSection>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<AdminListFilters>(() => parseListQuery(initialQuery).filters);
  const [sort, setSort] = useState(() => parseListQuery(initialQuery).sort);
  const [page, setPage] = useState(() => parseListQuery(initialQuery).page);

  // P1-A/P1-B：待确认记录的绑定是"发起身份 + 发起会话 + 目标 + 操作"。
  // 直接读存储而不是复制进组件状态，这样重挂载、切页、换弹窗看到的都是同一条记录。
  const actorId = snapshot.adminUserId;
  const sessionId = snapshot.session.id;
  const subjectOf = (operation: PendingOperationKey, target: string) => pendingSubject(actorId, sessionId, target, operation);
  const pendingFor = (operation: PendingOperationKey, target = selectedUsername ?? "") => readPending(subjectOf(operation, target));
  const markPending = (operation: PendingOperationKey, target: string, path: string, kind: PendingOperation["kind"], requestId?: string) => {
    const saved = savePending({ actorId, sessionId, target, operation, kind, path, requestId });
    setPendingTick((value) => value + 1);
    return saved;
  };
  const clearPending = (operation: PendingOperationKey, target: string) => {
    dropPending(subjectOf(operation, target));
    setPendingTick((value) => value + 1);
  };

  const load = useCallback(async () => {
    const directory = await adminRequest<{ admins?: AdminDirectoryEntry[]; createScopeRequired?: boolean }>("/security/admins");
    setAdmins(directory.admins ?? []);
    setCreateScopeSupported(directory.createScopeRequired === true);
    if (canReadRoles || canReadPermissions) {
      const catalog = await adminRequest<{ roles?: AdminRoleRecord[]; permissions?: AdminPermissionCatalogEntry[] }>("/security/roles");
      setRoles(catalog.roles ?? []);
      setPermissions(catalog.permissions ?? []);
    }
    try {
      const gameCatalog = await adminRequest<{ games?: SupplyGame[] }>("/supply/games");
      setGames(gameCatalog.games ?? []);
      setGamesFailed(false);
    } catch {
      setGamesFailed(true);
    }
  }, [canReadPermissions, canReadRoles]);

  useEffect(() => {
    if (!canRead) return;
    setReady(false);
    void load().then(() => setReady(true)).catch((failure) => setError(friendlyError(failure)));
  }, [canRead, load, refreshNonce, attempt]);

  useEffect(() => {
    if (initialUsername) setSelectedUsername(initialUsername);
  }, [initialUsername]);

  type Drafts = { name?: string; roleIds?: string[]; allow?: string[]; deny?: string[]; scopeChoice?: ScopeChoice | null; scopeGameIds?: string[] };

  const loadDetail = useCallback(async (username: string, preserve?: Drafts): Promise<boolean> => {
    const generation = ++readSeq.current;
    setDetailLoading(true);
    setDetailError(undefined);
    // R5：同账号刷新保留既有投影；切换对象才清空，避免写入确认后界面塌成骨架。
    setDetail((current) => (current && current.username === username ? current : undefined));
    setAudit({ status: canReadAudit ? "loading" : "idle", events: [] });
    try {
      const next = await adminRequest<AdminDirectoryDetail>(`/security/admins/detail?username=${encodeURIComponent(username)}`);
      // R4：关闭或切换对象后代次已变，旧响应不得再写回。
      if (generation !== readSeq.current) return false;
      setDetail(next);
      // Q1/P1-A：ACK 后基线过期这件事，任何一次成功的同目标 GET 都能解除；UNKNOWN 不行 ——
      // 读到旧值、读到新值都不证明原请求已终止。
      for (const operation of PENDING_OPERATIONS) {
        const subject = pendingSubject(snapshot.adminUserId, snapshot.session.id, username, operation);
        if (readPending(subject)?.kind === "ACK_STALE") dropPending(subject);
      }
      setPendingTick((value) => value + 1);
      setName(preserve?.name ?? next.name);
      setRoleIds(preserve?.roleIds ?? (next.roles ?? []).map((role) => role.id).filter((id): id is string => Boolean(id)));
      setAllowPermissions(preserve?.allow ?? next.allowPermissions ?? []);
      setDenyPermissions(preserve?.deny ?? next.denyPermissions ?? []);
      const restoredScope = scopeChoiceOf(next.scope?.mode, next.scope?.gameIds);
      // R7：服务端本次没给出范围就是未知，旧草稿不能把它冒充成刚读到的事实。
      setScopeChoice(restoredScope === null ? null : (preserve?.scopeChoice ?? restoredScope));
      setScopeGameIds(restoredScope === null ? [] : (preserve?.scopeGameIds ?? next.scope?.gameIds ?? []));
      if (canReadAudit) {
        // R6：审计失败保留 error 态与只读重试入口，不清空成"无记录"或"无权"，也不连带把详情报成失败。
        // R3：账号变更分散在两类目标对象上，只查 admin_user 会结构性漏掉冻结/解冻。
        const settled = await Promise.allSettled(
          ACCOUNT_HISTORY_SOURCES.map((source) =>
            adminRequest<unknown>(
              `/security/audit/events?objectType=${source.objectType}&objectId=${encodeURIComponent(next.id)}&limit=6`,
            ).then((page) => {
              if (!isAccountHistoryPage(page)) throw new Error("Incomplete account history response");
              return page;
            }),
          ),
        );
        const pages = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
        const missing = ACCOUNT_HISTORY_SOURCES.filter((_, index) => settled[index]?.status === "rejected").map((source) => source.label);
        if (generation === readSeq.current) {
          if (pages.length === 0) {
            setAudit({ status: "error", events: [] });
          } else {
            const seen = new Set<string>();
            const events = pages
              .flatMap((page) => page.events)
              .filter((event) => {
                if (seen.has(event.eventId)) return false;
                seen.add(event.eventId);
                return true;
              })
              .sort((left, right) => (right.occurredAt ?? "").localeCompare(left.occurredAt ?? ""))
              .slice(0, 8);
            setAudit({ status: missing.length ? "partial" : "ready", events, scope: pages[0]?.scope, missing });
          }
        }
      }
      return true;
    } catch (failure) {
      if (generation !== readSeq.current) return false;
      setDetailError(friendlyError(failure));
      // R5：已有该账号投影时不清空，全屏错误只留给"从来没读到过"。
      setDetail((current) => (current && current.username === username ? current : undefined));
      setAudit({ status: "idle", events: [] });
      return false;
    } finally {
      if (generation === readSeq.current) setDetailLoading(false);
    }
  }, [canReadAudit, snapshot.adminUserId, snapshot.session.id]);

  useEffect(() => {
    if (!selectedUsername) return;
    void loadDetail(selectedUsername);
  }, [loadDetail, selectedUsername]);

  useEffect(() => {
    const next = parseListQuery(initialQuery);
    setFilters(next.filters);
    setSort(next.sort);
    setPage(next.page);
  }, [initialQuery?.dir, initialQuery?.page, initialQuery?.q, initialQuery?.role, initialQuery?.scope, initialQuery?.sort, initialQuery?.status]);

  // 对象深链直接展示详情页；编辑复用原有分区表单。
  useEffect(() => {
    if (objectOnly && initialUsername) setSelectedUsername(initialUsername);
  }, [initialUsername, objectOnly]);

  const baseline = useMemo(
    () =>
      detail
        ? {
            name: detail.name,
            roleIds: (detail.roles ?? []).map((role) => role.id).filter((id): id is string => Boolean(id)).join(","),
            allow: (detail.allowPermissions ?? []).join(","),
            deny: (detail.denyPermissions ?? []).join(","),
            scope: scopeChoiceOf(detail.scope?.mode, detail.scope?.gameIds),
            scopeGames: (detail.scope?.gameIds ?? []).join(","),
          }
        : null,
    [detail],
  );

  const profileDirty = baseline ? name !== baseline.name : false;
  const accessDirty = baseline
    ? roleIds.join(",") !== baseline.roleIds ||
      allowPermissions.join(",") !== baseline.allow ||
      denyPermissions.join(",") !== baseline.deny
    : false;
  const scopeDirty = baseline ? scopeChoice !== baseline.scope || scopeGameIds.join(",") !== baseline.scopeGames : false;
  const editDirty = profileDirty || accessDirty || scopeDirty;

  // R9/Q3：服务端按 role.read / permission.read 分别省略字段，省略不是空集合；而 assign 是全量替换。
  // 完整性同时绑定"当前"读取能力与当前目标 —— 先前读到过不代表现在仍有权读取。
  const grantsComplete =
    canReadRoles &&
    canReadPermissions &&
    detail?.username === selectedUsername &&
    Array.isArray(detail?.roles) &&
    Array.isArray(detail?.allowPermissions) &&
    Array.isArray(detail?.denyPermissions);
  // 无该读取能力 = 未知，不等于空集合。两组能力独立授予，必须分别呈现。
  const rolesReadable = canReadRoles && Array.isArray(detail?.roles);
  const personalReadable = canReadPermissions && Array.isArray(detail?.allowPermissions) && Array.isArray(detail?.denyPermissions);
  // R7：scope 缺失时不得当作已确认的全部游戏，禁止修改与恢复。
  const scopeKnown = scopeChoice !== null;

  const actionReason = (action: AdminActionEligibility["action"], entry: AdminDirectoryEntry | undefined = detail) => {
    const permitted = { update: canUpdate, assign: canGrant, scope: canGrant, freeze: canFreeze, unfreeze: canUnfreeze, "force-logout": isBossActor }[action];
    return permitted ? directoryActionBlockedReason(entry, action) : "没有该操作的权限";
  };
  const profileActionReason = actionReason("update");
  const accessActionReason = actionReason("assign");
  const scopeActionReason = actionReason("scope");

  // Q3：身份或两项读取能力变化时，旧合同下在途的响应立即作废，并按新合同重取一次。
  const grantContract = `${snapshot.adminUserId}|${canReadRoles ? 1 : 0}${canReadPermissions ? 1 : 0}`;
  const lastGrantContract = useRef(grantContract);
  useEffect(() => {
    if (lastGrantContract.current === grantContract) return;
    lastGrantContract.current = grantContract;
    readSeq.current += 1;
    if (selectedUsername) void loadDetail(selectedUsername, draftsRef.current);
  }, [grantContract, loadDetail, selectedUsername]);

  const targetPending = PENDING_OPERATIONS.filter((operation) => operation !== "create")
    .map((operation) => pendingFor(operation))
    .filter((record): record is PendingOperation => record !== null);
  const createPending = pendingFor("create", CREATE_TARGET);

  useEffect(() => {
    // R3/Q1/Q2：未确认的一次性凭据、结果未知的写与未核对的创建结果都算"有未结事项"，纳入现有离开保护。
    onDirtyChange?.(
      Boolean(delivery) ||
        targetPending.length > 0 ||
        Boolean(createPending) ||
        createUndelivered !== undefined ||
        loading ||
        createName.trim().length > 0 ||
        createScopeChoice !== null ||
        createRoleIds.length > 0 ||
        createAllow.length > 0 ||
        createDeny.length > 0 ||
        editDirty ||
        Boolean(securityAction),
    );
  }, [createAllow, createDeny, createName, createScopeChoice, createPending, createRoleIds, createUndelivered, delivery, editDirty, loading, onDirtyChange, pendingTick, securityAction, targetPending.length]);

  const roleFilterItems = [{ value: "all", label: canReadRoles ? "全部" : "无权查看" }, ...roles.map((role) => ({ value: role.id, label: role.status === "DISABLED" ? `${role.name}（已停用）` : role.name }))];
  const activeRoleOptions = roles.filter((role) => role.status === "ACTIVE");
  const activeRoleIds = useMemo(() => new Set(activeRoleOptions.map((role) => role.id)), [activeRoleOptions]);
  // 已分配但已停用的角色必须显形：它们仍在 roleIds 里，隐藏会导致保存必然 409。
  const disabledAssigned = useMemo(() => assignedDisabledRoles(detail?.roles, activeRoleIds), [detail?.roles, activeRoleIds]);
  // R1：只有草稿里仍保留的停用角色才阻断保存；取消勾选后必须能保存，否则原 P0 未关闭。
  const blockingDisabledRoles = disabledAssigned.filter((role) => roleIds.includes(role.id));
  const savedScopeNames = games.filter((game) => (detail?.scope?.gameIds ?? []).includes(game.id)).map((game) => game.name);
  const scopeError = scopeChoiceError(scopeChoice, scopeGameIds);

  const toggle = (list: string[], value: string, setter: (next: string[]) => void) => {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const persistQuery = (next: AdminListFilters, page: number, sortState = sort) => {
    const query: Record<string, string> = {};
    if (next.q.trim()) query.q = next.q.trim();
    if (next.status) query.status = next.status;
    if (next.role) query.role = next.role;
    if (next.scope) query.scope = next.scope;
    if (sortState.key !== "name" || sortState.direction !== "asc") {
      query.sort = sortState.key;
      query.dir = sortState.direction;
    }
    if (page > 1) query.page = String(page);
    onQueryChange?.(query);
  };

  const applyFilters = (patch: Partial<AdminListFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    setPage(1);
    persistQuery(next, 1);
  };

  const applySort = (key: AdminSortKey) => {
    const next = { key, direction: sort.key === key && sort.direction === "asc" ? ("desc" as SortDirection) : ("asc" as SortDirection) };
    setSort(next);
    persistQuery(filters, page, next);
  };

  // Q4：请求发起时的闭包会把等待期间的新编辑当成旧值。草稿统一从这份"最新快照"取。
  const draftsRef = useRef<Required<Drafts>>({
    name: "",
    roleIds: [],
    allow: [],
    deny: [],
    scopeChoice: null,
    scopeGameIds: [],
  });
  useEffect(() => {
    draftsRef.current = { name, roleIds, allow: allowPermissions, deny: denyPermissions, scopeChoice, scopeGameIds };
  });

  const currentDrafts = (): Required<Drafts> => draftsRef.current;

  /**
   * R5：写入已确认后刷新服务端事实。刷新失败不得冒泡成"写失败"（那会诱导重复提交治理写），
   * 只降级为"已保存，显示未更新"，重试路径只发 GET。
   * 同时保留其他分区尚未保存的草稿，避免保存一个分区清掉别的在编内容。
   */
  const confirmRefresh = async (saved: PendingOperationKey) => {
    if (!selectedUsername) return false;
    const drafts = currentDrafts();
    const preserve: Drafts =
      saved === "profile"
        ? { roleIds: drafts.roleIds, allow: drafts.allow, deny: drafts.deny, scopeChoice: drafts.scopeChoice, scopeGameIds: drafts.scopeGameIds }
        : saved === "scope"
          ? { name: drafts.name, roleIds: drafts.roleIds, allow: drafts.allow, deny: drafts.deny }
          : { name: drafts.name, scopeChoice: drafts.scopeChoice, scopeGameIds: drafts.scopeGameIds };
    let refreshed = false;
    try {
      await load();
      refreshed = await loadDetail(selectedUsername, preserve);
    } catch {
      refreshed = false;
    }
    // 写已被接受，只是显示没跟上：降级成 ACK_STALE，成功 GET 可解除（loadDetail 里做）。
    if (!refreshed && !pendingFor(saved, selectedUsername)) markPending(saved, selectedUsername, "", "ACK_STALE");
    return refreshed;
  };

  /** P1-A：锁只由记录决定。丢弃草稿、读到旧值、列表没看到、人工声明都不是终态回执。 */
  const writeLocked = (operation: PendingOperationKey, target = selectedUsername ?? "") => pendingFor(operation, target) !== null;

  /** 只发 GET 的核对入口：保留草稿，也保留 UNKNOWN。 */
  const recheckWrite = (target = selectedUsername ?? "") => {
    if (target) void loadDetail(target, currentDrafts());
  };

  /** 丢弃本地在编内容并重读。这只影响草稿，不解除原操作的 UNKNOWN。 */
  const discardDrafts = (target = selectedUsername ?? "") => {
    if (target) void loadDetail(target);
  };

  /**
   * R5/Q1/P1：分区写的统一出口。发起前先落"待确认"记录，落不下就不发这一笔写；
   * 成功 → 只读回读；结果未知 → 记录留在存储里，UI 内没有解除入口；明确拒绝 → 清记录并可纠错重试。
   */
  const writeSection = async (
    saved: WriteSection,
    path: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) => {
    const target = selectedUsername ?? "";
    if (!target || detail?.username !== target || writeLocked(saved, target)) return false;
    const blocked = saved === "profile" ? profileActionReason : saved === "access" ? accessActionReason : scopeActionReason;
    if (blocked) { setError(blocked); return false; }
    setError(undefined);
    setMessage(undefined);
    if (!markPending(saved, target, path, "UNKNOWN")) {
      setError("当前浏览器无法保存原操作记录，未提交任何写请求。请恢复站点存储后重试。");
      return false;
    }
    setLoading(true);
    try {
      await adminRequest(path, body);
      setMessage(successMessage);
      if (!markPending(saved, target, path, "ACK_STALE")) {
        setError("已收到保存成功回执，但浏览器无法保存确认状态，本项仍锁定。请恢复站点存储后核对原操作。");
        return false;
      }
      return await confirmRefresh(saved);
    } catch (failure) {
      if (isUnknownResult(failure)) {
        // 记录已经是 UNKNOWN，这里只是把它连同可核对的追踪号一起刷新。
        markPending(saved, target, path, "UNKNOWN", failure instanceof AdminApiError ? failure.requestId : undefined);
        void loadDetail(target, currentDrafts());
      } else {
        clearPending(saved, target);
        setError(friendlyError(failure));
      }
      return false;
    } finally {
      setLoading(false);
    }
  };

  const saveProfile = async () => {
    if (!detail || writeLocked("profile")) return;
    if (await writeSection("profile", "/security/admins/update", { username: detail.username, name }, "显示名称已更新。")) setEditSection(undefined);
  };

  const saveAccess = async () => {
    if (!detail || !grantsComplete || writeLocked("access")) return;
    if (await writeSection(
      "access",
      "/security/admins/assign",
      { username: detail.username, roleIds, allowPermissions, denyPermissions },
      "角色与个人权限差异已保存，将在下一次请求立即生效。",
    )) setEditSection(undefined);
  };

  const saveScope = async () => {
    if (!detail || !scopeKnown || scopeError || writeLocked("scope")) return;
    if (await writeSection(
      "scope",
      "/security/admins/scope",
      buildScopePayload(detail.username, scopeChoice as ScopeChoice, scopeGameIds),
      "业务范围已保存。订单、账号、供给和售后读取将在下一次请求按新范围生效。",
    )) setEditSection(undefined);
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (writeLocked("create", CREATE_TARGET)) return;
    if (!createScopeSupported || scopeChoiceError(createScopeChoice, createScopeGameIds)) return;
    const { username: omittedUsername, ...creationScope } = buildScopePayload("", createScopeChoice as ScopeChoice, createScopeGameIds);
    setError(undefined);
    if (!markPending("create", CREATE_TARGET, "/security/admins/create", "UNKNOWN")) {
      setError("当前浏览器无法保存原操作记录，未提交任何写请求。请恢复站点存储后重试。");
      return;
    }
    setLoading(true);
    try {
      const created = await adminRequest<Partial<CreatedAdministrator>>("/security/admins/create", {
        name: createName,
        ...creationScope,
        roleIds: createRoleIds,
        allowPermissions: createAllow,
        denyPermissions: createDeny,
      });
      // 拿到响应就是终态：先解除 UNKNOWN，再判断能不能交付。
      clearPending("create", CREATE_TARGET);
      // Q2：交付态要求真正拿到一次性凭据；只有 200 不足以声称"已交付"。
      if (typeof created?.username !== "string" || !created.username || typeof created.temporaryPassword !== "string" || !created.temporaryPassword) {
        setCreateUndelivered(typeof created?.username === "string" ? created.username : "");
        setCreateName("");
        setCreateScopeChoice(null);
        setCreateScopeGameIds([]);
        setCreateRoleIds([]);
        setCreateAllow([]);
        setCreateDeny([]);
        try {
          await load();
        } catch {
          // 列表刷新失败不改变"没拿到凭据"这个事实。
        }
      } else {
        const delivered: CreatedAdministrator = {
          id: typeof created.id === "string" ? created.id : "",
          username: created.username,
          name: typeof created.name === "string" ? created.name : "",
          status: created.status === "ACTIVE" || created.status === "FROZEN" ? created.status : "PENDING_ENROLLMENT",
          temporaryPassword: created.temporaryPassword,
        };
        setDelivery(delivered);
        setCreateName("");
        setCreateScopeChoice(null);
        setCreateScopeGameIds([]);
        setCreateRoleIds([]);
        setCreateAllow([]);
        setCreateDeny([]);
        try {
          await load();
        } catch {
          // 列表刷新失败不能吞掉已生成的一次性凭据，交付优先。
        }
      }
    } catch (failure) {
      if (!isUnknownResult(failure)) {
        clearPending("create", CREATE_TARGET);
        setError(friendlyError(failure));
      }
      // 结果未知：记录已经在存储里，界面保持"待核对"且不开放再次创建。
    } finally {
      setLoading(false);
    }
  };

  const directoryMenu = (item: AdminDirectoryEntry) => {
    const runFor: Record<AdminActionEligibility["action"], () => void> = {
      update: () => setEditSection("profile"),
      assign: () => setEditSection("access"),
      scope: () => setEditSection("scope"),
      freeze: () => setSecurityAction("freeze"),
      unfreeze: () => setSecurityAction("unfreeze"),
      "force-logout": () => setSecurityAction("force-logout"),
    };
    return planDirectoryActions(item).map((plan) => (
      // F1：本仓菜单项的动作走 onClick（Base UI Item）；onSelect 不会被执行。
      <DropdownMenuItem key={plan.action} disabled={Boolean(actionReason(plan.action, item))} onClick={() => startRowAction(item, plan.action, runFor[plan.action])}>
        {ACTION_ICONS[plan.action]}
        {plan.label}
      </DropdownMenuItem>
    ));
  };

  const ACTION_ICONS: Record<AdminActionEligibility["action"], ReactNode> = {
  update: <SquarePen size={14} aria-hidden />,
  assign: <UserCog size={14} aria-hidden />,
  scope: <KeyRound size={14} aria-hidden />,
  freeze: <Lock size={14} aria-hidden />,
  unfreeze: <ShieldAlert size={14} aria-hidden />,
  "force-logout": <LogOut size={14} aria-hidden />,
};

/** 菜单标签下一行汇总禁用原因，避免把同一条原因重复写进每个条目。 */
  const menuReasons = (item: AdminDirectoryEntry) => {
    const reasons = [...new Set(planDirectoryActions(item).map((plan) => actionReason(plan.action, item)).filter(Boolean))] as string[];
    if (reasons.length === 0) return null;
    return `不可用：${reasons.join("；")}`;
  };

  // 从列表行直接发起任务：先切换当前对象，详情到位后再打开对应的独立操作窗口。
  const pendingRowAction = useRef<{ username: string; action: AdminActionEligibility["action"]; run: () => void } | null>(null);
  const startRowAction = (entry: AdminDirectoryEntry, action: AdminActionEligibility["action"], run: () => void) => {
    if (actionReason(action, entry)) return;
    if (detail?.username === entry.username) {
      const blocked = actionReason(action);
      if (blocked) setError(blocked);
      else run();
      return;
    }
    pendingRowAction.current = { username: entry.username, action, run };
    setSelectedUsername(entry.username);
  };
  useEffect(() => {
    const pending = pendingRowAction.current;
    if (!pending || !detail || pending.username !== detail.username) return;
    pendingRowAction.current = null;
    const blocked = actionReason(pending.action);
    if (blocked) setError(blocked);
    else pending.run();
  }, [detail]);

  // R8：所有 Hook 必须固定在任何条件 return 之前，否则权限快照翻转会改变 Hook 数量。
  // 筛选与排序都作用于完整匹配结果，分页只是之后的切片。
  const filteredAdmins = useMemo(() => sortAdminEntries(filterAdminEntries(admins, filters), sort.key, sort.direction), [admins, filters, sort]);

  if (!canRead) {
    return (
      <section className="section-panel">
        <StatusMessage error="当前账号没有查看管理员目录的权限。直接请求接口也会被服务端拒绝。" />
      </section>
    );
  }

  const pageCount = Math.max(1, Math.ceil(filteredAdmins.length / PAGE_SIZE));
  // F4：页码先收敛再切片，筛小结果或数据变少后都不该停在空页上。
  const activePage = clampPage(page, pageCount);
  const pageItems = filteredAdmins.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE);
  const visibleUnknownCount = pageItems.filter((item) => !item.scopeSummary || !item.securitySummary || item.personalGrantSummary === undefined).length;
  const openDetail = (username: string, title: string) => {
    setMessage(undefined);
    setSelectedUsername(username);
  };

  /**
   * R4：关闭只废弃「读取」——代次自增后在途 GET 的响应不再写回，也不会重开弹窗。
   * 写请求不中止：中止会让结果未知，正是 R5 要消除的重复治理写来源。
   */
  const closeDetail = () => {
    readSeq.current += 1;
    setSelectedUsername(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    // 代次失效后读取回调不再复位加载态。
    setDetailLoading(false);
    setAudit({ status: "idle", events: [] });
    setScopeChoice(null);
    // Q1：这里不清 unconfirmedWrite。结果未知的写不会因为关掉窗口就变成已确定，重开同一账号仍应锁住。
    setCloseBlocked(false);
  };

  const accessChange = diffPermissionCodes(baseline ? (detail?.allowPermissions ?? []) : [], allowPermissions);
  const denyChange = diffPermissionCodes(baseline ? (detail?.denyPermissions ?? []) : [], denyPermissions);
  const auditApplicable = audit.scope === "BOSS_ALL_GENERIC_ADMIN_AUDIT" || detail?.id === snapshot.adminUserId;


  const editorContent = !detail ? null : editSection === "profile" ? (
<Section title="基本资料">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <FieldLabel>显示名称</FieldLabel>
                  <Input value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(profileActionReason) || detail.isBoss || loading} className="focus-visible:outline-none!" required />
                </label>
                <div className="block">
                  <FieldLabel>登录账号</FieldLabel>
                  <p className="rounded-md border border-input bg-transparent px-2.5 py-2 text-sm text-muted-foreground">
                    {detail.username} · 由系统分配且不可修改
                  </p>
                </div>
              </div>
              {canUpdate && !detail.isBoss ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={loading}
                    disabled={Boolean(profileActionReason) || writeLocked("profile") || name === baseline?.name || !name.trim()}
                    onClick={() => void saveProfile()}
                  >
                    保存资料
                  </Button>
                  {writeLocked("profile") ? (
                    <span className="text-xs text-amber-900 dark:text-amber-300">上一次提交的结果尚未确认，先用下方核对入口确认，不要重复提交。</span>
                  ) : name !== baseline?.name ? (
                    <span className="text-xs text-muted-foreground">有未保存的修改</span>
                  ) : null}
                </div>
              ) : null}
            </Section>
  ) : editSection === "access" ? (
<Section title="角色与有效权限" hint="多个角色的权限取并集；能查看哪些游戏由业务范围单独决定。">
              {detail.isBoss ? (
                <NotApplicable reason="Boss 由系统旁路直接持有平台全部权限，不参与角色并集，也不可在此配置。" />
              ) : (
                <>
                  {rolesReadable ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {activeRoleOptions.map((role) => (
                        <label key={role.id} className="flex items-center gap-2.5 rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-foreground/[0.03]">
                          <input type="checkbox" checked={roleIds.includes(role.id)} disabled={!canGrant || loading} onChange={() => toggle(roleIds, role.id, setRoleIds)} />
                          <span className="min-w-0 truncate">{role.name}</span>
                        </label>
                      ))}
                      {disabledAssigned.map((role) => (
                        <label key={role.id} className="flex items-center gap-2.5 rounded-md border border-dashed border-amber-500/50 bg-amber-500/[0.07] px-3 py-2 text-sm">
                          <input type="checkbox" checked={roleIds.includes(role.id)} disabled={!canGrant || loading} onChange={() => toggle(roleIds, role.id, setRoleIds)} />
                          <span className="min-w-0 truncate">{role.name}</span>
                          <Badge variant="outline" className="ml-auto shrink-0 border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-400">
                            已停用
                          </Badge>
                        </label>
                      ))}
                      {activeRoleOptions.length === 0 && disabledAssigned.length === 0 ? (
                        <p className="text-xs text-muted-foreground">角色目录没有可分配的生效角色，该账号也没有已分配的停用角色。</p>
                      ) : null}
                    </div>
                  ) : (
                    <NotApplicable reason="你没有角色读取权限，服务端不会返回该账号的角色列表。这里没有列出角色不代表该账号没有角色。" />
                  )}
                  {disabledAssigned.length > 0 ? (
                    <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:text-amber-300">
                      该账号挂着 {disabledAssigned.length} 个已停用角色。停用角色不参与权限并集，但保留在分配关系里；服务端不允许把停用角色写回分配。
                      {blockingDisabledRoles.length > 0
                        ? `本次草稿仍勾选其中 ${blockingDisabledRoles.length} 个，取消勾选后即可保存。`
                        : "本次草稿已不再勾选它们，可以保存。"}
                    </p>
                  ) : null}
                  <div className="rounded-md bg-foreground/[0.04] px-3 py-2.5">
                    <p className="text-xs text-muted-foreground">有效权限</p>
                    <p className="mt-1 text-sm text-foreground">
                      {!personalReadable
                        ? "未提供（你没有权限明细读取权限）"
                        : (detail.effectivePermissions ?? []).length === 0
                          ? "仅系统基础权限"
                          : countPermissionsByGroup(detail.effectivePermissions ?? [], permissions)
                              .map((part) => `${part.label} ${part.count}`)
                              .join(" · ") || "仅系统基础权限"}
                      {personalReadable && (detail.effectivePermissions ?? []).includes("order.read") ? " · 含系统基础权限 1 项" : ""}
                    </p>
                  </div>
                  <details className="rounded-md border border-border/70 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-foreground">
                      个人权限例外{personalReadable ? `（${allowPermissions.length} 允许 · ${denyPermissions.length} 禁止）` : "（无权查看）"}
                    </summary>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      个人禁止优先于角色允许；个人例外只影响可配置权限，订单核心读取属于所有生效管理员的系统基础权限，不受这里影响。
                    </p>
                    {personalReadable ? (
                      <div className="mt-3 space-y-4">
                        <PermissionPicker label="个人允许" permissions={permissions} disabled={loading || !canGrant} selected={allowPermissions} onToggle={(code) => toggle(allowPermissions, code, setAllowPermissions)} />
                        <PermissionPicker label="个人禁止（优先）" permissions={permissions} disabled={loading || !canGrant} selected={denyPermissions} onToggle={(code) => toggle(denyPermissions, code, setDenyPermissions)} />
                      </div>
                    ) : (
                      <NotApplicable reason="你没有个人权限读取权限，服务端不会返回该账号的个人允许与禁止清单。" />
                    )}
                    {accessChange.added.length + accessChange.removed.length + denyChange.added.length + denyChange.removed.length > 0 ? (
                      <p className="mt-3 text-xs text-muted-foreground">
                        本次变更：允许 新增 {accessChange.added.length} · 移除 {accessChange.removed.length}；禁止 新增 {denyChange.added.length} · 移除 {denyChange.removed.length}
                      </p>
                    ) : null}
                  </details>
                  {canGrant ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        size="sm"
                        loading={loading}
                        disabled={Boolean(accessActionReason) || writeLocked("access") || !accessDirty || blockingDisabledRoles.length > 0 || !grantsComplete}
                        onClick={() => void saveAccess()}
                      >
                        保存权限
                      </Button>
                      {writeLocked("access") ? (
                        <span className="text-xs text-amber-900 dark:text-amber-300">上一次提交的结果尚未确认，先用下方核对入口确认，不要重复提交。</span>
                      ) : !grantsComplete ? (
                        <span className="text-xs text-amber-900 dark:text-amber-300">
                          角色或个人例外未能完整读取，保存会全量替换授权关系，因此禁用。请让拥有对应读取权限的账号操作。
                        </span>
                      ) : accessDirty ? (
                        <span className="text-xs text-muted-foreground">有未保存的修改</span>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </Section>
  ) : (
<Section title="业务范围" hint="决定该账号能查看哪些游戏业务；新管理员默认全部游戏。">
              {detail.isBoss ? (
                <NotApplicable reason="Boss 恒为全部游戏，且不能自行修改业务范围。" />
              ) : (
                <>
                  {!scopeKnown ? (
                    <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:text-amber-300">
                      服务端没有返回该账号当前的业务范围，无法确认它现在是全部游戏、指定游戏还是无范围。为避免按猜测覆盖真实范围，此处暂不可修改或恢复。
                    </p>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-3">
                    {([
                      ["ALL_GAMES", "全部游戏", "新增游戏也自动可见"],
                      ["SELECTED_GAMES", "指定游戏", "只读取勾选的游戏"],
                      ["NO_SCOPE", "无业务范围", "不能读取任何游戏的业务数据"],
                    ] as const).map(([value, label, hint]) => (
                      <label key={value} className={`flex items-start gap-2.5 rounded-md border px-3 py-2 ${scopeChoice === value ? "border-foreground/35 bg-foreground/[0.06]" : "border-border/60"} ${!scopeKnown ? "opacity-60" : ""}`}>
                        <input
                          type="radio"
                          name="admin-game-scope"
                          checked={scopeChoice === value}
                          disabled={!canGrant || !scopeKnown || loading}
                          onChange={() => {
                            setScopeChoice(value);
                            if (value !== "SELECTED_GAMES") setScopeGameIds([]);
                          }}
                        />
                        <span className="min-w-0">
                          <strong className="block text-sm text-foreground">{label}</strong>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {scopeChoice === "SELECTED_GAMES" ? (
                    games.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{gamesFailed ? "游戏元数据读取失败，请刷新后重试。" : "服务端还没有可分配的游戏。"}</p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {games.map((game) => (
                          <label key={game.id} className="flex items-center gap-2.5 rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-foreground/[0.03]">
                            <input type="checkbox" checked={scopeGameIds.includes(game.id)} disabled={!canGrant || loading} onChange={() => toggle(scopeGameIds, game.id, setScopeGameIds)} />
                            <span className="min-w-0 truncate">{game.name}</span>
                          </label>
                        ))}
                      </div>
                    )
                  ) : null}
                  {scopeError ? <p className="text-xs text-rose-700 dark:text-rose-400">{scopeError}</p> : null}
                  {scopeChoice === "NO_SCOPE" ? (
                    <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:text-amber-300">
                      该账号将不能读取任何游戏的订单、账号、供给与售后数据，会收到"无业务范围"提示。游戏元数据仍然可见。
                    </p>
                  ) : null}
                  {canGrant ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" size="sm" loading={loading} disabled={Boolean(scopeActionReason) || writeLocked("scope") || Boolean(scopeError) || !scopeDirty || !scopeKnown} onClick={() => void saveScope()}>
                        保存业务范围
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={Boolean(scopeActionReason) || loading || !scopeKnown} onClick={() => setSecurityAction("restore-scope")}>
                        恢复此前指定的范围
                      </Button>
                      {!scopeKnown ? (
                        <span className="text-xs text-amber-900 dark:text-amber-300">范围未知，不可修改或恢复。</span>
                      ) : scopeDirty ? (
                        <span className="text-xs text-muted-foreground">有未保存的修改</span>
                      ) : null}
                      <span className="text-xs text-muted-foreground">当前：{scopeLabel(detail.scope?.mode, detail.scope?.gameIds, savedScopeNames)}</span>
                    </div>
                  ) : null}
                </>
              )}
            </Section>
  );

  const editorTitle = editSection === "profile" ? "编辑管理员资料" : editSection === "access" ? "调整角色与个人权限" : "调整业务范围";
  const closeEditor = (discard = false) => {
    if (loading) return;
    const sectionDirty = editSection === "profile" ? profileDirty : editSection === "access" ? accessDirty : scopeDirty;
    if (!discard && sectionDirty) { setCloseBlocked(true); return; }
    if (discard && detail) {
      if (editSection === "profile") setName(detail.name);
      if (editSection === "access") {
        setRoleIds((detail.roles ?? []).flatMap(role => role.id ? [role.id] : []));
        setAllowPermissions(detail.allowPermissions ?? []);
        setDenyPermissions(detail.denyPermissions ?? []);
      }
      if (editSection === "scope") {
        setScopeChoice(scopeChoiceOf(detail.scope?.mode, detail.scope?.gameIds));
        setScopeGameIds(detail.scope?.gameIds ?? []);
      }
    }
    setEditSection(undefined);
    setCloseBlocked(false);
  };
  const returnToList = () => {
    if (onReturnToList) onReturnToList();
    else closeDetail();
  };
  const extraPermissions = (detail?.effectivePermissions ?? []).filter(code => code !== "order.read");
  const permissionGroups = countPermissionsByGroup(detail?.effectivePermissions ?? [], permissions);
  const eventLabels: Record<string, string> = {
    "admin.account.created": "创建管理员", "admin.account.updated": "更新管理员资料",
    "admin.permission.assigned": "调整角色与个人权限", "admin.game_scope.assigned": "调整业务范围",
    "admin.frozen": "冻结管理员", "admin.unfrozen": "解除冻结", "admin.session.force_logged_out": "撤销会话",
  };
  // 信息以弹窗呈现：不新增工作区对象标签，列表保持挂载，筛选/排序/页码不丢。
  const detailWindow = selectedUsername ? (
    <Dialog open onOpenChange={(open) => { if (!open) (objectOnly ? returnToList() : closeDetail()); }}>
      <DialogContent className="flex h-[min(84vh,46rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl" data-admin-detail showCloseButton={!loading}>
        {!detail ? <DialogTitle className="sr-only">管理员信息</DialogTitle> : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto w-full max-w-5xl space-y-6">
      {detail ? (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <Avatar className="size-10 shrink-0">
                  <AvatarImage src={detail.image ?? undefined} alt="" />
                  <AvatarFallback>{detail.name.trim().slice(0, 1) || "?"}</AvatarFallback>
                </Avatar>
                <DialogTitle render={<h1 />} className="break-words text-2xl font-semibold tracking-tight">{detail.name}</DialogTitle>
                <AdminStatusBadge status={detail.status} />
                {detail.isBoss ? <Badge variant="outline">Boss · 系统旁路</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">登录账号 {detail.username} · 创建于 {formatDate(detail.createdAt ?? null)}</p>
            </div>
          </header>
          <StatusMessage error={error} success={message} />
          {detailError ? <StatusMessage error={detailError} /> : null}
          {menuReasons(detail) ? <p className="text-xs text-muted-foreground">{menuReasons(detail)}</p> : null}
          {targetPending.map((record) => (
            <div key={record.subject} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-300" role="status">
              <p>
                {record.kind === "UNKNOWN"
                  ? `「${pendingLabel(record.operation)}」无法确认这次操作是否已送达服务端，该项已锁定。重新读取不代表原请求已经结束。`
                  : `「${pendingLabel(record.operation)}」已保存，但页面数据未能刷新。重新读取只读取，不会重复提交。`}
              </p>
              <Button type="button" size="sm" variant="secondary" disabled={loading || detailLoading} onClick={() => void recheckWrite()}>重新读取账号</Button>
            </div>
          ))}
          <div className="space-y-6">
              <section className="space-y-4" aria-labelledby="admin-access-title">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="admin-access-title" className="text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">角色与有效能力</h2>
                </div>
                <div className="flex justify-end">
                  {canGrant && !detail.isBoss ? <Button type="button" size="sm" variant="ghost" className="hover:bg-foreground/[0.06] hover:text-foreground" title={accessActionReason ?? undefined} disabled={Boolean(accessActionReason) || loading || !grantsComplete || writeLocked("access")} onClick={() => setEditSection("access")}>调整角色与权限</Button> : null}
                </div>
                {detail.isBoss ? <NotApplicable reason="Boss 通过系统旁路持有全部能力，角色与个人例外均不参与计算。" /> : (
                  <>
                    <dl className="grid gap-x-12 gap-y-6 sm:grid-cols-2">
                      <div className="space-y-2">
                        <dt className="text-xs font-medium text-foreground/70">角色</dt>
                        <dd className="text-sm">
                          {!rolesReadable ? (canReadRoles ? "角色信息未提供" : "无权查看角色")
                            : detail.roles?.length ? <span className="flex flex-wrap gap-1.5">{detail.roles.map(role => <Badge key={role.id ?? role.code} variant={role.status === "DISABLED" ? "unknown" : "outline"}>{role.name}{role.status === "DISABLED" ? " · 已停用" : ""}</Badge>)}</span>
                            : "未分配角色"}
                        </dd>
                      </div>
                      <div className="space-y-2">
                        <dt className="text-xs font-medium text-foreground/70">有效权限（角色并集 + 个人例外）</dt>
                        <dd className="text-sm">
                          {!personalReadable || !Array.isArray(detail.effectivePermissions) ? (canReadPermissions ? "有效权限未提供" : "无权查看有效权限")
                            : <span className="flex flex-wrap items-center gap-1.5">{extraPermissions.length} 项额外能力{detail.effectivePermissions.includes("order.read") ? "（含系统基础订单读取）" : ""}{permissionGroups.map(group => <Badge key={group.id} variant="secondary">{group.label} {group.count}</Badge>)}</span>}
                        </dd>
                      </div>
                      <div className="space-y-2 sm:col-span-2">
                        <dt className="text-xs font-medium text-foreground/70">个人权限例外</dt>
                        <dd className="text-sm">
                          {!personalReadable ? (canReadPermissions ? "未提供" : "无权查看")
                            : (detail.allowPermissions?.length ?? 0) + (detail.denyPermissions?.length ?? 0) === 0 ? "无个人例外"
                            : <span className="flex flex-wrap gap-1.5">
                                {(detail.allowPermissions ?? []).map(code => <Badge key={`allow-${code}`} variant="outline">{permissions.find(permission => permission.code === code)?.name ?? code}</Badge>)}
                                {(detail.denyPermissions ?? []).map(code => <Badge key={`deny-${code}`} variant="destructive">禁止 · {permissions.find(permission => permission.code === code)?.name ?? code}</Badge>)}
                              </span>}
                        </dd>
                      </div>
                    </dl>
                    {canGrant && !grantsComplete ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground">授权基线不完整<InfoHint label="为什么不能调整授权">角色或个人权限没有完整读取，而保存是全量替换；为避免清空看不见的授权，当前禁止调整。</InfoHint></p> : null}
                  </>
                )}
              </section>
              <section className="space-y-3 border-t border-border/60 pt-5" aria-labelledby="admin-scope-title">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 id="admin-scope-title" className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">业务范围<InfoHint label="业务范围的含义">{detail.isBoss ? "Boss 的业务范围始终为全部游戏，不在此调整。" : !scopeKnown ? "范围确认后才可调整。" : detail.scope?.mode === "ALL_GAMES" ? "可读取全部游戏的业务，新增游戏也自动包含。" : detail.scope?.gameIds.length === 0 ? "当前没有任何游戏的业务读取范围。" : "业务读取仅限上述游戏，实际操作仍由角色与权限决定。"}</InfoHint></h2>
                  {canGrant && !detail.isBoss ? <Button type="button" size="sm" variant="ghost" className="hover:bg-foreground/[0.06] hover:text-foreground" title={scopeActionReason ?? undefined} disabled={Boolean(scopeActionReason) || loading || !scopeKnown || writeLocked("scope")} onClick={() => setEditSection("scope")}>调整业务范围</Button> : null}
                </div>
                <dl className="grid gap-y-4">
                  <dt className="text-xs font-medium text-foreground/70">当前范围</dt>
                  <dd className="text-sm">{detail.isBoss ? "全部游戏 · 系统旁路" : scopeKnown ? scopeLabel(detail.scope?.mode, detail.scope?.gameIds, savedScopeNames) : <UnknownFact hint="当前运行版本未返回该账号的业务范围，不代表无范围。" />}</dd>
                </dl>
              </section>

              <section className="space-y-3" aria-labelledby="admin-security-title">
                <h2 id="admin-security-title" className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">账号安全{detail.security === undefined || detail.security.twoFactorEnabled === null ? <InfoHint label="为什么安全详情不完整">安全详情尚未提供，当前不能确认双因素验证及会话情况。治理操作以接口资格预检为准，执行前请核对账号状态。</InfoHint> : null}</h2>
                <div className="flex justify-end">
                  {canFreeze && !detail.isBoss && detail.id !== snapshot.adminUserId && detail.status !== "FROZEN" ? <Button type="button" size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" title={actionReason("freeze") ?? undefined} disabled={Boolean(actionReason("freeze")) || loading} onClick={() => setSecurityAction("freeze")}>冻结账号</Button> : null}
                  {canUnfreeze && !detail.isBoss && detail.status === "FROZEN" ? <Button type="button" size="sm" variant="ghost" className="hover:bg-foreground/[0.06] hover:text-foreground" title={actionReason("unfreeze") ?? undefined} disabled={Boolean(actionReason("unfreeze")) || loading} onClick={() => setSecurityAction("unfreeze")}>解除冻结</Button> : null}
                  {isBossActor && detail.id !== snapshot.adminUserId ? <Button type="button" size="sm" variant="ghost" className="hover:bg-foreground/[0.06] hover:text-foreground" title={actionReason("force-logout") ?? undefined} disabled={Boolean(actionReason("force-logout")) || loading} onClick={() => setSecurityAction("force-logout")}>撤销全部会话</Button> : null}
                </div>
                <div className="space-y-4 text-sm"><div className="space-y-1"><p className="text-xs text-muted-foreground">最近一次完整认证</p><p>{detail.lastFullAuthenticatedAt ? formatDate(detail.lastFullAuthenticatedAt) : "未记录"}</p></div></div>
                <SecurityFacts detail={detail} />
                {detail.id === snapshot.adminUserId ? <p className="text-xs text-muted-foreground">不能冻结或撤销当前账号自己的会话。</p> : null}
              </section>
              <section className="space-y-3 border-t border-border/60 pt-5" aria-labelledby="admin-audit-title">
                <h2 id="admin-audit-title" className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">账号变更记录<InfoHint label="账号变更记录的覆盖范围">只汇总直接作用于该账号的记录（资料、授权、安全状态）；角色定义本身的变更、认证与恢复流程属于其他来源，不在这里。</InfoHint></h2>
                {!canReadAudit ? <p className="text-sm text-muted-foreground">无权查看操作记录</p> : audit.status === "error" ? <div className="space-y-2 text-sm"><p>操作记录读取失败，无法判断该账号是否有相关记录。</p><Button type="button" size="sm" variant="secondary" onClick={() => selectedUsername && void loadDetail(selectedUsername, currentDrafts())}>重试读取</Button></div> : audit.status === "loading" || audit.status === "idle" ? <p className="text-sm text-muted-foreground">正在读取操作记录…</p> : !auditApplicable ? <p className="text-sm text-muted-foreground">当前可见范围不包含该账号的操作记录。</p> : <>
                  {audit.status === "partial" ? <div className="space-y-2 rounded-md bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-300"><p>记录不完整：{(audit.missing ?? []).join("、")}没有读到，下面只包含已读到的来源，不代表该账号只有这些记录。</p><Button type="button" size="sm" variant="secondary" disabled={detailLoading} onClick={() => selectedUsername && void loadDetail(selectedUsername, currentDrafts())}>重试读取</Button></div> : null}
                  {audit.events.length === 0 ? <p className="text-sm text-muted-foreground">{audit.status === "partial" ? "已读到的来源里没有该账号的记录。" : "暂无该账号相关的审计事件。"}</p> : <Timeline>
                    {audit.events.map((event, index) => (
                      <TimelineItem key={event.eventId} step={index + 1}>
                        <TimelineSeparator>
                          <TimelineIndicator />
                        </TimelineSeparator>
                        <TimelineHeader>
                          <span className="text-sm font-medium">{eventLabels[event.action] ?? "其他管理操作"}</span>
                          <TimelineDate>{event.occurredAt ? formatDate(event.occurredAt) : "时间未提供"}</TimelineDate>
                        </TimelineHeader>
                        <TimelineContent>
                          <p className="text-xs text-muted-foreground">{event.actor.name} · {event.outcome === "SUCCESS" ? "成功" : event.outcome === "FAILURE" ? "失败" : "结果未提供"}</p>
                        </TimelineContent>
                      </TimelineItem>
                    ))}
                  </Timeline>}
                </>}
              </section>
          </div>
        </>
      ) : detailError ? <div className="section-panel space-y-3"><StatusMessage error={detailError} /><Button type="button" size="sm" variant="secondary" onClick={() => selectedUsername && void loadDetail(selectedUsername)}>重新读取</Button></div> : <div className="space-y-4"><Skeleton className="h-12 w-2/3" /><Skeleton className="h-56 w-full" /></div>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border/60 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {canUpdate && detail && !detail.isBoss ? <Button type="button" size="sm" variant="secondary" className="hover:border-foreground/40 hover:bg-foreground/[0.06]" title={profileActionReason ?? undefined} disabled={Boolean(profileActionReason) || loading || writeLocked("profile")} onClick={() => setEditSection("profile")}>编辑资料</Button> : null}
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => (objectOnly ? returnToList() : closeDetail())}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  ) : null;
  const detailEditor = editSection && detail ? (
    <Dialog open onOpenChange={open => { if (!open) closeEditor(); }}>
      <DialogContent className="flex h-[min(88vh,40rem)] w-full flex-col gap-0 p-0 sm:max-w-2xl" showCloseButton={!loading}>
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
          <DialogTitle>{editorTitle}</DialogTitle>
          <DialogDescription>{detail.name}（{detail.username}）。只修改当前分区。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
          <StatusMessage error={error} success={message} />
          {actionReason(editSection === "profile" ? "update" : editSection === "access" ? "assign" : "scope") ? <p className="text-xs text-muted-foreground">{actionReason(editSection === "profile" ? "update" : editSection === "access" ? "assign" : "scope")}</p> : null}
          {editSection && pendingFor(editSection) ? <div className="space-y-2 rounded-md bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-300">
            <p>{pendingFor(editSection)?.kind === "UNKNOWN" ? "无法确认这次修改是否已送达，本项已锁定；重新读取或丢弃草稿都不能证明原请求已结束。" : "已保存，但页面数据未能刷新。重试只读取，不会重复提交。"}</p>
            <Button type="button" size="sm" variant="secondary" disabled={loading || detailLoading} onClick={() => void recheckWrite()}>重试刷新</Button>
            {pendingFor(editSection)?.kind === "UNKNOWN" ? <Button type="button" size="sm" variant="ghost" disabled={loading || detailLoading} onClick={() => discardDrafts()}>丢弃本地草稿重新读取（本项仍锁定）</Button> : null}
          </div> : null}
          {editorContent}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/60 px-6 py-3">
          {closeBlocked ? <><p className="mr-auto text-xs text-muted-foreground">有未保存的修改，关闭不会保存这些改动。</p><Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => closeEditor(true)}>放弃修改并关闭</Button></> : null}
          <Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => closeEditor()}>取消编辑</Button>
        </div>
      </DialogContent>
    </Dialog>
  ) : null;

  return (
    <TooltipProvider>
    <div className="space-y-5">
      {(<TooltipProvider>
      <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">管理员账号{visibleUnknownCount > 0 ? <InfoHint label="为什么有的单元格标未接入">标「未接入」的单元格表示当前运行的 API 版本没有返回该字段，不是这个账号的事实；部署含该字段的构建后会自动显示真实值。</InfoHint> : null}</h1>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            {ready
              ? `${admins.length} 个账号 · 生效 ${admins.filter((item) => item.status === "ACTIVE").length} · 冻结 ${admins.filter((item) => item.status === "FROZEN").length} · 待激活 ${admins.filter((item) => item.status === "PENDING_ENROLLMENT").length}`
              : "正在读取…"}
          </p>
        </div>
        {canCreate ? (
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            新增管理员
          </Button>
        ) : null}
      </div>
      <StatusMessage error={error} success={message} />

      {!ready ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <section className="section-panel">
          <form
            className="mb-3 flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters({});
            }}
          >
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground block">账号或名称</span>
              <Input value={filters.q} onChange={(event) => applyFilters({ q: event.target.value })} placeholder="搜索" className="h-9 w-56 focus-visible:outline-none!" />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground block">状态</span>
              <Select value={filters.status || "all"} onValueChange={(value) => applyFilters({ status: value === "all" ? "" : String(value) })} items={STATUS_FILTER_ITEMS}>
                <SelectTrigger className="h-9 w-32 text-xs focus-visible:outline-none!"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="PENDING_ENROLLMENT">待激活</SelectItem>
                  <SelectItem value="FROZEN">冻结</SelectItem>
                  <SelectItem value="ACTIVE">正常</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground block">角色</span>
              <Select value={filters.role || "all"} onValueChange={(value) => applyFilters({ role: value === "all" ? "" : String(value) })} disabled={!canReadRoles} items={roleFilterItems}>
                <SelectTrigger className="h-9 w-32 text-xs focus-visible:outline-none!"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{canReadRoles ? "全部" : "无权查看"}</SelectItem>
                  {canReadRoles ? roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name}{role.status === "DISABLED" ? "（已停用）" : ""}</SelectItem>) : null}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground block">业务范围</span>
              <Select value={filters.scope || "all"} onValueChange={(value) => applyFilters({ scope: value === "all" ? "" : String(value) })} items={SCOPE_FILTER_ITEMS}>
                <SelectTrigger className="h-9 w-32 text-xs focus-visible:outline-none!"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="ALL_GAMES">全部游戏</SelectItem>
                  <SelectItem value="SELECTED_GAMES">指定游戏</SelectItem>
                  <SelectItem value="NO_SCOPE">无业务范围</SelectItem>
                  <SelectItem value="UNKNOWN">未接入</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {hasActiveFilters(filters) ? (
              <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => applyFilters(EMPTY_FILTERS)}>
                重置筛选
              </Button>
            ) : null}
          </form>

          {filteredAdmins.length === 0 ? (
            <p className="rounded-md border border-dashed border-border/70 px-4 py-12 text-center text-sm text-muted-foreground">
              {admins.length === 0 ? "还没有管理员账号。用右上角「新增管理员」创建第一个。" : `没有匹配当前筛选条件的账号${filters.q.trim() ? `（“${filters.q.trim()}”）` : ""}。`}
            </p>
          ) : (
            <>
            <div className="table-wrap">
              <table className="data-table admin-directory-table" style={{ tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "17%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "11%" }} />
                </colgroup>
                <thead>
                  <tr>
                    {([
                      ["name", "管理员"],
                      ["status", "账号状态"],
                      ["access", "访问配置"],
                      ["scope", "业务范围"],
                      ["security", "登录与安全"],
                    ] as const).map(([key, label]) => (
                      <th key={key} scope="col" aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                        <button
                          type="button"
                          className="-mx-2 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left font-medium hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none! disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => applySort(key)}
                          disabled={key === "access" && !canReadRoles && !canReadPermissions}
                          title={key === "access" && !canReadRoles && !canReadPermissions ? "没有角色/权限读取能力，不能按该列排序" : `按${label}排序`}
                        >
                          {label}
                          {sort.key === key ? (sort.direction === "asc" ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />) : <ArrowUpDown size={12} aria-hidden className="opacity-40" />}
                        </button>
                      </th>
                    ))}
                    <th scope="col">会话</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => {
                    const access = accessSummaryOf(item);
                    const security = securitySummaryOf(item);
                    const scope = scopeSummaryOf(item);
                    return (
                      <tr key={item.id} className="cursor-pointer hover:bg-foreground/[0.03]" onClick={(event) => { if (!(event.target as HTMLElement).closest("button,a,input,select,[role=menuitem]")) openDetail(item.username, item.name); }}>
                        <td className="whitespace-nowrap">
                          <span className="flex items-center gap-2.5">
                            <Avatar className="size-8 shrink-0">
                              <AvatarImage src={item.image ?? undefined} alt="" />
                              <AvatarFallback className="text-xs">{item.name.trim().slice(0, 1) || "?"}</AvatarFallback>
                            </Avatar>
                            <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="inline-flex min-w-0 items-center gap-1.5">
                              <button type="button" className="min-w-0 truncate text-left font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline" onClick={() => openDetail(item.username, item.name)}>{item.name}</button>
                            </span>
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate font-mono text-xs text-muted-foreground">{item.username}</span>
                                {item.isBoss ? <Badge variant="outline" className="shrink-0 border-transparent bg-foreground/[0.08] text-muted-foreground">Boss</Badge> : null}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="whitespace-nowrap">
                          <Badge variant={item.status === "ACTIVE" ? "success" : item.status === "FROZEN" ? "destructive" : item.status === "PENDING_ENROLLMENT" ? "warning" : "unknown"}>
                            {adminStatusLabel(item.status)}
                          </Badge>
                        </td>
                        <td className="whitespace-normal">
                          <span className="block truncate text-sm">{item.isBoss ? "全部能力 · 系统旁路" : access.roles}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.isBoss ? "不参与角色并集" : access.exception}
                            {access.disabledCount > 0 ? ` · 含 ${access.disabledCount} 个已停用角色` : ""}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-sm">
                          {item.isBoss ? "全部游戏" : scope.known ? scope.label : <UnknownFact hint="当前运行版本未返回该账号的业务范围，不代表无范围。" />}
                        </td>
                        <td className="whitespace-normal">
                          <span className="block text-sm">
                            {security.headline === "未提供" ? <UnknownFact hint="当前运行版本未返回安全摘要，不代表未启用双因素。" /> : security.headline}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {security.detail ? `${security.detail} ` : ""}
                            {security.timeLabel ? `${security.timeLabel} ${formatDate(security.time)}` : ""}
                          </span>
                        </td>
                        <td className="whitespace-normal">
                          {item.sessionSummary ? (
                            <>
                              <span className="block text-sm">
                                {item.sessionSummary.activeCount === 0
                                  ? "无未过期会话"
                                  : `${item.sessionSummary.activeCount} 个未过期会话${item.sessionSummary.lockedCount > 0 ? `（含 ${item.sessionSummary.lockedCount} 锁定）` : ""}`}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {item.sessionSummary.lastSessionCreatedAt ? `最近建立 ${formatDate(item.sessionSummary.lastSessionCreatedAt)}` : "尚无未过期会话的建立记录"}
                              </span>
                            </>
                          ) : (
                            <UnknownFact hint="当前运行版本未返回会话摘要。" />
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          <div className="flex items-center justify-start gap-0.5" onClick={(event) => event.stopPropagation()}>
                            <Tooltip>
                              <TooltipTrigger render={<UiButton type="button" variant="ghost" size="icon-sm" aria-label={`查看 ${item.name} 的信息`} onClick={() => openDetail(item.username, item.name)} />}>
                                <Eye size={16} aria-hidden />
                              </TooltipTrigger>
                              <TooltipContent>查看信息</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <UiButton
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`编辑 ${item.name} 的显示名称`}
                                    disabled={Boolean(actionReason("update", item)) || writeLocked("profile", item.username)}
                                    onClick={() => startRowAction(item, "update", () => setEditSection("profile"))}
                                  />
                                }
                              >
                                <SquarePen size={16} aria-hidden />
                              </TooltipTrigger>
                              <TooltipContent>{writeLocked("profile", item.username) ? "上一次提交结果未确认" : actionReason("update", item) ?? "修改显示名称"}</TooltipContent>
                            </Tooltip>
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<UiButton type="button" variant="ghost" size="icon-sm" aria-label={`${item.name} 的更多操作`} />}>
                                <MoreHorizontal size={16} aria-hidden />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuGroup>
                                  <DropdownMenuLabel>{item.name} · {item.username}</DropdownMenuLabel>
                                  {menuReasons(item) ? <p className="max-w-72 px-1.5 pb-1 text-xs leading-relaxed text-muted-foreground">{menuReasons(item)}</p> : null}
                                </DropdownMenuGroup>
                                <DropdownMenuSeparator />
                                {directoryMenu(item)}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}

          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span className="tabular-nums">
              共 {filteredAdmins.length} 人，第 {activePage}/{pageCount} 页
            </span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={activePage <= 1} onClick={() => { const next = activePage - 1; setPage(next); persistQuery(filters, next); }}>
                上一页
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={activePage >= pageCount} onClick={() => { const next = activePage + 1; setPage(next); persistQuery(filters, next); }}>
                下一页
              </Button>
            </div>
          </div>
        </section>
      )}

      </>
      </TooltipProvider>)}

      {detailWindow}

      {securityAction && detail ? (
        <SecurityActionDialog
          action={securityAction}
          target={detail}
          pending={pendingFor(securityAction, detail.username)}
          blockedReason={securityAction === "restore-scope" && !scopeKnown ? "范围未知，不可修改或恢复。" : actionReason(securityAction === "restore-scope" ? "scope" : securityAction)}
          markPending={markPending}
          clearPending={clearPending}
          onClose={() => setSecurityAction(undefined)}
          onDone={(text) => {
            setSecurityAction(undefined);
            setMessage(text);
            void confirmRefresh(securityAction);
          }}
        />
      ) : null}

      {detailEditor}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          // R3：待抄录的临时凭据与在途创建请求都不允许通过 Esc/点外关闭，只有显式确认才能收起。
          if (!open && (delivery || loading)) return;
          setCreateOpen(open);
          if (!open) setError(undefined);
        }}
      >
        <DialogContent className="flex max-h-[88vh] w-full flex-col gap-0 p-0 sm:max-w-2xl" showCloseButton={!delivery && !loading}>
          <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
            <DialogTitle>{delivery ? "交付临时凭据" : "新增管理员"}</DialogTitle>
            <DialogDescription>
              {delivery
                ? "临时密码只在此显示一次，关闭后无法再次查看。"
                : "系统分配 ZZ 账号和临时密码。对方首次登录必须改密并绑定双因素验证后才会激活。新管理员默认全部游戏范围。"}
            </DialogDescription>
          </DialogHeader>
          {delivery ? (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
              <div className="rounded-lg border border-border/70 bg-foreground/[0.04] p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">登录账号</p>
                    <p className="mt-1 font-mono text-sm text-foreground">{delivery.username}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">临时密码</p>
                    <p className="mt-1 font-mono text-sm text-foreground">{delivery.temporaryPassword}</p>
                  </div>
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                请当面交付或走既有安全通道。账号在本人完成改密并绑定双因素验证前保持"待激活"，此期间无法通过恢复流程找回凭据。
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    const created = delivery;
                    setDelivery(undefined);
                    setCreateOpen(false);
                    if (created) setMessage(`已确认抄录 ${created.username} 的临时凭据。`);
                  }}
                >
                  我已抄录并关闭
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={create} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
                <StatusMessage error={error} />
                {createPending || createUndelivered !== undefined ? (
                  <div className="space-y-2 rounded-md bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:text-amber-300">
                    {createPending ? (
                      <>
                        <p>
                          无法确认这次创建请求是否已送达服务端。账号可能已经建好，但一次性密码的响应没有收到；该密码无法补发，重复创建会多出第二个待激活账号。
                        </p>
                        <p>下面的名称、角色与个人例外仍保留。这里不能再次创建：读取列表为空也不能证明原请求被拒绝，它可能在读取之后才提交。</p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            loading={loading}
                            onClick={() => {
                              setLoading(true);
                              void load().finally(() => setLoading(false));
                            }}
                          >
                            刷新列表核对
                          </Button>
                        </div>
                        <p>需要由管理维护者按账号名在服务端核对；在拿到原操作终态回执之前，本项保持锁定。</p>
                      </>
                    ) : (
                      <>
                        <p>
                          {createUndelivered ? `已收到账号 ${createUndelivered} 的创建响应，但` : "已收到创建响应，但"}
                          缺少必要的一次性凭据，无法完成交付，因此这里不提供"已抄录"确认。
                        </p>
                        <p>待激活账号不能使用现有恢复流程。当前没有重发临时凭据的入口，需要由管理维护者处理。</p>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setCreateUndelivered(undefined);
                              setCreateOpen(false);
                            }}
                          >
                            关闭
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
                <label className="block">
                  <FieldLabel>显示名称</FieldLabel>
                  <Input value={createName} onChange={(event) => setCreateName(event.target.value)} className="focus-visible:outline-none!" required />
                </label>
                <fieldset className="space-y-2" disabled={loading || !createScopeSupported}>
                  <FieldLabel>业务范围（必须明确选择）</FieldLabel>
                  {!createScopeSupported ? <p className="text-xs text-muted-foreground">当前接口未接入创建时业务范围，暂不能创建管理员。</p> : null}
                  {(["ALL_GAMES", "SELECTED_GAMES", "NO_SCOPE"] as const).map((choice) => (
                    <label key={choice} className="mr-4 inline-flex items-center gap-2 text-sm">
                      <input type="radio" name="create-admin-scope" value={choice} checked={createScopeChoice === choice} onChange={() => setCreateScopeChoice(choice)} />
                      {choice === "ALL_GAMES" ? "全部游戏" : choice === "SELECTED_GAMES" ? "指定游戏" : "无业务范围"}
                    </label>
                  ))}
                  {createScopeChoice === "SELECTED_GAMES" ? <div className="flex flex-wrap gap-3">{games.map((game) => <label key={game.id} className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={createScopeGameIds.includes(game.id)} onChange={() => toggle(createScopeGameIds, game.id, setCreateScopeGameIds)} />{game.name}</label>)}</div> : null}
                  {scopeChoiceError(createScopeChoice, createScopeGameIds) ? <p className="text-xs text-muted-foreground">{scopeChoiceError(createScopeChoice, createScopeGameIds)}</p> : null}
                </fieldset>
                {activeRoleOptions.length > 0 ? (
                  <div>
                    <FieldLabel>预设角色</FieldLabel>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {activeRoleOptions.map((role) => (
                        <label key={role.id} className="flex items-center gap-2.5 rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-foreground/[0.03]">
                          <input type="checkbox" checked={createRoleIds.includes(role.id)} onChange={() => toggle(createRoleIds, role.id, setCreateRoleIds)} />
                          <span className="min-w-0 truncate">{role.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
                {canGrant && canReadPermissions ? (
                  <details className="rounded-md border border-border/70 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-foreground">个人权限例外（可选）</summary>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      角色是主要配置入口。个人禁止优先于角色允许；订单核心读取属于所有生效管理员，不需要在这里配置。
                    </p>
                    <div className="mt-3 space-y-4">
                      <PermissionPicker label="个人允许" permissions={permissions} selected={createAllow} onToggle={(code) => toggle(createAllow, code, setCreateAllow)} />
                      <PermissionPicker label="个人禁止（优先）" permissions={permissions} selected={createDeny} onToggle={(code) => toggle(createDeny, code, setCreateDeny)} />
                    </div>
                  </details>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border/70 bg-surface px-6 py-3">
                <UiButton type="button" variant="outline" disabled={loading} onClick={() => setCreateOpen(false)}>
                  取消
                </UiButton>
                <Button type="submit" size="sm" loading={loading} disabled={!createScopeSupported || Boolean(scopeChoiceError(createScopeChoice, createScopeGameIds)) || Boolean(createPending) || createUndelivered !== undefined || !createName.trim()}>
                  创建管理员
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
