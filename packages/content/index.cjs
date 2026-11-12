"use strict";

const { validatePlateDocument, extractPlate } = require("./plate-schema.mjs");

const RESOURCE_SCHEMA = "content-resource.v1";
const MAX_RESOURCE_BYTES = 200000;
const categories = ["rental", "publish", "fees", "account", "after-sale", "membership", "agreement"];
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const controls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const contact = (title, description) => ({ kind: "contact", title, description, handle: "", qrMediaId: null, imageAlt: `${title}二维码`, enabled: false });
const placements = {
  FOOTER: { kind: "footer", title: "网站页脚", copyright: "杭州鑫峰互娱网络科技有限公司", icp: "浙ICP备2026028260号", policeRegion: "浙", policeCode: "33010802014464", licenseUrl: null,
    help: [{ label: "租号流程", href: "/help/rental-getting-started" }, { label: "费用与租期", href: "/help/fees-overview" }, { label: "发布须知", href: "/help/publish-prepare" }],
    support: [{ label: "帮助中心", href: "/help" }], complaint: true, socials: [] },
  HOME_HERO: { kind: "carousel", title: "首页轮播", slides: [
    { id: "delta", title: "资源账号租赁", description: "", imageAlt: "资源账号租赁", linkUrl: "/accounts", sortOrder: 3 },
    { id: "protection", title: "未成年人保护", description: "", imageAlt: "未成年人保护", linkUrl: "/help/minor-protection", sortOrder: 2 },
    { id: "accounts", title: "洲洲商行", description: "", imageAlt: "洲洲商行账号服务", linkUrl: "/accounts", sortOrder: 1 },
  ].map(slide => ({ ...slide, mediaId: null, mobileMediaId: null, mobileImageAlt: "", enabled: true, startsAt: null, endsAt: null })) },
  FOLLOW: contact("关注我们", "获取洲洲商行的活动与资讯。"),
  MARKET_PLAYER_GROUP: contact("玩家交流群", "玩家交流用途；订单沟通和交易请通过站内客服与订单群。"),
  MARKET_COOPERATION: contact("合作咨询", "商务合作咨询；请勿通过私人二维码支付租号订单。"),
  ESCORT: contact("护航代肝", "通过已公布渠道了解服务内容与安排；本站暂不提供护航代肝下单。"),
  MARKET_DELTA_BANNER: { kind: "banner", title: "三角洲行动账号租赁专区", description: "浏览资源配置与租用条件", mediaId: null, mobileMediaId: null, imageAlt: "三角洲行动账号租赁专区", mobileImageAlt: "", linkUrl: "/accounts#account-list", enabled: false },
};
// 场景说明（notice）不再携带运行时代码默认：正文由首部署初始化写入 Plate 文档。
// 这里只保留位置元数据，供后台目录与 key 校验识别合法位置。
const noticePlacements = {
  PUBLISH_NOTICE: ["出租上架须知", "publish", ["上架出租 · 阅读弹窗"]],
  RENTAL_PROCESS: ["租号流程说明", "rental", ["账号详情 · 租赁流程"]],
  PUBLISH_SAFE_BOX: ["安全箱填写说明", "publish", ["上架出租 · 安全箱问号提示"]],
  PUBLISH_RESOURCES: ["库存申报说明", "publish", ["上架出租 · 物品资源说明"]],
  PUBLISH_TERM: ["日耗与租期说明", "publish", ["上架出租 · 日耗与租期展开说明"]],
  RENTAL_FEES: ["租用费用说明", "rental", ["账号详情 · 费用说明"]],
};
const labels = {
  FOOTER: ["网站页脚", "site", ["全站 · 页脚"]],
  HOME_HERO: ["首页轮播", "site", ["首页 · 中央轮播（桌面与手机）"]],
  FOLLOW: ["全站关注二维码", "site", ["全站工具条 · 关注我们"]],
  MARKET_PLAYER_GROUP: ["玩家交流群", "market", ["三角洲账号市场 · 顶部联系卡"]],
  MARKET_COOPERATION: ["合作咨询", "market", ["三角洲账号市场 · 顶部联系卡"]],
  ESCORT: ["护航代肝咨询", "site", ["首页 · 护航代肝入口"]],
  MARKET_DELTA_BANNER: ["三角洲市场海报", "market", ["三角洲账号市场 · 主海报"]],
};
const DEFAULT_RESOURCES = Object.fromEntries(Object.entries(placements).map(([key, payload]) => [`placement:${key}`, payload]));
const MEDIA_RULES = {
  footer: { minWidth: 256, minHeight: 256, aspectRatio: 1, aspectTolerance: .02, recommendedSize: "512×512 PNG" },
  contact: { minWidth: 256, minHeight: 256, aspectRatio: 1, aspectTolerance: .02, recommendedSize: "512×512 PNG" },
  banner: { minWidth: 810, minHeight: 270, aspectRatio: 3, aspectTolerance: .05, recommendedSize: "1620×540" },
  carousel: { minWidth: 920, minHeight: 400, aspectRatio: 2.3, aspectTolerance: .05, recommendedSize: "1840×800" },
};
const RESOURCE_DEFINITIONS = [
  ...Object.entries(placements).map(([key, payload]) => ({ key: `placement:${key}`, kind: payload.kind, label: labels[key][0], group: labels[key][1], locations: labels[key][2], businessRelated: false, ...MEDIA_RULES[payload.kind] })),
  ...Object.entries(noticePlacements).map(([key, [label, group, locations]]) => ({ key: `placement:${key}`, kind: "notice", label, group, locations, businessRelated: true })),
];

function fail(message) { throw new Error(message); }
function object(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}格式无效`);
  if (Object.keys(value).some((key) => !fields.includes(key))) fail(`${label}包含不支持的字段`);
  return value;
}
function text(value, max, label, allowEmpty = false) {
  if (typeof value !== "string") fail(`${label}必须是文本`);
  const result = value.normalize("NFC").replace(/\r\n?/g, "\n");
  if (controls.test(result) || [...result].length > max || (!allowEmpty && !result.trim())) fail(`${label}为空、过长或包含控制字符`);
  return result;
}
function strings(value, count, max, label, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > count) fail(`${label}数量超出范围`);
  return value.map((entry) => text(entry, max, label, allowEmpty));
}
function mediaId(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !idPattern.test(value)) fail("素材引用无效");
  return value;
}
function boolean(value, label) { if (typeof value !== "boolean") fail(`${label}必须明确填写`); return value; }
function safeContentLink(value) {
  const result = text(value, 300, "链接");
  let decoded;
  try { decoded = decodeURIComponent(result); } catch { fail("链接编码无效"); }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\s]/.test(decoded) || controls.test(decoded)) fail("只允许安全的站内链接");
  if (decoded.split(/[?#]/)[0].split("/").some((part) => part === "." || part === "..")) fail("链接不能包含相对跳转");
  const segment = decoded.split(/[/?#]/).filter(Boolean)[0];
  if (segment && !["accounts", "publish", "account", "help", "legal"].includes(segment)) fail("链接目标尚未开放");
  return result;
}
function safeFooterLink(value) {
  const result = text(value, 500, "链接");
  let decoded;
  try { decoded = decodeURIComponent(result); } catch { fail("链接编码无效"); }
  if (/[\\\s]/.test(decoded) || controls.test(decoded)) fail("链接格式无效");
  if (result.startsWith("/") && decoded.startsWith("/") && !decoded.startsWith("//") && !decoded.split(/[?#]/)[0].split("/").some(part => part === "." || part === "..")) return result;
  if (!/^https:\/\/[^/]/i.test(result)) fail("链接须为站内路径或完整的 HTTPS 地址");
  let url;
  try { url = new URL(result); } catch { fail("链接须为站内路径或 HTTPS 地址"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) fail("链接须为安全的 HTTPS 地址");
  return url.href;
}
// guide / notice 正文唯一格式：plate。sections / markdown 出现即拒绝。
// mediaIds 一律从 document 重算，不信任调用方传入的清单。
function documentBody(input, preset) {
  if (input.sections !== undefined || input.markdown !== undefined) fail("正文仅支持 plate 格式，不接受 sections 或 markdown");
  if (input.format !== "plate" || input.schemaVersion !== 1) fail("正文格式无效，仅支持 plate schemaVersion 1");
  const document = input.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("缺少 plate 正文文档");
  const checked = validatePlateDocument(document, { preset, mode: "draft" });
  if (!checked.ok) {
    const first = checked.errors[0];
    fail(`正文未通过校验：${first.path} ${first.code} ${first.message}`);
  }
  const aliases = {};
  if (input.anchorAliases !== undefined) {
    object(input.anchorAliases, Object.keys(input.anchorAliases ?? {}), "旧锚点映射");
    if (Object.keys(input.anchorAliases).length > 100) fail("旧锚点数量过多");
    for (const [from, to] of Object.entries(input.anchorAliases)) {
      if (!idPattern.test(from) || ["__proto__", "constructor", "prototype"].includes(from) || typeof to !== "string" || !/^content-[\p{L}\p{N}_-]+$/u.test(to) || to.length > 250) fail("旧锚点映射无效");
      aliases[from] = to;
    }
  }
  const mediaIds = extractPlate(document).mediaIds.sort();
  return { format: "plate", schemaVersion: 1, document, mediaIds, ...(Object.keys(aliases).length ? { anchorAliases: aliases } : {}) };
}
function validateResourceKey(value) {
  if (typeof value !== "string" || value.length > 128 || !/^(?:guide:[a-z0-9]+(?:-[a-z0-9]+)*|placement:[A-Z][A-Z0-9_]*)$/.test(value)) fail("内容位置标识无效");
  if (value === "guide:updates") fail("该地址保留给公告与资讯，请更换手册地址");
  if (value.startsWith("placement:") && !DEFAULT_RESOURCES[value] && !noticePlacements[value.slice(10)]) fail("该页面位置尚未接入");
  return value;
}
function validateResource(key, input) {
  validateResourceKey(key);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("内容格式无效");
  const builtin = DEFAULT_RESOURCES[key];
  if (key.startsWith("guide:") ? input.kind !== "guide" : input.kind !== (builtin ? builtin.kind : "notice")) fail("内容类型与展示位置不匹配");
  let result;
  if (input.kind === "footer") {
    object(input, ["kind", "title", "copyright", "icp", "policeRegion", "policeCode", "licenseUrl", "help", "support", "complaint", "socials"], "网站页脚");
    const links = (value, label) => {
      if (!Array.isArray(value) || value.length > 8) fail(`${label}数量超出范围`);
      return value.map(entry => { object(entry, ["label", "href"], label); return { label: text(entry.label, 40, "链接文字"), href: safeFooterLink(entry.href) }; });
    };
    if (!Array.isArray(input.socials) || input.socials.length > 6) fail("社交渠道数量超出范围");
    const socials = input.socials.map(entry => {
      object(entry, ["label", "href", "qrMediaId"], "社交渠道");
      const href = entry.href === null ? null : safeFooterLink(entry.href), qrMediaId = mediaId(entry.qrMediaId, true);
      if (!href && !qrMediaId) fail("社交渠道须配置链接或二维码");
      return { label: text(entry.label, 40, "社交渠道名称"), href, qrMediaId };
    });
    const icp = text(input.icp, 40, "ICP备案号", true), policeRegion = text(input.policeRegion, 6, "公安备案地区", true), policeCode = text(input.policeCode, 14, "公安备案编号", true);
    if (icp && !/^[\u4e00-\u9fff]{1,4}ICP备\d{8,12}号(?:-\d+)?$/.test(icp)) fail("ICP备案号格式无效");
    if ((policeRegion || policeCode) && (!/^[\u4e00-\u9fff]{1,6}$/.test(policeRegion) || !/^\d{14}$/.test(policeCode))) fail("公安备案地区与14位编号须同时填写");
    const help = links(input.help, "使用帮助"), support = links(input.support, "服务支持"), allLinks = [...help, ...support].map(link => link.href);
    if (new Set(allLinks).size !== allLinks.length || allLinks.some(href => ["/updates", "/legal/terms", "/legal/privacy"].includes(href.split(/[?#]/)[0]))) fail("链接重复或与固定入口重复");
    result = { kind: "footer", title: text(input.title, 200, "标题"), copyright: text(input.copyright, 120, "版权主体", true), icp, policeRegion, policeCode, licenseUrl: input.licenseUrl === null ? null : safeFooterLink(input.licenseUrl), help, support, complaint: boolean(input.complaint, "投诉建议入口"), socials };
  } else if (input.kind === "carousel") {
    object(input, ["kind", "title", "slides"], "轮播");
    if (!Array.isArray(input.slides) || input.slides.length > 30) fail("轮播最多 30 张");
    const ids = new Set();
    const timestamp = (value) => {
      if (value === null) return null;
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail("轮播时间无效");
      const localDate = value.slice(0, 10);
      if (new Date(`${localDate}T00:00:00Z`).toISOString().slice(0, 10) !== localDate || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail("轮播时间无效");
      return new Date(value).toISOString();
    };
    const slides = input.slides.map((entry) => {
      object(entry, ["id", "mediaId", "mobileMediaId", "imageAlt", "mobileImageAlt", "title", "description", "linkUrl", "enabled", "sortOrder", "startsAt", "endsAt"], "轮播图片");
      const id = mediaId(entry.id);
      if (ids.has(id)) fail("轮播图片标识重复");
      ids.add(id);
      if (!Number.isInteger(entry.sortOrder) || Math.abs(entry.sortOrder) > 1000000) fail("轮播排序无效");
      const startsAt = timestamp(entry.startsAt), endsAt = timestamp(entry.endsAt);
      if (startsAt && endsAt && startsAt >= endsAt) fail("轮播开始时间须早于结束时间");
      return { id, mediaId: mediaId(entry.mediaId, true), mobileMediaId: mediaId(entry.mobileMediaId, true), imageAlt: text(entry.imageAlt, 300, "图片说明"), mobileImageAlt: text(entry.mobileImageAlt, 300, "手机图说明", true), title: text(entry.title, 120, "轮播标题"), description: text(entry.description, 300, "轮播说明", true), linkUrl: entry.linkUrl === null ? null : safeContentLink(entry.linkUrl), enabled: boolean(entry.enabled, "轮播启用状态"), sortOrder: entry.sortOrder, startsAt, endsAt };
    });
    result = { kind: "carousel", title: text(input.title, 200, "标题"), slides };
  } else if (input.kind === "guide") {
    object(input, ["kind", "id", "slug", "title", "summary", "category", "audience", "game", "keywords", "updatedAt", "related", "contactCta", "format", "schemaVersion", "document", "mediaIds", "anchorAliases", "sections", "markdown"], "手册");
    if (input.slug !== key.slice(6) || !slugPattern.test(input.slug)) fail("文章地址与位置不一致");
    if (!categories.includes(input.category)) fail("帮助分类无效");
    const audience = strings(input.audience, 3, 10, "适用对象");
    if (!audience.length || new Set(audience).size !== audience.length || audience.some((item) => !["renter", "owner", "all"].includes(item))) fail("适用对象无效");
    if (typeof input.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.updatedAt) || !Number.isFinite(Date.parse(input.updatedAt)) || new Date(input.updatedAt).toISOString().slice(0, 10) !== input.updatedAt) fail("更新日期无效");
    const related = strings(input.related, 20, 100, "相关文章");
    if (related.some((slug) => !slugPattern.test(slug) || slug === input.slug) || new Set(related).size !== related.length) fail("相关文章地址重复或无效");
    result = { kind: "guide", id: text(input.id, 100, "文章编号"), slug: input.slug, title: text(input.title, 200, "标题"), summary: text(input.summary, 500, "摘要", true), category: input.category, audience, ...(input.game === undefined ? {} : { game: text(input.game, 100, "适用游戏") }), keywords: strings(input.keywords, 30, 100, "关键词"), updatedAt: input.updatedAt, ...documentBody(input, "help"), related, ...(input.contactCta === undefined ? {} : { contactCta: boolean(input.contactCta, "客服入口") }) };
  } else if (input.kind === "notice") {
    object(input, ["kind", "title", "format", "schemaVersion", "document", "mediaIds", "anchorAliases", "sections", "markdown"], "场景说明");
    result = { kind: "notice", title: text(input.title, 200, "标题"), ...documentBody(input, "notice") };
  } else if (input.kind === "contact") {
    object(input, ["kind", "title", "description", "handle", "qrMediaId", "imageAlt", "enabled"], "联系渠道");
    result = { kind: "contact", title: text(input.title, 100, "标题"), description: text(input.description, 500, "说明", true), handle: text(input.handle, 100, "联系标识", true), qrMediaId: mediaId(input.qrMediaId, true), imageAlt: text(input.imageAlt, 300, "二维码说明"), enabled: boolean(input.enabled, "启用状态") };
  } else if (input.kind === "banner") {
    object(input, ["kind", "title", "description", "mediaId", "mobileMediaId", "imageAlt", "mobileImageAlt", "linkUrl", "enabled"], "页面海报");
    result = { kind: "banner", title: text(input.title, 120, "标题"), description: text(input.description, 300, "说明", true), mediaId: mediaId(input.mediaId, true), mobileMediaId: mediaId(input.mobileMediaId, true), imageAlt: text(input.imageAlt, 300, "图片说明"), mobileImageAlt: text(input.mobileImageAlt, 300, "手机图说明", true), linkUrl: input.linkUrl === null ? null : safeContentLink(input.linkUrl), enabled: boolean(input.enabled, "启用状态") };
  } else fail("内容类型无效");
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_RESOURCE_BYTES) fail("单份内容超过 200000 字节");
  return result;
}
function resourceMediaIds(value) {
  const ids = [];
  if (value.kind === "footer") ids.push(...value.socials.map(entry => entry.qrMediaId).filter(Boolean));
  if (value.kind === "carousel") for (const slide of value.slides) ids.push(...[slide.mediaId, slide.mobileMediaId].filter(Boolean));
  if (value.kind === "contact" && value.qrMediaId) ids.push(value.qrMediaId);
  if (value.kind === "banner") ids.push(...[value.mediaId, value.mobileMediaId].filter(Boolean));
  if (value.kind === "guide" || value.kind === "notice") ids.push(...value.mediaIds);
  return [...new Set(ids)].sort();
}
function resourceText(value) {
  if (value.kind === "footer") return [value.title, value.copyright, value.icp, ...value.help.map(link => link.label), ...value.support.map(link => link.label), ...value.socials.map(link => link.label)].join("\n");
  if (value.kind === "carousel") return [value.title, ...value.slides.map((slide) => `${slide.title}\n${slide.description}`)].join("\n\n");
  if (value.kind === "contact") return [value.title, value.description, value.handle].join("\n");
  if (value.kind === "banner") return [value.title, value.description].join("\n");
  return [value.title, value.kind === "guide" ? value.summary : "", extractPlate(value.document).plainText].join("\n\n");
}

function validateResourceMedia(value, media) {
  const rule = MEDIA_RULES[value.kind];
  if (!rule) return;
  for (const id of resourceMediaIds(value)) {
    const image = media.find(entry => entry.id === id);
    if (!image || image.width < rule.minWidth || image.height < rule.minHeight || Math.abs(image.width / image.height / rule.aspectRatio - 1) > rule.aspectTolerance) fail(`图片须接近 ${rule.aspectRatio}:1 且至少 ${rule.minWidth}×${rule.minHeight}（素材 ${id}）`);
  }
}

exports.RESOURCE_SCHEMA = RESOURCE_SCHEMA;
exports.MAX_RESOURCE_BYTES = MAX_RESOURCE_BYTES;
exports.RESOURCE_DEFINITIONS = RESOURCE_DEFINITIONS;
exports.DEFAULT_RESOURCES = DEFAULT_RESOURCES;
exports.NOTICE_PLACEMENT_KEYS = Object.keys(noticePlacements);
exports.validateResource = validateResource;
exports.validateResourceKey = validateResourceKey;
exports.resourceMediaIds = resourceMediaIds;
exports.safeContentLink = safeContentLink;
exports.resourceText = resourceText;
exports.validateResourceMedia = validateResourceMedia;
