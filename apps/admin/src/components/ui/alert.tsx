import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Adapted from shadcn/ui new-york-v4 `alert` (https://ui.shadcn.com/r/styles/new-york-v4/alert.json).
// Upstream copy depended on cva + cn only. Local changes: R2 quiet-surface danger/warning/success
// variants, an AlertAction recovery row, and an AlertTitle that wraps Chinese headings.
const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-1.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",
        // R2: 中性表面 + 小型语义图标，标题与正文保持主文字色。
        danger: "bg-card text-card-foreground [&>svg]:text-destructive",
        warning:
          "bg-card text-card-foreground [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400",
        success:
          "bg-card text-card-foreground [&>svg]:text-emerald-700 dark:[&>svg]:text-emerald-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 min-h-4 text-base leading-relaxed font-semibold",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("col-start-2 flex flex-wrap items-center gap-x-4 gap-y-2 pt-1", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
