"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  resourceInputFromBase,
  resourceItemDisplayName,
  resourceUnitHint,
  resourceUnitShort,
  validateResourceQuantityInput,
  type ResourceInputMode,
} from "@/lib/listing-filters";
import type { PublicListingFilterMetadata } from "@/lib/supply-types";
import { FilterRow, field } from "./market-filter-row";
import type { MarketFilterControlsProps, ResourceRange } from "./market-filter-types";

export type { ResourceRange };

export function ResourceQuantityInput({ item, bounds, committed, rangeSupported, onCommit, gameCode, showLabel = true, resetToken = 0, flushDrafts }: {
  item: PublicListingFilterMetadata["items"][number];
  bounds: { min: string; max: string };
  committed: ResourceRange | null;
  rangeSupported: boolean;
  onCommit: (value: ResourceRange | null) => void;
  gameCode?: string;
  showLabel?: boolean;
  resetToken?: number;
  flushDrafts?: (fn: () => boolean) => () => void;
}) {
  const id = useId();
  const committedValues = [committed?.minQuantity, committed?.maxQuantity].filter((value): value is string => value !== undefined);
  const mode: ResourceInputMode = committedValues.some((value) => !/^(0|[1-9]\d*)$/.test(resourceInputFromBase(value, item) ?? "")) ? "base" : "display";
  const display = (value: string | undefined) => value === undefined ? "" : resourceInputFromBase(value, item, mode) ?? value;
  const [minDraft, setMinDraft] = useState(() => display(committed?.minQuantity));
  const [maxDraft, setMaxDraft] = useState(() => display(committed?.maxQuantity));
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorId = `${id}-quantity-error`;
  const unit = resourceUnitShort(item, mode);
  const unitHint = resourceUnitHint(item, mode);
  const hintId = `${id}-quantity-hint`;
  const describedBy = [unitHint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setMinDraft(display(committed?.minQuantity));
    setMaxDraft(display(committed?.maxQuantity));
    setError(null);
    // resetToken lets 清空筛选 drop an invalid or uncommitted draft even when the committed value never changed.
  }, [committed?.minQuantity, committed?.maxQuantity, item.code, item.unit, mode, resetToken]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const apply = (minimum: string, maximum: string): string | null => {
    if (minimum === "" && maximum === "") {
      setError(null);
      if (committed) onCommit(null);
      return null;
    }
    try {
      const minQuantity = minimum === "" ? undefined : validateResourceQuantityInput(minimum, item, bounds, mode);
      const maxQuantity = !rangeSupported || maximum === "" ? undefined : validateResourceQuantityInput(maximum, item, bounds, mode);
      if (minQuantity !== undefined && maxQuantity !== undefined && BigInt(minQuantity) > BigInt(maxQuantity)) throw new Error("下限不能大于上限。");
      setError(null);
      const next = { ...(minQuantity === undefined ? {} : { minQuantity }), ...(maxQuantity === undefined ? {} : { maxQuantity }) };
      if (next.minQuantity !== committed?.minQuantity || next.maxQuantity !== committed?.maxQuantity) onCommit(next);
      return null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "数量格式无效。";
      setError(message);
      return message;
    }
  };

  const applyRef = useRef(apply);
  useEffect(() => { applyRef.current = apply; });
  const draftsRef = useRef<[string, string]>([minDraft, maxDraft]);
  draftsRef.current = [minDraft, maxDraft];
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;
  useEffect(() => {
    if (!flushDrafts) return;
    return flushDrafts(() => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
        return applyRef.current(draftsRef.current[0], draftsRef.current[1]) === null;
      }
      // A draft that already surfaced its error must not be dropped silently on 查看结果.
      return errorRef.current === null;
    });
  }, [flushDrafts]);
  const change = (minimum: string, maximum: string) => {
    setMinDraft(minimum);
    setMaxDraft(maximum);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; applyRef.current(minimum, maximum); }, 350);
  };
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    apply(minDraft, maxDraft);
  };

  const displayName = resourceItemDisplayName(item, { gameCode });
  const hint = unitHint ? <small className="market-resource-hint" id={hintId}>{unitHint}</small> : null;
  return <div className="market-resource-quantity">
    {showLabel ? <span className="market-resource-name"><span className="market-resource-label">{displayName}</span>{hint}</span> : null}
    <div className="market-resource-range" title={unitHint ?? undefined}>
      <input type="text" inputMode="numeric" value={minDraft} maxLength={32} placeholder="最低"
        aria-label={`${displayName}数量下限（${unit}）`} aria-invalid={Boolean(error)} aria-describedby={describedBy}
        onChange={(event) => change(event.target.value, maxDraft)} onBlur={flush} />
      {rangeSupported ? <>
        <span className="market-range-separator" aria-hidden="true">–</span>
        <input type="text" inputMode="numeric" value={maxDraft} maxLength={32} placeholder="最高"
          aria-label={`${displayName}数量上限（${unit}）`} aria-invalid={Boolean(error)} aria-describedby={describedBy}
          onChange={(event) => change(minDraft, event.target.value)} onBlur={flush} />
      </> : null}
      <span className="market-resource-unit">{unit}</span>
    </div>
    {showLabel ? null : hint}
    {error ? <small className="market-inline-error" id={errorId} role="alert">{error}</small> : null}
  </div>;
}

export function HaffFilter({ item, bounds, current, rangeSupported, gameCode, onChange, resetToken = 0, flushDrafts }: {
  item: PublicListingFilterMetadata["items"][number];
  bounds: { min: string; max: string };
  current: ResourceRange | undefined;
  rangeSupported: boolean;
  gameCode?: string;
  onChange: (value: ResourceRange | null) => void;
  resetToken?: number;
  flushDrafts?: (fn: () => boolean) => () => void;
}) {
  const id = useId();
  const options = [
    { value: "", label: "不限" },
    { value: "100000000", label: "≥100M" },
    { value: "500000000", label: "≥500M" },
    { value: "1000000000", label: "≥1000M" },
  ];
  const currentMin = current?.minQuantity;
  if (currentMin !== undefined && !current?.maxQuantity && !options.some((option) => option.value === currentMin)) {
    const display = resourceInputFromBase(currentMin, item);
    options.push({ value: currentMin, label: display === null ? `≥${currentMin} 基础单位` : `≥${display} M` });
  }
  const selected = current?.maxQuantity ? null : currentMin ?? "";
  return <FilterRow label={resourceItemDisplayName(item, { gameCode })} id={id}>
    <div className="market-haff-filter">
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="market-haff-presets-row">
        {options.map(({ value, label }) => {
          const isSelected = selected === value;
          return (
            <button
              key={value}
              type="button"
              className="market-haff-preset-pill"
              data-selected={isSelected}
              aria-pressed={isSelected}
              onClick={() => onChange(value ? { minQuantity: value } : null)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <ResourceQuantityInput item={item} bounds={bounds} committed={current ?? null} rangeSupported={rangeSupported} onCommit={onChange} gameCode={gameCode} showLabel={false} resetToken={resetToken} flushDrafts={flushDrafts} />
    </div>
  </FilterRow>;
}

export function ResourceFilters({ filters, metadata, haffId, gameCode, onCommit, resetToken = 0, flushDrafts }: Pick<MarketFilterControlsProps, "filters" | "metadata" | "gameCode"> & {
  haffId: string | undefined;
  onCommit: (itemId: string, quantity: ResourceRange | null) => void;
  resetToken?: number;
  flushDrafts?: (fn: () => boolean) => () => void;
}) {
  const id = useId();
  const rule = field(metadata, "resources");
  const resources = filters.filters.resources ?? [];
  const selectedCount = resources.filter((entry) => entry.itemId !== haffId).length;
  if (!rule) return null;
  const availableItems = (rule.items ?? []).flatMap((ruleItem) => {
    const item = metadata.items.find((entry) => entry.id === ruleItem.itemId);
    return item && item.id !== haffId ? [{ ruleItem, item }] : [];
  });
  return <FilterRow label={rule.label} id={id} count={selectedCount || undefined} className="market-filter-row--resource">
    <div className="market-resource-grid">
      {availableItems.map(({ ruleItem, item }) => {
        return <ResourceQuantityInput key={item.id} item={item} bounds={ruleItem}
          committed={resources.find((entry) => entry.itemId === item.id) ?? null}
          rangeSupported={metadata.resourceQuantityRange === true}
          gameCode={gameCode}
          resetToken={resetToken}
          flushDrafts={flushDrafts}
          onCommit={(quantity) => onCommit(item.id, quantity)} />;
      })}
    </div>
  </FilterRow>;
}
