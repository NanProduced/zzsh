import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { initialLegacyFacts } from "../src/order/legacy-continuation-model";
import { projectLegacySettlementBasis, readLegacySettlementBasis, recordLegacySettlementBasis, type BasisInput } from "../src/order/legacy-settlement-basis";
import { legacyBinding, legacyEvidence, legacyPrices, legacyQuantities, legacySource } from "./legacy-continuation-fixture";

test("verified basis projection exposes quantities, never owner prices or a frozen-order claim", () => {
  const source={id:"basis_1",openingHaffM:"100",baseBot:"110",ownerPrices:legacyPrices("1.00"),openingItems:legacyQuantities("100"),fullPayout:false};
  const view=projectLegacySettlementBasis(source);
  assert.deepEqual(view,{id:"basis_1",openingHaffM:"100",openingItems:legacyQuantities("100"),fullPayout:false,source:"STAFF_VERIFIED"});
  assert.equal("ownerPrices" in view,false);assert.equal("baseBot" in view,false);
  view.openingItems.coffee="9";assert.notEqual(source.openingItems.coffee,"9");
});

test("staff-verified legacy basis is bound to source, evidence and original revision", async () => {
  const events: Array<Record<string, unknown>> = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes("SELECT details FROM zzsh_iam.audit_event")) return { rows: events.slice(-2).reverse().map(details => ({details})) };
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { events.push(JSON.parse(String(values[10]))); return { rows: [], rowCount: 1 }; }
    throw new Error("Unexpected SQL");
  } } as unknown as PoolClient;
  const source=legacySource({baseBot:"110",profitDot:"10",goodsMoney:"100.00",storedCommissionMoney:"9.00",depositAmount:"0.00",detainMoney:"0.00"});
  const row=legacyEvidence(initialLegacyFacts(source)), actor={realm:"admin" as const,userId:"staff_1",sessionId:"session_1",requestId:"request_1"};
  const input:BasisInput={expectedRevision:null,inputEvidenceId:row.id,expectedBasisId:null,openingHaffM:"100",baseBot:"110",
    ownerPrices:legacyPrices("1.00"),openingItems:legacyQuantities("100"),fullPayout:false,partiesVerified:true,reason:"已与双方核实原单资源"};
  const result=await recordLegacySettlementBasis(client,actor,legacyBinding,row,null,input);
  const basis=await readLegacySettlementBasis(client,legacyBinding,row,null);
  assert.equal(basis?.id,result.body.basisId);assert.equal(basis?.openingHaffM,"100");assert.equal(events.length,1);
  assert.equal(await readLegacySettlementBasis(client,legacyBinding,{...row,id:"another_evidence"},null),null);
  await assert.rejects(recordLegacySettlementBasis(client,actor,legacyBinding,row,null,input),/OPENING_BASIS_CHANGED/);
  await assert.rejects(recordLegacySettlementBasis(client,actor,legacyBinding,row,null,{...input,expectedBasisId:basis!.id,baseBot:"111"}),/OPENING_BASIS_PRICE_MISMATCH/);
  const updated=await recordLegacySettlementBasis(client,actor,legacyBinding,row,null,{...input,expectedBasisId:basis!.id,reason:"再次与双方核实"});
  assert.equal(updated.body.basisRevision,"2");assert.notEqual(updated.body.basisId,basis!.id);
  await assert.rejects(recordLegacySettlementBasis(client,actor,legacyBinding,row,null,{...input,expectedBasisId:basis!.id}),/OPENING_BASIS_CHANGED/);
  (events[1]!.basis as Record<string,unknown>).openingHaffM="101";
  await assert.rejects(readLegacySettlementBasis(client,legacyBinding,row,null),/OPENING_BASIS_UNAVAILABLE/);
});
