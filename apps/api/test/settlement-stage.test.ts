import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { projectSettlementResponse, readSettlementStages, settlementStageFactsFromView, settlementStageOf, type SettlementStageFacts } from "../src/order/settlement-record";

const base: SettlementStageFacts = { orderStatus: "PAID", viewerParty: "RENTER", posted: false, intakeOpen: false, currentVersionNo: null, renterAction: null, ownerAction: null };

test("stage rules are party-scoped and carry no amounts", () => {
  assert.deepEqual(settlementStageOf({ ...base, orderStatus: "PENDING_PAYMENT" }), { code: "NONE", label: null, viewerActionRequired: false, settlementVersionNo: null });
  assert.equal(settlementStageOf(base).code, "RENTING");
  assert.equal(settlementStageOf({ ...base, intakeOpen: true }).viewerActionRequired, false);
  const pending = settlementStageOf({ ...base, currentVersionNo: 2 });
  assert.deepEqual(pending, { code: "DECISION_PENDING", label: "待你确认结算", viewerActionRequired: true, settlementVersionNo: 2 });
  assert.equal(settlementStageOf({ ...base, currentVersionNo: 2, renterAction: "CONFIRM" }).code, "DECISION_WAITING");
  assert.equal(settlementStageOf({ ...base, viewerParty: "OWNER", currentVersionNo: 2, renterAction: "CONFIRM" }).viewerActionRequired, true);
  assert.equal(settlementStageOf({ ...base, currentVersionNo: 2, ownerAction: "REJECT" }).code, "DECISION_REJECTED");
  assert.equal(settlementStageOf({ ...base, orderStatus: "COMPLETED", posted: true, currentVersionNo: 3 }).code, "POSTED");
  for (const k of Object.keys(pending)) assert.ok(!/cents|amount/i.test(k));
});

test("batch read is one scoped query and degrades to UNKNOWN on missing relation", async () => {
  const seen: string[] = [];
  const ok = { query: async (s: string, p?: unknown[]) => { seen.push(s); if (s.includes("user-settlement-stage-batch")) { assert.deepEqual(p, [["o1"], "u1"]); return { rows: [{ ...base, id: "o1", currentVersionNo: "4" }] }; } return { rows: [] }; } } as unknown as PoolClient;
  const m = await readSettlementStages(ok, ["o1", "o1"], "u1");
  assert.equal(m.get("o1")?.settlementVersionNo, 4);
  assert.equal(seen.filter(s => s.includes("user-settlement-stage-batch")).length, 1);
  const bad = { query: async (s: string) => { if (s.includes("user-settlement-stage-batch")) throw Object.assign(new Error("x"), { code: "42P01" }); return { rows: [] }; } } as unknown as PoolClient;
  assert.equal((await readSettlementStages(bad, ["o2"], "u1")).get("o2")?.code, "UNKNOWN");
  const worse = { query: async (s: string) => { if (s.includes("user-settlement-stage-batch")) throw Object.assign(new Error("y"), { code: "XX000" }); return { rows: [] }; } } as unknown as PoolClient;
  await assert.rejects(readSettlementStages(worse, ["o3"], "u1"));
});

test("single /settlement view derives the same stage facts as the list batch row", () => {
  const v = (versionNo: number, supersededAt: string | null, decisions: Array<{ party: string; action: string }>) => ({ versionNo, supersededAt, decisions });
  const cases: Array<[Record<string, unknown>, "RENTER" | "OWNER" | null, SettlementStageFacts]> = [
    [{ orderStatus: "PAID", intakes: [], versions: [], posting: null }, "RENTER", base],
    [{ orderStatus: "PAID", intakes: [{ status: "CLASSIFIED" }, { status: "OPEN" }], versions: [v(1, null, [])], posting: null }, "OWNER",
      { ...base, viewerParty: "OWNER", intakeOpen: true, currentVersionNo: 1 }],
    [{ orderStatus: "PAID", intakes: [{ status: "CLASSIFIED" }], versions: [v(1, "t", [{ party: "RENTER", action: "REJECT" }]), v(2, null, [{ party: "RENTER", action: "CONFIRM" }])], posting: null }, "OWNER",
      { ...base, viewerParty: "OWNER", currentVersionNo: 2, renterAction: "CONFIRM" }],
    [{ orderStatus: "COMPLETED", intakes: [], versions: [v(3, null, [{ party: "RENTER", action: "CONFIRM" }, { party: "OWNER", action: "CONFIRM" }])], posting: { compensationFeeCents: "0" } }, "RENTER",
      { ...base, orderStatus: "COMPLETED", posted: true, currentVersionNo: 3, renterAction: "CONFIRM", ownerAction: "CONFIRM" }],
  ];
  for (const [body, party, listRow] of cases) {
    const facts = settlementStageFactsFromView(body, party);
    assert.deepEqual(facts, { ...listRow, rentalStarted: false, openingActionRequired: false });
    assert.deepEqual(settlementStageOf(facts), settlementStageOf({ ...listRow, rentalStarted: false, openingActionRequired: false }));
  }
});

test("GET /settlement user projection keeps the optional additive stage field", async () => {
  const stage = settlementStageOf({ ...base, currentVersionNo: 2 });
  const client = { query: async () => ({ rows: [{ ownerUserId: "owner", renterUserId: "u1" }] }) } as unknown as PoolClient;
  const out = await projectSettlementResponse(client, { realm: "user", userId: "u1", sessionId: "s1" },
    { status: 200, body: { orderId: "o1", orderStatus: "PAID", stage, secretInternal: "x" } });
  const body = out.body as Record<string, unknown>;
  assert.deepEqual(body.stage, stage);
  assert.equal(stage.code, "DECISION_PENDING");
  assert.equal(body.secretInternal, undefined);
});

test("paid order cannot be called renting before confirmed opening, and rejection is explicit", () => {
  const pending = settlementStageOf({ ...base, rentalStarted: false, openingActionRequired: true });
  assert.equal(pending.code, "OPENING_PENDING"); assert.equal(pending.viewerActionRequired, true);
  assert.equal(settlementStageOf({ ...base, rentalStarted: false, openingActionRequired: false }).viewerActionRequired, false);
  assert.equal(settlementStageOf({ ...base, rentalStarted: true }).code, "RENTING");
  for (const viewerParty of ["RENTER", "OWNER"] as const) {
    const rejected = settlementStageOf({ ...base, viewerParty, currentVersionNo: 3, renterAction: "REJECT" });
    assert.equal(rejected.code, "DECISION_REJECTED"); assert.equal(rejected.viewerActionRequired, false);
  }
});

test("settlement fresh and replay projections isolate each party by current server-side membership", async () => {
  const money = (amount: string) => ({ currency: "CNY", unit: "yuan", scale: 2, amount });
  const amounts = { ownerNet: money("876.54"), ownerGross: money("888.88"), renterCharge: money("321.98"), renterRefund: money("234.56"),
    depositRefund: money("123.00"), haffConsumedBuyer: money("300.00"), haffConsumedOwner: money("800.00"),
    feePayer: "OWNER", feeAmount: money("12.34"), feeBase: money("888.88"), feeRate: "0.08" };
  const version = { id: "v1", systemOwnerNet: "87654", systemRenterRefund: "23456", proposedOwnerNet: "87654", proposedRenterRefund: "23456",
    inputSnapshot: { capturedAmount: "99999", depositAmount: "12300", amounts }, computation: { ok: true, amounts }, decisions: [] };
  const body = { orderId: "route-order-id", amounts, versions: [version], settlement: version,
    posting: { id: "p1", capturedCents: "99999", owner: { availableCents: "87654" }, refund: { payableCents: "23456" }, amounts, compensationFeeCents: "1234",
      manualAdjustment: { reason: "reviewed", postedOwnerNetCents: "87654", postedRenterRefundCents: "23456" } } };
  const before = JSON.stringify(body);
  const client = { query: async (_sql: string, values: unknown[]) => {
    assert.deepEqual(values, ["route-order-id"]); return { rows: [{ ownerUserId: "owner", renterUserId: "renter" }] };
  } } as unknown as PoolClient;
  for (const replayed of [false, true]) {
    const result = { status: 200, body: { ...body, replayed } };
    const owned = (await projectSettlementResponse(client, { realm: "user", userId: "owner", sessionId: "s" }, result, "route-order-id")).body as Record<string, any>;
    assert.equal(owned.amounts.ownerNet.amount, "876.54"); assert.equal(owned.amounts.renterRefund, undefined);
    assert.equal(owned.settlement.proposedRenterRefund, undefined); assert.equal(owned.posting.refund, undefined);
    assert.equal(owned.posting.capturedCents, undefined); assert.equal(owned.settlement.inputSnapshot.depositAmount, undefined);
    assert.equal(owned.posting.manualAdjustment.postedRenterRefundCents, undefined);
    assert.equal(owned.amounts.feeAmount.amount, "12.34");
    assert.equal(owned.posting.compensationFeeCents, "1234");
    const rented = (await projectSettlementResponse(client, { realm: "user", userId: "renter", sessionId: "s" }, result, "route-order-id")).body as Record<string, any>;
    assert.equal(rented.amounts.renterRefund.amount, "234.56"); assert.equal(rented.amounts.ownerNet, undefined);
    assert.equal(rented.posting.owner, undefined); assert.equal(rented.settlement.systemOwnerNet, undefined);
    assert.equal(rented.posting.manualAdjustment.postedOwnerNetCents, undefined);
    assert.equal(rented.amounts.feeAmount, undefined); assert.equal(rented.posting.compensationFeeCents, undefined);
  }
  await assert.rejects(projectSettlementResponse(client, { realm: "user", userId: "stranger", sessionId: "s" }, { status: 200, body }, "route-order-id"),
    (error: unknown) => (error as { status?: number }).status === 404);
  await assert.rejects(projectSettlementResponse(client, { realm: "user", userId: "owner", sessionId: "s" }, { status: 200, body: { ...body, orderId: "another-order" } }, "route-order-id"),
    (error: unknown) => (error as { status?: number }).status === 404);
  assert.equal(JSON.stringify(body), before, "projection never changes frozen financial truth");
  const renterFee = { ...body, amounts: { ...amounts, feePayer: "RENTER" }, posting: { ...body.posting, amounts: { ...amounts, feePayer: "RENTER" } } };
  const rented = (await projectSettlementResponse(client, { realm: "user", userId: "renter", sessionId: "s" }, { status: 200, body: renterFee }, "route-order-id")).body as Record<string, any>;
  assert.equal(rented.amounts.feeAmount.amount, "12.34"); assert.equal(rented.posting.compensationFeeCents, "1234");
});

test("party isolation preserves database dates through JSON without exposing the other party's money", async () => {
  const createdAt = new Date("2026-10-30T08:00:00.000Z"), confirmedAt = new Date("2026-10-30T08:02:00.000Z");
  const body = { orderId: "date-order", openings: [{ id: "opening", createdAt, confirmedAt,
    acks: [{ party: "OWNER", createdAt }, { party: "RENTER", createdAt: confirmedAt }] }],
    intakes: [{ id: "intake", createdAt: new Date(NaN) }],
    versions: [{ id: "v1", decisions: [{ party: "OWNER", action: "CONFIRM", createdAt }] }],
    posting: { id: "posting", postedAt: confirmedAt, refundDueAt: null,
      owner: { availableCents: "87654" }, refund: { payableCents: "23456" } } };
  const client = { query: async () => ({ rows: [{ ownerUserId: "owner", renterUserId: "renter" }] }) } as unknown as PoolClient;
  for (const userId of ["owner", "renter"]) {
    const out = await projectSettlementResponse(client, { realm: "user", userId, sessionId: "s" }, { status: 200, body }, "date-order");
    const json = JSON.parse(JSON.stringify(out.body));
    assert.equal(json.openings[0].createdAt, createdAt.toISOString());
    assert.equal(json.openings[0].confirmedAt, confirmedAt.toISOString());
    assert.deepEqual(json.openings[0].acks.map((ack: { createdAt: string }) => ack.createdAt), [createdAt.toISOString(), confirmedAt.toISOString()]);
    assert.equal(json.versions[0].decisions[0].createdAt, createdAt.toISOString());
    assert.equal(json.posting.postedAt, confirmedAt.toISOString());
    assert.equal(json.intakes[0].createdAt, null);assert.equal(json.posting.refundDueAt, null);
    assert.equal(json.posting[userId === "owner" ? "refund" : "owner"], undefined);
  }
  assert.equal(body.openings[0]!.createdAt, createdAt, "projection does not change stored facts");
});
