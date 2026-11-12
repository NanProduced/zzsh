"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipArrow = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Arrow>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Arrow>
>(({ className, ...props }, ref) => (
  <TooltipPrimitive.Arrow
    ref={ref}
    className={["app-tooltip-arrow", className].filter(Boolean).join(" ")}
    {...props}
  />
));
TooltipArrow.displayName = TooltipPrimitive.Arrow.displayName;

interface TooltipContentProps
  extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {
  showArrow?: boolean;
}

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(({ className, sideOffset = 6, showArrow = false, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={["app-tooltip-content", className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
      {showArrow ? <TooltipArrow width={8} height={4} /> : null}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));

TooltipContent.displayName = TooltipPrimitive.Content.displayName;

interface ActionTooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  delayDuration?: number;
  showArrow?: boolean;
}

/**
 * 统一快捷气泡提示：包裹任意按钮/图标，简化样板代码
 */
function ActionTooltip({
  content,
  children,
  side = "top",
  align = "center",
  sideOffset = 6,
  className,
  delayDuration = 180,
  showArrow = false,
}: ActionTooltipProps) {
  if (!content) return children;
  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={className}
        showArrow={showArrow}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

interface InfoTipProps {
  label: string;
  title?: string;
  body: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
}

/**
 * 统一说明型气泡：Info 触发图标 + 标题 + 正文，全平台统一风格
 */
function InfoTip({
  label,
  title,
  body,
  side = "top",
  align = "center",
  sideOffset = 6,
  className,
}: InfoTipProps) {
  return (
    <ActionTooltip
      side={side}
      align={align}
      sideOffset={sideOffset}
      showArrow={true}
      className={["app-tooltip-infotip", className].filter(Boolean).join(" ")}
      content={
        <div className="app-tooltip-infotip-inner">
          {title ? <strong className="app-tooltip-infotip-title">{title}</strong> : null}
          <div className="app-tooltip-infotip-body">{body}</div>
        </div>
      }
    >
      <button
        type="button"
        className="app-tooltip-trigger-btn"
        aria-label={label}
      >
        <Info size={14} aria-hidden="true" />
      </button>
    </ActionTooltip>
  );
}

export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  TooltipArrow,
  ActionTooltip,
  InfoTip,
};
