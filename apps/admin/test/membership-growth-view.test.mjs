import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
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
  const view=await vite.ssrLoadModule('/src/views/membership-growth-view.tsx'),form=await vite.ssrLoadModule('/src/views/membership-entitlement-form.tsx');
  const host=browser.document.createElement('div');browser.document.body.append(host);
  const {createRoot}=await import('react-dom/client'),root=createRoot(host);
  t.after(async()=>{await act(async()=>root.unmount());await vite.close();await browser.happyDOM.abort();globalThis.fetch=previousFetch;});
  const render=async(component,props)=>{await act(async()=>root.render(createElement(component,props)));};
  const input=label=>{const element=host.querySelector(`input[aria-label='${label}']`);assert.ok(element,`missing ${label}`);return element;};
  const type=async(element,value)=>{await act(async()=>{const prototype=element.tagName==='TEXTAREA'?browser.HTMLTextAreaElement.prototype:browser.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new browser.Event('input',{bubbles:true}));element.dispatchEvent(new browser.Event('change',{bubbles:true}));});};
  const click=async element=>{assert.ok(element);await act(async()=>element.click());};
  const button=text=>[...host.querySelectorAll('button')].find(element=>element.textContent.trim()===text);
  return{browser,host,root,view,form,render,input,type,click,button,fetches};
}
const discount=(mode,ratio='0.9')=>({status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode,priceVersionId:'price-v1',payableRatio:ratio,costBasisRef:'cost-v1'});
const range=(mode,min='0.6',max='1')=>({status:'CONFIGURED',kind:'TOTAL_DISCOUNT_RANGE',mode,priceVersionId:'price-v1',minPayableRatio:min,maxPayableRatio:max,costBasisRef:'cost-ent'});
function readyState(){
  const shares=['0.95','0.90','0.88','0.86','0.84'];
  return{status:'ready',policy:{version:'b1',status:'DRAFT',effectiveAt:'2026-11-01T00:00:00.000Z',catalog:{safeBoxes:[],materials:[],priceVersions:[{id:'price-v1',label:'当前价格方案'}],enabledModes:['ordinary','custom'],catalogSource:'SEALED'},selectedSafeBoxCode:'',selectedMaterialId:'',tiers:['STANDARD','SILVER','GOLD','PLATINUM','DIAMOND'].map((tier,index)=>({tier,threshold:String(index*5000),tenantDeposit:index<2?'ACCOUNT_BASE':'WAIVED',ordinary:discount('ordinary',shares[index]),custom:discount('custom',shares[index]),fast:{status:'NOT_PRICED',reason:'未启用'},maxEntitlement:{status:'NOT_PRICED',reason:'旧合同不用于独立范围'}})),entitlementRanges:{FRIEND:{byMode:{ordinary:range('ordinary'),custom:range('custom')}},PRESTIGE:{byMode:{ordinary:range('ordinary','0.5'),custom:range('custom','0.5')}}},changes:[]},preview:{status:'NOT_RUN'},subject:{subjectId:'u',status:'UNKNOWN'},entitlement:{kind:'FRIEND',scopeKey:'game:delta',startsAtUtc:'',endsAtUtc:'',pricingMode:'ordinary',priceVersionId:'',payableRatio:'',costBasisRef:'',depositWaived:false,reason:''},approval:{status:'NOT_REQUESTED'}};
}

test('policy view separates independent ranges from growth shares and respects Boss-only editing',async t=>{
  const h=await ui(t),state=readyState(),changed=[],saves=[],submitted=[];
  const props={state,canEditEntitlementRanges:true,onPolicyChange:policy=>changed.push(policy),onSavePolicyDraft:()=>saves.push(true),onSubmitPolicy:()=>submitted.push(true)};
  await h.render(h.view.MembershipGrowthAdminView,props);
  assert.match(h.host.textContent,/会员政策/);assert.match(h.host.textContent,/成长等级权益/);assert.match(h.host.textContent,/礼遇折扣范围/);
  assert.doesNotMatch(h.host.textContent,/报价预览|用户成长依据|人工礼遇申请|审批与实际生效|金卡上限|钻石上限/);
  assert.equal(h.host.querySelector('select,textarea,input[type=datetime-local]'),null,'use house controls and a Calendar date picker');
  assert.ok(h.host.querySelector('button[aria-label="政策生效日期"]'));assert.ok(h.input('政策生效时间'));
  assert.equal(h.view.validateAdminPolicyDraft(state.policy,['ordinary','custom']).publishable,true,'independent ranges may legitimately be deeper than growth-tier discounts');
  await h.type(h.input('SILVERordinary应付比例'),'0.92');
  assert.equal(changed.at(-1).tiers[1].ordinary.payableRatio,'0.92');
  assert.deepEqual(changed.at(-1).entitlementRanges,state.policy.entitlementRanges);
  await h.type(h.input('FRIENDordinary最小应付比例'),'0.55');
  assert.equal(changed.at(-1).entitlementRanges.FRIEND.byMode.ordinary.minPayableRatio,'0.55');
  assert.deepEqual(changed.at(-1).tiers.map(tier=>tier.maxEntitlement),state.policy.tiers.map(tier=>tier.maxEntitlement),'no tier cap seeding or mutation');
  assert.equal(h.button('提交审批').disabled,true,'unsaved policy edits cannot be submitted');
  await h.click(h.button('保存草稿'));assert.deepEqual(saves,[true]);
  const saved={...state,policy:{...changed.at(-1),version:'b2'}};
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:saved});
  assert.equal(h.button('提交审批').disabled,false);await h.click(h.button('提交审批'));assert.deepEqual(submitted,[true]);
  await h.render(h.view.MembershipGrowthAdminView,{...props,state:saved,canEditEntitlementRanges:false});
  assert.equal(h.input('FRIENDordinary最小应付比例').disabled,true);assert.equal(h.input('SILVERordinary应付比例').disabled,false);
  assert.match(h.host.textContent,/仅 Boss 可修改/);
  await h.render(h.view.MembershipGrowthAdminView,{state:{status:'loading'}});assert.ok(h.host.querySelector('[role=status]'));
  await h.render(h.view.MembershipGrowthAdminView,{state:{status:'error',message:'读取失败'}});assert.match(h.host.querySelector('[role=alert]').textContent,/读取失败/);
  await h.render(h.view.MembershipGrowthAdminView,{state:{status:'permission',message:'权限已收回'}});assert.match(h.host.textContent,/没有会员政策查看权限/);
});

test('entitlement form validates independent ranges, dates, automatic references and unknown growth without network',async t=>{
  const h=await ui(t),state=readyState(),submitted=[];
  const context={schema:'membership-entitlement-context.v1',subject:{userId:'u',name:'用户甲',image:null,maskedPhone:null},game:{id:'delta',name:'三角洲'},approvedMeta:{id:'approved-1',version:'1',effectiveAtUtc:'2026-10-01T00:00:00.000Z',ruleReleaseId:'release-1',priceVersionId:'price-v1',payloadHash:'a'.repeat(64),sourceRef:'fixture'},ranges:state.policy.entitlementRanges,rangeSource:'INDEPENDENT',capability:{canRequest:true,reasonCode:'OK'},existingEntitlements:[],growth:{knowledge:'UNKNOWN'}};
  const initial={kind:'FRIEND',scopeKey:'legacy:scope',startsAtUtc:'2026-11-01T02:00:00.000Z',endsAtUtc:'2026-11-20T02:00:00.000Z',pricingMode:'ordinary',priceVersionId:'untrusted-initial',payableRatio:'0.8',costBasisRef:'untrusted-initial',depositWaived:false,reason:'用户专项礼遇'};
  const props={context,initial,onSubmit:draft=>submitted.push(draft)};
  await h.render(h.form.MembershipEntitlementForm,props);
  assert.equal(h.host.querySelector('select,input[type=datetime-local],input[aria-label="礼遇成本依据"],input[aria-label="礼遇业务范围"]'),null);
  assert.match(h.host.textContent,/独立配置/);assert.doesNotMatch(h.host.textContent,/金卡|钻石|untrusted-initial/);
  assert.equal(h.button('提交礼遇审批').disabled,false,'UNKNOWN growth is not a grant-capability gate');
  await h.type(h.input('礼遇应付比例'),'0.5');assert.match(h.host.textContent,/超出允许范围/);assert.equal(h.button('提交礼遇审批').disabled,true);
  await h.type(h.input('礼遇应付比例'),'1.000000001');assert.match(h.host.textContent,/最多8位小数/);
  await h.type(h.input('礼遇应付比例'),'0.8');
  await h.click(h.host.querySelector('button[aria-label="开始日期"]'));
  const day=[...h.browser.document.querySelectorAll('button[data-day]')].find(element=>element.textContent.trim()==='11');
  assert.ok(day,'house Calendar renders interactive days');await h.click(day);
  await h.click(h.button('提交礼遇审批'));
  assert.equal(submitted.length,1);assert.equal(submitted[0].scopeKey,'legacy:scope');assert.equal(submitted[0].priceVersionId,'price-v1');assert.equal(submitted[0].costBasisRef,'cost-ent');
  assert.equal(submitted[0].startsAtUtc,'2026-11-11T02:00:00.000Z');
  await h.render(h.form.MembershipEntitlementForm,{...props,context:{...context,rangeSource:'LEGACY_TIER_CAP'}});
  assert.match(h.host.textContent,/沿用旧政策/);assert.doesNotMatch(h.host.textContent,/独立配置/);
  await h.render(h.form.MembershipEntitlementForm,{...props,context:{...context,subject:{...context.subject,userId:'other'}},initial:undefined});
  assert.equal(h.input('礼遇应付比例').value,'','switching subject resets the old draft');assert.equal(h.button('提交礼遇审批').disabled,true);
  await h.render(h.form.MembershipEntitlementForm,{...props,context:{...context,capability:{canRequest:false,reasonCode:'FEATURE_DISABLED'}},busy:true,error:'权限发生变化'});
  assert.equal(h.button('正在提交…').disabled,true);assert.match(h.host.textContent,/礼遇功能尚未启用|权限发生变化/);
  assert.equal(h.form.beijingInputToUtc('2026-02-30T10:00'),'');assert.equal(h.form.beijingInputToUtc('2026-11-01T10:00'),'2026-11-01T02:00:00.000Z');
  assert.equal(h.form.utcToBeijingInput(null),'');assert.equal(h.form.parsePayableRatio(1),null,'a numeric JSON value is not an exact decimal-text contract');
  for(const [value,expected] of [['0.85','8.5折'],['0.85000000','8.5折'],['1','10折'],['0.00000001','0.0000001折'],['0.99999999','9.9999999折'],['0','折扣待核'],['1.01','折扣待核'],[undefined,'折扣待核']])assert.equal(h.form.formatEntitlementDiscount(value),expected);
  assert.equal(h.form.entitlementWindowError('2026-11-01T00:00:00Z','2027-01-30T00:00:00Z'),'');assert.equal(h.form.entitlementWindowError('2026-11-01T00:00:00Z','2027-01-30T00:00:00.001Z'),'礼遇单次最多90天');
  assert.equal(h.fetches.length,0);
});

test('form switches independent kind, guards duplicate submission and blocks unavailable context',async t=>{
  const h=await ui(t),state=readyState();let release;const waiting=new Promise(resolve=>{release=resolve;}),submitted=[];
  const context={schema:'membership-entitlement-context.v1',subject:{userId:'u',name:null,image:null,maskedPhone:null},game:{id:'delta',name:'三角洲'},approvedMeta:{id:'approved-1',version:'1',effectiveAtUtc:'2026-10-01T00:00:00.000Z',ruleReleaseId:'r',priceVersionId:'price-v1',payloadHash:'b'.repeat(64),sourceRef:'fixture'},ranges:state.policy.entitlementRanges,rangeSource:'INDEPENDENT',capability:{canRequest:true,reasonCode:'OK'},existingEntitlements:[]};
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
  const deposit=h.host.querySelector('[role=checkbox][aria-label="独立授予免押"]');await h.click(deposit);
  assert.equal(deposit.getAttribute('aria-checked'),'true',deposit.outerHTML);
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
test("empty policy bootstrap, discount gating and cap seeding stay honest", async () => {
  const vite = await createServer({ configFile: false, root: rootPath, plugins: [react()], resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { bootstrapGrowthPolicy, validateAdminPolicyDraft, entitlementFromCap, capStatusSummary, completeEntitlementCaps } = await vite.ssrLoadModule("/src/views/membership-growth-view.tsx");
    const catalog = { safeBoxes: [], materials: [], priceVersions: [{ id: "price-v1", label: "price-v1" }], enabledModes: ["ordinary", "custom"], haffSchema: "haff-ratio-v2", releaseMode: "SPREAD" };
    const policy = bootstrapGrowthPolicy(catalog, { STANDARD: "0", SILVER: "5000", GOLD: "10000", PLATINUM: "20000", DIAMOND: "40000" }, 1);
    assert.equal(policy.version, "1");
    assert.equal(policy.status, "DRAFT");
    assert.deepEqual(policy.tiers.map((tier) => tier.tenantDeposit), ["ACCOUNT_BASE", "ACCOUNT_BASE", "WAIVED", "WAIVED", "WAIVED"]);
    assert.equal(policy.tiers.every((tier) => tier.ordinary.status === "NOT_PRICED" && tier.maxEntitlement.status === "NOT_PRICED"), true);
    assert.deepEqual(policy.entitlementRanges,{FRIEND:{byMode:{}},PRESTIGE:{byMode:{}}});
    delete policy.entitlementRanges; // Explicitly exercise legacy helpers; the new UI never calls tier-cap seeding.
    // First draft is savable but not publishable; disabled modes never warn.
    const first = validateAdminPolicyDraft(policy, ["ordinary", "custom"]);
    assert.deepEqual(first.errors, []);
    assert.equal(first.publishable, false);
    assert.ok(first.warnings.every((warning) => !warning.includes(".fast")));
    // Enabled modes need explicit shares; unknown values stay pending, invalid values are errors.
    const enabled = structuredClone(policy);
    enabled.effectiveAt = "2026-11-01T00:00:00.000Z";
    const shares = ["0.95", "0.92", "0.90", "0.88", "0.85"];
    for (const [index, tier] of enabled.tiers.entries()) {
      for (const mode of ["ordinary", "custom"]) {
        tier[mode] = { status: "CONFIGURED", kind: "TOTAL_DISCOUNT", mode, priceVersionId: "price-v1", payableRatio: shares[index], costBasisRef: `cost-${tier.tier}` };
      }
    }
    const capsPending = validateAdminPolicyDraft(enabled, ["ordinary", "custom"]);
    assert.deepEqual(capsPending.errors, []);
    assert.equal(capsPending.publishable, false);
    assert.ok(capsPending.warnings.some((warning) => warning.includes("礼遇上限")));
    // A tightened cap survives the explicit completion action; missing entries are seeded from the tier share.
    const tightened = structuredClone(enabled);
    tightened.tiers[2].maxEntitlement = { byMode: { ordinary: { ...tightened.tiers[2].ordinary, payableRatio: "0.95" } } };
    const completed = completeEntitlementCaps(tightened, ["ordinary", "custom"]);
    assert.equal(completed.tiers[2].maxEntitlement.byMode.ordinary.payableRatio, "0.95");
    assert.equal(completed.tiers[2].maxEntitlement.byMode.custom.payableRatio, "0.90");
    assert.equal(completed.tiers[0].maxEntitlement.byMode.ordinary.payableRatio, "0.95");
    const ready = validateAdminPolicyDraft(completeEntitlementCaps(enabled, ["ordinary", "custom"]), ["ordinary", "custom"]);
    assert.deepEqual(ready.errors, []);
    assert.equal(ready.publishable, true, JSON.stringify(ready));
    // Non-monotonic tiers and invalid shares must never publish.
    const inverted = structuredClone(enabled);
    inverted.tiers[1].ordinary = { ...inverted.tiers[1].ordinary, payableRatio: "0.99" };
    const invertedResult = validateAdminPolicyDraft(completeEntitlementCaps(inverted, ["ordinary", "custom"]), ["ordinary", "custom"]);
    assert.equal(invertedResult.publishable, false);
    assert.ok(invertedResult.errors.some((error) => error.includes("高档应付比例不得高于低档")));
    const invalid = structuredClone(enabled);
    invalid.tiers[0].ordinary = { ...invalid.tiers[0].ordinary, payableRatio: "1.5" };
    assert.equal(validateAdminPolicyDraft(completeEntitlementCaps(invalid, ["ordinary", "custom"]), ["ordinary", "custom"]).errors.some((error) => error.includes("0–1")), true);
    // A cap deeper than its tier stays a publish blocker, not silently accepted.
    const deepCap = structuredClone(enabled);
    deepCap.tiers[2].maxEntitlement = { byMode: { ordinary: { ...deepCap.tiers[2].ordinary, payableRatio: "0.80" }, custom: { ...deepCap.tiers[2].custom } } };
    const deepResult = validateAdminPolicyDraft(deepCap, ["ordinary", "custom"]);
    assert.equal(deepResult.publishable, false);
    assert.ok(deepResult.warnings.some((warning) => warning.includes("礼遇上限深于该成长档")));
    // R2-04 sequence 1: tier tightened to 0.91 while the old cap (0.90) is now deeper — the repair action fixes it.
    const staleCap = structuredClone(enabled);
    staleCap.tiers[2].ordinary = { ...staleCap.tiers[2].ordinary, payableRatio: "0.91" };
    staleCap.tiers[2].custom = { ...staleCap.tiers[2].custom, payableRatio: "0.91" };
    staleCap.tiers[2].maxEntitlement = { byMode: { ordinary: { ...staleCap.tiers[2].ordinary, payableRatio: "0.90" }, custom: { ...staleCap.tiers[2].custom, payableRatio: "0.90" } } };
    const staleBlocked = validateAdminPolicyDraft(staleCap, ["ordinary", "custom"]);
    assert.equal(staleBlocked.publishable, false);
    const staleRepaired = completeEntitlementCaps(staleCap, ["ordinary", "custom"]);
    assert.equal(staleRepaired.tiers[2].maxEntitlement.byMode.ordinary.payableRatio, "0.91");
    assert.equal(validateAdminPolicyDraft(staleRepaired, ["ordinary", "custom"]).publishable, true);
    // R2-04 sequence 2: caps seeded while the tier cost facts were still empty stay a blocker until repaired.
    const pendingCosts = structuredClone(enabled);
    const blankCost = (contract) => ({ ...contract, costBasisRef: "" });
    pendingCosts.tiers[2].ordinary = blankCost(pendingCosts.tiers[2].ordinary);
    pendingCosts.tiers[2].custom = blankCost(pendingCosts.tiers[2].custom);
    pendingCosts.tiers[2].maxEntitlement = { byMode: { ordinary: { ...pendingCosts.tiers[2].ordinary, payableRatio: "0.93", costBasisRef: "" }, custom: blankCost(pendingCosts.tiers[2].custom) } };
    const missingCost = validateAdminPolicyDraft(pendingCosts, ["ordinary", "custom"]);
    assert.equal(missingCost.publishable, false);
    assert.ok(missingCost.warnings.some((warning) => warning.includes("待补 成本依据")));
    assert.equal(missingCost.errors.length, 0);
    // Filling the tier cost lets the same explicit action repair only the missing cap cost and keep the tightened share.
    const filledCosts = structuredClone(pendingCosts);
    filledCosts.tiers[2].ordinary = { ...filledCosts.tiers[2].ordinary, costBasisRef: "cost-GOLD" };
    filledCosts.tiers[2].custom = { ...filledCosts.tiers[2].custom, costBasisRef: "cost-GOLD" };
    const repairedCaps = completeEntitlementCaps(filledCosts, ["ordinary", "custom"]);
    assert.equal(repairedCaps.tiers[2].maxEntitlement.byMode.ordinary.payableRatio, "0.93");
    assert.equal(repairedCaps.tiers[2].maxEntitlement.byMode.ordinary.costBasisRef, "cost-GOLD");
    assert.equal(repairedCaps.tiers[2].maxEntitlement.byMode.custom.costBasisRef, "cost-GOLD");
    assert.equal(validateAdminPolicyDraft(repairedCaps, ["ordinary", "custom"]).publishable, true);
    // A missing price version is an error, and the repair action restores it from the tier contract.
    const missingVersion = structuredClone(enabled);
    missingVersion.tiers[2].maxEntitlement = { byMode: { ordinary: { ...missingVersion.tiers[2].ordinary, priceVersionId: "" }, custom: { ...missingVersion.tiers[2].custom } } };
    const versionResult = validateAdminPolicyDraft(missingVersion, ["ordinary", "custom"]);
    assert.equal(versionResult.publishable, false);
    assert.ok(versionResult.errors.some((error) => error.includes("缺少价格版本")));
    assert.equal(completeEntitlementCaps(missingVersion, ["ordinary", "custom"]).tiers[2].maxEntitlement.byMode.ordinary.priceVersionId, "price-v1");
    // Entitlement seeding keeps the cap share and its own cost basis.
    const seededSource = completeEntitlementCaps(enabled, ["ordinary", "custom"]);
    const seeded = entitlementFromCap(seededSource, "FRIEND", "ordinary", "2026-10-10T02:00:00.000Z", "2026-10-20T02:00:00.000Z");
    assert.equal(seeded.priceVersionId, "price-v1");
    assert.equal(seeded.payableRatio, "0.90");
    assert.equal(seeded.costBasisRef, "cost-GOLD");
    assert.equal(capStatusSummary(seededSource.tiers[2].maxEntitlement, ["ordinary", "custom"]), "礼遇上限 普通/自定义 已配置");
    assert.equal(capStatusSummary({ status: "NOT_PRICED", reason: "待核" }, ["ordinary"]), "礼遇上限未配置");
  } finally { await vite.close(); }
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
