import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_PERMISSION, type EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { readAdminCatalog } from "../src/supply/catalog";
import { assertFullPayoutTermsAccepted, fullPayoutDraftFields, fullPayoutTermsSourceSuffix, parseFullPayoutTermsAcceptance, readFullPayoutTerms } from "../src/supply/full-payout-terms";
import { sealVersion, updateFullPayoutTermsDraft } from "../src/supply/rules";
import { readAdminSupplyOperationResult } from "../src/supply/supply-operation-results";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

const fields=fullPayoutDraftFields({policyRef:"g0-full-payout",policyVersion:"1",disclosureVersion:"g0-disclosure",title:"Offline terms",body:"Offline explicit full-payout disclosure."});
const row={id:"payout-1",game_id:"game-1",policy_ref:fields.policyRef,policy_version:fields.policyVersion,disclosure_version:fields.disclosureVersion,title:fields.title,body:fields.body,digest:fields.digest,status:"SEALED",revision:"2"};
const terms={termsVersionId:row.id,termsDigest:row.digest,disclosureVersion:row.disclosure_version,policyRef:row.policy_ref,policyVersion:row.policy_version,title:row.title,body:row.body};
const accepted={termsVersionId:terms.termsVersionId,termsDigest:terms.termsDigest,disclosureVersion:terms.disclosureVersion};
const access:EffectiveAdminAccess={status:"ACTIVE",isBoss:true,passwordChangeRequired:false,permissions:new Set(Object.values(ADMIN_PERMISSION))};
const key="idem_11111111111111111111111111111111",fingerprint="f".repeat(64);

test("full-payout bodies have bounded text and explicit acceptance cannot be inferred",()=>{
  assert.deepEqual(assertFullPayoutTermsAccepted(terms,accepted),accepted);
  for(const value of [undefined,null,{},[],{...accepted,termsDigest:"0".repeat(64)},{...accepted,termsVersionId:"other"},{...accepted,disclosureVersion:"other"},{...accepted,selected:true}]) assert.throws(()=>assertFullPayoutTermsAccepted(terms,value));
  for(const value of [null,{...accepted,termsDigest:"A".repeat(64)},{...accepted,termsVersionId:42}])assert.throws(()=>parseFullPayoutTermsAcceptance(value));
  for(const body of ["","x".repeat(20_001),null])assert.throws(()=>fullPayoutDraftFields({...fields,body}));
  assert.equal(fullPayoutTermsSourceSuffix(terms),`:full-payout-terms:${row.id}:${row.digest}`);
});

test("terms reader requires the sealed body, matching policy/disclosure and actual digest",async()=>{
  for(const patch of [{},{status:"DRAFT"},{disclosure_version:"other"},{policy_version:"other"},{digest:"0".repeat(64)}]){
    const client={query:async(_sql:string,values:unknown[])=>{assert.deepEqual(values,["game-1","g0-full-payout","1"]);return {rows:[{...row,...patch}]};}} as never;
    if(Object.keys(patch).length)await assert.rejects(()=>readFullPayoutTerms(client,"game-1",fundingPolicyFixture("NOT_REQUIRED")));
    else assert.deepEqual(await readFullPayoutTerms(client,"game-1",fundingPolicyFixture("NOT_REQUIRED")),terms);
  }
  await assert.rejects(()=>readFullPayoutTerms({query:async()=>({rows:[]})} as never,"game-1",fundingPolicyFixture("NOT_REQUIRED")));
});

test("sealed-price consumption requires its original terms binding, not a later matching name",async()=>{
  const client={query:async(sql:string,values:unknown[])=>{assert(sql.includes("p.full_payout_terms_version_id=t.id"));assert.deepEqual(values,["game-1","g0-full-payout","1","old-price"]);return {rows:[]};}} as never;
  await assert.rejects(()=>readFullPayoutTerms(client,"game-1",fundingPolicyFixture("NOT_REQUIRED"),"old-price"));
});

test("terms draft edits reject sealed/stale/null fields and price sealing rejects a dangling reference before UPDATE",async()=>{
  for(const [current,body]of [[row,{expectedRevision:"2",body:"changed"}],[{...row,status:"DRAFT"},{expectedRevision:"1",body:"changed"}],[{...row,status:"DRAFT"},{expectedRevision:"2",body:null}]] as const){
    const client={query:async(sql:string)=>{assert(!sql.startsWith("UPDATE"));return {rows:[current]};}} as never;
    await assert.rejects(()=>updateFullPayoutTermsDraft(client,"admin-1",true,row.id,body));
  }
  const sql:string[]=[];
  const client={query:async(text:string)=>{sql.push(text);return {rows:text.includes('FROM "zzsh_supply"."price_version"')?[{status:"DRAFT",game_id:"game-1",revision:"1",funding_policy:fundingPolicyFixture("NOT_REQUIRED")}]:[]};}} as never;
  await assert.rejects(()=>sealVersion(client,"admin-1",true,"price_version","price-1","1"));
  assert(!sql.some(text=>text.startsWith("UPDATE")));
});

test("catalog gets safe firearm identities without reading schemes or private sources; scope denial precedes data reads",async()=>{
  const sql:string[]=[];
  const client={query:async(text:string,values:unknown[])=>{sql.push(text);assert.equal(values[0],"game-1");return {rows:text.includes('FROM "zzsh_supply"."game"')?[{id:"game-1"}]:text.includes("FROM zzsh_supply.firearm")?[{id:"firearm-1",code:"rifle",name:"Offline firearm",enabled:true}]:[]};}} as never;
  const result=await readAdminCatalog(client,"admin-1",true,"game-1");
  assert.deepEqual(result.firearmOwners,[{id:"firearm-1",code:"rifle",name:"Offline firearm",enabled:true}]);
  const firearmSql=sql.find(text=>text.includes("FROM zzsh_supply.firearm"))!;
  assert(!/\*|source_note|gunsmith_code|media/i.test(firearmSql));
  let queries=0;
  await assert.rejects(()=>readAdminCatalog({query:async()=>{queries++;return {rows:[{mode:"SELECTED_GAMES",gameIds:["game-2"]}],rowCount:1};}} as never,"staff-1",false,"game-1"),(error:any)=>error.status===404);
  assert.equal(queries,1);
  let emptyScopeQueries=0;
  await assert.rejects(()=>readAdminCatalog({query:async()=>{emptyScopeQueries++;return {rows:[{mode:"SELECTED_GAMES",gameIds:[]}],rowCount:1};}} as never,"staff-1",false,"game-1"),(error:any)=>error.status===403 && error.code==="NO_GAME_SCOPE");
  assert.equal(emptyScopeQueries,1);
});

function recoveryClient(body:Record<string,unknown>|null,scopeActor="admin-1",ownershipKind="PLATFORM_CATALOG",storedFingerprint=fingerprint){
  const sql:string[]=[];
  return {sql,client:{query:async(text:string,values:unknown[])=>{
    sql.push(text);assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(text));
    if(text.includes("idempotency_record")){
      assert.equal(values[1],key);const scope=JSON.parse(values[0] as string);assert.equal(scope[0],"admin");
      return {rows:body && scope[1]===scopeActor?[{requestFingerprint:storedFingerprint,responseStatus:200,responseBody:body}]:[]};
    }
    return {rows:[{gameId:"game-1",ownershipKind}]};
  }} as never};
}
const query=(operation="supply.rules.full_payout_terms_draft.create",resourceId?:string)=>new URLSearchParams({operation,fingerprint,...(resourceId?{resourceId}:{})});

test("original-result recovery returns bounded receipt data and omits tokens, evidence and amounts",async()=>{
  const f=recoveryClient({id:"payout-1",status:"DRAFT",uploadToken:"private-token",ownerAmount:"999",body:"private-body",evidenceRef:"private-evidence"});
  assert.deepEqual(await readAdminSupplyOperationResult(f.client,"admin-1",access,query(),key),{receipt:"RECORDED",operation:"supply.rules.full_payout_terms_draft.create",resourceId:null,responseStatus:200,result:{id:"payout-1",status:"DRAFT"}});
});

test("game recovery returns its stable identity without copying nested configuration",async()=>{
  for (const [operation,resourceId] of [["supply.game.create",undefined],["supply.game.update","game-1"]] as const) {
    const f=recoveryClient({game:{id:"game-1",name:"Private configuration",description:"Not a receipt field",enabled:true}});
    const result=await readAdminSupplyOperationResult(f.client,"admin-1",access,query(operation,resourceId),key);
    assert.deepEqual(result,{receipt:"RECORDED",operation,resourceId:resourceId??null,responseStatus:200,result:{id:"game-1"}});
    assert(f.sql.some(sql=>sql.includes("FROM zzsh_supply.game WHERE id=$1")));
  }
});

test("missing/inflight or other actor receipt stays unresolved; fingerprint mismatch is a conflict",async()=>{
  for(const [body,scopeActor]of [[null,"admin-1"],[{id:"payout-1"},"other-admin"]] as const){
    const f=recoveryClient(body,scopeActor);assert.deepEqual(await readAdminSupplyOperationResult(f.client,"admin-1",access,query(),key),{receipt:"UNRESOLVED"});assert.equal(f.sql.length,1);
  }
  const f=recoveryClient({id:"payout-1"},"admin-1","PLATFORM_CATALOG","0".repeat(64));
  await assert.rejects(()=>readAdminSupplyOperationResult(f.client,"admin-1",access,query(),key),(error:any)=>error.code==="IDEMPOTENCY_KEY_REUSED");assert.equal(f.sql.length,1);
});

test("recovery is permission/object scoped and cannot retrieve user-supply or arbitrary operations",async()=>{
  const denied=recoveryClient({id:"payout-1"});
  await assert.rejects(()=>readAdminSupplyOperationResult(denied.client,"admin-1",{...access,isBoss:false,permissions:new Set()},query(),key),(error:any)=>error.status===403);assert.equal(denied.sql.length,0);
  const userMedia=recoveryClient({intentId:"intent-1",uploadToken:"private"},"admin-1","USER_SUPPLY");
  await assert.rejects(()=>readAdminSupplyOperationResult(userMedia.client,"admin-1",access,query("supply.media.upload_intent.create"),key),(error:any)=>error.status===404);
  for(const q of [query("auth.admin.freeze"),new URLSearchParams("operation=supply.game.update&operation=supply.game.create&fingerprint="+fingerprint),new URLSearchParams({operation:"supply.game.update",fingerprint,principalId:"other"})]) await assert.rejects(()=>readAdminSupplyOperationResult(denied.client,"admin-1",access,q,key));
});
