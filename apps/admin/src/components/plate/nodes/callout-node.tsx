// Source: https://platejs.org/r/callout-node.json — Plate UI (MIT)
// Adapted: removed the emoji picker (needs @platejs/emoji, not installed) and
// the persisted icon/backgroundColor attributes. The storage contract only
// allows variant info|warning, so the icon and tint are mapped at render time
// (shared .plate-callout[data-variant] rules in @zzsh/ui/plate-document.css).
import { Info, TriangleAlert } from "lucide-react";
import { PlateElement, type PlateElementProps } from "platejs/react";

import { cn } from "@/lib/utils";

export function CalloutElement({ className, ...props }: PlateElementProps) {
  const variant = props.element.variant === "warning" ? "warning" : "info";
  const Icon = variant === "warning" ? TriangleAlert : Info;

  return (
    <PlateElement
      {...props}
      className={cn("plate-callout my-1 flex items-start gap-2.5", className)}
      attributes={{ ...props.attributes, "data-variant": variant, role: "note" }}
    >
      <span
        contentEditable={false}
        aria-hidden="true"
        className={cn(
          "mt-1 flex size-5 shrink-0 select-none items-center justify-center",
          variant === "warning" ? "text-(--plate-orange)" : "text-(--plate-blue)"
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="w-full min-w-0">{props.children}</div>
    </PlateElement>
  );
}