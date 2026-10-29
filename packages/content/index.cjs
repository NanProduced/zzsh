"use strict";

const RESOURCE_SCHEMA = "content-resource.v1";
const MAX_RESOURCE_BYTES = 200000;
const categories = ["rental", "publish", "fees", "account", "after-sale", "membership", "agreement"];
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const controls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const DEFAULT_GUIDES = require("./default-guides.json").map((article) => ({ kind: "guide", ...article }));

const notice = (title, sections) => ({ kind: "notice", title, sections: sections.map(([id, heading, text]) => ({ id, title: heading, blocks: [{ type: "paragraph", text }] })) });
const contact = (title, description) => ({ kind: "contact", title, description, handle: "", qrMediaId: null, imageAlt: `${title}二维码`, enabled: false });
const placements = {
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
  PUBLISH_NOTICE: notice("出租上架须知", [
    ["face", "绑定人脸须为号主本人", "解除人脸验证需准备双设备：两部手机，或手机与电脑。"],
    ["withdrawal", "核对提现条件", "可用渠道和办理条件以钱包的当前状态为准。"],
    ["inventory", "如实申报资料与库存", "申报可出租的全量库存，留空与 0 含义不同。物品名称和计量单位以当前目录与表单为准；有封禁记录时按要求提供对应资料。"],
    ["quote", "核对报价、租期与收入", "租期和金额由平台按本次规则计算；修改资料或规则变化后需要重新核价。预计收入不代表最终净到账，押金不计入收入。"],
    ["protection", "确认上号配合与赔付方案", "请填写实际可协助上号的时间。包赔费用、押金要求和保障条件以本次有效报价及条款为准；阅读须知不代表接受本次报价。"],
  ]),
  RENTAL_PROCESS: notice("租赁流程", [
    ["review", "核对资料与费用", "查看公开属性、资源库存和本人的适用报价。"],
    ["order", "确认并创建订单", "阅读本次适用条款，按页面提示确认订单与支付。"],
    ["delivery", "客服协助交付", "付款后留意订单状态和站内消息，由真人客服协助履约。"],
    ["opening", "确认交付后开租", "核对同一版期初清单并完成双方确认，付款不等于已经开租。"],
    ["settlement", "按实际消耗结算", "归还时按订单流程核对消耗与结算；退款应付与实际到账分别记录。"],
  ]),
  PUBLISH_SAFE_BOX: notice("安全箱档位", [["help", "填写说明", "填写当前赛季永久安全箱容量，不包含临时体验卡；体验卡数量在库存区填写。"]]),
  PUBLISH_RESOURCES: notice("物品资源", [["help", "填写说明", "申报可用于本次出租的全量库存。留空表示尚未申报，0 表示明确没有；数量和单位以目录及表单校验为准。"]]),
  PUBLISH_TERM: notice("日耗、租期与比例", [["help", "选择说明", "每日消耗用于推算预计租期，也可能参与比例计算。可用档位、范围及金额以本次核价为准；资料变化后需要重新核价。"]]),
  RENTAL_FEES: notice("报价费用说明", [["help", "费用说明", "物资先预付，最终按实际消耗和适用条款结算。公开参考费用不能替代个人报价，会员价格与实际租客押金由服务端核定。"]]),
};
const labels = {
  HOME_HERO: ["首页轮播", "site", ["首页 · 中央轮播（桌面与手机）"]],
  FOLLOW: ["全站关注二维码", "site", ["全站工具条 · 关注我们"]],
  MARKET_PLAYER_GROUP: ["玩家交流群", "market", ["三角洲账号市场 · 顶部联系卡"]],
  MARKET_COOPERATION: ["合作咨询", "market", ["三角洲账号市场 · 顶部联系卡"]],
  ESCORT: ["护航代肝咨询", "site", ["首页 · 护航代肝入口"]],
  MARKET_DELTA_BANNER: ["三角洲市场海报", "market", ["三角洲账号市场 · 主海报"]],
  PUBLISH_NOTICE: ["出租上架须知", "publish", ["上架出租 · 阅读弹窗"]],
  RENTAL_PROCESS: ["租号流程说明", "rental", ["账号详情 · 租赁流程"]],
  PUBLISH_SAFE_BOX: ["安全箱填写说明", "publish", ["上架出租 · 安全箱问号提示"]],
  PUBLISH_RESOURCES: ["库存申报说明", "publish", ["上架出租 · 物品资源说明"]],
  PUBLISH_TERM: ["日耗与租期说明", "publish", ["上架出租 · 日耗与租期展开说明"]],
  RENTAL_FEES: ["租用费用说明", "rental", ["账号详情 · 费用说明"]],
};
const DEFAULT_RESOURCES = Object.fromEntries([
  ...DEFAULT_GUIDES.map((article) => [`guide:${article.slug}`, article]),
  ...Object.entries(placements).map(([key, payload]) => [`placement:${key}`, payload]),
]);
const MEDIA_RULES = {
  contact: { minWidth: 256, minHeight: 256, aspectRatio: 1, aspectTolerance: .02, recommendedSize: "512×512 PNG" },
  banner: { minWidth: 810, minHeight: 270, aspectRatio: 3, aspectTolerance: .05, recommendedSize: "1620×540" },
  carousel: { minWidth: 920, minHeight: 400, aspectRatio: 2.3, aspectTolerance: .05, recommendedSize: "1840×800" },
};
const RESOURCE_DEFINITIONS = [
  ...DEFAULT_GUIDES.map((article) => ({ key: `guide:${article.slug}`, kind: "guide", label: article.title, group: "help", locations: [`/help/${article.slug}`], businessRelated: ["fees", "membership", "agreement"].includes(article.category) })),
  ...Object.entries(placements).map(([key, payload]) => ({ key: `placement:${key}`, kind: payload.kind, label: labels[key][0], group: labels[key][1], locations: labels[key][2], businessRelated: payload.kind === "notice", ...MEDIA_RULES[payload.kind] })),
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
function block(input) {
  object(input, ["type", "text", "ordered", "items", "tone", "caption", "columns", "rows", "mediaId", "alt", "href"], "内容块");
  switch (input.type) {
    case "paragraph": object(input, ["type", "text"], "段落"); return { type: "paragraph", text: text(input.text, 10000, "段落", true) };
    case "list": object(input, ["type", "ordered", "items"], "列表"); return { type: "list", ordered: input.ordered === undefined ? false : boolean(input.ordered, "列表顺序"), items: strings(input.items, 100, 2000, "列表项") };
    case "callout": object(input, ["type", "tone", "text"], "提示"); if (!["info", "warning"].includes(input.tone)) fail("提示类型无效"); return { type: "callout", tone: input.tone, text: text(input.text, 4000, "提示") };
    case "table": {
      object(input, ["type", "caption", "columns", "rows"], "表格");
      const columns = strings(input.columns, 12, 200, "表头", true);
      if (!columns.some((column) => column.trim()) || !Array.isArray(input.rows) || input.rows.length > 100) fail("表格大小无效");
      const rows = input.rows.map((row) => { const cells = strings(row, 12, 2000, "单元格", true); if (cells.length !== columns.length) fail("表格列数不一致"); return cells; });
      return { type: "table", ...(input.caption === undefined ? {} : { caption: text(input.caption, 300, "表格标题", true) }), columns, rows };
    }
    case "image": object(input, ["type", "mediaId", "alt", "caption"], "插图"); return { type: "image", mediaId: mediaId(input.mediaId), alt: text(input.alt, 300, "图片说明"), ...(input.caption === undefined ? {} : { caption: text(input.caption, 500, "图注", true) }) };
    case "link": object(input, ["type", "text", "href"], "链接"); return { type: "link", text: text(input.text, 300, "链接文字"), href: safeContentLink(input.href) };
    default: fail("不支持的内容块，不能静默省略");
  }
}
function sections(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) fail("章节数量无效");
  const ids = new Set();
  let count = 0;
  return value.map((entry) => {
    object(entry, ["id", "title", "blocks"], "章节");
    if (typeof entry.id !== "string" || !slugPattern.test(entry.id) || entry.id.length > 80 || ids.has(entry.id)) fail("章节锚点重复或无效");
    ids.add(entry.id);
    if (!Array.isArray(entry.blocks) || !entry.blocks.length || (count += entry.blocks.length) > 300) fail("内容块数量无效");
    return { id: entry.id, title: text(entry.title, 200, "章节标题"), blocks: entry.blocks.map(block) };
  });
}
function validateResourceKey(value) {
  if (typeof value !== "string" || value.length > 128 || !/^(?:guide:[a-z0-9]+(?:-[a-z0-9]+)*|placement:[A-Z][A-Z0-9_]*)$/.test(value)) fail("内容位置标识无效");
  if (value === "guide:updates") fail("该地址保留给公告与资讯，请更换手册地址");
  if (value.startsWith("placement:") && !DEFAULT_RESOURCES[value]) fail("该页面位置尚未接入");
  return value;
}
function documentBody(input) {
  if (input.format !== "markdown") {
    if (input.format !== undefined && input.format !== "blocks") fail("正文格式无效");
    if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail("旧正文版本暂不支持");
    if (input.markdown !== undefined || input.mediaIds !== undefined || input.anchorAliases !== undefined) fail("旧格式不能夹带Markdown正文");
    return { ...(input.format ? { format: "blocks", schemaVersion: 1 } : {}), sections: sections(input.sections) };
  }
  if (input.schemaVersion !== 1 || input.sections !== undefined) fail("Markdown版本或正文格式无效");
  const aliases = {};
  if (input.anchorAliases !== undefined) {
    object(input.anchorAliases, Object.keys(input.anchorAliases ?? {}), "旧锚点映射");
    if (Object.keys(input.anchorAliases).length > 100) fail("旧锚点数量过多");
    for (const [from, to] of Object.entries(input.anchorAliases)) {
      if (!idPattern.test(from) || ["__proto__", "constructor", "prototype"].includes(from) || typeof to !== "string" || !/^content-[\p{L}\p{N}_-]+$/u.test(to) || to.length > 250) fail("旧锚点映射无效");
      aliases[from] = to;
    }
  }
  const ids = input.mediaIds === undefined ? [] : strings(input.mediaIds, 300, 128, "正文媒体引用").map(id => mediaId(id));
  if (new Set(ids).size !== ids.length) fail("正文媒体引用重复");
  return { format: "markdown", schemaVersion: 1, markdown: text(input.markdown, MAX_RESOURCE_BYTES, "Markdown正文", true), mediaIds: ids.sort(), ...(Object.keys(aliases).length ? { anchorAliases: aliases } : {}) };
}
function validateResource(key, input) {
  validateResourceKey(key);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("内容格式无效");
  const builtin = DEFAULT_RESOURCES[key];
  if (key.startsWith("guide:") ? input.kind !== "guide" : input.kind !== builtin.kind) fail("内容类型与展示位置不匹配");
  let result;
  if (input.kind === "carousel") {
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
    object(input, ["kind", "id", "slug", "title", "summary", "category", "audience", "game", "keywords", "updatedAt", "sections", "related", "contactCta", "format", "schemaVersion", "markdown", "mediaIds", "anchorAliases"], "手册");
    if (input.slug !== key.slice(6) || !slugPattern.test(input.slug)) fail("文章地址与位置不一致");
    if (!categories.includes(input.category)) fail("帮助分类无效");
    const audience = strings(input.audience, 3, 10, "适用对象");
    if (!audience.length || new Set(audience).size !== audience.length || audience.some((item) => !["renter", "owner", "all"].includes(item))) fail("适用对象无效");
    if (typeof input.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.updatedAt) || !Number.isFinite(Date.parse(input.updatedAt)) || new Date(input.updatedAt).toISOString().slice(0, 10) !== input.updatedAt) fail("更新日期无效");
    const related = strings(input.related, 20, 100, "相关文章");
    if (related.some((slug) => !slugPattern.test(slug) || slug === input.slug) || new Set(related).size !== related.length) fail("相关文章地址重复或无效");
    result = { kind: "guide", id: text(input.id, 100, "文章编号"), slug: input.slug, title: text(input.title, 200, "标题"), summary: text(input.summary, 500, "摘要", true), category: input.category, audience, ...(input.game === undefined ? {} : { game: text(input.game, 100, "适用游戏") }), keywords: strings(input.keywords, 30, 100, "关键词"), updatedAt: input.updatedAt, ...documentBody(input), related, ...(input.contactCta === undefined ? {} : { contactCta: boolean(input.contactCta, "客服入口") }) };
  } else if (input.kind === "notice") {
    object(input, ["kind", "title", "sections", "format", "schemaVersion", "markdown", "mediaIds", "anchorAliases"], "场景说明");
    result = { kind: "notice", title: text(input.title, 200, "标题"), ...documentBody(input) };
    const compact = ["PUBLISH_SAFE_BOX", "PUBLISH_RESOURCES", "PUBLISH_TERM", "RENTAL_FEES"].includes(key.slice(10));
    if (result.format !== "markdown" && result.sections.length > (compact ? 1 : 8)) fail("该位置的章节数量过多");
    if (result.format !== "markdown" && result.sections.some(section => section.blocks.some(item => !["paragraph", "list", "callout"].includes(item.type)))) fail("流程说明不支持图片、链接或表格，请放入完整手册");
    if (compact && result.format !== "markdown" && resourceText(result).length > 1200) fail("该位置适合简短说明，完整规则请放入手册");
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
  if (value.kind === "carousel") for (const slide of value.slides) ids.push(...[slide.mediaId, slide.mobileMediaId].filter(Boolean));
  if (value.kind === "contact" && value.qrMediaId) ids.push(value.qrMediaId);
  if (value.kind === "banner") ids.push(...[value.mediaId, value.mobileMediaId].filter(Boolean));
  if (value.kind === "guide" || value.kind === "notice") {
    if (value.format === "markdown") ids.push(...value.mediaIds);
    else for (const section of value.sections) for (const item of section.blocks) if (item.type === "image") ids.push(item.mediaId);
  }
  return [...new Set(ids)].sort();
}
function resourceText(value) {
  if (value.kind === "carousel") return [value.title, ...value.slides.map((slide) => `${slide.title}\n${slide.description}`)].join("\n\n");
  if (value.kind === "contact") return [value.title, value.description, value.handle].join("\n");
  if (value.kind === "banner") return [value.title, value.description].join("\n");
  if (value.format === "markdown") return [value.title, value.kind === "guide" ? value.summary : "", value.markdown].join("\n\n");
  return [value.title, value.kind === "guide" ? value.summary : "", ...value.sections.flatMap((section) => [section.title, ...section.blocks.map((item) => item.type === "list" ? item.items.join("\n") : item.type === "table" ? [item.columns, ...item.rows].map((row) => row.join(" | ")).join("\n") : item.type === "image" ? item.alt : item.text)])].join("\n\n");
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
exports.DEFAULT_GUIDES = DEFAULT_GUIDES;
exports.RESOURCE_DEFINITIONS = RESOURCE_DEFINITIONS;
exports.DEFAULT_RESOURCES = DEFAULT_RESOURCES;
exports.validateResource = validateResource;
exports.validateResourceKey = validateResourceKey;
exports.resourceMediaIds = resourceMediaIds;
exports.safeContentLink = safeContentLink;
exports.resourceText = resourceText;
exports.validateResourceMedia = validateResourceMedia;
