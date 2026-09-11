import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Button as UiButton } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Icons } from "../components/icons";
import { Button, PasswordInput, StatusMessage } from "../components/ui-elements";
import {
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
} from "../api";

function statusLabel(status: string): string {
  if (status === "ACTIVE") return "正常";
  if (status === "FROZEN") return "冻结";
  return "待激活";
}

function PermissionPicker({
  label,
  permissions,
  selected,
  onToggle,
}: {
  label: string;
  permissions: AdminPermissionCatalogEntry[];
  selected: string[];
  onToggle: (code: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-foreground">{label}</legend>
      <div className="permission-grid">
        {permissions.map((permission) => (
          <label key={permission.code} className="permission-chip">
            <input
              type="checkbox"
              checked={selected.includes(permission.code)}
              onChange={() => onToggle(permission.code)}
            />
            <span>
              <strong>{permission.name}</strong>
              <em>{permission.code}</em>
            </span>
          </label>
        ))}
      </div>
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
      const result = await adminRequest<{ message?: string }>("/security/users/restore", {
        targetUserId,
        password,
        totpCode,
        reason,
      });
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
        <label className="sr-only" htmlFor="restore-user-search">搜索用户账号或姓名</label>
        <input
          id="restore-user-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="flex-1 h-9 px-3 rounded border border-border bg-surface-raised text-xs"
          placeholder="输入账号或姓名（至少 2 个字符）"
        />
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

function ForceLogoutPanel({
  admins,
  currentAdminId,
  onRefresh,
}: {
  admins: AdminDirectoryEntry[];
  currentAdminId: string;
  onRefresh: () => Promise<void>;
}) {
  const [targetAdminId, setTargetAdminId] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!targetAdminId) return;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      const result = await adminRequest<{ message?: string }>("/security/admins/force-logout", { targetAdminId, password, totpCode, reason });
      setTargetAdminId("");
      setPassword("");
      setTotpCode("");
      setReason("");
      setMessage(result.message ?? "目标管理员的会话和未完成登录挑战已撤销。");
      await onRefresh();
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
          <h3>Boss 强制登出</h3>
          <p>撤销目标管理员全部设备会话和未完成登录挑战；账号状态不变，后续登录仍需密码与 2FA。不会替代冻结。</p>
        </div>
        <Icons.Shield size={20} className="text-muted-foreground" />
      </div>
      <div className="space-y-3 max-w-2xl mt-4">
        <label className="space-y-1 text-xs block">
          <span className="text-muted-foreground">目标管理员</span>
          <select value={targetAdminId} onChange={(event) => setTargetAdminId(event.target.value)} className="w-full h-9 px-2 rounded border border-border bg-surface-raised text-xs">
            <option value="">选择管理员</option>
            {admins.filter((admin) => admin.id !== currentAdminId).map((admin) => <option key={admin.id} value={admin.id}>{admin.name} · {admin.username} · {statusLabel(admin.status)}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <PasswordInput
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-9 px-3 rounded border border-border bg-surface-raised text-xs"
            placeholder="Boss 本人密码"
          />
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono"
            placeholder="Boss 6 位 TOTP"
          />
        </div>
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs" placeholder="强制登出原因" />
        <Button type="button" variant="danger" size="sm" loading={loading} disabled={!targetAdminId || password.length < 12 || totpCode.length !== 6 || reason.trim().length < 3} onClick={() => void submit()}>撤销目标会话</Button>
      </div>
      <StatusMessage error={error} success={message} className="mt-4" />
    </section>
  );
}

const PAGE_SIZE = 20;

export function AdminDirectoryView({
  snapshot,
  initialUsername,
  objectOnly = false,
  initialQuery,
  onOpenObject,
  onDirtyChange,
  onQueryChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialUsername?: string;
  objectOnly?: boolean;
  initialQuery?: Record<string, string>;
  onOpenObject?: (username: string, title: string) => void;
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
  const canRestore = hasPermission(snapshot, "user.account.restore");
  const canForceLogout = snapshot.security.isBoss;

  const [admins, setAdmins] = useState<AdminDirectoryEntry[]>([]);
  const [roles, setRoles] = useState<AdminRoleRecord[]>([]);
  const [permissions, setPermissions] = useState<AdminPermissionCatalogEntry[]>([]);
  const [selectedUsername, setSelectedUsername] = useState<string | undefined>(initialUsername);
  const [detail, setDetail] = useState<AdminDirectoryDetail>();
  const [name, setName] = useState("");
  const [createName, setCreateName] = useState("");
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [allowPermissions, setAllowPermissions] = useState<string[]>([]);
  const [denyPermissions, setDenyPermissions] = useState<string[]>([]);
  const [createRoleIds, setCreateRoleIds] = useState<string[]>([]);
  const [createAllow, setCreateAllow] = useState<string[]>([]);
  const [createDeny, setCreateDeny] = useState<string[]>([]);
  const [delivery, setDelivery] = useState<CreatedAdministrator>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState(initialQuery?.q ?? "");
  const [statusFilter, setStatusFilter] = useState(initialQuery?.status ?? "");
  const [page, setPage] = useState(Math.max(1, Number(initialQuery?.page) || 1));
  const [previewUsername, setPreviewUsername] = useState<string>();

  const load = useCallback(async () => {
    if (canRead) {
      const directory = await adminRequest<{ admins?: AdminDirectoryEntry[] }>("/security/admins");
      setAdmins(directory.admins ?? []);
    } else {
      setAdmins([]);
    }
    if (!canRead) {
      setRoles([]);
      setPermissions([]);
      return;
    }
    if (!canReadRoles && !canReadPermissions) {
      setRoles([]);
      setPermissions([]);
      return;
    }
    const catalog = await adminRequest<{ roles?: AdminRoleRecord[]; permissions?: AdminPermissionCatalogEntry[] }>("/security/roles");
    setRoles(catalog.roles ?? []);
    setPermissions(catalog.permissions ?? []);
  }, [canRead, canReadPermissions, canReadRoles]);

  const loadDetail = useCallback(async (username: string) => {
    const next = await adminRequest<AdminDirectoryDetail>(`/security/admins/detail?username=${encodeURIComponent(username)}`);
    setDetail(next);
    setName(next.name);
    setRoleIds((next.roles ?? []).map((role) => role.id).filter((id): id is string => Boolean(id)));
    setAllowPermissions(next.allowPermissions ?? []);
    setDenyPermissions(next.denyPermissions ?? []);
  }, []);

  useEffect(() => {
    void load().catch((failure) => setError(friendlyError(failure)));
  }, [load, refreshNonce]);

  useEffect(() => {
    if (initialUsername) setSelectedUsername(initialUsername);
  }, [initialUsername]);

  useEffect(() => {
    if (!selectedUsername) return;
    void loadDetail(selectedUsername).catch((failure) => setError(friendlyError(failure)));
  }, [loadDetail, selectedUsername]);

  useEffect(() => {
    setSearch(initialQuery?.q ?? "");
    setStatusFilter(initialQuery?.status ?? "");
    setPage(Math.max(1, Number(initialQuery?.page) || 1));
  }, [initialQuery?.page, initialQuery?.q, initialQuery?.status]);

  useEffect(() => {
    if (!onDirtyChange) return;
    const createDirty = createName.trim().length > 0 || createRoleIds.length > 0 || createAllow.length > 0 || createDeny.length > 0;
    const originalName = detail?.name;
    const originalRoles = (detail?.roles ?? []).map((role) => role.id).filter((id): id is string => Boolean(id)).join(",");
    const editDirty = detail
      ? name !== originalName ||
        roleIds.join(",") !== originalRoles ||
        allowPermissions.join(",") !== (detail.allowPermissions ?? []).join(",") ||
        denyPermissions.join(",") !== (detail.denyPermissions ?? []).join(",") ||
        password.length > 0 ||
        totpCode.length > 0 ||
        reason.length > 0
      : false;
    onDirtyChange(createDirty || editDirty);
  }, [allowPermissions, createAllow, createDeny, createName, createRoleIds, denyPermissions, detail, name, onDirtyChange, password, reason, roleIds, totpCode]);

  const selected = useMemo(
    () => admins.find((item) => item.username === selectedUsername),
    [admins, selectedUsername],
  );
  const preview = useMemo(
    () => admins.find((item) => item.username === previewUsername),
    [admins, previewUsername],
  );
  const filteredAdmins = useMemo(() => {
    const q = search.trim().toLowerCase();
    return admins.filter((item) => {
      if (statusFilter && item.status !== statusFilter) return false;
      if (!q) return true;
      return item.username.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
    });
  }, [admins, search, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredAdmins.length / PAGE_SIZE));
  const pageItems = filteredAdmins.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const previewTitle = preview ? `${preview.name} · ${preview.username}` : "";

  const persistQuery = (next: { q: string; status: string; page: number }) => {
    const query: Record<string, string> = {};
    if (next.q.trim()) query.q = next.q.trim();
    if (next.status) query.status = next.status;
    if (next.page > 1) query.page = String(next.page);
    onQueryChange?.(query);
  };

  const toggle = (list: string[], value: string, setter: (next: string[]) => void) => {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      const created = await adminRequest<CreatedAdministrator>("/security/admins/create", {
        name: createName,
        roleIds: createRoleIds,
        allowPermissions: createAllow,
        denyPermissions: createDeny,
      });
      setDelivery(created);
      setCreateName("");
      setCreateRoleIds([]);
      setCreateAllow([]);
      setCreateDeny([]);
      setSelectedUsername(created.username);
      await load();
      setMessage("管理员已创建。请立即抄录临时密码，离开此页后将无法再次查看。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest("/security/admins/update", { username: detail.username, name });
      await Promise.all([load(), loadDetail(detail.username)]);
      setMessage("显示名称已更新。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const saveAccess = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest("/security/admins/assign", {
        username: detail.username,
        roleIds,
        allowPermissions,
        denyPermissions,
      });
      await Promise.all([load(), loadDetail(detail.username)]);
      setMessage("角色与个人权限差异已保存，将在下一次请求立即生效。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const changeFreeze = async (action: "freeze" | "unfreeze") => {
    if (!detail) return;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest(`/security/${action}`, {
        targetAdminId: detail.id,
        password,
        totpCode,
        reason,
      });
      setPassword("");
      setTotpCode("");
      setReason("");
      await Promise.all([load(), loadDetail(detail.username)]);
      setMessage(action === "freeze" ? "目标账号已冻结。" : "目标账号已解冻。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  if (!canRead && !canRestore && !canForceLogout) {
    return (
      <section className="section-panel">
        <StatusMessage error="当前账号没有查看管理员目录的权限。直接请求接口也会被服务端拒绝。" />
      </section>
    );
  }

  if (!canRead) {
    return (
      <div className="space-y-6">
        <UserRestorePanel />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StatusMessage error={error} success={message} />
      {objectOnly ? null : (
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>管理员目录</h3>
            <p>登录账号由系统分配且不可修改。离职使用冻结，不提供常规删除。</p>
          </div>
          <Icons.Users size={20} className="text-muted-foreground" />
        </div>
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const nextPage = 1;
            setPage(nextPage);
            persistQuery({ q: search, status: statusFilter, page: nextPage });
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground block">账号或名称</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 min-w-48 px-2 rounded border border-border bg-surface-raised text-xs" placeholder="搜索" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground block">状态</span>
            <select
              value={statusFilter}
              onChange={(event) => {
                const status = event.target.value;
                setStatusFilter(status);
                setPage(1);
                persistQuery({ q: search, status, page: 1 });
              }}
              className="h-8 px-2 rounded border border-border bg-surface-raised text-xs"
            >
              <option value="">全部</option>
              <option value="ACTIVE">正常</option>
              <option value="FROZEN">冻结</option>
              <option value="PENDING_ENROLLMENT">待激活</option>
            </select>
          </label>
          <Button type="submit" size="sm" variant="secondary">筛选</Button>
        </form>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>登录账号</th>
                <th>显示名称</th>
                <th>状态</th>
                <th>角色</th>
                <th>最近完整登录</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item) => (
                <tr
                  key={item.id}
                  className={item.username === previewUsername ? "selected" : ""}
                  onClick={() => setPreviewUsername(item.username)}
                >
                  <td className="font-mono">{item.username}</td>
                  <td>{item.name}{item.isBoss ? " · Boss" : ""}</td>
                  <td>{statusLabel(item.status)}</td>
                  <td>{item.roles ? (item.roles.map((role) => role.name).join("、") || "未关联") : "—"}</td>
                  <td>{formatDate(item.lastFullAuthenticatedAt ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>共 {filteredAdmins.length} 人，第 {page}/{pageCount} 页</span>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={page <= 1} onClick={() => {
              const nextPage = page - 1;
              setPage(nextPage);
              persistQuery({ q: search, status: statusFilter, page: nextPage });
            }}>上一页</Button>
            <Button type="button" size="sm" variant="secondary" disabled={page >= pageCount} onClick={() => {
              const nextPage = page + 1;
              setPage(nextPage);
              persistQuery({ q: search, status: statusFilter, page: nextPage });
            }}>下一页</Button>
          </div>
        </div>
      </section>
      )}

      <Sheet open={Boolean(previewUsername) && !objectOnly} onOpenChange={(open) => { if (!open) setPreviewUsername(undefined); }}>
        <SheetContent side="right" className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{previewTitle || "管理员"}</SheetTitle>
            <SheetDescription>快速查看。复杂处理请在标签页打开。</SheetDescription>
          </SheetHeader>
          {preview ? (
            <div className="space-y-3 px-4 text-sm">
              <p><span className="text-muted-foreground">登录账号：</span><span className="font-mono">{preview.username}</span></p>
              <p><span className="text-muted-foreground">显示名称：</span>{preview.name}{preview.isBoss ? " · Boss" : ""}</p>
              <p><span className="text-muted-foreground">状态：</span>{statusLabel(preview.status)}</p>
              <p><span className="text-muted-foreground">角色：</span>{preview.roles?.map((role) => role.name).join("、") || "未关联"}</p>
              <p><span className="text-muted-foreground">最近完整登录：</span>{formatDate(preview.lastFullAuthenticatedAt ?? null)}</p>
            </div>
          ) : null}
          <SheetFooter>
            <UiButton
              type="button"
              onClick={() => {
                if (!preview) return;
                onOpenObject?.(preview.username, previewTitle);
                setPreviewUsername(undefined);
              }}
            >
              在标签页打开
            </UiButton>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {objectOnly || !canCreate ? null : (
        <section className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>新增管理员</h3>
              <p>系统分配 ZZ 账号和临时密码。对方首次登录必须改密并绑定 2FA 后才会激活。</p>
            </div>
          </div>
          {delivery ? (
            <div className="delivery-card">
              <p>请立即把下列凭据交给 {delivery.name}。临时密码只在这一次显示。</p>
              <div className="facts-grid">
                <div>
                  <span>登录账号</span>
                  <strong className="font-mono">{delivery.username}</strong>
                </div>
                <div>
                  <span>临时密码</span>
                  <strong className="font-mono">{delivery.temporaryPassword}</strong>
                </div>
              </div>
              <Button type="button" size="sm" variant="secondary" onClick={() => setDelivery(undefined)}>
                我已抄录并关闭
              </Button>
            </div>
          ) : null}
          <form onSubmit={create} className="space-y-4" noValidate>
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground block">显示名称</label>
              <input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs"
                required
              />
            </div>
            {roles.filter((role) => role.status === "ACTIVE").length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-foreground">预设角色</legend>
                <div className="permission-grid">
                  {roles.filter((role) => role.status === "ACTIVE").map((role) => (
                    <label key={role.id} className="permission-chip">
                      <input
                        type="checkbox"
                        checked={createRoleIds.includes(role.id)}
                        onChange={() => toggle(createRoleIds, role.id, setCreateRoleIds)}
                      />
                      <span>
                        <strong>{role.name}</strong>
                        <em>{role.code}</em>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {canGrant && canReadPermissions ? (
              <>
                <PermissionPicker
                  label="个人允许"
                  permissions={permissions}
                  selected={createAllow}
                  onToggle={(code) => toggle(createAllow, code, setCreateAllow)}
                />
                <PermissionPicker
                  label="个人禁止（优先）"
                  permissions={permissions}
                  selected={createDeny}
                  onToggle={(code) => toggle(createDeny, code, setCreateDeny)}
                />
              </>
            ) : null}
            <Button type="submit" size="sm" loading={loading} disabled={!createName.trim()}>
              创建管理员
            </Button>
          </form>
        </section>
      )}

      {detail ? (
        <section className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>{detail.name}</h3>
              <p>
                {detail.username}
                {detail.isBoss ? " · 同级 Boss，身份不受普通创建或授权入口修改" : ""}
              </p>
            </div>
          </div>
          <div className="facts-grid mb-5">
            <div>
              <span>状态</span>
              <strong>{statusLabel(detail.status)}</strong>
            </div>
            {detail.effectivePermissions ? (
              <div>
                <span>有效权限</span>
                <strong>{detail.isBoss ? "Boss 最高权限" : detail.effectivePermissions.join("、") || "无"}</strong>
              </div>
            ) : null}
          </div>
          {detail.allowPermissions || detail.denyPermissions ? (
            <p className="text-xs text-muted-foreground mb-4">
              个人允许：{detail.allowPermissions?.join("、") || "无"}；个人禁止：{detail.denyPermissions?.join("、") || "无"}。禁止优先。
            </p>
          ) : null}
          {canUpdate && !detail.isBoss ? (
            <form onSubmit={saveProfile} className="space-y-3 max-w-xl mt-4" noValidate>
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground block">显示名称</label>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs"
                  required
                />
              </div>
              <Button type="submit" size="sm" loading={loading} disabled={!name.trim()}>保存资料</Button>
            </form>
          ) : null}
          {canGrant && canReadRoles && !detail.isBoss ? (
            <form onSubmit={saveAccess} className="space-y-4 mt-6" noValidate>
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-foreground">关联角色</legend>
                <div className="permission-grid">
                  {roles.filter((role) => role.status === "ACTIVE").map((role) => (
                    <label key={role.id} className="permission-chip">
                      <input
                        type="checkbox"
                        checked={roleIds.includes(role.id)}
                        onChange={() => toggle(roleIds, role.id, setRoleIds)}
                      />
                      <span>
                        <strong>{role.name}</strong>
                        <em>{role.code}</em>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <PermissionPicker
                label="个人允许"
                permissions={permissions}
                selected={allowPermissions}
                onToggle={(code) => toggle(allowPermissions, code, setAllowPermissions)}
              />
              <PermissionPicker
                label="个人禁止（优先）"
                permissions={permissions}
                selected={denyPermissions}
                onToggle={(code) => toggle(denyPermissions, code, setDenyPermissions)}
              />
              <Button type="submit" size="sm" loading={loading}>保存权限</Button>
            </form>
          ) : null}
          {(canFreeze || canUnfreeze) && selected && (!selected.isBoss || snapshot.security.isBoss) && selected.username !== snapshot.user.displayUsername ? (
            <div className="space-y-3 max-w-xl mt-6">
              <div className="grid grid-cols-2 gap-3">
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
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs"
                placeholder="冻结或解冻原因"
              />
              <div className="flex gap-2">
                {canFreeze && detail.status !== "FROZEN" ? (
                  <Button type="button" variant="danger" size="sm" loading={loading} onClick={() => void changeFreeze("freeze")}>
                    冻结
                  </Button>
                ) : null}
                {canUnfreeze && detail.status === "FROZEN" ? (
                  <Button type="button" variant="secondary" size="sm" loading={loading} onClick={() => void changeFreeze("unfreeze")}>
                    解冻
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {canRestore ? <UserRestorePanel /> : null}
      {canForceLogout ? <ForceLogoutPanel admins={admins} currentAdminId={snapshot.adminUserId} onRefresh={load} /> : null}
    </div>
  );
}
