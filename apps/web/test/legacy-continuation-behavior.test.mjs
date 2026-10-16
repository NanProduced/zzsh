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
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function setup(t, api = {}) {
  const browser = new Window({url:"http://fixture.invalid/account"}); Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Node:browser.Node,Event:browser.Event,IS_REACT_ACT_ENVIRONMENT:true});
  const {createRoot} = require("react-dom/client"), host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const session = {status:"authenticated",userId:"user_A",identityVersion:1,revalidate(){}};
  const intents = require(path.join(tree,"apps/web/src/lib/order-intents.ts"));
  const helpers = load("apps/web/src/lib/legacy-continuation-client.ts",{"./order-client.ts":{}});
  const calls = [], client = {read:async()=>view(),preview:async()=>({revision:null,inputEvidenceId:"evidence_source",proposalFingerprint:digest,previewAmounts:{},proposalAmounts:{refundNet:"82.00"}}),write:async(...args)=>{calls.push(args);throw new Error("network uncertain");},receipt:async()=>({state:"UNKNOWN"}),...api};
  const {LegacyContinuationPanel} = load("apps/web/src/components/order/legacy-continuation-panel.tsx",{
    "@/components/session/user-session-provider":{useUserSession:()=>session},"@/lib/order-client":{orderIntentKey:()=>"ORIGINAL_KEY",OrderRequestError:class extends Error{}},"@/lib/order-intents":intents,"@/lib/legacy-continuation-client":{legacyContinuationApi:client,parseLegacyQuantitiesInput:helpers.parseLegacyQuantitiesInput}
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
test("original body/key is retained before POST, uncertain result reads receipt and retries only original bytes",async t=>{
  const p=await setup(t);await p.render();await p.click("确认本次结算");await p.click("确认提交");
  assert.equal(p.calls.length,1);const original=p.intents.inspectIntent("user_A","legacy.continuation",id);assert.equal(original.state,"VALID");assert.equal(original.intent.key,"ORIGINAL_KEY");assert.deepEqual(p.calls[0].slice(1),["confirm",original.intent.body,"ORIGINAL_KEY"]);
  await p.click("核对原请求结果");await p.click("重试原请求");assert.equal(p.calls.length,2);assert.deepEqual(p.calls[1],p.calls[0]);assert.equal(p.intents.inspectIntent("user_A","legacy.continuation",id).state,"VALID");
  p.client.receipt=async()=>({state:"KNOWN_REJECTED",status:409,fingerprint:digest,receipt:{outcome:"REJECTED"}});await p.click("核对原请求结果");assert.equal(p.intents.inspectIntent("user_A","legacy.continuation",id).state,"VALID");await p.click("刷新后重新核对");assert.equal(p.intents.inspectIntent("user_A","legacy.continuation",id).state,"NONE");
});
test("bad pending bytes block mutations while history remains readable",async t=>{
  const p=await setup(t), key=`zzsh.order-intent.v1:user_A:legacy.continuation:${id}`;p.browser.sessionStorage.setItem(key,"{BROKEN_PENDING");await p.render();
  assert(p.host.textContent.includes("82.00"));assert(p.host.textContent.includes("原请求记录暂时无法读取"));assert.equal(p.browser.sessionStorage.getItem(key),"{BROKEN_PENDING");
  assert([...p.host.querySelectorAll("button")].find(b=>b.textContent==="确认本次结算").disabled);assert.equal(p.calls.length,0);
});
test("scope render hides private amounts and confirmation before passive clearing, late old read cannot repaint",async t=>{
  let resolveOld;const late = new Promise(resolve=>{resolveOld=resolve;});let reads=0;
  const p=await setup(t,{read:async()=>++reads===1?view({amounts:{refundNet:{cents:"123456",yuan:"1234.56"}}}):reads===2?late:view({amounts:{payMoney:{cents:"200",yuan:"2.00"}}})});
  const commits=[];function Probe({scope}){React.useLayoutEffect(()=>{commits.push({scope,text:p.host.textContent});},[scope]);return React.createElement(p.LegacyContinuationPanel,{orderId:id,party:"owner"});}
  await p.render(React.createElement(Probe,{scope:"A"}));await p.click("确认本次结算");assert(p.host.textContent.includes("1234.56"));
  p.session.userId="user_B";p.session.identityVersion++;await p.render(React.createElement(Probe,{scope:"B"}));const first=commits.find(c=>c.scope==="B");assert(first);assert(!first.text.includes("1234.56"));assert(!first.text.includes("确认提交"));
  p.session.userId="user_C";p.session.identityVersion++;await p.render(React.createElement(Probe,{scope:"C"}));await React.act(async()=>{resolveOld(view({amounts:{refundNet:{cents:"999999",yuan:"9999.99"}}}));await tick();});
  // A late B response cannot repaint the current C identity.
  assert(!p.host.textContent.includes("1234.56"));assert(!p.host.textContent.includes("9999.99"));assert.equal(p.calls.length,0);
});
test("read errors and isolated facts remain distinct from empty or successful continuation",async t=>{
  const p=await setup(t,{read:async()=>{throw new Error("missing schema");}});await p.render();assert(p.host.textContent.includes("暂不可用"));assert(!p.host.textContent.includes("正在核对续办资料"));assert.equal(p.calls.length,0);
});
