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

test('unrelated completed order history and archived metadata never turn an unknown account business state into completion', async t => {
  const value = workDetail(); value.supervision.facts.businessState = null; value.supervision.facts.lifecycle = 'ARCHIVED';
  value.supervision.orders.items = [{ id: 'unrelated-completed-order', displayNo: 'OLD-DONE', status: 'COMPLETED', ownerUserId: 'owner-a', ownerName: 'fixture owner', renterName: 'fixture renter', versionId: 'old-v', payment: { state: 'PAID' }, source: { origin: 'LEGACY' } }]; value.supervision.orders.total = 1;
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'situation' }, fetchImpl: async () => json(value) }); await tick(h);
  assert.equal(h.el.querySelector('header [data-account-status]').textContent, '状态待核'); assert.equal(h.writes.length, 0);
});

test('a blank account profile summarizes missing groups without pretending they are zero or false', async t => {
  const value = workDetail(); value.version.declaration.attributes = {}; value.version.declaration.inventory = []; value.version.quote = null; value.version.termOption = null;
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'situation' }, fetchImpl: async () => json(value) }); await tick(h);
  const body = h.el.querySelector('[data-account-profile]');
  assert.match(body.textContent, /下赛季通行证、德穆兰：尚未提供|本人脸声明、封禁记录声明、下赛季通行证、德穆兰：尚未提供/);
  assert.doesNotMatch(body.textContent, /不计划购买|未解锁|无封禁记录/);
  assert.equal(h.writes.length, 0);
});

test('account profile groups declarations, preserves private attribution and lets zero stock be inspected', async t => {
  const value = workDetail();
  value.version.declaration.attributes = { next_season_pass: false, demulan_unlocked: true, face_is_self: false, ban_record: true };
  value.version.management = { infoSource: { value: '朋友介绍', name: '朋友介绍' } };
  value.version.declaration.inventory = [{ itemId: 'zero', quantity: '0' }, { itemId: 'stock', quantity: '2' }, { itemId: 'unknown', quantity: null }];
  value.version.presentation.items = [{ id: 'zero', name: '零库存探针', unit: 'PIECE' }, { id: 'stock', name: '正库存探针', unit: 'PIECE' }, { id: 'unknown', name: '未知库存探针', unit: 'PIECE' }];
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'situation' }, fetchImpl: async () => json(value) }); await tick(h);
  const body = h.el.querySelector('.supervision-detail-body');
  assert.match(body.textContent, /下赛季通行证不计划购买/); assert.match(body.textContent, /德穆兰已解锁/); assert.match(body.textContent, /了解渠道（内部）朋友介绍/);
  assert.match(body.textContent, /正库存探针/); assert.match(body.textContent, /未知库存探针/); assert.doesNotMatch(body.textContent, /零库存探针/);
  assert.match(body.querySelector('[aria-label="基础报价"]').textContent, /基础总价/);
  await h.click(h.el.querySelector('[aria-label="显示零数量项"]')); assert.match(body.textContent, /零库存探针/);
  assert.deepEqual(value.version.declaration.inventory.map(item => item.quantity), ['0', '2', null]); assert.equal(h.writes.length, 0);
});
test('detail pane renders declaration, catalog resources and quote lines', async t => {
  const value = detail({ ...accountA, display_no: 'TEST-A', owner_user_id: 'owner-a' }, 'PUBLISHED');
  value.version.declaration.attributes = { ...value.version.declaration.attributes, face_is_self: false, ban_record: true };
  value.version.declaration.inventory = [{ itemId: 'barrett', quantity: '2' }];
  value.version.presentation.items = [];
  value.version.catalogItems = [{ id: 'barrett', name: '巴雷特', unit: 'ROUND', code: 'df_billable_barrett_bullet' }];
  value.version.quote.lines = [{ itemId: 'barrett', quantity: '2', unit: 'ROUND', buyerAmount: { amount: '1.00' } }];
  value.supervision = { historical: false, facts: { publicVisible: true, newOrders: true, reasons: [], ownerPaused: false, staffRestricted: false, occupancy: 'FREE', publicSource: 'NATIVE_PUBLICATION', sources: [], legacyNumbers: [] }, changes: null, previousVersion: null, restrictionHistory: { state: 'NOT_RECORDED', items: [], limit: 20 }, ownerLink: { state: 'READY', userId: 'owner-a' }, orders: { state: 'READY', items: [], total: 0 } };
  value.contextKey = 'fixture-context';
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'archive' }, fetchImpl: async () => json(value) });
  await tick(h);
  assert.match(h.el.textContent, /号主声明非本人脸/);
  assert.match(h.el.textContent, /号主声明有封禁记录/);
  assert.match(h.el.textContent, /巴雷特/);
  assert.match(h.el.textContent, /¥1\.00/);
  assert.equal(h.el.querySelectorAll('[data-resource-billing] table').length, 1);
  assert.deepEqual([...h.el.querySelector('[data-resource-billing] thead').querySelectorAll('th')].map(node => node.textContent), ['物资', '数量', '单位', '计价基数', '单价', '行额']);
});

test('skin grid shows only image, name and factual quality badges without repeating classification metadata', async t => {
  const value = workDetail();
  value.version.presentation.skins = [{ id: 'skin1', name: '可读外观', ownerKind: 'AGENT', rarityName: '传说', rarityBasis: 'PLATFORM_REFERENCE', isCollectible: true, defaultState: 'DEFAULT' }, { id: 'skin2', name: '未定品质外观', ownerKind: 'MELEE_TYPE', rarityName: null, isCollectible: false, defaultState: 'NON_DEFAULT' }];
  value.version.declaration.skins = ['skin1', 'skin2'];
  const original = JSON.stringify(value.version.presentation.skins);
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'situation' }, fetchImpl: async () => json(value) }); await tick(h);
  const list = h.el.querySelector('[data-skin-list]'); assert(list);
  assert.match(list.textContent, /可读外观传说（平台参考）/); assert.match(list.textContent, /未定品质外观品质未知/);
  assert.doesNotMatch(list.textContent, /干员|近战外观|典藏|默认/);
  assert.equal(list.querySelectorAll('[data-slot="badge"]').length, 2);
  assert.equal(JSON.stringify(value.version.presentation.skins), original); assert.equal(h.writes.length, 0);
});

test('current profile has one secondary source entry and retains the complete historical record there', async t => {
  const value = workDetail();
  value.supervision.facts.sources = [{ sourceSystem: 'fixture-legacy', sourceEntity: 'account', sourceId: 'source-123', businessNo: 'OLD-123' }];
  value.supervision.facts.legacyNumbers = ['OLD-123'];
  value.supervision.facts.historicalRead = { resourceNo: 'OLD-123', historicalQuote: { haffRentYuan: '12.30', goodsYuan: '0.00', depositYuan: '1.00', termDays: '2', dailyHaffBase: '1000000' }, display: { state: 'KNOWN', facts: { attributes: { character_level: 0 }, resources: [{ code: 'historical-material', name: '唯一旧物资', quantity: null, unit: 'PIECE' }], attributeDisplay: {}, sourceUpdatedAt: '2026-09-01T00:00:00Z' } } };
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'situation' }, fetchImpl: async () => json(value) }); await tick(h);
  assert.doesNotMatch(h.el.textContent, /唯一旧物资|OLD-123|来源记录/);
  await h.click(h.btn('操作记录')); await tick(h);
  const trigger = h.btn('来源与迁入前记录'); assert(trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await h.click(trigger); await tick(h);
  assert.match(h.el.textContent, /fixture-legacy\/account.*source-123/); assert.match(h.el.textContent, /历史编号 OLD-123/);
  assert.match(h.el.textContent, /角色等级0 级/); assert.match(h.el.textContent, /唯一旧物资数量待核/); assert.match(h.el.textContent, /¥12\.30/);
  assert.equal(h.el.querySelectorAll('[data-imported-account]').length, 1); assert.equal(h.writes.length, 0);
});

test('same account follows an external version and section selection while dirty review text blocks replacement', async t => {
  const reads = [];
  const h = await mountHarness(t, { permissions, initialAccountId: 'a', initialQuery: { context: 'situation' }, fetchImpl: async url => {
    reads.push(url.searchParams.get('versionId')); const value = workDetail(); value.version.id = url.searchParams.get('versionId') ?? 'current-version'; return json(value);
  } }); await tick(h);
  await h.render('admin', permissions, 'a', { context: 'changes', versionId: 'selected-version', fromUserId: 'source-user' }); await tick(h);
  assert.equal(h.el.querySelector('#supply-detail-title').dataset.versionId, 'selected-version'); assert(h.el.querySelector('[data-account-media-review]'));
  await h.fillReason('保留这次图片核对说明'); const count = reads.length;
  await h.render('admin', permissions, 'a', { context: 'orders', versionId: 'different-version', fromOrderId: 'source-order' }); await tick(h);
  assert.equal(reads.length, count); assert.equal(h.el.querySelector('#supply-detail-title').dataset.versionId, 'selected-version');
  assert.equal(h.el.querySelector('textarea').value, '保留这次图片核对说明'); assert(h.el.querySelector('[data-account-media-review]')); assert.equal(h.writes.length, 0);
});

test('image review keeps one owner action and the duplicate form opens only on request', async t => {
  const value = workDetail();
  const h = await mountHarness(t, { permissions: [...permissions, 'supply.duplicate.review'], initialAccountId: 'a', initialQuery: { context: 'changes' }, fetchImpl: async url => url.pathname.endsWith('/listing-reviews') ? json(page([])) : json(value) }); await tick(h);
  assert.equal([...h.el.querySelectorAll('button')].filter(button => /查看.*号主资料/.test(button.textContent)).length, 1);
  assert.equal(h.el.querySelector('[aria-label="关联队列中的另一个账号"]'), null);
  const trigger = h.btn('疑似重复线索'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await h.click(trigger); await tick(h); assert(h.el.querySelector('[aria-label="关联队列中的另一个账号"]'));
  assert.equal(h.el.querySelector('textarea').getAttribute('rows'), '4'); assert(h.btn('记录关联线索').disabled); assert.equal(h.writes.length, 0);
});

for (const [label, readPermissions, access] of [
  ['rental detail reader', ['supply.rental_account.read'], 'DENIED'],
  ['legacy rental response without management field', ['supply.rental_account.read'], undefined],
  ['explicit management denial overrides a review snapshot', permissions, 'DENIED'],
]) test(label + ' reads the account without management queries or media fallback', async t => {
  const value = workDetail(), reads = [];
  value.supervision.managementAccess = access; value.supervision.restrictionHistory = { state: 'DENIED', items: [], limit: 0 };
  value.version.management = { infoSource: { name: '内部来源不得显示' } };
  value.version.declaration.mediaBindings[0].publicUrl = '/public/same-account-display';
  value.version.declaration.mediaBindings[0].publiclyReadable = true;
  const h = await mountHarness(t, { permissions: readPermissions, isBoss: false, initialAccountId: 'a', initialQuery: { context: 'changes', fromUserId: 'owner-a' }, fetchImpl: async url => { reads.push(url.pathname); return json(value); } }); await tick(h);
  assert(h.el.querySelector('[data-account-profile]')); assert.equal(reads.length, 1); assert.equal(reads[0], '/api/bff/admin/supply/listing-reviews/a');
  assert.doesNotMatch(h.el.textContent, /内部来源不得显示|审核与图片|版本与审核记录|没有更早的资料记录|尚无审核记录|新增运营限制|返回账号供给|回原工作视图继续查看|私有凭证/);
  assert.equal(h.btn('操作记录'), undefined);
  assert.deepEqual([...h.el.querySelectorAll('.supervision-detail-body img')].map(img => img.getAttribute('src')), ['/public/same-account-display']);
  assert.equal(h.el.querySelector('img[src^="/api/bff/admin/supply/media/"]'), null);
  await h.click(h.btn('放大核对 展示图 1')); await tick(h);
  assert.equal(h.el.querySelector('[data-account-image] img').getAttribute('src'), '/public/same-account-display');
  assert.equal(h.writes.length, 0);
});

test('rental permission never opens the supervision list and unreadable media does not acquire a management URL', async t => {
  let reads = 0; const value = workDetail(); value.supervision.managementAccess = 'DENIED';
  const h = await mountHarness(t, { permissions: ['supply.rental_account.read'], isBoss: false, fetchImpl: async () => { reads++; return json(value); } }); await tick(h);
  assert.equal(reads, 0); assert.match(h.el.textContent, /没有账号供给读取权限/);
  await h.render('admin', ['supply.rental_account.read'], 'a', { context: 'records' }); await tick(h);
  assert.equal(reads, 1); assert.match(h.el.textContent, /未提供可公开读取的展示图/);
  assert.equal(h.el.querySelector('.supervision-detail-body img'), null); assert.equal(h.writes.length, 0);
});

test('StrictMode discards an aborted old query after a work view changes',async t=>{
 const deferred=[];const h=await mountHarness(t,{permissions,strict:true,fetchImpl:async url=>{if(url.searchParams.get('view')==='paused')return json(page([item('b',true)]));return await new Promise(resolve=>deferred.push(()=>resolve(json(page([item('a')])))));}});
 await h.click(h.btn('号主暂停'));await tick(h);for(const finish of deferred)finish();await tick(h);
 assert.ok(h.el.textContent.includes('TEST-b'));assert.ok(!h.el.textContent.includes('TEST-a'));assert.equal(h.writes.length,0);
});
test('UNKNOWN freezes original request and acknowledged write recovers by GET only',async t=>{
 let posted=false,attempt=0,failRead=false;const h=await prepare(t,async(url,init)=>{if(init.method==='POST'){if(++attempt===1)throw new Error('fixture unknown transport');posted=true;failRead=true;return json({accepted:true});}if(failRead){failRead=false;return failure(500);}return json(workDetail(posted));});
 await confirm(h);await tick(h);assert.equal(h.writes.length,1);assert.ok(h.el.textContent.includes('结果未确认'));assert.ok([...h.el.querySelectorAll('[data-slot="dialog-content"] textarea')].every(e=>e.disabled));
 await h.render('admin',permissions,'a',{context:'orders',versionId:'external-other-version',fromOrderId:'external-order'});await tick(h);assert.ok(h.el.textContent.includes('结果未确认'));assert.equal(h.writes.length,1);assert.equal(h.el.querySelector('#supply-detail-title').dataset.versionId,'v-a');
 await confirm(h);await tick(h);assert.equal(h.writes.length,2);assert.equal(h.writes[0].key,h.writes[1].key);assert.equal(h.writes[0].rawBody,h.writes[1].rawBody);assert.equal(h.writes[0].path,h.writes[1].path);
 assert.ok(h.el.textContent.includes('只重读本次结果'));assert.equal(h.el.querySelectorAll('[data-slot="dialog-content"]').length,0);
 await h.click(h.btn('只重读本次结果'));await tick(h);assert.equal(h.writes.length,2);assert.ok(h.el.textContent.includes('解除影响'));
});
test('409 permanently invalidates the old confirmation and requires a new review',async t=>{
 const h=await prepare(t,async(url,init)=>init.method==='POST'?failure(409):json(workDetail()));await confirm(h);await tick(h);assert.equal(h.writes.length,1);
 assert.ok(h.btn('确认施加运营限制').disabled);await h.click(h.btn('返回核对（保留原因）'));await tick(h);assert.equal(h.el.querySelectorAll('[data-slot="dialog-content"]').length,0);assert.equal(h.writes.length,1);
});
test('an identity/permission switch clears UNKNOWN and historical page stays zero-write',async t=>{
 const h=await prepare(t,async(url,init)=>init.method==='POST'?failure(500):json(workDetail()));await confirm(h);await tick(h);assert.ok(h.el.querySelector('[data-slot="dialog-content"]'));
 await h.render('different-admin',['supply.review.read'],'a',{context:'review'});await tick(h);assert.equal(h.el.querySelectorAll('[data-slot="dialog-content"]').length,0);assert.ok(!h.btn('核对后确认运营限制'));assert.equal(h.writes.length,1);
 const old=workDetail(false,true);globalThis.fetch=async()=>json(old);await h.render('history-admin',permissions,'a',{context:'review',versionId:'v-old'});await tick(h);assert.ok(h.btn('核对后确认运营限制').disabled);await h.click(h.btn('核对后确认运营限制'));await tick(h);assert.equal(h.writes.length,1);
});

test('FLOW02 Root F2: public publication time comes only from the original basis, including unknown',async t=>{
 const d=workDetail();d.version.id='current-v3';d.version.declaration.title='Current private v3';d.version.publication={source:'OWNER_DIRECT',publishedAt:'2026-10-24T01:02:03Z'};
 d.supervision.facts={...d.supervision.facts,publicVersionId:'public-v1',publicBasis:{id:'public-v1',accountId:'a',releaseId:'release-v1',title:'Original public v1',description:null,attributes:{},presentation:{items:[],skins:[],entitlements:[]},media:[],quote:null,termOption:null,fullPayoutSelected:null,publishedAt:'2026-10-21T01:02:03Z'}};
 const h=await mountHarness(t,{permissions,initialAccountId:'a',initialQuery:{context:'situation'},fetchImpl:async()=>json(d)});await tick(h);
 const publication=()=>{const section=h.el.querySelector('[aria-label="租客当前看到的版本"]'),label=[...section.querySelectorAll('dt')].find(node=>node.textContent==='发布时间');assert(label,'public publication field is present');return label.nextElementSibling.textContent;};
 assert.match(publication(),/2026.10.21/);assert.doesNotMatch(publication(),/2026.10.24/);
 d.supervision.facts.publicBasis.publishedAt=null;await h.render('admin',permissions,'a',{context:'situation'},1);await tick(h);assert.match(publication(),/未提供|未知/);assert.doesNotMatch(publication(),/2026.10.24/);assert.equal(h.writes.length,0);
});
