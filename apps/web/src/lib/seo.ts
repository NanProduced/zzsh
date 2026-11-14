import type { Metadata } from "next";

export const SEO_SITE_NAME = "洲洲商行";
export const SEO_HOME_TITLE = "洲洲商行 - 三角洲行动账号租赁平台";
export const SEO_HOME_DESCRIPTION =
  "洲洲商行是三角洲行动游戏账号租赁平台，在线挑选高价值账号，资源费用、押金与租期公开透明，支付后由真人客服全程履约。";
export const SEO_LOGO_PATH = "/brand/zzsh-logo-variant-01.png";

function isRootOrigin(value: string, protocol: "http:" | "https:" | "both"): boolean {
  try {
    const url = new URL(value);
    const protocolOk = protocol === "both" ? url.protocol === "http:" || url.protocol === "https:" : url.protocol === protocol;
    return protocolOk && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

let configErrorLogged = false;

/** 规范域名；开关非 1 或 origin 非法时返回 null，调用方一律按不可收录处理。 */
export function seoOrigin(): string | null {
  if (process.env.ZZSH_SEO_INDEXABLE !== "1") return null;
  const origin = process.env.ZZSH_WEB_ORIGIN ?? "";
  if (!isRootOrigin(origin, "https:")) {
    if (!configErrorLogged) {
      configErrorLogged = true;
      console.error("[seo] ZZSH_SEO_INDEXABLE=1 但 ZZSH_WEB_ORIGIN 不是合法的 https origin，已按不可收录处理");
    }
    return null;
  }
  return origin;
}

export function seoIndexable(): boolean {
  return seoOrigin() !== null;
}

export function seoMetadataBase(): URL | undefined {
  const origin = process.env.ZZSH_WEB_ORIGIN ?? "";
  return isRootOrigin(origin, "both") ? new URL(origin) : undefined;
}

export function seoCanonical(path: string): string | undefined {
  const origin = seoOrigin();
  return origin ? `${origin}${path}` : undefined;
}

export function seoPageMetadata(input: {
  title: string;
  description: string;
  path: string;
  robots?: string;
  absoluteTitle?: boolean;
}): Metadata {
  const canonical = seoCanonical(input.path);
  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description: input.description,
    ...(canonical ? { alternates: { canonical } } : {}),
    ...(input.robots ? { robots: input.robots } : {}),
  };
}
