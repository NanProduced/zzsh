"use client";
import { useEffect, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, RotateCw, X, ZoomIn } from "lucide-react";
import { SkinMediaThumb, SkinMediaPreview, SkinMetadata } from "@/components/supply/skin-media-thumb";
import {
  skinGroupKey,
  skinGroupOptions,
  toggleSkinId,
} from "@/lib/listing-filters";
import type { PublicCatalog } from "@/lib/supply-types";
import { FilterRow, field, useInlinePicker } from "./market-filter-row";
import { MarketSelect } from "./market-select";
import type { MarketFilterControlsProps } from "./market-filter-types";

export function SkinTile({ skin, selected, onClick }: { skin: PublicCatalog["skins"][number]; selected: boolean; onClick: () => void }) {
  return <div className="market-skin-candidate" data-skin-id={skin.id}>
    <button type="button" className="market-skin-tile" aria-label={`选择 ${skin.name}`} aria-pressed={selected} onClick={onClick}>
      <span className="market-skin-thumb-wrap">
        <SkinMediaThumb mediaId={skin.mediaId} ownerKind={skin.ownerKind} className="market-skin-image" fallbackClassName="market-skin-image-empty" />
        <SkinMetadata skin={skin} qualityTag className="market-skin-tags" />
        <span className="market-skin-check" aria-hidden="true">{selected ? <Check size={13} /> : null}</span>
      </span>
      <span className="market-skin-name" title={skin.name}>{skin.name}</span>
    </button>
    <SkinMediaPreview skin={skin} triggerClassName="market-skin-preview"><ZoomIn size={14} aria-hidden="true" /></SkinMediaPreview>
  </div>;
}

export function SkinFilters({
  filters: committedFilters, metadata, catalog, catalogStatus, skinSearch, skinOwner, skinRarity, activeSkinCategoryId, skinSearchCatalog, skinSearchStatus,
  onChange: commitFilters, onRetryCatalog, onRetrySkinSearch, onSkinSearchChange, onSkinOwnerChange, onSkinRarityChange, onSkinCategoryChange, onLoadMoreSkins, loadingMoreSkins,
}: MarketFilterControlsProps) {
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
  const categories = skinGroupOptions(skinField, catalog);
  const activeCategory = categories.find((category) => category.id === activeSkinCategoryId) ?? categories[0];
  const owners = (catalog?.owners ?? []).filter((owner) => !activeCategory?.ownerKind || owner.kind === activeCategory.ownerKind);
  if (!skinField) return null;
  const group = filters.filters.skinGroups?.find((entry) => skinGroupKey(entry) === activeCategory?.id);
  const totalSelected = (filters.filters.skinGroups ?? []).reduce((sum, entry) => sum + entry.ids.length, 0);
  const searchQuery = skinSearch.normalize("NFKC").trim();
  const skinResultsStatus = skinSearchStatus;
  const skins = skinSearchCatalog?.skins ?? [];
  const nextCursor = skinSearchCatalog?.nextCursor;
  const updateMatch = (match: "ANY" | "ALL") => {
    if (!activeCategory) return;
    const groups = [...(filters.filters.skinGroups ?? [])];
    const index = groups.findIndex((entry) => skinGroupKey(entry) === activeCategory.id);
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
            const count = filters.filters.skinGroups?.find((entry) => skinGroupKey(entry) === category.id)?.ids.length ?? 0;
            return <button type="button" key={category.id} aria-pressed={activeCategory?.id === category.id} onClick={() => onSkinCategoryChange(category.id)}>{category.name}{count > 0 ? <span>{count}</span> : null}</button>;
          })}
        </div>
        <div className="market-skin-candidates">
        {activeCategory && <>
          <div className="market-skin-search-controls">
            <label className="market-skin-search" htmlFor={`${id}-skin-search`}>
              <span className="sr-only">搜索{activeCategory.name}或所属名称</span>
              <input ref={searchRef} id={`${id}-skin-search`} type="search" maxLength={80} value={skinSearch} placeholder="搜索皮肤或所属名称" onChange={(event) => onSkinSearchChange(event.target.value)} />
            </label>
            {owners.length ? <MarketSelect label="皮肤所属" value={skinOwner || "__all__"} placeholder="全部所属" options={[{ value: "__all__", label: "全部所属" }, ...owners.map((owner) => ({ value: owner.id, label: owner.name }))]} onChange={(value) => onSkinOwnerChange(value === null || value === "__all__" ? "" : value)} /> : null}
            {catalog?.rarities.length ? <MarketSelect label="皮肤品质" value={skinRarity || "__all__"} placeholder="全部品质" options={[{ value: "__all__", label: "全部品质" }, ...catalog.rarities.map((rarity) => ({ value: rarity.code, label: rarity.name }))]} onChange={(value) => onSkinRarityChange(value === null || value === "__all__" ? "" : value)} /> : null}
          </div>
          {skinResultsStatus === "loading" ? <p className="market-filter-hint" role="status">{searchQuery ? "正在搜索当前类别…" : "正在读取当前类别…"}</p> : null}
          {skinResultsStatus === "error" ? <div className="market-filter-error" role="alert"><p>皮肤目录暂时不可用，已选条件不会清除。</p><button type="button" className="market-filter-chip" onClick={onRetrySkinSearch}>{searchQuery ? "重试搜索" : "重试类别"}</button></div> : null}
          {skinResultsStatus === "ready" ? <>
            <div className="market-skin-grid" role="group" aria-label={`按${activeCategory.name}筛选`}>
              {skins.map((skin) => <SkinTile key={skin.id} skin={skin} selected={Boolean(group?.ids.includes(skin.id))} onClick={() => onChange(toggleSkinId(filters, activeCategory.id, skin.id))} />)}
            </div>
            {skins.length === 0 && <p className="market-filter-hint">没有匹配的皮肤；已选条件仍保留。</p>}
          </> : null}
        </>}
        {nextCursor && skinResultsStatus === "ready" ? (
          <div className="market-skin-load-more-wrap">
            <button
              type="button"
              className="market-load-catalog-btn"
              onClick={onLoadMoreSkins}
              disabled={loadingMoreSkins}
            >
              {loadingMoreSkins ? (
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
        </div>
        <aside className="market-skin-selected" aria-label="已选皮肤">
          <strong>已选 {totalSelected} 款</strong>
          <div className="market-skin-selected-list">
            {(filters.filters.skinGroups ?? []).flatMap((selectedGroup) => selectedGroup.ids.map((skinId) => {
              const skin = knownSkins[skinId];
              return <div key={skinId} className="market-skin-selected-item">
                <SkinMediaThumb mediaId={skin?.mediaId ?? null} ownerKind={skin?.ownerKind} className="market-skin-selected-thumb" fallbackClassName="market-skin-image-empty" iconSize={14} />
                <span className="market-skin-selected-name" title={skin?.name ?? skinId}>
                  {skin?.name ?? "已选皮肤"}
                </span>
                <button type="button" className="market-skin-selected-remove" aria-label={`移除皮肤 ${skin?.name ?? skinId}`} onClick={() => onChange(toggleSkinId(filters, skinGroupKey(selectedGroup), skinId))}>
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
  return <FilterRow label={skinField.label} id={`${id}-skins`} className="market-skin-filter">
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
    {committedCount > 0 ? (
      <div className="market-skin-selected-inline" aria-label="已选皮肤">
        {(committedFilters.filters.skinGroups ?? []).flatMap((g) => g.ids.map((skinId) => {
          const skinName = knownSkins[skinId]?.name ?? "已选皮肤";
          return (
            <span key={skinId} className="market-filter-chip market-skin-chip-selected">
              <span>{skinName}</span>
              <button
                type="button"
                className="market-skin-chip-remove"
                onClick={() => commitFilters(toggleSkinId(committedFilters, skinGroupKey(g), skinId))}
                aria-label={`移除已选皮肤 ${skinName}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        }))}
      </div>
    ) : null}
  </FilterRow>;
}
