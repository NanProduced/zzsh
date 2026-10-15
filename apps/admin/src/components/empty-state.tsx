import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * EmptyState - 小型空状态/无结果展示组件
 * 参考 devl "No results" (https://www.devl.dev/c/empty-states/no-results) 结构与层次设计，
 * 采用克制的圆角图标容器、短标题、辅助说明和真实操作按钮。
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border/70 bg-card/40 px-4 py-8 text-center max-w-full overflow-hidden",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-full border border-border/80 bg-muted/60 text-muted-foreground mb-3 shrink-0">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-foreground max-w-full break-words [overflow-wrap:anywhere]">{title}</p>
      {description ? (
        <p className="text-muted-foreground mt-1.5 text-xs max-w-sm w-full break-all [overflow-wrap:anywhere] leading-relaxed">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * EndOfFeed - 列表/历史已读到末尾反馈组件
 * 参考 devl "End of feed" (https://www.devl.dev/c/empty-states/end-of-feed) 结构设计，
 * 以细分割线加微型对勾圆环指示当前查询结果的终点。
 */
export function EndOfFeed({
  title = "当前查询没有更多记录",
  description = "已到达本次查询的末尾。新事件发生时将按时间逆序记录。",
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("mt-6 mb-2 flex flex-col items-center gap-2", className)} role="status">
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-border/60" />
        <div className="flex size-5 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
          <CheckIcon className="size-3" aria-hidden="true" />
        </div>
        <div className="h-px flex-1 bg-border/60" />
      </div>
      <p className="text-[11px] font-medium text-muted-foreground tracking-wider">{title}</p>
      {description ? <p className="text-[11px] text-muted-foreground/80 max-w-xs text-center">{description}</p> : null}
    </div>
  );
}
