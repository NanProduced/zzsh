import assert from "node:assert/strict";
import { test } from "node:test";

const { formatOrderMoney, formatOrderTime, mergeOrderItems, orderApi, OrderRequestError } = await import("../src/lib/order-client.ts");

test("order times use the declared timezone and refuse missing or invalid dates", () => {
  assert.match(formatOrderTime("2026-10-01T00:30:00Z"), /08:30/);
  assert.match(formatOrderTime("2026-10-01T00:30:00Z"), /GMT\+08:00/);
  assert.equal(formatOrderTime(undefined), "待确认");
  assert.equal(formatOrderTime("not-a-date"), "待确认");
});

test("money rendering preserves zero and refuses unknown values", () => {
  assert.equal(formatOrderMoney({ amount: "0.00", currency: "CNY" }), "0.00 元");
  assert.equal(formatOrderMoney({ amount: "12.3", currency: "CNY" }), "待确认");
  assert.equal(formatOrderMoney({ amount: "12.30" }), "待确认");
  assert.equal(formatOrderMoney(null), "待确认");
  assert.equal(formatOrderMoney({ amount: "12345678901234567890.01", currency: "CNY" }), "12,345,678,901,234,567,890.01 元");
});

test("cursor pages append by id while accepting the newest projection", () => {
  assert.deepEqual(mergeOrderItems([{ id: "a", status: "PAID" }, { id: "b", status: "CANCELLED" }], [{ id: "b", status: "COMPLETED" }, { id: "c", status: "PAID" }]).map((item) => [item.id, item.status]), [["a", "PAID"], ["b", "COMPLETED"], ["c", "PAID"]]);
});

test("order read client keeps party, filters, cursor, and same-origin no-store GETs", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({ items: [], nextCursor: "cursor-next", limit: 3 });
  };
  try {
    const page = await orderApi.list({ party: "owner", status: "PAID", accountId: "acct_1", limit: 3, cursor: "cursor-1" });
    assert.equal(page.nextCursor, "cursor-next");
    assert.equal(requests[0].input, "/api/orders?party=owner&limit=3&status=PAID&accountId=acct_1&cursor=cursor-1");
    assert.equal(requests[0].init.method, undefined);
    assert.equal(requests[0].init.credentials, "same-origin");
    assert.equal(requests[0].init.cache, "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("order detail unwraps the read envelope and encodes the id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/orders/order%2Fprivate");
    return Response.json({ order: { id: "order/private", status: "COMPLETED" } });
  };
  try {
    assert.deepEqual(await orderApi.detail("order/private"), { id: "order/private", status: "COMPLETED" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read failures preserve status and API error code without exposing write recovery", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: "CONFLICT", message: "cursor changed" } }, { status: 409 });
  try {
    await assert.rejects(() => orderApi.list({ party: "renter" }), (error) => {
      assert.ok(error instanceof OrderRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "CONFLICT");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("historical order client uses independent read routes and keeps failures visible", async () => {
  const old = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url:String(url), init }); return Response.json(String(url).includes("legacy_order") ? {order:{id:"legacy_order_a",readOnly:true}} : {items:[],page:2,pageSize:3,total:0}); };
  try {
    assert.equal((await orderApi.listLegacy({party:"owner",page:2,pageSize:3,status:"UNKNOWN"})).total,0);
    assert.equal(calls[0].url,"/api/orders/legacy?party=owner&page=2&pageSize=3&status=UNKNOWN");assert.equal(calls[0].init.cache,"no-store");assert.equal(calls[0].init.credentials,"same-origin");
    assert.equal((await orderApi.legacyDetail("legacy_order_a")).readOnly,true);
    globalThis.fetch = async () => Response.json({error:{code:"NOT_FOUND",message:"未找到"}},{status:404});
    await assert.rejects(()=>orderApi.legacyDetail("legacy_order_other"),e=>e instanceof OrderRequestError && e.status===404);
  } finally { globalThis.fetch=old; }
});

test("unified browsing has its own read endpoint and never changes native recovery reads", async () => {
 const before=globalThis.fetch;const calls=[];
 globalThis.fetch=async url=>{calls.push(String(url));return Response.json({items:[],nextCursor:null,limit:20});};
 try{await orderApi.listUnified({party:"renter"});await orderApi.list({party:"renter"});assert.deepEqual(calls,["/api/orders/unified?party=renter&limit=20","/api/orders?party=renter&limit=20"]);}finally{globalThis.fetch=before;}
});
test("order pagination retains equal ids from different internal sources", () => {
 const current={id:"same",source:{origin:"NATIVE"}},old={id:"same",source:{origin:"LEGACY"},readOnly:true};
 assert.equal(mergeOrderItems([current],[old]).length,2);
 assert.equal(mergeOrderItems([current,old],[{...old,title:"updated"}]).length,2);
});

test("channel payment client reads the separate contract and preserves absent payment/action/amount",async()=>{
 const before=globalThis.fetch;let seen;
 const view={contractVersion:"order-payment-request.v1",dataOrigin:"JOINPAY_CANDIDATE",request:{id:"request_1",state:"UNKNOWN",amount:null},paymentAction:null,payment:null};
 globalThis.fetch=async(url,init)=>{seen={url:String(url),init};return Response.json(view);};
 try{
  assert.deepEqual(await orderApi.channelPaymentStatus("user_a","order/private"),view);
  assert.equal(seen.url,"/api/orders/order%2Fprivate/channel-payment-requests");assert.equal(seen.init.cache,"no-store");assert.equal(seen.init.credentials,"same-origin");
 }finally{globalThis.fetch=before;}
});

test("channel POST sends only the selected Native method and original key, without replacing the controlled entry",async()=>{
 const before=globalThis.fetch;const seen=[];
 const receipt={contractVersion:"order-payment-request.v1",replay:true,request:{id:"request_1",state:"UNKNOWN"},paymentAction:null,payment:null};
 globalThis.fetch=async(url,init)=>{seen.push({url:String(url),init});return Response.json(receipt,{status:202});};
 try{
  assert.deepEqual(await orderApi.requestChannelPayment("user_a","order_1","WEIXIN_NATIVE","frozen-channel-key"),receipt);
  assert.equal(seen[0].url,"/api/orders/order_1/channel-payment-requests");assert.equal(seen[0].init.method,"POST");
  assert.equal(new Headers(seen[0].init.headers).get("idempotency-key"),"frozen-channel-key");assert.deepEqual(JSON.parse(seen[0].init.body),{method:"WEIXIN_NATIVE"});
  await orderApi.pay("order_1","original-controlled-key");assert.equal(seen[1].url,"/api/orders/order_1/payment-requests");assert.deepEqual(JSON.parse(seen[1].init.body),{});
 }finally{globalThis.fetch=before;}
});

test("channel failure keeps the API error and never falls back to a controlled payment or new request",async()=>{
 const before=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url)=>{calls.push(String(url));return Response.json({error:{code:"PAYMENT_CHANNEL_NOT_ENABLED",message:"not enabled",requestId:"req_channel"}},{status:503});};
 try{
  await assert.rejects(()=>orderApi.requestChannelPayment("user_a","order_1","ALIPAY_NATIVE","same-key"),e=>e instanceof OrderRequestError&&e.status===503&&e.code==="PAYMENT_CHANNEL_NOT_ENABLED");
  assert.deepEqual(calls,["/api/orders/order_1/channel-payment-requests"]);
 }finally{globalThis.fetch=before;}
});

test('channel client supplies expected subject for both local read and command without changing business body',async()=>{const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({request:null});};try{await orderApi.channelPaymentStatus('user_a','order_subject');await orderApi.requestChannelPayment('user_a','order_subject','WEIXIN_NATIVE','original_subject_key');assert.equal(calls.length,2);for(const c of calls){assert.match(c.url,/order_subject\/channel-payment-requests$/);assert.equal(new Headers(c.init.headers).get('x-zzsh-expected-user-id'),'user_a');}assert.equal(calls[1].init.body,'{"method":"WEIXIN_NATIVE"}');assert.equal(new Headers(calls[1].init.headers).get('idempotency-key'),'original_subject_key');}finally{globalThis.fetch=old;}});
