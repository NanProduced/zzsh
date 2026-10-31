import type { NimMessageLike } from "@zzsh/im-client/nim-web-client";
import type { SupportManagementRequest } from "./im-support-management";

/** DEV-only fixture for reviewing multi-agent charts and patrol states. Never reads or writes business data. */
const DAY = 86_400_000;
const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();
const day = (offset: number) => iso(-offset * DAY).slice(0, 10);

const agents = [
  { adminUserId: "demo-a", name: "林晓", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 2, todaySeconds: 8_100, todaySessions: 12, todayUsers: 9, currentOrderGroups: 3 },
  { adminUserId: "demo-b", name: "陈晨", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 1, todaySeconds: 6_000, todaySessions: 8, todayUsers: 7, currentOrderGroups: 1 },
  { adminUserId: "demo-c", name: "王悦", availability: "PAUSED", connectionState: "CONNECTED", activeLoad: 0, todaySeconds: 11_100, todaySessions: 15, todayUsers: 11, currentOrderGroups: 4 },
  { adminUserId: "demo-d", name: "赵宁", availability: "OFF_DUTY", connectionState: "DISCONNECTED", activeLoad: 0, todaySeconds: 2_700, todaySessions: 4, todayUsers: 4, currentOrderGroups: 0 },
];

const overview = {
  onDuty: agents,
  totals: { onDutyCount: 2, waitingConsultations: 3, todaySessions: 39, todayUsers: 24 },
  trend: [3, 5, 4, 8, 6, 9, 4].map((sessions, index) => ({ date: day(6 - index), sessions, users: Math.max(1, sessions - 2) })),
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: [9, 10, 11, 14, 15, 16, 20, 21, 22].includes(hour) ? 3 + (hour % 3) : 0 })),
  ratings: {
    count: 18,
    average: 4.5,
    distribution: [0, 1, 1, 4, 12],
    agents: [
      { adminUserId: "demo-a", name: "林晓", count: 8, average: 4.8 },
      { adminUserId: "demo-b", name: "陈晨", count: 6, average: 4.5 },
      { adminUserId: "demo-c", name: "王悦", count: 4, average: 4.0 },
    ],
  },
};

type DemoConversation = {
  id: string; type: "SERVICE" | "COMPLAINT" | "ORDER"; title: string; userName: string;
  adminUserId: string | null; adminName: string; state: string; lastMessageAt: string | null;
  displayNo: string | null; gameName: string | null; conversationId: string | null;
};
let conversations: DemoConversation[] = [
  { id: "demo-c1", type: "SERVICE", title: "用户甲 · 平台咨询", userName: "用户甲", adminUserId: "demo-a", adminName: "林晓", state: "ACTIVE", lastMessageAt: iso(-2 * 60_000), displayNo: null, gameName: null, conversationId: "demo-conv-c1" },
  { id: "demo-c2", type: "SERVICE", title: "用户乙 · 平台咨询（通道恢复中）", userName: "用户乙", adminUserId: "demo-b", adminName: "陈晨", state: "ACTIVE", lastMessageAt: null, displayNo: null, gameName: null, conversationId: null },
  { id: "demo-c3", type: "COMPLAINT", title: "用户丙 · 投诉反馈", userName: "用户丙", adminUserId: null, adminName: "未分配", state: "WAITING", lastMessageAt: iso(-20 * 60_000), displayNo: null, gameName: null, conversationId: "demo-conv-c3" },
  { id: "demo-c5", type: "SERVICE", title: "用户戊 · 平台咨询", userName: "用户戊", adminUserId: null, adminName: "未分配", state: "WAITING", lastMessageAt: iso(-35 * 60_000), displayNo: null, gameName: null, conversationId: "demo-conv-c5" },
  { id: "demo-c4", type: "SERVICE", title: "用户丁 · 平台咨询", userName: "用户丁", adminUserId: "demo-c", adminName: "王悦", state: "CLOSED", lastMessageAt: iso(-3 * 3_600_000), displayNo: null, gameName: null, conversationId: "demo-conv-c4" },
  { id: "demo-o1", type: "ORDER", title: "订单群 DD20261029001", userName: "", adminUserId: "demo-a", adminName: "林晓", state: "COMPLETED", lastMessageAt: iso(-5 * 3_600_000), displayNo: "DD20261029001", gameName: "三角洲行动", conversationId: "demo-conv-o1" },
  { id: "demo-o2", type: "ORDER", title: "订单群 DD20261029002", userName: "", adminUserId: "demo-b", adminName: "陈晨", state: "ACTIVE", lastMessageAt: iso(-8 * 60_000), displayNo: "DD20261029002", gameName: "英雄联盟", conversationId: "demo-conv-o2" },
];

const message = (conversationId: string, senderId: string, text: string, createTime: number, extra: Partial<NimMessageLike> = {}): NimMessageLike => ({
  messageClientId: `${conversationId}-${createTime}-${senderId}`, messageServerId: `${conversationId}-${createTime}-${senderId}`,
  conversationId, senderId, receiverId: "demo-staff", createTime, text, messageType: 0, ...extra,
});

const histories: Record<string, NimMessageLike[]> = {
  "demo-conv-c1": [
    message("demo-conv-c1", "demo-user-a", "你好，我想确认一下开租时间和哈夫币数量。", now - 8 * 60_000),
    message("demo-conv-c1", "demo-a", "你好，我是客服林晓。账号资料和期初清单已发出，请核对。", now - 7 * 60_000),
    message("demo-conv-c1", "system", "成员已加入会话", now - 6 * 60_000, { messageType: 5, attachment: { type: 0 } } as Partial<NimMessageLike>),
    message("demo-conv-c1", "demo-a", "", now - 5 * 60_000, { card: { kind: "ORDER_OPENING", orderId: "DD20261029003", cardId: "demo-card-1" } } as Partial<NimMessageLike>),
  ],
  "demo-conv-c4": [
    message("demo-conv-c4", "demo-user-d", "收到，谢谢。", now - 3.1 * 3_600_000),
    message("demo-conv-c4", "demo-c", "不客气，订单已结算完成，沟通窗口内仍可留言。", now - 3 * 3_600_000),
  ],
  "demo-conv-o1": [
    message("demo-conv-o1", "demo-user-a", "结算完成了，辛苦。", now - 5.1 * 3_600_000),
    message("demo-conv-o1", "demo-a", "已完成，72 小时内仍可查看历史。", now - 5 * 3_600_000),
    message("demo-conv-o1", "demo-staff", "", now - 4.9 * 3_600_000, { card: { kind: "ORDER_SETTLED", orderId: "DD20261029001", cardId: "demo-card-2" } } as Partial<NimMessageLike>),
  ],
  "demo-conv-c3": [
    message("demo-conv-c3", "demo-user-c", "购买的账号被原号主找回了，账号资料和聊天记录我都保留着。", now - 21 * 60_000),
    message("demo-conv-c3", "demo-user-c", "希望平台核查一下，我需要退款处理。", now - 20 * 60_000),
  ],
  "demo-conv-c5": [
    message("demo-conv-c5", "demo-user-e", "你好，请问这个账号还在吗？我想确认一下租期。", now - 35 * 60_000),
  ],
  "demo-conv-o2": [
    message("demo-conv-o2", "demo-user-b", "号主已确认，什么时候开始算租期？", now - 9 * 60_000),
    message("demo-conv-o2", "demo-b", "双方确认后开始，我正在核对期初数量。", now - 8 * 60_000),
  ],
};

let handovers = [
  { id: "demo-h1", objectType: "CONSULTATION", objectId: "demo-c4", display: "用户丁 · 平台咨询", fromName: "陈晨", toName: "王悦", note: "午休交接，期初已确认", createdAt: iso(-4 * 3_600_000) },
  { id: "demo-h2", objectType: "ORDER_GROUP", objectId: "demo-o1", display: "订单 DD20261029001", fromName: "林晓", toName: "陈晨", note: null, createdAt: iso(-26 * 3_600_000) },
];

function query(path: string): URLSearchParams {
  const index = path.indexOf("?");
  return new URLSearchParams(index >= 0 ? path.slice(index + 1) : "");
}

export const demoSupportManagementRequest: SupportManagementRequest = async (path, _body, method = "GET") => {
  const pathname = path.split("?")[0] ?? "";
  if (pathname.endsWith("/im/support-overview")) return overview as never;
  if (pathname.endsWith("/im/handovers")) return { items: handovers } as never;
  if (pathname.endsWith("/im/audit/conversations")) {
    const params = query(path);
    const type = params.get("type");
    const adminUserId = params.get("adminUserId");
    return { items: conversations.filter((item) => (!type || item.type === type) && (!adminUserId || item.adminUserId === adminUserId)), nextCursor: null } as never;
  }
  if (pathname.endsWith("/im/audit/messages")) {
    const params = query(path);
    const id = params.get("id") ?? "";
    const conversation = conversations.find((item) => item.id === id);
    const messages = conversation?.conversationId ? histories[conversation.conversationId] ?? [] : [];
    return { messages, nextCursor: null } as never;
  }
  if (pathname.endsWith("/im/messages")) {
    const conversationId = query(path).get("conversationId") ?? "";
    return { messages: histories[conversationId] ?? [], nextCursor: null } as never;
  }
  const takeover = /\/im\/audit\/consultations\/([^/]+)\/takeover$/.exec(pathname);
  if (takeover && method === "POST") {
    const id = decodeURIComponent(takeover[1] ?? "");
    const target = conversations.find((item) => item.id === id && item.type !== "ORDER");
    if (target) {
      const fromName = target.adminName;
      target.adminUserId = "demo-a";
      target.adminName = "当前运营";
      handovers = [{ id: `demo-h-${now}`, objectType: "CONSULTATION", objectId: target.id, display: target.title, fromName, toName: "当前运营", note: null, createdAt: iso(0) }, ...handovers];
    }
    return { ok: true } as never;
  }
  throw new Error("演示数据未覆盖该接口");
};
