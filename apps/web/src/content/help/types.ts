import type { ContentBlock, ContentSection } from "@zzsh/content";

// 帮助正文保留历史 blocks；新 Markdown 经共享解析投影目录和搜索文本。

export const helpCategories = [
  { id: "rental", label: "租号与使用", description: "选号、下单、交付与租用期间的操作" },
  { id: "publish", label: "出租与管理", description: "上架准备、定价方式与账号管理" },
  { id: "fees", label: "费用与资金", description: "费用构成、押金、结算、退款与提现" },
  { id: "account", label: "账号与安全", description: "注册登录、找回、实名与账号保护" },
  { id: "after-sale", label: "售后与保障", description: "异常处理、包赔保障、投诉与防骗" },
  { id: "membership", label: "会员与邀请", description: "会员档位、礼遇与邀请收益的适用" },
] as const;

export type HelpCategoryId = (typeof helpCategories)[number]["id"];

/** 任务分类之外的辅助分类，在目录下方独立分组展示 */
export const helpAuxCategories = [
  { id: "agreement", label: "协议与规则", description: "正式协议、隐私与平台规则说明" },
] as const;

export type HelpAuxCategoryId = (typeof helpAuxCategories)[number]["id"];

export type AnyHelpCategoryId = HelpCategoryId | HelpAuxCategoryId;

export function helpCategoryLabel(id: AnyHelpCategoryId): string {
  return helpCategories.find((c) => c.id === id)?.label
      ?? helpAuxCategories.find((c) => c.id === id)?.label
      ?? id;
}

export type HelpAudience = "renter" | "owner" | "all";

export const audienceLabels: Record<HelpAudience, string> = {
  renter: "租客",
  owner: "号主",
  all: "全体用户",
};

export type HelpBlock = ContentBlock;

export type HelpSection = ContentSection;

export type HelpArticle = {
  /** 稳定内部编号，与内容目录一致，例如 R01 */
  id: string;
  /** 公开 URL slug，/help/[slug] */
  slug: string;
  title: string;
  summary: string;
  category: AnyHelpCategoryId;
  audience: readonly HelpAudience[];
  /** 仅游戏专属文章填写；平台通用文章留空 */
  game?: string;
  keywords: readonly string[];
  /** 真实内容更新日期，ISO YYYY-MM-DD */
  updatedAt: string;
  sections?: readonly HelpSection[];
  format?: "markdown" | "blocks";
  schemaVersion?: number;
  markdown?: string;
  anchorAliases?: Readonly<Record<string, string>>;
  toc?: readonly { id: string; title: string; depth: number }[];
  plainText?: string;
  version?: { id: string; sequence: number; publishedAt: string | null } | null;
  /** 相关文章 slug，来自真实内容关系 */
  related: readonly string[];
  /** 结尾是否提供“联系平台客服”入口（公共文章无订单上下文） */
  contactCta?: boolean;
  mediaUrls?: Readonly<Record<string, string | null>>;
};

export type HelpArticleMeta = Omit<HelpArticle, "sections">;
