import * as React from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const USER_DIRECTORY_MAX_PAGE = 1_000_000;

export type PagePagination = {
  mode: "page";
  page: number;
  pageSize: number;
  total: number;
  loading: boolean;
  pageSizeOptions: readonly number[];
  loadedCount?: number;
  itemLabel?: string;
  onPageChange(page: number): void;
  onPageSizeChange(size: number): void;
};

export type CursorPagination = {
  mode: "cursor";
  pageSize: number;
  loadedCount: number;
  total?: number;
  loading: boolean;
  pageSizeOptions: readonly number[];
  hasPrevious: boolean;
  hasNext: boolean;
  itemLabel?: string;
  onPrevious(): void;
  onNext(): void;
  onPageSizeChange(size: number): void;
};

export type ListPaginationProps = (PagePagination | CursorPagination) & {
  className?: string;
};

function generatePageWindow(page: number, totalPages: number): Array<number | "..."> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (page <= 4) {
    return [1, 2, 3, 4, 5, "...", totalPages];
  }
  if (page >= totalPages - 3) {
    return [1, "...", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "...", page - 1, page, page + 1, "...", totalPages];
}

export function ListPagination(props: ListPaginationProps) {
  const { mode, pageSize, pageSizeOptions, loading, className } = props;
  const itemLabel = props.itemLabel ?? "位用户";
  const [jumpInput, setJumpInput] = React.useState("");
  const [jumpError, setJumpError] = React.useState<string | null>(null);

  // Build capacity items ensuring current pageSize is included even if non-standard
  const optionsSet = new Set(pageSizeOptions);
  if (pageSize && !optionsSet.has(pageSize)) {
    optionsSet.add(pageSize);
  }
  const sortedOptions = Array.from(optionsSet).sort((a, b) => a - b);
  const sizeItems = sortedOptions.map((s) => ({
    value: String(s),
    label: `${s} 条/页`,
  }));

  const handleSizeChange = (val: string | null) => {
    if (!val) return;
    const size = Number(val);
    if (Number.isSafeInteger(size) && size > 0) {
      props.onPageSizeChange(size);
    }
  };

  if (mode === "cursor") {
    const { loadedCount, total, hasPrevious, hasNext, onPrevious, onNext } = props;
    const isTrustedTotal =
      typeof total === "number" && Number.isSafeInteger(total) && total >= 0;

    return (
      <div
        data-slot="admin-list-pagination"
        className={cn("ud-pagination admin-list-pagination", className)}
        role="navigation"
        aria-label="分页导航（游标模式）"
      >
        <div className="admin-list-pagination-left">
          <span>
            {isTrustedTotal
              ? `共 ${total} ${itemLabel} · 当前页已加载 ${loadedCount} 条`
              : `当前页已加载 ${loadedCount} 条 · 总数待更新`}
            {loading ? " · 正在翻页" : ""}
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={handleSizeChange}
            items={sizeItems}
            disabled={loading}
          >
            <SelectTrigger
              aria-label="每页容量"
              size="sm"
              className="h-8 w-[100px] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sizeItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="admin-list-pagination-notice">
            当前服务暂未提供跳页能力
          </span>
        </div>
        <div className="admin-list-pagination-right">
          <Button
            variant="outline"
            size="sm"
            aria-label="上一页"
            disabled={loading || !hasPrevious}
            onClick={onPrevious}
          >
            <ChevronLeftIcon className="size-4 mr-1" />
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="下一页"
            disabled={loading || !hasNext}
            onClick={onNext}
          >
            下一页
            <ChevronRightIcon className="size-4 ml-1" />
          </Button>
        </div>
      </div>
    );
  }

  // mode === 'page'
  const { page, total, onPageChange, loadedCount } = props;
  const isTrustedTotal =
    typeof total === "number" && Number.isSafeInteger(total) && total >= 0;
  const safeTotal = isTrustedTotal ? total : 0;
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / pageSize);
  const maxAllowedPage = Math.min(totalPages, USER_DIRECTORY_MAX_PAGE);

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = jumpInput.trim();
    if (!trimmed) {
      setJumpError("请输入页码");
      return;
    }
    // Must be a positive decimal integer without decimals, signs, or scientific notation
    if (!/^[1-9]\d*$/.test(trimmed)) {
      setJumpError("请输入有效的整数页码");
      return;
    }
    const target = Number(trimmed);
    if (!Number.isSafeInteger(target) || target < 1 || target > maxAllowedPage) {
      setJumpError(`请输入 1 到 ${maxAllowedPage} 之间的页码`);
      return;
    }
    setJumpError(null);
    setJumpInput("");
    onPageChange(target);
  };

  const pagesWindow = totalPages > 0 ? generatePageWindow(page, maxAllowedPage) : [];

  const displayCount = loadedCount ?? Math.max(0, Math.min(pageSize, safeTotal - (page - 1) * pageSize));
  const rangeStart = (page - 1) * pageSize + 1;
  const rangeLabel = displayCount > 0 ? `第 ${rangeStart}–${rangeStart + displayCount - 1} 位` : '当前页暂无记录';

  return (
    <div
      data-slot="admin-list-pagination"
      className={cn("ud-pagination admin-list-pagination", className)}
      role="navigation"
      aria-label="分页导航"
    >
      <div className="admin-list-pagination-left">
        <span>
          {safeTotal === 0 ? (
            `共 0 ${itemLabel} · 暂无分页`
          ) : (
            `共 ${safeTotal} ${itemLabel} · ${rangeLabel} · 当前页已加载 ${displayCount} 条 · 第 ${page} / ${totalPages} 页`
          )}
          {loading ? " · 正在翻页" : ""}
        </span>
        <Select
          value={String(pageSize)}
          onValueChange={handleSizeChange}
          items={sizeItems}
          disabled={loading}
        >
          <SelectTrigger
            aria-label="每页容量"
            size="sm"
            className="h-8 w-[100px] text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sizeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {totalPages > 0 ? (
        <div className="admin-list-pagination-center" aria-label="页码列表">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="首页"
            disabled={loading || page <= 1}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeftIcon className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="上一页"
            disabled={loading || page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeftIcon className="size-4 mr-0.5" />
            上一页
          </Button>

          {pagesWindow.map((p, idx) =>
            p === "..." ? (
              <span
                key={`ellipsis-${idx}`}
                className="px-2 text-xs text-muted-foreground select-none"
                aria-hidden
              >
                ...
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="icon-sm"
                aria-label={`第 ${p} 页`}
                aria-current={p === page ? "page" : undefined}
                disabled={loading}
                onClick={() => onPageChange(p)}
                className="text-xs"
              >
                {p}
              </Button>
            )
          )}

          <Button
            variant="outline"
            size="sm"
            aria-label="下一页"
            disabled={loading || page >= maxAllowedPage}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
            <ChevronRightIcon className="size-4 ml-0.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="末页"
            disabled={loading || page >= maxAllowedPage}
            onClick={() => onPageChange(maxAllowedPage)}
          >
            <ChevronsRightIcon className="size-4" />
          </Button>
        </div>
      ) : null}

      {totalPages > 1 ? (
        <div className="admin-list-pagination-right">
          <form
            noValidate
            onSubmit={handleJumpSubmit}
            className="admin-list-pagination-jump-form"
          >
            <span className="text-xs">前往第</span>
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="跳转页码"
              value={jumpInput}
              onChange={(e) => {
                setJumpInput(e.target.value);
                if (jumpError) setJumpError(null);
              }}
              disabled={loading}
              className="admin-list-pagination-jump-input h-7 w-12 px-1 text-center text-xs"
            />
            <span className="text-xs">页</span>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={loading}
              className="h-7 px-2 text-xs"
            >
              跳转
            </Button>
          </form>
          {jumpError ? (
            <span
              className="admin-list-pagination-error text-xs text-destructive"
              role="alert"
            >
              {jumpError}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
