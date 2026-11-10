import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createYunxinDueReminderTransport,
  createYunxinStageCardTransport,
  createYunxinSystemMessageTransport,
} from "../src/im/yunxin-transport";

const TEAM = "9001";
const CONVERSATION = `sys-manager|2|${TEAM}`;
const NOW = 1_700_000_000_000;

function recorder() {
  const sent: { teamId: string; senderAccountId: string; text: string; messageClientId: string }[] = [];
  const cards: { teamId: string; senderAccountId: string; card: unknown; text: string; messageClientId: string }[] = [];
  return {
    sent,
    cards,
    async sendSupportTeamText(input: { teamId: string; senderAccountId: string; text: string; messageClientId: string }) {
      sent.push(input);
    },
    async sendSupportTeamCard(input: { teamId: string; senderAccountId: string; card: unknown; text: string; messageClientId: string }) {
      cards.push(input);
      return { messageServerId: `server-${input.messageClientId}`, createTime: NOW };
    },
  };
}

test("stage card transport sends the Bot welcome as Team text and keys idempotency on the caller's client id", async () => {
  const provider = recorder();
  const transport = createYunxinStageCardTransport(provider, () => NOW);
  const message = await transport.text!({
    conversationId: CONVERSATION,
    senderAccountId: "sys-manager",
    receiverAccountId: TEAM,
    text: "订单群已建立",
    messageClientId: "8f1c2d3e-0001",
  });
  assert.deepEqual(provider.sent, [{
    teamId: TEAM,
    senderAccountId: "sys-manager",
    text: "订单群已建立",
    messageClientId: "8f1c2d3e-0001",
  }]);
  assert.equal(message.conversationId, CONVERSATION);
  assert.equal(message.receiverId, TEAM);
  assert.equal(message.createTime, NOW);
  assert.equal(message.messageType, 0);
  assert.equal(message.serverMessageId, null, "a text seam has no provider server id");
});

test("stage cards use the NIM custom-message seam and keep a readable text preview", async () => {
  const provider = recorder();
  const transport = createYunxinStageCardTransport(provider, () => NOW);
  const opening = await transport.card({
    conversationId: CONVERSATION,
    senderAccountId: "sys-manager",
    receiverAccountId: TEAM,
    card: { kind: "ORDER_OPENING", orderId: "order-1", cardId: "card-1" },
  });
  await transport.card({
    conversationId: CONVERSATION,
    senderAccountId: "sys-manager",
    receiverAccountId: TEAM,
    card: { kind: "ORDER_PRICE_CHANGE", orderId: "order-1", cardId: "card-2" },
  });
  assert.deepEqual(provider.sent, []);
  assert.equal(provider.cards.length, 2);
  assert.deepEqual(provider.cards[0]!.card, { kind: "ORDER_OPENING", orderId: "order-1", cardId: "card-1" });
  assert.match(provider.cards[0]!.text, /开租确认卡/);
  assert.equal(provider.cards[0]!.messageClientId, "card-1");
  assert.match(provider.cards[1]!.text, /订单进度卡/);
  assert.equal(provider.cards[1]!.messageClientId, "card-2");
  assert.equal(opening.messageType, 100);
  assert.equal(opening.serverMessageId, "server-card-1", "the provider server id is kept separately");
  assert.deepEqual(opening.card, { kind: "ORDER_OPENING", orderId: "order-1", cardId: "card-1" });
});

test("a provider without custom-card support falls back to readable Team text", async () => {
  const sent: { teamId: string; senderAccountId: string; text: string; messageClientId: string }[] = [];
  const provider = {
    async sendSupportTeamText(input: { teamId: string; senderAccountId: string; text: string; messageClientId: string }) {
      sent.push(input);
    },
  };
  const transport = createYunxinStageCardTransport(provider, () => NOW);
  const message = await transport.card({
    conversationId: CONVERSATION,
    senderAccountId: "sys-manager",
    receiverAccountId: TEAM,
    card: { kind: "ORDER_OPENING", orderId: "order-1", cardId: "card-1" },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /开租确认卡/);
  assert.equal(message.messageType, 0);
});

test("a non-Team conversation fails closed instead of sending to a guessed receiver", async () => {
  const provider = recorder();
  const transport = createYunxinStageCardTransport(provider, () => NOW);
  await assert.rejects(
    transport.card({
      conversationId: "user-a|1|user-b",
      senderAccountId: "sys-manager",
      receiverAccountId: "user-b",
      card: { kind: "ORDER_OPENING", orderId: "order-1", cardId: "card-1" },
    }),
    /IM_CONVERSATION_UNSUPPORTED/,
  );
  assert.deepEqual(provider.sent, []);
  assert.deepEqual(provider.cards, []);
});

test("due reminders and order system notes reuse the same Team text seam", async () => {
  const provider = recorder();
  const reminder = createYunxinDueReminderTransport(provider, () => NOW);
  await reminder.sendText({
    conversationId: CONVERSATION,
    senderAccountId: "sys-manager",
    receiverAccountId: TEAM,
    text: "租期即将到期",
    messageClientId: "reminder-1",
  });
  const notice = createYunxinSystemMessageTransport(provider, () => NOW);
  await notice.sendText({
    conversationId: CONVERSATION,
    senderAccountId: "sys-manager",
    receiverAccountId: TEAM,
    text: "客服已手动结束本单。",
  });
  assert.equal(provider.sent.length, 2);
  assert.equal(provider.sent[0]!.messageClientId, "reminder-1");
  assert.match(provider.sent[1]!.messageClientId, /^zzsh-\d+-[a-z0-9]{1,10}$/);
});
