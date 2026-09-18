import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { withTransaction } from "../src/auth/security-core";
import { createApp } from "../src/app";
import { createControlledPaymentSource,confirmOrderPayment } from "../src/order/payment-confirmation";
import { dispatchPaidOrders } from "../src/im/order-dispatch";
import { advanceOrderTeam,prepareOrderTeam,reconcileOrderTeam,scanOrderTeams,OrderTeamLifecycle,type OrderTeamOptions } from "../src/im/order-team";
import { readOrderTeamAccess,listJoinedOrderTeams } from "../src/im/order-team-access";
import { ImIdentityProvisioner,deriveYunxinAccountId,type ImIdentityKey } from "../src/im/identity-lifecycle";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { createOrResumeUserConsultation,closeConsultation,supportManagerIdentityKey,MessageScopeRecoveryLifecycle } from "../src/im/consultation";
import { lockDispatchGate } from "../src/im/support-dispatch";
import { seedAdmin,seedIdentity,seedUser,adminContext,userContext,FakeSupportScopeProvider } from "./im-test-fixtures";
import { OrderTeamTransport,fakeIdentityAccounts } from "./order-team-fixtures";
import type { runPaymentAcceptance } from "./order-payment-im-postgres.test";
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};

export async function runOrderTeamAcceptance(t:TestContext,o:Parameters<typeof runPaymentAcceptance>[1],upgrade?:()=>Promise<void>):Promise<void>{
  const {pool,ownerPool,migrationPool}=o,run=randomUUID().replaceAll("-","").slice(0,8),appId=`order_team_${run}`,staff=`team_staff_${run}`;
  const identityKey=(kind:"USER"|"ADMIN",id:string,app=appId):ImIdentityKey=>({provider:"yunxin",appId:app,realm:kind.toLowerCase(),kind,platformSubjectId:id});
  await seedAdmin(pool,staff,`${staff}_s`,run,false);await seedIdentity(pool,identityKey("ADMIN",staff),run);
  for(const permission of ["im.support.read","im.support.accept","im.support.presence","im.support.transfer"])
    await pool.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES($1,$2,'ALLOW')`,[staff,permission]);
  await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id,admin_user_id,availability,connection_state,last_connected_at) VALUES($1,$2,'AVAILABLE','CONNECTED',clock_timestamp())`,[appId,staff]);
  let gameId="";const fixtureApps=new Set([appId]);
  const makePaid=async(label:string,app=appId)=>{
    const f=await o.fixture(label);const row=(await pool.query(`SELECT * FROM zzsh_order.rental_order WHERE id=$1`,[f.orderId])).rows[0];
    if(!gameId){gameId=row.game_id;await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$1)`,[staff,gameId]);}
    if(!fixtureApps.has(app)){await seedIdentity(pool,identityKey("ADMIN",staff,app),run);await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id,admin_user_id,availability,connection_state,last_connected_at) VALUES($1,$2,'AVAILABLE','CONNECTED',clock_timestamp())`,[app,staff]);fixtureApps.add(app);}
    const fact=createControlledPaymentSource({config:o.config,resourceSet:o.resourceSet,appId:app,merchantScopeId:"team_test",allowedOrderIds:[f.orderId]})({orderId:f.orderId,merchantOrderNo:row.display_no,providerTransactionId:`tx_${randomUUID()}`,amountCents:(BigInt(row.rental_amount_cents)+BigInt(row.deposit_amount_cents)).toString(),currency:"CNY",providerPaidAt:new Date().toISOString(),requestId:`req_${randomUUID()}`});
    await withTransaction(pool,c=>confirmOrderPayment(c,fact));await dispatchPaidOrders(pool,app);
    return {...f,renter:row.renter_user_id as string,owner:row.owner_user_id as string,appId:app};
  };
  const legacy=await makePaid("0037已分配订单");
  if(upgrade){assert.equal((await pool.query(`SELECT to_regclass('zzsh_order.im_order_operation') AS relation`)).rows[0].relation,null);await upgrade();}
  const accounts=fakeIdentityAccounts();const identities=new ImIdentityProvisioner(new YunxinIdentityRepository(pool),accounts.api);
  const wire=new OrderTeamTransport();const options:OrderTeamOptions={pool,appId,provider:wire.client,identities,membersLimit:200};
  const group=async(id:string)=>(await pool.query(`SELECT * FROM zzsh_order.im_order_group WHERE order_id=$1`,[id])).rows[0];
  const op=async(id:string)=>(await pool.query(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1`,[id])).rows[0];
  const reconcile=async(id:string,opts=options)=>{const row=await op(id);await reconcileOrderTeam(opts,id,{operationId:row.id,version:row.version,teamId:row.candidate_team_id});};
  const actor=async(id:string,realm:"user"|"admin")=>({realm,userId:id,sessionId:(await pool.query(`SELECT id FROM ${realm==="user"?'zzsh_auth_user':'zzsh_auth_admin'}."session" WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,[id])).rows[0].id as string});
  const stats=async()=>(await pool.query(`SELECT active_load,last_order_assigned_at::text,last_consultation_assigned_at::text FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`,[appId,staff])).rows[0];
  const deadlocks=(await ownerPool.query(`SELECT deadlocks::text FROM pg_stat_database WHERE datname=current_database()`)).rows[0].deadlocks;
  let outside=0;const fetch=globalThis.fetch;
  globalThis.fetch=(async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.hostname!=="127.0.0.1"){outside++;throw new Error("real channel blocked");}return fetch(input,init);}) as typeof fetch;
  try{
    await t.test("T01 legacy ASSIGNED, identity pending/recovery and two workers create only once",async()=>{
      const before=await stats();accounts.failNext();await advanceOrderTeam(options,legacy.orderId);
      assert.equal((await group(legacy.orderId)).team_state,"IDENTITY_PENDING");assert.equal(wire.creates.length,0);
      await pool.query(`UPDATE zzsh_iam.im_identity_mapping SET next_retry_at=clock_timestamp() WHERE app_id=$1 AND status='PENDING'`,[appId]);
      await Promise.all([advanceOrderTeam(options,legacy.orderId),advanceOrderTeam(options,legacy.orderId)]);
      assert.equal((await group(legacy.orderId)).team_state,"READY");assert.equal(wire.creates.length,1);assert.deepEqual(await stats(),before);
      await advanceOrderTeam(options,legacy.orderId);assert.equal(wire.creates.length,1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_member WHERE order_id=$1 AND state='JOINED'`,[legacy.orderId])).rows[0].n,3);
      assert.equal((await op(legacy.orderId)).state,"SUCCEEDED");
      assert.match((await group(legacy.orderId)).team_name,/^三角洲行动\|订单:ZZ/);
    });
    await t.test("T02 exact readback failures preserve candidates and never create twice",async()=>{
      for(const [name,tweak] of [
        ["owner",(x:any)=>{x.info.owner_account_id="wrong";}],["marker",(x:any)=>{x.info.server_extension='{}';}],
        ["type",(x:any)=>{x.info.team_type=2;}],["members",(x:any)=>{x.members.pop();x.info.member_count=3;}],
        ["extra",(x:any)=>{x.members.push({team_id:x.info.team_id,account_id:"outsider",member_role:0,chat_banned:false});x.info.member_count=5;}],
        ["control",(x:any)=>{x.info.configuration.invite_mode=1;}],["role",(x:any)=>{x.members[1].member_role=2;}],
      ] as const){wire.tweak=tweak;const f=await makePaid(`读回-${name}`);const count=wire.creates.length;
        await advanceOrderTeam(options,f.orderId);assert.equal((await group(f.orderId)).team_state,"NEEDS_REVIEW");assert.ok((await op(f.orderId)).candidate_team_id);
        await advanceOrderTeam(options,f.orderId);assert.equal(wire.creates.length,count+1);
      }
      wire.tweak=undefined;wire.partial=true;const partial=await makePaid("部分邀请");await advanceOrderTeam(options,partial.orderId);wire.partial=false;
      assert.equal((await op(partial.orderId)).failure_class,"PARTIAL_CREATE");await reconcile(partial.orderId);assert.equal((await group(partial.orderId)).team_state,"READY");
      wire.rejectCode=108435;const quota=await makePaid("配额拒绝");const count=wire.creates.length;await advanceOrderTeam(options,quota.orderId);wire.rejectCode=undefined;
      assert.equal((await op(quota.orderId)).failure_class,"PROVIDER_QUOTA");await advanceOrderTeam(options,quota.orderId);assert.equal(wire.creates.length,count+1);
      const invalid=await makePaid("名称超限");const oldName=(await pool.query(`SELECT name FROM zzsh_supply.game WHERE id=$1`,[gameId])).rows[0].name;
      try{await pool.query(`UPDATE zzsh_supply.game SET name=$2 WHERE id=$1`,[gameId,"长".repeat(70)]);await advanceOrderTeam(options,invalid.orderId);}
      finally{await pool.query(`UPDATE zzsh_supply.game SET name=$2 WHERE id=$1`,[gameId,oldName]);}
      assert.equal((await group(invalid.orderId)).team_failure,"INVALID_NAME");assert.equal(await op(invalid.orderId),undefined);
    });
    await t.test("T03 response loss/ABSENT and late success under expired lease cannot recreate or overwrite",async()=>{
      const lost=await makePaid("响应丢失");wire.responseLoss=true;await advanceOrderTeam(options,lost.orderId);wire.responseLoss=false;
      const unknown=await op(lost.orderId);assert.equal(unknown.state,"NEEDS_REVIEW");assert.equal(unknown.candidate_team_id,null);
      const count=wire.creates.length;await scanOrderTeams(options);assert.equal(wire.creates.length,count);
      await assert.rejects(reconcileOrderTeam(options,lost.orderId,{operationId:unknown.id,version:unknown.version,teamId:String(wire.nextId-1)}),/BINDING_MISMATCH/);
      const late=await makePaid("租约过期迟到");const entered=deferred(),release=deferred();wire.beforeResponse=async()=>{entered.resolve();await release.promise;};
      const pending=advanceOrderTeam(options,late.orderId);
      try{await entered.promise;await pool.query(`UPDATE zzsh_order.im_order_operation SET lease_until=clock_timestamp()-interval '1 second' WHERE order_id=$1`,[late.orderId]);await scanOrderTeams(options);}
      finally{release.resolve();await pending;wire.beforeResponse=undefined;}
      assert.equal((await group(late.orderId)).team_state,"NEEDS_REVIEW");const old=await op(late.orderId);assert.ok(old.candidate_team_id);
      const saved=wire.teams.get(old.candidate_team_id)!;wire.teams.delete(old.candidate_team_id);
      await reconcile(late.orderId);assert.equal((await group(late.orderId)).team_state,"NEEDS_REVIEW");assert.equal(wire.creates.length,count+1);
      wire.teams.set(old.candidate_team_id,saved);await reconcile(late.orderId);const done=await op(late.orderId);
      await reconcileOrderTeam(options,late.orderId,{operationId:old.id,version:old.version,teamId:old.candidate_team_id});
      assert.equal(done.state,"SUCCEEDED");assert.equal(wire.creates.length,count+1);
    });
    await t.test("T04 successful CREATE plus audit failure retains candidate; restart reconciles read-only",async()=>{
      const f=await makePaid("回写审计失败");await prepareOrderTeam(options,f.orderId);
      wire.beforeResponse=async()=>{await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.config.database.user}"`);};
      try{await advanceOrderTeam(options,f.orderId);}finally{wire.beforeResponse=undefined;await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.config.database.user}"`);}
      const row=await op(f.orderId);assert.ok(row.candidate_team_id);assert.equal(row.state,"NEEDS_REVIEW");assert.equal((await group(f.orderId)).team_id,null);
      const count=wire.creates.length;await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp() WHERE order_id=$1`,[f.orderId]);
      await scanOrderTeams({...options});assert.equal((await group(f.orderId)).team_state,"READY");assert.equal(wire.creates.length,count);
    });
    await t.test("T05 pool=1 includes identity, remote renewal and candidate writes; network never holds App gate",async()=>{
      const f=await makePaid("单连接建群");const db=o.config.database;
      const single=new Pool({host:db.host,port:db.port,database:db.name,user:db.user,password:db.password,max:1,connectionTimeoutMillis:2000});
      wire.beforeResponse=async()=>{await withTransaction(pool,c=>lockDispatchGate(c,appId));};
      try{
        await advanceOrderTeam({...options,pool:single,identities:new ImIdentityProvisioner(new YunxinIdentityRepository(single),accounts.api)},f.orderId);
        assert.equal((await group(f.orderId)).team_state,"READY");
        const scope=new FakeSupportScopeProvider(960000001);const cOpts={pool:single,appId,provider:scope,supportManager:{key:supportManagerIdentityKey(appId),provisioner:new ImIdentityProvisioner(new YunxinIdentityRepository(single),accounts.api)}};
        const ctx=await actor(f.renter,"user");const consult=await createOrResumeUserConsultation(cOpts,ctx,"SERVICE",null,`req_${run}_pool1`);
        assert.equal(consult.consultation.messageScopeState,"READY");await closeConsultation(cOpts,adminContext(staff,`${staff}_s`),consult.consultation.id,`req_${run}_pool1close`);
      }finally{wire.beforeResponse=undefined;await single.end();}
    });
    await t.test("T06 cross-kind binding collision works in both directions",async()=>{
      // Deliberately conflicting provider views cannot override the DB binding.
      for(const first of ["order","consultation"] as const){
        const app=`${appId}_${first}`,f=await makePaid(`跨类型-${first}`,app),id=wire.nextId;
        const orderOpts={...options,appId:app};await prepareOrderTeam(orderOpts,f.orderId);
        const scope=new FakeSupportScopeProvider(id);const cOpts={pool,appId:app,provider:scope,supportManager:{key:supportManagerIdentityKey(app),provisioner:identities}};
        const ctx=await actor(f.renter,"user");
        if(first==="order"){
          await advanceOrderTeam(orderOpts,f.orderId);
          await assert.rejects(createOrResumeUserConsultation(cOpts,ctx,"SERVICE",null,`req_${run}_${first}`),/being recovered/);
        }else{
          await createOrResumeUserConsultation(cOpts,ctx,"SERVICE",null,`req_${run}_${first}`);
          await advanceOrderTeam(orderOpts,f.orderId);assert.equal((await group(f.orderId)).team_state,"NEEDS_REVIEW");
        }
        const bindings=(await pool.query(`SELECT (SELECT count(*) FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2)+
          (SELECT count(*) FROM zzsh_iam.im_consultation WHERE app_id=$1 AND message_scope_id=$2) AS n`,[app,String(id)])).rows[0].n;
        assert.equal(bindings,"1");
      }
      const app=`${appId}_race`,f=await makePaid("跨类型并发",app),id=wire.nextId,orderOpts={...options,appId:app};
      await prepareOrderTeam(orderOpts,f.orderId);
      const scope=new FakeSupportScopeProvider(id),arrived=deferred(),release=deferred();let n=0;
      const barrier=async()=>{if(++n===2)arrived.resolve();await release.promise;};
      wire.beforeResponse=barrier;scope.beforeCreate=barrier;
      const cOpts={pool,appId:app,provider:scope,supportManager:{key:supportManagerIdentityKey(app),provisioner:identities}};
      const pending=Promise.allSettled([advanceOrderTeam(orderOpts,f.orderId),createOrResumeUserConsultation(cOpts,await actor(f.renter,"user"),"SERVICE",null,`req_${run}_race`)]);
      try{await arrived.promise;await withTransaction(pool,c=>lockDispatchGate(c,app));}finally{release.resolve();await pending;wire.beforeResponse=undefined;}
      assert.equal((await pool.query(`SELECT (SELECT count(*) FROM zzsh_order.im_order_group WHERE app_id=$1 AND team_id=$2)+
        (SELECT count(*) FROM zzsh_iam.im_consultation WHERE app_id=$1 AND message_scope_id=$2) AS n`,[app,String(id)])).rows[0].n,"1");
    });
    await t.test("T07 current sessions, parties and JOINED staff equality; no order.read shortcut",async()=>{
      const buyer=await actor(legacy.renter,"user"),owner=await actor(legacy.owner,"user"),primary=await actor(staff,"admin");
      for(const ctx of [buyer,owner,primary])assert.equal((await withTransaction(pool,c=>readOrderTeamAccess(c,ctx,legacy.orderId,"send"))).canSend,true);
      if(!upgrade){assert.equal((await o.api(`/api/v1/orders/${legacy.orderId}/im?operation=send`)).response.status,200);}
      const extra=`team_extra_${run}`;await seedAdmin(pool,extra,`${extra}_s`,run,false);await seedIdentity(pool,identityKey("ADMIN",extra),run);
      for(const permission of ["im.support.read","im.support.accept","order.read"])await pool.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES($1,$2,'ALLOW')`,[extra,permission]);
      await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$3)`,[extra,gameId,staff]);
      const ctx=await actor(extra,"admin");await assert.rejects(withTransaction(pool,c=>readOrderTeamAccess(c,ctx,legacy.orderId)),{status:403});
      const mapping=(await pool.query(`SELECT id FROM zzsh_iam.im_identity_mapping WHERE app_id=$1 AND platform_subject_id=$2 AND realm='admin'`,[appId,extra])).rows[0].id;
      await pool.query(`INSERT INTO zzsh_order.im_order_member(order_id,app_id,identity_id,party,state,joined_at) VALUES($1,$2,$3,'STAFF','JOINED',clock_timestamp())`,[legacy.orderId,appId,mapping]);
      assert.equal((await withTransaction(pool,c=>readOrderTeamAccess(c,ctx,legacy.orderId,"send"))).canSend,true);
      await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`,[extra]);
      assert.equal((await withTransaction(pool,c=>readOrderTeamAccess(c,ctx,legacy.orderId))).canRead,true);await assert.rejects(withTransaction(pool,c=>readOrderTeamAccess(c,ctx,legacy.orderId,"send")),{status:403});
      await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.read'`,[extra]);await assert.rejects(withTransaction(pool,c=>readOrderTeamAccess(c,ctx,legacy.orderId)),{status:403});
      await assert.rejects(withTransaction(pool,c=>readOrderTeamAccess(c,{...buyer,sessionId:"expired"},legacy.orderId)),{status:401});
      const outsider=`team_other_${run}`;await seedUser(pool,outsider,`${outsider}_s`,run);await assert.rejects(withTransaction(pool,c=>readOrderTeamAccess(c,{realm:"user",...userContext(outsider,`${outsider}_s`)},legacy.orderId)),{status:403});
    });
    await t.test("T08 DB binding/party/state constraints and minimum runtime grants",async()=>{
      const good=await group(legacy.orderId),operation=await op(legacy.orderId);
      await assert.rejects(pool.query(`UPDATE zzsh_order.im_order_operation SET candidate_team_id='123' WHERE id=$1`,[operation.id]),{code:"40001"});
      await assert.rejects(pool.query(`UPDATE zzsh_order.im_order_group SET team_id='123',version=version+1 WHERE order_id=$1`,[legacy.orderId]),{code:"40001"});
      await assert.rejects(pool.query(`UPDATE zzsh_order.im_order_member SET identity_id=$2 WHERE order_id=$1`,[legacy.orderId,good.system_identity_id]),{code:"42501"});
      const next=await makePaid("类型约束");await prepareOrderTeam(options,next.orderId);
      await assert.rejects(pool.query(`INSERT INTO zzsh_order.im_order_member(order_id,app_id,identity_id,party) VALUES($1,$2,$3,'STAFF')`,[next.orderId,appId,good.system_identity_id]),{code:"23514"});
      await assert.rejects(pool.query(`UPDATE zzsh_order.im_order_member SET state='JOINED',joined_at=clock_timestamp() WHERE order_id=$1`,[next.orderId]),{code:"23514"});
      const foreign=(await pool.query(`SELECT id,app_id FROM zzsh_iam.im_identity_mapping WHERE app_id<>$1 AND identity_kind='ADMIN' LIMIT 1`,[appId])).rows[0];
      await assert.rejects(pool.query(`INSERT INTO zzsh_order.im_order_member(order_id,app_id,identity_id,party) VALUES($1,$2,$3,'STAFF')`,[legacy.orderId,appId,foreign.id]),{code:"23514"});
      const rights=(await pool.query(`SELECT has_column_privilege(current_user,'zzsh_order.im_order_operation','state','UPDATE') AS state,
        has_column_privilege(current_user,'zzsh_order.im_order_operation','order_id','UPDATE') AS binding,
        has_table_privilege(current_user,'zzsh_order.im_order_member','DELETE') AS del`)).rows[0];assert.deepEqual(rights,{state:true,binding:false,del:false});
    });
    await t.test("T10 current staff permissions gate CREATE and final binding, with recoverable original intent",async()=>{
      const f=await makePaid("建群前后撤权");await prepareOrderTeam(options,f.orderId);const count=wire.creates.length;
      const permission=async(code:string,effect:string)=>pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect=$3 WHERE admin_user_id=$1 AND permission_code=$2`,[staff,code,effect]);
      try{
        await permission("im.support.read","DENY");await advanceOrderTeam(options,f.orderId);
        assert.equal(wire.creates.length,count);assert.equal((await op(f.orderId)).sent_at,null);assert.equal((await op(f.orderId)).state,"PENDING");
        await permission("im.support.read","ALLOW");
        await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp() WHERE order_id=$1`,[f.orderId]);
        wire.beforeResponse=async()=>{await permission("im.support.accept","DENY");};
        await advanceOrderTeam(options,f.orderId);wire.beforeResponse=undefined;
        assert.equal((await group(f.orderId)).team_state,"NEEDS_REVIEW");assert.ok((await op(f.orderId)).candidate_team_id);
        await permission("im.support.accept","ALLOW");await reconcile(f.orderId);
        assert.equal((await group(f.orderId)).team_state,"READY");assert.equal(wire.creates.length,count+1);
      }finally{wire.beforeResponse=undefined;await permission("im.support.read","ALLOW");await permission("im.support.accept","ALLOW");}
    });
    await t.test("T09 explicit worker default-off and Nest close waits for actual remote flight",async()=>{
      const f=await makePaid("生命周期");const db=o.config.database;const workerPool=new Pool({host:db.host,port:db.port,database:db.name,user:db.user,password:db.password,max:1,connectionTimeoutMillis:2000});
      const app=await createApp({health:{dependencies:{postgres:{check:async()=>undefined,close:async()=>undefined},redis:{check:async()=>undefined,close:async()=>undefined}}},database:{pool:workerPool}});await app.init();
      const host=app.get(OrderTeamLifecycle);host.wake();assert.equal(workerPool.totalCount,0);
      const entered=deferred(),release=deferred();wire.beforeResponse=async()=>{entered.resolve();await release.promise;};
      let closing:Promise<void>|undefined;
      try{host.start({...options,pool:workerPool,identities:new ImIdentityProvisioner(new YunxinIdentityRepository(workerPool),accounts.api)},100000,100);
        await entered.promise;let ended=false;const end=workerPool.end.bind(workerPool);workerPool.end=(async()=>{ended=true;return end();}) as typeof workerPool.end;
        closing=app.close();await new Promise<void>(r=>setImmediate(r));assert.equal(ended,false);release.resolve();await closing;assert.equal(ended,true);
      }finally{release.resolve();wire.beforeResponse=undefined;if(closing)await closing;else await app.close();}
      // A prior pending operation can be first in the bounded scan; close must
      // settle all started work, never end its single connection under a callback.
      assert.equal((await group(f.orderId)).team_state,"READY");
    });
    await t.test("T11 one Nest instance waits for simultaneous order and consultation recovery before closing its small pool",async()=>{
      const f=await makePaid("新旧共同关闭");await prepareOrderTeam(options,f.orderId);
      const scope=new FakeSupportScopeProvider(970000001);
      const cOpts={pool,appId,provider:scope,supportManager:{key:supportManagerIdentityKey(appId),provisioner:identities}};
      await assert.rejects(createOrResumeUserConsultation({...cOpts,supportManager:{...cOpts.supportManager,provisioner:{
        ensure:async(input)=>({...await identities.ensure(input),outcome:"PENDING" as const}),
      }}},await actor(f.renter,"user"),"SERVICE",null,`req_${run}_jointclose`),/being recovered/);
      const consultation=(await pool.query(`SELECT id FROM zzsh_iam.im_consultation WHERE app_id=$1 AND user_id=$2 AND state='ACTIVE'`,[appId,f.renter])).rows[0];
      await pool.query(`UPDATE zzsh_iam.im_consultation_scope_operation SET next_retry_at=clock_timestamp() WHERE consultation_id=$1`,[consultation.id]);
      const db=o.config.database,workerPool=new Pool({host:db.host,port:db.port,database:db.name,user:db.user,password:db.password,max:2,connectionTimeoutMillis:2000});
      const app=await createApp({health:{dependencies:{postgres:{check:async()=>undefined,close:async()=>undefined},redis:{check:async()=>undefined,close:async()=>undefined}}},database:{pool:workerPool}});await app.init();
      const orderEntered=deferred(),oldEntered=deferred(),releaseOrder=deferred(),releaseOld=deferred();
      wire.beforeResponse=async()=>{orderEntered.resolve();await releaseOrder.promise;};scope.beforeCreate=async()=>{oldEntered.resolve();await releaseOld.promise;};
      let closing:Promise<void>|undefined,timeout:NodeJS.Timeout|undefined,ended=false;
      const end=workerPool.end.bind(workerPool);workerPool.end=(async()=>{ended=true;return end();}) as typeof workerPool.end;
      try{
        const workerIdentities=new ImIdentityProvisioner(new YunxinIdentityRepository(workerPool),accounts.api);
        app.get(MessageScopeRecoveryLifecycle).start({...cOpts,pool:workerPool,supportManager:{...cOpts.supportManager,provisioner:workerIdentities}},10);
        await Promise.race([oldEntered.promise,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("consultation barrier not reached")),5000);})]);clearTimeout(timeout);
        app.get(OrderTeamLifecycle).start({...options,pool:workerPool,identities:workerIdentities},100000,100);
        await Promise.race([orderEntered.promise,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("order barrier not reached")),5000);})]);clearTimeout(timeout);
        closing=app.close();await new Promise<void>(r=>setImmediate(r));assert.equal(ended,false);
        releaseOrder.resolve();await new Promise<void>(r=>setImmediate(r));assert.equal(ended,false);
        releaseOld.resolve();await closing;assert.equal(ended,true);
      }finally{clearTimeout(timeout);releaseOrder.resolve();releaseOld.resolve();wire.beforeResponse=undefined;if(closing)await closing;else await app.close();}
      assert.equal((await group(f.orderId)).team_state,"READY");
      assert.equal((await pool.query(`SELECT message_scope_state FROM zzsh_iam.im_consultation WHERE id=$1`,[consultation.id])).rows[0].message_scope_state,"READY");
    });
    await t.test("T12 scan isolates a locked head and advances beyond an entirely locked bounded window",async(t)=>{
      const warnings:string[]=[];const log=t.mock.method(Logger.prototype,"warn",(message:unknown)=>{warnings.push(String(message));});
      try{for(const [label,size,locked,limit] of [["single",2,1,10],["window",3,2,2]] as const){
        const app=`${appId}_${label}`,opts={...options,appId:app};
        for(let i=0;i<size;i++)await makePaid(`扫描${label}${i}`,app);
        const rows=(await pool.query(`SELECT g.order_id,o.account_id FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id WHERE g.app_id=$1 ORDER BY g.order_id`,[app])).rows;
        const count=wire.creates.length,blocker=await pool.connect();
        try{await blocker.query("BEGIN");await blocker.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,[rows.slice(0,locked).map(r=>r.account_id)]);
          await scanOrderTeams(opts,limit);
          assert.equal(wire.creates.length-count,label==="single"?1:0);
          if(label==="window")await scanOrderTeams({...opts},limit);
          assert.equal((await group(rows[locked].order_id)).team_state,"READY");
          for(const row of rows.slice(0,locked))assert.equal((await group(row.order_id)).team_state,"PENDING");
        }finally{await blocker.query("ROLLBACK");blocker.release();}
        await scanOrderTeams(opts,limit);
        for(const row of rows)assert.equal((await group(row.order_id)).team_state,"READY");
        await scanOrderTeams(opts,limit);assert.equal(wire.creates.length-count,size);
        assert.ok(warnings.some(w=>{const e=JSON.parse(w);return e.phase==="due"&&e.orderId===rows[0].order_id&&e.failureClass==="LOCK_BUSY";}));
      }}finally{log.mock.restore();}
      for(const warning of warnings){const e=JSON.parse(warning);assert.deepEqual(Object.keys(e).sort(),["appId","event","failureClass","operationId","orderId","phase"].sort());assert.equal(e.event,"im.order.team.item_deferred");}
    });
    await t.test("T13 expired RUNNING windows advance, wrap and never resend unknown CREATE",async()=>{
      const app=`${appId}_expired`,opts={...options,appId:app};
      for(let i=0;i<3;i++){const f=await makePaid(`过期扫描${i}`,app);await prepareOrderTeam(opts,f.orderId);}
      await pool.query(`UPDATE zzsh_order.im_order_operation SET state='RUNNING',version=version+1,lease_until=clock_timestamp()-interval '1 second',lease_token_hash=repeat('a',64),sent_at=clock_timestamp() WHERE app_id=$1`,[app]);
      const rows=(await pool.query(`SELECT order_id,sent_at::text FROM zzsh_order.im_order_operation WHERE app_id=$1 ORDER BY order_id`,[app])).rows;
      const count=wire.creates.length,blocker=await pool.connect();
      try{await blocker.query("BEGIN");await blocker.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=ANY($1::text[]) ORDER BY order_id FOR UPDATE`,[rows.slice(0,2).map(r=>r.order_id)]);
        await scanOrderTeams(opts,2);assert.equal((await op(rows[2].order_id)).state,"RUNNING");
        await scanOrderTeams(opts,2);assert.equal((await op(rows[2].order_id)).state,"NEEDS_REVIEW");
      }finally{await blocker.query("ROLLBACK");blocker.release();}
      await scanOrderTeams(opts,2);await scanOrderTeams(opts,2);
      for(const row of rows){assert.equal((await op(row.order_id)).state,"NEEDS_REVIEW");assert.equal((await op(row.order_id)).candidate_team_id,null);}
      assert.deepEqual((await pool.query(`SELECT order_id,sent_at::text FROM zzsh_order.im_order_operation WHERE app_id=$1 ORDER BY order_id`,[app])).rows,rows);
      assert.equal(wire.creates.length,count);
    });
    await t.test("T14 read-only recovery isolates locked candidates and retries on wrap without CREATE",async()=>{
      const app=`${appId}_recover`,opts={...options,appId:app};
      wire.partial=true;
      try{for(let i=0;i<3;i++){const f=await makePaid(`候选扫描${i}`,app);await advanceOrderTeam(opts,f.orderId);}}
      finally{wire.partial=false;}
      // Controlled recovery fixture: known exact candidate, same state as a
      // successful CREATE followed by failed local finalization (T04).
      await pool.query(`UPDATE zzsh_order.im_order_operation SET failure_class='DB_WRITEBACK_UNKNOWN',next_retry_at=clock_timestamp() WHERE app_id=$1`,[app]);
      const rows=(await pool.query(`SELECT order_id,candidate_team_id FROM zzsh_order.im_order_operation WHERE app_id=$1 ORDER BY order_id`,[app])).rows;
      const count=wire.creates.length,blocker=await pool.connect();
      try{await blocker.query("BEGIN");await blocker.query(`SELECT id FROM zzsh_order.im_order_operation WHERE order_id=ANY($1::text[]) ORDER BY order_id FOR UPDATE`,[rows.slice(0,2).map(r=>r.order_id)]);
        await scanOrderTeams(opts,2);assert.equal((await group(rows[2].order_id)).team_state,"NEEDS_REVIEW");
        await scanOrderTeams(opts,2);assert.equal((await group(rows[2].order_id)).team_state,"READY");
      }finally{await blocker.query("ROLLBACK");blocker.release();}
      await scanOrderTeams(opts,2);await scanOrderTeams(opts,2);
      for(const row of rows){assert.equal((await group(row.order_id)).team_state,"READY");assert.equal((await group(row.order_id)).team_id,row.candidate_team_id);}
      assert.equal(wire.creates.length,count);
    });
    await t.test("T15 member-scoped order directory and safe identity context do not require order.read",async()=>{
      const primary=await actor(staff,"admin");
      await pool.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES($1,'order.read','DENY') ON CONFLICT(admin_user_id,permission_code) DO UPDATE SET effect='DENY'`,[staff]);
      const list=await withTransaction(pool,c=>listJoinedOrderTeams(c,primary,null,2));
      assert.equal((list.items as unknown[]).length,2);assert.ok(list.nextCursor);
      const second=await withTransaction(pool,c=>listJoinedOrderTeams(c,primary,list.nextCursor as string,2));
      assert.ok(!(second.items as {id:string}[]).some(row=>(list.items as {id:string}[]).some(old=>row.id===old.id)));
      const detail=await withTransaction(pool,c=>readOrderTeamAccess(c,primary,legacy.orderId));
      assert.equal(detail.gameName,"三角洲行动");assert.equal((detail.account as {id:string}).id,(await pool.query(`SELECT account_id FROM zzsh_order.rental_order WHERE id=$1`,[legacy.orderId])).rows[0].account_id);
      assert.ok((detail.members as {name:string}[]).every(member=>typeof member.name==="string"));
      assert.ok((detail.members as {party:string;identityStatus?:string}[]).filter(m=>m.party!=="STAFF").every(m=>m.identityStatus==="UNKNOWN"));
      assert.doesNotMatch(JSON.stringify(detail),/phoneNumber|password|token|rental_amount|deposit_amount/);
      const boss=`team_outside_boss_${run}`;await seedAdmin(pool,boss,`${boss}_s`,run,true);await seedIdentity(pool,identityKey("ADMIN",boss),run);
      const bossActor=await actor(boss,"admin");
      assert.deepEqual((await withTransaction(pool,c=>listJoinedOrderTeams(c,bossActor,null,20))).items,[]);
      await assert.rejects(withTransaction(pool,c=>readOrderTeamAccess(c,bossActor,legacy.orderId)),{status:403});
      await ownerPool.query(`DELETE FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=$1 AND game_id=$2`,[staff,gameId]);
      try{assert.deepEqual((await withTransaction(pool,c=>listJoinedOrderTeams(c,primary,null,20))).items,[]);await assert.rejects(withTransaction(pool,c=>readOrderTeamAccess(c,primary,legacy.orderId)),{status:403});}
      finally{await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$1)`,[staff,gameId]);}
      await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.read'`,[staff]);
      try{await assert.rejects(withTransaction(pool,c=>listJoinedOrderTeams(c,primary,null,20)),{status:403});}
      finally{await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='im.support.read'`,[staff]);}
      const unpaid=await o.fixture("未付款群入口");const renter=(await pool.query(`SELECT renter_user_id FROM zzsh_order.rental_order WHERE id=$1`,[unpaid.orderId])).rows[0].renter_user_id;
      const renterActor=await actor(renter,"user");const pending=await withTransaction(pool,c=>readOrderTeamAccess(c,renterActor,unpaid.orderId));
      assert.equal(pending.orderStatus,"PENDING_PAYMENT");assert.equal(pending.canRead,false);assert.equal(pending.teamId,null);
    });
    assert.equal(outside,0);assert.equal((await ownerPool.query(`SELECT deadlocks::text FROM pg_stat_database WHERE datname=current_database()`)).rows[0].deadlocks,deadlocks);
    console.log("order Team acceptance",JSON.stringify({realRequests:outside,deadlocksDelta:0,creates:wire.creates.length}));
  }finally{globalThis.fetch=fetch;}
}
