/**
 * 侧栏入口的唯一活动判定。
 *
 * 规则按「路由最具体匹配」由深到浅，第一条命中即为唯一活动入口：
 * 1. 路径去掉尾斜杠后完全相等 → 更具体（同时带 query 的入口优先于只按路径匹配的入口）；
 * 2. 有 query 的入口：路径相等且声明的 query 键全部命中当前地址（`/settings?section=security` 只在安全分区点亮）；
 * 3. 有 query 的入口：当前路径以它声明路径为前缀（详情页落在自己模块的入口上）；
 * 4. 无 query 的入口：路径相等（同深度时更长的声明路径更具体）；
 * 5. 无 query 的入口：当前路径以它声明路径为前缀（`/orders/:id` 点亮「订单」）。
 *
 * 旧 URL 与旧 query 入口全部保留：`/account` 与 `/settings?section=security` 都能打开安全页，
 * 但在任一状态下只有一个入口点亮，搜索与标签命名沿用同一套名称。
 */

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeNavPath(path: string): string {
  let value = (path.split("?")[0] ?? "").replace(/\/+$/, "");
  value = safeDecode(value).replace(/\/+$/, "");
  if (!value) return "/";
  return value;
}

export function sanitizeLocalHref(href: string): string {
  const value = (href || "/").trim();
  if (!/^\/[^/\\]/.test(value) || value.startsWith("//")) return "/";
  if (/[\u0000-\u001f\\]/.test(value) || value.includes("://")) return "/";
  return value;
}

/** 同级独立页面不能被父级前缀吞掉：有自己入口与权限的同级页不算父级的详情。 */
const SIBLING_ROUTES: Record<string, readonly string[]> = {
  "/settings": ["/settings?section=security"],
  "/finance": ["/finance/period"],
};

function blockedBySibling(pathname: string, current: string): boolean {
  return (SIBLING_ROUTES[pathname] ?? []).some((sibling) => (sibling.split("?")[0] ?? "") === current);
}

export function splitNavPath(path: string): { pathname: string; query: URLSearchParams } {
  const [rawPathname = "", rawSearch = ""] = path.split("?");
  const pathname = normalizeNavPath(rawPathname);
  const encoded = new URLSearchParams(rawSearch);
  const query = new URLSearchParams();
  for (const [key, value] of encoded.entries()) {
    query.append(key, safeDecode(value));
  }
  return { pathname, query };
}

/** 入口声明的 query 键必须全部命中当前地址，其余筛选、分页、来源回链键不受影响。 */
export function navQueryMatches(item: URLSearchParams, current: URLSearchParams): boolean {
  for (const [key, value] of item.entries()) {
    if (current.get(key) !== value) return false;
  }
  return true;
}

export type NavLocation = { pathname: string; search?: string };

export function navEntryRank(
  path: string,
  location: NavLocation,
): { exact: boolean; carriesQuery: boolean; depth: number } | null {
  const { pathname, query } = splitNavPath(path);
  const href = sanitizeLocalHref(`${location.pathname}${location.search ?? ""}`);
  const [currentPath = "/", currentSearch = ""] = href.split("?");
  const current = normalizeNavPath(currentPath);
  const carriesQuery = query.size > 0;

  if (current === pathname) {
    if (carriesQuery && !navQueryMatches(query, new URLSearchParams(currentSearch))) return null;
    return { exact: true, carriesQuery, depth: pathname.length };
  }
  if (!carriesQuery && current.startsWith(`${pathname}/`)) {
    if (blockedBySibling(pathname, current)) return null;
    return { exact: false, carriesQuery, depth: pathname.length };
  }
  return null;
}

export function navEntryIsActive(path: string, location: NavLocation): boolean {
  return navEntryRank(path, location) !== null;
}

const rankScore = (rank: { exact: boolean; carriesQuery: boolean; depth: number }) =>
  [Number(rank.exact), Number(rank.carriesQuery), rank.depth] as const;

/** 返回 a 是否严格比 b 更具体。 */
function isMoreSpecific(
  a: { exact: boolean; carriesQuery: boolean; depth: number },
  b: { exact: boolean; carriesQuery: boolean; depth: number },
): boolean {
  const left = rankScore(a);
  const right = rankScore(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

/** 在一组入口路径里选出唯一活动入口；全部未命中时返回 null（不误点亮别的模块）。 */
export function activeNavPath(paths: readonly (string | undefined)[], location: NavLocation): string | null {
  let winner: string | null = null;
  let winnerRank: { exact: boolean; carriesQuery: boolean; depth: number } | null = null;
  for (const path of paths) {
    if (!path) continue;
    const rank = navEntryRank(path, location);
    if (!rank) continue;
    if (!winnerRank || isMoreSpecific(rank, winnerRank)) {
      winner = path;
      winnerRank = rank;
    }
  }
  return winner;
}

export function navItemPaths(items: readonly { path?: string; items?: readonly { path?: string }[] }[]): string[] {
  return items.flatMap((item) => [...(item.path ? [item.path] : []), ...navItemPaths(item.items ?? [])]);
}
