/**
 * 客服管理（看板/巡视）的纯数据层。
 *
 * 服务端契约可能先于前端落地，或被裁剪；这里只做“容错读取 + 不算假数”：
 * 统计必需字段缺失直接判为不完整，不能适配成真实 0；quality/queue/period 等
 * 可选旧兼容字段才保持 null。统计口径（北京时间自然日）由服务端决定，前端不推断。
 */
import { mergeImMessages } from "@zzsh/im-client/message-state";
import { nimMessageView, type NimMessageLike } from "@zzsh/im-client/nim-web-client";
import { BEIJING_TIME_ZONE, beijingTodayStart } from "../workspace/beijing-time";

export type SupportOverviewAgent = {
  adminUserId: string;
  name: string;
  availability: string;
  connectionState: string;
  activeLoad: number;
  todaySeconds: number;
  todaySessions: number;
  todayUsers: number;
  currentOrderGroups: number;
  /** 服务端接待容量上限；未提供时 null，不能拿它推断“满载”。 */
  capacityLimit: number | null;
  /** 咨询 + 在租订单群的当前合计负载；服务端未提供时回退 activeLoad。 */
  totalLoad: number;
  /** 服务端判定的满载；未提供时 null，不是 false。 */
  atCapacity: boolean | null;
};

export type SupportTotals = {
  onDutyCount: number;
  waitingConsultations: number;
  todaySessions: number;
  todayUsers: number;
  /** TRANSFERRED 事件所选期间计数；未提供时 null（不是 0）。 */
  transfersToday: number | null;
  /** im_support_handover 所选期间 DB 全量计数；未提供时 null（不是 0，也不受列表单页上限影响）。 */
  handoversToday: number | null;
};

export type SupportFirstResponseQuality = {
  /** 服务端的首响 SLA 阈值（秒）；未提供时 null。 */
  slaSeconds: number | null;
  /** 所选期间样本平均首响；无样本时 null（不是 0）。 */
  averageSeconds: number | null;
  sampleCount: number;
  askedCount?: number;
  breached: number;
  pending: number;
  overdue: number;
};

export type SupportResolutionQuality = { averageSeconds: number | null; sampleCount: number };

/** 服务时效段；服务端还没给整段时为 null，UI 才挂「服务端未提供」。 */
export type SupportQuality = {
  firstResponse: SupportFirstResponseQuality | null;
  resolution: SupportResolutionQuality | null;
};

export type SupportQueueReason = "NO_ONLINE_STAFF" | "ALL_AT_CAPACITY" | "CAPACITY_AVAILABLE" | "UNKNOWN";

export type SupportQueueSnapshot = {
  queued: number;
  oldestQueuedAt: string | null;
  oldestWaitSeconds: number | null;
  onDuty: number;
  withFreeSlot: number;
  atCapacity: number;
  capacityLimit: number | null;
  reason: SupportQueueReason;
};

export type SupportTrendPoint = { date: string; sessions: number; users: number };
export type SupportHourlyPoint = { hour: number; sessions: number };
export type SupportReportPeriod = {
  dateFrom: string;
  dateTo: string;
  days: number;
  timeZone: "Asia/Shanghai";
  trendFrom: string;
  trendTo: string;
};
export type SupportRatingAgent = { adminUserId: string; name: string; count: number; average: number | null };
export type SupportRatings = {
  count: number;
  average: number | null;
  /** 1..5 星各自数量；索引 0 是 1 星。 */
  distribution: [number, number, number, number, number];
  agents: SupportRatingAgent[];
};
export type SupportOverview = {
  reportDate: string;
  serverNow: string;
  period: SupportReportPeriod | null;
  onDuty: SupportOverviewAgent[];
  totals: SupportTotals;
  trend: SupportTrendPoint[];
  hourly: SupportHourlyPoint[];
  ratings: SupportRatings;
  /** 服务时效投影；服务端未提供时为 null。 */
  quality: SupportQuality | null;
  /** 排队与容量投影；服务端未提供时为 null。 */
  queue: SupportQueueSnapshot | null;
};

export type SupportHandover = {
  id: string;
  objectType: string;
  objectId: string;
  display: string;
  fromName: string;
  toName: string;
  note: string | null;
  createdAt: string;
};

export type AuditConversationType = "SERVICE" | "COMPLAINT" | "ORDER" | "UNKNOWN";
export type AuditConversation = {
  id: string;
  type: AuditConversationType;
  title: string;
  userName: string;
  userAvatar?: string | null;
  adminUserId: string | null;
  adminName: string;
  state: string;
  lastMessageAt: string | null;
  conversationId: string | null;
  displayNo: string | null;
  gameName: string | null;
  adminUnreadCount?: number;
  userUnreadCount?: number;
  firstUserMessageAt?: string | null;
  historyState?: "AVAILABLE" | "NOT_ESTABLISHED" | "LEGACY_UNAVAILABLE" | "RECOVERING" | string;
  firstResponseAt?: string | null;
  remindDueAt?: string | null;
  addRound?: number;
  escalationState?: string | null;
};

export type AuditPage<T> = { items: T[]; nextCursor: string | null };
export type AuditMessagePage = { messages: AuditMessage[]; nextCursor: string | null };

export type AuditTimeFilter = "all" | "today" | "7d";

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** 只有明确是有限非负数才算“服务端给了数”；缺失或非法一律 null，不补 0。 */
function maybeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 时长类接受 0：服务端用 sampleCount 判“有无样本”，均值可能被四舍五入成 0 秒。
 * 只有字段缺失或非法值才是 null。
 */
function maybeSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseFirstResponse(value: unknown): SupportFirstResponseQuality | null {
  const row = recordOf(value);
  if (!Object.keys(row).length) return null;
  return {
    slaSeconds: maybeCount(row.slaSeconds),
    averageSeconds: maybeSeconds(row.averageSeconds),
    sampleCount: count(row.sampleCount),
    askedCount: maybeCount(row.askedCount) ?? undefined,
    breached: count(row.breached),
    pending: count(row.pending),
    overdue: count(row.overdue),
  };
}

function parseResolution(value: unknown): SupportResolutionQuality | null {
  const row = recordOf(value);
  if (!Object.keys(row).length) return null;
  return { averageSeconds: maybeSeconds(row.averageSeconds), sampleCount: count(row.sampleCount) };
}

function parseQuality(value: unknown): SupportQuality | null {
  const root = recordOf(value);
  if (!Object.keys(root).length) return null;
  return { firstResponse: parseFirstResponse(root.firstResponse), resolution: parseResolution(root.resolution) };
}

function parseQueue(value: unknown): SupportQueueSnapshot | null {
  const row = recordOf(value);
  if (!Object.keys(row).length) return null;
  const reason: SupportQueueReason = row.reason === "NO_ONLINE_STAFF" || row.reason === "ALL_AT_CAPACITY" || row.reason === "CAPACITY_AVAILABLE"
    ? row.reason
    : "UNKNOWN";
  return {
    queued: count(row.queued),
    oldestQueuedAt: text(row.oldestQueuedAt) || null,
    oldestWaitSeconds: maybeCount(row.oldestWaitSeconds),
    onDuty: count(row.onDuty),
    withFreeSlot: count(row.withFreeSlot),
    atCapacity: count(row.atCapacity),
    capacityLimit: maybeCount(row.capacityLimit),
    reason,
  };
}

/** 秒 -> “Xh Ym”。缺失/非法一律 “—”，不把未知写成 0。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** /im/presence 的 today 秒数；服务端未提供时返回 null。 */
export function todaySecondsOf(presence: unknown): number | null {
  const today = recordOf(recordOf(presence).today);
  return typeof today.seconds === "number" && Number.isFinite(today.seconds) && today.seconds >= 0 ? today.seconds : null;
}

function isSupportDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requiredCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`客服统计数据不完整：${field}`);
  return value;
}

/** 区间元数据是可选旧兼容字段；存在时必须完整、可核对，不能拿缺失值猜区间。 */
export function parseSupportPeriod(value: unknown): SupportReportPeriod | null {
  if (value === undefined || value === null) return null;
  const row = recordOf(value);
  const dateFrom = text(row.dateFrom);
  const dateTo = text(row.dateTo);
  const trendFrom = text(row.trendFrom);
  const trendTo = text(row.trendTo);
  const days = row.days;
  if (!isSupportDay(dateFrom) || !isSupportDay(dateTo) || !isSupportDay(trendFrom) || !isSupportDay(trendTo)) {
    throw new Error("客服统计数据不完整：period 日期");
  }
  if (row.timeZone !== "Asia/Shanghai") throw new Error("客服统计数据不完整：period 时区");
  const computedDays = Math.round((Date.parse(`${dateTo}T00:00:00.000Z`) - Date.parse(`${dateFrom}T00:00:00.000Z`)) / 86_400_000) + 1;
  if (computedDays < 1 || computedDays > 366 || days !== computedDays || dateFrom > dateTo || trendFrom > trendTo) {
    throw new Error("客服统计数据不完整：period 区间");
  }
  return { dateFrom, dateTo, days: computedDays, timeZone: "Asia/Shanghai", trendFrom, trendTo };
}

function parseAgent(value: unknown): SupportOverviewAgent {
  const row = recordOf(value);
  const adminUserId = text(row.adminUserId);
  if (!adminUserId) throw new Error("客服统计数据不完整：客服身份");
  const activeLoad = requiredCount(row.activeLoad, "客服当前接待");
  const todaySeconds = requiredCount(row.todaySeconds, "客服期间时长");
  const todaySessions = requiredCount(row.todaySessions, "客服期间会话");
  const todayUsers = requiredCount(row.todayUsers, "客服期间用户");
  const currentOrderGroups = requiredCount(row.currentOrderGroups, "客服负责订单群");
  const totalLoad = maybeCount(row.totalLoad);
  return {
    adminUserId,
    name: text(row.name) || "未命名客服",
    availability: text(row.availability) || "UNKNOWN",
    connectionState: text(row.connectionState) || "UNKNOWN",
    activeLoad,
    todaySeconds,
    todaySessions,
    todayUsers,
    currentOrderGroups,
    capacityLimit: maybeCount(row.capacityLimit),
    totalLoad: totalLoad === null ? activeLoad : totalLoad,
    atCapacity: typeof row.atCapacity === "boolean" ? row.atCapacity : null,
  };
}

function parseTrend(value: unknown): SupportTrendPoint | null {
  const row = recordOf(value);
  const date = text(row.date);
  return date ? { date, sessions: count(row.sessions), users: count(row.users) } : null;
}

function parseHourly(value: unknown): SupportHourlyPoint | null {
  const row = recordOf(value);
  const hour = row.hour;
  return typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= 23
    ? { hour, sessions: count(row.sessions) }
    : null;
}

/** 平均分只接受 1..5 的有限数；缺失或越界一律 null，不用 0 分补位。 */
function ratingAverage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 5 ? value : null;
}

function parseRatingAgent(value: unknown): SupportRatingAgent | null {
  const row = recordOf(value);
  const adminUserId = text(row.adminUserId);
  if (!adminUserId) return null;
  return { adminUserId, name: text(row.name) || "未命名客服", count: count(row.count), average: ratingAverage(row.average) };
}

function parseRatings(value: unknown): SupportRatings {
  const root = recordOf(value);
  if (!Object.keys(root).length) throw new Error("客服统计数据不完整：评价");
  const countValue = requiredCount(root.count, "评价数");
  if (root.average !== null && (typeof root.average !== "number" || !Number.isFinite(root.average) || root.average < 1 || root.average > 5)) {
    throw new Error("客服统计数据不完整：评价平均分");
  }
  if (!Array.isArray(root.distribution) || root.distribution.length !== 5) throw new Error("客服统计数据不完整：评价分布");
  const distribution = root.distribution.map((item, index) => requiredCount(item, `评价分布第 ${index + 1} 档`)) as SupportRatings["distribution"];
  if (root.agents !== undefined && !Array.isArray(root.agents)) throw new Error("客服统计数据不完整：按客服评价");
  return {
    count: countValue,
    average: root.average as number | null,
    distribution,
    agents: Array.isArray(root.agents)
      ? root.agents.map(parseRatingAgent).filter((agent): agent is SupportRatingAgent => agent !== null)
      : [],
  };
}

/** 平均分固定一位小数；无评价给 “—”，不把 null 写成 0.0。 */
export function formatRatingAverage(average: number | null | undefined): string {
  return typeof average === "number" && Number.isFinite(average) && average > 0 ? average.toFixed(1) : "—";
}

export function parseSupportOverview(value: unknown): SupportOverview {
  const root = recordOf(value);
  if (!Object.keys(root).length) throw new Error("客服统计数据不完整：缺少响应");
  const reportDate = text(root.reportDate);
  const serverNow = text(root.serverNow);
  if (!isSupportDay(reportDate)) throw new Error("客服统计数据不完整：报表日期");
  if (!Number.isFinite(Date.parse(serverNow))) throw new Error("客服统计数据不完整：服务器时间");
  if (!Object.keys(recordOf(root.totals)).length) throw new Error("客服统计数据不完整：汇总");
  if (!Array.isArray(root.onDuty)) throw new Error("客服统计数据不完整：客服列表");
  if (!Array.isArray(root.trend)) throw new Error("客服统计数据不完整：趋势");
  if (!Array.isArray(root.hourly)) throw new Error("客服统计数据不完整：时段");
  const totals = recordOf(root.totals);
  const onDuty = root.onDuty.map(parseAgent);
  const trend = root.trend.map(parseTrend).filter((point): point is SupportTrendPoint => point !== null);
  const hourly = root.hourly.map(parseHourly).filter((point): point is SupportHourlyPoint => point !== null);
  return {
    reportDate,
    serverNow,
    period: parseSupportPeriod(root.period),
    onDuty,
    totals: {
      onDutyCount: requiredCount(totals.onDutyCount, "当前可接待客服"),
      waitingConsultations: requiredCount(totals.waitingConsultations, "当前排队咨询"),
      todaySessions: requiredCount(totals.todaySessions, "期间有动作咨询"),
      todayUsers: requiredCount(totals.todayUsers, "期间接待用户"),
      transfersToday: maybeCount(totals.transfersToday),
      handoversToday: maybeCount(totals.handoversToday),
    },
    trend,
    hourly,
    ratings: parseRatings(root.ratings),
    quality: parseQuality(root.quality),
    queue: parseQueue(root.queue),
  };
}

function personName(value: unknown): string {
  const row = recordOf(value);
  return text(value) || text(row.name) || text(row.displayName);
}

export function parseSupportHandovers(value: unknown): SupportHandover[] {
  const items = recordOf(value).items;
  if (!Array.isArray(items)) return [];
  return items.map((value, index) => {
    const row = recordOf(value);
    return {
      id: text(row.id) || `handover-${index}`,
      objectType: text(row.objectType) || "UNKNOWN",
      objectId: text(row.objectId),
      display: text(row.display) || text(row.objectId),
      fromName: personName(row.fromName) || personName(row.from),
      toName: personName(row.toName) || personName(row.to),
      note: text(row.note) || null,
      createdAt: text(row.createdAt),
    };
  });
}

export function handoverObjectLabel(objectType: string): string {
  if (objectType === "CONSULTATION") return "咨询会话";
  if (objectType === "ORDER_GROUP") return "订单群";
  return objectType && objectType !== "UNKNOWN" ? objectType : "未标对象";
}

function conversationType(value: unknown): AuditConversationType {
  return value === "SERVICE" || value === "COMPLAINT" || value === "ORDER" ? value : "UNKNOWN";
}

function parseConversation(value: unknown): AuditConversation | null {
  const row = recordOf(value);
  const id = text(row.id);
  if (!id) return null;
  const userName = text(row.userName) || personName(row.user);
  const displayNo = text(row.displayNo) || null;
  const gameName = text(row.gameName) || null;
  const assigned = recordOf(row.assignedAdmin);
  const type = row.kind === "ORDER_GROUP" ? "ORDER" : conversationType(row.type);
  const rawState = text(row.state) || text(row.status);
  const state = type === "ORDER"
    ? (rawState === "ACTIVE" || rawState === "WAITING" || rawState === "CLOSED"
      ? rawState
      : rawState === "COMPLETED" || rawState === "CANCELLED"
        ? "CLOSED"
        : row.teamState === "READY" ? "ACTIVE" : "WAITING")
    : rawState || "UNKNOWN";
  const conversationId = text(row.conversationId) || null;
  // Order DTOs have no historyState; the server only emits a team cid when READY.
  const historyState = type === "ORDER"
    ? text(row.historyState) || (conversationId ? "AVAILABLE" : state === "CLOSED" ? "LEGACY_UNAVAILABLE" : "NOT_ESTABLISHED")
    : text(row.historyState) || undefined;
  return {
    id,
    type,
    title: text(row.title) || displayNo || userName || "未命名会话",
    userName,
    userAvatar: typeof recordOf(row.user).avatar === "string" ? recordOf(row.user).avatar as string : null,
    adminUserId: text(row.adminUserId) || text(assigned.id) || null,
    adminName: text(row.adminName) || personName(row.assignedAdmin) || "未分配",
    state,
    lastMessageAt: text(row.lastMessageAt) || null,
    conversationId,
    displayNo,
    gameName,
    adminUnreadCount: maybeCount(row.adminUnreadCount) ?? undefined,
    userUnreadCount: maybeCount(row.userUnreadCount) ?? undefined,
    firstUserMessageAt: text(row.firstUserMessageAt) || null,
    historyState,
    firstResponseAt: text(row.firstResponseAt) || text(recordOf(row.supportEscalation).firstResponseAt) || null,
    remindDueAt: text(row.remindDueAt) || text(recordOf(row.supportEscalation).remindDueAt) || null,
    addRound: typeof row.addRound === "number" ? row.addRound : typeof recordOf(row.supportEscalation).addRound === "number" ? (recordOf(row.supportEscalation).addRound as number) : 0,
    escalationState: text(row.escalationState) || text(recordOf(row.supportEscalation).state) || null,
  };
}

export function parseAuditConversations(value: unknown): AuditPage<AuditConversation> {
  const root = recordOf(value);
  const items = Array.isArray(root.items)
    ? root.items.map(parseConversation).filter((item): item is AuditConversation => item !== null)
    : [];
  return { items, nextCursor: text(root.nextCursor) || null };
}

export type AuditMessage = NimMessageLike & { sender?: { displayName: string; avatar: string | null; role: "USER" | "ADMIN" | "SYSTEM"; platformId?: string; displayUsername?: string } };

const CARD_KINDS = ["ORDER_OPENING", "ORDER_ENDING", "ORDER_SETTLED", "ORDER_PRICE_CHANGE"] as const;
const AUDIT_MESSAGE_TYPES = ["CONSULTATION", "ORDER"] as const;

function parseCard(value: unknown): NimMessageLike["card"] | undefined {
  const row = recordOf(value);
  const kind = CARD_KINDS.find((candidate) => candidate === row.kind);
  return kind ? { kind, orderId: text(row.orderId), cardId: text(row.cardId) } : undefined;
}

function parseMessage(value: unknown): AuditMessage | null {
  const row = recordOf(value);
  const senderId = text(row.senderId);
  const createTime = row.createTime;
  if (!senderId || typeof createTime !== "number" || !Number.isFinite(createTime)) return null;
  const messageServerId = text(row.messageServerId);
  const attachment = recordOf(row.attachment);
  const reply = recordOf(row.reply);
  const card = parseCard(row.card);
  const base: NimMessageLike = {
    messageClientId: text(row.messageClientId) || messageServerId || `${senderId}-${createTime}`,
    conversationId: text(row.conversationId),
    senderId,
    receiverId: text(row.receiverId),
    createTime,
    ...(messageServerId ? { messageServerId } : {}),
    ...(typeof row.text === "string" ? { text: row.text } : {}),
    ...(typeof row.messageType === "number" ? { messageType: row.messageType } : {}),
    ...(row.media !== undefined ? { media: row.media as NimMessageLike["media"] } : {}),
    ...(Object.keys(attachment).length ? { attachment: attachment as NimMessageLike["attachment"] } : {}),
    ...(Object.keys(reply).length && typeof reply.messageClientId === "string"
      ? { reply: reply as NimMessageLike["reply"] }
      : {}),
    ...(row.revoked === true ? { revoked: true } : {}),
  };
  const normalized = nimMessageView(base);
  if (!normalized) return null;
  const author = recordOf(row.sender);
  const role: NonNullable<AuditMessage["sender"]>["role"] | null = author.role === "USER" || author.role === "ADMIN" || author.role === "SYSTEM" ? author.role : null;
  const platformId = role !== "SYSTEM" && /^[A-Za-z0-9._:-]{1,128}$/.test(text(author.platformId)) ? text(author.platformId) : null;
  const publicLogin = text(author.displayUsername).trim().toUpperCase();
  const displayUsername = role === "ADMIN" && /^ZZ\d{1,19}$/.test(publicLogin) ? publicLogin : null;
  const sender = role ? { displayName: text(author.displayName).trim(), avatar: text(author.avatar) || null, role, ...(platformId ? { platformId } : {}), ...(displayUsername ? { displayUsername } : {}) } : undefined;
  return { ...normalized, ...(card ? { card } : {}), ...(sender ? { sender } : {}) };
}

/** 只读历史：字段缺失的消息直接跳过，不渲染半条消息。 */
export function mergeAuditMessages(current: readonly AuditMessage[], incoming: readonly AuditMessage[]): AuditMessage[] {
  const key = (message: AuditMessage) => message.messageServerId || message.messageClientId;
  return mergeImMessages(current.map(message => ({ ...message, id: key(message) })), incoming.map(message => ({ ...message, id: key(message) })))
    .sort((a, b) => {
      const time = a.createTime - b.createTime;
      if (time) return time;
      const left = a.messageServerId, right = b.messageServerId;
      if (left && right && /^[0-9]{1,20}$/.test(left) && /^[0-9]{1,20}$/.test(right)) return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
      return key(a).localeCompare(key(b));
    });
}

export function parseAuditMessages(value: unknown): AuditMessagePage {
  const root = recordOf(value);
  const messages = Array.isArray(root.messages)
    ? root.messages.map(parseMessage).filter((message): message is AuditMessage => message !== null)
    : [];
  return { messages: mergeAuditMessages([], messages), nextCursor: text(root.nextCursor) || null };
}

export function auditConversationsPath(input: { type?: string; adminUserId?: string; cursor?: string | null }): string {
  const params = new URLSearchParams();
  if (input.type && input.type !== "ALL") params.set("type", input.type);
  if (input.adminUserId) params.set("adminUserId", input.adminUserId);
  if (input.cursor) params.set("cursor", input.cursor);
  const query = params.toString();
  return `/im/audit/conversations${query ? `?${query}` : ""}`;
}

export function auditMessageType(type: AuditConversationType): (typeof AUDIT_MESSAGE_TYPES)[number] {
  return type === "ORDER" ? "ORDER" : "CONSULTATION";
}

export function auditMessagesPath(conversationId: string, before?: string | null): string {
  const params = new URLSearchParams({ conversationId, mode: "patrol" });
  if (before) params.set("cursor", before);
  return `/im/messages?${params.toString()}`;
}

export function auditTypeLabel(type: AuditConversationType): string {
  if (type === "SERVICE") return "咨询";
  if (type === "COMPLAINT") return "投诉";
  if (type === "ORDER") return "订单群";
  return "暂无法识别，请刷新核对";
}

export function auditStateLabel(state: string): string {
  if (state === "WAITING") return "待接入";
  if (state === "ACTIVE") return "处理中";
  if (state === "CLOSED") return "已结束";
  return "暂无法识别，请刷新核对";
}

/** 状态（可用/暂停/离线）沿用工作台现有文案；可接待但通道未连时不能只说“可接待”。 */
export function availabilityLabel(agent: Pick<SupportOverviewAgent, "availability" | "connectionState">): string {
  if (agent.availability !== "AVAILABLE") return agent.availability === "PAUSED" ? "已暂停" : "未上线";
  return agent.connectionState === "CONNECTED" ? "可接待" : "可接待 · 未连接";
}

export function withinTimeFilter(
  value: string | null | undefined,
  filter: AuditTimeFilter,
  now = new Date(),
): boolean {
  if (filter === "all") return true;
  if (!value) return false;
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return false;
  const start = beijingTodayStart(now).getTime() - (filter === "7d" ? 6 * 86_400_000 : 0);
  return at >= start && at <= now.getTime();
}

export function hourlySlots(hourly: SupportHourlyPoint[]): SupportHourlyPoint[] {
  const byHour = new Map<number, number>();
  for (const point of hourly) byHour.set(point.hour, (byHour.get(point.hour) ?? 0) + point.sessions);
  return Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: byHour.get(hour) ?? 0 }));
}

export function maxOf(values: number[]): number {
  return values.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0);
}

/** 有值才给最小 4% 高度，0 保持 0；图表不把 0 画成一根可见的柱子。 */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(4, Math.round((value / max) * 100));
}

export function hasTrendData(points: SupportTrendPoint[]): boolean {
  return points.some((point) => point.sessions > 0 || point.users > 0);
}

export function hasHourlyData(points: SupportHourlyPoint[]): boolean {
  return points.some((point) => point.sessions > 0);
}

export function hasWorkloadData(agents: SupportOverviewAgent[]): boolean {
  return agents.some((agent) => agent.todaySeconds > 0 || agent.todaySessions > 0);
}

export function formatDayLabel(date: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date;
  const month = Number(match[1] ?? 0);
  const day = Number(match[2] ?? 0);
  return month > 0 && day > 0 ? `${month}/${day}` : date;
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/* ------------------------------ 时效缺口与交接班 ------------------------------ */

/**
 * 运营关注用的接待量关注线。服务端没有「客服容量上限」事实，这条线只是本页关注阈值，
 * 不代表系统会拒绝分配，也不能当容量结论。
 */
export const SUPPORT_ATTENTION_LOAD_LINE = 3;

/** /im/handovers 单页上限 50 条：今日交接只能在这个分母内统计，UI 必须写明。 */
export const SUPPORT_HANDOVER_PAGE_LIMIT = 50;

export type SupportSlaGap = { id: string; label: string; missing: string; needed: string };

/** 服务端尚未提供聚合事实的时效指标：只描述缺口，不估算、不补 0。 */
export const SUPPORT_SLA_GAPS: readonly SupportSlaGap[] = [
  {
    id: "first-response",
    label: "首响时长",
    missing: "咨询轮次没有「首条人工回复」时间；事件类型只有 CREATED/ASSIGNED/CLAIMED/TRANSFERRED/CLOSED/REOPENED",
    needed: "服务端产出每轮首条人工回复时间（当前落在 audit_event 并由单一函数读取，或换正列），再由 overview 聚合成 quality.firstResponse",
  },
  {
    id: "resolution",
    label: "解决时长",
    missing: "CLOSED 与 CLAIMED 的时间差没有聚合端点，单会话事件接口只能逐条取",
    needed: "overview 按今日 CLOSED(actor=admin) 轮次求 CLAIMED→CLOSED 平均秒数与样本数",
  },
  {
    id: "support-cancel",
    label: "客服取消数",
    missing: "咨询轮次没有取消事件；SUPPORT_CANCELLED_REFUND 是订单取消原因，不在咨询域",
    needed: "先定「客服取消」口径，再按口径出事件计数或订单域计数",
  },
];

export type SupportDutySummary = {
  /** 在岗可接待（availability=AVAILABLE）人数。 */
  available: number;
  /** 在岗可接待且通道已连接，与服务端 totals.onDutyCount 同口径。 */
  connected: number;
  /** 非在岗但名下仍有接待的客服数。 */
  offDutyWithLoad: number;
  /** presence 上报的 activeLoad 合计：覆盖有 presence 记录的账号，不等于全量未结。 */
  activeLoadTotal: number;
  names: string[];
};

export function summarizeDuty(agents: SupportOverviewAgent[]): SupportDutySummary {
  const available = agents.filter((agent) => agent.availability === "AVAILABLE");
  return {
    available: available.length,
    connected: available.filter((agent) => agent.connectionState === "CONNECTED").length,
    offDutyWithLoad: agents.filter((agent) => agent.availability !== "AVAILABLE" && agent.activeLoad > 0).length,
    activeLoadTotal: agents.reduce((sum, agent) => sum + agent.activeLoad, 0),
    names: available.map((agent) => agent.name),
  };
}

export type SupportAttention = { id: string; level: "high" | "watch"; title: string; detail: string };

/**
 * 异常只看服务端已有事实：服务端给了排队原因与容量上限就按原因报；
 * 只有整段缺失时才退到本页关注线，并且文案里必须自曝口径。
 */
export function attentionSignals(input: { agents: SupportOverviewAgent[]; totals: SupportTotals; queue?: SupportQueueSnapshot | null }): SupportAttention[] {
  const duty = summarizeDuty(input.agents);
  const queue = input.queue ?? null;
  const signals: SupportAttention[] = [];
  if (queue) {
    if (queue.reason === "NO_ONLINE_STAFF") {
      signals.push({
        id: "no-support",
        level: "high",
        title: "无在岗可接待客服",
        detail: `排队 ${queue.queued} 条；暂无在线可接待客服。`,
      });
    } else if (queue.reason === "ALL_AT_CAPACITY") {
      signals.push({
        id: "at-capacity",
        level: "high",
        title: "全部客服已达容量上限",
        detail: `排队 ${queue.queued} 条，满载 ${queue.atCapacity} 人${queue.capacityLimit !== null ? `（上限 ${queue.capacityLimit} 条/人）` : ""}；全员已达接待上限。`,
      });
    } else if (queue.reason === "CAPACITY_AVAILABLE" && queue.queued > 0) {
      signals.push({
        id: "queue-undigested",
        level: "watch",
        title: "有客服可接单但仍有排队",
        detail: `排队 ${queue.queued} 条，可接单客服 ${queue.withFreeSlot} 人；派单可能仍在进行。`,
      });
    }
    if (queue.oldestWaitSeconds !== null && queue.oldestWaitSeconds > 0) {
      signals.push({
        id: "queue-oldest",
        level: queue.oldestWaitSeconds >= 300 ? "high" : "watch",
        title: "有久等中的咨询",
        detail: `最久已等 ${formatSlaDuration(queue.oldestWaitSeconds)}；超过 5 分钟关注线。`,
      });
    }
  }
  if (duty.available === 0 && !queue) {
    signals.push({
      id: "no-support",
      level: "high",
      title: "无在岗可接待客服",
      detail: `${input.agents.length} 名客服全部未上线或已暂停，排队 ${input.totals.waitingConsultations} 条。`,
    });
  }
  if (duty.available > 0 && duty.connected === 0) {
    signals.push({
      id: "channel-down",
      level: "high",
      title: "在岗客服通道全部未连接",
      detail: `${duty.available} 人在岗可接待，但没有任何一台通道处于已连接状态。`,
    });
  }
  if (!queue && duty.available > 0 && input.totals.waitingConsultations > duty.available) {
    signals.push({
      id: "backlog",
      level: "watch",
      title: "排队高于在岗人数",
      detail: `等待接入 ${input.totals.waitingConsultations} 条，在岗可接待 ${duty.available} 人。`,
    });
  }
  const capped = input.agents.filter((agent) => agent.atCapacity === true);
  if (capped.length) {
    signals.push({
      id: "at-capacity-agent",
      level: "watch",
      title: "有客服达到容量上限",
      detail: `${capped.map((agent) => `${agent.name}（${agent.totalLoad}${agent.capacityLimit !== null ? `/${agent.capacityLimit}` : ""}）`).join("、")}。`,
    });
  } else if (input.agents.every((agent) => agent.atCapacity === null || agent.atCapacity === undefined)) {
    const loaded = input.agents.filter((agent) => agent.activeLoad >= SUPPORT_ATTENTION_LOAD_LINE);
    if (loaded.length) {
      signals.push({
        id: "load-line",
        level: "watch",
        title: "接待量达关注线",
        detail: `${loaded.map((agent) => `${agent.name} ${agent.activeLoad} 条`).join("、")}；达到 ${SUPPORT_ATTENTION_LOAD_LINE} 条关注线。`,
      });
    }
  }
  if (duty.offDutyWithLoad > 0) {
    signals.push({
      id: "off-duty-load",
      level: "watch",
      title: "有客服未上线但挂着会话",
      detail: `${duty.offDutyWithLoad} 人状态为未上线或已暂停，名下仍有接待中的会话。`,
    });
  }
  return signals;
}

export type SupportHourlyTrendPoint = { hour: number; label: string; sessions: number; cumulative: number };

/** 今日累计趋势：用服务端 hourly（CREATED 计数）累加，不重新估计。 */
export function cumulativeSessions(hourly: SupportHourlyPoint[]): SupportHourlyTrendPoint[] {
  let running = 0;
  return hourlySlots(hourly).map((point) => {
    running += point.sessions;
    return { hour: point.hour, label: String(point.hour).padStart(2, "0"), sessions: point.sessions, cumulative: running };
  });
}

/** 评分分布固定 5→1 星，缺失位补 0（服务端已按 1..5 给全量计数）。 */
export function ratingBuckets(ratings: SupportRatings): Array<{ score: number; count: number }> {
  return [5, 4, 3, 2, 1].map((score) => ({ score, count: ratings.distribution[score - 1] ?? 0 }));
}

export type SupportHandoverStats = {
  /** 实际读到的交接记录条数：今日统计的分母。 */
  scanned: number;
  /** 已读到单页上限，今日数字可能被截断。 */
  truncated: boolean;
  consultation: number;
  orderGroup: number;
  total: number;
};

export function handoverStatsToday(items: SupportHandover[], now = new Date()): SupportHandoverStats {
  const today = items.filter((item) => withinTimeFilter(item.createdAt, "today", now));
  return {
    scanned: items.length,
    truncated: items.length >= SUPPORT_HANDOVER_PAGE_LIMIT,
    consultation: today.filter((item) => item.objectType === "CONSULTATION").length,
    orderGroup: today.filter((item) => item.objectType === "ORDER_GROUP").length,
    total: today.length,
  };
}

function beijingStamp(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
}

/** 秒 -> 服务时效文案：秒/分，不和“小时级接待时长”混用。 */
export function formatSlaDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return seconds < 1 ? "<1 秒" : `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

export function queueReasonLabel(reason: SupportQueueReason): string {
  if (reason === "NO_ONLINE_STAFF") return "无在岗客服";
  if (reason === "ALL_AT_CAPACITY") return "全部满载";
  if (reason === "CAPACITY_AVAILABLE") return "有空位";
  return "原因未提供";
}

export type HandoverSummaryInput = {
  totals: SupportTotals;
  agents: SupportOverviewAgent[];
  handovers: SupportHandover[] | null;
  ratings?: SupportRatings | null;
  quality?: SupportQuality | null;
  queue?: SupportQueueSnapshot | null;
  now?: Date;
};

/**
 * 交接班摘要：只拼服务端已有事实，缺口如实写出，口径带分母，可整段复制给下一班。
 * 服务端给了首响/解决/排队事实就用事实；没给就明说缺口，不拿 0 顶替。
 */
export function handoverSummaryText(input: HandoverSummaryInput): string {
  const now = input.now ?? new Date();
  const duty = summarizeDuty(input.agents);
  const attention = attentionSignals({ agents: input.agents, totals: input.totals, queue: input.queue ?? null });
  const stats = input.handovers ? handoverStatsToday(input.handovers, now) : null;
  const names = duty.names.length === 0
    ? "无"
    : `${duty.names.slice(0, 6).join("、")}${duty.names.length > 6 ? ` 等 ${duty.names.length} 人` : ""}`;
  const ratings = input.ratings;
  const ratingLine = ratings && ratings.count > 0 ? ` · 评价 ${ratings.count} 条（平均 ${formatRatingAverage(ratings.average)}）` : " · 今日暂无评价";

  const firstResponse = input.quality?.firstResponse ?? null;
  const firstResponseLine = !firstResponse
    ? "首响：服务端未提供聚合事实"
    : firstResponse.sampleCount > 0
      ? `首响：平均 ${formatSlaDuration(firstResponse.averageSeconds)}（样本 ${firstResponse.sampleCount}${firstResponse.slaSeconds !== null ? ` · 阈值 ${firstResponse.slaSeconds} 秒` : ""} · 超阈值 ${firstResponse.breached} · 未回 ${firstResponse.pending}，其中已超 ${firstResponse.overdue}）`
      : `首响：今日暂无样本 · 未回 ${firstResponse.pending} 条${firstResponse.overdue > 0 ? `，其中已超阈值 ${firstResponse.overdue} 条` : ""}`;
  const resolution = input.quality?.resolution ?? null;
  const resolutionLine = !resolution
    ? "解决：服务端未提供聚合事实"
    : resolution.sampleCount > 0
      ? `解决：平均 ${formatSlaDuration(resolution.averageSeconds)}（样本 ${resolution.sampleCount}）`
      : "解决：今日无「已接起且已关闭」的样本";

  // 类型上写着 number | null，但调用方/旧 fixture 可能整段缺失：undefined 一律当“未提供”。
  const serverTransfers = typeof input.totals.transfersToday === "number" ? input.totals.transfersToday : null;
  const serverHandovers = typeof input.totals.handoversToday === "number" ? input.totals.handoversToday : null;
  const transferLine = serverTransfers !== null || serverHandovers !== null
    ? `交接：转交 ${serverTransfers === null ? "服务端未提供" : `${serverTransfers} 件`} · 交接记录 ${serverHandovers === null ? "服务端未提供" : `${serverHandovers} 件`}（服务端全量计数）`
    : stats
      ? `交接：今日 ${stats.total} 件（咨询 ${stats.consultation} / 订单群 ${stats.orderGroup}）；分母为最近 ${stats.scanned} 条交接记录${stats.truncated ? `，已达单页上限 ${SUPPORT_HANDOVER_PAGE_LIMIT} 条，今日数字可能被截断` : ""}`
      : "交接：交接记录未读取，本摘要不含交接数";

  const queue = input.queue ?? null;
  const queueLine = queue
    ? `排队：${queue.queued} 条${queue.oldestWaitSeconds !== null && queue.oldestWaitSeconds > 0 ? `（最久 ${formatSlaDuration(queue.oldestWaitSeconds)}）` : ""} · 在岗 ${queue.onDuty} · 可接单 ${queue.withFreeSlot} · 满载 ${queue.atCapacity}${queue.capacityLimit !== null ? ` · 上限 ${queue.capacityLimit} 条/人` : ""} · 原因 ${queueReasonLabel(queue.reason)}`
    : null;

  const gaps: string[] = [];
  if (!firstResponse) gaps.push("首响时长");
  if (!resolution) gaps.push("解决时长");
  gaps.push("客服取消数");
  const gapLine = gaps.length
    ? `口径缺口：${gaps.join("、")} 服务端未提供聚合事实，本摘要不估算。`
    : "口径缺口：无（首响与解决时长已由服务端提供；客服取消数仍无口径）。";

  const lines = [
    `客服交接班摘要 · ${beijingStamp(now)}（北京时间）`,
    `值班客服：${names}`,
    `在线：可接待 ${duty.available} 人 / 通道已连接 ${duty.connected} 人${duty.offDutyWithLoad > 0 ? ` / 未上线仍有接待 ${duty.offDutyWithLoad} 人` : ""}`,
    `待接待：${input.totals.waitingConsultations} 条（服务端 WAITING 全量）`,
    `接待中：${duty.activeLoadTotal} 条（presence 上报合计，不含从未上报 presence 的账号）`,
    `今日：会话 ${input.totals.todaySessions} · 用户 ${input.totals.todayUsers}${ratingLine}`,
    firstResponseLine,
    resolutionLine,
    transferLine,
    ...(queueLine ? [queueLine] : []),
    attention.length === 0
      ? "异常：无"
      : `异常：\n${attention.map((item) => `  - [${item.level === "high" ? "严重" : "关注"}] ${item.title}：${item.detail}`).join("\n")}`,
    gapLine,
  ];
  return lines.join("\n");
}
