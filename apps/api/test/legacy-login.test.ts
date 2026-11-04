import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readUserPasswordState, resolveLegacyNumberLogin } from "../src/auth/legacy-login";
import { buildTransactionalPhoneSignIn } from "../src/auth/user-auth-session";
import type { Pool } from "pg";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { verifyUserCredentialInTransaction } from "../src/auth/auth-security";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function db(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows };
    },
  };
}

const snRow={id:legacyOwnerUserId('legacy_mysql_restore','la_user','904'),username:'ZZ000019',phone:'+8613800019000',source_system:'legacy_mysql_restore',source_entity:'la_user',legacy_id:'904',source_digest:'a'.repeat(64),evidence_digest:'b'.repeat(64),source_sn:'ZZ000019',projection_digest:'a'.repeat(64),projection_system:'legacy_mysql_restore',projection_entity:'la_user',projection_id:'904'};
test('legacy public number resolves only the unique source-bound SN and retains the existing phone throttle bucket',async()=>{
 const p=db([snRow]),r=await resolveLegacyNumberLogin(p,'ZZ000019');assert.deepEqual(r,{userId:snRow.id,username:'ZZ000019',throttleSubject:snRow.phone});assert(Object.isFrozen(r));assert.deepEqual(p.calls[0]!.values,['ZZ000019']);
 assert.match(p.calls[0]!.text,/WHERE u\.username=\$1 LIMIT 2/);assert(!/u\."?(?:name|email)"?\s*=|WHERE u\.id\s*=\$1/.test(p.calls[0]!.text));
 assert.match(p.calls[0]!.text,/user\.legacy_number\.bound/);assert.match(p.calls[0]!.text,/user\.legacy_contact\.projected/);
});
test('phone-less legacy aliases share a stable internal subject without interpreting an internal UID as a number',async()=>{
 const r=await resolveLegacyNumberLogin(db([{...snRow,phone:null,username:'000019',source_sn:'000019'}]),'000019');assert.equal(r?.throttleSubject,'legacy-subject:'+snRow.id);
 const absent=db([]);assert.equal(await resolveLegacyNumberLogin(absent,'904'),null);assert.deepEqual(absent.calls[0]!.values,['904']);assert(!absent.calls[0]!.text.includes('legacy-owner'));
});
test('an existing username without matching source tuple/digests/SN or a duplicate match stays generic unavailable',async()=>{
 for(const changed of [{id:'other'},{username:'different'},{source_sn:'different'},{source_system:'native'},{source_entity:'other'},{legacy_id:'not-id'},{source_digest:'bad'},{evidence_digest:'bad'},{projection_digest:'c'.repeat(64)},{projection_system:'other'},{projection_entity:'other'},{projection_id:'905'}])assert.equal(await resolveLegacyNumberLogin(db([{...snRow,...changed}]),'ZZ000019'),null);
 assert.equal(await resolveLegacyNumberLogin(db([]),'ZZ000019'),null);assert.equal(await resolveLegacyNumberLogin(db([snRow,{...snRow,id:'other'}]),'ZZ000019'),null);
 // A later real provider verification does not erase the immutable migration/SN audit anchor.
 assert.equal((await resolveLegacyNumberLogin(db([{...snRow,provider:'aliyun-id2meta'}]),'ZZ000019'))?.userId,snRow.id);
});
test('invalid public-number input is rejected before any query and database failure is not a guessed user',async()=>{
 for(const input of ['', ' ZZ000019','ZZ000019 ','x'.repeat(129),'ZZ\n19']){const p=db([snRow]);assert.equal(await resolveLegacyNumberLogin(p,input),null);assert.equal(p.calls.length,0);}
 await assert.rejects(resolveLegacyNumberLogin({query:async()=>{throw Error('dependency failed');}},'ZZ000019'),/dependency failed/);
});
test("the real phone endpoint challenges a correct old password before writing a session", async () => {
  const {APIError} = await import("better-auth/api");
  const credential = credentialClient({password:null, legacyPasswordVersion:"legacy-md5-v0", legacyPasswordMd5:createHash("md5").update("original").digest("hex"), suspended:false, accountStatus:"ACTIVE"});
  const sql: string[] = [];
  let cookies = 0;
  const pool = {connect:async()=>({release(){},query:async(text:string)=>{
    sql.push(text);
    if(text.includes('SELECT id FROM zzsh_auth_user."user"')) return {rows:[{id:"user-test"}]};
    if(text.includes('FOR UPDATE OF a')) return credential.client.query(text);
    return {rows:[]};
  }})} as unknown as Pool;
  let handler: any;
  const endpoint = ((_path:string,_options:unknown,fn:unknown)=>{handler=fn;return fn;}) as never;
  buildTransactionalPhoneSignIn(pool,endpoint,APIError,(async()=>{cookies++;}) as never);
  await assert.rejects(handler({body:{phoneNumber:"13800000000",password:"original"},headers:new Headers(),context:{password:{verify:credential.verify,hash:credential.hash}}}), (error:any)=>error.status==="CONFLICT"&&error.body?.code==="LEGACY_PASSWORD_CHANGE_REQUIRED");
  assert.equal(cookies,0); assert.equal(credential.hashed,0);
  assert(sql.includes("ROLLBACK")); assert(!sql.some(text=>/^\s*(INSERT|UPDATE|DELETE)/.test(text)));
});
test('the real user runtime alias field is returned by the SDK but cannot be written on create or update',async()=>{
 const filename=[resolve(process.cwd(),'apps/api/src/auth/auth-runtime.ts'),resolve(process.cwd(),'src/auth/auth-runtime.ts')].find(existsSync);
 assert(filename,'run from the repository or API root');
 const source=ts.createSourceFile(filename,readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true);
 let user:ts.Expression|undefined;
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='userAuth'&&node.initializer&&ts.isCallExpression(node.initializer)){
  const config=node.initializer.arguments[0];if(config&&ts.isObjectLiteralExpression(config))for(const property of config.properties)if(ts.isPropertyAssignment(property)&&property.name.getText(source)==='user')user=property.initializer;
 }ts.forEachChild(node,visit);};visit(source);assert(user);
 const javascript=ts.transpileModule(`const user=${user.getText(source)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const config=runInNewContext(`${javascript}; user`,{common:{user:{additionalFields:{}}}});
 const {parseUserInput,parseUserOutput}=await import('better-auth/db');const options={user:config};
 const stored={id:'synthetic',name:'synthetic',email:'synthetic@example.invalid',emailVerified:false,createdAt:new Date(),updatedAt:new Date(),username:'ZZ000019'};
 assert.equal(Reflect.get(parseUserOutput(options,stored),'username'),'ZZ000019');
 for(const action of ['create','update'] as const){
  assert.throws(()=>parseUserInput(options,{username:'TAKEOVER'},action),(error:any)=>error.status==='BAD_REQUEST');
  for(const username of ['',null,false])assert.equal(Object.hasOwn(parseUserInput(options,{username},action),'username'),false);
 }
});

test("recognized legacy and modern credentials are set without forcing a replacement", async () => {
  const fake = db([{ modern: false, legacy: true }]);
  assert.equal(await readUserPasswordState(fake, "user-1"), "set");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0]!.values, ["user-1"]);
});

test("absent passwords and unavailable credentials are distinct, and reads fail closed", async () => {
  assert.equal(await readUserPasswordState(db([{ modern: true, legacy: false }]), "user-1"), "set");
  assert.equal(await readUserPasswordState(db([{ modern: false, legacy: false }]), "user-1"), "unavailable");
  assert.equal(await readUserPasswordState(db([]), "user-1"), "not-set");
  await assert.rejects(readUserPasswordState({ query: async () => { throw new Error("read failed"); } }, "user-1"));
});

function credentialClient(overrides: Record<string, unknown> = {}) {
  const row = { id: "account-test", userId: "user-test", password: "CURRENT_HASH", legacyPasswordMd5: null,
    legacyPasswordVersion: null, legacyPasswordSalt: null, suspended: true, accountStatus: "FROZEN", ...overrides };
  const calls: string[] = [];
  let verified = 0, hashed = 0;
  const client = { query: async (text: string) => {
    calls.push(text);
    return { rows: text.includes('FROM "zzsh_auth_user"."account" a') ? [row] : [], rowCount: 1 };
  } } as unknown as PoolClient;
  return { client, calls, get verified() { return verified; }, get hashed() { return hashed; },
    verify: async (value: string, hash: string) => { verified++; return value === "correct" && hash === "CURRENT_HASH"; },
    hash: async () => { hashed++; return "UPGRADED_HASH"; } };
}

test("sign-in can identify a valid frozen credential without creating or changing it", async () => {
  const fake = credentialClient();
  assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test", "sign-in"), "retry");
  assert.equal(fake.verified, 1);
  assert.equal(fake.hashed, 0);
  assert.equal(fake.calls.some(q => /^\s*(UPDATE|INSERT|DELETE)/.test(q)), false);
});

test("wrong frozen passwords remain generic rejections and never write", async () => {
  const fake = credentialClient();
  assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "wrong", "test", "sign-in"), "none");
  assert.equal(fake.verified, 1);
  assert.equal(fake.hashed, 0);
  assert.equal(fake.calls.some(q => /^\s*(UPDATE|INSERT|DELETE)/.test(q)), false);
});

test("non-login compatibility never admits a frozen account", async () => {
  const fake = credentialClient();
  assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test"), "none");
  assert.equal(fake.verified, 0);
});

test('server-resolved legacy userId uses the same credential/account lock and rejects cancelled or password-less subjects',async()=>{
 const active=credentialClient({suspended:false,accountStatus:'ACTIVE'});assert.equal(await verifyUserCredentialInTransaction(active.client,active.verify,active.hash,{userId:'user-test'},'correct','test','sign-in'),'retry');assert(active.calls.some(s=>s.includes('WHERE u."id" = $1')&&s.includes('FOR UPDATE OF a')));
 for(const changed of [{accountStatus:'CANCELLED'},{password:null,legacyPasswordMd5:null}]){const p=credentialClient({suspended:false,accountStatus:'ACTIVE',...changed});assert.equal(await verifyUserCredentialInTransaction(p.client,p.verify,p.hash,{userId:'user-test'},'correct','test','sign-in'),'none');assert.equal(p.verified,0);assert.equal(p.hashed,0);assert(!p.calls.some(s=>/^\s*(INSERT|UPDATE|DELETE)/.test(s)));}
 const frozen=credentialClient();assert.equal(await verifyUserCredentialInTransaction(frozen.client,frozen.verify,frozen.hash,{userId:'user-test'},'correct','test','sign-in'),'retry');assert.equal(frozen.hashed,0);
});

for (const version of ["legacy-md5-v0", "legacy-md5-v1"] as const) {
  test(`frozen ${version} can be rejected explicitly without upgrading its hash`, async () => {
    const salt = version === "legacy-md5-v1" ? "SYNTHETIC_SALT" : null;
    const fake = credentialClient({ password: null, legacyPasswordVersion: version, legacyPasswordSalt: salt,
      legacyPasswordMd5: createHash("md5").update("correct" + (salt ?? "")).digest("hex") });
    assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test", "sign-in"), "retry");
    assert.equal(fake.hashed, 0);
    assert.equal(fake.calls.some(q => /^\s*(UPDATE|INSERT|DELETE)/.test(q)), false);
    assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "wrong", "test", "sign-in"), "none");
  });
}

for (const mode of ["active-only", "sign-in"] as const) {
  for (const state of ["CANCELLED", "DEACTIVATED", "ACTIVE"] as const) {
    test(`${mode} never admits an otherwise suspended ${state} credential`, async () => {
      const fake = credentialClient({ accountStatus: state });
      assert.equal(await verifyUserCredentialInTransaction(fake.client, fake.verify, fake.hash, { phoneNumber: "+8613800000000" }, "correct", "test", mode), "none");
      assert.equal(fake.verified, 0);
    });
  }
}

test("active phone login requires a different new password before upgrading a legacy credential", async () => {
  const modern = credentialClient({ suspended: false, accountStatus: "ACTIVE" });
  assert.equal(await verifyUserCredentialInTransaction(modern.client, modern.verify, modern.hash, { phoneNumber: "+8613800000000" }, "correct", "test", "sign-in"), "retry");
  const legacy = credentialClient({ suspended: false, accountStatus: "ACTIVE", password: null,
    legacyPasswordMd5: createHash("md5").update("correct").digest("hex"), legacyPasswordVersion: "legacy-md5-v0" });
  const lookup = { phoneNumber: "+8613800000000" };
  assert.equal(await verifyUserCredentialInTransaction(legacy.client, legacy.verify, legacy.hash, lookup, "correct", "test", "sign-in"), "change-required");
  assert.equal(await verifyUserCredentialInTransaction(legacy.client, legacy.verify, legacy.hash, lookup, "correct", "test", "sign-in", "short"), "new-password-invalid");
  assert.equal(legacy.hashed, 0);
  assert.equal(await verifyUserCredentialInTransaction(legacy.client, legacy.verify, legacy.hash, lookup, "correct", "test", "sign-in", "different-fixture-password"), "retry");
  assert.equal(legacy.hashed, 1);
  assert.ok(legacy.calls.some(q => q.includes('UPDATE "zzsh_auth_user"."account"')));
  assert.ok(legacy.calls.some(q => /INSERT[\s\S]*audit_event/.test(q)));
});
