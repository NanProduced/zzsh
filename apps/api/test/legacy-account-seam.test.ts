import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import * as access from "../src/auth/admin-authorization";
import * as service from "../src/supply/game-services";
import * as util from "../src/supply/supply-util";
import { createLegacyOwnerRentalAccount } from "../src/legacy-load/legacy-account-seam";

test("historical account import preserves frozen/cancelled source owners without publishing or restoring identity", async t => {
  t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,permissions:new Set(["supply.catalog.manage"])} as never));
  t.mock.method(service,"requireWritableGameService",async()=>({} as never));
  t.mock.method(util,"assertGameScope",async()=>undefined);
  t.mock.method(util,"withIdempotency",async(_client:unknown,_scope:unknown,_key:unknown,_fingerprint:unknown,authorize:()=>Promise<unknown>,action:()=>Promise<{status:number;body:unknown}>)=>{
    await authorize();return{...await action(),replayed:false};
  });
  const input={sourceSystem:"legacy_mysql_restore" as const,sourceEntity:"la_rental_accounts" as const,legacyId:"10",sourceDigest:"a".repeat(64),
    evidenceRef:"SYNTHETIC:account:10",owner:{legacyId:"20",sourceDigest:"b".repeat(64)},gameId:"delta_fixture"};
  let owner={provider:"legacy_mysql_restore",provider_reference:"la_user:20",account_status:"ACTIVE",suspended:false},proof=true,inserts=0;
  const sqlSeen:string[]=[];
  const client={query:async(sql:string)=>{
    sqlSeen.push(sql);
    if(sql.includes("SELECT i.provider"))return{rows:[owner]};
    if(sql.includes("SELECT 1 FROM zzsh_iam.audit_event"))return{rows:proof?[{}]:[],rowCount:proof?1:0};
    if(sql.includes("SELECT owner_user_id, game_id"))return{rows:[]};
    if(sql.includes('INSERT INTO "zzsh_supply"."rental_account"'))inserts++;
    return{rows:[],rowCount:1};
  }} as unknown as PoolClient;
  for(const [account_status,suspended] of [["ACTIVE",false],["FROZEN",true],["CANCELLED",true]] as const){
    owner={...owner,account_status,suspended};
    assert.ok((await createLegacyOwnerRentalAccount(client,input,{id:"boss",sessionId:"session",requestId:"request"})).accountId);
  }
  assert.equal(inserts,3);
  assert.equal(sqlSeen.some(sql=>/UPDATE.*user_identity_state|INSERT.*listing_publication|UPDATE.*suspended/.test(sql)),false);
  for(const mismatch of [{provider:"fake"},{provider_reference:"la_user:other"},{account_status:"UNKNOWN"}]){
    owner={provider:"legacy_mysql_restore",provider_reference:"la_user:20",account_status:"FROZEN",suspended:true,...mismatch};
    await assert.rejects(createLegacyOwnerRentalAccount(client,input,{id:"boss",sessionId:"session",requestId:"request"}));
  }
  owner={provider:"legacy_mysql_restore",provider_reference:"la_user:20",account_status:"CANCELLED",suspended:true};proof=false;
  await assert.rejects(createLegacyOwnerRentalAccount(client,input,{id:"boss",sessionId:"session",requestId:"request"}));
  assert.equal(inserts,3,"source identity and exact migration proof remain mandatory");
});
