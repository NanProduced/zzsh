import type { ContentResource, PublicContentResource, ResourceDefinition } from "@zzsh/content";
import { BEIJING_TIME_ZONE } from "../workspace/beijing-time";

export type ResourceVersion = { id: string; sequence: number; state: string; revision: string; title: string; payload: ContentResource | null; publishedAt: string | null; updatedAt: string };
export type ResourceDetail = {
  key: string; definition: ResourceDefinition | null;
  item: { id: string; resourceKey: string; gameId: string | null; revision: string } | null;
  draft: ResourceVersion | null; published: ResourceVersion | null; versions: ResourceVersion[];
  current: PublicContentResource; baseline: ContentResource | null;
  editorSource?: { version: ResourceVersion; media: { id: string; url: string | null }[] };
};
export type ResourceListItem = { current: PublicContentResource; definition: ResourceDefinition | null; metadata: { itemId: string; revision: string; updatedAt: string; hasDraft: boolean; title?: string | null } | null };
export type ResourcePage = { items: ResourceListItem[]; nextCursor: string | null; limit: number };
export type ContentOperation = "content.resource.draft.create" | "content.resource.draft.save" | "content.resource.media-draft.save" | "content.resource.draft.restore" | "content.resource.publish" | "content.resource.withdraw";
export const resourcePath = (key: string) => `/content/resources/${encodeURIComponent(key)}`;

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
/** 内容页统一按北京时间显示；未知值不补零。 */
export function contentTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : timeFormatter.format(date);
}

export const RESOURCE_KIND_LABEL = { guide: "帮助手册", notice: "流程说明", contact: "联系二维码", banner: "页面海报", carousel: "首页轮播" } as const;
export const RESOURCE_CATEGORY_LABEL = { rental: "租号与使用", publish: "出租与管理", fees: "费用与资金", account: "账号与安全", "after-sale": "售后与保障", membership: "会员与邀请", agreement: "协议与规则" } as const;

export type ResourceStateTone = "success" | "warning" | "info" | "secondary" | "unknown";
export function resourceStateInfo(item: ResourceListItem): { label: string; tone: ResourceStateTone; detail: string } {
  const { current, metadata } = item;
  const published = current.version;
  const online = published?.publishedAt ? `线上 v${published.sequence} · ${contentTime(published.publishedAt)}` : "";
  const draft = metadata?.hasDraft ? "有草稿" : "";
  if (current.state === "withdrawn") return { label: draft ? "已撤回 · 有草稿" : "已撤回", tone: "warning", detail: draft ? "线上已停止读取；草稿发布前保持撤回" : "线上已停止读取；恢复或新建草稿后需重新发布" };
  if (current.state === "unpublished") return { label: draft ? "尚未发布 · 有草稿" : "尚未发布", tone: "info", detail: draft ? "草稿保存后仍需发布" : "用户页面暂无此内容" };
  if (current.source === "BUILTIN") return { label: draft ? "内置内容 · 有草稿" : "内置内容", tone: draft ? "warning" : "secondary", detail: draft ? "用户页仍读取内置版本" : "" };
  if (current.source === "LEGACY") return { label: draft ? "沿用原轮播 · 有草稿" : "沿用原轮播", tone: draft ? "warning" : "secondary", detail: draft ? "用户页仍读取原轮播" : "" };
  return { label: draft ? "已发布 · 有草稿" : "已发布", tone: "success", detail: [online, draft ? "草稿未发布" : ""].filter(Boolean).join(" · ") };
}
export function resourceCategoryLabel(value: ContentResource | null | undefined): string {
  if (!value || value.kind !== "guide") return "";
  return RESOURCE_CATEGORY_LABEL[value.category] ?? value.category;
}
export function resourceRequirement(definition: ResourceDefinition | null): string {
  if (!definition) return "";
  const ratio = definition.aspectRatio ? `${definition.aspectRatio}:1` : "";
  return [ratio, definition.recommendedSize ? `建议 ${definition.recommendedSize}` : ""].filter(Boolean).join(" · ");
}
