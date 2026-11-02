import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { orderHasPaidState } from "../src/order/order";
import { manualCloseOrder } from "../src/order/manual-close";
import type { PoolClient } from "pg";
import * as security from "../src/auth/auth-security";
import * as access from "../src/auth/admin-authorization";
import * as scopes from "../src/auth/admin-scope";

test("manual close is a paid cancellation, while unpaid cancellations stay unpaid", () => {
  assert.equal(orderHasPaidState("PAID", null), true);
  assert.equal(orderHasPaidState("COMPLETED", null), true);
  assert.equal(orderHasPaidState("CANCELLED", "PRESTART_TERMINATED"), true);
  assert.equal(orderHasPaidState("CANCELLED", "MANUAL_CLOSE"), true);
  assert.equal(orderHasPaidState("CANCELLED", "USER"), false);
  assert.equal(orderHasPaidState("CANCELLED", "TIMEOUT"), false);
});

test("0129 admits only the paid MANUAL_CLOSE transition and keeps the row immutable", () => {
  const sql = readFileSync(resolve("migrations/business/0129_manual_close.sql"), "utf8");
  assert.match(sql, /cancel_reason IN\('USER','TIMEOUT','PRESTART_TERMINATED','MANUAL_CLOSE'\)/);
  assert.match(sql, /cancel_reason IN\('PRESTART_TERMINATED','MANUAL_CLOSE'\) AND paid_confirmation_id IS NOT NULL/);
  assert.match(sql, /OLD\.status='PAID' AND NEW\.status='CANCELLED' AND NEW\.cancel_reason='MANUAL_CLOSE'/);
  assert.match(sql, /manually closed order is immutable/);
  assert.match(sql, /c\.disposition='APPLIED'/);
  assert.match(sql, /prestart_termination t WHERE t\.order_id=NEW\.id AND t\.state<>'REJECTED'/);
  assert.match(sql, /CREATE TRIGGER manual_close_order_guard BEFORE UPDATE ON zzsh_order\.rental_order/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 129 && entry.tag === "0129_manual_close"));
});

test("new paid orders must use original refund responsibility or actual-consumption settlement instead of status-only closing",async t=>{
 t.mock.method(security,"assertAdminContextInTransaction",async()=>undefined);
 t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:false,permissions:new Set(["order.settlement.write"])} as never));
 t.mock.method(scopes,"readAdminGameScope",async()=>({mode:"ALL_GAMES",gameIds:[]}));
 const seen:string[]=[];let openingConfirmed=false,status="PAID",cancelReason:string|null=null;
 const client={query:async(sql:string)=>{
  seen.push(sql);
  if(sql.includes('SELECT game_id AS "gameId"'))return{rows:[{gameId:"delta"}],rowCount:1};
  if(sql.includes("FROM zzsh_order.im_order_member"))return{rows:[{}],rowCount:1};
  if(sql.includes('paid_confirmation_id AS "paidConfirmationId"'))return{rows:[{status,cancelReason,paidConfirmationId:"original-payment",cancelledAt:"historical-time",openingConfirmed}],rowCount:1};
  return{rows:[],rowCount:1};
 }} as unknown as PoolClient;
 for(const confirmed of [false,true]){
  openingConfirmed=confirmed;
  const result=await manualCloseOrder(client,"order",{userId:"support",sessionId:"session"},"handle actual original responsibility","request");
  assert.equal(result.status,409);assert.equal(result.body.status,"PAID");assert.equal(result.body.orderUnchanged,true);
  assert.equal((result.body.resolution as{code:string}).code,confirmed?"SETTLEMENT_REQUIRED":"PRESTART_REFUND_REQUIRED");
 }
 assert.equal(seen.some(sql=>/UPDATE zzsh_order\.rental_order|INSERT INTO zzsh_order\.(settlement|prestart|payment)/.test(sql)),false);
 status="CANCELLED";cancelReason="MANUAL_CLOSE";
 const replay=await manualCloseOrder(client,"order",{userId:"support",sessionId:"session"},"original request","request");
 assert.equal(replay.status,200);assert.equal(replay.body.alreadyClosed,true);assert.equal(replay.body.financeHandling,"OFFLINE_REQUIRED");
});
