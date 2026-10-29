import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { stageCardWindowReason } from "../src/im/order-stage-cards";
import { InMemoryMessageTransport } from "./im-local-fixtures";

const HOUR = 60 * 60 * 1_000;
const POSTED = "2026-10-29T00:00:00.000Z";
const POSTED_MS = Date.parse(POSTED);

test("stage cards stop at the order terminal window and never send for cancelled orders", () => {
  assert.equal(stageCardWindowReason("PAID", null, POSTED_MS), null);
  assert.equal(stageCardWindowReason("CANCELLED", null, POSTED_MS), "ORDER_CANCELLED");
  assert.equal(stageCardWindowReason("PENDING_PAYMENT", null, POSTED_MS), "ORDER_NOT_PAID");
  assert.equal(stageCardWindowReason("COMPLETED", POSTED, POSTED_MS + 72 * HOUR - 1), null);
  assert.equal(stageCardWindowReason("COMPLETED", POSTED, POSTED_MS + 72 * HOUR), "SEND_WINDOW_CLOSED");
  assert.equal(stageCardWindowReason("COMPLETED", null, POSTED_MS), "SEND_WINDOW_CLOSED");
  assert.equal(stageCardWindowReason("COMPLETED", "not-a-time", POSTED_MS), "SEND_WINDOW_CLOSED");
});

test("fixture transport treats the card id as the client id and both viewers see one message", async () => {  const now = Date.parse("2026-10-29T08:00:00.000Z");
  const transport = new InMemoryMessageTransport(() => now);
  const conversationId = "zzSYSTEM123|2|900001";
  const input = {
    conversationId,
    senderAccountId: "zzSYSTEM123",
    receiverAccountId: "900001",
    card: { kind: "ORDER_OPENING" as const, orderId: "order_stage_1", cardId: "im_card_event_1" },
  };
  const first = await transport.card(input);
  const replay = await transport.card(input);
  assert.equal(transport.calls.card, 2, "each call reaches the transport");
  assert.equal(replay.messageServerId, first.messageServerId, "the card id keys the retry");
  assert.equal(first.messageClientId, "im_card_event_1");

  for (const viewer of ["zzUSER1", "zzSYSTEM123"]) {
    const history = await transport.history({ conversationId, viewerAccountId: viewer, limit: 10 });
    assert.equal(history.length, 1, `viewer ${viewer} sees exactly one card`);
    assert.deepEqual(history[0]?.card, input.card);
    assert.equal(history[0]?.senderId, "zzSYSTEM123");
  }

  const next = await transport.card({ ...input, card: { ...input.card, kind: "ORDER_SETTLED", cardId: "im_card_event_2" } });
  assert.notEqual(next.messageServerId, first.messageServerId);
  assert.equal((await transport.history({ conversationId, viewerAccountId: "zzUSER1", limit: 10 })).length, 2);
});

test("opening cards are materialized from a draft opening, not only after both acks", () => {
  const source = readFileSync(resolve("src/im/order-stage-cards.ts"), "utf8");
  assert.match(source, /opening_status IN \('DRAFT', 'CONFIRMED'\)/);
});

test("0110 records one card per stage with a narrow runtime update grant", () => {  const sql = readFileSync(resolve("migrations/business/0110_im_order_stage_card.sql"), "utf8");
  assert.match(sql, /UNIQUE \("order_id", "app_id", "kind"\)/);
  assert.match(sql, /UNIQUE \("card_id"\)/);
  assert.match(sql, /"kind" IN \('ORDER_OPENING', 'ORDER_ENDING', 'ORDER_SETTLED', 'ORDER_PRICE_CHANGE'\)/);
  assert.match(sql, /"state" IN \('PENDING', 'SENDING', 'SENT', 'SKIPPED'\)/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 110 && entry.tag === "0110_im_order_stage_card"));
  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /REVOKE UPDATE ON TABLE zzsh_order\.im_order_stage_card FROM \$\{runtimeUser\}/);
  assert.match(acl, /GRANT UPDATE \(state,attempt_count,next_attempt_at,lease_until,lease_token_hash,sent_at,failure_class,updated_at\)\s+ON TABLE zzsh_order\.im_order_stage_card/);
});
