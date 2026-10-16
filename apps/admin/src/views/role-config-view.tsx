import { directoryScopeOf, readAdminDirectoryShared } from "../workspace/admin-directory-read";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import {
  adminRequest,
  friendlyError,
  hasPermission,
  type AdminDirectoryEntry,
  type AdminPermissionCatalogEntry,
  type AdminRoleRecord,
  type SessionSnapshot,
} from "../api";
import {
  diffPermissionCodes,
  groupAdminPermissions,
  permissionByCode,
  permissionDescription,
  permissionLabel,
  type AdminPermissionGroup,
} from "../lib/admin-permissions";
import { createRoleFormDirty, roleFormDirty, snapshotRole, type RoleBaseline } from "../workspace/role-draft";

const ROLE_STATUS_LABELS: Record<string, string> = { ACTIVE: "生效", DISABLED: "停用" };

/** 未登记的枚举值原样带出，不塌缩成"停用"。 */
function roleStatusLabel(status: string): string {
  return ROLE_STATUS_LABELS[status] ?? `未知状态（${status}）`;
}

function RoleStatusBadge({ status }: { status: string }) {
  const active = status === "ACTIVE";
  const known = status in ROLE_STATUS_LABELS;
  return (
    <Badge
      variant="outline"
      className={`border-transparent ${
        active
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : known
            ? "bg-foreground/[0.08] text-muted-foreground"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      }`}
    >
      {roleStatusLabel(status)}
    </Badge>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{children}</span>;
}

function GrantedCell({ granted, label }: { granted: boolean; label?: string }) {
  if (!granted) {
    return (
      <span className="inline-flex size-5 items-center justify-center">
        <span className="block h-px w-2.5 bg-muted-foreground/45" aria-hidden />
        <span className="sr-only">{label ?? "未授予"}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
      <Icons.Check size={12} strokeWidth={3} aria-hidden />
      <span className="sr-only">{label ?? "已授予"}</span>
    </span>
  );
}

function ToggleChip({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${checked ? "border-foreground/35 bg-foreground/[0.06] text-foreground" : "border-input bg-transparent text-muted-foreground dark:bg-input/30"}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {children}
    </label>
  );
}

// ---------- 对比矩阵 ----------

function MatrixGroup({
  group,
  catalog,
  roles,
  showHint,
  highlightCode,
}: {
  group: AdminPermissionGroup;
  catalog: Map<string, AdminPermissionCatalogEntry>;
  roles: AdminRoleRecord[];
  showHint: boolean;
  highlightCode: string;
}) {
  return (
    <tbody>
      <tr>
        <th
          scope="rowgroup"
          colSpan={roles.length + 1}
          className="sticky left-0 border-y border-border/60 bg-foreground/[0.05] px-4 py-2 text-left"
        >
          <span className="text-xs font-semibold text-foreground">{group.label}</span>
          <span className="ml-2 text-xs font-normal text-muted-foreground">{group.codes.length} 项</span>
          <span className="ml-3 hidden text-xs font-normal text-muted-foreground md:inline">{group.description}</span>
        </th>
      </tr>
      {group.sections.map((section) => (
        <MatrixSection key={section.id} section={section} catalog={catalog} roles={roles} showHint={showHint} highlightCode={highlightCode} />
      ))}
    </tbody>
  );
}

function MatrixSection({
  section,
  catalog,
  roles,
  showHint,
  highlightCode,
}: {
  section: { id: string; label: string; codes: string[] };
  catalog: Map<string, AdminPermissionCatalogEntry>;
  roles: AdminRoleRecord[];
  showHint: boolean;
  highlightCode: string;
}) {
  return (
    <>
      {section.label ? (
        <tr>
          <th scope="rowgroup" colSpan={roles.length + 1} className="sticky left-0 bg-surface py-1.5 pl-7 pr-4 text-left text-xs font-medium text-muted-foreground">
            {section.label}
          </th>
        </tr>
      ) : null}
      {section.codes.map((code) => {
        const permission = catalog.get(code);
        if (!permission) return null;
        const hint = permissionDescription(permission);
        return (
          <tr key={code} className="group border-t border-border/40">
            <th scope="row" className="sticky left-0 z-[1] bg-surface px-4 py-2.5 pl-7 text-left font-normal transition-colors group-hover:bg-surface-raised">
              <span className="block text-sm text-foreground">{permissionLabel(permission)}</span>
              {showHint && hint ? <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{hint}</span> : null}
            </th>
            {roles.map((role) => (
              <td
                key={role.id}
                className={`px-2 py-2.5 text-center transition-colors group-hover:bg-foreground/[0.04] ${
                  role.code === highlightCode ? "border-x border-foreground/20" : "border-l border-border/40"
                }`}
              >
                <GrantedCell granted={role.permissionCodes.includes(code)} />
              </td>
            ))}
          </tr>
        );
      })}
    </>
  );
}

function CapabilityMatrix({
  roles,
  permissions,
  highlightCode,
  onHighlight,
}: {
  roles: AdminRoleRecord[];
  permissions: AdminPermissionCatalogEntry[];
  highlightCode: string;
  onHighlight: (code: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [diffOnly, setDiffOnly] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const catalog = permissionByCode(permissions);
  const allGroups = groupAdminPermissions(permissions);
  const total = allGroups.reduce((sum, group) => sum + group.codes.length, 0);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allGroups
      .map((group) => ({
        ...group,
        sections: group.sections
          .map((section) => ({
            ...section,
            codes: section.codes.filter((code) => {
              const permission = catalog.get(code);
              if (!permission) return false;
              if (needle && !`${permissionLabel(permission)} ${permissionDescription(permission)}`.toLowerCase().includes(needle)) return false;
              if (!diffOnly) return true;
              const first = roles[0] ? roles[0].permissionCodes.includes(code) : false;
              return roles.some((role) => role.permissionCodes.includes(code) !== first);
            }),
          }))
          .filter((section) => section.codes.length > 0),
      }))
      .filter((group) => group.sections.length > 0);
  }, [allGroups, catalog, diffOnly, query, roles]);
  const shown = groups.reduce((sum, group) => sum + group.sections.reduce((s, section) => s + section.codes.length, 0), 0);

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center gap-2">
          <Input
            aria-label="搜索权限"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索权限名称或说明"
            className="focus-visible:outline-none!"
          />
          {query.trim() ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{shown}/{total}</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <ToggleChip checked={diffOnly} onChange={setDiffOnly}>只看有差异</ToggleChip>
          <ToggleChip checked={showHint} onChange={setShowHint}>显示说明</ToggleChip>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/70">
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full min-w-[560px] table-fixed border-collapse bg-surface">
            <colgroup>
              <col />
              {roles.map((role) => (
                <col key={role.id} style={{ width: "112px" }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-border/70 bg-surface">
                <th scope="col" className="sticky left-0 z-20 bg-surface px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  权限
                </th>
                {roles.map((role) => {
                  const active = role.code === highlightCode;
                  return (
                    <th key={role.id} scope="col" className={`bg-surface px-2 py-2 text-center ${active ? "border-x-2 border-foreground/30" : "border-l border-border/40"}`}>
                      <button type="button" onClick={() => onHighlight(role.code)} className="flex w-full flex-col items-center gap-0.5 py-1">
                        <span className={`truncate text-xs ${active ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{role.name}</span>
                        <span className="text-[11px] tabular-nums text-muted-foreground/80">{role.permissionCodes.length}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              <tr className="group border-b border-border/50">
                <th scope="row" className="sticky left-0 z-[1] bg-surface px-4 py-2.5 text-left font-normal transition-colors group-hover:bg-surface-raised">
                  <span className="block text-sm text-foreground">订单核心读取</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">所有生效管理员的系统基础权限</span>
                </th>
                {roles.map((role) => (
                  <td
                    key={role.id}
                    className={`px-2 py-2.5 text-center transition-colors group-hover:bg-foreground/[0.04] ${
                      role.code === highlightCode ? "border-x border-foreground/20" : "border-l border-border/40"
                    }`}
                  >
                    <GrantedCell granted label="系统默认授予" />
                  </td>
                ))}
              </tr>
            </tbody>
            {groups.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={roles.length + 1} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    {query.trim() ? `没有匹配"${query.trim()}"的权限。` : diffOnly ? "这些角色的额外权限相同。" : "服务端权限目录为空。"}
                  </td>
                </tr>
              </tbody>
            ) : (
              groups.map((group) => (
                <MatrixGroup key={group.id} group={group} catalog={catalog} roles={roles} showHint={showHint} highlightCode={highlightCode} />
              ))
            )}
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-border/60 bg-surface px-4 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <GrantedCell granted />已授予
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <GrantedCell granted={false} />未授予
          </span>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {shown} / {total} 项
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------- 权限勾选 ----------

function SectionSelectAll({
  label,
  codes,
  selected,
  disabled,
  onSetMany,
}: {
  label: string;
  codes: string[];
  selected: string[];
  disabled?: boolean;
  onSetMany: (codes: string[], want: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const hit = codes.filter((code) => selected.includes(code)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = hit > 0 && hit < codes.length;
  }, [hit, codes.length]);
  const all = hit === codes.length;
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input ref={ref} type="checkbox" checked={all} disabled={disabled} onChange={() => onSetMany(codes, !all)} />
      <span>{all ? `取消${label} ${codes.length} 项` : `全选${label} ${codes.length} 项`}</span>
    </label>
  );
}

function PermissionGroupBlock({
  group,
  catalog,
  selected,
  disabled,
  forceOpen,
  onToggle,
  onSetMany,
}: {
  group: AdminPermissionGroup;
  catalog: Map<string, AdminPermissionCatalogEntry>;
  selected: string[];
  disabled?: boolean;
  forceOpen: boolean;
  onToggle: (code: string) => void;
  onSetMany: (codes: string[], want: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const hit = group.codes.filter((code) => selected.includes(code)).length;
  const expanded = open || forceOpen;
  const headingId = `role-perm-group-${group.id}`;
  return (
    <div role="group" aria-labelledby={headingId} className="overflow-hidden rounded-lg border border-border/70">
      <div className="flex items-center gap-3 bg-foreground/[0.04] px-3 py-2">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={expanded} aria-controls={`${group.id}-body`} className="flex flex-1 items-center gap-2 text-left">
          <Icons.ChevronDown size={14} className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} aria-hidden />
          <span id={headingId} className="text-sm font-semibold text-foreground">{group.label}</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">{group.description}</span>
        </button>
        <span className={`shrink-0 text-xs tabular-nums ${hit > 0 ? "text-foreground" : "text-muted-foreground"}`}>
          已选 {hit} / {group.codes.length}
        </span>
      </div>
      {expanded ? (
        <div id={`${group.id}-body`} className="divide-y divide-border/50">
          {group.sections.map((section) => (
            <div key={section.id} className="px-3 py-2">
              {section.label ? (
                <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{section.label}</span>
                  <SectionSelectAll label={section.label} codes={section.codes} selected={selected} disabled={disabled} onSetMany={onSetMany} />
                </div>
              ) : null}
              <div className="grid gap-x-4 sm:grid-cols-2">
                {section.codes.map((code) => {
                  const permission = catalog.get(code);
                  if (!permission) return null;
                  const hint = permissionDescription(permission);
                  const checked = selected.includes(code);
                  return (
                    <label key={code} className={`flex items-start gap-2.5 rounded-md px-2 py-2 ${disabled ? "opacity-60" : "hover:bg-foreground/[0.05]"}`}>
                      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={() => onToggle(code)} />
                      <span className="min-w-0">
                        <strong className={`block text-sm ${checked ? "font-semibold text-foreground" : "font-normal text-foreground"}`}>
                          {permissionLabel(permission)}
                        </strong>
                        {hint ? <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{hint}</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------- 角色表单（新建与编辑共用） ----------

type FormState = {
  code: string;
  name: string;
  description: string;
  status: "ACTIVE" | "DISABLED";
  permissionCodes: string[];
};

const EMPTY_FORM: FormState = { code: "", name: "", description: "", status: "ACTIVE", permissionCodes: [] };
const STATUS_ITEMS = { ACTIVE: "生效", DISABLED: "停用" };

function RoleFormDialog({
  open,
  mode,
  roles,
  permissions,
  readOnly,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: { kind: "create" } | { kind: "edit"; role: AdminRoleRecord };
  roles: AdminRoleRecord[];
  permissions: AdminPermissionCatalogEntry[];
  readOnly: boolean;
  onClose: () => void;
  onSaved: (message: string, role?: AdminRoleRecord) => void;
}) {
  const editing = mode.kind === "edit" ? mode.role : null;
  const baseline = useMemo<RoleBaseline | null>(() => (editing ? snapshotRole(editing) : null), [editing]);
  const [form, setForm] = useState<FormState>(() => (baseline ? { ...baseline } : EMPTY_FORM));
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  // 旧编辑器卸载后的保存回调不能控制后来打开的窗口。
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // 只依赖 open：后台刷新会重算 baseline，若一并依赖会冲掉未保存的编辑。
  useEffect(() => {
    if (!open) return;
    setForm(baseline ? { ...baseline } : EMPTY_FORM);
    setCopyFrom(null);
    setQuery("");
    setError(undefined);
    setCloseBlocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const catalog = permissionByCode(permissions);
  const needle = query.trim().toLowerCase();
  const groups = groupAdminPermissions(permissions)
    .map((group) => ({
      ...group,
      sections: group.sections
        .map((section) => ({
          ...section,
          codes: needle
            ? section.codes.filter((code) => {
                const permission = catalog.get(code);
                return permission ? `${permissionLabel(permission)} ${permissionDescription(permission)}`.toLowerCase().includes(needle) : false;
              })
            : section.codes,
        }))
        .filter((section) => section.codes.length > 0),
    }))
    .filter((group) => group.sections.length > 0);
  const copyItems = useMemo(() => Object.fromEntries(roles.map((role) => [role.code, `${role.name}（${role.permissionCodes.length} 项）`])), [roles]);
  const dirty = baseline
    ? roleFormDirty(baseline, form)
    : createRoleFormDirty({ code: form.code, name: form.name, description: form.description, permissionCodes: form.permissionCodes });
  const change = diffPermissionCodes(baseline?.permissionCodes ?? [], form.permissionCodes);
  const changeLabel = (code: string) => permissionLabel(catalog.get(code) ?? { code, name: code });

  const closeDialog = (discard = false) => {
    if (saving) return;
    if (dirty && !discard) { setCloseBlocked(true); return; }
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || readOnly) return;
    setError(undefined);
    setSaving(true);
    try {
      if (editing) {
        await adminRequest("/security/roles/update", {
          code: editing.code,
          name: form.name,
          description: form.description,
          status: form.status,
          permissionCodes: form.permissionCodes,
        });
        if (mounted.current) onSaved("角色配置已保存。关联账号的有效权限将在下一次请求立即变化。");
      } else {
        const created = await adminRequest<AdminRoleRecord>("/security/roles/create", {
          code: form.code,
          name: form.name,
          description: form.description,
          permissionCodes: form.permissionCodes,
        });
        if (mounted.current) onSaved(`角色「${created.name}」已创建。`, created);
      }
    } catch (failure) {
      if (mounted.current) setError(friendlyError(failure));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeDialog(); }}>
      {/* 固定高度：展开分组时只滚内部，弹窗不跳尺寸 */}
      <DialogContent className="flex h-[88vh] w-full flex-col gap-0 p-0 sm:max-w-4xl" showCloseButton={!saving}>
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
          <DialogTitle>{editing ? `${readOnly ? "查看" : "编辑"}角色「${editing.name}」` : "新建角色"}</DialogTitle>
          <DialogDescription>{readOnly ? "角色资料与权限仅供查看。" : editing ? "改动在下一次请求立即生效。" : "先填岗位名称，再勾选需要的额外权限。"}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <fieldset disabled={saving} className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
            <StatusMessage error={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <FieldLabel>角色名称</FieldLabel>
                <Input
                  value={form.name}
                  readOnly={readOnly}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  className="h-9 focus-visible:outline-none!"
                  required
                />
              </label>
              {editing ? (
                <label className="block">
                  <FieldLabel>状态</FieldLabel>
                  <Select
                    value={form.status}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, status: (value ?? "ACTIVE") as FormState["status"] }))}
                    items={STATUS_ITEMS}
                    disabled={readOnly}
                  >
                    <SelectTrigger className="h-9 w-full focus-visible:outline-none!">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">生效</SelectItem>
                      <SelectItem value="DISABLED">停用</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              ) : (
                <label className="block">
                  <FieldLabel>从现有角色复制</FieldLabel>
                  <Select
                    value={copyFrom ?? ""}
                    onValueChange={(value) => {
                      const code = typeof value === "string" ? value : "";
                      setCopyFrom(code || null);
                      const source = roles.find((role) => role.code === code);
                      setForm((prev) => ({ ...prev, permissionCodes: source ? [...source.permissionCodes] : prev.permissionCodes }));
                    }}
                    items={{ "": "不复制，从空白开始", ...copyItems }}
                    disabled={readOnly}
                  >
                    <SelectTrigger className="h-9 w-full focus-visible:outline-none!">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">不复制，从空白开始</SelectItem>
                      {roles.map((role) => (
                        <SelectItem key={role.id} value={role.code}>
                          {role.name}（{role.permissionCodes.length} 项）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
            </div>
            <label className="block">
              <FieldLabel>用途说明</FieldLabel>
              <textarea
                value={form.description}
                readOnly={readOnly}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                rows={2}
                placeholder="例如：负责供给审核与账号处置，不负责资金"
                className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm transition-colors focus-visible:outline-none! focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 placeholder:text-muted-foreground dark:bg-input/30"
              />
            </label>
            {editing && form.status === "DISABLED" ? (
              <p className="rounded-md bg-foreground/[0.04] px-3 py-2 text-xs text-muted-foreground">
                停用后该角色不再参与权限并集，已分配它的账号需要重新配置。
              </p>
            ) : null}
            {!editing ? (
              <label className="block">
                <FieldLabel>角色代码</FieldLabel>
                <Input
                  value={form.code}
                  readOnly={readOnly}
                  onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
                  placeholder="如 finance_ops"
                  className="h-9 max-w-sm font-mono focus-visible:outline-none!"
                  required
                />
                <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
                  给系统内部识别这个角色用的固定名字，页面上不会显示，创建后不能修改。用英文小写加下划线即可，例如 finance_ops。
                </span>
              </label>
            ) : null}

            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-sm font-semibold text-foreground">额外权限</h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  已选 {form.permissionCodes.length} 项
                  {change.added.length > 0 ? ` · 新增 ${change.added.length}` : ""}
                  {change.removed.length > 0 ? ` · 移除 ${change.removed.length}` : ""}
                </span>
              </div>
              {dirty && (change.added.length > 0 || change.removed.length > 0) ? (
                <p className="rounded-md bg-foreground/[0.04] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {[...change.added.map((code) => `+ ${changeLabel(code)}`), ...change.removed.map((code) => `- ${changeLabel(code)}`)].join("、")}
                </p>
              ) : null}
              <Input
                aria-label="搜索权限名称或说明"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索权限名称或说明"
                className="focus-visible:outline-none!"
              />
              {groups.length === 0 ? (
                <p className="rounded-md bg-foreground/[0.04] px-3 py-8 text-center text-sm text-muted-foreground">
                  没有匹配"{query.trim()}"的权限。
                </p>
              ) : null}
              {groups.map((group) => (
                <PermissionGroupBlock
                  key={group.id}
                  group={group}
                  catalog={catalog}
                  selected={form.permissionCodes}
                  disabled={readOnly}
                  forceOpen={needle.length > 0}
                  onToggle={(code) =>
                    setForm((prev) => ({
                      ...prev,
                      permissionCodes: prev.permissionCodes.includes(code)
                        ? prev.permissionCodes.filter((item) => item !== code)
                        : [...prev.permissionCodes, code],
                    }))
                  }
                  onSetMany={(codes, want) =>
                    setForm((prev) => ({
                      ...prev,
                      permissionCodes: want
                        ? [...new Set([...prev.permissionCodes, ...codes])]
                        : prev.permissionCodes.filter((item) => !codes.includes(item)),
                    }))
                  }
                />
              ))}
            </div>
          </fieldset>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border/70 bg-surface px-6 py-3">
            <span className="mr-auto text-xs text-muted-foreground">
              {closeBlocked ? "有未保存的修改，选择“放弃修改”才会关闭。" : dirty ? "有未保存的修改" : editing ? "没有未保存的修改" : "尚未选择权限"}
            </span>
            <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={() => closeDialog(true)}>
              {dirty ? "放弃修改" : "关闭"}
            </Button>
            {!readOnly ? <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
              {editing ? "保存更改" : "创建角色"}
            </Button> : null}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 页面 ----------

export function RoleConfigView({
  snapshot,
  initialCode,
  objectOnly = false,
  onDirtyChange,
  refreshNonce = 0,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  initialCode?: string;
  objectOnly?: boolean;
  onOpenObject?: (code: string, title: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  refreshNonce?: number;
}) {
  const canRead = hasPermission(snapshot, "admin.role.read") || hasPermission(snapshot, "admin.permission.read");
  const canConfigure = hasPermission(snapshot, "admin.role.configure");
  const canReadAccounts = hasPermission(snapshot, "admin.account.read");
  const [roles, setRoles] = useState<AdminRoleRecord[]>([]);
  const [permissions, setPermissions] = useState<AdminPermissionCatalogEntry[]>([]);
  const [memberCounts, setMemberCounts] = useState<Map<string, number> | null>(null);
  const [bossCount, setBossCount] = useState<number | null>(null);
  const [highlightCode, setHighlightCode] = useState("");
  const [dialog, setDialog] = useState<{ kind: "create" } | { kind: "edit"; role: AdminRoleRecord } | null>(null);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const directoryScope = directoryScopeOf(snapshot);
  const directoryScopeRef = useRef(directoryScope);
  directoryScopeRef.current = directoryScope;
  const load = useCallback(async () => {
    const requested = directoryScopeRef.current;
    const catalog = await adminRequest<{ roles?: AdminRoleRecord[]; permissions?: AdminPermissionCatalogEntry[] }>("/security/roles");
    setRoles(catalog.roles ?? []);
    setPermissions(catalog.permissions ?? []);
    if (canReadAccounts) {
      try {
        const directory = await readAdminDirectoryShared(requested);
        if (directoryScopeRef.current !== requested) return;
        const admins = directory.admins ?? [];
        const next = new Map<string, number>();
        for (const admin of admins) {
          for (const role of admin.roles ?? []) next.set(role.code, (next.get(role.code) ?? 0) + 1);
        }
        setMemberCounts(next);
        setBossCount(admins.filter((admin) => admin.isBoss).length);
      } catch {
        setMemberCounts(null);
        setBossCount(null);
      }
    }
  }, [canReadAccounts]);

  useEffect(() => {
    if (!canRead) return;
    setReady(false);
    void load().then(() => setReady(true)).catch((failure) => setError(friendlyError(failure)));
  }, [canRead, load, refreshNonce, attempt, directoryScope]);

  useEffect(() => {
    const first = roles[0];
    if (!first) return;
    setHighlightCode((current) => (current && roles.some((role) => role.code === current) ? current : first.code));
  }, [roles]);

  // 深链 /roles/:code 复用同一个编辑弹窗，避免出现两套编辑界面。
  useEffect(() => {
    if (!objectOnly || !initialCode || roles.length === 0) return;
    const target = roles.find((role) => role.code === initialCode);
    setDialog(target ? { kind: "edit", role: target } : null);
  }, [initialCode, objectOnly, roles]);

  useEffect(() => {
    onDirtyChange?.(Boolean(dialog));
  }, [dialog, onDirtyChange]);

  const highlighted = roles.find((role) => role.code === highlightCode);
  const permissionTotal = groupAdminPermissions(permissions).reduce((sum, group) => sum + group.codes.length, 0);

  if (!canRead) {
    return <StatusMessage error="当前账号没有查看角色配置的权限。" />;
  }

  if (objectOnly && !ready) {
    return (
      <div role="status" aria-label="正在读取角色配置" className="space-y-3">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-96 w-full" />
        <span className="sr-only">正在读取角色配置</span>
      </div>
    );
  }

  if (objectOnly && initialCode && ready && !roles.some((role) => role.code === initialCode)) {
    return (
      <div className="space-y-3">
        <StatusMessage error={error ?? `找不到角色 ${initialCode}，它可能已被删除或不在你的可见范围内。`} />
        <Button type="button" size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
          重新读取
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">预设角色</h1>
          <p className="mt-1 text-sm tabular-nums text-muted-foreground">
            {ready ? `${roles.length} 个角色 · ${permissionTotal} 项额外权限` : "正在读取…"}
          </p>
        </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!highlighted}
              onClick={() => highlighted && setDialog({ kind: "edit", role: highlighted })}
            >
              {canConfigure ? `编辑「${highlighted?.name}」` : `查看「${highlighted?.name}」权限`}
            </Button>
            {canConfigure ? <Button type="button" size="sm" onClick={() => setDialog({ kind: "create" })}>
              新建角色
            </Button> : null}
          </div>
      </div>
      <StatusMessage error={error} success={message} />

      {!ready ? (
        <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-2">
            <Skeleton className="h-[84px] w-full" />
            <Skeleton className="h-[84px] w-full" />
          </div>
          <Skeleton className="h-[420px] w-full" />
        </div>
      ) : roles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 px-6 py-16 text-center">
          <p className="text-sm font-medium text-foreground">还没有角色</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            角色决定管理员能做什么。新建一个，之后在管理员账号上分配给需要的人。
          </p>
          {canConfigure ? (
            <Button type="button" size="sm" className="mt-4" onClick={() => setDialog({ kind: "create" })}>
              新建角色
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="min-w-0">
            {/* Boss 是账号级旁路而非角色：可显示，但不可选、不可编辑、不编造权限数 */}
            <TooltipProvider delay={300}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div className="role-boss" />
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="role-boss-mark">
                        <Icons.ShieldCheck size={15} aria-hidden />
                      </span>
                      <span className="truncate text-sm font-semibold text-foreground">Boss</span>
                    </span>
                    <span className="role-boss-badge shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">最高权限</span>
                  </div>
                  <p className="role-boss-note mt-2 text-xs">系统旁路 · 不可配置</p>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">使用成员 {bossCount ?? "—"}</p>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-64 leading-relaxed">
                  Boss 不是角色，由系统直接配置，不能创建、编辑或停用。Boss 账号持有平台全部权限，业务范围恒为全部游戏，且不能自行修改。
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <ul className="mt-3 space-y-2">
              {roles.map((role) => {
                const active = role.code === highlightCode;
                return (
                  <li key={role.id}>
                    <button
                      type="button"
                      onClick={() => setHighlightCode(role.code)}
                      aria-current={active ? "true" : undefined}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        active ? "border-foreground/35 bg-foreground/[0.06]" : "border-border/60 hover:border-foreground/20 hover:bg-foreground/[0.03]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-foreground">{role.name}</span>
                        <RoleStatusBadge status={role.status} />
                      </div>
                      <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
                        <div className="flex items-baseline gap-1.5">
                          <dt className="text-xs text-muted-foreground">额外权限</dt>
                          <dd className="text-xs font-medium tabular-nums text-foreground">{role.permissionCodes.length}</dd>
                        </div>
                        <div className="flex items-baseline gap-1.5">
                          <dt className="text-xs text-muted-foreground">使用成员</dt>
                          <dd className="text-xs font-medium tabular-nums text-foreground">
                            {memberCounts ? (memberCounts.get(role.code) ?? 0) : "—"}
                          </dd>
                        </div>
                      </dl>
                    </button>
                  </li>
                );
              })}
            </ul>
            {!canConfigure ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">你可以查看角色，但不能修改。需要调整请联系平台安全管理员。</p>
            ) : null}
          </aside>
          <div className="hidden min-w-0 lg:block">
            <CapabilityMatrix
              roles={roles}
              permissions={permissions}
              highlightCode={highlightCode}
              onHighlight={setHighlightCode}
            />
          </div>
          <p className="text-sm text-muted-foreground lg:hidden">选中角色后，用页面上方的按钮查看完整权限。</p>
        </div>
      )}

      {dialog ? (
        <RoleFormDialog
          key={dialog.kind === "edit" ? dialog.role.code : "create"}
          open
          mode={dialog}
          roles={roles}
          permissions={permissions}
          readOnly={!canConfigure}
          onClose={() => setDialog(null)}
          onSaved={(text, created) => {
            setDialog(null);
            setMessage(text);
            void load();
            if (created) setHighlightCode(created.code);
          }}
        />
      ) : null}
    </div>
  );
}
