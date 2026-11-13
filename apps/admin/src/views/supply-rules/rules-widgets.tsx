import type { ComponentProps, ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { SupplySelect } from "../../components/supply/supply-select";

export const inputClass = "h-9";

type RulesOption = { value: string; label: string };

export function RulesSelect({ label, value, onChange, options, placeholder = "请选择", disabled, ...aria }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: RulesOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <SupplySelect label={label} value={value} onValueChange={onChange} options={value === "" ? [{ value: "", label: options.length ? placeholder : "暂无可选项" }, ...options] : options} disabled={disabled || options.length === 0} id={aria.id} aria-labelledby={aria["aria-labelledby"]} aria-describedby={aria["aria-describedby"]} aria-invalid={aria["aria-invalid"]} />
  );
}

// ui/button 没有 loading：在途时显式禁用 + aria-busy + 在途文案
export function BusyButton({ busy = false, busyText = "处理中…", disabled, children, ...props }: Omit<ComponentProps<typeof Button>, "children"> & { busy?: boolean; busyText?: string; children: ReactNode }) {
  return <Button {...props} disabled={Boolean(disabled) || busy} aria-busy={busy || undefined}>{busy ? busyText : children}</Button>;
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">{children}</p>;
}
