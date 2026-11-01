import type { ImTransportMessage } from "./im-contract";
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
};

const TEAM_CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}\|2\|([0-9]{1,19})$/;

/** The NIM custom-message type for stage cards is not verified on the real App yet, so each card is delivered as the same sentence the offline dataset shows. */
const CARD_TEXT: Record<string, string> = {
  ORDER_OPENING: "【开租确认卡】请在订单群内确认账号信息并确认开租，双方确认后开始计算租期。",
  ORDER_ENDING: "【结束确认卡】请确认本单已经结束，确认后进入结算。",
  ORDER_SETTLED: "【结算完成卡】本单已完成结算。",
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
  // The supplier call returns no server id; callers record the local ledger row
  // themselves, so a stable local id is enough to keep the seam honest.
  return {
    messageClientId,
    messageServerId: messageClientId,
    conversationId: input.conversationId,
    senderId: input.senderAccountId,
    receiverId: teamId,
    createTime,
    text: input.text,
    messageType: 0,
  };
}

export function createYunxinStageCardTransport(
  provider: YunxinTeamTextSender,
  now: () => number = Date.now,
): StageCardTransport {
  return {
    text: (input) => sendText(provider, input, now),
    card: (input) => sendText(
      provider,
      {
        conversationId: input.conversationId,
        senderAccountId: input.senderAccountId,
        receiverAccountId: input.receiverAccountId,
        text: CARD_TEXT[input.card.kind] ?? CARD_FALLBACK,
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
