"use client";
import { useCallback, useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Coins, LayoutGrid, List, Moon, RotateCw, TrendingUp, X } from "lucide-react";
import {
  resourceInputFromBase,
  resourceItemDisplayName,
  resourceUnitShort,
  skinGroupKey,
  toggleSkinId,
  withFilterChange,
  type ListingFilters,
} from "@/lib/listing-filters";
import type { PublicCatalog, PublicListingFilterMetadata } from "@/lib/supply-types";
import type { ResultErrorInfo } from "./market-error-display";

export type MarketSortTab = {
  id: string;
  label: string;
  isActive: boolean;
  direction: "ASC" | "DESC" | null;
  directionText: string;
  title: string;
  ariaLabel: string;
  onClick: () => void;
};

export type ActiveTag = { id: string; label: string; onRemove: () => void };

export function useMarketSort(
  filters: ListingFilters,
  navigate: (next: ListingFilters) => void,
  activeMetadata: PublicListingFilterMetadata | null
) {
  const haffItem = useMemo(
    () => activeMetadata?.items.find((i) => i.unit === "HAFF_BASE" || i.code === "haff_base" || i.code === "df_billable_haff" || i.code === "haff"),
    [activeMetadata]
  );
  const awmItem = useMemo(
    () => activeMetadata?.items.find((i) => i.code === "awm_round" || i.code === "df_billable_awm_bullet" || i.code === "awm"),
    [activeMetadata]
  );
  const helmetItem = useMemo(
    () => activeMetadata?.items.find((i) => i.code === "level6_helmet" || i.code === "df_billable_level6_helmet" || i.code === "helmet"),
    [activeMetadata]
  );
  const armorItem = useMemo(
    () => activeMetadata?.items.find((i) => i.code === "level6_armor" || i.code === "df_billable_level6_armor" || i.code === "armor"),
    [activeMetadata]
  );

  const isSmallAmountActive = Boolean(
    filters.filters.resources?.some(
      (r) => (r.itemId === haffItem?.id || r.itemId === "haff" || r.itemId === "haff_base" || r.itemId === "df_billable_haff") && r.maxQuantity === "150000000"
    )
  );
  const isHighRatioActive = filters.sort === "ratio" && filters.direction === "DESC";
  const isLingchenActive = Boolean(
    filters.filters.serviceWindow &&
    filters.filters.serviceWindow.startMinute === 0 &&
    filters.filters.serviceWindow.endMinute === 480
  );

  const toggleSmallAmount = useCallback(() => {
    const existing = filters.filters.resources ?? [];
    const filtered = existing.filter(
      (r) => !(r.itemId === haffItem?.id || r.itemId === "haff" || r.itemId === "haff_base" || r.itemId === "df_billable_haff")
    );
    if (!isSmallAmountActive) {
      filtered.push({
        itemId: haffItem?.id ?? "haff",
        maxQuantity: "150000000",
      });
    }
    navigate(
      withFilterChange(filters, {
        filters: {
          ...filters.filters,
          resources: filtered.length ? filtered : undefined,
        },
      })
    );
  }, [filters, haffItem?.id, isSmallAmountActive, navigate]);

  const toggleHighRatio = useCallback(() => {
    if (isHighRatioActive) {
      navigate(withFilterChange(filters, { sort: "latest", direction: "DESC", coreItemId: null }));
    } else {
      navigate(withFilterChange(filters, { sort: "ratio", coreItemId: haffItem?.id ?? null, direction: "DESC" }));
    }
  }, [filters, haffItem?.id, isHighRatioActive, navigate]);

  const toggleLingchen = useCallback(() => {
    if (isLingchenActive) {
      const nextConditions = { ...filters.filters };
      delete nextConditions.serviceWindow;
      navigate(withFilterChange(filters, { filters: nextConditions }));
    } else {
      navigate(
        withFilterChange(filters, {
          filters: {
            ...filters.filters,
            serviceWindow: {
              startMinute: 0,
              endMinute: 480,
              crossMidnight: false,
              timezone: "Asia/Shanghai",
            },
          },
        })
      );
    }
  }, [filters, isLingchenActive, navigate]);

  const sortTabs: MarketSortTab[] = useMemo(() => {
    const isLatestActive = filters.sort === "latest";
    const isHaffActive = filters.sort === "coreQuantity" && (!filters.coreItemId || filters.coreItemId === haffItem?.id);
    const isMoneyActive = filters.sort === "resourceTotal";
    const isRatioActive = filters.sort === "ratio";
    const isAwmActive = Boolean(awmItem && filters.sort === "coreQuantity" && filters.coreItemId === awmItem.id);
    const isHelmetActive = Boolean(helmetItem && filters.sort === "coreQuantity" && filters.coreItemId === helmetItem.id);
    const isArmorActive = Boolean(armorItem && filters.sort === "coreQuantity" && filters.coreItemId === armorItem.id);

    return [
      {
        id: "default",
        label: "默认排序",
        isActive: isLatestActive,
        direction: isLatestActive ? filters.direction : null,
        directionText: filters.direction === "DESC" ? "最新发布" : "最早发布",
        title: isLatestActive
          ? `默认排序：当前${filters.direction === "DESC" ? "最新发布优先" : "最早发布优先"}，点击切换为${filters.direction === "DESC" ? "最早发布" : "最新发布"}`
          : "点击按最新发布排序",
        ariaLabel: isLatestActive
          ? `默认排序，当前${filters.direction === "DESC" ? "最新发布" : "最早发布"}，点击切换方向`
          : "默认排序，点击激活",
        onClick: () => {
          if (isLatestActive) {
            navigate(withFilterChange(filters, { direction: filters.direction === "DESC" ? "ASC" : "DESC" }));
          } else {
            navigate(withFilterChange(filters, { sort: "latest", direction: "DESC", coreItemId: null }));
          }
        },
      },
      {
        id: "haff",
        label: "哈夫币排序",
        isActive: isHaffActive,
        direction: isHaffActive ? filters.direction : null,
        directionText: filters.direction === "DESC" ? "从高到低" : "从低到高",
        title: isHaffActive
          ? `哈夫币排序：当前从${filters.direction === "DESC" ? "高到低（多币优先）" : "低到高"}，点击切换为从${filters.direction === "DESC" ? "低到高" : "高到低"}`
          : "点击按哈夫币从高到低排序（多币优先）",
        ariaLabel: isHaffActive
          ? `哈夫币排序，当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换方向`
          : "哈夫币排序，点击激活",
        onClick: () => {
          if (isHaffActive) {
            navigate(withFilterChange(filters, { direction: filters.direction === "DESC" ? "ASC" : "DESC" }));
          } else {
            navigate(withFilterChange(filters, { sort: "coreQuantity", coreItemId: haffItem?.id ?? null, direction: "DESC" }));
          }
        },
      },
      {
        id: "money",
        label: "价格排序",
        isActive: isMoneyActive,
        direction: isMoneyActive ? filters.direction : null,
        directionText: filters.direction === "ASC" ? "从低到高" : "从高到低",
        title: isMoneyActive
          ? `价格排序：当前从${filters.direction === "ASC" ? "低到高（便宜优先）" : "高到低"}，点击切换为从${filters.direction === "ASC" ? "高到低" : "低到高"}`
          : "点击按价格从低到高排序（便宜优先）",
        ariaLabel: isMoneyActive
          ? `价格排序，当前从${filters.direction === "ASC" ? "低到高" : "高到低"}，点击切换方向`
          : "价格排序，点击激活",
        onClick: () => {
          if (isMoneyActive) {
            navigate(withFilterChange(filters, { direction: filters.direction === "ASC" ? "DESC" : "ASC" }));
          } else {
            navigate(withFilterChange(filters, { sort: "resourceTotal", direction: "ASC", coreItemId: null }));
          }
        },
      },
      {
        id: "ratio",
        label: "比例排序",
        isActive: isRatioActive,
        direction: isRatioActive ? filters.direction : null,
        directionText: filters.direction === "DESC" ? "从高到低" : "从低到高",
        title: isRatioActive
          ? `比例排序：当前从${filters.direction === "DESC" ? "高到低（高性价比优先）" : "低到高"}，点击切换为从${filters.direction === "DESC" ? "低到高" : "高到低"}`
          : "点击按比例从高到低排序（高性价比优先）",
        ariaLabel: isRatioActive
          ? `比例排序，当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换方向`
          : "比例排序，点击激活",
        onClick: () => {
          if (isRatioActive) {
            navigate(withFilterChange(filters, { direction: filters.direction === "DESC" ? "ASC" : "DESC" }));
          } else {
            navigate(withFilterChange(filters, { sort: "ratio", coreItemId: haffItem?.id ?? null, direction: "DESC" }));
          }
        },
      },
      ...(awmItem ? [{
        id: "awm",
        label: "AWM排序",
        isActive: isAwmActive,
        direction: isAwmActive ? filters.direction : null,
        directionText: filters.direction === "DESC" ? "从高到低" : "从低到高",
        title: isAwmActive
          ? `AWM排序：当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换为从${filters.direction === "DESC" ? "低到高" : "高到低"}`
          : "点击按AWM子弹从高到低排序",
        ariaLabel: isAwmActive
          ? `AWM排序，当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换方向`
          : "AWM排序，点击激活",
        onClick: () => {
          if (isAwmActive) {
            navigate(withFilterChange(filters, { direction: filters.direction === "DESC" ? "ASC" : "DESC" }));
          } else {
            navigate(withFilterChange(filters, { sort: "coreQuantity", coreItemId: awmItem.id, direction: "DESC" }));
          }
        },
      }] : []),
      ...(helmetItem ? [{
        id: "helmet",
        label: "六头排序",
        isActive: isHelmetActive,
        direction: isHelmetActive ? filters.direction : null,
        directionText: filters.direction === "DESC" ? "从高到低" : "从低到高",
        title: isHelmetActive
          ? `六头排序：当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换为从${filters.direction === "DESC" ? "低到高" : "高到低"}`
          : "点击按六级头盔从高到低排序",
        ariaLabel: isHelmetActive
          ? `六头排序，当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换方向`
          : "六头排序，点击激活",
        onClick: () => {
          if (isHelmetActive) {
            navigate(withFilterChange(filters, { direction: filters.direction === "DESC" ? "ASC" : "DESC" }));
          } else {
            navigate(withFilterChange(filters, { sort: "coreQuantity", coreItemId: helmetItem.id, direction: "DESC" }));
          }
        },
      }] : []),
      ...(armorItem ? [{
        id: "armor",
        label: "六甲排序",
        isActive: isArmorActive,
        direction: isArmorActive ? filters.direction : null,
        directionText: filters.direction === "DESC" ? "从高到低" : "从低到高",
        title: isArmorActive
          ? `六甲排序：当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换为从${filters.direction === "DESC" ? "低到高" : "高到低"}`
          : "点击按六级护甲从高到低排序",
        ariaLabel: isArmorActive
          ? `六甲排序，当前从${filters.direction === "DESC" ? "高到低" : "低到高"}，点击切换方向`
          : "六甲排序，点击激活",
        onClick: () => {
          if (isArmorActive) {
            navigate(withFilterChange(filters, { direction: filters.direction === "DESC" ? "ASC" : "DESC" }));
          } else {
            navigate(withFilterChange(filters, { sort: "coreQuantity", coreItemId: armorItem.id, direction: "DESC" }));
          }
        },
      }] : []),
    ];
  }, [filters, haffItem?.id, awmItem, helmetItem, armorItem, navigate]);

  return {
    isSmallAmountActive,
    toggleSmallAmount,
    isHighRatioActive,
    toggleHighRatio,
    isLingchenActive,
    toggleLingchen,
    sortTabs,
  };
}

export function useActiveListingTags(
  filters: ListingFilters,
  activeMetadata: PublicListingFilterMetadata | null,
  catalog: PublicCatalog | null,
  gameCode: string | undefined,
  navigate: (next: ListingFilters) => void
): ActiveTag[] {
  return useMemo(() => {
    if (!activeMetadata) return [];
    const tags: ActiveTag[] = [];
    const selected = filters.filters;
    if (filters.q) {
      tags.push({
        id: "q",
        label: `搜索: ${filters.q}`,
        onRemove: () => navigate(withFilterChange(filters, { q: null })),
      });
    }
    const safeBoxField = activeMetadata.fields.find((f) => f.key === "safeBoxCodes");
    for (const code of selected.safeBoxCodes ?? []) {
      const label = safeBoxField?.options?.find((o) => o.value === code)?.label ?? code;
      tags.push({
        id: `safeBox-${code}`,
        label: `安全箱: ${label}`,
        onRemove: () => {
          const next = (selected.safeBoxCodes ?? []).filter((c) => c !== code);
          navigate(withFilterChange(filters, { filters: { ...selected, safeBoxCodes: next.length ? next : undefined } }));
        },
      });
    }
    const gradingField = activeMetadata.fields.find((f) => f.key === "gradingCodes");
    for (const code of selected.gradingCodes ?? []) {
      const label = gradingField?.options?.find((o) => o.value === code)?.label ?? code;
      tags.push({
        id: `grading-${code}`,
        label: `段位: ${label}`,
        onRemove: () => {
          const next = (selected.gradingCodes ?? []).filter((c) => c !== code);
          navigate(withFilterChange(filters, { filters: { ...selected, gradingCodes: next.length ? next : undefined } }));
        },
      });
    }
    const loginField = activeMetadata.fields.find((f) => f.key === "loginMethodCodes");
    for (const code of selected.loginMethodCodes ?? []) {
      const label = loginField?.options?.find((o) => o.value === code)?.label ?? code;
      tags.push({
        id: `login-${code}`,
        label: `登录: ${label}`,
        onRemove: () => {
          const next = (selected.loginMethodCodes ?? []).filter((c) => c !== code);
          navigate(withFilterChange(filters, { filters: { ...selected, loginMethodCodes: next.length ? next : undefined } }));
        },
      });
    }
    if (selected.vitality) {
      tags.push({
        id: "vitality",
        label: `体力 ≥ ${selected.vitality.min}`,
        onRemove: () => navigate(withFilterChange(filters, { filters: { ...selected, vitality: undefined } })),
      });
    }
    if (selected.bear) {
      tags.push({
        id: "bear",
        label: `负重 ≥ ${selected.bear.min}`,
        onRemove: () => navigate(withFilterChange(filters, { filters: { ...selected, bear: undefined } })),
      });
    }
    if (selected.serviceWindow) {
      const sw = selected.serviceWindow;
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      tags.push({
        id: "serviceWindow",
        label: `上号时间: ${fmt(sw.startMinute)}—${sw.crossMidnight ? "次日 " : ""}${fmt(sw.endMinute)}`,
        onRemove: () => navigate(withFilterChange(filters, { filters: { ...selected, serviceWindow: undefined } })),
      });
    }
    for (const region of selected.regions ?? []) {
      tags.push({
        id: `region-${region.province}-${region.city}`,
        label: `${region.province}·${region.city}`,
        onRemove: () => {
          const next = (selected.regions ?? []).filter((r) => r.province !== region.province || r.city !== region.city);
          navigate(withFilterChange(filters, { filters: { ...selected, regions: next.length ? next : undefined } }));
        },
      });
    }
    for (const res of selected.resources ?? []) {
      const item = activeMetadata.items.find((i) => i.id === res.itemId);
      const name = item?.unit === "HAFF_BASE" ? "哈夫币" : resourceItemDisplayName(item, { gameCode, itemId: res.itemId });
      const display = (value: string) => {
        const quantity = item ? resourceInputFromBase(value, item) ?? value : value;
        const unit = item ? resourceUnitShort(item) : "";
        return unit ? `${quantity} ${unit}` : quantity;
      };
      const rangeLabel = res.minQuantity !== undefined && res.maxQuantity !== undefined
        ? res.minQuantity === res.maxQuantity ? display(res.minQuantity) : `${display(res.minQuantity)}–${display(res.maxQuantity)}`
        : res.minQuantity !== undefined ? `≥ ${display(res.minQuantity)}` : `≤ ${display(res.maxQuantity!)}`;
      tags.push({
        id: `resource-${res.itemId}`,
        label: `${name}: ${rangeLabel}`,
        onRemove: () => {
          const next = (selected.resources ?? []).filter((r) => r.itemId !== res.itemId);
          navigate(withFilterChange(filters, { filters: { ...selected, resources: next.length ? next : undefined } }));
        },
      });
    }
    for (const group of selected.skinGroups ?? []) {
      for (const skinId of group.ids) {
        const skinName = catalog?.skins?.find((s) => s.id === skinId)?.name ?? "已选皮肤";
        tags.push({
          id: `skin-${skinId}`,
          label: `皮肤: ${skinName}`,
          onRemove: () => navigate(toggleSkinId(filters, skinGroupKey(group), skinId)),
        });
      }
    }
    return tags;
  }, [activeMetadata, catalog, filters, gameCode, navigate]);
}

export function MarketResultsToolbar({
  lookupNumber,
  feedStatus,
  resultCount,
  currentError,
  listingNotOpen,
  readyToBrowse,
  hasNextCursor,
  refreshing,
  onRefresh,
  compact,
  viewMode,
  onViewModeChange,
}: {
  lookupNumber: boolean;
  feedStatus: string;
  resultCount: number;
  currentError: ResultErrorInfo | null;
  listingNotOpen: boolean;
  readyToBrowse: boolean;
  hasNextCursor: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  compact: boolean;
  viewMode: "list" | "grid";
  onViewModeChange: (mode: "list" | "grid") => void;
}) {
  return (
    <div className="market-results-toolbar">
      <div>
        <h2>{lookupNumber ? "编号查询结果" : "账号列表"}</h2>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {feedStatus === "ready"
            ? (resultCount ? `已加载 ${resultCount} 条` : "暂时没有符合条件的账号")
            : feedStatus === "error"
            ? currentError?.title ?? "结果读取失败"
            : listingNotOpen
            ? "暂未开放选号"
            : readyToBrowse
            ? "正在读取结果"
            : "正在准备账号列表"}
          {hasNextCursor ? " · 还有更多可继续加载" : ""}
        </p>
      </div>
      <div className="market-results-controls">
        <div className="market-results-actions">
          <button
            type="button"
            className="market-toolbar-action"
            onClick={onRefresh}
            disabled={!readyToBrowse || refreshing}
            aria-busy={refreshing || undefined}
            aria-label={refreshing ? "正在刷新结果" : "刷新结果"}
            title={refreshing ? "正在刷新结果" : "刷新结果"}
          >
            <RotateCw size={15} aria-hidden="true" />
            <span className="market-toolbar-action-label">{refreshing ? "刷新中…" : "刷新结果"}</span>
          </button>
        </div>
        {!compact && (
          <div className="market-view-toggle" role="group" aria-label="账号展示方式">
            <button
              type="button"
              aria-pressed={viewMode === "list"}
              onClick={() => onViewModeChange("list")}
            >
              <List size={16} aria-hidden="true" />
              <span>列表</span>
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "grid"}
              onClick={() => onViewModeChange("grid")}
            >
              <LayoutGrid size={16} aria-hidden="true" />
              <span>卡片</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function MarketSortBar({
  isSmallAmountActive,
  onToggleSmallAmount,
  isHighRatioActive,
  onToggleHighRatio,
  isLingchenActive,
  onToggleLingchen,
  sortTabs,
}: {
  isSmallAmountActive: boolean;
  onToggleSmallAmount: () => void;
  isHighRatioActive: boolean;
  onToggleHighRatio: () => void;
  isLingchenActive: boolean;
  onToggleLingchen: () => void;
  sortTabs: MarketSortTab[];
}) {
  return (
    <div className="market-sort-bar" role="toolbar" aria-label="专区筛选与账号排序">
      <div className="market-zone-group" role="group" aria-label="快捷专区">
        <button
          type="button"
          className={`market-zone-btn ${isSmallAmountActive ? "market-zone-btn--active" : ""}`}
          aria-pressed={isSmallAmountActive}
          onClick={onToggleSmallAmount}
          title="哈夫币 ≤ 150M，低门槛快捷租号"
        >
          <Coins size={14} aria-hidden="true" />
          <span>小额专区</span>
        </button>
        <button
          type="button"
          className={`market-zone-btn ${isHighRatioActive ? "market-zone-btn--active" : ""}`}
          aria-pressed={isHighRatioActive}
          onClick={onToggleHighRatio}
          title="按哈夫币/租金比例降序排列"
        >
          <TrendingUp size={14} aria-hidden="true" />
          <span>高比例</span>
        </button>
        <button
          type="button"
          className={`market-zone-btn ${isLingchenActive ? "market-zone-btn--active" : ""}`}
          aria-pressed={isLingchenActive}
          onClick={onToggleLingchen}
          title="服务时段覆盖 00:00–08:00 凌晨档"
        >
          <Moon size={14} aria-hidden="true" />
          <span>凌晨专场</span>
        </button>
      </div>

      <div className="market-sort-divider" aria-hidden="true" />

      <div className="market-sort-items" role="group" aria-label="排序维度">
        {sortTabs.map((tab) => {
          const isDesc = tab.direction === "DESC";
          return (
            <button
              key={tab.id}
              type="button"
              className={`market-sort-tab ${tab.isActive ? "market-sort-tab--active" : ""}`}
              aria-pressed={tab.isActive}
              onClick={tab.onClick}
              title={tab.title}
              aria-label={tab.ariaLabel}
            >
              <span className="market-sort-tab-label">{tab.label}</span>
              {tab.isActive ? (
                <span className={`market-sort-dir-badge market-sort-dir-badge--${isDesc ? "desc" : "asc"}`}>
                  {isDesc ? (
                    <ArrowDown size={12} strokeWidth={2.5} aria-hidden="true" />
                  ) : (
                    <ArrowUp size={12} strokeWidth={2.5} aria-hidden="true" />
                  )}
                  <span>{tab.directionText}</span>
                </span>
              ) : (
                <ArrowUpDown size={12} className="market-sort-icon-neutral" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function MarketActiveChips({
  tags,
  expanded,
  onToggleExpanded,
  onReset,
}: {
  tags: ActiveTag[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onReset: () => void;
}) {
  if (tags.length === 0) return null;
  return (
    <div className="market-active-chips" role="group" aria-label="当前已选筛选条件，可单项移除">
      {(expanded ? tags : tags.slice(0, 6)).map((tag) => (
        <button key={tag.id} type="button" className="market-filter-chip" onClick={tag.onRemove} aria-label={`移除筛选：${tag.label}`}>
          <span>{tag.label}</span><X size={12} aria-hidden="true" />
        </button>
      ))}
      {tags.length > 6 ? (
        <button type="button" className="market-filter-chip market-filter-chip--toggle" aria-expanded={expanded} onClick={onToggleExpanded}>
          {expanded ? "收起" : `还有 ${tags.length - 6} 项`}
        </button>
      ) : null}
      <button type="button" className="market-filter-chip market-filter-chip--clear-all" onClick={onReset} aria-label="清空全部已选筛选条件">
        <span>清空全部</span>
      </button>
    </div>
  );
}
