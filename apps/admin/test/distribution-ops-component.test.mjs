import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act,createElement,StrictMode } from 'react';
import { setup,snap,known,flat,context,operations,json,settle,input,click,manager } from './distribution-ops-fixture.mjs';
const button=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent.includes(text));

test('effective legacy policy shows current names and separate purchase/listing rates and submits only an explicit state change',async()=>{
 const h=await setup();try{
  const config={...known.policy.config,schema:'distribution-policy.v3',enabled:true,levels:[{code:'legacy_1',rank:1,default:true,renterPercent:'20',ownerPercent:'30',upgrade:null}],legacySource:{receiptSha256:'a'.repeat(64),configurationSha256:'b'.repeat(64),levelsSha256:'c'.repeat(64),levelNames:{legacy_1:'青铜会员'}}};
  const response={...known,policy:{...known.policy,config},changeContext:{...context,settlementDelayChangeSupported:true}};
  globalThis.fetch=h.browser.fetch=async url=>json(String(url).endsWith('/operations')?operations:response);
  const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),model=await h.loader.ssrLoadModule('/src/views/distribution-policy-model.ts');
  const ui=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager)});
  await click(button(ui.host,'当前按分销档位计佣'));
  assert.match(ui.host.textContent,/青铜会员.*20%.*30%/);
  await click(button(ui.host,'申请调整计佣规则'));
  assert.match(h.browser.document.querySelector('[aria-label="申请后的分销状态"]').textContent,/开启新计佣/);
  assert.equal(h.browser.document.querySelector('[aria-label="推荐租客奖励比例"]'),null);
  assert.deepEqual(model.buildDistributionPolicyPayload(response.policy,{enabled:false,renter:'',owner:'',reason:'暂停新增计佣'}).changes,{enabled:false});
  const delay=h.browser.document.querySelector('[aria-label="分销佣金等待天数"]');assert.equal(delay.value,'7');assert.equal(delay.disabled,false);
  await input(h.browser,delay,'14');await input(h.browser,h.browser.document.querySelector('[aria-label="分销政策变更原因"]'),'调整佣金入账时间');
  assert.match(h.browser.document.body.textContent,/结算后等待入账：14 天/);
  assert.deepEqual(model.buildDistributionPolicyPayload(response.policy,{enabled:true,renter:'',owner:'',reason:'调整佣金入账时间',settlementDelayDays:'14'}).changes,{settlementDelayDays:14});
  for(const value of ['-1','1.5','1000000','01'])assert.throws(()=>model.buildDistributionPolicyPayload(response.policy,{enabled:true,renter:'',owner:'',reason:'调整佣金入账时间',settlementDelayDays:value}));
 }finally{await h.close();}
});

test('compact policy summary keeps calculation rules without repeating the level table or an unavailable approval banner',async()=>{
 const h=await setup();try{
  const config={...known.policy.config,schema:'distribution-policy.v3',enabled:true,levels:[{code:'legacy_1',rank:1,default:true,renterPercent:'20',ownerPercent:'30',upgrade:null}],legacySource:{receiptSha256:'a'.repeat(64),configurationSha256:'b'.repeat(64),levelsSha256:'c'.repeat(64),levelNames:{legacy_1:'青铜会员'}}};
  globalThis.fetch=h.browser.fetch=async url=>json(String(url).endsWith('/operations')?operations:{...known,policy:{...known.policy,config},changeContext:{...context,writeAssemblyReady:false}});
  const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),ui=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager),compact:true});
  assert.match(ui.host.textContent,/计佣规则/);assert.match(ui.host.textContent,/计佣口径/);assert.match(ui.host.textContent,/待入账期/);
  assert.doesNotMatch(ui.host.textContent,/当前按分销档位计佣|政策提审与执行能力待接入|青铜会员/);
 }finally{await h.close();}
});

test('historical qualification, grade and mapped children do not become current policy admission or zero',async()=>{
 const h=await setup();try{const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-model.ts');
  const p={eligibility:'UNKNOWN',levelCode:null,legacyQualification:{eligibility:'ELIGIBLE',commissionFrozen:false,levelId:'2'}};
  assert.equal(m.participantEligibilityLabel(p),'原资格有效 · 当前计佣待核');assert.equal(m.participantLevelLabel(p),'原分销档位 ID 2');
  assert.equal(m.participantEligibilityLabel({eligibility:'ELIGIBLE',frozen:null}),'计佣状态待核');assert.equal(m.participantEligibilityLabel({eligibility:'ELIGIBLE',frozen:true}),'已冻结');
  assert.equal(m.participantChildrenLabel(null,164),'已接入 164 · 总数待核');assert.equal(m.participantChildrenLabel(0,0),'0');assert.equal(m.money(null),'未核定');
 }finally{await h.close();}
});

test('unknown freeze state never presents an eligible participant as actively earning',async()=>{
 const h=await setup(),oldFetch=globalThis.fetch;try{
  const participant={userId:'user_1',name:'测试分销商',eligibility:'ELIGIBLE',frozen:null,levelCode:'silver',sourceType:'NATIVE',inviterChildren:0,leaderChildren:0,settledCents:'0',pendingCents:'0',recoveryCents:'0',mappedRecordCount:'0'};
  globalThis.fetch=h.browser.fetch=async()=>json({items:[participant],total:'1',page:1,pageSize:20,hasMore:false,snapshot:null,scope:{network:'AVAILABLE'}});
  const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx'),ui=await h.mount(m.DistributionParticipantsPage,{snapshot:snap([], 'boss','session',true),onOpenPath(){}});
  for(const root of [ui.host.querySelector('table'),ui.host.querySelector('ul')]){assert.match(root.textContent,/计佣状态待核/);assert.match(root.textContent,/查看资格/);assert.doesNotMatch(root.textContent,/参与中|冻结资格/);}
 }finally{globalThis.fetch=oldFetch;await h.close();}
});

test('participant desktop and mobile retain observed relations, commission subtotal and unknown coverage',async()=>{
 const h=await setup();try{
  const participant={userId:'historical_subject',name:'历史分销商',eligibility:'UNKNOWN',frozen:false,levelCode:null,sourceType:'LEGACY_MYSQL',leaderChildren:null,inviterChildren:null,mappedLeaderChildren:2,mappedInviterChildren:164,contributorChildren:null,mappedContributorChildren:6,settledCents:'398183',pendingCents:null,recoveryCents:null,mappedRecordCount:'959',earningsCoverage:'UNKNOWN',needsReviewCount:'1',needsReviewCents:'100',legacyQualification:{eligibility:'ELIGIBLE',commissionFrozen:false,levelId:'2'}};
  globalThis.fetch=h.browser.fetch=async()=>json({items:[participant],total:'1',page:1,pageSize:20,hasMore:false,snapshot:null,scope:{network:'AVAILABLE'}});
  const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx'),ui=await h.mount(m.DistributionParticipantsPage,{snapshot:snap([], 'boss', 'session', true),onOpenPath(){}});
  for(const root of [ui.host.querySelector('table'),ui.host.querySelector('ul')]){assert(root);assert.match(root.textContent,/原资格有效 · 当前计佣待核/);assert.match(root.textContent,/产生佣金人数/);assert.match(root.textContent,/邀请人数/);assert.match(root.textContent,/已确认 6 · 总数待核/);assert.doesNotMatch(root.textContent,/计佣下级|邀请注册/);assert.doesNotMatch(root.textContent,/直属计佣/);assert.doesNotMatch(root.textContent,/注册邀请/);assert.match(root.textContent,/已接入 164 · 总数待核/);assert.match(root.textContent,/¥3,981.83/);assert.match(root.textContent,/未核定/);assert.match(root.textContent,/待核对\s*1 笔/);assert.match(root.textContent,/原分销档位 ID 2/);assert.doesNotMatch(root.textContent,/¥0.00/);}
 }finally{await h.close();}
});

test('participant list exposes direct row actions on desktop and mobile with a scoped editor',async()=>{
 const h=await setup(),oldFetch=globalThis.fetch;try{
  const participant={userId:'user_1',name:'测试分销商',eligibility:'ELIGIBLE',frozen:false,levelCode:'silver',levelName:'白银会员',sourceType:'NATIVE',inviterChildren:0,leaderChildren:0,settledCents:'0',pendingCents:'0',recoveryCents:'0',mappedRecordCount:'0'};
  globalThis.fetch=h.browser.fetch=async url=>String(url).includes('/manage/participants')?json({items:[{...participant,revision:'1',inviteCode:'CODE1',inviteCodeId:'code_1'}],total:'1',page:1,hasMore:false,writeAssemblyReady:true,freezeWriteReady:true,policy:{versionId:'policy_1',revision:'1',schema:'distribution-policy.v4',levels:[{code:'silver',name:'白银会员'}]}}):json({items:[participant],total:'1',page:1,pageSize:20,hasMore:false,snapshot:null,scope:{network:'AVAILABLE'}});
  const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx'),ui=await h.mount(m.DistributionParticipantsPage,{snapshot:snap([], 'boss','session',true),onOpenPath(){}});
  for(const root of [ui.host.querySelector('table'),ui.host.querySelector('ul')]){assert.match(root.textContent,/详情/);assert.match(root.textContent,/调整等级/);assert.match(root.textContent,/修改邀请码/);assert.match(root.textContent,/冻结资格/);}
  await click([...ui.host.querySelectorAll('table button')].find(b=>b.textContent==='调整等级'));
  const dialog=h.browser.document.querySelector('[role="dialog"]');assert.ok(dialog);assert.match(dialog.textContent,/调整分销等级/);assert.match(dialog.textContent,/测试分销商/);
  assert.match(dialog.querySelector('[aria-label="选择分销等级"]').textContent,/白银会员/);assert.equal(dialog.querySelector('[aria-label="搜索参与人"]'),null);
  await act(async()=>ui.root.render(createElement(m.DistributionParticipantsPage,{snapshot:snap(['distribution.dashboard.read']),onOpenPath(){}})));await settle();
  assert.equal(h.browser.document.querySelector('[role="dialog"]'),null);assert.doesNotMatch(ui.host.querySelector('table').textContent,/调整等级|修改邀请码|冻结资格/);
 }finally{globalThis.fetch=oldFetch;await h.close();}
});

test('exact cents, zero, uniform parsing and proposal identity do not invent grade fallback',async()=>{
 const h=await setup();try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-model.ts');
  assert.equal(m.distributionCentsLabel('9007199254740993'),'¥90,071,992,547,409.93');assert.equal(m.distributionCentsLabel('0'),'¥0.00');assert.equal(m.distributionCentsLabel(null),'未知');
  assert.equal(m.parseDistributionPolicyRead(flat).policy.config.rateMode,'UNIFORM');
  assert.throws(()=>m.parseDistributionPolicyRead({...flat,changeContext:{...context,request:{requestId:'unexpected'}}}));
  assert.throws(()=>m.parseDistributionPolicyRead({...flat,policy:{...flat.policy,config:{...flat.policy.config,enabled:'false'}}}));
  const p=m.buildDistributionPolicyPayload(known.policy,{enabled:false,renter:'3.00',owner:'2',reason:'统一新方案'});assert.deepEqual(p.changes,{renterPercent:'3',ownerPercent:'2'});assert.equal(p.expectedPolicyDigest,'d'.repeat(64));
  for(const value of ['', '-1','1e2','0.123456789','100.00000001'])assert.throws(()=>m.buildDistributionPolicyPayload(known.policy,{enabled:false,renter:value,owner:'2',reason:'统一新方案'}));
  assert.throws(()=>m.buildDistributionPolicyPayload(known.policy,{enabled:false,renter:'99',owner:'2',reason:'统一新方案'}));
  assert(m.sameDistributionProposal({...p,changes:{ownerPercent:'2',renterPercent:'3'}},p));assert(!m.sameDistributionProposal({...p,expectedRevision:'4'},p));
 }finally{await h.close();}
});

test('old graded policy requires explicitly entered rates and cancel does not send a write',async()=>{
 const h=await setup(),calls=[];globalThis.fetch=h.browser.fetch=async(url,init={})=>{calls.push({url:String(url),method:init.method??'GET'});return json(String(url).endsWith('/operations')?operations:{...known,changeContext:context});};
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager)});await click(button(v.host,'申请调整政策'));
  const fields=h.browser.document.querySelectorAll('[aria-label$="奖励比例"]');assert.equal(fields.length,2);assert.equal(fields[0].value,'');assert.equal(fields[1].value,'');assert.equal(button(h.browser.document,'提交Boss审批').disabled,true);
  await click(button(h.browser.document,'取消修改'));await click(button(h.browser.document,'放弃修改'));assert.equal(h.browser.document.querySelector('[aria-label="推荐租客奖励比例"]'),null);assert(calls.every(c=>c.method==='GET'));
 }finally{await h.close();}
});

async function fillProposal(h,root){await click(button(root,'申请调整政策'));await input(h.browser,h.browser.document.querySelector('[aria-label="推荐租客奖励比例"]'),'4');await input(h.browser,h.browser.document.querySelector('[aria-label="推荐号主奖励比例"]'),'2');await input(h.browser,h.browser.document.querySelector('[aria-label="分销政策变更原因"]'),'核对后统一比例');}

test('unverified accepted id or wrong detail preserves original key/body and keeps original request reachable',async()=>{
 const h=await setup(),posts=[],opened=[];let accepted=false;
 globalThis.fetch=h.browser.fetch=async(url,init={})=>{const path=String(url);if(init.method==='POST'){posts.push({key:init.headers['idempotency-key'],body:JSON.parse(init.body)});accepted=true;return json({approvalRequestId:'approval_1'});}if(path.endsWith('/operations'))return json(operations);if(path.includes('/requests/detail'))return json({requestId:'approval_1',operation:{code:'membership.benefit.policy.publish',payload:{}}});return json(accepted?{...flat,changeContext:{...context,state:'PENDING',request:{requestId:'approval_1',status:'PENDING',requestedBy:'ops_1',requesterName:'运营甲',createdAt:'2026-10-26T08:00:00.000Z'}}}:flat);};
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),p=await h.loader.ssrLoadModule('/src/views/approval/pending-writes.ts'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager),onOpenPath:path=>opened.push(path)});await fillProposal(h,v.host);await click(button(h.browser.document,'提交Boss审批'));await settle();assert.equal(posts.length,1);
  const pending=p.inspectPending(p.pendingWriteSubject('ops_1','session_1','','approval.request.create'));assert.equal(pending.state,'valid');assert.deepEqual(pending.record.body,posts[0].body);assert.equal(pending.record.idempotencyKey,posts[0].key);assert.match(v.host.textContent,/原请求记录保留/);assert.equal(button(v.host,'申请调整政策').disabled,true);
  await click(button(v.host,'查看原申请'));assert.match(opened[0],/requestId=approval_1/);assert(posts.every(p=>p.body.operationCode==='distribution.policy.publish'));
 }finally{await h.close();}
});

test('verified create/detail resolves only its matching original proposal, then shows server pending context',async()=>{
 const h=await setup(),posts=[];let accepted=false;
 globalThis.fetch=h.browser.fetch=async(url,init={})=>{const path=String(url);if(init.method==='POST'){posts.push(JSON.parse(init.body));accepted=true;return json({approvalRequestId:'approval_1'});}if(path.endsWith('/operations'))return json(operations);if(path.includes('/requests/detail'))return json({requestId:'approval_1',operation:{code:'distribution.policy.publish',payload:posts[0].payload}});return json(accepted?{...flat,changeContext:{...context,state:'PENDING',request:{requestId:'approval_1',status:'PENDING',requestedBy:'ops_1',requesterName:'运营甲',createdAt:'2026-10-26T08:00:00.000Z'}}}:flat);};
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),p=await h.loader.ssrLoadModule('/src/views/approval/pending-writes.ts'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager)});await fillProposal(h,v.host);await click(button(h.browser.document,'提交Boss审批'));await settle();assert.equal(posts.length,1);assert.equal(p.inspectPending(p.pendingWriteSubject('ops_1','session_1','','approval.request.create')).state,'absent');assert.match(v.host.textContent,/运营甲|等待Boss审批/);assert.equal(button(v.host,'申请调整政策').disabled,true);assert.doesNotMatch(v.host.textContent,/已生效|已入账/);
 }finally{await h.close();}
});

test('late old actor POST cannot reload or replace the new actor draft; original UNKNOWN survives',async()=>{
 const h=await setup(),calls=[];let resolvePost;
 globalThis.fetch=h.browser.fetch=(url,init={})=>{calls.push({url:String(url),method:init.method??'GET',body:init.body});if(init.method==='POST')return new Promise(r=>{resolvePost=r;});return Promise.resolve(json(String(url).endsWith('/operations')?operations:flat));};
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),p=await h.loader.ssrLoadModule('/src/views/approval/pending-writes.ts'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager)});await fillProposal(h,v.host);await click(button(h.browser.document,'提交Boss审批'));const original=p.inspectPending(p.pendingWriteSubject('ops_1','session_1','','approval.request.create'));assert.equal(original.state,'valid');
  await act(async()=>v.root.render(createElement(m.DistributionPolicyPanel,{snapshot:snap(manager,'ops_2','session_2')})));await settle();await fillProposal(h,v.host);await input(h.browser,h.browser.document.querySelector('[aria-label="分销政策变更原因"]'),'新身份保留输入');const count=calls.length;
  await act(async()=>resolvePost(json({approvalRequestId:'approval_old'})));await settle();assert.equal(calls.length,count);assert.equal(h.browser.document.querySelector('[aria-label="分销政策变更原因"]').value,'新身份保留输入');assert.doesNotMatch(v.host.textContent,/approval_old/);assert.deepEqual(p.inspectPending(original.record.subject).record.body,original.record.body);assert.equal(p.inspectPending(original.record.subject).record.idempotencyKey,original.record.idempotencyKey);
 }finally{await h.close();}
});

test('commission states distinguish source, due date, local funds and channel arrival',async()=>{
 const h=await setup();try{const m=await h.loader.ssrLoadModule('/src/views/distribution-workspace.tsx');const settledNative=m.distributionState({origin:'NATIVE',state:'SETTLED',fundsDisposition:'SETTLED'});
  const settledLegacy=m.distributionState({origin:'LEGACY_MYSQL',state:'SETTLED',fundsDisposition:'HISTORICAL_STATUS_ONLY'});
   assert.equal(settledNative,'已结算');assert.equal(settledLegacy,'已结算');
   assert.equal(m.distributionState({origin:'LEGACY_MYSQL',state:'PENDING',fundsDisposition:'HISTORICAL_STATUS_ONLY'}),'状态待确认');
  assert.doesNotMatch(settledNative,/转入可用|已入账|已到账/);
  assert.equal(m.distributionState({origin:'NATIVE',state:'FUTURE',fundsDisposition:'UNKNOWN'}),'状态暂不识别，请刷新后核对');
  assert.throws(()=>m.parseDistributionOrder({schema:'admin-distribution-order.v1',knowledge:'KNOWN',coverage:'THIS_AUTHORIZED_ORDER_ONLY',order:{id:'order_1',origin:'NATIVE'},items:[{origin:'NATIVE',amountCents:0}],truncated:false,currentLegacyCommissions:[]}));
 }finally{await h.close();}
});

test('ambiguous public order number requires explicit source selection and never prefetches policy or each row',async()=>{
 const h=await setup(),calls=[];globalThis.fetch=h.browser.fetch=async(url,init={})=>{calls.push(String(url));if(String(url).includes('/orders?'))return json({items:[{id:'order_1',displayNo:'NO_1',source:{origin:'NATIVE'}},{id:'legacy_1',displayNo:'NO_1',source:{origin:'LEGACY'}}],total:2});return json({schema:'admin-distribution-order.v1',knowledge:'KNOWN',contextKey:'context_1',order:{id:'legacy_1',origin:'LEGACY',number:'NO_1'},items:[],truncated:false,coverage:'THIS_AUTHORIZED_ORDER_ONLY',currentLegacyCommissions:[],reasonCodes:[]});};
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-workspace.tsx'),v=await h.mount(m.DistributionWorkspace,{snapshot:snap(['order.read']),onOpenPath:()=>{}});assert.equal(calls.length,0);await input(h.browser,v.host.querySelector('[aria-label="分销原订单号"]'),'NO_1');await click(button(v.host,'查询本单佣金'));assert.equal(calls.length,1);assert.match(v.host.textContent,/多个来源匹配/);await click(button(v.host,'NO_1 · 旧平台'));assert.equal(calls.length,2);assert.match(calls[1],/distribution\/orders\/LEGACY\/legacy_1$/);assert.match(v.host.textContent,/尚无已登记佣金记录/);assert(calls.every(p=>!p.endsWith('/policy')&&!p.endsWith('/operations')));
 }finally{await h.close();}
});

test('server discovered original request id survives same actor permission loss but is hidden from another identity',async()=>{
 const h=await setup(),opened=[];globalThis.fetch=h.browser.fetch=async()=>json({...flat,changeContext:{...context,state:'PENDING',request:{requestId:'approval_original',status:'PENDING',requestedBy:'ops_9',requesterName:'运营甲',createdAt:'2026-10-26T08:00:00.000Z'}}});
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),props={snapshot:snap(['personal.distribution.policy.read']),onOpenPath:p=>opened.push(p)},v=await h.mount(m.DistributionPolicyPanel,props);assert(button(v.host,'查看原申请'));
  await act(async()=>v.root.render(createElement(m.DistributionPolicyPanel,{...props,snapshot:snap([])})));await settle();assert.match(v.host.textContent,/没有分销政策权限/);await click(button(v.host,'查看原申请'));assert.match(opened[0],/approval_original/);assert.doesNotMatch(v.host.textContent,/运营甲/);
  await act(async()=>v.root.render(createElement(m.DistributionPolicyPanel,{...props,snapshot:snap([],'other_actor','other_session')})));await settle();assert.equal(Boolean(button(v.host,'查看原申请')),false);assert.doesNotMatch(v.host.textContent,/approval_original|运营甲/);
 }finally{await h.close();}
});

test('overlapping refreshes keep only the latest policy response',async()=>{
 const h=await setup(),reads=[];let initial=true;globalThis.fetch=h.browser.fetch=()=>initial?(initial=false,Promise.resolve(json(flat))):new Promise(resolve=>reads.push(resolve));
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(['personal.distribution.policy.read'])});await click(button(v.host,'刷新政策'));await click(button(v.host,'刷新政策'));assert.equal(reads.length,2);
  const newest={...flat,policy:{...flat.policy,revision:'4',digest:'e'.repeat(64),config:{...flat.policy.config,renterPercent:'9'}}};await act(async()=>reads[1](json(newest)));await settle();assert.match(v.host.textContent,/9%/);await act(async()=>reads[0](json(flat)));await settle();assert.match(v.host.textContent,/9%/);assert.doesNotMatch(v.host.textContent,/3%/);
 }finally{await h.close();}
});

test('missing, forbidden, wrong-id and same-baseline wrong-change details never release original responsibility',async t=>{
 for(const kind of ['404','403','wrong-id','wrong-change'])await t.test(kind,async()=>{
  const h=await setup(),posts=[];globalThis.fetch=h.browser.fetch=async(url,init={})=>{const path=String(url);if(init.method==='POST'){posts.push({key:init.headers['idempotency-key'],body:JSON.parse(init.body)});return json({approvalRequestId:'approval_1'});}if(path.endsWith('/operations'))return json(operations);if(path.includes('/requests/detail')){if(kind==='404'||kind==='403')return json({error:{code:kind==='403'?'FORBIDDEN':'NOT_FOUND'}},Number(kind));const payload=structuredClone(posts[0].body.payload);if(kind==='wrong-change')payload.changes.renterPercent='8';return json({requestId:kind==='wrong-id'?'another_request':'approval_1',operation:{code:'distribution.policy.publish',payload}});}return json(flat);};
  try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),p=await h.loader.ssrLoadModule('/src/views/approval/pending-writes.ts'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:snap(manager,'actor_'+kind,'session_'+kind)});await fillProposal(h,v.host);await click(button(h.browser.document,'提交Boss审批'));await settle();assert.equal(posts.length,1);const pending=p.inspectPending(p.pendingWriteSubject('actor_'+kind,'session_'+kind,'','approval.request.create'));assert.equal(pending.state,'valid');assert.deepEqual(pending.record.body,posts[0].body);assert.equal(pending.record.idempotencyKey,posts[0].key);assert(button(v.host,'查看原申请'));assert.equal(button(v.host,'申请调整政策').disabled,true);}
  finally{await h.close();}
 });
});

test('cold remount uses GET-only recovery and preserves a pending original without generating another POST',async()=>{
 const h=await setup(),posts=[];let rejectPost;
 globalThis.fetch=h.browser.fetch=(url,init={})=>{const path=String(url);if(init.method==='POST'){posts.push({key:init.headers['idempotency-key'],body:JSON.parse(init.body)});return new Promise((_r,reject)=>{rejectPost=reject;});}if(path.endsWith('/operations'))return Promise.resolve(json(operations));if(path.includes('/recovery?'))return Promise.resolve(json({knowledge:'UNRESOLVED'}));return Promise.resolve(json(flat));};
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-panel.tsx'),p=await h.loader.ssrLoadModule('/src/views/approval/pending-writes.ts'),who=snap(manager,'cold_actor','cold_session'),v=await h.mount(m.DistributionPolicyPanel,{snapshot:who});await fillProposal(h,v.host);await click(button(h.browser.document,'提交Boss审批'));await act(async()=>rejectPost(new Error('synthetic transport loss')));await settle();const subject=p.pendingWriteSubject('cold_actor','cold_session','','approval.request.create'),before=p.inspectPending(subject);assert.equal(before.state,'valid');await act(async()=>v.root.unmount());
  const mounted=await h.mount(m.DistributionPolicyPanel,{snapshot:who});await settle();assert.equal(posts.length,1);const after=p.inspectPending(subject);assert.equal(after.state,'valid');assert.equal(after.record.idempotencyKey,before.record.idempotencyKey);assert.deepEqual(after.record.body,before.record.body);assert.match(mounted.host.textContent,/没有回执不代表未提交/);
 }finally{await h.close();}
});

test('distribution dashboard model formats exact cents and keeps source/role/state labels explicit',async()=>{
 const h=await setup();
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-model.ts');
  assert.equal(m.money('9007199254740993'),'¥90,071,992,547,409.93');
  assert.equal(m.money('0'),'¥0.00');
  assert.equal(m.dashboardMoney({knowledge:'UNKNOWN',cents:null,count:null,reasonCodes:['LEGACY_SOURCE_NOT_INSTALLED']}),'未核定');
  assert.equal(m.dashboardMoney({knowledge:'KNOWN',cents:'95',count:'1',reasonCodes:[]}),'¥0.95');
    assert.equal(m.roleLabel('OWNER_REFERRAL'),'邀请号主出租');
  assert.equal(m.sourceLabel('LEGACY'),'历史观察');
  assert.equal(m.stateLabel('RECOVERY_REQUIRED'),'待追回');
  const f=m.defaultDashboardFilters();
  assert.match(f.from,/^\d{4}-\d{2}-\d{2}$/);assert.equal(f.page,1);assert.equal(f.pageSize,20);assert.equal(f.sort,'recordCount');assert.equal(f.order,'desc');
 }finally{await h.close();}
});

test('390 宽度的佣金与分销商页面使用移动卡片保全金额、状态与身份',async()=>{const h=await setup();const previous=globalThis.fetch;try{
 const earning={id:'earning_1',source:'NATIVE',beneficiaryId:'user_1',beneficiaryName:'受益人',role:'OWNER_REFERRAL',orderId:'order_1',orderNumber:'ZZ-1',amountCents:'95',recoveryRequiredCents:null,state:'SETTLED',occurredAt:'2026-10-19T11:51:09.937Z',settledAt:'2026-10-19T11:51:41.130Z',dueAt:null,recordedAt:'2026-10-19T11:51:09.937Z',gameId:'game_1'};
 globalThis.fetch=h.browser.fetch=async(url)=>json(String(url).includes('/participants')?{items:[{userId:'user_1',name:'受益人',eligibility:'ELIGIBLE',frozen:false,levelCode:'L1',inviter:'KNOWN_NONE',leader:'KNOWN_PARENT',sourceType:'NATIVE',revision:'1',leaderChildren:1,inviterChildren:0,settledCents:'95',pendingCents:'0',recoveryCents:'0'}],total:'1',page:1,pageSize:20,hasMore:false,snapshot:null,scope:{network:'AVAILABLE'},asOf:'2026-11-02T03:00:00Z'}:{items:[earning],total:'1',page:1,pageSize:20,hasMore:false,snapshot:null,asOf:'2026-11-02T03:00:00Z',snapshotVersion:'v1',scope:{network:'AVAILABLE'}});
 const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx'),snapshot=snap([], 'boss', 'session', true);
 const earnings=await h.mount(m.DistributionEarningsPage,{snapshot,onOpenPath:()=>{}});const earningMobile=earnings.host.querySelector('ul.md\\:hidden');
 assert.ok(earningMobile?.textContent.includes('¥0.95'));assert.ok(earningMobile?.textContent.includes('已结算'));assert.ok(earningMobile?.textContent.includes('入账 2026'));
 assert.ok(earnings.host.querySelector('div.hidden.overflow-x-auto'));
 const participants=await h.mount(m.DistributionParticipantsPage,{snapshot,onOpenPath:()=>{}});const participantMobile=participants.host.querySelector('ul.md\\:hidden');
 assert.ok(participantMobile?.textContent.includes('受益人'));assert.ok(!participantMobile?.textContent.includes('user_1'));assert.ok(!participants.host.textContent.includes('本平台'));assert.ok(participants.host.querySelector('[data-distribution-participants-filters]'));assert.ok(participantMobile?.textContent.includes('¥0.95'));
 const sortBtn=[...participants.host.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='按分销单数排序');
 assert.ok(sortBtn);assert.equal(participants.host.querySelector('th[aria-sort="descending"]')?.textContent.includes('分销单数'),true);
}finally{globalThis.fetch=previous;await h.close();}});

test('participants table sort headers rewrite query sort/order and reset page',async()=>dashboardProbe(async(h,m)=>{
 const calls=[];globalThis.fetch=h.browser.fetch=async url=>{const q=new URL(String(url),'http://fixture.invalid').searchParams;calls.push(Object.fromEntries(q));return json(dashboardPage(url,{items:[{userId:'user_1',name:'受益人',eligibility:'ELIGIBLE',frozen:false,levelCode:'L1',inviter:'KNOWN_NONE',leader:'KNOWN_PARENT',sourceType:'NATIVE',revision:'1',leaderChildren:1,inviterChildren:0,settledCents:'95',pendingCents:'0',recoveryCents:'0',recordCount:'3',mappedRecordCount:'3'}],total:'1',hasMore:false}));};
 const queries=[];const ui=await h.mount(m.DistributionParticipantsPage,{snapshot:dashboardWho(),onOpenPath(){},query:{page:'2',sort:'recordCount',order:'desc'},onQueryChange:q=>queries.push(q)});
 await dashboardUntil(()=>calls.length>=1);
 assert.equal(calls[0].sort,'recordCount');assert.equal(calls[0].order,'desc');
 const settled=[...ui.host.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='按已结算排序');
 await click(settled);assert.equal(queries.at(-1).sort,'settledCents');assert.equal(queries.at(-1).order,'asc');assert.equal(queries.at(-1).page,'1');
}));

const dashboardWho=()=>snap(['distribution.dashboard.read','user.directory.read','order.read'],'dashboard-reader','dashboard-session');
const dashboardEarning={id:'earning_1',source:'NATIVE',beneficiaryId:'user_1',beneficiaryName:'PRIVATE_DIRECTORY_NAME',role:'OWNER_REFERRAL',orderId:'order_1',orderNumber:'ORDER-ONE',amountCents:'95',recoveryRequiredCents:null,state:'SETTLED',occurredAt:'2026-10-19T11:51:09Z',settledAt:'2026-10-19T11:51:41Z',dueAt:null,recordedAt:'2026-10-19T11:51:09Z',gameId:'game_1'};
const dashboardPage=(url,extra={})=>{const q=new URL(String(url),'http://fixture.invalid').searchParams;return{items:[dashboardEarning],total:'40',page:Number(q.get('page')??1),pageSize:Number(q.get('pageSize')??20),hasMore:true,snapshot:'fixture-snapshot',asOf:'2026-11-02T03:00:00Z',snapshotVersion:'fixture-v1',scope:{isBoss:false,games:'ALL_GAMES',gameIds:[],network:'AVAILABLE',reasonCodes:[]},...extra};};
const exactOrder=(id,origin='NATIVE')=>({schema:'admin-distribution-order.v1',knowledge:'KNOWN',contextKey:'fixture',order:{id,origin,number:'PUBLIC-'+id},items:[],truncated:false,coverage:'THIS_AUTHORIZED_ORDER_ONLY',currentLegacyCommissions:[],reasonCodes:[]});
const dashboardButton=(host,name)=>[...host.querySelectorAll('button')].find(b=>b.textContent.trim()===name);
async function dashboardUntil(predicate){for(let i=0;i<70;i++){if(predicate())return;await settle();}throw Error('Dashboard condition timed out');}
async function dashboardProbe(run){const h=await setup(),previous=globalThis.fetch;try{const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx');await run(h,m);}finally{globalThis.fetch=previous;await h.close();}}

test('dashboard directory permission withdrawal hides the old projection before a new read completes',async()=>dashboardProbe(async(h,m)=>{
 let calls=0,release;globalThis.fetch=h.browser.fetch=async url=>++calls===1?json(dashboardPage(url)):new Promise(resolve=>release=()=>resolve(json(dashboardPage(url,{items:[{...dashboardEarning,beneficiaryName:null}]}))));
 const props={snapshot:dashboardWho(),onOpenPath(){}};const ui=await h.mount(m.DistributionEarningsPage,props);assert.match(ui.host.textContent,/PRIVATE_DIRECTORY_NAME/);
 await act(async()=>ui.root.render(createElement(m.DistributionEarningsPage,{...props,snapshot:snap(['distribution.dashboard.read'],'dashboard-reader','dashboard-session')})));
 assert.doesNotMatch(ui.host.textContent,/PRIVATE_DIRECTORY_NAME|ORDER-ONE/);await dashboardUntil(()=>!!release);await act(async()=>release());await dashboardUntil(()=>ui.host.textContent.includes('ORDER-ONE'));assert.doesNotMatch(ui.host.textContent,/PRIVATE_DIRECTORY_NAME/);
}));
for(const boundary of ['identity','session','lock','permissions'])test(`dashboard ${boundary} boundary discards private rows and late completions`,async()=>dashboardProbe(async(h,m)=>{
 let release,calls=0;globalThis.fetch=h.browser.fetch=async url=>++calls===1?json(dashboardPage(url)):new Promise(resolve=>release=()=>resolve(json(dashboardPage(url))));
 const who=dashboardWho(),props={snapshot:who,onOpenPath(){}};const ui=await h.mount(m.DistributionEarningsPage,props);assert.match(ui.host.textContent,/ORDER-ONE/);
 const next=boundary==='identity'?{...who,adminUserId:'another-reader'}:boundary==='session'?{...who,session:{...who.session,id:'another-session'}}:boundary==='lock'?{...who,session:{...who.session,locked:true}}:{...who,permissions:[],permissionCodes:[]};
 await act(async()=>ui.root.render(createElement(m.DistributionEarningsPage,{...props,snapshot:next})));assert.doesNotMatch(ui.host.textContent,/PRIVATE_DIRECTORY_NAME|ORDER-ONE/);
 if(boundary==='lock'||boundary==='permissions'){assert.equal(calls,1);assert.match(ui.host.textContent,/没有这项分销读取权限/);}else{await dashboardUntil(()=>!!release);await act(async()=>ui.root.render(createElement(m.DistributionEarningsPage,{...props,snapshot:{...next,permissions:[],permissionCodes:[]}})));await act(async()=>release());assert.doesNotMatch(ui.host.textContent,/ORDER-ONE/);}
}));
test('dashboard failed refresh never leaves an unauthorized old result under its error',async()=>dashboardProbe(async(h,m)=>{
 let denied=false;globalThis.fetch=h.browser.fetch=async url=>denied?json({error:{code:'FORBIDDEN'}},403):json(dashboardPage(url));
 const ui=await h.mount(m.DistributionEarningsPage,{snapshot:dashboardWho(),onOpenPath(){}});denied=true;await click(dashboardButton(ui.host,'刷新'));await dashboardUntil(()=>ui.host.textContent.includes('当前身份没有'));assert.doesNotMatch(ui.host.textContent,/PRIVATE_DIRECTORY_NAME|ORDER-ONE|当前范围没有佣金记录/);
}));
test('dashboard page 409 clears the old page and reads page one with a fresh snapshot',async()=>dashboardProbe(async(h,m)=>{
 const calls=[],queries=[];let first=true;globalThis.fetch=h.browser.fetch=async url=>{const q=new URL(String(url),'http://fixture.invalid').searchParams;calls.push({page:q.get('page'),token:q.get('snapshot')});if(q.get('page')==='2')return json({error:{code:'CONFLICT'}},409);const value=dashboardPage(url,first?{}:{items:[{...dashboardEarning,orderNumber:'FRESH-PAGE-ONE'}],total:'1',hasMore:false,snapshot:'new-snapshot'});first=false;return json(value);};
 const ui=await h.mount(m.DistributionEarningsPage,{snapshot:dashboardWho(),onOpenPath(){},onQueryChange:q=>queries.push(q)});await click(dashboardButton(ui.host,'下一页'));await dashboardUntil(()=>ui.host.textContent.includes('FRESH-PAGE-ONE'));
 assert.deepEqual(calls.map(c=>c.page),['1','2','1']);assert.equal(calls[1].token,'fixture-snapshot');assert.equal(calls[2].token,null);assert.match(ui.host.textContent,/第 1 \/ 1 页/);assert.doesNotMatch(ui.host.textContent,/ORDER-ONE|第 2/);assert.equal(queries.at(-1).page,'1');
}));
test('dashboard restores every filter and gets a new first-page token before a restored later page',async()=>dashboardProbe(async(h,m)=>{
 const calls=[],queries=[];globalThis.fetch=h.browser.fetch=async url=>{const q=new URL(String(url),'http://fixture.invalid').searchParams;calls.push(Object.fromEntries(q));return json(dashboardPage(url,{total:'30',pageSize:10,hasMore:false}));};
 const query={from:'2026-10-01',to:'2026-10-19',source:'LEGACY',state:'SETTLED',role:'OWNER_REFERRAL',q:'restored',page:'3',pageSize:'10',rankingBasis:'PERIOD_SETTLED_FLOW',rankingLimit:'100'};
 const ui=await h.mount(m.DistributionEarningsPage,{snapshot:dashboardWho(),onOpenPath(){},query,onQueryChange:q=>queries.push(q)});await dashboardUntil(()=>calls.length===2);
 assert.deepEqual(calls.map(c=>c.page),['1','3']);assert.equal(calls[1].snapshot,'fixture-snapshot');for(const key of ['from','to','source','state','role','q','pageSize','rankingBasis','rankingLimit'])assert.equal(calls[1][key],query[key],key);
 assert.equal(ui.host.querySelectorAll('input[type=date]').length,0,'dates use the shared DateSelector');const date=ui.host.querySelector('button[aria-label="选择佣金发生日期"]');assert.match(date.textContent,/2026-10-01 至 2026-10-19/);const filterForm=ui.host.querySelector('[data-distribution-earnings-filters]');assert.ok(filterForm);assert.match(filterForm.className,/flex flex-col gap-3/);const search=[...ui.host.querySelectorAll('input')].find(el=>el.value==='restored');await input(h.browser,search,'restored2');assert.equal(queries.length,0,'typing alone does not refetch');await act(async()=>search.form.requestSubmit());await dashboardUntil(()=>queries.length>0);assert.equal(queries.at(-1).from,'2026-10-01');assert.equal(queries.at(-1).page,'1');assert.equal(queries.at(-1).source,'LEGACY');assert.equal(queries.at(-1).snapshot,undefined);
}));
test('dashboard external filter navigation cancels a late prior response',async()=>dashboardProbe(async(h,m)=>{
 let release;globalThis.fetch=h.browser.fetch=async url=>new URL(String(url),'http://fixture.invalid').searchParams.get('q')==='old'?new Promise(resolve=>release=()=>resolve(json(dashboardPage(url,{items:[{...dashboardEarning,orderNumber:'LATE-OLD'}]})))):json(dashboardPage(url,{items:[{...dashboardEarning,orderNumber:'CURRENT-NEW'}]}));
 const props={snapshot:dashboardWho(),onOpenPath(){},query:{q:'old'}};const ui=await h.mount(m.DistributionEarningsPage,props);await act(async()=>ui.root.render(createElement(m.DistributionEarningsPage,{...props,query:{q:'new'}})));await dashboardUntil(()=>ui.host.textContent.includes('CURRENT-NEW'));await act(async()=>release());assert.doesNotMatch(ui.host.textContent,/LATE-OLD/);
}));
test('earnings page has one search box and marks only historical rows',async()=>dashboardProbe(async(h,m)=>{
 globalThis.fetch=h.browser.fetch=async url=>json(dashboardPage(url,{items:[{...dashboardEarning,id:'n1',source:'NATIVE',beneficiaryName:'新平台用户'},{...dashboardEarning,id:'l1',source:'LEGACY',beneficiaryName:'历史用户'}],total:'2',hasMore:false}));const ui=await h.mount(m.DistributionEarningsPage,{snapshot:dashboardWho(),onOpenPath(){}});
 await dashboardUntil(()=>ui.host.textContent.includes('历史用户'));assert.equal(ui.host.querySelector('input[placeholder="完整订单号"]'),null);assert.equal(dashboardButton(ui.host,'查询本单佣金'),undefined);assert.equal(ui.host.querySelectorAll('input[placeholder]').length,1);
 const table=ui.host.querySelector('table');assert.equal(table.querySelector('th').textContent,'受益人');const rows=[...table.querySelectorAll('tbody tr')];assert.doesNotMatch(rows[0].cells[0].textContent,/历史|本平台/);assert.equal(rows[1].cells[0].textContent,'历史用户');assert.match(rows[1].cells[2].textContent,/旧平台记录/);
}));
test('legacy exact-order context loads the right root and discards a late earlier root',async()=>dashboardProbe(async(h,m)=>{
 let release;const calls=[];globalThis.fetch=h.browser.fetch=async url=>{calls.push(String(url));return String(url).includes('/orders/NATIVE/old_order')?new Promise(resolve=>release=()=>resolve(json(exactOrder('old_order')))):String(url).includes('/orders/LEGACY/new_order')?json(exactOrder('new_order','LEGACY')):json(dashboardPage(url,{items:[],total:'0',hasMore:false}));};
 const props={snapshot:dashboardWho(),onOpenPath(){},query:{orderId:'old_order',origin:'NATIVE'}};const ui=await h.mount(m.DistributionEarningsPage,props);await act(async()=>ui.root.render(createElement(m.DistributionEarningsPage,{...props,query:{orderId:'new_order',origin:'LEGACY'}})));await dashboardUntil(()=>ui.host.textContent.includes('PUBLIC-new_order'));await act(async()=>release());assert.doesNotMatch(ui.host.textContent,/PUBLIC-old_order/);assert(calls.some(p=>p.includes('/orders/LEGACY/new_order')));
}));
test('policy read-only wrapper never mounts maintenance reads or write controls',async()=>dashboardProbe(async(h,m)=>{
 const calls=[];globalThis.fetch=h.browser.fetch=async url=>{calls.push(String(url));return json(flat);};const ui=await h.mount(m.DistributionPolicyPage,{snapshot:snap(['personal.distribution.policy.read']),onOpenPath(){},onDirtyChange(){}});await settle();assert.equal(ui.host.querySelector('[aria-label="分销计提维护"]'),null);assert.equal(dashboardButton(ui.host,'执行到期入账'),undefined);assert(calls.every(p=>!p.includes('/maintenance/')));
}));
test('participant detail shows downline and own earnings',async()=>dashboardProbe(async(h,m)=>{
 const urls=[];globalThis.fetch=h.browser.fetch=async url=>{const u=String(url);urls.push(u);if(u.includes('/downline'))return json({subjectId:'old_user',type:'INVITER',knowledge:'KNOWN',total:'1',page:1,pageSize:10,items:[{userId:'child_one',name:'CHILD-ONE',boundAt:'2026-11-01T00:00:00.000Z',childCount:'0'}]});if(u.includes('/participants/old_user'))return json({participant:{userId:'old_user',name:'SUBJECT',knowledge:'KNOWN'},relations:[],downline:{knowledge:'KNOWN',leader:'1',inviter:'0'}});return json(dashboardPage(url,{items:[],total:'0',hasMore:false}));};
 const detail=await h.mount(m.DistributionParticipantPage,{snapshot:dashboardWho(),onOpenPath(){},userId:'old_user'});await dashboardUntil(()=>detail.host.textContent.includes('CHILD-ONE'));assert.ok(urls.some(u=>u.includes('beneficiary=old_user')));assert.ok(urls.some(u=>u.includes('/downline')&&new URL(u,'http://fixture.invalid').searchParams.get('type')==='INVITER'));assert.match(detail.host.textContent,/佣金明细/);
}));

test('participant detail switches from invitees to confirmed contributors without showing the previous list',async()=>dashboardProbe(async(h,m)=>{
 const urls=[];let release;
 globalThis.fetch=h.browser.fetch=async url=>{const u=String(url);urls.push(u);if(u.includes('/downline')){
  const type=new URL(u,'http://fixture.invalid').searchParams.get('type');
  if(type==='COMMISSION_CONTRIBUTOR')return new Promise(resolve=>release=()=>resolve(json({subjectId:'old_user',type,knowledge:'PARTIAL',total:'1',page:1,pageSize:10,items:[{userId:'contributor',name:'CONTRIBUTOR',children:0,mappedChildren:0}]})));
  return json({subjectId:'old_user',type:'INVITER',knowledge:'PARTIAL',total:'1',page:1,pageSize:10,items:[{userId:'invitee',name:'INVITED',children:0,mappedChildren:0}]});
 }if(u.includes('/participants/old_user'))return json({participant:{userId:'old_user',name:'SUBJECT',knowledge:'KNOWN'},relations:[],downline:{knowledge:'PARTIAL',inviter:10,contributors:1,contributorKnowledge:'PARTIAL'}});return json(dashboardPage(url,{items:[],total:'0',hasMore:false}));};
 const detail=await h.mount(m.DistributionParticipantPage,{snapshot:dashboardWho(),onOpenPath(){},userId:'old_user'});await dashboardUntil(()=>detail.host.textContent.includes('INVITED'));
 await click(button(detail.host,'产生佣金人数'));await dashboardUntil(()=>!!release);assert.doesNotMatch(detail.host.textContent,/INVITED/);
 await act(async()=>release());await dashboardUntil(()=>detail.host.textContent.includes('CONTRIBUTOR'));assert.match(detail.host.textContent,/仅列出已确认产生有效佣金的用户/);
 assert.ok(urls.some(u=>u.includes('/downline')&&new URL(u,'http://fixture.invalid').searchParams.get('type')==='COMMISSION_CONTRIBUTOR'));
}));

test('dashboard participant list and detail clear private fields on denied refresh and root changes',async()=>dashboardProbe(async(h,m)=>{
 const participant={userId:'old_user',name:'PRIVATE_PARTICIPANT',eligibility:'ELIGIBLE',frozen:false,levelCode:null,inviter:'KNOWN_NONE',leader:'KNOWN_NONE',sourceType:'NATIVE',revision:'1',leaderChildren:0,inviterChildren:0,settledCents:'95',pendingCents:'0',recoveryCents:'0'};
 let denied=false,release;globalThis.fetch=h.browser.fetch=async url=>{if(denied)return json({error:{code:'FORBIDDEN'}},403);if(String(url).includes('/participants/new_user'))return new Promise(resolve=>release=()=>resolve(json({participant:{...participant,userId:'new_user',name:'CURRENT_PARTICIPANT'},relations:[]})));return String(url).includes('/participants/old_user')?json({participant,relations:[]}):json(dashboardPage(url,{items:[participant],total:'1',hasMore:false}));};
 const list=await h.mount(m.DistributionParticipantsPage,{snapshot:dashboardWho(),onOpenPath(){}});assert.match(list.host.textContent,/PRIVATE_PARTICIPANT/);denied=true;await click(dashboardButton(list.host,'刷新'));await dashboardUntil(()=>list.host.textContent.includes('当前身份没有'));assert.doesNotMatch(list.host.textContent,/PRIVATE_PARTICIPANT/);
 denied=false;const props={snapshot:dashboardWho(),onOpenPath(){},userId:'old_user'};const detail=await h.mount(m.DistributionParticipantPage,props);assert.match(detail.host.textContent,/PRIVATE_PARTICIPANT/);await act(async()=>detail.root.render(createElement(m.DistributionParticipantPage,{...props,userId:'new_user'})));assert.doesNotMatch(detail.host.textContent,/PRIVATE_PARTICIPANT/);await dashboardUntil(()=>!!release);await act(async()=>release());await dashboardUntil(()=>detail.host.textContent.includes('CURRENT_PARTICIPANT'));
}));

test('the rendered distribution chart formatter keeps original cents beyond safe integer precision',async()=>dashboardProbe(async(h,m)=>{
 const cents='9007199254740993',tree=m.DistributionTrend({points:[{date:'2026-11-02',cents,knowledge:'KNOWN'}]});let formatter;
 const visit=element=>{if(!element||typeof element!=='object')return;if(typeof element.props?.formatValue==='function')formatter=element.props.formatValue;visit(element.props?.content);const children=element.props?.children;if(Array.isArray(children))children.forEach(visit);else visit(children);};visit(tree);
 assert.equal(formatter,m.distributionTrendValue);assert.equal(formatter({cents,yuan:Number(cents)/100},'yuan'),'¥90,071,992,547,409.93');assert.equal(formatter({yuan:999},'yuan'),'未核定');
}));
test('non-finite distribution chart coordinates use an exact table and unknown points stay unknown',async()=>dashboardProbe(async(h,m)=>{
 const huge='1'+'0'.repeat(400),model=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-model.ts');const ui=await h.mount(m.DistributionTrend,{points:[{date:'2026-11-01',cents:huge,knowledge:'KNOWN'},{date:'2026-11-02',cents:'0',knowledge:'UNKNOWN'}]});
 const table=ui.host.querySelector('table[aria-label="分销入账趋势明细"]');assert(table);assert.equal(ui.host.querySelector('[role=img]'),null);assert.equal(table.querySelectorAll('tbody tr')[0].lastChild.textContent,model.money(huge));assert.equal(table.querySelectorAll('tbody tr')[1].lastChild.textContent,'未核定');assert.doesNotMatch(ui.host.textContent,/Infinity|NaN|当前范围暂无入账/);
}));

test('StrictMode replays the legacy exact-order read after its first effect is cancelled',async()=>dashboardProbe(async(h,m)=>{
 const requests=[];globalThis.fetch=h.browser.fetch=async(url,options)=>{requests.push({path:String(url),signal:options?.signal});return String(url).includes('/orders/NATIVE/order_strict')?json(exactOrder('order_strict')):json(dashboardPage(url,{items:[],total:'0',hasMore:false}));};
 const Wrapper=props=>createElement(StrictMode,null,createElement(m.DistributionEarningsPage,props));const ui=await h.mount(Wrapper,{snapshot:dashboardWho(),onOpenPath(){},query:{orderId:'order_strict',origin:'NATIVE'}});await dashboardUntil(()=>ui.host.textContent.includes('PUBLIC-order_strict'));assert(requests.filter(r=>r.path.includes('/orders/NATIVE/order_strict')).some(r=>!r.signal?.aborted));
}));
test('policy without explicit write assembly never mounts the maintenance commands, even for Boss',async()=>dashboardProbe(async(h,m)=>{
 for(const writeAssemblyReady of [false,undefined]){const calls=[];globalThis.fetch=h.browser.fetch=async url=>{calls.push(String(url));return json({...flat,changeContext:writeAssemblyReady===undefined?undefined:{...context,writeAssemblyReady}});};const ui=await h.mount(m.DistributionPolicyPage,{snapshot:snap([],'boss','boss-session',true),onOpenPath(){},onDirtyChange(){}});await settle();assert.equal(ui.host.querySelector('[aria-label="分销计提维护"]'),null);assert(calls.every(p=>!p.includes('/maintenance/')));}
}));
test('failed maintenance read is unfinished, never a completed empty inspection',async()=>dashboardProbe(async(h)=>{
 globalThis.fetch=h.browser.fetch=async()=>json({error:{code:'EVIDENCE_UNAVAILABLE'}},503);const m=await h.loader.ssrLoadModule('/src/views/distribution-maintenance-panel.tsx'),ui=await h.mount(m.DistributionMaintenancePanel,{});await dashboardUntil(()=>ui.host.textContent.includes('维护未完成'));assert.match(ui.host.textContent,/本次检查未完成/);assert.doesNotMatch(ui.host.textContent,/已检查 0|当前范围内没有可检查|已到达当前范围最早/);
}));

test('DistributionDateRange keeps incomplete ranges local and only commits both ends', async () => {
  const {readFileSync}=await import('node:fs');const src=readFileSync(new URL('../src/views/distribution-dashboard-pages.tsx',import.meta.url),'utf8');
  const start=src.indexOf('export function DistributionDateRange'), body=src.slice(start, src.indexOf('\nexport function', start+10));
  assert.ok(body.includes('setDraft(next)'));
  assert.ok(body.includes('if (next.startDate && next.endDate)'));
  assert.ok(body.includes("presets={[{ label: '近 7 天', days: 7 }"));
  assert.match(body, /onChange\(isoDay\(next\.startDate\), isoDay\(next\.endDate\)\);\s*setOpen\(false\);/);
  assert.equal(body.includes('onChange(isoDay(next.startDate), isoDay(next.endDate)); if (next.startDate && next.endDate)'), false, 'must not commit half ranges');
  assert.ok(body.includes('align="start"'));
});
test('earnings filters use compact flex layout around the shared DateSelector', async () => {
  const {readFileSync}=await import('node:fs');const src=readFileSync(new URL('../src/views/distribution-dashboard-pages.tsx',import.meta.url),'utf8');
  const start=src.indexOf('export function DistributionEarningsPage'), body=src.slice(start, src.indexOf('\nexport function', start+10));
  assert.ok(body.includes('data-distribution-earnings-filters className="flex flex-col gap-3"'));
  assert.ok(body.includes('flex flex-wrap items-end gap-x-4 gap-y-3'));
  assert.ok(body.includes('min-w-[14rem] max-w-md flex-1'));
  assert.ok(body.includes('flex flex-wrap items-end gap-2'));
  assert.equal(body.includes('xl:grid-cols-[minmax(16rem,1.6fr)'), false);
  assert.ok(body.includes('DistributionDateRange'));
});
test('overview layout drops 关系与资格, shows 佣金排行 + 邀请人数 above 最近分销记录',async()=>{
 const {readFileSync}=await import('node:fs');const src=readFileSync(new URL('../src/views/distribution-dashboard-pages.tsx',import.meta.url),'utf8');
 const start=src.indexOf('export function DistributionOverviewPage'),body=src.slice(start,src.indexOf('\nexport function',start+10));
 for(const gone of ['关系与资格','计佣关系','最近佣金','label="排行口径"','分销排行'])assert.equal(body.includes(gone),false,gone);
 const a=body.indexOf('佣金排行'),b=body.indexOf('邀请人数'),c=body.indexOf('最近分销记录');
 assert.ok(a>0&&a<b&&b<c);assert.ok(body.includes('DistributionDateRange'));
 assert.ok(src.includes('DistributionUserName'));
 const shared=readFileSync(new URL('../src/views/distribution-user-name.tsx',import.meta.url),'utf8');
 assert.ok(shared.includes('UserProfilePreview'));
 assert.ok(shared.includes('EntityPreviewTrigger'));
});
test('dashboard earnings uses unified ListPagination with page numbers, jump and page size',async()=>dashboardProbe(async(h,m)=>{
 const calls=[];globalThis.fetch=h.browser.fetch=async url=>{const q=new URL(String(url),'http://fixture.invalid').searchParams;calls.push(Object.fromEntries(q));return json(dashboardPage(url,{total:'100',hasMore:Number(q.get('page')??1)<5}));};
 const ui=await h.mount(m.DistributionEarningsPage,{snapshot:dashboardWho(),onOpenPath(){}});await dashboardUntil(()=>ui.host.textContent.includes('ORDER-ONE'));
 assert.ok(ui.host.querySelector('[data-slot="admin-list-pagination"]'));assert.match(ui.host.textContent,/共 100 条记录 · 第 1 \/ 5 页/);assert.ok(ui.host.querySelector('[aria-label="每页容量"]'));
 await click(ui.host.querySelector('[aria-label="第 3 页"]'));await dashboardUntil(()=>calls.some(c=>c.page==='3'));assert.equal(calls.at(-1).pageSize,'20');
}));
