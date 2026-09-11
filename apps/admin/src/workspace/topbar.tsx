import { useEffect } from "react";
import { LockIcon, MoonIcon, RefreshCwIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import type { Theme } from "../api";

import type { SearchableWorkspacePage } from "./nav-config";
import { WorkspacePageSearch } from "./page-search";

export function WorkspaceTopbar({
  pathname,
  theme,
  onToggleTheme,
  onRefresh,
  onLock,
  canLock,
  refreshing,
  pages,
  onNavigate,
}: {
  pathname: string;
  theme: Theme;
  onToggleTheme: () => void;
  onRefresh: () => void;
  onLock: () => void;
  canLock: boolean;
  refreshing: boolean;
  pages: SearchableWorkspacePage[];
  onNavigate: (path: string) => void;
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
          <WorkspacePageSearch pages={pages} onNavigate={onNavigate} />
        </div>
      </div>
      <div className="flex items-center gap-1.5 px-3">
        <Button variant="ghost" size="icon-sm" aria-label="刷新当前页" onClick={onRefresh} disabled={refreshing}>
          <RefreshCwIcon className={refreshing ? "size-4 animate-spin" : "size-4"} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={onToggleTheme}>
          {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="锁定当前会话" onClick={onLock} disabled={!canLock} className="max-[1024px]:hidden">
          <LockIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}
