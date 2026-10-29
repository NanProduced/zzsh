export type ContentBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered?: boolean; items: readonly string[] }
  | { type: "callout"; tone: "info" | "warning"; text: string }
  | { type: "table"; caption?: string; columns: readonly string[]; rows: readonly (readonly string[])[] }
  | { type: "image"; mediaId: string; alt: string; caption?: string }
  | { type: "link"; text: string; href: string };
export type ContentSection = { id: string; title: string; blocks: readonly ContentBlock[] };
export type HelpCategory = "rental" | "publish" | "fees" | "account" | "after-sale" | "membership" | "agreement";
export type DocumentBody =
  | { format?: "blocks"; schemaVersion?: 1; sections: readonly ContentSection[]; markdown?: never; mediaIds?: never; anchorAliases?: never }
  | { format: "markdown"; schemaVersion: 1; markdown: string; mediaIds: readonly string[]; anchorAliases?: Readonly<Record<string, string>>; sections?: never };
export type GuideResource = {
  kind: "guide";
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: HelpCategory;
  audience: readonly ("renter" | "owner" | "all")[];
  game?: string;
  keywords: readonly string[];
  updatedAt: string;
  related: readonly string[];
  contactCta?: boolean;
} & DocumentBody;
export type NoticeResource = { kind: "notice"; title: string } & DocumentBody;
export type ContactResource = {
  kind: "contact"; title: string; description: string; handle: string;
  qrMediaId: string | null; imageAlt: string; enabled: boolean;
};
export type BannerResource = {
  kind: "banner"; title: string; description: string; mediaId: string | null;
  mobileMediaId: string | null; imageAlt: string; mobileImageAlt: string;
  linkUrl: string | null; enabled: boolean;
};
export type CarouselSlide = {
  id: string; mediaId: string | null; mobileMediaId: string | null; imageAlt: string; mobileImageAlt: string;
  title: string; description: string; linkUrl: string | null; enabled: boolean;
  sortOrder: number; startsAt: string | null; endsAt: string | null;
};
export type CarouselResource = { kind: "carousel"; title: string; slides: readonly CarouselSlide[] };
export type ContentResource = GuideResource | NoticeResource | ContactResource | BannerResource | CarouselResource;
export type PublicContentResource = {
  schema: "content-resource.v1"; key: string; source: "BUILTIN" | "MANAGED" | "LEGACY";
  state: "available" | "withdrawn" | "unpublished"; payload: ContentResource | null;
  media: readonly { id: string; url: string | null }[];
  version?: { id: string; sequence: number; publishedAt: string | null } | null;
};
export type ResourceDefinition = {
  key: string; label: string; group: "help" | "publish" | "rental" | "site" | "market";
  kind: ContentResource["kind"]; locations: readonly string[]; aspectRatio?: number;
  recommendedSize?: string; businessRelated?: boolean;
  minWidth?: number; minHeight?: number; aspectTolerance?: number;
};
export const DEFAULT_GUIDES: readonly GuideResource[];
export const RESOURCE_DEFINITIONS: readonly ResourceDefinition[];
export const DEFAULT_RESOURCES: Readonly<Record<string, ContentResource>>;
export const RESOURCE_SCHEMA: "content-resource.v1";
export const MAX_RESOURCE_BYTES: number;
export function validateResource(key: string, value: unknown): ContentResource;
export function validateResourceKey(value: unknown): string;
export function resourceMediaIds(value: ContentResource): string[];
export function safeContentLink(value: unknown): string;
export function resourceText(value: ContentResource): string;
export function validateResourceMedia(value: ContentResource, media: readonly { id: string; width: number; height: number }[]): void;
