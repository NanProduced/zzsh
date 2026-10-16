import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import { mountAuthComponent } from './react-auth-harness.mjs';
import * as legalDocuments from "../src/content/legal/documents.ts";
const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../src/components/auth/auth-overlay-provider.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function probe(status,target){
 const exports={},states=[];let index=0;
 new Function('require','exports','window','document','HTMLElement',code)(name=>{
  if(name==='react')return {...React,useState(initial){const i=index++;states[i]=initial;return [initial,value=>{states[i]=value;}];},useRef:value=>({current:value}),useCallback:fn=>fn,useEffect(){}};
   if(name==='next/navigation')return {useRouter:()=>({push(){throw Error('Must not navigate without confirmed authentication');},replace(){throw Error('Must not navigate without confirmed authentication');}}),usePathname:()=>'/'};
  if(name.includes('session/user-session-provider'))return {useUserSession:()=>({status,revalidate(){}})};
  if(name==='@/lib/safe-return')return {safeReturnTo:value=>value};
  if(name==='@/components/brand/brand-logo')return {BrandLogo:()=>null};
  if(name==='./auth-form')return {AuthForm:()=>null};
  return require(name);
 },exports,{location:{pathname:'/',search:''}},{activeElement:null},class HTMLElement {});
 const element=exports.AuthOverlayProvider({children:null});
 element.props.value.open(target);
 return states[0];
}
test('explicit login opens during session outage without granting protected navigation',()=>{
 for(const status of ['loading','error','guest'])assert.equal(probe(status,undefined),true);
 for(const status of ['loading','error'])assert.equal(probe(status,'/publish'),false);
 assert.equal(probe('guest','/publish'),true);
});

test('support and complaint entries wait for unified authentication without creating a consultation',()=>{
 const railCode=ts.transpileModule(readFileSync(new URL('../src/components/support/support-rail.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
 for(const type of ['SERVICE','COMPLAINT']){
  const exports={},states=[];let index=0,pending;
  new Function('require','exports','window',railCode)(name=>{
   if(name==='react')return {...React,useState(initial){const i=index++;states[i]=initial;return [initial,value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},useRef:value=>({current:value}),useEffect(){}};
   if(name==='next/navigation')return {usePathname:()=>'/'};
   if(name==='next/link')return {default:()=>null};
   if(name.includes('auth-overlay-provider'))return {useAuthOverlay:()=>({open:(target,callback)=>{pending={target,callback};}})};
   if(name==='./contact-popover')return {ContactPopover:()=>null};
   if(name==='./customer-support-workspace')return {CustomerSupportWorkspace:()=>null};
   if(name.endsWith('.css'))return {};
   return require(name);
  },exports,{location:{pathname:'/',search:'?from=home'}});
  const rail=exports.SupportRail();
  // Collect the support triggers wherever they sit in the rail tree, so reshaping the rail (for
  // example adding the mobile tools toggle) cannot silently shift which button this test clicks.
  const triggers=[];
  (function walk(node){
   if(!node||typeof node!=='object')return;
   if(Array.isArray(node)){node.forEach(walk);return;}
   if(!node.props)return;
   if(node.props['data-support-trigger'])triggers.push(node);
   walk(node.props.children);
  })(rail);
  triggers[type==='SERVICE'?0:1].props.onClick({currentTarget:{}});
  assert.equal(pending.target,'/?from=home');
  assert.equal(states[0],false,'guest or cancelled login never opens the support window');
  assert.equal(states[4],0,'no support request before confirmed login');
  pending.callback();
  assert.equal(states[0],true);
  assert.equal(states[1],type,'restore the selected entry after authentication');
  assert.equal(states[4],1);
 }
});

const coordinator = 'apps/web/src/components/auth/auth-overlay-provider.tsx';
const loginPage = 'apps/web/src/app/login/page.tsx';
const dialog = p => p.host.querySelector('[role="dialog"]');
async function setSession(p, status) {
  await p.React.act(async () => { p.identity.status = status; p.identity.userId = status === 'authenticated' ? 'user_A' : null; });
  await p.render();
}
function linkClick(node, init = {}) {
  return new node.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
}

test('public browsing stays quiet and a protected arrival opens exactly one coordinator dialog', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', { children: null }, { url: 'http://127.0.0.1:4200/', pathname: '/', initialStatus: 'loading' });
  try {
    assert.equal(dialog(p), null, 'an unconfirmed session must stay neutral');
    await setSession(p, 'guest');
    assert.equal(dialog(p), null, 'a public page never prompts a guest');
    p.nav.pathname = '/account';
    p.window.history.pushState(null, '', '/account');
    await p.render();
    assert.equal(p.host.querySelectorAll('[role="dialog"]').length, 1, 'direct arrival opens the shared dialog once');
    assert.deepEqual(p.router.pushes, []);
    assert.deepEqual(p.router.replaces, [], 'opening never navigates on its own');
  } finally { await p.close(); }
});

test('a session read failure is a retryable notice, never a guess that the visitor signed out', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', { children: null }, { url: 'http://127.0.0.1:4200/support', pathname: '/support', initialStatus: 'loading' });
  try {
    assert.equal(dialog(p), null);
    await setSession(p, 'error');
    assert.equal(dialog(p), null, 'error must not open the dialog');
    assert.ok(p.host.querySelector('.auth-session-pending'), 'error shows a retryable session notice');
    await p.click('重试');
    assert.equal(p.confirmations, 1, 'retry re-reads the shared session');
    assert.equal(p.host.querySelector('.auth-session-pending'), null);
    await setSession(p, 'guest');
    assert.equal(p.host.querySelectorAll('[role="dialog"]').length, 1, 'only a confirmed guest opens the dialog');
  } finally { await p.close(); }
});

test('a confirmed session reaches the protected route without a prompt or a redirect', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', { children: null }, { url: 'http://127.0.0.1:4200/account?view=accounts', pathname: '/account', initialStatus: 'authenticated' });
  try {
    assert.equal(dialog(p), null);
    assert.deepEqual(p.router.pushes, []);
    assert.deepEqual(p.router.replaces, []);
  } finally { await p.close(); }
});

test('a confirmed sign-in during a protected arrival closes the dialog without navigating again', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', { children: null }, { url: 'http://127.0.0.1:4200/account?view=favorites', pathname: '/account' });
  try {
    assert.ok(dialog(p), 'guest arrival opens the dialog');
    await setSession(p, 'authenticated');
    assert.equal(dialog(p), null, 'the dialog closes once identity is confirmed');
    assert.deepEqual(p.router.pushes, []);
    assert.deepEqual(p.router.replaces, [], 'already on the target route, so nothing is pushed or replaced');
  } finally { await p.close(); }
});

test('cancelling a protected arrival lands on the last known public page, never back to the protected route', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', { children: null }, { url: 'http://127.0.0.1:4200/account?view=favorites', pathname: '/account' });
  try {
    assert.ok(dialog(p));
    p.window.sessionStorage.setItem('zzsh-auth-public-source:v1', '/accounts?q=1');
    await p.click('关闭认证窗口');
    assert.deepEqual(p.router.replaces, ['/accounts?q=1'], 'a known public source is used');
    assert.deepEqual(p.router.pushes, [], 'no history.back, so an external site can never be the target');
    assert.equal(dialog(p), null);
    p.nav.pathname = '/accounts';
    await p.render();
    assert.equal(dialog(p), null, 'settling on the public page must not re-open the dialog');
  } finally { await p.close(); }
});

test('without any public source a cancelled protected arrival replaces to the portal home', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', { children: null }, { url: 'http://127.0.0.1:4200/publish?mode=fast', pathname: '/publish' });
  try {
    assert.ok(dialog(p));
    await p.click('关闭认证窗口');
    assert.deepEqual(p.router.replaces, ['/'], 'falls back to home instead of looping back to /publish');
    assert.deepEqual(p.router.pushes, []);
  } finally { await p.close(); }
});

test('protected links keep modifier, new-tab and download semantics and only intercept a plain same-tab click', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {
    children: React.createElement('nav', null,
      React.createElement('a', { href: '/publish' }, '上架出租'),
      React.createElement('a', { href: '/publish?mode=fast', target: '_blank' }, '极速上架'),
      React.createElement('a', { href: '/account', download: '' }, '个人中心')),
  }, { url: 'http://127.0.0.1:4200/', pathname: '/' });
  try {
    const [plain, blank, download] = [...p.host.querySelectorAll('a')];
    let allowed = true;
    await p.React.act(async () => { allowed = plain.dispatchEvent(linkClick(plain, { ctrlKey: true })); });
    assert.equal(allowed, true, 'a modifier click stays with the browser');
    await p.React.act(async () => { allowed = blank.dispatchEvent(linkClick(blank)); });
    assert.equal(allowed, true, 'a new-tab link keeps its own semantics');
    await p.React.act(async () => { allowed = download.dispatchEvent(linkClick(download)); });
    assert.equal(allowed, true, 'a download link keeps its own semantics');
    assert.equal(dialog(p), null, 'unhandled link kinds never open the dialog');
    await p.React.act(async () => { allowed = plain.dispatchEvent(linkClick(plain)); });
    assert.equal(allowed, false, 'a plain same-tab protected link is taken over');
    assert.equal(p.host.querySelectorAll('[role="dialog"]').length, 1);
    assert.deepEqual(p.router.replaces, [], 'the public page itself is kept in place');
  } finally { await p.close(); }
});

test('several protected entries while the session is unconfirmed collapse into one guest-confirmed dialog', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {
    children: React.createElement('nav', null,
      React.createElement('a', { href: '/publish' }, '上架出租'),
      React.createElement('a', { href: '/account' }, '个人中心')),
  }, { url: 'http://127.0.0.1:4200/', pathname: '/', initialStatus: 'loading' });
  try {
    const [publish, account] = [...p.host.querySelectorAll('a')];
    await p.React.act(async () => { publish.dispatchEvent(linkClick(publish)); });
    await p.React.act(async () => { account.dispatchEvent(linkClick(account)); });
    assert.equal(dialog(p), null, 'no prompt before the session settles');
    await setSession(p, 'guest');
    assert.equal(p.host.querySelectorAll('[role="dialog"]').length, 1, 'one dialog, no stack');
    assert.deepEqual(p.router.replaces, []);
    assert.deepEqual(p.router.pushes, []);
  } finally { await p.close(); }
});

test('a cancelled login-page shell leaves for a safe public page instead of the protected target', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {
    children: React.createElement('a', { href: '/publish' }, '上架出租'),
  }, { url: 'http://127.0.0.1:4200/login?next=%2Fpublish', pathname: '/login' });
  try {
    const link = p.host.querySelector('a[href="/publish"]');
    await p.React.act(async () => { link.dispatchEvent(linkClick(link)); });
    assert.ok(dialog(p), 'the /login shell only exists around this dialog');
    await p.click('关闭认证窗口');
    assert.deepEqual(p.router.replaces, ['/'], 'the protected next target is never the landing page');
    assert.deepEqual(p.router.pushes, []);
    assert.equal(dialog(p), null);
  } finally { await p.close(); }
});

test('the legacy /login link keeps next and invite code while rendering exactly one form', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/login?next=%2Faccount%3Fview%3Dfavorites&inviteCode=fxOriginal',
    pathname: '/login',
    child: { path: loginPage, name: 'default' },
  });
  try {
    assert.equal(p.host.querySelectorAll('[role="dialog"]').length, 1, 'the shared dialog is the only presentation layer');
    assert.equal(p.host.querySelectorAll('form').length, 1, 'never two forms');
    assert.equal(p.host.querySelector('[data-auth-form-next]').getAttribute('data-auth-form-next'), '/account?view=favorites');
    assert.equal(p.host.querySelector('#auth-invite-code').value, 'fxOriginal');
  } finally { await p.close(); }
});

test('/login with an unreadable session offers a retry and an explicit form open without entering the protected target', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/login?next=%2Fpublish&inviteCode=fx1',
    pathname: '/login',
    initialStatus: 'error',
    child: { path: loginPage, name: 'default' },
  });
  try {
    assert.equal(dialog(p), null, 'no prompt while the session read failed');
    assert.match(p.host.textContent, /暂时无法确认账号状态/);
    assert.deepEqual(p.router.replaces, [], 'the protected target is never entered on a failed read');
    await p.click('打开登录窗口');
    assert.equal(p.host.querySelectorAll('[role="dialog"]').length, 1, 'an explicit request still opens the form');
    await p.click('重试');
    assert.equal(p.confirmations, 1, 'the notice is retryable');
  } finally { await p.close(); }
});

test('/login still honours its existing replace target once the session is already confirmed', async () => {
  const p = await mountAuthComponent(coordinator, 'AuthOverlayProvider', {}, {
    url: 'http://127.0.0.1:4200/login?next=%2Faccount%3Fview%3Daccounts',
    pathname: '/login',
    initialStatus: 'authenticated',
    child: { path: loginPage, name: 'default' },
  });
  try {
    assert.deepEqual(p.router.replaces, ['/account?view=accounts'], 'the established default target is kept');
    assert.deepEqual(p.router.pushes, [], 'no history entry for the transient login shell');
    assert.equal(dialog(p), null);
  } finally { await p.close(); }
});

test('R1: route coordinator must not complete a pending login for a different confirmed subject',async()=>{
 const p=await mountAuthComponent(coordinator,'AuthOverlayProvider',{children:null},{
  url:'http://127.0.0.1:4200/account?view=accounts',pathname:'/account',initialStatus:'guest',
  confirmUserId:'user_B',
  fetch:async()=>Response.json({status:true,userId:'user_A'}),
 });
 try{
  await p.click('密码登录');await p.input('auth-identifier','13800138000');await p.input('auth-terms',true);await p.input('auth-password','test-password');
  await p.submit();
  assert.equal(p.identity.userId,'user_B');
  assert.match(p.host.textContent,/操作已接受/,'form refuses mismatched session');
  await p.render();
  assert.equal(p.host.querySelectorAll('form').length,1,'coordinator must preserve the unresolved form instead of auto-finishing');
 }finally{await p.close();}
});

test('R2: cancellation must classify the resolved path, not a dot-segment alias',async()=>{
 const p=await mountAuthComponent(coordinator,'AuthOverlayProvider',{children:null},{
  url:'http://127.0.0.1:4200/login?next=%2Fhelp%2F..%2Faccount',
  pathname:'/login',initialStatus:'guest',
  child:{path:'apps/web/src/app/login/page.tsx',name:'default'}
 });
 try{
  assert.equal(p.host.querySelectorAll('form').length,1);
  await p.click('关闭认证窗口');
  const destination=p.router.replaces.at(-1);
  const path=new URL(destination,'http://127.0.0.1:4200').pathname;
  assert.notEqual(path,'/account','cancel must not return to another protected route');
  assert.equal(destination,'/');
 }finally{await p.close();}
});

test('R3: a query-only protected arrival must replace the stale return intent',async()=>{
 const p=await mountAuthComponent(coordinator,'AuthOverlayProvider',{children:null},{url:'http://127.0.0.1:4200/account?view=accounts',pathname:'/account',initialStatus:'guest'});
 try{
  p.window.history.pushState(null,'','/account?view=wallet');
  await p.render();
  p.identity.status='authenticated';p.identity.userId='user_A';
  await p.render();await p.settle();
  assert.deepEqual(p.router.pushes,[],'already on latest target; do not navigate back to old account tab');
  assert.deepEqual(p.router.replaces,[]);
 }finally{await p.close();}
});

test("a same-subject session notification cannot unmount the form before confirm settles", async () => {
  let resolveConfirm;
  const confirmation = new Promise(resolve => { resolveConfirm = resolve; });
  const p = await mountAuthComponent(coordinator, "AuthOverlayProvider", { children: null }, {
    url: "http://127.0.0.1:4200/account?view=accounts", pathname: "/account", initialStatus: "guest",
    confirm: () => confirmation, fetch: async () => Response.json({ status: true, userId: "user_A" }),
  });
  try {
    await p.click("密码登录"); await p.input("auth-identifier", "13800138000"); await p.input("auth-terms", true); await p.input("auth-password", "test-password"); await p.submit();
    p.identity.status = "authenticated"; p.identity.userId = "user_A"; await p.render();
    assert.equal(p.host.querySelectorAll("form").length, 1);
    await p.React.act(async () => { resolveConfirm("authenticated"); await new Promise(setImmediate); });
    await p.settle();
    assert.equal(p.host.querySelectorAll("form").length, 0);
    p.identity.status = "guest"; p.identity.userId = null; await p.render();
    assert.ok(p.host.querySelector("form"));
    assert.doesNotMatch(p.host.textContent, /操作已接受|结果暂时无法确认/);
  } finally { resolveConfirm("authenticated"); await p.close(); }
});

test("cancel landing rejects normalized private/login aliases and preserves public query and hash", async () => {
  for (const target of ["/help/%2e%2e/account", "/%61ccount", "/help/../login", "/ａｃｃｏｕｎｔ", "/help?q=fees#refund"]) {
    const p = await mountAuthComponent(coordinator, "AuthOverlayProvider", { children: null }, {
      url: "http://127.0.0.1:4200/login?next=" + encodeURIComponent(target), pathname: "/login", initialStatus: "guest",
      child: { path: loginPage, name: "default" },
    });
    try { await p.click("关闭认证窗口"); assert.equal(p.router.replaces.at(-1), target.startsWith("/help?q") ? target : "/"); }
    finally { await p.close(); }
  }
});

test("a changed invitation URL updates the same login form without creating another form", async () => {
 const p=await mountAuthComponent(coordinator,"AuthOverlayProvider",{children:null},{url:"http://127.0.0.1:4200/login?next=%2Faccount&inviteCode=first",pathname:"/login",initialStatus:"guest",child:{path:loginPage,name:"default"}});
 try {
  assert.equal(p.host.querySelector("#auth-invite-code").value,"first");
  p.window.history.pushState(null,"","/login?next=%2Faccount&inviteCode=second");await p.render();await p.settle();
  assert.equal(p.host.querySelectorAll("form").length,1);
  assert.equal(p.host.querySelector("#auth-invite-code").value,"second");
 }finally{await p.close();}
});

test("legal page and metadata reject prototype keys through the same allowlist", async () => {
 const exports = {};
 const legal = ts.transpileModule(readFileSync(new URL("../src/app/legal/[doc]/page.tsx", import.meta.url), "utf8"), {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
 new Function("require","exports",legal)(name=>{
  if(name==="next/navigation")return {notFound(){throw Object.assign(new Error("Not found"),{status:404});}};
  if(name==="next/link")return ()=>null;
  if(name==="@/components/brand/brand-logo")return {BrandLogo:()=>null};
  if(name==="@/content/legal/documents")return legalDocuments;
  return require(name);
 },exports);
 for(const doc of ["toString","constructor","__proto__","missing"]){
  const props={params:Promise.resolve({doc})};
  await assert.rejects(()=>exports.default(props),e=>e.status===404);
  await assert.rejects(()=>exports.generateMetadata(props),e=>e.status===404);
 }
 for(const doc of ["terms","privacy"])assert.match((await exports.generateMetadata({params:Promise.resolve({doc})})).title,/洲洲商行/);
});
