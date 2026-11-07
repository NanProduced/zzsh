import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

import { requiresEarlySettlementAcceptance } from "../src/order/settlement-record";
import { newEarlySettlementDisclosure, readEarlySettlementDisclosure } from "../src/legal/legal-documents";
import { handleSettlementAdminRoute, handleSettlementUserRoute } from "../src/order/settlement-routes";

test("only orders that froze the new disclosure require early-settlement acceptance", () => {
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "ORDER_CONFIRMATION", agreementAcceptanceSchema: 1, earlySettlementDisclosure: newEarlySettlementDisclosure() } }), true);
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "ORDER_CONFIRMATION" } }), false);
  assert.equal(requiresEarlySettlementAcceptance({ quote: {} }), false);
  assert.equal(requiresEarlySettlementAcceptance({ quote: { quoteKind: "LEGACY" } }), false);
});

test("frozen disclosure retains its exact text and refuses a changed digest", () => {
  const doc = newEarlySettlementDisclosure();
  const quote = { agreementAcceptanceSchema: 1, earlySettlementDisclosure: doc };
  assert.deepEqual(readEarlySettlementDisclosure(quote), doc);
  assert.throws(() => readEarlySettlementDisclosure({ ...quote, earlySettlementDisclosure: { ...doc, body: "changed" } }));
  assert.throws(() => readEarlySettlementDisclosure({ agreementAcceptanceSchema: 1 }));
});

test("real settlement routes bind explicit consent into idempotency while preserving old omitted bodies", async () => {
  const require = createRequire(__filename);
  const routes = require("../src/supply/supply-routes");
  const identity = require("../src/auth/user-identity");
  const record = require("../src/order/settlement-record");
  const original = { origin: routes.requireOrigin, write: routes.runIdempotentWrite, user: identity.readUserContext, open: record.settlementSurfaceOpen };
  let fingerprint: Record<string, unknown> | undefined;
  routes.requireOrigin = () => true;
  routes.runIdempotentWrite = async (...args: unknown[]) => { fingerprint = args[6] as Record<string, unknown>; };
  identity.readUserContext = async () => ({ userId: "user_1", sessionId: "session_1" });
  record.settlementSurfaceOpen = () => true;
  try {
    for (const suffix of ["/settlements", "/settlements/version_1/decision"]) {
      for (const accepted of [undefined, false, true]) {
        const base = suffix.endsWith("decision") ? { action: "CONFIRM", versionHash: "a".repeat(64) }
          : { lines: [{ itemId: "item_1", remainingQuantity: "0" }], acceptedHash: "a".repeat(64) };
        const body = { ...base, ...(accepted === undefined ? {} : { termsAccepted: accepted }) };
        fingerprint = undefined;
        await handleSettlementUserRoute({ method: "POST", url: `/api/v1/orders/order_1${suffix}`, headers: {}, body } as never,
          { setHeader() {} } as never, { pool: {}, settlementRecordingEnabled: true } as never);
        const sent = fingerprint as Record<string, unknown> | undefined;
        assert.ok(sent);
        assert.equal(Object.hasOwn(sent, "termsAccepted"), accepted !== undefined);
        if (accepted !== undefined) assert.equal(sent.termsAccepted, accepted);
      }
    }
  } finally {
    routes.requireOrigin = original.origin; routes.runIdempotentWrite = original.write;
    identity.readUserContext = original.user; record.settlementSurfaceOpen = original.open;
  }
});

test("settlement route binds actual quantities into the original idempotent intent",async()=>{
 const require=createRequire(__filename),routes=require("../src/supply/supply-routes"),identity=require("../src/auth/user-identity"),record=require("../src/order/settlement-record");
 const original={origin:routes.requireOrigin,write:routes.runIdempotentWrite,user:identity.readUserContext,open:record.settlementSurfaceOpen};let fingerprint:Record<string,unknown>|undefined;
 routes.requireOrigin=()=>true;routes.runIdempotentWrite=async(...args:unknown[])=>{fingerprint=args[6] as Record<string,unknown>;};identity.readUserContext=async()=>({userId:"user_1",sessionId:"session_1"});record.settlementSurfaceOpen=()=>true;
 try{
  const send=(lines:unknown[])=>handleSettlementUserRoute({method:"POST",url:"/api/v1/orders/order_1/settlements",headers:{},body:{lines,acceptedHash:"a".repeat(64)}} as never,{setHeader(){}} as never,{pool:{},settlementRecordingEnabled:true} as never);
  await send([{itemId:"item_1",consumedQuantity:"12"}]);
  assert.deepEqual(fingerprint?.lines,[{itemId:"item_1",quantity:"12",quantityKind:"CONSUMED"}]);
  await assert.rejects(()=>send([{itemId:"item_1",consumedQuantity:"12",remainingQuantity:"0"}]));
  await assert.rejects(()=>send([{itemId:"item_1",consumedQuantity:"-1"}]));
  await assert.rejects(()=>send([{itemId:"item_1",consumedQuantity:"12",buyerUnitAmount:"0"}]));
 }finally{routes.requireOrigin=original.origin;routes.runIdempotentWrite=original.write;identity.readUserContext=original.user;record.settlementSurfaceOpen=original.open;}
});

test("support finalization binds the version and reason to the original idempotent intent",async()=>{
 const require=createRequire(__filename),routes=require("../src/supply/supply-routes"),auth=require("../src/auth/auth-security"),record=require("../src/order/settlement-record");
 const original={origin:routes.requireOrigin,write:routes.runIdempotentWrite,admin:auth.readAdminContext,open:record.settlementSurfaceOpen};let fingerprint:Record<string,unknown>|undefined;
 routes.requireOrigin=()=>true;routes.runIdempotentWrite=async(...args:unknown[])=>{fingerprint=args[6] as Record<string,unknown>;};auth.readAdminContext=async()=>({userId:"staff_1",sessionId:"session_1"});record.settlementSurfaceOpen=()=>true;
 try{
  const send=(body:Record<string,unknown>)=>handleSettlementAdminRoute({method:"POST",url:"/api/v1/admin/orders/order_1/settlements/version_1/finalize",headers:{},body} as never,{setHeader(){}} as never,{pool:{},settlementRecordingEnabled:true} as never);
  await send({versionHash:"a".repeat(64),reason:"双方已核实"});assert.deepEqual(fingerprint,{versionHash:"a".repeat(64),reason:"双方已核实"});
  await assert.rejects(()=>send({versionHash:"a".repeat(64),reason:"短"}));
  await assert.rejects(()=>send({versionHash:"a".repeat(64),reason:"双方已核实",actor:"forged"}));
 }finally{routes.requireOrigin=original.origin;routes.runIdempotentWrite=original.write;auth.readAdminContext=original.admin;record.settlementSurfaceOpen=original.open;}
});

test("support opening confirmation binds its reason while old clients may omit it",async()=>{
 const require=createRequire(__filename),routes=require("../src/supply/supply-routes"),auth=require("../src/auth/auth-security"),record=require("../src/order/settlement-record");
 const original={origin:routes.requireOrigin,write:routes.runIdempotentWrite,admin:auth.readAdminContext,open:record.settlementSurfaceOpen};let fingerprint:Record<string,unknown>|undefined;
 routes.requireOrigin=()=>true;routes.runIdempotentWrite=async(...args:unknown[])=>{fingerprint=args[6] as Record<string,unknown>;};auth.readAdminContext=async()=>({userId:"staff_1",sessionId:"session_1"});record.settlementSurfaceOpen=()=>true;
 try{
  const send=(body:Record<string,unknown>)=>handleSettlementAdminRoute({method:"POST",url:"/api/v1/admin/orders/order_1/openings/opening_1/confirm",headers:{},body} as never,{setHeader(){}} as never,{pool:{},settlementRecordingEnabled:true} as never);
  await send({party:"RENTER",versionNo:1,reason:"已核对期初"});assert.deepEqual(fingerprint,{party:"RENTER",versionNo:1,reason:"已核对期初"});
  await send({party:"OWNER",versionNo:1});assert.deepEqual(fingerprint,{party:"OWNER",versionNo:1});
  await assert.rejects(()=>send({party:"RENTER",versionNo:1,reason:"短"}));
  await assert.rejects(()=>send({party:"RENTER",versionNo:1,reason:"已核对期初",userId:"forged"}));
 }finally{routes.requireOrigin=original.origin;routes.runIdempotentWrite=original.write;auth.readAdminContext=original.admin;record.settlementSurfaceOpen=original.open;}
});
