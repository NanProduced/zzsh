import { SupplyListingReviewView } from "../views/supply-listing-review-view";
import type { SessionSnapshot } from "../api";
import { AdminAuditView } from "../views/admin-audit-view";
import { AdminDirectoryView, UserRestorePanel } from "../views/admin-directory-view";
import { ApprovalAuditView } from "../views/approval-audit-view";
import { RoleConfigView } from "../views/role-config-view";
import { SupplyCatalogView } from "../views/supply-catalog-view";
import { SupplyMediaReviewView } from "../views/supply-media-review-view";
import { SupplyRulesView } from "../views/supply-rules-view";

import { AccountSecurityPage } from "./account-security-page";
import type { WorkspaceTab } from "./tab-model";
import { WorkbenchPage } from "./workbench";

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
  onQueryChange,
  refreshNonce,
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
  onQueryChange: (query: Record<string, string>) => void;
  refreshNonce: number;
}) {
  if (tab.kind === "workbench") {
    return <WorkbenchPage key={tab.id} snapshot={snapshot} onNavigate={(path) => onOpenPath(path)} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "account") {
    return (
      <AccountSecurityPage
        key={tab.id}
        snapshot={snapshot}
        idleMinutes={idleMinutes}
        onIdleMinutes={onIdleMinutes}
        onLock={onLock}
        onRefresh={onRefresh}
        onRecoveryCompleted={onRecoveryCompleted}
        onDirtyChange={onDirtyChange}
      />
    );
  }
  if (tab.kind === "admins" || tab.kind === "admin-object") {
    return (
      <AdminDirectoryView
        key={tab.id}
        snapshot={snapshot}
        initialUsername={tab.objectId}
        objectOnly={tab.kind === "admin-object"}
        initialQuery={tab.query}
        onOpenObject={(username, title) => onOpenPath(`/admins/${encodeURIComponent(username)}`, title)}
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
        initialTab={tab.query.tab === "pending" || tab.query.tab === "templates" || tab.query.tab === "audit" ? tab.query.tab : "mine"}
        objectOnly={tab.kind === "approval-object"}
        onOpenObject={(requestId, title) => onOpenPath(`/approvals/${encodeURIComponent(requestId)}`, title)}
        onTabChange={(value) => onQueryChange({ ...tab.query, tab: value })}
        refreshNonce={refreshNonce}
      />
    );
  }
  if (tab.kind === "audit") {
    return <AdminAuditView key={tab.id} snapshot={snapshot} initialQuery={tab.query} onQueryChange={onQueryChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "catalog") {
    return <SupplyCatalogView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "rules") {
    return <SupplyRulesView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "listing-review") return <SupplyListingReviewView key={tab.id} snapshot={snapshot} refreshNonce={refreshNonce} onDirtyChange={onDirtyChange}/>;
  if (tab.kind === "media-review") {
    return <SupplyMediaReviewView key={tab.id} snapshot={snapshot} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "user-restore") return <UserRestorePanel key={tab.id} />;
  return <WorkbenchPage key={tab.id} snapshot={snapshot} onNavigate={(path) => onOpenPath(path)} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
}
