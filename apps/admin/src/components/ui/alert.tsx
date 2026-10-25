import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

// Adapted from ReUI Alert (https://reui.io/docs/components/base/alert, registry https://reui.io/r/alert.json).
// Upstream parts: Alert / AlertTitle / AlertDescription / AlertAction. Local changes:
// - `danger` kept as a transitional alias of `destructive`, so old calls stay destructive rather than default.
// - AlertAction stays in the content column (below the text) instead of drifting to the far right.
// - Optional dismiss with an explicit focus-return target; persistence stays with the caller.
// - `role` defaults to "alert" but can be set to "status" for non-urgent notices.
const destructiveSurface =
  "border-destructive/40 bg-destructive/8 [&>svg]:text-destructive"

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-1.5 rounded-lg border border-border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive: destructiveSurface,
        // Transitional alias: explicit destructive mapping, never a silent default.
        danger: destructiveSurface,
        info: "border-info/35 bg-info/8 [&>svg]:text-info-foreground",
        success: "border-success/35 bg-success/8 [&>svg]:text-success-foreground",
        warning: "border-warning/40 bg-warning/8 [&>svg]:text-warning-foreground",
        invert:
          "border-invert bg-invert text-invert-foreground [&_[data-slot=alert-description]]:text-invert-foreground/80 [&>svg]:text-invert-foreground",
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
  role = "alert",
  onDismiss,
  dismissFocusRef,
  dismissLabel = "关闭提示",
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    onDismiss?: () => void
    /** Element that receives focus after this alert is removed; usually the trigger. */
    dismissFocusRef?: React.RefObject<HTMLElement | null>
    dismissLabel?: string
  }) {
  const dismiss = () => {
    onDismiss?.()
    const target = dismissFocusRef?.current
    if (target) target.focus()
  }

  return (
    <div
      data-slot="alert"
      role={role}
      className={cn(alertVariants({ variant }), onDismiss && "pr-11", className)}
      {...props}
    >
      {children}
      {onDismiss ? (
        <button
          type="button"
          data-slot="alert-dismiss"
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={dismiss}
          className="absolute top-1.5 right-1.5 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 min-h-4 min-w-0 text-sm leading-relaxed font-semibold break-words",
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
        "col-start-2 grid min-w-0 justify-items-start gap-1 text-sm leading-relaxed text-muted-foreground break-words [&_p]:leading-relaxed",
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
      className={cn(
        "col-start-2 flex flex-wrap items-center gap-x-3 gap-y-2 pt-1",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
