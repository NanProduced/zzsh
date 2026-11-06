import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { act, createElement, useState } from 'react';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const rootPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=new Window({url:'http://127.0.0.1:4231/finance/users/u1'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','CustomEvent','MutationObserver','ResizeObserver','CSS','localStorage','sessionStorage'])globalThis[key]=key==='window'?browser:browser[key];
Object.defineProperty(globalThis,'navigator',{value:browser.navigator,configurable:true});
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.requestAnimationFrame=browser.requestAnimationFrame.bind(browser);globalThis.cancelAnimationFrame=browser.cancelAnimationFrame.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client');
const vite=await createServer({root:rootPath,configFile:false,plugins:[react()],resolve:{alias:{'@':path.join(rootPath,'src'),'@brand':path.resolve(rootPath,'../../assets/brand')}},optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false,watch:null}});
const {FinanceUser}=await vite.ssrLoadModule('/src/views/finance-user.tsx');
after(async()=>{await vite.close();await browser.happyDOM.abort();});
async function waitFor(check){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('user finance timed out');await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));}}

test('user funds separates wallet, historic channel, and opening views while retaining scope and dates',async t=>{
 const prior=globalThis.fetch,requests=[],opened=[],host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
 const snapshot={authenticated:true,adminUserId:'admin',security:{status:'ACTIVE',isBoss:true,passwordChangeRequired:false},session:{id:'session',locked:false},permissions:['finance.read','finance.document.read','user.directory.read','order.read']};
 globalThis.fetch=async address=>{const url=new URL(String(address),browser.location.href);requests.push(url);let body;
  if(url.pathname.endsWith('/users/u1'))body={user:{userId:'u1',name:'用户一',walletSummary:{state:'ready',amountCents:'735',currency:'CNY',asOfUtc:'2026-11-06T00:00:00Z'}}};
  else if(url.searchParams.get('view')==='OPENING')body={asOf:'2026-11-06T00:00:00.000Z',total:1,items:[{id:'basis',source:'OPENING',amountCents:'735',occurredAt:'2026-11-03T00:00:00Z'}]};
  else if(url.pathname.endsWith('/channels'))body={asOf:'2026-11-06T00:00:00.000Z',total:1,items:[{id:'old',source:'LEGACY',kind:'PAYMENT',subjectRole:'OWNER',subjectId:'u2',subjectName:'租客',number:'OLD-1',documentRef:'HISTORY_PAYMENT:1',state:'旧平台已付款',amountCents:'224',occurredAt:null}]};
  else body={asOf:'2026-11-06T00:00:00.000Z',total:42,items:[{id:'balance',source:'NATIVE',label:'分销收入',amountCents:'224',occurredAt:null,documentRef:'DISTRIBUTION:1'}]};
  return new Response(JSON.stringify(body),{status:200});};
 function Harness(){const [query,setQuery]=useState({financeFrom:'2026-10-31',financeTo:'2026-11-06'});return createElement(FinanceUser,{tab:{id:'finance-user:u1',title:'用户资金',path:'/finance/users/u1',objectId:'u1',kind:'finance-user',closable:true,query},snapshot,onOpenPath:(...args)=>opened.push(args),onQueryChange:setQuery,onRefresh:async()=>snapshot,refreshNonce:0});}
 await act(async()=>root.render(createElement(Harness)));t.after(async()=>{globalThis.fetch=prior;await act(async()=>root.unmount());host.remove();});
 await waitFor(()=>host.textContent.includes('分销收入'));assert.match(host.textContent,/7\.35 元/);assert.doesNotMatch(host.textContent,/HISTORY_PAYMENT|用户二/);
 let activity=requests.find(url=>url.pathname.endsWith('/balances'));assert.equal(activity.searchParams.get('subjectUserId'),'u1');assert.equal(activity.searchParams.get('view'),'LIVE');assert.equal(activity.searchParams.get('from'),'2026-10-31');
 await act(async()=>host.querySelector('[aria-label="下一页"]').click());await waitFor(()=>requests.some(url=>url.searchParams.get('page')==='2'));
 activity=requests.find(url=>url.searchParams.get('page')==='2');assert.equal(activity.searchParams.get('subjectUserId'),'u1');assert.equal(activity.searchParams.get('asOf'),'2026-11-06T00:00:00.000Z');
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='资金记录').click());await waitFor(()=>requests.some(url=>url.pathname.endsWith('/channels')));
 assert.match(host.textContent,/号主/);activity=requests.find(url=>url.pathname.endsWith('/channels'));assert.equal(activity.searchParams.get('subjectUserId'),'u1');assert.equal(activity.searchParams.get('source'),'NATIVE');
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='查看旧平台记录').click());await waitFor(()=>requests.some(url=>url.searchParams.get('source')==='LEGACY'));
 assert.match(host.textContent,/旧平台已付款/);assert.match(host.textContent,/号主/);assert.equal(requests.at(-1).searchParams.get('subjectUserId'),'u1');
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='查看迁移期初').click());await waitFor(()=>requests.some(url=>url.searchParams.get('view')==='OPENING'));
 activity=requests.find(url=>url.searchParams.get('view')==='OPENING');assert.equal(activity.searchParams.get('subjectUserId'),'u1');assert.equal(activity.searchParams.has('from'),false);assert.match(host.textContent,/期初余额/);
});

test('finance user clears private content when directory permission is lost',async t=>{
 const prior=globalThis.fetch,host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
 const snapshot={authenticated:true,adminUserId:'admin',security:{status:'ACTIVE',isBoss:false,passwordChangeRequired:false},session:{id:'session',locked:false},permissions:['finance.read','user.directory.read']};
 globalThis.fetch=async address=>new Response(JSON.stringify(String(address).includes('/users/u1')?{user:{userId:'u1',name:'用户一',walletSummary:{state:'ready',amountCents:'735'}}}:{asOf:'2026-11-06T00:00:00.000Z',total:0,items:[]}),{status:200});
 const props={tab:{id:'finance-user:u1',title:'用户资金',path:'/finance/users/u1',objectId:'u1',kind:'finance-user',closable:true,query:{}},snapshot,onOpenPath:()=>{},onQueryChange:()=>{},onRefresh:async()=>snapshot,refreshNonce:0};
 await act(async()=>root.render(createElement(FinanceUser,props)));t.after(async()=>{globalThis.fetch=prior;await act(async()=>root.unmount());host.remove();});await waitFor(()=>host.textContent.includes('7.35 元'));
 props.snapshot={...snapshot,permissions:['finance.read']};await act(async()=>root.render(createElement(FinanceUser,props)));assert.match(host.textContent,/需要用户资料和资金读取权限/);assert.doesNotMatch(host.textContent,/7\.35 元|用户一/);
});

test('an unreadable opening record is not presented as an absent or zero opening',async t=>{
 const prior=globalThis.fetch,host=browser.document.createElement('div');browser.document.body.append(host);const root=createRoot(host);
 const snapshot={authenticated:true,adminUserId:'admin',security:{status:'ACTIVE',isBoss:true,passwordChangeRequired:false},session:{id:'session',locked:false},permissions:['finance.read','user.directory.read']};
 globalThis.fetch=async address=>new Response(JSON.stringify(String(address).includes('/users/u1')?{user:{userId:'u1',name:'用户一',walletSummary:{state:'unknown'}}}:{asOf:'2026-11-06T00:00:00.000Z',total:1,items:[]}),{status:200});
 const props={tab:{id:'finance-user:u1',title:'用户资金',path:'/finance/users/u1',objectId:'u1',kind:'finance-user',closable:true,query:{financeView:'finance-balance-opening'}},snapshot,onOpenPath:()=>{},onQueryChange:()=>{},onRefresh:async()=>snapshot,refreshNonce:0};
 await act(async()=>root.render(createElement(FinanceUser,props)));t.after(async()=>{globalThis.fetch=prior;await act(async()=>root.unmount());host.remove();});
 await waitFor(()=>host.textContent.includes('期初记录暂时无法读取'));assert.match(host.textContent,/待核实/);assert.doesNotMatch(host.textContent,/没有迁移期初记录|0\.00 元/);
});
