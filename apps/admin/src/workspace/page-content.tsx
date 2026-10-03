import { SupplyListingReviewView } from "../views/supply-listing-review-view";
import type { SessionSnapshot } from "../api";
import { AdminAuditView } from "../views/admin-audit-view";
import { AdminDirectoryView, UserRestorePanel } from "../views/admin-directory-view";
import { UserDirectoryView } from "../views/user-directory/user-directory-view";
import { ApprovalAuditView } from "../views/approval-audit-view";
import { RoleConfigView } from "../views/role-config-view";
import { SupplyCatalogView } from "../views/supply-catalog-view";
import { SupplyMediaReviewView } from "../views/supply-media-review-view";
import { SupplyRulesView } from "../views/supply-rules-view";
import { SupplyGunsmithView } from "../views/supply-gunsmith-view";
import { ContentView } from "../views/content-view";
import { ImSupportView } from "../views/im-support-view";

import { AdminOrderChainView, AdminResourceReadView } from "../views/admin-order-chain-view";

import { AccountSecurityPage } from "./account-security-page";
import type { WorkspaceTab } from "./tab-model";
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
  const fromSupply = tab.query.fromSupplyId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tab.query.fromSupplyId) && snapshot.permissions.includes("supply.review.read") ? tab.query.fromSupplyId : null;
  const supplyReturn = fromSupply ? <div className="wf-source-context"><Button variant="secondary" onClick={() => onOpenPath(`/supply/reviews/${encodeURIComponent(fromSupply)}?${new URLSearchParams({context:tab.query.fromSupplyContext??"situation",...(tab.query.fromSupplyVersionId?{versionId:tab.query.fromSupplyVersionId}:{})})}`)}>返回来源账号供给</Button></div> : null;
  const withSupplyOrigin = (path: string, title?: string) => {
    if (!fromSupply) return onOpenPath(path,title);
    const [pathname,search=""] = path.split("?"), params = new URLSearchParams(search);
    params.set("fromSupplyId",fromSupply); params.set("fromSupplyContext",tab.query.fromSupplyContext??"situation");
    if (tab.query.fromSupplyVersionId) params.set("fromSupplyVersionId",tab.query.fromSupplyVersionId);
    onOpenPath(pathname+"?"+params,title);
  };
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
  if (tab.kind === "support") return <>{tab.query.fromOrderId&&/^[A-Za-z0-9._:-]{1,128}$/.test(tab.query.fromOrderId)?<button className="oc-back" onClick={()=>onOpenPath(`/orders/${tab.query.fromOrderId}`)}>返回来源订单</button>:null}<ImSupportView key={tab.id} snapshot={snapshot} preview={tab.query.preview === "1"} initialSection={tab.query.section==="orders"?"orders":"consultation"} onRefresh={onRefresh} /></>;
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
  if (tab.kind === "users" || tab.kind === "user-object") return <>{supplyReturn}{tab.query.fromOrderId&&/^[A-Za-z0-9._:-]{1,128}$/.test(tab.query.fromOrderId)&&(snapshot.security.isBoss||snapshot.permissions.includes("order.read"))?<button className="oc-back" onClick={()=>onOpenPath(`/orders/${tab.query.fromOrderId}`)}>返回来源订单</button>:null}<UserDirectoryView key={tab.id} tab={tab} snapshot={snapshot} onOpenPath={(path,title)=>{const [pathname="",query=""]=path.split("?");const params=new URLSearchParams(query);if(tab.query.fromOrderId)params.set("fromOrderId",tab.query.fromOrderId);if(pathname.startsWith("/supply/accounts/")){params.set("fromUserId",tab.objectId??"");params.set("fromUserSection",tab.query.section??"resources");}withSupplyOrigin(pathname+(params.size?`?${params}`:""),title);}} onQueryChange={query=>onQueryChange({...tab.query,...query})} refreshNonce={refreshNonce}/></>;
  if(tab.kind==="resource-object")return <AdminResourceReadView snapshot={snapshot} accountId={tab.objectId!} fromOrderId={tab.query.fromOrderId} fromUserId={tab.query.fromUserId} fromUserSection={tab.query.fromUserSection} onOpenPath={onOpenPath} refreshNonce={refreshNonce}/>;
  if (tab.kind === "catalog") {
    return <SupplyCatalogView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "gunsmith") {
    return <SupplyGunsmithView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "rules") {
    return <SupplyRulesView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "listing-review" || tab.kind === "listing-object") return <SupplyListingReviewView key={tab.id} snapshot={snapshot} initialAccountId={tab.objectId} initialQuery={tab.query} onOpenPath={onOpenPath} onQueryChange={onQueryChange} refreshNonce={refreshNonce} onDirtyChange={onDirtyChange}/>;
  if (tab.kind === "media-review") {
    return <SupplyMediaReviewView key={[tab.id,snapshot.adminUserId,snapshot.session.id,snapshot.permissions.slice().sort().join(",")].join("|")} snapshot={snapshot} refreshNonce={refreshNonce} onOpenPath={onOpenPath} />;
  }
  if (tab.kind === "content") {
    return <ContentView key={tab.id} snapshot={snapshot} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
  }
  if (tab.kind === "orders" || tab.kind === "order-object") {
    return (
      <>{supplyReturn}
      <AdminOrderChainView
        key={tab.id}
        snapshot={snapshot}
        initialOrderId={tab.objectId}
        objectOnly={tab.kind === "order-object"}
        initialQuery={tab.query}
        onOpenPath={withSupplyOrigin}
        onQueryChange={onQueryChange}
        refreshNonce={refreshNonce}
      />
      </>
    );
  }
  if (tab.kind === "user-restore") return <UserRestorePanel key={tab.id} />;
  return <WorkbenchPage key={tab.id} snapshot={snapshot} onNavigate={(path) => onOpenPath(path)} onDirtyChange={onDirtyChange} refreshNonce={refreshNonce} />;
}
