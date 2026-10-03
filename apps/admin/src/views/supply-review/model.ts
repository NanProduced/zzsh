/**
 * 账号监管工作台的纯数据模型与格式化:类型沿用 API 返回,函数不依赖 React/DOM,
 * 便于 node --experimental-strip-types 直接测试。
 *
 * 语义基线(PUB-1/2 已合):直发版本状态 PUBLISHED + 唯一发布事实(OWNER_DIRECT),
 * 历史审核发布 APPROVED + LEGACY_APPROVED 事实;staff_restricted 隐藏公开展示并阻止新单;
 * 展示图以免审/受权恢复 + 技术就绪为公开资格,凭证始终私有。
 */

export type QueueItem = {
  id: string;
  game_id: string;
  title: string | null;
  owner_name: string;
  game_name: string;
  review_state: string;
  sequence: string;
  owner_paused: boolean;
  staff_restricted: boolean;
};

export type Declaration = {
  attributes: Record<string, unknown>;
  title: string;
  description: string | null;
  inventory: Array<{ itemId: string; quantity: string | null }>;
  skins: string[];
  entitlements: Array<{ entitlementId: string; value: unknown; expiresAt: string | null }>;
  mediaBindings: MediaBinding[];
};

export type MediaBinding = {
  assetId: string;
  purpose: string | null;
  position: number;
  byteHash?: string | null;
  mediaRevision?: string | null;
  reviewState?: string | null;
  /** 服务端投影:具备公开展示资格(技术就绪+衍生图+绑定/用途正确) */
  publicDisplayEligible?: boolean;
  /** 服务端投影:当前公开路由可读(账号公开+资格+当前版本绑定) */
  publiclyReadable?: boolean;
};

export type SupplyWorkView = "all" | "changes" | "restricted" | "paused" | "orders";
export type SupplyQueryKind = "account" | "legacy" | "owner" | "nickname" | "order" | "link";
export type SupplyFacts = { publicVisible: boolean | null; publicSource: string | null; newOrders: boolean | null; reasons: string[]; primaryReasonCode?: string | null; ownerPaused: boolean; staffRestricted: boolean; occupancy: "FREE" | "OCCUPIED" | "UNKNOWN"; sources: Array<{ sourceSystem: string; sourceEntity: string; sourceId: string; businessNo: string | null }>; legacyNumbers: string[] };
export type SupplyWorkItem = { id: string; accountId: string; displayNo: string | null; ownerId: string; ownerName: string; revision: string; gameName: string; versionId: string | null; sequence: string | null; title: string | null; reviewState: string | null; sortAt: string; facts: SupplyFacts };
export type SupplyWorkPage = { contractVersion: string; contextKey: string; items: SupplyWorkItem[]; nextCursor: string | null; stationOrigins: { admin: string; user: string }; games?: Array<{ id: string; name: string }> };
export type RestrictionEvent = { id: string; reason: string | null; occurredAt: string; actorName: string | null; beforeRevision: string | null; afterRevision: string | null; versionId: string | null; restricted: boolean | null };
export type SupplyWorkDetail = Omit<Detail, "version"> & {
  contractVersion: string; contextKey: string; version: Version | null;
  account: Detail["account"] & { display_no: string | null; owner_user_id: string };
  supervision: { historical: boolean; facts: SupplyFacts; changes: { previousVersionId: string; previousSequence: string; changed: boolean } | null; previousVersion: Version | null; originalRestrictionVersion?: Version | null; restrictionHistory: { state: "KNOWN" | "NOT_RECORDED"; items: RestrictionEvent[]; limit: number }; ownerLink: { state: "READY" | "DENIED"; userId?: string }; orders: { state: "READY" | "DENIED"; total?: number; items?: SupplyLinkedOrder[] } };
};
export type SupplyLinkedOrder = { id: string; displayNo: string; ownerName: string | null; ownerUserId: string; renterName: string | null; renterUserId?: string | null; status: string; versionId: string | null; payment: { state: string }; source: { origin: string; statusLabel?: string } };
export function orderPaymentText(state: string): string {
  return state === "RECORDED_PAID" ? "支付已记录" : state === "RECORDED_UNPAID" ? "未记录付款" : "付款事实待核";
}
/** 只交接受权订单投影；原版本缺失时不拿当前资料补齐。 */
export function orderHandoff(detail: SupplyWorkDetail, order: SupplyLinkedOrder, accountSummary: string): string {
  if (detail.supervision.orders.state !== "READY" || !detail.supervision.orders.items?.some(item => item.id === order.id)) return "没有本单读取依据，不能生成本单摘要。";
  return [
    "本单：" + order.displayNo + " · " + order.id,
    "订单来源：" + (order.source.origin === "LEGACY" ? "旧来源" : order.source.origin === "NATIVE" ? "原生订单" : "来源待核"),
    "本单阶段：" + (order.source.statusLabel ?? order.status) + "；" + orderPaymentText(order.payment.state),
    "本单原号主：" + (order.ownerName ?? "未提供") + " · " + order.ownerUserId,
    "本单租客：" + (order.renterName ?? "未提供") + " · " + (order.renterUserId ?? "稳定ID未提供"),
    "订单冻结资料：" + (order.versionId ?? "旧版本引用未完整，不能用当前资料替代"),
    order.ownerUserId === detail.account.owner_user_id ? "当前号主与本单原号主相同。" : "当前号主与本单原号主不同。",
    "当前账号核对：", accountSummary,
    "当前账号处置不自动改变本单原主体、冻结资料、金额或履约事实；本单问题沿既有订单详情核对。",
  ].join("\n");
}
/** 当前受权事实的快照，不推算解除后可租或发布。 */
export function restrictionConditions(detail: SupplyWorkDetail): string[] {
  const version = detail.version, facts = detail.supervision.facts;
  const remaining = [...new Set(facts.reasons.filter(code => code !== "STAFF_RESTRICTED" && code !== "OWNER_PAUSED"))];
  return [
    "号主暂停：" + (detail.account.owner_paused ? "已暂停，须由号主独立恢复" : "当前未暂停"),
    "本版资料：" + (version ? reviewStateLabel(version.reviewState) + "；发布记录：" + (version.publication ? publicationSourceLabel(version.publication.source) : "无记录") : "当前版本未提供"),
    "其余阻断（当前读取）：" + (remaining.map(blockerLabel).join("；") || "服务端未返回其余阻断"),
    ...(facts.publicVisible === null || facts.newOrders === null ? ["公开或新单资格仍有待核依据，处置后须重新读取。"] : []),
  ];
}
export function supplyObjectLabel(item: { id?: string; displayNo?: string | null; accountId?: string; facts?: SupplyFacts }): string {
  if (item.displayNo) return item.displayNo;
  if (item.facts?.legacyNumbers.length === 1) return `旧来源号 ${item.facts.legacyNumbers[0]}`;
  return `账号 ${shortId(item.accountId ?? item.id ?? "")}`;
}
export function supplyFactText(facts: SupplyFacts) {
  return { display: facts.publicVisible === null ? "公开状态待核" : facts.publicVisible ? "当前公开展示" : "当前未公开", newOrders: facts.newOrders === null ? "新单资格待核" : facts.newOrders ? "可接新订单" : "不能接新订单", reason: facts.primaryReasonCode ? blockerLabel(facts.primaryReasonCode) : facts.staffRestricted ? "运营限制尚未解除" : facts.ownerPaused ? "号主暂停公开" : facts.reasons.map(blockerLabel).join("；") || "当前读取依据完整" };
}
export function knownSupplyLink(value: string, origins: { admin: string; user: string }): { kind: "account" | "order"; id: string } | null {
  try {
    const link = new URL(value, value.startsWith("/orders/") || value.startsWith("/supply/") ? origins.admin : origins.user), id = "([A-Za-z0-9][A-Za-z0-9._:-]{0,127})";
    if (link.username || link.password) return null;
    if (link.origin === new URL(origins.user).origin) { const match = new RegExp(`^/accounts/${id}/?$`).exec(link.pathname); if (match) return { kind: "account", id: match[1]! }; }
    if (link.origin === new URL(origins.admin).origin) { const match = new RegExp(`^/supply/(?:reviews|accounts)/${id}/?$`).exec(link.pathname); if (match) return { kind: "account", id: match[1]! }; const order = new RegExp(`^/orders/${id}/?$`).exec(link.pathname); if (order) return { kind: "order", id: order[1]! }; }
  } catch { /* An unknown address is not fetched. */ }
  return null;
}

export type CodeDisplay = {
  code: string;
  displayName: string | null;
  mappingStatus: "CONFIRMED" | "UNCONFIRMED";
  issueCode: string | null;
};

export type AttributeDisplay = {
  safeBox: CodeDisplay | null;
  grading: CodeDisplay | null;
  loginMethod: CodeDisplay | null;
  serviceWindow: { startMinute: number; endMinute: number; displayName: string } | null;
};

export type PresentationItem = { id: string; name: string; unit: string };
export type PresentationSkin = { id: string; name: string; categoryCode?: string; categoryName?: string };
export type Presentation = {
  items?: PresentationItem[];
  skins?: PresentationSkin[];
  entitlements?: Array<{ id: string; name: string }>;
};

export type PublicationFact = {
  source: string;
  publishedAt: string;
};

export type Version = {
  id: string;
  sequence: string;
  reviewState: string;
  releaseId: string | null;
  contentHash: string | null;
  publication?: PublicationFact | null;
  termOption?: {
    code: string;
    displayName: string | null;
    dailyConsumption: { quantity: string; unit: "HAFF_BASE" } | null;
  } | null;
  attributeDisplay?: AttributeDisplay;
  declaration: Declaration;
  presentation: Presentation;
  quote: { resourceTotal: { amount: string }; termSeconds: string } | null;
};

export type VersionHistoryEntry = {
  id: string;
  sequence: string;
  origin: string;
  review_state: string;
  title: string | null;
  content_hash: string | null;
  rule_release_id: string | null;
  created_at: string;
};

export type Detail = {
  account: {
    id: string;
    game_id: string;
    revision: string;
    owner_paused: boolean;
    staff_restricted: boolean;
    restriction_reason: string | null;
  };
  ownerName: string;
  version: Version;
  history?: VersionHistoryEntry[];
  previousDeclaration: Declaration | null;
  previousPresentation?: { items?: Array<{ id: string; name: string }>; skins?: Array<{ id: string; name: string }> };
  decisions: Array<{
    id: string;
    decision: string;
    reason: string;
    reviewer_name: string;
    decided_at: string;
  }>;
  duplicateHints: Array<{ id: string; result: string; reason: string }>;
  blockers: string[];
  available: boolean;
};

/* ---------- 监管视图与状态标签 ---------- */

export type SupervisionView = "PUBLISHED" | "APPROVED" | "LEGACY";

export const SUPERVISION_VIEWS: ReadonlyArray<{ value: SupervisionView; label: string; hint: string }> = [
  { value: "PUBLISHED", label: "在架直发", hint: "号主直发上架的账号(免人工预审)" },
  { value: "APPROVED", label: "历史审核发布", hint: "免审政策前经人工审核发布的账号" },
  { value: "LEGACY", label: "历史记录", hint: "草稿/待审/退回/撤回/导入未核实,不属于当前在架" },
];

export const LEGACY_STATES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "SUBMITTED", label: "历史待审" },
  { value: "REJECTED", label: "已退回" },
  { value: "WITHDRAWN", label: "已撤回" },
  { value: "DRAFT", label: "草稿" },
  { value: "IMPORTED_UNVERIFIED", label: "导入未核实" },
];

const STATE_LABELS: Record<string, string> = {
  PUBLISHED: "已发布(直发)",
  APPROVED: "已通过(历史审核)",
  SUBMITTED: "历史待审",
  REJECTED: "已退回",
  WITHDRAWN: "已撤回",
  DRAFT: "草稿",
  IMPORTED_UNVERIFIED: "导入未核实",
};

export function reviewStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function publicationSourceLabel(source: string | null | undefined): string {
  if (source === "OWNER_DIRECT") return "号主直发";
  if (source === "LEGACY_APPROVED") return "历史审核发布";
  return "来源未确认";
}

/* ---------- 阻塞与可租资格 ---------- */

const BLOCKER_LABELS: Record<string, string> = {
  OWNER_UNAVAILABLE: "号主不可用",
  IDENTITY_REQUIRED: "号主未实名",
  ADULT_REQUIRED: "号主未成年",
  GAME_UNAVAILABLE: "游戏不可用",
  GAME_SERVICE_UNAVAILABLE: "租赁服务未启用",
  RULE_CHANGED: "规则已切换(需新版本)",
  ACCOUNT_NOT_PUBLISHABLE: "账号不可发布(历史/归档)",
  PUBLISHER_BAIL_UNCONFIRMED: "号主保证金未确认",
  FUNDING_UNKNOWN: "资金资格依据尚未核定",
  OCCUPIED: "租用占用中",
  OCCUPANCY_UNKNOWN: "占用状态未知",
  PUBLICATION_REQUIRED: "无有效发布事实",
  CURRENT_VERSION_MISSING: "尚无当前资料版本",
  OWNER_PAUSED: "号主已暂停",
  STAFF_RESTRICTED: "运营限制中",
  CONFIRMATION_OR_MEDIA_REQUIRED: "规则接受或展示图不满足",
  HISTORICAL_VERSION: "历史版本(只读)",
};

export function blockerLabel(code: string): string {
  return BLOCKER_LABELS[code] ?? code;
}

/** 有效可租 = 服务端 available 且未被号主暂停、未被运营限制;已发布不等于当前一定可租。 */
export function effectiveRentable(detail: Pick<Detail, "available" | "account">): boolean {
  return detail.available && !detail.account.owner_paused && !detail.account.staff_restricted;
}

export function availabilityText(detail: Detail): string {
  if (detail.account.staff_restricted) return "运营限制中(已隐藏公开展示并阻止新订单)";
  if (detail.account.owner_paused) return "号主已暂停(隐藏于公开列表)";
  if (detail.available) return "当前可公开出租";
  return "当前不可租(存在阻塞项)";
}

/* ---------- 媒体状态 ---------- */

export function mediaPurposeLabel(binding: MediaBinding): string {
  return binding.purpose === "ACCOUNT_DISPLAY" ? "展示图" : "私有凭证";
}

export function mediaReviewLabel(binding: MediaBinding): string {
  const state = binding.reviewState;
  if (state === "NOT_REQUIRED") return "免人工预审";
  if (state === "QUARANTINED") return "已隔离";
  if (state === "APPROVED") return "已通过(受权)";
  if (state === "REJECTED") return "已驳回";
  if (state === "PENDING") return binding.purpose === "ACCOUNT_DISPLAY" ? "状态未确认" : "已上传(私有)";
  return "状态未确认";
}

export function mediaEligibleLabel(binding: MediaBinding): string {
  if (binding.purpose !== "ACCOUNT_DISPLAY") return "不参与公开展示";
  return binding.publicDisplayEligible ? "具备展示资格" : "不具备展示资格";
}

export function mediaReadableLabel(binding: MediaBinding): string {
  if (binding.purpose !== "ACCOUNT_DISPLAY") return "仅审核可见";
  return binding.publiclyReadable ? "当前公开可读" : "当前公开不可读";
}

/** 展示图是否可执行恢复:当前被隔离(技术就绪由服务端复核,不满足返回明确错误)。 */
export function mediaCanRestore(binding: MediaBinding): boolean {
  return binding.purpose === "ACCOUNT_DISPLAY" && binding.reviewState === "QUARANTINED";
}

/** 展示图是否可执行隔离:当前非隔离、非驳回。 */
export function mediaCanQuarantine(binding: MediaBinding): boolean {
  return binding.purpose === "ACCOUNT_DISPLAY" && binding.reviewState !== "QUARANTINED" && binding.reviewState !== "REJECTED";
}

/* ---------- 历史版本只读 ---------- */

export const HISTORICAL_BLOCKER = "HISTORICAL_VERSION";

export function isHistorical(detail: Pick<Detail, "blockers"> | undefined): boolean {
  return Boolean(detail?.blockers.includes(HISTORICAL_BLOCKER));
}

/* ---------- 队列键盘 ---------- */

export function cursorDelta(key: string): number | null {
  if (key === "j" || key === "ArrowDown") return 1;
  if (key === "k" || key === "ArrowUp") return -1;
  return null;
}

export function moveCursorId(
  items: ReadonlyArray<{ id: string }>,
  currentId: string | undefined,
  delta: number,
): string | null {
  if (items.length === 0) return null;
  const index = items.findIndex((item) => item.id === currentId);
  if (index < 0) return items[0]!.id;
  const next = Math.min(Math.max(index + delta, 0), items.length - 1);
  return items[next]!.id;
}

export function lightboxKeyAction(key: string): "close" | null {
  return key === "Escape" ? "close" : null;
}

export type ZoomTarget = { src: string; alt: string; caption: string };

export function mediaContentUrl(assetId: string): string {
  return `/api/bff/admin/supply/media/${assetId}/content`;
}

export function reasonIsDirty(reason: string): boolean {
  return reason.trim().length > 0;
}

/* ---------- 格式化(十进制字符串,不经浮点) ---------- */

export function formatAmount(amount: string): string {
  const [integer = "", fraction] = amount.split(".");
  const negative = integer.startsWith("-");
  const digits = negative ? integer.slice(1) : integer;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function formatTermDays(termSeconds: string): string {
  if (!/^\d+$/.test(termSeconds)) return "未确认";
  return `${BigInt(termSeconds) / 86400n} 天`;
}

export function quantityText(value: string | null | undefined): string {
  if (!value || !/^\d+$/.test(value)) return "未确认";
  const amount = BigInt(value);
  const millions = amount / 1_000_000n;
  const remainder = amount % 1_000_000n;
  return remainder === 0n
    ? `${millions} M 哈夫币`
    : `${millions}.${remainder.toString().padStart(6, "0").replace(/0+$/, "")} M 哈夫币`;
}

export function unitText(unit: string | null | undefined): string {
  if (unit === "HAFF_BASE") return "哈夫币";
  if (unit === "ROUND") return "发";
  if (unit === "DAY") return "天";
  if (unit === "PIECE") return "件";
  return "单位待核";
}

export function formatBytes(value: string | number): string {
  const bytes = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]!}`;
}

export function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

/* ---------- 属性与资源映射 ---------- */

export type AttributeFact = { label: string; value: string; unconfirmed: boolean };

function codeFact(label: string, display: CodeDisplay | null | undefined, raw: unknown): AttributeFact {
  if (display?.displayName) return { label, value: display.displayName, unconfirmed: false };
  const code = display?.code ?? (raw === null || raw === undefined || raw === "" ? "" : String(raw));
  return code
    ? { label, value: `未确认(代码 ${code})`, unconfirmed: true }
    : { label, value: "未申报", unconfirmed: false };
}

function levelFact(label: string, raw: unknown): AttributeFact {
  const missing = raw === null || raw === undefined || raw === "";
  return { label, value: missing ? "未申报" : `${String(raw)} 级`, unconfirmed: false };
}

export function attributeFacts(version: Version): AttributeFact[] {
  const attributes = version.declaration.attributes;
  const display = version.attributeDisplay;
  const region = [attributes.region_province, attributes.region_city]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(" · ");
  const term = version.termOption;
  return [
    codeFact("安全箱配置", display?.safeBox, attributes.safe_box_code),
    levelFact("体力等级", attributes.vit_level),
    levelFact("负重等级", attributes.bear_level),
    levelFact("潜水等级", attributes.dive_level),
    levelFact("角色等级", attributes.character_level),
    codeFact("段位", display?.grading, attributes.grading_code),
    codeFact("登录方式", display?.loginMethod, attributes.login_method_code),
    { label: "绝密 KD", value: attributes.secret_kd === null || attributes.secret_kd === undefined || attributes.secret_kd === "" ? "未申报" : String(attributes.secret_kd), unconfirmed: false },
    { label: "地区", value: region || "未申报", unconfirmed: false },
    { label: "上号时间", value: display?.serviceWindow?.displayName ?? "未确认", unconfirmed: !display?.serviceWindow?.displayName },
    {
      label: "租期规则",
      value: term?.displayName ?? (term ? `未确认(代码 ${term.code})` : "未申报"),
      unconfirmed: Boolean(term) && !term?.displayName,
    },
    { label: "每日消耗", value: quantityText(term?.dailyConsumption?.quantity), unconfirmed: false },
  ];
}

export type InventoryRow = {
  itemId: string;
  name: string;
  unit: string;
  previous: string;
  current: string;
  changed: boolean;
};

function quantityOrLabel(value: string | null | undefined, missing: string): string {
  if (value === undefined) return missing;
  if (value === null) return "数量未知";
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString("zh-CN") : "数量未知";
}

export function inventoryRows(
  version: Version,
  previous: Declaration | null,
  previousItems?: Array<{ id: string; name: string }>,
): InventoryRow[] {
  const ids = [
    ...new Set([
      ...version.declaration.inventory.map((item) => item.itemId),
      ...(previous?.inventory.map((item) => item.itemId) ?? []),
    ]),
  ];
  return ids.map((itemId) => {
    const item = version.declaration.inventory.find((entry) => entry.itemId === itemId);
    const previousQuantity = previous?.inventory.find((entry) => entry.itemId === itemId)?.quantity;
    const presentation = version.presentation.items?.find((entry) => entry.id === itemId);
    return {
      itemId,
      name: presentation?.name ?? previousItems?.find((entry) => entry.id === itemId)?.name ?? "历史物品",
      unit: unitText(presentation?.unit),
      previous: quantityOrLabel(previousQuantity, "未申报"),
      current: item ? quantityOrLabel(item.quantity, "数量未知") : "本次未申报",
      changed: previousQuantity !== undefined && previousQuantity !== item?.quantity,
    };
  });
}

export function skinsText(version: Version): string {
  return (
    version.presentation.skins
      ?.map((skin) => (skin.categoryName ? `${skin.categoryName} · ${skin.name}` : skin.name))
      .join("、") || (version.declaration?.skins?.length ? "皮肤名称或归属尚未核齐" : version.declaration ? "未申报皮肤" : "皮肤资料未提供")
  );
}
