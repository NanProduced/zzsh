// Source: https://platejs.org/r/block-list.json — Plate UI (MIT)
// Adapted: the registry version only wraps ordered/todo lists and relies on
// list-base-kit's display:list-item injection + IndentPlugin for disc bullets
// and indent margins. This editor installs neither, so this wrapper handles
// all three stored list types (disc/decimal/todo) and maps indent 1..3 to
// 0/24/48px marginLeft itself. Todo checkbox uses the admin Base UI Checkbox.
import type { TListElement } from "platejs";
import { isOrderedList } from "@platejs/list";
import { useTodoListElement, useTodoListElementState } from "@platejs/list/react";
import { PlateElement, useReadOnly, type PlateElementProps, type RenderNodeWrapper } from "platejs/react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export const BlockList: RenderNodeWrapper = (props) => {
  if (!props.element.listStyleType) return;
  return (inner) => <List {...inner} />;
};

function List(props: PlateElementProps) {
  const { listStart, listStyleType, indent, checked } = props.element as TListElement;
  const marginLeft = ((indent ?? 1) - 1) * 24;

  if (listStyleType === "todo") {
    return (
      <ul className="relative m-0 list-none p-0" style={{ marginLeft }}>
        <TodoMarker {...props} />
        <li className={cn("list-none", checked && "text-muted-foreground line-through")}>{props.children}</li>
      </ul>
    );
  }

  if (isOrderedList(props.element)) {
    return (
      <ol className="relative m-0 pl-6" style={{ listStyleType, marginLeft }} start={listStart}>
        <li>{props.children}</li>
      </ol>
    );
  }

  return (
    <ul className="relative m-0 pl-6" style={{ listStyleType, marginLeft }}>
      <li>{props.children}</li>
    </ul>
  );
}

function TodoMarker(props: PlateElementProps) {
  const state = useTodoListElementState({ element: props.element });
  const { checkboxProps } = useTodoListElement(state);
  const readOnly = useReadOnly();

  return (
    <div contentEditable={false}>
      <Checkbox className={cn("absolute left-0 top-1.5", readOnly && "pointer-events-none")} {...checkboxProps} />
    </div>
  );
}