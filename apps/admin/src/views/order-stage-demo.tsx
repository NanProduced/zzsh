import { useMemo } from "react";
import type { NimMessageLike, NimWebClientLike, NimWebConnectionState } from "@zzsh/im-client/nim-web-client";
import { OrderTeamPanel, type OrderTeamAccess, type OrderTeamFulfillmentStage, type OrderTeamTerms } from "@zzsh/ui/order-team-panel";
import "@zzsh/ui/order-team.css";
import "@zzsh/ui/message-actions.css";

/**
 * Development-only stage gallery. It renders the real order chat against six
 * synthetic stages; nothing here calls the API or writes an order.
 */
type DemoStage = {
  id: string;
  label: string;
  stage: OrderTeamFulfillmentStage;
  orderStatus: "PAID" | "COMPLETED";
  teamState: string | null;
  assignmentState: string | null;
  openingState: "NONE" | "DRAFT" | "PARTIAL" | "CONFIRMED";
  openingAcks: { renter: boolean; owner: boolean };
  endState: "NONE" | "REQUESTED" | "POSTED";
  canSend: boolean;
  dueAt: string | null;
  sendUntil: string | null;
  message: string;
};

const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const iso = (offset: number) => new Date(now + offset).toISOString();

const STAGES: DemoStage[] = [
  { id: "waiting-staff", label: "已付款 · 等待客服", stage: "WAITING_STAFF", orderStatus: "PAID", teamState: null, assignmentState: "WAITING", openingState: "NONE", openingAcks: { renter: false, owner: false }, endState: "NONE", canSend: false, dueAt: null, sendUntil: null, message: "已付款，等待客服接入并建立订单群。" },
  { id: "team-pending", label: "正在建立订单群", stage: "TEAM_PENDING", orderStatus: "PAID", teamState: "CREATING", assignmentState: "ASSIGNED", openingState: "NONE", openingAcks: { renter: false, owner: false }, endState: "NONE", canSend: false, dueAt: null, sendUntil: null, message: "已分配客服，订单群正在创建与核验。" },
  { id: "opening-confirm", label: "账号与开租确认", stage: "OPENING_CONFIRM", orderStatus: "PAID", teamState: "READY", assignmentState: "ASSIGNED", openingState: "PARTIAL", openingAcks: { renter: true, owner: false }, endState: "NONE", canSend: true, dueAt: null, sendUntil: null, message: "买家已确认账号可用，等待号主确认期初与金额。" },
  { id: "renting", label: "租用中", stage: "RENTING", orderStatus: "PAID", teamState: "READY", assignmentState: "ASSIGNED", openingState: "CONFIRMED", openingAcks: { renter: true, owner: true }, endState: "NONE", canSend: true, dueAt: iso(5 * day), sendUntil: null, message: "双方已确认开租，租期进行中。" },
  { id: "ending", label: "结束确认", stage: "ENDING", orderStatus: "PAID", teamState: "READY", assignmentState: "ASSIGNED", openingState: "CONFIRMED", openingAcks: { renter: true, owner: true }, endState: "REQUESTED", canSend: true, dueAt: iso(-day), sendUntil: null, message: "已发起结束，等待另一方确认期末数据。" },
  { id: "settled", label: "结算完成", stage: "SETTLED", orderStatus: "COMPLETED", teamState: "READY", assignmentState: "ASSIGNED", openingState: "CONFIRMED", openingAcks: { renter: true, owner: true }, endState: "POSTED", canSend: false, dueAt: iso(-3 * day), sendUntil: iso(-day), message: "结算完成，72 小时沟通窗口已结束，仅可查看历史。" },
];

const MEMBERS = [
  { platformId: "demo-buyer", accountId: "demo-buyer-account", party: "BUYER", name: "演示买家", avatar: null },
  { platformId: "demo-owner", accountId: "demo-owner-account", party: "OWNER", name: "演示号主", avatar: null },
  { platformId: "demo-staff", accountId: "demo-staff-account", party: "STAFF", name: "演示客服", avatar: null, responsible: true },
];

/** Synthetic staff-side terms only: cents strings, buyer/owner split, never a real quote. */
const DEMO_TERMS: OrderTeamTerms = {
  viewerParty: "STAFF", basis: "QUOTE", currency: "CNY", scale: 2, version: "demo-quote-v1",
  rentalAmount: null, depositAmount: null, paidTotal: null,
  lines: [
    { itemId: "item_haff", name: "哈夫币", quantity: "1000000", unitPrice: null, amount: null, buyerUnitPrice: "1", ownerUnitPrice: "0.8", buyerAmount: "1000000", ownerAmount: "800000", platformContribution: "200000" },
    { itemId: "item_case", name: "装备箱", quantity: "3", unitPrice: null, amount: null, buyerUnitPrice: "6000", ownerUnitPrice: "5000", buyerAmount: "18000", ownerAmount: "15000", platformContribution: "3000" },
    { itemId: "item_ammo", name: "弹药箱", quantity: "2", unitPrice: null, amount: null, buyerUnitPrice: "5000", ownerUnitPrice: "4000", buyerAmount: "10000", ownerAmount: "8000", platformContribution: "2000" },
    { itemId: "item_med", name: "医疗包", quantity: "5", unitPrice: null, amount: null, buyerUnitPrice: "800", ownerUnitPrice: "600", buyerAmount: "4000", ownerAmount: "3000", platformContribution: "1000" },
  ],
  staff: { buyerRentalAmount: "1032000", ownerRentalAmount: "826000", buyerTotal: "1532000", ownerTotal: "1126000", platformContribution: "206000" },
};

function accessOf(stage: DemoStage): OrderTeamAccess {
  const conversationId = stage.teamState === "READY" ? `demo-staff-account|2|${stage.id}` : undefined;
  return {
    orderId: stage.id,
    displayNo: `DEMO-${STAGES.indexOf(stage) + 1}`,
    name: `演示订单 · ${stage.label}`,
    orderStatus: stage.orderStatus,
    stage: stage.stage,
    rentalStartedAt: stage.openingState === "CONFIRMED" ? iso(-10 * day) : null,
    dueAt: stage.dueAt,
    openingState: stage.openingState,
    openingAcks: stage.openingAcks,
    endState: stage.endState,
    sendUntil: stage.sendUntil,
    assignmentState: stage.assignmentState,
    teamState: stage.teamState,
    appId: "demo-app",
    teamId: stage.id,
    gameName: "三角洲行动",
    account: { id: `account-${stage.id}`, title: "演示资源账号" },
    viewerAccountId: "demo-staff-account",
    ...(conversationId ? { conversationId } : {}),
    canRead: true,
    canSend: stage.canSend,
    members: stage.teamState === "READY" ? MEMBERS : MEMBERS.slice(0, 2),
    supportEscalation: { firstResponseAt: null, remindDueAt: null, addRound: 0, state: "NOT_STARTED", needsManualReview: false, noEligibleStaff: false },
    terms: DEMO_TERMS,
  };
}

function messagesOf(stage: DemoStage, conversationId: string): NimMessageLike[] {
  if (stage.teamState !== "READY") return [];
  const base = now - 2 * day;
  const rows: NimMessageLike[] = [
    { messageClientId: `${stage.id}-1`, messageServerId: `${stage.id}-s1`, conversationId, senderId: "demo-buyer-account", receiverId: "demo-staff-account", createTime: base, text: "你好，账号资料我已收到。", messageType: 0 },
    { messageClientId: `${stage.id}-2`, messageServerId: `${stage.id}-s2`, conversationId, senderId: "demo-staff-account", receiverId: "demo-buyer-account", createTime: base + 60_000, text: stage.message, messageType: 0 },
  ];
  // 每单一条阶段卡消息：卡片本身是消息，阶段事实仍由订单投影决定。
  const cardKind = stage.id === "opening-confirm" || stage.id === "renting" ? "ORDER_OPENING" : stage.id === "ending" ? "ORDER_ENDING" : stage.id === "settled" ? "ORDER_SETTLED" : null;
  if (cardKind) rows.push({
    messageClientId: `${stage.id}-card`, messageServerId: `${stage.id}-card-s1`, conversationId,
    senderId: "demo-platform", receiverId: "demo-staff-account", createTime: base + 120_000, messageType: 0, text: "",
    card: { kind: cardKind, orderId: stage.id, cardId: `demo-card-${stage.id}` },
  });
  return rows;
}

export function OrderStageDemo() {
  const client = useMemo(() => ({
    accountId: "demo-staff-account",
    transport: "local-fake" as const,
    getConnectionState: () => "CONNECTED" as NimWebConnectionState,
    onConnectionStateChange: () => () => {},
    onMessages: () => () => {},
    async getMessageHistory(conversationId: string, _limit?: number, _before?: NimMessageLike, authorize?: (input: { conversationId: string; operation: "read" | "send" }) => Promise<void>) {
      await authorize?.({ conversationId, operation: "read" });
      const stage = STAGES.find((item) => item.id === conversationId.split("|")[2]) ?? STAGES[0]!;
      return messagesOf(stage, conversationId);
    },
    async sendText(conversationId: string, text: string, authorize?: (input: { conversationId: string; operation: "read" | "send" }) => Promise<void>) {
      await authorize?.({ conversationId, operation: "send" });
      return { messageClientId: `demo-${Date.now()}`, messageServerId: `demo-s-${Date.now()}`, conversationId, senderId: "demo-staff-account", receiverId: "demo-buyer-account", createTime: Date.now(), text, messageType: 0 };
    },
    async retryText(conversationId: string, messageClientId: string, authorize?: (input: { conversationId: string; operation: "read" | "send" }) => Promise<void>) {
      await authorize?.({ conversationId, operation: "send" });
      return { messageClientId, messageServerId: `demo-s-${messageClientId}`, conversationId, senderId: "demo-staff-account", receiverId: "demo-buyer-account", createTime: Date.now(), text: "演示消息", messageType: 0 };
    },
    async sendImage() { throw new Error("阶段样本不发送图片"); },
    async retryImage() { throw new Error("阶段样本不发送图片"); },
    async replyText(conversationId: string, text: string, replyTo: NimMessageLike, authorize?: (input: { conversationId: string; operation: "read" | "send" }) => Promise<void>) {
      await authorize?.({ conversationId, operation: "send" });
      return { messageClientId: `demo-reply-${Date.now()}`, messageServerId: `demo-reply-s-${Date.now()}`, conversationId, senderId: "demo-staff-account", receiverId: "demo-buyer-account", createTime: Date.now(), text, messageType: 0, reply: { messageId: replyTo.messageServerId ?? replyTo.messageClientId, senderId: replyTo.senderId, text: replyTo.text } };
    },
    async revokeMessage(_conversationId: string, message: NimMessageLike) { return { ...message, text: "", revoked: true }; },
    async deleteMessage() {},
  } as unknown as NimWebClientLike), []);

  const request = useMemo(() => async <T,>(path: string): Promise<T> => {
    if (path.includes("im-groups")) {
      return {
        items: STAGES.map((stage) => ({ id: stage.id, displayNo: `DEMO-${STAGES.indexOf(stage) + 1}`, title: `演示订单 · ${stage.label}`, status: stage.orderStatus, stage: stage.stage, teamState: stage.teamState })),
        nextCursor: null,
      } as T;
    }
    const id = path.split("/")[2] ?? "";
    const stage = STAGES.find((item) => item.id === id);
    if (!stage) throw Object.assign(new Error("Not found"), { status: 404 });
    return accessOf(stage) as T;
  }, []);

  return <div className="order-stage-demo">
    <header className="order-stage-demo-head">
      <strong>订单阶段样本</strong>
      <span>仅本地开发环境；六个阶段共用真实聊天组件，不读取或写入业务数据。</span>
    </header>
    <OrderTeamPanel identity="demo-staff" realm="admin" client={client} connection="CONNECTED" active request={request} onAuthError={() => {}} />
  </div>;
}
