import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { withTransaction } from "../src/auth/security-core";
import { verifyPersonalConfirmation, rebuildPersonalConfirmation, type ConfirmationFunding } from "../src/order/personal-confirmation";
import type { Options } from "./supply-publishing-checks";
import type { AuthRuntimeOptions } from "../src/auth/auth-runtime";
import { Pool } from "pg";
import { runPersonalOrderChecks } from "./personal-order-checks";

export const personalFixture = {
  key:{keyId:"pc2a-isolated",secret:randomBytes(32).toString("hex")},
  funding:null as ConfirmationFunding|null,
  sms:new Map() as NonNullable<AuthRuntimeOptions["fakeSmsOutbox"]>,
  runtimeAuth:undefined as AuthRuntimeOptions|undefined,
};

export async function runPersonalConfirmationChecks(o:Options,listing:any) {
  const input={accountId:o.accountId,versionId:listing.version.id,releaseId:listing.version.releaseId};
  const renter=(await o.pool.query(`SELECT u.id,s.id AS session_id FROM zzsh_auth_user."user" u JOIN zzsh_auth_user."session" s ON s."userId"=u.id WHERE u.email='m3b-user-2@example.invalid' LIMIT 1`)).rows[0];
  const membershipPath=`/api/bff/admin/users/${renter.id}/rental-membership`;
  const call=async(path:string,body?:unknown,jar=o.stranger,method=body===undefined?"GET":"POST",key="pc2a_"+randomUUID())=>{
    const response=await fetch(o.base+path,{method,headers:{cookie:jar.header(),origin:path.includes("/admin/")?o.adminOrigin:o.userOrigin,...(body===undefined?{}:{"content-type":"application/json","idempotency-key":key})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    jar.update?.(response);return {status:response.status,body:await response.json(),cache:response.headers.get("cache-control")};
  };
  const ok=async(path:string,body?:unknown,jar=o.stranger,method?:string)=>{const result=await call(path,body,jar,method);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
  const options={key:personalFixture.key,gate:async()=>o.gates.get(o.accountId)!,fundingReader:async()=>personalFixture.funding};
  const context={userId:renter.id,sessionId:renter.session_id};
  const original=(await o.pool.query(`SELECT payload,content_hash FROM zzsh_supply.listing_version WHERE id=$1`,[input.versionId])).rows[0];
  await o.testContext.test("PC2A membership authority, permission, CAS, audit, replay and registration",async()=>{
    await assert.rejects(()=>o.pool.query(`DELETE FROM zzsh_iam.user_rental_membership WHERE user_id=$1`,[renter.id]),{code:"42501"});
    await assert.rejects(()=>o.pool.query(`UPDATE zzsh_iam.user_rental_membership SET updated_at=clock_timestamp() WHERE user_id=$1`,[renter.id]),{code:"42501"});
    // Explicit legacy-missing-record fixture, never a production backfill.
    await o.maintenance.query(`DELETE FROM zzsh_iam.user_rental_membership WHERE user_id=$1`,[renter.id]);
    assert.deepEqual((await ok("/api/v1/users/me/rental-membership")).membership,{tier:"UNKNOWN",version:"0"});
    assert.equal((await call(membershipPath,undefined,o.operator)).status,403);
    const body={tier:"STANDARD",expectedVersion:"0",reason:"isolated authority fixture",sourceRef:"fixture:approved-grant"};
    assert.equal((await call(membershipPath,body,o.operator,"PUT")).status,403);
    for(const invalidBody of [{...body,tier:null},{...body,sourceRef:""},{...body,reason:""},{...body,V:"9"}])assert.equal((await call(membershipPath,invalidBody,o.boss,"PUT")).status,400);
    const key="pc2a_membership_"+randomUUID();
    const first=await call(membershipPath,body,o.boss,"PUT",key);assert.equal(first.status,200);
    assert.deepEqual((await call(membershipPath,body,o.boss,"PUT",key)).body,first.body);
    assert.equal((await call(membershipPath,{...body,tier:"VIP"},o.boss,"PUT",key)).status,409);
    assert.equal((await call(membershipPath,body,o.boss,"PUT")).status,409);
    const before=(await o.pool.query(`SELECT * FROM zzsh_iam.user_rental_membership WHERE user_id=$1`,[renter.id])).rows;
    await o.migration.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeUser}"`);
    try{assert.equal((await call(membershipPath,{...body,expectedVersion:"1",tier:"VIP"},o.boss,"PUT")).status,500);}finally{await o.migration.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeUser}"`);}
    assert.deepEqual((await o.pool.query(`SELECT * FROM zzsh_iam.user_rental_membership WHERE user_id=$1`,[renter.id])).rows,before);
    await assert.rejects(()=>o.pool.query(`UPDATE zzsh_iam.user_rental_membership SET version=version WHERE user_id=$1`,[renter.id]),{code:"40001"});
    assert.equal((await call("/api/v1/users/me/rental-membership",{tier:"SVIP"},o.stranger,"PUT")).status,404);
    const audits=(await o.pool.query(`SELECT details FROM zzsh_iam.audit_event WHERE action='user.rental_membership.updated' AND object_id=$1`,[renter.id])).rows;
    assert.equal(audits.length,1);assert.equal(audits[0].details.before.tier,"UNKNOWN");assert.equal(audits[0].details.after.tier,"STANDARD");
    const newJar=()=>{const cookies=new Map<string,string>();return {header:()=>[...cookies].map(([k,v])=>k+"="+v).join("; "),update:(r:Response)=>{for(const entry of r.headers.getSetCookie()){const pair=entry.split(";")[0]!;const index=pair.indexOf("=");cookies.set(pair.slice(0,index),pair.slice(index+1));}}};};
    const user=newJar();const suffix=randomUUID().replaceAll("-","").slice(0,20);
    await ok("/api/auth/user/sign-up/email",{email:`${suffix}@example.invalid`,password:"Isolated#Registration123",name:"PC2A registration",username:"pc2a_"+suffix,tier:"VIP"},user);
    assert.deepEqual((await ok("/api/v1/users/me/rental-membership",undefined,user)).membership,{tier:"STANDARD",version:"1"});
    await o.maintenance.query(`UPDATE zzsh_iam.user_rental_membership SET version=version+1,source_ref='unverified:legacy',updated_by_admin_id=NULL WHERE user_id=(SELECT id FROM zzsh_auth_user."user" WHERE email=$1)`,[`${suffix}@example.invalid`]);
    assert.equal((await ok("/api/v1/users/me/rental-membership",undefined,user)).membership.tier,"UNKNOWN","unverified source cannot provide eligibility");
    await o.migration.query(`REVOKE INSERT ON zzsh_iam.user_rental_membership FROM "${o.runtimeUser}"`);
    try {
      const failed=await call("/api/auth/user/sign-up/email",{email:`fail-${suffix}@example.invalid`,password:"Isolated#Registration123",name:"Failed fixture",username:"fail_"+suffix},newJar());
      assert.ok(failed.status>=400);
      assert.equal((await o.pool.query(`SELECT count(*)::int AS n FROM zzsh_auth_user."user" WHERE email=$1`,[`fail-${suffix}@example.invalid`])).rows[0].n,0,"membership initialization failure rolls back user creation");
    } finally {await o.migration.query(`GRANT INSERT ON zzsh_iam.user_rental_membership TO "${o.runtimeUser}"`);}
    const phone="+86139"+String(Math.floor(Math.random()*1e8)).padStart(8,"0");const phoneJar=newJar();
    await ok("/api/auth/user/phone-registration/send-otp",{phoneNumber:phone},phoneJar);
    const code=personalFixture.sms.get("phone-registration:"+phone)?.code;assert.ok(code);
    await ok("/api/auth/user/phone-registration/complete",{phoneNumber:phone,code,password:"Isolated#Registration123",acceptedTerms:true},phoneJar);
    assert.deepEqual((await ok("/api/v1/users/me/rental-membership",undefined,phoneJar)).membership,{tier:"STANDARD",version:"1"});
    console.log("PC2A username/phone registration atomic STANDARD; legacy missing UNKNOWN; authorized audited CAS PASS");
  });
  await ok("/api/auth/user/identity/verify",{fullName:"合成测试用户",documentNumber:"110101199001010000"});
  const grant=async(tier:string)=>{const current=(await ok(membershipPath,undefined,o.boss)).membership;return ok(membershipPath,{tier,expectedVersion:current.version,sourceRef:"fixture:grant",reason:"isolated confirmation"},o.boss,"PUT");};
  await o.testContext.test("PC2A formal UNKNOWN funding fails closed; synthetic four-tier confirmation never reserves or leaks",async()=>{
    const anonymous=await call("/api/bff/user/order-confirmations",input,{header:()=>""});assert.equal(anonymous.status,401);
    assert.equal((await call("/api/bff/user/order-confirmations",input,o.user)).status,403);
    for(const tier of ["STANDARD","VIP","SVIP","DISCOUNT_USER"]) {
      await grant(tier);personalFixture.funding=null;
      const failed=await call("/api/bff/user/order-confirmations",input);assert.equal(failed.status,503);assert.equal(failed.body.error.code,"CONFIRMATION_DEPENDENCY_UNAVAILABLE");assert.equal(failed.body.confirmationToken,undefined);
    }
    personalFixture.funding={version:"fixture:v1",sourceRef:"fixture:isolated-authority",baseDepositCents:"30000",publisherBailRequirementCents:"5000",fullPayoutSelected:false,fullPayoutPolicyRef:"fixture:none",fullPayoutFeeCents:"0",vipWaiver:true,svipWaiver:true};
    assert.equal((await call("/api/bff/user/order-confirmations",input)).status,503,"positive guarantee cannot use NOT_REQUIRED");
    o.gates.set(o.accountId,{publisherBail:"SATISFIED",occupancy:"FREE",reference:"fixture:account-guarantee"});
    const previousApiOrigin=process.env.ZZSH_API_ORIGIN,previousWebOrigin=process.env.ZZSH_WEB_ORIGIN;
    process.env.ZZSH_API_ORIGIN=o.base;process.env.ZZSH_WEB_ORIGIN=o.userOrigin;
    let webPost:(request:Request)=>Promise<Response>;
    try { webPost=require("../../../web/src/app/api/order-confirmations/route.ts").POST; }
    finally {
      if(previousApiOrigin===undefined)delete process.env.ZZSH_API_ORIGIN;else process.env.ZZSH_API_ORIGIN=previousApiOrigin;
      if(previousWebOrigin===undefined)delete process.env.ZZSH_WEB_ORIGIN;else process.env.ZZSH_WEB_ORIGIN=previousWebOrigin;
    }
    const throughWeb=async(cookie:string)=>webPost(new Request(o.userOrigin+"/api/order-confirmations",{method:"POST",headers:{origin:o.userOrigin,"content-type":"application/json",cookie},body:JSON.stringify(input)}));
    const webSuccess=await throughWeb(o.stranger.header());assert.equal(webSuccess.status,200);assert.equal(webSuccess.headers.get("cache-control"),"no-store");assert.ok((await webSuccess.json()).confirmationToken);
    assert.equal((await throughWeb("")).status,401);assert.equal((await throughWeb(o.user.header())).status,403);
    const savedFunding=personalFixture.funding;personalFixture.funding=null;
    const webUnknown=await throughWeb(o.stranger.header());assert.equal(webUnknown.status,503);assert.equal((await webUnknown.json()).confirmationToken,undefined);personalFixture.funding=savedFunding;
    const orderCount=(await o.pool.query(`SELECT count(*)::text AS n FROM zzsh_order.rental_order`)).rows[0].n;
    for(const [tier,rental,deposit] of [["STANDARD","280.27","300.00"],["VIP","264.41","0.00"],["SVIP","257.00","0.00"],["DISCOUNT_USER","264.41","300.00"]]) {
      await grant(tier!);
      const result=await call("/api/bff/user/order-confirmations",input);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.cache,"no-store");
      assert.equal(result.body.quote.resourceTotal.amount,rental);assert.equal(result.body.quote.tenantDeposit.amount,deposit);
      const decoded=JSON.parse(Buffer.from(result.body.confirmationToken.split(".")[0],"base64url").toString());
      for(const field of ["ownerAmount","ownerUnitAmount","platformFullProfit","sourceRef","publisherBailRequirementCents","inventory"]){assert.equal(JSON.stringify(result.body).includes('"'+field+'"'),false);assert.equal(field in decoded,false);}
      await withTransaction(o.pool,client=>verifyPersonalConfirmation(client,context,input,result.body.confirmationToken,options));
      await grant(tier!); // same tier/price, new authority version must still invalidate.
      await assert.rejects(()=>withTransaction(o.pool,client=>verifyPersonalConfirmation(client,context,input,result.body.confirmationToken,options)),(e:any)=>e.code==="CONFIRMATION_CHANGED");
    }
    assert.equal((await o.pool.query(`SELECT count(*)::text AS n FROM zzsh_order.rental_order`)).rows[0].n,orderCount);
    assert.deepEqual((await o.pool.query(`SELECT payload,content_hash FROM zzsh_supply.listing_version WHERE id=$1`,[input.versionId])).rows[0],original);
    for(const extra of [{tier:"STANDARD"},{tenantDeposit:"0"},{userId:renter.id}])assert.equal((await call("/api/bff/user/order-confirmations",{...input,...extra})).status,400);
    await grant("UNKNOWN");assert.equal((await call("/api/bff/user/order-confirmations",input)).body.error.code,"MEMBERSHIP_UNKNOWN");await grant("STANDARD");
    const savedGate=o.gates.get(o.accountId)!;o.gates.set(o.accountId,{...savedGate,publisherBail:"UNKNOWN"});
    assert.equal((await call("/api/bff/user/order-confirmations",input)).status,503);o.gates.set(o.accountId,savedGate);
    o.gates.set(o.accountId,{...savedGate,reference:null});assert.equal((await call("/api/bff/user/order-confirmations",input)).status,503);o.gates.set(o.accountId,savedGate);
    const completeFunding=personalFixture.funding!;
    personalFixture.funding={...completeFunding,baseDepositCents:null as unknown as string};assert.equal((await call("/api/bff/user/order-confirmations",input)).status,503);personalFixture.funding=completeFunding;
    const full=personalFixture.funding;personalFixture.funding={...full!,fullPayoutSelected:true};assert.equal((await call("/api/bff/user/order-confirmations",input)).status,503);personalFixture.funding=full;
  });
  await o.testContext.test("PC2A ordinary and fast personal prices follow newly approved frozen declarations",async()=>{
    const path=`/api/v1/supply/accounts/${o.accountId}`;
    const token=(d:any)=>({expectedRevision:d.account.revision,versionId:d.version.id,releaseId:d.version.releaseId,contentHash:d.version.contentHash});
    for(const [rentalPricing,expected] of [
      [{rentalMode:"ordinary"},["266.41","251.90","245.10","251.90"]],
      [{rentalMode:"fast",ownerRatioB:"53"},["253.90","240.56","229.22","240.56"]],
    ] as const) {
      let d=await ok(path,undefined,o.user);
      d=await ok(path+"/drafts",{expectedRevision:d.account.revision},o.user);
      const declaration=d.version.declaration;
      d=await ok(path+"/draft",{...declaration,attributes:{...declaration.attributes,rentalPricing},mediaBindings:declaration.mediaBindings.map((m:any)=>({assetId:m.assetId,position:m.position})),expectedRevision:d.account.revision},o.user,"PUT");
      d=await ok(path+"/quote",{expectedRevision:d.account.revision},o.user);
      d=await ok(path+"/accept-rules",token(d),o.user);
      d=await ok(path+"/submit",token(d),o.user);
      d=await ok(`/api/bff/admin/supply/listing-reviews/${o.accountId}/decide`,{...token(d),decision:"APPROVE",reason:"isolated PC2A mode fixture"},o.boss);
      input.versionId=d.version.id;input.releaseId=d.version.releaseId;
      for(const [index,tier] of ["STANDARD","VIP","SVIP","DISCOUNT_USER"].entries()) {
        await grant(tier);const result=await ok("/api/bff/user/order-confirmations",input);
        assert.equal(result.quote.resourceTotal.amount,expected[index]);assert.equal(result.quote.rentalMode,rentalPricing.rentalMode);
      }
    }
  });
  await o.testContext.test("PC2A membership write waits for confirmation user lock; full old/new versions only",async()=>{
    const lock=await o.pool.connect();let pending:Promise<any>|undefined;
    try {
      await lock.query("BEGIN");
      const holderPid=(await lock.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const old=await rebuildPersonalConfirmation(lock,context,input,options);
      const oldVersion=old.snapshot.membership.version;
      pending=call(membershipPath,{tier:"VIP",expectedVersion:oldVersion,sourceRef:"fixture:barrier",reason:"concurrent fixture"},o.boss,"PUT");
      let blocked=false;const deadline=Date.now()+5000;
      while(Date.now()<deadline && !blocked)blocked=(await o.maintenance.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`,[holderPid])).rows[0].blocked;
      assert.equal(blocked,true,"deterministic DB lock barrier reached");
      assert.equal((await lock.query(`SELECT version::text FROM zzsh_iam.user_rental_membership WHERE user_id=$1`,[renter.id])).rows[0].version,oldVersion);
      await lock.query("COMMIT");assert.equal((await pending).status,200);
      const next=await withTransaction(o.pool,client=>rebuildPersonalConfirmation(client,context,input,options));
      assert.equal(next.snapshot.membership.tier,"VIP");assert.equal(BigInt(next.snapshot.membership.version),BigInt(oldVersion)+1n);
    } finally {await lock.query("ROLLBACK");lock.release();if(pending)await pending;}
    const small=new Pool({...o.pool.options,password:o.pool.options.password,max:2});
    try {await Promise.all(Array.from({length:4},()=>withTransaction(small,client=>rebuildPersonalConfirmation(client,context,input,options))));assert.ok(small.totalCount<=2);}finally{await small.end();}
  });
  try {await runPersonalOrderChecks(o,input,personalFixture);}finally{personalFixture.funding=null;}
}
