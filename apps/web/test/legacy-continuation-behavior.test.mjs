import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire, Module } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."), require = createRequire(path.join(tree,"package.json"));
const React = require("react"), ts = require("typescript"), { Window } = require("happy-dom");
const id = "legacy_order_" + "a".repeat(40), digest = "c".repeat(64);
const quantities = { expendHaff:"1",barrett:"0",bullet:"0",awm:"0",armor:"0",helmet:"0",coffee:"0",card:"0" };
const view = (patch = {}) => ({schema:"legacy-continuation.v1",availability:"KNOWN",revision:null,evidenceId:"evidence_source",stage:"8",isSettle:"0",amounts:{refundNet:{cents:"8200",yuan:"82.00"},detainMoney:{cents:"500",yuan:"5.00"}},quantities,capabilities:["confirm","reject"],commandFingerprints:{confirm:digest,reject:digest},reasons:[],duties:[],channelState:"UNKNOWN",...patch});
function load(file, overrides = {}) {
  const m = new Module(path.join(tree,"legacy-probe.cjs")); m.filename = path.join(tree,file); m.paths = Module._nodeModulePaths(tree);
  m.require = name => overrides[name] ?? require(name);
  m._compile(ts.transpileModule(fs.readFileSync(m.filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,m.filename);
  return m.exports;
}
test("legacy settlement preview rejects unrounded server amounts",async()=>{
  let amount="10.01";
  const client=load("apps/web/src/lib/legacy-continuation-client.ts",{"./order-client.ts":{
    requestOrderWrite:async()=>({revision:null,inputEvidenceId:"evidence_source",proposalFingerprint:digest,previewAmounts:{refundNet:amount},proposalAmounts:{refundNet:amount}}),
  }}).legacyContinuationApi;
  assert.equal((await client.preview("user_A",id,quantities)).proposalAmounts.refundNet,"10.01");
  amount="10.00000000";assert.equal((await client.preview("user_A",id,quantities)).proposalAmounts.refundNet,"10.00");
  amount="10.005";await assert.rejects(client.preview("user_A",id,quantities),/预估结果暂不可用/);
});
test("legacy original-key recovery binds the selected ending reason",async()=>{
 const {legacyIntentFingerprint}=load("apps/web/src/lib/legacy-continuation-client.ts",{"./order-client.ts":{}});
 const body={expectedRevision:null,inputEvidenceId:"evidence_source",planFingerprint:digest,quantities,endReason:"TENANT_VOLUNTARY_EARLY"};
 const input={kind:"propose",expectedRevision:null,inputEvidenceId:body.inputEvidenceId,planFingerprint:digest,quantities,endReason:body.endReason};
 const expected=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['order.legacy.continuation.propose',id,input])))).toString('hex');
 assert.equal(await legacyIntentFingerprint(id,'propose',body),expected);
 assert.notEqual(await legacyIntentFingerprint(id,'propose',{...body,endReason:'OWNER_OR_ACCOUNT_EARLY'}),expected);
});
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function setup(t, api = {}) {
  const browser = new Window({url:"http://fixture.invalid/account"}); Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,IS_REACT_ACT_ENVIRONMENT:true});
  const {createRoot} = require("react-dom/client"), host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const session = {status:"authenticated",userId:"user_A",identityVersion:1,revalidate(){}};
  const intents = require(path.join(tree,"apps/web/src/lib/order-intents.ts"));
  const helpers = load("apps/web/src/lib/legacy-continuation-client.ts",{"./order-client.ts":{}});
  const calls = [], client = {read:async()=>view(),preview:async()=>({revision:null,inputEvidenceId:"evidence_source",proposalFingerprint:digest,previewAmounts:{},proposalAmounts:{refundNet:"82.00"}}),write:async(...args)=>{calls.push(args);throw new Error("network uncertain");},receipt:async()=>({state:"UNKNOWN"}),...api};
  const {LegacyContinuationPanel} = load("apps/web/src/components/order/legacy-continuation-panel.tsx",{
    "@/components/session/user-session-provider":{useUserSession:()=>session},"@/components/ui/form-controls":{FormSelect:({label,value,options,onChange,disabled})=>React.createElement('select',{'aria-label':label,value,disabled,onChange:e=>onChange(e.target.value)},React.createElement('option',{value:''},'请选择'),...options.map(o=>React.createElement('option',{key:o.value,value:o.value},o.label)))},"@/lib/order-client":{orderIntentKey:()=>"ORIGINAL_KEY",formatOrderTime:x=>x,OrderRequestError:class extends Error{}},"@/lib/order-intents":intents,"@/lib/legacy-continuation-client":{legacyContinuationApi:client,parseLegacyQuantitiesInput:helpers.parseLegacyQuantitiesInput}
  });
  const render = async wrapper => React.act(async()=>{root.render(wrapper??React.createElement(LegacyContinuationPanel,{orderId:id,party:"owner"}));await tick();});
  t.after(async()=>{await React.act(async()=>root.unmount());await browser.happyDOM.abort();});
  const click = async text => {const button=[...host.querySelectorAll("button")].find(b=>b.textContent===text);assert(button,`missing ${text}`);await React.act(async()=>{button.click();await tick();});};
  return {session,host,root,browser,client,calls,intents,LegacyContinuationPanel,render,click};
}
test("wire parsing strips private source, refuses inconsistent money and does not synthesize missing quantities",()=>{
  const {parseLegacyContinuation,parseLegacyQuantitiesInput} = load("apps/web/src/lib/legacy-continuation-client.ts",{"./order-client.ts":{}});
  const parsed=parseLegacyContinuation({...view(),privatePhone:"PRIVATE",source_snapshot:{password:"PRIVATE"}});assert(!JSON.stringify(parsed).includes("PRIVATE"));
  assert.throws(()=>parseLegacyContinuation(view({amounts:{refundNet:{cents:"8200",yuan:"87.00"}}})));
  assert.throws(()=>parseLegacyQuantitiesInput({expendHaff:"1"}));
  assert.equal(parseLegacyContinuation(view({availability:"NOT_IMPORTED",quantities:null,capabilities:[],amounts:{}})).quantities,null);
});
test("verified legacy opening facts survive the user projection without exposing internal prices",()=>{
 const {parseLegacyContinuation}=load("apps/web/src/lib/legacy-continuation-client.ts",{"./order-client.ts":{}});
 const basis={id:"basis_1",openingHaffM:"1",openingItems:{...quantities,coffee:null},fullPayout:false,source:"STAFF_VERIFIED",ownerPrices:{coffee:"PRIVATE"}};
 const parsed=parseLegacyContinuation(view({stage:"3",settlementBasis:basis}));
 assert.deepEqual(parsed.settlementBasis,{id:"basis_1",openingHaffM:"1",openingItems:{...quantities,coffee:null},fullPayout:false,source:"STAFF_VERIFIED"});
 assert(!JSON.stringify(parsed).includes("PRIVATE"));
 assert.equal(parseLegacyContinuation(view({settlementBasis:undefined})).settlementBasis,null);
 assert.deepEqual(parseLegacyContinuation(view({settlementBasis:{id:"basis_1",openingHaffM:"1"}})).settlementBasis,
  {id:"basis_1",openingHaffM:"1",openingItems:null,fullPayout:null,source:null});
 assert.throws(()=>parseLegacyContinuation(view({settlementBasis:{...basis,openingHaffM:"NaN"}})));
 assert.throws(()=>parseLegacyContinuation(view({settlementBasis:{...basis,fullPayout:"false"}})));
});
test('legacy simulated refund requires an explicit demo scope and remains distinct from channel success',()=>{
 const {parseLegacyContinuation}=load('apps/web/src/lib/legacy-continuation-client.ts',{'./order-client.ts':{}});
 const duty={id:'refund',kind:'RENTER_REFUND',amountCents:'8200',currency:'CNY',status:'SETTLED',maturityAt:null,sourceStatus:null,revision:'1',settledBy:'FINANCE',financeVerified:true,refundProgress:'SIMULATED',refundSimulationScope:'LOCAL_DEMO_SIMULATED'};
 assert.equal(parseLegacyContinuation(view({stage:'4',capabilities:[],duties:[duty]})).duties[0].refundProgress,'SIMULATED');
 assert.throws(()=>parseLegacyContinuation(view({stage:'4',capabilities:[],duties:[{...duty,refundSimulationScope:undefined}]})));
 assert.throws(()=>parseLegacyContinuation(view({stage:'4',capabilities:[],duties:[{...duty,refundProgress:'CHANNEL_SUCCEEDED'}]})));
});
test('renter sees a simulated old-order refund without a bank-arrival claim',async t=>{
 const duty={id:'refund',kind:'RENTER_REFUND',amountCents:'8200',status:'SETTLED',settledBy:'FINANCE',refundProgress:'SIMULATED'};
 const p=await setup(t,{read:async()=>view({stage:'4',capabilities:[],duties:[duty]})});await p.render(React.createElement(p.LegacyContinuationPanel,{orderId:id,party:'renter'}));
 assert.match(p.host.textContent,/模拟退款已记录，不代表真实退款或到账/);assert.doesNotMatch(p.host.textContent,/渠道已确认退款/);
});
test('cancelled legacy order shows its pending refund without claiming channel success',async t=>{
 const duty={id:'refund',kind:'RENTER_REFUND',amountCents:'5000',status:'PENDING',settledBy:null};
 const p=await setup(t,{read:async()=>view({stage:'5',availability:'ISOLATED',capabilities:[],duties:[duty],refundDueAt:'2026-11-14T08:00:00Z'})});
 await p.render(React.createElement(p.LegacyContinuationPanel,{orderId:id,party:'renter',readOnly:true}));
 assert.match(p.host.textContent,/订单已取消/);assert.match(p.host.textContent,/租客退款/);assert.match(p.host.textContent,/¥50\.00/);
 assert.match(p.host.textContent,/到账以实际退款进度为准/);assert.doesNotMatch(p.host.textContent,/渠道已确认退款|提交结算方案|确认提交/);
});
test("legacy in-flight renter sees units, explicit zero items and the disclosed early fee before submitting",async t=>{
 let submitted,endReason;
 const p=await setup(t,{read:async()=>view({stage:"3",quantities:null,capabilities:["propose"],amounts:{},commandFingerprints:{}}),
  preview:async(_subject,_order,values,reason)=>{submitted=values;endReason=reason;return {revision:null,inputEvidenceId:"evidence_source",proposalFingerprint:digest,previewAmounts:{},proposalAmounts:{returnOrderMoney:"94.00"},settlementKind:"EARLY",earlyFee:"5.00"};}});
 await p.render(React.createElement(p.LegacyContinuationPanel,{orderId:id,party:"renter"}));
 assert.match(p.host.textContent,/哈夫币消耗（M）/);assert.match(p.host.textContent,/6级子弹（组）/);assert.match(p.host.textContent,/1 组为 60 发/);
 const inputs=[...p.host.querySelectorAll("input")];assert.equal(inputs[0].value,"");assert(inputs.slice(1).every(item=>item.value==="0"));
 await React.act(async()=>{Object.getOwnPropertyDescriptor(p.browser.HTMLInputElement.prototype,"value").set.call(inputs[0],"0.10");inputs[0].dispatchEvent(new p.browser.Event("input",{bubbles:true}));await tick();});
 await React.act(async()=>{const select=p.host.querySelector('select[aria-label="结束原因"]');select.value="TENANT_VOLUNTARY_EARLY";select.dispatchEvent(new p.browser.Event("change",{bubbles:true}));await tick();});
 await p.click("核对结算结果");assert.equal(submitted.expendHaff,"0.10");assert.equal(submitted.bullet,"0");assert.equal(endReason,"TENANT_VOLUNTARY_EARLY");
 assert.match(p.host.textContent,/提前结算费用 ¥5\.00/);assert.match(p.host.textContent,/已计入下方退款金额/);assert.match(p.host.textContent,/94\.00/);
});
test("an existing early proposal explains its status without inventing a missing fee",async t=>{
 const p=await setup(t,{read:async()=>view({settlementKind:"EARLY",earlyFee:null})});await p.render();
 assert.match(p.host.textContent,/此方案属于提前结算/);assert.match(p.host.textContent,/详情可联系客服核对/);assert.doesNotMatch(p.host.textContent,/提前结算费用 ¥0/);
});
test("renter sees the earliest refund handling time without mistaking it for arrival",async t=>{
 const duty={id:"refund",kind:"RENTER_REFUND",amountCents:"8200",status:"PENDING",settledBy:null};
 const p=await setup(t,{read:async()=>view({stage:"4",capabilities:[],duties:[duty],refundDueAt:"2026-11-14T08:00:00Z"})});
 await p.render(React.createElement(p.LegacyContinuationPanel,{orderId:id,party:"renter"}));
 assert.match(p.host.textContent,/最早可在 2026-11-14T08:00:00Z 后处理/);assert.match(p.host.textContent,/到账以实际退款进度为准/);
 p.client.read=async()=>view({stage:"4",capabilities:[],duties:[duty],refundDueAt:null});await p.click("刷新");assert.match(p.host.textContent,/退款处理时间待核/);
 await p.render(React.createElement(p.LegacyContinuationPanel,{orderId:id,party:"owner"}));assert.doesNotMatch(p.host.textContent,/最早可在/);
});
test('renter is not told a booked refund liability has arrived',async t=>{
 const duty={id:'refund',kind:'RENTER_REFUND',amountCents:'8200',status:'SETTLED',settledBy:'FINANCE'};
 const p=await setup(t,{read:async()=>view({stage:'4',capabilities:[],duties:[duty]})});
 await p.render(React.createElement(p.LegacyContinuationPanel,{orderId:id,party:'renter'}));
 assert.match(p.host.textContent,/退款状态待核对/);assert.doesNotMatch(p.host.textContent,/退款成功|已到账/);
 p.client.read=async()=>view({stage:'4',capabilities:[],duties:[{...duty,refundProgress:'CHANNEL_SUCCEEDED'}]});
 await p.click('刷新');assert.match(p.host.textContent,/渠道已确认退款/);assert.doesNotMatch(p.host.textContent,/银行已到账/);
 p.client.read=async()=>view({stage:'4',capabilities:[],duties:[{...duty,refundProgress:'REVIEW_REQUIRED'}]});
 await p.click('刷新');assert.match(p.host.textContent,/退款状态待核对/);
 p.client.read=async()=>view({stage:'4',capabilities:[],duties:[{...duty,amountCents:'0',refundProgress:'NO_REFUND_DUE'}]});
 await p.click('刷新');assert.match(p.host.textContent,/无需退款/);assert.doesNotMatch(p.host.textContent,/旧退款已抵扣/);
});
test("owner distinguishes a credited platform balance from income still awaiting review",async t=>{
 const duty={id:"owner-duty",kind:"OWNER_CREDIT",amountCents:"1234",status:"SETTLED",settledBy:"FINANCE",financeVerified:true};
 const p=await setup(t,{read:async()=>view({stage:"4",capabilities:[],duties:[duty]})});
 await p.render(React.createElement(p.LegacyContinuationPanel,{orderId:id,party:"owner"}));
 assert.match(p.host.textContent,/出租收益/);assert.match(p.host.textContent,/已入平台余额/);
 p.client.read=async()=>view({stage:"4",capabilities:[],duties:[{...duty,financeVerified:false}]});
 await p.click("刷新");assert.match(p.host.textContent,/账目待核对/);assert.doesNotMatch(p.host.textContent,/已入平台余额/);
 p.client.read=async()=>view({stage:"4",capabilities:[],duties:[{...duty,status:"PENDING",settledBy:null}]});
 await p.click("刷新");assert.match(p.host.textContent,/待核对/);assert.doesNotMatch(p.host.textContent,/已入平台余额/);
});
test("original body/key is retained before POST, uncertain result reads receipt and retries only original bytes",async t=>{
  const p=await setup(t);await p.render();await p.click("确认结算方案");await p.click("确认提交");
  assert.equal(p.calls.length,1);const original=p.intents.inspectIntent("user_A","legacy.continuation",id);assert.equal(original.state,"VALID");assert.equal(original.intent.key,"ORIGINAL_KEY");
  assert.equal(p.calls[0][0],"user_A","the frozen intent owner is the request subject, not a later session value");assert.equal(p.calls[0][1],id);
  assert.deepEqual(p.calls[0].slice(2),["confirm",original.intent.body,"ORIGINAL_KEY"]);
  await p.click("查询处理进度");await p.click("继续提交上次申请");assert.equal(p.calls.length,2);assert.deepEqual(p.calls[1],p.calls[0]);assert.equal(p.intents.inspectIntent("user_A","legacy.continuation",id).state,"VALID");
  p.client.receipt=async()=>({state:"KNOWN_REJECTED",status:409,fingerprint:digest,receipt:{outcome:"REJECTED"}});await p.click("查询处理进度");assert.equal(p.intents.inspectIntent("user_A","legacy.continuation",id).state,"VALID");await p.click("刷新后重新核对");assert.equal(p.intents.inspectIntent("user_A","legacy.continuation",id).state,"NONE");
});
test("detail refresh is signalled after a direct or recovered success", async t => {
  for (const recovery of [false, true]) await t.test(recovery ? "recovered" : "direct", async sub => {
    const receipt = { orderId: id, revision: "1", stage: "4", channelState: "UNKNOWN" };
    const p = await setup(sub, {
      write: async () => { if (recovery) throw new Error("uncertain"); return receipt; },
      receipt: async () => ({ state: "KNOWN_SUCCESS", receipt }),
    });
    let refreshes = 0;
    await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner", onOrderChanged: () => refreshes++ }));
    await p.click("确认结算方案"); await p.click("确认提交");
    if (recovery) {
      assert.equal(refreshes, 0);
      await p.click("查询处理进度");
    }
    assert.equal(refreshes, 1);
    assert.equal(p.intents.inspectIntent("user_A", "legacy.continuation", id).state, "NONE");
  });
});
test("bad pending bytes block mutations while history remains readable",async t=>{
  const p=await setup(t), key=`zzsh.order-intent.v1:user_A:legacy.continuation:${id}`;p.browser.sessionStorage.setItem(key,"{BROKEN_PENDING");await p.render();
  assert(p.host.textContent.includes("82.00"));assert(p.host.textContent.includes("暂时无法确认上次操作"));assert.equal(p.browser.sessionStorage.getItem(key),"{BROKEN_PENDING");
  assert([...p.host.querySelectorAll("button")].find(b=>b.textContent==="确认结算方案").disabled);assert.equal(p.calls.length,0);
});
test("scope render hides private amounts and confirmation before passive clearing, late old read cannot repaint",async t=>{
  let resolveOld;const late = new Promise(resolve=>{resolveOld=resolve;});let reads=0;
  const p=await setup(t,{read:async()=>++reads===1?view({amounts:{refundNet:{cents:"123456",yuan:"1234.56"}}}):reads===2?late:view({amounts:{payMoney:{cents:"200",yuan:"2.00"}}})});
  const commits=[];function Probe({scope}){React.useLayoutEffect(()=>{commits.push({scope,text:p.host.textContent});},[scope]);return React.createElement(p.LegacyContinuationPanel,{orderId:id,party:"owner"});}
  await p.render(React.createElement(Probe,{scope:"A"}));await p.click("确认结算方案");assert(p.host.textContent.includes("1234.56"));
  p.session.userId="user_B";p.session.identityVersion++;await p.render(React.createElement(Probe,{scope:"B"}));const first=commits.find(c=>c.scope==="B");assert(first);assert(!first.text.includes("1234.56"));assert(!first.text.includes("确认提交"));
  p.session.userId="user_C";p.session.identityVersion++;await p.render(React.createElement(Probe,{scope:"C"}));await React.act(async()=>{resolveOld(view({amounts:{refundNet:{cents:"999999",yuan:"9999.99"}}}));await tick();});
  // A late B response cannot repaint the current C identity.
  assert(!p.host.textContent.includes("1234.56"));assert(!p.host.textContent.includes("9999.99"));assert.equal(p.calls.length,0);
});
test("read errors and isolated facts remain distinct from empty or successful continuation",async t=>{
  const p=await setup(t,{read:async()=>{throw new Error("missing schema");}});await p.render();assert(p.host.textContent.includes("暂时无法查看办理信息"));assert(!p.host.textContent.includes("正在核对续办资料"));assert.equal(p.calls.length,0);
});

test("terminal legacy order keeps records but blocks new continuation actions", async t => {
  const p = await setup(t);
  await p.render();
  await p.click("确认结算方案");
  assert.match(p.host.textContent, /确认提交/);
  await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner", readOnly: true }));
  assert.match(p.host.textContent, /82\.00/);
  assert.doesNotMatch(p.host.textContent, /确认结算方案|拒绝结算方案|确认提交/);
  assert.equal(p.calls.length, 0);
});

test("terminal legacy order preserves the original-key recovery entry", async t => {
  const p = await setup(t);
  p.intents.saveIntent({ userId: "user_A", kind: "legacy.continuation", resourceId: id, key: "ORIGINAL_KEY", body: { expectedRevision: null, inputEvidenceId: "evidence_source", planFingerprint: digest }, context: { command: "confirm" } });
  await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner", readOnly: true }));
  assert.match(p.host.textContent, /查询处理进度/);
  assert.doesNotMatch(p.host.textContent, /确认结算方案|拒绝结算方案/);
  assert.equal(p.intents.inspectIntent("user_A", "legacy.continuation", id).intent.key, "ORIGINAL_KEY");
  assert.equal(p.calls.length, 0);
});
test("a late legacy preview cannot return after the order becomes terminal", async t => {
  let resolvePreview;
  const preview = new Promise(resolve => { resolvePreview = resolve; });
  const p = await setup(t, { read: async () => view({ stage: "3", capabilities: ["propose"] }), preview: async () => preview });
  await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner" }));
  await React.act(async()=>{const select=p.host.querySelector('select[aria-label="结束原因"]');select.value="NORMAL";select.dispatchEvent(new p.browser.Event("change",{bubbles:true}));await tick();});
  await p.click("核对结算结果");
  await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner", readOnly: true }));
  await React.act(async () => { resolvePreview({ revision: null, inputEvidenceId: "evidence_source", proposalFingerprint: digest, previewAmounts: {}, proposalAmounts: { refundNet: "82.00" } }); await tick(); });
  await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner", readOnly: false }));
  assert.doesNotMatch(p.host.textContent, /提交结算方案/);
  assert.equal(p.calls.length, 0);
});

test("master review: a frozen A continuation intent is never replayed under B and keeps its original key", async t => {
  const p = await setup(t);
  p.intents.saveIntent({ userId: "user_A", kind: "legacy.continuation", resourceId: id, key: "ORIGINAL_KEY", body: {}, context: { command: "confirm" } });
  await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner" }));
  p.session.userId = "user_B"; p.session.identityVersion = 2;
  await p.render(React.createElement(p.LegacyContinuationPanel, { orderId: id, party: "owner" }));
  assert.equal(p.intents.inspectIntent("user_A", "legacy.continuation", id).intent.key, "ORIGINAL_KEY", "the original request remains stored");
  assert.equal(p.intents.inspectIntent("user_B", "legacy.continuation", id).state, "NONE", "no new key is created for B");
  assert.equal(p.calls.length, 0, "no cross-subject write is sent");
  assert.doesNotMatch(p.host.textContent, /继续提交上次申请/, "B cannot replay A's intent");
});
