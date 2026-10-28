import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { readSettlementStages, settlementStageFactsFromView, settlementStageOf, type SettlementStageFacts } from "../src/order/settlement-record";

const base: SettlementStageFacts = { orderStatus: "PAID", viewerParty: "RENTER", posted: false, intakeOpen: false, currentVersionNo: null, renterAction: null, ownerAction: null };

test("stage rules are party-scoped and carry no amounts", () => {
  assert.deepEqual(settlementStageOf({ ...base, orderStatus: "PENDING_PAYMENT" }), { code: "NONE", label: null, viewerActionRequired: false, settlementVersionNo: null });
  assert.equal(settlementStageOf(base).code, "RENTING");
  assert.equal(settlementStageOf({ ...base, intakeOpen: true }).viewerActionRequired, false);
  const pending = settlementStageOf({ ...base, currentVersionNo: 2 });
  assert.deepEqual(pending, { code: "DECISION_PENDING", label: "待你确认结算", viewerActionRequired: true, settlementVersionNo: 2 });
  assert.equal(settlementStageOf({ ...base, currentVersionNo: 2, renterAction: "CONFIRM" }).code, "DECISION_WAITING");
  assert.equal(settlementStageOf({ ...base, viewerParty: "OWNER", currentVersionNo: 2, renterAction: "CONFIRM" }).viewerActionRequired, true);
  assert.equal(settlementStageOf({ ...base, currentVersionNo: 2, ownerAction: "REJECT" }).code, "DECISION_WAITING");
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
    assert.deepEqual(facts, listRow);
    assert.deepEqual(settlementStageOf(facts), settlementStageOf(listRow));
  }
});
