import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { createApp } from "../src/app";
import { signConfirmation } from "../src/order/confirmation-token";
import { rebuildPersonalConfirmation, type confirmationInput } from "../src/order/personal-confirmation";
import { withTransaction } from "../src/auth/security-core";
import type { Options } from "./supply-publishing-checks";
import type { personalFixture } from "./personal-confirmation-checks";
import { createPersonalReservation } from "../src/order/personal-order";
import { sweepExpiredHolds } from "../src/order/order";
import { changeRentalMembership } from "../src/auth/rental-membership";
import { activateRelease } from "../src/supply/rules";

export async function runPersonalOrderChecks(o:Options,input:ReturnType<typeof confirmationInput>,fixture:typeof personalFixture) {
  const actor=(await o.pool.query(`SELECT u.id,s.id AS session_id FROM zzsh_auth_user."user" u JOIN zzsh_auth_user."session" s ON s."userId"=u.id WHERE u.email='m3b-user-2@example.invalid' LIMIT 1`)).rows[0];
  const context={userId:actor.id,sessionId:actor.session_id};
  const options={key:fixture.key,gate:async()=>o.gates.get(o.accountId)!,fundingReader:async()=>fixture.funding};
  const call=async(path:string,body?:unknown,jar=o.stranger,method=body===undefined?"GET":"POST",key="pc2b_"+randomUUID(),base=o.base)=>{
    const r=await fetch(base+path,{method,headers:{cookie:jar.header(),origin:path.includes("/admin/")?o.adminOrigin:o.userOrigin,...(body===undefined?{}:{"content-type":"application/json","idempotency-key":key})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    jar.update?.(r);return {status:r.status,body:await r.json()};
  };
  const ok=async(path:string,body?:unknown,jar=o.stranger,method?:string)=>{const r=await call(path,body,jar,method);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const grant=async(tier:string)=>{const path=`/api/bff/admin/users/${actor.id}/rental-membership`;const current=(await ok(path,undefined,o.boss)).membership;await ok(path,{tier,expectedVersion:current.version,sourceRef:"fixture:pc2b",reason:"isolated consumption"},o.boss,"PUT");};
  const confirm=async()=> (await ok("/api/bff/user/order-confirmations",input)).confirmationToken as string;
  const create=(token:string,key="pc2b_"+randomUUID(),jar=o.stranger)=>call("/api/bff/user/orders-v2",{confirmationToken:token},jar,"POST",key);
  const cancel=(id:string)=>ok(`/api/v1/orders/${id}/cancel`,{reason:"isolated test cleanup"});
  const counts=async()=> (await o.pool.query(`SELECT (SELECT count(*)::int FROM zzsh_order.rental_order) AS orders,(SELECT count(*)::int FROM zzsh_supply.idempotency_record WHERE scope_key LIKE '%order.reservation.create.v2%') AS receipts,(SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action='order.reservation.created') AS audits`)).rows[0];
  const freshProof=async(remaining:number)=>withTransaction(o.pool,async client=>{const rebuilt=await rebuildPersonalConfirmation(client,context,input,options);return signConfirmation(rebuilt.binding,rebuilt.now-300+remaining,fixture.key);});
  const original=(await o.pool.query(`SELECT payload,content_hash FROM zzsh_supply.listing_version WHERE id=$1`,[input.versionId])).rows[0];
  let firstId="";
  await o.testContext.test("PC2B real Cookie/Web BFF four-tier order creation, immutable personal snapshot and safe projections",async()=>{
    const web=require("../../../web/src/app/api/v2/orders/route.ts");
    for(const [tier,rental,deposit] of [["STANDARD","253.90","300.00"],["VIP","240.56","0.00"],["SVIP","229.22","0.00"],["DISCOUNT_USER","240.56","300.00"]]) {
      await grant(tier!);const token=await confirm();
      const r=await web.POST(new Request(o.userOrigin+"/api/v2/orders",{method:"POST",headers:{origin:o.userOrigin,"content-type":"application/json",cookie:o.stranger.header(),"idempotency-key":"pc2b_web_"+randomUUID()},body:JSON.stringify({confirmationToken:token})}));
      assert.equal(r.status,200);assert.equal(r.headers.get("cache-control"),"no-store");const {order}=await r.json();firstId ||= order.id;
      assert.equal(order.amounts.rental.amount,rental);assert.equal(order.amounts.deposit.amount,deposit);
      const row=(await o.pool.query(`SELECT * FROM zzsh_order.rental_order WHERE id=$1`,[order.id])).rows[0];
      assert.equal(row.quote_snapshot.quoteKind,"ORDER_CONFIRMATION");assert.equal(row.confirmation_id,row.quote_snapshot.confirmationId);assert.equal(row.content_hash,original.content_hash);assert.notEqual(row.content_hash,row.quote_snapshot.confirmationDigest);
      assert.equal(row.quote_snapshot.personal.membership.tier,tier);
      assert.equal(JSON.stringify(row.quote_snapshot).includes(token),false);
      for(const jar of [o.stranger,o.user]) {
        const view=await ok(`/api/v1/orders/${order.id}`,undefined,jar);
        for(const field of ["sourceRef","publisherBailRequirement","platformFullProfit","confirmationToken","signature","personal"])assert.equal(JSON.stringify(view).includes('"'+field+'"'),false,field);
      }
      await cancel(order.id);assert.equal((await create(token)).body.error.code,"CONFIRMATION_USED");
      await assert.rejects(()=>o.pool.query(`UPDATE zzsh_order.rental_order SET confirmation_id=NULL WHERE id=$1`,[order.id]),{code:"40001"});
      await assert.rejects(()=>o.pool.query(`UPDATE zzsh_order.rental_order SET quote_snapshot=jsonb_set(quote_snapshot,'{confirmationDigest}','"changed"') WHERE id=$1`,[order.id]),{code:"40001"});
    }
    assert.deepEqual((await o.pool.query(`SELECT payload,content_hash FROM zzsh_supply.listing_version WHERE id=$1`,[input.versionId])).rows[0],original);
  });
  await o.testContext.test("PC2B same key/body and same confirmation races, namespace and cross-subject isolation",async()=>{
    const token=await confirm(),key="pc2b_same_"+randomUUID();
    const same=await Promise.all([create(token,key),create(token,key)]);assert.deepEqual(same[0],same[1]);assert.equal(same[0]!.status,200);
    assert.equal((await create(token+"x",key)).body.error.code,"IDEMPOTENCY_KEY_REUSED");
    assert.equal((await create(token,key,o.user)).status,400);
    assert.equal((await call("/api/v2/orders",{confirmationToken:token},{header:()=>""})).status,401);
    await cancel(same[0]!.body.order.id);
    assert.equal((await call("/api/v1/orders",input,o.stranger,"POST",key)).body.error.code,"PRICING_SCHEMA_UNSUPPORTED","v1 does not replay the v2 receipt under the same key");
    const second=await confirm();const race=await Promise.all([create(second),create(second)]);
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal(race.find(r=>r.status===409)!.body.error.code,"CONFIRMATION_USED");
    await cancel(race.find(r=>r.status===200)!.body.order.id);
    const before=await counts();for(const body of [{confirmationToken:null},{confirmationToken:"x".repeat(4097)},{confirmationToken:token,tier:"STANDARD"},{confirmationToken:token,amount:"0"}])assert.equal((await call("/api/v2/orders",body)).status,400);
    assert.deepEqual(await counts(),before);
  });
  await o.testContext.test("PC2B failed audit/order/idempotency insert rolls back consumption and occupancy",async()=>{
    for(const table of ["zzsh_iam.audit_event","zzsh_order.rental_order","zzsh_supply.idempotency_record"]) {
      const token=await confirm(),key="pc2b_rollback_"+randomUUID(),before=await counts();
      await o.migration.query(`REVOKE INSERT ON ${table} FROM "${o.runtimeUser}"`);
      try{assert.equal((await create(token,key)).status,500);}finally{await o.migration.query(`GRANT INSERT ON ${table} TO "${o.runtimeUser}"`);}
      assert.deepEqual(await counts(),before);
      const success=await create(token,key);assert.equal(success.status,200);await cancel(success.body.order.id);
    }
  });
  await o.testContext.test("PC2B two authenticated renters compete for one account without spending the losing confirmation",async()=>{
    const cookies=new Map<string,string>();const other={header:()=>[...cookies].map(([k,v])=>k+"="+v).join("; "),update:(r:Response)=>{for(const entry of r.headers.getSetCookie()){const pair=entry.split(";")[0]!,i=pair.indexOf("=");cookies.set(pair.slice(0,i),pair.slice(i+1));}}};
    const name="pc2b_"+randomUUID().replaceAll("-","").slice(0,18);
    await ok("/api/auth/user/sign-up/email",{email:name+"@example.invalid",password:"Isolated#Buyer123",name:"Second synthetic renter",username:name},other);
    await ok("/api/auth/user/identity/verify",{fullName:"合成买家",documentNumber:"110101199001010000"},other);
    const proofs=[await confirm(),(await ok("/api/bff/user/order-confirmations",input,other)).confirmationToken];const jars=[o.stranger,other];
    const raced=await Promise.all(proofs.map((t,i)=>create(t,"pc2b_renter_"+randomUUID(),jars[i])));
    assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);const winner=raced.findIndex(r=>r.status===200),loser=1-winner;
    assert.equal(raced[loser]!.body.error.code,"OCCUPIED");
    await ok(`/api/v1/orders/${raced[winner]!.body.order.id}/cancel`,{reason:"fixture"},jars[winner]);
    const recovered=await create(proofs[loser]!,"pc2b_loser_"+randomUUID(),jars[loser]);assert.equal(recovered.status,200);
    await ok(`/api/v1/orders/${recovered.body.order.id}/cancel`,{reason:"fixture"},jars[loser]);
  });
  await o.testContext.test("PC2B reciprocal v2 rentals use ordered user locks with a real two-connection API pool",async()=>{
    const created=await ok("/api/v1/supply/accounts",{gameId:o.gameId});const accountId=created.accountId,path=`/api/v1/supply/accounts/${accountId}`;
    o.gates.set(accountId,{publisherBail:"SATISFIED",occupancy:"FREE",reference:"fixture:reciprocal-guarantee"});
    let d=await ok(path);d=await ok(path+"/drafts",{expectedRevision:d.account.revision});
    const intent=await ok("/api/v1/supply/media/upload-intents",{gameId:o.gameId,accountId,mime:"image/png",size:o.bytes.length,purpose:"ACCOUNT_DISPLAY"});
    const upload=await fetch(o.base+"/api/v1/supply/media/uploads/"+intent.intentId,{method:"PUT",headers:{origin:o.userOrigin,cookie:o.stranger.header(),"content-type":"image/png","x-upload-token":intent.uploadToken,"idempotency-key":"pc2b_upload_"+randomUUID()},body:new Uint8Array(o.bytes)});assert.equal(upload.status,200);const asset=await upload.json();
    await ok(`/api/bff/admin/supply/media/${asset.assetId}/review`,{decision:"APPROVE",visibility:"PUBLIC_DISPLAY"},o.boss);
    const declaration=original.payload.declaration;
    d=await ok(path+"/draft",{...declaration,title:"PC2B reciprocal fixture",mediaBindings:[{assetId:asset.assetId,position:0}],expectedRevision:d.account.revision},o.stranger,"PUT");
    d=await ok(path+"/quote",{expectedRevision:d.account.revision});
    const refs=(v:any)=>({expectedRevision:v.account.revision,versionId:v.version.id,releaseId:v.version.releaseId,contentHash:v.version.contentHash});
    d=await ok(path+"/accept-rules",refs(d));d=await ok(path+"/submit",refs(d));d=await ok(`/api/bff/admin/supply/listing-reviews/${accountId}/decide`,{...refs(d),decision:"APPROVE",reason:"isolated reciprocal fixture"},o.boss);
    const a=await confirm(),b=(await ok("/api/bff/user/order-confirmations",{accountId,versionId:d.version.id,releaseId:d.version.releaseId},o.user)).confirmationToken;
    const pool=new Pool({...o.pool.options,password:o.pool.options.password,max:2});let app:Awaited<ReturnType<typeof createApp>>|undefined;
    try {
      app=await createApp({health:{dependencies:{postgres:{check:async()=>{},close:async()=>{}},redis:{check:async()=>{},close:async()=>{}}}},database:{pool},auth:{...fixture.runtimeAuth!,pool}});await app.listen(0,"127.0.0.1");const base=await app.getUrl();
      const outcomes=await Promise.all([call("/api/bff/user/orders-v2",{confirmationToken:a},o.stranger,"POST","pc2b_mutual_a_"+randomUUID(),base),call("/api/bff/user/orders-v2",{confirmationToken:b},o.user,"POST","pc2b_mutual_b_"+randomUUID(),base)]);
      assert.deepEqual(outcomes.map(r=>r.status),[200,200]);assert.ok(pool.totalCount<=2);
      await cancel(outcomes[0]!.body.order.id);await ok(`/api/v1/orders/${outcomes[1]!.body.order.id}/cancel`,{reason:"fixture"},o.user);
    } finally {if(app)await app.close();else await pool.end();}
  });
  await o.testContext.test("PC2B membership, freeze, cancellation, pause and version invalidation commit before waiting creation",async()=>{
    const adminSession=(await o.pool.query(`SELECT id FROM zzsh_auth_admin."session" WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,[o.bossId])).rows[0].id;
    const sessionExpiry=(await o.pool.query(`SELECT "expiresAt" FROM zzsh_auth_user."session" WHERE id=$1`,[context.sessionId])).rows[0].expiresAt;
    for(const scenario of ["membership","frozen","cancelled","session","paused","version"] as const) {
      const proof=await confirm(),before=await counts(),holder=await o.maintenance.connect();let pending:ReturnType<typeof create>|undefined;
      try {
        await holder.query("BEGIN");
        if(scenario==="paused"||scenario==="version")await holder.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,[o.accountId]);
        else await holder.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[actor.id]);
        const pid=(await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;pending=create(proof);
        let blocked=false;const deadline=Date.now()+5000;while(!blocked&&Date.now()<deadline)blocked=(await o.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`,[pid])).rows[0].blocked;assert.equal(blocked,true,scenario);
        if(scenario==="membership") {const m=(await holder.query(`SELECT tier,version::text FROM zzsh_iam.user_rental_membership WHERE user_id=$1`,[actor.id])).rows[0];await changeRentalMembership(holder,actor.id,{tier:m.tier,expectedVersion:m.version,sourceRef:"fixture:barrier",reason:"same-price version change"},{userId:o.bossId,sessionId:adminSession},"pc2b-member-barrier");}
        if(scenario==="frozen")await holder.query(`UPDATE zzsh_auth_user."user" SET suspended=true WHERE id=$1`,[actor.id]);
        if(scenario==="cancelled")await holder.query(`UPDATE zzsh_iam.user_identity_state SET account_status='CANCELLED' WHERE user_id=$1`,[actor.id]);
        if(scenario==="session")await holder.query(`UPDATE zzsh_auth_user."session" SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=$1`,[context.sessionId]);
        if(scenario==="paused")await holder.query(`UPDATE zzsh_supply.rental_account SET owner_paused=true WHERE id=$1`,[o.accountId]);
        if(scenario==="version")await holder.query(`UPDATE zzsh_supply.rental_account SET current_version_id=NULL WHERE id=$1`,[o.accountId]);
        await holder.query("COMMIT");const result=await pending;
        assert.equal(result.status,scenario==="membership"?409:scenario==="frozen"||scenario==="cancelled"||scenario==="session"?401:scenario==="version"?404:503,scenario);
        assert.deepEqual(await counts(),before);
      } finally {
        await holder.query("ROLLBACK");holder.release();if(pending)await pending;
        if(scenario==="frozen")await o.maintenance.query(`UPDATE zzsh_auth_user."user" SET suspended=false WHERE id=$1`,[actor.id]);
        if(scenario==="cancelled")await o.maintenance.query(`UPDATE zzsh_iam.user_identity_state SET account_status='ACTIVE' WHERE user_id=$1`,[actor.id]);
        if(scenario==="session")await o.maintenance.query(`UPDATE zzsh_auth_user."session" SET "expiresAt"=$2 WHERE id=$1`,[context.sessionId,sessionExpiry]);
        if(scenario==="paused")await o.maintenance.query(`UPDATE zzsh_supply.rental_account SET owner_paused=false WHERE id=$1`,[o.accountId]);
        if(scenario==="version")await o.maintenance.query(`UPDATE zzsh_supply.rental_account SET current_version_id=$2 WHERE id=$1`,[o.accountId,input.versionId]);
      }
    }
  });
  await o.testContext.test("PC2B same-price qualification change, unknown funding, changed amount, tampering and expiry fail without records",async()=>{
    const token=await confirm(),before=await counts();await grant("DISCOUNT_USER");assert.equal((await create(token)).body.error.code,"CONFIRMATION_CHANGED");
    const fresh=await confirm(),funding=fixture.funding;fixture.funding=null;
    assert.equal((await create(fresh)).status,503);fixture.funding=funding;
    fixture.funding={...funding!,baseDepositCents:"30001"};assert.equal((await create(fresh)).body.error.code,"CONFIRMATION_CHANGED");fixture.funding=funding;
    assert.equal((await create(fresh.replace(/^./,"x"))).status,400);
    const expired=await freshProof(0);assert.equal((await create(expired.token)).body.error.code,"CONFIRMATION_EXPIRED");
    assert.deepEqual(await counts(),before);
  });
  await o.testContext.test("PC2B success replay ignores expired token, changed qualification, removed signing/hold/funding config",async()=>{
    const proof=await freshProof(3),key="pc2b_replay_"+randomUUID();const initial=await create(proof.token,key);assert.equal(initial.status,200);await cancel(initial.body.order.id);
    await grant("STANDARD");await o.maintenance.query(`SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp())))`,[proof.claims.expiresAt]);
    const pool=new Pool({...o.pool.options,password:o.pool.options.password,max:2});let app:Awaited<ReturnType<typeof createApp>>|undefined;
    const {confirmationKey:_key,testConfirmationFundingReader:_funding,orderHoldSeconds:_hold,...auth}=fixture.runtimeAuth!;
    const oldHold=process.env.ORDER_HOLD_SECONDS;delete process.env.ORDER_HOLD_SECONDS;
    try {
      app=await createApp({health:{dependencies:{postgres:{check:async()=>{},close:async()=>{}},redis:{check:async()=>{},close:async()=>{}}}},database:{pool},auth:{...auth,pool}});await app.listen(0,"127.0.0.1");
      const replay=await call("/api/bff/user/orders-v2",{confirmationToken:proof.token},o.stranger,"POST",key,await app.getUrl());assert.deepEqual(replay,initial);
      assert.equal((await call("/api/bff/user/orders-v2",{confirmationToken:proof.token},o.stranger,"POST","pc2b_new_"+randomUUID(),await app.getUrl())).status,503);
    } finally {if(oldHold!==undefined)process.env.ORDER_HOLD_SECONDS=oldHold;if(app)await app.close();else await pool.end();}
  });
  await o.testContext.test("PC2B deterministic user-lock wait expiring the confirmation refuses insertion",async()=>{
    const proof=await freshProof(3),before=await counts();const holder=await o.maintenance.connect();let pending:ReturnType<typeof create>|undefined;
    try {
      await holder.query("BEGIN");await holder.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[actor.id]);const pid=(await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      pending=create(proof.token);let blocked=false;const deadline=Date.now()+5000;
      while(!blocked&&Date.now()<deadline)blocked=(await o.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`,[pid])).rows[0].blocked;
      assert.equal(blocked,true);await holder.query(`SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp())))`,[proof.claims.expiresAt]);await holder.query("COMMIT");assert.equal((await pending).body.error.code,"CONFIRMATION_EXPIRED");
      assert.deepEqual(await counts(),before);
    } finally {await holder.query("ROLLBACK");holder.release();if(pending)await pending;}
  });
  await o.testContext.test("PC2B database insert wait rechecks expiry and leaves consumption unused",async()=>{
    const proof=await freshProof(3),before=await counts(),barrier="783125421";
    const holder=await o.maintenance.connect();let pending:ReturnType<typeof create>|undefined;
    await o.migration.query(`CREATE FUNCTION zzsh_order.pc2b_insert_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${barrier}); RETURN NEW; END $$; CREATE TRIGGER aaa_pc2b_insert_pause BEFORE INSERT ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.pc2b_insert_pause()`);
    try {
      await holder.query(`SELECT pg_advisory_lock($1::bigint)`,[barrier]);const pid=(await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;pending=create(proof.token);
      let blocked=false;const deadline=Date.now()+5000;while(!blocked&&Date.now()<deadline)blocked=(await o.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`,[pid])).rows[0].blocked;
      assert.equal(blocked,true);await holder.query(`SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp())))`,[proof.claims.expiresAt]);await holder.query(`SELECT pg_advisory_unlock($1::bigint)`,[barrier]);
      assert.equal((await pending).body.error.code,"CONFIRMATION_EXPIRED");assert.deepEqual(await counts(),before);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock($1::bigint)`,[barrier]);holder.release();if(pending)await pending;
      await o.migration.query(`DROP TRIGGER aaa_pc2b_insert_pause ON zzsh_order.rental_order; DROP FUNCTION zzsh_order.pc2b_insert_pause()`);
    }
  });
  await o.testContext.test("PC2B database uniqueness, snapshot/amount and retained PAID constraints",async()=>{
    const copy=`INSERT INTO zzsh_order.rental_order(id,display_no,account_id,listing_version_id,owner_user_id,renter_user_id,game_id,rule_release_id,content_hash,term_option_code,status,rental_amount_cents,deposit_amount_cents,currency,term_seconds,quote_snapshot,title,hold_until,confirmation_id) SELECT $2,zzsh_order.next_display_no(),account_id,listing_version_id,owner_user_id,renter_user_id,game_id,rule_release_id,content_hash,term_option_code,'PENDING_PAYMENT',rental_amount_cents+$3::numeric,deposit_amount_cents,currency,term_seconds,quote_snapshot,title,clock_timestamp()+interval '5 minutes',confirmation_id FROM zzsh_order.rental_order WHERE id=$1`;
    await assert.rejects(()=>o.pool.query(copy,[firstId,"pc2b_duplicate_"+randomUUID(),0]),{code:"23505",constraint:"rental_order_confirmation_unique"});
    await assert.rejects(()=>o.pool.query(copy,[firstId,"pc2b_bad_amount_"+randomUUID(),1]),{code:"40001"});
    const token=await confirm(),created=await create(token);assert.equal(created.status,200);const id=created.body.order.id;
    const client=await o.pool.connect();
    try {
      await client.query("BEGIN");
      const payment="pc2b_payment_"+randomUUID();
      await client.query(`INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,provider_paid_at,disposition,request_id) SELECT $2,'CONTROLLED','pc2b-fixture',$2,display_no,id,rental_amount_cents+deposit_amount_cents,currency,clock_timestamp(),'APPLIED','pc2b-paid' FROM zzsh_order.rental_order WHERE id=$1`,[id,payment]);
      await client.query(`UPDATE zzsh_order.rental_order SET status='PAID',paid_confirmation_id=$2,paid_at=(SELECT accepted_at FROM zzsh_order.payment_confirmation WHERE id=$2),revision=revision+1 WHERE id=$1`,[id,payment]);
      await client.query(`INSERT INTO zzsh_order.im_order_group(order_id,payment_confirmation_id,app_id) VALUES($1,$2,'pc2b-isolated')`,[id,payment]);await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("SAVEPOINT invalid_paid");await assert.rejects(()=>client.query(`UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='USER',cancelled_at=clock_timestamp() WHERE id=$1`,[id]),{code:"40001"});await client.query("ROLLBACK TO invalid_paid");
    } finally {await client.query("ROLLBACK");client.release();}
    await cancel(id);
  });
  await o.testContext.test("PC2B personal order timeout retains lifetime consumption",async()=>{
    const token=await confirm();const result=await withTransaction(o.pool,c=>createPersonalReservation(c,context,token,{...options,holdSeconds:1},"pc2b-timeout"));
    const id=(result.body as any).order.id;
    await o.maintenance.query(`SELECT pg_sleep(GREATEST(0,extract(epoch FROM hold_until)-extract(epoch FROM clock_timestamp()))) FROM zzsh_order.rental_order WHERE id=$1`,[id]);
    await sweepExpiredHolds(o.pool,{batchLimit:50,lockTimeoutMs:2000});
    const row=(await o.pool.query(`SELECT status,cancel_reason,confirmation_id FROM zzsh_order.rental_order WHERE id=$1`,[id])).rows[0];assert.equal(row.status,"CANCELLED");assert.equal(row.cancel_reason,"TIMEOUT");assert.ok(row.confirmation_id);assert.equal((await create(token)).body.error.code,"CONFIRMATION_USED");
  });
  await o.testContext.test("PC2B rule switch blocks waiting fresh creation while historical receipt still replays",async()=>{
    const unused=await confirm(),usedToken=await confirm(),key="pc2b_rule_replay_"+randomUUID();const receipt=await create(usedToken,key);assert.equal(receipt.status,200);await cancel(receipt.body.order.id);
    const before=await counts(),holder=await o.maintenance.connect();let pending:ReturnType<typeof create>|undefined;
    try {
      await holder.query("BEGIN");const game=(await holder.query(`SELECT current_release_id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`,[o.gameId])).rows[0];
      const release=(await holder.query(`SELECT * FROM zzsh_supply.rule_release WHERE id=$1`,[game.current_release_id])).rows[0];
      const pid=(await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;pending=create(unused);
      let blocked=false;const deadline=Date.now()+5000;while(!blocked&&Date.now()<deadline)blocked=(await o.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`,[pid])).rows[0].blocked;assert.equal(blocked,true);
      await activateRelease(holder,o.bossId,true,o.gameId,release.price_version_id,release.term_version_id,release.agreement_version_id,String(release.generation));
      await holder.query("COMMIT");assert.equal((await pending).body.error.code,"CONFIRMATION_CHANGED");assert.deepEqual(await counts(),before);
      assert.deepEqual(await create(usedToken,key),receipt);
    } finally {await holder.query("ROLLBACK");holder.release();if(pending)await pending;}
  });
  await o.testContext.test("PC2B missing member price in a legitimately sealed release never falls back to STANDARD",async()=>{
    const rules=await ok(`/api/bff/admin/supply/games/${o.gameId}/rules`,undefined,o.boss);
    const current=rules.release,price=rules.priceVersions.find((p:any)=>p.id===current.priceVersionId);
    const created=await ok("/api/bff/admin/supply/price-drafts",{gameId:o.gameId,mode:"SPREAD"},o.boss);
    const lines=rules.priceLines.filter((l:any)=>l.priceVersionId===price.id && l.customerTier==="STANDARD").map((l:any)=>({itemId:l.itemId,customerTier:l.customerTier,pricingKind:l.pricingKind,...(l.pricingKind==="FIXED_UNIT"?{unitQuantity:l.unitQuantity,buyerUnitAmount:l.buyerUnitAmount,ownerUnitAmount:l.ownerUnitAmount}:{})}));
    await ok(`/api/bff/admin/supply/price-drafts/${created.id}`,{expectedRevision:"1",haffRule:price.haffRule,lines},o.boss,"PUT");await ok(`/api/bff/admin/supply/price-drafts/${created.id}/seal`,{expectedRevision:"2"},o.boss);
    await ok("/api/bff/admin/supply/releases",{gameId:o.gameId,priceVersionId:created.id,termVersionId:current.termVersionId,agreementVersionId:current.agreementVersionId,expectedGeneration:current.generation},o.boss);
    const path=`/api/v1/supply/accounts/${o.accountId}`;let d=await ok(path,undefined,o.user);d=await ok(path+"/drafts",{expectedRevision:d.account.revision},o.user);d=await ok(path+"/quote",{expectedRevision:d.account.revision},o.user);
    const refs=(v:any)=>({expectedRevision:v.account.revision,versionId:v.version.id,releaseId:v.version.releaseId,contentHash:v.version.contentHash});
    d=await ok(path+"/accept-rules",refs(d),o.user);d=await ok(path+"/submit",refs(d),o.user);d=await ok(`/api/bff/admin/supply/listing-reviews/${o.accountId}/decide`,{...refs(d),decision:"APPROVE",reason:"isolated missing tier fixture"},o.boss);
    input.versionId=d.version.id;input.releaseId=d.version.releaseId;await grant("STANDARD");const proof=await confirm(),before=await counts();await grant("VIP");
    assert.equal((await create(proof)).body.error.code,"CONFIRMATION_DEPENDENCY_UNAVAILABLE");assert.deepEqual(await counts(),before);
  });
}
