import type { ImTransportCard, ImTransportMessage } from "./im-contract";
import type { DueReminderTransport } from "./order-due-reminders";
import type { StageCardTransport } from "./order-stage-cards";

/**
 * Server-side notification seam for the real Yunxin App.
 *
 * Everything the workers push into an order group (Bot welcome, stage cards,
 * due reminders, manual-close notice) already has a fake transport for the
 * offline review dataset; without this adapter the real channel simply never
 * sends them because the lifecycle only scans when a transport is present.
 *
 * Only Team conversations are supported: anything else fails closed rather than
 * guessing a receiver, so a malformed id can never fan a message out to a 1:1
 * conversation by accident.
 */
export type YunxinTeamTextSender = {
  sendSupportTeamText(input: { teamId: string; senderAccountId: string; text: string; messageClientId: string }): Promise<void>;
  sendSupportTeamCard?(input: { teamId: string; senderAccountId: string; card: ImTransportCard; text: string; messageClientId: string }): Promise<{ messageServerId: string; createTime: number }>;
};

const TEAM_CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}\|2\|([0-9]{1,19})$/;

/** Readable fallback/push text paired with the NIM custom-message card payload. */
const CARD_TEXT: Record<string, string> = {
  ORDER_OPENING: "【开租确认卡】请在订单群内确认账号信息并确认开租，双方确认后开始计算租期。",
  ORDER_ENDING: "【结束确认卡】请确认本单已经结束，确认后进入结算。",
  ORDER_SETTLED: "【结算完成卡】本单已完成结算。",
  ORDER_CANCELLED: "【订单取消卡】本单已取消，请在订单详情查看取消原因与退款状态。",
};
const CARD_FALLBACK = "【订单进度卡】订单状态已更新，请查看本单详情。";

function teamIdOf(conversationId: string): string {
  const match = TEAM_CONVERSATION.exec(conversationId);
  if (!match) throw new Error("IM_CONVERSATION_UNSUPPORTED");
  return match[1]!;
}

type TextInput = {
  conversationId: string;
  senderAccountId: string;
  receiverAccountId: string;
  text: string;
  messageClientId?: string;
};

function clientIdOf(explicit: string | undefined, now: () => number): string {
  if (explicit) return explicit;
  return `zzsh-${now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function sendText(
  provider: YunxinTeamTextSender,
  input: TextInput,
  now: () => number,
): Promise<ImTransportMessage> {
  const teamId = teamIdOf(input.conversationId);
  const messageClientId = clientIdOf(input.messageClientId, now);
  const createTime = now();
  await provider.sendSupportTeamText({
    teamId,
    senderAccountId: input.senderAccountId,
    text: input.text,
    messageClientId,
  });
  // The supplier text call returns no server id; keep the local/client id in
  // messageServerId for the existing ledger seam and advertise the provider id
  // separately so it is never mistaken for a queryable Cloud message id.
  return {
    messageClientId,
    messageServerId: messageClientId,
    serverMessageId: null,
    conversationId: input.conversationId,
    senderId: input.senderAccountId,
    receiverId: teamId,
    createTime,
    text: input.text,
    messageType: 0,
  };
}

async function sendCard(
  provider: YunxinTeamTextSender,
  input: {
    conversationId: string;
    senderAccountId: string;
    receiverAccountId: string;
    card: ImTransportCard;
    text?: string;
    messageClientId: string;
  },
  now: () => number,
): Promise<ImTransportMessage> {
  const teamId = teamIdOf(input.conversationId);
  const text = input.text ?? CARD_TEXT[input.card.kind] ?? CARD_FALLBACK;
  if (!provider.sendSupportTeamCard) {
    return sendText(provider, {
      conversationId: input.conversationId,
      senderAccountId: input.senderAccountId,
      receiverAccountId: input.receiverAccountId,
      text,
      messageClientId: input.messageClientId,
    }, now);
  }
  const sent = await provider.sendSupportTeamCard({
    teamId,
    senderAccountId: input.senderAccountId,
    card: input.card,
    text,
    messageClientId: input.messageClientId,
  });
  return {
    messageClientId: input.messageClientId,
    messageServerId: sent.messageServerId,
    serverMessageId: sent.messageServerId,
    conversationId: input.conversationId,
    senderId: input.senderAccountId,
    receiverId: teamId,
    createTime: sent.createTime,
    text,
    messageType: 100,
    card: input.card,
  };
}

export function createYunxinStageCardTransport(
  provider: YunxinTeamTextSender,
  now: () => number = Date.now,
): StageCardTransport {
  return {
    text: (input) => sendText(provider, input, now),
    card: (input) => sendCard(
      provider,
      {
        conversationId: input.conversationId,
        senderAccountId: input.senderAccountId,
        receiverAccountId: input.receiverAccountId,
        card: input.card,
        ...(input.text ? { text: input.text } : {}),
        messageClientId: input.card.cardId,
      },
      now,
    ),
  };
}

export function createYunxinDueReminderTransport(
  provider: YunxinTeamTextSender,
  now: () => number = Date.now,
): DueReminderTransport {
  return { sendText: (input) => sendText(provider, input, now) };
}

export function createYunxinSystemMessageTransport(
  provider: YunxinTeamTextSender,
  now: () => number = Date.now,
): { sendText(input: TextInput): Promise<ImTransportMessage> } {
  return { sendText: (input) => sendText(provider, input, now) };
}
