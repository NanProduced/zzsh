import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act,createElement,StrictMode } from 'react';
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

test('distribution dashboard model formats exact cents and keeps source/role/state labels explicit',async()=>{
 const h=await setup();
 try{const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-model.ts');
  assert.equal(m.money('9007199254740993'),'¥90,071,992,547,409.93');
  assert.equal(m.money('0'),'¥0.00');
  assert.equal(m.dashboardMoney({knowledge:'UNKNOWN',cents:null,count:null,reasonCodes:['LEGACY_SOURCE_NOT_INSTALLED']}),'未核定');
  assert.equal(m.dashboardMoney({knowledge:'KNOWN',cents:'95',count:'1',reasonCodes:[]}),'¥0.95');
  assert.equal(m.roleLabel('OWNER_REFERRAL'),'号主来源');
  assert.equal(m.sourceLabel('LEGACY'),'历史观察');
  assert.equal(m.stateLabel('RECOVERY_REQUIRED'),'待追偿');
  const f=m.defaultDashboardFilters();
  assert.match(f.from,/^\d{4}-\d{2}-\d{2}$/);assert.equal(f.page,1);assert.equal(f.pageSize,20);
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
 assert.ok(participantMobile?.textContent.includes('受益人'));assert.ok(participantMobile?.textContent.includes('user_1'));assert.ok(participantMobile?.textContent.includes('¥0.95'));
}finally{globalThis.fetch=previous;await h.close();}});

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
 const date=ui.host.querySelector('input[type=date]');await input(h.browser,date,'2026-10-02');await dashboardUntil(()=>queries.length>0);assert.equal(queries.at(-1).from,'2026-10-02');assert.equal(queries.at(-1).page,'1');assert.equal(queries.at(-1).source,'LEGACY');assert.equal(queries.at(-1).snapshot,undefined);
}));
test('dashboard external filter navigation cancels a late prior response',async()=>dashboardProbe(async(h,m)=>{
 let release;globalThis.fetch=h.browser.fetch=async url=>new URL(String(url),'http://fixture.invalid').searchParams.get('q')==='old'?new Promise(resolve=>release=()=>resolve(json(dashboardPage(url,{items:[{...dashboardEarning,orderNumber:'LATE-OLD'}]})))):json(dashboardPage(url,{items:[{...dashboardEarning,orderNumber:'CURRENT-NEW'}]}));
 const props={snapshot:dashboardWho(),onOpenPath(){},query:{q:'old'}};const ui=await h.mount(m.DistributionEarningsPage,props);await act(async()=>ui.root.render(createElement(m.DistributionEarningsPage,{...props,query:{q:'new'}})));await dashboardUntil(()=>ui.host.textContent.includes('CURRENT-NEW'));await act(async()=>release());assert.doesNotMatch(ui.host.textContent,/LATE-OLD/);
}));
test('dashboard zero exact-order matches release the query lock without a fake amount',async()=>dashboardProbe(async(h,m)=>{
 globalThis.fetch=h.browser.fetch=async url=>String(url).includes('/orders?')?json({items:[],total:0}):json(dashboardPage(url,{items:[],total:'0',hasMore:false}));const ui=await h.mount(m.DistributionEarningsPage,{snapshot:dashboardWho(),onOpenPath(){}});
 await input(h.browser,ui.host.querySelector('input[placeholder="完整订单号"]'),'NO-SUCH-ORDER');const submit=dashboardButton(ui.host,'查询本单佣金');await click(submit);await dashboardUntil(()=>ui.host.textContent.includes('没有找到可读的匹配订单'));assert.equal(submit.disabled,false);
}));
test('legacy exact-order context loads the right root and discards a late earlier root',async()=>dashboardProbe(async(h,m)=>{
 let release;const calls=[];globalThis.fetch=h.browser.fetch=async url=>{calls.push(String(url));return String(url).includes('/orders/NATIVE/old_order')?new Promise(resolve=>release=()=>resolve(json(exactOrder('old_order')))):String(url).includes('/orders/LEGACY/new_order')?json(exactOrder('new_order','LEGACY')):json(dashboardPage(url,{items:[],total:'0',hasMore:false}));};
 const props={snapshot:dashboardWho(),onOpenPath(){},query:{orderId:'old_order',origin:'NATIVE'}};const ui=await h.mount(m.DistributionEarningsPage,props);await act(async()=>ui.root.render(createElement(m.DistributionEarningsPage,{...props,query:{orderId:'new_order',origin:'LEGACY'}})));await dashboardUntil(()=>ui.host.textContent.includes('PUBLIC-new_order'));await act(async()=>release());assert.doesNotMatch(ui.host.textContent,/PUBLIC-old_order/);assert(calls.some(p=>p.includes('/orders/LEGACY/new_order')));
}));
test('policy read-only wrapper never mounts maintenance reads or write controls',async()=>dashboardProbe(async(h,m)=>{
 const calls=[];globalThis.fetch=h.browser.fetch=async url=>{calls.push(String(url));return json(flat);};const ui=await h.mount(m.DistributionPolicyPage,{snapshot:snap(['personal.distribution.policy.read']),onOpenPath(){},onDirtyChange(){}});await settle();assert.equal(ui.host.querySelector('[aria-label="分销计提维护"]'),null);assert.equal(dashboardButton(ui.host,'执行到期入账'),undefined);assert(calls.every(p=>!p.includes('/maintenance/')));
}));
test('relations incoming user context and permission withdrawal are request-scoped',async()=>dashboardProbe(async(h,m)=>{
 let release;globalThis.fetch=h.browser.fetch=async url=>{const id=String(url).split('/').at(-1);const body={subjectId:id,participant:{knowledge:'KNOWN',eligibility:'ELIGIBLE',commissionFrozen:false,legacyLevelCode:null},relations:[{type:'INVITER',knowledge:'KNOWN_PARENT',parentUserId:'parent',parentName:id==='old_user'?'PRIVATE-OLD-PARENT':'CURRENT-PARENT',sourceType:'NATIVE',policyVersion:null}],reasonCodes:[]};return id==='old_user'?new Promise(resolve=>release=()=>resolve(json(body))):json(body);};
 const who=snap(['user.directory.read','personal.distribution.policy.read']),props={snapshot:who,onOpenPath(){},query:{userId:'old_user'}};const ui=await h.mount(m.DistributionRelationsPage,props);await act(async()=>ui.root.render(createElement(m.DistributionRelationsPage,{...props,query:{userId:'new_user'}})));await dashboardUntil(()=>ui.host.textContent.includes('CURRENT-PARENT'));await act(async()=>release());assert.doesNotMatch(ui.host.textContent,/PRIVATE-OLD-PARENT/);await input(h.browser,ui.host.querySelector('input'),'bad/user');await click(dashboardButton(ui.host,'查询关系'));assert.match(ui.host.textContent,/请填写准确用户 ID/);await act(async()=>ui.root.render(createElement(m.DistributionRelationsPage,{...props,query:{userId:'third_user'}})));await dashboardUntil(()=>ui.host.textContent.includes('CURRENT-PARENT'));assert.doesNotMatch(ui.host.textContent,/请填写准确用户 ID/);await act(async()=>ui.root.render(createElement(m.DistributionRelationsPage,{...props,query:{userId:'new_user'},snapshot:snap([])})));assert.doesNotMatch(ui.host.textContent,/CURRENT-PARENT/);
}));

test('dashboard participant list and detail clear private fields on denied refresh and root changes',async()=>dashboardProbe(async(h,m)=>{
 const participant={userId:'old_user',name:'PRIVATE_PARTICIPANT',eligibility:'ELIGIBLE',frozen:false,levelCode:null,inviter:'KNOWN_NONE',leader:'KNOWN_NONE',sourceType:'NATIVE',revision:'1',leaderChildren:0,inviterChildren:0,settledCents:'95',pendingCents:'0',recoveryCents:'0'};
 let denied=false,release;globalThis.fetch=h.browser.fetch=async url=>{if(denied)return json({error:{code:'FORBIDDEN'}},403);if(String(url).includes('/participants/new_user'))return new Promise(resolve=>release=()=>resolve(json({participant:{...participant,userId:'new_user',name:'CURRENT_PARTICIPANT'},relations:[]})));return String(url).includes('/participants/old_user')?json({participant,relations:[]}):json(dashboardPage(url,{items:[participant],total:'1',hasMore:false}));};
 const list=await h.mount(m.DistributionParticipantsPage,{snapshot:dashboardWho(),onOpenPath(){}});assert.match(list.host.textContent,/PRIVATE_PARTICIPANT/);denied=true;await click(dashboardButton(list.host,'刷新'));await dashboardUntil(()=>list.host.textContent.includes('当前身份没有'));assert.doesNotMatch(list.host.textContent,/PRIVATE_PARTICIPANT/);
 denied=false;const props={snapshot:dashboardWho(),onOpenPath(){},userId:'old_user'};const detail=await h.mount(m.DistributionParticipantPage,props);assert.match(detail.host.textContent,/PRIVATE_PARTICIPANT/);await act(async()=>detail.root.render(createElement(m.DistributionParticipantPage,{...props,userId:'new_user'})));assert.doesNotMatch(detail.host.textContent,/PRIVATE_PARTICIPANT/);await dashboardUntil(()=>!!release);await act(async()=>release());await dashboardUntil(()=>detail.host.textContent.includes('CURRENT_PARTICIPANT'));
}));

test('the rendered distribution chart formatter keeps original cents beyond safe integer precision',async()=>dashboardProbe(async(h,m)=>{
 const cents='9007199254740993',tree=m.DistributionTrend({points:[{date:'2026-11-02',cents,knowledge:'KNOWN'}]});let formatter;
 const visit=element=>{if(!element||typeof element!=='object')return;if(typeof element.props?.formatter==='function')formatter=element.props.formatter;const children=element.props?.children;if(Array.isArray(children))children.forEach(visit);else visit(children);};visit(tree);
 assert.equal(formatter,m.distributionTrendTooltip);assert.deepEqual(formatter(Number(cents)/100,'入账',{payload:{cents}}),['¥90,071,992,547,409.93','入账']);assert.deepEqual(formatter(999,'入账',{}),['未核定','入账']);
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
