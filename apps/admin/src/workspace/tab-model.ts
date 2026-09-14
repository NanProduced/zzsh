export const WORKBENCH_TAB_ID = "workbench";
const STORAGE_PREFIX = "zzsh-admin-workspace-tabs:";
const SENSITIVE_QUERY = /(password|pin|otp|totp|backup|credential|token|secret|temporary)/i;

export type WorkspaceRouteKind =
  | "workbench"
  | "account"
  | "admins"
  | "admin-object"
  | "roles"
  | "role-object"
  | "approvals"
  | "approval-object"
  | "audit"
  | "user-restore"
  | "catalog"
  | "gunsmith"
  | "rules"
  | "listing-review"
  | "media-review"
  | "content"
  | "unknown";

export type WorkspaceTab = {
  id: string;
  title: string;
  path: string;
  query: Record<string, string>;
  closable: boolean;
  kind: WorkspaceRouteKind;
  objectType?: string;
  objectId?: string;
};

export type PersistedWorkspaceTabs = {
  adminUserId: string;
  activeId: string;
  tabs: WorkspaceTab[];
};

export type NavPermission = {
  isBoss: boolean;
  permissions: string[];
};

const LIST_TABS: Record<string, Omit<WorkspaceTab, "query">> = {
  [WORKBENCH_TAB_ID]: { id: WORKBENCH_TAB_ID, title: "工作台", path: "/workbench", closable: false, kind: "workbench" },
  account: { id: "account", title: "账号安全", path: "/account", closable: true, kind: "account" },
  admins: { id: "admins", title: "管理员", path: "/admins", closable: true, kind: "admins" },
  roles: { id: "roles", title: "角色权限", path: "/roles", closable: true, kind: "roles" },
  approvals: { id: "approvals", title: "审批与审计", path: "/approvals", closable: true, kind: "approvals" },
  audit: { id: "audit", title: "账号与权限审计", path: "/audit", closable: true, kind: "audit" },
  "user-restore": { id: "user-restore", title: "用户账号恢复", path: "/users/restore", closable: true, kind: "user-restore" },
  catalog: { id: "catalog", title: "目录维护", path: "/supply/catalog", closable: true, kind: "catalog" },
  gunsmith: { id: "gunsmith", title: "改枪码目录", path: "/supply/gunsmith", closable: true, kind: "gunsmith" },
  rules: { id: "rules", title: "规则与价目", path: "/supply/rules", closable: true, kind: "rules" },
  "listing-review": { id: "listing-review", title: "供给审核", path: "/supply/reviews", closable: true, kind: "listing-review" },
  "media-review": { id: "media-review", title: "平台素材审核", path: "/supply/media", closable: true, kind: "media-review" },
  content: { id: "content", title: "内容管理", path: "/content", closable: true, kind: "content" },
};

export function sanitizeTabQuery(query: Record<string, string> | URLSearchParams): Record<string, string> {
  const source = query instanceof URLSearchParams ? Object.fromEntries(query.entries()) : query;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key || SENSITIVE_QUERY.test(key) || SENSITIVE_QUERY.test(value)) continue;
    if (value.length > 200) continue;
    result[key] = value;
  }
  return result;
}

export function parseWorkspacePath(pathname: string): { kind: WorkspaceRouteKind; objectType?: string; objectId?: string; tabId: string; path: string; title: string } {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/workbench") return { kind: "workbench", tabId: WORKBENCH_TAB_ID, path: "/workbench", title: "工作台" };
  if (path === "/account") return { kind: "account", tabId: "account", path: "/account", title: "账号安全" };
  if (path === "/admins") return { kind: "admins", tabId: "admins", path: "/admins", title: "管理员" };
  const adminObject = path.match(/^\/admins\/([^/]+)$/);
  if (adminObject) {
    const objectId = decodeURIComponent(adminObject[1] ?? "");
    return { kind: "admin-object", objectType: "admin", objectId, tabId: `admin:${objectId}`, path, title: objectId };
  }
  if (path === "/roles") return { kind: "roles", tabId: "roles", path: "/roles", title: "角色权限" };
  const roleObject = path.match(/^\/roles\/([^/]+)$/);
  if (roleObject) {
    const objectId = decodeURIComponent(roleObject[1] ?? "");
    return { kind: "role-object", objectType: "role", objectId, tabId: `role:${objectId}`, path, title: objectId };
  }
  if (path === "/approvals") return { kind: "approvals", tabId: "approvals", path: "/approvals", title: "审批与审计" };
  const approvalObject = path.match(/^\/approvals\/([^/]+)$/);
  if (approvalObject) {
    const objectId = decodeURIComponent(approvalObject[1] ?? "");
    return { kind: "approval-object", objectType: "approval", objectId, tabId: `approval:${objectId}`, path, title: "审批详情" };
  }
  if (path === "/audit") return { kind: "audit", tabId: "audit", path: "/audit", title: "账号与权限审计" };
  if (path === "/users/restore") return { kind: "user-restore", tabId: "user-restore", path: "/users/restore", title: "用户账号恢复" };
  if (path === "/supply/catalog") return { kind: "catalog", tabId: "catalog", path: "/supply/catalog", title: "目录维护" };
  if (path === "/supply/gunsmith") return { kind: "gunsmith", tabId: "gunsmith", path: "/supply/gunsmith", title: "改枪码目录" };
  if (path === "/supply/rules") return { kind: "rules", tabId: "rules", path: "/supply/rules", title: "规则与价目" };
  if (path === "/supply/reviews") return { kind: "listing-review", tabId: "listing-review", path: "/supply/reviews", title: "供给审核" };
  if (path === "/supply/media") return { kind: "media-review", tabId: "media-review", path: "/supply/media", title: "平台素材审核" };
  if (path === "/content") return { kind: "content", tabId: "content", path: "/content", title: "内容管理" };
  return { kind: "unknown", tabId: WORKBENCH_TAB_ID, path: "/workbench", title: "工作台" };
}

export function tabFromLocation(pathname: string, search = ""): WorkspaceTab {
  const parsed = parseWorkspacePath(pathname);
  const query = sanitizeTabQuery(new URLSearchParams(search.startsWith("?") ? search.slice(1) : search));
  const base = LIST_TABS[parsed.tabId];
  if (base) return { ...base, query };
  return {
    id: parsed.tabId,
    title: parsed.title,
    path: parsed.path,
    query,
    closable: true,
    kind: parsed.kind,
    objectType: parsed.objectType,
    objectId: parsed.objectId,
  };
}

export function tabHref(tab: WorkspaceTab): string {
  const params = new URLSearchParams(sanitizeTabQuery(tab.query));
  const query = params.toString();
  return query ? `${tab.path}?${query}` : tab.path;
}

export function canOpenKind(kind: WorkspaceRouteKind, nav: NavPermission): boolean {
  const has = (code: string) => nav.permissions.includes(code);
  if (kind === "workbench" || kind === "account") return true;
  if (kind === "admins" || kind === "admin-object") return has("admin.account.read") || nav.isBoss;
  if (kind === "roles" || kind === "role-object") return has("admin.role.read") || has("admin.permission.read");
  if (kind === "approvals" || kind === "approval-object") {
    return ["approval.request.read", "approval.request.approve", "approval.template.read", "approval.audit.read"].some(has);
  }
  if (kind === "audit") return has("admin.audit.read");
  if (kind === "user-restore") return has("user.account.restore");
  if (kind === "catalog") return has("supply.catalog.manage") || nav.isBoss;
  if (kind === "gunsmith") return has("supply.gunsmith.manage") || nav.isBoss;
  if (kind === "rules") return has("supply.rules.edit") || nav.isBoss;
  if (kind === "listing-review") return has("supply.review.read") || nav.isBoss;
  if (kind === "media-review") return has("supply.review.read") || nav.isBoss;
  if (kind === "content") return has("content.platform.read") || has("content.read") || nav.isBoss;
  return false;
}

export function upsertTab(tabs: WorkspaceTab[], next: WorkspaceTab): WorkspaceTab[] {
  if (next.kind === "admins" || next.kind === "roles" || next.kind === "approvals" || next.kind === "audit" || next.kind === "account" || next.kind === "user-restore" || next.kind === "workbench" || next.kind === "catalog" || next.kind === "gunsmith" || next.kind === "rules" || next.kind === "media-review" || next.kind === "listing-review" || next.kind === "content") {
    const existing = tabs.find((tab) => tab.id === next.id);
    if (existing) return tabs.map((tab) => (tab.id === next.id ? { ...existing, ...next, query: { ...existing.query, ...next.query } } : tab));
    return [...tabs, next];
  }
  const existing = tabs.find((tab) => tab.id === next.id);
  if (existing) return tabs.map((tab) => (tab.id === next.id ? { ...existing, ...next } : tab));
  return [...tabs, next];
}

export function tabsRemovedBy(tabs: WorkspaceTab[], action: "self" | "others" | "right", targetId: string): WorkspaceTab[] {
  const index = tabs.findIndex((tab) => tab.id === targetId);
  if (index < 0) return [];
  return tabs.filter((tab, tabIndex) => {
    if (!tab.closable) return false;
    if (action === "self") return tab.id === targetId;
    if (action === "others") return tab.id !== targetId;
    return tabIndex > index;
  });
}

export function closeTabs(tabs: WorkspaceTab[], activeId: string, action: "self" | "others" | "right", targetId: string): { tabs: WorkspaceTab[]; activeId: string } {
  const index = tabs.findIndex((tab) => tab.id === targetId);
  if (index < 0) return { tabs, activeId };
  const removed = new Set(tabsRemovedBy(tabs, action, targetId).map((tab) => tab.id));
  const next = tabs.filter((tab) => !removed.has(tab.id));
  const kept = next.length === 0 ? [tabFromLocation("/workbench")] : next;
  const stillActive = kept.some((tab) => tab.id === activeId);
  const fallback = kept[Math.min(Math.max(index, 0), kept.length - 1)] ?? kept[0]!;
  return { tabs: kept, activeId: stillActive ? activeId : fallback.id };
}

export function filterTabsByPermission(tabs: WorkspaceTab[], nav: NavPermission): WorkspaceTab[] {
  const kept = tabs.filter((tab) => canOpenKind(tab.kind, nav));
  if (!kept.some((tab) => tab.id === WORKBENCH_TAB_ID)) {
    return [tabFromLocation("/workbench"), ...kept];
  }
  return kept;
}

export function persistTabs(adminUserId: string, state: { tabs: WorkspaceTab[]; activeId: string }): void {
  if (typeof sessionStorage === "undefined") return;
  const payload: PersistedWorkspaceTabs = {
    adminUserId,
    activeId: state.activeId,
    tabs: state.tabs.map((tab) => ({ ...tab, query: sanitizeTabQuery(tab.query) })),
  };
  sessionStorage.setItem(`${STORAGE_PREFIX}${adminUserId}`, JSON.stringify(payload));
}

export function restoreTabs(adminUserId: string, nav: NavPermission): { tabs: WorkspaceTab[]; activeId: string } | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${adminUserId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedWorkspaceTabs;
    if (parsed.adminUserId !== adminUserId || !Array.isArray(parsed.tabs)) return null;
    const tabs = filterTabsByPermission(
      parsed.tabs
        .filter((tab) => tab && typeof tab.id === "string" && typeof tab.path === "string")
        .map((tab) => ({ ...tab, query: sanitizeTabQuery(tab.query ?? {}) })),
      nav,
    );
    const activeId = tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId : WORKBENCH_TAB_ID;
    return { tabs, activeId };
  } catch {
    return null;
  }
}

export function clearTabs(adminUserId?: string): void {
  if (typeof sessionStorage === "undefined") return;
  if (adminUserId) {
    sessionStorage.removeItem(`${STORAGE_PREFIX}${adminUserId}`);
    return;
  }
  const keys: string[] = [];
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  for (const key of keys) sessionStorage.removeItem(key);
}

export function listTabTemplate(id: keyof typeof LIST_TABS | string): WorkspaceTab | undefined {
  const template = LIST_TABS[id];
  return template ? { ...template, query: {} } : undefined;
}

export function tabFromKeyboard(
  tabs: WorkspaceTab[],
  activeId: string,
  key: string,
): { type: "activate"; id: string } | { type: "close"; id: string } | null {
  if (tabs.length === 0) return null;
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));
  if (key === "ArrowRight") {
    const next = tabs[(index + 1) % tabs.length];
    return next ? { type: "activate", id: next.id } : null;
  }
  if (key === "ArrowLeft") {
    const next = tabs[(index - 1 + tabs.length) % tabs.length];
    return next ? { type: "activate", id: next.id } : null;
  }
  if (key === "Home") return { type: "activate", id: tabs[0]!.id };
  if (key === "End") return { type: "activate", id: tabs[tabs.length - 1]!.id };
  if (key === "Delete" || key === "Backspace") {
    const tab = tabs[index];
    if (tab?.closable) return { type: "close", id: tab.id };
  }
  return null;
}
