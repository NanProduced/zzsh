import assert from 'node:assert/strict';
import {test} from 'node:test';
import {act,createElement} from 'react';
import {setup,snap,json,settle,click,input} from './distribution-ops-fixture.mjs';

const levels={knowledge:'KNOWN',writeAssemblyReady:true,policy:{versionId:'policy_1',revision:'1',managed:{schema:'distribution-policy.v4',baseMode:'LEGACY_RENTAL',levelNames:{base:'默认',silver:'白银'},levels:[
 {code:'base',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null},{code:'silver',rank:2,default:false,renterPercent:'8',ownerPercent:'8',upgrade:null}]}}};
const people={items:[{userId:'user_1',name:'用户甲',eligibility:'ELIGIBLE',frozen:true,revision:'1',levelCode:'silver',levelName:'白银',inviteCode:'OLD_CODE',inviteCodeId:'old_code'}],total:'1',page:1,hasMore:false,writeAssemblyReady:true,
 policy:{versionId:'policy_1',revision:'1',schema:'distribution-policy.v4',levels:[{code:'base',name:'默认'},{code:'silver',name:'白银'}]}};

test('operator edits a code directly and retries an unknown result with the identical key and body',async t=>{
 const h=await setup(),oldFetch=globalThis.fetch,calls=[];let failed=false;
 t.after(async()=>{globalThis.fetch=oldFetch;await h.close();});
 globalThis.fetch=h.browser.fetch=async(url,options={})=>{calls.push({url:String(url),options});if((options.method??'GET')==='GET')return json(people);
  if(!failed){failed=true;throw Error('synthetic transport interruption');}return json({userId:'user_1',code:'NEW_CODE',codeId:'new_code'});};
 const m=await h.loader.ssrLoadModule('/src/views/distribution-management.tsx');const ui=await h.mount(m.DistributionParticipantManager,{snapshot:snap(['distribution.participant.read','distribution.participant.manage'])});
 const button=text=>[...ui.host.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
 assert.match(ui.host.textContent,/原邀请关系和历史佣金保留/);assert.match(ui.host.textContent,/佣金冻结/);
 await click(button('维护'));assert.match(ui.host.textContent,/旧码立即失效/);
 const reason=[...ui.host.querySelectorAll('input')].find(i=>i.placeholder.includes('至少 3'));await input(h.browser,reason,'调整邀请码');
 await input(h.browser,ui.host.querySelector('input[aria-label="邀请码"]'),'NEW_CODE');
 await click(button('保存邀请码'));assert.match(ui.host.textContent,/操作结果待核对/);
 const sent=calls.filter(c=>c.options.method==='POST');assert.equal(sent.length,1);assert.equal(JSON.parse(sent[0].options.body).expectedCodeId,'old_code');
 await click(button('查询原请求'));await settle();const replay=calls.filter(c=>c.options.method==='POST');assert.equal(replay.length,2);
 assert.equal(replay[1].options.headers['idempotency-key'],replay[0].options.headers['idempotency-key']);assert.equal(replay[1].options.body,replay[0].options.body);
 assert.match(ui.host.textContent,/已保存/);assert.equal(h.browser.sessionStorage.length,0);
});

test('default level is protected and deleting another level clearly shows reassignment',async t=>{
 const h=await setup(),oldFetch=globalThis.fetch,calls=[];t.after(async()=>{globalThis.fetch=oldFetch;await h.close();});
 globalThis.fetch=h.browser.fetch=async(url,options={})=>{calls.push({url:String(url),options});return json(options.method==='POST'?{versionId:'policy_2',revision:'2',reassigned:1,config:{schema:'distribution-policy.v4',levels:[levels.policy.managed.levels[0]],levelNames:{base:'默认'}}}:levels);};
 const m=await h.loader.ssrLoadModule('/src/views/distribution-management.tsx');const ui=await h.mount(m.DistributionLevelManager,{snapshot:snap(['distribution.level.manage'])});
 const rows=[...ui.host.querySelectorAll('tbody tr')];assert.equal(rows.length,2);
 assert.equal([...rows[0].querySelectorAll('button')].find(b=>b.textContent==='删除').disabled,true);
 await click([...rows[1].querySelectorAll('button')].find(b=>b.textContent==='删除'));assert.match(ui.host.textContent,/当前使用此等级的用户将调整为默认等级/);
 await input(h.browser,[...ui.host.querySelectorAll('input')].find(i=>i.placeholder.includes('至少 3')),'合并分销等级');
 await click([...ui.host.querySelectorAll('button')].find(b=>b.textContent==='确认删除'));const sent=calls.find(c=>c.options.method==='POST');
 assert.deepEqual(JSON.parse(sent.options.body).command,{action:'DELETE',code:'silver'});
});

test('new permissions expose only participant and level navigation, not dashboard or earnings',async()=>{
 const {canOpenKind}=await import('../src/workspace/tab-model.ts');
 const nav={isBoss:false,permissions:['distribution.participant.read','distribution.participant.manage','distribution.level.manage']};
 assert.equal(canOpenKind('distribution-participants',nav),true);assert.equal(canOpenKind('distribution-policy',nav),true);
 assert.equal(canOpenKind('distribution-overview',nav),false);assert.equal(canOpenKind('distribution-earnings',nav),false);
});

test('a 200 response with an unrelated or incomplete receipt never clears the original write',async t=>{
 const h=await setup();t.after(async()=>h.close());const m=await h.loader.ssrLoadModule('/src/views/distribution-management.tsx');
 const code={actor:'ops',session:'session',key:'idem_'+'a'.repeat(32),path:'/distribution/manage/participants/user_1/code',body:{expectedCodeId:'old',code:'NEW'}};
 assert.equal(m.matchesDistributionManagementReceipt(code,{}),false);
 assert.equal(m.matchesDistributionManagementReceipt(code,{userId:'other',code:'NEW',codeId:'new'}),false);
 assert.equal(m.matchesDistributionManagementReceipt(code,{userId:'user_1',code:'NEW',codeId:'new'}),true);
 const deletion={...code,path:'/distribution/manage/levels',body:{expectedRevision:'1',command:{action:'DELETE',code:'silver'}}};
 assert.equal(m.matchesDistributionManagementReceipt(deletion,{versionId:'p',revision:'2'}),false);
 assert.equal(m.matchesDistributionManagementReceipt(deletion,{versionId:'p',revision:'2',reassigned:1,config:{schema:'distribution-policy.v4',levels:[{code:'base',default:true}],levelNames:{base:'默认'}}}),true);
});

test('v4 policy is readable while global enable changes keep the existing approval contract',async t=>{
 const h=await setup();t.after(async()=>h.close());const m=await h.loader.ssrLoadModule('/src/views/distribution-policy-model.ts');
 const config={...levels.policy.managed,scope:'NATIVE',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary'],minimumAccrualCents:'1',settlementDelayDays:7};
 const read=m.parseDistributionPolicyRead({knowledge:'KNOWN',policy:{versionId:'policy_2',revision:'2',digest:'d'.repeat(64),createdAt:'2026-11-06T00:00:00Z',config}});
 const payload=m.buildDistributionPolicyPayload(read.policy,{enabled:false,renter:'',owner:'',reason:'暂停新的计佣'});
 assert.deepEqual(payload.changes,{enabled:false});assert.equal(payload.expectedPolicyId,'policy_2');
});

test('participant management drops previous names immediately when permission changes',async t=>{
 const h=await setup(),oldFetch=globalThis.fetch;let release,calls=0;
 t.after(async()=>{globalThis.fetch=oldFetch;await h.close();});
 globalThis.fetch=h.browser.fetch=async()=>{calls++;if(calls===1)return json(people);return new Promise(resolve=>{release=()=>resolve(json({...people,items:[]}));});};
 const m=await h.loader.ssrLoadModule('/src/views/distribution-management.tsx'),props={snapshot:snap(['distribution.participant.read','user.directory.read'])};
 const ui=await h.mount(m.DistributionParticipantManager,props);assert.match(ui.host.textContent,/用户甲/);
 await act(async()=>ui.root.render(createElement(m.DistributionParticipantManager,{snapshot:snap(['distribution.participant.read'])})));
 assert.doesNotMatch(ui.host.textContent,/用户甲/);await act(async()=>release());await settle();
});

test('user columns hide internal IDs and use the shared, permission-gated profile preview',async t=>{
 const h=await setup(),oldFetch=globalThis.fetch,calls=[];t.after(async()=>{globalThis.fetch=oldFetch;await h.close();});
 globalThis.fetch=h.browser.fetch=async(url)=>{calls.push(String(url));return json(people);};
 const m=await h.loader.ssrLoadModule('/src/views/distribution-management.tsx');
 const ui=await h.mount(m.DistributionParticipantManager,{snapshot:snap(['distribution.participant.read','user.directory.read']),onOpenUser(){}});
 assert.doesNotMatch(ui.host.textContent,/user_1/);assert.ok(ui.host.querySelector('[aria-label="预览用户 用户甲"]'));
 assert.equal(calls.filter(url=>url.includes('/users/')).length,0,'profile is fetched only on demand');
 await act(async()=>ui.root.render(createElement(m.DistributionParticipantManager,{snapshot:snap(['distribution.participant.read']),onOpenUser(){}})));await settle();
 assert.equal(ui.host.querySelector('[aria-label="预览用户 用户甲"]'),null);assert.doesNotMatch(ui.host.textContent,/user_1/);
});

test('selected-games operator uses the minimal maintenance read without loading global finance',async t=>{
 const h=await setup(),oldFetch=globalThis.fetch,calls=[];t.after(async()=>{globalThis.fetch=oldFetch;await h.close();});
 globalThis.fetch=h.browser.fetch=async(url)=>{calls.push(String(url));return json(people);};
 const m=await h.loader.ssrLoadModule('/src/views/distribution-dashboard-pages.tsx');const actor=snap(['distribution.dashboard.read','distribution.participant.read']);actor.gameScope={mode:'SELECTED_GAMES',gameIds:['game_1']};
 const ui=await h.mount(m.DistributionParticipantsPage,{snapshot:actor,onOpenPath(){}});
 assert.match(ui.host.textContent,/维护分销参与人/);assert.ok(calls.some(url=>url.includes('/distribution/manage/participants')));
 assert.ok(calls.every(url=>!url.includes('/distribution/participants?')&&!url.includes('/distribution/earnings')));
});
