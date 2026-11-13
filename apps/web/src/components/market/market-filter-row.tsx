"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import type { PublicListingFilterField, PublicListingFilterMetadata } from "@/lib/supply-types";

export function field(metadata: PublicListingFilterMetadata, key: string): PublicListingFilterField | undefined {
  return metadata.fields.find((entry) => entry.key === key && entry.enabled);
}

export function useInlinePicker(): boolean {
  const [inline, setInline] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 799px)");
    const update = () => setInline(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return inline;
}

export function FilterRow({ label, id, count, className = "", children }: { label: string; id: string; count?: number; className?: string; children: ReactNode }) {
  return <div className={`market-filter-row ${className}`.trim()} role="group" aria-labelledby={`${id}-label`}>
    <span className="market-filter-row-label" id={`${id}-label`}>
      {label}
      {count ? <span className="market-filter-row-count" aria-label={`已选 ${count} 项`}> ({count})</span> : null}
    </span>
    <div className="market-filter-row-options">{children}</div>
  </div>;
}

export function FilterGroup({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: (open: boolean) => void; children: ReactNode }) {
  return <details className="market-filter-group" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
    <summary>
      <span className="market-filter-group-title">{label}</span>
      {count > 0 ? <span className="market-filter-group-count">已选 {count} 项</span> : null}
    </summary>
    <div className="market-filter-group-body">{children}</div>
  </details>;
}

export function MarketChoice({
  type,
  checked,
  indeterminate = false,
  name,
  value,
  className = "",
  onChange,
  children,
}: {
  type: "checkbox" | "radio";
  checked: boolean;
  indeterminate?: boolean;
  name?: string;
  value?: string;
  className?: string;
  onChange: () => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (type === "checkbox" && inputRef.current) inputRef.current.indeterminate = indeterminate; }, [indeterminate, type]);
  return <label className={`market-choice ${className}`} data-selected={checked || indeterminate} data-indeterminate={indeterminate || undefined}>
    <input ref={inputRef} type={type} name={name} value={value} checked={checked} aria-checked={indeterminate ? "mixed" : checked} onChange={onChange} />
    <span className={`market-choice-indicator market-choice-indicator--${type}`} aria-hidden="true">
      {type === "checkbox" ? indeterminate ? <Minus size={12} strokeWidth={2.75} /> : <Check size={12} strokeWidth={2.75} /> : <span />}
    </span>
    <span className="market-choice-label">{children}</span>
  </label>;
}

export function optionGroup(
  entry: PublicListingFilterField | undefined,
  selected: string[],
  onToggle: (value: string) => void,
  idPrefix: string,
) {
  if (!entry?.options?.length) return null;
  return <FilterRow label={entry.label} id={`${idPrefix}-filter-${entry.key}`}>
    {entry.options.map((option) => {
      const checked = selected.includes(option.value);
      return <MarketChoice key={option.value} type="checkbox" className="market-filter-choice" checked={checked} onChange={() => onToggle(option.value)}>{option.label}</MarketChoice>;
    })}
  </FilterRow>;
}
