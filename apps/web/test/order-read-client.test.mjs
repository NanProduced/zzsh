import assert from "node:assert/strict";
import { test } from "node:test";

const { formatOrderMoney, formatOrderTime, mergeOrderItems, orderApi, OrderRequestError } = await import("../src/lib/order-client.ts");
const { registerOrderExpectedUserId, captureOrderSubject, isOrderSubjectCurrent } = await import("../src/lib/order-subject.ts");
const SUBJECT_A = captureOrderSubject("user_a", 1);

test("order times use the declared timezone and refuse missing or invalid dates", () => {
  assert.match(formatOrderTime("2026-10-01T00:30:00Z"), /08:30/);
  assert.match(formatOrderTime("2026-10-01T00:30:00Z"), /GMT\+08:00/);
  assert.equal(formatOrderTime(undefined), "未记录");
  assert.equal(formatOrderTime("not-a-date"), "未记录");
});

test("money rendering preserves zero and refuses unknown values", () => {
  assert.equal(formatOrderMoney({ amount: "0.00", currency: "CNY" }), "0.00 元");
  assert.equal(formatOrderMoney({ amount: "12.3", currency: "CNY" }), "未记录");
  assert.equal(formatOrderMoney({ amount: "12.30" }), "未记录");
  assert.equal(formatOrderMoney(null), "未记录");
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
    const page = await orderApi.list(SUBJECT_A, { party: "owner", status: "PAID", accountId: "acct_1", limit: 3, cursor: "cursor-1" });
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
    assert.deepEqual(await orderApi.detail(SUBJECT_A, "order/private"), { id: "order/private", status: "COMPLETED" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read failures preserve status and API error code without exposing write recovery", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { code: "CONFLICT", message: "cursor changed" } }, { status: 409 });
  try {
    await assert.rejects(() => orderApi.list(SUBJECT_A, { party: "renter" }), (error) => {
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
    assert.equal((await orderApi.listLegacy(SUBJECT_A,{party:"owner",page:2,pageSize:3,status:"UNKNOWN"})).total,0);
    assert.equal(calls[0].url,"/api/orders/legacy?party=owner&page=2&pageSize=3&status=UNKNOWN");assert.equal(calls[0].init.cache,"no-store");assert.equal(calls[0].init.credentials,"same-origin");
    assert.equal((await orderApi.legacyDetail(SUBJECT_A,"legacy_order_a")).readOnly,true);
    globalThis.fetch = async () => Response.json({error:{code:"NOT_FOUND",message:"未找到"}},{status:404});
    await assert.rejects(()=>orderApi.legacyDetail(SUBJECT_A,"legacy_order_other"),e=>e instanceof OrderRequestError && e.status===404);
  } finally { globalThis.fetch=old; }
});

test("unified browsing has its own read endpoint and every order read carries its explicitly captured subject", async () => {
 const before=globalThis.fetch;const calls=[];
 const subject = captureOrderSubject("user_page", 3);
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({items:[],nextCursor:null,limit:20});};
 try{await orderApi.listUnified("user_a",{party:"renter"});await orderApi.list(subject,{party:"renter"});assert.deepEqual(calls.map(call=>call.url),["/api/orders/unified?party=renter&limit=20","/api/orders?party=renter&limit=20"]);assert.equal(new Headers(calls[0].init.headers).get("x-zzsh-expected-user-id"),"user_a","an explicit per-call subject wins");assert.equal(new Headers(calls[1].init.headers).get("x-zzsh-expected-user-id"),"user_page","a frozen subject object is sent as its userId");}finally{globalThis.fetch=before;}
});

test("an order request without a frozen subject is refused before any fetch", async () => {
 const before=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({ok:true});};
 try{
  registerOrderExpectedUserId("user_page"); // deliberately inert: a later registration is not a subject
  await assert.rejects(()=>orderApi.confirmOpening(undefined,"order_1","opening_1",1,"original_key"),e=>e instanceof OrderRequestError && e.status===401 && e.code==="ORDER_SUBJECT_NOT_FROZEN");
  assert.equal(calls,0,"no unbound order request may reach the BFF");
 }finally{globalThis.fetch=before;registerOrderExpectedUserId(null);}
});

test("non-order endpoints keep their own contracts and never receive the order identity header",async()=>{
 const before=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({ok:true});};
 try{
  await orderApi.previewRentalPrice({accountId:"a",versionId:"v",releaseId:"r"});
  await orderApi.confirmRental({accountId:"a",versionId:"v",releaseId:"r"});
  await orderApi.createOrder("signed-token","original_key");
  assert.deepEqual(calls.map(call=>call.url),["/api/rental-price-preview?accountId=a&versionId=v&releaseId=r","/api/order-confirmations","/api/v2/orders"]);
  for(const call of calls)assert.equal(new Headers(call.init.headers).has("x-zzsh-expected-user-id"),false);
 }finally{globalThis.fetch=before;}
});

test("a frozen subject is never re-derived from a later registration, including A→B→A",async()=>{
 const before=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json(String(url).includes('/openings/')?{orderId:'order_1',openings:[{id:'opening_1',versionNo:1}]}:{ok:true});};
 try{
  const frozenA = captureOrderSubject("user_a", 1);
  registerOrderExpectedUserId("user_b");
  await orderApi.detail(frozenA,"order_1");
  await orderApi.settlement(frozenA,"order_1");
  await orderApi.settlementPreview(frozenA,"order_1",{lines:[]});
  await orderApi.submitSettlement(frozenA,"order_1",{lines:[],acceptedHash:"hash_1"},"key_1");
  await orderApi.decideSettlement(frozenA,"order_1","version_1",{action:"CONFIRM",versionHash:"hash_1"},"key_2");
  await orderApi.confirmOpening(frozenA,"order_1","opening_1",1,"key_3");
  assert.equal(calls.length,6);
  for(const call of calls)assert.equal(new Headers(call.init.headers).get("x-zzsh-expected-user-id"),"user_a",call.url);
  assert.equal(isOrderSubjectCurrent(frozenA,{status:"authenticated",userId:"user_b",identityVersion:2}),false);
  registerOrderExpectedUserId("user_a");
  assert.equal(isOrderSubjectCurrent(frozenA,{status:"authenticated",userId:"user_a",identityVersion:1}),true);
  await orderApi.detail(frozenA,"order_1");
  assert.equal(new Headers(calls.at(-1).init.headers).get("x-zzsh-expected-user-id"),"user_a");
 }finally{globalThis.fetch=before;registerOrderExpectedUserId(null);}
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
  await orderApi.pay("user_a","order_1","original-controlled-key");assert.equal(seen[1].url,"/api/orders/order_1/payment-requests");assert.deepEqual(JSON.parse(seen[1].init.body),{});
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


/* --- Prestart Termination Client Rules --- */

// SYNTHETIC_READER_COMPONENT；读取合成DTO与内存HTTP，不是PG/渠道验收。
import {parsePrestartView,parsePrestartRefund,prestartApi} from '../src/lib/prestart-termination-client.ts';
const at='2026-10-28T00:00:00.000000Z';
const request={id:'term_1',revision:'2',state:'APPROVED',requestedByParty:'RENTER',reason:'申请未开租结束',reviewReason:'核实无争议',createdAt:at,updatedAt:at,approvedAt:at,
 fullRefundCents:'15908',currency:'CNY',dataOrigin:'JOINPAY_LOCAL_ACCEPTANCE',liabilityRecognized:true,channelSubmission:'NOT_REPORTED',bankArrival:'UNKNOWN'};
const refund={integration:'INTEGRATED',truncated:false,reason:null,channelRecordsChecked:false,bankArrival:'UNKNOWN',
 totals:{originalCents:'15908',allocatedCents:'15908',consumedCents:'0',releasedCents:'0',remainingCents:'0',totalsComplete:true},
 intents:[{intentId:'refund_1',refundOrderNo:'RF'+'a'.repeat(28),state:'UNKNOWN',amountCents:'15908',firstSubmit:'DISPATCHED',blockedReason:null,
  localWriteOff:'NOT_RECORDED',savedChannelEvidence:null,bankArrival:'UNKNOWN'}]};
const view=()=>({contractVersion:'order-prestart-termination.v1',orderId:'order_1',orderRevision:'2',eligibility:{allowed:false,reason:'ORDER_NOT_PAID',refundCents:null},
 request:{...request},refund:structuredClone(refund),coverage:'LOCAL_REGISTERED_ONLY',asOf:at,localAcceptanceObservedAt:at,unknowns:['BANK_ARRIVAL_NOT_VERIFIED'],bankArrival:'UNKNOWN'});
test('原责任、分配、核销、尚未分配与渠道/银行未知分开',()=>{
 const p=parsePrestartView(view(),'order_1');assert.equal(p.refund.totals.remainingCents,'0');assert.equal(p.refund.totals.consumedCents,'0');assert.equal(p.request.fullRefundCents,'15908');assert.equal(p.refund.intents[0].state,'UNKNOWN');assert.equal(p.bankArrival,'UNKNOWN');
 const cropped=view();cropped.request.fullRefundCents=null;cropped.refund.totals=null;cropped.refund.intents[0].amountCents=null;cropped.refund.intents[0].refundOrderNo=null;
 assert.equal(parsePrestartView(cropped,'order_1').request.fullRefundCents,null);
});
test('坏版本/对象/枚举/金额/时间、未认责任的APPROVED直接拒绝',()=>{
 for(const patch of [{contractVersion:'other'},{orderId:'other'},{bankArrival:'ARRIVED'},
  {request:{...request,state:['APPROVED']}},{request:{...request,liabilityRecognized:false}},
  {request:{...request,fullRefundCents:15908}},{request:{...request,approvedAt:null}}])assert.throws(()=>parsePrestartView({...view(),...patch},'order_1'));
});
test('取消原因采用服务端角色选项，缺少选项时不能误当作已配置',()=>{
 const options=[{code:'RENTER_WRONG_ACCOUNT',label:'选错账号'},{code:'OTHER',label:'其他'}];
 assert.deepEqual(parsePrestartView({...view(),cancellationReasons:options},'order_1').cancellationReasons,options);
 assert.deepEqual(parsePrestartView(view(),'order_1').cancellationReasons,[]);
 assert.throws(()=>parsePrestartView({...view(),cancellationReasons:[...options,options[0]]},'order_1'));
 assert.throws(()=>parsePrestartView({...view(),cancellationReasons:[{code:'bad/code',label:'坏选项'}]},'order_1'));
});
test('截断、冲突或未接入不能提供完整合计；分配含核销、remaining不是未到账',()=>{
 for(const patch of [{truncated:true},{integration:'UNAVAILABLE'},{totals:{...refund.totals,remainingCents:'15908'}},
  {totals:{...refund.totals,consumedCents:'15909'}},{intents:[{...refund.intents[0],firstSubmit:['DISPATCHED']}]}])assert.throws(()=>parsePrestartRefund({...refund,...patch}));
 const truncated=parsePrestartRefund({...refund,truncated:true,totals:null});assert.equal(truncated.totals,null);assert.equal(truncated.truncated,true);
});
test('保存的渠道成功仍保留未重验标签与银行UNKNOWN',()=>{
 const p=parsePrestartRefund({...refund,intents:[{...refund.intents[0],savedChannelEvidence:{terminal:'SUCCEEDED',channelRefundTrxNo:'trx_1',completedAt:at,observedAt:at,trust:'SAVED_EVIDENCE_NOT_REVALIDATED'}}]});
 assert.equal(p.intents[0].savedChannelEvidence.trust,'SAVED_EVIDENCE_NOT_REVALIDATED');assert.equal(p.bankArrival,'UNKNOWN');
 assert.throws(()=>parsePrestartRefund({...refund,intents:[{...refund.intents[0],savedChannelEvidence:{terminal:'SUCCEEDED',trust:'OFFICIAL_REVERIFIED'}}]}));
});
test('模拟退款只接受已证明的受控来源和演示范围',()=>{
 const p=view();p.request.dataOrigin='LOCAL_CONTROLLED';p.refund.dataOrigin='LOCAL_CONTROLLED';p.refund.simulationScope='ECS_TEST_SIMULATED';
 assert.equal(parsePrestartView(p,'order_1').refund.simulationScope,'ECS_TEST_SIMULATED');
 assert.throws(()=>parsePrestartView({...p,request:{...p.request,dataOrigin:'JOINPAY_LOCAL_ACCEPTANCE'}},'order_1'));
 assert.throws(()=>parsePrestartRefund({...p.refund,simulationScope:'OTHER'}));
 assert.throws(()=>parsePrestartRefund({...p.refund,simulationScope:['ECS_TEST_SIMULATED']}));
 assert.throws(()=>parsePrestartRefund({...p.refund,dataOrigin:'JOINPAY_PROVIDER'}));
 assert.equal(parsePrestartView(view(),'order_1').refund.simulationScope,undefined);
});
test('提交回执未知/无有效对象不能当成功；原key/body由调用方恢复',async()=>{
 const old=globalThis.fetch,calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({outcome:'UNKNOWN',originalKeyRequired:true},{status:202});};
 try{const body={expectedOrderRevision:'1',reason:'申请无交付结束'};
  await assert.rejects(prestartApi.request('renter_1','order_1','original_key',body));
  await assert.rejects(prestartApi.request('renter_1','order_1','original_key',body));
  assert.equal(calls[0].init.body,calls[1].init.body);assert.equal(new Headers(calls[0].init.headers).get('idempotency-key'),'original_key');
  assert.equal(new Headers(calls[0].init.headers).get('x-zzsh-expected-user-id'),'renter_1');
 }finally{globalThis.fetch=old;}
});


/* --- Personal Order Refund Client Rules --- */

import { parsePersonalRefunds } from "../src/lib/order-client.ts";

const intent = (over = {}) => ({
  intentId: "intent_refund_1", refundOrderNo: "RF" + "a".repeat(28), source: "JOINPAY_FORMAL", evidenceLevel: "JOINPAY_FORMAL",
  amount: { cents: "28000", currency: "CNY" }, state: "SUCCEEDED", budgetDisposition: "CONSUMED", requiresReview: false,
  dueAt: "2026-10-19T04:30:00.000000Z", createdAt: "2026-10-18T04:30:00.000000Z", updatedAt: "2026-10-18T05:30:00.000000Z",
  latestObservation: null, latestFailure: null,
  savedChannelEvidence: { terminal: "SUCCEEDED", evidenceLevel: "JOINPAY_FORMAL", providerRefundTrxNo: "RF-TRX-1", completedAt: "2026-10-18T05:30:00.000000Z", trust: "SAVED_EVIDENCE_NOT_REVALIDATED" },
  localAccounting: { disposition: "CONSUMED", writeOff: { eventId: "event_refund", amountCents: "28000", postedAt: "2026-10-18T05:30:00.000000Z", trust: "LOCAL_LEDGER" }, release: null, reasonCodes: [] },
  channelFacts: { actualAmountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN", reasonCodes: [] },
  reasonCodes: [], ...over,
});

const read = (over = {}) => ({
  contractVersion: "personal-native-refunds.v1", subjectId: "user_A",
  order: { orderId: "order_A", displayNo: "ZZ-1", status: "COMPLETED" },
  status: "AVAILABLE", outcome: "FULLY_CONSUMED",
  coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: 50, intentsComplete: true, channelRecordsChecked: false },
  asOf: "2026-10-27T02:30:17.490161Z",
  responsibility: { state: "POSTED", postingId: "posting_1", originalCents: "28000", allocatedCents: "28000", consumedCents: "28000", releasedCents: "0", remainingCents: "0", totalsComplete: true, dueAt: "2026-10-19T04:30:00.000000Z", dueState: "DUE" },
  intents: [intent()], returnedIntentCount: 1, intentsTruncated: false,
  actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN", reasonCodes: [] },
  localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: "28000", releasedCents: "0", bankArrival: "UNKNOWN" },
  reasonCodes: [], unknowns: ["CHANNEL_REFUND_RECORD_NOT_CHECKED", "BANK_ARRIVAL_UNKNOWN", "REFUND_DESTINATION_NOT_PROJECTED"], ...over,
});

test("accepted projection is parsed with zero and null kept distinct", () => {
  const parsed = parsePersonalRefunds(read(), "user_A", "order_A");
  assert.equal(parsed.outcome, "FULLY_CONSUMED");
  assert.equal(parsed.responsibility.releasedCents, "0");
  assert.equal(parsed.responsibility.originalCents, "28000");
  assert.equal(parsed.actualChannelRefund.bankArrival, "UNKNOWN");
  assert.equal(parsed.intents[0].savedChannelEvidence.trust, "SAVED_EVIDENCE_NOT_REVALIDATED");
  const zero = parsePersonalRefunds(read({ outcome: "ZERO_RESPONSIBILITY", responsibility: { ...read().responsibility, originalCents: "0", allocatedCents: "0", consumedCents: "0", releasedCents: "0", remainingCents: "0" }, intents: [], returnedIntentCount: 0, localFundsEffect: null }), "user_A", "order_A");
  assert.equal(zero.responsibility.originalCents, "0");
  assert.equal(zero.localFundsEffect, null);
});

test("prestart refund is an additive cancelled-order fact and never invents bank arrival",()=>{
 const value=read({order:{orderId:"order_A",displayNo:"ZZ-1",status:"CANCELLED"},
  prestartRefund:{state:"SUCCEEDED",amountCents:"334613",source:"SIMULATED",bankArrival:"UNKNOWN"}});
 assert.deepEqual(parsePersonalRefunds(value,"user_A","order_A").prestartRefund,value.prestartRefund);
 for(const change of [{state:"SUCCEEDED",amountCents:null,source:"JOINPAY",bankArrival:"UNKNOWN"},
  {state:"SUCCEEDED",amountCents:"0",source:"SIMULATED",bankArrival:"UNKNOWN"},
  {state:"SUCCEEDED",amountCents:"1",source:"UNKNOWN",bankArrival:"UNKNOWN"},
  {state:"SUCCEEDED",amountCents:"1",source:"JOINPAY",bankArrival:"ARRIVED"}])
  assert.throws(()=>parsePersonalRefunds({...value,prestartRefund:change},"user_A","order_A"));
 assert.throws(()=>parsePersonalRefunds({...value,order:{...value.order,status:"PAID"}},"user_A","order_A"));
});

test("poststart cancellation refund keeps its own verified amount and rejects contradictory summaries",()=>{
 const summary={state:"PROCESSING",amountCents:"5000",source:"JOINPAY",bankArrival:"UNKNOWN"};
 const value=read({order:{orderId:"order_A",displayNo:"ZZ-1",status:"CANCELLED"},cancellationRefund:summary});
 assert.deepEqual(parsePersonalRefunds(value,"user_A","order_A").cancellationRefund,summary);
 assert.throws(()=>parsePersonalRefunds({...value,prestartRefund:summary},"user_A","order_A"));
 assert.throws(()=>parsePersonalRefunds({...value,cancellationRefund:{...summary,bankArrival:"ARRIVED"}},"user_A","order_A"));
});

test("contract, subject, order and enum anchors are enforced", () => {
  for (const bad of [
    read({ contractVersion: "personal-native-refunds.v0" }),
    read({ subjectId: "user_B" }),
    read({ order: { orderId: "order_B", displayNo: "ZZ-2", status: "COMPLETED" } }),
    read({ outcome: "ORDER_NOT_PAID" }),
    read({ responsibility: { ...read().responsibility, dueState: "SOON" } }),
    read({ actualChannelRefund: { ...read().actualChannelRefund, amountCents: "28000" } }),
    read({ actualChannelRefund: { ...read().actualChannelRefund, bankArrival: "ARRIVED" } }),
    read({ intents: [intent({ amount: { cents: "28000", currency: "USD" } })], returnedIntentCount: 1 }),
  ]) assert.throws(() => parsePersonalRefunds(bad, "user_A", "order_A"), (error) => error.status === 502);
});

test("truncated or conflicting reads cannot claim complete totals", () => {
  const truncated = read({ outcome: "TRUNCATED", intentsTruncated: true, coverage: { ...read().coverage, intentsComplete: false }, responsibility: { ...read().responsibility, totalsComplete: false } });
  assert.throws(() => parsePersonalRefunds(truncated, "user_A", "order_A"), (error) => error.status === 502);
  const intents = Array.from({ length: 50 }, (_, index) => intent({ intentId: `intent_${index}` }));
  const truncatedOk = read({
    outcome: "TRUNCATED", intents, returnedIntentCount: 50, intentsTruncated: true,
    coverage: { ...read().coverage, intentsComplete: false },
    responsibility: { ...read().responsibility, originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false },
    localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: null, releasedCents: null, bankArrival: "UNKNOWN" },
  });
  assert.equal(parsePersonalRefunds(truncatedOk, "user_A", "order_A").intents.length, 50);
  assert.equal(parsePersonalRefunds({ ...truncatedOk, intents: intents.slice(0, 49), returnedIntentCount: 49 }, "user_A", "order_A").returnedIntentCount, 49);
  assert.throws(() => parsePersonalRefunds(read({ outcome: "CONFLICT" }), "user_A", "order_A"), (error) => error.status === 502);
  assert.throws(() => parsePersonalRefunds(read({ returnedIntentCount: 2 }), "user_A", "order_A"), (error) => error.status === 502);
  assert.throws(() => parsePersonalRefunds(read({ intents: Array.from({ length: 51 }, (_, index) => intent({ intentId: `intent_${index}` })), returnedIntentCount: 51 }), "user_A", "order_A"), (error) => error.status === 502);
});

test("saved evidence, write-off and channel facts stay within their verified shapes", () => {
  const wrongTrust = intent({ savedChannelEvidence: { ...intent().savedChannelEvidence, trust: "VERIFIED" } });
  assert.throws(() => parsePersonalRefunds(read({ intents: [wrongTrust] }), "user_A", "order_A"), (error) => error.status === 502);
  const nullWriteOff = intent({ localAccounting: { ...intent().localAccounting, writeOff: { ...intent().localAccounting.writeOff, amountCents: null } } });
  assert.throws(() => parsePersonalRefunds(read({ intents: [nullWriteOff] }), "user_A", "order_A"), (error) => error.status === 502);
  const observed = intent({ latestFailure: { source: "JOINPAY", event: "REFUND_QUERY", failureReason: "RESULT_UNKNOWN", evidenceLevel: "JOINPAY_FORMAL", observedAt: "2026-10-18T05:30:00.000000Z", ageSeconds: 60, trust: "LOCAL_OBSERVATION_NOT_REVALIDATED" } });
  assert.equal(parsePersonalRefunds(read({ intents: [observed] }), "user_A", "order_A").intents[0].latestFailure.failureReason, "RESULT_UNKNOWN");
});

test("legacy C02 keeps a known original amount while derived totals remain unknown", () => {
  for (const outcome of ["CONFLICT", "TRUNCATED"]) {
    const intents = Array.from({ length: 49 }, (_, index) => intent({ intentId: "filtered_intent_" + index }));
    const actual = read({
      outcome, intents, returnedIntentCount: 49, intentsTruncated: true,
      coverage: { ...read().coverage, intentsComplete: false },
      responsibility: { ...read().responsibility, originalCents: "28000", allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false },
      localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: null, releasedCents: null, bankArrival: "UNKNOWN" },
    });
    const parsed = parsePersonalRefunds(actual, "user_A", "order_A");
    assert.equal(parsed.outcome, outcome);
    assert.equal(parsed.responsibility.originalCents, "28000");
    assert.equal(parsed.responsibility.allocatedCents, null);
    assert.equal(parsed.coverage.intentsComplete, false);
    assert.equal(parsed.localFundsEffect.writtenOffCents, null);
    assert.throws(() => parsePersonalRefunds({ ...actual, responsibility: { ...actual.responsibility, consumedCents: "28000" } }, "user_A", "order_A"), (error) => error.status === 502);
  }
});


test("retired abnormal refund fields are not exposed by the reader",()=>{
 const parsed=parsePersonalRefunds({...read(),abnormalResponsibilities:[{unused:true}],responsibilityTotals:{unused:true}},"user_A","order_A");
 assert.equal("abnormalResponsibilities" in parsed,false);assert.equal("responsibilityTotals" in parsed,false);
 assert.throws(()=>parsePersonalRefunds(read({intents:[intent({basisKind:"REVIEW_CONFIRMATION"})]}),"user_A","order_A"),error=>error.status===502);
});


/* --- Rental Price Preview & Checkout Forwarding Tests --- */

process.env.NODE_ENV = 'test';
process.env.ZZSH_API_ORIGIN = 'http://127.0.0.1:3102';
process.env.ZZSH_WEB_ORIGIN = 'http://127.0.0.1:3100';
const { forwardOrderRequest } = await import('../src/lib/order-proxy.ts');
const { GET: rentalPreviewGet } = await import('../src/app/api/rental-price-preview/route.ts');
const { toListingCard, toListingDetail } = await import('../src/lib/listing-view.ts');
const previewRefs = { accountId: 'account-price', versionId: 'version-price', releaseId: 'release-price' };
const previewQuery = new URLSearchParams(previewRefs).toString();
const previewUrl = 'http://127.0.0.1:3100/api/rental-price-preview';
const previewMoney = amount => ({ currency: 'CNY', unit: 'yuan', amount, scale: 2 });
const previewQuote = { schemaVersion: 2, currency: 'CNY', ruleReleaseId: previewRefs.releaseId, lines: [], resourceTotal: previewMoney('1.00'), tenantDeposit: previewMoney('0.00'), tenantPayableTotal: previewMoney('1.00'), termSeconds: '86400', expiryDisclosures: [], unitAmountsInformational: true, baseRenterHaffRatioWanPerYuan: '44.12345678' };
const previewData = { schema: 'rental-price-preview.v1', binding: { ...previewRefs, listingHash: 'a'.repeat(64) }, asOfUtc: '2026-10-25T00:10:00.123456Z', refreshAfterUtc: '2026-10-25T00:10:30.123456Z', quote: previewQuote, baseTenantDeposit: previewMoney('100.00'), membershipBenefits: { schema: 'membership-benefits-v1', effectiveTier: 'GOLD', policyTier: 'GOLD', priceSource: 'GROWTH', depositSource: 'GROWTH', policyVersion: '1' } };
function previewRequest(search = previewQuery, headers = {}) { return new Request(previewUrl + '?' + search, { headers }); }

test('preview client sends exactly three references using the existing same-origin no-store read and Abort signal', async () => {
  const before = globalThis.fetch, seen = [], controller = new AbortController();
  globalThis.fetch = async (input, init) => { seen.push({ input: String(input), init }); return Response.json(previewData); };
  try {
    const result = await orderApi.previewRentalPrice({ ...previewRefs, userId: 'client-must-not-choose-actor', tier: 'VIP', fullPayoutTermsAcceptance: 'not-read-input' }, controller.signal);
    assert.deepEqual(result, previewData); assert.equal(seen.length, 1); assert.equal(seen[0].input, '/api/rental-price-preview?' + previewQuery);
    assert.equal(seen[0].init.method, undefined); assert.equal(seen[0].init.credentials, 'same-origin'); assert.equal(seen[0].init.cache, 'no-store'); assert.equal(seen[0].init.signal, controller.signal);
    assert.equal(seen[0].init.body, undefined); assert(!('confirmationToken' in result)); assert(!('depositWaived' in result)); assert.equal(result.quote.tenantDeposit.amount, '0.00');
  } finally { globalThis.fetch = before; }
});

test('preview client keeps read errors and cancellation without trying confirmation or creation', async () => {
  const before = globalThis.fetch, calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ input: String(input), init }); return Response.json({ error: { code: 'MEMBERSHIP_UNKNOWN', message: '暂不可用' } }, { status: 503 }); };
  try {
    await assert.rejects(() => orderApi.previewRentalPrice(previewRefs), error => error instanceof OrderRequestError && error.status === 503 && error.code === 'MEMBERSHIP_UNKNOWN');
    assert.equal(calls.length, 1); assert.match(calls[0].input, /^\/api\/rental-price-preview\?/); assert.equal(calls[0].init.body, undefined);
    const controller = new AbortController(), aborted = new DOMException('Aborted', 'AbortError'); controller.abort(); globalThis.fetch = async () => { throw aborted; };
    await assert.rejects(() => orderApi.previewRentalPrice(previewRefs, controller.signal), error => error === aborted);
  } finally { globalThis.fetch = before; }
});

test('preview BFF forwards only user session, the exact root GET and references with no-store', async () => {
  const before = globalThis.fetch; let seen;
  globalThis.fetch = async (input, init) => { seen = { input: String(input), init }; return Response.json(previewData, { headers: { 'cache-control': 'public,max-age=86400', 'set-cookie': 'zzsh_admin.session_token=forbidden; Path=/' } }); };
  try {
    const response = await rentalPreviewGet(previewRequest(previewQuery, { cookie: 'zzsh_user.session_token=synthetic-user; zzsh_admin.session_token=synthetic-admin; unrelated=ignored', 'x-client-user-id': 'cannot-select', 'idempotency-key': 'not-forwarded' }));
    assert.equal(response.status, 200); assert.equal(seen.input, 'http://127.0.0.1:3102/api/bff/user/rental-price-preview?' + previewQuery); assert.equal(seen.init.method, 'GET'); assert.equal(seen.init.cache, 'no-store'); assert.equal(seen.init.redirect, 'error'); assert.equal(seen.init.body, undefined);
    assert.equal(seen.init.headers.get('cookie'), 'zzsh_user.session_token=synthetic-user'); assert.equal(seen.init.headers.get('origin'), 'http://127.0.0.1:3100'); assert.equal(seen.init.headers.get('idempotency-key'), null); assert.equal(seen.init.headers.get('x-client-user-id'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), previewData);
  } finally { globalThis.fetch = before; }
});

test('preview BFF rejects invalid or mixed queries, non-GET methods, and forwards upstream error shapes unchanged', async () => {
  const before = globalThis.fetch, seen = [];
  globalThis.fetch = async (input, init) => { seen.push({ input: String(input), init }); return Response.json({ error: { code: 'ORDER_NOT_FOUND', message: '未找到商品' } }, { status: 404 }); };
  try {
    for (const bad of ['', 'accountId=a', 'accountId=a&versionId=b', previewQuery + '&extra=1', previewQuery + '&userId=a', previewQuery + '&accountId=other']) {
      const response = await rentalPreviewGet(previewRequest(bad)); assert.equal(response.status, 400); assert.equal(seen.length, 0);
    }
    const upstream404 = await rentalPreviewGet(previewRequest()); assert.equal(upstream404.status, 404); assert.deepEqual(await upstream404.json(), { error: { code: 'ORDER_NOT_FOUND', message: '未找到商品' } });
    globalThis.fetch = async (input, init) => { seen.push({ input: String(input), init }); return Response.json({ message: 'plain error' }, { status: 503 }); };
    assert.equal((await rentalPreviewGet(previewRequest())).status, 503);
    globalThis.fetch = async () => new Response('not JSON'); assert.equal((await rentalPreviewGet(previewRequest())).status, 502);
    assert(seen.every(v => v.init.method === 'GET' && v.input.startsWith('http://127.0.0.1:3102/api/bff/user/rental-price-preview?')));
  } finally { globalThis.fetch = before; }
});

function previewListing(value = previewQuote) { return { ...previewRefs, id: previewRefs.accountId, source: 'NATIVE', title: '', description: null, attributes: {}, media: [], presentation: { items: [], skins: [], entitlements: [] }, game: { id: 'game', code: 'delta', name: 'Synthetic' }, quote: value, availability: { state: 'RENTABLE' }, canCreateOrder: true }; }
test('public card/detail map the frozen base ratio exactly and absence stays null without changing eligibility', () => {
  for (const value of ['44.12345678', null, undefined]) { const source = previewListing({ ...previewQuote, baseRenterHaffRatioWanPerYuan: value }), card = toListingCard(source), detail = toListingDetail(source); assert.equal(card.baseRenterHaffRatioWanPerYuan, value ?? null); assert.equal(detail.baseRenterHaffRatioWanPerYuan, value ?? null); assert.equal(card.canCreateOrder, true); assert.equal(card.resourceTotalLabel, '¥1.00'); }
  const history = { ...previewListing(null), source: 'LEGACY_READ_ONLY', canCreateOrder: false, availability: { state: 'LEGACY_READ_ONLY' }, inventory: [], historicalQuote: { haffRent: previewMoney('1.00'), goods: previewMoney('0.00'), deposit: previewMoney('100.00'), termDays: '1' } };
  assert.equal(toListingCard(history).baseRenterHaffRatioWanPerYuan, null);
});

test('local checkout BFF rechecks the captured user and only forwards exact JSON leaves',async()=>{
 const original=globalThis.fetch,calls=[];globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init});return Response.json(String(input).endsWith('/get-session')?{user:{id:'checkout-user'}}:{scope:'LOCAL_CONTROLLED',knowledge:'KNOWN'});};
 const headers={origin:'http://127.0.0.1:3100',cookie:'zzsh_user.session_token=fixture-user; zzsh_admin.session_token=must-not-forward','x-zzsh-expected-user-id':'checkout-user','content-type':'application/json','idempotency-key':'original-issue'};
 try{for(const method of ['GET','POST']){const response=await forwardOrderRequest(new Request('http://127.0.0.1:3100/api/orders/order-local/local-checkouts',{method,headers,...(method==='POST'?{body:'{}'}:{})}),{params:Promise.resolve({path:['order-local','local-checkouts']})});assert.equal(response.status,200);const forwarded=calls.at(-1);assert.equal(forwarded.init.method,method);assert.equal(forwarded.init.headers.get('cookie'),'zzsh_user.session_token=fixture-user');assert(!forwarded.init.headers.get('cookie').includes('admin'));if(method==='POST'){assert.equal(forwarded.init.headers.get('idempotency-key'),'original-issue');assert.equal(new TextDecoder().decode(forwarded.init.body),'{}');}}assert.equal(calls.filter(c=>c.url.endsWith('/get-session')).length,2);
 }finally{globalThis.fetch=original;}
});
test('local checkout receipt preserves the original key and rejects query or identity drift without command retry',async()=>{
 const original=globalThis.fetch,calls=[];globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init});return Response.json(String(input).endsWith('/get-session')?{user:{id:'checkout-user'}}:{knowledge:'UNKNOWN'});};
 const headers={origin:'http://127.0.0.1:3100','x-zzsh-expected-user-id':'checkout-user'},go=(query,identity='checkout-user')=>forwardOrderRequest(new Request('http://127.0.0.1:3100/api/orders/order-local/local-checkouts/receipt'+query,{headers:{...headers,'x-zzsh-expected-user-id':identity}}),{params:Promise.resolve({path:['order-local','local-checkouts','receipt']})});
 try{assert.equal((await go('?key=original-issue')).status,200);assert(calls.at(-1).url.endsWith('/local-checkouts/receipt?key=original-issue'));for(const query of ['','?key=first&key=second','?key=first&mode=COMPLETE'])assert.equal((await go(query)).status,400);const before=calls.length;assert.equal((await go('?key=original-issue','other-user')).status,401);assert.equal(calls.length,before+1);assert.equal(calls.filter(c=>c.init.method==='POST').length,0);
 }finally{globalThis.fetch=original;}
});
test('local checkout HTML and completion cannot be tunneled through the JSON BFF',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not fetch');};try{for(const leaf of ['page','complete','complete/receipt'])for(const method of ['GET','POST']){const response=await forwardOrderRequest(new Request('http://127.0.0.1:3100/api/orders/order-local/local-checkouts/'+leaf,{method,headers:{origin:'http://127.0.0.1:3100','content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})}),{params:Promise.resolve({path:['order-local','local-checkouts',...leaf.split('/')]})});assert.equal(response.status,404);}assert.equal(calls,0);}finally{globalThis.fetch=original;}
});
