import type {
  ListingFilterConditions,
  PublicListingFilterMetadata,
} from "./supply-types.ts";
import { DELTA_GAME_CODE } from "./supply-games.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const QUANTITY_PATTERN = /^(0|[1-9]\d{0,23})$/;
export const LISTING_PAGE_SIZE = 20;
export const LISTING_MAX_SKINS = 50;
export type ListingViewMode = "list" | "grid";
export type ResourceInputMode = "display" | "base";

export type ListingRequestTargetKind = "page" | "webBff" | "apiBff" | "api";
export type ListingRequestTarget = {
  kind: ListingRequestTargetKind;
  path: string;
  bytes: number;
  limit: number;
};

const listingRequestPrefixes: Array<{ kind: Exclude<ListingRequestTargetKind, "page">; prefix: string }> = [
  { kind: "webBff", prefix: "/api/supply/listings?" },
  { kind: "apiBff", prefix: "/api/bff/user/supply/listings?" },
  { kind: "api", prefix: "/api/v1/supply/listings?" },
];
const listingRequestTargetLabels: Record<ListingRequestTargetKind, string> = {
  page: "分享地址",
  webBff: "Web BFF 请求",
  apiBff: "用户 BFF 请求",
  api: "原生 API 请求",
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export type ListingFilters = {
  game: string | null;
  filters: ListingFilterConditions;
  q: string | null;
  sort: string;
  direction: "ASC" | "DESC";
  coreItemId: string | null;
  cursor: string | null;
  limit: number;
  viewMode: ListingViewMode;
};

function text(value: string | string[] | undefined): string | null {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" ? single : null;
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function values(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id))].sort().slice(0, maximum);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanLabel(value: unknown, maximum = 80): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").trim();
  return cleaned && cleaned.length <= maximum && !/[\u0000-\u001f\u007f]/.test(cleaned)
    ? cleaned
    : null;
}

export function normalizeListingQuery(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

export function normalizeListingConditions(value: unknown): ListingFilterConditions {
  if (!record(value)) return {};
  const output: ListingFilterConditions = {};

  if (Array.isArray(value.resources)) {
    const seen = new Set<string>();
    output.resources = value.resources.filter(record).sort((left, right) => String(left.itemId ?? "").localeCompare(String(right.itemId ?? ""))).flatMap((entry) => {
      if (!record(entry) || !id(entry.itemId) || seen.has(entry.itemId)) return [];
      if (entry.minQuantity !== undefined && (typeof entry.minQuantity !== "string" || !QUANTITY_PATTERN.test(entry.minQuantity))) return [];
      if (entry.maxQuantity !== undefined && (typeof entry.maxQuantity !== "string" || !QUANTITY_PATTERN.test(entry.maxQuantity))) return [];
      if (entry.minQuantity === undefined && entry.maxQuantity === undefined) return [];
      if (entry.minQuantity !== undefined && entry.maxQuantity !== undefined && BigInt(entry.minQuantity) > BigInt(entry.maxQuantity)) return [];
      seen.add(entry.itemId);
      const res: { itemId: string; minQuantity?: string; maxQuantity?: string } = { itemId: entry.itemId };
      if (entry.minQuantity !== undefined) res.minQuantity = entry.minQuantity;
      if (entry.maxQuantity !== undefined) res.maxQuantity = entry.maxQuantity;
      return [res as any];
    }).sort((left, right) => left.itemId.localeCompare(right.itemId)).slice(0, 16);
    if (output.resources.length === 0) delete output.resources;
  }

  for (const key of ["safeBoxCodes", "gradingCodes", "loginMethodCodes"] as const) {
    const selected = values(value[key], 50);
    if (selected.length) output[key] = selected;
  }

  for (const key of ["vitality", "bear"] as const) {
    const entry = value[key];
    if (record(entry) && Number.isSafeInteger(entry.min) && (entry.min as number) >= 0 && (entry.min as number) <= 99) {
      output[key] = { min: entry.min as number };
    }
  }

  if (Array.isArray(value.regions)) {
    const seen = new Set<string>();
    output.regions = value.regions.flatMap((entry) => {
      if (!record(entry)) return [];
      const province = cleanLabel(entry.province);
      const city = cleanLabel(entry.city);
      const key = province && city ? `${province}\u0000${city}` : "";
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [{ province: province!, city: city! }];
    }).sort((left, right) => left.province.localeCompare(right.province) || left.city.localeCompare(right.city)).slice(0, 20);
    if (output.regions.length === 0) delete output.regions;
  }

  if (record(value.serviceWindow)) {
    const { startMinute, endMinute, crossMidnight, timezone } = value.serviceWindow;
    const validMinutes = Number.isInteger(startMinute) && Number.isInteger(endMinute) &&
      (startMinute as number) >= 0 && (startMinute as number) <= 1439 &&
      (endMinute as number) >= 0 && (endMinute as number) <= 1440;
    if (validMinutes && (startMinute !== endMinute || (startMinute === 0 && endMinute === 1440)) &&
      timezone === "Asia/Shanghai" && crossMidnight === ((endMinute as number) < (startMinute as number))) {
      output.serviceWindow = {
        startMinute: startMinute as number,
        endMinute: endMinute as number,
        crossMidnight: crossMidnight as boolean,
        timezone: "Asia/Shanghai",
      };
    }
  }

  if (Array.isArray(value.skinGroups)) {
    const seenCategories = new Set<string>();
    const seenSkins = new Set<string>();
    let remaining = LISTING_MAX_SKINS;
    const groups = value.skinGroups.filter(record).sort((left, right) => String(left.categoryId ?? "").localeCompare(String(right.categoryId ?? ""))).flatMap((entry) => {
      if (!record(entry) || !id(entry.categoryId) || seenCategories.has(entry.categoryId)) return [];
      const match: "ANY" | "ALL" = entry.match === "ALL" ? "ALL" : "ANY";
      const selected = values(entry.ids, remaining).filter((skinId) => !seenSkins.has(skinId));
      if (selected.length === 0) return [];
      seenCategories.add(entry.categoryId);
      selected.forEach((skinId) => seenSkins.add(skinId));
      remaining -= selected.length;
      return [{ categoryId: entry.categoryId, ids: selected, match }];
    }).sort((left, right) => left.categoryId.localeCompare(right.categoryId)).slice(0, 8);
    if (groups.length) output.skinGroups = groups;
  }

  return output;
}

function conditionsFromUrl(value: string | null): ListingFilterConditions {
  if (!value || value.length > 64_000) return {};
  try {
    return normalizeListingConditions(JSON.parse(value));
  } catch {
    return {};
  }
}

export function parseListingFilters(input: Record<string, string | string[] | undefined>): ListingFilters {
  const game = text(input.game);
  const cursor = text(input.cursor);
  const limit = Number(text(input.limit) ?? LISTING_PAGE_SIZE);
  const sort = text(input.sort);
  const coreItemId = text(input.coreItemId);
  const direction = text(input.direction);
  return {
    game: game && id(game) ? game : null,
    filters: conditionsFromUrl(text(input.filters)),
    q: normalizeListingQuery(text(input.q)),
    sort: sort && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(sort) ? sort : "latest",
    direction: direction === "ASC" ? "ASC" : "DESC",
    coreItemId: coreItemId && id(coreItemId) ? coreItemId : null,
    cursor: cursor && CURSOR_PATTERN.test(cursor) ? cursor : null,
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : LISTING_PAGE_SIZE,
    viewMode: text(input.view) === "grid" ? "grid" : "list",
  };
}

export function serializeListingConditions(filters: ListingFilterConditions): string {
  return JSON.stringify(normalizeListingConditions(filters));
}

export function listingQuery(
  filters: ListingFilters,
  metadata?: PublicListingFilterMetadata | null,
): URLSearchParams {
  const query = new URLSearchParams();
  query.set("queryVersion", "2");
  if (filters.game) query.set("gameId", filters.game);
  if (metadata?.filterRevision) query.set("filterRevision", metadata.filterRevision);
  if (metadata?.catalogRevision) query.set("catalogRevision", metadata.catalogRevision);
  if (metadata?.ruleReleaseId) query.set("ruleReleaseId", metadata.ruleReleaseId);
  query.set("sort", filters.sort);
  query.set("direction", filters.direction);
  if (filters.sort === "coreQuantity" && filters.coreItemId) query.set("coreItemId", filters.coreItemId);
  if (Object.keys(filters.filters).length) {
    query.set("filters", serializeListingConditions(filters.filters));
  }
  if (filters.q) query.set("q", filters.q);
  query.set("limit", String(filters.limit));
  if (filters.cursor) query.set("cursor", filters.cursor);
  return query;
}

export function listingRequestTargets(
  filters: ListingFilters,
  metadata?: PublicListingFilterMetadata | null,
  cursor: string | null = filters.cursor,
): ListingRequestTarget[] {
  const query = listingQuery({ ...filters, cursor }, metadata).toString();
  const page = listingFiltersUrl(filters);
  const limit = metadata?.limits.urlBytes ?? 8192;
  return [
    { kind: "page", path: page, bytes: utf8Bytes(page), limit },
    ...listingRequestPrefixes.map(({ kind, prefix }) => {
      const path = prefix + query;
      return { kind, path, bytes: utf8Bytes(path), limit };
    }),
  ];
}

export function listingRequestBudget(
  filters: ListingFilters,
  metadata?: PublicListingFilterMetadata | null,
  cursor: string | null = filters.cursor,
): ListingRequestTarget | null {
  return listingRequestTargets(filters, metadata, cursor).find((target) => target.bytes > target.limit) ?? null;
}

export function listingRequestBudgetMessage(target: ListingRequestTarget): string {
  return `${listingRequestTargetLabels[target.kind]}为 ${target.bytes} 字节，超过 ${target.limit} 字节限制，请减少部分筛选条件后重试。`;
}

export class ListingRequestBudgetError extends Error {
  readonly status = 400;
  readonly code = "LISTING_URL_TOO_LONG";
  readonly details = [{ path: "url", code: "INVALID_FIELD" }];
  readonly target: ListingRequestTarget;

  constructor(target: ListingRequestTarget) {
    super(listingRequestBudgetMessage(target));
    this.target = target;
    this.name = "ListingRequestBudgetError";
  }
}

export function listingFiltersUrl(filters: ListingFilters): string {
  const query = new URLSearchParams();
  if (filters.game) query.set("game", filters.game);
  if (filters.q) query.set("q", filters.q);
  if (Object.keys(filters.filters).length) query.set("filters", serializeListingConditions(filters.filters));
  if (filters.sort !== "latest") query.set("sort", filters.sort);
  if (filters.direction !== "DESC") query.set("direction", filters.direction);
  if (filters.sort === "coreQuantity" && filters.coreItemId) query.set("coreItemId", filters.coreItemId);
  if (filters.viewMode === "grid") query.set("view", "grid");
  return "/accounts" + (query.size ? "?" + query.toString() : "");
}

export function withFilterChange(filters: ListingFilters, patch: Partial<ListingFilters>): ListingFilters {
  return { ...filters, ...patch, cursor: null };
}

export function listingFilterKey(filters: ListingFilters, metadata?: PublicListingFilterMetadata | null): string {
  const query = listingQuery({ ...filters, cursor: null }, metadata);
  query.delete("cursor");
  return query.toString();
}

export function toggleCode(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export function toggleSkinId(filters: ListingFilters, categoryId: string, skinId: string): ListingFilters {
  const groups = [...(filters.filters.skinGroups ?? [])];
  const index = groups.findIndex((group) => group.categoryId === categoryId);
  const current = groups[index];
  const ids = toggleCode(current?.ids ?? [], skinId).slice(0, LISTING_MAX_SKINS);
  if (index >= 0) {
    if (ids.length) groups[index] = { ...current!, ids };
    else groups.splice(index, 1);
  } else if (ids.length) groups.push({ categoryId, ids, match: "ANY" });
  const total = groups.reduce((sum, group) => sum + group.ids.length, 0);
  if (total > LISTING_MAX_SKINS) return filters;
  return withFilterChange(filters, { filters: { ...filters.filters, skinGroups: groups.length ? groups : undefined } });
}

export function activeListingFilterCount(filters: ListingFilters): number {
  const conditions = normalizeListingConditions(filters.filters);
  return (conditions.resources?.length ?? 0) +
    (conditions.safeBoxCodes?.length ?? 0) +
    (conditions.gradingCodes?.length ?? 0) +
    (conditions.loginMethodCodes?.length ?? 0) +
    Number(Boolean(conditions.vitality)) + Number(Boolean(conditions.bear)) +
    (conditions.regions?.length ?? 0) + Number(Boolean(conditions.serviceWindow)) +
    (conditions.skinGroups?.reduce((sum, group) => sum + group.ids.length, 0) ?? 0) +
    Number(Boolean(filters.q));
}

function enabledField(metadata: PublicListingFilterMetadata, key: string) {
  return metadata.fields.find((field) => field.key === key && field.enabled);
}

function within(value: string, min: string, max: string): boolean {
  try {
    const candidate = BigInt(value);
    return candidate >= BigInt(min) && candidate <= BigInt(max);
  } catch {
    return false;
  }
}

export function reconcileListingFilters(
  filters: ListingFilters,
  metadata: PublicListingFilterMetadata,
  allowedSkinIds?: ReadonlySet<string>,
): ListingFilters {
  const conditions = normalizeListingConditions(filters.filters);
  const resourcesField = enabledField(metadata, "resources");
  const resourceRules = new Map((resourcesField?.items ?? []).map((item) => [item.itemId, item]));
  const rangeSupported = metadata.resourceQuantityRange === true;
  const resources = (conditions.resources ?? []).flatMap((entry) => {
    const rule = resourceRules.get(entry.itemId);
    if (!rule) return [];
    const validMin = entry.minQuantity !== undefined && within(entry.minQuantity, rule.min, rule.max);
    const validMax = rangeSupported && entry.maxQuantity !== undefined && within(entry.maxQuantity, rule.min, rule.max);
    if (!validMin && !validMax) return [];
    const nextItem: { itemId: string; minQuantity?: string; maxQuantity?: string } = { itemId: entry.itemId };
    if (validMin) nextItem.minQuantity = entry.minQuantity;
    if (validMax) nextItem.maxQuantity = entry.maxQuantity;
    return [nextItem as any];
  });
  const pickOptions = (key: string, selected: string[] | undefined) => {
    const allowed = new Set((enabledField(metadata, key)?.options ?? []).map((option) => option.value));
    return (selected ?? []).filter((value) => allowed.has(value));
  };
  const vitalityLevels = new Set(enabledField(metadata, "vitality")?.levels ?? []);
  const bearLevels = new Set(enabledField(metadata, "bear")?.levels ?? []);
  const regionRules = new Set((enabledField(metadata, "regions")?.regions ?? []).map(({ province, city }) => `${province}\u0000${city}`));
  const allowedCategories = new Set((enabledField(metadata, "skinGroups")?.categoryIds ?? []).filter((categoryId) => metadata.categories.some((category) => category.id === categoryId)));
  let skinBudget = Math.min(LISTING_MAX_SKINS, metadata.limits.skinIds);
  const skinGroups = (conditions.skinGroups ?? []).filter((group) => allowedCategories.has(group.categoryId)).slice(0, Math.min(8, metadata.limits.skinGroups)).flatMap((group) => {
    const ids = group.ids.filter((skinId) => (!allowedSkinIds || allowedSkinIds.has(skinId)) && skinBudget > 0).slice(0, skinBudget);
    skinBudget -= ids.length;
    return ids.length ? [{ ...group, ids }] : [];
  });
  const regions = (conditions.regions ?? []).filter(({ province, city }) => regionRules.has(`${province}\u0000${city}`));
  const safeBoxCodes = pickOptions("safeBoxCodes", conditions.safeBoxCodes);
  const gradingCodes = pickOptions("gradingCodes", conditions.gradingCodes);
  const loginMethodCodes = pickOptions("loginMethodCodes", conditions.loginMethodCodes);

  const nextConditions: ListingFilterConditions = {
    ...(resources.length ? { resources } : {}),
    ...(safeBoxCodes.length ? { safeBoxCodes } : {}),
    ...(gradingCodes.length ? { gradingCodes } : {}),
    ...(loginMethodCodes.length ? { loginMethodCodes } : {}),
    ...(conditions.vitality && vitalityLevels.has(conditions.vitality.min) ? { vitality: conditions.vitality } : {}),
    ...(conditions.bear && bearLevels.has(conditions.bear.min) ? { bear: conditions.bear } : {}),
    ...(regions.length ? { regions } : {}),
    ...(conditions.serviceWindow && enabledField(metadata, "serviceWindow") ? { serviceWindow: conditions.serviceWindow } : {}),
    ...(skinGroups.length ? { skinGroups } : {}),
  };

  const sort = metadata.sorts.some((entry) => entry.enabled && entry.key === filters.sort)
    ? filters.sort
    : metadata.defaultSort.sort;
  const directions = metadata.directions.length ? metadata.directions : [metadata.defaultSort.direction];
  const direction = directions.includes(filters.direction) ? filters.direction : metadata.defaultSort.direction;
  const sortConfig = metadata.sorts.find((entry) => entry.key === sort);
  const coreItemId = sort === "coreQuantity"
    ? (sortConfig?.itemIds?.includes(filters.coreItemId ?? "") ? filters.coreItemId : sortConfig?.itemIds?.[0] ?? null)
    : null;
  const limit = Math.max(1, Math.min(filters.limit, metadata.limits.limit, 50));
  const next: ListingFilters = {
    ...filters,
    game: metadata.gameId,
    filters: nextConditions,
    sort,
    direction,
    coreItemId,
    limit,
  };
  if (listingFilterKey(next) !== listingFilterKey(filters)) next.cursor = null;
  return next;
}

export function regionProvinceSelectionState(
  selectedRegions: Array<{ province: string; city: string }>,
  province: string,
  cities: string[],
): "none" | "partial" | "all" {
  if (!cities.length) return "none";
  const selectedCities = new Set(
    selectedRegions.filter((entry) => entry.province === province).map((entry) => entry.city)
  );
  let count = 0;
  for (const city of cities) {
    if (selectedCities.has(city)) count++;
  }
  if (count === 0) return "none";
  if (count === cities.length) return "all";
  return "partial";
}

export function toggleRegionSelection(
  filters: ListingFilters,
  province: string,
  cities: string[],
  metadata: PublicListingFilterMetadata,
  mode: "province" | "city",
  targetCity?: string,
): { filters: ListingFilters; error: string | null } {
  const current = filters.filters.regions ?? [];
  let next: Array<{ province: string; city: string }>;

  if (mode === "province") {
    const state = regionProvinceSelectionState(current, province, cities);
    if (state === "all") {
      next = current.filter((entry) => entry.province !== province);
    } else {
      const other = current.filter((entry) => entry.province !== province);
      const added = cities.map((city) => ({ province, city }));
      next = [...other, ...added];
    }
  } else {
    if (!targetCity) return { filters, error: null };
    const exists = current.some((entry) => entry.province === province && entry.city === targetCity);
    if (exists) {
      next = current.filter((entry) => !(entry.province === province && entry.city === targetCity));
    } else {
      next = [...current, { province, city: targetCity }];
    }
  }

  const maxRegions = metadata.limits?.regions ?? 20;
  if (next.length > maxRegions) {
    return { filters, error: `最多可选 ${maxRegions} 个地区` };
  }

  const candidateFilters: ListingFilters = {
    ...filters,
    filters: {
      ...filters.filters,
      regions: next.length ? next : undefined,
    },
    cursor: null,
  };

  const maxUrlBytes = metadata.limits?.urlBytes ?? 8192;
  const url = listingFiltersUrl(candidateFilters);
  if (new TextEncoder().encode(url).length > maxUrlBytes) {
    return { filters, error: "筛选条件过长，请减少已选地区" };
  }

  return { filters: candidateFilters, error: null };
}

function decimalBaseUnits(value: string, multiplier: bigint): string {
  const normalized = value.normalize("NFKC").replace(/[\s,]/g, "");
  const match = normalized.match(/^(\d{1,24})(?:\.(\d{1,6}))?$/);
  if (!match) throw new Error("请输入非负整数或最多 6 位小数。");
  const fraction = match[2] ?? "";
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(match[1]! + fraction) * multiplier;
  if (numerator % denominator !== 0n) throw new Error("该数量无法精确换算为平台基础单位。");
  const result = numerator / denominator;
  if (result > 999999999999999999999999n) throw new Error("数量超出平台允许范围。");
  return result.toString();
}

export function resourceInputToBase(value: string, item: { unit: string; code?: string }, mode: ResourceInputMode = "display"): string {
  if (mode === "base") return decimalBaseUnits(value, 1n);
  if (item.unit === "HAFF_BASE") return decimalBaseUnits(value, 1_000_000n);
  if (item.unit === "ROUND" && item.code === "df_billable_level6_bullet") return decimalBaseUnits(value, 60n);
  return decimalBaseUnits(value, 1n);
}

export function validateResourceQuantityInput(
  value: string,
  item: { unit: string; code?: string },
  bounds: { min: string; max: string },
  mode: ResourceInputMode = "display",
): string {
  const isBullets = item.unit === "ROUND" && item.code === "df_billable_level6_bullet";
  if (mode === "display" && isBullets) {
    const minGroup = (BigInt(bounds.min) + 59n) / 60n;
    const maxGroup = BigInt(bounds.max) / 60n;
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(`请输入 ${minGroup} 至 ${maxGroup} 组。`);
    }
    const groups = BigInt(value);
    if (groups < minGroup || groups > maxGroup) {
      throw new Error(`请输入 ${minGroup} 至 ${maxGroup} 组。`);
    }
    return (groups * 60n).toString();
  }
  const normalized = value.normalize("NFKC").trim();
  const base = resourceInputToBase(normalized, item, mode);
  const min = BigInt(bounds.min);
  const max = BigInt(bounds.max);
  const actual = BigInt(base);
  if (actual < min || actual > max) {
    const minDisplay = resourceInputFromBase(bounds.min, item, mode) ?? bounds.min;
    const maxDisplay = resourceInputFromBase(bounds.max, item, mode) ?? bounds.max;
    const unit = resourceUnitShort(item, mode);
    throw new Error(`请输入 ${minDisplay} 至 ${maxDisplay} ${unit}。`);
  }
  return base;
}

export function resourceInputFromBase(value: string, item: { unit: string; code?: string }, mode: ResourceInputMode = "display"): string | null {
  if (!/^\d+$/.test(value)) return null;
  const base = BigInt(value);
  if (mode === "base") return base.toString();
  let divisor = 1n;
  if (item.unit === "HAFF_BASE") divisor = 1_000_000n;
  else if (item.unit === "ROUND" && item.code === "df_billable_level6_bullet") divisor = 60n;
  const whole = base / divisor;
  const remainder = base % divisor;
  if (remainder === 0n) return whole.toString();
  if (divisor === 60n) return null;
  const places = divisor === 1_000_000n ? 6 : 1;
  const fractional = remainder.toString().padStart(places, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

export function resourceUnitShort(item: { unit: string; code?: string }, mode: ResourceInputMode = "display"): string {
  if (mode === "base") return item.unit === "ROUND" ? "发" : item.unit === "HAFF_BASE" ? "基础单位" : unitLabel(item.unit);
  if (item.unit === "HAFF_BASE") return "M";
  if (item.unit === "ROUND" && item.code === "df_billable_level6_bullet") return "组";
  return unitLabel(item.unit);
}

export function resourceUnitHint(item: { unit: string; code?: string }, mode: ResourceInputMode = "display"): string | null {
  if (mode === "base") return null;
  if (item.unit === "HAFF_BASE") return "1 M = 1,000,000 哈夫币";
  if (item.unit === "ROUND" && item.code === "df_billable_level6_bullet") return "1 组 = 60 发";
  return null;
}

function unitLabel(unit: string): string {
  return ({ HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件", DAY: "天" } as Record<string, string>)[unit] ?? unit;
}

export const SERVICE_WINDOW_STEP_MINUTES = 30;
export const SERVICE_WINDOW_START_OPTIONS: readonly number[] = Array.from({ length: 48 }, (_, index) => index * SERVICE_WINDOW_STEP_MINUTES);
export const SERVICE_WINDOW_END_OPTIONS: readonly number[] = [...SERVICE_WINDOW_START_OPTIONS, 1440];

export function formatServiceWindowMinute(minute: number): string {
  if (minute === 1440) return "24:00";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export type ServiceWindowSelection = NonNullable<ListingFilterConditions["serviceWindow"]>;

export function buildServiceWindow(
  startMinute: number | null,
  endMinute: number | null,
): { ok: true; value: ServiceWindowSelection } | { ok: false; reason: "missing" | "equal" } {
  if (startMinute === null || endMinute === null) return { ok: false, reason: "missing" };
  if (!SERVICE_WINDOW_START_OPTIONS.includes(startMinute) || !SERVICE_WINDOW_END_OPTIONS.includes(endMinute)) return { ok: false, reason: "missing" };
  if (startMinute === endMinute) return { ok: false, reason: "equal" };
  return {
    ok: true,
    value: {
      startMinute,
      endMinute,
      crossMidnight: endMinute < startMinute,
      timezone: "Asia/Shanghai",
    },
  };
}

export function describeServiceWindow(window: { startMinute: number; endMinute: number; crossMidnight: boolean }): string {
  const start = formatServiceWindowMinute(window.startMinute);
  const end = formatServiceWindowMinute(window.endMinute);
  if (window.startMinute === 0 && window.endMinute === 1440) return `${start}–${end}（全天）`;
  if (window.crossMidnight) return `${start}–${end}（跨日）`;
  return `${start}–${end}`;
}

export function resourceItemDisplayName(
  item: { name?: string; code?: string } | undefined,
  context: { gameCode?: string; itemId?: string } = {},
): string {
  if (item?.code === "df_billable_level6_bullet") return "6级子弹";
  if (!item?.code && context.gameCode === DELTA_GAME_CODE && item?.name === "六级子弹") return "6级子弹";
  return item?.name || (context.itemId ? `未确认（代码 ${context.itemId}）` : "未确认");
}
