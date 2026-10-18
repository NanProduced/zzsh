export const WORKBENCH_TAB_ID = "workbench";
const STORAGE_PREFIX = "zzsh-admin-workspace-tabs:";
const SENSITIVE_QUERY = /(password|pin|otp|totp|backup|credential|token|secret|temporary|phone)/i;
const NON_PERSISTED_ORDER_QUERY = /^(displayNo|renterUserId|ownerUserId|createdFrom|createdTo|qKind|qValue)$/i;
const PHONE_VALUE = /(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/;

export type WorkspaceRouteKind =
  | "workbench"
  | "support"
  | "membership-growth"
  | "distribution-policy"
  | "account"
  | "settings"
  | "admins"
  | "admin-object"
  | "roles"
  | "role-object"
  | "approvals"
  | "approval-object"
  | "audit"
  | "user-restore"
  | "users"
  | "user-object"
  | "catalog"
  | "gunsmith"
  | "rules"
  | "listing-review"
  | "listing-object"
  | "media-review"
  | "content"
  | "orders"
  | "order-object"
  | "resource-object"
  | "finance-lookup"
  | "finance-period"
  | "finance-document"
  | "finance-user"
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

const DETAIL_TAB_TYPES: Partial<Record<WorkspaceRouteKind, string>> = {
  "admin-object": "管理员", "role-object": "角色", "approval-object": "审批",
  "user-object": "用户", "listing-object": "供给账号", "order-object": "订单",
  "resource-object": "资源账号", "finance-document": "资金单据", "finance-user": "用户资金",
};
const GENERIC_DETAIL_TITLES = new Set(["审批详情", "账号供给详情", "资源账号", "资金单据", "用户资金"]);

export function tabPresentation(tab: WorkspaceTab, tabs: WorkspaceTab[]) {
  const type = DETAIL_TAB_TYPES[tab.kind];
  const name = (item: WorkspaceTab) => (!item.title.trim() || GENERIC_DETAIL_TITLES.has(item.title))
    ? item.objectId || item.title : item.title;
  let label = type ? name(tab) : tab.title;
  if (type && tab.objectId) {
    const siblings = tabs.filter((item) => item.kind === tab.kind && item.id !== tab.id && name(item) === label);
    if (siblings.length) {
      const shortId = tab.objectId.slice(-8);
      const suffix = siblings.some((item) => item.objectId?.slice(-8) === shortId) ? tab.objectId : shortId;
      label = `${label} · ${suffix}`;
    }
  }
  return { type, label, description: type ? `${type}详情：${label}` : label };
}

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
  support: { id: "support", title: "客服工作台", path: "/support", closable: true, kind: "support" },
  "membership-growth": { id: "membership-growth", title: "会员成长", path: "/membership-growth", closable: true, kind: "membership-growth" },
  "distribution-policy": { id: "distribution-policy", title: "分销政策", path: "/distribution-policy", closable: true, kind: "distribution-policy" },
  account: { id: "account", title: "账号安全", path: "/account", closable: true, kind: "account" },
  settings: { id: "settings", title: "设置", path: "/settings", closable: true, kind: "settings" },
  admins: { id: "admins", title: "管理员管理", path: "/admins", closable: true, kind: "admins" },
  roles: { id: "roles", title: "角色权限", path: "/roles", closable: true, kind: "roles" },
  approvals: { id: "approvals", title: "审批中心", path: "/approvals", closable: true, kind: "approvals" },
  audit: { id: "audit", title: "账号与权限审计", path: "/audit", closable: true, kind: "audit" },
  "user-restore": { id: "user-restore", title: "账号恢复", path: "/users/restore", closable: true, kind: "user-restore" },
  users: { id: "users", title: "用户管理", path: "/users", closable: true, kind: "users" },
  catalog: { id: "catalog", title: "目录维护", path: "/supply/catalog", closable: true, kind: "catalog" },
  gunsmith: { id: "gunsmith", title: "改枪码目录", path: "/supply/gunsmith", closable: true, kind: "gunsmith" },
  rules: { id: "rules", title: "规则与价目", path: "/supply/rules", closable: true, kind: "rules" },
  "listing-review": { id: "listing-review", title: "账号供给", path: "/supply/reviews", closable: true, kind: "listing-review" },
  "media-review": { id: "media-review", title: "平台素材审核", path: "/supply/media", closable: true, kind: "media-review" },
  orders: { id: "orders", title: "订单", path: "/orders", closable: true, kind: "orders" },
  content: { id: "content", title: "内容管理", path: "/content", closable: true, kind: "content" },
};

export function sanitizeTabQuery(query: Record<string, string> | URLSearchParams): Record<string, string> {
  const source = query instanceof URLSearchParams ? Object.fromEntries(query.entries()) : query;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key || (key.toLowerCase() === "theme" && value !== "light" && value !== "dark") || SENSITIVE_QUERY.test(key) || SENSITIVE_QUERY.test(value) || PHONE_VALUE.test(value) || NON_PERSISTED_ORDER_QUERY.test(key)) continue;
    if (value.length > (key === "cursor" ? 2048 : key === "supplyCursorHistory" ? 8192 : 200)) continue;
    result[key] = value;
  }
  return result;
}

export function sanitizePersistedTabQuery(query: Record<string, string> | URLSearchParams): Record<string, string> {
  const clean = sanitizeTabQuery(query);
  delete clean.theme;
  return clean;
}

export function parseWorkspacePath(pathname: string): { kind: WorkspaceRouteKind; objectType?: string; objectId?: string; tabId: string; path: string; title: string } {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/workbench") return { kind: "workbench", tabId: WORKBENCH_TAB_ID, path: "/workbench", title: "工作台" };
  if (path === "/settings") return { kind: "settings", tabId: "settings", path: "/settings", title: "设置" };
  if (path === "/account") return { kind: "account", tabId: "account", path: "/account", title: "账号安全" };
  if (path === "/support") return { kind: "support", tabId: "support", path: "/support", title: "客服工作台" };
  if (path === "/membership-growth") return { kind: "membership-growth", tabId: "membership-growth", path: "/membership-growth", title: "会员成长" };
  if (path === "/distribution-policy") return { kind: "distribution-policy", tabId: "distribution-policy", path: "/distribution-policy", title: "分销政策" };
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
  if (path === "/users") return { kind: "users", tabId: "users", path, title: "用户管理" };
  const userObject = path.match(/^\/users\/([^/]+)$/);
  if (userObject) {
    let objectId = ""; try { objectId = decodeURIComponent(userObject[1] ?? ""); } catch { /* Invalid IDs follow the existing unknown-route path. */ }
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(objectId)) return { kind: "user-object", objectType: "user", objectId, tabId: `user:${objectId}`, path, title: objectId };
  }
  if (path === "/supply/catalog") return { kind: "catalog", tabId: "catalog", path: "/supply/catalog", title: "目录维护" };
  const resourceObject=path.match(/^\/supply\/accounts\/([A-Za-z0-9._:-]+)$/);
  if(resourceObject)return {kind:"resource-object",objectType:"resource",objectId:resourceObject[1]!,tabId:`resource:${resourceObject[1]}`,path,title:"资源账号"};
  if (path === "/supply/gunsmith") return { kind: "gunsmith", tabId: "gunsmith", path: "/supply/gunsmith", title: "改枪码目录" };
  if (path === "/supply/rules") return { kind: "rules", tabId: "rules", path: "/supply/rules", title: "规则与价目" };
  if (path === "/supply/reviews") return { kind: "listing-review", tabId: "listing-review", path: "/supply/reviews", title: "账号供给" };
  const listingObject = path.match(/^\/supply\/reviews\/([^/]+)$/);
  if (listingObject) {
    let objectId = ""; try { objectId = decodeURIComponent(listingObject[1]!); } catch { /* Follow the existing unknown-route path. */ }
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(objectId)) return { kind: "listing-object", objectType: "supply", objectId, tabId: `supply:${objectId}`, path, title: "账号供给详情" };
  }
  if (path === "/supply/media") return { kind: "media-review", tabId: "media-review", path: "/supply/media", title: "平台素材审核" };
  if (path === "/orders") return { kind: "orders", tabId: "orders", path, title: "订单" };
  const orderObject = path.match(/^\/orders\/([^/]+)$/);
  if (orderObject) {
    const objectId = decodeURIComponent(orderObject[1] ?? "");
    return { kind: "order-object", objectType: "order", objectId, tabId: `order:${objectId}`, path, title: objectId };
  }
  if (path === "/finance") return {kind:"finance-lookup",tabId:"finance-lookup",path,title:"资金查找"};
  if (path === "/finance/period") return {kind:"finance-period",tabId:"finance-period",path,title:"期间核对"};
  const financeObject=/^\/finance\/(documents|users)\/([^/]+)$/.exec(path);
  if(financeObject){let objectId="INVALID_REFERENCE";try{objectId=decodeURIComponent(financeObject[2]!);}catch{}const kind=financeObject[1]==="documents"?"finance-document":"finance-user";return {kind,objectType:kind,objectId,tabId:kind+":"+objectId,path,title:kind==="finance-document"?"资金单据":"用户资金"};}
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

/** 设置分区和示例模式切换会卸载表单，即使仍是同一个工作区标签也须守护未保存输入。 */
export function changesSettingsContent(current: WorkspaceTab, next: WorkspaceTab): boolean {
  return current.kind === "settings" && next.kind === "settings" && current.id === next.id
    && ((current.query.section ?? "appearance") !== (next.query.section ?? "appearance")
      || (current.query.preview === "1") !== (next.query.preview === "1"));
}

export function canOpenKind(kind: WorkspaceRouteKind, nav: NavPermission): boolean {
  const has = (code: string) => nav.permissions.includes(code);
  if (kind === "workbench" || kind === "account" || kind === "settings") return true;
  if(kind==="finance-lookup")return has("finance.read")||has("finance.document.read");
  if(kind==="finance-period"||kind==="finance-user")return has("finance.read");
  if(kind==="finance-document")return has("finance.document.read");
  if (kind === "support") return has("im.support.read") || nav.isBoss;
  if (kind === "distribution-policy") return nav.isBoss || ["personal.distribution.policy.read", "personal.distribution.policy.manage"].some(has);
  if (kind === "membership-growth") return nav.isBoss || ["membership.policy.draft", "membership.policy.publish", "membership.growth.read.summary"].some(has);
  if (kind === "admins" || kind === "admin-object") return has("admin.account.read") || nav.isBoss;
  if (kind === "roles" || kind === "role-object") return has("admin.role.read") || has("admin.permission.read");
  if (kind === "approvals" || kind === "approval-object") {
    return ["approval.request.read", "approval.request.approve", "approval.template.read", "approval.audit.read"].some(has);
  }
  if (kind === "audit") return has("admin.audit.read");
  if (kind === "user-restore") return has("user.account.restore");
  if (kind === "users" || kind === "user-object") return has("user.directory.read");
  if (kind === "catalog") return has("supply.catalog.manage") || nav.isBoss;
  if (kind === "gunsmith") return has("supply.gunsmith.manage") || nav.isBoss;
  if (kind === "rules") return has("supply.rules.edit") || nav.isBoss;
  if (kind === "listing-review" || kind === "listing-object") return has("supply.review.read") || nav.isBoss;
  if (kind === "media-review") return has("supply.review.read") || nav.isBoss;
  if (kind === "orders" || kind === "order-object") return true;
  if (kind === "resource-object") return nav.isBoss || has("supply.rental_account.read");
  if (kind === "content") return has("content.platform.read") || has("content.read") || nav.isBoss;
  return false;
}

export function upsertTab(tabs: WorkspaceTab[], next: WorkspaceTab): WorkspaceTab[] {
  if(next.kind.startsWith("finance-"))return tabs.some(tab=>tab.id===next.id)?tabs.map(tab=>tab.id===next.id?next:tab):[...tabs,next];
  if (next.kind === "users" || next.kind === "user-object") return tabs.some(tab => tab.id === next.id) ? tabs.map(tab => tab.id === next.id ? next : tab) : [...tabs, next];
  if (next.kind === "admins" || next.kind === "roles" || next.kind === "approvals" || next.kind === "audit" || next.kind === "account" || next.kind === "user-restore" || next.kind === "workbench" || next.kind === "support" || next.kind === "membership-growth" || next.kind === "distribution-policy" || next.kind === "catalog" || next.kind === "gunsmith" || next.kind === "rules" || next.kind === "media-review" || next.kind === "listing-review" || next.kind === "content" || next.kind === "orders") {
    const existing = tabs.find((tab) => tab.id === next.id);
    if (existing) return tabs.map((tab) => (tab.id === next.id ? { ...existing, ...next, query: { ...existing.query, ...next.query } } : tab));
    return [...tabs, next];
  }
  const existing = tabs.find((tab) => tab.id === next.id);
  if (existing) return tabs.map((tab) => (tab.id === next.id ? { ...existing, ...next, ...(next.kind === "listing-object" && next.title === "账号供给详情" ? { title: existing.title } : {}) } : tab));
  return [...tabs, next];
}

export type TabCloseAction = "self" | "others" | "left" | "right";

export function tabsRemovedBy(tabs: WorkspaceTab[], action: TabCloseAction, targetId: string): WorkspaceTab[] {
  const index = tabs.findIndex((tab) => tab.id === targetId);
  if (index < 0) return [];
  return tabs.filter((tab, tabIndex) => {
    if (!tab.closable) return false;
    if (action === "self") return tab.id === targetId;
    if (action === "others") return tab.id !== targetId;
    if (action === "left") return tabIndex < index;
    return tabIndex > index;
  });
}

export function closeTabs(tabs: WorkspaceTab[], activeId: string, action: TabCloseAction, targetId: string): { tabs: WorkspaceTab[]; activeId: string } {
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
    tabs: state.tabs.map((tab) => ({ ...tab, query: sanitizePersistedTabQuery(tab.query) })),
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
        .map((tab) => ({ ...tab, query: sanitizePersistedTabQuery(tab.query ?? {}) })),
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
