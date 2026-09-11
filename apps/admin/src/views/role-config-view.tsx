import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { Icons } from "../components/icons";
import { Button, StatusMessage } from "../components/ui-elements";
import {
  adminRequest,
  friendlyError,
  hasPermission,
  type AdminPermissionCatalogEntry,
  type AdminRoleRecord,
  type SessionSnapshot,
} from "../api";
import { rolePageDirty, shouldApplyServerRole, snapshotRole, type RoleBaseline } from "../workspace/role-draft";

export function RoleConfigView({
  snapshot,
  initialCode,
  objectOnly = false,
  onOpenObject,
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
  const [roles, setRoles] = useState<AdminRoleRecord[]>([]);
  const [permissions, setPermissions] = useState<AdminPermissionCatalogEntry[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | undefined>(initialCode);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"ACTIVE" | "DISABLED">("ACTIVE");
  const [permissionCodes, setPermissionCodes] = useState<string[]>([]);
  const [createCode, setCreateCode] = useState("");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createPermissions, setCreatePermissions] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [baselineEpoch, setBaselineEpoch] = useState(0);

  const load = useCallback(async () => {
    const catalog = await adminRequest<{ roles?: AdminRoleRecord[]; permissions?: AdminPermissionCatalogEntry[] }>("/security/roles");
    setRoles(catalog.roles ?? []);
    setPermissions(catalog.permissions ?? []);
  }, []);

  useEffect(() => {
    if (!canRead) return;
    void load().catch((failure) => setError(friendlyError(failure)));
  }, [canRead, load, refreshNonce]);

  useEffect(() => {
    if (initialCode) setSelectedCode(initialCode);
  }, [initialCode]);

  const baselineRef = useRef<RoleBaseline | null>(null);
  const formRef = useRef({ name, description, status, permissionCodes });
  formRef.current = { name, description, status, permissionCodes };

  const acceptRoleSnapshot = useCallback((incoming: RoleBaseline) => {
    formRef.current = {
      name: incoming.name,
      description: incoming.description,
      status: incoming.status,
      permissionCodes: incoming.permissionCodes,
    };
    setName(incoming.name);
    setDescription(incoming.description);
    setStatus(incoming.status);
    setPermissionCodes(incoming.permissionCodes);
    baselineRef.current = incoming;
    setBaselineEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    const current = roles.find((role) => role.code === selectedCode);
    if (!current || !selectedCode) return;
    const incoming = snapshotRole(current);
    if (!shouldApplyServerRole(baselineRef.current, formRef.current, incoming)) return;
    acceptRoleSnapshot(incoming);
  }, [acceptRoleSnapshot, roles, selectedCode]);

  useEffect(() => {
    if (!onDirtyChange) return;
    onDirtyChange(
      rolePageDirty(baselineRef.current, selectedCode, { name, description, status, permissionCodes }, {
        code: createCode,
        name: createName,
        description: createDescription,
        permissionCodes: createPermissions,
      }),
    );
  }, [baselineEpoch, createCode, createDescription, createName, createPermissions, description, name, onDirtyChange, permissionCodes, selectedCode, status]);

  const toggle = (list: string[], value: string, setter: (next: string[]) => void) => {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCode) return;
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      await adminRequest("/security/roles/update", {
        code: selectedCode,
        name,
        description,
        status,
        permissionCodes,
      });
      acceptRoleSnapshot(snapshotRole({
        code: selectedCode,
        name,
        description,
        status,
        permissionCodes,
      }));
      await load();
      setMessage("角色配置已保存。关联账号的有效权限将在下一次请求立即变化。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setLoading(true);
    try {
      const created = await adminRequest<AdminRoleRecord>("/security/roles/create", {
        code: createCode,
        name: createName,
        description: createDescription,
        permissionCodes: createPermissions,
      });
      setCreateCode("");
      setCreateName("");
      setCreateDescription("");
      setCreatePermissions([]);
      acceptRoleSnapshot(snapshotRole(created));
      setSelectedCode(created.code);
      await load();
      setMessage("预设角色已创建。");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  };

  if (!canRead) {
    return (
      <section className="section-panel">
        <StatusMessage error="当前账号没有查看角色配置的权限。" />
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {objectOnly ? null : (
      <section className="section-panel">
        <div className="panel-heading">
          <div>
            <h3>预设角色</h3>
            <p>角色是可配置的权限集合。名称不会在服务端硬编码为固定能力。</p>
          </div>
          <Icons.Key size={20} className="text-muted-foreground" />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>标识</th>
                <th>名称</th>
                <th>状态</th>
                <th>权限</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr
                  key={role.id}
                  className={role.code === selectedCode ? "selected" : ""}
                  onClick={() => {
                    if (onOpenObject) onOpenObject(role.code, role.name);
                    else setSelectedCode(role.code);
                  }}
                >
                  <td className="font-mono">{role.code}</td>
                  <td>{role.name}</td>
                  <td>{role.status === "ACTIVE" ? "生效" : "停用"}</td>
                  <td>{role.permissionCodes.join("、") || "未配置"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {objectOnly || !canConfigure ? null : (
        <section className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>新建角色</h3>
              <p>只能授予自己当前持有的操作权限。</p>
            </div>
          </div>
          <form onSubmit={create} className="space-y-4" noValidate>
            <div className="grid grid-cols-2 gap-3">
              <input
                value={createCode}
                onChange={(event) => setCreateCode(event.target.value)}
                className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs font-mono"
                placeholder="稳定标识，如 finance_ops"
                required
              />
              <input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs"
                placeholder="显示名称"
                required
              />
            </div>
            <textarea
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              rows={2}
              className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs"
              placeholder="可选说明"
            />
            <div className="permission-grid">
              {permissions.map((permission) => (
                <label key={permission.code} className="permission-chip">
                  <input
                    type="checkbox"
                    checked={createPermissions.includes(permission.code)}
                    onChange={() => toggle(createPermissions, permission.code, setCreatePermissions)}
                  />
                  <span>
                    <strong>{permission.name}</strong>
                    <em>{permission.code}</em>
                  </span>
                </label>
              ))}
            </div>
            <Button type="submit" size="sm" loading={loading} disabled={!createCode.trim() || !createName.trim()}>
              创建角色
            </Button>
          </form>
        </section>
      )}

      {selectedCode ? (
        <section className="section-panel">
          <div className="panel-heading">
            <div>
              <h3>编辑 {name || selectedCode}</h3>
              <p>停用后该角色不再参与权限并集。审批引擎不在本包范围。</p>
            </div>
          </div>
          <StatusMessage error={error} success={message} />
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="grid grid-cols-2 gap-3">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs"
                disabled={!canConfigure}
                required
              />
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as "ACTIVE" | "DISABLED")}
                className="w-full h-9 px-3 rounded border border-border bg-surface-raised text-xs"
                disabled={!canConfigure}
              >
                <option value="ACTIVE">生效</option>
                <option value="DISABLED">停用</option>
              </select>
            </div>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              className="w-full p-2.5 rounded border border-border bg-surface-raised text-xs"
              disabled={!canConfigure}
            />
            <div className="permission-grid">
              {permissions.map((permission) => (
                <label key={permission.code} className="permission-chip">
                  <input
                    type="checkbox"
                    checked={permissionCodes.includes(permission.code)}
                    disabled={!canConfigure}
                    onChange={() => toggle(permissionCodes, permission.code, setPermissionCodes)}
                  />
                  <span>
                    <strong>{permission.name}</strong>
                    <em>{permission.code}</em>
                  </span>
                </label>
              ))}
            </div>
            {canConfigure ? (
              <Button type="submit" size="sm" loading={loading}>保存角色</Button>
            ) : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}
