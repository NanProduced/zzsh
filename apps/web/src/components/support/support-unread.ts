/**
 * 客服入口的未读事实源。
 *
 * 常驻工具列在每一页，客服窗口却要用户点开才挂载；未读只活在窗口里，用户不点开就永远看不到客服回复
 * 和订单群消息。所以这里只放一份快照，喂给两个写入方：
 * - 窗口关着：轨道自己按可见性低频轮询目录；
 * - 窗口开着：窗口本来就有 5 秒目录轮询，把结果发布上来，轨道停手——不做两套轮询。
 *
 * 计数只认服务端事实（咨询 hasUnread/userUnreadCount、订单群 unreadCount）：有条数报条数，
 * 只有“有未读”没有条数就退回圆点；读不到就保留上一次的事实，绝不把未知补成 0 或编一个数字。
 */

export type DirectoryPreference = { pinned: boolean; muted: boolean };

/** 目录需要的咨询字段；只读这几个，别的字段由窗口自己的 Consultation 类型管。 */
export type SupportUnreadConsultation = {
  id: string;
  threadId?: string | null;
  hasUnread?: boolean;
  userUnreadCount?: number;
};

/** 目录需要的订单群字段。 */
export type SupportUnreadOrder = {
  id: string;
  status?: string | null;
  unreadCount?: number;
};

export type SupportUnreadSummary = {
  /** 可读的未读条数合计。数量未知的会话不计入这里。 */
  total: number;
  /** 客服咨询未读条数。 */
  consultations: number;
  /** 订单群未读条数。 */
  orders: number;
  /** 有未读的会话数（含数量未知的）。 */
  unreadThreads: number;
  /** 有未读但条数未知的会话数；大于 0 时入口只显示圆点。 */
  unknownThreads: number;
  /** 这份汇总的采样时间。 */
  at: number;
};

/** 与窗口里的目录偏好同一个键：置顶/免打扰只是本机偏好。 */
export const DIRECTORY_PREFS_PREFIX = "zzsh.support.directory-prefs";

/** 目录与入口必须用同一条可见性规则：草稿与未付款样本不算会话，规则只写这一份。 */
export function isDirectoryOrderGroup(order: Pick<SupportUnreadOrder, "status">): boolean {
  return order.status !== "DRAFT" && order.status !== "PENDING_PAYMENT";
}

/** 对话目录行的本机偏好键；咨询按线程、订单群按订单号，和窗口里的键一致。 */
export function directoryEntryKey(kind: "consultation" | "order", id: string): string {
  return `${kind}:${id}`;
}

export function consultationThreadKey(consultation: Pick<SupportUnreadConsultation, "id" | "threadId">): string {
  return consultation.threadId || consultation.id;
}

/** 读不出或写不进时回退为空：偏好损坏不能把整个入口带崩。 */
export function readDirectoryPreferences(identity: string): Record<string, DirectoryPreference> {
  if (!identity || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`${DIRECTORY_PREFS_PREFIX}.${identity}`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => key.trim()).map(([key, value]) => {
      const record = value && typeof value === "object" && !Array.isArray(value) ? value as { pinned?: unknown; muted?: unknown } : {};
      return [key, { pinned: record.pinned === true, muted: record.muted === true }];
    }));
  } catch {
    return {};
  }
}

/** 写回本机偏好：窗口写、入口读，键和格式只在这里拼。写不进（隐私模式/配额满）时保留内存事实。 */
export function writeDirectoryPreferences(identity: string, preferences: Record<string, DirectoryPreference>): void {
  if (!identity || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${DIRECTORY_PREFS_PREFIX}.${identity}`, JSON.stringify(preferences));
  } catch {
    /* 本机偏好写不进时仍保留在内存 */
  }
}

function unreadCountOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 汇总入口未读。免打扰的会话不计入角标——窗口里它显示 BellOff，入口却闪数字会自相矛盾。
 * 订单群沿用目录口径（草稿/未付款不算会话），否则入口会数出用户根本进不去的群。
 */
export function computeSupportUnread(
  consultations: readonly SupportUnreadConsultation[],
  orders: readonly SupportUnreadOrder[],
  preferences: Record<string, DirectoryPreference> = {},
  at: number = Date.now(),
): SupportUnreadSummary {
  let consultationTotal = 0;
  let orderTotal = 0;
  let unreadThreads = 0;
  let unknownThreads = 0;
  for (const consultation of consultations) {
    if (preferences[directoryEntryKey("consultation", consultationThreadKey(consultation))]?.muted) continue;
    const count = unreadCountOf(consultation.userUnreadCount);
    if (count > 0) { consultationTotal += count; unreadThreads += 1; continue; }
    if (consultation.hasUnread === true) { unknownThreads += 1; unreadThreads += 1; }
  }
  for (const order of orders) {
    if (!isDirectoryOrderGroup(order)) continue;
    if (preferences[directoryEntryKey("order", order.id)]?.muted) continue;
    const count = unreadCountOf(order.unreadCount);
    if (count > 0) { orderTotal += count; unreadThreads += 1; }
  }
  return { total: consultationTotal + orderTotal, consultations: consultationTotal, orders: orderTotal, unreadThreads, unknownThreads, at };
}

/** 入口角标文案：99 封顶，数量未知时只给一个点，没有未读时什么都不给。 */
export function supportUnreadBadge(summary: SupportUnreadSummary | null | undefined): { text: string; counted: boolean } | null {
  if (!summary) return null;
  if (summary.total > 0) return { text: summary.total > 99 ? "99+" : String(summary.total), counted: true };
  if (summary.unknownThreads > 0) return { text: "", counted: false };
  return null;
}

/** 无障碍描述；角标是纯装饰，入口的可访问名字必须自己说清数量。 */
export function supportUnreadDescription(summary: SupportUnreadSummary | null | undefined): string {
  if (!summary) return "";
  if (summary.total > 0) return `${summary.total > 99 ? "99+" : summary.total} 条未读消息`;
  if (summary.unknownThreads > 0) return "有新消息";
  return "";
}

export function supportUnreadAriaLabel(base: string, summary: SupportUnreadSummary | null | undefined): string {
  const description = supportUnreadDescription(summary);
  return description ? `${base}，${description}` : base;
}

let snapshot: SupportUnreadSummary | null = null;
const listeners = new Set<() => void>();

function sameFacts(left: SupportUnreadSummary | null, right: SupportUnreadSummary | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.total === right.total
    && left.consultations === right.consultations
    && left.orders === right.orders
    && left.unreadThreads === right.unreadThreads
    && left.unknownThreads === right.unknownThreads;
}

/** 写入方可以是窗口的 5 秒轮询，也可以是轨道自己的轮询；数字没变就不惊动订阅者。 */
export function publishSupportUnread(next: SupportUnreadSummary | null): void {
  if (sameFacts(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getSupportUnreadSnapshot(): SupportUnreadSummary | null {
  return snapshot;
}

export function subscribeSupportUnread(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 换身份或读不到权限时清空：别人的未读不能挂在这个账号的入口上。 */
export function resetSupportUnread(): void {
  publishSupportUnread(null);
}
