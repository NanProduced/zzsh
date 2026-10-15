import * as React from "react"

import { cn } from "@/lib/utils"

type FieldChildProps = {
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  "aria-labelledby"?: string
}

/**
 * 字段标签、说明与错误的共享组合。控件仍由调用方持有状态，这里只做可访问关联与文字层次。
 * composite 用于 Select 等非 labelable 控件：改用 aria-labelledby 关联可见标签。
 */
function Field({
  label,
  hint,
  error,
  required,
  composite,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
  composite?: boolean
}) {
  const id = React.useId()
  const controlId = `${id}-control`
  const labelId = `${id}-label`
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ")

  const control = React.Children.count(children) === 1
    ? React.cloneElement(children as React.ReactElement<FieldChildProps>, {
        id: controlId,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(error ? { "aria-invalid": true } : {}),
        ...(composite ? { "aria-labelledby": labelId } : {}),
      })
    : children

  return (
    <div
      data-slot="field"
      className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}
      {...props}
    >
      <label
        id={labelId}
        htmlFor={composite ? undefined : controlId}
        data-slot="field-label"
        className="text-[13px] leading-relaxed font-medium text-foreground"
      >
        {label}
        {required ? (
          <span className="font-normal text-muted-foreground">（必填）</span>
        ) : null}
      </label>
      <div data-slot="field-control" className="min-w-0">
        {control}
      </div>
      {hint ? (
        <p
          id={hintId}
          data-slot="field-description"
          className="text-[13px] leading-relaxed text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          data-slot="field-error"
          className="text-[13px] leading-relaxed text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { Field }
