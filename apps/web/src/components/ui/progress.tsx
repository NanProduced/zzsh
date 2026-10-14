"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

// shadcn Base UI composition, styled by the consuming surface's theme.
export function Progress({ className, ...props }: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root {...props} className={className} data-slot="progress">
      <ProgressPrimitive.Track data-slot="progress-track">
        <ProgressPrimitive.Indicator data-slot="progress-indicator" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}
