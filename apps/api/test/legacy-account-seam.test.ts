import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import * as access from "../src/auth/admin-authorization";
import * as service from "../src/supply/game-services";
import * as util from "../src/supply/supply-util";
import * as accountNumber from "../src/supply/account-number";
import { createLegacyOwnerRentalAccount } from "../src/legacy-load/legacy-account-seam";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";

test("historical account import preserves frozen/cancelled source owners without publishing or restoring identity", async t => {
  const numbered: string[] = [];
  t.mock.method(accountNumber,"assignAccountNumber",async(_client:PoolClient,id:string)=>{numbered.push(id);return "ZZ20261103000001";});
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
    if(sql.includes("SELECT i.provider"))return{rows:[{...owner,migration_proven:proof}]};
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
  assert.equal(numbered.length,3,"only authorized imported accounts receive a public number");
});

test("legacy account creation allocates a stable public number on fresh and historical replay, rejecting changed source or owner", async t => {
  t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,permissions:new Set(["supply.catalog.manage"])} as never));
  t.mock.method(service,"requireWritableGameService",async()=>({} as never));
  t.mock.method(util,"assertGameScope",async()=>undefined);
  const input={sourceSystem:"legacy_mysql_restore" as const,sourceEntity:"la_rental_accounts" as const,legacyId:"10",sourceDigest:"a".repeat(64),
    evidenceRef:"SYNTHETIC:account:10",owner:{legacyId:"20",sourceDigest:"b".repeat(64)},gameId:"delta_fixture"};
  const actor={id:"boss",sessionId:"session",requestId:"request"};
  const records=new Map<string,{requestFingerprint:unknown;responseStatus:unknown;responseBody:unknown}>();
  let account:{id:string;owner_user_id:string;game_id:string;display_no:string|null}|null=null, allocations=0, inserts=0;
  const client={query:async(sql:string,args:unknown[]=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes('FROM "zzsh_supply"."idempotency_record"')){
      const row=records.get(JSON.stringify(args));return{rows:row?[row]:[],rowCount:row?1:0};
    }
    if(sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')){
      records.set(JSON.stringify(args.slice(0,2)),{requestFingerprint:args[2],responseStatus:args[3],responseBody:JSON.parse(args[4] as string)});
      return{rows:[],rowCount:1};
    }
    if(sql.includes("SELECT i.provider"))return{rows:[{provider:"legacy_mysql_restore",provider_reference:`la_user:${args[0]===legacyOwnerUserId("legacy_mysql_restore","la_user","20")?"20":"21"}`,account_status:"ACTIVE",suspended:false,migration_proven:true}]};
    if(sql.includes("SELECT owner_user_id, game_id")||sql.includes("SELECT id,display_no"))return{rows:account?[account]:[],rowCount:account?1:0};
    if(sql.includes('INSERT INTO "zzsh_supply"."rental_account"')){
      account={id:args[0] as string,owner_user_id:args[1] as string,game_id:args[2] as string,display_no:null};inserts++;return{rows:[],rowCount:1};
    }
    if(sql.includes("to_regprocedure"))return{rows:[{ready:true}]};
    if(sql.includes("SELECT zzsh_supply.next_dated_account_display_no()"))return{rows:[{number:`ZZ20261103${String(++allocations).padStart(6,"0")}`}]};
    if(sql.includes("WHERE a.id<>$2"))return{rows:[],rowCount:0};
    if(sql.includes("UPDATE zzsh_supply.rental_account SET display_no")){
      assert.ok(account);account.display_no=args[1] as string;return{rows:[],rowCount:1};
    }
    if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"'))return{rows:[],rowCount:1};
    throw new Error(`Unexpected legacy-account query: ${sql}`);
  }} as unknown as PoolClient;
  const first=await createLegacyOwnerRentalAccount(client,input,actor);
  assert.equal(first.replayed,false);assert.equal(allocations,1);assert.equal(inserts,1);
  assert.equal((account as {display_no:string|null}|null)?.display_no,"ZZ20261103000001");
  assert.deepEqual(await createLegacyOwnerRentalAccount(client,input,actor),{...first,replayed:true});
  assert.equal(allocations,1);assert.equal(inserts,1);
  // An import recorded before public-number allocation can resume without rewriting its idempotency receipt.
  (account as {display_no:string|null}|null)!.display_no=null;
  assert.deepEqual(await createLegacyOwnerRentalAccount(client,input,actor),{...first,replayed:true});
  assert.equal((account as {display_no:string|null}|null)?.display_no,"ZZ20261103000002");
  await assert.rejects(createLegacyOwnerRentalAccount(client,{...input,sourceDigest:"c".repeat(64)},actor),(error:any)=>error.status===409);
  await assert.rejects(createLegacyOwnerRentalAccount(client,{...input,owner:{...input.owner,legacyId:"21"}},{...actor,id:"other-admin"}),(error:any)=>error.status===409);
  assert.equal(allocations,2);assert.equal(inserts,1,"changed digest and cross-owner attempts cannot create or renumber");
  t.mock.method(access,"loadEffectiveAdminAccess",async()=>null);
  await assert.rejects(createLegacyOwnerRentalAccount(client,input,actor),(error:any)=>error.status===403);
  assert.equal(allocations,2,"replay authorization runs before public-number allocation");
});
