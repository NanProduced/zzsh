/** 字段校验、记录读取、资源草稿、条目写入、轮播、公开投影和媒体列表已拆出；本文件保持原导入路径。 */

export {
  CAROUSEL_SLOTS,
  CONTENT_LIMITS,
  CONTENT_TYPES,
  isCarouselSlot,
  isContentType,
  itemScope,
  normalizeContentText,
  parseRfc3339Timestamp,
  validateInternalLink,
  type CarouselSlot,
  type ContentScope,
  type ContentType,
} from "./content-fields";

export {
  loadContentItem,
  loadContentVersion,
  loadContentVersions,
  projectStoredVersion,
  type ContentItemRow,
  type ContentVersionRow,
} from "./content-records";

export {
  checkedResource,
  fixedCarouselDraft,
  isMediaResource,
  prepareResourceDraft,
  replaceResourceMedia,
  requireResourceMedia,
} from "./content-resource";

export {
  createContentDraftFromLatest,
  createContentItem,
  listAdminContentItems,
  publishContentVersion,
  restoreContentDraft,
  saveContentDraft,
  saveContentMediaDraft,
  updateContentItemMeta,
  withdrawContentVersion,
  type DraftInput,
  type NewContentItemInput,
} from "./content-item";

export {
  carouselCreateRequiresPublish,
  carouselUpdateRequiresPublish,
  createCarouselItem,
  listAdminCarousel,
  loadCarouselItem,
  updateCarouselItem,
  type CarouselInput,
  type CarouselRow,
} from "./content-carousel";

export {
  getPublicContentItem,
  listPublicCarousel,
  listPublicContentItems,
} from "./content-public";

export {
  listContentMedia,
  listContentMediaOptions,
} from "./content-media-list";
