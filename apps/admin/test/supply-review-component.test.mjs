import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountA,detail,mountHarness} from './supply-review-fixture.mjs';
const permissions=['supply.review.read','supply.restrict','supply.review.decide','order.read','user.directory.read'];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const failure=(status)=>json({error:{code:status===409?'CONFLICT':'INTERNAL_ERROR'}},status);
function workDetail(restricted=false,historical=false){const result=detail({...accountA,display_no:'TEST-A',owner_user_id:'owner-a',staff_restricted:restricted},'PUBLISHED');result.version.declaration.mediaBindings[0].byteHash='a'.repeat(64);result.version.declaration.mediaBindings[0].mediaRevision='2';result.supervision={historical,facts:{publicVisible:!restricted,newOrders:!restricted,reasons:restricted?['STAFF_RESTRICTED']:[],ownerPaused:false,staffRestricted:restricted,occupancy:'FREE',publicSource:'NATIVE_PUBLICATION',sources:[],legacyNumbers:[]},changes:null,previousVersion:null,restrictionHistory:{state:'NOT_RECORDED',items:[],limit:20},ownerLink:{state:'READY',userId:'owner-a'},orders:{state:'READY',items:[],total:0}};result.contextKey='fixture-context';if(historical)result.blockers=['HISTORICAL_VERSION'];return result;}
const item=(id,paused=false)=>({id,accountId:id,displayNo:'TEST-'+id,ownerId:'owner-'+id,ownerName:'fixture owner',revision:'7',gameName:'fixture game',versionId:'v-'+id,sequence:'1',title:'fixture account',reviewState:'PUBLISHED',sortAt:'2026-10-03T00:00:00.000000Z',facts:{...workDetail().supervision.facts,ownerPaused:paused,publicVisible:!paused,newOrders:!paused,reasons:paused?['OWNER_PAUSED']:[]}});
const page=items=>({contractVersion:'admin-supervision.read.v1',contextKey:'fixture-context',items,nextCursor:null,stationOrigins:{admin:'http://127.0.0.1:4291',user:'http://127.0.0.1:4290'},games:[]});
const tick=async h=>{for(let i=0;i<5;i++)await h.settle();};
async function prepare(t,fetchImpl,options={}){const h=await mountHarness(t,{permissions,initialAccountId:'a',initialQuery:{context:'review'},fetchImpl,strict:true,...options});await tick(h);await h.fillReason('fixture: verify account/version and retain independent blockers');await h.click(h.btn('核对后确认运营限制'));await tick(h);return h;}
const confirm=h=>h.click(h.btn('确认'+ '施加运营限制'));
test('StrictMode discards an aborted old query after a work view changes',async t=>{
 const deferred=[];const h=await mountHarness(t,{permissions,strict:true,fetchImpl:async url=>{if(url.searchParams.get('view')==='paused')return json(page([item('b',true)]));return await new Promise(resolve=>deferred.push(()=>resolve(json(page([item('a')])))));}});
 await h.click(h.btn('号主暂停'));await tick(h);for(const finish of deferred)finish();await tick(h);
 assert.ok(h.el.textContent.includes('TEST-b'));assert.ok(!h.el.textContent.includes('TEST-a'));assert.equal(h.writes.length,0);
});
test('UNKNOWN freezes original request and acknowledged write recovers by GET only',async t=>{
 let posted=false,attempt=0,failRead=false;const h=await prepare(t,async(url,init)=>{if(init.method==='POST'){if(++attempt===1)throw new Error('fixture unknown transport');posted=true;failRead=true;return json({accepted:true});}if(failRead){failRead=false;return failure(500);}return json(workDetail(posted));});
 await confirm(h);await tick(h);assert.equal(h.writes.length,1);assert.ok(h.el.textContent.includes('结果未确认'));assert.ok([...h.el.querySelectorAll('dialog textarea')].every(e=>e.disabled));
 await confirm(h);await tick(h);assert.equal(h.writes.length,2);assert.equal(h.writes[0].key,h.writes[1].key);assert.equal(h.writes[0].rawBody,h.writes[1].rawBody);assert.equal(h.writes[0].path,h.writes[1].path);
 assert.ok(h.el.textContent.includes('只重读本次结果'));assert.equal(h.el.querySelectorAll('dialog').length,0);
 await h.click(h.btn('只重读本次结果'));await tick(h);assert.equal(h.writes.length,2);assert.ok(h.el.textContent.includes('解除影响'));
});
test('409 permanently invalidates the old confirmation and requires a new review',async t=>{
 const h=await prepare(t,async(url,init)=>init.method==='POST'?failure(409):json(workDetail()));await confirm(h);await tick(h);assert.equal(h.writes.length,1);
 assert.ok(h.btn('确认施加运营限制').disabled);await h.click(h.btn('返回核对（保留原因）'));await tick(h);assert.equal(h.el.querySelectorAll('dialog').length,0);assert.equal(h.writes.length,1);
});
test('an identity/permission switch clears UNKNOWN and historical page stays zero-write',async t=>{
 const h=await prepare(t,async(url,init)=>init.method==='POST'?failure(500):json(workDetail()));await confirm(h);await tick(h);assert.ok(h.el.querySelector('dialog'));
 await h.render('different-admin',['supply.review.read'],'a',{context:'review'});await tick(h);assert.equal(h.el.querySelectorAll('dialog').length,0);assert.ok(!h.btn('核对后确认运营限制'));assert.equal(h.writes.length,1);
 const old=workDetail(false,true);globalThis.fetch=async()=>json(old);await h.render('history-admin',permissions,'a',{context:'review',versionId:'v-old'});await tick(h);assert.ok(h.btn('核对后确认运营限制').disabled);await h.click(h.btn('核对后确认运营限制'));await tick(h);assert.equal(h.writes.length,1);
});
