import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import type {INestApplication} from '@nestjs/common';
import type {AuthSecurityOptions} from '../src/auth/auth-security';
import {SecurityApiError} from '../src/auth/security-core';
import {mountLocalFinancialSandboxRoutes} from '../src/finance/local-financial-sandbox-routes';
import {createLocalSandboxCheckoutSigner,signLocalSandboxCheckout} from '../src/order/local-sandbox-checkout-crypto';
import {renderLocalSandboxCheckoutPage} from '../src/order/local-sandbox-checkout-page';
import {localFinancialSandboxRegistration,verifyDailyRestoreProof} from '../src/finance/local-financial-sandbox-resource';
import {createLocalFinancialSandboxRuntime,assertLocalFinancialSandboxRuntimeAssembly,preflightLocalFinancialSandboxRuntime} from '../src/finance/local-financial-sandbox-runtime';
import type {PaymentDistributionStore} from '../src/finance/distribution-payment-store';
import {sandboxFixture,sandboxOrigins,sandboxConfig,sandboxResource,restoreDocument,digest} from './local-financial-sandbox-fixture';
const actor={userId:'user_fixture',sessionId:'session_fixture'},orderId='order_fixture';
function mounted(){
 const sandbox=sandboxFixture(),signer=createLocalSandboxCheckoutSigner(sandbox,Buffer.alloc(32,7)),routes=new Map<string,Function>();
 const checkout={sandbox,signer,appId:'app',distribution:{} as PaymentDistributionStore};
 const security={...sandboxOrigins,pool:{}} as AuthSecurityOptions&{secureCookies:boolean};
 const app={getHttpAdapter:()=>({getInstance:()=>({use:(prefix:string,handler:Function)=>routes.set(prefix,handler)})})} as unknown as INestApplication;
 mountLocalFinancialSandboxRoutes(app,security,checkout);
 const response=()=>({code:0,body:null as unknown,headers:{} as Record<string,string|string[]>,headersSent:false,
  status(code:number){this.code=code;return this;},setHeader(name:string,value:string|string[]){this.headers[name]=value;return this;},
  json(body:unknown){this.body=body;this.headersSent=true;},send(body:string){this.body=body;this.headersSent=true;}});
 const invoke=async(prefix:string,path:string,method='GET',headers:Record<string,string|string[]|undefined>={},body:unknown={})=>{
  const r=response();await routes.get(prefix)!({method,url:path,originalUrl:prefix+path,headers,body},r,()=>{throw Error('Unexpected next in local route fixture');});return r;
 };
 return{sandbox,checkout,security,invoke};
}
function authMock(t:TestContext){
 const user=require('../src/auth/user-identity');
 t.mock.method(user,'readUserContext',async(request:any)=>{if(request.headers.cookie!=='synthetic=1')throw new SecurityApiError(401,'UNAUTHENTICATED','Synthetic authentication required');return actor;});
}

test('branded runtime bundle rejects field copies/formal providers and never installs a policy, identity, origin or maintenance timer',()=>{
 const bytes=Buffer.from(JSON.stringify(restoreDocument)),input={config:sandboxConfig,resource:sandboxResource,origins:sandboxOrigins,
  restoreProof:verifyDailyRestoreProof(bytes,digest(bytes)),reference:'runtime_fixture',approvedByAdminId:'boss_fixture',appId:'app',checkoutSigningKey:Buffer.alloc(32,7)};
 const bundle=createLocalFinancialSandboxRuntime(input),options={...bundle.auth,...sandboxOrigins};
 assertLocalFinancialSandboxRuntimeAssembly(bundle.auth.localFinancialSandbox,options);
 assert.throws(()=>assertLocalFinancialSandboxRuntimeAssembly({...bundle.auth.localFinancialSandbox},options));
 for(const extra of [{joinpayCollection:{}},{joinpayRefund:{}},{joinpayWithdrawal:{}},{joinpayAccountObservation:{}},{localControlledPayments:{}},{nativeWithdrawalScope:undefined}])
  assert.throws(()=>assertLocalFinancialSandboxRuntimeAssembly(bundle.auth.localFinancialSandbox,{...options,...extra}));
 assert(!Object.hasOwn(bundle.auth,'nativeWalletOrigin'));assert(!Object.hasOwn(bundle.auth,'localControlledPayments'));
 assert(!Object.hasOwn(bundle.auth,'joinpayCollection'));assert(Object.isFrozen(bundle.auth.localFinancialSandbox));
 assert.throws(()=>createLocalFinancialSandboxRuntime({...input,config:{...sandboxConfig,profile:'production'}} as typeof input));
});

test('actual API/BFF mounts require authentication/exact single Origin, reject duplicate keys and unsigned amount/outcome fields',async t=>{
 authMock(t);const f=mounted(),service=require('../src/order/local-sandbox-checkout-service');let issued=0,completed=0;
 t.mock.method(service,'issueLocalSandboxCheckout',async()=>{issued++;return{status:200,body:{scope:'LOCAL_CONTROLLED'},replayed:false};});
 t.mock.method(service,'completeLocalSandboxCheckout',async()=>{completed++;return{status:200,body:{scope:'LOCAL_CONTROLLED'},replayed:false};});
 for(const prefix of ['/api/v1/orders','/api/bff/user/orders']){
  const path=`/${orderId}/local-checkouts`,valid={origin:sandboxOrigins.userOrigin,cookie:'synthetic=1','idempotency-key':'synthetic-issue-key'};
  assert.equal((await f.invoke(prefix,path,'POST',{origin:valid.origin,'idempotency-key':valid['idempotency-key']})).code,401);
  assert.equal((await f.invoke(prefix,path,'POST',{...valid,origin:'http://127.0.0.1:9999'})).code,403);
  assert.equal((await f.invoke(prefix,path,'POST',{...valid,origin:[valid.origin,valid.origin]})).code,403);
  assert.equal((await f.invoke(prefix,path,'POST',{...valid,'idempotency-key':['one','two']})).code,400);
  assert.equal((await f.invoke(prefix,path,'POST',valid,{amountCents:'1'})).code,400);
  assert.equal((await f.invoke(prefix,path+'/complete','POST',valid,{token:'synthetic-ticket',outcome:'SUCCEEDED'})).code,400);
  assert.equal((await f.invoke(prefix,path,'POST',valid)).code,200);
 }
 assert.equal(issued,2);assert.equal(completed,0);
});

test('local availability GET only reads the authenticated original order and does not issue or complete payment',async t=>{
 authMock(t);const f=mounted(),service=require('../src/order/local-sandbox-checkout-service');let reads=0;
 t.mock.method(service,'readLocalSandboxCheckoutAvailability',async()=>{reads++;return{contractVersion:'local-sandbox-checkout-availability.v1',checkoutEnabled:true,productionPaymentCapability:false};});
 t.mock.method(service,'issueLocalSandboxCheckout',async()=>{throw Error('GET may not issue');});
 t.mock.method(service,'completeLocalSandboxCheckout',async()=>{throw Error('GET may not complete');});
 const headers={origin:sandboxOrigins.userOrigin,cookie:'synthetic=1'};
 assert.equal((await f.invoke('/api/v1/orders',`/${orderId}/local-checkouts`,'GET',headers)).code,200);assert.equal(reads,1);
 assert.equal((await f.invoke('/api/v1/orders',`/${orderId}/local-checkouts?outcome=SUCCEEDED`,'GET',headers)).code,400);assert.equal(reads,1);
});

test('startup checks the complete local schema and rejects missing guards without installing objects',async()=>{
 const bytes=Buffer.from(JSON.stringify(restoreDocument)),input={config:sandboxConfig,resource:sandboxResource,origins:sandboxOrigins,
  restoreProof:verifyDailyRestoreProof(bytes,digest(bytes)),reference:'synthetic_daily_sandbox',approvedByAdminId:'boss_fixture',appId:'app',checkoutSigningKey:Buffer.alloc(32,7)};
 const bundle=createLocalFinancialSandboxRuntime(input),base=require('./local-financial-sandbox-fixture').sandboxClient(bundle.auth.localFinancialSandbox.sandbox);
 let ready=true;const calls:string[]=[];const pool={connect:async()=>({release(){},query:async(sql:string,args:any[])=>{
  calls.push(sql);if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
  if(sql.startsWith('WITH expected('))return{rows:[{ready}]};return base.query(sql,args);
 }})} as unknown as import('pg').Pool;
 await preflightLocalFinancialSandboxRuntime(pool,bundle.auth.localFinancialSandbox);
 ready=false;await assert.rejects(preflightLocalFinancialSandboxRuntime(pool,bundle.auth.localFinancialSandbox));
 assert(!calls.some(sql=>/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(sql)));
});

test('provider page GET reads only original receipts; page token stays out of URL and uses CSP/no-store without automatic completion',async t=>{
 authMock(t);const f=mounted(),service=require('../src/order/local-sandbox-checkout-service'),proof=localFinancialSandboxRegistration(f.sandbox);
 const token=signLocalSandboxCheckout(f.checkout.signer,{schema:'local-sandbox-checkout.v1',sandboxDigest:proof.digest,checkoutId:'checkout_fixture',
  userId:actor.userId,sessionHash:createHash('sha256').update(actor.sessionId).digest('hex'),orderId,displayNo:'ZZ_TEST_FIXTURE',amountCents:'200',currency:'CNY',
  orderCreatedAt:'2026-11-02T10:00:00.000Z',issuedAt:'2026-11-02T10:01:00.000Z',expiresAt:'2026-11-02T10:03:00.000Z'});
 const calls:string[]=[];let post=0;
 t.mock.method(service,'readLocalSandboxCheckoutReceipt',async(_pool:any,_actor:any,_id:any,operation:string)=>{
  calls.push(operation);return operation==='ISSUE'?{knowledge:'KNOWN',writeAssemblyReady:true,observedAt:'2026-11-02T10:02:00.000Z',receipt:{contractVersion:'local-sandbox-checkout.v1',scope:'LOCAL_CONTROLLED',productionPaymentCapability:false,
   checkout:{displayNo:'ZZ_TEST_FIXTURE',ticket:token,completeKey:'synthetic-complete-key',amount:{cents:'200',currency:'CNY'},expiresAt:'2026-11-02T10:03:00.000Z'}}}
   :{knowledge:'UNKNOWN',receipt:null};
 });
 t.mock.method(service,'completeLocalSandboxCheckout',async()=>{post++;throw Error('GET may not complete');});
 const r=await f.invoke('/api/v1/orders',`/${orderId}/local-checkouts/page?key=synthetic-issue-key`,'GET',{cookie:'synthetic=1'});
 assert.equal(r.code,200);assert.equal(r.headers['Cache-Control'],'no-store');assert(String(r.headers['Content-Security-Policy']).includes("frame-ancestors 'none'"));
 assert(typeof r.body==='string');assert(r.body.includes('¥2.00'));assert(r.body.includes('本地模拟付款'));assert(r.body.includes('不会向银行或支付机构发起真实支付'));
 assert(!/href="[^"]*token=/.test(r.body));assert.deepEqual(calls,['ISSUE','COMPLETE']);assert.equal(post,0);
 const result=await f.invoke('/api/bff/user/orders',`/${orderId}/local-checkouts/complete/receipt?key=synthetic-complete-key`,'GET',{cookie:'synthetic=1',origin:sandboxOrigins.userOrigin});
 assert.equal(result.code,200);assert.equal(calls.at(-1),'COMPLETE');assert.equal(post,0);
});

test('local utility page escapes original labels and rejects non-loopback return navigation',()=>{
 const input={nonce:'synthetic_nonce_1234567890',displayNo:'<script>synthetic</script>',amountCents:'200',expiresAt:'2026-11-02T10:03:00.000Z',ticket:'synthetic.ticket',completeKey:'synthetic-key',
  completePath:'/api/v1/orders/order_fixture/local-checkouts/complete',returnUrl:'http://127.0.0.1:4220/account?view=rentals',accepted:false,canComplete:true};
 const html=renderLocalSandboxCheckoutPage(input);assert(!html.includes(input.displayNo));assert(html.includes('&lt;script&gt;'));
 assert.throws(()=>renderLocalSandboxCheckoutPage({...input,returnUrl:'https://example.invalid/account'}));
 assert.throws(()=>renderLocalSandboxCheckoutPage({...input,returnUrl:'javascript:alert(1)'}));
});
