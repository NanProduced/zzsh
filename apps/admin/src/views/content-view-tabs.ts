import { BookOpen, FileText, FolderOpen, FolderTree, Image, Megaphone, Newspaper } from "lucide-react";
import type { ContentType } from "../api";

export type ContentTab = "rules" | "help" | "pages" | "announcement" | "news" | "media" | "legal" | "plate-trial";
export type ContentSurface = "help" | "updates" | "legal" | "pages" | "media" | "trial";
export const SURFACE_TABS: Record<ContentSurface, readonly ContentTab[]> = {
  help: ["help", "rules"], updates: ["announcement", "news"], legal: ["legal"], pages: ["pages"], media: ["media"], trial: ["plate-trial"],
};

/** 分区顺序与命名即信息架构：规则与手册／帮助目录／图片与二维码／平台公告／资讯／运营素材／法律文书／Plate 试用。每个分区一句 helper 说明。 */
export const TAB_META: Record<ContentTab, { label: string; icon: typeof BookOpen; helper: string }> = {
  rules: { label: "规则与手册", icon: BookOpen, helper: "维护面向用户的规则与帮助手册正文；保存草稿不改变线上。" },
  help: { label: "帮助目录", icon: FolderTree, helper: "管理帮助中心的文件夹与文章结构；点击文章在本页直接编辑正文。" },
  pages: { label: "用户站展示", icon: Image, helper: "维护首页轮播、市场海报、联系二维码与网站页脚。" },
  announcement: { label: "平台公告", icon: Megaphone, helper: "发布平台级公告，进入用户端平台动态；长期规则请放入帮助手册。" },
  news: { label: "资讯", icon: Newspaper, helper: "维护有时效的平台与游戏资讯、服务更新。" },
  media: { label: "图片素材", icon: FolderOpen, helper: "上传并审核供文章和用户站使用的图片。" },
  legal: { label: "协议条款", icon: FileText, helper: "维护协议、告知与页面说明，提交审批后发布。" },
  "plate-trial": { label: "Plate 试用", icon: FileText, helper: "Plate 编辑器的试用与验证入口。" },
};

export const CONTENT_TABS = Object.keys(TAB_META) as ContentTab[];

/** 无可用分区时给出可读默认：平台级优先，其次资讯；权限收窄后仍落在允许集合内。 */
export function defaultContentTab(available: readonly ContentTab[]): ContentTab {
  return available[0] ?? "announcement";
}

/** 资讯范围的默认与合法值都取决于当前权限，避免先渲染无权分区。 */
export function defaultNewsScope(canPlatformRead: boolean): "platform" | "game" {
  return canPlatformRead ? "platform" : "game";
}

export function allowedNewsScope(value: string | undefined, canPlatformRead: boolean, canGameRead: boolean): "platform" | "game" | null {
  if (value === "platform") return canPlatformRead ? "platform" : null;
  if (value === "game") return canGameRead ? "game" : null;
  return null;
}

/** 地址栏分区必须属于当前可访问分区集合；资讯另需范围合法，否则按权限默认。 */
export function allowedContentTab(value: string | undefined, available: readonly ContentTab[]): ContentTab | null {
  if (value === "carousel") value = "pages";
  if (!value || !CONTENT_TABS.includes(value as ContentTab) || !available.includes(value as ContentTab)) return null;
  return value as ContentTab;
}

export const ITEM_NOUN: Record<ContentType, string> = { ANNOUNCEMENT: "公告", NEWS: "资讯" };
