// 帮助中心内容类型：受控 typed 内容块，不执行 MDX/JSX/任意 HTML。
// 后续接入后台内容模块时，API 结果映射到同一结构，阅读组件不需要重写。

export const helpCategories = [
  { id: "rental", label: "租号与使用", description: "选号、下单、交付与租用期间的操作" },
  { id: "publish", label: "出租与管理", description: "上架准备、定价方式与账号管理" },
  { id: "fees", label: "费用与资金", description: "费用构成、押金、结算、退款与提现" },
  { id: "account", label: "账号与安全", description: "注册登录、找回、实名与账号保护" },
  { id: "after-sale", label: "售后与保障", description: "异常处理、包赔保障、投诉与防骗" },
  { id: "membership", label: "会员与邀请", description: "会员档位与费用优惠的适用" },
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

export type HelpBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered?: boolean; items: readonly string[] }
  | { type: "callout"; tone: "info" | "warning"; text: string }
  | { type: "table"; caption?: string; columns: readonly string[]; rows: readonly (readonly string[])[] };

export type HelpSection = {
  /** 稳定锚点 id，文章内唯一，用于页内目录与章节直链 */
  id: string;
  title: string;
  blocks: readonly HelpBlock[];
};

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
  sections: readonly HelpSection[];
  /** 相关文章 slug，来自真实内容关系 */
  related: readonly string[];
  /** 结尾是否提供“联系平台客服”入口（公共文章无订单上下文） */
  contactCta?: boolean;
};

export type HelpArticleMeta = Omit<HelpArticle, "sections">;
