import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseAftersalePage, parseAftersaleRecord } from "../../../packages/im-client/src/aftersale.ts";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../.."),require=createRequire(root+"/package.json"),ts=require("typescript"),React=require("react"),{Window}=require("happy-dom");
const row=(id="ASrecord1",description="本人的订单问题")=>({id,orderSource:"NATIVE",orderId:"order",orderDisplayNo:"DD-TEST",requesterParty:"RENTER",description,state:"PENDING",result:null,version:1,handler:null,createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-01T00:00:00Z",resolvedAt:null});
const page=(items=[],canSubmit=true)=>({items,canSubmit,nextCursor:null});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test("aftersale response boundary rejects malformed status/handler instead of rendering false completion",()=>{
  assert.equal(parseAftersaleRecord(row()).state,"PENDING");assert.throws(()=>parseAftersaleRecord({...row(),state:"RESOLVED"}));
  assert.throws(()=>parseAftersaleRecord({...row(),orderSource:"LEGACY"}));assert.throws(()=>parseAftersaleRecord({...row(),handler:{id:"x",name:""}}));
  assert.throws(()=>parseAftersalePage({items:[],nextCursor:null}));assert.equal(parseAftersalePage(page()).canSubmit,true);
});
async function harness(t,fetcher){
  const browser=new Window({url:"http://127.0.0.1:4220/orders/order"});Object.assign(globalThis,{window:browser,document:browser.document,HTMLElement:browser.HTMLElement,Element:browser.Element,Node:browser.Node,Event:browser.Event,CustomEvent:browser.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(globalThis,"navigator",{value:browser.navigator,configurable:true});
  let session={status:"authenticated",userId:"renter",identityVersion:1,confirm:async()=>{}},contacts=[];
  const filename=root+"/apps/web/src/components/order/order-aftersale.tsx",compiled=ts.transpileModule(readFileSync(filename,"utf8"),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod=new Module(filename);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod.require=name=>{
    if(name==="@/components/session/user-session-provider")return {useUserSession:()=>session};
    if(name==="@/components/support/support-dialog-request")return {requestSupportDialog:(...args)=>contacts.push(args)};
    return require(name);
  };mod._compile(compiled,filename);
  const oldFetch=globalThis.fetch;globalThis.fetch=fetcher;const host=browser.document.createElement("div");browser.document.body.append(host);const dom=require("react-dom/client").createRoot(host);
  const settle=()=>React.act(async()=>{await new Promise(r=>setImmediate(r));});
  const render=()=>React.act(async()=>{dom.render(React.createElement(React.StrictMode,null,React.createElement(mod.exports.OrderAftersale,{orderId:"order",orderDisplayNo:"DD-TEST"})));});
  const input=async value=>React.act(async()=>{const e=host.querySelector("textarea");assert.ok(e);Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype,"value").set.call(e,value);e.dispatchEvent(new browser.Event("input",{bubbles:true}));});
  const click=async label=>React.act(async()=>{const e=[...host.querySelectorAll("button")].find(e=>e.textContent===label);assert.ok(e,`missing ${label}`);e.click();});
  const submit=()=>React.act(async()=>{host.querySelector("form").dispatchEvent(new browser.Event("submit",{bubbles:true,cancelable:true}));});
  t.after(async()=>{await React.act(async()=>dom.unmount());globalThis.fetch=oldFetch;browser.happyDOM.abort();});
  await render();await settle();return {host,contacts,input,click,submit,settle,render,session:value=>{session=value;}};
}
test("record submission guards reentry, retains the old operation after lost ACK and preserves drafts on refresh",async t=>{
  const writes=[],first=deferred();let saved=false;
  const h=await harness(t,async(url,init={})=>{
    if(init.method==="POST"){writes.push(JSON.parse(init.body));if(writes.length===1)return first.promise;saved=true;return Response.json({record:row("ASsaved",writes[0].description),created:false,replayed:true});}
    return Response.json(page(saved?[row("ASsaved",writes[0].description)]:[]));
  });
  await h.input("需要跟进的原始问题");await h.click("刷新记录");await h.settle();assert.equal(h.host.querySelector("textarea").value,"需要跟进的原始问题");
  await h.submit();await h.submit();assert.equal(writes.length,1);
  await React.act(async()=>first.reject(new TypeError("network")));await h.settle();assert.match(h.host.textContent,/结果未确认/);assert.equal(h.host.querySelector("textarea").value,writes[0].description);
  await h.submit();await h.settle();assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);assert.match(h.host.textContent,/ASsaved/);assert.equal(h.host.querySelector("form"),null);
  await h.click("联系客服");assert.equal(h.contacts.at(-1)[2].subjectRef,"order:order");assert.equal(h.contacts.at(-1)[2].userId,"renter");
});
test("an identity switch hides prior records and ignores a late successful submission",async t=>{
  const pending=deferred();let getCount=0;
  const h=await harness(t,async(url,init={})=>init.method==="POST"?pending.promise:Response.json(page(++getCount>2?[row("ASowner","新的号主记录")]:[])));
  await h.input("旧身份未提交内容");await h.submit();
  h.session({status:"authenticated",userId:"owner",identityVersion:2,confirm:async()=>{}});await h.render();await h.settle();
  await React.act(async()=>pending.resolve(Response.json({record:row("ASlate","旧身份未提交内容"),created:true,replayed:false})));await h.settle();
  assert.doesNotMatch(h.host.textContent,/旧身份未提交内容|ASlate/);
});
