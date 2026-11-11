// Source: https://platejs.org/r/toc-node.json — Plate UI (MIT)
// Adapted: only h2/h3 are listed (matches extractPlate's stored toc); depth is
// remapped so h2 is the base level. Replaced useTocElement's onClick — it calls
// editor.tf.navigation.flashTarget which the installed platejs lacks — with
// scrollIntoView + select/focus. Empty state kept in Chinese.
import { cva } from "class-variance-authority";
import { NodeApi } from "platejs";
import { PlateElement, useEditorRef, type PlateElementProps } from "platejs/react";
import { useTocElementState } from "@platejs/toc/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const headingItemVariants = cva(
  "block h-auto w-full cursor-pointer truncate rounded-md px-2 py-1.5 text-left font-medium underline decoration-[0.5px] underline-offset-4 transition-colors",
  {
    variants: {
      active: {
        false: "text-muted-foreground hover:bg-accent hover:text-foreground",
        true: "bg-accent text-foreground decoration-foreground",
      },
      depth: {
        1: "pl-2",
        2: "pl-6",
      },
    },
    defaultVariants: { active: false, depth: 1 },
  }
);

export function TocElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const { activeContentId, headingList } = useTocElementState();
  const items = headingList.filter((item) => item.depth === 2 || item.depth === 3);

  return (
    <PlateElement {...props} className={cn("mb-1 rounded-md border border-border bg-muted/30 p-3", props.className)}>
      <nav contentEditable={false} aria-label="目录" className="flex flex-col gap-0.5">
        {items.length === 0 ? (
          <span className="px-2 py-1.5 text-sm text-muted-foreground">暂无标题</span>
        ) : (
          items.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              className={headingItemVariants({
                active: item.id === activeContentId,
                depth: (item.depth - 1) as 1 | 2,
              })}
              aria-current={item.id === activeContentId ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                const node = NodeApi.get(editor, item.path);
                if (!node) return;
                const el = editor.api.toDOMNode(node);
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
                editor.tf.select(editor.api.start(item.path));
                editor.tf.focus();
              }}
            >
              {item.title}
            </Button>
          ))
        )}
      </nav>
      {props.children}
    </PlateElement>
  );
}