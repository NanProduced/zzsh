import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountA,detail,mountHarness} from './supply-review-fixture.mjs';
const permissions=['supply.review.read','supply.restrict','supply.review.decide'];
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
function data(id='a',revision='7',mediaRevision='2'){const value=detail({...accountA,id,revision,display_no:'TEST-'+id,owner_user_id:'owner-'+id},'PUBLISHED');value.version.declaration.mediaBindings[0].byteHash='a'.repeat(64);value.version.declaration.mediaBindings[0].mediaRevision=mediaRevision;value.contextKey='fixture-authorization';value.supervision={historical:false,facts:{publicVisible:true,newOrders:true,reasons:[],primaryReasonCode:null,ownerPaused:false,staffRestricted:false,occupancy:'FREE',sources:[],legacyNumbers:[]},changes:null,previousVersion:null,restrictionHistory:{state:'NOT_RECORDED',items:[],limit:20},ownerLink:{state:'DENIED'},orders:{state:'DENIED'}};return value;}
const settle=async h=>{for(let i=0;i<5;i++)await h.settle();};
test('R1 port: late detail A cannot replace independent object B under StrictMode',async t=>{
 const pending=[];const h=await mountHarness(t,{permissions,strict:true,initialAccountId:'a',initialQuery:{context:'review'},fetchImpl:async url=>url.pathname.endsWith('/a')?new Promise(resolve=>pending.push(()=>resolve(response(data('a'))))):response(data('b'))});
 await h.render('admin',permissions,'b',{context:'review'});await settle(h);for(const resolve of pending)resolve();await settle(h);assert.match(h.el.textContent,/TEST-b/);assert.doesNotMatch(h.el.textContent,/TEST-a/);assert.equal(h.writes.length,0);
});
test('R1 port: changed account revision invalidates an open confirmation after refresh',async t=>{
 let revision='7';const h=await mountHarness(t,{permissions,strict:true,initialAccountId:'a',initialQuery:{context:'review'},fetchImpl:async()=>response(data('a',revision))});await settle(h);await h.fillReason('fixture current account evidence');await h.click(h.btn('核对后确认运营限制'));await settle(h);revision='8';await h.render('admin',permissions,'a',{context:'review'},1);await settle(h);
 assert.ok(h.btn('确认施加运营限制').disabled);await h.click(h.btn('确认施加运营限制'));assert.equal(h.writes.length,0);assert.match(h.el.textContent,/原账号版本已失效/);
});
test('R1 port: image revision change cannot reuse an old image confirmation',async t=>{
 let mediaRevision='2';const h=await mountHarness(t,{permissions,strict:true,initialAccountId:'a',initialQuery:{context:'changes'},fetchImpl:async()=>response(data('a','7',mediaRevision))});await settle(h);await h.fillReason('fixture verify bound image');await h.click(h.btn('确认前核对并隔离本图'));await settle(h);mediaRevision='3';await h.render('admin',permissions,'a',{context:'changes'},1);await settle(h);
 assert.ok(h.btn('确认隔离当前展示图').disabled);await h.click(h.btn('确认隔离当前展示图'));assert.equal(h.writes.length,0);
});

test('finish F1: restricted paused account confirmation preserves actual independent conditions and UNKNOWN snapshot',async t=>{
 let value=data();value.account.staff_restricted=true;value.account.owner_paused=true;value.supervision.facts={...value.supervision.facts,staffRestricted:true,ownerPaused:true,newOrders:null,reasons:['STAFF_RESTRICTED','OWNER_PAUSED','RULE_CHANGED','OCCUPANCY_UNKNOWN']};
 const h=await mountHarness(t,{permissions,strict:true,initialAccountId:'a',initialQuery:{context:'review'},fetchImpl:async(url,init)=>{if(init.method==='POST')throw new Error('offline UNKNOWN');return response(value);}});await settle(h);
 await h.click(h.el.querySelector('input[type=checkbox]'));await h.fillReason('fixture independent paused and blocked conditions');await h.click(h.btn('核对完成，确认解除影响'));await settle(h);
 const condition=h.el.querySelector('dialog section[aria-label]');assert.match(condition.textContent,/已暂停，须由号主独立恢复/);assert.match(condition.textContent,/规则已切换/);assert.match(condition.textContent,/占用状态未知/);assert.match(condition.textContent,/新单资格仍有待核依据/);const frozen=condition.textContent;
 await h.click(h.btn('确认解除运营限制'));await settle(h);value=structuredClone(value);value.supervision.facts.reasons=['GAME_UNAVAILABLE'];await h.render('admin',permissions,'a',{context:'review'},1);await settle(h);assert.equal(h.el.querySelector('dialog section[aria-label]').textContent,frozen);assert.equal(h.writes.length,1);
});
test('finish F1: draft confirmation shows missing publication and opens/cancels with zero writes',async t=>{
 const value=data();value.version.reviewState='DRAFT';value.version.publication=null;value.supervision.facts.reasons=['PUBLICATION_REQUIRED','FUNDING_UNKNOWN'];value.supervision.facts.publicVisible=false;value.supervision.facts.newOrders=false;
 const h=await mountHarness(t,{permissions,strict:true,initialAccountId:'a',initialQuery:{context:'review'},fetchImpl:async()=>response(value)});await settle(h);await h.fillReason('fixture draft evidence');await h.click(h.btn('核对后确认运营限制'));await settle(h);
 assert.match(h.el.querySelector('dialog').textContent,/草稿；发布记录：无记录/);assert.match(h.el.querySelector('dialog').textContent,/无有效发布事实/);assert.match(h.el.querySelector('dialog').textContent,/资金资格依据尚未核定/);await h.click(h.btn('取消'));assert.equal(h.writes.length,0);
});
test('finish F2: two order clipboard summaries keep each original party/payment/version, and failed copy fallback keeps selected order',async t=>{
 const value=data(),orders=[
 {id:'order-old',displayNo:'OLD-1',ownerName:'原号主甲',ownerUserId:'original-owner',renterName:'租客甲',renterUserId:'renter-old',status:'FINISHED',versionId:null,payment:{state:'UNKNOWN'},source:{origin:'LEGACY',statusLabel:'旧单已结束'}},
 {id:'order-native',displayNo:'NEW-2',ownerName:'原号主乙',ownerUserId:'owner-a',renterName:'租客乙',renterUserId:'renter-native',status:'PAID',versionId:'frozen-version-2',payment:{state:'RECORDED_PAID'},source:{origin:'NATIVE'}}
 ];value.supervision.orders={state:'READY',items:orders,total:2};const h=await mountHarness(t,{permissions:[...permissions,'order.read'],isBoss:false,strict:true,initialAccountId:'a',initialQuery:{context:'orders'},fetchImpl:async()=>response(value)});await settle(h);
 const copied=[];Object.defineProperty(h.browser.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});const buttons=[...h.el.querySelectorAll('button')].filter(x=>x.textContent==='复制本单核对摘要');assert.equal(buttons.length,2);await h.click(buttons[0]);await h.click(buttons[1]);assert.notEqual(copied[0],copied[1]);
 assert.match(copied[0],/OLD-1 · order-old/);assert.match(copied[0],/原号主甲 · original-owner/);assert.match(copied[0],/租客甲 · renter-old/);assert.match(copied[0],/付款事实待核/);assert.match(copied[0],/旧版本引用未完整/);assert.match(copied[0],/当前号主与本单原号主不同/);assert.doesNotMatch(copied[0],/NEW-2|frozen-version-2/);
 assert.match(copied[1],/NEW-2 · order-native/);assert.match(copied[1],/支付已记录/);assert.match(copied[1],/frozen-version-2/);assert.match(copied[1],/当前号主与本单原号主相同/);assert.doesNotMatch(copied[1],/OLD-1|original-owner/);
 h.browser.navigator.clipboard.writeText=async()=>{throw new Error('offline clipboard unavailable');};await h.click(buttons[0]);assert.equal(h.el.querySelector('.wf-handoff pre').textContent,copied[0]);assert.match(h.el.textContent,/最近选择的摘要后手动复制/);assert.equal(h.writes.length,0);
});
test('finish F2: denied order relation exposes no order copy action or original parties',async t=>{
 const value=data();const h=await mountHarness(t,{permissions:['supply.review.read'],isBoss:false,initialAccountId:'a',initialQuery:{context:'orders'},fetchImpl:async()=>response(value)});await settle(h);assert.ok(!h.btn('复制本单核对摘要'));assert.match(h.el.textContent,/没有订单读取权限/);assert.equal(h.writes.length,0);
});
