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
after(async()=>{await vite.close();await browser.happyDOM.abort();});
const permissions=['user.directory.read','user.phone.lookup','order.read','supply.rental_account.read','admin.audit.read','user.account.restore','im.support.read'];
let serial=0;
const user={userId:'user_normal',name:'林舟',image:null,username:null,displayUsername:null,maskedPhone:'188****1101',accountStatus:'ACTIVE',suspended:false,identityStatus:'UNKNOWN',ageStatus:'UNKNOWN',source:{kind:'MIGRATED',legacyId:'88001'},registeredAt:'2026-09-24T04:00:00Z',registeredAtSource:'LOCAL',createdAt:'2026-09-24T04:00:00Z',updatedAt:'2026-09-24T04:00:00Z',localCreatedAt:'2026-09-24T04:00:00Z',resourceSummary:{state:'ready',count:1},orderSummary:{state:'ready',currentCount:1},lastBusinessActivity:{state:'not_connected',domains:['ORDER','SUPPLY']}};
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
    if(address.pathname.endsWith('/orders'))return options.ordersError?failure(503):json({items:[order,{...order,orderId:'order_paid',status:'PAID',paidAt:null,role:'owner'},{...order,orderId:'order_complete',status:'COMPLETED',paidAt:null}],nextCursor:null});
    if(address.pathname.endsWith('/rental-accounts'))return json({items:[],nextCursor:null});
    if(address.pathname.endsWith('/audit-events'))return json({items:[],nextCursor:null});
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
  assert.deepEqual([...browser.document.querySelectorAll('th')].map(e=>e.textContent),['用户','账号状态','当前订单','资源账号','操作']);
  const text=browser.document.querySelector('.ud-directory').textContent;assert.equal(text.includes('业务关系'),false);assert.equal(text.includes('租客'),false);assert.equal(text.includes('号主'),false);assert.ok(text.includes('业务活动暂未接入'));
  await click(namedButton('更多筛选'));const filters=browser.document.querySelector('.ud-filter-sheet').textContent;for(const label of ['业务关系','有无订单','有无资源'])assert.equal(filters.includes(label),false);
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

test('390 row directly opens takeover, with no desktop table or Drawer',async t=>{
  await mount(t,{width:390});await waitFor(()=>browser.document.querySelector('.ud-mobile-row'));assert.equal(browser.document.querySelector('table'),null);await click(browser.document.querySelector('.ud-mobile-row'));await waitFor(()=>browser.document.querySelector('.ud-detail'));assert.equal(browser.location.pathname,'/users/user_normal');assert.equal(browser.document.querySelector('.ud-drawer'),null);
});

test('phone search uses a body, never URL/storage, and no permission executes no lookup',async t=>{
  const {calls}=await mount(t);await waitFor(()=>browser.document.querySelector('tbody tr'));await input(browser.document.querySelector('[aria-label="查找用户"]'),'18800001101');await click(namedButton('搜索'));await waitFor(()=>calls.some(call=>call.url==='/api/bff/admin/users/lookup'));
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

test('canonical registration is distinct from old-source trace, with four sections and no membership',async t=>{
  await mount(t,{path:'/users/user_normal'});await waitFor(()=>browser.document.querySelector('.ud-detail'));const text=browser.document.querySelector('.ud-detail').textContent;assert.ok(text.includes('2026'));assert.equal(text.includes('2019'),false);assert.equal(text.includes('会员'),false);assert.deepEqual([...browser.document.querySelectorAll('.ud-sections button')].map(e=>e.textContent),['概览','订单记录','资源账号','账号安全']);await click(namedButton('账号安全'));await waitFor(()=>browser.document.querySelector('.ud-trace'));assert.ok(browser.document.querySelector('.ud-trace').textContent.includes('2019'));
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
  let release;let count=0;const {snapshot,switchActor}=await mount(t,{fetch:async(address,init)=>{if(++count<=2)return new Promise(resolve=>{release=()=>resolve(json({items:[user],nextCursor:null}));});return json({items:[{...user,name:'新身份范围',resourceSummary:{state:'denied',permission:'supply.rental_account.read'},orderSummary:{state:'denied',permission:'order.read'}}],nextCursor:null});}});
  await switchActor({...snapshot,adminUserId:'different-admin',permissions:['user.directory.read']});await waitFor(()=>browser.document.querySelector('tbody tr'));if(release)release();await settle();assert.ok(browser.document.querySelector('tbody').textContent.includes('新身份范围'));assert.equal(browser.document.querySelector('tbody').textContent.includes('1 个进行中'),false);
});
