import { FINANCE_ACCESS_FAILURE_EVENT } from "../views/admin-finance-api";
import { clearFinanceContexts } from "../views/admin-finance-view";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { SessionSnapshot, Theme, ThemeMode } from "../api";
import type { ThemeStorageStatus } from "../lib/theme";

import { applyDirtyMap, clearDirtyForTabs, confirmDiscard } from "./dirty-state";
import { searchableWorkspacePages } from "./nav-config";
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const dirtyIdsRef = useRef(dirtyIds);
  tabsRef.current = tabs;
  activeIdRef.current = activeId;
  dirtyIdsRef.current = dirtyIds;

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? tabFromLocation("/workbench");

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

  useEffect(()=>{const revoke=()=>{clearFinanceContexts();const next=tabsRef.current.filter(tab=>!tab.kind.startsWith("finance-"));setTabs(next);setActiveId(WORKBENCH_TAB_ID);replaceUrl(tabFromLocation("/workbench"),true);};window.addEventListener(FINANCE_ACCESS_FAILURE_EVENT,revoke);return()=>window.removeEventListener(FINANCE_ACCESS_FAILURE_EVENT,revoke);},[replaceUrl]);
  useEffect(() => {
    const next = filterTabsByPermission(tabs, nav);
    if (next.length !== tabs.length || next.some((tab, index) => tab.id !== tabs[index]?.id)) {
      const removed = tabs.filter((tab) => !next.some((item) => item.id === tab.id));
      setTabs(next);
      setDirtyIds((current) => clearDirtyForTabs(current, removed.map((tab) => tab.id)));
      if (!next.some((tab) => tab.id === activeId)) {
        setActiveId(WORKBENCH_TAB_ID);
        const workbench = next.find((tab) => tab.id === WORKBENCH_TAB_ID) ?? tabFromLocation("/workbench");
        replaceUrl(workbench, true);
      }
    }
  }, [activeId, nav, replaceUrl, tabs]);

  useEffect(() => {
    const onPop = () => {
      const next = currentLocationTab();
      const currentId = activeIdRef.current;
      const currentTab = tabsRef.current.find((tab) => tab.id === currentId);
      if (currentTab && dirtyIdsRef.current[currentId] && (next.id !== currentId || changesSettingsContent(currentTab, next))) {
        if (!confirmDiscard([currentTab.title])) {
          window.history.pushState({ tabId: currentTab.id }, "", tabHref(currentTab));
          return;
        }
        markDirty(currentId, false);
      }
      if (!canOpenKind(next.kind, nav)) {
        const workbench = tabFromLocation("/workbench");
        setTabs((current) => upsertTab(current, workbench));
        setActiveId(WORKBENCH_TAB_ID);
        replaceUrl(workbench, true);
        return;
      }
      setTabs((current) => upsertTab(current, next));
      setActiveId(next.id);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [markDirty, nav, replaceUrl]);

  useEffect(() => {
    const href = tabHref(active);
    if (`${window.location.pathname}${window.location.search}` !== href) replaceUrl(active, true);
  }, [active, replaceUrl]);

  const confirmLeave = useCallback((tabId: string) => {
    if (!dirtyIdsRef.current[tabId]) return true;
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!confirmDiscard([tab?.title ?? "当前页"])) return false;
    markDirty(tabId, false);
    return true;
  }, [markDirty]);

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
    if (!canOpenKind(next.kind, nav)) return false;
    const current = tabsRef.current.find((item) => item.id === activeIdRef.current);
    if ((next.id !== activeIdRef.current || (current && changesSettingsContent(current, next))) && !confirmLeave(activeIdRef.current)) return false;
    setTabs((current) => upsertTab(current, next));
    setActiveId(next.id);
    replaceUrl(next, replace);
    return true;
  }, [confirmLeave, nav, replaceUrl]);

  const openPath = useCallback((path: string, title?: string): boolean => {
    const [pathname, search = ""] = path.split("?");
    const tab = tabFromLocation(pathname || "/workbench", search);
    return openTab(title ? { ...tab, title } : tab);
  }, [openTab]);

  const activate = (tabId: string): boolean => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab || !canOpenKind(tab.kind, nav)) return false;
    if (tabId !== activeId && !confirmLeave(activeId)) return false;
    setActiveId(tabId);
    replaceUrl(tab);
    return true;
  };

  const close = (action: TabCloseAction, targetId: string) => {
    const removed = tabsRemovedBy(tabs, action, targetId);
    const dirtyRemoved = removed.filter((tab) => dirtyIds[tab.id]);
    if (dirtyRemoved.length > 0 && !confirmDiscard(dirtyRemoved.map((tab) => tab.title))) return;
    const result = closeTabs(tabs, activeId, action, targetId);
    setTabs(result.tabs);
    setActiveId(result.activeId);
    const next = result.tabs.find((tab) => tab.id === result.activeId);
    if (next) replaceUrl(next, true);
    setDirtyIds((current) => clearDirtyForTabs(current, removed.map((tab) => tab.id)));
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
        <WorkspaceSidebar snapshot={snapshot} pathname={active.path} onNavigate={openPath} onSignOut={signOutAndClear} />
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
    </div>
  );
}
