import type { HelpArticle } from "./types.ts";

// 帮助文章不再有运行时代码默认：唯一内容源是 API 已发布快照（loadPublicHelpArticles）。
// 这里保留空清单以兼容离线导航/搜索工具的默认参数；真实文章由服务端注入。
export const helpArticles: readonly HelpArticle[] = [];
export const helpArticlesMore: readonly HelpArticle[] = [];