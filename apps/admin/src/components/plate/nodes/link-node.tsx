// Source: https://platejs.org/r/link-node.json — Plate UI (MIT)
// Adapted: dropped inlineSuggestionVariants (suggestion plugin not installed).
// Kept local href handling instead of getLinkAttributes: the storage contract
// also allows relative ("/…") and internal "doc:" URLs which the default
// scheme sanitizer would strip.
import type { TLinkElement } from "platejs";
import { PlateElement, type PlateElementProps } from "platejs/react";

import { cn } from "@/lib/utils";

export function LinkElement(props: PlateElementProps<TLinkElement>) {
  const url = typeof props.element.url === "string" ? props.element.url : "";
  const external = /^https?:\/\//.test(url);

  return (
    <PlateElement
      {...props}
      as="a"
      className={cn(
        "font-medium text-primary underline decoration-primary/50 underline-offset-4 outline-none transition-colors hover:decoration-primary focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50",
        props.className
      )}
      attributes={{
        ...props.attributes,
        href: url,
        ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}),
      }}
    >
      {props.children}
    </PlateElement>
  );
}