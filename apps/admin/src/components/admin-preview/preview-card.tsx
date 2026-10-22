import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PreviewCardShellProps {
  ariaLabel: string;
  header: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

/**
 * 业务对象预览通用外壳：统一尺寸、自适应视口、防 React 事件冒泡（阻止触发行点击）。
 */
export function PreviewCardShell({
  ariaLabel,
  header,
  children,
  footer,
  className,
}: PreviewCardShellProps) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
        }
      }}
      className={cn(
        'w-64 max-w-[calc(100vw-32px)] text-popover-foreground space-y-2.5 select-text text-left',
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        {header}
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        {children}
      </div>
      {footer && (
        <div className="pt-2 border-t border-border">
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * 紧凑复制按钮：单动作解释 Tooltip，1.5 秒视觉反馈，完全阻止冒泡。
 */
export function PreviewCopyButton({
  value,
  label = '复制',
  tooltip = '复制 ID',
  className,
}: {
  value: string;
  label?: string;
  tooltip?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!value) return;
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={tooltip}
            onClick={handleCopy}
            className={cn('size-5 p-0 text-muted-foreground hover:text-foreground cursor-pointer', className)}
          >
            {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          </Button>
        }
      />
      <TooltipContent side="top">{copied ? '已复制' : tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 预览底部详情按钮或未授权降级提示。
 */
export function PreviewFooterAction({
  canOpen,
  onOpen,
  label = '查看详情',
  deniedReason = '当前身份没有该对象读取授权或该行未开放下钻，未读取完整资料。',
}: {
  canOpen?: boolean;
  onOpen?: () => void;
  label?: string;
  deniedReason?: string;
}) {
  if (canOpen && onOpen) {
    return (
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="flex items-center gap-1 text-xs text-primary hover:underline font-medium p-0 h-auto cursor-pointer"
      >
        <span>{label}</span>
        <ExternalLink className="size-3" />
      </Button>
    );
  }

  return (
    <p className="text-[11px] text-muted-foreground leading-normal">
      {deniedReason}
    </p>
  );
}
