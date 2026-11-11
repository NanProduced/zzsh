// Source: https://platejs.org/r/paragraph-node.json — Plate UI (MIT)
// Kept as a div (registry default): ListPlugin's belowNodes wrapper renders
// ul/li inside the paragraph element, which a <p> tag cannot legally contain.
import { PlateElement, type PlateElementProps } from "platejs/react";

import { cn } from "@/lib/utils";

export function ParagraphElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} className={cn("m-0 px-0 py-1", props.className)}>
      {props.children}
    </PlateElement>
  );
}