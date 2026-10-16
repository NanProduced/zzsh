import assert from "node:assert/strict";
import {test} from "node:test";
import {createRequire,Module} from "node:module";
import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../.."),require=createRequire(path.join(tree,"package.json")),ts=require("typescript"),React=require("react"),{Window}=require("happy-dom");
const orderId="legacy_order_"+"a".repeat(40),digest="b".repeat(64);
function load(file,overrides={}){const m=new Module(path.join(tree,file));m.filename=path.join(tree,file);m.paths=Module._nodeModulePaths(tree);m.require=name=>overrides[name]??(name.endsWith(".css")?{}:require(name));m._compile(ts.transpileModule(fs.readFileSync(m.filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,m.filename);return m.exports;}
function client(request){return load("apps/admin/src/lib/legacy-continuation-client.ts",{"../api":{adminRequest:request},"./supply-write-lock":require(path.join(tree,"apps/admin/src/lib/supply-write-lock.ts"))});}
function storage(t){const w=new Window({url:"http://fixture.invalid/orders"});Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Node:w.Node,Event:w.Event,sessionStorage:w.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true});t.after(()=>w.happyDOM.abort());return w;}
function view(patch={}){return {schema:"legacy-continuation.v1",availability:"KNOWN",revision:"2",evidenceId:"evidence_result",stage:"4",isSettle:"2",amounts:{refundNet:{cents:"8200",yuan:"82.00"}},capabilities:["release","confiscate"],commandFingerprints:{release:digest,confiscate:digest},duties:[],reasons:[],channelState:"UNKNOWN",...patch};}
const snapshot={authenticated:true,adminUserId:"admin_A",session:{id:"session_A"},security:{isBoss:false},permissions:["order.read","order.legacy.continue"]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test("admin pending is retained before write, same subject cannot overwrite, corrupt marker is never deleted",async t=>{
 storage(t);const calls=[],c=client(async(...args)=>{calls.push(args);throw new Error("unknown commit");}),subject=c.legacyAdminSubject("a",orderId);
 const body={expectedRevision:"2",inputEvidenceId:"evidence_result",planFingerprint:digest},intent=await c.retainLegacyAdminIntent(subject,orderId,"release",body);
 assert.equal(c.inspectLegacyAdminIntent(subject,orderId).state,"VALID");await assert.rejects(()=>c.retainLegacyAdminIntent(subject,orderId,"release",body),/不能覆盖/);
 await assert.rejects(()=>c.sendLegacyAdminIntent(intent),/unknown commit/);assert.deepEqual(calls[0].slice(1),[body,"POST",{"idempotency-key":intent.key}]);assert.equal(c.inspectLegacyAdminIntent(subject,orderId).intent.key,intent.key);
 const key="zzsh.admin.legacy-continuation.v1:"+encodeURIComponent(subject);sessionStorage.setItem(key,"{BROKEN");assert.equal(c.inspectLegacyAdminIntent(subject,orderId).state,"UNREADABLE");c.clearLegacyAdminIntent(intent);assert.equal(sessionStorage.getItem(key),"{BROKEN");assert.equal(c.inspectLegacyAdminIntent(c.legacyAdminSubject("b",orderId),orderId).state,"NONE");
});
test("current source amount shape is checked and successful receipt must bind full original operation/body fingerprint",async t=>{
 storage(t);let reply={state:"UNKNOWN"};const c=client(async()=>reply),s=c.legacyAdminSubject("a",orderId),body={expectedRevision:"2",inputEvidenceId:"evidence_result",planFingerprint:digest},intent=await c.retainLegacyAdminIntent(s,orderId,"release",body);
 assert.equal((await c.recoverLegacyAdminIntent(intent)).state,"UNKNOWN");reply={state:"KNOWN_SUCCESS",status:200,fingerprint:digest,receipt:{}};await assert.rejects(()=>c.recoverLegacyAdminIntent(intent),/绑定不一致/);
 const bytes=new TextEncoder().encode(JSON.stringify(["order.legacy.continuation.release",orderId,{kind:"release",...body}]));reply.fingerprint=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");reply.receipt={orderId,command:"release",inputEvidenceId:"evidence_result",revision:"3",versionId:"version_done",resultEvidenceId:"result_done",stage:"4",channelState:"UNKNOWN"};assert.equal((await c.recoverLegacyAdminIntent(intent)).state,"KNOWN_SUCCESS");
 const parsed=c.parseLegacyAdminView({...view(),source_snapshot:{secret:"PRIVATE"}});assert(!JSON.stringify(parsed).includes("PRIVATE"));assert.throws(()=>c.parseLegacyAdminView(view({amounts:{refundNet:{cents:"8200",yuan:"87.00"}}})));
});
test("admin identity or permission change hides details/confirmation in the first layout commit; late old read cannot repaint",async t=>{
 const w=storage(t),{createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 let reads=0,resolveLate;const late=new Promise(resolve=>{resolveLate=resolve;}),api=client(async()=>view());
 api.readLegacyAdminContinuation=async()=>++reads===1?view({amounts:{refundNet:{cents:"123456",yuan:"1234.56"}}}):reads===2?late:view({amounts:{}});
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{"../api":{friendlyError:()=>"暂不可用",formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 const commits=[];function Probe({s}){React.useLayoutEffect(()=>{commits.push({id:s.adminUserId,text:host.textContent});},[s]);return React.createElement(LegacyAdminContinuationPanel,{snapshot:s,orderId});}
 const render=async s=>React.act(async()=>{root.render(React.createElement(Probe,{s}));await tick();});await render(snapshot);assert(host.textContent.includes("1234.56"));
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="解除暂扣").click();await tick();});assert(host.textContent.includes("请核对当前版本与来源责任"));
 const b={...snapshot,adminUserId:"admin_B",session:{id:"session_B"},permissions:["order.read"]};await render(b);assert(!commits.find(c=>c.id==="admin_B").text.includes("1234.56"));assert(!host.textContent.includes("请核对当前版本与来源责任"));
 await render({...b,adminUserId:"admin_C",session:{id:"session_C"}});await React.act(async()=>{resolveLate(view({amounts:{refundNet:{cents:"999999",yuan:"9999.99"}}}));await tick();});assert(!host.textContent.includes("9999.99"));assert.equal(w.sessionStorage.length,0);
});
