import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyTeamSendWindow } from "../src/im/legacy-order-team-window";

test("a newly created Team for an already ended legacy order remains writable for 72 hours",()=>{
  const ready="2026-11-07T00:00:00.000Z",old="2026-10-01T00:00:00.000Z";
  for(const status of ["COMPLETED","CANCELLED"]){
    const before=legacyTeamSendWindow(status,ready,old,Date.parse("2026-11-09T23:59:59.999Z"));
    assert.equal(before.sendUntil,"2026-11-10T00:00:00.000Z");assert.equal(before.terminalSendAllowed,true);
    assert.equal(legacyTeamSendWindow(status,ready,old,Date.parse("2026-11-10T00:00:00.000Z")).terminalSendAllowed,false);
  }
});

test("an in-progress order stays writable and later settlement starts its own 72-hour window",()=>{
  const ready="2026-11-07T00:00:00.000Z",end="2026-11-12T00:00:00.000Z";
  assert.equal(legacyTeamSendWindow("PAID",ready,null,Date.parse("2026-11-11T00:00:00Z")).terminalSendAllowed,true);
  const result=legacyTeamSendWindow("COMPLETED",ready,end,Date.parse("2026-11-13T00:00:00Z"));
  assert.equal(result.sendUntil,"2026-11-15T00:00:00.000Z");assert.equal(result.terminalSendAllowed,true);
  assert.equal(legacyTeamSendWindow("COMPLETED",null,end).terminalSendAllowed,false);
});
