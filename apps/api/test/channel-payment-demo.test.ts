import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { AuthSecurityOptions } from "../src/auth/auth-security";
import type { SupplyNodeRequest } from "../src/supply/supply-util";
import type { SupplyResponse } from "../src/supply/supply-routes";
import { SecurityApiError } from "../src/auth/security-core";
import { handleChannelPaymentRoute, type ChannelPaymentCollectionAssembly } from "../src/order/channel-payment-routes";

test("test cashier uses the channel request endpoint without enabling a real provider", async t=>{
  const identity:typeof import('../src/auth/user-identity')=require('../src/auth/user-identity');
  const order:typeof import('../src/order/order')=require('../src/order/order');
  const read:typeof import('../src/order/channel-payment-read')=require('../src/order/channel-payment-read');
  const checkout:typeof import('../src/order/ecs-demo-checkout-service')=require('../src/order/ecs-demo-checkout-service');
  const store:typeof import('../src/order/channel-payment-store')=require('../src/order/channel-payment-store');
  const policy:typeof import('../src/finance/distribution-policy-store')=require('../src/finance/distribution-policy-store');
  const capability=Object.freeze({evidenceLevel:'CONTROLLED_TEST' as const});let created=false,marks=0,mismatched=false;
  t.mock.method(identity,'readUserContext',async()=>({userId:'renter',sessionId:'session'}));
  t.mock.method(order,'assertReplayAuthorization',async()=>{});
  t.mock.method(policy,'readDistributionPolicyRowInTransaction',async()=>({knowledge:'KNOWN',policy:{} as never}));
  t.mock.method(checkout,'readEcsDemoCheckoutAvailability',async()=>({contractVersion:'ecs-test-checkout-availability.v1',scope:'ECS_TEST_SIMULATED',orderId:'order_1',observedAt:'2026-11-08T00:00:00.000Z',checkoutEnabled:true,productionPaymentCapability:false,bankArrival:'UNKNOWN'}));
  t.mock.method(read,'readChannelPaymentRequest',async()=>({available:true,view:{contractVersion:'order-payment-request.v1',dataOrigin:created?'LOCAL_CONTROLLED':'SYNTHETIC_PROTOCOL',capability:{channelEnabled:false,methods:['ALIPAY_NATIVE','WEIXIN_NATIVE'],evidenceProfile:'JOINPAY_AGG_2_6_MD5',productionPaymentCapability:false},order:{id:'order_1',displayNo:'ZZ-1',status:'PENDING_PAYMENT',paidAt:null},request:created?{id:'payreq_1',state:'ACTION_READY',method:'WEIXIN_NATIVE',amount:{cents:'125',currency:'CNY'},updatedAt:'2026-11-08T00:00:00.000Z',recovery:null}:null,projection:{displayState:'AWAITING_PAYMENT',actionBlockedReason:'ACTION_PARAMS_UNAVAILABLE'},paymentAction:null,payment:null}}));
  t.mock.method(store,'createPaymentRequest',async(...[_c,input]:Parameters<typeof store.createPaymentRequest>)=>{
    if(input.capability!==capability)throw Object.assign(new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','closed'),{paymentReason:'PAYMENT_CHANNEL_NOT_ENABLED'});
    assert.equal(input.method,'WEIXIN_NATIVE');created=true;
    return {status:202,replayed:false,body:{requestId:'payreq_1',orderId:'order_1',channel:'CONTROLLED',channelOrderNo:'ZZ-1',amountCents:'125',wireAmountYuan:'1.25',method:'WEIXIN_NATIVE',state:'SUBMITTING',existing:false,currency:'CNY',evidenceLevel:'CONTROLLED_TEST',createdAt:'2026-11-08T00:00:00.000Z',updatedAt:'2026-11-08T00:00:00.000Z'}};
  });
  t.mock.method(store,'readDemoPaymentRequestMatch',async()=>mismatched?false:created?true:null);
  t.mock.method(store,'markDemoPaymentActionReady',async(...[_c,input]:Parameters<typeof store.markDemoPaymentActionReady>)=>{assert.equal(input.capability,capability);marks++;});
  const pool={connect:async()=>({release(){},query:async(sql:string)=>sql.startsWith('SELECT evidence_level FROM zzsh_order.payment_request')?{rows:created?[{evidence_level:'CONTROLLED_TEST'}]:[]}:{rows:[]}})} as unknown as Pool;
  const security={pool,userOrigin:'https://user.example.test'} as AuthSecurityOptions;
  const assembly={demo:{demo:{} as never,appId:'test_app',distribution:{} as never,capability}} as ChannelPaymentCollectionAssembly;
  const invoke=async(method:string,options:ChannelPaymentCollectionAssembly|undefined=assembly)=>{
    const out={code:0,body:null as any,setHeader(){return this;},status(code:number){this.code=code;return this;},json(value:unknown){this.body=value;return this;}};
    await handleChannelPaymentRoute({method,originalUrl:'/api/v1/orders/order_1/channel-payment-requests',headers:{origin:'https://user.example.test','idempotency-key':'original_key'},body:{method:'WEIXIN_NATIVE'}} as unknown as SupplyNodeRequest,out as unknown as SupplyResponse,security,'/api/v1/orders',options);
    return out;
  };
  const before=await invoke('GET');assert.equal(before.body.dataOrigin,'LOCAL_CONTROLLED');assert.equal(before.body.capability.evidenceProfile,'CONTROLLED_TEST');assert.equal(before.body.capability.productionPaymentCapability,false);assert.equal(before.body.paymentAction,null);
  const posted=await invoke('POST');assert.equal(posted.code,202);assert.equal(posted.body.dataOrigin,'LOCAL_CONTROLLED');assert.equal(marks,1);
  const after=await invoke('GET');assert.deepEqual(after.body.paymentAction,{kind:'TEST_CASHIER',scope:'ECS_TEST_SIMULATED'});assert.equal(after.body.capability.productionPaymentCapability,false);
  mismatched=true;const other=await invoke('GET');assert.equal(other.body.paymentAction,null);assert.equal(other.body.capability.channelEnabled,false);
  const mixed=await invoke('POST',{...assembly,initial:{} as never});assert.equal(mixed.code,503);assert.equal(marks,1);
});
