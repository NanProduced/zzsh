import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/components/hero/hero-carousel.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function setup(overrides={}){
 let index=0;const state=[false,true,0,false,false,false,true];Object.assign(state,overrides);
 const effects=[],updates=[],calls=[],timers=[];const api={on(){},off(){},selectedScrollSnap:()=>0,scrollNext:()=>calls.push('next'),scrollPrev:()=>calls.push('prev'),scrollTo:i=>calls.push(i)};
 const exports={};
 new Function('require','exports','matchMedia','document','setInterval','clearInterval',code)(name=>{
  if(name==='react')return {...React,useEffect:fn=>effects.push(fn),useState:()=>{const slot=index++;return[state[slot],v=>updates.push([slot,v])];}};
  if(name==='embla-carousel-react')return {default:()=>[()=>{},api]};return require(name);
 },exports,()=>({matches:state[0],addEventListener(){},removeEventListener(){}}),{hidden:false,addEventListener(){},removeEventListener(){}},(fn,delay)=>{timers.push({fn,delay});return 1;},()=>{});
 const tree=exports.HeroCarousel();return {tree,effects,updates,calls,timers};
}
test('carousel keeps automatic rotation and manual controls without play/pause button',()=>{
 const p=setup();const html=renderToStaticMarkup(p.tree);assert.ok(!html.includes('data-autoplay-control'));assert.ok(html.includes('data-autoplay="true"'));assert.equal((html.match(/class="slide-index"/g)||[]).length,4);
 p.effects.forEach(fn=>fn());assert.equal(p.timers.length,1);assert.equal(p.timers[0].delay,5500);p.timers[0].fn();assert.deepEqual(p.calls,['next']);
 p.tree.props.onFocusCapture({});assert.ok(p.updates.some(([slot,v])=>slot===1&&v===false));
 const buttons=[];function walk(node){if(!node||typeof node!=='object')return;if(node.type==='button')buttons.push(node);React.Children.forEach(node.props?.children,walk);}walk(p.tree);
 buttons.find(b=>b.props['aria-label']==='下一张幻灯片').props.onClick();assert.equal(p.calls.at(-1),'next');
 buttons.find(b=>b.props['aria-label']==='切换到幻灯片 3').props.onClick();assert.equal(p.calls.at(-1),2);
 for(const state of [{0:true},{4:true},{5:true},{6:false},{1:false}]){const q=setup(state);q.effects.forEach(fn=>fn());assert.equal(q.timers.length,0);}
});
