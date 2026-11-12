import type { PlateDocumentEnvelope } from "./plate-schema.d.mts";

export type HelpCategory = "rental" | "publish" | "fees" | "account" | "after-sale" | "membership" | "agreement";
// guide / notice 正文唯一格式：plate。mediaIds 由服务端从 document 重算。
export type DocumentBody = {
  format: "plate"; schemaVersion: 1; document: PlateDocumentEnvelope;
  mediaIds: readonly string[]; anchorAliases?: Readonly<Record<string, string>>;
};
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
export type FooterResource = {
  kind: "footer"; title: string; copyright: string; icp: string; policeRegion: string; policeCode: string; licenseUrl: string | null;
  help: readonly { label: string; href: string }[]; support: readonly { label: string; href: string }[]; complaint: boolean;
  socials: readonly { label: string; href: string | null; qrMediaId: string | null }[];
};
export type ContentResource = GuideResource | NoticeResource | ContactResource | BannerResource | CarouselResource | FooterResource;
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
export const RESOURCE_DEFINITIONS: readonly ResourceDefinition[];
export const DEFAULT_RESOURCES: Readonly<Record<string, ContentResource>>;
export const NOTICE_PLACEMENT_KEYS: readonly string[];
export const RESOURCE_SCHEMA: "content-resource.v1";
export const MAX_RESOURCE_BYTES: number;
export function validateResource(key: string, value: unknown): ContentResource;
export function validateResourceKey(value: unknown): string;
export function resourceMediaIds(value: ContentResource): string[];
export function safeContentLink(value: unknown): string;
export function resourceText(value: ContentResource): string;
export function validateResourceMedia(value: ContentResource, media: readonly { id: string; width: number; height: number }[]): void;
