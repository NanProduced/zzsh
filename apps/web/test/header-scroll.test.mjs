import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/layout/portal-header.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function render(stage,home=true){
 let hook=0,listener;const updates=[];const exports={};
 new Function('require','exports',code)(name=>{
  if(name==='react')return {...React,useEffect:()=>{},useState:()=>{const i=hook++;return [[true,stage,true,false][i],value=>{if(i===1)updates.push(value);}];}};
  if(name==='motion/react')return {useScroll:()=>({scrollY:{}}),useMotionValueEvent:(_,__,fn)=>{listener=fn;},motion:{div:({initial,animate,transition,...props})=>React.createElement('div',props)}};
  if(name==='next/link')return {default:props=>React.createElement('a',props)};
  if(name.includes('user-session-provider'))return {useUserSession:()=>({status:'guest'})};
  if(name.includes('brand-logo'))return {BrandLogo:()=>null};
  if(name.includes('theme-toggle'))return {ThemeToggle:()=>null};
  if(name==='./mobile-nav')return {MobileNav:()=>null};
  if(name.endsWith('.css'))return {};
  return require(name);
 },exports);
 const html=renderToStaticMarkup(React.createElement(exports.PortalHeader,{query:'',onQueryChange:()=>{},home}));
 return {html,listener,updates};
}
test('header becomes opaque on first scroll but shrinks only beyond 100px',()=>{
 for(const [stage,solid,compact] of [[0,false,false],[1,true,false],[101,true,true]]){
  const {html}=render(stage);assert.ok(html.includes(`data-scrolled="${solid}"`));assert.ok(html.includes(`data-compact="${compact}"`));
 }
 assert.ok(render(0,false).html.includes('data-scrolled="true"'));
 const probe=render(0);for(const y of [0,1,99,100,101,500,0])probe.listener(y);assert.deepEqual(probe.updates,[0,1,1,1,101,101,0]);
});
