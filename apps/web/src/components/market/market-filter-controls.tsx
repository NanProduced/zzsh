"use client";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ListBox } from "@heroui/react/list-box";
import { Select as UiSelect } from "@heroui/react/select";
import { Check, ChevronDown, ImageOff, MapPin, Minus, Plus, Search, X } from "lucide-react";
import {
  buildServiceWindow,
  formatServiceWindowMinute,
  resourceInputFromBase,
  resourceItemDisplayName,
  validateResourceQuantityInput,
  resourceUnitHint,
  resourceUnitShort,
  SERVICE_WINDOW_END_OPTIONS,
  SERVICE_WINDOW_START_OPTIONS,
  toggleCode,
  regionProvinceSelectionState,
  toggleRegionSelection,
  toggleSkinId,
  type ListingFilters,
  type ResourceInputMode,
} from "@/lib/listing-filters";
import type { ListingFilterConditions, PublicCatalog, PublicListingFilterField, PublicListingFilterMetadata } from "@/lib/supply-types";

type Props = {
  filters: ListingFilters;
  metadata: PublicListingFilterMetadata;
  gameCode?: string;
  catalog: PublicCatalog | null;
  catalogStatus: "idle" | "loading" | "ready" | "error";
  skinSearch: string;
  activeSkinCategoryId: string;
  skinSearchCatalog: PublicCatalog | null;
  skinSearchStatus: "idle" | "loading" | "ready" | "error";
  onChange: (next: ListingFilters) => void;
  onRetryCatalog: () => void;
  onRetrySkinSearch: () => void;
  onSkinSearchChange: (value: string) => void;
  onSkinCategoryChange: (categoryId: string) => void;
  onLoadMoreSkins: () => void;
  loadingMoreSkins: boolean;
};

function field(metadata: PublicListingFilterMetadata, key: string): PublicListingFilterField | undefined {
  return metadata.fields.find((entry) => entry.key === key && entry.enabled);
}

function useInlinePicker(): boolean {
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

function FilterRow({ label, id, count, className = "", children }: { label: string; id: string; count?: number; className?: string; children: ReactNode }) {
  return <div className={`market-filter-row ${className}`.trim()} role="group" aria-labelledby={`${id}-label`}>
    <span className="market-filter-row-label" id={`${id}-label`}>
      {label}
      {count ? <span className="market-filter-row-count" aria-label={`已选 ${count} 项`}> ({count})</span> : null}
    </span>
    <div className="market-filter-row-options">{children}</div>
  </div>;
}

export type MarketSelectOption = { value: string; label: string };

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
  return <UiSelect.Root
    className={`market-ui-select ${className}`}
    aria-label={label}
    aria-invalid={invalid || undefined}
    aria-describedby={describedBy}
    name={name}
    placeholder={placeholder}
    selectedKey={value}
    onSelectionChange={(key) => onChange(key === null ? null : String(key))}
  >
    <UiSelect.Trigger className="market-ui-select-trigger">
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

function MarketChoice({
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

function optionGroup(
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

function LevelFilter({
  entry,
  current,
  name,
  idPrefix,
  onChange,
}: {
  entry: PublicListingFilterField;
  current: number | undefined;
  name: string;
  idPrefix: string;
  onChange: (value: number | null) => void;
}) {
  const values = entry.levels ?? [];
  if (!values.length) return null;
  return <FilterRow label={entry.label} id={`${idPrefix}-filter-${entry.key}`}>
    <MarketSelect
      className="market-ui-select--property"
      label={entry.label}
      name={name}
      value={current === undefined ? "__unlimited__" : String(current)}
      placeholder="不限"
      options={[{ value: "__unlimited__", label: "不限" }, ...values.map((value) => ({ value: String(value), label: `≥${value}` }))]}
      onChange={(value) => onChange(value === null || value === "__unlimited__" ? null : Number(value))}
    />
  </FilterRow>;
}

function GradeFilter({ entry, selected, onToggle, onClear }: {
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

function RegionFilter({
  label,
  availableRegions,
  selectedRegions,
  onToggle,
  onToggleProvince,
  onClear,
}: {
  label: string;
  availableRegions: Array<{ province: string; city: string }>;
  selectedRegions: Array<{ province: string; city: string }>;
  onToggle: (province: string, city: string) => string | null;
  onToggleProvince: (province: string) => string | null;
  onClear: () => void;
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

type ResourceRange = { minQuantity?: string; maxQuantity?: string };

function ResourceQuantityInput({ item, bounds, committed, rangeSupported, onCommit, gameCode, showLabel = true }: {
  item: PublicListingFilterMetadata["items"][number];
  bounds: { min: string; max: string };
  committed: ResourceRange | null;
  rangeSupported: boolean;
  onCommit: (value: ResourceRange | null) => void;
  gameCode?: string;
  showLabel?: boolean;
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

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    setMinDraft(display(committed?.minQuantity));
    setMaxDraft(display(committed?.maxQuantity));
    setError(null);
  }, [committed?.minQuantity, committed?.maxQuantity, item.code, item.unit, mode]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const apply = (minimum: string, maximum: string) => {
    if (minimum === "" && maximum === "") {
      setError(null);
      if (committed) onCommit(null);
      return;
    }
    try {
      const minQuantity = minimum === "" ? undefined : validateResourceQuantityInput(minimum, item, bounds, mode);
      const maxQuantity = !rangeSupported || maximum === "" ? undefined : validateResourceQuantityInput(maximum, item, bounds, mode);
      if (minQuantity !== undefined && maxQuantity !== undefined && BigInt(minQuantity) > BigInt(maxQuantity)) throw new Error("下限不能大于上限。");
      setError(null);
      const next = { ...(minQuantity === undefined ? {} : { minQuantity }), ...(maxQuantity === undefined ? {} : { maxQuantity }) };
      if (next.minQuantity !== committed?.minQuantity || next.maxQuantity !== committed?.maxQuantity) onCommit(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "数量格式无效。");
    }
  };

  const applyRef = useRef(apply);
  useEffect(() => { applyRef.current = apply; });
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
  return <div className="market-resource-quantity">
    {showLabel ? <span className="market-resource-name">{displayName}</span> : null}
    <div className="market-resource-range" title={unitHint ?? undefined}>
      <input type="text" inputMode="numeric" value={minDraft} maxLength={32} placeholder="最低"
        aria-label={`${displayName}数量下限（${unit}）`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
        onChange={(event) => change(event.target.value, maxDraft)} onBlur={flush} />
      {rangeSupported ? <>
        <span className="market-range-separator" aria-hidden="true">–</span>
        <input type="text" inputMode="numeric" value={maxDraft} maxLength={32} placeholder="最高"
          aria-label={`${displayName}数量上限（${unit}）`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
          onChange={(event) => change(minDraft, event.target.value)} onBlur={flush} />
      </> : null}
      <span className="market-resource-unit">{unit}</span>
    </div>
    {error ? <small className="market-inline-error" id={errorId} role="alert">{error}</small> : null}
  </div>;
}

function HaffFilter({ item, bounds, current, rangeSupported, gameCode, onChange }: {
  item: PublicListingFilterMetadata["items"][number];
  bounds: { min: string; max: string };
  current: ResourceRange | undefined;
  rangeSupported: boolean;
  gameCode?: string;
  onChange: (value: ResourceRange | null) => void;
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
      <span role="radiogroup" aria-labelledby={`${id}-label`} className="market-filter-row-radios">
        {options.map(({ value, label }) => <MarketChoice key={value} type="radio" className={`market-filter-choice ${value === "" ? "market-choice--default" : ""}`} name={`${id}-haff`} value={value} checked={selected === value} onChange={() => onChange(value ? { minQuantity: value } : null)}>{label}</MarketChoice>)}
      </span>
      <ResourceQuantityInput item={item} bounds={bounds} committed={current ?? null} rangeSupported={rangeSupported} onCommit={onChange} gameCode={gameCode} showLabel={false} />
    </div>
  </FilterRow>;
}

function ResourceFilters({ filters, metadata, haffId, gameCode, onCommit }: Pick<Props, "filters" | "metadata" | "gameCode"> & {
  haffId: string | undefined;
  onCommit: (itemId: string, quantity: ResourceRange | null) => void;
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
          onCommit={(quantity) => onCommit(item.id, quantity)} />;
      })}
    </div>
  </FilterRow>;
}

function ServiceWindowFilter({ filters, metadata, onChange }: Pick<Props, "filters" | "metadata" | "onChange">) {
  const id = useId();
  const entry = field(metadata, "serviceWindow");
  const selected = filters.filters.serviceWindow;
  const [start, setStart] = useState<number | null>(selected?.startMinute ?? null);
  const [end, setEnd] = useState<number | null>(selected?.endMinute ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStart(selected?.startMinute ?? null);
    setEnd(selected?.endMinute ?? null);
    setError(null);
  }, [selected?.startMinute, selected?.endMinute, filters.game]);
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
  return <FilterRow label={entry.label} id={id}>
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
function SkinTile({ skin, selected, onClick }: { skin: PublicCatalog["skins"][number]; selected: boolean; onClick: () => void }) {
  const [failed, setFailed] = useState(false);
  const src = skin.mediaId ? `/api/supply/media/${encodeURIComponent(skin.mediaId)}/content` : null;
  useEffect(() => setFailed(false), [src]);
  return <button type="button" className="market-skin-tile" aria-pressed={selected} onClick={onClick}>
    <span className="market-skin-image">{src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span className="market-skin-image-empty"><ImageOff size={17} aria-hidden="true" /><span>暂无公开图</span></span>}</span>
    <span className="market-skin-check" aria-hidden="true">{selected ? <Check size={13} /> : null}</span>
    <span className="market-skin-name">{skin.name}</span>
  </button>;
}

function SkinFilters({
  filters: committedFilters, metadata, catalog, catalogStatus, skinSearch, activeSkinCategoryId, skinSearchCatalog, skinSearchStatus,
  onChange: commitFilters, onRetryCatalog, onRetrySkinSearch, onSkinSearchChange, onSkinCategoryChange, onLoadMoreSkins, loadingMoreSkins,
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [filters, onChange] = useState(committedFilters);
  const inline = useInlinePicker();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [knownSkins, setKnownSkins] = useState<Record<string, PublicCatalog["skins"][number]>>({});
  const committedKey = JSON.stringify(committedFilters.filters.skinGroups ?? []);
  useEffect(() => {
    setOpen(false);
    onChange(committedFilters);
    // External URL/metadata changes invalidate an unconfirmed selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedKey, committedFilters.game, metadata.filterRevision, metadata.catalogRevision]);
  useEffect(() => { setOpen(false); }, [inline]);
  useEffect(() => {
    setKnownSkins((previous) => Object.fromEntries([
      ...Object.values(previous), ...(catalog?.skins ?? []), ...(skinSearchCatalog?.skins ?? []),
    ].map((skin) => [skin.id, skin])));
  }, [catalog, skinSearchCatalog]);
  const changeOpen = (next: boolean) => {
    if (next) onChange(committedFilters);
    setOpen(next);
  };
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const skinField = field(metadata, "skinGroups");
  const categoryIds = new Set(skinField?.categoryIds ?? []);
  const categories = (catalog?.categories ?? []).filter((category) => categoryIds.has(category.id));
  const activeCategory = categories.find((category) => category.id === activeSkinCategoryId) ?? categories[0];
  if (!skinField) return null;
  const group = filters.filters.skinGroups?.find((entry) => entry.categoryId === activeCategory?.id);
  const totalSelected = (filters.filters.skinGroups ?? []).reduce((sum, entry) => sum + entry.ids.length, 0);
  const searchQuery = skinSearch.normalize("NFKC").trim();
  const skinResultsStatus = searchQuery ? skinSearchStatus : catalogStatus;
  const skins = searchQuery
    ? (skinSearchCatalog?.skins ?? [])
    : (catalog?.skins ?? []).filter((skin) => skin.categoryId === activeCategory?.id);
  const nextCursor = searchQuery ? skinSearchCatalog?.nextCursor : catalog?.nextCursor;
  const updateMatch = (match: "ANY" | "ALL") => {
    if (!activeCategory) return;
    const groups = [...(filters.filters.skinGroups ?? [])];
    const index = groups.findIndex((entry) => entry.categoryId === activeCategory.id);
    if (index < 0) return;
    groups[index] = { ...groups[index]!, match };
    onChange({ ...filters, filters: { ...filters.filters, skinGroups: groups }, cursor: null });
  };
  const committedCount = (committedFilters.filters.skinGroups ?? []).reduce((sum, entry) => sum + entry.ids.length, 0);
  const panel = <div className="market-skin-panel">
    <button type="button" className="market-skin-close" aria-label="关闭皮肤选择" onClick={close}><X size={18} aria-hidden="true" /></button>
    <div className="market-skin-panel-content">
      {catalogStatus === "error" ? <div className="market-filter-error"><p>皮肤目录暂时不可用。你仍可使用其他已加载筛选项。</p><button type="button" className="market-filter-chip" onClick={onRetryCatalog}>重试皮肤目录</button></div> : null}
      {catalogStatus === "loading" ? <p className="market-filter-hint" role="status">正在读取皮肤目录…</p> : null}
      {catalogStatus === "ready" && categories.length > 0 ? <>
        <div className="market-skin-categories" role="group" aria-label="皮肤类别">
          {categories.map((category) => {
            const count = filters.filters.skinGroups?.find((entry) => entry.categoryId === category.id)?.ids.length ?? 0;
            return <button type="button" key={category.id} aria-pressed={activeCategory?.id === category.id} onClick={() => onSkinCategoryChange(category.id)}>{category.name}{count > 0 ? <span>{count}</span> : null}</button>;
          })}
        </div>
        <div className="market-skin-candidates">
        {activeCategory && <>
          <label className="market-skin-search" htmlFor={`${id}-skin-search`}>
            <span className="sr-only">搜索{activeCategory.name}名称</span>
            <input ref={searchRef} id={`${id}-skin-search`} type="search" maxLength={80} value={skinSearch} placeholder={`搜索${activeCategory.name}`} onChange={(event) => onSkinSearchChange(event.target.value)} />
          </label>
          {skinResultsStatus === "loading" ? <p className="market-filter-hint" role="status">正在搜索当前类别…</p> : null}
          {searchQuery && skinResultsStatus === "error" ? <div className="market-filter-error" role="alert"><p>皮肤搜索暂时不可用，已选条件不会清除。</p><button type="button" className="market-filter-chip" onClick={onRetrySkinSearch}>重试搜索</button></div> : null}
          {skinResultsStatus === "ready" ? <>
            <div className="market-skin-grid" role="group" aria-label={`按${activeCategory.name}筛选`}>
              {skins.map((skin) => <SkinTile key={skin.id} skin={skin} selected={Boolean(group?.ids.includes(skin.id))} onClick={() => onChange(toggleSkinId(filters, activeCategory.id, skin.id))} />)}
            </div>
            {skins.length === 0 && <p className="market-filter-hint">没有匹配的皮肤；已选条件仍保留。</p>}
          </> : null}
        </>}
        {nextCursor && skinResultsStatus === "ready" && <button type="button" className="market-load-catalog" onClick={onLoadMoreSkins} disabled={loadingMoreSkins}>{loadingMoreSkins ? "正在加载…" : "加载更多皮肤"}<Plus size={14} /></button>}
        </div>
        <aside className="market-skin-selected" aria-label="已选皮肤">
          <strong>已选 {totalSelected} 款</strong>
          <div className="market-skin-selected-list">
            {(filters.filters.skinGroups ?? []).flatMap((selectedGroup) => selectedGroup.ids.map((skinId) => {
              const skin = knownSkins[skinId];
              const src = skin?.mediaId ? `/api/supply/media/${encodeURIComponent(skin.mediaId)}/content` : null;
              return <div key={skinId} className="market-skin-selected-item">
                <span className="market-skin-selected-thumb">
                  {src ? <img src={src} alt="" loading="lazy" /> : <ImageOff size={14} aria-hidden="true" className="market-skin-thumb-placeholder" />}
                </span>
                <span className="market-skin-selected-name" title={skin?.name ?? skinId}>
                  {skin?.name ?? "已选皮肤"}
                </span>
                <button type="button" className="market-skin-selected-remove" aria-label={`移除皮肤 ${skin?.name ?? skinId}`} onClick={() => onChange(toggleSkinId(filters, selectedGroup.categoryId, skinId))}>
                  <X size={14} aria-hidden="true" />
                </button>
              </div>;
            }))}
          </div>
          {activeCategory && group?.ids.length ? <div className="market-skin-match" role="group" aria-label={`${activeCategory.name}匹配方式`}>
            <div className="market-skin-match-header">
              <span className="market-skin-match-title">匹配规则</span>
              <span className="market-skin-match-hint">{(group.match ?? "ANY") === "ALL" ? "需全部拥有" : "拥有任一即可"}</span>
            </div>
            <div className="market-skin-match-buttons">
              {(["ANY", "ALL"] as const).map((match) => {
                const isSelected = (group.match ?? "ANY") === match;
                return <button
                  key={match}
                  type="button"
                  className="market-skin-match-btn"
                  aria-pressed={isSelected}
                  data-selected={isSelected}
                  onClick={() => updateMatch(match)}
                >
                  {isSelected ? <Check size={12} className="market-skin-match-icon" aria-hidden="true" /> : null}
                  <span>{match === "ANY" ? "任一皮肤" : "全部皮肤"}</span>
                </button>;
              })}
            </div>
          </div> : null}
        </aside>
      </> : catalogStatus === "ready" && <p className="market-filter-hint">当前没有可筛选皮肤类别。</p>}
    </div>
    <div className="market-skin-panel-footer">
      <span>已选 {totalSelected} 款</span>
      <button type="button" className="market-filter-chip" onClick={() => onChange({ ...filters, filters: { ...filters.filters, skinGroups: undefined } })}>清空</button>
      <button type="button" className="market-skin-confirm" onClick={() => {
        commitFilters({ ...committedFilters, filters: { ...committedFilters.filters, skinGroups: filters.filters.skinGroups }, cursor: null });
        close();
      }}>确认</button>
    </div>
  </div>;
  const trigger = <button ref={triggerRef} type="button" className="market-picker-trigger market-skin-trigger" aria-label={`选择皮肤${committedCount ? `，已选 ${committedCount} 款` : ""}`} aria-expanded={open} aria-controls={`${id}-skin-panel`} onClick={() => { if (inline) changeOpen(!open); }}>
    <span>选择皮肤{committedCount ? ` · 已选 ${committedCount} 款` : ""}</span><ChevronDown size={14} aria-hidden="true" />
  </button>;
  return <FilterRow label={skinField.label} id={`${id}-skins`}>
    {inline ? <>
      {trigger}
      {open && <div id={`${id}-skin-panel`} className="market-skin-inline" role="region" aria-label="选择皮肤" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }}>{panel}</div>}
    </> : <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content id={`${id}-skin-panel`} className="market-skin-popover" align="start" side="bottom" sideOffset={6} collisionPadding={16} aria-label="选择皮肤" onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}>
          {panel}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>}
  </FilterRow>;
}

export function MarketFilterControls(props: Props) {
  const id = useId();
  const { filters, metadata, gameCode, onChange } = props;
  const selected = filters.filters;
  const regionsField = field(metadata, "regions");
  const regions = selected.regions ?? [];
  const updateEnum = (key: "safeBoxCodes" | "gradingCodes" | "loginMethodCodes", value: string) => {
    const next = toggleCode(selected[key] ?? [], value);
    onChange({ ...filters, filters: { ...selected, [key]: next.length ? next : undefined }, cursor: null });
  };
  const updateLevel = (key: "vitality" | "bear", value: number | null) => onChange({
    ...filters,
    filters: { ...selected, [key]: value === null ? undefined : { min: value } },
    cursor: null,
  });
  const availableRegions = regionsField?.regions ?? [];
  const updateRegion = (province: string, city: string) => {
    const result = toggleRegionSelection(filters, province, [], metadata, "city", city);
    if (result.filters !== filters) onChange(result.filters);
    return result.error;
  };
  const updateProvince = (province: string) => {
    const cities = availableRegions.filter((region) => region.province === province).map((region) => region.city);
    const result = toggleRegionSelection(filters, province, cities, metadata, "province");
    if (result.filters !== filters) onChange(result.filters);
    return result.error;
  };
  const levelFilter = (key: "vitality" | "bear") => {
    const entry = field(metadata, key);
    if (!entry) return null;
    return <LevelFilter key={key} entry={entry} current={selected[key]?.min} name={`${id}-${key}`} idPrefix={id} onChange={(value) => updateLevel(key, value)} />;
  };

  const loginField = field(metadata, "loginMethodCodes");
  const haffItem = metadata.items.find((item) => item.unit === "HAFF_BASE" && field(metadata, "resources")?.items?.some((entry) => entry.itemId === item.id));
  const commitResource = (itemId: string, quantity: ResourceRange | null) => {
    const next = (selected.resources ?? []).filter((entry) => entry.itemId !== itemId);
    if (quantity) next.push({ itemId, ...quantity });
    const conditions: ListingFilterConditions = { ...selected, resources: next.length ? next : undefined };
    onChange({ ...filters, filters: conditions, cursor: null });
  };

  return <div className="market-filter-controls">
    {optionGroup(loginField, selected.loginMethodCodes ?? [], (value) => updateEnum("loginMethodCodes", value), id)}
    {regionsField?.regions?.length ? <RegionFilter label={regionsField.label} availableRegions={regionsField.regions} selectedRegions={regions} onToggle={updateRegion} onToggleProvince={updateProvince} onClear={() => onChange({ ...filters, filters: { ...selected, regions: undefined }, cursor: null })} /> : null}
    {haffItem && field(metadata, "resources")?.items?.find((entry) => entry.itemId === haffItem.id) ? <HaffFilter item={haffItem} bounds={field(metadata, "resources")!.items!.find((entry) => entry.itemId === haffItem.id)!} current={selected.resources?.find((entry) => entry.itemId === haffItem.id)} rangeSupported={metadata.resourceQuantityRange === true} gameCode={gameCode} onChange={(quantity) => commitResource(haffItem.id, quantity)} /> : null}
    {optionGroup(field(metadata, "safeBoxCodes"), selected.safeBoxCodes ?? [], (value) => updateEnum("safeBoxCodes", value), id)}
    <GradeFilter entry={field(metadata, "gradingCodes")} selected={selected.gradingCodes ?? []} onToggle={(value) => updateEnum("gradingCodes", value)} onClear={() => onChange({ ...filters, filters: { ...selected, gradingCodes: undefined }, cursor: null })} />
    {levelFilter("vitality")}
    {levelFilter("bear")}
    <ServiceWindowFilter filters={filters} metadata={metadata} onChange={onChange} />
    <ResourceFilters filters={filters} metadata={metadata} haffId={haffItem?.id} gameCode={gameCode} onCommit={commitResource} />
    <SkinFilters {...props} />
  </div>;
}
