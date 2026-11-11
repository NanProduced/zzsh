import assert from "node:assert/strict";
import { test } from "node:test";
import { maskIdCard, maskRealName, readIdentityDisplay,pgIdentityDisplayStore,recordNativeIdentityDisplay, type IdentityDisplayStore } from "../src/auth/identity-display";
import type {PoolClient} from "pg";

// Synthetic values only.
test("identity-mask-v1 name and id rules", () => {
  assert.equal(maskRealName("甲"), "*");
  assert.equal(maskRealName("甲乙"), "甲*");
  assert.equal(maskRealName("甲乙丙"), "甲*丙");
  assert.equal(maskRealName("甲乙丙丁"), "甲**丁");
  assert.equal(maskIdCard("11010119900101123X"), "110101********123X");
  assert.equal(maskIdCard("ABCDEFGH"), "****EFGH");
});

test("native verified profile stores only purpose HMACs and masks, with no full name or document",async()=>{
 let values:unknown[]=[];
 let statement="";
 const client={query:async(sql:string,args:unknown[])=>{statement=sql;values=args;return{rows:[{user_id:"user"}],rowCount:1};}} as unknown as PoolClient;
 const input={userId:"user",subjectDigest:"a".repeat(64),fullName:"合成姓名",documentNumber:"110105199001011232",provider:"aliyun-id2meta" as const,providerReference:"real-request",verifiedAt:new Date("2026-11-02T00:00:00Z")};
 await recordNativeIdentityDisplay(client,input,Buffer.alloc(32,5));
 assert.equal(values.includes(input.fullName),false);assert.equal(values.includes(input.documentNumber),false);
 assert.match(String(values[2]),/^[a-f0-9]{64}$/);assert.notEqual(values[2],input.subjectDigest);
 assert.equal(values[3],"合**名");assert.equal(values[4],"110105********1232");
 assert.match(statement,/s\.verified_at FROM/);assert.equal(values.some(value=>value instanceof Date),false,"exact database timestamp must not roundtrip through JavaScript milliseconds");
 const stale={query:async()=>({rowCount:0,rows:[]})} as unknown as PoolClient;
 await assert.rejects(recordNativeIdentityDisplay(stale,input,Buffer.alloc(32,5)),(error:unknown)=>(error as{status?:number}).status===503);
 await assert.rejects(recordNativeIdentityDisplay(client,input,undefined),(error:unknown)=>(error as{status?:number}).status===503);
});

test("native display uses only current provider/subject binding and never selects name HMAC",async()=>{
 const statements:string[]=[];
 const client={release(){},query:async(sql:string)=>{
  statements.push(sql);
  if(sql.includes("to_regclass"))return{rows:[{ready:true}]};
  if(sql.includes("native-identity-display-read"))return{rows:[{nameMask:"合**名",documentMask:"110105********1232"}]};
  return{rows:[]};
 }} as unknown as PoolClient;
 const display=await readIdentityDisplay(pgIdentityDisplayStore(client),"user","VERIFIED");
 assert.equal(display.identityDisplay?.realNameMasked,"合**名");
 assert.equal("identityDisplaySource"in display&&display.identityDisplaySource,"NATIVE_PROVIDER");
 const read=statements.find(sql=>sql.includes("native-identity-display-read"))!;
 assert.match(read,/s\.provider=p\.provider/);assert.match(read,/b\.subject_digest=p\.subject_digest/);
 assert.doesNotMatch(read,/SELECT.*name_hmac/);
 assert.equal(statements.some(sql=>sql.includes('SELECT real_name AS "realName"')),false);
});

test("missing native profile capability preserves recorded source while a denied read restores its savepoint",async()=>{
 const fallback={query:async(sql:string)=>({rows:sql.includes("to_regclass")?[{ready:false}]:[{realName:"合成姓名",idCardNo:"110105199001011232"}]})} as unknown as PoolClient;
 const old=await readIdentityDisplay(pgIdentityDisplayStore(fallback),"user","VERIFIED");
 assert.equal("identityDisplaySource"in old&&old.identityDisplaySource,"RECORDED_SOURCE");
 const seen:string[]=[];
 const denied={release(){},query:async(sql:string)=>{
  seen.push(sql);if(sql.includes("to_regclass"))return{rows:[{ready:true}]};
  if(sql.includes("native-identity-display-read"))throw Object.assign(new Error("synthetic private driver detail"),{code:"42501"});
  return{rows:[]};
 }} as unknown as PoolClient;
 assert.equal((await readIdentityDisplay(pgIdentityDisplayStore(denied),"user","VERIFIED")).identityDisplayReason,"STORE_UNAVAILABLE");
 assert.ok(seen.includes("ROLLBACK TO SAVEPOINT identity_display_read"));
});

test("migrated identity self display reads only masks tied to the current legacy subject", async () => {
 const statements:string[]=[];
 const client={query:async(sql:string)=>{
  statements.push(sql);
  if(sql.includes("to_regclass('zzsh_iam.user_identity_verified_profile')"))return{rows:[{ready:false}]};
  if(sql.includes("to_regclass('zzsh_iam.user_legacy_identity_profile')"))return{rows:[{ready:true}]};
  if(sql.includes("FROM zzsh_iam.user_legacy_identity_profile p"))return{rows:[{nameMask:"合**名",documentMask:"990000********123X"}]};
  throw new Error("unexpected query");
 }} as unknown as PoolClient;
 const display=await readIdentityDisplay(pgIdentityDisplayStore(client),"user","VERIFIED");
 assert.equal(display.identityDisplay?.realNameMasked,"合**名");
 assert.equal("identityDisplaySource" in display && display.identityDisplaySource,"RECORDED_SOURCE");
 const query=statements.find(sql=>sql.includes("FROM zzsh_iam.user_legacy_identity_profile p"))!;
 assert.doesNotMatch(query,/ciphertext|authentication_tag|nonce/);
 assert.match(query,/s\.provider_reference=p\.source_ref/); assert.match(query,/b\.source='LEGACY_IMPORT'/);
});

test("display read: verified/recorded, not recorded, not verified, store unavailable, no value leak on error", async () => {
  const store = (row: { realName: string; idCardNo: string } | null, err?: object): IdentityDisplayStore => ({ read: async () => { if (err) throw err; return row; } });
  const ok = await readIdentityDisplay(store({ realName: "测试人", idCardNo: "000000200001010000" }), "u", "VERIFIED");
  assert.deepEqual(ok, { identityDisplay: { realNameMasked: "测*人", idCardMasked: "000000********0000", maskingVersion: "identity-mask-v1" }, identityDisplayReason: null });
  assert.ok(!JSON.stringify(ok).includes("20000101"));
  assert.equal((await readIdentityDisplay(store(null), "u", "VERIFIED")).identityDisplayReason, "NOT_RECORDED");
  let called = false;
  assert.equal((await readIdentityDisplay({ read: async () => { called = true; return null; } }, "u", "UNVERIFIED")).identityDisplayReason, "NOT_VERIFIED");
  assert.equal(called, false);
  assert.equal((await readIdentityDisplay(store(null, { code: "42P01" }), "u", "VERIFIED")).identityDisplayReason, "STORE_UNAVAILABLE");
  await assert.rejects(readIdentityDisplay(store(null, { code: "XX", message: "测试人 000000200001010000" }), "u", "VERIFIED"), (e: Error) => !e.message.includes("000000200001010000"));
});
