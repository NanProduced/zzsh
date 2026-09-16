import { safeReturnTo } from "./safe-return.ts";

export const ACCOUNT_RETURN_KEY = "zzsh:account-return";
const FALLBACK = "/accounts";
const ACCOUNT_LIST_PATH = "/accounts";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_LIST_QUERY_KEYS = new Set(["game", "item", "minQty", "skinId", "match", "q", "cursor", "limit"]);

type AccountReturnKey = { id: string; storageKey: string };

function accountReturnKey(accountId: string): AccountReturnKey | null {
  const id = accountId.normalize("NFKC").trim();
  if (!ACCOUNT_ID_PATTERN.test(id)) return null;
  return { id, storageKey: ACCOUNT_RETURN_KEY + ":" + encodeURIComponent(id) };
}

// This is stricter than safeReturnTo: detail back-navigation only accepts the listing route and its supported filters.
function accountListTarget(value: string | null | undefined): string | undefined {
  const target = safeReturnTo(value);
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
  for (const key of url.searchParams.keys()) {
    if (!ACCOUNT_LIST_QUERY_KEYS.has(key)) return undefined;
  }
  return url.pathname + url.search;
}

export function rememberAccountReturn(accountId: string, location: { pathname: string; search: string }): void {
  const key = accountReturnKey(accountId);
  const target = accountListTarget(location.pathname + location.search);
  if (!key) return;
  try {
    // sessionStorage is tab-scoped; the object suffix prevents different accounts in one tab from colliding.
    if (target) sessionStorage.setItem(key.storageKey, JSON.stringify({ accountId: key.id, target }));
    else sessionStorage.removeItem(key.storageKey);
  } catch {
    // Private browsing may reject storage; the detail page falls back to the account list.
  }
}

export function readAccountReturn(accountId: string): string | null {
  const key = accountReturnKey(accountId);
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key.storageKey);
    if (!raw) return null;
    const record = JSON.parse(raw) as { accountId?: unknown; target?: unknown };
    if (record.accountId !== key.id || typeof record.target !== "string") return null;
    return accountListTarget(record.target) ?? null;
  } catch {
    return null;
  }
}

export function accountReturnTarget(stored: string | null): { href: string; label: string } {
  const target = safeReturnTo(stored);
  if (!target) return { href: FALLBACK, label: "返回账号列表" };
  if (target === "/" || target.startsWith("/?")) return { href: target, label: "返回首页" };
  const listing = accountListTarget(target);
  return listing ? { href: listing, label: "返回账号列表" } : { href: FALLBACK, label: "返回账号列表" };
}
