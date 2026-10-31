import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { Window } from 'happy-dom';
import { createServer, loadConfigFromFile } from 'vite';

// Test the real decision form and its callback contract; graph layout and API persistence have other suites.
const adminRoot=fileURLToPath(new URL('..',import.meta.url));
const browser=new Window({url:'http://127.0.0.1:3101/approvals/entitlement-fixture'});
browser.matchMedia=query=>({matches:false,media:query,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
globalThis.window=browser;
for(const key of ['document','HTMLElement','Element','Node','Event','CustomEvent','MouseEvent','KeyboardEvent','HTMLInputElement','HTMLTextAreaElement','MutationObserver','ResizeObserver','ShadowRoot','sessionStorage','localStorage'])Object.defineProperty(globalThis,key,{value:browser[key],writable:true,configurable:true});
Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const previousFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('RequestDetail decisions must use the supplied callback, never HTTP in this suite');};
const loaded=await loadConfigFromFile({command:'serve',mode:'test'},process.env.ADMIN_TEST_VITE_CONFIG||fileURLToPath(new URL('../vite.config.ts',import.meta.url)),adminRoot);
assert.ok(loaded?.config);
const config=loaded.config;
const aliases=Array.isArray(config.resolve?.alias)?config.resolve.alias.filter(entry=>!(entry.find instanceof RegExp&&['react','react-dom','dagre'].some(id=>entry.find.test(id)))):config.resolve?.alias;
const vite=await createServer({...config,configFile:false,root:adminRoot,resolve:{...config.resolve,alias:aliases},plugins:[...(config.plugins??[]),{
  name:'decision-test-graph-boundary',enforce:'pre',
  resolveId(id,importer){if(id==='./request-flow'&&importer?.replaceAll('\\','/').endsWith('/approval/request-detail.tsx'))return '\0decision-test-graph';},
  load(id){if(id==='\0decision-test-graph')return 'export function RequestFlow(){return null;}';},
}],cacheDir:fileURLToPath(new URL(`../../../tmp/admin-integration-test-cache/${process.pid}-amendment/`,import.meta.url)),server:{...config.server,middlewareMode:true,hmr:false,ws:false,watch:null},optimizeDeps:{noDiscovery:true,include:[]}});
let RequestDetail;
try { ({RequestDetail}=await vite.ssrLoadModule('/src/views/approval/request-detail.tsx')); }
catch(error){await vite.close();await browser.happyDOM.abort();globalThis.fetch=previousFetch;throw error;}
const {createRoot}=await import('react-dom/client');
after(async()=>{await vite.close();await browser.happyDOM.abort();globalThis.fetch=previousFetch;});

function payload(userId='user-fixture'){
  return {userId,gameId:'delta-fixture',kind:'FRIEND',policyId:'approved-policy-1',scopeKey:'legacy:immutable-scope',replaceEntitlementId:'entitlement-1',startsAtUtc:'2026-11-01T02:00:00.000Z',endsAtUtc:'2026-11-20T02:00:00.000Z',depositWaived:false,reason:'原办理依据',pricing:{status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode:'ordinary',priceVersionId:'frozen-price-1',costBasisRef:'frozen-cost-1',payableRatio:'0.9'}};
}
function detail(id='request-a',editable=true){
  const hash=(id==='request-a'?'a':'b').repeat(64),original=payload(id==='request-a'?'user-a':'user-b');
  return {requestId:id,operationCode:'membership.entitlement.replace',triggerCondition:'membership.entitlement.replace.requested',payloadVersion:1,payloadHash:hash,summary:'为用户办理挚友礼遇',status:'PENDING',requester:{username:'requester',name:'申请人'},createdAt:'2026-10-23T00:00:00Z',expiresAt:'2026-10-24T00:00:00Z',operation:{code:'membership.entitlement.replace',triggerCondition:'membership.entitlement.replace.requested',payloadVersion:1,payloadHash:hash,executionMode:'GENERIC_TRANSACTION'},template:{id:'template',version:1},decision:null,execution:null,candidates:[{username:'reviewer',name:'审核人',status:'ACTIVE',eligible:true,source:'TEMPLATE'}],history:[],supersedesRequestId:null,supersededByRequestId:null,actions:[{action:'approve',allowed:true,reasonCode:'OK',executionMode:'GENERIC_TRANSACTION'},{action:'reject',allowed:true,reasonCode:'OK',executionMode:'GENERIC_TRANSACTION'}],candidateAvailability:{total:1,eligible:1,blockingReasonCode:null},...(editable?{entitlementAmendment:{expectedPayloadHash:hash,editablePayload:original}}:{})};
}
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});};
const dialog=()=>browser.document.querySelector('[role=dialog]');
const button=(text,within=browser.document)=>[...within.querySelectorAll('button')].find(element=>element.textContent.trim()===text);
async function clickRaw(element){assert.ok(element,'expected an interactive control');await act(async()=>element.click());await settle();}
async function type(element,value){assert.ok(element,'expected an editable field');await act(async()=>{const prototype=element.tagName==='TEXTAREA'?browser.HTMLTextAreaElement.prototype:browser.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new browser.Event('input',{bubbles:true}));element.dispatchEvent(new browser.Event('change',{bubbles:true}));});}
async function check(text){const label=[...dialog().querySelectorAll('label')].find(element=>element.textContent.trim()===text);assert.ok(label);await click(browser.document.getElementById(label.htmlFor));}
async function mount(t,data){
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host),decisions=[];
  const props={busy:false,blocked:false,onOpenRequest(){},onExecute(){throw new Error('No execution is authorized by this decision test');},onAppend(){throw new Error('No approver append is authorized by this decision test');},onDecide:(decision,reason,stepUp,amendment)=>{assert.ok(stepUp&&stepUp.password.length>=12&&/^\d{6}$/.test(stepUp.totpCode),'decision carries live step-up');decisions.push(structuredClone(amendment===undefined?[decision,reason]:[decision,reason,amendment]));}};
  const render=async next=>{await act(async()=>root.render(createElement(RequestDetail,{...props,detail:next})));await settle();};
  t.after(async()=>{await act(async()=>root.unmount());host.remove();await settle();});
  await render(data);return{host,decisions,render};
}

test('authorized amendment submits the exact final payload and keeps fixed identity, scope and pricing references',async t=>{
  const data=detail(),original=structuredClone(data.entitlementAmendment.editablePayload),h=await mount(t,data);
  await click(button('批准',h.host));await check('调整礼遇后批准');
  await type(dialog().querySelector('[aria-label="批准应付比例"]'),'0.85');
  await type(dialog().querySelector('input[type=time][aria-label^="批准开始"]'),'11:15');
  await click(dialog().querySelector('button[aria-label^="批准开始"]'));
  await click([...browser.document.querySelectorAll('button[data-day]')].find(element=>element.textContent.trim()==='12'));
  await type(dialog().querySelector('input[type=time][aria-label^="批准结束"]'),'09:45');
  await check('独立免押');await type(dialog().querySelector('[aria-label="批准礼遇原因"]'),'核对后调整权益');
  await type(dialog().querySelector('textarea[placeholder="补充说明（可选）"]'),'已核对申请依据');
  await click(button('确认批准',dialog()));
  assert.deepEqual(h.decisions,[['APPROVE','已核对申请依据',{expectedPayloadHash:data.entitlementAmendment.expectedPayloadHash,finalPayload:{...original,startsAtUtc:'2026-11-12T03:15:00.000Z',endsAtUtc:'2026-11-20T01:45:00.000Z',depositWaived:true,reason:'核对后调整权益',pricing:{...original.pricing,payableRatio:'0.85'}}}]]);
  assert.deepEqual(data.entitlementAmendment.editablePayload,original,'the original server payload remains immutable');
});

test('rejecting never carries a previously edited amendment',async t=>{
  const h=await mount(t,detail());await click(button('批准',h.host));await check('调整礼遇后批准');
  await type(dialog().querySelector('[aria-label="批准应付比例"]'),'0.75');await click(button('取消',dialog()));
  await click(button('驳回',h.host));assert.equal(dialog().textContent.includes('调整礼遇后批准'),false);
  await type(dialog().querySelector('textarea[placeholder="说明驳回依据"]'),'当前依据不足');await click(button('确认驳回',dialog()));
  assert.deepEqual(h.decisions,[['REJECT','当前依据不足']]);
});

test('invalid decimal ratios and an edited period exceeding 90 days disable approval',async t=>{
  const h=await mount(t,detail());await click(button('批准',h.host));await check('调整礼遇后批准');
  for(const ratio of ['0','1.1','0.123456789']){await type(dialog().querySelector('[aria-label="批准应付比例"]'),ratio);assert.equal(button('确认批准',dialog()).disabled,true);}
  await type(dialog().querySelector('[aria-label="批准应付比例"]'),'0.85');
  await click(dialog().querySelector('button[aria-label^="批准结束"]'));
  for(let count=0;count<3;count++)await click([...browser.document.querySelectorAll('[data-slot=popover-content] button[aria-label]')].find(element=>/next month|下一月|下个月|下月/i.test(element.getAttribute('aria-label'))));
  await click([...browser.document.querySelectorAll('button[data-day]')].find(element=>element.textContent.trim()==='2'));
  assert.match(dialog().textContent,/最多90天/);assert.equal(button('确认批准',dialog()).disabled,true);assert.deepEqual(h.decisions,[]);
});

test('old DTOs and non-eligible actions do not expose an amendment entry',async t=>{
  const data=detail('request-old',false);data.operation.payload=payload();const h=await mount(t,data);
  await click(button('批准',h.host));assert.equal(dialog().textContent.includes('调整礼遇后批准'),false);
  await click(button('确认批准',dialog()));assert.equal(h.decisions[0][0],'APPROVE');assert.equal(h.decisions[0][2],undefined);
  const denied=detail('request-denied');denied.actions[0]={...denied.actions[0],allowed:false,reasonCode:'BUSINESS_PERMISSION_REQUIRED'};
  await h.render(denied);assert.equal(button('批准',h.host),undefined,'批准被禁用时不渲染为按钮，也就没有调整入口');assert.equal(dialog(),null);
});

test('switching requests clears old edits and approval opinions before the next decision',async t=>{
  const h=await mount(t,detail());await click(button('批准',h.host));await check('调整礼遇后批准');
  await type(dialog().querySelector('[aria-label="批准应付比例"]'),'0.71');await type(dialog().querySelector('textarea[placeholder="补充说明（可选）"]'),'旧申请意见');
  const next=detail('request-b');next.entitlementAmendment.editablePayload.pricing.payableRatio='0.97';await h.render(next);
  if(!dialog())await click(button('批准',h.host));
  assert.equal(dialog().querySelector('[aria-label="批准应付比例"]'),null);assert.equal(dialog().querySelector('textarea[placeholder="补充说明（可选）"]').value,'');
  await check('调整礼遇后批准');assert.equal(dialog().querySelector('[aria-label="批准应付比例"]').value,'0.97');
  await click(button('确认批准',dialog()));assert.equal(h.decisions[0][2].expectedPayloadHash,next.entitlementAmendment.expectedPayloadHash);assert.equal(h.decisions[0][2].finalPayload.userId,'user-b');assert.equal(h.decisions[0][2].finalPayload.pricing.payableRatio,'0.97');
});

// Step-up credentials are required in every approval write dialog; tests fill them once the dialog opens.
async function click(element) { await clickRaw(element); await fillStepUpFields(element); }
async function fillStepUpFields(element) {
  const doc = element?.ownerDocument; if (!doc) return;
  const fields = [...doc.querySelectorAll('input[autocomplete="current-password"], input[autocomplete="one-time-code"]')].filter((field) => !field.value);
  if (fields.length === 0) return;
  const setValue = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, "value").set;
  await act(async () => { for (const field of fields) { setValue.call(field, field.autocomplete === "one-time-code" ? "123456" : "step-up-password-1"); field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true })); } });
}
