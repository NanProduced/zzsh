import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Existing Admin component harness; no running application or business requests.
const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=new Window({url:'http://127.0.0.1:4291/users'});
for(const name of ['document','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','ResizeObserver','localStorage','sessionStorage'])globalThis[name]=browser[name];
globalThis.window=browser;Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const vite=await createServer({root:rootPath,configFile:false,plugins:[react()],resolve:{alias:{'@':path.join(rootPath,'src'),'@brand':path.resolve(rootPath,'../../assets/brand')}},server:{middlewareMode:true,hmr:false,ws:false}});
const {UserQuickCheck}=await vite.ssrLoadModule('/src/views/user-directory/user-quick-check.tsx');
after(async()=>{await vite.close();await browser.happyDOM.abort();});
const order={orderId:'order-one',displayNo:'ZZ001',status:'PAID',role:'renter',accountId:'account-one',accountDisplayNo:'AC001',counterpartyName:'对方用户',createdAt:'2026-10-22T05:00:00Z'};
const account={accountId:'account-one',displayNo:'AC001',game:{id:'delta',name:'三角洲行动'},ownerPaused:true,staffRestricted:true,publication:{currentlyPublished:true}};
const user={id:'user-one',name:'测试用户',riskFlag:false,riskRevision:0,orders:{state:'ready',data:[],renterCurrent:12,ownerCurrent:8},resources:{state:'ready',data:[],publishedCount:9}};
const waitFor=async(condition)=>{for(let i=0;i<80;i++){if(condition())return;await act(async()=>new Promise(setImmediate));}throw Error('Quick check condition timed out');};
const button=(host,label)=>[...host.querySelectorAll('button')].find(item=>item.textContent===label);
const tab=(host,label)=>[...host.querySelectorAll('[role="tab"]')].find(item=>item.textContent===label);
let serial=0;
async function mount(t,{permissions=['order.read','supply.rental_account.read'],section,subject=user}={}){
  const calls={section:[],notes:0,sensitive:0,details:0,writes:0},opened=[];
  const adapter={snapshot:{adminUserId:'quick-admin-'+(++serial),session:{id:'quick-session-'+serial,locked:false},security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},permissions},has:permission=>permissions.includes(permission),
    section:async(...args)=>{calls.section.push(args);return section?section(...args):{state:'ready',data:args[1]==='resources'?[account]:[{...order,role:args[4].role}]};},
    notes:async()=>{calls.notes++;return {items:[{id:'note-one',text:'已有内部备注',author:{id:'staff-one',displayName:'客服甲'},createdAt:'2026-10-22T00:00:00Z',canDelete:false}],nextCursor:null,capabilities:{canCreate:false,canManage:false}};},
    sensitiveProfile:async()=>{calls.sensitive++;throw Error('No sensitive query allowed');},
    detail:async()=>{calls.details++;return subject;},userCommand:async()=>{calls.writes++;throw Error('No writes in this component suite');}};
  const host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
  const props={adapter,user:subject,refreshNonce:0,onOpenPath:(...args)=>opened.push(args)};
  await act(async()=>root.render(createElement(UserQuickCheck,props)));
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  return{host,props,calls,opened,render:async()=>act(async()=>root.render(createElement(UserQuickCheck,props)))};
}

test('initial panel reads only current renter orders at limit five and keeps the server summary count',async t=>{
  const ui=await mount(t);await waitFor(()=>ui.host.querySelector('[aria-label="快速核对当前租入订单"]'));
  assert.equal(ui.calls.section.length,1);assert.deepEqual(ui.calls.section[0].slice(3),[undefined,{role:'renter',status:'current',limit:'5'}]);
  assert.equal(ui.calls.section[0][0],'user-one');assert.equal(ui.calls.section[0][1],'orders');
  assert.match(ui.host.textContent,/当前租入 12 笔/);assert.doesNotMatch(ui.host.textContent,/共 1|余额|会员|注册时间/);
  assert.match(ui.host.textContent,/账号 AC001|号主 对方用户/);assert.equal(ui.calls.notes,0);assert.equal(ui.calls.sensitive,0);
  await act(async()=>button(ui.host,'查看全部租入').click());assert.equal(ui.opened[0][0],'/users/user-one?section=orders&role=renter&status=current');
});

test('owner tab uses its own current filter and the order link carries exact return context',async t=>{
  const ui=await mount(t);await waitFor(()=>ui.calls.section.length===1);await act(async()=>tab(ui.host,'出租').click());
  await waitFor(()=>ui.host.querySelector('[aria-label="快速核对当前出租订单"]'));
  assert.deepEqual(ui.calls.section.at(-1)[4],{role:'owner',status:'current',limit:'5'});assert.match(ui.host.textContent,/租客 对方用户/);
  await act(async()=>button(ui.host,'ZZ001').click());const url=new URL(ui.opened[0][0],'http://127.0.0.1:4291');
  assert.equal(url.pathname,'/orders/order-one');assert.equal(url.searchParams.get('fromUserId'),'user-one');assert.equal(url.searchParams.get('fromUserSection'),'orders');assert.equal(url.searchParams.get('fromUserRole'),'owner');assert.equal(url.searchParams.get('fromUserStatus'),'current');
});

test('published tab reads the published collection and never calls paused or restricted accounts rentable',async t=>{
  const ui=await mount(t);await act(async()=>tab(ui.host,'上架').click());await waitFor(()=>ui.host.querySelector('[aria-label="快速核对当前上架账号"]'));
  assert.equal(ui.calls.section.at(-1)[1],'resources');assert.deepEqual(ui.calls.section.at(-1)[4],{publication:'published',limit:'5'});
  assert.match(ui.host.textContent,/当前上架 9 个/);assert.match(ui.host.textContent,/号主暂停/);assert.match(ui.host.textContent,/运营限制/);assert.doesNotMatch(ui.host.textContent,/可租/);
  await act(async()=>button(ui.host,'AC001').click());const linked=new URL(ui.opened[0][0],'http://127.0.0.1:4291');
  assert.equal(linked.pathname,'/supply/accounts/account-one');assert.equal(linked.searchParams.get('fromUserPublication'),'published');
  await act(async()=>button(ui.host,'查看全部上架').click());assert.equal(ui.opened.at(-1)[0],'/users/user-one?section=resources&publication=published');
});

test('unknown summary count stays unknown and absent row fields are omitted',async t=>{
  const subject={...user,orders:{state:'ready',data:[]}};
  const ui=await mount(t,{subject,section:async()=>({state:'ready',data:[{orderId:'unknown-one',displayNo:'ZZUNKNOWN',status:'NEW_STATUS'}]})});
  await waitFor(()=>ui.host.textContent.includes('ZZUNKNOWN'));
  assert.match(ui.host.textContent,/数量待核/);assert.match(ui.host.textContent,/状态待核/);assert.doesNotMatch(ui.host.textContent,/当前租入 0|账号 undefined|号主 undefined|未提供/);
});

test('denied orders make no request while the independent resource tab remains usable',async t=>{
  const ui=await mount(t,{permissions:['supply.rental_account.read']});assert.match(ui.host.textContent,/无法查看租入记录/);assert.equal(ui.calls.section.length,0);
  await act(async()=>tab(ui.host,'上架').click());await waitFor(()=>ui.calls.section.length===1);assert.equal(ui.calls.section[0][1],'resources');
});

test('server denial and a failing renter request do not block owner reading',async t=>{
  let mode='error';const ui=await mount(t,{section:async(_id,_domain,_signal,_cursor,filters)=>{
    if(filters.role==='renter'){if(mode==='error')throw Error('Renter unavailable');return {state:'denied',permission:'order.read'};}
    return {state:'ready',data:[{...order,role:'owner'}]};}});
  await waitFor(()=>ui.host.textContent.includes('租入记录读取失败'));assert.equal(button(ui.host,'查看全部租入'),undefined);
  await act(async()=>tab(ui.host,'出租').click());await waitFor(()=>ui.host.querySelector('[aria-label="快速核对当前出租订单"]'));
  mode='denied';await act(async()=>tab(ui.host,'租入').click());await waitFor(()=>ui.host.textContent.includes('无法查看租入记录'));
  assert.equal(button(ui.host,'查看全部租入'),undefined);assert.doesNotMatch(ui.host.textContent,/当前租入 12 笔/);
});

test('pending rows show skeletons and permission loss hides already loaded data',async t=>{
  let release;const ui=await mount(t,{section:()=>new Promise(resolve=>{release=resolve;})});assert(ui.host.querySelector('[aria-label="正在读取当前租入"]'));
  await act(async()=>release({state:'ready',data:[order]}));await waitFor(()=>ui.host.textContent.includes('ZZ001'));
  ui.props.adapter={...ui.props.adapter,snapshot:{...ui.props.adapter.snapshot,permissions:[]},has:()=>false};await ui.render();
  assert.doesNotMatch(ui.host.textContent,/ZZ001|当前租入 12/);assert.match(ui.host.textContent,/无法查看租入记录/);
});

test('notes load only after expansion, use the existing authored notes view and never reveal sensitive data',async t=>{
  const ui=await mount(t);assert.equal(ui.calls.notes,0);await act(async()=>button(ui.host,'内部备注').click());
  await waitFor(()=>ui.host.textContent.includes('已有内部备注'));assert.equal(ui.calls.notes,1);assert.match(ui.host.textContent,/客服甲/);assert.equal(ui.calls.sensitive,0);assert.equal(ui.calls.writes,0);
});

test('risk controls reuse the existing command action without fetching detail or writing on mount',async t=>{
  const ui=await mount(t,{permissions:['order.read','user.risk.manage']});await waitFor(()=>button(ui.host,'标记高危'));
  assert.equal(ui.calls.details,0);assert.equal(ui.calls.writes,0);await act(async()=>button(ui.host,'标记高危').click());
  await waitFor(()=>browser.document.body.textContent.includes('仅后台可见，不改变账号、信用或订单状态。'));
  assert.equal(ui.calls.writes,0);assert.equal(ui.calls.sensitive,0);
});
