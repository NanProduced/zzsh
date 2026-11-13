"use client";
import { useEffect, useRef } from "react";
import { ListBox } from "@heroui/react/list-box";
import { Select as UiSelect } from "@heroui/react/select";
import { Check } from "lucide-react";
import type { MarketSelectOption } from "./market-filter-types";

export type { MarketSelectOption };

export function MarketSelect({
  label,
  value,
  options,
  placeholder,
  onChange,
  className = "",
  invalid = false,
  describedBy,
  name,
}: {
  label: string;
  value: string | null;
  options: readonly MarketSelectOption[];
  placeholder: string;
  onChange: (value: string | null) => void;
  className?: string;
  invalid?: boolean;
  describedBy?: string;
  name?: string;
}) {
  // HeroUI's trigger forwards aria-describedby but drops aria-invalid, so the real
  // focusable control gets it imperatively; the describedby id already links the alert.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const node = triggerRef.current;
    if (!node) return;
    if (invalid) node.setAttribute("aria-invalid", "true");
    else node.removeAttribute("aria-invalid");
  }, [invalid]);
  return <UiSelect.Root
    className={`market-ui-select ${className}`}
    aria-label={label}
    aria-describedby={describedBy}
    name={name}
    placeholder={placeholder}
    selectedKey={value}
    onSelectionChange={(key) => onChange(key === null ? null : String(key))}
  >
    <UiSelect.Trigger ref={triggerRef} className="market-ui-select-trigger" aria-describedby={describedBy}>
      <UiSelect.Value className="market-ui-select-value" />
      <UiSelect.Indicator className="market-ui-select-indicator" />
    </UiSelect.Trigger>
    <UiSelect.Popover className="market-ui-select-popover" placement="bottom start">
      <ListBox aria-label={`${label}选项`} className="market-ui-select-list">
        {options.map((option) => <ListBox.Item key={option.value} id={option.value} textValue={option.label} className="market-ui-select-option">
          <span>{option.label}</span>
          <ListBox.Item.Indicator className="market-ui-select-option-indicator"><Check size={14} aria-hidden="true" /></ListBox.Item.Indicator>
        </ListBox.Item>)}
      </ListBox>
    </UiSelect.Popover>
  </UiSelect.Root>;
}
