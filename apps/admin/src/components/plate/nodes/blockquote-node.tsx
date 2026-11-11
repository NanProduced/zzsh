// Source: https://platejs.org/r/blockquote-node.json — Plate UI (MIT)
// Adapted: muted token border color; `!` suffixes win over the unlayered
// shared blockquote rules in @zzsh/ui/plate-document.css.
import { PlateElement, type PlateElementProps } from "platejs/react";

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="blockquote"
      className="my-1 border-l-2! border-muted-foreground/40! pl-6! italic"
      {...props}
    />
  );
}