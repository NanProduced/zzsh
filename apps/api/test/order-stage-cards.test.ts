import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { scanOrderStageCards, settledNoticeText, stageCardDeliveryBlock, stageCardWindowReason } from "../src/im/order-stage-cards";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import {
  projectStageCardAttention, projectStageCardQueue, readStageCardFailures, readStageCardsByOrderIds, requeueStageCard,
} from "../src/im/order-team-access";
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

test("a new order group gets one bot welcome before the opening card", () => {
  const source = readFileSync(resolve("src/im/order-stage-cards.ts"), "utf8");
  assert.match(source, /ORDER_WELCOME/);
  // The activity guard moved out of production and into delivery: the ledger row must exist so a
  // welcome that could not be the group's first message is recorded as SKIPPED instead of vanishing.
  assert.match(source, /EXISTS\(SELECT 1 FROM zzsh_order\.im_order_activity act WHERE act\.order_id = sc\.order_id\) AS has_activity/);
  assert.doesNotMatch(source, /NOT EXISTS\(SELECT 1 FROM zzsh_order\.im_order_activity/);
  assert.match(source, /WHEN 'ORDER_CANCELLED' THEN 0/);
  assert.match(source, /WHEN 'ORDER_WELCOME' THEN 1/);
  assert.match(source, /'ORDER_CANCELLED' FROM facts WHERE order_status = 'CANCELLED'/);
  assert.match(source, /o\.cancelled_at > clock_timestamp\(\) - interval '72 hours'/, "historical cancellations do not backfill new cards");
  assert.match(source, /订单群已建立/);
});

test("0138 extends the stage-card ledger with the bot welcome", () => {
  const sql = readFileSync(resolve("migrations/business/0138_im_order_group_welcome.sql"), "utf8");
  assert.match(sql, /'ORDER_WELCOME'/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 138 && entry.tag === "0138_im_order_group_welcome"));
});

test("0185 adds the cancellation card to the ledger kind check", () => {
  const sql = readFileSync(resolve("migrations/business/0185_order_cancelled_stage_card.sql"), "utf8");
  assert.match(sql, /'ORDER_CANCELLED'/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 185 && entry.tag === "0185_order_cancelled_stage_card"));
});

test("0127 records one card per stage with a narrow runtime update grant", () => {  const sql = readFileSync(resolve("migrations/business/0127_im_order_stage_card.sql"), "utf8");
  assert.match(sql, /UNIQUE \("order_id", "app_id", "kind"\)/);
  assert.match(sql, /UNIQUE \("card_id"\)/);
  assert.match(sql, /"kind" IN \('ORDER_OPENING', 'ORDER_ENDING', 'ORDER_SETTLED', 'ORDER_PRICE_CHANGE'\)/);
  assert.match(sql, /"state" IN \('PENDING', 'SENDING', 'SENT', 'SKIPPED'\)/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 127 && entry.tag === "0127_im_order_stage_card"));
  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /REVOKE UPDATE ON TABLE zzsh_order\.im_order_stage_card FROM \$\{runtimeUser\}/);
  assert.match(acl, /GRANT UPDATE \(state,attempt_count,next_attempt_at,lease_until,lease_token_hash,sent_at,failure_class,updated_at\)\s+ON TABLE zzsh_order\.im_order_stage_card/);
});

test("a produced card is skipped, not replayed, once its stage is gone", () => {
  const welcome = { kind: "ORDER_WELCOME" as const, postedAt: null, now: POSTED_MS };
  assert.equal(stageCardDeliveryBlock({ ...welcome, orderStatus: "PAID", hasActivity: false }), null);
  assert.equal(stageCardDeliveryBlock({ ...welcome, orderStatus: "PAID", hasActivity: true }), "WELCOME_SUPERSEDED");
  assert.equal(stageCardDeliveryBlock({ ...welcome, orderStatus: "COMPLETED", hasActivity: false }), "ORDER_ENDED");
  assert.equal(stageCardDeliveryBlock({ ...welcome, orderStatus: "CANCELLED", hasActivity: false }), "ORDER_ENDED");

  const opening = { kind: "ORDER_OPENING" as const, postedAt: POSTED, hasActivity: false, now: POSTED_MS };
  assert.equal(stageCardDeliveryBlock({ ...opening, orderStatus: "PAID" }), null);
  assert.equal(stageCardDeliveryBlock({ ...opening, orderStatus: "COMPLETED" }), "STAGE_SUPERSEDED");
  assert.equal(stageCardDeliveryBlock({ ...opening, orderStatus: "CANCELLED" }), "ORDER_CANCELLED");
  assert.equal(stageCardDeliveryBlock({ ...opening, orderStatus: "PENDING_PAYMENT" }), "ORDER_NOT_PAID");
  assert.equal(stageCardDeliveryBlock({ ...opening, orderStatus: "COMPLETED", now: POSTED_MS + 72 * HOUR }), "STAGE_SUPERSEDED");

  const ending = { kind: "ORDER_ENDING" as const, postedAt: POSTED, hasActivity: true, now: POSTED_MS };
  assert.equal(stageCardDeliveryBlock({ ...ending, orderStatus: "PAID" }), null);
  assert.equal(stageCardDeliveryBlock({ ...ending, orderStatus: "CANCELLED" }), "ORDER_CANCELLED");

  const settled = { kind: "ORDER_SETTLED" as const, postedAt: POSTED, hasActivity: true, now: POSTED_MS };
  assert.equal(stageCardDeliveryBlock({ ...settled, orderStatus: "COMPLETED" }), null);
  assert.equal(stageCardDeliveryBlock({ ...settled, orderStatus: "COMPLETED", now: POSTED_MS + 72 * HOUR }), "SEND_WINDOW_CLOSED");
  assert.equal(stageCardDeliveryBlock({ ...settled, orderStatus: "PAID" }), "STAGE_NOT_REACHED");
  assert.equal(stageCardDeliveryBlock({ ...settled, orderStatus: "CANCELLED" }), "STAGE_NOT_REACHED");

  const cancelled = { kind: "ORDER_CANCELLED" as const, postedAt: null, hasActivity: true, now: POSTED_MS };
  assert.equal(stageCardDeliveryBlock({ ...cancelled, orderStatus: "CANCELLED" }), null);
  assert.equal(stageCardDeliveryBlock({ ...cancelled, orderStatus: "PAID" }), "STAGE_NOT_REACHED");
  assert.equal(stageCardDeliveryBlock({ ...cancelled, orderStatus: "COMPLETED" }), "STAGE_NOT_REACHED");
});

test("the settlement notice names the Beijing posting time and never an amount", () => {
  const text = settledNoticeText(POSTED);
  assert.match(text, /结算完成/);
  assert.match(text, /过账时间 2026-10-29 08:00/);
  assert.match(text, /订单页/);
  assert.match(text, /客服/);
  assert.doesNotMatch(text, /¥\d/);
  assert.doesNotMatch(text, /\d+\.\d{2} 元/);
  assert.doesNotMatch(text, /买家|宄户/);
  assert.match(settledNoticeText(null), /时间暂不可用/);
});

test("stage-card attention keeps an unknown failure code verbatim", () => {
  const base = { kind: "ORDER_SETTLED", state: "PENDING", attemptCount: "2", nextAttemptAt: POSTED, sentAt: null, updatedAt: POSTED };
  const known = projectStageCardAttention({ ...base, state: "UNKNOWN", failureClass: "SEND_FAILED" });
  assert.equal(known.kindLabel, "结算完成");
  assert.equal(known.failureLabel, "发送结果未知（可能已发出，请先在群里核对）");
  assert.equal(known.attemptCount, 2);
  assert.equal(known.retryable, false, "an unknown send result is never retried by the worker");
  assert.equal(known.needsAttention, true);

  const retryable = projectStageCardAttention({ ...base, failureClass: "IDENTITY_PENDING" });
  assert.equal(retryable.retryable, true, "only a provably pre-send failure stays retryable");

  const unknown = projectStageCardAttention({ ...base, failureClass: "WEIRD_UPSTREAM_CODE" });
  assert.equal(unknown.failureClass, "WEIRD_UPSTREAM_CODE");
  assert.equal(unknown.failureLabel, "WEIRD_UPSTREAM_CODE", "an unknown code is never folded into a guess");
  assert.equal(unknown.retryable, false);

  const skipped = projectStageCardAttention({ kind: "ORDER_OPENING", state: "SKIPPED", failureClass: "STAGE_SUPERSEDED", attemptCount: 1 });
  assert.equal(skipped.failureLabel, "订单已结束，前序阶段卡不再补发");
  assert.equal(skipped.retryable, false, "a superseded stage is a fact, not a retryable failure");
  assert.equal(skipped.needsAttention, true);

  const sent = projectStageCardAttention({ kind: "ORDER_WELCOME", state: "SENT", failureClass: null, sentAt: POSTED });
  assert.equal(sent.needsAttention, false);
  assert.equal(sent.failureLabel, null);
  assert.equal(sent.retryable, false);
});

test("the queue badge degrades to zeros when the roster predates stage cards", () => {
  assert.deepEqual(projectStageCardQueue(undefined, undefined), { pending: 0, failed: 0, skipped: 0, unknown: 0, attention: null });
  const card = { kind: "ORDER_ENDING", state: "SKIPPED", failureClass: "ORDER_CANCELLED", attemptCount: 1 };
  assert.deepEqual(projectStageCardQueue(card, { pending: "0", failed: "1", skipped: "2", unknown: "3" }), {
    pending: 0, failed: 1, skipped: 2, unknown: 3, attention: projectStageCardAttention(card),
  });
});

test("stage cards are read per order and never across Apps", async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params?: unknown[]) => { seen.push({ sql, params: params ?? [] });
    return { rows: [
      { orderId: "o1", kind: "ORDER_WELCOME", state: "SENT", attemptCount: 1, sentAt: POSTED, updatedAt: POSTED, displayNo: "ZZ-1", orderStatus: "PAID" },
      { orderId: "o1", kind: "ORDER_OPENING", state: "SKIPPED", attemptCount: 0, failureClass: "ORDER_CANCELLED", updatedAt: POSTED, displayNo: "ZZ-1", orderStatus: "CANCELLED" },
      { orderId: "o2", kind: "ORDER_SETTLED", state: "PENDING", attemptCount: 0 },
    ] }; } };
  const byOrder = await readStageCardsByOrderIds(client as never, "app_live", ["o1", "o1", "o2"]);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.sql, /WHERE sc\.app_id=\$1 AND sc\.order_id=ANY\(\$2::text\[\]\)/);
  assert.deepEqual(seen[0]!.params, ["app_live", ["o1", "o2"]], "order ids are deduplicated inside one query");
  assert.equal(byOrder.get("o1")?.length, 2);
  assert.equal(byOrder.get("o1")![0]!.kindLabel, "订单群建立");
  assert.equal(byOrder.get("o2")![0]!.failureLabel, null);

  const empty = await readStageCardsByOrderIds(client as never, "app_live", []);
  assert.equal(empty.size, 0);
  assert.equal(seen.length, 1, "an empty page reads nothing");
});

test("the failure list pages by updated_at with a bounded App scope", async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const first = { id: "im_card_b", orderId: "o2", kind: "ORDER_SETTLED", state: "PENDING", attemptCount: 3,
    failureClass: "SEND_FAILED", nextAttemptAt: POSTED, updatedAt: POSTED };
  const second = { id: "im_card_a", orderId: "o1", kind: "ORDER_OPENING", state: "SKIPPED", attemptCount: 1,
    failureClass: "STAGE_SUPERSEDED", updatedAt: "2026-10-28T00:00:00.000Z" };
  const client = { query: async (sql: string, params?: unknown[]) => { seen.push({ sql, params: params ?? [] });
    if (sql.includes("count(*) AS total")) return { rows: [{ total: "9", pending: "2", sending: "0", skipped: "4", sent: "3", failed: "2" }] };
    return { rows: [first, second] }; } };
  const page = await readStageCardFailures(client as never, { appId: "app_live", limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.failureLabel, "发送结果未知（可能已发出，请先在群里核对）");
  assert.match(seen[0]!.sql, /WHERE sc\.app_id=\$1 AND sc\.state<>'SENT'/);
  assert.deepEqual(seen[0]!.params, ["app_live", 2, null, null]);
  assert.equal(page.nextCursor, POSTED + "|im_card_b");
  assert.deepEqual(page.summary, { total: 9, pending: 2, sending: 0, skipped: 4, sent: 3, failed: 2 });

  const next = await readStageCardFailures(client as never, { appId: "app_live", limit: 20, cursor: page.nextCursor });
  assert.deepEqual(seen[2]!.params.slice(2), [POSTED, "im_card_b"], "the cursor becomes a keyset bound");
  assert.equal(next.nextCursor, null);
  await assert.rejects(readStageCardFailures(client as never, { appId: "app_live", cursor: "not-a-cursor" }), /INVALID_CURSOR/);
  await assert.rejects(readStageCardFailures(client as never, { appId: "app_live", limit: 0 }), /INVALID_LIMIT/);
});

test("a human retry only requeues cards the worker still owns", async () => {
  const script = (rowCount: number, state?: string, failureClass: string | null = null) => ({ query: async (sql: string) => {
    if (sql.startsWith("UPDATE") && sql.includes("failure_class IN")) return { rowCount };
    if (sql.startsWith("UPDATE")) return { rowCount: 0 };
    return { rows: state ? [{ state, failureClass }] : [] }; } });
  const target = { appId: "app_live", orderId: "o1", kind: "ORDER_SETTLED" };
  assert.deepEqual(await requeueStageCard(script(1) as never, target), { requeued: true, outcome: "RETRY_SCHEDULED" });
  assert.deepEqual(await requeueStageCard(script(0, "SENT") as never, target), { requeued: false, outcome: "ALREADY_SENT" });
  assert.deepEqual(await requeueStageCard(script(0, "SKIPPED") as never, target), { requeued: false, outcome: "SKIPPED_TERMINAL" });
  assert.deepEqual(await requeueStageCard(script(0, "PENDING") as never, target), { requeued: false, outcome: "ALREADY_PENDING" });
  assert.deepEqual(await requeueStageCard(script(0, "PENDING", "IDENTITY_PENDING") as never, target), { requeued: false, outcome: "ALREADY_PENDING" });
  assert.deepEqual(await requeueStageCard(script(0, "PENDING", "SEND_FAILED") as never, target), { requeued: false, outcome: "UNSAFE_PENDING_REVIEW_REQUIRED" });
  assert.deepEqual(await requeueStageCard(script(0, "SENDING") as never, target), { requeued: false, outcome: "SENDING_IN_PROGRESS" });
  assert.deepEqual(await requeueStageCard(script(0, "UNKNOWN") as never, target), { requeued: false, outcome: "UNKNOWN_REVIEW_REQUIRED" });
  assert.deepEqual(await requeueStageCard(script(0) as never, target), { requeued: false, outcome: "NOT_FOUND" });
  const seen: string[] = [];
  await requeueStageCard({ query: async (sql: string) => { seen.push(sql); return { rowCount: 0, rows: [] }; } } as never, target);
  assert.match(seen[0]!, /WHERE app_id=\$1 AND order_id=\$2 AND kind=\$3/);
  assert.match(seen[0]!, /state='PENDING'/);
  assert.match(seen[0]!, /failure_class IN \('IDENTITY_PENDING','TEXT_TRANSPORT_UNAVAILABLE'\)/);
  assert.doesNotMatch(seen[0]!, /state='SENT'/, "a sent card is never rewritten");
  assert.equal(seen.filter((sql) => sql.includes("UPDATE")).length, 1, "no SENDING reclaim path survives");
});

const SCAN_APP = "app_scan";
function scanRow(overrides: Record<string, unknown> = {}) {
  const key = { provider: "yunxin" as const, appId: SCAN_APP, realm: "system" as const, kind: "SYSTEM" as const, platformSubjectId: "support-manager" };
  return {
    id: "im_card_1", order_id: "order_1", kind: "ORDER_OPENING", card_id: "im_card_1", attempt_count: 0,
    team_id: "900001", order_status: "PAID", posted_at: null, has_activity: false,
    system_account: deriveYunxinAccountId(key), system_status: "READY",
    system_marker: buildYunxinIdentityMarker(key), system_subject: "support-manager",
    ...overrides,
  };
}

function scanFixture(options: { transportError?: unknown; failSentOnce?: boolean; identityPending?: boolean; unsafePending?: boolean } = {}) {
  let state: "PENDING" | "SENDING" | "UNKNOWN" | "SENT" = "PENDING";
  let finishFailed = false;
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const row = scanRow({
    ...(options.identityPending ? { system_status: "PENDING" } : {}),
    ...(options.unsafePending ? { failure_class: "SEND_FAILED" } : {}),
  });
  const safeFailure = (() => { const failureClass = (row as { failure_class?: string }).failure_class;
    return failureClass == null || ["IDENTITY_PENDING", "TEXT_TRANSPORT_UNAVAILABLE"].includes(failureClass); })();
  const pool = { query: async (sql: string, params: unknown[] = []) => {
    writes.push({ sql, params });
    if (sql.includes("WITH facts AS")) return { rows: [], rowCount: 0 };
    if (sql.includes("failure_class = 'LEASE_EXPIRED'") && sql.includes("SET state = 'UNKNOWN'")) return { rows: [], rowCount: 0 };
    if (sql.includes("state = 'PENDING'") && sql.includes("NOT (failure_class IS NULL OR failure_class IN")) {
      if (safeFailure) return { rows: [], rowCount: 0 };
      state = "UNKNOWN";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("WHERE sc.app_id = $1 AND sc.state = 'PENDING'")) {
      const selected = state === "PENDING" && safeFailure;
      return { rows: selected ? [row] : [], rowCount: selected ? 1 : 0 };
    }
    if (sql.includes("SET state = 'SENDING'")) {
      if (state !== "PENDING") return { rows: [], rowCount: 0 };
      state = "SENDING";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state = 'PENDING'")) {
      state = "PENDING";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state = $3")) {
      if (params[2] === "SENT") {
        if (options.failSentOnce && !finishFailed) { finishFailed = true; throw new Error("synthetic SENT write failure"); }
        state = "SENT";
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state = 'UNKNOWN'")) {
      state = "UNKNOWN";
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL ${sql}`);
  } } as never;
  const calls = { card: 0 };
  const transport = { card: async () => {
    calls.card += 1;
    if ("transportError" in options) throw options.transportError;
    return {} as never;
  } };
  return { pool, transport, calls, writes, state: () => state };
}

test("an ambiguous stage-card send is frozen as UNKNOWN and never called again", async () => {
  const fixture = scanFixture({ transportError: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) });
  await scanOrderStageCards({ pool: fixture.pool, appId: SCAN_APP, transport: fixture.transport }, 10);
  assert.equal(fixture.calls.card, 1);
  assert.equal(fixture.state(), "UNKNOWN");
  assert.ok(fixture.writes.some(({ sql, params }) => sql.includes("SET state = 'UNKNOWN'") && params[2] === "ETIMEDOUT"));
  await scanOrderStageCards({ pool: fixture.pool, appId: SCAN_APP, transport: fixture.transport }, 10);
  assert.equal(fixture.calls.card, 1, "the next worker tick does not resend an unknown result");
});

test("a successful card send with a failed SENT write is not resent", async () => {
  const fixture = scanFixture({ failSentOnce: true });
  await scanOrderStageCards({ pool: fixture.pool, appId: SCAN_APP, transport: fixture.transport }, 10);
  assert.equal(fixture.calls.card, 1);
  assert.equal(fixture.state(), "UNKNOWN");
  assert.ok(fixture.writes.some(({ sql, params }) => sql.includes("SET state = 'UNKNOWN'") && params[2] === "SENT_RECORD_FAILED"));
  await scanOrderStageCards({ pool: fixture.pool, appId: SCAN_APP, transport: fixture.transport }, 10);
  assert.equal(fixture.calls.card, 1, "only the successful send is counted; nothing is replayed");
});

test("identity readiness is checked before the transport and stays retryable", async () => {
  const fixture = scanFixture({ identityPending: true });
  await scanOrderStageCards({ pool: fixture.pool, appId: SCAN_APP, transport: fixture.transport }, 10);
  assert.equal(fixture.calls.card, 0, "no channel call happens for a pre-send identity failure");
  assert.equal(fixture.state(), "PENDING");
  assert.ok(fixture.writes.some(({ sql, params }) => sql.includes("SET state = 'PENDING'") && params[2] === "IDENTITY_PENDING"));
});

test("unsafe PENDING failures are frozen for review and never selected or claimed", async () => {
  const unsafe = scanFixture({ unsafePending: true });
  await scanOrderStageCards({ pool: unsafe.pool, appId: SCAN_APP, transport: unsafe.transport }, 10);
  assert.equal(unsafe.calls.card, 0, "a dirty PENDING failure never reaches the channel");
  assert.equal(unsafe.state(), "UNKNOWN", "the dirty failure is kept as reviewable state");
  const cleanup = unsafe.writes.find(({ sql }) => sql.includes("state = 'PENDING'") && sql.includes("NOT (failure_class IS NULL OR failure_class IN"))!;
  assert.doesNotMatch(cleanup.sql, /failure_class\s*=/, "the original failure reason is preserved");
  const due = unsafe.writes.find(({ sql }) => sql.includes("WHERE sc.app_id = $1 AND sc.state = 'PENDING'"))!;
  assert.match(due.sql, /\(sc\.failure_class IS NULL OR sc\.failure_class IN \('IDENTITY_PENDING','TEXT_TRANSPORT_UNAVAILABLE'\)\)/);

  const safe = scanFixture();
  await scanOrderStageCards({ pool: safe.pool, appId: SCAN_APP, transport: safe.transport }, 10);
  const claim = safe.writes.find(({ sql }) => sql.includes("SET state = 'SENDING'"))!;
  assert.match(claim.sql, /\(failure_class IS NULL OR failure_class IN \('IDENTITY_PENDING','TEXT_TRANSPORT_UNAVAILABLE'\)\)/,
    "the claim repeats the safety predicate atomically");
});

test("0183 adds UNKNOWN, clears expired leases and freezes previously retryable failures", () => {
  const sql = readFileSync(resolve("migrations/business/0183_order_stage_card_unknown.sql"), "utf8");
  const normalized = sql.replace(/\s+/g, " ");
  assert.match(normalized, /'PENDING', 'SENDING', 'SENT', 'SKIPPED', 'UNKNOWN'/);
  assert.match(normalized, /SET "state" = 'UNKNOWN', "lease_until" = NULL, "lease_token_hash" = NULL, "failure_class" = 'LEASE_EXPIRED'/,
    "the cleanup must satisfy the old SENDING lease shape");
  assert.match(normalized, /WHERE "state" = 'SENDING' AND "lease_until" <= clock_timestamp\(\)/);
  assert.match(normalized, /"failure_class" NOT IN \('IDENTITY_PENDING', 'TEXT_TRANSPORT_UNAVAILABLE'\)/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.idx === 183 && entry.tag === "0183_order_stage_card_unknown"));
  assert.ok(journal.entries.some((entry) => entry.idx === 182 && entry.tag === "0182_complaint_handover_role_status"));
});