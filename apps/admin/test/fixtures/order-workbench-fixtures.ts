import { NimTextSendError, type NimMessageLike } from "@zzsh/im-client/nim-web-client";
import type { OrderTeamAccess } from "@zzsh/ui/order-team-panel";
import type { SettlementReadView } from "../../src/lib/order-fulfillment-client";

/**
 * Synthetic UI samples for the admin order workbench.
 *
 * Nothing here is a business fact: no payment, no real order, no NIM group, no
 * ledger. These samples are only imported by component tests.
 */

type Member = OrderTeamAccess["members"][number];
type InventoryLine = NonNullable<OrderTeamAccess["frozenInventory"]>[number];

const inventory: InventoryLine[] = [
  { itemId: "item_haff", quantity: "10000000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO", name: "哈夫币" },
  { itemId: "item_case", quantity: "3", unit: "PIECE", pricingKind: "FIXED_UNIT", name: "装备箱" },
];

const renter = (name: string | null = "小林"): Member => ({ platformId: "10001", accountId: "tenant-account", party: "BUYER", name, avatar: null });
const owner = (name: string | null = "老陈"): Member => ({ platformId: "20002", accountId: "owner-account", party: "OWNER", name, avatar: null });
const lead = (name: string | null = "小周"): Member => ({ platformId: "30003", accountId: "viewer", party: "STAFF", name, avatar: null, responsible: true });
const helper = (name: string | null = "小李"): Member => ({ platformId: "30004", accountId: "staff-b-account", party: "STAFF", name, avatar: null });

const escalation = (over: Partial<OrderTeamAccess["supportEscalation"]> = {}): OrderTeamAccess["supportEscalation"] => ({
  firstResponseAt: "2026-10-11T01:24:00.000Z", remindDueAt: null, addRound: 0, state: "STOPPED", needsManualReview: false, noEligibleStaff: false, ...over,
});

function access(over: Partial<OrderTeamAccess> = {}): OrderTeamAccess {
  return {
    orderId: "order-8842", displayNo: "ZZ20261011008842", orderStatus: "PAID", assignmentState: "ASSIGNED", teamState: "READY",
    appId: "app-synthetic", teamId: "team-8842", name: "满配六套 · 资源账号", gameName: "三角洲行动",
    account: { id: "account-8842", title: "满配六套 · 资源账号（含安全箱）" }, viewerAccountId: "viewer", conversationId: "viewer|2|team-8842",
    canRead: true, canSend: true, members: [renter(), owner(), lead()], supportEscalation: escalation(), frozenInventory: inventory, ...over,
  };
}

function listItems(orderIds: string[]) {
  return orderIds.map((id) => {
    const row = access(orderIdIndex.get(id) ?? {});
    return { id, displayNo: row.displayNo, title: row.account.title, status: row.orderStatus, teamState: row.teamState, firstResponseAt: row.supportEscalation.firstResponseAt, remindDueAt: row.supportEscalation.remindDueAt, addRound: row.supportEscalation.addRound, escalationState: row.supportEscalation.state };
  });
}
const orderIdIndex = new Map<string, Partial<OrderTeamAccess>>();

function message(over: Partial<NimMessageLike> & { messageClientId: string; senderId: string; createTime: number }): NimMessageLike {
  return { conversationId: "viewer|2|team-8842", receiverId: "team-8842", messageType: 0, text: "", ...over } as NimMessageLike;
}
function image(id: string, senderId: string, createTime: number, name: string, url = "/api/im/images/test-image"): NimMessageLike {
  return message({
    messageClientId: id, messageServerId: `srv-${id}`, senderId, createTime, messageType: 1,
    attachment: { imageId: `synthetic-${id}`, url, name, mimeType: "image/jpeg", size: 240_000 },
  });
}

const baseChat: NimMessageLike[] = [
  message({ messageClientId: "m-join", messageServerId: "srv-join", senderId: "viewer", createTime: Date.parse("2026-10-11T01:20:00Z"), messageType: 5, attachment: { type: 0 } }),
  message({ messageClientId: "m-1", messageServerId: "srv-1", senderId: "tenant-account", createTime: Date.parse("2026-10-11T01:24:00Z"), text: "你好，付款后从哪里交接？" }),
  message({ messageClientId: "m-2", messageServerId: "srv-2", senderId: "viewer", createTime: Date.parse("2026-10-11T01:25:00Z"), text: "双方好，我来协助本次交接。号主会先在本群发期初截图。" }),
  message({ messageClientId: "m-3", messageServerId: "srv-3", senderId: "owner-account", createTime: Date.parse("2026-10-11T01:31:00Z"), text: "期初截图已发，请核对。" }),
  image("m-4", "owner-account", Date.parse("2026-10-11T01:31:30Z"), "期初截图-1.jpg", "/src/assets/devl/clusters.png"),
  image("m-5", "owner-account", Date.parse("2026-10-11T01:31:40Z"), "期初截图-2.jpg"),
  message({ messageClientId: "m-6", messageServerId: "srv-6", senderId: "viewer", createTime: Date.parse("2026-10-11T01:33:00Z"), text: "收到，我先核对订单清单，再请双方确认。" }),
];

const openingLines = inventory.map((line) => ({ itemId: line.itemId, quantity: line.quantity, unit: line.unit, pricingKind: line.pricingKind }));
const opening = (status: string, acks: Array<{ party: string; createdAt: string }>): SettlementReadView["openings"] => [{
  id: "opening_1", versionNo: 1, status, createdAt: "2026-10-11T01:40:00.000Z", confirmedAt: status === "CONFIRMED" ? "2026-10-11T02:00:00.000Z" : null, lines: openingLines, acks,
}];
const settlementVersion = (over: Partial<NonNullable<SettlementReadView["settlement"]>> = {}): NonNullable<SettlementReadView["settlement"]> => ({
  id: "version_3", versionNo: 3, kind: "EARLY", early: true, versionHash: "hash-v3",
  inputSnapshot: { lines: inventory.map((line) => ({ itemId: line.itemId, openingQuantity: line.quantity, remainingQuantity: line.itemId === "item_haff" ? "8000000" : "2" })) },
  computation: { ok: true, early: true, amounts: { ownerNet: { amount: "1280.00", unit: "yuan" }, renterRefund: { amount: "320.00", unit: "yuan" }, depositRefund: { amount: "500.00", unit: "yuan" } } },
  decisions: [], ...over,
});

export type OrderFixture = {
  id: string;
  label: string;
  note: string;
  list: { items: string[]; mode: "ok" | "empty" | "error" | "forbidden" };
  info: OrderTeamAccess;
  history: NimMessageLike[];
  historyMode?: "ok" | "error" | "forbidden";
  settlement: SettlementReadView | { status: number };
  sendMode?: "ok" | "unknown";
};

const fixtures: OrderFixture[] = [
  {
    id: "ready-three", label: "群就绪 · 待核对期初", note: "3 人群、长订单编号、3 笔列表；冻结库存已投影，尚无已确认期初。",
    list: { items: ["order-8842", "order-7710", "order-3906"], mode: "ok" },
    info: access(), history: baseChat,
    settlement: { orderId: "order-8842", rentalStarted: false, ready: false, openings: [], settlement: null, reasons: ["SETTLEMENT_VERSION_MISSING"] },
  },
  {
    id: "multi-staff", label: "多客服协作 · 4+ 角色", note: "补派后同一群里既有负责客服也有协作客服，成员数不固定。",
    list: { items: ["order-8842", "order-7710"], mode: "ok" },
    info: access({ members: [renter("林小林小林"), owner(), lead(), helper(), { ...helper("小赵"), accountId: "staff-c-account", platformId: "30005" }, { ...helper("小孙"), accountId: "staff-d-account", platformId: "30006" }] }),
    history: baseChat, settlement: { orderId: "order-8842", rentalStarted: false, ready: false, openings: [], settlement: null, reasons: ["SETTLEMENT_VERSION_MISSING"] },
  },
  {
    id: "opening-one-ack", label: "期初同版 · 仅一方确认", note: "期初 v1 号主已确认、租客待确认；未正式开租，客服不能代确认。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: [...baseChat, message({ messageClientId: "m-7", messageServerId: "srv-7", senderId: "owner-account", createTime: Date.parse("2026-10-11T01:34:00Z"), text: "我确认好了。" })],
    settlement: { orderId: "order-8842", rentalStarted: false, ready: false, openings: opening("PENDING", [{ party: "OWNER", createdAt: "2026-10-11T01:40:00.000Z" }]), settlement: null, reasons: ["OPENING_ACK_MISSING"] },
  },
  {
    id: "rental-started", label: "已开租 · 期初只读", note: "服务端事实 rentalStarted=true；不得由本地倒计时推导。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat,
    settlement: { orderId: "order-8842", rentalStarted: true, ready: false, openings: opening("CONFIRMED", [{ party: "OWNER", createdAt: "2026-10-11T01:40:00.000Z" }, { party: "RENTER", createdAt: "2026-10-11T01:41:00.000Z" }]), settlement: null, reasons: ["SETTLEMENT_VERSION_MISSING"] },
  },
  {
    id: "early-intake", label: "提前结束待分类", note: "有归还申请（INTAKE）尚未生成费用版本；需核对数量并选择原因。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: [...baseChat, message({ messageClientId: "m-8", messageServerId: "srv-8", senderId: "tenant-account", createTime: Date.parse("2026-10-11T06:10:00Z"), text: "我这边想提前结束，装备箱少了一个。" })],
    settlement: { orderId: "order-8842", rentalStarted: true, ready: false, currentRequest: { kind: "INTAKE", id: "intake_9", versionNo: 3, status: "OPEN" }, openings: opening("CONFIRMED", [{ party: "OWNER", createdAt: "2026-10-11T01:40:00.000Z" }, { party: "RENTER", createdAt: "2026-10-11T01:41:00.000Z" }]), settlement: null, reasons: [] },
  },
  {
    id: "early-needs-review", label: "提前同版确认待复核", note: "双方已在 v3 同版确认，客服复核后才生效；点按钮不等于过账。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat,
    settlement: { orderId: "order-8842", rentalStarted: true, ready: true, openings: opening("CONFIRMED", [{ party: "OWNER", createdAt: "2026-10-11T01:40:00.000Z" }, { party: "RENTER", createdAt: "2026-10-11T01:41:00.000Z" }]), settlement: settlementVersion({ decisions: [{ party: "RENTER", action: "CONFIRM", versionHash: "hash-v3" }, { party: "OWNER", action: "CONFIRM", versionHash: "hash-v3" }] }) },
  },
  {
    id: "normal-confirmed", label: "正常结算双方同版", note: "正常结算无需客服审批门槛；同版双方确认后自动推进。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat,
    settlement: { orderId: "order-8842", rentalStarted: true, ready: true, openings: opening("CONFIRMED", [{ party: "OWNER", createdAt: "2026-10-11T01:40:00.000Z" }, { party: "RENTER", createdAt: "2026-10-11T01:41:00.000Z" }]), settlement: settlementVersion({ kind: "NORMAL", early: false, decisions: [{ party: "RENTER", action: "CONFIRM", versionHash: "hash-v3" }, { party: "OWNER", action: "CONFIRM", versionHash: "hash-v3" }] }) },
  },
  {
    id: "posted", label: "已过账", note: "应退与到期不代表渠道退款已到账。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat,
    settlement: {
      orderId: "order-8842", rentalStarted: true, ready: true, openings: opening("CONFIRMED", [{ party: "OWNER", createdAt: "2026-10-11T01:40:00.000Z" }, { party: "RENTER", createdAt: "2026-10-11T01:41:00.000Z" }]),
      settlement: settlementVersion({ decisions: [{ party: "RENTER", action: "CONFIRM", versionHash: "hash-v3" }, { party: "OWNER", action: "CONFIRM", versionHash: "hash-v3" }, { party: "SUPPORT", action: "REVIEW", versionHash: "hash-v3" }] }),
      posting: { id: "posting_1", versionHash: "hash-v3", early: true, postedAt: "2026-10-11T08:00:00.000Z", refundDueAt: "2026-10-14T08:00:00.000Z", amounts: { renterRefund: { amount: "320.00", unit: "yuan" }, depositRefund: { amount: "500.00", unit: "yuan" } } },
    },
  },
  {
    id: "stale-decision", label: "旧版本确认 + 新申请", note: "v2 的确认对 v3 无效；新 OPEN 申请使旧预览失效。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat,
    settlement: { orderId: "order-8842", rentalStarted: true, ready: false, currentRequest: { kind: "INTAKE", id: "intake_11", versionNo: 4, status: "OPEN" }, openings: opening("CONFIRMED", [{ party: "OWNER", createdAt: "2026-10-11T01:40:00.000Z" }, { party: "RENTER", createdAt: "2026-10-11T01:41:00.000Z" }]), settlement: settlementVersion({ versionNo: 3, decisions: [{ party: "RENTER", action: "CONFIRM", versionHash: "hash-v2" }, { party: "OWNER", action: "CONFIRM", versionHash: "hash-v2" }] }) },
  },
  {
    id: "settlement-unavailable", label: "群可读 · 履约资料不可用", note: "结算读取 404：既不能判定为待录入，也不影响本单聊天。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat, settlement: { status: 404 },
  },
  {
    id: "settlement-forbidden", label: "群可读 · 履约失权", note: "结算读取 403：只说明当前不可见，不推断订单是否存在。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat, settlement: { status: 403 },
  },
  {
    id: "send-only", label: "发送撤权 · 保留历史与草稿", note: "read 仍在、send 已撤：历史与草稿保留，输入区转为只读说明。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access({ canSend: false }), history: baseChat,
    settlement: { orderId: "order-8842", rentalStarted: false, ready: false, openings: [], settlement: null, reasons: ["SETTLEMENT_VERSION_MISSING"] },
  },
  {
    id: "history-error", label: "历史读取失败", note: "读取失败不等于空会话，已加载消息保留。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: [], historyMode: "error",
    settlement: { orderId: "order-8842", rentalStarted: false, ready: false, openings: [], settlement: null, reasons: [] },
  },
  {
    id: "unknown-sender", label: "映射缺失署名", note: "历史发送者不在当前成员表：中性降级，不冒名也不署成买家。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: [...baseChat, message({ messageClientId: "m-gone", messageServerId: "srv-gone", senderId: "former-staff-account", createTime: Date.parse("2026-10-11T01:22:00Z"), text: "（历史客服留言，成员表已无此账号）" })],
    settlement: { orderId: "order-8842", rentalStarted: false, ready: false, openings: [], settlement: null, reasons: ["SETTLEMENT_VERSION_MISSING"] },
  },
  {
    id: "unknown-image", label: "多图暂存与结果未确认", note: "文字先成功、图片再串行；UNKNOWN 的原图不可移除、只能按原标识重试。",
    list: { items: ["order-8842"], mode: "ok" },
    info: access(), history: baseChat, sendMode: "unknown",
    settlement: { orderId: "order-8842", rentalStarted: false, ready: false, openings: [], settlement: null, reasons: ["SETTLEMENT_VERSION_MISSING"] },
  },
  {
    id: "list-empty", label: "零条订单群", note: "读取成功且确实没有可访问的群：整区一个空态。",
    list: { items: [], mode: "empty" },
    info: access(), history: baseChat, settlement: { status: 404 },
  },
  {
    id: "list-error", label: "列表读取失败", note: "网络/5xx 不等于零条，也不能说成需要重新授权。",
    list: { items: [], mode: "error" },
    info: access(), history: baseChat, settlement: { status: 404 },
  },
  {
    id: "list-forbidden", label: "列表失权", note: "403：清掉私有投影并提供授权恢复入口。",
    list: { items: [], mode: "forbidden" },
    info: access(), history: baseChat, settlement: { status: 404 },
  },
];

// 列表里的另外两笔只需要"看起来是不同的单"，字段仍走同一份合同。
function sibling(id: string, displayNo: string, title: string, over: Partial<OrderTeamAccess> = {}): OrderTeamAccess {
  return access({ orderId: id, displayNo, teamId: `team-${id}`, conversationId: `viewer|2|team-${id}`, name: title, account: { id: `account-${id}`, title }, ...over });
}
orderIdIndex.set("order-8842", {});
orderIdIndex.set("order-7710", sibling("order-7710", "ZZ20261010007710", "三角洲行动 · 满配六套长标题账号名称示例"));
orderIdIndex.set("order-3906", sibling("order-3906", "ZZ20261009003906", "和平精英 · 账号", { gameName: "和平精英", teamState: "NEEDS_REVIEW", supportEscalation: escalation({ state: "RUNNING", firstResponseAt: null, remindDueAt: "2026-10-11T09:30:00.000Z" }), frozenInventory: undefined }));

const manyInventory = Array.from({ length: 24 }, (_, index) => ({ itemId: `synthetic-item-${index}`, quantity: String(index + 1), unit: "PIECE", pricingKind: "FIXED_UNIT", name: `合成资源项目 ${index + 1} · 长名称库存阅读样例` }));
fixtures.push({ ...fixtures[0]!, id: "inventory-many", label: "长清单 · 24项", note: "只检查冻结清单摘要与滚动，所有库存均为合成样本。", info: access({ frozenInventory: manyInventory }) });
export const orderFixtures = fixtures;
export function fixtureById(id: string): OrderFixture {
  return fixtures.find((item) => item.id === id) ?? fixtures[0]!;
}
export { listItems };

function fail(status: number): never {
  throw Object.assign(new Error(`synthetic ${status}`), { status });
}

/** In-memory stand-ins for the three boundaries the workbench reads: list/access, NIM, settlement. */
export function createFixtureDeps(item: OrderFixture) {
  const writes: Array<{ path: string; body: unknown; key: string | null }> = [];
  const request = async <T,>(path: string): Promise<T> => {
    if (item.list.mode === "forbidden" || item.list.mode === "error") {
      if (item.list.mode === "forbidden") fail(403);
      throw new TypeError("synthetic network failure");
    }
    const accessMatch = /^\/orders\/([^\/?]+)\/im\?/.exec(path);
    if (accessMatch) {
      if (!item.info.canRead) fail(403);
      const requested = decodeURIComponent(accessMatch[1]!);
      // Each loaded order answers with its own projection, so switching orders is real.
      if (requested === item.info.orderId) return item.info as T;
      if (item.list.items.includes(requested)) return access(orderIdIndex.get(requested) ?? {}) as T;
      fail(404);
    }
    return { items: item.list.mode === "empty" ? [] : listItems(item.list.items), nextCursor: null } as T;
  };
  const sendMode = item.sendMode ?? "ok";
  let counter = 0;
  const client = {
    accountId: "viewer",
    transport: "local-fake" as const,
    onMessages: () => () => undefined,
    async getMessageHistory(conversationId: string, _limit: number, _before: NimMessageLike | undefined, authorize: (input: { conversationId: string; operation: "read" | "send" }) => Promise<unknown>) {
      await authorize({ conversationId, operation: "read" });
      if (item.historyMode === "error") fail(500);
      if (item.historyMode === "forbidden") fail(403);
      return item.history.map((row) => ({ ...row, conversationId, receiverId: conversationId.split("|").at(-1) }));
    },
    async sendText(conversationId: string, text: string, authorize: (input: { conversationId: string; operation: "read" | "send" }) => Promise<unknown>) {
      await authorize({ conversationId, operation: "send" });
      if (sendMode === "unknown") throw new NimTextSendError("UNKNOWN", "合成结果未确认", { messageClientId: `pending-text-${Date.now()}` });
      counter += 1;
      return message({ messageClientId: `sent-${counter}`, messageServerId: `srv-sent-${counter}`, senderId: "viewer", createTime: Date.now(), text, conversationId });
    },
    async retryText(conversationId: string, messageClientId: string, authorize: (input: { conversationId: string; operation: "read" | "send" }) => Promise<unknown>) {
      await authorize({ conversationId, operation: "send" });
      return message({ messageClientId, messageServerId: `srv-${messageClientId}`, senderId: "viewer", createTime: Date.now(), text: "重试后的原文", conversationId });
    },
    async sendImage(conversationId: string, file: File, options: { authorize: (input: { conversationId: string; operation: "read" | "send" }) => Promise<unknown> }) {
      await options.authorize({ conversationId, operation: "send" });
      counter += 1;
      return { ...image(`sent-img-${counter}`, "viewer", Date.now(), file.name), conversationId };
    },
    async retryImage(conversationId: string, messageClientId: string, options: { authorize: (input: { conversationId: string; operation: "read" | "send" }) => Promise<unknown> }) {
      await options.authorize({ conversationId, operation: "send" });
      return { ...image(messageClientId, "viewer", Date.now(), "重试后的图片"), conversationId };
    },
  };
  const fetchStub = async (input: RequestInfo | URL, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!url.includes("/orders/")) return jsonResponse({ error: { code: "SYNTHETIC_UNROUTED" } }, 404);
    if (method === "GET") {
      if (typeof item.settlement === "object" && "status" in item.settlement) return jsonResponse({ error: { code: item.settlement.status === 403 ? "FORBIDDEN" : "NOT_FOUND" } }, item.settlement.status);
      return jsonResponse(item.settlement, 200);
    }
    writes.push({ path: url, body: init?.body ? JSON.parse(init.body) : null, key: init?.headers?.["idempotency-key"] ?? null });
    // 写入只回显当前投影：fixture 不推进任何业务状态，也不产生账务事实。
    return jsonResponse(typeof item.settlement === "object" && "status" in item.settlement ? {} : item.settlement, 200);
  };
  return { request, client, fetchStub, writes };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
