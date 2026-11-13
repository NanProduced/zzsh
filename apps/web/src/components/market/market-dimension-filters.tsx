"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, MapPin, Search, X } from "lucide-react";
import {
  buildServiceWindow,
  formatServiceWindowMinute,
  regionProvinceSelectionState,
  SERVICE_WINDOW_END_OPTIONS,
  SERVICE_WINDOW_START_OPTIONS,
  type ListingFilters,
} from "@/lib/listing-filters";
import type { PublicListingFilterField, PublicListingFilterMetadata } from "@/lib/supply-types";
import { FilterRow, MarketChoice, useInlinePicker } from "./market-filter-row";
import { MarketSelect } from "./market-select";
import type { MarketFilterControlsProps } from "./market-filter-types";

export function LevelFilter({
  entry,
  current,
  name,
  idPrefix,
  onChange,
  mobile = false,
}: {
  entry: PublicListingFilterField;
  current: number | undefined;
  name: string;
  idPrefix: string;
  onChange: (value: number | null) => void;
  mobile?: boolean;
}) {
  const values = entry.levels ?? [];
  if (!values.length) return null;
  const isAll = current === undefined;

  const content = (
    <div className={mobile ? "market-mobile-choice-grid--levels" : "market-filter-row-options"} role="radiogroup" aria-label={entry.label}>
      <button
        type="button"
        className={mobile ? "market-mobile-preset-pill" : "market-level-choice"}
        data-selected={isAll ? "true" : undefined}
        aria-pressed={isAll}
        onClick={() => onChange(null)}
      >
        不限
      </button>
      {values.map((value) => {
        const isSelected = current === value;
        return (
          <button
            key={value}
            type="button"
            className={mobile ? "market-mobile-preset-pill" : "market-level-choice"}
            data-selected={isSelected ? "true" : undefined}
            aria-pressed={isSelected}
            onClick={() => onChange(isSelected ? null : value)}
          >
            ≥{value}
          </button>
        );
      })}
    </div>
  );

  if (mobile) return content;

  return (
    <FilterRow label={entry.label} id={`${idPrefix}-filter-${entry.key}`}>
      {content}
    </FilterRow>
  );
}

export function GradeFilter({ entry, selected, onToggle, onClear }: {
  entry: PublicListingFilterField | undefined;
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const id = useId();
  if (!entry?.options?.length) return null;
  return <FilterRow label={entry.label} id={id}>
    <Popover.Root>
      <Popover.Trigger className="market-picker-trigger" aria-label={`${entry.label}：${selected.length ? `已选 ${selected.length} 项` : "不限（可多选）"}`}>
        <span>{selected.length ? entry.options.filter((option) => selected.includes(option.value)).map((option) => option.label).join("、") : "不限（可多选）"}</span><ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Content className="market-grade-panel" align="start" sideOffset={6} collisionPadding={12} aria-label="选择段位">
        <button type="button" className="market-filter-chip" onClick={onClear}>不限</button>
        {entry.options.map((option) => <MarketChoice key={option.value} type="checkbox" className="market-grade-option" checked={selected.includes(option.value)} onChange={() => onToggle(option.value)}>{option.label}</MarketChoice>)}
      </Popover.Content>
    </Popover.Root>
  </FilterRow>;
}

export function RegionFilter({
  label,
  availableRegions,
  selectedRegions,
  onToggle,
  onToggleProvince,
  onClear,
  resetToken = 0,
}: {
  label: string;
  availableRegions: Array<{ province: string; city: string }>;
  selectedRegions: Array<{ province: string; city: string }>;
  onToggle: (province: string, city: string) => string | null;
  onToggleProvince: (province: string) => string | null;
  onClear: () => void;
  resetToken?: number;
}) {
  const id = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeProvince, setActiveProvince] = useState(() => selectedRegions[0]?.province ?? "");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const inlineMode = useInlinePicker();
  const provinces = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const region of availableRegions) {
      const cities = grouped.get(region.province) ?? [];
      if (!cities.includes(region.city)) cities.push(region.city);
      grouped.set(region.province, cities);
    }
    return [...grouped].map(([province, cities]) => ({ province, cities }));
  }, [availableRegions]);
  const query = search.normalize("NFKC").trim().toLocaleLowerCase();
  const visibleProvinces = provinces.filter(({ province, cities }) =>
    !query || province.toLocaleLowerCase().includes(query) || cities.some((city) => city.toLocaleLowerCase().includes(query)),
  );
  const currentProvince = visibleProvinces.find(({ province }) => province === activeProvince) ?? visibleProvinces[0] ?? null;
  const provinceMatchesQuery = Boolean(query && currentProvince?.province.toLocaleLowerCase().includes(query));
  const visibleCities = currentProvince?.cities.filter((city) => !query || provinceMatchesQuery || city.toLocaleLowerCase().includes(query)) ?? [];
  const selectedCount = selectedRegions.length;
  const panelId = `${id}-panel`;

  useEffect(() => {
    setOpen(false);
  }, [inlineMode]);

  useEffect(() => {
    setSelectionError(null);
  }, [resetToken]);

  const panel = <div className="market-region-panel">
    <label className="market-region-search">
      <span className="sr-only">搜索省份或城市</span>
      <Search size={15} aria-hidden="true" />
      <input ref={searchRef} type="search" value={search} maxLength={60} placeholder="搜索省份或城市" onChange={(event) => setSearch(event.target.value)} />
    </label>
    {visibleProvinces.length ? <div className="market-region-columns">
      <div className="market-region-provinces" role="tablist" aria-label="选择省份">
        {visibleProvinces.map(({ province, cities }) => {
          const state = regionProvinceSelectionState(selectedRegions, province, cities);
          const count = selectedRegions.filter((r) => r.province === province).length;
          const isActive = currentProvince?.province === province;
          return <button
            key={province}
            type="button"
            role="tab"
            aria-selected={isActive}
            className="market-region-province-item"
            data-active={isActive}
            onClick={() => setActiveProvince(province)}
          >
            <span className="market-region-province-name">{province}</span>
            {count > 0 ? <span className="market-region-province-badge" data-all={state === "all"}>{state === "all" ? "全选" : count}</span> : null}
          </button>;
        })}
      </div>
      <fieldset className="market-region-cities" id={`${id}-cities`}>
        <legend className="market-region-cities-header">
          <span className="market-region-cities-title">{currentProvince?.province}<small>（可选 {currentProvince?.cities.length ?? 0} 城）</small></span>
          {currentProvince ? <button
            type="button"
            className="market-region-select-all-btn"
            data-selected={regionProvinceSelectionState(selectedRegions, currentProvince.province, currentProvince.cities) === "all"}
            onClick={() => setSelectionError(onToggleProvince(currentProvince.province))}
          >
            {regionProvinceSelectionState(selectedRegions, currentProvince.province, currentProvince.cities) === "all" ? "取消全选" : "全选本省"}
          </button> : null}
        </legend>
        <div className="market-region-cities-grid">
          {visibleCities.map((city) => {
            const checked = selectedRegions.some((region) => region.province === currentProvince?.province && region.city === city);
            return <MarketChoice key={`${currentProvince?.province}-${city}`} type="checkbox" className="market-region-city" checked={checked} onChange={() => { if (currentProvince) setSelectionError(onToggle(currentProvince.province, city)); }}>{city}</MarketChoice>;
          })}
        </div>
        {visibleCities.length === 0 && <p className="market-region-empty" role="status">没有匹配的城市</p>}
      </fieldset>
    </div> : <p className="market-region-empty" role="status">没有匹配的省份或城市</p>}
    <p className="market-region-summary">{selectedCount ? `已选 ${selectedCount} 个城市` : "尚未选择城市"}</p>
    {selectionError ? <p className="market-inline-error market-region-error" role="alert">{selectionError}</p> : null}
  </div>;

  const trigger = <button ref={triggerRef} type="button" className="market-picker-trigger market-region-trigger" aria-label={`${label}：${selectedCount ? `已选 ${selectedCount} 个城市` : "选择地区"}`} aria-controls={panelId} aria-expanded={open} onClick={() => { if (inlineMode) setOpen((value) => !value); }}>
    <MapPin size={15} aria-hidden="true" />
    <span>{selectedCount ? `已选 ${selectedCount} 个城市` : "选择地区"}</span>
    <ChevronDown size={14} aria-hidden="true" />
  </button>;

  return <div className="market-filter-row market-region-filter" role="group" aria-labelledby={`${id}-label`}>
    <span className="market-filter-row-label" id={`${id}-label`}>{label}</span>
    <div className="market-filter-row-options">
      <button type="button" className="market-choice market-filter-choice market-choice--default market-region-all" aria-pressed={selectedCount === 0} data-selected={selectedCount === 0} onClick={() => { setSelectionError(null); onClear(); }}>全部</button>
      {inlineMode ? trigger : <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content id={panelId} className="market-region-popover" side="bottom" align="start" sideOffset={8} collisionPadding={12} aria-label={`${label}选择`} onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}>
            {panel}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>}
      {inlineMode && open ? <div id={panelId} className="market-region-inline" role="region" aria-label={`${label}选择`} onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}>{panel}</div> : null}
      {selectedCount > 0 ? <div className="market-region-selected" aria-label="已选地区">
        {selectedRegions.map(({ province, city }) => <button key={`${province}-${city}`} type="button" onClick={() => setSelectionError(onToggle(province, city))} aria-label={`移除地区 ${province} ${city}`}>
          <span>{province === city ? city : `${province} · ${city}`}</span><X size={12} aria-hidden="true" />
        </button>)}
      </div> : null}
    </div>
  </div>;
}

export function ServiceWindowFilter({ filters, metadata, onChange, resetToken = 0 }: Pick<MarketFilterControlsProps, "filters" | "metadata" | "onChange"> & { resetToken?: number }) {
  const id = useId();
  const entry = metadata.fields.find((e) => e.key === "serviceWindow" && e.enabled);
  const selected = filters.filters.serviceWindow;
  const [start, setStart] = useState<number | null>(selected?.startMinute ?? null);
  const [end, setEnd] = useState<number | null>(selected?.endMinute ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStart(selected?.startMinute ?? null);
    setEnd(selected?.endMinute ?? null);
    setError(null);
  }, [selected?.startMinute, selected?.endMinute, filters.game, resetToken]);
  if (!entry) return null;

  const change = (part: "start" | "end", value: string) => {
    if (value === "") {
      setStart(null);
      setEnd(null);
      setError(null);
      onChange({ ...filters, filters: { ...filters.filters, serviceWindow: undefined }, cursor: null });
      return;
    }
    const nextStart = part === "start" ? Number(value) : start;
    const nextEnd = part === "end" ? Number(value) : end;
    setStart(nextStart);
    setEnd(nextEnd);
    const result = buildServiceWindow(nextStart, nextEnd);
    if (!result.ok) {
      setError(result.reason === "missing" ? null : "起止时间不能相同；全天请选择 00:00—24:00。");
      return;
    }
    setError(null);
    onChange({ ...filters, filters: { ...filters.filters, serviceWindow: result.value }, cursor: null });
  };
  return <FilterRow label="上号时间" id={id}>
    <div className="market-time-selects">
      <MarketSelect
        className="market-ui-select--time"
        label="开始时间（北京时间）"
        value={start === null ? null : String(start)}
        placeholder="开始时间"
        invalid={Boolean(error)}
        describedBy={error ? `${id}-error` : undefined}
        options={[
          { value: "__clear__", label: "不限" },
          ...(start !== null && !SERVICE_WINDOW_START_OPTIONS.includes(start) ? [{ value: String(start), label: formatServiceWindowMinute(start) }] : []),
          ...SERVICE_WINDOW_START_OPTIONS.map((minute) => ({ value: String(minute), label: formatServiceWindowMinute(minute) })),
        ]}
        onChange={(value) => change("start", value === null || value === "__clear__" ? "" : value)}
      />
      <span aria-hidden="true">—</span>
      <MarketSelect
        className="market-ui-select--time"
        label="结束时间（北京时间）"
        value={end === null ? null : String(end)}
        placeholder="结束时间"
        invalid={Boolean(error)}
        describedBy={error ? `${id}-error` : undefined}
        options={[
          { value: "__clear__", label: "不限" },
          ...(end !== null && !SERVICE_WINDOW_END_OPTIONS.includes(end) ? [{ value: String(end), label: `${start !== null && end < start ? "次日 " : ""}${formatServiceWindowMinute(end)}` }] : []),
          ...SERVICE_WINDOW_END_OPTIONS.map((minute) => ({ value: String(minute), label: `${start !== null && minute < start ? "次日 " : ""}${formatServiceWindowMinute(minute)}` })),
        ]}
        onChange={(value) => change("end", value === null || value === "__clear__" ? "" : value)}
      />
      {start !== null && end !== null && end < start ? <span className="market-time-badge" aria-label="该时段跨越午夜，覆盖至次日">次日</span> : null}
    </div>
    {error ? <span className="market-inline-error market-filter-row-error" id={`${id}-error`} role="alert">{error}</span> : null}
  </FilterRow>;
}
