import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cloneElement, type ReactNode } from "react"
import { Info } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { workspacePortalContainer } from "@/lib/workspace-portal"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal container={workspacePortalContainer()}>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 flex w-fit max-w-xs origin-(--transform-origin) flex-col items-start gap-1 rounded-md bg-foreground px-3 py-2 text-left text-xs leading-relaxed text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/**
 * 管理端统一的「说明型」Tooltip 入口：Info 图标 + 标题 + 正文。
 * 业务页不再自行拼 TooltipProvider/Root/Trigger/Content，也不使用原生 title=。
 */
function InfoTip({
  label,
  title,
  body,
  describedBy,
  className,
}: {
  label: string;
  title?: string;
  body: ReactNode;
  describedBy?: string;
  className?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn("-mt-0.5 shrink-0", className)}
            aria-label={label}
            aria-describedby={describedBy}
          >
            <Info className="size-3.5" aria-hidden="true" />
          </Button>
        } />
        <TooltipContent side="bottom" align="start" className="admin-info-tip">
          {title ? <p className="admin-info-tip-title">{title}</p> : null}
          <p className="admin-info-tip-body">{body}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ActionTooltip({
  content,
  children,
  side = "top",
  align = "center",
  delay = 150,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  align?: "center" | "start" | "end";
  delay?: number;
  className?: string;
}) {
  if (!content) return children;
  const childProps = children.props as { tabIndex?: number; "aria-hidden"?: boolean };
  const trigger = typeof children.type === "string" && ["span", "div", "strong"].includes(children.type)
    && childProps.tabIndex == null && childProps["aria-hidden"] !== true
    ? cloneElement(children as React.ReactElement<{ tabIndex?: number }>, { tabIndex: 0 }) : children;
  return (
    <TooltipProvider delay={delay}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent side={side} align={align} className={className}>
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, ActionTooltip, InfoTip }
