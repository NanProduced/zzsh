// Source: https://ui.shadcn.com/r/styles/new-york/tooltip.json — shadcn/ui (MIT)
// Scoped Radix copy for the Plate shell; admin Base UI primitives in components/ui stay untouched.
"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"
import { workspacePortalContainer } from "@/lib/workspace-portal"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal container={workspacePortalContainer()}>
    <TooltipPrimitive.Content
      ref={ref}
      data-slot="plate-tooltip"
      sideOffset={sideOffset}
      className={cn(
        "z-[550] max-w-[min(18rem,calc(100vw-1.5rem))] rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground shadow-sm animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 origin-[--radix-tooltip-content-transform-origin]",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
