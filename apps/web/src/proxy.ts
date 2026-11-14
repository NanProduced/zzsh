import { NextResponse, type NextRequest } from "next/server";
import { legacySiteUrlMap } from "@/content/help/legacy-links";
import { seoIndexable } from "@/lib/seo";

const LEGACY_PATH_TARGETS: Readonly<Record<string, string>> = {
  "/home": "/",
  "/rent": "/accounts",
  "/homeDetail": "/accounts",
  "/gun-code": "/gunsmith",
  "/proxy-level": "/account",
  "/proxy-level/issue": "/account",
  "/proxy-level/detail": "/account",
};

const LEGACY_ACCOUNT_NAMES = new Set([
  "personalCenter", "myWallet", "withdrawal", "myCollection", "attestation", "distributor",
  "taskCenter", "taskInfo", "empCenter", "bindInfo", "orderDetail", "accountSetting",
]);
const LEGACY_UPDATE_PATHS = new Set(["/individualMenu/officialNotice", "/individualMenu/gameNews"]);
const LEGACY_MENU_PREFIX = "/individualMenu/";
// 非 CDN 模式下公开图片走 /api/supply/*，这些字节响应必须可抓取。
const PUBLIC_IMAGE_PATH = /^\/api\/supply\/(?:media\/[^/]+\/content|listings\/[^/]+\/(?:media|legacy-images)\/[^/]+)$/;

function legacyRedirectTarget(pathname: string, id: string | null): string | null {
  const direct = LEGACY_PATH_TARGETS[pathname];
  if (direct) return direct;
  if (pathname === `${LEGACY_MENU_PREFIX}postRentNotice`) {
    const mapped = legacySiteUrlMap.find((entry) => entry.source === `${LEGACY_MENU_PREFIX}postRentNotice?id=${id}`);
    return mapped ? `/help/${mapped.slug}` : "/help";
  }
  const mapped = legacySiteUrlMap.find((entry) => entry.source === pathname);
  if (mapped) return `/help/${mapped.slug}`;
  if (LEGACY_UPDATE_PATHS.has(pathname)) return "/updates";
  if (pathname.startsWith(LEGACY_MENU_PREFIX) && LEGACY_ACCOUNT_NAMES.has(pathname.slice(LEGACY_MENU_PREFIX.length))) return "/account";
  return null;
}

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const target = legacyRedirectTarget(pathname, searchParams.get("id"));
  // 旧站参数（no/homeDetailId/id 等）一律不带入目标地址；百度对 301 识别最稳定。
  if (target) return NextResponse.redirect(new URL(target, request.url), 301);
  const response = NextResponse.next();
  if (!seoIndexable()) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  else if (pathname.startsWith("/api/") && !PUBLIC_IMAGE_PATH.test(pathname)) response.headers.set("X-Robots-Tag", "noindex");
  return response;
}