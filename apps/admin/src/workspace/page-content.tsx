import { AdminFinanceView } from "../views/admin-finance-view";
import { SupplyListingReviewView } from "../views/supply-listing-review-view";
import type { SessionSnapshot, Theme, ThemeMode } from "../api";
import type { ThemeStorageStatus } from "../lib/theme";
import { SettingsWorkspace } from "./settings-page";
import { AccountSecurityPage } from "./account-security-page";
import { AdminAuditView } from "../views/admin-audit-view";
import { AdminDirectoryView } from "../views/admin-directory-view";
import { UserDirectoryView } from "../views/user-directory/user-directory-view";
import { ApprovalAuditView } from "../views/approval-audit-view";
import { RoleConfigView } from "../views/role-config-view";
import { SupplyCatalogView } from "../views/supply-catalog-view";
import { SupplyMediaReviewView } from "../views/supply-media-review-view";
import { SupplyRulesView } from "../views/supply-rules-view";
import { SupplyGunsmithView } from "../views/supply-gunsmith-view";
import { ContentView } from "../views/content-view";
import { ImSupportView } from "../views/im-support-view";
import { MembershipGrowthAdminHost } from "../views/membership-growth-admin-host";
import { DistributionWorkspace } from "../views/distribution-workspace";

import { AdminOrderChainView, AdminResourceReadView } from "../views/admin-order-chain-view";

import { parseWorkspacePath, type WorkspaceTab } from "./tab-model";
import { WorkbenchPage } from "./workbench";
import { Button } from "../components/ui-elements";

export function WorkspacePageContent({
  tab,
  snapshot,
  idleMinutes,
  onIdleMinutes,
  onLock,
  onRefresh,
  onRecoveryCompleted,
  onOpenPath,
  onDirtyChange,
  onWriteLockChange,
  onQueryChange,
  refreshNonce,
  theme,
  themeMode,
  onSelectThemeMode,
  onResetTheme,
  themeStorageError,
  themeStorageStatus,
  urlTheme,
  onExitPreview,
}: {
  tab: WorkspaceTab;
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  idleMinutes: number;
  onIdleMinutes: (value: number) => void;
  onLock: () => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onRecoveryCompleted: () => void;
  onOpenPath: (path: string, title?: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onWriteLockChange?: (locked: boolean) => void;
  onQueryChange: (query: Record<string, string>) => void;
  refreshNonce: number;
  theme?: Theme;
  themeMode?: ThemeMode;
  onSelectThemeMode?: (mode: ThemeMode) => void;
  onResetTheme?: () => void;
  themeStorageError?: boolean;
  themeStorageStatus?: ThemeStorageStatus;
  urlTheme?: Theme | null;
  onExitPreview?: () => void;
}) {
  const fromSupply = tab.query.fromSupplyId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tab.query.fromSupplyId) && (snapshot.security.isBoss || snapshot.permissions.includes("supply.review.read") || snapshot.permissions.includes("supply.rental_account.read")) ? tab.query.fromSupplyId : null;
  const supplyReturnQuery = new URLSearchParams({ context: tab.query.fromSupplyContext ?? "situation", ...(tab.query.fromSupplyVersionId ? { versionId: tab.query.fromSupplyVersionId } : {}) });
  for (const key of ["fromOrderId", "fromUserId", "fromUserSection", "fromUserPublication", "fromUserRole", "fromUserStatus"]) if (tab.query[key]) supplyReturnQuery.set(key, tab.query[key]!);
  const supplyReturn = fromSupply ? <div className="wf-source-context"><Button variant="secondary" onClick={() => onOpenPath(`/supply/reviews/${encodeURIComponent(fromSupply)}?${supplyReturnQuery}`)}>返回来源账号供给</Button></div> : null;
  const withSupplyOrigin = (path: string, title?: string) => {
    if (!fromSupply) return onOpenPath(path,title);
    const [pathname,search=""] = path.split("?"), params = new URLSearchParams(search);
    params.set("fromSupplyId",fromSupply); params.set("fromSupplyContext",tab.query.fromSupplyContext??"situation");
    if (tab.query.fromSupplyVersionId) params.set("fromSupplyVersionId",tab.query.fromSupplyVersionId);
    onOpenPath(pathname+"?"+params,title);
  };
  if(tab.kind.startsWith("finance-"))return <AdminFinanceView key={tab.id} tab={tab} snapshot={snapshot} onOpenPath={onOpenPath} onQueryChange={onQueryChange} onRefresh={onRefresh} refreshNonce={refreshNonce}/>;
  if (tab.kind === "workbench") {
    return <WorkbenchPage key={tab.id} snapshot={snapshot} onNavigate={(path) => onOpenPath(path)} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "account") {
    return <AccountSecurityPage key={tab.id} snapshot={snapshot} idleMinutes={idleMinutes}
      onIdleMinutes={onIdleMinutes} onLock={onLock} onRefresh={onRefresh}
      onRecoveryCompleted={onRecoveryCompleted} onDirtyChange={onDirtyChange} />;
  }
  if (tab.kind === "settings") {
    return (
      <SettingsWorkspace
        key={tab.id}
        query={tab.query}
        snapshot={snapshot}
        idleMinutes={idleMinutes}
        onIdleMinutes={onIdleMinutes}
        onLock={onLock}
        onRefresh={onRefresh}
        onRecoveryCompleted={onRecoveryCompleted}
        onDirtyChange={onDirtyChange}
        onQueryChange={onQueryChange}
        theme={theme ?? "dark"}
        themeMode={themeMode ?? "dark"}
        onSelectThemeMode={onSelectThemeMode ?? (() => undefined)}
        onResetTheme={onResetTheme ?? (() => undefined)}
        themeStorageError={themeStorageError}
        themeStorageStatus={themeStorageStatus}
        urlTheme={urlTheme}
        onExitPreview={onExitPreview}
        onOpenPath={onOpenPath}
      />
    );
  }
  if (tab.kind === "support") return <>{tab.query.fromOrderId&&/^[A-Za-z0-9._:-]{1,128}$/.test(tab.query.fromOrderId)?<button className="oc-back" onClick={()=>onOpenPath(`/orders/${tab.query.fromOrderId}`)}>返回来源订单</button>:null}<ImSupportView key={tab.id} snapshot={snapshot} initialSection={tab.query.section==="orders"?"orders":"consultation"} onRefresh={onRefresh} onOpenPath={onOpenPath} /></>;
  if (tab.kind === "distribution-policy") return snapshot.authenticated ? <DistributionWorkspace key={tab.id} snapshot={snapshot} query={tab.query} onOpenPath={onOpenPath} onQueryChange={onQueryChange} onDirtyChange={onDirtyChange} /> : null;
  if (tab.kind === "membership-growth") return <>{tab.query.fromUserId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tab.query.fromUserId) && (snapshot.security.isBoss || snapshot.permissions.includes("user.directory.read")) ? <Button variant="ghost" onClick={() => onOpenPath("/users/" + tab.query.fromUserId + "?section=growth")}>返回来源用户</Button> : null}<MembershipGrowthAdminHost key={tab.id} tab={tab} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} onOpenPath={onOpenPath} /></>;
  if (tab.kind === "admins" || tab.kind === "admin-object") {
    return (
      <AdminDirectoryView
        key={tab.id}
        snapshot={snapshot}
        initialUsername={tab.objectId}
        objectOnly={tab.kind === "admin-object"}
        initialQuery={tab.query}
        onOpenObject={(username, title) => { const query = new URLSearchParams(tab.query).toString(); onOpenPath(`/admins/${encodeURIComponent(username)}${query ? `?${query}` : ""}`, title); }}
        onReturnToList={() => { const query = new URLSearchParams(tab.query).toString(); onOpenPath(`/admins${query ? `?${query}` : ""}`); }}
        onDirtyChange={onDirtyChange}
        onQueryChange={onQueryChange}
        refreshNonce={refreshNonce}
      />
    );
  }
  if (tab.kind === "roles" || tab.kind === "role-object") {
    return (
      <RoleConfigView
        key={tab.id}
        snapshot={snapshot}
        initialCode={tab.objectId}
        objectOnly={tab.kind === "role-object"}
        onOpenObject={(code, title) => onOpenPath(`/roles/${encodeURIComponent(code)}`, title)}
        onDirtyChange={onDirtyChange}
        refreshNonce={refreshNonce}
      />
    );
  }
  if (tab.kind === "approvals" || tab.kind === "approval-object") {
    return (
      <ApprovalAuditView
        key={tab.id}
        snapshot={snapshot}
        initialRequestId={tab.objectId}
        initialQuery={tab.query}
        objectOnly={tab.kind === "approval-object"}
        onOpenObject={(requestId, title) => onOpenPath(`/approvals/${encodeURIComponent(requestId)}`, title)}
        onOpenPath={onOpenPath}
        onTabChange={(value) => onQueryChange({ ...tab.query, tab: value })}
        onQueryChange={onQueryChange}
        refreshNonce={refreshNonce}
      />
    );
  }
  if (tab.kind === "audit") {
    return <AdminAuditView key={tab.id} snapshot={snapshot} initialQuery={tab.query} onQueryChange={onQueryChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "users" || tab.kind === "user-object") return <>{supplyReturn}{tab.query.fromOrderId&&/^[A-Za-z0-9._:-]{1,128}$/.test(tab.query.fromOrderId)&&(snapshot.security.isBoss||snapshot.permissions.includes("order.read"))?<button className="oc-back" onClick={()=>onOpenPath(`/orders/${tab.query.fromOrderId}`)}>返回来源订单</button>:null}<UserDirectoryView key={tab.id} tab={tab} snapshot={snapshot} onOpenPath={(path,title)=>{const [pathname="",query=""]=path.split("?");const params=new URLSearchParams(query);if(tab.query.fromOrderId&&!params.has("fromOrderId"))params.set("fromOrderId",tab.query.fromOrderId);const route=parseWorkspacePath(pathname);if(route.kind==="listing-object"){const section=params.get("fromUserSection")??tab.query.section??"orders";if(!params.has("fromUserId")&&tab.objectId)params.set("fromUserId",tab.objectId);params.set("fromUserSection",section);if(!params.has("fromUserPublication")&&section==="resources"&&tab.query.publication==="published")params.set("fromUserPublication","published");if(!params.has("fromUserRole")&&section==="orders"&&tab.query.role)params.set("fromUserRole",tab.query.role);if(!params.has("fromUserStatus")&&section==="orders"&&tab.query.status)params.set("fromUserStatus",tab.query.status);}if(pathname.startsWith("/orders/")&&tab.objectId){params.set("fromUserId",tab.objectId);params.set("fromUserSection",tab.query.section??"orders");if(tab.query.role)params.set("fromUserRole",tab.query.role);if(tab.query.status)params.set("fromUserStatus",tab.query.status);}withSupplyOrigin((route.kind==="listing-object"?route.path:pathname)+(params.size?`?${params}`:""),title);}} onQueryChange={query=>onQueryChange(tab.kind==="users"?query:{...tab.query,...query})} refreshNonce={refreshNonce}/></>;
  if (tab.kind === "resource-object" || tab.kind === "listing-object") return <AdminResourceReadView key={tab.id} snapshot={snapshot} accountId={tab.objectId!} initialQuery={tab.query} onOpenPath={onOpenPath} onQueryChange={onQueryChange} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce}/>;
  if (tab.kind === "catalog") {
    return <SupplyCatalogView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "gunsmith") {
    return <SupplyGunsmithView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "rules") {
    return <SupplyRulesView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} section={tab.query.section} draft={tab.query.draft} onOpenPath={onOpenPath} />;
  }
  if (tab.kind === "listing-review") return <SupplyListingReviewView key={tab.id} snapshot={snapshot} initialQuery={tab.query} onOpenPath={onOpenPath} onQueryChange={onQueryChange} refreshNonce={refreshNonce} onDirtyChange={onDirtyChange}/>;
  if (tab.kind === "media-review") {
    return <SupplyMediaReviewView key={[tab.id,snapshot.adminUserId,snapshot.session.id,snapshot.permissions.slice().sort().join(",")].join("|")} snapshot={snapshot} refreshNonce={refreshNonce} onOpenPath={onOpenPath} />;
  }
  if (tab.kind === "content") {
    return <ContentView key={[tab.id,snapshot.adminUserId,snapshot.session.id,snapshot.permissions.slice().sort().join(",")].join("|")} snapshot={snapshot} onDirtyChange={onDirtyChange} onWriteLockChange={onWriteLockChange} refreshNonce={refreshNonce} tab={tab} onQueryChange={onQueryChange} onOpenPath={onOpenPath} />;
  }
  if (tab.kind === "orders" || tab.kind === "order-object") {
    const fromUser = tab.kind === "order-object" && tab.query.fromUserId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tab.query.fromUserId) && (snapshot.security.isBoss || snapshot.permissions.includes("user.directory.read")) ? tab.query.fromUserId : null;
    const userReturn = fromUser ? <button className="oc-back" onClick={() => onOpenPath(`/users/${fromUser}?${new URLSearchParams({ section: tab.query.fromUserSection ?? "orders", ...(tab.query.fromUserRole ? { role: tab.query.fromUserRole } : {}), ...(tab.query.fromUserStatus ? { status: tab.query.fromUserStatus } : {}), ...(tab.query.fromUserSection === "resources" && tab.query.fromUserPublication === "published" ? { publication: "published" } : {}) })}`)}>返回来源用户</button> : null;
    const withUserOrigin = (path: string, title?: string) => {
      const [pathname = "", search = ""] = path.split("?"), params = new URLSearchParams(search);
      const route = parseWorkspacePath(pathname);
      if (!fromUser || (pathname !== tab.path && route.kind !== "listing-object")) return withSupplyOrigin(path, title);
      params.set("fromUserId", fromUser);
      params.set("fromUserSection", tab.query.fromUserSection ?? "orders");
      if (tab.query.fromUserRole) params.set("fromUserRole", tab.query.fromUserRole);
      if (tab.query.fromUserStatus) params.set("fromUserStatus", tab.query.fromUserStatus);
      if (tab.query.fromUserPublication) params.set("fromUserPublication", tab.query.fromUserPublication);
      withSupplyOrigin((route.kind === "listing-object" ? route.path : pathname) + "?" + params, title);
    };
    return (
      <>{supplyReturn}{userReturn}
      <AdminOrderChainView
        key={tab.id}
        snapshot={snapshot}
        initialOrderId={tab.objectId}
        objectOnly={tab.kind === "order-object"}
        initialQuery={tab.query}
        onOpenPath={withUserOrigin}
        onQueryChange={onQueryChange}
        refreshNonce={refreshNonce}
      />
      </>
    );
  }
  return <WorkbenchPage key={tab.id} snapshot={snapshot} onNavigate={(path) => onOpenPath(path)} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
}
