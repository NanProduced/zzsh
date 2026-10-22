import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "@/components/ui/table";

export interface ListTableProps extends React.ComponentPropsWithoutRef<"div"> {
  loading?: boolean;
  empty?: React.ReactNode;
  error?: React.ReactNode;
  children?: React.ReactNode;
}

export function ListTable({
  className,
  loading = false,
  empty,
  error,
  children,
  ...props
}: ListTableProps) {
  return (
    <div
      data-slot="admin-list-table-container"
      className={cn("admin-list-table-wrap", className)}
      aria-busy={loading}
      {...props}
    >
      {error ? (
        <div className="p-4">{error}</div>
      ) : empty ? (
        <div className="p-4">{empty}</div>
      ) : (
        children
      )}
    </div>
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
