// 不连库，只核PG函数在入口/准备不满足时不会推进到业务写入。
import test from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../src/config/config";
import { CHANNEL_REFUND_PG_EVIDENCE, runChannelRefundPostgres } from "./channel-refund-postgres.test";
import { createNativeRefundContextFixture } from "./channel-refund-context-fixture";
import { createNativeRefundPostingFixture } from "./channel-refund-fixture";
import { createSyntheticChannelRequestCapability } from "../src/order/channel-payment-store";
import * as settlement from "../src/order/settlement-record";
import { createNativeRefundIntent } from "../src/order/channel-refund-store";
const config={profile:"test",provider:"fake",testOperationsEnabled:true,database:{target:"local-compose",host:"127.0.0.1",port:55432,name:"zzsh_test_order_refund_synth",user:"zzsh_order_refund_synth_r"}} as AppConfig;
const input={config,resourceSet:"refund_synth",postingId:"posting_1",attempt:"refund-pg-synthetic"};
test("PG模块导入不建池，坏输入/资源在SQL之前拒绝",async()=>{
 let calls=0;const pool={query:async()=>{calls++;throw Error("NO_SOCKET_CLIENT");}} as unknown as Pool;
 await assert.rejects(runChannelRefundPostgres(pool,{...input,postingId:"bad id"}),/INPUT_INVALID/);
 await assert.rejects(runChannelRefundPostgres(pool,{...input,resourceSet:"other"}),/isolated test/);
 assert.equal(calls,0);
 assert.equal(CHANNEL_REFUND_PG_EVIDENCE,"CONTROLLED_DATABASE_CONTRACT");
 await assert.rejects(runChannelRefundPostgres(pool,null as never),/REFUND_PG_INPUT_INVALID/);
});

test("受控退款入口拒绝正式JOINPAY原款，不用合成能力替代正式退款准入",async()=>{
 const seen:string[]=[];
 const client={query:async(sql:string)=>{seen.push(sql);return{rows:sql.includes('current_database()')?[{db:config.database.name,actor:config.database.user}]
  :sql.includes('transaction_isolation')?[{isolation:'read committed'}]:[{source:'JOINPAY',currency:'CNY'}]};}} as unknown as PoolClient;
 const capability=createSyntheticChannelRequestCapability({config,resourceSet:'refund_synth',evidenceLevel:'CONTROLLED_TEST'});
 await assert.rejects(createNativeRefundIntent(client,{postingId:'posting_1',requestId:'request_1',amountCents:'100',idempotencyKey:'scope-negative',capability}),
  (e:any)=>e.status===503&&e.code==='EVIDENCE_UNAVAILABLE');
 assert.equal(seen.some(s=>/INSERT|UPDATE|DELETE|advisory/i.test(s)),false);
});

test("过期fixture窗口或共享库配置在首次连接之前拒绝",async()=>{
 let calls=0;const pool={connect:async()=>{calls++;throw Error('NO_SOCKET_CLIENT');}} as unknown as Pool;
 const args={config:{...config,database:{...config.database,name:'zzsh_test_order_joinpay_pay03a',user:'zzsh_order_joinpay_pay03a_r'}},
  resourceSet:'joinpay_pay03a',resourceOid:1001585,approvalDigest:'a'.repeat(64),expiresAt:'2000-01-01T00:00:00Z',attempt:'fixture_synthetic',
  accountId:'account_1',listingVersionId:'listing_1',gameId:'game_1',renter:{userId:'renter',sessionId:'sr'},owner:{userId:'owner',sessionId:'so'},
  support:{userId:'support',sessionId:'ss'},roleId:'role_1',appId:'synthetic_app',merchantScopeId:'synthetic_merchant',checkpoint:async()=>{}};
 await assert.rejects(createNativeRefundContextFixture(pool,pool,args as any),/REFUND_CONTEXT_INPUT_INVALID/);
 await assert.rejects(createNativeRefundContextFixture(pool,pool,{...args,expiresAt:new Date(Date.now()+60000).toISOString(),config:{...config,database:{...config.database,name:'zzsh_test_order_milestone_real_1'}}} as any),/REFUND_CONTEXT_INPUT_INVALID/);
 assert.equal(calls,0);
});
test("缺schema/错连接身份在parent读取和写入之前拒绝",async()=>{
 for(const identity of [{db:config.database.name,actor:config.database.user,ready:false},{db:"other",actor:config.database.user,ready:true}]){
  const seen:string[]=[];const pool={query:async(sql:string)=>{seen.push(sql);return{rows:[identity]};}} as unknown as Pool;
  await assert.rejects(runChannelRefundPostgres(pool,input),/SCHEMA_REQUIRED|IDENTITY_MISMATCH/);assert.equal(seen.length,1);
 }
});
test("没有合法到期posted责任保持准备错误，不能伪造原付款/结算或继续建意图",async()=>{
 for(const basis of [undefined,{due:false,refund_cents:"100"},{due:true,refund_cents:"7"}]){
  const seen:string[]=[];const pool={query:async(sql:string)=>{seen.push(sql);return{rows:seen.length===1?[{db:config.database.name,actor:config.database.user,ready:true}]:(basis?[basis]:[])};}} as unknown as Pool;
  await assert.rejects(runChannelRefundPostgres(pool,input),/POSTING_FIXTURE_REQUIRED/);assert.equal(seen.length,2);
  assert.equal(seen.some(s=>/INSERT|UPDATE|DELETE|CREATE|GRANT/.test(s)),false);
 }
});
test("责任fixture没有正当事人/客服及冻结数量输入时，在建连前拒绝",async()=>{
 let calls=0;const pool={connect:async()=>{calls++;throw Error('NO_SOCKET_CLIENT');}} as unknown as Pool;
 const renter={realm:'user' as const,userId:'renter',sessionId:'session_r'},owner={realm:'user' as const,userId:'owner',sessionId:'session_o'},support={realm:'admin' as const,userId:'support',sessionId:'session_s'};
 const valid={orderId:'order_1',requestId:'request_1',capability:{},renter,owner,support,openingLines:[{itemId:'haff',quantity:'100'}],remainingLines:[{itemId:'haff',quantity:'20'}]};
 for(const change of [{owner:renter},{support:renter},{openingLines:[]},{remainingLines:[{itemId:'haff',quantity:'1.2'}]},
  {openingLines:[{itemId:'haff',quantity:'10'},{itemId:'haff',quantity:'20'}]}]){
  await assert.rejects(createNativeRefundPostingFixture(pool,{...valid,...change}),/FIXTURE_INPUT_INVALID/);
 }
 assert.equal(calls,0);
});

for(const early of [false,true])test(`合成编排检查：${early?'提前分支停止并回滚':'沿用预览返回hash和双方角色，不重确认发起人'}，不作为PG证据`,async t=>{
 const trace:string[]=[],sqls:string[]=[];
 const renter={realm:'user' as const,userId:'renter',sessionId:'session_r'},owner={realm:'user' as const,userId:'owner',sessionId:'session_o'},support={realm:'admin' as const,userId:'support',sessionId:'session_s'};
 const openingLines=[{itemId:'haff',quantity:'100'}],remainingLines=[{itemId:'haff',quantity:'20'}];
 t.mock.method(settlement,'recordOpening',async()=>{trace.push('recordOpening');return{status:200,body:{openings:[{id:'opening_1',versionNo:1}]}};});
 t.mock.method(settlement,'confirmOpening',async(...[_c,_o,_id,_v,actor]:Parameters<typeof settlement.confirmOpening>)=>{trace.push('opening:'+actor.userId);return{status:200,body:{}};});
 t.mock.method(settlement,'previewSettlement',async()=>{trace.push('preview');return{status:200,body:{early,versionHash:'b'.repeat(64)}};});
 t.mock.method(settlement,'submitSettlement',async(...[_c,_o,actor,lines,hash]:Parameters<typeof settlement.submitSettlement>)=>{trace.push('submit:'+actor.userId);assert.equal(hash,'b'.repeat(64));assert.deepEqual(lines,remainingLines);
  return{status:200,body:{settlement:{id:'settlement_1',versionHash:'c'.repeat(64),decisions:[{party:'RENTER',action:'CONFIRM'}]}}};});
 t.mock.method(settlement,'decideSettlement',async(...[_c,_o,_id,actor,action,hash]:Parameters<typeof settlement.decideSettlement>)=>{trace.push('decide:'+actor.userId);assert.equal(action,'CONFIRM');assert.equal(hash,'c'.repeat(64));return{status:200,body:{}};});
 const client={release(){},query:async(sql:string)=>{sqls.push(sql);
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
  if(sql.includes('current_database()'))return{rows:[{db:config.database.name,actor:config.database.user}]};
  if(sql.includes('SELECT o.renter_user_id'))return{rows:[{renter_user_id:renter.userId,owner_user_id:owner.userId,confirmation_id:'payment_1'}]};
  if(sql.includes('SELECT p.id'))return{rows:[{id:'posting_1',order_id:'order_1',payment_confirmation_id:'payment_1',version_hash:'c'.repeat(64),refund_cents:'100',due:true}]};
  throw Error('UNEXPECTED_FIXTURE_SQL');}} as unknown as PoolClient;
 const pool={connect:async()=>client} as unknown as Pool;
 const args={orderId:'order_1',requestId:'request_1',renter,owner,support,openingLines,remainingLines,
  capability:createSyntheticChannelRequestCapability({config,resourceSet:'refund_synth',evidenceLevel:'CONTROLLED_TEST'})};
 if(early){await assert.rejects(createNativeRefundPostingFixture(pool,args),/NORMAL_SETTLEMENT_REQUIRED/);assert.deepEqual(trace,['recordOpening','opening:renter','opening:owner','preview']);assert.equal(sqls.includes('COMMIT'),false);assert.equal(sqls.at(-1),'ROLLBACK');}
 else{const result=await createNativeRefundPostingFixture(pool,args);assert.equal(result.postingId,'posting_1');assert.equal(result.formalRefund,false);
  assert.deepEqual(trace,['recordOpening','opening:renter','opening:owner','preview','submit:renter','decide:owner']);assert.equal(sqls.at(-1),'COMMIT');}
});
