// 旧 /help 锚点与旧站公开 URL 的精确映射。
// 旧锚点由帮助首页客户端读取 location.hash 后跳转（fragment 不会发送到服务端，不做服务端 301）。

export const legacyHelpHashMap: Readonly<Record<string, string>> = {
  "rental-guide": "rental-getting-started",
  "billing-guide": "fees-overview",
  "publish-guide": "publish-prepare",
  "protection": "minor-protection",
};

export function resolveLegacyHash(hash: string): string | null {
  const key = hash.replace(/^#/, "");
  return legacyHelpHashMap[key] ?? null;
}

/** 旧站公开页面 → 新文章；站点切换重定向由唯一维护者另行接入，本轮不改全局路由 */
export const legacySiteUrlMap: readonly { source: string; title: string; slug: string }[] = [
  { source: "/individualMenu/postRentNotice?id=14", title: "号主须知", slug: "publish-prepare" },
  { source: "/individualMenu/postRentNotice?id=15", title: "租客须知", slug: "rental-getting-started" },
  { source: "/individualMenu/postRentNotice?id=16", title: "人脸验证教程", slug: "account-realname-vs-face" },
  { source: "/individualMenu/postRentNotice?id=17", title: "出租完成后如何结算？", slug: "fees-settlement" },
  { source: "/individualMenu/postRentNotice?id=19", title: "出租开始务必开启设备锁！", slug: "publish-account-safety" },
  { source: "/individualMenu/privacy", title: "隐私保护", slug: "terms-and-privacy" },
  { source: "/individualMenu/disclaimer", title: "免责声明", slug: "terms-and-privacy" },
];
