import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act,createElement,StrictMode,useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { tabFromLocation,persistTabs } from '../src/workspace/tab-model.ts';

const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=new Window({url:'http://127.0.0.1:4291/users'});let width=1440;const media=new Set();
browser.matchMedia=query=>{const handlers=new Set();const match={media:query,get matches(){const max=query.match(/max-width:\s*(\d+)px/);return max?width<=Number(max[1]):false;},addEventListener:(_e,fn)=>handlers.add(fn),removeEventListener:(_e,fn)=>handlers.delete(fn),addListener:fn=>handlers.add(fn),removeListener:fn=>handlers.delete(fn)};media.add({match,handlers});return match;};
Object.defineProperty(browser,'innerWidth',{get:()=>width,configurable:true});
for(const name of ['window','document','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','ResizeObserver','localStorage','sessionStorage'])globalThis[name]=name==='window'?browser:browser[name];
Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const vite=await createServer({root:rootPath,configFile:false,plugins:[react()],resolve:{alias:{'@':path.join(rootPath,'src'),'@brand':path.resolve(rootPath,'../../assets/brand')}},server:{middlewareMode:true,hmr:false}});
const {UserDirectoryView}=await vite.ssrLoadModule('/src/views/user-directory/user-directory-view.tsx');
const {UserDetail}=await vite.ssrLoadModule('/src/views/user-directory/user-directory-detail.tsx');
const {DateSelector}=await vite.ssrLoadModule('/src/components/reui/date-selector.tsx');
const {UserDirectoryBff,EMPTY_FILTERS}=await vite.ssrLoadModule('/src/views/user-directory/user-directory-data.ts');
after(async()=>{await vite.close();await browser.happyDOM.abort();});
const permissions=['user.directory.read','user.phone.lookup','order.read','supply.rental_account.read','admin.audit.read','user.account.restore','im.support.read'];
let serial=0;
const user={userId:'user_normal',name:'林舟',image:null,username:null,displayUsername:null,maskedPhone:'188****1101',accountStatus:'ACTIVE',suspended:false,identityStatus:'UNKNOWN',ageStatus:'UNKNOWN',source:{kind:'MIGRATED',legacyId:'88001'},registeredAt:'2026-09-24T04:00:00Z',registeredAtSource:'LOCAL',createdAt:'2026-09-24T04:00:00Z',updatedAt:'2026-09-24T04:00:00Z',localCreatedAt:'2026-09-24T04:00:00Z',resourceSummary:{state:'ready',count:1,publishedCount:1},orderSummary:{state:'ready',currentCount:1},lastBusinessActivity:{state:'not_connected',domains:['ORDER','SUPPLY']}};
const detail={...user,maskedEmail:null,phoneNumberVerified:false,identity:{status:'UNKNOWN',ageStatus:'UNKNOWN',provider:'legacy_mysql_restore',verifiedAt:null},source:{kind:'MIGRATED',legacyId:'88001',sourceCreatedAt:'2019-01-01T00:00:00Z',sourceUpdatedAt:null},localUpdatedAt:user.updatedAt};
const order={orderId:'order_cancel',displayNo:'TEST-1003',status:'CANCELLED',role:'renter',title:'订单快照',counterpartyName:'另一方',gameId:'delta',amounts:{rental:{currency:'CNY',unit:'yuan',amount:'60.00',scale:2},deposit:{currency:'CNY',unit:'yuan',amount:'100.00',scale:2},totalDue:{currency:'CNY',unit:'yuan',amount:'160.00',scale:2}},createdAt:user.createdAt,paidAt:'2026-09-19T02:05:00Z',cancelledAt:user.createdAt,cancelReason:'支付后取消',expiredAwaitingCancel:false};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const failure=(status)=>json({error:{code:status===409?'CONFLICT':status===403?'FORBIDDEN':status===401?'UNAUTHENTICATED':'INTERNAL_ERROR'}},status);
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});}
async function waitFor(fn,timeout=3000){const until=Date.now()+timeout;while(!fn()){if(Date.now()>until)throw new Error('Component condition timed out');await settle();}}
const namedButton=name=>[...browser.document.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')||e.textContent.trim())===name);
async function click(element){assert.ok(element);await act(async()=>element.dispatchEvent(new browser.MouseEvent('click',{bubbles:true,cancelable:true})));await settle();}
async function key(element,key){await act(async()=>{element.focus();element.dispatchEvent(new browser.KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true}));});await settle();}
async function input(element,value){await act(async()=>{Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?browser.HTMLTextAreaElement.prototype:browser.HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new browser.Event('input',{bubbles:true}));element.dispatchEvent(new browser.Event('change',{bubbles:true}));});await settle();}
async function resize(value){await act(async()=>{width=value;for(const {match,handlers} of media)for(const handler of handlers)handler({matches:match.matches,media:match.media});});await settle();}
async function mount(t,options={}) {
  width=options.width??1440;media.clear();browser.sessionStorage.clear();browser.localStorage.clear();browser.history.replaceState(null,'',options.path??'/users');
  const calls=[];let restored=false;let readbackFailures=options.detailErrorAfterRestore?1:0;
  const snapshot={authenticated:true,adminUserId:`test-admin-${++serial}`,user:{name:'测试管理员',username:'ZZ00001',twoFactorEnabled:true},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},session:{id:`test-session-${serial}`,locked:false,pinConfigured:true,createdAt:null,expiresAt:null},permissions:options.permissions??permissions};
  globalThis.fetch=async(url,init={})=>{
    const address=new URL(String(url),browser.location.href);calls.push({url:String(url),method:init.method??'GET',body:init.body?JSON.parse(init.body):undefined,signal:init.signal});
    if(options.fetch)return options.fetch(address,init);
    if(address.pathname==='/api/bff/admin/users'||address.pathname.endsWith('/lookup'))return json({items:options.empty?[]:[{...user,...(snapshot.permissions.includes('supply.rental_account.read')?{}:{resourceSummary:{state:'denied',permission:'supply.rental_account.read'}}),...(snapshot.permissions.includes('order.read')?{}:{orderSummary:{state:'denied',permission:'order.read'}})}],nextCursor:options.next?'NEXT':null,limit:20});
    if(address.pathname.endsWith('/orders'))return options.ordersError?failure(503):json({items:options.orders??[order,{...order,orderId:'order_paid',status:'PAID',paidAt:null,role:'owner'},{...order,orderId:'order_complete',status:'COMPLETED',paidAt:null}],nextCursor:null});
    if(address.pathname.endsWith('/rental-accounts'))return json({items:[],nextCursor:null});
    if(address.pathname.endsWith('/audit-events'))return json({items:[],nextCursor:null});
    if(address.pathname.endsWith('/membership-growth'))return json({subjectId:address.pathname.split('/')[4]||'user_normal',growth:{knowledge:'KNOWN',sourceState:'COMPLETE',benefitsState:'CONFIGURED',normalTier:'GOLD',effectiveTier:'GOLD',blackGold:'NOT_QUALIFIED',grace:null},entitlements:[{id:'ent-1',kind:'FRIEND',scopeKey:'friend',startsAtUtc:'2026-01-01T00:00:00Z',endsAtUtc:'2026-12-31T23:59:59Z',status:'ACTIVE',label:'密友礼遇',depositWaived:true}]});
    if(address.pathname.includes('/finance/subjects/'))return json({wallet:{buckets:{available:{amountCents:'15000',knowledge:'KNOWN'},reserved:{amountCents:'5000',knowledge:'KNOWN'},restricted:{amountCents:'0',knowledge:'KNOWN'},pendingEarnings:{amountCents:'2000',knowledge:'KNOWN'},refundPayable:{amountCents:'0',knowledge:'KNOWN'}},withdrawable:{amountCents:'15000',reasonCodes:[]},coverage:{knowledge:'KNOWN',cutoff:'2026-10-18T00:00:00Z'}}});
    if(address.pathname==='/api/bff/admin/security/users/restore'){if(options.restore==='pending')throw new Error('Injected response loss');if(typeof options.restore==='number')return failure(options.restore);restored=true;return json({status:'ACTIVE'});}
    if(restored&&readbackFailures>0){readbackFailures-=1;return failure(options.detailErrorAfterRestore);}
    if(options.detailError)return failure(options.detailError);
    return json({user:{...detail,userId:address.pathname.split('/').at(-1),accountStatus:restored?'ACTIVE':options.status??detail.accountStatus}});
  };
  const container=browser.document.createElement('div');browser.document.body.appendChild(container);const root=createRoot(container);let switchSnapshot;
  function Harness(){const [tab,setTab]=useState(tabFromLocation(browser.location.pathname,browser.location.search));const [actor,setActor]=useState(snapshot);switchSnapshot=setActor;return createElement(UserDirectoryView,{snapshot:actor,tab,refreshNonce:0,onQueryChange:query=>{const next={...tab,query};persistTabs(actor.adminUserId,{tabs:[tabFromLocation('/users'),next],activeId:next.id});const params=new URLSearchParams(query).toString();browser.history.replaceState(null,'',next.path+(params?'?'+params:''));setTab(next);},onOpenPath:path=>{const target=new URL(path,browser.location.href);browser.history.pushState(null,'',path);setTab(tabFromLocation(target.pathname,target.search));}});}
  t.after(async()=>{await act(async()=>root.unmount());container.remove();await settle();});
  await act(async()=>root.render(createElement(StrictMode,null,createElement(Harness))));await settle();
  return {calls,snapshot,switchActor:async(value)=>{await act(async()=>switchSnapshot(value));await settle();}};
}

test('ordinary BFF list removes user classifications and shows canonical dates, explicit activity gap and source',async t=>{
  const {calls}=await mount(t);await waitFor(()=>browser.document.querySelector('tbody tr'));
  assert.ok(calls.every(call=>call.url.startsWith('/api/bff/admin/')));
  assert.deepEqual([...browser.document.querySelectorAll('th')].map(e=>e.textContent),['用户','账号与实名','会员与礼遇','信用↕','可用余额↕','当前业务租入↕出租↕上架↕','注册时间↓','操作']);
  const text=browser.document.querySelector('.ud-directory').textContent;assert.equal(text.includes('业务关系'),false);assert.equal(text.includes('租客'),false);assert.equal(text.includes('号主'),false);
  assert.equal(text.includes('业务活动暂未接入'),false,'the list no longer repeats a not-connected notice');
  const toolbar=browser.document.querySelector('.ud-directory').textContent;for(const label of ['业务关系','有无订单','有无资源','年龄状态'])assert.equal(toolbar.includes(label),false);
  assert.equal(namedButton('更多筛选'),undefined,'the filter drawer is gone; filters sit inline in the toolbar');
  for(const label of ['账号状态','注册日期','实名状态','来源','会员等级','有效礼遇','信用','内部标识'])assert.ok(toolbar.includes(label),`inline filter ${label}`);
});

test('desktop row and Enter open Drawer; only CTA navigates, viewport changes never create a detail',async t=>{
  await mount(t);await waitFor(()=>browser.document.querySelector('tbody tr'));const row=()=>browser.document.querySelector('tbody tr');
  await key(row(),'Enter');await waitFor(()=>namedButton('打开完整详情'));assert.equal(browser.location.pathname,'/users');
  await key(browser.document.activeElement,'Escape');await waitFor(()=>!browser.document.querySelector('.ud-drawer'));
  await click(row());await waitFor(()=>namedButton('打开完整详情'));await resize(390);await resize(1440);assert.equal(browser.location.pathname,'/users');
  await click(row());await waitFor(()=>namedButton('打开完整详情'));await click(namedButton('打开完整详情'));await waitFor(()=>browser.document.querySelector('.ud-detail h1'));
  assert.equal(browser.location.pathname,'/users/user_normal');assert.equal(browser.document.activeElement,browser.document.querySelector('.ud-detail h1'));
  await click(namedButton('返回列表'));await waitFor(()=>browser.document.querySelector('tbody tr'));assert.equal(browser.location.pathname,'/users');
});

test('390 cards expose their own takeover CTA, with no desktop table and no unsolicited Drawer',async t=>{
  await mount(t,{width:390});await waitFor(()=>browser.document.querySelector('.ud-mobile-row'));assert.equal(browser.document.querySelector('table'),null);assert.equal(browser.document.querySelector('.ud-drawer'),null);
  await click(namedButton('查看用户 林舟 详情'));await waitFor(()=>browser.document.querySelector('.ud-detail'));assert.equal(browser.location.pathname,'/users/user_normal');assert.equal(browser.document.querySelector('.ud-drawer'),null,'only the card CTA creates the detail, browsing never opens a Drawer');
});

test('phone search uses a body, never URL/storage, and no permission executes no lookup',async t=>{
  const {calls}=await mount(t);await waitFor(()=>browser.document.querySelector('tbody tr'));await input(browser.document.querySelector('[aria-label="查找用户"]'),'18800001101');await click(namedButton('查询'));await waitFor(()=>calls.some(call=>call.url==='/api/bff/admin/users/lookup'));
  const lookup=calls.find(call=>call.url==='/api/bff/admin/users/lookup');assert.equal(lookup.method,'POST');assert.equal(lookup.body.phone,'18800001101');assert.ok(calls.every(call=>!call.url.includes('18800001101')));assert.equal(browser.location.href.includes('18800001101'),false);assert.equal(JSON.stringify(Array.from({length:browser.sessionStorage.length},(_,i)=>browser.sessionStorage.getItem(browser.sessionStorage.key(i)))).includes('18800001101'),false);
});

test('no domain permissions never fetch or display counts, orders, internal IDs or audit',async t=>{
  const {calls}=await mount(t,{permissions:['user.directory.read']});await waitFor(()=>browser.document.querySelector('tbody tr'));assert.ok(browser.document.querySelector('tbody').textContent.includes('无权限'));await click(browser.document.querySelector('tbody tr'));await waitFor(()=>namedButton('打开完整详情'));assert.equal(namedButton('查看订单记录'),undefined);assert.equal(namedButton('查看资源账号'),undefined);assert.equal(calls.some(call=>/\/(orders|rental-accounts|audit-events)/.test(call.url)),false);
});

test('orders retain cancelled payment, PAID/COMPLETED missing-time warning and per-order participation',async t=>{
  await mount(t,{path:'/users/user_normal?section=orders'});await waitFor(()=>browser.document.querySelector('[data-order-id="order_cancel"]'));
  assert.ok(browser.document.querySelector('[data-order-id="order_cancel"]').textContent.includes('10:05'));for(const id of ['order_paid','order_complete'])assert.ok(browser.document.querySelector(`[data-order-id="${id}"]`).textContent.includes('支付时间待确认'));
  assert.ok(browser.document.querySelector('[data-order-id="order_cancel"]').textContent.includes('本单租用方'));assert.ok(browser.document.querySelector('[data-order-id="order_paid"]').textContent.includes('本单资源归属方'));
});

test('user order records label old account sources and preserve denied resource information',async t=>{
  const cases=[['0000123','旧来源号 0000123'],['ZZ20261018000001','账号 ZZ20261018000001'],['AC9000000000002','账号 AC9000000000002'],[null,'资源账号信息受限'],['','账号编号待核']];
  await mount(t,{path:'/users/user_normal?section=orders',orders:cases.map(([value],i)=>({...order,orderId:'number-'+i,accountDisplayNo:value}))});await waitFor(()=>browser.document.querySelector('[data-order-id="number-4"]'));
  cases.forEach(([,label],i)=>assert(browser.document.querySelector(`[data-order-id="number-${i}"]`).textContent.includes(label),label));
});

test('canonical registration is distinct from old-source trace, with seven sections and no membership',async t=>{
  await mount(t,{path:'/users/user_normal'});await waitFor(()=>browser.document.querySelector('.ud-detail'));const text=browser.document.querySelector('.ud-detail').textContent;assert.ok(text.includes('2026'));assert.equal(text.includes('2019'),false);assert.equal(text.includes('会员'),false);assert.deepEqual([...browser.document.querySelectorAll('.ud-sections button')].map(e=>e.textContent),['概览','订单记录','名下游戏账号','成长与礼遇','信用与保证金','资金','账号安全']);await click(namedButton('账号安全'));await waitFor(()=>browser.document.querySelector('.ud-trace'));assert.ok(browser.document.querySelector('.ud-trace').textContent.includes('2019'));
});

test('section failure does not block user detail; main-object failure has retry and no detail facts',async t=>{
  await mount(t,{path:'/users/user_normal?section=orders',ordersError:true});await waitFor(()=>browser.document.querySelector('.ud-message-error'));assert.ok(browser.document.querySelector('.ud-detail h1'));assert.ok(namedButton('概览'));assert.ok(namedButton('重试'));
});

test('primary object failure never renders detail navigation or stale user facts',async t=>{
  await mount(t,{path:'/users/user_normal',detailError:404});await waitFor(()=>browser.document.querySelector('.ud-message-error'));assert.equal(browser.document.querySelector('.ud-detail'),null);assert.ok(namedButton('返回列表'));
});

test('successful empty list is distinct from failure and denied',async t=>{
  await mount(t,{empty:true});await waitFor(()=>browser.document.querySelector('.ud-message-empty'));assert.ok(browser.document.querySelector('.ud-message-empty').textContent.includes('没有符合条件'));assert.equal(browser.document.querySelector('table'),null);
});

test('invalid local date range identifies the filter and never recommends API restart or unchanged retry',async t=>{
  const {calls}=await mount(t,{path:'/users?from=2026-10-01&to=2026-09-01'});await waitFor(()=>browser.document.querySelector('.ud-message-error'));
  const text=browser.document.querySelector('.ud-message-error').textContent;assert.ok(text.includes('筛选条件无效'));assert.ok(text.includes('注册起始日期不能晚于结束日期'));assert.equal(text.includes('API'),false);assert.equal(!!namedButton('重试'),false);assert.equal(calls.length,0);
});

for(const [name,outcome] of [['rejected',401],['conflict',409],['failed',503],['pending','pending']])test(`restore ${name} clears authentication inputs and keeps unknown outcome read-only`,async t=>{
  const {calls}=await mount(t,{path:'/users/user_restore?section=security',status:'DEACTIVATED',restore:outcome});await waitFor(()=>namedButton('账号恢复'));await click(namedButton('账号恢复'));
  await input(browser.document.querySelector('[aria-label="操作原因"]'),'仅合成测试原因');await input(browser.document.querySelector('[aria-label="管理员密码"]'),'Synthetic-Only-Password');await input(browser.document.querySelector('[aria-label="管理员 TOTP"]'),'123456');await click(namedButton('提交恢复'));await waitFor(()=>namedButton('重新读取账号状态'));
  assert.equal(browser.document.querySelector('[aria-label="管理员密码"]').value,'');assert.equal(browser.document.querySelector('[aria-label="管理员 TOTP"]').value,'');assert.equal(browser.location.href.includes('Synthetic'),false);assert.equal(JSON.stringify(Array.from({length:browser.sessionStorage.length},(_,i)=>browser.sessionStorage.getItem(browser.sessionStorage.key(i)))).includes('Synthetic'),false);
  assert.equal(calls.filter(call=>call.url.endsWith('/restore')).length,1);if(name==='pending'){assert.equal(namedButton('提交恢复'),undefined);assert.equal(browser.document.querySelector('.ud-restore-dialog').textContent.includes('检查 API 是否'),false);}
});

test('restore write success is not overwritten by readback failure and cannot resubmit',async t=>{
  const {calls}=await mount(t,{path:'/users/user_restore?section=security',status:'DEACTIVATED',detailErrorAfterRestore:503});await waitFor(()=>namedButton('账号恢复'));await click(namedButton('账号恢复'));
  await input(browser.document.querySelector('[aria-label="操作原因"]'),'仅合成测试原因');await input(browser.document.querySelector('[aria-label="管理员密码"]'),'Synthetic-Only-Password');await input(browser.document.querySelector('[aria-label="管理员 TOTP"]'),'123456');await click(namedButton('提交恢复'));
  await waitFor(()=>browser.document.querySelector('.ud-restore-dialog')?.textContent.includes('恢复请求已提交'));const dialog=browser.document.querySelector('.ud-restore-dialog');assert.ok(dialog);assert.equal(dialog.textContent.includes('恢复操作失败'),false);assert.equal(namedButton('提交恢复'),undefined);assert.equal(calls.filter(call=>call.url.endsWith('/restore')).length,1);
  await click(namedButton('重新读取账号状态'));await waitFor(()=>browser.document.querySelector('.ud-detail')?.textContent.includes('正常'));assert.equal(calls.filter(call=>call.url.endsWith('/restore')).length,1);
});

test('identity/permission changes abort old requests and reject old domain output',async t=>{
  let release;let count=0;const {snapshot,switchActor}=await mount(t,{fetch:async(address,init)=>{if(++count<=2)return new Promise(resolve=>{release=()=>resolve(json({items:[user],nextCursor:null,limit:20}));});return json({items:[{...user,name:'新身份范围',resourceSummary:{state:'denied',permission:'supply.rental_account.read'},orderSummary:{state:'denied',permission:'order.read'}}],nextCursor:null,limit:20});}});
  await switchActor({...snapshot,adminUserId:'different-admin',permissions:['user.directory.read']});await waitFor(()=>browser.document.querySelector('tbody tr'));if(release)release();await settle();assert.ok(browser.document.querySelector('tbody').textContent.includes('新身份范围'));assert.equal(browser.document.querySelector('tbody').textContent.includes('1 个进行中'),false);
});

test('U-LIST: displays total count from API and renders role-specific order entries', async t => {
  const customUser = {
    ...user,
    userId: 'user_both_roles',
    name: '周既租又租',
    orderSummary: { state: 'ready', currentCount: 3, renterCurrentCount: 1, ownerCurrentCount: 2 },
    resourceSummary: { state: 'ready', count: 4, publishedCount: 2 },
  };
  await mount(t, {
    fetch: async (address) => {
      if (address.pathname === '/api/bff/admin/users') {
        return json({ items: [customUser], total: 88, nextCursor: null, limit: 20 });
      }
      return json({ user: { ...detail, ...customUser } });
    }
  });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const text = browser.document.querySelector('.ud-directory').textContent;
  assert.ok(text.includes('共 88 位用户'));
  assert.ok(text.includes('共 88 位用户 · 已加载 1 条'));
  assert.ok(text.includes('租入 1'));
  assert.ok(text.includes('出租 2'));
  assert.equal(text.includes('共 3 个进行中'),false,'role counts are never summed into a de-duplicated total');
  assert.ok(text.includes('上架 2'),'the published count is its own number, not the archive count');

  const renterBtn = [...browser.document.querySelectorAll('button')].find(b => b.textContent.includes('租入 1'));
  assert.ok(renterBtn);
  await click(renterBtn);
  await waitFor(() => browser.location.pathname === '/users/user_both_roles');
  assert.ok(browser.location.search.includes('section=orders'));
  assert.ok(browser.location.search.includes('role=renter'));
  assert.ok(browser.location.search.includes('status=current'));
});

test('U-LIST: displays membership growth tier, policy unconfigured badge, and active entitlements', async t => {
  const memberUser = {
    ...user,
    userId: 'user_member',
    name: '会员用户',
    membershipSummary: {
      state: 'ready',
      asOfUtc: '2026-10-19T00:00:00Z',
      growth: {
        knowledge: 'KNOWN',
        sourceState: 'COMPLETE',
        benefitsState: 'NOT_CONFIGURED',
        normalTier: 'GOLD',
        effectiveTier: 'GOLD',
        blackGold: null,
        grace: null,
      },
      entitlements: [
        { id: 'ent-1', kind: 'FRIEND', scopeKey: 'friend', startsAtUtc: '2026-01-01T00:00:00Z', endsAtUtc: '2026-12-31T23:59:59Z', status: 'ACTIVE', label: '密友礼遇', depositWaived: true },
      ],
    },
  };
  await mount(t, {
    fetch: async () => json({ items: [memberUser], total: 1, nextCursor: null, limit: 20 })
  });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const rowText = browser.document.querySelector('tbody tr').textContent;
  assert.ok(rowText.includes('金卡会员'));
  assert.equal(rowText.includes('政策未配置'),false,'policy configuration is not a per-row fact in the list');
  assert.ok(rowText.includes('密友礼遇'));
});

test('U-LIST: membership UNKNOWN growth retains active entitlements and does not obscure them', async t => {
  const unknownGrowthUser = {
    ...user,
    userId: 'user_unknown_growth',
    name: '成长未知用户',
    membershipSummary: {
      state: 'ready',
      asOfUtc: '2026-10-19T00:00:00Z',
      growth: {
        knowledge: 'UNKNOWN',
        sourceState: 'BACKFILL_PENDING',
        benefitsState: 'CONFIGURED',
        normalTier: null,
        effectiveTier: 'UNKNOWN',
        blackGold: null,
        grace: null,
      },
      entitlements: [
        { id: 'ent-2', kind: 'PRESTIGE', scopeKey: 'prestige', startsAtUtc: '2026-01-01T00:00:00Z', endsAtUtc: '2026-12-31T23:59:59Z', status: 'ACTIVE', label: '黑金礼遇', depositWaived: true },
      ],
    },
  };
  await mount(t, {
    fetch: async () => json({ items: [unknownGrowthUser], total: 1, nextCursor: null, limit: 20 })
  });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const rowText = browser.document.querySelector('tbody tr').textContent;
  assert.ok(rowText.includes('等级待核'));
  assert.equal(rowText.includes('标准会员'),false,'an unknown tier never falls back to the lowest tier');
  assert.ok(rowText.includes('黑金礼遇'));
});

test('U-LIST: credit distinguishes KNOWN 0 score, NOT_INITIALIZED, and NO_GAME_SCOPE / OUT_OF_SCOPE', async t => {
  const users = [
    { ...user, userId: 'u_zero', name: '零分用户', creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 0, revision: '1' } },
    { ...user, userId: 'u_uninit', name: '未初始化用户', creditSummary: { state: 'ready', knowledge: 'NOT_INITIALIZED', score: null, revision: null } },
    { ...user, userId: 'u_noscope', name: '无范围用户', creditSummary: { state: 'denied', permission: 'credit.read', reason: 'NO_GAME_SCOPE' } },
    { ...user, userId: 'u_outscope', name: '越界用户', creditSummary: { state: 'denied', permission: 'credit.read', reason: 'OUT_OF_SCOPE' } },
  ];
  await mount(t, {
    fetch: async () => json({ items: users, total: 4, nextCursor: null, limit: 20 })
  });
  await waitFor(() => browser.document.querySelectorAll('tbody tr').length === 4);
  const rows = [...browser.document.querySelectorAll('tbody tr')].map(r => r.textContent);
  assert.ok(rows[0].includes('0 分'));
  assert.equal(rows[0].includes('版本 1'),false,'the concurrency revision number stays out of the list');
  assert.ok(rows[1].includes('未评分'));
  assert.equal(rows[1].includes('0 分'), false);
  assert.equal(rows[1].includes('100 分'), false);
  assert.ok(rows[2].includes('未分配业务范围'));
  assert.ok(rows[3].includes('无对象权限'));
});

test('R1: the registration range sends a Beijing day start and the next-day exclusive upper bound', async t => {
  const { calls,snapshot } = await mount(t);
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const adapter=new UserDirectoryBff(snapshot),signal=new AbortController().signal;
  await adapter.list({...EMPTY_FILTERS,from:'2026-10-18',to:'2026-10-18'},{page:1,pageSize:20},signal);
  const listCall = calls.find(c => c.url.includes('registeredFrom'));
  const url = new URL(listCall.url, 'http://127.0.0.1:4291');
  assert.equal(url.searchParams.get('registrationTime'),'ORIGINAL');
  assert.equal(url.searchParams.get('registeredFrom'), '2026-10-18T00:00:00+08:00');
  assert.equal(url.searchParams.get('registeredBefore'), '2026-10-19T00:00:00+08:00');
  assert.equal(url.searchParams.has('registeredTo'),false,'the inclusive upper bound is never sent');
  const before=calls.length;
  await assert.rejects(()=>adapter.list({...EMPTY_FILTERS,from:'2026-10-18',to:'2026-09-01'},{page:1,pageSize:20},signal),/注册起始日期不能晚于结束日期/);
  assert.equal(calls.length,before,'a reversed range fails before any request');
});

test('R1: month end, year end and leap day ranges keep the real Beijing calendar day', async t => {
  const { calls,snapshot } = await mount(t);
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const adapter=new UserDirectoryBff(snapshot),signal=new AbortController().signal;
  for (const [from,to] of [['2026-10-31','2026-10-31'],['2026-12-31','2026-12-31'],['2024-02-29','2024-02-29'],['2026-02-28','2026-02-28']]) {
    await adapter.list({...EMPTY_FILTERS,from,to},{page:1,pageSize:20},signal);
  }
  const bounds = calls.filter(c=>c.url.includes('registeredBefore')).map(c=>new URL(c.url,'http://127.0.0.1:4291').searchParams.get('registeredBefore'));
  assert.deepEqual(bounds,['2026-11-01T00:00:00+08:00','2027-01-01T00:00:00+08:00','2024-03-01T00:00:00+08:00','2026-03-01T00:00:00+08:00']);
  const before=calls.length;
  await assert.rejects(()=>adapter.list({...EMPTY_FILTERS,from:'2026-02-29',to:'2026-02-29'},{page:1,pageSize:20},signal),/注册日期无效/);
  assert.equal(calls.length,before,'a day that does not exist never becomes a request');
});

test('U-LIST: graceful fallback when API lacks additive fields', async t => {
  const legacyItem = {
    userId: 'u_legacy',
    name: '旧接口用户',
    image: null,
    username: null,
    displayUsername: null,
    maskedPhone: '133****0000',
    accountStatus: 'ACTIVE',
    suspended: false,
    identityStatus: 'VERIFIED',
    ageStatus: 'ADULT',
    source: { kind: 'LOCAL' },
    registeredAt: '2026-10-01T00:00:00Z',
    registeredAtSource: 'LOCAL',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    localCreatedAt: '2026-10-01T00:00:00Z',
    resourceSummary: { state: 'ready', count: 2 },
    orderSummary: { state: 'ready', currentCount: 1 },
    lastBusinessActivity: { state: 'not_connected', domains: ['ORDER', 'SUPPLY'] },
  };
  await mount(t, {
    fetch: async () => json({ items: [legacyItem], nextCursor: null, limit: 20 })
  });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const text = browser.document.querySelector('.ud-directory').textContent;
  assert.ok(text.includes('成长待更新'));
  assert.ok(text.includes('信用待更新'));
  assert.ok(text.includes('总数待更新'));
});

test('U-DETAIL: orders section initializes and updates role and status=current filters', async t => {
  const { calls } = await mount(t, { path: '/users/user_normal?section=orders&role=renter&status=current' });
  await waitFor(() => browser.document.querySelector('[data-order-id="order_cancel"]'));
  const orderReq = calls.find(c => c.url.includes('/orders?') && c.url.includes('role=renter'));
  assert.ok(orderReq, 'orders request includes role parameter');
  assert.ok(orderReq.url.includes('role=renter'));
  assert.ok(orderReq.url.includes('status=current'));
});

test('U-DETAIL: growth section performs independent read of growth facts and active entitlements', async t => {
  const { calls } = await mount(t, {
    path: '/users/user_normal?section=growth',
    permissions: [...permissions, 'membership.growth.read.summary']
  });
  await waitFor(() => browser.document.querySelector('.ud-section-heading h2'));
  const text = browser.document.querySelector('.ud-detail').textContent;
  assert.ok(calls.some(c => c.url.includes('/membership-growth')));
  assert.ok(text.includes('金卡会员'));
  assert.ok(text.includes('已配置生效'));
  assert.ok(text.includes('密友礼遇'));
  assert.ok(text.includes('免押金'));
});

test('U-DETAIL: growth section shows denied state when lacking growth permissions', async t => {
  await mount(t, {
    path: '/users/user_normal?section=growth',
    permissions: ['user.directory.read']
  });
  await waitFor(() => browser.document.querySelector('.ud-message-denied'));
  const text = browser.document.querySelector('.ud-detail').textContent;
  assert.ok(text.includes('无权限'));
  assert.ok(text.includes('membership.growth.read.summary'));
});

test('U-DETAIL: finance section performs independent read of wallet in CENT and renders amounts', async t => {
  const { calls } = await mount(t, {
    path: '/users/user_normal?section=finance',
    permissions: [...permissions, 'finance.read']
  });
  await waitFor(() => browser.document.querySelector('.ud-section-heading h2'));
  const text = browser.document.querySelector('.ud-detail').textContent;
  assert.ok(calls.some(c => c.url.includes('/finance/subjects/')));
  assert.ok(text.includes('150.00 元'));
  assert.ok(text.includes('50.00 元'));
  assert.ok(namedButton('进入完整资金核对'));
});

const growthSectionFetch = (growth, entitlements) => async address => {
  if (address.pathname.endsWith('/membership-growth')) return json({ subjectId: 'user_normal', authorizationState: 'SUMMARY_AUTHORIZED', growth, entitlements, sourceSummary: { contributionCount: 1, pendingCount: 0, excludedCount: 0 } });
  return json({ user: { ...detail, userId: 'user_normal' } });
};

test('U-LIST-CLOSEOUT: permitted identity with absent summaries never reads as 无权限 and never fans out per row', async t => {
  const bare = { ...user }; delete bare.orderSummary; delete bare.resourceSummary;
  const { calls } = await mount(t, { fetch: async () => json({ items: [bare], nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const text = browser.document.querySelector('tbody').textContent;
  assert.equal(text.includes('无权限'), false, 'a missing summary is not a permission verdict');
  assert.equal(text.includes('未分配业务范围'), false);
  assert.ok(text.includes('订单摘要待更新'));
  assert.ok(text.includes('上架数待更新'));
  assert.equal(calls.filter(c => /\/(orders|rental-accounts|audit-events|membership-growth)/.test(c.url)).length, 0, 'the list never compensates with per-row growth/credit/finance reads');
});

test('U-LIST-CLOSEOUT: real zero stays zero, missing counts never become zero, role counts never sum into a total', async t => {
  const items = [
    { ...user, userId: 'u_zero', name: '零单用户', orderSummary: { state: 'ready', currentCount: 0 }, resourceSummary: { state: 'ready', count: 0, publishedCount: 0 } },
    { ...user, userId: 'u_partial', name: '仅租入用户', orderSummary: { state: 'ready', currentCount: 5, renterCurrentCount: 2 } },
    { ...user, userId: 'u_split', name: '仅分角色用户', orderSummary: { state: 'ready', renterCurrentCount: 2, ownerCurrentCount: 3 } },
    { ...user, userId: 'u_nullish', name: '空值用户', orderSummary: { state: 'ready', currentCount: null }, resourceSummary: { state: 'ready' } },
  ];
  await mount(t, { fetch: async () => json({ items, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelectorAll('tbody tr').length === 4);
  const rows = [...browser.document.querySelectorAll('tbody tr')].map(r => r.textContent);
  assert.ok(rows[0].includes('租入 0') || rows[0].includes('进行中 0'), 'known zero is stated as zero business, not as missing data');
  assert.ok(rows[0].includes('上架 0'), 'known zero published count stays 0');
  assert.ok(rows[1].includes('租入 2'));
  assert.ok(rows[1].includes('出租待更新'), 'the unknown sibling role is pending, never 0');
  assert.equal(rows[1].includes('出租 0'), false);
  assert.equal(rows[1].includes('共 5 个进行中'), false, 'role counts are never summed into a de-duplicated total');
  assert.ok(rows[2].includes('租入 2') && rows[2].includes('出租 3'));
  assert.equal(rows[2].includes('共 5'), false, 'role counts must not be added into a de-duplicated total');
  assert.ok(rows[3].includes('订单摘要待更新') && rows[3].includes('上架数待更新'));
  assert.equal(rows[3].includes('0 个进行中'), false);
  assert.equal(rows[3].includes('上架 0'), false);
});

for (const [value, trusted] of [[1234, true], [0, true], [12.5, false], [-3, false], ['1234', false], [null, false]]) test(`U-LIST-CLOSEOUT: page total ${String(value)} renders only when it is a trusted non-negative integer`, async t => {
  const page = { items: [user], nextCursor: null, limit: 20 };
  if (value !== null) page.total = value;
  await mount(t, { fetch: async () => json(page) });
  await waitFor(() => browser.document.querySelector('.ud-pagination'));
  const text = browser.document.querySelector('.ud-pagination').textContent;
  assert.equal(text.includes('位用户'), trusted, text);
  if (!trusted) assert.ok(text.includes('总数待更新'), 'a page length never stands in for the server total');
  else assert.ok(text.includes(`共 ${value} 位用户`), 'the server total is the only stated count');
});

test('U-LIST-CLOSEOUT: a last page emptied by refresh keeps the way back instead of hiding every pagination exit', async t => {
  const { calls } = await mount(t, {
    fetch: async address => address.searchParams.get('cursor') === 'NEXT'
      ? json({ items: [], nextCursor: null, limit: 20 })
      : json({ items: [user], nextCursor: 'NEXT', limit: 20 })
  });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  await click(namedButton('下一页'));
  await waitFor(() => calls.filter(c => c.url.includes('cursor=NEXT')).length === 1);
  assert.equal(browser.document.querySelector('tbody'), null, 'the emptied page shows no table');
  const back = namedButton('上一页');
  assert.ok(back, 'an emptied cursor page must still offer the way back');
  assert.equal(back.disabled, false);
  await click(back);
  await waitFor(() => browser.document.querySelector('tbody tr'));
  assert.ok(browser.document.querySelector('.ud-mobile-list, tbody').textContent.includes('林舟'));
});

test('U-LIST-CLOSEOUT: 390 cards use house actions and keep no bare wrapper button', async t => {
  await mount(t, { width: 390 });
  await waitFor(() => browser.document.querySelector('.ud-mobile-row'));
  assert.equal(browser.document.querySelectorAll('button.ud-mobile-row').length, 0, 'the whole card is no longer a native button');
  assert.equal(browser.document.querySelector('button dl'), null, 'no definition list sits inside a control');
  const card = browser.document.querySelector('.ud-mobile-row');
  assert.notEqual(card.tagName, 'BUTTON');
  const detail = namedButton('查看用户 林舟 详情');
  const quick = namedButton('快速核对用户 林舟');
  assert.ok(detail && quick, 'each card carries its own house actions');
  assert.equal(detail.tagName, 'BUTTON');
  assert.equal(quick.closest('.ud-mobile-row'), card, 'both actions stay inside their own card');
  const count = namedButton('查看用户 林舟 已上架游戏账号');
  assert.ok(count, 'a supported count stays its own focusable drill-down');
  assert.equal(count.closest('dl') !== null, true);
  assert.equal(browser.document.querySelector('button button'), null, 'no control is nested inside another control');
  // Drawer open, focus return and takeover on 390 are proven in real Chromium: happy-dom spins on an overlay over this view.
});

test('U-LIST-CLOSEOUT: growth, entitlement and credit states stay distinct from each other and from zero', async t => {
  const entitlement = { id: 'e1', kind: 'FRIEND', scopeKey: 'friend', startsAtUtc: '2026-01-01T00:00:00Z', endsAtUtc: '2026-12-31T00:00:00Z', status: 'ACTIVE', label: '密友礼遇', depositWaived: true };
  const withGrowth = (id, growth, entitlements) => ({ ...user, userId: id, name: id, membershipSummary: { state: 'ready', asOfUtc: '2026-10-20T00:00:00Z', growth, ...(entitlements === undefined ? {} : { entitlements }) } });
  const growth = (knowledge, over = {}) => ({ knowledge, sourceState: 'COMPLETE', benefitsState: 'CONFIGURED', normalTier: null, effectiveTier: null, blackGold: null, grace: null, ...over });
  const items = [
    withGrowth('g_no_tier', growth('KNOWN'), undefined),
    withGrowth('g_odd_tier', growth('KNOWN', { benefitsState: 'NOT_CONFIGURED', effectiveTier: 'MYSTIC' }), []),
    withGrowth('g_unknown', growth('UNKNOWN', { sourceState: 'BACKFILL_PENDING' }), [entitlement]),
    withGrowth('g_empty_ents', growth('KNOWN', { normalTier: 'GOLD', effectiveTier: 'GOLD' }), []),
    { ...user, userId: 'c_zero', name: 'c_zero', creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 0, revision: '7' } },
    { ...user, userId: 'c_no_score', name: 'c_no_score', creditSummary: { state: 'ready', knowledge: 'KNOWN' } },
    { ...user, userId: 'c_uninit', name: 'c_uninit', creditSummary: { state: 'ready', knowledge: 'NOT_INITIALIZED', score: null, revision: null } },
    { ...user, userId: 'c_denied', name: 'c_denied', creditSummary: { state: 'denied', permission: 'credit.read', reason: 'OUT_OF_SCOPE' } },
  ];
  await mount(t, { fetch: async () => json({ items, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelectorAll('tbody tr').length === items.length);
  const rows = [...browser.document.querySelectorAll('tbody tr')].map(r => r.textContent);
  assert.ok(rows[0].includes('等级待核'), 'KNOWN growth without a tier is not 普通会员');
  assert.equal(rows[0].includes('普通会员'), false);
  assert.equal(rows[0].includes('无有效礼遇'), false, 'absent entitlements never mean no entitlement');
  assert.ok(rows[0].includes('礼遇待核'));
  assert.ok(rows[1].includes('等级待核'), 'an unrecognised tier stays pending');
  assert.ok(rows[2].includes('等级待核'));
  assert.ok(rows[2].includes('密友礼遇'), 'unknown growth still surfaces known ACTIVE entitlements');
  assert.ok(rows[3].includes('金卡会员'));
  assert.equal(rows[3].includes('无有效礼遇'), false, 'a confirmed empty entitlement set takes no row');
  assert.ok(rows[4].includes('0 分'));
  assert.equal(rows[4].includes('版本 7'), false, 'the concurrency revision number stays out of the list');
  assert.ok(rows[5].includes('信用分待核'));
  assert.equal(rows[5].includes('0 分'), false);
  assert.equal(rows[5].includes('undefined 分'), false);
  assert.ok(rows[6].includes('未评分'));
  assert.equal(rows[6].includes('0 分'), false);
  assert.ok(rows[7].includes('无对象权限'));
});

test('U-DETAIL-CLOSEOUT: growth section never defaults an UNKNOWN or unrecognised tier to 标准会员', async t => {
  const { calls } = await mount(t, {
    path: '/users/user_normal?section=growth',
    permissions: [...permissions, 'membership.growth.read.summary'],
    fetch: growthSectionFetch({ knowledge: 'KNOWN', sourceState: 'BACKFILL_PENDING', benefitsState: 'CONFIGURED', normalTier: null, effectiveTier: null, blackGold: null, grace: null }, undefined)
  });
  await waitFor(() => browser.document.querySelector('.ud-section-heading h2'));
  const text = browser.document.querySelector('.ud-detail').textContent;
  assert.equal(calls.filter(c => /\/(orders|rental-accounts)/.test(c.url)).length, 0);
  assert.equal(text.includes('普通会员'), false, 'a permitted read with no tier never becomes the lowest tier');
  assert.ok(text.includes('等级待核'));
  assert.ok(text.includes('资料待补'), 'the source state stays readable next to the unknown tier');
});

test('U-DETAIL-CLOSEOUT: rejected status=current names the dead condition, keeps the role, and never silently lists all orders', async t => {
  const orderRequests = [];
  await mount(t, {
    path: '/users/user_normal?section=orders&role=renter&status=current',
    fetch: async address => {
      if (address.pathname.endsWith('/orders')) {
        orderRequests.push(address.search);
        if (address.searchParams.get('status') === 'current') return json({ error: { code: 'INVALID_ARGUMENT', message: 'Status is invalid' } }, 400);
        return json({ items: [order], nextCursor: null });
      }
      return json({ user: { ...detail, userId: 'user_normal' } });
    }
  });
  await waitFor(() => browser.document.querySelector('.ud-message-error'));
  const text = browser.document.querySelector('.ud-message-error').textContent;
  assert.ok(text.includes('当前订单'), `the refused condition is named: ${text}`);
  assert.equal(text.includes('API 是否'), false, 'a value-level rejection is not reported as a service outage');
  assert.equal(namedButton('重试'), undefined, 'a refused condition is never offered as a blind retry');
  assert.equal(browser.document.querySelector('[data-order-id="order_cancel"]'), null, 'no orders are rendered while the requested condition is unexecuted');
  assert.equal(orderRequests.filter(search => !search.includes('status=')).length, 0, 'the page never drops the condition and re-queries everything');
  assert.ok(orderRequests[0].includes('role=renter'), 'the supported role condition is preserved');
  assert.ok(browser.document.querySelector('[aria-label="订单状态"]'), 'the order record entry keeps its own controls');
  assert.ok(browser.document.querySelector('[aria-label="该用户在具体订单中的参与方"]'), 'the supported role control is still usable');
  assert.ok(browser.document.querySelector('[aria-label="订单状态"]').textContent.includes('当前订单（待付/已付）'), 'a restored status shows its business label before the popup is opened');
  assert.ok(browser.document.querySelector('[aria-label="该用户在具体订单中的参与方"]').textContent.includes('租用方'), 'a restored role never leaks its API enum as the label');
  assert.ok(browser.location.search.includes('status=current'), 'the refused condition stays visible instead of being silently rewritten');
});

test('U-LIST-PAGE: numbered pagination renders total, page window, navigates and passes in-memory contextKey', async t => {
  const contextSecret = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const { calls } = await mount(t, {
    fetch: async address => {
      const p = address.searchParams.get('page') ? Number(address.searchParams.get('page')) : 1;
      const size = address.searchParams.get('pageSize') ? Number(address.searchParams.get('pageSize')) : 20;
      const count = p === 3 ? 15 : size;
      const items = Array.from({ length: count }, (_, i) => ({ ...user, userId: `u_page_${p}_${i}`, name: `用户 P${p}-${i}` }));
      return json({
        paginationMode: 'page',
        items,
        total: 55,
        page: p,
        pageSize: size,
        contextKey: contextSecret,
        nextCursor: null,
        limit: size,
      });
    }
  });

  await waitFor(() => browser.document.querySelectorAll('tbody tr').length === 20);
  const paginationText = browser.document.querySelector('.ud-pagination').textContent;
  assert.ok(paginationText.includes('共 55 位用户'), 'displays total count from page API');
  assert.ok(paginationText.includes('共 55 位用户 · 第 1 / 3 页'));
  assert.ok(paginationText.includes('第 1 / 3 页'));

  // First & Prev disabled on page 1
  assert.ok(namedButton('首页')?.disabled);
  assert.ok(namedButton('上一页')?.disabled);
  assert.equal(namedButton('下一页')?.disabled, false);
  assert.equal(namedButton('末页')?.disabled, false);

  // Click page 2
  await click(namedButton('第 2 页'));
  await waitFor(() => calls.some(c => c.url.includes('page=2')));
  const page2Call = calls.find(c => c.url.includes('page=2'));
  assert.ok(page2Call.url.includes(`contextKey=${contextSecret}`), 'subsequent page sends in-memory contextKey');
  assert.equal(browser.location.href.includes(contextSecret), false, 'contextKey must NEVER leak to URL');
  assert.equal(browser.sessionStorage.getItem('contextKey'), null, 'contextKey must NEVER leak to sessionStorage');

  // Next page via '下一页' button
  await click(namedButton('下一页'));
  await waitFor(() => calls.some(c => c.url.includes('page=3')));
  assert.ok(namedButton('下一页')?.disabled, 'Next disabled on last page');
  assert.ok(namedButton('末页')?.disabled, 'Last disabled on last page');
});

test('U-LIST-PAGE: jump to page validates integer bounds without triggering requests', async t => {
  const { calls } = await mount(t, {
    fetch: async address => {
      const p = address.searchParams.get('page') ? Number(address.searchParams.get('page')) : 1;
      return json({
        paginationMode: 'page',
        items: [user],
        total: 55,
        page: p,
        pageSize: 20,
        contextKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        nextCursor: null,
        limit: 20,
      });
    }
  });

  await waitFor(() => browser.document.querySelector('tbody tr'));
  const jumpInput = browser.document.querySelector('[aria-label="跳转页码"]');
  assert.ok(jumpInput, 'jump input exists');

  // Input out-of-bounds 999
  await input(jumpInput, '999');
  await click(namedButton('跳转'));
  assert.ok(browser.document.querySelector('.admin-list-pagination-error')?.textContent.includes('请输入 1 到 3 之间的页码'));
  assert.equal(calls.some(c => c.url.includes('page=999')), false, 'out-of-bounds jump does not send request');

  // Input invalid text 'abc'
  await input(jumpInput, 'abc');
  await click(namedButton('跳转'));
  assert.ok(browser.document.querySelector('.admin-list-pagination-error')?.textContent.includes('请输入有效的整数页码'));

  // Valid jump to page 3
  await input(jumpInput, '3');
  await click(namedButton('跳转'));
  await waitFor(() => calls.some(c => c.url.includes('page=3')));
  assert.equal(browser.document.querySelector('.admin-list-pagination-error'), null);
});

test('U-LIST-PAGE: total 0 shows clean empty pagination state', async t => {
  await mount(t, {
    fetch: async () => json({
      paginationMode: 'page',
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      contextKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      nextCursor: null,
      limit: 20,
    })
  });

  await waitFor(() => browser.document.querySelector('.ud-pagination'));
  const paginationText = browser.document.querySelector('.ud-pagination').textContent;
  assert.ok(paginationText.includes('共 0 位用户 · 暂无分页'));
  assert.equal(browser.document.querySelector('[aria-label="页码列表"]'), null);
  assert.ok(namedButton('重置'), 'Reset remains accessible');
});

test('U-LIST-PAGE: out of bounds empty page provides return to first page', async t => {
  const { calls } = await mount(t, {
    path: '/users?page=10',
    fetch: async address => {
      const p = Number(address.searchParams.get('page') || '1');
      return json({
        paginationMode: 'page',
        items: p === 1 ? [user] : [],
        total: 20,
        page: p,
        pageSize: 20,
        contextKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        nextCursor: null,
        limit: 20,
      });
    }
  });

  await waitFor(() => browser.document.querySelector('.ud-message-empty'));
  const emptyText = browser.document.querySelector('.ud-message-empty').textContent;
  assert.ok(emptyText.includes('该页暂无记录'));
  assert.ok(namedButton('返回首页'));

  await click(namedButton('返回首页'));
  await waitFor(() => calls.some(c => c.url.includes('page=1')));
  await waitFor(() => browser.document.querySelector('tbody tr'));
});

test('U-LIST-PAGE: 409 recovers once to page 1, clears context and preserves applied filters', async t => {
  let conflicts=0;
  const {calls}=await mount(t,{path:'/users?status=ACTIVE',fetch:async address=>{
    if(address.searchParams.get('page')==='2'){conflicts++;return failure(409);}
    return json({paginationMode:'page',items:[user],total:60,page:1,pageSize:20,contextKey:'a'.repeat(64),nextCursor:null,limit:20});
  }});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  await click(namedButton('下一页'));
  await waitFor(()=>browser.document.querySelector('.ud-directory').textContent.includes('查询上下文已失效'));
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  assert.equal(conflicts,1);
  const second=calls.findIndex(c=>c.url.includes('page=2'));
  const recovered=new URL(calls[second+1].url,browser.location.href);
  assert.equal(recovered.searchParams.get('page'),'1');
  assert.equal(recovered.searchParams.has('contextKey'),false);
  assert.equal(recovered.searchParams.get('accountStatus'),'ACTIVE');
  assert.ok(browser.document.querySelector('.ud-pagination').textContent.includes('第 1 / 3 页'));
});

test('U-LIST-COMPAT: legacy cursor response enters compatibility mode and does not fabricate jump', async t => {
  const { calls } = await mount(t, {
    fetch: async address => {
      const cursor = address.searchParams.get('cursor');
      return json({
        items: [user],
        nextCursor: cursor === 'CUR_NEXT' ? null : 'CUR_NEXT',
        limit: 20,
      });
    }
  });

  await waitFor(() => browser.document.querySelector('tbody tr'));
  const text = browser.document.querySelector('.ud-pagination').textContent;
  assert.ok(text.includes('当前服务暂未提供跳页能力'));
  assert.ok(text.includes('总数待更新'));
  assert.equal(browser.document.querySelector('[aria-label="跳转页码"]'), null, 'no fake jump input');

  // Navigate using nextCursor
  assert.equal(namedButton('下一页')?.disabled, false);
  await click(namedButton('下一页'));
  await waitFor(() => calls.some(c => c.url.includes('cursor=CUR_NEXT')));
});

test('MASTER: ignored pageSize retries with limit and removes the unserved page from return state', async t => {
  const {calls}=await mount(t,{path:'/users?page=8&pageSize=10',fetch:async address=>{
    const size=Number(address.searchParams.get('limit')||20);
    return json({items:[user],nextCursor:'NEXT',limit:size});
  }});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  assert.equal(new URL(browser.location.href).searchParams.has('page'),false);
  assert.ok(calls.some(c=>c.url.includes('limit=10')));
  assert.ok(browser.document.querySelector('[aria-label="每页容量"]').textContent.includes('10'));
});

test('MASTER: malformed numbered response is rejected instead of becoming cursor data', async t => {
  await mount(t,{fetch:async()=>json({paginationMode:'page',items:[user],total:1,page:1,pageSize:0,contextKey:'bad',nextCursor:null,limit:20})});
  await waitFor(()=>browser.document.querySelector('.ud-message-error'));
  assert.equal(browser.document.querySelector('tbody tr'),null);
  assert.equal(browser.document.querySelector('.ud-pagination'),null);
});

test('MASTER: the registration date control is available and picking a day stays a draft', async t => {
  const {calls}=await mount(t);
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const before=calls.length;
  const trigger=browser.document.querySelector('[aria-label="注册日期"]');
  assert.ok(trigger && !trigger.disabled,'the registration date filter is available');
  const {container}=await mountCalendar(t,{period:'day',operator:'between',startDate:new Date(2026,9,20)});
  const day=container.querySelector('button[data-day]');
  assert.ok(day,'the calendar renders selectable days');
  await click(day);
  await settle();
  assert.equal(calls.length,before,'picking a date never fires a request by itself');
  assert.ok(browser.document.querySelector('tbody tr'),'the applied rows stay until the query is submitted');
});

test('R1: a restored date condition queries the original registration range instead of the local filing date',async t=>{
  const {calls}=await mount(t,{path:'/users?from=2026-10-18&to=2026-10-18'});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const call=calls.find(c=>c.url.includes('registeredFrom'));
  assert.ok(call,'the restored date condition is executed as a registration range');
  const url=new URL(call.url,browser.location.href);
  assert.equal(url.searchParams.get('registrationTime'),'ORIGINAL');
  assert.equal(url.searchParams.get('registeredFrom'),'2026-10-18T00:00:00+08:00');
  assert.equal(url.searchParams.get('registeredBefore'),'2026-10-19T00:00:00+08:00');
  assert.equal(url.searchParams.has('registeredTo'),false);
});

test('MASTER: a failed context recovery stops after one attempt and removes stale rows', async t => {
  let failed=0;
  const {calls}=await mount(t,{fetch:async address=>{
    if(address.searchParams.get('contextKey')||failed>0){failed++;return failure(409);}
    return json({paginationMode:'page',items:[user],total:60,page:1,pageSize:20,contextKey:'a'.repeat(64),nextCursor:null,limit:20});
  }});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  await click(namedButton('下一页'));
  await waitFor(()=>browser.document.querySelector('.ud-message-error'));
  await settle();
  assert.equal(failed,2,'one conflicting read and one controlled recovery');
  assert.equal(browser.document.querySelector('tbody tr'),null);
});

test('MASTER: cursor return state retains capacity and the toolbar has one query action',async t=>{
  const {calls}=await mount(t,{path:'/users?pageSize=50',fetch:async address=>json({items:[user],nextCursor:address.searchParams.has('cursor')?null:'NEXT',limit:50})});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  await click(namedButton('下一页'));
  await waitFor(()=>calls.some(c=>c.url.includes('cursor=NEXT')));
  assert.equal(new URL(browser.location.href).searchParams.get('pageSize'),'50');
  assert.equal(browser.document.querySelectorAll('.admin-list-toolbar button[type="submit"]').length,1);
});

test('MASTER: resetting an already clear query refreshes it and retains the pagination exit',async t=>{
  const {calls}=await mount(t);
  await waitFor(()=>browser.document.querySelector('.ud-pagination'));
  const before=calls.length;
  await click(namedButton('重置'));
  await waitFor(()=>calls.length>before);
  await waitFor(()=>browser.document.querySelector('.ud-pagination'));
  assert.ok(browser.document.querySelector('tbody tr'));
});

test('U-LIST-TOOLBAR: draft filters and search commit on 查询 and reset on 重置', async t => {
  const { calls } = await mount(t);
  await waitFor(() => browser.document.querySelector('tbody tr'));

  const searchInput = browser.document.querySelector('[aria-label="查找用户"]');
  await input(searchInput, 'test_user_query');
  assert.equal(calls.some(c => c.url.includes('test_user_query')), false, 'typing does not immediately fire request');

  await click(namedButton('查询'));
  await waitFor(() => calls.some(c => c.url.includes('q=test_user_query')));

  await click(namedButton('重置'));
  await waitFor(() => searchInput.value === '');
  await waitFor(() => calls.some(c => !c.url.includes('test_user_query')));
});


// ADM-USER-SUMMARY-UX-03: shared identity summary, semantic colours, business counts and registration honesty.
async function mountCalendar(t,initialValue,props={}) {
  width=1440;
  const container=browser.document.createElement('div');browser.document.body.appendChild(container);
  const root=createRoot(container),changes=[];
  function Fixture(){const [value,setValue]=useState(initialValue);return createElement(DateSelector,{value,presetMode:'between',showTwoMonths:false,...props,onChange:next=>{changes.push(next);setValue(next);}});}
  t.after(async()=>{await act(async()=>root.unmount());container.remove();await settle();});
  await act(async()=>root.render(createElement(StrictMode,null,createElement(Fixture))));await settle();
  return {container,changes};
}

test('MASTER-UX03: selecting an end before the start preserves both dates',async t=>{
  const {container,changes}=await mountCalendar(t,{period:'day',operator:'between',startDate:new Date(2026,9,20)});
  const day=container.querySelector(`[data-day="${new Date(2026,9,14).toLocaleDateString()}"]`);
  await click(day);
  assert.equal(changes.at(-1)?.startDate?.getDate(),14);
  assert.equal(changes.at(-1)?.endDate?.getDate(),20);
});

test('MASTER-UX03: the calendar day has a Chinese accessible name',async t=>{
  const {container}=await mountCalendar(t,{period:'day',operator:'between',startDate:new Date(2026,9,20)});
  const day=container.querySelector(`[data-day="${new Date(2026,9,14).toLocaleDateString()}"]`);
  assert.match(day?.getAttribute('aria-label')||'',/2026年.*10月.*14日/);
});

test('MASTER-UX03: quick ranges use the Beijing date in a UTC browser',async t=>{
  const previousTZ=process.env.TZ;process.env.TZ='UTC';
  t.after(()=>{if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;});
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T17:30:00Z')});
  const {container,changes}=await mountCalendar(t,undefined,{presets:[{label:'近 7 天',days:7}]});
  await click([...container.querySelectorAll('button')].find(b=>b.textContent==='近 7 天'));
  assert.equal(changes.at(-1)?.endDate?.getDate(),21);
  assert.equal(changes.at(-1)?.startDate?.getDate(),15);
});

test('R1: the registration sort is available and the legacy created sort normalises into the default',async t=>{
  const {calls}=await mount(t,{path:'/users?sort=created'});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  assert.ok(browser.document.querySelector('[aria-label="按注册时间排序"]'),'the registration sort lives on the column header');
  const call=calls.find(c=>c.url.includes('/users?'));
  const url=new URL(call.url,browser.location.href);
  assert.equal(url.searchParams.get('sort'),'registered_desc','the old created sort normalises into the registration default');
  assert.equal(url.searchParams.get('registrationTime'),'ORIGINAL');
});

test('MASTER-UX03: the source tooltip is keyboard reachable and never opens the row drawer',async t=>{
  const {calls}=await mount(t);await waitFor(()=>browser.document.querySelector('tbody tr'));
  const source=browser.document.querySelector('tbody .ud-source-icon');
  assert.ok(source?.tabIndex>=0,'the source explanation must be keyboard reachable');
  const before=calls.length;
  await click(source);
  assert.ok(browser.document.querySelector('.ud-drawer')===null);
  assert.equal(calls.length,before);
});

test('R1: an unknown registration source never becomes a registration date',async t=>{
  const unknown={...user,source:{kind:'UNKNOWN'},registeredAt:null,registeredAtSource:'UNKNOWN'};
  await mount(t,{fetch:async()=>json({items:[unknown],nextCursor:null,limit:20})});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const dateCell=browser.document.querySelector('tbody tr').children[6];
  assert.ok(dateCell.textContent.includes('待核'));
  assert.ok(!dateCell.textContent.includes('2026-09-24'),'the local filing date is never printed as a registration date');
});

test('MASTER-UX03: a known local registration agrees in the detail view',async t=>{
  await mount(t,{path:'/users/user_local',fetch:async()=>json({user:{...detail,userId:'user_local',source:{kind:'LOCAL'},registeredAt:'2026-04-01T00:00:00Z',registeredAtSource:'LOCAL'}})});
  await waitFor(()=>browser.document.querySelector('.ud-facts'));
  const row=[...browser.document.querySelectorAll('.ud-facts>div')].find(n=>n.querySelector('dt')?.textContent==='注册时间');
  assert.ok(row?.textContent.includes('2026-04-01')||row?.textContent.includes('2026/04/01'));
});

test('MASTER-UX03: details provide readable IDs when copying fails without audit permission',async t=>{
  await mount(t,{path:'/users/user_normal',permissions:['user.directory.read']});
  await waitFor(()=>browser.document.querySelector('.ud-facts'));
  const facts=browser.document.querySelector('.ud-facts').textContent;
  assert.ok(facts.includes('user_normal'),'the detail must offer the ID promised by the copy failure');
  assert.ok(facts.includes('88001'),'legacy ID belongs to basic user facts, not an audit-only panel');
});

test('ADM-SUMMARY: the row shows a real avatar, the nickname drill-down and a copy-ID control that never prints the UUID', async t => {
  // happy-dom does not fetch images; report the loaded state so the real avatar branch renders.
  browser.Image = class { constructor() { this.complete = true; this.naturalWidth = 120; } set src(_value) {} };
  const withImage = { ...user, userId: 'u_avatar', name: '带头像', image: 'https://cdn.example.com/a.png' };
  const { calls } = await mount(t, { fetch: async () => json({ items: [withImage], total: 1, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const row = browser.document.querySelector('tbody tr');
  assert.ok(row.querySelector('img[src="https://cdn.example.com/a.png"]'), 'the server image URL reaches the model and the DOM');
  const copy = row.querySelector('[aria-label="复制用户ID：带头像"]');
  assert.ok(copy, 'the copy control is named for the user, not for the UUID');
  assert.equal(copy.textContent.includes('u_avatar'), false, 'the UUID body is never printed in the list');
  assert.equal(row.textContent.includes('u_avatar'), false);
  const written = [];
  const realClipboard = browser.navigator.clipboard;
  Object.defineProperty(browser.navigator, 'clipboard', { value: { writeText: async value => { written.push(value); } }, configurable: true });
  t.after(() => Object.defineProperty(browser.navigator, 'clipboard', { value: realClipboard, configurable: true }));
  await click(copy);
  await waitFor(() => written.length === 1, 1000);
  assert.equal(written[0], 'u_avatar');
  assert.notEqual(written[0], '带头像', 'the nickname is never copied');
  await click(row.querySelector('[aria-label="查看用户 带头像 详情"]'));
  await waitFor(() => browser.document.querySelector('.ud-detail, .ud-message-error'));
  assert.equal(browser.location.pathname, '/users/u_avatar');
  assert.equal(calls.filter(c => c.url.includes('/users/u_avatar/orders')).length, 0, 'the nickname drill-down fires no business read');
});

test('ADM-SUMMARY: a broken or missing avatar always falls back without inventing a portrait', async t => {
  // A failed load (naturalWidth 0) is the broken-image path.
  browser.Image = class { constructor() { this.complete = true; this.naturalWidth = 0; } set src(_value) {} };
  const broken = { ...user, userId: 'u_broken', name: '坏图用户', image: 'https://cdn.example.com/missing.png' };
  await mount(t, { fetch: async () => json({ items: [broken], total: 1, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const row = browser.document.querySelector('tbody tr');
  assert.ok(row.querySelector('[data-slot="avatar-fallback"]'), 'a broken image falls back to the icon');
  assert.equal(row.querySelector('img'), null, 'a broken image renders no portrait');
  const noImage = { ...user, userId: 'u_plain', name: '无图用户', image: null };
  await mount(t, { fetch: async () => json({ items: [noImage], total: 1, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  assert.equal(browser.document.querySelector('tbody tr img'), null, 'no image means no img element at all');
  assert.ok(browser.document.querySelector('[data-slot="avatar-fallback"]'));
});

test('ADM-SUMMARY: the account, identity and credit states use their semantic colour and never a bare revision number', async t => {
  const users = [
    { ...user, userId: 's_active', name: '正常', accountStatus: 'ACTIVE', identityStatus: 'VERIFIED', creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 85, revision: '3' } },
    { ...user, userId: 's_restricted', name: '受限', accountStatus: 'RESTRICTED', identityStatus: 'UNVERIFIED', creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 65, revision: '4' } },
    { ...user, userId: 's_frozen', name: '冻结', accountStatus: 'DEACTIVATED', suspended: true, creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 40, revision: '5' } },
    { ...user, userId: 's_unknown', name: '未知', accountStatus: 'UNKNOWN', identityStatus: 'UNKNOWN', creditSummary: { state: 'ready', knowledge: 'KNOWN', score: 0, revision: '6' } },
  ];
  await mount(t, { fetch: async () => json({ items: users, total: 4, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelectorAll('tbody tr').length === 4);
  const rows = [...browser.document.querySelectorAll('tbody tr')].map(r => r.textContent);
  assert.ok(rows[0].includes('正常') && rows[0].includes('已实名') && rows[0].includes('85 分'));
  assert.ok(rows[1].includes('受限') && rows[1].includes('未实名') && rows[1].includes('65 分'));
  assert.ok(rows[2].includes('已冻结') && rows[2].includes('40 分'));
  assert.ok(rows[3].includes('未知') && rows[3].includes('实名未知') && rows[3].includes('0 分'));
  for (const row of rows) assert.equal(/版本\s*\d/.test(row), false, 'no row prints the concurrency revision');
  assert.equal(rows[3].includes('未实名'), false, 'an unknown identity never reads as 未实名');
  const badges = [...browser.document.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('[data-slot="badge"]')].map(b => b.className));
  assert.ok(badges[0].some(c => c.includes('emerald')), 'a normal account uses the calm success tone');
  assert.ok(badges[1].some(c => c.includes('amber')), 'a restricted account uses the warning tone');
  assert.ok(badges[2].some(c => c.includes('destructive')), 'a frozen account uses the danger tone');
  assert.ok(badges[3].some(c => c.includes('border-dashed')), 'an unknown state uses the neutral dashed badge');
});

test('ADM-SUMMARY: the credit score boundaries follow the agreed tones and a zero stays a zero', async t => {
  const users = [80, 79, 60, 59, 0].map(score => ({ ...user, userId: `c_${score}`, name: `c_${score}`, creditSummary: { state: 'ready', knowledge: 'KNOWN', score, revision: '1' } }));
  await mount(t, { fetch: async () => json({ items: users, total: users.length, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelectorAll('tbody tr').length === 5);
  const rows = [...browser.document.querySelectorAll('tbody tr')];
  const tone = row => {
    const badge = [...row.querySelectorAll('[data-slot="badge"]')].find(b => b.textContent.includes('分'));
    return badge.className.includes('emerald') ? 'success' : badge.className.includes('amber') ? 'warning' : 'destructive';
  };
  assert.equal(tone(rows[0]), 'success', '80 is the normal tone');
  assert.equal(tone(rows[1]), 'warning', '79 is the warning tone');
  assert.equal(tone(rows[2]), 'warning', '60 is the warning tone');
  assert.equal(tone(rows[3]), 'destructive', '59 is the danger tone');
  assert.equal(tone(rows[4]), 'destructive', 'a real zero stays zero and is not softened');
  assert.ok(rows[4].textContent.includes('0 分'));
});

test('R2: the business cell separates renting, lending and the published accounts, each with its own drill-down', async t => {
  const mixed = { ...user, userId: 'u_mixed', name: '混合用户', orderSummary: { state: 'ready', currentCount: 3, renterCurrentCount: 1, ownerCurrentCount: 2 }, resourceSummary: { state: 'ready', count: 4, publishedCount: 2 } };
  const { calls } = await mount(t, { fetch: async () => json({ items: [mixed], total: 1, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const cell = browser.document.querySelector('tbody tr .ud-business-cell');
  assert.ok(cell, 'the business cell groups the counts');
  assert.ok(cell.textContent.includes('租入 1'));
  assert.ok(cell.textContent.includes('出租 2'));
  assert.ok(cell.textContent.includes('上架 2'));
  assert.equal(cell.textContent.includes('名下 4'), false, 'the archive count never stands in for the published count');
  assert.equal(cell.textContent.includes('共 3'), false, 'the two roles are never summed into a de-duplicated total');
  await click(cell.querySelector('[aria-label="查看用户 混合用户 租入订单"]'));
  await waitFor(() => browser.location.pathname === '/users/u_mixed');
  assert.ok(browser.location.search.includes('role=renter'));
  assert.ok(browser.location.search.includes('status=current'));
  assert.equal(calls.filter(c => c.url.includes('/rental-accounts')).length, 0, 'the list never compensates with per-row business reads');
});

test('R1: the registration fact follows the server-declared source in every caller', async t => {
  const local = { ...user, userId: 'u_local', name: '本平台注册', registeredAtSource: 'LOCAL', registeredAt: '2026-10-12T00:00:00Z' };
  const legacy = { ...user, userId: 'u_legacy', name: '旧平台注册', registeredAtSource: 'LEGACY', registeredAt: '2026-07-29T00:00:00Z' };
  const unknown = { ...user, userId: 'u_unknown', name: '来源未知', registeredAtSource: 'UNKNOWN', registeredAt: null };
  await mount(t, { fetch: async () => json({ items: [local, legacy, unknown], total: 3, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelectorAll('tbody tr').length === 3);
  const rows = [...browser.document.querySelectorAll('tbody tr')].map(r => r.textContent);
  assert.ok(rows[0].includes('2026-10-12') && rows[0].includes('本平台注册'), 'a server-declared local registration is shown with its source');
  assert.ok(rows[1].includes('2026-07-29') && rows[1].includes('旧平台注册'));
  assert.ok(rows[2].includes('待核'), 'an unknown source stays pending');
  assert.equal(rows[2].includes('2026-09-24'), false, 'the local filing date is never printed as a registration date');
});

test('ADM-SUMMARY: the growth detail separates active entitlements from history and never infers a missing one', async t => {
  const growthResponse = {
    subjectId: 'user_normal',
    authorizationState: 'SUMMARY_AUTHORIZED',
    growth: { knowledge: 'KNOWN', sourceState: 'COMPLETE', benefitsState: 'CONFIGURED', normalTier: 'GOLD', effectiveTier: 'GOLD', blackGold: 'NOT_QUALIFIED', grace: null },
    entitlements: [
      { id: 'e-active', kind: 'FRIEND', scopeKey: 'friend', startsAtUtc: '2026-01-01T00:00:00Z', endsAtUtc: '2026-12-31T23:59:59Z', status: 'ACTIVE', label: '挚友礼遇', depositWaived: true },
      { id: 'e-expired', kind: 'PRESTIGE', scopeKey: 'prestige', startsAtUtc: '2025-01-01T00:00:00Z', endsAtUtc: '2025-12-31T23:59:59Z', status: 'EXPIRED', label: '尊享礼遇', depositWaived: false },
      { id: 'e-revoked', kind: 'PRESTIGE', scopeKey: 'prestige', startsAtUtc: '2025-01-01T00:00:00Z', endsAtUtc: '2026-12-31T23:59:59Z', status: 'REVOKED', label: '尊享礼遇', depositWaived: false },
    ],
    sourceSummary: { contributionCount: 4, pendingCount: 1, excludedCount: 2 },
  };
  await mount(t, { path: '/users/user_normal?section=growth', permissions: [...permissions, 'membership.growth.read.summary'], fetch: async address => address.pathname.endsWith('/membership-growth') ? json(growthResponse) : json({ user: { ...detail, userId: 'user_normal' } }) });
  await waitFor(() => browser.document.querySelector('.ud-section-heading h2'));
  const text = browser.document.querySelector('.ud-detail').textContent;
  assert.ok(text.includes('金卡会员'));
  assert.ok(text.includes('挚友礼遇'));
  assert.ok(text.includes('来源记录：4 条'), 'contribution rows are called source records, not effective contributions');
  assert.equal(text.includes('有效贡献'), false);
  const history = browser.document.querySelector('.ud-entitlement-history');
  assert.ok(history, 'the historical entitlements are folded away');
  assert.ok(history.textContent.includes('已过期') && history.textContent.includes('已撤销'), 'each history entry keeps its own state');
  assert.equal(history.textContent.includes('暂无有效独立礼遇'), false, 'history never empties the active list');
});

test('ADM-SUMMARY: a DETAIL_ONLY growth read never becomes "no entitlement"', async t => {
  await mount(t, {
    path: '/users/user_normal?section=growth',
    permissions: [...permissions, 'membership.growth.read.detail'],
    fetch: async address => address.pathname.endsWith('/membership-growth')
      ? json({ subjectId: 'user_normal', authorizationState: 'DETAIL_ONLY', scopeDetails: [] })
      : json({ user: { ...detail, userId: 'user_normal' } }),
  });
  await waitFor(() => browser.document.querySelector('.ud-section-heading h2'));
  const text = browser.document.querySelector('.ud-detail').textContent;
  assert.ok(text.includes('读取范围受限'), 'the limited read scope is stated');
  assert.equal(text.includes('暂无有效独立礼遇'), false, 'a limited read scope never becomes no entitlement');
  assert.ok(text.includes('礼遇未读取'));
  assert.equal(text.includes('普通会员'), false, 'a limited read scope never invents a tier');
});

test('ADM-SUMMARY: a missing blackGold judgement and a missing gap are not turned into a negative fact', async t => {
  await mount(t, {
    path: '/users/user_normal?section=growth',
    permissions: [...permissions, 'membership.growth.read.summary'],
    fetch: async address => address.pathname.endsWith('/membership-growth')
      ? json({ subjectId: 'user_normal', authorizationState: 'SUMMARY_AUTHORIZED', growth: { knowledge: 'KNOWN', sourceState: 'COMPLETE', benefitsState: 'CONFIGURED', normalTier: 'GOLD', effectiveTier: 'GOLD', blackGold: null, grace: { state: 'ACTIVE', fromTier: 'GOLD', droppedAt: null, until: '2026-12-01T00:00:00Z', gapPoints: null } }, entitlements: [] })
      : json({ user: { ...detail, userId: 'user_normal' } }),
  });
  await waitFor(() => browser.document.querySelector('.ud-section-heading h2'));
  const text = browser.document.querySelector('.ud-detail').textContent;
  assert.ok(text.includes('未读取'), 'a missing blackGold judgement stays unread');
  assert.equal(text.includes('未具备'), false, 'a missing judgement is not a negative fact');
  assert.ok(text.includes('差额：未读取'), 'a missing gap is not filled with zero');
  assert.equal(text.includes('差额：0'), false);
});

test('ADM-SUMMARY: the search keeps the old-ID hit explainable without a permanent old-ID column', async t => {
  await mount(t, { fetch: async () => json({ items: [{ ...user, name: '命中用户' }], total: 1, nextCursor: null, limit: 20 }) });
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const row = browser.document.querySelector('tbody tr').textContent;
  assert.equal(row.includes('88001'), false, 'the old platform ID never stays in the row');
  assert.equal(row.includes('旧平台 ID'), false);
  await input(browser.document.querySelector('[aria-label="查找用户"]'), '88001');
  await click(namedButton('查询'));
  await waitFor(() => browser.document.querySelector('tbody tr'));
  const matched = browser.document.querySelector('tbody tr').textContent;
  assert.ok(matched.includes('按旧平台 ID 命中'), 'an old-ID hit explains itself once');
});

// ADM-USER-UI-RESTORE-01 / F0-B: R1 真实注册时间与 R2 上架摘要及同集合下钻。
test('R1: the list, the phone lookup and the detail all ask for the original registration time',async t=>{
  const {calls}=await mount(t);
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const list=calls.find(c=>c.url.startsWith('/api/bff/admin/users?'));
  assert.equal(new URL(list.url,browser.location.href).searchParams.get('registrationTime'),'ORIGINAL','the list asks for the original registration time');
  await input(browser.document.querySelector('[aria-label="查找用户"]'),'18800001101');
  await click(namedButton('查询'));
  await waitFor(()=>calls.some(c=>c.url==='/api/bff/admin/users/lookup'));
  const lookup=calls.find(c=>c.url==='/api/bff/admin/users/lookup');
  assert.equal(lookup.method,'POST');
  assert.equal(lookup.body.registrationTime,'ORIGINAL','the phone lookup body carries the mode');
  assert.equal(lookup.body.sort,'registered_desc');
  assert.ok(calls.every(c=>!c.url.includes('18800001101')),'the phone never enters the URL');
  assert.equal(browser.location.href.includes('18800001101'),false);
  await click(browser.document.querySelector('tbody tr'));
  await waitFor(()=>namedButton('打开完整详情'));
  const detail=calls.find(c=>c.url.includes('/api/bff/admin/users/user_normal?'));
  assert.ok(detail,'the quick check reads the user detail');
  assert.equal(new URL(detail.url,browser.location.href).searchParams.get('registrationTime'),'ORIGINAL','the detail asks for the original registration time');
});

test('R1: the registration sort sends the requested direction',async t=>{
  const {calls}=await mount(t,{path:'/users?sort=registered_asc'});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const call=calls.find(c=>c.url.includes('/users?'));
  assert.equal(new URL(call.url,browser.location.href).searchParams.get('sort'),'registered_asc');
});

test('R2: a zero published count, a missing published count and a denied scope stay different',async t=>{
  const items=[
    { ...user, userId:'p_zero', name:'零上架用户', resourceSummary:{state:'ready',count:4,publishedCount:0} },
    { ...user, userId:'p_unknown', name:'上架未知用户', resourceSummary:{state:'ready',count:4} },
    { ...user, userId:'p_denied', name:'无权限用户', resourceSummary:{state:'denied',permission:'supply.rental_account.read'} },
    { ...user, userId:'p_noscope', name:'无范围用户', resourceSummary:{state:'denied',permission:'supply.rental_account.read',reason:'NO_GAME_SCOPE'} },
  ];
  await mount(t,{fetch:async()=>json({items,total:4,nextCursor:null,limit:20})});
  await waitFor(()=>browser.document.querySelectorAll('tbody tr').length===4);
  const rows=[...browser.document.querySelectorAll('tbody tr')].map(r=>r.textContent);
  assert.ok(rows[0].includes('上架 0'),'a real zero stays a zero');
  assert.equal(rows[0].includes('上架数待更新'),false);
  assert.ok(rows[1].includes('上架数待更新'),'a missing published count stays unknown');
  assert.equal(rows[1].includes('上架 0'),false,'a missing count never becomes zero');
  assert.ok(rows[2].includes('无权限'));
  assert.ok(rows[3].includes('未分配业务范围'));
  assert.equal(rows[2].includes('上架 '),false,'a denied scope never shows a number');
  assert.equal(rows[3].includes('上架 '),false,'a denied scope never shows a number');
});

test('R2: the published count opens the same collection with the published filter kept',async t=>{
  const mixed={...user,userId:'u_pub',name:'混合用户',resourceSummary:{state:'ready',count:4,publishedCount:2}};
  await mount(t,{fetch:async()=>json({items:[mixed],total:1,nextCursor:null,limit:20})});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  await click(namedButton('查看用户 混合用户 已上架游戏账号'));
  await waitFor(()=>browser.location.pathname==='/users/u_pub');
  assert.ok(browser.location.search.includes('section=resources'));
  assert.ok(browser.location.search.includes('publication=published'),'the drill-down keeps the published scope');
});

test('R2: the resources section reads the published collection instead of filtering a full page locally',async t=>{
  const {calls}=await mount(t,{path:'/users/user_normal?section=resources&publication=published'});
  await waitFor(()=>browser.document.querySelector('.ud-section-heading h2'));
  const read=calls.find(c=>c.url.includes('/rental-accounts'));
  assert.ok(read,'the resources section reads the rental accounts');
  assert.ok(read.url.includes('publication=published'),'the published collection is requested explicitly');
  assert.equal(calls.some(c=>c.url.includes('/rental-accounts')&&!c.url.includes('publication=published')),false,'the page never requests everything and filters it locally');
});

test('R2: the account publication fact comes from currentlyPublished, not from the version state',async t=>{
  const account=(id,no,lifecycle,currentlyPublished)=>({accountId:id,displayNo:no,game:{id:'g',code:'g',name:'游戏'},lifecycle,ownerPaused:false,staffRestricted:false,restrictionReason:null,legacyHold:'NONE',currentVersionId:`v-${no}`,publication:{versionState:'PUBLISHED',source:'OWNER_DIRECT',versionPublished:true,...(currentlyPublished===undefined?{}:{currentlyPublished})},createdAt:'2026-10-01T00:00:00Z'});
  const accounts=[account('a_published','ACC-1','ACTIVE',true),account('a_archived','ACC-2','ARCHIVED',false),account('a_unknown','ACC-3','ACTIVE',undefined)];
  await mount(t,{path:'/users/user_normal?section=resources',fetch:async address=>address.pathname.endsWith('/rental-accounts')?json({items:accounts,nextCursor:null}):json({user:{...detail,userId:'user_normal'}})});
  await waitFor(()=>browser.document.querySelector('.ud-resource'));
  const articles=[...browser.document.querySelectorAll('.ud-resource')].map(a=>a.textContent);
  assert.ok(articles[0].includes('当前已上架'),'a published account says so');
  assert.ok(articles[1].includes('当前未上架'),'an archived account is not currently published even though its version is');
  assert.ok(articles[1].includes('当前版本已直接发布'),'the version state stays readable next to it');
  assert.ok(articles[2].includes('当前上架状态待核'),'a missing publication fact stays unknown');
});

test('R2: switching the account scope clears the cursor and the old rows',async t=>{
  const calls=[];
  const account=id=>({accountId:id,displayNo:id,game:{id:'g',code:'g',name:'游戏'},lifecycle:'ACTIVE',ownerPaused:false,staffRestricted:false,restrictionReason:null,legacyHold:'NONE',currentVersionId:`v-${id}`,publication:{versionState:'PUBLISHED',source:'OWNER_DIRECT',versionPublished:true,currentlyPublished:true},createdAt:'2026-10-01T00:00:00Z'});
  const detailUser={id:'user_normal',name:'林舟',username:null,displayUsername:null,phoneMasked:'188****1101',emailMasked:null,image:null,status:'ACTIVE',suspended:false,identityStatus:'UNKNOWN',identity:'未知',age:'未知',verifiedAt:null,createdAt:'2026-09-24T04:00:00Z',updatedAt:'2026-09-24T04:00:00Z',registeredAt:'2026-09-24T04:00:00Z',registeredAtSource:'LOCAL',orders:{state:'ready',data:[],current:0},resources:{state:'ready',data:[],count:2,publishedCount:1}};
  const allowed=['user.directory.read','supply.rental_account.read'];
  const adapter={snapshot:{adminUserId:'admin-A',session:{id:'s-A'},security:{isBoss:false},permissions:allowed},has:p=>allowed.includes(p),hasCreditGuaranteeRead:()=>false,hasCreditGuaranteeManage:()=>false,detail:async()=>detailUser,section:async(id,domain,signal,cursor,filters)=>{calls.push({cursor,filters});return {state:'ready',data:[account(filters.publication==='published'?'a-published':'a-all')],nextCursor:'NEXT'};},membershipGrowth:async()=>({}),finance:async()=>({})};
  const container=browser.document.createElement('div');browser.document.body.appendChild(container);const root=createRoot(container);
  const tab=query=>({id:'user:user_normal',title:'林舟',path:'/users/user_normal',query,closable:true,kind:'user-object',objectType:'user',objectId:'user_normal'});
  t.after(async()=>{await act(async()=>root.unmount());container.remove();await settle();});
  const render=async query=>{await act(async()=>root.render(createElement(StrictMode,null,createElement(UserDetail,{adapter,snapshot:adapter.snapshot,tab:tab(query),onOpenPath:()=>{},onQueryChange:()=>{},refreshNonce:0}))));await settle();};
  await render({section:'resources',publication:'published'});
  await waitFor(()=>container.querySelector('.ud-resource'));
  assert.ok(container.textContent.includes('a-published'),'the published collection is read');
  await click(namedButton('下一页'));
  await waitFor(()=>calls.some(c=>c.cursor==='NEXT'));
  const before=calls.length;
  await render({section:'resources'});
  await waitFor(()=>calls.length>before);
  const after=calls.slice(before);
  assert.ok(after.every(c=>c.cursor===undefined),'the cursor from the previous scope is not reused');
  assert.ok(after.every(c=>c.filters.publication===undefined),'the new scope reads the whole collection');
  assert.ok(container.textContent.includes('a-all'),'the new scope shows its own rows');
  assert.equal(container.textContent.includes('a-published'),false,'the rows of the previous scope are gone');
});

// ADM-USER-LIST-REPAIR-01：可用余额、内部高危标识、表头排序与紧凑行内筛选。
test('R2: the balance column shows the exact amount and keeps unknown and denied apart from zero',async t=>{
  const users=[
    { ...user, userId:'w_zero', name:'零余额用户', walletSummary:{state:'ready',amountCents:'0',currency:'CNY',asOfUtc:'2026-10-22T00:00:00Z'} },
    { ...user, userId:'w_big', name:'大额用户', walletSummary:{state:'ready',amountCents:'9007199254740993',currency:'CNY',asOfUtc:'2026-10-22T00:00:00Z'} },
    { ...user, userId:'w_unknown', name:'余额待核用户', walletSummary:{state:'unknown',reason:'SOURCE_COVERAGE_NOT_ADMITTED'} },
    { ...user, userId:'w_denied', name:'余额无权限用户', walletSummary:{state:'denied',permission:'user.wallet.read'} },
  ];
  await mount(t,{fetch:async()=>json({items:users,total:4,nextCursor:null,limit:20})});
  await waitFor(()=>browser.document.querySelectorAll('tbody tr').length===4);
  const rows=[...browser.document.querySelectorAll('tbody tr')].map(r=>r.textContent);
  assert.ok(rows[0].includes('¥0.00'),'a real zero stays zero');
  assert.ok(rows[1].includes('¥90071992547409.93'),'a large exact amount is not rounded through a float');
  assert.ok(rows[2].includes('待核'),'an unknown balance is not a zero');
  assert.ok(rows[3].includes('无权限'),'a denied balance is not a zero');
});

test('R2: the internal risk flag sits next to the nickname and only for flagged users',async t=>{
  const users=[
    { ...user, userId:'r_flagged', name:'高危用户', riskFlag:true },
    { ...user, userId:'r_plain', name:'普通用户', riskFlag:false },
  ];
  await mount(t,{fetch:async()=>json({items:users,total:2,nextCursor:null,limit:20})});
  await waitFor(()=>browser.document.querySelectorAll('tbody tr').length===2);
  const rows=[...browser.document.querySelectorAll('tbody tr')];
  assert.ok(rows[0].textContent.includes('高危'),'the flagged user carries the internal tag');
  assert.equal(rows[1].textContent.includes('高危'),false,'an unflagged user carries no tag');
});

test('R1/R2: the column headers sort immediately, go back to page 1 and expose aria-sort',async t=>{
  const {calls}=await mount(t);
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const sortButton=browser.document.querySelector('[aria-label="按可用余额排序"]');
  assert.ok(sortButton,'the balance column carries its own sort control');
  await click(sortButton);
  await waitFor(()=>calls.some(c=>c.url.includes('sort=balance_asc')));
  const header=sortButton.closest('th');
  assert.ok(header,'the sorted column declares aria-sort');
  assert.equal(header.getAttribute('aria-sort'),'ascending');
  const call=calls.find(c=>c.url.includes('sort=balance_asc'));
  assert.equal(new URL(call.url,browser.location.href).searchParams.get('page'),'1','a new sort starts at the first page');
});

test('R2: the business column sorts renting, lending and published separately',async t=>{
  const {calls}=await mount(t);
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  for(const label of ['按租入排序','按出租排序','按上架排序']){
    const button=browser.document.querySelector(`[aria-label="${label}"]`);
    assert.ok(button,`${label} is available`);
  }
  await click(browser.document.querySelector('[aria-label="按上架排序"]'));
  await waitFor(()=>calls.some(c=>c.url.includes('sort=published_asc')));
  assert.ok(calls.some(c=>c.url.includes('sort=published_asc')),'the published count has its own server sort');
});

test('R1: the applied date range is one condition and the draft only warns until 查询',async t=>{
  const {calls}=await mount(t,{path:'/users?from=2026-10-18&to=2026-10-18'});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  const chips=[...browser.document.querySelectorAll('.admin-list-toolbar-applied button')].map(b=>b.getAttribute('aria-label'));
  assert.equal(chips.length,1,'the date range is a single applied condition');
  assert.ok(chips[0].includes('注册日期'),'the applied condition is a readable Chinese label');
  assert.equal(browser.document.querySelector('.ud-draft-hint'),null,'an applied range leaves no pending draft');
  const before=calls.length;
  await input(browser.document.querySelector('[aria-label="查找用户"]'),'林舟');
  await waitFor(()=>browser.document.querySelector('.ud-draft-hint'));
  assert.equal(calls.length,before,'typing a draft never queries by itself');
  await click(namedButton('查询'));
  await waitFor(()=>calls.length>before);
});

test('R1: a refresh keeps the previous rows and says 更新中',async t=>{
  let release;let block=false;
  const {calls}=await mount(t,{fetch:async()=>{ if(block)await new Promise(resolve=>{release=resolve;}); return json({items:[user],total:1,nextCursor:null,limit:20}); }});
  await waitFor(()=>browser.document.querySelector('tbody tr'));
  await input(browser.document.querySelector('[aria-label="查找用户"]'),'林舟');
  block=true;
  await click(namedButton('查询'));
  await waitFor(()=>browser.document.querySelector('.ud-updating'));
  assert.ok(browser.document.querySelector('tbody tr'),'the previous rows stay visible while the new query runs');
  assert.ok(browser.document.querySelector('.ud-updating').textContent.includes('更新中'));
  if(release)await act(async()=>{release();});
});
