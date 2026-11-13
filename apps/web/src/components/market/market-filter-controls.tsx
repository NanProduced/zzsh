"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronDown, RotateCw, X } from "lucide-react";
import { SkinMediaThumb, SkinMetadata } from "@/components/supply/skin-media-thumb";
import {
  resourceItemDisplayName,
  resourceUnitHint,
  resourceUnitShort,
  skinGroupKey,
  skinGroupOptions,
  toggleCode,
  toggleRegionSelection,
  toggleSkinId,
} from "@/lib/listing-filters";
import type { ListingFilterConditions, PublicCatalog } from "@/lib/supply-types";
import type { MarketFilterControlsProps, MarketSelectOption, Props, ResourceRange } from "./market-filter-types";
import { MarketSelect } from "./market-select";
import { FilterGroup, FilterRow, MarketChoice, field, optionGroup, useInlinePicker } from "./market-filter-row";
import { GradeFilter, LevelFilter, RegionFilter, ServiceWindowFilter } from "./market-dimension-filters";
import { HaffFilter, ResourceFilters, ResourceQuantityInput } from "./market-resource-filters";
import { SkinFilters, SkinTile } from "./market-skin-filters";

export type { MarketFilterControlsProps, MarketSelectOption, Props, ResourceRange };
export { MarketSelect };
export { FilterGroup, FilterRow, MarketChoice, field, optionGroup, useInlinePicker };
export { GradeFilter, LevelFilter, RegionFilter, ServiceWindowFilter };
export { HaffFilter, ResourceFilters, ResourceQuantityInput };
export { SkinFilters, SkinTile };

export function MarketFilterControls(props: Props) {
  const id = useId();
  const { filters, metadata, gameCode, onChange } = props;
  const selected = filters.filters;
  const [activeMobileCategory, setActiveMobileCategory] = useState<"basic" | "character" | "resources" | "skins">("basic");
  const [knownSkins, setKnownSkins] = useState<Record<string, PublicCatalog["skins"][number]>>({});

  useEffect(() => {
    setKnownSkins((prev) => Object.fromEntries([
      ...Object.values(prev),
      ...(props.catalog?.skins ?? []),
      ...(props.skinSearchCatalog?.skins ?? []),
    ].map((s) => [s.id, s])));
  }, [props.catalog, props.skinSearchCatalog]);

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
  const levelFilter = (key: "vitality" | "bear", mobile = false) => {
    const entry = field(metadata, key);
    if (!entry) return null;
    return <LevelFilter key={key} entry={entry} current={selected[key]?.min} name={`${id}-${key}`} idPrefix={id} onChange={(value) => updateLevel(key, value)} mobile={mobile} />;
  };

  // Owner 要求：前端隐藏“Steam国际服”选项，避免改动后端代码与枚举（勿当成 bug 移除）
  const loginField = useMemo(() => {
    const raw = field(metadata, "loginMethodCodes");
    if (!raw) return undefined;
    return {
      ...raw,
      options: raw.options?.filter(
        (option) => option.value !== "legacy_login_steam_global" && !option.label.includes("Steam国际服")
      ),
    };
  }, [metadata]);
  const haffItem = metadata.items.find((item) => item.unit === "HAFF_BASE" && field(metadata, "resources")?.items?.some((entry) => entry.itemId === item.id));
  const commitResource = (itemId: string, quantity: ResourceRange | null) => {
    const next = (selected.resources ?? []).filter((entry) => entry.itemId !== itemId);
    if (quantity) next.push({ itemId, ...quantity });
    const conditions: ListingFilterConditions = { ...selected, resources: next.length ? next : undefined };
    onChange({ ...filters, filters: conditions, cursor: null });
  };

  const resourceRule = field(metadata, "resources");
  const availableResourceItems = (resourceRule?.items ?? []).flatMap((ruleItem) => {
    const item = metadata.items.find((entry) => entry.id === ruleItem.itemId);
    return item && item.id !== haffItem?.id ? [{ ruleItem, item }] : [];
  });

  const skinField = field(metadata, "skinGroups");
  const categories = skinGroupOptions(skinField, props.catalog);
  const activeSkinCategory = categories.find((c) => c.id === props.activeSkinCategoryId) ?? categories[0];
  const owners = (props.catalog?.owners ?? []).filter((o) => !activeSkinCategory?.ownerKind || o.kind === activeSkinCategory.ownerKind);
  const currentSkinGroup = selected.skinGroups?.find((g) => skinGroupKey(g) === activeSkinCategory?.id);
  const skins = props.skinSearchCatalog?.skins ?? [];

  const basicCount = (selected.loginMethodCodes?.length ?? 0)
    + (selected.safeBoxCodes?.length ?? 0)
    + (selected.vitality ? 1 : 0)
    + (selected.bear ? 1 : 0)
    + (selected.resources?.some((r) => r.itemId === haffItem?.id) ? 1 : 0);

  const characterCount = (selected.regions?.length ?? 0)
    + (selected.gradingCodes?.length ?? 0)
    + (selected.serviceWindow ? 1 : 0);

  const resourceCount = selected.resources?.filter((r) => r.itemId !== haffItem?.id).length ?? 0;
  const skinCount = selected.skinGroups?.reduce((sum, g) => sum + g.ids.length, 0) ?? 0;
  const basicDesktopCount = basicCount;
  const characterDesktopCount = characterCount;
  const [openGroups, setOpenGroups] = useState<Record<"basic" | "character" | "resources" | "skins", boolean>>(() => ({
    basic: true,
    character: characterDesktopCount > 0,
    resources: resourceCount > 0,
    skins: skinCount > 0,
  }));
  const setGroupOpen = (key: "basic" | "character" | "resources" | "skins") => (open: boolean) =>
    setOpenGroups((previous) => previous[key] === open ? previous : { ...previous, [key]: open });

  // Mobile categorized layout
  if (props.mobile) {
    return (
      <div className="market-mobile-categorized-layout">
        <div className="market-filter-rail" role="tablist" aria-label="筛选分类导航">
          {[
            { id: "basic", label: "基础条件", count: basicCount },
            { id: "character", label: "地区与上号时间", count: characterCount },
            { id: "resources", label: "物资数量", count: resourceCount },
            { id: "skins", label: "皮肤外观", count: skinCount },
          ].map((cat) => {
            const isActive = activeMobileCategory === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className="market-rail-item"
                data-active={isActive}
                onClick={() => setActiveMobileCategory(cat.id as any)}
              >
                <span className="market-rail-item-label">{cat.label}</span>
                {cat.count > 0 ? <span className="market-rail-badge">{cat.count}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="market-filter-panel" role="tabpanel">
          {activeMobileCategory === "basic" && (
            <div className="market-mobile-category-content">
              {loginField?.options?.length ? (
                <div className="market-mobile-group">
                  <span className="market-mobile-group-title">{loginField.label}</span>
                  <div className="market-mobile-choice-grid">
                    {loginField.options.map((option) => {
                      const checked = (selected.loginMethodCodes ?? []).includes(option.value);
                      return (
                        <MarketChoice
                          key={option.value}
                          type="checkbox"
                          className="market-mobile-choice"
                          checked={checked}
                          onChange={() => updateEnum("loginMethodCodes", option.value)}
                        >
                          {option.label}
                        </MarketChoice>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {haffItem && field(metadata, "resources")?.items?.find((entry) => entry.itemId === haffItem.id) ? (
                <div className="market-mobile-group">
                  <div className="market-mobile-group-header">
                    <span className="market-mobile-group-title">{resourceItemDisplayName(haffItem, { gameCode })}</span>
                    <span className="market-mobile-group-hint">1M = 1,000,000 哈夫币</span>
                  </div>
                  <div className="market-mobile-presets-row">
                    {[
                      { value: "", label: "不限" },
                      { value: "100000000", label: "≥100M" },
                      { value: "500000000", label: "≥500M" },
                      { value: "1000000000", label: "≥1000M" },
                    ].map(({ value, label }) => {
                      const currentMin = selected.resources?.find((r) => r.itemId === haffItem.id)?.minQuantity;
                      const currentMax = selected.resources?.find((r) => r.itemId === haffItem.id)?.maxQuantity;
                      const isPresetSelected = !currentMax && (currentMin ?? "") === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          className="market-mobile-preset-pill"
                          data-selected={isPresetSelected}
                          onClick={() => commitResource(haffItem.id, value ? { minQuantity: value } : null)}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <ResourceQuantityInput
                    item={haffItem}
                    bounds={field(metadata, "resources")!.items!.find((entry) => entry.itemId === haffItem.id)!}
                    committed={selected.resources?.find((entry) => entry.itemId === haffItem.id) ?? null}
                    rangeSupported={metadata.resourceQuantityRange === true}
                    gameCode={gameCode}
                    showLabel={false}
                    resetToken={props.resetToken}
                    flushDrafts={props.flushDrafts}
                    onCommit={(quantity) => commitResource(haffItem.id, quantity)}
                  />
                </div>
              ) : null}

              {field(metadata, "safeBoxCodes")?.options?.length ? (
                <div className="market-mobile-group">
                  <span className="market-mobile-group-title">{field(metadata, "safeBoxCodes")!.label}</span>
                  <div className="market-mobile-choice-grid">
                    {field(metadata, "safeBoxCodes")!.options!.map((option) => {
                      const checked = (selected.safeBoxCodes ?? []).includes(option.value);
                      return (
                        <MarketChoice
                          key={option.value}
                          type="checkbox"
                          className="market-mobile-choice"
                          checked={checked}
                          onChange={() => updateEnum("safeBoxCodes", option.value)}
                        >
                          {option.label}
                        </MarketChoice>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {field(metadata, "vitality")?.levels?.length ? (
                <div className="market-mobile-group">
                  <span className="market-mobile-group-title">{field(metadata, "vitality")!.label}</span>
                  {levelFilter("vitality", true)}
                </div>
              ) : null}

              {field(metadata, "bear")?.levels?.length ? (
                <div className="market-mobile-group">
                  <span className="market-mobile-group-title">{field(metadata, "bear")!.label}</span>
                  {levelFilter("bear", true)}
                </div>
              ) : null}
            </div>
          )}

          {activeMobileCategory === "character" && (
            <div className="market-mobile-category-content">
              {regionsField?.regions?.length ? (
                <div className="market-mobile-group">
                  <RegionFilter
                    label={regionsField.label}
                    availableRegions={regionsField.regions}
                    selectedRegions={regions}
                    resetToken={props.resetToken}
                    onToggle={updateRegion}
                    onToggleProvince={updateProvince}
                    onClear={() => onChange({ ...filters, filters: { ...selected, regions: undefined }, cursor: null })}
                  />
                </div>
              ) : null}

              {field(metadata, "gradingCodes")?.options?.length ? (
                <div className="market-mobile-group">
                  <span className="market-mobile-group-title">{field(metadata, "gradingCodes")!.label}</span>
                  <div className="market-mobile-choice-grid">
                    {field(metadata, "gradingCodes")!.options!.map((option) => {
                      const checked = (selected.gradingCodes ?? []).includes(option.value);
                      return (
                        <MarketChoice
                          key={option.value}
                          type="checkbox"
                          className="market-mobile-choice"
                          checked={checked}
                          onChange={() => updateEnum("gradingCodes", option.value)}
                        >
                          {option.label}
                        </MarketChoice>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="market-mobile-group">
                <span className="market-mobile-group-title">上号时间</span>
                <ServiceWindowFilter filters={filters} metadata={metadata} onChange={onChange} resetToken={props.resetToken} />
              </div>
            </div>
          )}

          {activeMobileCategory === "resources" && (
            <div className="market-mobile-category-content">
              <div className="market-mobile-resources-list">
                {availableResourceItems.map(({ ruleItem, item }) => (
                  <div key={item.id} className="market-mobile-resource-box">
                    <div className="market-mobile-resource-head">
                      <span className="market-mobile-resource-name">{resourceItemDisplayName(item, { gameCode })}</span>
                      <span className="market-mobile-resource-unit-hint">
                        {resourceUnitHint(item, "display") || resourceUnitShort(item, "display")}
                      </span>
                    </div>
                    <ResourceQuantityInput
                      item={item}
                      bounds={ruleItem}
                      committed={selected.resources?.find((entry) => entry.itemId === item.id) ?? null}
                      rangeSupported={metadata.resourceQuantityRange === true}
                      gameCode={gameCode}
                      showLabel={false}
                      resetToken={props.resetToken}
                      flushDrafts={props.flushDrafts}
                      onCommit={(quantity) => commitResource(item.id, quantity)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeMobileCategory === "skins" && (
            <div className="market-mobile-category-content market-mobile-skin-panel">
              <div className="market-mobile-skin-categories" role="tablist" aria-label="皮肤类别">
                {categories.map((cat) => {
                  const count = selected.skinGroups?.find((g) => skinGroupKey(g) === cat.id)?.ids.length ?? 0;
                  const isActive = activeSkinCategory?.id === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className="market-mobile-skin-tab"
                      data-active={isActive}
                      onClick={() => {
                        props.onSkinCategoryChange(cat.id);
                        props.onSkinOwnerChange("");
                      }}
                    >
                      <span>{cat.name}</span>
                      {count > 0 ? <span className="market-mobile-skin-tab-badge">{count}</span> : null}
                    </button>
                  );
                })}
              </div>

              <div className="market-mobile-skin-controls">
                <div className="market-mobile-skin-search-wrap">
                  <input
                    type="search"
                    className="market-mobile-skin-search-input"
                    value={props.skinSearch}
                    placeholder="搜索皮肤或所属名称"
                    onChange={(e) => props.onSkinSearchChange(e.target.value)}
                  />
                </div>
                <div className="market-mobile-skin-dropdowns">
                  {owners.length > 0 ? (
                    <MarketSelect
                      className="market-mobile-skin-select"
                      label="所属"
                      value={props.skinOwner || "__all__"}
                      placeholder="全部所属"
                      options={[{ value: "__all__", label: "全部所属" }, ...owners.map((o) => ({ value: o.id, label: o.name }))]}
                      onChange={(val) => props.onSkinOwnerChange(val === null || val === "__all__" ? "" : val)}
                    />
                  ) : null}
                  {props.catalog?.rarities?.length ? (
                    <MarketSelect
                      className="market-mobile-skin-select"
                      label="品质"
                      value={props.skinRarity || "__all__"}
                      placeholder="全部品质"
                      options={[{ value: "__all__", label: "全部品质" }, ...props.catalog.rarities.map((r) => ({ value: r.code, label: r.name }))]}
                      onChange={(val) => props.onSkinRarityChange(val === null || val === "__all__" ? "" : val)}
                    />
                  ) : null}
                </div>
              </div>

              {props.skinSearchStatus === "loading" ? (
                <p className="market-filter-hint" role="status">正在读取皮肤…</p>
              ) : null}
              {props.skinSearchStatus === "error" ? (
                <div className="market-filter-error">
                  <p>皮肤目录暂时不可用</p>
                  <button type="button" className="market-filter-chip" onClick={props.onRetrySkinSearch}>重试</button>
                </div>
              ) : null}
              {props.skinSearchStatus === "ready" ? (
                <>
                  <div className="market-mobile-skin-grid">
                    {skins.map((skin) => {
                      const isSelected = Boolean(currentSkinGroup?.ids.includes(skin.id));
                      return (
                        <div key={skin.id} className="market-mobile-skin-card" data-selected={isSelected}>
                          <button
                            type="button"
                            className="market-mobile-skin-card-btn"
                            aria-label={`选择 ${skin.name}`}
                            aria-pressed={isSelected}
                            onClick={() => {
                              if (activeSkinCategory) {
                                onChange(toggleSkinId(filters, activeSkinCategory.id, skin.id));
                              }
                            }}
                          >
                            <div className="market-mobile-skin-thumb-wrap" data-owner-kind={skin.ownerKind ?? "UNKNOWN"}>
                              <SkinMediaThumb mediaId={skin.mediaId} ownerKind={skin.ownerKind} className="market-mobile-skin-img" fallbackClassName="market-skin-image-empty" />
                              <SkinMetadata skin={skin} qualityTag className="market-skin-tags" />
                              <span className="market-mobile-skin-checkbox" aria-hidden="true">
                                {isSelected ? <Check size={12} strokeWidth={3} /> : null}
                              </span>
                            </div>
                            <span className="market-mobile-skin-name" title={skin.name}>{skin.name}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {skins.length === 0 ? (
                    <p className="market-filter-hint">没有匹配的皮肤；已选条件仍保留。</p>
                  ) : null}
                  {props.skinSearchCatalog?.nextCursor ? (
                    <div className="market-skin-load-more-wrap">
                      <button
                        type="button"
                        className="market-load-catalog-btn market-mobile-load-skins"
                        onClick={props.onLoadMoreSkins}
                        disabled={props.loadingMoreSkins}
                      >
                        {props.loadingMoreSkins ? (
                          <>
                            <RotateCw size={14} className="market-load-spin" aria-hidden="true" />
                            <span>正在加载更多皮肤…</span>
                          </>
                        ) : (
                          <>
                            <span>加载更多皮肤</span>
                            <ChevronDown size={14} aria-hidden="true" />
                          </>
                        )}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}

              {skinCount > 0 ? (
                <div className="market-mobile-skin-selected-box">
                  <div className="market-skin-match">
                    <div className="market-skin-match-header">
                      <span className="market-skin-match-title">匹配规则</span>
                      <span className="market-skin-match-hint">
                        {(selected.skinGroups?.[0]?.match ?? "ANY") === "ALL" ? "需拥有全部已选" : "拥有任一即可"}
                      </span>
                    </div>
                    <div className="market-skin-match-buttons">
                      {(["ANY", "ALL"] as const).map((match) => {
                        const isSelected = (selected.skinGroups?.[0]?.match ?? "ANY") === match;
                        return (
                          <button
                            key={match}
                            type="button"
                            className="market-skin-match-btn"
                            data-selected={isSelected}
                            onClick={() => {
                              const groups = (selected.skinGroups ?? []).map((g) => ({ ...g, match }));
                              onChange({ ...filters, filters: { ...selected, skinGroups: groups }, cursor: null });
                            }}
                          >
                            {isSelected ? <Check size={12} className="market-skin-match-icon" aria-hidden="true" /> : null}
                            <span>{match === "ANY" ? "任一皮肤" : "全部皮肤"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="market-mobile-selected-chips">
                    {(selected.skinGroups ?? []).flatMap((g) => g.ids.map((id) => (
                      <span key={id} className="market-mobile-skin-pill">
                        <span className="skin-pill-name">{knownSkins[id]?.name ?? "已选皮肤"}</span>
                        <button
                          type="button"
                          className="skin-pill-remove"
                          aria-label={`移除皮肤 ${knownSkins[id]?.name ?? id}`}
                          onClick={() => onChange(toggleSkinId(filters, skinGroupKey(g), id))}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </span>
                    )))}
                  </div>
                  <button
                    type="button"
                    className="market-filter-chip market-mobile-skin-clear"
                    onClick={() => onChange({ ...filters, filters: { ...selected, skinGroups: undefined }, cursor: null })}
                  >
                    清空皮肤
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Desktop view: basics stay visible; the rest are one click away.
  return <div className="market-filter-controls">
    <FilterGroup label="基础条件" count={basicDesktopCount} open={openGroups.basic} onToggle={setGroupOpen("basic")}>
      {optionGroup(loginField, selected.loginMethodCodes ?? [], (value) => updateEnum("loginMethodCodes", value), id)}
      {haffItem && field(metadata, "resources")?.items?.find((entry) => entry.itemId === haffItem.id) ? <HaffFilter flushDrafts={props.flushDrafts} item={haffItem} bounds={field(metadata, "resources")!.items!.find((entry) => entry.itemId === haffItem.id)!} current={selected.resources?.find((entry) => entry.itemId === haffItem.id)} rangeSupported={metadata.resourceQuantityRange === true} gameCode={gameCode} resetToken={props.resetToken} onChange={(quantity) => commitResource(haffItem.id, quantity)} /> : null}
      {optionGroup(field(metadata, "safeBoxCodes"), selected.safeBoxCodes ?? [], (value) => updateEnum("safeBoxCodes", value), id)}
      {levelFilter("vitality")}
      {levelFilter("bear")}
    </FilterGroup>
    <FilterGroup label="地区与上号时间" count={characterDesktopCount} open={openGroups.character} onToggle={setGroupOpen("character")}>
      {regionsField?.regions?.length ? <RegionFilter label={regionsField.label} availableRegions={regionsField.regions} selectedRegions={regions} resetToken={props.resetToken} onToggle={updateRegion} onToggleProvince={updateProvince} onClear={() => onChange({ ...filters, filters: { ...selected, regions: undefined }, cursor: null })} /> : null}
      <GradeFilter entry={field(metadata, "gradingCodes")} selected={selected.gradingCodes ?? []} onToggle={(value) => updateEnum("gradingCodes", value)} onClear={() => onChange({ ...filters, filters: { ...selected, gradingCodes: undefined }, cursor: null })} />
      <ServiceWindowFilter filters={filters} metadata={metadata} onChange={onChange} resetToken={props.resetToken} />
    </FilterGroup>
    <FilterGroup label="物资" count={resourceCount} open={openGroups.resources} onToggle={setGroupOpen("resources")}>
      <ResourceFilters filters={filters} metadata={metadata} haffId={haffItem?.id} gameCode={gameCode} onCommit={commitResource} resetToken={props.resetToken} flushDrafts={props.flushDrafts} />
    </FilterGroup>
    <FilterGroup label="皮肤外观" count={skinCount} open={openGroups.skins} onToggle={setGroupOpen("skins")}>
      <SkinFilters {...props} />
    </FilterGroup>
  </div>;
}
