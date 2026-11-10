// SYNTHETIC_COMPONENT_MODEL；调用真实router，身份/事务/数据库为内存替身。
import assert from 'node:assert/strict';
import test from 'node:test';
import * as auth from '../src/auth/auth-security';
import * as user from '../src/auth/user-identity';
import * as core from '../src/auth/security-core';
import * as routes from '../src/supply/supply-routes';
import * as domain from '../src/order/prestart-termination';
import {handlePrestartTerminationRoute} from '../src/order/prestart-termination-routes';
import {handleAdminNativeRefundRoute} from '../src/order/native-refund-routes';
import * as refunds from '../src/order/native-refund-command';

function fixture(t:any){
 const seen:{action:string;value?:any}[]=[];let status=0,body:any,failCommit=false;
 const response={headersSent:false,setHeader(){return this;},status(n:number){status=n;return this;},json(v:any){body=v;return this;}} as any;
 const c={query:async(sql:string)=>{seen.push({action:sql});return{rows:[]};}} as any;
 const options={pool:{},userOrigin:'https://user.invalid',adminOrigin:'https://admin.invalid',apiOrigin:'https://api.invalid'} as any;
 t.mock.method(user,'readUserContext',async()=>({userId:'renter_1',sessionId:'session_1'}));
 t.mock.method(auth,'readAdminContext',async()=>({userId:'admin_1',sessionId:'session_admin'}));
 t.mock.method(core,'withTransaction',async(_p:any,fn:any)=>fn(c));
 t.mock.method(domain,'authorizePrestartWrite',async(_c:any,actor:any,id:any)=>{seen.push({action:'authorize',value:{actor,id}});});
 t.mock.method(domain,'readPrestartTermination',async(_c:any,actor:any,id:any)=>{seen.push({action:'read',value:{actor,id}});return{orderId:id};});
 t.mock.method(domain,'requestPrestartTermination',async(_c:any,actor:any,input:any)=>{seen.push({action:'request',value:{actor,input}});return{status:200,body:{request:{state:'REQUESTED'}}};});
 t.mock.method(domain,'reviewPrestartTermination',async(_c:any,actor:any,input:any)=>{seen.push({action:'review',value:{actor,input}});return{status:200,body:{request:{state:'APPROVED'}}};});
 t.mock.method(routes,'runIdempotentWrite',async(_o:any,_r:any,res:any,_id:any,scope:any,_a:any,frozen:any,authorize:any,action:any)=>{
  seen.push({action:'idempotency',value:{scope,frozen}});await authorize(c,{});const r=await action(c);if(failCommit)throw Error('SYNTHETIC_COMMIT_RESPONSE_UNKNOWN');res.status(r.status).json(r.body);});
 const req=(realm='user',path='order_1/prestart-termination',method='GET',data:any={})=>({method,originalUrl:`/api/v1/${realm==='admin'?'admin/':''}orders/${path}`,
  headers:{origin:realm==='admin'?options.adminOrigin:options.userOrigin,'idempotency-key':'original_1'},body:data}) as any;
 return{seen,c,options,response,req,status:()=>status,body:()=>body,unknown(){failCommit=true;}};
}
test('GET只做本人/管理读取事务，明确RR READ ONLY；不进入命令',async t=>{
 const f=fixture(t);await handlePrestartTerminationRoute(f.req(),f.response,f.options,'user');
 assert.equal(f.status(),200);assert.equal(f.seen[0]?.action,'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 assert.equal(f.seen.some(s=>s.action==='idempotency'),false);
 assert.equal(await handlePrestartTerminationRoute(f.req('user','order_1/prestart-termination/term/review','POST'),f.response,f.options,'user'),false);
});
test('模拟环境沿用服务端身份和同一资源处理未开租申请、审核及只读查询',async t=>{
 const f=fixture(t),demo={kind:'SYNTHETIC_DEMO_RESOURCE'};
 f.options.ecsTestDemo=demo;f.options.pool.options={database:'zzsh_ecs_test',user:'zzsh_ecs_runtime'};
 await handlePrestartTerminationRoute(f.req(),f.response,f.options,'user');
 const reader=f.seen.find(s=>s.action==='read')?.value.actor;
 assert.equal(reader.ecsTestDemo,demo);assert.deepEqual(reader.settlementReadIdentity,{database:'zzsh_ecs_test',runtimeUser:'zzsh_ecs_runtime'});
 await handlePrestartTerminationRoute(f.req('user','order_1/prestart-termination/requests','POST',{expectedOrderRevision:'1',reason:'未开租取消'}),f.response,f.options,'user');
 assert.equal(f.seen.find(s=>s.action==='request')?.value.actor.ecsTestDemo,demo);
 await handlePrestartTerminationRoute(f.req('admin','order_1/prestart-termination/term_1/review','POST',{expectedRevision:'1',decision:'APPROVE',assessment:'NO_USE_NO_DISPUTE',reason:'核实无争议'}),f.response,f.options,'admin');
 assert.equal(f.seen.find(s=>s.action==='review')?.value.actor.ecsTestDemo,demo);
});
test('申请/审核锁定幂等scope与原body；不收客户端金额、目标或供应商状态',async t=>{
 const f=fixture(t);
 await handlePrestartTerminationRoute(f.req('user','order_1/prestart-termination/requests','POST',{expectedOrderRevision:'1',reason:'未交付申请结束'}),f.response,f.options,'user');
 assert.deepEqual(f.seen.find(s=>s.action==='idempotency')?.value.scope,{principalId:'renter_1',operation:'order.prestart.request',resourceId:'order_1'});
 await handlePrestartTerminationRoute(f.req('admin','order_1/prestart-termination/term_1/review','POST',{expectedRevision:'1',decision:'APPROVE',assessment:'NO_USE_NO_DISPUTE',reason:'核实无交付无争议'}),f.response,f.options,'admin');
 assert(f.seen.some(s=>s.action==='review'));
 await assert.rejects(handlePrestartTerminationRoute(f.req('user','order_1/prestart-termination/requests','POST',{expectedOrderRevision:'1',reason:'申请未交付',amountCents:'1'}),f.response,f.options,'user'),(e:any)=>e.status===400);
});
test('领域完成后COMMIT响应未知返回202原键恢复；Origin/GET query先拒绝',async t=>{
 const f=fixture(t);f.unknown();await handlePrestartTerminationRoute(f.req('user','order_1/prestart-termination/requests','POST',{expectedOrderRevision:'1',reason:'未交付申请结束'}),f.response,f.options,'user');
 assert.equal(f.status(),202);assert.equal(f.body().outcome,'UNKNOWN');assert.equal(f.body().originalKeyRequired,true);assert.equal(f.body().bankArrival,'UNKNOWN');
 const cross=f.req();cross.headers.origin='https://other.invalid';await assert.rejects(handlePrestartTerminationRoute(cross,f.response,f.options,'user'),(e:any)=>e.status===403);
 await assert.rejects(handlePrestartTerminationRoute(f.req('user','order_1/prestart-termination?query=channel'),f.response,f.options,'user'),(e:any)=>e.status===400);
});
test('异常原款入口已停用；未开租退款仍绑定原对象且拒绝额外金额',async t=>{
 const f=fixture(t);const calls:any[]=[];
 t.mock.method(refunds,'requestAdminPrestartNativeRefund',async(_p:any,_e:any,v:any)=>{calls.push(v);return{outcome:'ALLOCATED'} as any;});
 assert.equal(await handleAdminNativeRefundRoute(f.req('admin','order_1/refunds/abnormal','POST',{confirmationId:'pc_1',reason:'核实迟到原款'}),f.response,f.options,'/api/v1/admin/orders',{pool:{} as any}),false);
 assert.equal(calls.length,0);
 await handleAdminNativeRefundRoute(f.req('admin','order_1/prestart-termination/term_1/refund-requests','POST'),f.response,f.options,'/api/v1/admin/orders',{pool:{} as any});
 assert.equal(calls[0].terminationId,'term_1');assert.equal(calls[0].idempotencyKey,'original_1');
 await handleAdminNativeRefundRoute(f.req('admin','order_1/prestart-termination/term_1/refund-requests','POST',{amountCents:'1'}),f.response,f.options,'/api/v1/admin/orders',{pool:{} as any});assert.equal(f.status(),400);assert.equal(calls.length,1);
 assert.equal(await handleAdminNativeRefundRoute(f.req('admin','order_1/refunds/abnormal','GET'),f.response,f.options,'/api/v1/admin/orders',{pool:{} as any}),false);
});
