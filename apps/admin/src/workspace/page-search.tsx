import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { filterSearchablePages, type SearchableWorkspacePage } from "./nav-config";

export function WorkspacePageSearch({
  pages,
  onNavigate,
}: {
  pages: SearchableWorkspacePage[];
  onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => filterSearchablePages(pages, query), [pages, query]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const go = (path: string) => {
    setOpen(false);
    onNavigate(path);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const next = results[activeIndex] ?? results[0];
      if (next) go(next.path);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const next = results[activeIndex] ?? results[0];
    if (next) go(next.path);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full max-w-md justify-start gap-2 px-2.5 font-normal shadow-none"
            aria-label="搜索页面"
          >
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground truncate">搜索页面</span>
            <kbd className="bg-background text-muted-foreground ms-auto hidden h-5 items-center rounded border px-1 font-sans text-[10px] sm:inline-flex">
              Ctrl K
            </kbd>
          </Button>
        }
      />
      <PopoverContent align="start" sideOffset={6} className="w-(--anchor-width) min-w-72 max-w-md gap-2 p-2">
        <form onSubmit={onSubmit}>
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="在当前权限内的已实现页面中查找"
            aria-label="搜索页面"
            autoComplete="off"
          />
        </form>
        <p className="text-muted-foreground px-1 text-[11px]">只搜索可打开的管理页面，不是订单或用户检索。</p>
        <ul role="listbox" aria-label="可打开的页面" className="max-h-72 overflow-auto">
          {results.length === 0 ? (
            <li className="text-muted-foreground px-2 py-3 text-xs">没有匹配的已实现页面。</li>
          ) : results.map((page, index) => (
            <li key={page.path}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm",
                  index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => go(page.path)}
              >
                <span>{page.label}</span>
                <span className="text-muted-foreground text-[11px]">{page.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
