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
