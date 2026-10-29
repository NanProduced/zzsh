import { useEffect } from "react";
import { CheckIcon, LaptopIcon, LockIcon, MoonIcon, RefreshCwIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import type { Theme, ThemeMode } from "../api";

import type { SearchableWorkspacePage } from "./nav-config";
import { WorkspacePageSearch } from "./page-search";
import type { WorkspaceTab } from "./tab-model";

export function WorkspaceTopbar({
  pathname,
  theme,
  themeMode,
  onToggleTheme,
  onSelectThemeMode,
  onRefresh,
  onLock,
  canLock,
  refreshing,
  refreshDisabled = false,
  pages,
  onNavigate,
  tabs,
  activeTabId,
  onActivateTab,
  adminUserId,
  sessionId,
  isLocked,
  themeStorageError = false,
}: {
  pathname: string;
  theme: Theme;
  themeMode?: ThemeMode;
  onToggleTheme?: () => void;
  onSelectThemeMode?: (mode: ThemeMode) => void;
  onRefresh: () => void;
  onLock: () => void;
  canLock: boolean;
  refreshing: boolean;
  refreshDisabled?: boolean;
  pages: SearchableWorkspacePage[];
  onNavigate: (path: string) => boolean | void;
  tabs?: WorkspaceTab[];
  activeTabId?: string;
  onActivateTab?: (tabId: string) => boolean | void;
  adminUserId?: string;
  sessionId?: string;
  isLocked?: boolean;
  themeStorageError?: boolean;
}) {
  const { setOpenMobile } = useSidebar();

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    <header className="bg-background sticky top-0 z-40 flex min-h-12 items-center justify-between border-b">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <SidebarTrigger />
        <div className="min-w-0 flex-1">
          <WorkspacePageSearch
            pages={pages}
            onNavigate={onNavigate}
            tabs={tabs}
            activeTabId={activeTabId}
            onActivateTab={onActivateTab}
            adminUserId={adminUserId}
            sessionId={sessionId}
            isLocked={isLocked}
          />
        </div>
      </div>
      <div className="flex items-center gap-1.5 px-3">
        {themeStorageError && (
          <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500 font-medium shrink-0">
            已临时应用，无法保存在此浏览器
          </span>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="刷新当前页" onClick={onRefresh} disabled={refreshing || refreshDisabled}>
          <RefreshCwIcon className={refreshing ? "size-4 animate-spin" : "size-4"} />
        </Button>
        {onSelectThemeMode ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`主题模式：${themeMode === "light" ? "浅色" : themeMode === "dark" ? "深色" : "跟随系统"}`}
                  title={`主题：${themeMode === "light" ? "浅色" : themeMode === "dark" ? "深色" : "跟随系统"}`}
                >
                  {themeMode === "system" ? (
                    <LaptopIcon className="size-4" />
                  ) : theme === "dark" ? (
                    <MoonIcon className="size-4" />
                  ) : (
                    <SunIcon className="size-4" />
                  )}
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onClick={() => onSelectThemeMode("light")}>
                <SunIcon className="size-4" />
                <span>浅色</span>
                {themeMode === "light" ? <CheckIcon className="ms-auto size-4" /> : null}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSelectThemeMode("dark")}>
                <MoonIcon className="size-4" />
                <span>深色</span>
                {themeMode === "dark" ? <CheckIcon className="ms-auto size-4" /> : null}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSelectThemeMode("system")}>
                <LaptopIcon className="size-4" />
                <span>跟随系统</span>
                {themeMode === "system" ? <CheckIcon className="ms-auto size-4" /> : null}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={onToggleTheme}>
            {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="锁定当前会话" onClick={onLock} disabled={!canLock} className="max-[1024px]:hidden">
          <LockIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}
