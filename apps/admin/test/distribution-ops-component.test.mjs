import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act,createElement } from 'react';
import { setup,snap,known,flat,context,operations,json,settle,input,click,manager } from './distribution-ops-fixture.mjs';
const button=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent.includes(text));

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
 const h=await setup();try{const m=await h.loader.ssrLoadModule('/src/views/distribution-workspace.tsx');assert.equal(m.distributionState({origin:'NATIVE',state:'SETTLED',fundsDisposition:'SETTLED'}),'已转入可用资金');assert.equal(m.distributionState({origin:'LEGACY_MYSQL',state:'SETTLED',fundsDisposition:'HISTORICAL_STATUS_ONLY'}),'旧平台已结算记录');assert.equal(m.distributionState({origin:'NATIVE',state:'FUTURE',fundsDisposition:'UNKNOWN'}),'当前状态待核');
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
