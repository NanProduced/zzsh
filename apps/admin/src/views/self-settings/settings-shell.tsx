import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Badge, InlineStatus, type InlineStatusTone } from "../../components/ui/badge";

/**
 * 设置工作区共用骨架。结构与 `views/settings-view.tsx`（外观）和
 * `views/security-self/security-self-view.tsx`（登录与安全）保持一致：
 * 同一 max-w-6xl 容器、同一页头层次、同一「分组 + 分隔行」卡片，避免四张设置分区各立一套排版。
 */

export function SettingsPageHeader({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string;
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="text-muted-foreground mb-1 font-mono text-[11px] tracking-wider uppercase">{eyebrow}</div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}

export function SettingsGroup({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? <p className="text-muted-foreground mt-0.5 text-xs">{description}</p> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      <div className="divide-border bg-surface-raised/40 divide-y rounded-xl border border-border">{children}</div>
    </section>
  );
}

/** 一行一个事实或一个动作；说明文字保持短句，必要的前提收进 InfoHint。 */
export function SettingsRow({
  title,
  status,
  description,
  action,
  pending,
  className,
}: {
  title: string;
  status?: { label: string; tone?: InlineStatusTone };
  description?: ReactNode;
  action?: ReactNode;
  pending?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between",
        pending && "bg-muted/30",
        className,
      )}
    >
      <div className="min-w-0 max-w-xl">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground break-words [overflow-wrap:anywhere]">{title}</h3>
          {status ? <InlineStatus tone={status.tone ?? "neutral"}>{status.label}</InlineStatus> : null}
        </div>
        {description ? <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** 没有值时显示的可辨识标记：虚线徽标，明确区别于 0、空字符串或成功。 */
export function MissingValue({ label = "未提供" }: { label?: string }) {
  return <Badge variant="unknown">{label}</Badge>;
}

export type NoticeTone = "info" | "warning" | "danger" | "success";

const noticeTones: Record<NoticeTone, string> = {
  info: "border-border bg-muted/40 text-muted-foreground",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-300",
  danger: "border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-300",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-300",
};

/** 页面级结果与责任提示：紧贴它所描述的对象，不堆成全局 toast。 */
export function SettingsNotice({
  tone = "info",
  role = "status",
  children,
  action,
}: {
  tone?: NoticeTone;
  role?: "status" | "alert";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={role}
      className={cn("flex flex-col gap-2 rounded-lg border p-3 text-xs leading-relaxed sm:flex-row sm:items-center sm:justify-between", noticeTones[tone])}
    >
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}
