import { safeReturnTo } from "./safe-return.ts";

export const ACCOUNT_RETURN_KEY = "zzsh:account-return";
const ACTIVE_RETURN_KEY = `${ACCOUNT_RETURN_KEY}:active`;
const ACCOUNT_LIST_STATE_KEY = "zzsh:account-list-state:v1:";
const FALLBACK = "/accounts";
const ACCOUNT_LIST_PATH = "/accounts";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const ACCOUNT_LIST_QUERY_KEYS = new Set(["game", "filters", "q", "sort", "direction", "coreItemId", "cursor", "limit", "view"]);
const RETURN_TTL_MS = 30 * 60 * 1000;

export type AccountReturnSnapshot = { scrollY: number; pageCursors: Array<string | null>; filterKey: string | null; viewMode: "list" | "grid" };
export type AccountListingSessionState = {
  filters: unknown;
  q: string | null;
  sort: string;
  direction: "ASC" | "DESC";
  coreItemId: string | null;
  limit: number;
  viewMode: "list" | "grid";
};
type StoredReturn = { accountId: string; target: string; savedAt: number; snapshot: AccountReturnSnapshot };
type AccountReturnKey = { id: string; storageKey: string };
type StoredListingState = { version: 1; gameId: string; state: AccountListingSessionState };
const returnMemory = new Map<string, StoredReturn>();
const listingMemory = new Map<string, StoredListingState>();
let activeReturnMemory: string | null = null;

function accountReturnKey(accountId: string): AccountReturnKey | null {
  const id = accountId.normalize("NFKC").trim();
  if (!ACCOUNT_ID_PATTERN.test(id)) return null;
  return { id, storageKey: ACCOUNT_RETURN_KEY + ":" + encodeURIComponent(id) };
}

function accountListTarget(value: string | null | undefined): string | undefined {
  const target = safeReturnTo(value, 8192);
  if (!target) return undefined;
  let url: URL;
  try {
    url = new URL(target, "https://zzsh.invalid");
  } catch {
    return undefined;
  }
  if (url.hash) return undefined;
  if (url.pathname === "/") return url.pathname + url.search;
  if (url.pathname !== ACCOUNT_LIST_PATH) return undefined;
  for (const key of url.searchParams.keys()) if (!ACCOUNT_LIST_QUERY_KEYS.has(key)) return undefined;
  return url.pathname + url.search;
}

function normalizeSnapshot(value: unknown): AccountReturnSnapshot {
  if (!value || typeof value !== "object") return { scrollY: 0, pageCursors: [null], filterKey: null, viewMode: "list" };
  const snapshot = value as Partial<AccountReturnSnapshot>;
  const scrollY = Number.isFinite(snapshot.scrollY) ? Math.max(0, Math.min(10_000_000, Math.floor(snapshot.scrollY!))) : 0;
  const pageCursors = Array.isArray(snapshot.pageCursors)
    ? snapshot.pageCursors.slice(0, 50).filter((cursor, index): cursor is string | null => index === 0 && cursor === null || typeof cursor === "string" && CURSOR_PATTERN.test(cursor))
    : [null];
  const filterKey = typeof snapshot.filterKey === "string" && snapshot.filterKey.length <= 8192 ? snapshot.filterKey : null;
  const viewMode = snapshot.viewMode === "grid" ? "grid" : "list";
  return { scrollY, pageCursors: pageCursors.length ? pageCursors : [null], filterKey, viewMode };
}

function readStored(key: AccountReturnKey): StoredReturn | null {
  try {
    const raw = sessionStorage.getItem(key.storageKey);
    if (!raw || raw.length > 64_000) return returnMemory.get(key.id) ?? null;
    const stored = JSON.parse(raw) as Partial<StoredReturn>;
    if (stored.accountId !== key.id || typeof stored.target !== "string" || !Number.isFinite(stored.savedAt) || Date.now() - stored.savedAt! > RETURN_TTL_MS) return null;
    const target = accountListTarget(stored.target);
    if (!target) return null;
    const normalized = { accountId: key.id, target, savedAt: stored.savedAt!, snapshot: normalizeSnapshot(stored.snapshot) };
    returnMemory.set(key.id, normalized);
    return normalized;
  } catch {
    return returnMemory.get(key.id) ?? null;
  }
}

function listingStateKey(gameId: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId)
    ? ACCOUNT_LIST_STATE_KEY + encodeURIComponent(gameId)
    : null;
}

export function readAccountListingState(gameId: string): AccountListingSessionState | null {
  const storageKey = listingStateKey(gameId);
  if (!storageKey) return null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw && raw.length <= 64_000) {
      const stored = JSON.parse(raw) as Partial<StoredListingState>;
      if (stored.version === 1 && stored.gameId === gameId && stored.state && typeof stored.state === "object") {
        const normalized = stored as StoredListingState;
        listingMemory.set(gameId, normalized);
        return normalized.state;
      }
    }
  } catch {
    // Use the in-memory copy when sessionStorage is unavailable.
  }
  return listingMemory.get(gameId)?.state ?? null;
}

export function rememberAccountListingState(gameId: string, state: AccountListingSessionState): void {
  const storageKey = listingStateKey(gameId);
  if (!storageKey) return;
  const stored: StoredListingState = { version: 1, gameId, state };
  listingMemory.set(gameId, stored);
  try {
    const serialized = JSON.stringify(stored);
    if (serialized.length <= 64_000) sessionStorage.setItem(storageKey, serialized);
  } catch {
    // The live list remains fully usable; only refresh persistence is unavailable.
  }
}

export function rememberAccountReturn(
  accountId: string,
  location: { pathname: string; search: string },
  snapshot: AccountReturnSnapshot = { scrollY: 0, pageCursors: [null], filterKey: null, viewMode: "list" },
): void {
  const key = accountReturnKey(accountId);
  const target = accountListTarget(location.pathname + location.search);
  if (!key) return;
  try {
    if (!target) {
      sessionStorage.removeItem(key.storageKey);
      returnMemory.delete(key.id);
      return;
    }
    const stored: StoredReturn = { accountId: key.id, target, savedAt: Date.now(), snapshot: normalizeSnapshot(snapshot) };
    returnMemory.set(key.id, stored);
    activeReturnMemory = key.id;
    const serialized = JSON.stringify(stored);
    if (serialized.length <= 64_000) {
      sessionStorage.setItem(key.storageKey, serialized);
      sessionStorage.setItem(ACTIVE_RETURN_KEY, key.id);
    }
  } catch {
    // Same-tab navigation can still consume the in-memory snapshot.
  }
}

export function readAccountReturn(accountId: string): string | null {
  const key = accountReturnKey(accountId);
  if (!key) return null;
  const stored = readStored(key);
  return stored?.target ?? null;
}

export function consumeAccountReturnSnapshot(location: string, filterKey: string): AccountReturnSnapshot | null {
  const target = accountListTarget(location);
  if (!target) return null;
  try {
    const activeId = sessionStorage.getItem(ACTIVE_RETURN_KEY) ?? activeReturnMemory;
    if (!activeId) return null;
    const key = accountReturnKey(activeId);
    if (!key) {
      sessionStorage.removeItem(ACTIVE_RETURN_KEY);
      activeReturnMemory = null;
      return null;
    }
    const stored = readStored(key);
    if (!stored || stored.target !== target) return null;
    sessionStorage.removeItem(ACTIVE_RETURN_KEY);
    sessionStorage.removeItem(key.storageKey);
    activeReturnMemory = null;
    returnMemory.delete(key.id);
    return stored.snapshot.filterKey === filterKey ? stored.snapshot : null;
  } catch {
    const activeId = activeReturnMemory;
    const key = activeId ? accountReturnKey(activeId) : null;
    const stored = key ? returnMemory.get(key.id) : null;
    if (!key || !stored || stored.target !== target) return null;
    activeReturnMemory = null;
    returnMemory.delete(key.id);
    return stored.snapshot.filterKey === filterKey ? stored.snapshot : null;
  }
}

export function accountReturnTarget(stored: string | null): { href: string; label: string } {
  const target = safeReturnTo(stored, 8192);
  if (!target) return { href: FALLBACK, label: "返回账号列表" };
  if (target === "/" || target.startsWith("/?")) return { href: target, label: "返回首页" };
  const listing = accountListTarget(target);
  return listing ? { href: listing, label: "返回账号列表" } : { href: FALLBACK, label: "返回账号列表" };
}
