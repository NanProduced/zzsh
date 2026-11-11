// Source: https://platejs.org/r/toggle-node.json — Plate UI (MIT)
// Adapted: the registry toggle hides *indented sibling* blocks via the plugin
// openIds store, but our storage contract keeps toggle content as children.
// Kept the registry caret button visuals and render the first child as the
// title, remaining children in an animated collapsible body (local open state,
// default open — never persisted).
import { Children, useState } from "react";

import { ChevronRight } from "lucide-react";
import { PlateElement, type PlateElementProps } from "platejs/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ToggleElement(props: PlateElementProps) {
  const [open, setOpen] = useState(true);
  const [title, ...body] = Children.toArray(props.children);

  return (
    <PlateElement {...props} className={cn("relative pl-6", props.className)}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute -left-0.5 top-0 size-6 cursor-pointer select-none items-center justify-center rounded-md p-px text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-4"
        contentEditable={false}
        aria-expanded={open}
        aria-label={open ? "折叠" : "展开"}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={cn("transition-transform duration-150", open && "rotate-90")} aria-hidden="true" />
      </Button>
      <div className="font-medium">{title}</div>
      {body.length > 0 && (
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="overflow-hidden">{body}</div>
        </div>
      )}
    </PlateElement>
  );
}