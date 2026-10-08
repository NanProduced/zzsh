"use client";

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Select } from "@base-ui/react/select";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import { CalendarDays, Check, ChevronDown, Minus, Plus } from "lucide-react";
import "react-day-picker/style.css";
import "./form-controls.css";

// shadcn/ui composition: Base UI Select/Radio and Popover + DayPicker.
// Styles use the portal's existing light/dark tokens; no parallel theme system.
export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={`form-input ${className}`} {...props} />;
}
export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={`form-input ${className}`} {...props} />;
}

export function IntegerStepper({ label, value, onChange, disabled = false, max = "999999999999999999999999", unit, id, invalid = false }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; max?: string; unit?: string; id?: string; invalid?: boolean;
}) {
  const valid = /^(0|[1-9]\d*)$/.test(value), limit = BigInt(max);
  const change = (raw: string) => {
    if(disabled)return;
    if (raw === "") return onChange("");
    if (!/^\d+$/.test(raw) || BigInt(raw) > limit) return;
    onChange(BigInt(raw).toString());
  };
  return <div className="form-integer-stepper">
    <button type="button" aria-label={`减少${label}`} disabled={disabled || !valid || BigInt(value) === 0n || BigInt(value)>limit} onClick={() => change((BigInt(value) - 1n).toString())}><Minus size={16} aria-hidden="true" /></button>
    <Input id={id} inputMode="numeric" pattern="[0-9]*" maxLength={24} aria-label={label} aria-invalid={invalid || undefined} value={value} disabled={disabled} onChange={event => change(event.target.value)} />
    {unit ? <span className="form-integer-unit">{unit}</span> : null}
    <button type="button" aria-label={`增加${label}`} disabled={disabled || (value !== "" && !valid) || (valid && BigInt(value) >= limit)} onClick={() => change((BigInt(value || "0") + 1n).toString())}><Plus size={16} aria-hidden="true" /></button>
  </div>;
}

export type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean };
export function FormSelect({ label, value, options, placeholder = "请选择", disabled = false, hasError = false, onChange, className = "", id, firstField = false }: {
  label: string; value: string; options: SelectOption[]; placeholder?: string; disabled?: boolean; hasError?: boolean;
  onChange: (value: string) => void; className?: string; id?: string; firstField?: boolean;
}) {
  const generatedId = useId();
  const items = options.filter(option => option.value !== "");
  return <Select.Root value={value || null} onValueChange={next => onChange(next ?? "")} disabled={disabled} items={items}>
    <Select.Trigger id={id ?? generatedId} aria-label={label} aria-invalid={hasError || undefined} data-first-field={firstField || undefined} className={`form-select-trigger ${className}`}>
      <Select.Value placeholder={placeholder}>{items.find(option => option.value === value)?.label ?? placeholder}</Select.Value>
      <Select.Icon><ChevronDown size={16} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal><Select.Positioner sideOffset={6} align="start" alignItemWithTrigger={false} className="form-select-positioner">
      <Select.Popup className="form-select-popup"><Select.List>
        {items.map(option => <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="form-select-option">
          <Select.ItemText>{option.label}</Select.ItemText>
          {option.hint ? <small>{option.hint}</small> : null}
          <Select.ItemIndicator className="form-select-check"><Check size={16} /></Select.ItemIndicator>
        </Select.Item>)}
      </Select.List></Select.Popup>
    </Select.Positioner></Select.Portal>
  </Select.Root>;
}

export function FormRadioGroup<T extends string | number | boolean | null>({ name, label, error, value, options, disabled = false, onChange, className = "", variant = "default" }: {
  name: string; label: string; error?: string; value: T; options: { value: T; label: string; icon?: ReactNode; description?: string; badge?: string; disabled?: boolean }[]; disabled?: boolean; onChange: (value: T) => void; className?: string; variant?: "default" | "segmented";
}) {
  const errorId=useId();
  return <RadioGroup name={name} aria-label={label} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? errorId : undefined} tabIndex={error ? -1 : undefined} value={value === null ? null : String(value)} disabled={disabled} onValueChange={next => {
    const option = options.find(item => String(item.value) === next);
    if (option) onChange(option.value);
  }} className={`form-radio-group${variant === "segmented" ? " form-radio-group--segmented" : ""} ${className}`}>
    {options.map(option => <label key={String(option.value)} className={`form-radio-choice${value === option.value ? " is-selected" : ""}`}>
      <Radio.Root value={String(option.value)} disabled={option.disabled} className="form-radio-control"><Radio.Indicator className="form-radio-dot" /></Radio.Root>
      {option.icon ? <span className="form-option-icon" aria-hidden="true">{option.icon}</span> : null}
      <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>
      {variant === "segmented" ? <Check size={14} className="form-segment-check" aria-hidden="true" /> : null}
      {option.badge ? <em className="form-radio-badge">{option.badge}</em> : null}
    </label>)}
    {error ? <span id={errorId} className="supply-field-error" role="alert" style={{gridColumn:"1 / -1"}}>{error}</span> : null}
  </RadioGroup>;
}

export function TimeSelect({ label, value, onChange, disabled = false, allowEndOfDay = false, minuteStep = 1 }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; allowEndOfDay?: boolean; minuteStep?: number;
}) {
  const [hour = "", minute = "00"] = value.split(":");
  const minuteValues = Array.from({ length: Math.ceil(60 / Math.max(1, minuteStep)) }, (_, index) => String(index * Math.max(1, minuteStep)).padStart(2, "0")).filter((entry) => Number(entry) < 60);
  const minuteOptions = minute && !minuteValues.includes(minute) ? [{ value: minute, label: `${minute}（保留）` }, ...minuteValues.map((entry) => ({ value: entry, label: entry }))] : minuteValues.map((entry) => ({ value: entry, label: entry }));
  return <span className="form-time-select" role="group" aria-label={label}>
    <FormSelect label={`${label}小时`} value={hour} disabled={disabled} placeholder="时" options={Array.from({ length: allowEndOfDay ? 25 : 24 }, (_, index) => ({ value: String(index).padStart(2, "0"), label: String(index).padStart(2, "0") }))} onChange={next => onChange(`${next}:${next === "24" ? "00" : minute}`)} />
    <span aria-hidden="true">:</span>
    <FormSelect label={`${label}分钟`} value={value ? minute : ""} disabled={disabled || !hour || hour === "24"} placeholder="分" options={minuteOptions} onChange={next => onChange(`${hour}:${next}`)} />
  </span>;
}

export function DateTimePicker({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [day = "", time = "00:00"] = value.split("T");
  const [year, month, date] = day.split("-").map(Number);
  const selected = day ? new Date(year!, month! - 1, date!, 12) : undefined;
  return <span className="form-datetime-picker">
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="form-select-trigger" disabled={disabled} aria-label={`${label}日期`}>
        <span>{day ? day.replaceAll("-", "/") : "选择日期"}</span><CalendarDays size={16} aria-hidden="true" />
      </button></Popover.Trigger>
      <Popover.Portal><Popover.Content sideOffset={6} align="start" className="form-calendar" aria-label={`${label}日历`}>
        <DayPicker mode="single" locale={zhCN} selected={selected} defaultMonth={selected} autoFocus showOutsideDays onSelect={next => {
          if (!next) return;
          const isoDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
          onChange(`${isoDay}T${time}`); setOpen(false);
        }} />
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <TimeSelect label={`${label}时间`} value={day ? time : ""} disabled={disabled || !day} onChange={next => onChange(`${day}T${next}`)} />
  </span>;
}
