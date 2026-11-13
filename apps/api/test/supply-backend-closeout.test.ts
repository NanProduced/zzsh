import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_PERMISSION, type EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { readAdminCatalog } from "../src/supply/catalog";
import { assertFullPayoutTermsAccepted, fullPayoutDraftFields, fullPayoutTermsSourceSuffix, parseFullPayoutTermsAcceptance, readFullPayoutTerms } from "../src/supply/full-payout-terms";
import { sealVersion, updateFullPayoutTermsDraft } from "../src/supply/rules";
import { readAdminSupplyOperationResult, readUserSupplyOperationResult } from "../src/supply/supply-operation-results";
import { fingerprintRequest } from "../src/supply/supply-util";
import { fundingPolicyFixture } from "./funding-authority-fixtures";
import { handleSupplyUserRoute } from "../src/supply/supply-routes";

test("user media upload intent audit records the validated display or evidence purpose", async t => {
  for (const purpose of ["ACCOUNT_DISPLAY", "ACCOUNT_EVIDENCE", undefined, "INVALID_PURPOSE", "OTHER_ACCOUNT"] as const) await t.test(purpose ?? "legacy default", async t => {
    const identity: typeof import("../src/auth/user-identity") = require("../src/auth/user-identity");
    t.mock.method(identity, "readUserContext", async () => ({ userId: "fixture_owner", sessionId: "fixture_session" }));
    t.mock.method(identity, "assertUserContextInTransaction", async () => {});
    const intents: string[] = [], auditPurposes: string[] = [];
    const client = { release() {}, query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("SELECT 1 FROM zzsh_supply.rental_account")) return { rows: purpose === "OTHER_ACCOUNT" ? [] : [{}], rowCount: purpose === "OTHER_ACCOUNT" ? 0 : 1 };
      if (sql.includes('"owner_user_id" AS "ownerUserId"')) return { rows: [{ ownerUserId: "fixture_owner", gameId: "fixture_game" }], rowCount: 1 };
      if (sql.includes('INSERT INTO "zzsh_supply"."media_upload_intent"')) intents.push(values[4] as string);
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) auditPurposes.push(JSON.parse(values[10] as string).after.purpose);
      return { rows: [], rowCount: 0 };
    } };
    const response = { statusCode: 0, headersSent: false, status(code: number) { this.statusCode = code; return this; }, setHeader() { return this; }, json() { this.headersSent = true; return this; } };
    await handleSupplyUserRoute({ method: "POST", originalUrl: "/api/v1/supply/media/upload-intents", headers: { origin: "http://user.invalid", "idempotency-key": "idem_11111111111111111111111111111111", "x-request-id": "req_fixture_media_purpose" }, body: { accountId: "fixture_account", gameId: "fixture_game", mime: "image/png", size: 128, ...(purpose === undefined ? {} : { purpose }) } } as never, response as never,
      { pool: { connect: async () => client }, apiOrigin: "http://api.invalid", userOrigin: "http://user.invalid", adminOrigin: "http://admin.invalid", mediaStorage: { available: true } } as never);
    if (purpose === "INVALID_PURPOSE" || purpose === "OTHER_ACCOUNT") {
      assert.equal(response.statusCode, purpose === "OTHER_ACCOUNT" ? 404 : 400); assert.deepEqual(intents, []); assert.deepEqual(auditPurposes, []);
    } else {
      assert.equal(response.statusCode, 200); assert.deepEqual(intents, [purpose ?? "ACCOUNT_EVIDENCE"]); assert.deepEqual(auditPurposes, intents);
    }
  });
});

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

test("user account recovery is original-scope read-only and returns only a bounded receipt",async()=>{
  for(const action of ["pause","resume","withdraw"]){
    const operation=`supply.publication.${action}`,body={expectedRevision:"1",...(action==="withdraw"?{versionId:"version-1"}:{})};
    const digest=fingerprintRequest(operation,"account-1",body),sql:string[]=[];
    const client={query:async(text:string,values:unknown[])=>{
      sql.push(text);assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(text));
      if(text.includes("rental_account")){assert.deepEqual(values,["account-1","owner-1"]);return{rows:[{gameId:"game-1"}]};}
      assert.deepEqual(values,[JSON.stringify(["user","owner-1",operation,"account-1"]),key]);
      return{rows:[{requestFingerprint:digest,responseStatus:200,responseBody:{account:{id:"account-1",game_id:"game-1",revision:"2",private:"omit"},version:{id:"version-1",quote:{ownerAmount:"900"}},token:"omit"}}]};
    }} as never;
    const result=await readUserSupplyOperationResult(client,"owner-1",new URLSearchParams({operation,resourceId:"account-1",fingerprint:digest}),key);
    assert.deepEqual(result,{receipt:"RECORDED",operation,resourceId:"account-1",responseStatus:200,result:{accountId:"account-1",revision:"2",versionId:"version-1"}});assert.equal(sql.length,2);
  }
});

test("user recovery rejects other owners and arbitrary scope, and never resolves a missing or mismatched original",async()=>{
  const operation="supply.publication.pause",params=new URLSearchParams({operation,resourceId:"account-1",fingerprint});
  let queries=0;
  await assert.rejects(()=>readUserSupplyOperationResult({query:async()=>{queries++;return{rows:[]};}} as never,"other-owner",params,key),(error:any)=>error.status===404);assert.equal(queries,1);
  const own=(row:unknown)=>({query:async(text:string)=>({rows:text.includes("rental_account")?[{gameId:"game-1"}]:row?[row]:[]})} as never);
  assert.deepEqual(await readUserSupplyOperationResult(own(null),"owner-1",params,key),{receipt:"UNRESOLVED"});
  await assert.rejects(()=>readUserSupplyOperationResult(own({requestFingerprint:"0".repeat(64)}),"owner-1",params,key),(error:any)=>error.code==="IDEMPOTENCY_KEY_REUSED");
  const invalidFields: Record<string,string>[] = [{userId:"other"},{operation:"supply.publication.submit"},{resourceId:""},{fingerprint:"bad"}];
  for(const extra of invalidFields){
    const q=new URLSearchParams({...Object.fromEntries(params),...extra});let sent=0;
    await assert.rejects(()=>readUserSupplyOperationResult({query:async()=>{sent++;return{rows:[]};}} as never,"owner-1",q,key));assert.equal(sent,0);
  }
  for(const responseBody of [{account:{id:"other",game_id:"game-1",revision:"2"}},{account:{id:"account-1",game_id:"other-game",revision:"2"}},{}])
    await assert.rejects(()=>readUserSupplyOperationResult(own({requestFingerprint:fingerprint,responseStatus:200,responseBody}),"owner-1",params,key),(error:any)=>error.status===404);
});

test("original-result recovery returns bounded receipt data and omits tokens, evidence and amounts",async()=>{
  const f=recoveryClient({id:"payout-1",status:"DRAFT",uploadToken:"private-token",ownerAmount:"999",body:"private-body",evidenceRef:"private-evidence"});
  assert.deepEqual(await readAdminSupplyOperationResult(f.client,"admin-1",access,query(),key),{receipt:"RECORDED",operation:"supply.rules.full_payout_terms_draft.create",resourceId:null,responseStatus:200,result:{id:"payout-1",status:"DRAFT"}});
});

test("catalog operation recovery returns the original persisted catalogRevision without private fields", async () => {
  const operation = "supply.catalog.skins.update", resourceId = "skin-1";
  const f = scopedRecoveryClient({ id: resourceId, gameId: "game-1", catalogRevision: "1828", sourceSnapshot: { token: "SYNTHETIC_PRIVATE_SOURCE" }, uploadToken: "SYNTHETIC_PRIVATE_UPLOAD", responseBody: { password: "SYNTHETIC_PRIVATE_BODY" } }, resourceId);
  const result = await readAdminSupplyOperationResult(f.client, "admin-1", access, query(operation, resourceId), key);
  assert.deepEqual(result, { receipt: "RECORDED", operation, resourceId, responseStatus: 200, result: { id: resourceId, gameId: "game-1", catalogRevision: "1828" } });
  assert.deepEqual(f.scopes, [JSON.stringify(["admin", "admin-1", operation, resourceId])]);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE_"), false);
});

test("legacy catalog receipts keep an absent catalogRevision absent and reject non-scalar receipt data", async () => {
  for (const extra of [{}, { catalogRevision: { token: "SYNTHETIC_PRIVATE_REVISION" } }, { catalogRevision: "x".repeat(161) }]) {
    const f = scopedRecoveryClient({ id: "skin-1", ...extra }, "skin-1");
    const result = await readAdminSupplyOperationResult(f.client, "admin-1", access, query("supply.catalog.skins.update", "skin-1"), key);
    assert.equal(result.receipt, "RECORDED");
    assert.equal(Object.hasOwn(result.result!, "catalogRevision"), false);
    assert.deepEqual(result.result, { id: "skin-1" });
  }
});

test("catalog revision recovery retains permission, actor, resource and fingerprint isolation", async () => {
  const operation = "supply.catalog.skins.update", body = { id: "skin-1", catalogRevision: "1828" };
  const denied = scopedRecoveryClient(body, "skin-1");
  await assert.rejects(() => readAdminSupplyOperationResult(denied.client, "admin-1", { ...access, isBoss: false, permissions: new Set() }, query(operation, "skin-1"), key), (error: any) => error.status === 403);
  assert.equal(denied.scopes.length, 0);
  const otherActor = recoveryClient(body, "other-admin");
  assert.deepEqual(await readAdminSupplyOperationResult(otherActor.client, "admin-1", access, query(operation, "skin-1"), key), { receipt: "UNRESOLVED" });
  assert.equal(otherActor.sql.length, 1);
  const otherResource = scopedRecoveryClient(body, "skin-1");
  assert.deepEqual(await readAdminSupplyOperationResult(otherResource.client, "admin-1", access, query(operation, "skin-2"), key), { receipt: "UNRESOLVED" });
  const mismatch = recoveryClient(body, "admin-1", "PLATFORM_CATALOG", "0".repeat(64));
  await assert.rejects(() => readAdminSupplyOperationResult(mismatch.client, "admin-1", access, query(operation, "skin-1"), key), (error: any) => error.code === "IDEMPOTENCY_KEY_REUSED");
  assert.equal(mismatch.sql.length, 1);
});

test("game recovery returns its stable identity without copying nested configuration",async()=>{
  for (const [operation,resourceId] of [["supply.game.create",undefined],["supply.game.update","game-1"]] as const) {
    const f=recoveryClient({game:{id:"game-1",name:"Private configuration",description:"Not a receipt field",enabled:true}});
    const result=await readAdminSupplyOperationResult(f.client,"admin-1",access,query(operation,resourceId),key);
    assert.deepEqual(result,{receipt:"RECORDED",operation,resourceId:resourceId??null,responseStatus:200,result:{id:"game-1"}});
    assert(f.sql.some(sql=>sql.includes("FROM zzsh_supply.game WHERE id=$1")));
  }
});

test("boss-only recovery rechecks the original action permission before reading receipts",async()=>{
  for (const [operation,permissions,isBoss] of [
    ["supply.rules.release.activate",new Set([ADMIN_PERMISSION.supplyRulesEdit]),true],
    ["supply.rules.release.activate",new Set([ADMIN_PERMISSION.supplyRulesActivate]),false],
    ["supply.game.create",new Set([ADMIN_PERMISSION.supplyCatalogManage]),false],
  ] as const) {
    const f=recoveryClient({releaseId:"release-1",game:{id:"game-1"}});
    await assert.rejects(()=>readAdminSupplyOperationResult(f.client,"admin-1",{...access,isBoss,permissions},query(operation,"game-1"),key),(error:any)=>error.status===403);
    assert.equal(f.sql.length,0);
  }
  const allowed=recoveryClient({releaseId:"release-1",generation:"2",affectedCount:10});
  const result=await readAdminSupplyOperationResult(allowed.client,"admin-1",{...access,permissions:new Set([ADMIN_PERMISSION.supplyRulesActivate])},query("supply.rules.release.activate","game-1"),key);
  assert.deepEqual(result.result,{releaseId:"release-1",generation:"2"});
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

/* ---------- API C：本轮新增的原结果恢复登记 ---------- */

function scopedRecoveryClient(body: Record<string, unknown> | null, scopeResource: string | null = null) {
  const scopes: string[] = [];
  return {
    scopes, client: { query: async (text: string, values: unknown[]) => {
      assert(!/\b(INSERT|UPDATE|DELETE)\b/.test(text));
      if (text.includes("idempotency_record")) {
        const scope = JSON.parse(values[0] as string); scopes.push(JSON.stringify(scope));
        return { rows: body && scope[3] === scopeResource ? [{ requestFingerprint: fingerprint, responseStatus: 200, responseBody: body }] : [] };
      }
      return { rows: [{ gameId: "game-1", ownershipKind: "USER_SUPPLY" }] };
    } } as never,
  };
}
const gunsmithAccess = { ...access, permissions: new Set([ADMIN_PERMISSION.supplyGunsmithManage]) };

test("gunsmith creates recover from the recorded receipt id and never accept a guessed resource", async () => {
  const created = scopedRecoveryClient({ id: "code-1", gameId: "game-1", firearmId: "f-1", code: "secret_code_text", note: "operator free text", revision: "3", status: "ACTIVE" });
  const result = await readAdminSupplyOperationResult(created.client, "admin-1", gunsmithAccess, query("supply.gunsmith.code.create"), key);
  assert.equal(result.receipt, "RECORDED");
  assert.deepEqual(result.result, { id: "code-1", gameId: "game-1", revision: "3", status: "ACTIVE" }, "code text, note and firearmId stay outside the receipt whitelist");
  assert.equal(created.scopes[0], JSON.stringify(["admin", "admin-1", "supply.gunsmith.code.create", null]), "create scope must stay resource-less");
  // 同一次创建若调用方自行补一个 resourceId，作用域就变了：只能是未找到，不能猜。
  const guessed = scopedRecoveryClient({ id: "code-1", revision: "3" }, null);
  assert.deepEqual(await readAdminSupplyOperationResult(guessed.client, "admin-1", gunsmithAccess, query("supply.gunsmith.code.create", "code-1"), key), { receipt: "UNRESOLVED" });
});

test("gunsmith updates and code withdraw/restore recheck the original resource scope", async () => {
  for (const [operation, resourceId, body] of [
    ["supply.gunsmith.classification.update", "class-1", { id: "class-1", revision: "2", enabled: false, name: "Private label" }],
    ["supply.gunsmith.firearm.update", "f-1", { id: "f-1", revision: "5", enabled: true, mediaId: "media-1" }],
    ["supply.gunsmith.alias.update", "alias-1", { id: "alias-1", revision: "1", name: "Alias text" }],
    ["supply.gunsmith.code.withdraw", "code-1", { id: "code-1", revision: "4", status: "WITHDRAWN", code: "secret_code_text" }],
    ["supply.gunsmith.code.restore", "code-1", { id: "code-1", revision: "6", status: "ACTIVE", code: "secret_code_text" }],
  ] as const) {
    const f = scopedRecoveryClient(body, resourceId);
    const result: any = await readAdminSupplyOperationResult(f.client, "admin-1", gunsmithAccess, query(operation, resourceId), key);
    assert.equal(result.receipt, "RECORDED", operation);
    assert.equal(result.operation, operation, operation);
    assert.equal(result.resourceId, resourceId, operation);
    assert.ok(f.scopes[0]?.includes(resourceId), `${operation} must look up the original resource scope`);
    assert.ok(!JSON.stringify(result.result).includes("secret_code_text"), operation);
    assert.ok(!("name" in result.result) && !("mediaId" in result.result), operation);
  }
  // 成功后对象 revision 已再次变化也不影响恢复：读取不套首次写的版本前置。
  const moved = scopedRecoveryClient({ id: "f-1", revision: "1", enabled: true }, "f-1");
  const recovered = await readAdminSupplyOperationResult(moved.client, "admin-1", gunsmithAccess, query("supply.gunsmith.firearm.update", "f-1"), key);
  assert.equal(recovered.receipt, "RECORDED");
  assert.deepEqual(recovered.result, { id: "f-1", revision: "1", enabled: true });
});

test("gunsmith recovery requires the original manage permission before any read", async () => {
  for (const permissions of [new Set<string>(), new Set([ADMIN_PERMISSION.supplyCatalogManage]), new Set([ADMIN_PERMISSION.supplyReviewDecide])] as const) {
    const f = scopedRecoveryClient({ id: "code-1", revision: "2" });
    await assert.rejects(() => readAdminSupplyOperationResult(f.client, "admin-1", { ...access, isBoss: false, permissions }, query("supply.gunsmith.code.create"), key), (error: any) => error.status === 403);
    assert.equal(f.scopes.length, 0, "denied before the idempotency read");
  }
});

test("game cover recovery resolves the recorded gameId and matches the write receipt shape", async () => {
  const f = scopedRecoveryClient({ gameId: "game-1" }, "game-1");
  const result = await readAdminSupplyOperationResult(f.client, "admin-1", access, query("supply.game.cover", "game-1"), key);
  assert.deepEqual(result, { receipt: "RECORDED", operation: "supply.game.cover", resourceId: "game-1", responseStatus: 200, result: { id: "game-1", gameId: "game-1" } });
  assert.ok(f.scopes[0]?.includes("supply.game.cover"), "cover scope keeps the original game resource");
  // 回执体不含 gameId 时目标不可核对：404 只表示读不到可核对的原目标，不是原写未发生，也不能换 key 重提。
  const empty = scopedRecoveryClient({ note: "unrelated body" }, "game-1");
  await assert.rejects(() => readAdminSupplyOperationResult(empty.client, "admin-1", access, query("supply.game.cover", "game-1"), key), (error: any) => error.status === 404);
});

test("user-supply media review and visibility receipts stay recoverable; upload intents stay platform-only", async () => {
  for (const operation of ["supply.media.review", "supply.media.visibility"] as const) {
    const f = scopedRecoveryClient({ id: "asset-1", reviewState: "APPROVED", accessClass: "PRIVATE_REVIEW", storageKey: "private/object/key", uploadToken: "private-token", technicalState: "READY" }, "asset-1");
    const result = await readAdminSupplyOperationResult(f.client, "admin-1", { ...access, permissions: new Set([ADMIN_PERMISSION.supplyReviewDecide]) }, query(operation, "asset-1"), key);
    assert.equal(result.receipt, "RECORDED", operation);
    assert.deepEqual(result.result, { id: "asset-1", technicalState: "READY", reviewState: "APPROVED", accessClass: "PRIVATE_REVIEW" }, `${operation} must not echo storage keys or tokens`);
  }
  const intent = scopedRecoveryClient({ intentId: "intent-1", uploadToken: "private-token" });
  await assert.rejects(() => readAdminSupplyOperationResult(intent.client, "admin-1", access, query("supply.media.upload_intent.create"), key), (error: any) => error.status === 404);
});
