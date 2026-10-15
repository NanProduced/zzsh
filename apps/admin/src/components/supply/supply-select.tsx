import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { cn } from "../../lib/utils"

export function SupplySelect({ label, value, options, onValueChange, disabled, id, className, ...aria }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return <Select value={value} items={options} disabled={disabled} onValueChange={next => {
    if (typeof next === "string") onValueChange(next);
  }}>
    <SelectTrigger id={id} aria-label={aria["aria-labelledby"] ? undefined : label} aria-labelledby={aria["aria-labelledby"]} aria-describedby={aria["aria-describedby"]} aria-invalid={aria["aria-invalid"] || undefined} className={cn("h-9 w-full min-w-0", className)}>
      <SelectValue>{options.find(option => option.value === value)?.label ?? "当前选项未提供"}</SelectValue>
    </SelectTrigger>
    <SelectContent alignItemWithTrigger={false} align="start">
      {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
