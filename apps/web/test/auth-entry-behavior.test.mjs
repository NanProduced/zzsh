import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../src/components/auth/auth-overlay-provider.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function probe(status,target){
 const exports={},states=[];let index=0;
 new Function('require','exports','window','document','HTMLElement',code)(name=>{
  if(name==='react')return {...React,useState(initial){const i=index++;states[i]=initial;return [initial,value=>{states[i]=value;}];},useRef:value=>({current:value}),useCallback:fn=>fn,useEffect(){}};
  if(name==='next/navigation')return {useRouter:()=>({push(){throw Error('Must not navigate without confirmed authentication');}})};
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
  const buttons=rail.props.children[0].props.children;
  buttons[type==='SERVICE'?0:2].props.onClick({currentTarget:{}});
  assert.equal(pending.target,'/?from=home');
  assert.equal(states[0],false,'guest or cancelled login never opens the support window');
  assert.equal(states[4],0,'no support request before confirmed login');
  pending.callback();
  assert.equal(states[0],true);
  assert.equal(states[1],type,'restore the selected entry after authentication');
  assert.equal(states[4],1);
 }
});
