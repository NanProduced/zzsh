import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JOINPAY_REFUND_SIGNATURE_ORDER } from "../src/order/joinpay-refund-protocol";
import { bindRefundProfile, createFormalRefundAdmission, describeRefundProfile, inspectRefundProfile, produceRefundRequest, readRefundOutbound,
  refundCompleteTimeToUtc, refundFailureMayRelease, refundWayAccepted, readRefundProfileEvidence, type RefundBinding, type RefundOperation, type RefundServerProfile } from "../src/order/joinpay-refund-profile";
import { exchangeRefundRequest, executeJoinpayRefund, queryJoinpayRefund, RefundAttemptCommitUnknown } from "../src/order/joinpay-refund-attempt";
import { handleJoinpayRefundNotification, JOINPAY_REFUND_NOTIFICATION_PATH } from "../src/order/joinpay-refund-notification-routes";
const KEY = "SYNTHETIC_REFUND_KEY", md5 = (s: string) => createHash("md5").update(s).digest("hex"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
const base = { merchantNo: "999900000000001", originalPaymentOrderNo: "ORDER_MODEL_1", refundOrderNo: "RF" + "a".repeat(28), amountCents: "100", currency: "CNY" as const };
function model(operation: RefundOperation = "SUBMIT", purpose: RefundServerProfile["purpose"] = "MERCHANT_REFUND") {
  const values: Record<string, string> = operation === "QUERY" ? { r0_Version: "2.3", r1_MerchantNo: base.merchantNo, r2_RefundOrderNo: base.refundOrderNo, r3_RefundAmount: "1.00", r4_RefundTrxNo: "REFUND_MODEL_TRX", r5_RefundCompleteTime: "2026-10-23 12:00:00", r8_RefundWay: "ORIGINAL", r9_ReceiveAccountNo: "", ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", rd_MarketRefAmount: "0.00" }
    : { r0_Version: "2.3", r1_MerchantNo: base.merchantNo, r2_OrderNo: base.originalPaymentOrderNo, r3_RefundOrderNo: base.refundOrderNo, r4_RefundAmount: "1.00", r5_RefundTrxNo: "REFUND_MODEL_TRX", ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", ...(operation === "NOTIFY" ? { r6_RefundCompleteTime: "2026-10-23 12:00:00", r7_RefundWay: "ORIGINAL", r8_ReceiveAccountNo: "", rd_MarketRefAmount: "0.00" } : {}) };
  const order = operation === "SUBMIT" ? JOINPAY_REFUND_SIGNATURE_ORDER.refundResponse : operation === "QUERY" ? JOINPAY_REFUND_SIGNATURE_ORDER.queryRefundResponse : JOINPAY_REFUND_SIGNATURE_ORDER.refundNotify;
  values.hmac = md5(order.map(n => values[n] ?? "").join("") + KEY);
  const responseBody = operation === "NOTIFY" ? new URLSearchParams(values).toString() : JSON.stringify(values);
  const requestValues: Record<string, string> = operation === "SUBMIT" ? { p0_Version: "2.3", p1_MerchantNo: base.merchantNo, p2_OrderNo: base.originalPaymentOrderNo, p3_RefundOrderNo: base.refundOrderNo, p4_RefundAmount: "1.00", p6_NotifyUrl: "https://merchant.example.test/refund" }
    : { p0_Version: "2.3", p1_MerchantNo: base.merchantNo, p2_RefundOrderNo: base.refundOrderNo };
  const requestOrder = operation === "SUBMIT" ? JOINPAY_REFUND_SIGNATURE_ORDER.refundRequest : JOINPAY_REFUND_SIGNATURE_ORDER.queryRefundRequest;
  const input: Omit<RefundServerProfile,"knownAnswer"> & { knownAnswer: Exclude<RefundServerProfile["knownAnswer"],"NOT_OBTAINED"> } = { operation, purpose, profileId: "SYNTHETIC_REFUND_CONFIGURATION_MODEL_" + operation, merchantIdentityId: "synthetic_refund_merchant", merchantNo: base.merchantNo,
    database: "synthetic_refund_test", runtimeUser: "synthetic_refund_r", keyVersionRef: "synthetic_refund_key_v1", notifyUrl: "https://merchant.example.test/refund",
    reviewRef: "SYNTHETIC_BACKEND_CONFIGURATION_MODEL", reviewSha256: "a".repeat(64), permission: "REVIEWED_NATIVE_RENTAL_REFUND",
    rules: { reference: "SYNTHETIC_RULES_NOT_OFFICIAL", sha256: "b".repeat(64), signing: "MD5_UTF8_RAW_VALUES", rawQueryDecode: "ONCE", numberTokens: "RAW_JSON_TOKEN", fieldPolicy: "STRICT_TABLE_EMPTY_OPTIONAL", refundIdentifier: "EXACT_TEXT", notify102: "REVIEW", utcOffsetMinutes: 480, refundWay: "ORIGINAL_REQUIRED", failureNoExecution: { accepted: false, codes: [], reference: null, sha256: null } },
    knownAnswer: { reference: "SYNTHETIC_KAT_NOT_OFFICIAL", rawSha256: sha(responseBody), vectorKey: KEY, binding: base, responseBody,
      expectedResult: operation === "SUBMIT" ? "APPLICATION_ACCEPTED" : "CHANNEL_REPORTED_SUCCEEDED", ...(operation === "NOTIFY" ? {} : { requestHmac: md5(requestOrder.map(n => requestValues[n] ?? "").join("") + KEY) }) } };
  const profile = bindRefundProfile(input), p = describeRefundProfile(profile), binding: RefundBinding = { ...base, intentId: "refund_model_1", postingId: "posting_model_1", orderId: "order_model_1", paymentConfirmationId: "payment_model_1", renterUserId: "renter_model_1", merchantIdentityId: p.merchantIdentityId,
    originalPaymentTrxNo: "PAY_MODEL_TRX", responsibilityVersionHash: "c".repeat(64), notifyUrl: input.notifyUrl, profileId: p.profileId, initialProfileSha256: p.profileSha256, keyVersionRef: p.keyVersionRef };
  return { profile, input, binding, responseBody };
}
test("三操作独立KAT计算模型；副本/A2/缺证据/模型冒正式准入均拒", () => {
  for (const operation of ["SUBMIT", "QUERY", "NOTIFY"] as const) {
    const m = model(operation); assert.equal(inspectRefundProfile(m.profile, operation, m.responseBody, m.binding, KEY).signature, "MATCH");
    assert.throws(() => describeRefundProfile({ ...m.profile }), /NOT_BOUND/);
    assert.throws(() => createFormalRefundAdmission({ reference: "SYNTHETIC_REVIEW", reviewSha256: "a".repeat(64), profiles: [m.profile] }));
    assert.throws(() => bindRefundProfile({ ...m.input, merchantNo: "888100000002340" }));
    assert.throws(() => bindRefundProfile({ ...m.input, knownAnswer: { ...m.input.knownAnswer, rawSha256: "0".repeat(64) } }));
    assert.throws(() => produceRefundRequest(m.profile, "NOTIFY" as "QUERY", m.binding, KEY), /OUTBOUND_OPERATION/);
  }
});

test("样例显式未取得可绑定，canonical如实记录且不保存演示钥或响应", () => {
  for(const operation of ["SUBMIT","QUERY","NOTIFY"] as const){const m=model(operation),profile=bindRefundProfile({...m.input,knownAnswer:"NOT_OBTAINED"} as any);
    const evidence=readRefundProfileEvidence(profile);assert.equal(JSON.parse(evidence).knownAnswer,"NOT_OBTAINED");assert.equal(evidence.includes(KEY),false);assert.equal(evidence.includes("vectorKey"),false);
    assert.throws(()=>createFormalRefundAdmission({reference:"SYNTHETIC_NOT_AUTHORITY",reviewSha256:"a".repeat(64),profiles:[profile]}));
  }
});

test("没有样例不放松真实响应校验、商户边界或坏样例拒绝", () => {
  const m=model("QUERY"),profile=bindRefundProfile({...m.input,knownAnswer:"NOT_OBTAINED"} as any),binding={...m.binding,initialProfileSha256:describeRefundProfile(profile).profileSha256};
  const bad=JSON.stringify({...JSON.parse(m.responseBody),hmac:"0".repeat(32)});assert.notEqual(inspectRefundProfile(profile,"QUERY",bad,binding,KEY).signature,"MATCH");
  assert.throws(()=>bindRefundProfile({...m.input,knownAnswer:"NOT_OBTAINED",merchantNo:"888100000002340"} as any));
  assert.throws(()=>bindRefundProfile({...m.input,knownAnswer:undefined} as any));
  assert.throws(()=>bindRefundProfile({...m.input,knownAnswer:{...m.input.knownAnswer,rawSha256:"0".repeat(64)}}));
});
test("原始请求固定2.3/原付款与退款号/精确分；QUERY轮换不改原初绑定", () => {
  const m = model(), request = produceRefundRequest(m.profile, "SUBMIT", m.binding, KEY), wire = readRefundOutbound(request), values = new URLSearchParams(wire.body);
  assert.equal(wire.endpoint, "https://trade.joinpay.com/tradeRt/refund"); assert.equal(values.get("p4_RefundAmount"), "1.00"); assert.equal(values.get("p2_OrderNo"), base.originalPaymentOrderNo);
  assert.equal(sha(wire.body), request.requestSha256); assert.throws(() => readRefundOutbound({ ...request }), /NOT_BOUND/);
  assert.throws(() => produceRefundRequest(m.profile, "SUBMIT", { ...m.binding, refundOrderNo: "x".repeat(31) }, KEY));
  const q = model("QUERY"), changed = { ...q.binding, profileId: "ORIGINAL_OLD_PROFILE", initialProfileSha256: "d".repeat(64), keyVersionRef: "old_key" };
  assert.equal(new URLSearchParams(readRefundOutbound(produceRefundRequest(q.profile, "QUERY", changed, KEY)).body).get("p2_RefundOrderNo"), base.refundOrderNo);
});
test("synthetic目的即使注入真实fetch也永不发送；fake模型响应永不标真实来源", async () => {
  const s = model("SUBMIT", "SYNTHETIC_PROTOCOL"), request = produceRefundRequest(s.profile, "SUBMIT", s.binding, KEY);
  await assert.rejects(exchangeRefundRequest(request, { fetch: globalThis.fetch }), /SYNTHETIC/);
  const m = model(); let sends = 0;
  const r = await exchangeRefundRequest(produceRefundRequest(m.profile, "SUBMIT", m.binding, KEY), { fetch: async (url, init) => {
    sends++; assert.equal(String(url), "https://trade.joinpay.com/tradeRt/refund"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit"); return new Response(m.responseBody);
  } });
  assert.equal(sends, 1); assert.equal(r.evidenceLevel, "SYNTHETIC_PROTOCOL"); assert.equal(r.responseComplete, true); assert.equal(Buffer.from(r.body!).toString(), m.responseBody);
});
test("真实终态前的申请受理不是退款；失败缺未执行证明不释放；方式和时区显式", () => {
  const s = model(), d = inspectRefundProfile(s.profile, "SUBMIT", s.responseBody, s.binding, KEY); assert.equal(d.result, "APPLICATION_ACCEPTED");
  assert.equal(refundFailureMayRelease(s.profile, { ...d, result: "CHANNEL_REPORTED_FAILED", channelCode: "101" }), false);
  assert.equal(refundWayAccepted(s.profile, undefined), false); assert.equal(refundWayAccepted(s.profile, "BALANCE"), false); assert.equal(refundWayAccepted(s.profile, "ORIGINAL"), true);
  assert.equal(refundCompleteTimeToUtc(s.profile, "2026-10-23 12:00:00"), "2026-10-23T04:00:00.000Z"); assert.throws(() => refundCompleteTimeToUtc(s.profile, "2026-02-30 12:00:00"));
});
test("transport超限/非200/中断保留有界原件；网络错误不泄露异常", async () => {
  const m = model(), request = produceRefundRequest(m.profile, "SUBMIT", m.binding, KEY);
  const huge = await exchangeRefundRequest(request, { fetch: async () => new Response("x".repeat(70000)) }); assert.equal(huge.failure, "BODY_TOO_LARGE"); assert.equal(huge.body?.length, 65536); assert.equal(huge.responseComplete, false);
  const http = await exchangeRefundRequest(request, { fetch: async () => new Response("error", { status: 503 }) }); assert.equal(http.failure, "HTTP_STATUS"); assert.equal(Buffer.from(http.body!).toString(), "error"); assert.equal(http.responseComplete, true);
  const failed = await exchangeRefundRequest(request, { fetch: async () => { throw Error(KEY); } }); assert.equal(failed.failure, "NETWORK_ERROR"); assert.equal(JSON.stringify(failed).includes(KEY), false);
});
test("单调截止含不响应fetch和timer晚调度，0重试", async t => {
  const m = model(), request = produceRefundRequest(m.profile, "SUBMIT", m.binding, KEY); let now = 0, sends = 0; t.mock.method(performance, "now", () => now);
  const late = await exchangeRefundRequest(request, { fetch: async () => { sends++; now = 9001; return new Response(m.responseBody); } }); assert.equal(late.failure, "TIMEOUT"); assert.equal(sends, 1);
  now = 0; t.mock.timers.enable({ apis: ["setTimeout"] }); const waiting = exchangeRefundRequest(request, { fetch: () => new Promise(() => {}) }); t.mock.timers.tick(8001); assert.equal((await waiting).failure, "TIMEOUT");
});
test("未绑定准入在claim前拒绝，0connect/0key/0transport", async () => {
  let connects = 0, keys = 0, sends = 0;
  // 只有连接用于transaction宿主；private admission校验必须早于业务读/钥/外发。
  const client = { query: async () => ({ rows: [] }), release() {} };
  await assert.rejects(executeJoinpayRefund({ pool: { connect: async () => { connects++; return client; } } as any, admission: {} as any, profileFor: () => model().profile,
    keyFor: () => { keys++; return KEY; }, fetch: async () => { sends++; return new Response(""); } }, "refund_1", "worker_1"));
  assert.equal(connects, 0); assert.equal(keys, 0); assert.equal(sends, 0);
  const unknown = new RefundAttemptCommitUnknown("refund_1", "CLAIM"); assert.equal(unknown.code, "REFUND_EXECUTION_UNKNOWN"); assert.equal(unknown.phase, "CLAIM");
});
// 下列模型明确假设准入/原DB绑定读取成立；不调用正式admission/source factory，不产生真实终态fact。
function executionModel(t: TestContext) {
  const m=model(),q=model("QUERY"),store=require("../src/order/channel-refund-store"),profiles=require("../src/order/joinpay-refund-profile");
  const state={now:0,row:{id:m.binding.intentId,state:"READY",lease_version:"0",revision:"1",lease_owner:null,lease_until:0,terminal_evidence_id:null,
    merchant_identity_id:m.binding.merchantIdentityId,original_payment_trx_no:m.binding.originalPaymentTrxNo,requires_review:false,budget_disposition:"ALLOCATED"} as any,
    attempts:[] as any[],observations:[] as any[],audits:[] as any[],commit:0,unknownCommit:0,auditFailure:0,auditCalls:0,sends:[] as string[],keys:0,due:true,intervalOk:true};
  const a={sha256:"a".repeat(64)},order:string[]=[];t.mock.method(profiles,"readFormalRefundAdmission",()=>a);t.mock.method(profiles,"assertFormalRefundProfile",()=>a);
  t.mock.method(store,"lockFormalRefundContext",async()=>{order.push("lock");return structuredClone(state.row);});t.mock.method(store,"formalRefundBinding",()=>Object.freeze({...m.binding}));
  let snapshot:any;
  const client={release(){},async query(sql:string,p:any[]=[]):Promise<any>{
    if(sql==="BEGIN"){snapshot=structuredClone({row:state.row,attempts:state.attempts,observations:state.observations,audits:state.audits});return{rows:[]};}
    if(sql==="COMMIT"){snapshot=undefined;if(++state.commit===state.unknownCommit)throw Error("MODEL_COMMIT_RESPONSE_LOST");return{rows:[]};}
    if(sql==="ROLLBACK"){if(snapshot)Object.assign(state,snapshot);snapshot=undefined;return{rows:[]};}
    if(sql.startsWith("SAVEPOINT")||sql.startsWith("RELEASE SAVEPOINT"))return{rows:[]};
    if(sql.startsWith("SELECT to_regclass"))return{rows:[{ready:true}]};
    if(sql.includes(" AS active")){
      const active=state.row.lease_until===null?null:state.row.lease_until>state.now;
      return{rows:[{active:/COALESCE\(lease_until\s*>\s*clock_timestamp\(\),\s*false\)/.test(sql)?active??false:active,due:state.due}]};
    }
    if(sql.includes("EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt"))return{rows:[{dispatched:state.attempts.some((a:any[])=>a[2]==="SUBMIT")}]};
    if(sql.includes("count(*) FILTER(WHERE operation='QUERY')::text AS queries"))return{rows:[{queries:String(state.attempts.filter((a:any[])=>a[2]==="QUERY").length),interval_ok:state.intervalOk}]};
    if(sql.includes("SELECT EXISTS"))return{rows:[{blocked:false}]};
    if(sql.includes("SET state=CASE")){if(state.row.lease_until>state.now)return{rows:[]};Object.assign(state.row,{state:state.row.state==="READY"?"SUBMITTING":"UNKNOWN",lease_version:String(BigInt(state.row.lease_version)+1n),lease_owner:p[1],lease_until:state.now+30,revision:String(BigInt(state.row.revision)+1n)});return{rows:[structuredClone(state.row)]};}
    if(sql.includes("AS current FROM"))return{rows:[{current:state.row.lease_version===p[1]&&state.row.lease_owner===p[2]&&state.row.lease_until>state.now}]};
    if(sql.includes("INSERT INTO zzsh_order.joinpay_refund_attempt")){state.attempts.push(p);return{rows:[]};}
    if(sql.includes("INSERT INTO zzsh_order.joinpay_refund_observation")){state.observations.push(p);return{rows:[]};}
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};if(sql.startsWith("SELECT id FROM zzsh_order.channel_refund_intent"))return{rows:[]};
    if(sql.includes("SET state=$2")){state.row.state=p[1];state.row.revision=String(BigInt(state.row.revision)+1n);return{rows:[],rowCount:1};}
    if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){if(++state.auditCalls===state.auditFailure)throw Error("MODEL_AUDIT_FAILED");state.audits.push(p);return{rows:[]};}
    throw Error("UNEXPECTED_COMPONENT_SQL");
  }};
  const options={pool:{connect:async()=>client} as any,admission:{} as any,profileFor:(op:RefundOperation)=>op==="QUERY"?q.profile:m.profile,keyFor:()=>{state.keys++;return KEY;},
    fetch:async(url:any)=>{state.sends.push(String(url));return new Response(String(url).endsWith("queryRefund")?q.responseBody:m.responseBody);}};
  return{state,options,order};
}
test("SYNTHETIC_COMPONENT_MODEL：CLAIM COMMIT未知0发送，租约后仅QUERY原号",async t=>{
  const m=executionModel(t);m.state.unknownCommit=1;
  await assert.rejects(executeJoinpayRefund(m.options,"refund_model_1","worker_1"),e=>e instanceof RefundAttemptCommitUnknown&&e.phase==="CLAIM");
  assert.equal(m.state.sends.length,0);assert.equal(m.state.attempts.length,1);assert.equal(m.state.row.state,"SUBMITTING");
  m.state.now=31;const r=await executeJoinpayRefund(m.options,"refund_model_1","worker_2");assert.equal(m.state.sends.length,1);assert.equal(m.state.sends[0],"https://trade.joinpay.com/tradeRt/queryRefund");
  assert.equal(r?.terminal,null);assert.equal(m.state.observations[0][20],"SYNTHETIC_PROTOCOL");
});
test("SYNTHETIC_COMPONENT_MODEL：RESULT COMMIT未知保留raw，audit失败全回滚且不重发",async t=>{
  const m=executionModel(t);m.state.unknownCommit=2;
  await assert.rejects(executeJoinpayRefund(m.options,"refund_model_1","worker_1"),e=>e instanceof RefundAttemptCommitUnknown&&e.phase==="RESULT");
  assert.equal(m.state.sends.length,1);assert.equal(m.state.observations.length,1);assert.equal(sha(Buffer.from(m.state.observations[0][10]).toString()),m.state.observations[0][11]);
});
test("SYNTHETIC_COMPONENT_MODEL：结果audit失败不留半条raw或状态",async t=>{
  const m=executionModel(t);m.state.auditFailure=2;
  await assert.rejects(executeJoinpayRefund(m.options,"refund_model_1","worker_1"),/MODEL_AUDIT_FAILED/);
  assert.equal(m.state.sends.length,1);assert.equal(m.state.observations.length,0);assert.equal(m.state.row.state,"SUBMITTING");assert.equal(m.state.attempts.length,1);
});
test("SYNTHETIC_COMPONENT_MODEL：旧lease晚到只追加STALE原raw，不推进新状态",async t=>{
  const m=executionModel(t);m.options.fetch=async(url:any)=>{m.state.sends.push(String(url));m.state.now=31;return new Response(model().responseBody);};
  const r=await executeJoinpayRefund(m.options,"refund_model_1","worker_1");assert.equal(r?.event,"STALE");assert.equal(r?.terminal,null);
  assert.equal(m.state.observations[0][16],"STALE");assert.equal(m.state.row.state,"SUBMITTING");assert.equal(m.state.sends.length,1);
});
test("SYNTHETIC_COMPONENT_MODEL：review只停SUBMIT，原号QUERY保留raw/audit且不接纳",async t=>{
  const m=executionModel(t),source=require("../src/order/joinpay-refund-source"),finance=require("../src/finance/native-rental-refund-store");let captured=0,consumed=0;
  t.mock.method(source,"captureRefundTerminalFact",async()=>{captured++;throw Error("must not capture model");});t.mock.method(finance,"consumeNativeRentalRefundTerminal",async()=>{consumed++;throw Error("must not consume model");});
  Object.assign(m.state.row,{state:"UNKNOWN",lease_version:"1",requires_review:true});m.state.now=31;
  const result=await executeJoinpayRefund(m.options,"refund_model_1","worker_2");
  assert.equal(m.state.sends[0],"https://trade.joinpay.com/tradeRt/queryRefund");assert.equal(m.state.observations.length,1);assert.ok(m.state.observations[0][10].length>0);
  assert.equal(m.state.audits.length,2);assert.equal(m.state.row.requires_review,true);assert.equal(result?.terminal,null);assert.equal(captured,0);assert.equal(consumed,0);
});

test("Master门禁模型：意图创建后原商户单号变多trx，首次SUBMIT前必须重核并停止",async t=>{
  const m=executionModel(t);m.state.row.basis_kind="REVIEW_CONFIRMATION";m.state.row.posting_id=null;
  let keys=0;m.options.keyFor=()=>{keys++;return KEY;};
  const c=await m.options.pool.connect(),query=c.query.bind(c);
  c.query=async(sql:string,p:any[]=[])=>sql.includes("count(DISTINCT")||sql.includes("abnormal refund first submit")
    ?{rows:[{valid:false,order_no_trx_count:"2",count:"2"}],rowCount:1}:query(sql,p);
  await executeJoinpayRefund(m.options,"refund_model_1","worker_1");
  assert.equal(keys,0);assert.equal(m.state.sends.length,0);assert.equal(m.state.attempts.length,0);
});

test("R1门禁失败只留固定REVIEW结论：不释放预算、不取钥、不发SUBMIT、不改lease",async t=>{
  const m=executionModel(t);m.state.row.basis_kind="REVIEW_CONFIRMATION";m.state.row.posting_id=null;
  const c=await m.options.pool.connect(),query=c.query.bind(c);
  c.query=async(sql:string,p:any[]=[])=>sql.includes("abnormal refund first submit")
    ?{rows:[{valid:false,order_no_trx_count:"3"}],rowCount:1}:query(sql,p);
  await executeJoinpayRefund(m.options,"refund_model_1","worker_1");
  assert.equal(m.state.row.state,"READY");assert.equal(m.state.row.lease_version,"0");
  assert.equal(m.state.row.lease_owner,null);assert.equal(m.state.row.requires_review,false);
  assert.equal(m.state.attempts.length,0);assert.equal(m.state.sends.length,0);
  assert.equal(m.state.audits.length,1);assert.ok(JSON.stringify(m.state.audits[0]).includes("order.refund.abnormal.first_submit.blocked"));
});
test("薄通知原URI/GET/精确ACK：坏输入/非GET/未知路径不读钥或出网", async () => {
  let body = "", status = 0, connects = 0;
  const response = { status(v: number) { status = v; }, setHeader() {}, send(v: string) { body = v; } } as any;
  const options = { pool: { connect: async () => { connects++; throw Error("not allowed"); } } } as any;
  assert.equal(await handleJoinpayRefundNotification({ method: "GET", url: "/other" } as any, response, options), false);
  assert.equal(await handleJoinpayRefundNotification({ method: "POST", url: JOINPAY_REFUND_NOTIFICATION_PATH } as any, response, options), true); assert.equal(status, 405); assert.equal(body, "fail");
  for (const raw of ["", "r1_MerchantNo=999&r1_MerchantNo=999", "r1_MerchantNo=%FF", "x=" + "a".repeat(65536)]) await handleJoinpayRefundNotification({ method: "GET", url: JOINPAY_REFUND_NOTIFICATION_PATH + "?" + raw } as any, response, options);
  assert.equal(connects, 0); assert.equal(body, "fail");
});

test("SYNTHETIC_COMPONENT_MODEL：known退款号缺必填schema先拒且0key，保留INVALID原件；完整schema仍走原验签", async t => {
  const m=executionModel(t),n=model("NOTIFY"),store=require("../src/order/channel-refund-store"),source=require("../src/order/joinpay-refund-source");
  t.mock.method(store,"assertRefundResource",async()=>"100");
  t.mock.method(source,"captureRefundTerminalFact",async()=>null); // model cannot manufacture a formal terminal fact
  const client=await m.options.pool.connect(),query=client.query.bind(client);let keys=0;
  client.query=async(sql:string,args:any[]=[])=>sql.includes("wire_merchant_no=$1 AND refund_order_no=$2")?{rows:[{id:m.state.row.id}]}:query(sql,args);
  m.options.profileFor=()=>n.profile;m.options.keyFor=()=>{keys++;return KEY;};
  const send=async(raw:string)=>{const res:any={body:"",status(n:number){return this;},setHeader(){},send(v:string){this.body=v;}};await handleJoinpayRefundNotification({method:"GET",url:JOINPAY_REFUND_NOTIFICATION_PATH+"?"+raw} as any,res,m.options);return res.body;};
  const missingAmount=new URLSearchParams(n.responseBody);missingAmount.delete("r4_RefundAmount");
  const badAmount=new URLSearchParams(n.responseBody);badAmount.set("r4_RefundAmount","1");
  const missingHmac=new URLSearchParams(n.responseBody);missingHmac.delete("hmac");
  for(const raw of [new URLSearchParams({r1_MerchantNo:base.merchantNo,r3_RefundOrderNo:base.refundOrderNo}).toString(),missingAmount.toString(),badAmount.toString(),missingHmac.toString()]){
    const before=m.state.observations.length;assert.equal(await send(raw),"fail");assert.equal(keys,0,"known intent is not sufficient reason to read a key");
    assert.equal(m.state.observations.length,before+1);const row=m.state.observations.at(-1)!;assert.equal(Buffer.from(row[10]).toString(),raw);assert.equal(row[17],"INVALID");assert.equal(row[18],"NOT_CHECKED");assert.equal(row[19],"NOT_CHECKED");assert.equal(m.state.row.state,"READY");
  }
  const badSignature=new URLSearchParams(n.responseBody);badSignature.set("hmac","0".repeat(32));assert.equal(await send(badSignature.toString()),"fail");assert.equal(keys,1);assert.equal(m.state.observations.at(-1)![18],"MISMATCH");
  assert.equal(await send(n.responseBody),"fail");assert.equal(keys,2);assert.equal(m.state.observations.at(-1)![18],"MATCH");assert.equal(m.state.row.terminal_evidence_id,null);assert.equal(m.state.sends.length,0);
});


// ---------- QUERY-only 内核（SYNTHETIC_COMPONENT_MODEL） ----------

test("SYNTHETIC_QUERY_ONLY：READY/0未派发0钥0attempt0外呼，authorize先于资金锁", async t => {
  const m = executionModel(t); m.state.row.state = "READY"; m.state.row.lease_version = "0"; m.state.row.lease_owner = null; m.state.row.lease_until = 0; m.state.due = true;
  let authClient: any = null;
  const r = await queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60,
    authorize: async (client, intentId) => { authClient = client; m.order.push("authorize"); assert.equal(intentId, "refund_model_1"); } });
  assert.deepEqual(r, { kind: "NOT_DISPATCHED", intentId: "refund_model_1", state: "READY" });
  assert.equal(typeof authClient.query, "function"); assert.deepEqual(m.order, ["authorize", "lock"]);
  assert.equal(m.state.keys, 0); assert.equal(m.state.sends.length, 0); assert.equal(m.state.attempts.length, 0);
  assert.equal(m.state.audits.length, 0); assert.equal(m.state.row.lease_version, "0"); assert.equal(m.state.row.lease_owner, null);
});

test("SYNTHETIC_QUERY_ONLY：已持久SUBMIT不再次SUBMIT，沿原退款号QUERY", async t => {
  const m = executionModel(t); m.state.attempts.push(["existing_submit", "refund_model_1", "SUBMIT"]);
  m.state.row.state = "UNKNOWN"; m.state.row.lease_version = "1"; m.state.row.lease_owner = "old_owner"; m.state.row.lease_until = 1; m.state.now = 31;
  const r = await queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60 });
  assert.equal(r.kind, "OBSERVED"); assert.equal(m.state.sends.length, 1); assert.equal(m.state.sends[0], "https://trade.joinpay.com/tradeRt/queryRefund");
  assert.equal(m.state.attempts.length, 2); assert.equal(m.state.attempts[1][2], "QUERY");
  assert.equal(m.state.attempts.filter((a: any[]) => a[2] === "SUBMIT").length, 1);
  const body = new URLSearchParams(Buffer.from(m.state.attempts[1][10]).toString());
  assert.equal(body.get("p2_RefundOrderNo"), "RF" + "a".repeat(28));
  assert.equal(r.terminal, null);
});

test("SYNTHETIC_QUERY_ONLY：READY枚举但锁内已有SUBMIT attempt时仍不首派", async t => {
  const m = executionModel(t); m.state.attempts.push(["existing_submit", "refund_model_1", "SUBMIT"]);
  m.state.row.state = "READY"; m.state.row.lease_version = "0"; m.state.row.lease_owner = null; m.state.row.lease_until = 0; m.state.due = true;
  const r = await queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60 });
  assert.equal(r.kind, "OBSERVED"); assert.equal(m.state.sends[0], "https://trade.joinpay.com/tradeRt/queryRefund");
  assert.equal(m.state.attempts[1][2], "QUERY"); assert.equal(m.state.attempts.filter((a: any[]) => a[2] === "SUBMIT").length, 1);
});

test("SYNTHETIC_QUERY_ONLY：终态/复核/活跃lease/未到期/节流/预算分别不取钥外呼", async t => {
  const m = executionModel(t), id = "refund_model_1", call = () => queryJoinpayRefund(m.options, id, "worker_q", { minimumIntervalSeconds: 60 });
  const reset = () => { m.state.row = { id, state: "UNKNOWN", lease_version: "1", revision: "2", lease_owner: "old_owner", lease_until: 1,
    terminal_evidence_id: null, merchant_identity_id: m.options.admission.merchantIdentityId, original_payment_trx_no: "PAY_MODEL_TRX", requires_review: false,
    budget_disposition: "ALLOCATED" } as any; m.state.attempts = []; m.state.now = 31; m.state.due = true; m.state.intervalOk = true; };
  reset(); m.state.row.state = "SUCCEEDED"; assert.deepEqual(await call(), { kind: "SKIPPED", intentId: id, state: "SUCCEEDED", reason: "TERMINAL" });
  reset(); m.state.row.state = "REVIEW_REQUIRED"; assert.deepEqual(await call(), { kind: "SKIPPED", intentId: id, state: "REVIEW_REQUIRED", reason: "REVIEW_REQUIRED" });
  reset(); m.state.row.requires_review = true; assert.deepEqual(await call(), { kind: "SKIPPED", intentId: id, state: "UNKNOWN", reason: "REVIEW_REQUIRED" });
  reset(); m.state.row.lease_until = 61; assert.deepEqual(await call(), { kind: "SKIPPED", intentId: id, state: "UNKNOWN", reason: "ACTIVE_LEASE" });
  reset(); m.state.row.state = "READY"; m.state.row.lease_version = "0"; m.state.row.lease_owner = null; m.state.row.lease_until = 0; m.state.due = false;
  assert.deepEqual(await call(), { kind: "NOT_DISPATCHED", intentId: id, state: "READY" });
  reset(); m.state.attempts = [["s", id, "SUBMIT"]]; m.state.due = false;
  assert.deepEqual(await call(), { kind: "SKIPPED", intentId: id, state: "UNKNOWN", reason: "NOT_DUE" });
  reset(); m.state.attempts = [["s", id, "SUBMIT"], ["q", id, "QUERY"]]; m.state.intervalOk = false;
  assert.deepEqual(await call(), { kind: "SKIPPED", intentId: id, state: "UNKNOWN", reason: "THROTTLED" });
  reset(); m.state.attempts = [["s", id, "SUBMIT"], ...Array.from({ length: 10 }, (_, i) => ["q" + i, id, "QUERY"])]; m.state.intervalOk = true;
  assert.deepEqual(await call(), { kind: "SKIPPED", intentId: id, state: "UNKNOWN", reason: "BUDGET_EXHAUSTED" });
  assert.equal(m.state.keys, 0); assert.equal(m.state.sends.length, 0); assert.equal(m.state.audits.length, 0);
});

test("SYNTHETIC_QUERY_ONLY：authorize拒绝在资金锁前回滚，0lease0attempt0钥0外呼", async t => {
  const m = executionModel(t);
  await assert.rejects(queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60,
    authorize: async () => { m.order.push("authorize"); throw Object.assign(Error("DENIED"), { code: "FORBIDDEN" }); } }),
  (e: any) => e.code === "FORBIDDEN");
  assert.deepEqual(m.order, ["authorize"]); assert.equal(m.state.keys, 0); assert.equal(m.state.sends.length, 0);
  assert.equal(m.state.attempts.length, 0); assert.equal(m.state.audits.length, 0);
  assert.equal(m.state.row.lease_version, "0"); assert.equal(m.state.row.lease_owner, null);
});

test("SYNTHETIC_QUERY_ONLY：错签名不消费/旧lease只STALE；关闭新准入不阻塞QUERY", async t => {
  const m = executionModel(t), profiles = require("../src/order/joinpay-refund-profile"); let starts = 0;
  t.mock.method(profiles, "assertRefundStart", () => { starts++; throw Error("NEW_SUBMIT_CLOSED"); });
  m.state.row.state = "UNKNOWN"; m.state.row.lease_version = "1"; m.state.row.lease_owner = "old_owner"; m.state.row.lease_until = 1; m.state.now = 31;
  m.state.attempts.push(["s", "refund_model_1", "SUBMIT"]);
  const q = model("QUERY"), bad = JSON.stringify({ ...JSON.parse(q.responseBody), hmac: "0".repeat(32) });
  m.options.fetch = async () => new Response(bad);
  const badResult = await queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60 });
  assert.equal(badResult.kind, "OBSERVED"); assert.equal(badResult.terminal, null); assert.equal(starts, 0);
  assert.equal(m.state.row.state, "UNKNOWN"); assert.equal(m.state.observations.at(-1)![18], "MISMATCH");
  m.state.row.lease_until = 1; m.state.now = 31;
  m.options.fetch = async () => { m.state.now = 200; return new Response(q.responseBody); };
  const stale = await queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60 });
  assert.equal(stale.kind, "OBSERVED"); assert.equal(stale.event, "STALE"); assert.equal(m.state.observations.at(-1)![16], "STALE");
});


test("SYNTHETIC_QUERY_ONLY：领取COMMIT未知0出网；旧UNKNOWN保留，下次QUERY为新attempt", async t => {
  const m = executionModel(t); m.state.row.state = "UNKNOWN"; m.state.row.lease_version = "1"; m.state.row.lease_owner = "old";
  m.state.row.lease_until = 1; m.state.now = 31; m.state.attempts.push(["s", "refund_model_1", "SUBMIT"]); m.state.unknownCommit = 1;
  await assert.rejects(queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60 }),
    (e: any) => e instanceof RefundAttemptCommitUnknown && e.phase === "CLAIM");
  assert.equal(m.state.sends.length, 0); assert.equal(m.state.attempts.length, 2);
  m.state.now = 100; const r = await queryJoinpayRefund(m.options, "refund_model_1", "worker_q", { minimumIntervalSeconds: 60 });
  assert.equal(r.kind, "OBSERVED"); assert.equal(m.state.attempts.length, 3); assert.equal(m.state.attempts.at(-1)[2], "QUERY");
});

test("SYNTHETIC_SQL_NULL_MODEL：真实首派空lease映射为不活跃，不误报时序证据缺失", async t => {
  const m=executionModel(t);m.state.row.lease_until=null;
  const before=structuredClone(m.state.row);
  assert.deepEqual(await queryJoinpayRefund(m.options,"refund_model_1","worker_q",{minimumIntervalSeconds:60}),
    {kind:"NOT_DISPATCHED",intentId:"refund_model_1",state:"READY"});
  assert.deepEqual(m.state.row,before);assert.equal(m.state.keys,0);assert.equal(m.state.sends.length,0);
  assert.equal(m.state.attempts.length,0);assert.equal(m.state.audits.length,0);
});

test("SYNTHETIC_RECOVERY_GAP：非初始枚举或正lease版本也不能替代持久SUBMIT依据", async t => {
  const m=executionModel(t);m.state.now=31;
  for(const [state,version] of [["READY","1"],["UNKNOWN","1"],["PROCESSING","2"]]){
    Object.assign(m.state.row,{state,lease_version:version,lease_until:1});const before=structuredClone(m.state.row);
    assert.deepEqual(await queryJoinpayRefund(m.options,"refund_model_1","worker_q",{minimumIntervalSeconds:60}),
      {kind:"NOT_DISPATCHED",intentId:"refund_model_1",state});
    assert.deepEqual(m.state.row,before);
  }
  assert.equal(m.state.keys,0);assert.equal(m.state.sends.length,0);assert.equal(m.state.attempts.length,0);assert.equal(m.state.audits.length,0);
});
