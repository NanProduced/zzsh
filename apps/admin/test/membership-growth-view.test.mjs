import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = fileURLToPath(new URL("..", import.meta.url));

async function ui(t) {
  const previousFetch=globalThis.fetch,fetches=[];
  globalThis.fetch=async(...args)=>{fetches.push(args);throw new Error('Unexpected component HTTP request');};
  const browser=new Window({url:'http://127.0.0.1:3101/membership-growth'});
  browser.matchMedia=query=>({matches:false,media:query,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
  for(const name of ['document','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','ResizeObserver','localStorage','sessionStorage'])globalThis[name]=browser[name];
  globalThis.window=browser;globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);
  globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
  const vite=await createServer({configFile:false,root:rootPath,plugins:[react()],resolve:{alias:{'@':fileURLToPath(new URL('../src',import.meta.url))}},server:{middlewareMode:true,hmr:false,ws:false,watch:null},optimizeDeps:{noDiscovery:true,include:[]}});
  const view=await vite.ssrLoadModule('/src/views/membership-growth-view.tsx'),form=await vite.ssrLoadModule('/src/views/membership-entitlement-form.tsx'),businessSummary=await vite.ssrLoadModule('/src/views/approval/business-summary.tsx');
  const host=browser.document.createElement('div');browser.document.body.append(host);
  const {createRoot}=await import('react-dom/client'),root=createRoot(host);
  t.after(async()=>{await act(async()=>root.unmount());await vite.close();await browser.happyDOM.abort();globalThis.fetch=previousFetch;});
  const render=async(component,props)=>{await act(async()=>root.render(createElement(component,props)));};
  const input=label=>{const element=host.querySelector(`input[aria-label='${label}']`);assert.ok(element,`missing ${label}`);return element;};
  const type=async(element,value)=>{await act(async()=>{const prototype=element.tagName==='TEXTAREA'?browser.HTMLTextAreaElement.prototype:browser.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new browser.Event('input',{bubbles:true}));element.dispatchEvent(new browser.Event('change',{bubbles:true}));});};
  const click=async element=>{assert.ok(element);await act(async()=>element.click());};
  const button=text=>[...host.querySelectorAll('button')].find(element=>element.textContent.trim()===text);
  return{browser,host,root,view,form,businessSummary,render,input,type,click,button,fetches};
}
const addMaterial=async(h,label='哈夫币',scenario='场景 1')=>{const combo=h.browser.document.querySelector(`[role=combobox][aria-label="${scenario} 添加物资"]`);assert.ok(combo,`missing material selector for ${scenario}`);await h.click(combo);const option=[...h.browser.document.querySelectorAll('[role=option]')].find(element=>element.textContent.includes(label));assert.ok(option,`missing material option ${label}`);await h.click(option);};
const setScenarioQuantity=async(h,label,unit,value,scenario='场景 1')=>{const input=h.browser.document.querySelector(`input[aria-label="${scenario} ${label} 数量（${unit}）"]`);assert.ok(input,`missing quantity for ${scenario}/${label}`);await h.type(input,value);};
const openSimulator=async h=>{await h.click(h.button('租金价差试算'));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});};
const TIERS=['STANDARD','SILVER','GOLD','PLATINUM','DIAMOND'];
const UNIFIED_RATIOS=['0.95','0.92','0.90','0.88','0.85'];
const catalog={safeBoxes:[],materials:[],priceVersions:[{id:'price-v1',label:'当前价格方案'}],enabledModes:['ordinary','custom'],catalogSource:'SEALED'};
const legacyDiscount=(mode,ratio='0.9')=>({status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode,priceVersionId:'price-v1',payableRatio:ratio,costBasisRef:'cost-v1'});
const legacyRange=(mode,min='0.6',max='1')=>({status:'CONFIGURED',kind:'TOTAL_DISCOUNT_RANGE',mode,priceVersionId:'price-v1',minPayableRatio:min,maxPayableRatio:max,costBasisRef:'cost-ent'});
function unifiedProjection(overrides={}) {
  const unknownTier=(payableRatio,reasonCodes=[])=>({knowledge:'KNOWN',payableRatio,reasonCodes});
  const range=(min,max)=>({knowledge:'KNOWN',minPayableRatio:min,maxPayableRatio:max,priceVersionId:'price-v1',costBasisRef:'cost-ent',reasonCodes:[]});
  return {schema:'membership-unified-pricing.v1',scope:'ALL_ENABLED_RENTAL_MODES',knowledge:'KNOWN',
    tiers:Object.fromEntries(TIERS.map((tier,index)=>[tier,unknownTier(UNIFIED_RATIOS[index])])),
    entitlementRanges:{FRIEND:range('0.6','1'),PRESTIGE:range('0.5','1')},...overrides};
}
function readyState(){
  const legacyRanges={FRIEND:{byMode:{ordinary:legacyRange('ordinary'),custom:legacyRange('custom')}},PRESTIGE:{byMode:{ordinary:legacyRange('ordinary','0.5'),custom:legacyRange('custom','0.5')}}};
  const policy={version:'b1',status:'DRAFT',effectiveAt:'2026-11-01T00:00:00.000Z',catalog,tiers:TIERS.map((tier,index)=>({tier,threshold:String(index*5000),tenantDeposit:index<2?'ACCOUNT_BASE':'WAIVED',depositAllowanceCents:'0'})),entitlementRanges:legacyRanges};
  const approvedPolicy={...policy,version:'b0',status:'APPROVED'};
  return{status:'ready',policy,unifiedPricing:unifiedProjection(),approvedPolicy,approvedUnifiedPricing:unifiedProjection(),capability:{unifiedPricingSupported:true,canDraft:true,canChangeEntitlementRanges:true,canRequestEntitlement:true,canSimulateProfit:true},preview:{status:'NOT_RUN'},subject:{subjectId:'u',status:'UNKNOWN'},entitlement:{kind:'FRIEND',scopeKey:'game:delta',startsAtUtc:'',endsAtUtc:'',pricingMode:'ordinary',priceVersionId:'',payableRatio:'',costBasisRef:'',depositWaived:false,reason:''},approval:{status:'NOT_REQUESTED'},policyChange:{status:'READY',change:{knowledge:'KNOWN',request:null,immutableDiff:[]}},draftReference:{id:'draft-1',version:'b1',payloadHash:'a'.repeat(64)}};
}

const contextDraftRef=(overrides={})=>({id:'draft-1',version:'b1',payloadHash:'a'.repeat(64),...overrides});
const contextRequest=(overrides={})=>({id:'approval-context-1',operationCode:'membership.benefit.policy.publish',approvalStatus:'PENDING',executionStatus:null,submittedBy:{id:'admin-2',name:'运营乙'},submittedAtUtc:'2026-10-20T02:30:00.000Z',plannedEffectiveAtUtc:'2026-11-01T00:00:00.000Z',steps:null,...overrides});
const contextSteps=status=>{
  const steps=[{key:'SUBMITTED',label:'已提交',state:'COMPLETED',actor:{id:'admin-2',name:'运营乙'},atUtc:'2026-10-20T02:30:00.000Z'}];
  if(status==='PENDING')steps.push({key:'APPROVAL',label:'审批处理',state:'CURRENT'});
  if(status==='REJECTED')steps.push({key:'APPROVAL',label:'审批处理',state:'FAILED',actor:{id:'boss-1',name:'Boss甲'},atUtc:'2026-10-21T03:00:00.000Z'});
  if(['APPROVED','EXECUTION_FAILED','PENDING_EFFECTIVE','EFFECTIVE'].includes(status))steps.push({key:'APPROVAL',label:'审批处理',state:'COMPLETED',actor:{id:'boss-1',name:'Boss甲'},atUtc:'2026-10-21T03:00:00.000Z'});
  if(status==='APPROVED')steps.push({key:'EXECUTION',label:'执行发布',state:'CURRENT'});
  if(status==='EXECUTION_FAILED')steps.push({key:'EXECUTION',label:'执行发布',state:'FAILED',note:'执行渠道未确认'});
  if(['PENDING_EFFECTIVE','EFFECTIVE'].includes(status))steps.push({key:'EXECUTION',label:'执行发布',state:'COMPLETED',actor:{id:'ops-1',name:'运营丙'},atUtc:'2026-10-22T03:00:00.000Z'});
  if(status==='PENDING_EFFECTIVE')steps.push({key:'EFFECTIVE',label:'生效',state:'CURRENT'});
  if(status==='EFFECTIVE')steps.push({key:'EFFECTIVE',label:'生效',state:'COMPLETED',atUtc:'2026-10-23T00:00:00.000Z'});
  return steps;
};
const contextChange=(changeOverrides={})=>({status:'READY',change:{knowledge:'KNOWN',draftReference:contextDraftRef(),request:contextRequest(),immutableDiff:[{label:'金卡 · 统一应付折扣',baseline:'1',requested:'0.9',format:'DISCOUNT'},{label:'金卡 · 押金权益',baseline:'0',requested:'20000',format:'CENTS'}],effectiveState:{status:'NOT_EFFECTIVE'},...changeOverrides}});
const changeSection=h=>h.host.querySelector('section[aria-labelledby="membership-change-heading"]');
const rowText=(h,label)=>[...h.host.querySelectorAll('tr')].find(row=>row.textContent.includes(label))?.textContent??'';

test('policy view shows only effective unified values and edits a mode-free unified draft',async t=>{
  const h=await ui(t),state=readyState(),changed=[],saves=[],submitted=[];
  const props={state,canEditEntitlementRanges:true,onPolicyChange:(policy,unified)=>changed.push({policy,unified}),onSavePolicyDraft:()=>saves.push(true),onSubmitPolicy:()=>submitted.push(true)};
  await h.render(h.view.MembershipGrowthAdminView,props);
  assert.match(h.host.textContent,/会员政策/);assert.match(h.host.textContent,/统一成长等级权益/);assert.match(h.host.textContent,/礼遇折扣范围/);
  assert.match(h.host.textContent,/9\.5折/);assert.match(h.host.textContent,/实付 95%/);
  assert.doesNotMatch(h.host.textContent,/普通租赁|自定义方案|极速租赁|计价模式/,'the policy page has no entitlement mode selector');
  assert.match(h.host.textContent,/所有已启用租赁方式统一/);assert.match(h.host.textContent,/适配全部已启用租赁方式/);assert.match(h.host.textContent,/6折 – 原价/);assert.doesNotMatch(h.host.textContent,/10折/);
  assert.match(h.host.textContent,/待处理变更/);
  assert.doesNotMatch(h.host.textContent,/报价预览|用户成长依据|人工礼遇申请|金卡上限|钻石上限/);
  assert.equal(h.host.querySelector('select,textarea,input[type=datetime-local]'),null,'use house controls and a Calendar date picker');
  assert.ok(h.host.querySelector('button[aria-label="政策生效日期"]'));assert.ok(h.input('政策生效时间'));
  assert.equal(h.view.validateAdminPolicyDraft(state.policy,h.view.unifiedDraftFromProjection(state.unifiedPricing)).publishable,true);
  await h.type(h.input('银卡 统一应付折扣'),'0.90');
  assert.equal(changed.at(-1).unified.tiers.SILVER,'0.90');
  await h.type(h.input('挚友礼遇 最小应付比例'),'0.55');
  assert.equal(changed.at(-1).unified.ranges.FRIEND.min,'0.55');
  assert.equal(changed.at(-1).policy.tiers.length,5,'deposit/threshold metadata survives');
  assert.equal(h.button('提交审批').disabled,true,'unsaved policy edits cannot be submitted');
  await h.click(h.button('保存草稿'));assert.deepEqual(saves,[true]);
  const saved={...state,policy:{...changed.at(-1).policy,version:'b2'},unifiedPricing:state.unifiedPricing};
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:saved});
  assert.equal(h.button('提交审批').disabled,false);await h.click(h.button('提交审批'));assert.deepEqual(submitted,[true]);
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:saved,canEditEntitlementRanges:false});
  assert.equal(h.input('挚友礼遇 最小应付比例').disabled,true);assert.equal(h.input('银卡 统一应付折扣').disabled,false);
  assert.match(h.host.textContent,/只读/);
  await h.render(h.view.MembershipGrowthAdminView,{state:{status:'loading'}});assert.ok(h.host.querySelector('[role=status]'));
  await h.render(h.view.MembershipGrowthAdminView,{state:{status:'error',message:'读取失败'}});assert.match(h.host.querySelector('[role=alert]').textContent,/读取失败/);
  await h.render(h.view.MembershipGrowthAdminView,{state:{status:'permission',message:'权限已收回'}});assert.match(h.host.textContent,/没有会员政策查看权限/);
});

test('edit stepper cannot skip an incomplete stage one and revisits the diff before filing',async t=>{
  const h=await ui(t),state=readyState();
  await h.render(h.view.MembershipGrowthAdminView,{state,canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{}});
  await h.click(h.button('调整会员政策'));
  const step=label=>h.browser.document.querySelector(`button[aria-label="${label}"]`);
  assert.ok(step('第 2 步，共 3 步：变更核对'));assert.equal(step('第 2 步，共 3 步：变更核对').disabled,false,'a complete stage one unlocks the diff');
  assert.equal(step('第 3 步，共 3 步：生效与提审').disabled,true,'stage three waits for the diff to be visited');
  assert.ok(h.browser.document.querySelector('button[aria-label="保存草稿说明"]'),'saving a draft explains that deletion is unavailable');
  await h.click(step('第 2 步，共 3 步：变更核对'));
  assert.equal(step('第 3 步，共 3 步：生效与提审').disabled,false);
  await h.type(h.input('银卡 统一应付折扣'),'');
  assert.equal(step('第 2 步，共 3 步：变更核对').disabled,true,'an incomplete ratio re-locks later stages');
  assert.equal(step('第 3 步，共 3 步：生效与提审').disabled,true);
  await h.type(h.input('银卡 统一应付折扣'),'0.90');
  assert.equal(step('第 2 步，共 3 步：变更核对').disabled,false);
});

test('manual two scenarios and three discounts show renter, owner and platform gross profit with one request per scenario',async t=>{
  const h=await ui(t),state=readyState();
  const context={schema:'membership-profit-simulation-context.v1',gameId:'delta',ruleReleaseId:'release-1',priceVersionId:'price-v1',termVersionId:'term-v1',enabledModes:['ordinary'],safeBoxes:['small'],resources:[{itemId:'haff',name:'哈夫币',pricingKind:'HAFF_RATIO',unit:'PIECE'},{itemId:'item-1',name:'六级甲',pricingKind:'FIXED_UNIT',unit:'PIECE'}],termOptions:[{code:'day',dailyConsumption:'1000000'}]};
  const point=(ratio,renter,owner,floor=true)=>({payableRatio:ratio,payableRentalCents:renter,discountCents:'0',ownerIncomeCents:owner,platformSpreadCents:(BigInt(renter)-BigInt(owner)).toString(),ownerFloorSatisfied:floor,spreadRate:null});
  const resultFor=haff=>{const scale=haff==='120000000'?2:1,owner=String(87347*scale),base=String(189605*scale);return{schema:'membership-profit-simulation.v1',baseQuotable:true,baseline:{platformSpreadCents:String(102258*scale),rentalCents:base,ownerIncomeCents:owner},points:[point('1',base,owner),point('0.8',String(151684*scale),owner),point('0.9',String(170645*scale),owner,false)]};};
  const requests=[];
  globalThis.fetch=async (url,init)=>{
    const text=String(url);
    if(text.includes('/profit-simulation-context'))return new Response(JSON.stringify(context),{status:200,headers:{'content-type':'application/json'}});
    if(text.includes('/profit-simulation')){
      const body=JSON.parse(init?.body??'{}');requests.push(body);
      const haff=body.quoteInput?.inventory?.find(item=>item.itemId==='haff')?.quantity;
      return new Response(JSON.stringify(resultFor(haff)),{status:200,headers:{'content-type':'application/json'}});
    }
    throw new Error('Unexpected component HTTP request');
  };
  await h.render(h.view.MembershipGrowthAdminView,{state,canSimulateProfit:true,binding:{ruleReleaseId:'release-1',priceVersionId:'price-v1'},onPolicyChange:()=>{}});
  await openSimulator(h);
  await addMaterial(h,'哈夫币','场景 1');await setScenarioQuantity(h,'哈夫币','M','60','场景 1');
  await addMaterial(h,'六级甲','场景 1');await setScenarioQuantity(h,'六级甲','件','1','场景 1');
  await h.type(h.browser.document.querySelector('#simulation-discount'),'9折');
  await h.click([...h.browser.document.querySelectorAll('button')].find(element=>element.textContent.trim()==='添加'));
  await h.click([...h.browser.document.querySelectorAll('button')].find(element=>element.textContent.trim()==='新增场景'));
  await addMaterial(h,'哈夫币','场景 2');await setScenarioQuantity(h,'哈夫币','M','120','场景 2');
  const start=[...h.browser.document.querySelectorAll('button')].find(element=>element.textContent.trim()==='开始试算');
  await h.click(start);
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,60));});
  assert.equal(requests.length,2,'one quote request per manual scenario');
  assert.deepEqual(requests[0].payableRatios,['1','0.8','0.9']);
  assert.equal(requests[0].quoteInput.inventory.find(item=>item.itemId==='haff').quantity,'60000000');
  assert.equal(requests[0].quoteInput.inventory.find(item=>item.itemId==='item-1').quantity,'1');
  assert.equal(requests[1].quoteInput.inventory.find(item=>item.itemId==='haff').quantity,'120000000');
  const dialog=[...h.browser.document.querySelectorAll('[role=dialog]')].find(element=>element.textContent.includes('三方试算'));
  assert.ok(dialog);
  assert.match(dialog.textContent,/租客租赁费用/);assert.match(dialog.textContent,/号主应得/);assert.match(dialog.textContent,/平台租赁毛利/);
  assert.match(dialog.textContent,/原价/);assert.match(dialog.textContent,/8折/);assert.match(dialog.textContent,/9折/);
  assert.match(dialog.textContent,/¥1896\.05/);assert.match(dialog.textContent,/¥873\.47/);assert.match(dialog.textContent,/¥1022\.58/);
  assert.match(dialog.textContent,/¥1516\.84/);assert.match(dialog.textContent,/¥643\.37/);assert.match(dialog.textContent,/¥1706\.45/);assert.match(dialog.textContent,/¥832\.98/);
  assert.match(dialog.textContent,/-¥379\.21/);assert.match(dialog.textContent,/-¥189\.60/);
  assert.equal(dialog.querySelectorAll('tbody tr').length,6,'two scenarios by three discounts');
  assert.equal((dialog.textContent.match(/闭合/g)??[]).length,6,'each row proves renter = owner + platform');
  assert.match(dialog.textContent,/2 行需注意/);assert.match(dialog.textContent,/低于底线/);
  assert.doesNotMatch(dialog.textContent,/标准租赁|重度高耗损/);
  assert.doesNotMatch(dialog.textContent,/拟设折扣|haff-only/);
});

test('a stale simulation response is discarded and a missing discount point stays unknown',async t=>{
  const h=await ui(t),state=readyState();
  const context={schema:'membership-profit-simulation-context.v1',gameId:'delta',ruleReleaseId:'release-1',priceVersionId:'price-v1',termVersionId:'term-1',enabledModes:['ordinary'],safeBoxes:['basic'],resources:[{itemId:'haff',name:'哈夫币',pricingKind:'HAFF_RATIO',unit:'PIECE'}],termOptions:[{code:'day',dailyConsumption:'1'}]};
  const point=(ratio,spread)=>({payableRatio:ratio,payableRentalCents:spread==='10000'?'20000':'16000',discountCents:ratio==='1'?'0':'4000',ownerIncomeCents:'10000',platformSpreadCents:spread,ownerFloorSatisfied:true,spreadRate:null});
  const full=(ratios=['1','0.8'])=>({schema:'membership-profit-simulation.v1',baseQuotable:true,baseline:{platformSpreadCents:'10000',rentalCents:'20000',ownerIncomeCents:'10000'},points:ratios.map(ratio=>point(ratio,ratio==='1'?'10000':'6000'))});
  let holdNext=false,releaseHeld=null,missing=false;
  globalThis.fetch=async (url,init)=>{
    const text=String(url);
    if(text.includes('/profit-simulation-context'))return new Response(JSON.stringify(context),{status:200,headers:{'content-type':'application/json'}});
    if(text.includes('/profit-simulation')){
      if(holdNext){holdNext=false;return new Promise(resolve=>{releaseHeld=()=>resolve(new Response(JSON.stringify(full()),{status:200,headers:{'content-type':'application/json'}}));});}
      const body=JSON.parse(init?.body??'{}');
      if(missing)return new Response(JSON.stringify(full(['1'])),{status:200,headers:{'content-type':'application/json'}});
      return new Response(JSON.stringify(full(body.payableRatios.includes('0.9')?['1','0.8','0.9']:['1','0.8'])),{status:200,headers:{'content-type':'application/json'}});
    }
    throw new Error('Unexpected component HTTP request');
  };
  await h.render(h.view.MembershipGrowthAdminView,{state,canSimulateProfit:true,binding:{ruleReleaseId:'release-1',priceVersionId:'price-v1'},onPolicyChange:()=>{}});
  await openSimulator(h);
  await addMaterial(h,'哈夫币','场景 1');await setScenarioQuantity(h,'哈夫币','M','60','场景 1');
  const start=()=>[...h.browser.document.querySelectorAll('button')].find(element=>element.textContent.trim()==='开始试算');
  holdNext=true;await h.click(start());
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  assert.ok(releaseHeld,'the first simulation is held');
  await setScenarioQuantity(h,'哈夫币','M','120','场景 1');
  releaseHeld();
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
  assert.doesNotMatch(h.browser.document.body.textContent,/¥0\.00/,'the old 60M response is never shown for 120M');
  assert.match(h.browser.document.body.textContent,/添加场景与物资/);
  await h.click(start());
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
  assert.match(h.browser.document.body.textContent,/¥200\.00/);
  missing=true;
  await h.click(start());
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
  assert.match(h.browser.document.body.textContent,/响应缺少该折扣点/);
  assert.match(h.browser.document.body.textContent,/1 行待核/);
  assert.doesNotMatch(h.browser.document.body.textContent,/保底均满足/,'a missing discount point cannot claim the original point\'s floor');
});

test('exact-cent three-party amounts keep the Master extreme counterexample at one cent',async t=>{
  const h=await ui(t),state=readyState();
  const context={schema:'membership-profit-simulation-context.v1',gameId:'delta',ruleReleaseId:'release-1',priceVersionId:'price-v1',termVersionId:'term-1',enabledModes:['ordinary'],safeBoxes:['basic'],resources:[{itemId:'haff',name:'哈夫币',pricingKind:'HAFF_RATIO',unit:'PIECE'}],termOptions:[{code:'day',dailyConsumption:'1'}]};
  const result={schema:'membership-profit-simulation.v1',baseQuotable:true,baseline:{platformSpreadCents:'9007199254740993'},points:[
    {payableRatio:'1',payableRentalCents:'9007199254741093',discountCents:'0',ownerIncomeCents:'100',platformSpreadCents:'9007199254740993',ownerFloorSatisfied:true,spreadRate:null},
    {payableRatio:'0.8',payableRentalCents:'9007199254741092',discountCents:'1',ownerIncomeCents:'100',platformSpreadCents:'9007199254740992',ownerFloorSatisfied:true,spreadRate:null},
  ]};
  globalThis.fetch=async (url)=>{
    const text=String(url);
    if(text.includes('/profit-simulation-context'))return new Response(JSON.stringify(context),{status:200,headers:{'content-type':'application/json'}});
    if(text.includes('/profit-simulation'))return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
    throw new Error('Unexpected component HTTP request');
  };
  await h.render(h.view.MembershipGrowthAdminView,{state,canSimulateProfit:true,binding:{ruleReleaseId:'release-1',priceVersionId:'price-v1'},onPolicyChange:()=>{}});
  await openSimulator(h);
  await addMaterial(h,'哈夫币','场景 1');await setScenarioQuantity(h,'哈夫币','M','60','场景 1');
  await h.click([...h.browser.document.querySelectorAll('button')].find(element=>element.textContent.trim()==='开始试算'));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
  const text=h.browser.document.body.textContent;
  assert.match(text,/¥90071992547409\.93/);
  assert.match(text,/-¥0\.01/);
  assert.doesNotMatch(text,/-¥0\.00/);
  assert.equal(h.view.formatSpreadRate({numerator:'9007199254740993',denominator:'9007199254740992'}),'100%');
  assert.equal(h.view.formatCents('9007199254740993'),'¥90071992547409.93');
});

test('losing simulation permission unmounts the dialog and discards its pending response',async t=>{
  const h=await ui(t),state=readyState();
  const context={schema:'membership-profit-simulation-context.v1',gameId:'delta',ruleReleaseId:'release-1',priceVersionId:'price-v1',termVersionId:'term-1',enabledModes:['ordinary'],safeBoxes:['basic'],resources:[{itemId:'haff',name:'哈夫币',pricingKind:'HAFF_RATIO',unit:'PIECE'}],termOptions:[{code:'day',dailyConsumption:'1'}]};
  let release=null;
  globalThis.fetch=async (url)=>{
    const text=String(url);
    if(text.includes('/profit-simulation-context'))return new Response(JSON.stringify(context),{status:200,headers:{'content-type':'application/json'}});
    if(text.includes('/profit-simulation'))return new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({schema:'membership-profit-simulation.v1',baseQuotable:true,baseline:{platformSpreadCents:'10000'},points:[]}),{status:200,headers:{'content-type':'application/json'}}));});
    throw new Error('Unexpected component HTTP request');
  };
  await h.render(h.view.MembershipGrowthAdminView,{state,canSimulateProfit:true,binding:{ruleReleaseId:'release-1',priceVersionId:'price-v1'},onPolicyChange:()=>{}});
  await openSimulator(h);
  await addMaterial(h,'哈夫币','场景 1');await setScenarioQuantity(h,'哈夫币','M','60','场景 1');
  await h.click([...h.browser.document.querySelectorAll('button')].find(element=>element.textContent.trim()==='开始试算'));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  assert.ok(release,'the quote request is pending');
  await h.render(h.view.MembershipGrowthAdminView,{state,canSimulateProfit:false,binding:{ruleReleaseId:'release-1',priceVersionId:'price-v1'},onPolicyChange:()=>{}});
  assert.equal([...h.browser.document.querySelectorAll('[role=dialog]')].some(element=>element.textContent.includes('三方试算')),false,'permission loss removes the dialog');
  release();
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  assert.equal(h.browser.document.body.textContent.includes('三方试算'),false);
});

test('invalid raw allowance is shown at the field and blocks save before any stale cents can be posted',async t=>{
  const h=await ui(t),base=readyState(),saves=[],changes=[];
  const state={...base,policy:{...base.policy,tiers:base.policy.tiers.map(tier=>tier.tier==='GOLD'?{...tier,tenantDeposit:'ACCOUNT_BASE',depositAllowanceCents:'20000'}:tier)}};
  await h.render(h.view.MembershipGrowthAdminView,{state,canEditEntitlementRanges:true,onPolicyChange:(policy,unified)=>changes.push({policy,unified}),onSavePolicyDraft:()=>saves.push(true)});
  await h.click(h.button('调整会员政策'));
  const dialog=()=>[...h.browser.document.querySelectorAll('[role=dialog]')].find(element=>element.textContent.includes('调整会员政策'));
  const allowance=dialog().querySelector('input[aria-label="金卡 每单减免额度"]');
  assert.equal(allowance.value,'200');
  const save=()=>[...dialog().querySelectorAll('button')].find(element=>element.textContent==='保存草稿');
  for(const [value,expected] of [['1.999','最多两位小数'],['-1','负数或指数'],['','请输入押金减免额度'],['1e3','负数或指数'],['9'.repeat(23)+'.99','超出可保存范围']]){
    await h.type(allowance,value);
    assert.match(dialog().textContent,new RegExp(expected));
    assert.equal(allowance.getAttribute('aria-invalid'),'true',value);
    assert.ok(dialog().querySelector(`[id="${allowance.getAttribute('aria-describedby')}"]`),'the error is programmatically associated');
    assert.equal(save().disabled,true,`invalid ${value} blocks save`);
    assert.equal([...dialog().querySelectorAll('button')].find(element=>element.textContent==='下一步').disabled,true,'invalid allowance blocks later steps');
  }
  await h.type(allowance,'200.50');
  assert.equal(allowance.getAttribute('aria-invalid'),'false');
  assert.doesNotMatch(dialog().textContent,/请先修正以下问题/,'the first-step error summary disappears only after a valid value');
  assert.equal(save().disabled,false,'a valid two-decimal amount can be saved');
  assert.equal(changes.at(-1).policy.tiers.find(tier=>tier.tier==='GOLD').depositAllowanceCents,'20050');
  assert.equal(saves.length,0,'validation itself never posts');
  // Waived and finite allowance are mutually exclusive.
  await h.click(dialog().querySelector('[role=combobox][aria-label="金卡 押金权益"]'));
  const waived=[...h.browser.document.querySelectorAll('[role=option]')].find(element=>element.textContent.includes('完全免押'));
  await h.click(waived);
  assert.equal(dialog().querySelector('input[aria-label="金卡 每单减免额度"]'),null);
  assert.equal(changes.at(-1).policy.tiers.find(tier=>tier.tier==='GOLD').tenantDeposit,'WAIVED');
  assert.equal(changes.at(-1).policy.tiers.find(tier=>tier.tier==='GOLD').depositAllowanceCents,'0');
});

test('tier monotonicity errors are visible and associated in the current step, not only in locked step three',async t=>{
  const h=await ui(t),state=readyState();
  await h.render(h.view.MembershipGrowthAdminView,{state,canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{}});
  await h.click(h.button('调整会员政策'));
  const dialog=()=>[...h.browser.document.querySelectorAll('[role=dialog]')].find(element=>element.textContent.includes('调整会员政策'));
  const silver=dialog().querySelector('input[aria-label="银卡 统一应付折扣"]');
  const gold=dialog().querySelector('input[aria-label="金卡 统一应付折扣"]');
  await h.type(silver,'0.8');await h.type(gold,'1');
  assert.equal(gold.getAttribute('aria-invalid'),'true');
  const errorId=gold.getAttribute('aria-describedby');
  assert.ok(errorId);
  assert.match(dialog().querySelector(`[id="${errorId}"]`).textContent,/高档折扣不得高于银卡/);
  assert.match(dialog().textContent,/请先修正以下问题/);
  assert.equal([...dialog().querySelectorAll('button')].find(element=>element.textContent==='下一步').disabled,true);
  assert.equal(dialog().querySelector('button[aria-label="第 3 步，共 3 步：生效与提审"]').disabled,true);
});

test('policy page keeps one pending card, one edit entry and an honest unknown linked-request state',async t=>{
  const h=await ui(t),base=readyState(),opened=[];
  const pendingState={...base,policyChange:{status:'UNAVAILABLE',message:'读取失败'},approval:{status:'UNKNOWN',message:'关联申请暂未读到；本次页面内存为空不代表从未申请，请到审批中心核对。'}};
  const props={state:pendingState,canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{},onOpenApproval:()=>opened.push('approval')};
  await h.render(h.view.MembershipGrowthAdminView,props);
  assert.match(h.host.textContent,/待处理变更/);
  assert.match(h.host.textContent,/申请状态暂未确认/);
  assert.doesNotMatch(h.host.textContent,/本次页面内存|不代表从未申请/);
  assert.doesNotMatch(h.host.textContent,/草稿 v\d|生效 v\d/);
  assert.equal([...h.host.querySelectorAll('button')].filter(button=>button.textContent.includes('调整会员政策')).length,1,'one primary edit entry');
  assert.equal([...h.host.querySelectorAll('button')].filter(button=>button.textContent.includes('编辑草稿')||button.textContent.includes('继续编辑')).length,0);
  assert.match(h.host.textContent,/当前生效/);
  const requested={...base,approval:{status:'REQUESTED',requestId:'approval-real',message:'服务端审批状态：PENDING。'}};
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:requested});
  assert.match(h.host.textContent,/已提交审批/);assert.match(changeSection(h).textContent,/等待审批/);
  await h.click(h.button('到审批中心处理'));
  assert.deepEqual(opened,['approval']);
  const legacy={...base,approval:{status:'NOT_REQUESTED'}};
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:legacy});
  assert.doesNotMatch(h.host.textContent,/关联申请暂未读到/,'no draft means no pending card');
});

test('policy change card shows the server-linked request, frozen diff and a compact basic-info dialog',async t=>{
  const h=await ui(t),state=readyState(),opened=[],submitted=[];
  let current={...state,approval:{status:'UNKNOWN',message:'关联申请暂未读到；本次页面内存为空不代表从未申请，请到审批中心核对。'},policyChange:contextChange({request:contextRequest({steps:contextSteps('PENDING')})})};
  const props={state:current,canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{},onSubmitPolicy:()=>submitted.push(true),onOpenPath:(path,title)=>opened.push({path,title})};
  await h.render(h.view.MembershipGrowthAdminView,props);
  assert.match(h.host.textContent,/待处理变更 · 待审批/);assert.equal(h.host.querySelectorAll("[data-testid=membership-policy-feedback]").length,1);
  assert.doesNotMatch(changeSection(h).textContent,/金卡 · 统一应付折扣/,"configuration detail lives in the dialog");
  assert.match(h.host.textContent,/运营乙/);assert.match(h.host.textContent,/2026年10月20日/);assert.match(h.host.textContent,/计划生效/);
  const card=changeSection(h);assert.ok(card);
  assert.equal([...card.querySelectorAll('button')].some(button=>button.textContent.trim()==='提交审批'),false,'a server-linked pending request offers no new submit');
  const approvalAction=[...card.querySelectorAll('button')].find(button=>button.textContent.trim()==='到审批中心处理');assert.ok(approvalAction);
  await h.click(approvalAction);
  assert.deepEqual(opened.at(-1),{path:'/approvals/approval-context-1?from=membership-growth&fromTab=policy',title:'审批详情'});
  current={...current,policy:{...current.policy,version:'b9'},unifiedPricing:{...current.unifiedPricing,tiers:{...current.unifiedPricing.tiers,DIAMOND:{knowledge:'KNOWN',payableRatio:'0.5',reasonCodes:[]}}}};
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:current});
  assert.doesNotMatch(changeSection(h).textContent,/5折/,'the request summary never follows the current draft');
  await h.click([...changeSection(h).querySelectorAll('button')].find(button=>button.textContent.trim()==='查看变更详情'));
  const dialog=()=>h.browser.document.querySelector('[data-slot=dialog-content]');
  assert.ok(dialog());assert.match(dialog().textContent,/变更基本信息/);
  assert.match(dialog().textContent,/申请对应基线/);assert.match(dialog().textContent,/本次申请值/);
  assert.match(dialog().textContent,/金卡 · 统一应付折扣/);assert.match(dialog().textContent,/原价/);assert.match(dialog().textContent,/9折/);assert.match(dialog().textContent,/¥200\.00/);
  assert.match(dialog().textContent,/已提交/);assert.match(dialog().textContent,/审批处理/);assert.match(dialog().textContent,/当前/);
  assert.doesNotMatch(dialog().textContent,/Boss甲/,'a pending approval has no handler yet');
  assert.match(dialog().className,/sm:max-w-\[900px\]/);
  assert.match(dialog().querySelector('[data-testid=policy-change-diff-scroll] [data-slot=table-container]').className,/overflow-x-auto/);
  const detailButton=[...dialog().querySelectorAll('button')].find(button=>button.textContent.trim()==='打开审批详情');assert.ok(detailButton);
  await h.click(detailButton);
  assert.deepEqual(opened.at(-1),{path:'/approvals/approval-context-1?from=membership-growth&fromTab=policy',title:'审批详情'});
  assert.equal(submitted.length,0);
});

test('policy change status fixtures keep approval, execution and effective facts separate',async t=>{
  const h=await ui(t),base=readyState();
  const model=(request,effectiveState={status:'NOT_EFFECTIVE'},extra={})=>h.view.policyChangeCardModel({read:contextChange({request,effectiveState,...extra}),approval:{status:'NOT_REQUESTED'},hasDraft:true,currentDraft:contextDraftRef(),draftDiffs:[],submitReady:true,localPending:false});
  const pending=model(contextRequest({steps:contextSteps('PENDING')}));
  assert.equal(pending.kind,'pending');assert.equal(pending.label,'待审批');assert.equal(pending.canSubmit,false);assert.equal(pending.steps.find(step=>step.key==='APPROVAL').state,'CURRENT');
  const rejected=model(contextRequest({approvalStatus:'REJECTED',steps:contextSteps('REJECTED')}));
  assert.equal(rejected.kind,'rejected');assert.equal(rejected.label,'已退回');assert.equal(rejected.steps.find(step=>step.key==='APPROVAL').state,'FAILED');
  const approved=model(contextRequest({approvalStatus:'APPROVED',executionStatus:'NOT_STARTED',steps:contextSteps('APPROVED')}));
  assert.equal(approved.kind,'approved');assert.equal(approved.label,'审批已过待发布');assert.match(approved.effectiveNote,/执行/);assert.doesNotMatch(approved.effectiveNote,/已生效/);
  const failed=model(contextRequest({approvalStatus:'APPROVED',executionStatus:'FAILED',steps:contextSteps('EXECUTION_FAILED')}));
  assert.equal(failed.kind,'execution-unknown');assert.match(failed.label,/执行状态待核对/);assert.match(failed.effectiveNote,/不能称为已生效/);
  assert.equal(model(contextRequest({approvalStatus:'APPROVED',executionStatus:'UNKNOWN'})).kind,'execution-unknown');
  const scheduled=model(contextRequest({approvalStatus:'APPROVED',executionStatus:'EXECUTED',steps:contextSteps('PENDING_EFFECTIVE')}),{status:'PENDING_EFFECTIVE',effectiveAtUtc:'2026-11-01T00:00:00.000Z'});
  assert.equal(scheduled.kind,'pending-effective');assert.equal(scheduled.label,'已发布待生效');assert.match(scheduled.effectiveNote,/尚未到生效时点/);assert.equal(scheduled.steps.find(step=>step.key==='EFFECTIVE').state,'CURRENT');
  const effective=model(contextRequest({approvalStatus:'APPROVED',executionStatus:'EXECUTED',steps:contextSteps('EFFECTIVE')}),{status:'EFFECTIVE',effectiveAtUtc:'2026-10-23T00:00:00.000Z'});
  assert.equal(effective.kind,'effective');assert.equal(effective.label,'已生效');assert.equal(effective.steps.every(step=>step.state==='COMPLETED'),true);
  for(const value of [pending,rejected,approved,failed,scheduled,effective]){assert.equal(value.canSubmit,false);assert.equal(value.canOpenDetail,true);}
  const state={...base,policyChange:contextChange({request:contextRequest({approvalStatus:'APPROVED',executionStatus:'EXECUTED',steps:contextSteps('EFFECTIVE')}),effectiveState:{status:'EFFECTIVE',effectiveAtUtc:'2026-10-23T00:00:00.000Z'}})};
  await h.render(h.view.MembershipGrowthAdminView,{state,onOpenPath:()=>{}});
  assert.match(h.host.textContent,/最近变更 · 已生效/);
  await h.click([...changeSection(h).querySelectorAll('button')].find(button=>button.textContent.trim()==='查看变更详情'));
  const text=h.browser.document.querySelector('[data-slot=dialog-content]').textContent;
  assert.match(text,/Boss甲/);assert.match(text,/运营丙/);assert.match(text,/经手人未取得/);
});

test('policy change projection never attaches another draft or another business and separates unavailable states',async t=>{
  const h=await ui(t);
  const model=(read,approval={status:'NOT_REQUESTED'},extra={})=>h.view.policyChangeCardModel({read,approval,hasDraft:true,currentDraft:contextDraftRef(),draftDiffs:[],submitReady:true,localPending:false,...extra});
  const wrongVersion=model(contextChange({draftReference:contextDraftRef({version:'b0'})}));
  assert.equal(wrongVersion.kind,'foreign');assert.match(wrongVersion.label,/另一份草稿/);assert.equal(wrongVersion.canSubmit,false);assert.match(wrongVersion.sourceNote,/id\/version\/hash/);
  assert.equal(model(contextChange({draftReference:contextDraftRef({payloadHash:'b'.repeat(64)})})).kind,'foreign');
  const wrongOperation=model(contextChange({request:contextRequest({operationCode:'membership.entitlement.grant'})}));
  assert.equal(wrongOperation.kind,'unknown');assert.match(wrongOperation.label,/业务类型/);assert.equal(wrongOperation.canSubmit,false);
  const noReference=model(contextChange({draftReference:null}));
  assert.equal(noReference.kind,'unknown');assert.match(noReference.label,/暂未取得/);assert.equal(noReference.canSubmit,false);
  assert.equal(model({status:'READY',change:{knowledge:'UNKNOWN',message:'投影暂不可用'}}).kind,'unknown');
  assert.equal(model({status:'READY',change:{knowledge:'FORBIDDEN'}}).kind,'forbidden');
  assert.equal(model({status:'UNAVAILABLE',message:'字段未部署'}).kind,'unavailable');
  const absent=model(contextChange({request:null,immutableDiff:[]}));
  assert.equal(absent.kind,'draft');assert.equal(absent.canSubmit,true);
  const pendingLocal=model(contextChange({request:null,immutableDiff:[]}),{status:'UNKNOWN',message:'原请求记录待核对'},{localPending:true});
  assert.equal(pendingLocal.kind,'unknown');assert.equal(pendingLocal.canSubmit,false);
  const oldTerminal=model(contextChange({draftReference:contextDraftRef({id:'draft-old'}),request:contextRequest({approvalStatus:'REJECTED'})}));
  assert.equal(oldTerminal.kind,'draft');assert.match(oldTerminal.summary,/上次申请/);assert.equal(oldTerminal.priorRequest,true);assert.equal(oldTerminal.canSubmit,true);
});

test('policy change unknown states disable submission and expose refresh or original entry',async t=>{
  const h=await ui(t),base=readyState();let refreshed=0;
  const props={canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{},onSubmitPolicy:()=>{},onRefreshPolicyChange:()=>{refreshed+=1;},onOpenPath:()=>{}};
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:{...base,policyChange:{status:'UNAVAILABLE',message:'字段未部署'}}});
  assert.match(h.host.textContent,/待处理变更 · 申请状态待确认/);assert.doesNotMatch(h.host.textContent,/字段未部署/);assert.match(h.host.textContent,/请刷新后再操作/);
  assert.ok(changeSection(h).textContent.includes('刷新状态'));
  assert.equal([...changeSection(h).querySelectorAll('button')].some(button=>button.textContent.trim()==='提交审批'),false);
  await h.click([...changeSection(h).querySelectorAll('button')].find(button=>button.textContent.trim()==='刷新状态'));
  assert.equal(refreshed,1);
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:{...base,policyChange:{status:'READY',change:{knowledge:'UNKNOWN',message:'服务端暂未取得变更状态'}}}});
  assert.match(h.host.textContent,/待处理变更 · 申请状态待确认/);assert.match(h.host.textContent,/申请状态暂未确认/);
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:{...base,policyChange:{status:'READY',change:{knowledge:'FORBIDDEN'}}}});
  assert.match(h.host.textContent,/待处理变更 · 无权读取变更状态/);
  assert.equal([...changeSection(h).querySelectorAll('button')].some(button=>button.textContent.trim()==='提交审批'),false);
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:base});
  assert.match(h.host.textContent,/待处理变更 · 草稿待提交/);
  assert.equal(h.button('提交审批').disabled,false);
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:{...base,policy:{...base.policy,status:'APPROVED'},policyChange:{status:'READY',change:{knowledge:'KNOWN',request:null,immutableDiff:[]}}}});
  assert.match(h.host.textContent,/政策变更 · 暂无待处理变更/);assert.match(h.host.textContent,/当前没有待处理的政策申请/);
  assert.equal([...changeSection(h).querySelectorAll('button')].some(button=>button.textContent.trim()==='查看变更详情'),false);
});

test('R1 a missing operation code cannot attach a request to the current draft',async t=>{
  const h=await ui(t),state=readyState(),opened=[];
  const read=contextChange({request:contextRequest({operationCode:null,approvalStatus:'PENDING',executionStatus:null})});
  await h.render(h.view.MembershipGrowthAdminView,{state:{...state,policyChange:read},canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{},onSubmitPolicy:()=>{},onOpenPath:(path,title)=>opened.push({path,title})});
  const card=changeSection(h);assert.ok(card);
  assert.match(h.host.textContent,/待处理变更 · 申请状态待确认/);
  assert.doesNotMatch(card.textContent,/待审批/);
  assert.match(card.textContent,/申请状态暂未确认/);
  assert.equal([...card.querySelectorAll('button')].some(button=>button.textContent.trim()==='提交审批'),false);
  assert.equal(h.button('提交审批').disabled,true);
  const link=[...card.querySelectorAll('button')].find(button=>button.textContent.trim()==='查看原申请');assert.ok(link);
  await h.click(link);
  assert.deepEqual(opened.at(-1),{path:'/approvals/approval-context-1?from=membership-growth&fromTab=policy',title:'审批详情'});
});

test('R1 FORBIDDEN keeps a local original ID while clearing restricted details',async t=>{
  const h=await ui(t),state=readyState(),opened=[];
  const read={status:'READY',change:{knowledge:'FORBIDDEN'},knownRequestId:'server-known-id'};
  await h.render(h.view.MembershipGrowthAdminView,{state:{...state,approval:{status:'UNKNOWN',requestId:'local-known-id'},policyChange:read},canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{},onSubmitPolicy:()=>{},onOpenPath:(path,title)=>opened.push({path,title})});
  const card=changeSection(h);assert.ok(card);
  assert.match(h.host.textContent,/待处理变更 · 无权读取变更状态/);
  assert.match(card.textContent,/查看原申请/);assert.doesNotMatch(card.textContent,/金卡 ·|运营乙|¥|提交审批/);
  const link=[...card.querySelectorAll('button')].find(button=>button.textContent.trim()==='查看原申请');assert.ok(link);
  await h.click(link);
  assert.deepEqual(opened.at(-1),{path:'/approvals/local-known-id?from=membership-growth&fromTab=policy',title:'审批详情'});
  await h.click([...changeSection(h).querySelectorAll('button')].find(button=>button.textContent.trim()==='查看变更详情'));
  const dialog=h.browser.document.querySelector('[data-slot=dialog-content]');assert.ok(dialog);
  assert.match(dialog.textContent,/原申请详情受限/);assert.doesNotMatch(dialog.textContent,/金卡 ·|运营乙|¥200/);
});

test('black gold permanent row mirrors diamond and never becomes an editable sixth tier',async t=>{
  const h=await ui(t),state=readyState();
  const render=async overrides=>h.render(h.view.MembershipGrowthAdminView,{state:{...state,...overrides},canEditEntitlementRanges:true,onPolicyChange:()=>{},onSavePolicyDraft:()=>{}});
  await render({});
  const row=rowText(h,'黑金（永久）');
  assert.match(row,/累计有效成长积分 50,000/);assert.match(row,/永久/);assert.match(row,/权益随钻石档调整/);assert.match(row,/8\.5折（实付 85%）/);assert.match(row,/完全免除押金/);
  assert.match(h.host.textContent,/普通档按近90天成长积分/);assert.doesNotMatch(row,/近90天/,'the black gold condition is never written as a rolling 90-day threshold');
  const limitedPolicy={...state.approvedPolicy,tiers:state.approvedPolicy.tiers.map(tier=>tier.tier==='DIAMOND'?{...tier,tenantDeposit:'ACCOUNT_BASE',depositAllowanceCents:'20000'}:tier)};
  await render({approvedPolicy:limitedPolicy});
  assert.match(rowText(h,'黑金（永久）'),/减免押金 ¥200 元/);
  const unknownPolicy={...state.approvedPolicy,tiers:state.approvedPolicy.tiers.filter(tier=>tier.tier!=='DIAMOND')};
  const unknownUnified={...state.approvedUnifiedPricing,tiers:{...state.approvedUnifiedPricing.tiers,DIAMOND:{knowledge:'UNKNOWN',payableRatio:null,reasonCodes:['FIXTURE']}}};
  await render({approvedPolicy:unknownPolicy,approvedUnifiedPricing:unknownUnified});
  const unknownRow=rowText(h,'黑金（永久）');
  assert.match(unknownRow,/待核/);assert.match(unknownRow,/未取得/);assert.doesNotMatch(unknownRow,/原价|完全免除押金/);
  await render({});
  await h.click(h.button('调整会员政策'));
  const dialog=()=>h.browser.document.querySelector('[data-slot=dialog-content]');
  assert.equal(dialog().querySelector("input[aria-label*='黑金']"),null);
  assert.match(dialog().textContent,/累计有效成长积分 50,000/);assert.match(dialog().textContent,/8\.5折（实付 85%）/);
  const diamondInput=dialog().querySelector("input[aria-label='钻石 统一应付折扣']");assert.ok(diamondInput);
  await h.type(diamondInput,'0.80');
  assert.match(dialog().textContent,/8折（实付 80%）/);
  await h.click(dialog().querySelector('[role=combobox][aria-label="钻石 押金权益"]'));
  const allowance=[...h.browser.document.querySelectorAll('[role=option]')].find(option=>option.textContent.includes('按额度减免'));assert.ok(allowance);
  await h.click(allowance);
  assert.match(dialog().textContent,/减免押金 ¥200 元/);
  await h.click(dialog().querySelector('button[aria-label="第 2 步，共 3 步：变更核对"]'));
  assert.match(dialog().textContent,/黑金（永久） · 统一应付折扣（随钻石）/);assert.match(dialog().textContent,/黑金（永久） · 押金权益（随钻石）/);
  const input=h.view.unifiedPricingInputFromDraft(h.view.unifiedDraftFromProjection(state.unifiedPricing));
  assert.deepEqual(Object.keys(input.tiers),TIERS);
  assert.equal(Object.hasOwn(input.tiers,'BLACK_GOLD'),false);
});

test('policy publish approval summary hides entitlement target fields and does not invent policy values',async t=>{
  const h=await ui(t);
  const business={businessType:'membership',summaryAvailable:true,summary:{gameName:'不应显示的游戏',targetUserId:'不应显示的用户',entitlementKind:'FRIEND',startsAt:'2026-11-01T00:00:00Z',endsAt:'2026-11-20T00:00:00Z',policyDraft:{id:'draft-policy-1',version:3,effectiveAtUtc:'2026-10-31T04:07:00Z',ruleReleaseId:'release-1',priceVersionId:'price-1',hash:'a'.repeat(64)},reason:'发布会员政策'}};
  const html=renderToString(createElement(h.businessSummary.BusinessSummary,{business,operationCode:'membership.benefit.policy.publish'}));
  assert.match(html,/2026年10月31日/);
  assert.doesNotMatch(html,/draft-policy-1|规则发布|价格版本|政策草稿/,'政策 dev 依据已下沉技术追溯，不在业务摘要显示');
  assert.doesNotMatch(html,/不应显示的游戏|不应显示的用户|礼遇类型/);
  assert.match(html,/逐档权益的冻结差异尚未提供/,'缺少冻结差异时保持未知，不借当前草稿生成审批内容');
});

test('policy view renders legacy/unknown unified projections without inventing values and disables unsupported contracts',async t=>{
  const h=await ui(t),state=readyState();
  const legacyTier={knowledge:'UNKNOWN',payableRatio:null,reasonCodes:['LEGACY_MODE_VALUES_DIFFER']};
  const legacyRange={knowledge:'UNKNOWN',minPayableRatio:null,maxPayableRatio:null,priceVersionId:null,costBasisRef:null,reasonCodes:['UNIFIED_RANGE_UNAVAILABLE']};
  const legacyPricing={...unifiedProjection(),knowledge:'UNKNOWN',tiers:{...unifiedProjection().tiers,SILVER:legacyTier},entitlementRanges:{...unifiedProjection().entitlementRanges,FRIEND:legacyRange}};
  await h.render(h.view.MembershipGrowthAdminView,{state:{...state,approvedUnifiedPricing:legacyPricing,unifiedPricing:legacyPricing},onPolicyChange:()=>{},canEditEntitlementRanges:true});
  assert.match(h.host.textContent,/待核/);assert.match(h.host.textContent,/旧路径数值或依据不一致|统一礼遇范围暂不可用/);
  assert.equal(h.input('银卡 统一应付折扣').value,'','a legacy conflict never defaults to the first mode');
  assert.equal(h.input('挚友礼遇 最小应付比例').value,'','a legacy range never defaults to the first mode');
  await h.render(h.view.MembershipGrowthAdminView,{state:{...state,capability:{...state.capability,unifiedPricingSupported:false}}});
  assert.match(h.host.textContent,/会员配置暂时只读/);assert.doesNotMatch(h.host.textContent,/API_DEPENDENCY_PENDING/);assert.doesNotMatch(h.host.textContent,/编辑政策/);
});

test('entitlement form validates independent ranges, dates, automatic references and unknown growth without network',async t=>{
  const h=await ui(t),state=readyState(),submitted=[];
  const context={schema:'membership-entitlement-context.v1',subject:{userId:'u',name:'用户甲',image:null,maskedPhone:null},game:{id:'delta',name:'三角洲'},approvedMeta:{id:'approved-1',version:'1',effectiveAtUtc:'2026-10-01T00:00:00.000Z',ruleReleaseId:'release-1',priceVersionId:'price-v1',payloadHash:'a'.repeat(64),sourceRef:'fixture'},ranges:state.policy.entitlementRanges,unifiedRanges:state.unifiedPricing.entitlementRanges,pricingScope:'ALL_ENABLED_RENTAL_MODES',rangeSource:'INDEPENDENT',capability:{canRequest:true,reasonCode:'OK',unifiedPricingSupported:true,requiresUnifiedPricing:true},existingEntitlements:[],growth:{knowledge:'UNKNOWN'}};
  const initial={kind:'FRIEND',scopeKey:'legacy:scope',startsAtUtc:'2026-11-01T02:00:00.000Z',endsAtUtc:'2026-11-20T02:00:00.000Z',pricingMode:'ordinary',priceVersionId:'untrusted-initial',payableRatio:'0.8',costBasisRef:'untrusted-initial',depositWaived:false,reason:'用户专项礼遇'};
  const props={context,initial,onSubmit:draft=>submitted.push(draft)};
  await h.render(h.form.MembershipEntitlementForm,props);
  assert.equal(h.host.querySelector('select,input[type=datetime-local],input[aria-label="礼遇成本依据"],input[aria-label="礼遇业务范围"]'),null);
  assert.match(h.host.textContent,/可选 6折 – 原价/);assert.ok(h.host.querySelector('button[aria-label="礼遇折扣说明"]'),'scope explanation lives in the tooltip, not an extra field');
  assert.doesNotMatch(h.host.textContent,/适用范围|快捷免押|金卡|钻石|untrusted-initial/);assert.equal(h.host.querySelector('[role=combobox][aria-label="计价模式"]'),null,'no entitlement mode selector');
  assert.equal(h.button('提交礼遇审批').disabled,false,'UNKNOWN growth is not a grant-capability gate');
  await h.type(h.input('礼遇应付比例'),'0.5');assert.match(h.host.textContent,/超出允许范围/);assert.equal(h.button('提交礼遇审批').disabled,true);
  await h.type(h.input('礼遇应付比例'),'1.000000001');assert.match(h.host.textContent,/最多8位小数/);
  await h.type(h.input('礼遇应付比例'),'0.8');
  await h.click(h.host.querySelector('button[aria-label="开始日期"]'));
  assert.equal(h.browser.document.querySelector('[data-slot=calendar]').style.getPropertyValue('--cell-size'),'2.5rem','day cells are readable, not 2rem-tight');
  const day=[...h.browser.document.querySelectorAll('button[data-day]')].find(element=>element.textContent.trim()==='11');
  assert.ok(day,'house Calendar renders interactive days');await h.click(day);
  await h.click(h.button('提交礼遇审批'));
  assert.equal(submitted.length,1);assert.equal(submitted[0].scopeKey,'legacy:scope');assert.equal(submitted[0].priceVersionId,'price-v1');assert.equal(submitted[0].costBasisRef,'cost-ent');assert.equal(submitted[0].pricingMode,undefined,'the unified grant payload has no mode');
  assert.equal(submitted[0].startsAtUtc,'2026-11-11T02:00:00.000Z');
  await h.render(h.form.MembershipEntitlementForm,{...props,context:{...context,unifiedRanges:{FRIEND:{...context.unifiedRanges.FRIEND,knowledge:'UNKNOWN',minPayableRatio:null,maxPayableRatio:null,reasonCodes:['UNIFIED_RANGE_UNAVAILABLE']},PRESTIGE:context.unifiedRanges.PRESTIGE},capability:{...context.capability,canRequest:false,reasonCode:'UNIFIED_RANGE_REQUIRED'}}});
  assert.match(h.host.textContent,/当前旧范围尚未统一，请先调整政策并审批/);assert.equal(h.button('提交礼遇审批').disabled,true);
  await h.render(h.form.MembershipEntitlementForm,{...props,context:{...context,subject:{...context.subject,userId:'other'}},initial:undefined});
  assert.equal(h.input('礼遇应付比例').value,'','switching subject resets the old draft');assert.equal(h.button('提交礼遇审批').disabled,true);
  await h.render(h.form.MembershipEntitlementForm,{...props,context:{...context,capability:{canRequest:false,reasonCode:'FEATURE_DISABLED'}},busy:true,error:'权限发生变化'});
  assert.equal(h.button('正在提交…').disabled,true);assert.match(h.host.textContent,/礼遇功能尚未启用|权限发生变化/);
  assert.equal(h.form.beijingInputToUtc('2026-02-30T10:00'),'');assert.equal(h.form.beijingInputToUtc('2026-11-01T10:00'),'2026-11-01T02:00:00.000Z');
  assert.equal(h.form.utcToBeijingInput(null),'');assert.equal(h.form.parsePayableRatio(1),null,'a numeric JSON value is not an exact decimal-text contract');
  const beijingToday=h.form.membershipCalendarToday(new Date('2026-10-31T18:00:00.000Z'));
  assert.deepEqual([beijingToday.getFullYear(),beijingToday.getMonth()+1,beijingToday.getDate()],[2026,11,1],'UTC evening is already the next Beijing calendar day');
  assert.equal(h.form.membershipCalendarToday(new Date('2026-10-31T15:59:59.999Z')).getDate(),31,'cross-day boundary keeps the Beijing day');
  for(const [value,expected] of [['0.85','8.5折'],['0.85000000','8.5折'],['1','原价'],['0.00000001','0.0000001折'],['0.99999999','9.9999999折'],['0','折扣待核'],['1.01','折扣待核'],[undefined,'折扣待核']])assert.equal(h.form.formatEntitlementDiscount(value),expected);
  assert.equal(h.form.formatDiscountLabel('1'),'原价');assert.equal(h.form.formatDiscountRangeLabel('0.6','1'),'6折 – 原价');assert.equal(h.form.formatDiscountRangeLabel('1','1'),'原价');
  assert.equal(h.form.entitlementWindowError('2026-11-01T00:00:00Z','2027-01-30T00:00:00Z'),'');assert.equal(h.form.entitlementWindowError('2026-11-01T00:00:00Z','2027-01-30T00:00:00.001Z'),'礼遇单次最多90天');
  assert.equal(h.fetches.length,0);
});

test('form switches independent kind, guards duplicate submission and blocks unavailable context',async t=>{
  const h=await ui(t),state=readyState();let release;const waiting=new Promise(resolve=>{release=resolve;}),submitted=[];
  const context={schema:'membership-entitlement-context.v1',subject:{userId:'u',name:null,image:null,maskedPhone:null},game:{id:'delta',name:'三角洲'},approvedMeta:{id:'approved-1',version:'1',effectiveAtUtc:'2026-10-01T00:00:00.000Z',ruleReleaseId:'r',priceVersionId:'price-v1',payloadHash:'b'.repeat(64),sourceRef:'fixture'},ranges:state.policy.entitlementRanges,unifiedRanges:state.unifiedPricing.entitlementRanges,pricingScope:'ALL_ENABLED_RENTAL_MODES',rangeSource:'INDEPENDENT',capability:{canRequest:true,reasonCode:'OK',unifiedPricingSupported:true,requiresUnifiedPricing:true},existingEntitlements:[]};
  const initial={...state.entitlement,startsAtUtc:'2026-11-01T00:00:00.000Z',endsAtUtc:'2026-11-20T00:00:00.000Z',payableRatio:'0.8',reason:'专项处理'};
  const props={context,initial,onSubmit:async draft=>{submitted.push(draft);await waiting;}};
  await h.render(h.form.MembershipEntitlementForm,props);
  assert.equal(h.host.querySelector('[role=combobox][aria-label="礼遇类型"]').disabled,true,'replacing an existing entitlement keeps its kind fixed');
  await h.render(h.form.MembershipEntitlementForm,{...props,initial:undefined});
  await h.type(h.input('礼遇应付比例'),'0.8');
  await h.click(h.host.querySelector('[role=combobox][aria-label="礼遇类型"]'));
  const prestige=[...h.browser.document.querySelectorAll('[role=option]')].find(element=>element.textContent.trim()==='尊享礼遇');
  assert.ok(prestige);await h.click(prestige);
  assert.equal(h.input('礼遇应付比例').value,'','a different kind never inherits the old actual discount');
  await h.type(h.input('礼遇应付比例'),'0.8');
  for(const [label,day] of [['开始','1'],['结束','20']]){
    await h.click(h.host.querySelector(`button[aria-label="${label}日期"]`));
    await h.click([...h.browser.document.querySelectorAll('button[data-day]')].find(element=>element.textContent.trim()===day));
  }
  await h.type(h.host.querySelector('textarea[aria-label="礼遇原因"]'),'专项处理');
  await h.click(h.host.querySelector('[role=combobox][aria-label="押金减免方式"]'));
  const waived=[...h.browser.document.querySelectorAll('[role=option]')].find(element=>element.textContent.trim()==='完全免押');
  assert.ok(waived,'deposit mode owns the waive choice; no duplicate checkbox');await h.click(waived);
  assert.match(h.host.textContent,/租客押金全免/);
  try{
    await h.click(h.button('提交礼遇审批'));assert.equal(submitted.length,1);assert.equal(submitted[0].kind,'PRESTIGE');assert.equal(submitted[0].depositWaived,true);
    assert.equal(h.button('正在提交…').disabled,true);
    await act(async()=>h.host.querySelector('form').dispatchEvent(new h.browser.Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(submitted.length,1,'an in-flight request is not submitted twice');
  }finally{await act(async()=>{release();await waiting;});}
  await h.render(h.form.MembershipEntitlementForm,{...props,context:{...context,approvedMeta:null}});
  assert.equal(h.button('提交礼遇审批').disabled,true);
  let failures=0;
  await h.render(h.form.MembershipEntitlementForm,{...props,onSubmit:()=>{failures++;throw new Error('synthetic unconfirmed submission');}});
  await h.click(h.button('提交礼遇审批'));assert.equal(failures,1);assert.match(h.host.textContent,/提交结果未确认/);
  await h.type(h.input('礼遇应付比例'),'0.85');
  assert.equal(h.button('提交礼遇审批').disabled,true,'editing a field cannot clear an unresolved submission');
  await act(async()=>h.host.querySelector('form').dispatchEvent(new h.browser.Event('submit',{bubbles:true,cancelable:true})));
  assert.equal(failures,1);
  assert.equal(h.fetches.length,0);
});
test("unified policy draft validation stays conservative and never fills missing ratios", async t => {
  const h = await ui(t), state = readyState();
  const emptyProjection = {
    schema: 'membership-unified-pricing.v1', scope: 'ALL_ENABLED_RENTAL_MODES', knowledge: 'UNKNOWN',
    tiers: Object.fromEntries(TIERS.map((tier) => [tier, { knowledge: 'UNKNOWN', payableRatio: null, reasonCodes: ['UNIFIED_PRICING_REQUIRED'] }])),
    entitlementRanges: Object.fromEntries(['FRIEND','PRESTIGE'].map((kind) => [kind, { knowledge: 'UNKNOWN', minPayableRatio: null, maxPayableRatio: null, priceVersionId: null, costBasisRef: null, reasonCodes: ['UNIFIED_RANGE_UNAVAILABLE'] }])),
  };
  const empty = h.view.unifiedDraftFromProjection(emptyProjection);
  const first = h.view.validateAdminPolicyDraft(state.policy, empty);
  assert.deepEqual(first.errors, []);
  assert.equal(first.publishable, false);
  assert.ok(first.warnings.some((warning) => warning.includes('统一折扣待填写')));
  assert.ok(first.warnings.some((warning) => warning.includes('统一范围待填写')));
  const filled = h.view.unifiedDraftFromProjection(state.unifiedPricing);
  assert.equal(h.view.validateAdminPolicyDraft(state.policy, filled).publishable, true, JSON.stringify(h.view.validateAdminPolicyDraft(state.policy, filled)));
  const inverted = { ...filled, tiers: { ...filled.tiers, SILVER: '0.99' } };
  assert.ok(h.view.validateAdminPolicyDraft(state.policy, inverted).errors.some((error) => error.includes('高档折扣')));
  const invalid = { ...filled, tiers: { ...filled.tiers, GOLD: '1.5' } };
  assert.ok(h.view.validateAdminPolicyDraft(state.policy, invalid).errors.some((error) => error.includes('(0,1]')));
  const badRange = { ...filled, ranges: { ...filled.ranges, FRIEND: { min: '0.9', max: '0.8' } } };
  assert.ok(h.view.validateAdminPolicyDraft(state.policy, badRange).errors.some((error) => error.includes('最小应付比例')));
  const past = { ...state, policy: { ...state.policy, effectiveAt: '2026-10-01T00:00:00.000Z' } };
  assert.equal(h.view.validateAdminPolicyDraft(past.policy, filled).publishable, true, 'no new future-time rule is imposed');
});

test("policy approval uses immutable saved-draft metadata rather than the full policy body", async () => {
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)), "@brand": fileURLToPath(new URL("../../../assets/brand", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { policyDraftApprovalPayload } = await vite.ssrLoadModule("/src/views/membership-growth-admin-host.tsx");
    const meta = { id: "draft-1", version: "2", status: "DRAFT", payloadHash: "a".repeat(64), ruleReleaseId: "release-1", priceVersionId: "price-1", sourceRef: "fixture", effectiveAtUtc: "2026-10-10T00:00:00.000Z" };
    const payload = policyDraftApprovalPayload(meta);
    assert.deepEqual(payload, { policyDraftId: "draft-1", policyDraftVersion: 2, policyDraftHash: "a".repeat(64), ruleReleaseId: "release-1", priceVersionId: "price-1", sourceRef: "fixture", effectiveAtUtc: "2026-10-10T00:00:00.000Z" });
    assert(Buffer.byteLength(JSON.stringify(payload)) < 8192);
    assert.throws(() => policyDraftApprovalPayload({ ...meta, status: "APPROVED" }));
    assert.throws(() => policyDraftApprovalPayload({ ...meta, payloadHash: "" }));
  } finally { await vite.close(); }
});

test("GAP-007 membership host gate matches nav/API read admission and hides writes from summary readers", async () => {
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { membershipGrowthAccess } = await vite.ssrLoadModule("/src/views/membership-growth-admin-host.tsx");
    const snap = (permissions, isBoss = false) => ({ authenticated: true, permissions, security: { isBoss } });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.growth.read.summary"])), { canRead: true, canReadPolicy: true, canDraft: false, canRequest: false, canRequestEntitlement: false });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.policy.publish"])), { canRead: true, canReadPolicy: true, canDraft: false, canRequest: false, canRequestEntitlement: false });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.policy.publish", "approval.request.create"])), { canRead: true, canReadPolicy: true, canDraft: false, canRequest: true, canRequestEntitlement: false });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.policy.draft"])), { canRead: true, canReadPolicy: true, canDraft: true, canRequest: false, canRequestEntitlement: false });
    assert.deepEqual(membershipGrowthAccess(snap([], true)), { canRead: true, canReadPolicy: true, canDraft: true, canRequest: true, canRequestEntitlement: true });
    assert.deepEqual(membershipGrowthAccess(snap(["membership.growth.read.detail"])), { canRead: false, canReadPolicy: false, canDraft: false, canRequest: false, canRequestEntitlement: false });
    assert.deepEqual(membershipGrowthAccess(snap(["approval.request.create", "membership.entitlement.request"])), { canRead: true, canReadPolicy: false, canDraft: false, canRequest: false, canRequestEntitlement: true });
    for (const permission of ["approval.request.create", "membership.entitlement.request"]) {
      assert.deepEqual(membershipGrowthAccess(snap([permission])), { canRead: false, canReadPolicy: false, canDraft: false, canRequest: false, canRequestEntitlement: false });
    }
  } finally { await vite.close(); }
});


test("diffGrowthPolicies lists only decision-relevant unified tier, deposit, range and time changes", async t => {
  const h = await ui(t), state = readyState();
  const baseline = structuredClone(state.approvedPolicy);
  const baselineUnified = structuredClone(state.approvedUnifiedPricing);
  const draft = structuredClone(state.policy);
  const draftUnified = h.view.unifiedDraftFromProjection(state.unifiedPricing);
  assert.deepEqual(h.view.diffGrowthPolicies(baseline, baselineUnified, draft, draftUnified), [], "identical policies have no diff");
  draftUnified.tiers.SILVER = '0.80';
  draft.tiers[0].tenantDeposit = 'WAIVED';
  draft.tiers[0].depositAllowanceCents = '0';
  draftUnified.ranges.FRIEND.min = '0.50';
  draft.effectiveAt = '2026-11-02T00:00:00.000Z';
  const changes = h.view.diffGrowthPolicies(baseline, baselineUnified, draft, draftUnified);
  const labels = changes.map((change) => change.label);
  assert.ok(labels.includes('银卡 · 统一应付折扣'), labels.join(' | '));
  assert.ok(labels.includes('普通 · 押金权益'), labels.join(' | '));
  assert.ok(labels.includes('挚友礼遇 · 统一折扣范围'), labels.join(' | '));
  assert.ok(labels.includes('计划生效时间'), labels.join(' | '));
  assert.equal(changes.find((change) => change.label.includes('应付折扣')).risk, 'REVIEW_REQUIRED');
  assert.equal(changes.find((change) => change.label === '普通 · 押金权益').risk, 'REVIEW_REQUIRED');
});

test('closeout pending is one progress alert and locks policy edits, saves and duplicate submit', async t => {
  const h = await ui(t), state = readyState(), calls = [];
  await h.render(h.view.MembershipGrowthAdminView, {
    state: { ...state, policyChange: contextChange({ immutableDiff: null }) },
    canEditEntitlementRanges: true, onPolicyChange: () => calls.push('edit'),
    onSavePolicyDraft: () => calls.push('save'), onSubmitPolicy: () => calls.push('submit'), onOpenPath: () => {},
  });
  const feedback = h.host.querySelector('[data-testid=membership-policy-feedback]');
  assert.equal(h.host.querySelectorAll('[data-testid=membership-policy-feedback]').length, 1);
  assert.equal(feedback.getAttribute('role'), 'status');
  assert.equal(h.button('调整会员政策').disabled, true);
  assert.equal(h.button('保存草稿').disabled, true);
  assert.equal(h.button('提交审批').disabled, true);
  assert.equal(h.input('银卡 统一应付折扣').disabled, true);
  await h.click(h.button('保存草稿')); await h.click(h.button('提交审批'));
  assert.deepEqual(calls, []);
  assert.doesNotMatch(feedback.textContent, /投影|字段未部署|本次内存|未知关联|差异未取得/);
});

test('closeout unknown feedback has one explanation, a refresh and the known original entry', async t => {
  const h = await ui(t), state = readyState(), opened = []; let refreshes = 0;
  await h.render(h.view.MembershipGrowthAdminView, {
    state: { ...state, policyChange: { status: 'UNAVAILABLE', knownRequestId: 'retained-original', message: '字段未部署' } },
    policyNotice: { tone: 'warning', blocking: true, title: '申请状态暂未更新', description: '刷新失败，请稍后重试。', requestId: 'retained-original' },
    onPolicyChange: () => {}, onSavePolicyDraft: () => {}, onSubmitPolicy: () => {},
    onRefreshPolicyChange: () => refreshes++, onOpenPath: path => opened.push(path),
  });
  const feedback = h.host.querySelector('[data-testid=membership-policy-feedback]');
  assert.equal(h.host.querySelectorAll('[role=alert]').length, 1);
  assert.equal(feedback.querySelectorAll('p').length, 1);
  assert.doesNotMatch(feedback.textContent, /字段未部署|投影|内存|暂无待处理/);
  assert.equal(h.button('提交审批').disabled, true);
  await h.click(h.button('刷新状态')); await h.click(h.button('查看原申请'));
  assert.equal(refreshes, 1);
  assert.deepEqual(opened, ['/approvals/retained-original?from=membership-growth&fromTab=policy']);
});

test('closeout basic info renders only the bound original requested values and clears them on lost access', async t => {
  const h = await ui(t), state = readyState();
  const requestedValues = [
    { label: '银卡 · 应付比例', value: '0.87', format: 'DISCOUNT' },
    { label: '银卡 · 每单押金减免额度', value: '20000', format: 'CENTS' },
    { label: '挚友礼遇 · 最低应付比例', value: null, format: 'DISCOUNT' },
  ];
  const props = { canEditEntitlementRanges: true, onPolicyChange: () => {}, onSavePolicyDraft: () => {}, onSubmitPolicy: () => {}, onOpenPath: () => {} };
  await h.render(h.view.MembershipGrowthAdminView, { ...props, state: {
    ...state, draftReference: contextDraftRef({ id: 'new-draft', version: 'b3', payloadHash: 'c'.repeat(64) }),
    policy: { ...state.policy, version: 'b3' },
    policyChange: contextChange({ requestedValues, immutableDiff: null }),
  } });
  await h.click(h.button('查看变更详情'));
  let dialog = h.browser.document.querySelector('[data-slot=dialog-content]');
  assert.match(dialog.textContent, /申请配置（不是当前生效权益）/);
  const values = dialog.querySelector('[data-testid=policy-requested-values]'); assert.ok(values);
  assert.equal(values.querySelectorAll('tbody tr').length, 3);
  assert.match(values.textContent, /8\.7折/); assert.match(values.textContent, /¥200\.00/);
  assert.match(values.textContent, /未取得/);
  assert.doesNotMatch(values.textContent, /9\.2折|9\.5折|原价/);
  assert.equal(dialog.querySelector('[data-testid=policy-change-diff-scroll]'), null);
  assert.doesNotMatch(dialog.textContent, /冻结差异|申请对应基线/);
  assert.match(dialog.textContent, /运营乙/); assert.match(dialog.textContent, /2026年10月20日/);
  await h.render(h.view.MembershipGrowthAdminView, { ...props, state: { ...state, policyChange: {
    status: 'READY', knownRequestId: 'approval-context-1', change: { knowledge: 'FORBIDDEN', request: null, requestedValues, immutableDiff: null },
  } } });
  dialog = h.browser.document.querySelector('[data-slot=dialog-content]');
  assert.equal(dialog.querySelector('[data-testid=policy-requested-values]'), null);
  assert.doesNotMatch(dialog.textContent, /8\.7折|¥200\.00|运营乙/);
});

test('closeout expired and cancelled are closed requests, preserve audit links and require a new saved draft', async t => {
  const h = await ui(t), state = readyState();
  for (const [status, label] of [['EXPIRED', '已过期'], ['CANCELLED', '已撤销']]) {
    const read = contextChange({ immutableDiff: null, request: contextRequest({ approvalStatus: status }) });
    const props = { onPolicyChange: () => {}, onSavePolicyDraft: () => {}, onSubmitPolicy: () => {}, onOpenPath: () => {} };
    await h.render(h.view.MembershipGrowthAdminView, { ...props, state: { ...state, policyChange: read } });
    assert.match(changeSection(h).textContent, new RegExp(label));
    assert.match(changeSection(h).textContent, /调整并保存草稿/);
    assert.ok(h.button('查看原申请')); assert.equal(h.button('提交审批').disabled, true);
    assert.equal(h.button('调整会员政策').disabled, false);
    const next = { ...state, policy: { ...state.policy, version: 'b2' }, draftReference: contextDraftRef({ id: 'draft-2', version: 'b2', payloadHash: 'b'.repeat(64) }), policyChange: read };
    await h.render(h.view.MembershipGrowthAdminView, { ...props, state: next });
    assert.equal(h.button('提交审批').disabled, false);
    await h.render(h.view.MembershipGrowthAdminView, { ...props, state: next, localPending: true });
    assert.equal(h.button('提交审批').disabled, true);
    assert.equal(h.button('调整会员政策').disabled, true);
  }
});


test('live polish closed requests show steps not taken while preserving completed and failed facts', async t => {
  const h = await ui(t), state = readyState();
  const completedApproval = { key: 'APPROVAL', label: '审批处理', state: 'COMPLETED', actor: { id: 'boss-completed', name: '审批人甲' }, atUtc: '2026-10-21T03:00:00.000Z' };
  const failedApproval = { ...completedApproval, state: 'FAILED', actor: { id: 'boss-failed', name: '审批人乙' } };
  const cases = [
    { status: 'EXPIRED', steps: null, expectedApproval: '未审批' },
    { status: 'CANCELLED', steps: [...contextSteps('PENDING'), { key: 'EXECUTION', label: '执行发布', state: 'UNKNOWN' }, { key: 'EFFECTIVE', label: '生效', state: 'PENDING' }], expectedApproval: '未审批' },
    { status: 'EXPIRED', steps: [contextSteps('PENDING')[0], completedApproval], expectedApproval: '已完成', actor: '审批人甲' },
    { status: 'CANCELLED', steps: [contextSteps('PENDING')[0], failedApproval], expectedApproval: '未通过', actor: '审批人乙' },
  ];
  for (const [index, example] of cases.entries()) {
    await h.render(h.view.MembershipGrowthAdminView, { state: { ...state, policyChange: contextChange({ immutableDiff: null, request: contextRequest({ id: 'closed-step-' + index, approvalStatus: example.status, steps: example.steps }) }) }, onOpenPath: () => {} });
    await h.click(h.button('查看变更详情'));
    const dialog = h.browser.document.querySelector('[data-slot=dialog-content]'); assert.ok(dialog);
    const flow = dialog.querySelector('section[aria-label="流程摘要"]'); assert.ok(flow);
    const step = label => [...flow.querySelectorAll('li')].find(item => item.querySelector('p')?.textContent.startsWith(label));
    assert.ok(step('审批处理')); assert.ok(step('执行发布')); assert.ok(step('生效'));
    assert.equal(step('审批处理').querySelector('p span').textContent, example.expectedApproval, example.status);
    assert.equal(step('执行发布').querySelector('p span').textContent, '未执行', example.status);
    assert.equal(step('生效').querySelector('p span').textContent, '未生效', example.status);
    assert.doesNotMatch(flow.textContent, /状态未知|待处理/, 'closed request steps cannot imply future work');
    assert.match(flow.textContent, /已提交已完成/);
    if (example.actor) {
      assert.match(step('审批处理').textContent, new RegExp(example.actor));
      assert.match(step('审批处理').textContent, /2026年10月21日 11:00/);
      assert.doesNotMatch(step('审批处理').textContent, /未审批|经手人未取得/);
    } else assert.doesNotMatch(step('审批处理').textContent, /审批人甲|审批人乙/);
    await h.click([...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === '关闭'));
  }
  assert.equal(h.fetches.length, 0);
});
