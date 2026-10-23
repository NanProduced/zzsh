import { FINANCE_ACCESS_FAILURE_EVENT } from "../views/admin-finance-api";
import { clearFinanceContexts } from "../views/admin-finance-view";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import type { SessionSnapshot, Theme, ThemeMode } from "../api";
import type { ThemeStorageStatus } from "../lib/theme";

import { applyDirtyMap, clearDirtyForTabs } from "./dirty-state";
import { searchableWorkspacePages } from "./nav-config";
import type { NavLocation } from "./nav-path";
import { WorkspacePageContent } from "./page-content";
import { WorkspaceSidebar } from "./sidebar";
import { WorkspaceTabBar } from "./tab-bar";
import { WorkspaceTopbar } from "./topbar";
import {
  WORKBENCH_TAB_ID,
  canOpenKind,
  changesSettingsContent,
  clearTabs,
  closeTabs,
  filterTabsByPermission,
  persistTabs,
  restoreTabs,
  tabFromLocation,
  tabHref,
  tabsRemovedBy,
  upsertTab,
  type NavPermission,
  type WorkspaceTab,
  type TabCloseAction,
} from "./tab-model";

function navOf(snapshot: Extract<SessionSnapshot, { authenticated: true }>): NavPermission {
  return { isBoss: snapshot.security.isBoss, permissions: snapshot.permissions };
}

function currentLocationTab(): WorkspaceTab {
  return tabFromLocation(window.location.pathname, window.location.search);
}

type DiscardIntent = { titles: string[]; execute: () => void; cancel?: () => void; accessKey: string };

export function WorkspaceApp({
  snapshot,
  theme,
  themeMode,
  onToggleTheme,
  onSelectThemeMode,
  onResetTheme,
  themeStorageError,
  themeStorageStatus,
  urlTheme,
  onClearUrlTheme,
  idleMinutes,
  onIdleMinutes,
  onLock,
  onSignOut,
  onRefresh,
  onRecoveryCompleted,
}: {
  snapshot: Extract<SessionSnapshot, { authenticated: true }>;
  theme: Theme;
  themeMode?: ThemeMode;
  onToggleTheme?: () => void;
  onSelectThemeMode?: (mode: ThemeMode) => void;
  onResetTheme?: () => void;
  themeStorageError?: boolean;
  themeStorageStatus?: ThemeStorageStatus;
  urlTheme?: Theme | null;
  onClearUrlTheme?: () => void;
  idleMinutes: number;
  onIdleMinutes: (value: number) => void;
  onLock: () => void;
  onSignOut: () => void;
  onRefresh: () => Promise<SessionSnapshot>;
  onRecoveryCompleted: () => void;
}) {
  const nav = useMemo(() => navOf(snapshot), [snapshot]);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => {
    const locationTab = typeof window === "undefined" ? tabFromLocation("/workbench") : currentLocationTab();
    const restored = restoreTabs(snapshot.adminUserId, nav);
    const seeded = restored?.tabs ?? [tabFromLocation("/workbench")];
    return upsertTab(filterTabsByPermission(seeded, nav), canOpenKind(locationTab.kind, nav) ? locationTab : tabFromLocation("/workbench"));
  });
  const [activeId, setActiveId] = useState(() => {
    const locationTab = typeof window === "undefined" ? tabFromLocation("/workbench") : currentLocationTab();
    return canOpenKind(locationTab.kind, nav) ? locationTab.id : WORKBENCH_TAB_ID;
  });
  const [dirtyIds, setDirtyIds] = useState<Record<string, boolean>>({});
  const [discardIntent, setDiscardIntent] = useState<DiscardIntent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const dirtyIdsRef = useRef(dirtyIds);
  const discardIntentRef = useRef<DiscardIntent | null>(null);
  const accessKey = JSON.stringify([snapshot.adminUserId, snapshot.session?.id, snapshot.session?.locked, snapshot.security.status, snapshot.security.isBoss, [...snapshot.permissions].sort()]);
  const accessRef = useRef({ key: accessKey, nav, locked: snapshot.session?.locked === true });
  tabsRef.current = tabs;
  activeIdRef.current = activeId;
  dirtyIdsRef.current = dirtyIds;
  accessRef.current = { key: accessKey, nav, locked: snapshot.session?.locked === true };

  const cancelDiscard = useCallback(() => {
    const pending = discardIntentRef.current;
    discardIntentRef.current = null;
    setDiscardIntent(null);
    pending?.cancel?.();
  }, []);
  const queueDiscard = useCallback((intent: Omit<DiscardIntent, "accessKey">) => {
    discardIntentRef.current?.cancel?.();
    const pending = { ...intent, accessKey: accessRef.current.key };
    discardIntentRef.current = pending;
    setDiscardIntent(pending);
  }, []);

  useEffect(() => { cancelDiscard(); }, [accessKey, cancelDiscard]);

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? tabFromLocation("/workbench");
  // 侧栏唯一活动入口按真实地址（含 query）判定：/settings?section=security 只点亮账号安全。
  // 前进/后退后 tab 可能还没有本轮 query，故用 revision 触发重算。
  const [locationRevision, bumpLocationRevision] = useState(0);
  const locateInWindow = (revision: number): NavLocation => {
    void revision;
    return { pathname: window.location.pathname, search: window.location.search };
  };
  const activeLocation = locateInWindow(locationRevision);

  const replaceUrl = useCallback((tab: WorkspaceTab, replace = false) => {
    const href = tabHref(tab);
    if (`${window.location.pathname}${window.location.search}` === href) return;
    if (replace) window.history.replaceState({ tabId: tab.id }, "", href);
    else window.history.pushState({ tabId: tab.id }, "", href);
  }, []);

  const markDirty = useCallback((tabId: string, dirty: boolean) => {
    setDirtyIds((current) => applyDirtyMap(current, tabId, dirty));
  }, []);

  const onDirtyChange = useCallback(
    (dirty: boolean) => {
      markDirty(activeIdRef.current, dirty);
    },
    [markDirty],
  );

  useEffect(() => {
    persistTabs(snapshot.adminUserId, { tabs, activeId });
  }, [activeId, snapshot.adminUserId, tabs]);

  useEffect(() => {
    const revoke = () => {
      cancelDiscard();
      clearFinanceContexts();
      const removed = tabsRef.current.filter(tab => tab.kind.startsWith("finance-"));
      const next = tabsRef.current.filter(tab => !tab.kind.startsWith("finance-"));
      tabsRef.current = next;
      activeIdRef.current = WORKBENCH_TAB_ID;
      setTabs(next);
      setActiveId(WORKBENCH_TAB_ID);
      setDirtyIds(current => clearDirtyForTabs(current, removed.map(tab => tab.id)));
      replaceUrl(tabFromLocation("/workbench"), true);
    };
    window.addEventListener(FINANCE_ACCESS_FAILURE_EVENT, revoke);
    return () => window.removeEventListener(FINANCE_ACCESS_FAILURE_EVENT, revoke);
  }, [cancelDiscard, replaceUrl]);
  useEffect(() => {
    const next = filterTabsByPermission(tabs, nav);
    if (next.length !== tabs.length || next.some((tab, index) => tab.id !== tabs[index]?.id)) {
      cancelDiscard();
      const removed = tabs.filter((tab) => !next.some((item) => item.id === tab.id));
      tabsRef.current = next;
      setTabs(next);
      setDirtyIds((current) => clearDirtyForTabs(current, removed.map((tab) => tab.id)));
      if (!next.some((tab) => tab.id === activeId)) {
        activeIdRef.current = WORKBENCH_TAB_ID;
        setActiveId(WORKBENCH_TAB_ID);
        const workbench = next.find((tab) => tab.id === WORKBENCH_TAB_ID) ?? tabFromLocation("/workbench");
        replaceUrl(workbench, true);
      }
    }
  }, [activeId, cancelDiscard, nav, replaceUrl, tabs]);

  const confirmLeave = useCallback((tabId: string, proceed: () => boolean): boolean => {
    if (!dirtyIdsRef.current[tabId]) {
      return proceed();
    }
    const tab = tabsRef.current.find((item) => item.id === tabId);
    queueDiscard({
      titles: [tab?.title ?? "当前页"],
      execute: () => {
        const current = tabsRef.current.find(item => item.id === tabId);
        if (activeIdRef.current !== tabId || !current || !canOpenKind(current.kind, accessRef.current.nav)) return;
        if (proceed()) markDirty(tabId, false);
      },
    });
    return false;
  }, [markDirty, queueDiscard]);

  useEffect(() => {
    const onPop = () => {
      bumpLocationRevision((value) => value + 1);
      const next = currentLocationTab();
      const currentId = activeIdRef.current;
      const currentTab = tabsRef.current.find((tab) => tab.id === currentId);
      const hasDirty = currentTab && dirtyIdsRef.current[currentId] && (next.id !== currentId || changesSettingsContent(currentTab, next));
      if (hasDirty) {
        window.history.pushState({ tabId: currentTab.id }, "", tabHref(currentTab));
        if (accessRef.current.locked || !canOpenKind(next.kind, accessRef.current.nav)) return;
        queueDiscard({
          titles: [currentTab.title],
          execute: () => {
            const access = accessRef.current;
            const source = tabsRef.current.find(tab => tab.id === currentId);
            if (access.locked || activeIdRef.current !== currentId || !source || !canOpenKind(source.kind, access.nav) || !canOpenKind(next.kind, access.nav)) return;
            const updated = upsertTab(filterTabsByPermission(tabsRef.current, access.nav), next);
            tabsRef.current = updated;
            activeIdRef.current = next.id;
            markDirty(currentId, false);
            setTabs(updated);
            setActiveId(next.id);
            replaceUrl(next, true);
          },
        });
        return;
      }
      if (accessRef.current.locked || !canOpenKind(next.kind, accessRef.current.nav)) {
        const workbench = tabFromLocation("/workbench");
        const updated = upsertTab(tabsRef.current, workbench);
        tabsRef.current = updated;
        activeIdRef.current = WORKBENCH_TAB_ID;
        setTabs(updated);
        setActiveId(WORKBENCH_TAB_ID);
        replaceUrl(workbench, true);
        return;
      }
      const updated = upsertTab(tabsRef.current, next);
      tabsRef.current = updated;
      activeIdRef.current = next.id;
      setTabs(updated);
      setActiveId(next.id);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [markDirty, queueDiscard, replaceUrl]);

  useEffect(() => {
    const href = tabHref(active);
    if (`${window.location.pathname}${window.location.search}` !== href) replaceUrl(active, true);
  }, [active, replaceUrl]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (Object.values(dirtyIds).some(Boolean)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyIds]);

  const openTab = useCallback((next: WorkspaceTab, replace = false): boolean => {
    if (accessRef.current.locked || !canOpenKind(next.kind, accessRef.current.nav)) return false;
    const proceed = () => {
      const access = accessRef.current;
      if (access.locked || !canOpenKind(next.kind, access.nav)) return false;
      const updated = upsertTab(filterTabsByPermission(tabsRef.current, access.nav), next);
      tabsRef.current = updated;
      activeIdRef.current = next.id;
      setTabs(updated);
      setActiveId(next.id);
      replaceUrl(next, replace);
      return true;
    };
    const current = tabsRef.current.find((item) => item.id === activeIdRef.current);
    const currentHref = current ? tabHref(current) : "";
    const nextHref = tabHref(next);
    if (next.id === activeIdRef.current && currentHref === nextHref) {
      return true;
    }
    if (next.id === activeIdRef.current && (!current || !changesSettingsContent(current, next))) {
      return proceed();
    }
    return confirmLeave(activeIdRef.current, proceed);
  }, [confirmLeave, replaceUrl]);

  const openPath = useCallback((path: string, title?: string): boolean => {
    const [pathname, search = ""] = path.split("?");
    const tab = tabFromLocation(pathname || "/workbench", search);
    return openTab(title ? { ...tab, title } : tab);
  }, [openTab]);

  const activate = (tabId: string): boolean => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (accessRef.current.locked || !tab || !canOpenKind(tab.kind, accessRef.current.nav)) return false;
    if (tabId === activeIdRef.current) return true;
    return confirmLeave(activeIdRef.current, () => {
      const latest = tabsRef.current.find(item => item.id === tabId);
      if (accessRef.current.locked || !latest || !canOpenKind(latest.kind, accessRef.current.nav)) return false;
      activeIdRef.current = tabId;
      setActiveId(tabId);
      replaceUrl(latest);
      return true;
    });
  };

  const close = (action: TabCloseAction, targetId: string) => {
    if (accessRef.current.locked) return;
    const removed = tabsRemovedBy(tabsRef.current, action, targetId);
    const dirtyRemoved = removed.filter((tab) => dirtyIdsRef.current[tab.id]);
    const confirmedDirtyIds = new Set(dirtyRemoved.map(tab => tab.id));
    const executeClose = () => {
      const access = accessRef.current;
      const latest = filterTabsByPermission(tabsRef.current, access.nav);
      if (access.locked || !latest.some(tab => tab.id === targetId)) return;
      const removedNow = tabsRemovedBy(latest, action, targetId);
      if (removedNow.some(tab => dirtyIdsRef.current[tab.id] && !confirmedDirtyIds.has(tab.id))) return;
      const result = closeTabs(latest, activeIdRef.current, action, targetId);
      tabsRef.current = result.tabs;
      activeIdRef.current = result.activeId;
      setTabs(result.tabs);
      setActiveId(result.activeId);
      const next = result.tabs.find((tab) => tab.id === result.activeId);
      if (next) replaceUrl(next, true);
      setDirtyIds((curr) => clearDirtyForTabs(curr, removedNow.map((tab) => tab.id)));
    };
    if (dirtyRemoved.length > 0) {
      queueDiscard({
        titles: dirtyRemoved.map((tab) => tab.title),
        execute: executeClose,
      });
      return;
    }
    executeClose();
  };

  const refreshPage = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
      setRefreshNonce((value) => value + 1);
    } finally {
      setRefreshing(false);
    }
  };

  const hasSupportRead = snapshot.permissions.includes("im.support.read");

  useEffect(() => {
    if (hasSupportRead || active.kind === "support") return;
    let refreshing = false;
    const refreshSession = () => {
      // GAP-020: a hidden tab does not poll; returning focus/visibility triggers the immediate refresh in main.tsx.
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      void onRefresh().catch(() => undefined).finally(() => { refreshing = false; });
    };
    const timer = window.setInterval(refreshSession, 5_000);
    return () => window.clearInterval(timer);
  }, [active.kind, hasSupportRead, onRefresh]);

  const signOutAndClear = () => {
    cancelDiscard();
    clearTabs(snapshot.adminUserId);
    onSignOut();
  };

  const clearThemeFromTabs = useCallback(() => {
    onClearUrlTheme?.();
    setTabs((items) =>
      items.map((tab) => {
        if (tab.query && "theme" in tab.query) {
          const nextQuery = { ...tab.query };
          delete nextQuery.theme;
          return { ...tab, query: nextQuery };
        }
        return tab;
      }),
    );
    const current = tabsRef.current.find((item) => item.id === activeIdRef.current);
    if (current && current.query && "theme" in current.query) {
      const nextQuery = { ...current.query };
      delete nextQuery.theme;
      replaceUrl({ ...current, query: nextQuery }, true);
    }
  }, [onClearUrlTheme, replaceUrl]);

  const handleExitPreview = useCallback(() => {
    clearThemeFromTabs();
  }, [clearThemeFromTabs]);

  const handleSelectThemeMode = useCallback(
    (mode: ThemeMode) => {
      onSelectThemeMode?.(mode);
      clearThemeFromTabs();
    },
    [clearThemeFromTabs, onSelectThemeMode],
  );

  const handleResetTheme = useCallback(() => {
    onResetTheme?.();
    clearThemeFromTabs();
  }, [clearThemeFromTabs, onResetTheme]);

  const handleToggleTheme = useCallback(() => {
    onToggleTheme?.();
    clearThemeFromTabs();
  }, [clearThemeFromTabs, onToggleTheme]);

  return (
    <div className={`workspace-root min-h-svh ${theme === "dark" ? "dark" : ""}`}>
      <SidebarProvider style={{ "--sidebar-width": "250px" } as CSSProperties}>
        <WorkspaceSidebar snapshot={snapshot} location={activeLocation} onNavigate={openPath} onSignOut={signOutAndClear} />
        <SidebarInset>
          <WorkspaceTopbar
            pathname={active.path}
            theme={theme}
            themeMode={themeMode}
            onToggleTheme={handleToggleTheme}
            onSelectThemeMode={handleSelectThemeMode}
            onRefresh={() => void refreshPage()}
            onLock={onLock}
            canLock={snapshot.security.status === "ACTIVE" && snapshot.session.pinConfigured && !snapshot.session.locked}
            refreshing={refreshing}
            pages={searchableWorkspacePages(nav)}
            onNavigate={openPath}
            tabs={filterTabsByPermission(tabs, nav)}
            activeTabId={activeId}
            onActivateTab={activate}
            adminUserId={snapshot.adminUserId}
            sessionId={snapshot.session?.id}
            isLocked={snapshot.session?.locked}
            themeStorageError={themeStorageError}
          />
          <WorkspaceTabBar
            tabs={tabs}
            activeId={activeId}
            onActivate={activate}
            onClose={close}
          />
          <div className="workspace-page flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 sm:px-5 sm:py-5">
            <WorkspacePageContent
              tab={active}
              snapshot={snapshot}
              idleMinutes={idleMinutes}
              onIdleMinutes={onIdleMinutes}
              onLock={onLock}
              onRefresh={onRefresh}
              onRecoveryCompleted={onRecoveryCompleted}
              onOpenPath={openPath}
              onDirtyChange={onDirtyChange}
              onQueryChange={(query) => {
                const current = tabsRef.current.find((item) => item.id === activeIdRef.current);
                if (!current) return;
                const next = { ...current, query };
                setTabs((items) => items.map((tab) => (tab.id === next.id ? next : tab)));
                replaceUrl(next, true);
              }}
              refreshNonce={refreshNonce}
              theme={theme}
              themeMode={themeMode}
              onSelectThemeMode={handleSelectThemeMode}
              onResetTheme={handleResetTheme}
              themeStorageError={themeStorageError}
              themeStorageStatus={themeStorageStatus}
              urlTheme={urlTheme}
              onExitPreview={handleExitPreview}
            />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Dialog open={discardIntent !== null} onOpenChange={(open) => { if (!open) cancelDiscard(); }}>
        <DialogContent showCloseButton={false} role="alertdialog">
          <DialogTitle>有修改尚未保存</DialogTitle>
          <DialogDescription>
            离开后将丢弃未保存的更改{discardIntent?.titles?.length ? `（${discardIntent.titles.join("、")}）` : ""}。确定放弃修改并离开？
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={cancelDiscard}
            >
              继续编辑
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const pending = discardIntentRef.current;
                if (!pending || pending !== discardIntent) { cancelDiscard(); return; }
                discardIntentRef.current = null;
                setDiscardIntent(null);
                if (pending.accessKey !== accessRef.current.key || accessRef.current.locked) { pending.cancel?.(); return; }
                pending.execute();
              }}
            >
              放弃修改并离开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
