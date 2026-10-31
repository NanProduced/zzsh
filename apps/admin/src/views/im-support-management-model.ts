/**
 * 客服管理（看板/巡视）的纯数据层。
 *
 * 服务端契约可能先于前端落地，或被裁剪；这里只做“容错读取 + 不算假数”：
 * 字段缺失保持 0/空/—，数组缺失保持空数组，未知枚举保留原值由 UI 中文化。
 * 统计口径（北京时间自然日）由服务端决定，前端不推断。
 */
import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import { beijingTodayStart } from "../workspace/beijing-time";

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
};

export type SupportTotals = {
  onDutyCount: number;
  waitingConsultations: number;
  todaySessions: number;
  todayUsers: number;
};

export type SupportTrendPoint = { date: string; sessions: number; users: number };
export type SupportHourlyPoint = { hour: number; sessions: number };
export type SupportRatingAgent = { adminUserId: string; name: string; count: number; average: number | null };
export type SupportRatings = {
  count: number;
  average: number | null;
  /** 1..5 星各自数量；索引 0 是 1 星。 */
  distribution: [number, number, number, number, number];
  agents: SupportRatingAgent[];
};
export type SupportOverview = {
  onDuty: SupportOverviewAgent[];
  totals: SupportTotals;
  trend: SupportTrendPoint[];
  hourly: SupportHourlyPoint[];
  ratings: SupportRatings;
};
const EMPTY_DISTRIBUTION: SupportRatings["distribution"] = [0, 0, 0, 0, 0];

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
  adminUserId: string | null;
  adminName: string;
  state: string;
  lastMessageAt: string | null;
  conversationId: string | null;
  displayNo: string | null;
  gameName: string | null;
};

export type AuditPage<T> = { items: T[]; nextCursor: string | null };
export type AuditMessagePage = { messages: NimMessageLike[]; nextCursor: string | null };

export type AuditTimeFilter = "all" | "today" | "7d";

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

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

function parseAgent(value: unknown): SupportOverviewAgent {
  const row = recordOf(value);
  return {
    adminUserId: text(row.adminUserId),
    name: text(row.name) || "未命名客服",
    availability: text(row.availability) || "UNKNOWN",
    connectionState: text(row.connectionState) || "UNKNOWN",
    activeLoad: count(row.activeLoad),
    todaySeconds: count(row.todaySeconds),
    todaySessions: count(row.todaySessions),
    todayUsers: count(row.todayUsers),
    currentOrderGroups: count(row.currentOrderGroups),
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
  const rawDistribution = Array.isArray(root.distribution) ? root.distribution : [];
  const distribution = EMPTY_DISTRIBUTION.map((_, index) => count(rawDistribution[index])) as SupportRatings["distribution"];
  return {
    count: count(root.count),
    average: ratingAverage(root.average),
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
  const totals = recordOf(root.totals);
  const onDuty = Array.isArray(root.onDuty) ? root.onDuty.map(parseAgent) : [];
  const trend = Array.isArray(root.trend)
    ? root.trend.map(parseTrend).filter((point): point is SupportTrendPoint => point !== null)
    : [];
  const hourly = Array.isArray(root.hourly)
    ? root.hourly.map(parseHourly).filter((point): point is SupportHourlyPoint => point !== null)
    : [];
  return {
    onDuty,
    totals: {
      onDutyCount: count(totals.onDutyCount),
      waitingConsultations: count(totals.waitingConsultations),
      todaySessions: count(totals.todaySessions),
      todayUsers: count(totals.todayUsers),
    },
    trend,
    hourly,
    ratings: parseRatings(root.ratings),
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
  return {
    id,
    type,
    title: text(row.title) || displayNo || userName || "未命名会话",
    userName,
    adminUserId: text(row.adminUserId) || text(assigned.id) || null,
    adminName: text(row.adminName) || personName(row.assignedAdmin) || "未分配",
    state,
    lastMessageAt: text(row.lastMessageAt) || null,
    conversationId: text(row.conversationId) || null,
    displayNo,
    gameName,
  };
}

export function parseAuditConversations(value: unknown): AuditPage<AuditConversation> {
  const root = recordOf(value);
  const items = Array.isArray(root.items)
    ? root.items.map(parseConversation).filter((item): item is AuditConversation => item !== null)
    : [];
  return { items, nextCursor: text(root.nextCursor) || null };
}

const CARD_KINDS = ["ORDER_OPENING", "ORDER_ENDING", "ORDER_SETTLED", "ORDER_PRICE_CHANGE"] as const;
const AUDIT_MESSAGE_TYPES = ["CONSULTATION", "ORDER"] as const;

function parseCard(value: unknown): NimMessageLike["card"] | undefined {
  const row = recordOf(value);
  const kind = CARD_KINDS.find((candidate) => candidate === row.kind);
  return kind ? { kind, orderId: text(row.orderId), cardId: text(row.cardId) } : undefined;
}

function parseMessage(value: unknown): NimMessageLike | null {
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
    ...(Object.keys(attachment).length ? { attachment: attachment as NimMessageLike["attachment"] } : {}),
    ...(Object.keys(reply).length && typeof reply.messageClientId === "string"
      ? { reply: reply as NimMessageLike["reply"] }
      : {}),
    ...(row.revoked === true ? { revoked: true } : {}),
  };
  return card ? { ...base, card } : base;
}

/** 只读历史：字段缺失的消息直接跳过，不渲染半条消息。 */
export function parseAuditMessages(value: unknown): AuditMessagePage {
  const root = recordOf(value);
  const messages = Array.isArray(root.messages)
    ? root.messages.map(parseMessage).filter((message): message is NimMessageLike => message !== null)
    : [];
  return { messages, nextCursor: text(root.nextCursor) || null };
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
  const params = new URLSearchParams({ conversationId });
  if (before) params.set("before", before);
  return `/im/messages?${params.toString()}`;
}

export function auditTypeLabel(type: AuditConversationType): string {
  if (type === "SERVICE") return "咨询";
  if (type === "COMPLAINT") return "投诉";
  if (type === "ORDER") return "订单群";
  return "其他";
}

export function auditStateLabel(state: string): string {
  if (state === "WAITING") return "待接入";
  if (state === "ACTIVE") return "处理中";
  if (state === "CLOSED") return "已结束";
  return state && state !== "UNKNOWN" ? state : "状态未知";
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
