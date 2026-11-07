import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import * as auth from "../src/auth/auth-security";
import * as userAuth from "../src/auth/user-identity";
import * as access from "../src/auth/admin-authorization";
import * as supply from "../src/supply/supply-util";
import * as readiness from "../src/order/legacy-order-read";
import {readLegacyContinuation} from "../src/order/legacy-continuation-evidence";
import {initialLegacyFacts} from "../src/order/legacy-continuation-model";
import {legacyBinding,legacyEvidence,legacySource} from "./legacy-continuation-fixture";

test("commission beneficiary name is read only for authorized admin finance views",async t=>{
 let finance=true,nameQueries=0;
 t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});
 t.mock.method(userAuth,"assertUserContextInTransaction",async()=>({}) as any);
 t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:false,passwordChangeRequired:false,permissions:new Set(finance?["order.read","finance.document.read"]:["order.read"])}) as any);
 t.mock.method(supply,"assertGameScope",async()=>{});t.mock.method(readiness,"legacyContinuationReady",async()=>true);
 const duty={id:"commission_1",orderId:legacyBinding.id,continuationVersionId:null,kind:"COMMISSION",sourceRecordId:"90",counterpartyUserId:legacyBinding.renterUserId,
  amountCents:"500",currency:"CNY",status:"PENDING",source:"LEGACY_IMPORT",sourceStatus:"1",level:"2",ratio:"20",maturityAt:null,revision:"1",settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};
 const original=legacyEvidence(initialLegacyFacts(legacySource()));
 const client={query:async(sql:string)=>{
  if(sql.includes("FROM zzsh_order.legacy_order_read_snapshot WHERE id="))return{rows:[legacyBinding]};
  if(sql.includes("FROM zzsh_iam.user_identity_state"))return{rows:[{valid:true}]};
  if(sql.includes("FROM zzsh_order.legacy_continuation_version"))return{rows:[]};
  if(sql.includes("FROM zzsh_order.legacy_order_duty WHERE"))return{rows:[duty]};
  if(sql.includes("FROM zzsh_order.legacy_continuation_evidence"))return{rows:[original]};
  if(sql.includes('SELECT id,name FROM zzsh_auth_user."user"')){nameQueries++;return{rows:[{id:legacyBinding.renterUserId,name:"小李"}]};}
  throw Error("Unexpected SQL "+sql);
 }} as unknown as PoolClient;
 const admin={realm:"admin" as const,userId:"staff",sessionId:"session",requestId:"req"};
 const visible=await readLegacyContinuation(client,admin,legacyBinding.id,async()=>"NONE");
 assert.deepEqual((visible.continuation.duties[0] as any).beneficiary,{userId:legacyBinding.renterUserId,name:"小李"});assert.equal(nameQueries,1);
 finance=false;const restricted=await readLegacyContinuation(client,admin,legacyBinding.id,async()=>"NONE");assert.equal(restricted.continuation.duties.length,0);assert.equal(nameQueries,1);
 const renter={realm:"user" as const,userId:legacyBinding.renterUserId,sessionId:"session",requestId:"req"};
 const own=await readLegacyContinuation(client,renter,legacyBinding.id,async()=>"NONE");assert.equal(own.continuation.duties.length,1);
 assert.equal(Object.hasOwn(own.continuation.duties[0]!,"beneficiary"),false);assert.equal(nameQueries,1);
});
