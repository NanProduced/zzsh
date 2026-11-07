import assert from "node:assert/strict";
import {test} from "node:test";
import {createRequire,Module} from "node:module";
import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../.."),require=createRequire(path.join(tree,"package.json")),ts=require("typescript"),React=require("react"),{Window}=require("happy-dom");
const orderId="legacy_order_"+"a".repeat(40),digest="b".repeat(64);
function load(file,overrides={}){const m=new Module(path.join(tree,file));m.filename=path.join(tree,file);m.paths=Module._nodeModulePaths(tree);m.require=name=>overrides[name]??(name.endsWith(".css")?{}:require(name));m._compile(ts.transpileModule(fs.readFileSync(m.filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,m.filename);return m.exports;}
function client(request){return load("apps/admin/src/lib/legacy-continuation-client.ts",{"../api":{adminRequest:request},"./supply-write-lock":require(path.join(tree,"apps/admin/src/lib/supply-write-lock.ts"))});}
test("legacy settlement previews only display server amounts rounded to cents",async()=>{
 let amount="10.01";const c=client(async()=>({revision:"2",inputEvidenceId:"evidence_result",proposalFingerprint:digest,settlementKind:"NORMAL",proposalAmounts:{ownerNet:amount}}));
 const quantities={expendHaff:"1",barrett:"0",bullet:"0",awm:"0",armor:"0",helmet:"0",coffee:"0",card:"0"};
 assert.equal((await c.previewLegacyAdminContinuation(orderId,quantities,"owner")).proposalAmounts.ownerNet,"10.01");
 amount="10.00000000";assert.equal((await c.previewLegacyAdminContinuation(orderId,quantities,"owner")).proposalAmounts.ownerNet,"10.00");
 amount="10.005";await assert.rejects(c.previewLegacyAdminContinuation(orderId,quantities,"owner"),/预估暂不可用/);
});
test("authorized support can submit owner credit with a reason and clear wallet wording",async t=>{
 const w=storage(t),{createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const source=view({stage:"4",isSettle:"0",capabilities:[],duties:[{id:"duty_1",kind:"OWNER_CREDIT",amountCents:"1000",currency:"CNY",status:"PENDING",maturityAt:null,revision:"1",settledBy:null,sourceStatus:null}]});
 const api=client(async()=>source);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(source);let sent;
 api.sendLegacyAdminIntent=async intent=>{sent=intent;return {};};
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:e=>e.message,formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 const authorized={...snapshot,permissions:[...snapshot.permissions,"order.settlement.write"]};
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot:authorized,orderId}));await tick();});
 assert.match(host.textContent,/加入号主可用余额/);const textarea=host.querySelector('[aria-label="号主收益入账原因"]');
 await React.act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,"value").set.call(textarea,"核对双方订单结算");textarea.dispatchEvent(new w.Event("input",{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(button=>button.textContent==="核对并入账").click();await tick();});
 assert.match(host.textContent,/不代表银行卡已到账/);
 await React.act(async()=>{[...host.querySelectorAll("button")].find(button=>button.textContent==="确认入账号主收益").click();await tick();});
 assert.equal(sent.command,"owner-credit");assert.deepEqual(sent.body,{expectedRevision:"1",reason:"核对双方订单结算"});
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot,orderId}));await tick();});
 assert(!host.textContent.includes("核对并入账"));
});
test("owner credit recovery stays bound to the original duty, reason and ledger receipt",async t=>{
 storage(t);let reply={state:"UNKNOWN"};const c=client(async()=>reply),subject=c.legacyAdminSubject("staff",orderId);
 const body={expectedRevision:"1",reason:"双方订单已核对"},intent=await c.retainLegacyAdminIntent(subject,orderId,"owner-credit",body,"duty_1");
 const input={dutyId:"duty_1",kind:"owner-credit",expectedRevision:"1",reason:body.reason};
 const bytes=new TextEncoder().encode(JSON.stringify(["order.legacy.duty.owner-credit","duty_1",input]));
 const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(value=>value.toString(16).padStart(2,"0")).join("");
 const receipt={orderId,dutyId:"duty_1",revision:"2",status:"SETTLED",settledBy:"FINANCE",amountCents:"1000",reference:{type:"LEDGER_ENTRY",id:"line_1",digest},channelArrival:"UNKNOWN"};
 reply={state:"KNOWN_SUCCESS",status:200,fingerprint,receipt};assert.equal((await c.recoverLegacyAdminIntent(intent)).state,"KNOWN_SUCCESS");
 reply={...reply,receipt:{...receipt,dutyId:"other"}};await assert.rejects(c.recoverLegacyAdminIntent(intent),/待核对/);
 assert.equal(c.inspectLegacyAdminIntent(subject,orderId).state,"VALID");
});
test("admin sees credited income only when the financial record was verified",async t=>{
 storage(t);const {createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const duty={id:"owner-duty",kind:"OWNER_CREDIT",amountCents:"1000",currency:"CNY",status:"SETTLED",maturityAt:null,revision:"2",settledBy:"FINANCE",sourceStatus:null};
 let source=view({stage:"4",capabilities:[],duties:[{...duty,financeVerified:false}]});const api=client(async()=>source);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(source);
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:e=>e.message,formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot,orderId}));await tick();});
 assert.match(host.textContent,/账目待核对/);assert.doesNotMatch(host.textContent,/已入可用余额/);
 source=view({stage:"4",capabilities:[],duties:[{...duty,financeVerified:true}]});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(button=>button.textContent==="刷新").click();await tick();});
 assert.match(host.textContent,/已入可用余额/);
});
test("finance-authorized staff sees the commission beneficiary before crediting the matured duty",async t=>{
 const w=storage(t),{createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const source=view({stage:"4",isSettle:"0",capabilities:[],duties:[{id:"commission_1",kind:"COMMISSION",amountCents:"500",currency:"CNY",status:"MATURED",maturityAt:"2026-10-08T00:00:00Z",revision:"2",settledBy:null,sourceStatus:"1",beneficiary:{userId:"internal_id_123",name:"小李",privatePhone:"PRIVATE"}}]});
 const api=client(async()=>source);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(source);let sent;api.sendLegacyAdminIntent=async intent=>{sent=intent;return {};};
 assert(!JSON.stringify(api.parseLegacyAdminView(source)).includes("PRIVATE"));
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:e=>e.message,formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 const authorized={...snapshot,permissions:[...snapshot.permissions,"order.settlement.write","finance.document.read"]};
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot:authorized,orderId}));await tick();});
 assert.match(host.textContent,/收益人：小李/);assert.doesNotMatch(host.textContent,/internal_id_123/);
 const textarea=host.querySelector('[aria-label="分销佣金入账原因 小李 第1笔"]');
 await React.act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,"value").set.call(textarea,"核对旧站佣金记录");textarea.dispatchEvent(new w.Event("input",{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(button=>button.textContent==="核对并入账佣金").click();await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(button=>button.textContent==="确认入账分销佣金").click();await tick();});
 assert.equal(sent.command,"commission-credit");assert.deepEqual(sent.body,{expectedRevision:"2",reason:"核对旧站佣金记录"});
});
function storage(t){const w=new Window({url:"http://fixture.invalid/orders"});Object.assign(globalThis,{window:w,document:w.document,HTMLElement:w.HTMLElement,Node:w.Node,Event:w.Event,sessionStorage:w.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true});t.after(()=>w.happyDOM.abort());return w;}
function view(patch={}){return {schema:"legacy-continuation.v1",availability:"KNOWN",revision:"2",evidenceId:"evidence_result",stage:"4",isSettle:"2",amounts:{refundNet:{cents:"8200",yuan:"82.00"}},capabilities:["release","confiscate"],commandFingerprints:{release:digest,confiscate:digest},duties:[],reasons:[],channelState:"UNKNOWN",...patch};}
const snapshot={authenticated:true,adminUserId:"admin_A",session:{id:"session_A"},security:{isBoss:false},permissions:["order.read","order.legacy.continue"]};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const html=(tag)=>(props)=>React.createElement(tag,props);
const sharedUi={"./legacy-refund-review-panel":{LegacyRefundReviewPanel:()=>null},"../components/ui/input":{Input:html("input")},"../components/ui/textarea":{Textarea:html("textarea")},
 "../components/ui/select":{Select:({value,onValueChange,disabled})=>React.createElement("select",{value,disabled,"aria-label":"结算发起方",onChange:e=>onValueChange(e.target.value)},...["NONE","renter","owner"].map(v=>React.createElement("option",{key:v,value:v},v))),SelectContent:()=>null,SelectItem:()=>null,SelectTrigger:()=>null,SelectValue:()=>null},
 "../components/ui/table":{Table:html("table"),TableBody:html("tbody"),TableCell:html("td"),TableHead:html("th"),TableHeader:html("thead"),TableRow:html("tr")}};
test("legacy refund request recovery remains bound to the original amounts and duty",async t=>{
 storage(t);let reply={state:'UNKNOWN'};const c=client(async()=>reply),subject=c.legacyAdminSubject('staff',orderId);
 const body={expectedDutyRevision:'1',expectedHeadRevision:'2',paymentOrderNo:'OLDPAY123',confirmedMerchantNo:'12345',paidCents:'10000',
  previouslyRefundedCents:'2000',priorAppliedToDutyCents:'1000',noUnresolvedRefunds:true,evidenceRef:'已核对原渠道记录'};
 const intent=await c.retainLegacyAdminIntent(subject,orderId,'refund-case',body,'duty_1');
 const input={orderId,dutyId:'duty_1',...body},bytes=new TextEncoder().encode(JSON.stringify(['order.legacy.duty.refund-case','duty_1',input]));
 const fingerprint=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
 const receipt={caseId:'case_1',orderId,dutyId:'duty_1',intentId:'intent_1',refundOrderNo:'LR'+'a'.repeat(28),dutyCents:'5000',priorAppliedCents:'1000',amountCents:'4000',channelResultAtCreation:'NOT_SUBMITTED'};
 reply={state:'KNOWN_SUCCESS',status:200,fingerprint,receipt};assert.equal((await c.recoverLegacyAdminIntent(intent)).state,'KNOWN_SUCCESS');
 reply={...reply,receipt:{...receipt,amountCents:'4001'}};await assert.rejects(c.recoverLegacyAdminIntent(intent),/待核对/);
 assert.equal(c.inspectLegacyAdminIntent(subject,orderId).state,'VALID');
});
test('legacy refund progress must match the same order, duty, amount and verified terminal',async()=>{
 const receipt={caseId:'case_1',intentId:'intent_1',refundOrderNo:'LR'+'a'.repeat(28),dutyCents:'5000',priorAppliedCents:'1000',amountCents:'4000'};
 const current={intentId:'intent_1',refundOrderNo:receipt.refundOrderNo,generation:1,amountCents:'4000',dutyCents:'5000',priorAppliedCents:'1000',previouslyRefundedCents:'2000',chainReview:false,blockedBy:null};
 const progress={intentId:'intent_1',caseId:'case_1',orderId,dutyId:'duty_1',refundOrderNo:receipt.refundOrderNo,amountCents:'4000',state:'SUCCEEDED',terminal:'SUCCEEDED',completedAt:'2026-11-07T00:00:00Z',bankArrival:'UNKNOWN'};
 let value={orderId,dutyId:'duty_1',headRevision:'2',dutyRevision:'1',dutyCents:'5000',paidCents:'10000',paymentOrderNo:'OLDPAY123',merchantNo:'12345',refundDueAt:'2026-11-01T00:00:00Z',canStart:false,receipt,current,progress};
 const c=client(async()=>value);assert.equal((await c.readLegacyAdminRefund(orderId,'duty_1')).progress.state,'SUCCEEDED');
 for(const bad of [{...progress,amountCents:'4001'},{...progress,terminal:null},{...progress,caseId:'case_other'}]){
  value={...value,progress:bad};await assert.rejects(c.readLegacyAdminRefund(orderId,'duty_1'),/暂不可用/);
 }
 const currentRetry={...current,intentId:'intent_2',refundOrderNo:'LR'+'b'.repeat(28),generation:2};
 value={...value,current:currentRetry,progress:{...progress,intentId:'intent_2',refundOrderNo:currentRetry.refundOrderNo,state:'PROCESSING',terminal:null,completedAt:null}};
 assert.equal((await c.readLegacyAdminRefund(orderId,'duty_1')).current.generation,2);
 value={...value,current:{...currentRetry,chainReview:true}};await assert.rejects(c.readLegacyAdminRefund(orderId,'duty_1'),/暂不可用/);
 value={...value,current:{...currentRetry,chainReview:true,blockedBy:{intentId:'intent_1',refundOrderNo:receipt.refundOrderNo,generation:1}},progress:{...value.progress,state:'REVIEW_REQUIRED'}};
 assert.equal((await c.readLegacyAdminRefund(orderId,'duty_1')).current.blockedBy.intentId,'intent_1');
 value={...value,current:{...value.current,blockedBy:{...value.current.blockedBy,generation:2}}};await assert.rejects(c.readLegacyAdminRefund(orderId,'duty_1'),/暂不可用/);
});
test('legacy refund review requires explicit amounts and distinguishes pending from channel success',async t=>{
 const w=storage(t),{createRoot}=require('react-dom/client'),host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 t.after(async()=>React.act(async()=>root.unmount()));let sent;
 let basis={orderId,dutyId:'duty_1',headRevision:'2',dutyRevision:'1',dutyCents:'5000',paidCents:'10000',paymentOrderNo:'OLDPAY123',merchantNo:'12345',refundDueAt:'2026-11-01T00:00:00Z',canStart:true,receipt:null,current:null,progress:null};
 let queries=0,submits=0,resumes=0,retries=0,resolutions=0;const {LegacyRefundReviewPanel}=load('apps/admin/src/views/legacy-refund-review-panel.tsx',{
  '../api':{friendlyError:e=>e.message,formatDate:x=>x},'../lib/legacy-continuation-client':{readLegacyAdminRefund:async()=>basis,queryLegacyAdminRefund:async id=>{assert.equal(id,'intent_1');queries++;return{kind:'OBSERVED'};},
   submitLegacyAdminRefund:async id=>{assert.equal(id,'intent_1');submits++;return{kind:'SKIPPED',reason:'NEW_REFUND_DISABLED'};},
   resumeLegacyAdminRefund:async(id,reason)=>{assert.equal(id,'intent_1');assert.equal(reason,'已核对汇聚记录');resumes++;return{kind:'RESUMED'};},
   resolveLegacyAdminRefund:async(id,reason)=>{assert.equal(id,'intent_1');assert.equal(reason,'已核对汇聚记录');resolutions++;return{kind:'OBSERVED',event:'REVIEW_RESOLVED'};},
   retryLegacyAdminRefund:async(id,input)=>{assert.equal(id,'intent_1');assert.equal(input.previouslyRefundedCents,'2000');assert.equal(input.noUnresolvedRefunds,true);retries++;return{kind:'RETRY_CREATED'};}},
  '../components/ui-elements':{Button:({variant:_,size:__,...p})=>React.createElement('button',p)},'../components/ui/input':{Input:html('input')},
  '../components/ui/checkbox':{Checkbox:({onCheckedChange,...p})=>React.createElement('input',{...p,type:'checkbox',onChange:e=>onCheckedChange(e.target.checked)})}});
 const money=value=>`¥${BigInt(value)/100n}.${(BigInt(value)%100n).toString().padStart(2,'0')}`;
 const render=refresh=>React.act(async()=>{root.render(React.createElement(LegacyRefundReviewPanel,{orderId,dutyId:'duty_1',refresh,disabled:false,money,onReview:body=>{sent=body;}}));await tick();});
 await render('1');assert.match(host.textContent,/原付款历史已退总额/);
 const button=[...host.querySelectorAll('button')].find(x=>x.textContent==='核对并创建退款任务');assert(button.disabled);
 const inputs=host.querySelectorAll('input');
 await React.act(async()=>{for(const [i,value] of [[0,'20'],[1,'10'],[2,'汇聚后台已核对']]){Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(inputs[i],value);inputs[i].dispatchEvent(new w.Event('input',{bubbles:true}));}
  inputs[3].click();await tick();});
 assert.match(host.textContent,/¥40\.00/);assert.equal(button.disabled,false);
 await React.act(async()=>{button.click();await tick();});assert.equal(sent.previouslyRefundedCents,'2000');assert.equal(sent.priorAppliedToDutyCents,'1000');assert.equal(sent.noUnresolvedRefunds,true);
 basis={...basis,canStart:false,receipt:{caseId:'case_1',intentId:'intent_1',refundOrderNo:'LR'+'a'.repeat(28),amountCents:'4000',dutyCents:'5000',priorAppliedCents:'1000'},
  current:{intentId:'intent_1',refundOrderNo:'LR'+'a'.repeat(28),generation:1,amountCents:'4000',dutyCents:'5000',priorAppliedCents:'1000',previouslyRefundedCents:'2000',chainReview:false,blockedBy:null},progress:{state:'UNKNOWN',terminal:null,completedAt:null,bankArrival:'UNKNOWN'}};
 await render('2');assert.match(host.textContent,/结果待核对/);assert.doesNotMatch(host.textContent,/渠道已确认退款/);
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='查询汇聚退款结果').click();await tick();});assert.equal(queries,1);assert.match(host.textContent,/已查询原退款/);
 basis={...basis,progress:{state:'READY',terminal:null,completedAt:null,bankArrival:'UNKNOWN'}};await render('3');
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='提交退款任务').click();await tick();});assert.equal(submits,0);
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='确认提交').click();await tick();});assert.equal(submits,1);assert.match(host.textContent,/未启用退款提交/);
 basis={...basis,progress:{state:'REVIEW_REQUIRED',terminal:null,completedAt:null,bankArrival:'UNKNOWN'}};await render('4');
 await React.act(async()=>{const reason=host.querySelector('input[placeholder="填写核对结果或依据"]');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(reason,'已核对汇聚记录');reason.dispatchEvent(new w.Event('input',{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='核对后恢复查询').click();await tick();});assert.equal(resumes,1);assert.match(host.textContent,/不会重新发起退款/);
 basis={...basis,progress:{state:'REVIEW_REQUIRED',terminal:'FAILED_NO_EXECUTION',completedAt:null,bankArrival:'UNKNOWN'}};await render('4-terminal');
 await React.act(async()=>{const reason=host.querySelector('input[placeholder="填写核对结果或依据"]');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(reason,'已核对汇聚记录');reason.dispatchEvent(new w.Event('input',{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='查询并核对汇聚结果').click();await tick();});assert.equal(resolutions,1);assert.match(host.textContent,/渠道最新结果与原记录一致/);
 const firstCurrent=basis.current;
 basis={...basis,current:{...firstCurrent,intentId:'intent_2',refundOrderNo:'LR'+'b'.repeat(28),generation:2,chainReview:true,
  blockedBy:{intentId:'intent_1',refundOrderNo:firstCurrent.refundOrderNo,generation:1}},progress:{state:'REVIEW_REQUIRED',terminal:null,completedAt:null,bankArrival:'UNKNOWN'}};
 await render('4-ancestor');assert.match(host.textContent,/第 1 次退款存在冲突/);assert.doesNotMatch(host.textContent,/核对后恢复查询/);
 await React.act(async()=>{const reason=host.querySelector('input[placeholder="填写核对结果或依据"]');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(reason,'已核对汇聚记录');reason.dispatchEvent(new w.Event('input',{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='查询并核对汇聚结果').click();await tick();});assert.equal(resolutions,2);
 basis={...basis,current:firstCurrent,progress:{state:'FAILED',terminal:'FAILED_NO_EXECUTION',completedAt:null,bankArrival:'UNKNOWN'}};await render('5');
 await React.act(async()=>{const inputs=host.querySelectorAll('input');for(const [i,value] of [[0,'20'],[1,'已核对失败及原款']]){Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(inputs[i],value);inputs[i].dispatchEvent(new w.Event('input',{bubbles:true}));}inputs[2].click();await tick();});
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='核对并重试退款').click();await tick();});assert.equal(retries,0);
 await React.act(async()=>{[...host.querySelectorAll('button')].find(x=>x.textContent==='确认重试').click();await tick();});assert.equal(retries,1);
 basis={...basis,receipt:{caseId:'case_1',intentId:null,refundOrderNo:null,amountCents:'0',dutyCents:'0',priorAppliedCents:'0'},
  current:{intentId:null,refundOrderNo:null,generation:null,amountCents:'0',dutyCents:'0',priorAppliedCents:'0',previouslyRefundedCents:'0',chainReview:false,blockedBy:null},progress:null};await render('6');
 assert.match(host.textContent,/本次无需退款/);assert.doesNotMatch(host.textContent,/本次责任已由旧退款抵扣/);
});
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
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:()=>"暂不可用",formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 const commits=[];function Probe({s}){React.useLayoutEffect(()=>{commits.push({id:s.adminUserId,text:host.textContent});},[s]);return React.createElement(LegacyAdminContinuationPanel,{snapshot:s,orderId});}
 const render=async s=>React.act(async()=>{root.render(React.createElement(Probe,{s}));await tick();});await render(snapshot);assert(host.textContent.includes("1234.56"));
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="解除暂扣").click();await tick();});assert(host.textContent.includes("请核对当前版本与来源责任"));
 const b={...snapshot,adminUserId:"admin_B",session:{id:"session_B"},permissions:["order.read"]};await render(b);assert(!commits.find(c=>c.id==="admin_B").text.includes("1234.56"));assert(!host.textContent.includes("请核对当前版本与来源责任"));
 await render({...b,adminUserId:"admin_C",session:{id:"session_C"}});await React.act(async()=>{resolveLate(view({amounts:{refundNet:{cents:"999999",yuan:"9999.99"}}}));await tick();});assert(!host.textContent.includes("9999.99"));assert.equal(w.sessionStorage.length,0);
});

test("staff can review a legacy proposal with server amounts and a required reason",async t=>{
 const w=storage(t),{createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const proposal=view({stage:"8",isSettle:"0",capabilities:["confirm"],commandFingerprints:{confirm:digest},confirmationAmounts:{ownerNet:{cents:"1300",yuan:"13.00"},refundNet:{cents:"8200",yuan:"82.00"}}});
 const api=client(async()=>proposal);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(proposal);let sent;
 api.sendLegacyAdminIntent=async intent=>{sent=intent;return {}};
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:()=>"暂不可用",formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 const authorized={...snapshot,permissions:[...snapshot.permissions,"order.settlement.write"]};
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot:authorized,orderId}));await tick();});
 assert.match(host.textContent,/号主应结/);assert.match(host.textContent,/13\.00/);assert.match(host.textContent,/82\.00/);
 const button=[...host.querySelectorAll("button")].find(item=>item.textContent==="核对并确认方案");assert.ok(button.disabled);
 const reason=host.querySelector('textarea[aria-label="客服处理结算原因"]');
 await React.act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,"value").set.call(reason,"已与双方沟通核实");reason.dispatchEvent(new w.Event("input",{bubbles:true}));await tick();});
 assert.equal(button.disabled,false);await React.act(async()=>{button.click();await tick();});
 assert.match(host.textContent,/不证明资金已到账/);
 await React.act(async()=>{[...host.querySelectorAll("button")].find(item=>item.textContent==="确认提交").click();await tick();});
 assert.equal(sent.command,"confirm");assert.equal(sent.body.reason,"已与双方沟通核实");assert.equal(sent.body.planFingerprint,digest);
 assert.throws(()=>api.parseLegacyAdminView({...proposal,confirmationAmounts:null}),/金额暂不可用/);
});
test("staff confirmation recovery binds the original reason and request key",async t=>{
 storage(t);let reply={state:"UNKNOWN"};const c=client(async()=>reply),subject=c.legacyAdminSubject("a",orderId);
 const body={expectedRevision:"2",inputEvidenceId:"evidence_result",planFingerprint:digest,reason:"已与双方沟通核实"};
 const intent=await c.retainLegacyAdminIntent(subject,orderId,"confirm",body);
 const bytes=new TextEncoder().encode(JSON.stringify(["order.legacy.continuation.confirm",orderId,{kind:"confirm",...body}]));
 const fingerprint=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");
 reply={state:"KNOWN_SUCCESS",status:200,fingerprint,receipt:{orderId,command:"confirm",inputEvidenceId:"evidence_result",revision:"3",versionId:"version_done",resultEvidenceId:"result_done",stage:"4",channelState:"UNKNOWN"}};
 assert.equal((await c.recoverLegacyAdminIntent(intent)).state,"KNOWN_SUCCESS");
 await assert.rejects(()=>c.recoverLegacyAdminIntent({...intent,body:{...body,reason:"不同原因"}}),/绑定不一致/);
});
test("staff without settlement permission sees why confirmation is unavailable",async t=>{
 storage(t);const {createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const proposal=view({stage:"8",isSettle:"0",capabilities:["reject"],commandFingerprints:{reject:digest},confirmationAmounts:null});
 const api=client(async()=>proposal);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(proposal);
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:e=>e.message,formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot,orderId}));await tick();});
 assert.match(host.textContent,/没有确认结算的权限/);assert.doesNotMatch(host.textContent,/方案金额不完整/);assert(![...host.querySelectorAll("button")].some(button=>button.textContent==="核对并确认方案"));
});
test("legacy pending refund displays a deadline as a handling time, not an arrival",async t=>{
 storage(t);const {createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const duty={id:"refund",kind:"RENTER_REFUND",amountCents:"8200",currency:"CNY",status:"PENDING",maturityAt:null,revision:"1",settledBy:null,sourceStatus:null};
 const row=view({stage:"4",capabilities:[],commandFingerprints:{},duties:[duty],refundDueAt:"2026-11-14T08:00:00Z"});
 const api=client(async()=>row);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(row);
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:()=>"暂不可用",formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot,orderId}));await tick();});
 assert.match(host.textContent,/退款最早处理时间：2026-11-14T08:00:00Z/);assert.match(host.textContent,/到账状态以渠道记录为准/);
});
test("staff can return an incomplete legacy proposal for correction with a reason",async t=>{
 const w=storage(t),{createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const proposal=view({stage:"8",isSettle:"0",capabilities:["reject"],commandFingerprints:{reject:digest},confirmationAmounts:null});
 const api=client(async()=>proposal);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(proposal);let sent;api.sendLegacyAdminIntent=async intent=>{sent=intent;return {};};
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:()=>"暂不可用",formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 const authorized={...snapshot,permissions:[...snapshot.permissions,"order.settlement.write"]};
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot:authorized,orderId}));await tick();});
 assert.match(host.textContent,/方案金额不完整/);assert(![...host.querySelectorAll("button")].some(b=>b.textContent==="核对并确认方案"));
 await React.act(async()=>{const reason=host.querySelector('textarea[aria-label="客服处理结算原因"]');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,"value").set.call(reason,"双方确认数量需重核");reason.dispatchEvent(new w.Event("input",{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="退回并重新核对").click();await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="确认退回结算方案").click();await tick();});
 assert.equal(sent.command,"reject");assert.equal(sent.body.reason,"双方确认数量需重核");assert.equal(sent.body.planFingerprint,digest);
});
test("staff can preview a legacy settlement and submit the exact reviewed party, amounts and reason",async t=>{
 const w=storage(t),{createRoot}=require("react-dom/client"),host=document.createElement("div");document.body.append(host);const root=createRoot(host);t.after(async()=>React.act(async()=>root.unmount()));
 const source=view({stage:"3",isSettle:"0",capabilities:["preview","propose"],commandFingerprints:{},confirmationAmounts:null});
 const api=client(async()=>source);api.readLegacyAdminContinuation=async()=>api.parseLegacyAdminView(source);let previewRequest,sent,attempts=0;
 api.previewLegacyAdminContinuation=async(...args)=>{previewRequest=args;if(attempts++===0)throw {reason:"DEPOSIT_SHORT"};return {revision:"2",inputEvidenceId:"evidence_result",proposalFingerprint:digest,settlementKind:"EARLY",proposalAmounts:{ownerNet:"13.00",returnOrderMoney:"87.00"}};};
 api.sendLegacyAdminIntent=async intent=>{sent=intent;return {};};
 const {LegacyAdminContinuationPanel}=load("apps/admin/src/views/legacy-continuation-panel.tsx",{...sharedUi,"../api":{friendlyError:e=>e.message,formatDate:x=>x},"../components/ui-elements":{Button:({variant:_,size:__,...p})=>React.createElement("button",p)},"../lib/legacy-continuation-client":api});
 await React.act(async()=>{root.render(React.createElement(LegacyAdminContinuationPanel,{snapshot,orderId}));await tick();});
 await React.act(async()=>{const select=host.querySelector('select[aria-label="结算发起方"]');select.value="renter";select.dispatchEvent(new w.Event("change",{bubbles:true}));const input=host.querySelector('input[aria-label="哈夫币（M）"]');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,"value").set.call(input,"10");input.dispatchEvent(new w.Event("input",{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="预览结算方案").click();await tick();});
 assert.match(host.textContent,/本单已付金额不足以覆盖实际消耗/);
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="预览结算方案").click();await tick();});
 assert.equal(previewRequest[2],"renter");assert.equal(previewRequest[1].expendHaff,"10");assert.match(host.textContent,/提前结算/);assert.match(host.textContent,/87\.00/);
 await React.act(async()=>{const reason=host.querySelector('textarea[aria-label="客服发起结算原因"]');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,"value").set.call(reason,"双方已沟通核实");reason.dispatchEvent(new w.Event("input",{bubbles:true}));await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="核对并提交方案").click();await tick();});
 await React.act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent.includes("确认协助提交结算方案")).click();await tick();});
 assert.equal(sent.command,"propose");assert.equal(sent.body.onBehalf,"renter");assert.equal(sent.body.reason,"双方已沟通核实");assert.equal(sent.body.quantities.expendHaff,"10");assert.equal(sent.body.planFingerprint,digest);
});
test("staff proposal recovery is bound to party, reason, quantities and the expected next stage",async t=>{
 storage(t);let reply={state:"UNKNOWN"};const c=client(async()=>reply),subject=c.legacyAdminSubject("a",orderId);
 const quantities={expendHaff:"10",barrett:"0",bullet:"0",awm:"0",armor:"0",helmet:"0",coffee:"0",card:"0"};
 const body={expectedRevision:"2",inputEvidenceId:"evidence_result",planFingerprint:digest,quantities,reason:"双方已沟通核实",onBehalf:"renter"};
 const intent=await c.retainLegacyAdminIntent(subject,orderId,"propose",body);
 const input={kind:"propose",expectedRevision:body.expectedRevision,inputEvidenceId:body.inputEvidenceId,planFingerprint:body.planFingerprint,quantities,reason:body.reason,onBehalf:body.onBehalf};
 const bytes=new TextEncoder().encode(JSON.stringify(["order.legacy.continuation.propose",orderId,input]));
 const fingerprint=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");
 reply={state:"KNOWN_SUCCESS",status:200,fingerprint,receipt:{orderId,command:"propose",inputEvidenceId:"evidence_result",revision:"3",versionId:"version_done",resultEvidenceId:"result_done",stage:"8",channelState:"UNKNOWN"}};
 assert.equal((await c.recoverLegacyAdminIntent(intent)).state,"KNOWN_SUCCESS");
 await assert.rejects(()=>c.recoverLegacyAdminIntent({...intent,body:{...body,onBehalf:"owner"}}),/绑定不一致/);
 await assert.rejects(()=>c.recoverLegacyAdminIntent({...intent,body:{...body,quantities:{...quantities,expendHaff:"11"}}}),/绑定不一致/);
 reply.receipt.stage="9";await assert.rejects(()=>c.recoverLegacyAdminIntent(intent),/尚待核对/);
});
