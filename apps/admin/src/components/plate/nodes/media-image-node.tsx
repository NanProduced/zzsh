// Source: https://platejs.org/r/media-image-node.json — Plate UI (MIT)
// Adapted: removed @platejs/resizable, MediaToolbar (floating shell) and
// caption textarea — caption/width/align are not in the storage whitelist.
// Kept figure layout, rounded image, focus/selection ring and a dashed
// placeholder when the runtime-injected url is missing.
import { Image as ImageIcon } from "lucide-react";
import type { TImageElement } from "platejs";
import { PlateElement, useFocused, useReadOnly, useSelected, type PlateElementProps } from "platejs/react";

import { cn } from "@/lib/utils";

export function ImageElement(props: PlateElementProps<TImageElement>) {
  const selected = useSelected();
  const focused = useFocused();
  const readOnly = useReadOnly();
  const url = typeof props.element.url === "string" ? props.element.url : "";
  const alt = typeof props.element.alt === "string" ? props.element.alt : "";

  return (
    <PlateElement {...props} className={cn("py-2.5", props.className)}>
      <figure className="group relative m-0" contentEditable={false}>
        {url ? (
          <img
            src={url}
            alt={alt}
            loading="lazy"
            draggable={false}
            className={cn(
              "block w-full max-w-full rounded-md object-cover px-0",
              !readOnly && "cursor-pointer",
              focused && selected && "ring-2 ring-ring ring-offset-2 ring-offset-background"
            )}
          />
        ) : (
          <span
            contentEditable={false}
            className={cn(
              "flex min-h-24 w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-4 py-8 text-sm text-muted-foreground",
              focused && selected && "ring-2 ring-ring ring-offset-2 ring-offset-background"
            )}
          >
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
            {alt || "图片不可用"}
          </span>
        )}
      </figure>
      {props.children}
    </PlateElement>
  );
}