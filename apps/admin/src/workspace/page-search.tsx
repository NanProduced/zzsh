import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  BoxesIcon,
  ClipboardCheckIcon,
  CrosshairIcon,
  CrownIcon,
  FileTextIcon,
  ImageIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  NewspaperIcon,
  ScrollTextIcon,
  SearchIcon,
  SearchXIcon,
  SettingsIcon,
  ShieldIcon,
  ShoppingBagIcon,
  UserRoundCogIcon,
  UserRoundSearchIcon,
  UsersRoundIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { EmptyState } from "@/components/empty-state";

import {
  filterSearchablePages,
  normalizeSearchString,
  scorePageMatch,
  type SearchableWorkspacePage,
} from "./nav-config";
import {
  tabPresentation,
  tabHref,
  WORKBENCH_TAB_ID,
  type WorkspaceRouteKind,
  type WorkspaceTab,
} from "./tab-model";

export type RecentAccessItem = {
  id: string;
  title: string;
  path: string;
  group: string;
  kind?: WorkspaceRouteKind;
  type?: string;
  objectId?: string;
  tabId?: string;
  accessedAt: number;
};

function getPageIcon(path: string): LucideIcon {
  if (path === "/workbench") return LayoutDashboardIcon;
  if (path === "/support") return MessagesSquareIcon;
  if (path === "/membership-growth") return CrownIcon;
  if (path === "/admins" || path.startsWith("/admins/")) return UserRoundCogIcon;
  if (path === "/roles" || path.startsWith("/roles/")) return KeyRoundIcon;
  if (path === "/supply/catalog") return BoxesIcon;
  if (path === "/supply/gunsmith") return CrosshairIcon;
  if (path === "/supply/rules") return ListChecksIcon;
  if (path === "/supply/reviews" || path.startsWith("/supply/reviews/")) return ClipboardCheckIcon;
  if (path === "/supply/media") return ImageIcon;
  if (path === "/content") return NewspaperIcon;
  if (path === "/finance" || path.startsWith("/finance/")) return WalletIcon;
  if (path === "/orders" || path.startsWith("/orders/")) return ShoppingBagIcon;
  if (path === "/users/restore") return UserRoundSearchIcon;
  if (path === "/users" || path.startsWith("/users/")) return UsersRoundIcon;
  if (path === "/approvals" || path.startsWith("/approvals/")) return ClipboardCheckIcon;
  if (path === "/audit") return ScrollTextIcon;
  if (path === "/settings") return SettingsIcon;
  if (path === "/account") return ShieldIcon;
  return FileTextIcon;
}

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 45) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  return `${Math.floor(diffSec / 86400)}天前`;
}

const EMPTY_TABS: WorkspaceTab[] = [];

type PageSearchProps = {
  pages: SearchableWorkspacePage[];
  onNavigate: (path: string) => boolean | void;
  tabs?: WorkspaceTab[];
  activeTabId?: string;
  onActivateTab?: (tabId: string) => boolean | void;
  adminUserId?: string;
  sessionId?: string;
  isLocked?: boolean;
};

export function WorkspacePageSearch(props: PageSearchProps) {
  // Unmount the portal, hotkeys and all query/history/IME state at the identity boundary.
  if (props.isLocked) return null;
  return <PageSearch key={JSON.stringify([props.adminUserId, props.sessionId])} {...props} />;
}

function hasBlockingModal(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="sheet-content"]',
  )).some((element) => {
    if (element.closest('[data-command-palette="true"], [hidden], [aria-hidden="true"], [inert], [data-closed]')) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

function PageSearch({
  pages,
  onNavigate,
  tabs = EMPTY_TABS,
  activeTabId,
  onActivateTab,
}: PageSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentItems, setRecentItems] = useState<RecentAccessItem[]>([]);
  const isComposingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastRecordedActiveTabIdRef = useRef(activeTabId);

  const visibleRecentItems = recentItems.filter((item) => item.type
    ? tabs.some((tab) => tab.id === item.tabId)
    : pages.some((page) => page.path === item.path));

  // Evict closed detail tabs from recent items automatically
  useEffect(() => {
    setRecentItems((current) => {
      const filtered = current.filter((item) => {
        return item.type ? tabs.some((tab) => tab.id === item.tabId) : pages.some((page) => page.path === item.path);
      });
      if (filtered.length === current.length) return current;
      return filtered;
    });
  }, [tabs, pages]);

  const itemForTab = useCallback((tab: WorkspaceTab): RecentAccessItem => {
    const pres = tabPresentation(tab, tabs);
    return { id: `tab:${tab.id}`, title: pres.label, path: tab.path,
      group: pres.type ? `${pres.type}详情` : pages.find((page) => page.path === tab.path)?.group ?? "工作区",
      type: pres.type, objectId: tab.objectId, tabId: tab.id, accessedAt: Date.now() };
  }, [pages, tabs]);

  // Record successful active tab changes in the workspace
  useEffect(() => {
    if (!activeTabId || tabs.length === 0 || activeTabId === WORKBENCH_TAB_ID) return;
    if (lastRecordedActiveTabIdRef.current === activeTabId) return;
    lastRecordedActiveTabIdRef.current = activeTabId;
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab) return;

    const item = itemForTab(activeTab);

    setRecentItems((prev) => {
      const rest = prev.filter((r) => r.path !== item.path && r.id !== item.id);
      return [item, ...rest].slice(0, 6);
    });
  }, [activeTabId, tabs, itemForTab]);

  // Global Ctrl/Cmd + K shortcut with sensitive dialog collision guard
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.defaultPrevented && !event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (hasBlockingModal()) return;

        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset query on close and restore focus on open
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 25);
    return () => window.clearTimeout(timer);
  }, [open]);

  const handleClear = useCallback(() => {
    setQuery("");
    inputRef.current?.focus();
  }, []);

  // Resolve again at selection time; a group or cached history entry is not authority.
  const selectDestination = useCallback(
    (target: { path: string; tabId?: string; type?: string }) => {
      const tab = tabs.find((item) => target.tabId ? item.id === target.tabId : item.path === target.path);
      const page = pages.find((item) => item.path === target.path);
      if ((!tab && target.type) || (!tab && !page) || (tab && !tabPresentation(tab, tabs).type && !page)) return;
      const item: RecentAccessItem = tab ? itemForTab(tab) : {
        id: `page:${page!.path}`, title: page!.label, path: page!.path, group: page!.group, accessedAt: Date.now(),
      };
      const res = tab && onActivateTab ? onActivateTab(tab.id) : onNavigate(tab ? tabHref(tab) : page!.path);
      if (res !== false) {
        setRecentItems((prev) => [
          item,
          ...prev.filter((r) => r.path !== item.path && r.id !== item.id),
        ].slice(0, 6));
      }
      setOpen(false);
    },
    [tabs, pages, onActivateTab, onNavigate, itemForTab]
  );

  // Compute matched open tabs and pages with transparent scoring
  const normQuery = useMemo(() => normalizeSearchString(query), [query]);
  const tokens = useMemo(() => normQuery.split(/\s+/).filter(Boolean), [normQuery]);

  // Open tabs matching query
  const matchingOpenTabs = useMemo(() => {
    if (!tokens.length) return [];

    const matched: { tab: WorkspaceTab; item: RecentAccessItem; score: number }[] = [];

    for (const tab of tabs) {
      const pres = tabPresentation(tab, tabs);
      const titleNorm = normalizeSearchString(tab.title);
      const labelNorm = normalizeSearchString(pres.label);
      const typeNorm = pres.type ? normalizeSearchString(pres.type) : "";
      const idNorm = tab.objectId ? normalizeSearchString(tab.objectId) : "";
      const pathNorm = normalizeSearchString(tab.path);

      // Multi-token AND matching
      const allTokensMatch = tokens.every((token) => {
        return (
          titleNorm.includes(token) ||
          labelNorm.includes(token) ||
          typeNorm.includes(token) ||
          idNorm.includes(token) ||
          pathNorm.includes(token)
        );
      });

      const page = pages.find((item) => item.path === tab.path);
      const pageScore = page ? scorePageMatch(page, normQuery) : null;
      if (!allTokensMatch && pageScore === null) continue;

      // Transparent scoring: exact > prefix > contains > type/path
      let score = 5;
      if (labelNorm === normQuery || idNorm === normQuery) {
        score = 1;
      } else if (labelNorm.startsWith(normQuery) || idNorm.startsWith(normQuery)) {
        score = 2;
      } else if (labelNorm.includes(normQuery) || idNorm.includes(normQuery)) {
        score = 3;
      } else if (typeNorm.includes(normQuery) || pathNorm.includes(normQuery)) {
        score = 4;
      }

      matched.push({ tab, item: itemForTab(tab), score: pageScore === null ? score : Math.min(score, pageScore) });
    }

    matched.sort((a, b) => a.score - b.score);
    return matched;
  }, [normQuery, tabs, tokens, pages, itemForTab]);

  // Open tab paths set for deduplication against static pages
  const openTabPathsSet = useMemo(() => {
    const set = new Set<string>();
    for (const t of tabs) {
      if (t.path) set.add(t.path);
    }
    return set;
  }, [tabs]);

  // Filtered and scored pages
  const matchingPages = (() => {
    if (!tokens.length) {
      // When query is empty: deduplicate accessible pages against recent list
      const recentPathSet = new Set(visibleRecentItems.map((r) => r.path));
      return pages.filter((p) => !recentPathSet.has(p.path));
    }

    // When query is not empty: deduplicate against matching open tabs
    const matchedTabPaths = new Set(matchingOpenTabs.map((m) => m.tab.path));
    const candidatePages = pages.filter((p) => !matchedTabPaths.has(p.path));

    return filterSearchablePages(candidatePages, normQuery);
  })();

  const hasAnyResults = matchingOpenTabs.length > 0 || matchingPages.length > 0 || (tokens.length === 0 && visibleRecentItems.length > 0);

  // Prevent navigation during IME composition
  const handleInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
      e.stopPropagation();
      return;
    }
  };

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        onClick={() => { if (!hasBlockingModal()) setOpen(true); }}
        className="bg-muted/40 hover:bg-muted/70 text-muted-foreground relative h-8 w-full max-w-sm justify-start text-xs sm:pr-12 shadow-none border border-border/80"
        aria-label="搜索页面"
      >
        <SearchIcon className="mr-2 size-3.5 shrink-0 opacity-70" />
        <span className="truncate">搜索页面与标签</span>
        <kbd className="bg-background text-muted-foreground pointer-events-none absolute right-1.5 top-1.5 hidden h-5 select-none items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
          <span className="text-xs">{typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}</span>K
        </kbd>
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            onKeyDown={handleInputKeyDown}
            placeholder="在当前权限内的已实现页面中查找"
            aria-label="搜索页面与标签"
            autoComplete="off"
          />

          <CommandList className="max-w-full">
            {!hasAnyResults && query.trim() ? (
              <CommandEmpty className="p-4 max-w-full">
                <EmptyState
                  icon={<SearchXIcon className="size-5" />}
                  title="未找到匹配的可访问页面"
                  description={
                    <>
                      没有找到与 “<span className="font-medium text-foreground inline break-all [overflow-wrap:anywhere]">{query.trim()}</span>” 相关的页面。
                    </>
                  }
                  action={
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleClear}
                      className="h-7 px-3 text-xs"
                    >
                      清空搜索
                    </Button>
                  }
                  className="py-6"
                />
              </CommandEmpty>
            ) : !hasAnyResults && !query.trim() && pages.length === 0 ? (
              <CommandEmpty className="p-4 max-w-full">
                <EmptyState
                  icon={<SearchIcon className="size-5" />}
                  title="当前无可访问页面"
                  description="当前登录账号未分配可在此打开的管理页面。"
                  className="py-6"
                />
              </CommandEmpty>
            ) : null}

            {/* When query is empty: show Recent Access up to 6 items */}
            {!query.trim() && visibleRecentItems.length > 0 ? (
              <CommandGroup heading="最近访问">
                {visibleRecentItems.map((item) => {
                  const Icon = getPageIcon(item.path);
                  return (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      onSelect={() => selectDestination(item)}
                      className="flex items-center justify-between gap-2.5"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">{item.title}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {item.type ? (
                              <>
                                {item.type}详情
                                {item.objectId ? (
                                  <> · ID: <span className="break-all [overflow-wrap:anywhere]">{item.objectId}</span></>
                                ) : null}
                              </>
                            ) : (
                              item.group
                            )}
                          </span>
                        </div>
                      </div>
                      <CommandShortcut>{formatRelativeTime(item.accessedAt)}</CommandShortcut>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}

            {/* When query is not empty: show Matching Open Tabs */}
            {query.trim() && matchingOpenTabs.length > 0 ? (
              <CommandGroup heading="已打开标签">
                {matchingOpenTabs.map(({ tab, item }) => {
                  const Icon = getPageIcon(tab.path);
                  return (
                    <CommandItem
                      key={tab.id}
                      value={`tab:${tab.id}`}
                      onSelect={() => selectDestination(item)}
                      className="flex items-center justify-between gap-2.5"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">{item.title}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {item.type ? (
                              <>
                                {item.type}详情
                                {item.objectId ? (
                                  <> · ID: <span className="break-all [overflow-wrap:anywhere]">{item.objectId}</span></>
                                ) : null}
                              </>
                            ) : (
                              item.group
                            )}
                          </span>
                        </div>
                      </div>
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground shrink-0">
                        已打开
                      </Badge>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}

            {!query.trim() && visibleRecentItems.length > 0 && matchingPages.length > 0 ? (
              <CommandSeparator />
            ) : null}

            {/* Accessible Pages Group */}
            {matchingPages.length > 0 ? (
              <CommandGroup heading={query.trim() ? "页面导航" : "可访问页面"}>
                {matchingPages.map((page) => {
                  const Icon = getPageIcon(page.path);
                  const isOpen = openTabPathsSet.has(page.path);
                  return (
                    <CommandItem
                      key={page.path}
                      value={`page:${page.path}`}
                      onSelect={() => selectDestination(page)}
                      className="flex items-center justify-between gap-2.5"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-sm font-medium">{page.label}</span>
                          <span className="truncate text-[11px] text-muted-foreground">{page.group}</span>
                        </div>
                      </div>
                      {isOpen ? (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground shrink-0">
                          已打开
                        </Badge>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>

          <div className="flex items-center justify-between border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground bg-muted/20">
            <span className="truncate">按拼音首字母或多词搜索</span>
            <div className="flex items-center gap-2.5 shrink-0">
              <span className="hidden sm:inline-flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">↑↓</kbd> 切换
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">↵</kbd> 选择
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1 font-mono text-[10px]">Esc</kbd> 关闭
              </span>
            </div>
          </div>
      </CommandDialog>
    </>
  );
}
