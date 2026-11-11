// Source: https://platejs.org/r/table-node.json — Plate UI (MIT)
// Adapted: removed column/row resize, floating toolbar, borders dropdown,
// cell background colors, merge/split and row drag handles — they need Radix
// primitives and persist attributes (colSizes/rowSizes/background/borders)
// outside the storage whitelist. Kept the scroll wrapper, native cell
// selection highlight (useTableSelectionDom) and header/cell styling.
// `!` suffixes win over the unlayered shared table rules in plate-document.css.
import { useRef } from "react";

import type { TTableCellElement, TTableElement, TTableRowElement } from "platejs";
import { PlateElement, withHOC, type PlateElementProps } from "platejs/react";
import { TableProvider, useTableElement, useTableSelectionDom } from "@platejs/table/react";

import { cn } from "@/lib/utils";

export const TableElement = withHOC(TableProvider, function TableElement(props: PlateElementProps<TTableElement>) {
  const tableRef = useRef<HTMLTableElement>(null);
  useTableSelectionDom(tableRef);
  const { props: tableProps } = useTableElement();

  return (
    <PlateElement
      {...props}
      className={cn("plate-table-scroll overflow-x-auto py-1", props.className)}
      attributes={{ ...props.attributes, role: "region", tabIndex: 0, "aria-label": "表格" }}
    >
      <table ref={tableRef} {...tableProps} className="w-full border-collapse">
        <tbody>{props.children}</tbody>
      </table>
    </PlateElement>
  );
});

export function TableRowElement(props: PlateElementProps<TTableRowElement>) {
  return <PlateElement {...props} as="tr" />;
}

export function TableCellElement({
  isHeader,
  ...props
}: PlateElementProps<TTableCellElement> & { isHeader?: boolean }) {
  return (
    <PlateElement
      {...props}
      as={isHeader ? "th" : "td"}
      className={cn(
        "relative h-full border-border! px-3! py-2! align-top",
        isHeader ? "bg-muted/60! text-left font-semibold" : "bg-background",
        "data-[table-cell-selected=true]:bg-accent/40!"
      )}
      attributes={{ ...props.attributes, "data-table-cell-id": props.element.id }}
    >
      {props.children}
    </PlateElement>
  );
}

export function TableCellHeaderElement(props: PlateElementProps<TTableCellElement>) {
  return <TableCellElement {...props} isHeader />;
}