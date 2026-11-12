// Source: https://platejs.org/r/media-image-node.json — Plate UI (MIT)
// Adapted: media URLs come from the host; alternative text and caption stay
// with the image node and share the public document renderer's typography.
import { createContext, useContext } from "react";
import { Image as ImageIcon, Pencil } from "lucide-react";
import type { TImageElement } from "platejs";
import { PlateElement, useReadOnly, type PlateElementProps } from "platejs/react";

import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export const PlateImageUrls = createContext<Record<string, string>>({});

export function ImageElement(props: PlateElementProps<TImageElement>) {
  const { editor, element, path } = props;
  const readOnly = useReadOnly();
  const urls = useContext(PlateImageUrls);
  const id = element.imageId ?? element.mediaId;
  const url = typeof id === "string" ? urls[id] : undefined;
  const alt = typeof element.alt === "string" ? element.alt : "";
  const caption = typeof element.caption === "string" ? element.caption : "";

  return (
    <PlateElement {...props} className={cn("py-2.5", props.className)}>
      <figure className="plate-image-figure relative m-0" contentEditable={false}>
        {url ? (
          <img
            src={url}
            alt={alt}
            loading="lazy"
            draggable={false}
            className="block w-full max-w-full rounded-md object-cover px-0"
          />
        ) : (
          <span
            contentEditable={false}
            className="flex min-h-24 w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-4 py-8 text-sm text-muted-foreground"
          >
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
            {alt || "图片不可用"}
          </span>
        )}
        {!readOnly ? (
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button type="button" size="sm" variant="secondary" className="plate-image-edit" aria-label="编辑图片说明">
                    <Pencil size={14} aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>编辑图片说明</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="grid gap-2.5 text-xs">
              <label className="grid gap-1">
                <span>替代文字</span>
                <Input value={alt} maxLength={500} onChange={(event) => editor.tf.setNodes({ alt: event.target.value }, { at: path })} />
              </label>
              <label className="grid gap-1">
                <span>图注</span>
                <Input value={caption} maxLength={500} onChange={(event) => editor.tf.setNodes({ caption: event.target.value }, { at: path })} />
              </label>
            </PopoverContent>
          </Popover>
        ) : null}
        {caption ? <figcaption className="plate-image-caption">{caption}</figcaption> : null}
      </figure>
      {props.children}
    </PlateElement>
  );
}
