import * as React from "react";
import { SearchIcon, XIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface ListToolbarProps extends React.ComponentPropsWithoutRef<"form"> {
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  onReset?: () => void;
  children?: React.ReactNode;
}

export function ListToolbar({
  className,
  onSubmit,
  onReset,
  children,
  ...props
}: ListToolbarProps) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit?.(e);
  };

  const handleReset = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onReset?.();
  };

  return (
    <form
      data-slot="admin-list-toolbar"
      className={cn("admin-list-toolbar", className)}
      onSubmit={handleSubmit}
      onReset={handleReset}
      {...props}
    >
      {children}
    </form>
  );
}

export interface ListToolbarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}

export function ListToolbarSearch({
  value,
  onChange,
  placeholder = "搜索...",
  ariaLabel = "搜索",
  className,
  disabled = false,
}: ListToolbarSearchProps) {
  return (
    <div className={cn("admin-list-toolbar-search", className)}>
      <SearchIcon size={16} aria-hidden />
      <span className="sr-only">{ariaLabel}</span>
      <Input
        type="search"
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-full min-w-[200px] text-xs"
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute right-1.5 h-6 w-6 text-muted-foreground hover:text-foreground"
          aria-label="清空搜索内容"
          onClick={() => onChange("")}
        >
          <XIcon size={12} />
        </Button>
      ) : null}
    </div>
  );
}

export interface ListToolbarEnumSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  allLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function ListToolbarEnumSelect({
  label,
  value,
  onChange,
  options,
  allLabel = "全部",
  disabled = false,
  className,
}: ListToolbarEnumSelectProps) {
  const items = [
    { value: "all", label: allLabel },
    ...options.map(([k, name]) => ({ value: k, label: name })),
  ];

  return (
    <Field label={label} composite className={cn("ud-field", className)}>
      <Select
        value={value || "all"}
        onValueChange={(v) => onChange(v === "all" ? "" : String(v))}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger aria-label={label} className="h-9 w-full min-w-[120px] text-xs cursor-pointer">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="min-w-[var(--anchor-width)]">
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map(([key, name]) => (
            <SelectItem key={key} value={key}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export interface ListToolbarAppliedFilter {
  key: string;
  label: string;
  onRemove: () => void;
}

export interface ListToolbarAppliedProps {
  filters: ListToolbarAppliedFilter[];
  className?: string;
}

export function ListToolbarApplied({
  filters,
  className,
}: ListToolbarAppliedProps) {
  if (!filters.length) return null;

  return (
    <div
      data-slot="admin-list-toolbar-applied"
      className={cn("admin-list-toolbar-applied", className)}
      aria-label="已用筛选"
    >
      <span>已用筛选</span>
      {filters.map(({ key, label, onRemove }) => (
        <Button
          key={key}
          type="button"
          variant="outline"
          aria-label={`移除${label}筛选`}
          onClick={onRemove}
          className="h-7 text-xs"
        >
          <span className="ud-filter-label">{label}</span>
          <XIcon size={12} className="ml-1" />
        </Button>
      ))}
    </div>
  );
}

export interface ListToolbarActionsProps {
  children?: React.ReactNode;
  className?: string;
}

export function ListToolbarActions({ children, className }: ListToolbarActionsProps) {
  return (
    <div className={cn("admin-list-toolbar-actions", className)}>
      {children}
    </div>
  );
}
