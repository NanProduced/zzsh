import { useEffect, useRef, useState } from "react";
import { Loader2, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AdminApiError, friendlyError, hasPermission, type SessionSnapshot } from "../api";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { directoryAdapter, EMPTY_FILTERS, REGISTRATION_SORT, REGISTRATION_TIME_ORIGINAL, type User } from "./user-directory/user-directory-data";

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const denied = error instanceof AdminApiError && error.status === 403;
  const changed = error instanceof AdminApiError && error.status === 409;
  const title = denied ? "无权查看这部分内容" : changed ? "读取范围已变化" : "读取失败";
  return <Alert variant={denied || changed ? "warning" : "destructive"} role={denied || changed ? "status" : "alert"}><TriangleAlert aria-hidden /><AlertTitle>{title}</AlertTitle><AlertDescription>{changed ? "请重新读取当前范围后继续。" : friendlyError(error)}</AlertDescription>{retry ? <AlertAction><Button size="sm" variant="outline" onClick={retry}>重试</Button></AlertAction> : null}</Alert>;
}

export function UserPicker({
  snapshot,
  userId,
  label,
  onSelect,
  disabled,
}: {
  snapshot: Snapshot;
  userId: string;
  label: string;
  onSelect: (userId: string, label: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(label || "");
  const [rows, setRows] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const lastSearchedRef = useRef<string>("");

  useEffect(() => {
    if (label) setQuery(label);
    else if (!userId) setQuery("");
  }, [label, userId]);

  useEffect(() => () => {
    controller.current?.abort();
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const canSearch = snapshot.security.isBoss || hasPermission(snapshot, "user.directory.read");
  const canPhoneLookup = hasPermission(snapshot, "user.phone.lookup");

  async function search(searchText?: string) {
    const q = (searchText !== undefined ? searchText : query).trim();
    if (!q || disabled || !canSearch) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (controller.current) controller.current.abort();

    const read = new AbortController();
    controller.current = read;
    setBusy(true);
    setError(null);
    setOpen(true);
    lastSearchedRef.current = q;

    try {
      const result = await directoryAdapter(snapshot).adapter.list(
        // 默认聚合排序需要 order.read；选择用户时使用注册时间排序。
        { ...EMPTY_FILTERS, q, sort: REGISTRATION_SORT.desc, registrationTime: REGISTRATION_TIME_ORIGINAL },
        { page: 1, pageSize: 10 },
        read.signal
      );
      if (!read.signal.aborted) {
        setRows(result.rows);
      }
    } catch (failure) {
      if (!read.signal.aborted) setError(failure);
    } finally {
      if (!read.signal.aborted) setBusy(false);
    }
  }

  const handleInputChange = (text: string) => {
    setQuery(text);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    // 显式触发：避免输入过程中占用目录查询的并发名额。
    // 输入变化先撤掉上一次结果与在途请求，避免展示与当前关键词不符的旧列表。
    if (controller.current) {
      controller.current.abort();
      controller.current = null;
    }
    setBusy(false);
    setRows([]);
    setOpen(false);
    lastSearchedRef.current = "";
  };

  if (!canSearch) {
    return (
      <span className="text-xs text-muted-foreground">
        {userId ? label || "来源用户已选定" : "请从已授权的用户页面进入办理"}
      </span>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full min-w-[200px] max-w-sm">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
        <Search className="absolute left-2.5 size-3.5 text-muted-foreground pointer-events-none" aria-hidden />
        <Input
          aria-label="查找用户"
          placeholder={canPhoneLookup ? "输入手机号、昵称或ID搜索..." : "输入昵称或ID搜索..."}
          disabled={disabled}
          value={query}
          onFocus={() => {
            if (rows.length > 0) setOpen(true);
          }}
          onChange={(event) => handleInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          className="h-9 pl-8 pr-8 text-xs bg-background border-border/80 font-normal focus-visible:ring-1"
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {busy ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : query ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (controller.current) controller.current.abort();
                if (debounceTimer.current) clearTimeout(debounceTimer.current);
                setQuery("");
                setRows([]);
                setOpen(false);
                lastSearchedRef.current = "";
                onSelect("", "");
              }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
              title="清除输入"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        </div>
        <Button
          type="button"
          aria-label="选择用户"
          variant="outline"
          size="sm"
          disabled={disabled || busy || !query.trim()}
          onClick={() => void search()}
        >
          查询
        </Button>
      </div>
      {!canPhoneLookup ? <p className="mt-1 text-[11px] text-muted-foreground">手机号查找需要相应权限</p> : null}

      {/* Floating Dropdown Results Menu: 纯实色高对比度、绝不透光 */}
      {open ? (
        <div
          className="absolute left-0 top-full mt-1.5 w-full min-w-[280px] max-w-sm rounded-lg border border-border bg-[#ffffff] dark:bg-[#181b21] text-foreground shadow-2xl z-50 overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ backgroundColor: "var(--popover, #181b21)" }}
        >
          {busy && rows.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>正在检索匹配用户...</span>
            </div>
          ) : error ? (
            <div className="p-3">
              <ErrorBox error={error} />
            </div>
          ) : rows.length > 0 ? (
            <div className="max-h-60 overflow-y-auto p-1.5 space-y-1">
              <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                <span>匹配用户 ({rows.length})</span>
                {busy ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
              </div>
              {rows.map((row) => (
                <Button
                  key={row.id}
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setQuery(row.name);
                    onSelect(row.id, row.name);
                    setOpen(false);
                  }}
                  className="h-auto w-full justify-start whitespace-normal py-2 px-2.5 text-left text-xs hover:bg-muted/70 rounded-md transition-colors group"
                >
                  <div className="flex items-center gap-2.5 w-full">
                    <div className="size-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold shrink-0">
                      {(row.name || "U").slice(0, 1)}
                    </div>
                    <div className="space-y-0.5 flex-1 min-w-0">
                      <div className="font-medium text-foreground truncate group-hover:text-primary transition-colors">
                        {row.name}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono truncate">
                        {row.phoneMasked || row.id}
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0 font-normal">
                      选择
                    </Badge>
                  </div>
                </Button>
              ))}
            </div>
          ) : lastSearchedRef.current === query.trim() ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              未找到匹配的用户
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
  allowAll = true,
  triggerClassName,
  contentClassName,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (value: string) => void;
  disabled?: boolean;
  allowAll?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <Select
        value={value || (allowAll ? "all" : null)}
        disabled={disabled}
        onValueChange={(next) => {
          if (next) onChange(next === "all" ? "" : next);
        }}
      >
        <SelectTrigger
          aria-label={label}
          className={cn(
            "h-9 w-32 sm:w-36 justify-between text-xs bg-background border-border/80 font-normal hover:bg-muted/40 transition-colors",
            triggerClassName
          )}
        >
          <SelectValue className="truncate">
            {value ? options[value] ?? value : allowAll ? "全部" : "请选择"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          className={cn(
            "w-(--anchor-width) shadow-xl border border-border/80 bg-[#ffffff] dark:bg-[#181b21] p-1 z-50",
            contentClassName
          )}
          style={{ backgroundColor: "var(--popover, #181b21)" }}
        >
          {allowAll ? (
            <SelectItem value="all" className="text-xs py-1.5 px-2 rounded-md">
              全部
            </SelectItem>
          ) : null}
          {Object.entries(options).map(([key, text]) => (
            <SelectItem key={key} value={key} className="text-xs py-1.5 px-2 rounded-md truncate">
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
