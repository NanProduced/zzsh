import type { ListingFilters } from "@/lib/listing-filters";
import type { PublicCatalog, PublicListingFilterMetadata } from "@/lib/supply-types";

export type MarketSelectOption = { value: string; label: string };

export type ResourceRange = { minQuantity?: string; maxQuantity?: string };

export type MarketFilterControlsProps = {
  filters: ListingFilters;
  metadata: PublicListingFilterMetadata;
  gameCode?: string;
  catalog: PublicCatalog | null;
  catalogStatus: "idle" | "loading" | "ready" | "error";
  skinSearch: string;
  skinOwner: string;
  skinRarity: string;
  activeSkinCategoryId: string;
  skinSearchCatalog: PublicCatalog | null;
  skinSearchStatus: "idle" | "loading" | "ready" | "error";
  onChange: (next: ListingFilters) => void;
  onRetryCatalog: () => void;
  onRetrySkinSearch: () => void;
  onSkinSearchChange: (value: string) => void;
  onSkinOwnerChange: (value: string) => void;
  onSkinRarityChange: (value: string) => void;
  onSkinCategoryChange: (categoryId: string) => void;
  onLoadMoreSkins: () => void;
  loadingMoreSkins: boolean;
  /** Bumped by 清空筛选; clears child drafts, errors and pending debounce timers even when the committed count is 0. */
  resetToken?: number;
  /** Mobile drawer: register a flush that commits a pending draft now and reports whether it was valid. */
  flushDrafts?: (fn: () => boolean) => () => void;
  mobile?: boolean;
};

export type Props = MarketFilterControlsProps;
