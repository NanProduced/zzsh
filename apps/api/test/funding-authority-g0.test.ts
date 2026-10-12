import assert from "node:assert/strict";
import test from "node:test";

import { assertFinalConfirmationFunding, createProductionSupplyGateReader, readFormalSupplyGate } from "../src/supply/funding-authority";

import { fundingPolicyFixture as policy } from "./funding-authority-fixtures";

function clientFor(value: unknown, proofRows: unknown[] = []) {
  return {
    query: async (sql: string) => {
      if (sql.includes("account_guarantee_proof")) return { rows: proofRows };
      if (sql.includes("zzsh_credit.user_credit_state")) return { rows: [{ score: 100, revision: "1" }] };
      if (sql.includes("SELECT a.id AS \"accountId\"")) return { rows: [{ accountId: "account-1", ownerUserId: "user-1", gameId: "game-1", currentVersionId: null, versionId: null, priceVersionId: "price-1", releaseId: "release-1", policy: value, policyStatus: "SEALED", priceStatus: "SEALED", payload: {quoteValues:{resourceTotal:{currency:"CNY",unit:"yuan",scale:2,amount:"100.00"}}} }] };
      if (sql.includes("owner_guarantee_requirement")) return { rows: [] };
      return { rows: [{ priceVersionId: "price-1", policy: value, status: "SEALED", gameId: "game-1", releaseId: "release-1" }] };
    },
  } as never;
}

test("G0 derives a stable policy reference for valid NOT_REQUIRED without a proof row", async () => {
  const gate = await readFormalSupplyGate(clientFor(policy("NOT_REQUIRED")), { id: "account-1", owner_user_id: "user-1" } as never);
  assert.deepEqual(gate, { publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "policy:price-1:g0-policy-v1:NOT_REQUIRED" });
});

test("G0 keeps positive requirements and invalid policies fail closed", async () => {
  const fixed = await readFormalSupplyGate(clientFor(policy("FIXED_CENTS")), { id: "account-1", owner_user_id: "user-1" } as never);
  assert.deepEqual(fixed, { publisherBail: "UNKNOWN", occupancy: "UNKNOWN", reference: null });
  const invalidPolicy = { ...policy("NOT_REQUIRED"), guaranteeRequirement: { ...policy("NOT_REQUIRED").guaranteeRequirement, requiredCents: "1" } };
  const invalidGate = await readFormalSupplyGate(clientFor(invalidPolicy), { id: "account-1", owner_user_id: "user-1" } as never);
  assert.deepEqual(invalidGate, { publisherBail: "UNKNOWN", occupancy: "UNKNOWN", reference: null });
});

test("credit eligibility display is nonlocking and write consumers retain row locks", async () => {
  for (const purpose of ["READ", "WRITE", undefined] as const) {
    const base = clientFor(policy("NOT_REQUIRED")) as unknown as { query: (sql: string) => Promise<unknown> };
    const sql: string[] = []; const query = base.query.bind(base);
    base.query = async text => { sql.push(text); if (purpose === "READ" && text.includes("FOR SHARE")) throw Error("read-only transaction rejects row locks"); return query(text); };
    const gate = await createProductionSupplyGateReader({creditGuaranteeEnabled:true})(base as never,{id:"account-1",owner_user_id:"user-1"} as never,purpose);
    assert.equal(gate.publisherBail,"NOT_REQUIRED");
    assert.equal(sql.some(text=>text.includes("FOR SHARE")),purpose!=="READ");
  }
});

test("final consumption rejects expired, replaced and incorrectly bound proofs; G0 remains policy-only", async () => {
  const expected={accountId:"account-1",ownerUserId:"user-1",priceVersionId:"price-1",releaseId:"release-1",policyVersion:"g0-policy-v1",reference:"proof-1",status:"SATISFIED"};
  const proof={id:"proof-1",ownerUserId:"user-1",accountId:"account-1",priceVersionId:"price-1",policyVersion:"g0-policy-v1",status:"SATISFIED",requiredCents:"3000",coveredCents:"3000",valid:true,validUntil:"2099-01-01T00:00:00Z"};
  await assertFinalConfirmationFunding(clientFor(policy("FIXED_CENTS"),[proof]),expected);
  for(const patch of [{valid:false},{validUntil:null},{id:"proof-2"},{status:"REVOKED"},{coveredCents:"2999"},{ownerUserId:"other"},{priceVersionId:"other"},{policyVersion:"other"}]) {
    await assert.rejects(()=>assertFinalConfirmationFunding(clientFor(policy("FIXED_CENTS"),[{...proof,...patch}]),expected),(e: any)=>e.code==="CONFIRMATION_DEPENDENCY_UNAVAILABLE");
  }
  await assertFinalConfirmationFunding(clientFor(policy("NOT_REQUIRED")),{...expected,reference:"policy:price-1:g0-policy-v1:NOT_REQUIRED",status:"NOT_REQUIRED"});
});
