import { BEIJING_TIME_ZONE } from "../../workspace/beijing-time";
import type { ReactNode } from "react";
import { CircleHelp, Lock } from "lucide-react";

import { Badge, InlineStatus, type InlineStatusTone } from "../../components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * 审批页局部原子。InfoHint / UnknownFact / FieldLabel 与 admin-directory-view.tsx
 * 内的同名局部实现逐字一致；两处都是文件内私有，跨页共享需要 Master 提升到共享模块
 * （见交付 brief 的共享 hunk 建议），本轮不复制第三份、也不改他人文件。
 * TooltipProvider 按既有约定只在页面根挂一次（ApprovalAuditView）。
 */

const approvalDateFormatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: BEIJING_TIME_ZONE });

export function formatApprovalDate(value: string | null): string {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : approvalDateFormatter.format(date);
}

export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" aria-label={label} className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />}
      >
        <CircleHelp size={13} aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}

/** 全页统一的“未提供”长相：虚线中性徽标 + Tooltip 说明来源，不冒充空值或 0。 */
export function UnknownFact({ hint }: { hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="unknown">未提供</Badge>} />
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{children}</span>;
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <h4 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
      {hint ? <InfoHint label="说明">{hint}</InfoHint> : null}
    </h4>
  );
}

export function Section({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <SectionTitle hint={hint}>{title}</SectionTitle>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

/** 标签在上、值在下的属性行；值为 null 时显示统一的未接入徽标而不是空字符串。 */
export function Fact({ label, value, mono = false }: { label: string; value: ReactNode | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      {value === null || value === undefined || value === ""
        ? <UnknownFact hint="这项信息暂未提供；不按 0 或已完成显示。" />
        : <div className={`text-sm leading-relaxed break-words ${mono ? "font-mono text-xs" : ""}`}>{value}</div>}
    </div>
  );
}

export function FactGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

export function StatusFact({ label, tone, children }: { label: string; tone: InlineStatusTone; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <InlineStatus tone={tone}>{children}</InlineStatus>
    </div>
  );
}

export function NotApplicable({ reason }: { reason: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-foreground/[0.04] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
      <Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
      {reason}
    </p>
  );
}
