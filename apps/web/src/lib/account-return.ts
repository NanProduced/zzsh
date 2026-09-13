import { safeReturnTo } from "./safe-return.ts";

export const ACCOUNT_RETURN_KEY = "zzsh:account-return";
const FALLBACK = "/accounts";

export function rememberAccountReturn(location: { pathname: string; search: string }): void {
  const target = safeReturnTo(location.pathname + location.search);
  if (!target) return;
  try {
    sessionStorage.setItem(ACCOUNT_RETURN_KEY, target);
  } catch {
    // Private browsing may reject storage; the detail page falls back to the account list.
  }
}
export function readAccountReturn(): string | null {
  try {
    return sessionStorage.getItem(ACCOUNT_RETURN_KEY);
  } catch {
    return null;
  }
}
export function accountReturnTarget(stored: string | null): { href: string; label: string } {
  const target = safeReturnTo(stored);
  if (!target) return { href: FALLBACK, label: "返回账号列表" };
  if (target === "/" || target.startsWith("/?")) return { href: target, label: "返回首页" };
  return { href: target, label: "返回账号列表" };
}
